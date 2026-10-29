#!/usr/bin/env python3
"""Oracle exam: run tabletop cases on Bags under one condition, grade them blind, and report.

usage:
  run_exam.py run   --condition baseline [--runs 3] [--cases all|train|heldout|id,id] [--parallel 3] [--tag NAME]
  run_exam.py grade --dir <results dir>
  run_exam.py report <results dir> [<results dir> ...]

Runs happen in a separate session `exam` on the oracle device (127.0.0.1:4790), never in the user's `oracle`
session. Exam agents are read-only (no delegation, no writes) and have Bags memory switched off, so real memories
cannot leak reference answers and an exam cannot start real work. Conditions differ only in their instructions
and add-ons (CONDITIONS below). Results go to ~/.dpi-oracle/exam-results/<tag>/ (outside git).
"""
import argparse, collections, concurrent.futures as cf, json, os, pathlib, statistics, sys, threading, time
import urllib.error, urllib.request, uuid

HERE = pathlib.Path(__file__).resolve().parent
ORACLE = HERE.parent
BASE = os.environ.get("DPI_ORACLE_URL", "http://127.0.0.1:4790")
ENV = pathlib.Path.home() / ".dpi-oracle" / "backend.env"
TOKEN = next(l.split("=", 1)[1].strip() for l in ENV.read_text().splitlines() if l.startswith("DPI_TOKEN="))
OUT_ROOT = pathlib.Path(os.environ.get("EXAM_OUT", pathlib.Path.home() / ".dpi-oracle" / "exam-results"))
MODEL = {"provider": os.environ.get("ORACLE_PROVIDER", "anthropic"), "modelId": os.environ.get("ORACLE_MODEL", "claude-opus-5-5")}
CWD = str(pathlib.Path.home() / "Documents" / "dev")
SESSION = "exam"
DIMS = ["verify", "plan", "delegate", "loop", "review", "scope", "evidence", "leverage"]

PREAMBLE = (
    "Tabletop exercise. Treat the case below as real and answer the user as you would for real: what you do, in "
    "order, who does each part, how each part is checked, and what you tell the user. You cannot delegate, start "
    "sessions or change anything in this exercise; describe what you would launch instead. You may read files if it "
    "helps.\n\nCASE:\n"
)


def charter():
    return (ORACLE / "charter.md").read_text()


def playbook():
    return charter() + "\n\n" + (HERE / "playbook.md").read_text()


# name -> (instructions factory, {extension: enabled})
CONDITIONS = {
    "baseline": (charter, {"memory": False, "library": False}),
    "playbook": (playbook, {"memory": False, "library": False}),
    "library": (playbook, {"memory": False, "library": True}),
}


