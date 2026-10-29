#!/usr/bin/env python3
"""A/B probe for the oracle: send one prompt to an agent, wait, record time, tools used, answer and the project map.

usage: ab_probe.py <agent> <label> <prompt> [--fresh-map]
Writes $TMPDIR/oracle-ab/<label>.json. --fresh-map deletes /oracle from App State first so runs don't share a map.
"""
import collections, json, os, pathlib, sys, time, urllib.request, uuid

BASE = os.environ.get("DPI_ORACLE_URL", "http://127.0.0.1:4790")
ENV = pathlib.Path.home() / ".dpi-oracle" / "backend.env"
TOKEN = next(l.split("=", 1)[1].strip() for l in ENV.read_text().splitlines() if l.startswith("DPI_TOKEN="))
OUT = pathlib.Path(os.environ.get("TMPDIR", "/tmp")) / "oracle-ab"


def api(method, path, body=None, timeout=330):
    req = urllib.request.Request(BASE + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"Authorization": f"Bearer {TOKEN}", "content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read() or b"null")


agent, label, prompt = sys.argv[1:4]
a = f"/v1/sessions/oracle/agents/{agent}"
if "--fresh-map" in sys.argv:
    state = api("GET", "/v1/docs/app.shared-state")["value"] or {}
    if "oracle" in state:
        api("POST", f"{a}/demo/state", {"operation": "delete", "path": "/oracle"})
before = api("GET", f"{a}/entries?scope=all&limit=2000")["items"]
start = time.time()
sub = api("POST", f"{a}/messages", {"content": prompt, "requestId": f"ab-{label}-{uuid.uuid4().hex[:8]}"})
sid = sub["submissionId"]
result = sub
while result.get("status") in ("queued", "pending"):
    result = api("GET", f"/v1/sessions/oracle/submissions/{sid}?waitMs=240000")
    if time.time() - start > 1500:
        break
elapsed = round(time.time() - start, 1)
after = api("GET", f"{a}/entries?scope=all&limit=2000")["items"]
last = max((e["id"] for e in before), default=0)
new = sorted((e for e in after if e["id"] > last), key=lambda e: e["id"])  # entries come newest first
tools = collections.Counter()
for e in new:
    messages = e.get("model") or []
    for message in messages if isinstance(messages, list) else [messages]:
        for part in message.get("content", []) if isinstance(message, dict) and isinstance(message.get("content"), list) else []:
            if isinstance(part, dict) and part.get("type") == "toolCall":
                tools[part.get("name")] += 1
state = (api("GET", "/v1/docs/app.shared-state")["value"] or {}).get("oracle")
record = {"agent": agent, "label": label, "status": result.get("status"), "seconds": elapsed, "tools": dict(tools),
          "answer": (result.get("answer") or {}).get("text"), "reason": result.get("reason"), "oracleMap": state, "entries": len(new)}
OUT.mkdir(exist_ok=True)
(OUT / f"{label}.json").write_text(json.dumps(record, indent=2))
print(json.dumps({k: record[k] for k in ("agent", "label", "status", "seconds", "tools", "entries")}))
print("map projects:", sorted((state or {}).get("projects", {}).keys()))
print("reason:", record["reason"]) if record["reason"] else None
print("answer:", (record["answer"] or "")[:1500])
