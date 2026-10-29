#!/usr/bin/env python3
"""Import the user's course material into a device's course library (POST /v1/library/import).

Reads lesson transcripts (WEBVTT) and the course docs (markdown), cuts them into passages of about 250 words, and
posts them in batches. Every passage has a stable originId (`<source>:<relpath>:<n>`), so a rerun adds nothing new;
to re-chunk, run with --wipe. The material stays on this machine: it goes to the device URL only.

  transcripts  <root>/IDD/transcripts/NN-*.vtt, cues joined into clean text, ~250-word windows with ~40 words of
               overlap; each passage's ref is `<relpath>@hh:mm:ss`, the start of its first cue
  docs         <root>/IDD-SCRAPED/T<n>-*/: every README.md, .claude/commands/**/*.md, specs/**/*.md and
               ai_docs/**/*.md (no code, node_modules, lockfiles or binaries), split at markdown headings and packed
               into passages of similar size; ref is `<relpath>#<heading>`. A file whose bytes another lesson already
               has is imported once, under the earliest lesson.

Device: DPI_URL (default http://127.0.0.1:4790) and the DPI_TOKEN line of DPI_ENV_FILE (default
~/.dpi-oracle/backend.env). The token is never printed.

  library_ingest.py --dry-run           counts per lesson and kind, nothing sent
  library_ingest.py                     import (idempotent)
  library_ingest.py --wipe --wait       delete the source first, then import and wait for the embeddings
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path

CHUNK_WORDS = 250
OVERLAP_WORDS = 40
MAX_DOC_WORDS = 300  # a doc passage may run a little long rather than split a short section
MAX_CHARS = 11_000  # the device refuses text over 12000 characters
BATCH_ITEMS = 250
BATCH_BYTES = 230_000  # the device's JSON body limit is 256 KB

# Lesson titles for the IDD course (folders T1..T14 and transcripts 01..14 are the same lessons).
IDD_TITLES = {
    1: "Hello Agentic Coding",
    2: "12 Leverage Points",
    3: "Success Is Planned",
    4: "AFK Agents",
    5: "Close The Loops",
    6: "Let Your Agents Focus",
    7: "ZTE",
    8: "The Agentic Layer",
    9: "Elite Context Engineering",
    10: "Agentic Prompt Engineering",
    11: "Building Specialized Agents",
    12: "Multi-Agent Orchestration",
    13: "Agent Experts",
    14: "Orchestrator Agent With ADWs",
}
SKIP_DIRS = {"node_modules", ".git", ".venv", "venv", "__pycache__", "dist", "build", ".next", "target", ".cache"}


def lesson_name(n: int, slug: str = "") -> str:
    title = IDD_TITLES.get(n) or re.sub(r"[-_]+", " ", slug).strip().title()
    return f"T{n} {title}".strip()


# ---------------------------------------------------------------- transcripts

TIMING = re.compile(r"^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{3})\s+-->\s+")


def parse_vtt(text: str) -> list[tuple[float, str]]:
    """Cues as (start seconds, text): headers, NOTE/STYLE blocks, cue ids and tags dropped, repeats folded."""
    cues: list[tuple[float, str]] = []
    blocks = re.split(r"\n\s*\n", text.replace("\r\n", "\n").replace("\r", "\n"))
    for block in blocks:
        lines = [l for l in block.split("\n") if l.strip()]
        at = next((i for i, l in enumerate(lines) if TIMING.match(l.strip())), None)
        if at is None:
            continue  # WEBVTT header, NOTE, STYLE, REGION
        m = TIMING.match(lines[at].strip())
        h, mnt, s, ms = (int(x) if x else 0 for x in m.groups())
        start = h * 3600 + mnt * 60 + s + ms / 1000
        body = " ".join(lines[at + 1 :])
        body = re.sub(r"<[^>]+>", "", body)
        body = body.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&nbsp;", " ")
        body = re.sub(r"\s+", " ", body).strip()
        if body and not (cues and cues[-1][1] == body):
            cues.append((start, body))
    return cues


def stamp(seconds: float) -> str:
    s = int(seconds)
    return f"{s // 3600:02d}:{s % 3600 // 60:02d}:{s % 60:02d}"


def window(n: int, size=CHUNK_WORDS, overlap=OVERLAP_WORDS):
    """Start/end word offsets of overlapping windows; a short tail joins the previous window."""
    if n <= size:
        return [(0, n)]
    stride = size - overlap
    spans, start = [], 0
    while start < n:
        end = min(n, start + size)
        if n - end < overlap * 2 and end < n:
            end = n  # do not leave a scrap
        spans.append((start, end))
        if end == n:
            break
        start += stride
    return spans


def transcript_chunks(path: Path) -> list[tuple[str, str]]:
    """(at hh:mm:ss, text) passages of one transcript."""
    words: list[tuple[str, float]] = []
    for start, body in parse_vtt(path.read_text(encoding="utf-8", errors="replace")):
        words.extend((w, start) for w in body.split())
    return [(stamp(words[a][1]), " ".join(w for w, _ in words[a:b])) for a, b in window(len(words))]


# ---------------------------------------------------------------- docs

HEADING = re.compile(r"^(#{1,6})\s+(.+?)\s*#*\s*$")
FENCE = re.compile(r"^\s*(```|~~~)")


def sections(text: str, fallback: str) -> list[tuple[str, list[str]]]:
    """(heading, lines) per markdown section; headings inside code fences do not count."""
    out: list[tuple[str, list[str]]] = [(fallback, [])]
    fenced = False
    for line in text.replace("\r\n", "\n").split("\n"):
        if FENCE.match(line):
            fenced = not fenced
        m = None if fenced else HEADING.match(line)
        if m:
            out.append((m.group(2).strip(), [line]))
        else:
            out[-1][1].append(line)
    return [(h, ls) for h, ls in out if any(l.strip() for l in ls)]


def count(lines: list[str]) -> int:
    return sum(len(l.split()) for l in lines)


def split_lines(lines: list[str]) -> list[list[str]]:
    """Cut a long section into ~CHUNK_WORDS pieces at line ends, with ~OVERLAP_WORDS of overlap."""
    flat: list[str] = []
    for line in lines:
        ws = line.split()
        if len(ws) > CHUNK_WORDS:  # one huge line (a table, minified text): cut it by words
            flat.extend(" ".join(ws[a:b]) for a, b in window(len(ws)))
        else:
            flat.append(line)
    pieces, cur = [], []
    for line in flat:
        if cur and count(cur) + len(line.split()) > CHUNK_WORDS:
            pieces.append(cur)
            tail, words = [], 0
            for prev in reversed(cur):  # carry the last ~40 words over
                if words >= OVERLAP_WORDS:
                    break
                tail.insert(0, prev)
                words += len(prev.split())
            cur = tail if words < CHUNK_WORDS // 2 else []
        cur.append(line)
    if cur:
        pieces.append(cur)
    return pieces


def doc_chunks(path: Path) -> list[tuple[str, str]]:
    """(heading, text) passages of one markdown file: small sections packed together, long ones cut."""
    text = path.read_text(encoding="utf-8", errors="replace")
    out: list[tuple[str, list[str]]] = []
    buf_head, buf = "", []
    for heading, lines in sections(text, path.stem):
        n = count(lines)
        if buf and count(buf) + n <= MAX_DOC_WORDS:
            buf.extend(lines)
            continue
        if buf:
            out.append((buf_head, buf))
            buf_head, buf = "", []
        if n > MAX_DOC_WORDS:
            for piece in split_lines(lines):
                out.append((heading, piece))
        else:
            buf_head, buf = heading, list(lines)
    if buf:
        out.append((buf_head, buf))
    chunks = []
    for heading, lines in out:
        body = re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()
        if not body:
            continue
        if not body.lstrip().startswith("#"):
            body = f"# {heading}\n{body}"  # a continuation keeps its section's name
        chunks.append((heading, body[:MAX_CHARS]))
    return chunks


def wanted_doc(rel: Path) -> bool:
    parts = rel.parts
    if any(p in SKIP_DIRS for p in parts) or rel.suffix.lower() != ".md":
        return False
    if rel.name == "README.md":
        return True  # every README.md, adws/README.md included
    dirs = parts[:-1]
    return any(d in ("specs", "ai_docs") for d in dirs) or any(a == ".claude" and b == "commands" for a, b in zip(dirs, dirs[1:]))


def is_binary(path: Path) -> bool:
    with path.open("rb") as f:
        return b"\0" in f.read(8192)


# ---------------------------------------------------------------- the corpus

def collect(root: Path, source: str):
    items, dupes = [], 0
    transcripts = root / "IDD" / "transcripts"
    for path in sorted(transcripts.glob("*.vtt")):
        m = re.match(r"(\d+)-", path.name)
        if not m:
            continue
        lesson = lesson_name(int(m.group(1)))
        rel = path.relative_to(root).as_posix()
        for n, (at, body) in enumerate(transcript_chunks(path)):
            items.append({"source": source, "lesson": lesson, "kind": "transcript", "ref": f"{rel}@{at}", "text": body, "originId": f"{source}:{rel}:{n}"})
    scraped = root / "IDD-SCRAPED"
    folders = sorted((d for d in scraped.glob("T*") if d.is_dir() and re.match(r"T\d+-", d.name)), key=lambda d: int(re.match(r"T(\d+)", d.name).group(1)))
    seen: set[str] = set()
    for folder in folders:
        n_lesson = int(re.match(r"T(\d+)", folder.name).group(1))
        lesson = lesson_name(n_lesson, folder.name.split("-", 1)[1])
        files = []
        for dirpath, dirnames, filenames in os.walk(folder):
            dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)
            for name in sorted(filenames):
                path = Path(dirpath) / name
                if wanted_doc(path.relative_to(folder)) and path.is_file() and not is_binary(path):
                    files.append(path)
        for path in files:
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            if digest in seen:
                dupes += 1
                continue
            seen.add(digest)
            rel = path.relative_to(root).as_posix()
            for n, (heading, body) in enumerate(doc_chunks(path)):
                items.append({"source": source, "lesson": lesson, "kind": "doc", "ref": f"{rel}#{heading}"[:400], "text": body, "originId": f"{source}:{rel}:{n}"})
    return items, dupes


# ---------------------------------------------------------------- the device

def read_token(env_file: Path) -> str:
    for line in env_file.read_text().splitlines():
        m = re.match(r"\s*(?:export\s+)?DPI_TOKEN\s*=\s*(.*)$", line)
        if m:
            value = m.group(1).strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            if value:
                return value
    sys.exit(f"No DPI_TOKEN in {env_file}")


def request(url: str, token: str, method: str, path: str, body=None, timeout=300):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(f"{url.rstrip('/')}/v1{path}", data=data, method=method, headers={"authorization": f"Bearer {token}", "content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return json.loads(res.read() or b"{}")
    except urllib.error.HTTPError as e:
        sys.exit(f"{method} {path}: HTTP {e.code} {e.read()[:300].decode(errors='replace')}")
    except urllib.error.URLError as e:
        sys.exit(f"{method} {path}: device unreachable at {url} ({e.reason})")


def batches(items):
    batch, size = [], 2
    for it in items:
        n = len(json.dumps(it).encode()) + 1
        if batch and (len(batch) >= BATCH_ITEMS or size + n > BATCH_BYTES):
            yield batch
            batch, size = [], 2
        batch.append(it)
        size += n
    if batch:
        yield batch


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--root", default=os.path.expanduser("~/Documents/dev/refs/cannon"), help="corpus root (holds IDD/ and IDD-SCRAPED/)")
    ap.add_argument("--source", default="idd")
    ap.add_argument("--dry-run", action="store_true", help="print counts per lesson and kind; send nothing")
    ap.add_argument("--wipe", action="store_true", help="delete the source on the device before importing")
    ap.add_argument("--wait", action="store_true", help="wait until the device has embedded every passage")
    args = ap.parse_args()

    root = Path(args.root).expanduser()
    items, dupes = collect(root, args.source)
    per = defaultdict(Counter)
    words = Counter()
    for it in items:
        per[it["lesson"]][it["kind"]] += 1
        words[it["kind"]] += len(it["text"].split())
    if args.dry_run:
        print(f"{'lesson':40} {'transcript':>10} {'doc':>6}")
        for lesson in sorted(per, key=lambda l: int(re.match(r"T(\d+)", l).group(1))):
            print(f"{lesson:40} {per[lesson]['transcript']:>10} {per[lesson]['doc']:>6}")
        kinds = Counter(it["kind"] for it in items)
        print(f"{'total':40} {kinds['transcript']:>10} {kinds['doc']:>6}")
        print(f"words: transcript {words['transcript']}, doc {words['doc']}; duplicate doc files skipped: {dupes}; batches: {len(list(batches(items)))}")
        return

    url = os.environ.get("DPI_URL", "http://127.0.0.1:4790")
    token = read_token(Path(os.environ.get("DPI_ENV_FILE", os.path.expanduser("~/.dpi-oracle/backend.env"))).expanduser())
    if args.wipe:
        print("wiped:", request(url, token, "DELETE", f"/library?source={args.source}")["deleted"])
    total = Counter()
    for i, batch in enumerate(batches(items), 1):
        result = request(url, token, "POST", "/library/import", {"items": batch})
        for k in ("added", "skipped", "invalid"):
            total[k] += result.get(k, 0)
        if result.get("errors"):
            print(f"batch {i}: {result['errors']}", file=sys.stderr)
    print(f"items {len(items)}: added {total['added']}, skipped {total['skipped']}, invalid {total['invalid']}")
    if args.wait:
        last = None
        while True:
            stats = request(url, token, "GET", "/library/stats")
            pending = stats.get("pendingEmbeddings")
            if pending is None:
                print("the device has no embedder: keyword recall only")
                break
            if pending != last:
                print(f"pending embeddings: {pending}" + (f" (last error: {stats['embedError']})" if stats.get("embedError") else ""), flush=True)
                last = pending
            if pending == 0:
                break
            time.sleep(5)


if __name__ == "__main__":
    main()