def api(method, path, body=None, timeout=330):
    req = urllib.request.Request(BASE + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"Authorization": f"Bearer {TOKEN}", "content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read() or b"null")


def ensure_session():
    sessions = {s["name"]: s for s in api("GET", "/v1/sessions")}
    if SESSION not in sessions:
        api("POST", "/v1/sessions", {"name": SESSION, "cwd": CWD, "model": MODEL, "thinkingLevel": "medium"})


def ensure_agent(name, instructions, extensions):
    agents = {a["name"]: a for a in api("GET", f"/v1/sessions/{SESSION}/agents")}
    if name not in agents:
        api("POST", f"/v1/sessions/{SESSION}/agents", {"from": "main", "name": name})
    a = f"/v1/sessions/{SESSION}/agents/{name}"
    api("PATCH", f"{a}/config", {"model": MODEL, "instructions": instructions, "cwd": CWD, "toolSet": "readOnly"})
    known = {e["name"] for e in api("GET", f"{a}/extensions")["extensions"]}
    for ext, on in extensions.items():
        if ext in known:
            api("PATCH", f"{a}/extensions", {"name": ext, "enabled": on})
        elif on:
            raise SystemExit(f"extension {ext} is not installed on the device; deploy it before this condition")


def ask(agent, content, label, cap_s=1500):
    """Reset the agent, send one message, wait for the answer. Returns (status, text, seconds, tool counts, reason)."""
    a = f"/v1/sessions/{SESSION}/agents/{agent}"
    api("POST", f"{a}/reset", {"note": f"exam {label}"})
    before = api("GET", f"{a}/entries?scope=all&limit=2000")["items"]
    start = time.time()
    sub = api("POST", f"{a}/messages", {"content": content, "requestId": f"exam-{label}-{uuid.uuid4().hex[:8]}"})
    result = sub
    while result.get("status") in ("queued", "pending") and time.time() - start < cap_s:
        result = api("GET", f"/v1/sessions/{SESSION}/submissions/{sub['submissionId']}?waitMs=240000")
    seconds = round(time.time() - start, 1)
    after = api("GET", f"{a}/entries?scope=all&limit=2000")["items"]
    last = max((e["id"] for e in before), default=0)
    tools = collections.Counter()
    for e in after:
        if e["id"] <= last:
            continue
        messages = e.get("model") or []
        for m in messages if isinstance(messages, list) else [messages]:
            parts = m.get("content") if isinstance(m, dict) else None
            for p in parts if isinstance(parts, list) else []:
                if isinstance(p, dict) and p.get("type") == "toolCall":
                    tools[p.get("name")] += 1
    return result.get("status"), (result.get("answer") or {}).get("text"), seconds, dict(tools), result.get("reason")


def load_cases(sel):
    cases = json.loads((HERE / "cases.json").read_text())
    if sel in ("train", "heldout"):
        return [c for c in cases if c["split"] == sel]
    if sel != "all":
        ids = set(sel.split(","))
        return [c for c in cases if c["id"] in ids]
    return cases


def cmd_run(args):
    instructions_fn, extensions = CONDITIONS[args.condition]
    instructions = instructions_fn()
    cases = load_cases(args.cases)
    tag = args.tag or f"{args.condition}-{time.strftime('%Y%m%d-%H%M')}"
    out = OUT_ROOT / tag
    out.mkdir(parents=True, exist_ok=True)
    os.chmod(out, 0o700)
    ensure_session()
    workers = [f"exam-{args.condition}-{k}" for k in range(1, args.parallel + 1)]
    for w in workers:
        ensure_agent(w, instructions, extensions)
    (out / "meta.json").write_text(json.dumps({"condition": args.condition, "runs": args.runs, "model": MODEL,
                                               "cases": [c["id"] for c in cases], "started": time.time(),
                                               "instructions_chars": len(instructions), "extensions": extensions}, indent=2))
    jobs = [(c, r) for r in range(1, args.runs + 1) for c in cases
            if not (out / f"{c['id']}-r{r}.json").exists()]
    queue = list(jobs)
    lock = threading.Lock()

    def worker(agent):
        while True:
            with lock:
                if not queue:
                    return
                case, r = queue.pop(0)
            label = f"{case['id']}-r{r}"
            try:
                status, text, secs, tools, reason = ask(agent, PREAMBLE + case["prompt"], label)
            except (urllib.error.URLError, TimeoutError) as e:
                status, text, secs, tools, reason = "error", None, None, {}, str(e)
            rec = {"case": case["id"], "split": case["split"], "run": r, "agent": agent, "status": status,
                   "seconds": secs, "tools": tools, "reason": reason, "answer": text}
            (out / f"{label}.json").write_text(json.dumps(rec, indent=2))
            print(json.dumps({k: rec[k] for k in ("case", "run", "status", "seconds", "tools")}), flush=True)

    with cf.ThreadPoolExecutor(len(workers)) as pool:
        list(pool.map(worker, workers))
    print(f"results: {out}")


def grade_one(agent, case, rec, rubric):
    payload = {"case": case["prompt"], "must_have": case["must_have"], "red_flags": case["red_flags"],
               "rubric": rubric, "answer": rec["answer"] or ""}
    for attempt in range(2):
        status, text, _, _, reason = ask(agent, json.dumps(payload), f"grade-{case['id']}-r{rec['run']}-{attempt}")
        try:
            g = json.loads(text[text.index("{"): text.rindex("}") + 1])
            assert set(DIMS) <= set(g["dimensions"]) and len(g["must_have"]) == len(case["must_have"])
            return g
        except Exception:
            continue
    return {"error": f"grader output unparsable ({status} {reason})"}


def score(g, case):
    if "error" in g:
        return None
    dims = sum(max(0, min(4, int(g["dimensions"][d]))) for d in DIMS)
    hits = sum(1 for m in g["must_have"] if m.get("hit"))
    flags = sum(1 for f in g["red_flags"] if f.get("present"))
    return max(0.0, round(100 * (0.5 * dims / 32 + 0.5 * hits / len(case["must_have"])) - 15 * flags, 1))


def cmd_grade(args):
    out = pathlib.Path(args.dir)
    cases = {c["id"]: c for c in json.loads((HERE / "cases.json").read_text())}
    rubric = (HERE / "rubric.md").read_text()
    graders = [f"exam-grader-{k}" for k in range(1, args.parallel + 1)]
    ensure_session()
    for g in graders:
        ensure_agent(g, (HERE / "grader.md").read_text(), {"memory": False, "library": False})
    todo = [p for p in sorted(out.glob("*-r*.json")) if not p.name.startswith("grade-")
            and not (out / f"grade-{p.name}").exists()]
    lock = threading.Lock()

    def worker(agent):
        while True:
            with lock:
                if not todo:
                    return
                p = todo.pop(0)
            rec = json.loads(p.read_text())
            case = cases[rec["case"]]
            g = grade_one(agent, case, rec, rubric) if rec.get("answer") else {"error": f"no answer ({rec['status']})"}
            g["score"] = score(g, case)
            (out / f"grade-{p.name}").write_text(json.dumps(g, indent=2))
            print(json.dumps({"file": p.name, "score": g["score"], "gap": g.get("biggest_gap") or g.get("error")}), flush=True)

    with cf.ThreadPoolExecutor(len(graders)) as pool:
        list(pool.map(worker, graders))


def summarize(out):
    meta = json.loads((out / "meta.json").read_text())
    rows = []
    for gp in sorted(out.glob("grade-*.json")):
        g = json.loads(gp.read_text())
        rec = json.loads((out / gp.name[len("grade-"):]).read_text())
        rows.append((rec, g))
    return meta, rows


def cmd_report(args):
    for d in args.dirs:
        out = pathlib.Path(d)
        meta, rows = summarize(out)
        scored = [(r, g) for r, g in rows if g.get("score") is not None]
        print(f"\n## {out.name}  (condition {meta['condition']}, {len(scored)}/{len(rows)} graded runs)\n")
        print("| Case | Split | Runs | Mean score | Min-max | Median s | Red flags |")
        print("|---|---|---|---|---|---|---|")
        by_case = collections.defaultdict(list)
        for r, g in scored:
            by_case[(r["case"], r["split"])].append((r, g))
        for (cid, split), items in sorted(by_case.items(), key=lambda kv: (kv[0][1], kv[0][0])):
            s = [g["score"] for _, g in items]
            secs = [r["seconds"] for r, _ in items if r["seconds"]]
            flags = sum(1 for _, g in items for f in g["red_flags"] if f.get("present"))
            print(f"| {cid} | {split} | {len(s)} | {statistics.mean(s):.1f} | {min(s):.0f}-{max(s):.0f} | "
                  f"{statistics.median(secs):.0f} | {flags} |")
        for split in ("train", "heldout"):
            s = [g["score"] for r, g in scored if r["split"] == split]
            if s:
                sd = statistics.stdev(s) if len(s) > 1 else 0
                print(f"\n{split}: mean {statistics.mean(s):.1f} (sd {sd:.1f}, n {len(s)})", end="")
        allscores = [g["score"] for _, g in scored]
        if allscores:
            print(f"\nall: mean {statistics.mean(allscores):.1f}")
        print("\n\n| Dimension | Mean (0-4) |\n|---|---|")
        for d in DIMS:
            v = [g["dimensions"][d] for _, g in scored]
            print(f"| {d} | {statistics.mean(v):.2f} |" if v else f"| {d} | - |")
        hits = collections.Counter()
        total = collections.Counter()
        for r, g in scored:
            for m in g["must_have"]:
                total[(r["case"], m["i"])] += 1
                hits[(r["case"], m["i"])] += bool(m.get("hit"))
        cases = {c["id"]: c for c in json.loads((HERE / "cases.json").read_text())}
        missed = sorted(((hits[k] / total[k], k) for k in total), key=lambda x: x[0])[:8]
        print("\nMost-missed must-haves:")
        for rate, (cid, i) in missed:
            print(f"- {rate:.0%} {cid}: {cases[cid]['must_have'][i]}")


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--condition", choices=sorted(CONDITIONS), required=True)
    r.add_argument("--runs", type=int, default=3)
    r.add_argument("--cases", default="all")
    r.add_argument("--parallel", type=int, default=3)
    r.add_argument("--tag")
    g = sub.add_parser("grade")
    g.add_argument("--dir", required=True)
    g.add_argument("--parallel", type=int, default=3)
    rep = sub.add_parser("report")
    rep.add_argument("dirs", nargs="+")
    args = p.parse_args()
    {"run": cmd_run, "grade": cmd_grade, "report": cmd_report}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
