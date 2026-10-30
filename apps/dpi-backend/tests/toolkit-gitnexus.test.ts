// gitnexus: the read-only code-graph tool. The argv builder, the cypher guard and the output parsing are tested without
// GitNexus; one test runs a fake GitNexus (DPI_GITNEXUS_CMD) through a live session to prove the command, the folder,
// the arguments it actually gets and the no-index answer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkCypher,
  extractJson,
  GITNEXUS_COMMANDS,
  GITNEXUS_DEFAULT_CMD,
  GITNEXUS_MAX_CHARS,
  gitnexusArgv,
  gitnexusCmd,
  gitnexusText,
  noIndexMessage,
  plainLines,
  saysNoIndex,
  stalenessLine,
} from "../src/toolkit-gitnexus.js";
import { ORACLE_REMOVED, WRITE_TOOLS } from "../src/store.js";
import { faux, tempStore } from "./helpers.js";

const R = "/repo";

test("gitnexus argv: one typed builder per command, pinned to the index with --repo=", () => {
  assert.deepEqual([...GITNEXUS_COMMANDS], ["query", "context", "impact", "trace", "cypher", "check", "status"]);
  assert.deepEqual(gitnexusArgv({ command: "context", target: "subagentModelId" }, R), ["context", "subagentModelId", "--repo=/repo"]);
  assert.deepEqual(gitnexusArgv({ command: "context", target: "execute", file: "src/a.ts", limit: 10 }, R), [
    "context", "execute", "--file=src/a.ts", "--limit=10", "--repo=/repo",
  ]);
  assert.deepEqual(gitnexusArgv({ command: "context", uid: "Function:src/a.ts:foo", target: "ignored" }, R), [
    "context", "--uid=Function:src/a.ts:foo", "--repo=/repo",
  ], "uid wins over target");
  assert.deepEqual(
    gitnexusArgv({ command: "impact", target: "createStore", direction: "downstream", depth: 2, kind: "Function", include_tests: true, limit: 20 }, R),
    ["impact", "createStore", "--direction=downstream", "--kind=Function", "--depth=2", "--include-tests", "--limit=20", "--repo=/repo"],
  );
  assert.deepEqual(gitnexusArgv({ command: "trace", from: "a", to: "b", file: "x.ts", to_file: "y.ts", depth: 5 }, R), [
    "trace", "a", "b", "--from-file=x.ts", "--to-file=y.ts", "--depth=5", "--repo=/repo",
  ]);
  assert.deepEqual(gitnexusArgv({ command: "query", query: "auth flow", limit: 3 }, R), ["query", "auth flow", "--limit=3", "--repo=/repo"]);
  assert.deepEqual(gitnexusArgv({ command: "cypher", query: "MATCH (n) RETURN n.name" }, R), ["cypher", "MATCH (n) RETURN n.name", "--limit=50", "--repo=/repo"]);
  assert.deepEqual(gitnexusArgv({ command: "check" }, R), ["check", "--cycles", "--json", "--repo=/repo"]);
  assert.deepEqual(gitnexusArgv({ command: "status" }, R), ["status", "--json", "--repo=/repo"]);
  // A value that would be a flag stays inside --flag=value.
  assert.deepEqual(gitnexusArgv({ command: "context", target: "x", file: "--content" }, R), ["context", "x", "--file=--content", "--repo=/repo"]);
});

