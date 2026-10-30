// pip3r: the read-only spot-check tool. The argv builder is tested without running pip3r; one test runs a fake pip3r
// (DPI_PIP3R_BIN) through a live session to prove the binary, the folder and the arguments it actually gets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ALLOWED, PIP3R_MAX_CHARS, PIP3R_SUBCOMMANDS, pip3rArgv, pip3rBin, pip3rText, pip3rTimeout, REFUSED } from "../src/toolkit-pip3r.js";
import { ORACLE_REMOVED, WRITE_TOOLS } from "../src/store.js";
import { faux, tempStore } from "./helpers.js";

const D = "/repo";

test("pip3r argv: allowlisted subcommands only, --json and --cwd always added, graphos and blast never auto-index", () => {
  assert.deepEqual([...PIP3R_SUBCOMMANDS], ["blast", "doctor", "verify", "graphos", "scout"]);
  for (const sub of ["init", "build", "ship", "runtime", "", "--help", "blast;rm"])
    assert.throws(() => pip3rArgv(sub, [], D), /is not allowed/, sub);

  assert.deepEqual(pip3rArgv("blast", ["createStore", "--max-depth", "2"], D), ["blast", "createStore", "--max-depth", "2", "--json", "--cwd", D, "--no-auto-index"]);
  assert.deepEqual(pip3rArgv("graphos", ["--refs=createStore"], D), ["graphos", "--refs=createStore", "--json", "--cwd", D, "--no-auto-index"]);
  assert.deepEqual(pip3rArgv("doctor", ["--typecheck"], D), ["doctor", "--typecheck", "--json", "--cwd", D]);
  assert.deepEqual(pip3rArgv("verify", ["--json"], D), ["verify", "--json", "--cwd", D], "--json is not doubled");
  assert.deepEqual(pip3rArgv("scout", ["--grep=-x flag"], D), ["scout", "--grep=-x flag", "--json", "--cwd", D], "a value that starts with - is written --flag=value");
  assert.throws(() => pip3rArgv("scout", ["--grep", "-x flag"], D), /may not start with "-"/, "a separate value token is never a flag");
  // Every subcommand gets --json, and every allowlist is free of refused flags.
  for (const sub of PIP3R_SUBCOMMANDS) {
    assert.ok(pip3rArgv(sub, [], D).includes("--json"), sub);
    for (const f of ALLOWED[sub]) assert.equal(REFUSED[sub][f.replace(/=$/, "")], undefined, `${sub} ${f}`);
  }
});

