#!/usr/bin/env python3
"""Live measurement: grade Bags on the real gaps while we build them, not only on tabletop cases.

usage:
  live.py shadow <gap> <issue-number>   Before the work starts: real Bags (session `oracle`, agent `shadow`, read-only,
                                         with Bags memory and the course library) plans the gap from the issue text.
  live.py record <gap> <episode.json>   After the work is live-verified: store what actually happened (outcome metrics,
                                         and the must-haves and red flags that really mattered, written from the work).
  live.py grade <gap>                   Blind-grade the shadow plan against what really mattered.
  live.py report                        Table of all episodes.

Episodes live in ~/.dpi-oracle/live-episodes/<gap>/ (outside git). The shadow agent can read repos, GitHub and Bags
memory but cannot delegate or write, so planning a gap never starts real work.
"""
import json, pathlib, statistics, subprocess, sys, time, uuid
import importlib.util

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("run_exam", HERE / "run_exam.py")
ex = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ex)

ROOT = pathlib.Path.home() / ".dpi-oracle" / "live-episodes"
SESSION, AGENT = "oracle", "shadow"
REPO = "n4s5ti/bagley-voice"

SHADOW = (
    "This is a real open gap on your projects. Plan how you would take it to done. Another agent is doing the work "
    "now, so you cannot delegate or change anything; read whatever helps (repos, GitHub, your memory, the course "
    "library) and give the plan you would execute: what you check first, the units of work, who does each with what "
    "scope, how each is verified (including any live check), what you ask the user, and how you report.\n\nISSUE:\n"
)


def ask_oracle(content, label):
    """Same as run_exam.ask, but in the user's `oracle` session."""
    saved = ex.SESSION
    ex.SESSION = SESSION
    try:
        return ex.ask(AGENT, content, label)
    finally:
        ex.SESSION = saved


def ensure_shadow():
    a = f"/v1/sessions/{SESSION}/agents"
    if AGENT not in {x["name"] for x in ex.api("GET", a)}:
        ex.api("POST", a, {"from": "main", "name": AGENT})
    charter = (ex.ORACLE / "charter.md").read_text()
    ex.api("PATCH", f"{a}/{AGENT}/config", {"model": ex.MODEL, "instructions": charter, "cwd": ex.CWD, "toolSet": "readOnly"})
    known = {e["name"] for e in ex.api("GET", f"{a}/{AGENT}/extensions")["extensions"]}
    for ext, on in {"memory": True, "library": True, "expertise": True}.items():
        if ext in known:
            ex.api("PATCH", f"{a}/{AGENT}/extensions", {"name": ext, "enabled": on})


def cmd_shadow(gap, issue):
    d = ROOT / gap
    d.mkdir(parents=True, exist_ok=True)
    d.chmod(0o700)
    body = subprocess.run(["gh", "issue", "view", issue, "-R", REPO, "--json", "title,body", "-q", ".title + \"\\n\\n\" + .body"],
                          capture_output=True, text=True, check=True).stdout
    ensure_shadow()
    status, text, secs, tools, reason = ask_oracle(SHADOW + body, f"shadow-{gap}")
    rec = {"gap": gap, "issue": f"{REPO}#{issue}", "issue_text": body, "status": status, "seconds": secs,
           "tools": tools, "reason": reason, "plan": text, "at": time.time()}
    (d / "shadow.json").write_text(json.dumps(rec, indent=2))
    print(json.dumps({k: rec[k] for k in ("gap", "status", "seconds", "tools")}))


def cmd_record(gap, path):
    ep = json.loads(pathlib.Path(path).read_text())
    for k in ("outcome", "must_have", "red_flags", "metrics"):
        assert k in ep, f"episode needs {k}"
    (ROOT / gap / "episode.json").write_text(json.dumps(ep, indent=2))
    print(f"recorded {gap}")


def cmd_grade(gap):
    d = ROOT / gap
    sh = json.loads((d / "shadow.json").read_text())
    ep = json.loads((d / "episode.json").read_text())
    case = {"id": gap, "prompt": sh["issue_text"], "must_have": ep["must_have"], "red_flags": ep["red_flags"]}
    ex.ensure_session()
    ex.ensure_agent("exam-grader-1", (ex.HERE / "grader.md").read_text(), {"memory": False, "library": False, "expertise": False})
    g = ex.grade_one("exam-grader-1", case, {"run": 1, "answer": sh["plan"]}, (ex.HERE / "rubric.md").read_text())
    g["score"] = ex.score(g, case)
    (d / "grade.json").write_text(json.dumps(g, indent=2))
    print(json.dumps({"gap": gap, "score": g["score"], "gap_note": g.get("biggest_gap")}))


def cmd_report():
    print("| Gap | Shadow score | Outcome | Live acceptance | Harvest defects | User interventions | Hours to live |")
    print("|---|---|---|---|---|---|---|")
    for d in sorted(p for p in ROOT.glob("*") if p.is_dir()):
        ep = json.loads((d / "episode.json").read_text()) if (d / "episode.json").exists() else {}
        g = json.loads((d / "grade.json").read_text()) if (d / "grade.json").exists() else {}
        m = ep.get("metrics", {})
        print(f"| {d.name} | {g.get('score', '-')} | {ep.get('outcome', 'open')} | {m.get('live_acceptance', '-')} | "
              f"{m.get('harvest_defects', '-')} | {m.get('user_interventions', '-')} | {m.get('hours_to_live', '-')} |")


if __name__ == "__main__":
    cmd, *rest = sys.argv[1:]
    {"shadow": lambda: cmd_shadow(*rest), "record": lambda: cmd_record(*rest), "grade": lambda: cmd_grade(*rest),
     "report": cmd_report}[cmd]()