test("gitnexus argv: writing and unknown commands, '-' positionals, bad values and depth bounds are refused", () => {
  for (const command of ["analyze", "index", "clean", "remove", "setup", "uninstall", "serve", "mcp", "wiki", "publish", "update", "auto-sync", "embeddings", "group", "list", "", "--help", "impact;rm"])
    assert.throws(() => gitnexusArgv({ command, target: "x" }, R), /is not allowed/, command);
  assert.throws(() => gitnexusArgv({ command: "impact", target: "--help" }, R), /may not start with "-"/);
  assert.throws(() => gitnexusArgv({ command: "context", target: "-x" }, R), /may not start with "-"/);
  assert.throws(() => gitnexusArgv({ command: "trace", from: "a", to: "--depth=99" }, R), /may not start with "-"/);
  assert.throws(() => gitnexusArgv({ command: "trace", from: "-a", to: "b" }, R), /may not start with "-"/);
  assert.throws(() => gitnexusArgv({ command: "query", query: "--content" }, R), /may not start with "-"/);
  assert.throws(() => gitnexusArgv({ command: "cypher", query: "-MATCH (n) RETURN n" }, R), /may not start with "-"/);
  assert.throws(() => gitnexusArgv({ command: "impact" }, R), /needs target .* or uid/);
  assert.throws(() => gitnexusArgv({ command: "trace", from: "a" }, R), /to must be/);
  assert.throws(() => gitnexusArgv({ command: "query" }, R), /query must be/);
  assert.throws(() => gitnexusArgv({ command: "context", target: "a\nb" }, R), /Invalid target/);
  assert.throws(() => gitnexusArgv({ command: "context", target: "x".repeat(501) }, R), /Invalid target/);
  assert.throws(() => gitnexusArgv({ command: "impact", target: "x", direction: "sideways" }, R), /upstream or downstream/);
  assert.throws(() => gitnexusArgv({ command: "impact", target: "x", kind: "Function --x" }, R), /kind must be/);
  for (const depth of [0, 6, 2.5, -1, 100]) {
    assert.throws(() => gitnexusArgv({ command: "impact", target: "x", depth }, R), /depth must be a whole number from 1 to 5/, String(depth));
    assert.throws(() => gitnexusArgv({ command: "trace", from: "a", to: "b", depth }, R), /depth must be/, String(depth));
  }
  for (const depth of [1, 5]) assert.ok(gitnexusArgv({ command: "impact", target: "x", depth }, R).includes(`--depth=${depth}`));
  assert.throws(() => gitnexusArgv({ command: "cypher", query: "MATCH (n) RETURN n", limit: 201 }, R), /limit must be/);
  assert.throws(() => gitnexusArgv({ command: "query", query: "x", limit: 21 }, R), /limit must be/);
  assert.throws(() => gitnexusArgv({ command: "context", target: "x", limit: 0 }, R), /limit must be/);
});

test("gitnexus cypher: read queries pass; writes, loads, calls and multiple statements are refused in any case", () => {
  for (const q of [
    "MATCH (n:Function) WHERE n.name = 'x' RETURN n.name, n.filePath",
    "optional match (a)-[r]->(b) return count(r)",
    "WITH 1 AS x RETURN x",
    "UNWIND [1,2] AS x RETURN x",
    "MATCH (n) WHERE n.name = 'CREATE (m)' RETURN n", // keywords inside strings are fine
    'MATCH (n) WHERE n.content CONTAINS "DELETE n; SET x" RETURN n.name',
    "MATCH (n) RETURN n.callCount, n.settings // set nothing",
    "MATCH (n)-[:CodeRelation {type: 'CALLS'}]->(m) RETURN m.name;",
  ])
    assert.doesNotThrow(() => checkCypher(q), q);
  const refused: [string, RegExp][] = [
    ["MATCH (n) DETACH DELETE n", /DELETE, DETACH|DETACH|DELETE/],
    ["match (n) set n.x = 1 return n", /SET/],
    ["MATCH (n) REMOVE n.x RETURN n", /REMOVE/],
    ["MATCH (a) MERGE (a)-[:X]->(b) RETURN a", /MERGE/],
    ["MATCH (n) WITH n CREATE (m) RETURN m", /CREATE/],
    ["MATCH (n) CALL db.labels() RETURN n", /CALL/],
    ["MATCH (n) RETURN n; DROP TABLE Function", /single statement/],
    ["MATCH (n) WITH n FOREACH (x IN [1] | SET n.y = x) RETURN n", /SET|FOREACH/],
    ["CREATE (n:Function {name: 'x'})", /must be a read query/],
    ["DROP TABLE Function", /must be a read query/],
    ["COPY Function FROM 'x.csv'", /must be a read query/],
    ["LOAD EXTENSION fts", /must be a read query/],
    ["CALL show_tables() RETURN *", /must be a read query/],
    ["ALTER TABLE Function ADD x INT", /must be a read query/],
    ["MATCH (n) RETURN n LIMIT 1 /* */ ; CREATE (m)", /single statement/],
    ["MATCH (n) WHERE n.name = 'x RETURN n", /unclosed string/],
    ["MATCH (n) WITH n LOAD FROM 'x' RETURN n", /LOAD/],
  ];
  for (const [q, why] of refused) assert.throws(() => checkCypher(q), why, q);
  assert.throws(() => gitnexusArgv({ command: "cypher", query: "MATCH (n) DETACH DELETE n" }, R), /refused/);
});