test("pip3r argv: writing and provisioning flags are refused in every spelling; unknown flags too", () => {
  const refused: [string, string][] = [
    ["graphos", "--write"],
    ["graphos", "--clean"],
    ["graphos", "--force"],
    ["graphos", "--index"],
    ["graphos", "--incremental"],
    ["graphos", "--embeddings"],
    ["graphos", "--write-context"],
    ["graphos", "--export-flag"],
    ["blast", "--auto-index"],
    ["doctor", "--hunt-seed"],
    ["doctor", "--hunt-seed-apply"],
    ["doctor", "--verify-refactor"],
    ["verify", "--hunt-seed"],
    ["verify", "--hunt-seed-apply"],
    ["verify", "--verify-refactor"],
  ];
  for (const [sub, flag] of refused) {
    assert.throws(() => pip3rArgv(sub, [flag], D), /is refused/, `${sub} ${flag}`);
    assert.throws(() => pip3rArgv(sub, [`${flag}=true`], D), /is refused/, `${sub} ${flag}=true`);
  }
  // pip3r also parses camelCase; those are not on the allowlist, so they are refused too.
  assert.throws(() => pip3rArgv("doctor", ["--huntSeedApply"], D), /not on this tool's list/);
  assert.throws(() => pip3rArgv("graphos", ["--writeContext"], D), /not on this tool's list/);
  assert.throws(() => pip3rArgv("blast", ["--autoIndex"], D), /not on this tool's list/);
  // The folder is the repo parameter's; no escape hatches.
  assert.throws(() => pip3rArgv("scout", ["--cwd", "/etc"], D), /is refused/);
  assert.throws(() => pip3rArgv("scout", ["-c", "/etc"], D), /is refused/);
  assert.throws(() => pip3rArgv("scout", ["--", "--write"], D), /`--` is not allowed/);
  assert.throws(() => pip3rArgv("scout", ["--grep"], D), /needs a value/);
  assert.throws(() => pip3rArgv("scout", ["--grep", "a\nb"], D), /Invalid value/);
  assert.throws(() => pip3rArgv("blast", ["--nope"], D), /not on this tool's list/);
  assert.throws(() => pip3rArgv("blast", Array(41).fill("x"), D), /At most 40/);
  assert.throws(() => pip3rArgv("blast", "x" as unknown as string[], D), /must be a list/);
});

test("pip3r: timeouts, output cap, binary override; it is not a write tool so the oracle set keeps it", () => {
  assert.equal(pip3rTimeout("blast", []), 120);
  assert.equal(pip3rTimeout("doctor", ["--test"]), 300);
  assert.equal(pip3rTimeout("verify", []), 300, "no check flag runs every check, tests included");
  assert.equal(pip3rTimeout("doctor", ["--typecheck"]), 120);
  assert.equal(pip3rTimeout("doctor", ["--no-test"]), 120);
  assert.equal(pip3rText(""), "(no output)");
  const cut = pip3rText("y".repeat(PIP3R_MAX_CHARS + 10));
  assert.match(cut, /\[pip3r output truncated: showed 40000 of 40010 characters/);
  const saved = process.env.DPI_PIP3R_BIN;
  delete process.env.DPI_PIP3R_BIN;
  assert.equal(pip3rBin(), "pip3r");
  process.env.DPI_PIP3R_BIN = "/opt/pip3r";
  assert.equal(pip3rBin(), "/opt/pip3r");
  if (saved === undefined) delete process.env.DPI_PIP3R_BIN;
  else process.env.DPI_PIP3R_BIN = saved;
  assert.equal(WRITE_TOOLS.has("pip3r"), false);
  assert.equal(ORACLE_REMOVED.has("pip3r"), false);
});

test("pip3r: a session runs the DPI_PIP3R_BIN binary argv-only in the repo folder; refused flags never reach it", async () => {
  const t = await tempStore();
  const repo = join(t.work, "proj");
  mkdirSync(repo);
  const fake = join(t.root, "fake-pip3r");
  const log = join(t.root, "calls.log");
  // Prints its folder and each argument on its own line, and logs every call.
  writeFileSync(fake, `#!/bin/sh\necho "cwd=$(pwd)" >> ${JSON.stringify(log)}\nprintf 'cwd=%s\\n' "$(pwd)"\nfor a in "$@"; do printf 'arg=%s\\n' "$a"; done\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\n`);
  chmodSync(fake, 0o755);
  const saved = process.env.DPI_PIP3R_BIN;
  process.env.DPI_PIP3R_BIN = fake;
  const store = await t.open();
  try {
    const s = await store.create({ name: "Pip3r", cwd: t.work, model: faux });
    const { row, h, c } = await store.resolveAgent(s.id, "main");
    await store.configure(row, c, { toolSet: "oracle" });
    const offered = (await store.agentDetail(row, c)).tools.filter((x) => x.offered).map((x) => x.name);
    assert.ok(offered.includes("pip3r") && !offered.includes("bash"), offered.join(","));
    await store.configure(row, c, { toolSet: "readOnly" });
    assert.ok((await store.agentDetail(row, c)).tools.find((x) => x.name === "pip3r")?.offered, "readOnly keeps it too");

    let n = 0;
    const call = async (args: unknown) => {
      const sub = await store.send(c, { content: `tool: pip3r ${JSON.stringify(args)}`, requestId: `p-${n++}` });
      assert.equal((await store.settled(h, sub.id as number, 15000)).status, "done");
      const text = (await store.transcript(c, "markdown")).text ?? "";
      return text.slice(text.lastIndexOf("Tool "));
    };
    const out = await call({ command: "blast", repo: "proj", args: ["createStore; rm -rf /", "--risk-only"] });
    assert.match(out, new RegExp(`cwd=${repo}`));
    assert.match(out, /arg=blast\n/);
    assert.match(out, /arg=createStore; rm -rf \/\n/, "one argument, never a shell");
    assert.match(out, /arg=--risk-only\narg=--json\narg=--cwd\n/);
    assert.match(out, /arg=--no-auto-index/);
    assert.match(await call({ command: "graphos", repo: "proj", args: ["--write", "--cypher", "MATCH (n) DELETE n"] }), /--write is refused/);
    assert.match(await call({ command: "build", repo: "proj" }), /not allowed|Expected|must be/i);
    assert.match(await call({ command: "scout", repo: "missing-dir" }), /does not exist/);
    const calls = readFileSync(log, "utf8").trim().split("\n");
    assert.equal(calls.length, 2, "only the allowed call ran pip3r");
    assert.equal(calls[1], `blast createStore; rm -rf / --risk-only --json --cwd ${repo} --no-auto-index`);
  } finally {
    if (saved === undefined) delete process.env.DPI_PIP3R_BIN;
    else process.env.DPI_PIP3R_BIN = saved;
    await store.close();
    await t.cleanup();
  }
});
