#!/usr/bin/env python3
"""Create or refresh the oracle session on the oracle device (127.0.0.1:4790).

One session `oracle` working in ~/Documents/dev, with two agents for the A/B test:
  main        tool set "oracle" (slim: no bash, write or edit)
  oracle-all  tool set "all"
Both get the charter as instructions and the same model. Idempotent: rerun after editing the charter.
"""
import json, os, pathlib, sys, urllib.request

HERE = pathlib.Path(__file__).resolve().parent
BASE = os.environ.get("DPI_ORACLE_URL", "http://127.0.0.1:4790")
ENV = pathlib.Path.home() / ".dpi-oracle" / "backend.env"
TOKEN = next(l.split("=", 1)[1].strip() for l in ENV.read_text().splitlines() if l.startswith("DPI_TOKEN="))
MODEL = {"provider": "openrouter", "modelId": os.environ.get("ORACLE_MODEL", "anthropic/claude-opus-5.5")}
CWD = str(pathlib.Path.home() / "Documents" / "dev")


def api(method, path, body=None):
    req = urllib.request.Request(BASE + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"Authorization": f"Bearer {TOKEN}", "content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read() or b"null")


charter = (HERE / "charter.md").read_text()
sessions = {s["name"]: s for s in api("GET", "/v1/sessions")}
session = sessions.get("oracle") or api("POST", "/v1/sessions", {"name": "oracle", "cwd": CWD, "model": MODEL, "thinkingLevel": "medium"})
sid = session["id"]
agents = {a["name"]: a for a in api("GET", f"/v1/sessions/{sid}/agents")}
if "oracle-all" not in agents:
    api("POST", f"/v1/sessions/{sid}/agents", {"from": "main", "name": "oracle-all"})
for name, tool_set in (("main", "oracle"), ("oracle-all", "all")):
    cfg = api("PATCH", f"/v1/sessions/{sid}/agents/{name}/config",
              {"model": MODEL, "instructions": charter, "cwd": CWD, "toolSet": tool_set})
    print(f"{name}: toolSet={cfg.get('toolSet')} model={cfg['model']['modelId']} cwd={cfg['cwd']} "
          f"instructions={len(cfg.get('instructions') or '')} chars")
print(f"session {sid}")