test("gitnexus output: JSON after banner and pino log lines, trailing noise dropped; no JSON returns the text", () => {
  const log = '{"level":40,"time":1793329272249,"name":"gitnexus","msg":"Skipping registry entry during validation"}';
  const body = '{\n  "status": "found",\n  "incoming": {\n    "calls": [\n      { "name": "execute" }\n    ]\n  }\n}';
  const out = `\n  GitNexus Context (1.6.12)\n${log}\n${log}\n${body}\n`;
  assert.equal(extractJson(out), body);
  assert.deepEqual(JSON.parse(extractJson(`${out}${log}\nsomething after\n`)!), JSON.parse(body), "trailing log lines are dropped");
  assert.equal(extractJson('banner\n{"error":"Target \'x\' not found"}\n'), '{"error":"Target \'x\' not found"}');
  assert.equal(extractJson(`  GitNexus Status (1.6.12)\n${log}\nRepository not indexed.\nRun: gitnexus analyze\n`), undefined);
  assert.equal(extractJson(`${log}\n`), undefined, "a log record alone is not the answer");
  assert.equal(
    plainLines(`  GitNexus Context (1.6.12)\n${log}\nError: Multiple repositories indexed.\n    at LocalBackend.selectToolRepository (file:///x/local-backend.js:1437:15)\n\nNode.js v24.16.0\n`),
    "GitNexus Context (1.6.12)\nError: Multiple repositories indexed.",
  );
  assert.equal(gitnexusText(""), "(no output)");
  assert.match(gitnexusText("y".repeat(GITNEXUS_MAX_CHARS + 10)), /\[gitnexus output truncated: showed 40000 of 40010 characters/);
});

test("gitnexus: no-index detection, staleness line, command override; it is not a write tool so the oracle set keeps it", () => {
  for (const s of [
    '{"schemaVersion":1,"repository":"/x","storagePath":"/x/.gitnexus","error":"not-indexed"}',
    '{"schemaVersion":1,"error":"not-git-repository"}',
    "Repository not indexed.\nRun: gitnexus analyze",
    'Error: Multiple repositories indexed. Specify which one with the "repo" parameter.',
    'Error: Repository "/tmp/x" not found. Available: a, b',
  ])
    assert.ok(saysNoIndex(s), s);
  assert.ok(!saysNoIndex('{"status":"found"}'));
  assert.equal(noIndexMessage("proj").split(";")[0], "No GitNexus index for proj");
  assert.match(noIndexMessage("proj"), /ask for a manual index/);
  const fresh = stalenessLine({ repository: "/r", status: "stale", index: { commit: "a97dacb21af", indexedAt: "t" }, current: { commit: "a97dacb21af" } });
  assert.match(fresh, /at commit a97dacb, HEAD a97dacb \(the index is at HEAD\).*gitnexus staleness: stale/);
  assert.match(stalenessLine({ index: { commit: "aaaaaaa1" }, current: { commit: "bbbbbbb2" } }), /NOT at HEAD/);
  const saved = process.env.DPI_GITNEXUS_CMD;
  delete process.env.DPI_GITNEXUS_CMD;
  assert.deepEqual(gitnexusCmd(), GITNEXUS_DEFAULT_CMD.split(" "));
  assert.deepEqual(gitnexusCmd(), ["npx", "-y", "gitnexus@1.6.12"]);
  process.env.DPI_GITNEXUS_CMD = "  /opt/node   /opt/gitnexus.js ";
  assert.deepEqual(gitnexusCmd(), ["/opt/node", "/opt/gitnexus.js"]);
  if (saved === undefined) delete process.env.DPI_GITNEXUS_CMD;
  else process.env.DPI_GITNEXUS_CMD = saved;
  assert.equal(WRITE_TOOLS.has("gitnexus"), false);
  assert.equal(ORACLE_REMOVED.has("gitnexus"), false);
});

test("gitnexus: a session runs DPI_GITNEXUS_CMD argv-only in the repo folder, pinned to its index; no index gets the message", async () => {
  const t = await tempStore();
  const repo = join(t.work, "proj");
  const bare = join(t.work, "bare");
  mkdirSync(repo);
  mkdirSync(bare);
  const fake = join(t.root, "fake-gitnexus");
  const log = join(t.root, "calls.log");
  // Logs every call; prints a banner and a pino record to stderr like GitNexus. `status` answers not-indexed in a folder
  // without .indexed, else a status for the folder; any other command echoes its folder, env and argv as JSON.
  writeFileSync(
    fake,
    `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
printf '\\n  GitNexus (fake)\\n{"level":40,"time":1,"name":"gitnexus","msg":"Skipping registry entry"}\\n' >&2
echo "  GitNexus banner on stdout"
echo '{"level":30,"time":2,"name":"gitnexus","msg":"a log on stdout"}'
if [ "$1" = status ]; then
  if [ -e .indexed ]; then printf '{"repository":"%s","status":"up-to-date","index":{"commit":"1111111aaaa","indexedAt":"t"},"current":{"commit":"1111111aaaa"}}\\n' "$(pwd)";
  else printf '{"schemaVersion":1,"repository":"%s","error":"not-indexed"}\\n' "$(pwd)"; fi
  exit 0
fi
printf '{\\n  "cwd": "%s",\\n  "no_color": "%s",\\n  "ci": "%s",\\n  "argv": [' "$(pwd)" "$NO_COLOR" "$CI"
sep=""; for a in "$@"; do printf '%s"%s"' "$sep" "$a"; sep=", "; done
printf ']\\n}\\n'
echo '{"level":30,"time":3,"msg":"after"}' >&2
`,
  );
  chmodSync(fake, 0o755);
  writeFileSync(join(repo, ".indexed"), "");
  const saved = process.env.DPI_GITNEXUS_CMD;
  process.env.DPI_GITNEXUS_CMD = `/bin/sh ${fake}`;
  const store = await t.open();
  try {
    const s = await store.create({ name: "Gitnexus", cwd: t.work, model: faux });
    const { row, h, c } = await store.resolveAgent(s.id, "main");
    await store.configure(row, c, { toolSet: "oracle" });
    const offered = (await store.agentDetail(row, c)).tools.filter((x) => x.offered).map((x) => x.name);
    assert.ok(offered.includes("gitnexus") && !offered.includes("bash"), offered.join(","));
    await store.configure(row, c, { toolSet: "readOnly" });
    assert.ok((await store.agentDetail(row, c)).tools.find((x) => x.name === "gitnexus")?.offered, "readOnly keeps it too");

    let n = 0;
    const call = async (args: unknown) => {
      const sub = await store.send(c, { content: `tool: gitnexus ${JSON.stringify(args)}`, requestId: `g-${n++}` });
      assert.equal((await store.settled(h, sub.id as number, 15000)).status, "done");
      const text = (await store.transcript(c, "markdown")).text ?? "";
      return text.slice(text.lastIndexOf("Tool "));
    };
    const out = await call({ command: "impact", repo: "proj", target: "createStore; rm -rf /", direction: "upstream", depth: 2 });
    assert.match(out, /Index: .*proj at commit 1111111, HEAD 1111111 \(the index is at HEAD\).*gitnexus staleness: up-to-date/);
    assert.match(out, new RegExp(`"cwd": "${repo}"`));
    assert.match(out, /"no_color": "1"/);
    assert.match(out, /"ci": "1"/);
    // The transcript shortens the result; the call log below checks the whole argv.
    assert.match(out, /"argv": \["impact", "createStore; rm -rf \/", /, "one argument, never a shell");
    assert.doesNotMatch(out, /GitNexus banner|"level"/, "banner and log lines are dropped");
    assert.match(await call({ command: "context", repo: "bare", target: "foo" }), /No GitNexus index for bare; ask for a manual index/);
    assert.match(await call({ command: "cypher", repo: "proj", query: "MATCH (n) DETACH DELETE n" }), /refused/);
    assert.match(await call({ command: "context", repo: "proj", target: "--help" }), /may not start with "-"/);
    assert.match(await call({ command: "analyze", repo: "proj" }), /not allowed|Expected|must be/i);
    assert.match(await call({ command: "status", repo: "missing-dir" }), /does not exist/);
    const status = await call({ command: "status", repo: "proj" });
    assert.match(status, /gitnexus staleness: up-to-date/);
    const calls = readFileSync(log, "utf8").trim().split("\n");
    assert.deepEqual(calls, [
      "status --json",
      `impact createStore; rm -rf / --direction=upstream --depth=2 --repo=${repo}`,
      "status --json",
      "status --json",
    ], "refused calls never ran GitNexus; no index stops after status");
  } finally {
    if (saved === undefined) delete process.env.DPI_GITNEXUS_CMD;
    else process.env.DPI_GITNEXUS_CMD = saved;
    await store.close();
    await t.cleanup();
  }
});
