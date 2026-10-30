// The runner: where delegated work runs, the claude CLI line it builds, the session it parses, and the model ladder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BLAST_RULE,
  CLOUD_EFFORT,
  STOP_MESSAGE,
  cloudCommand,
  createRunner,
  escalationInstruction,
  runnerConfig,
  strongerModel,
  withBlastRule,
} from "../src/runner.js";
import { fakeClaude, pushedCheckout } from "./fake-claude.js";
import { tempStore } from "./helpers.js";

const hasScript = (() => {
  try {
    execFileSync("sh", ["-c", "command -v script"]);
    return true;
  } catch {
    return false;
  }
})();

test("config: cloud is the default for code, DPI_CLAUDE_BIN names the CLI, anything else is refused", () => {
  assert.deepEqual(runnerConfig({}), { code: "cloud", claudeBin: "claude" });
  assert.deepEqual(runnerConfig({ DPI_RUNNER_CODE: " LOCAL ", DPI_CLAUDE_BIN: "/opt/claude" }), { code: "local", claudeBin: "/opt/claude" });
  assert.throws(() => runnerConfig({ DPI_RUNNER_CODE: "mars" }), /DPI_RUNNER_CODE must be cloud or local, not mars/);
});

test("cloud dispatch builds script -qec with the model, effort high and the instruction, quoted", async () => {
  const calls: { file: string; args: string[]; cwd?: string }[] = [];
  const runner = createRunner({
    env: { DPI_CLAUDE_BIN: "/opt/my claude" },
    exec: async (file, args, options) => (calls.push({ file, args, cwd: options?.cwd }), { code: 0, out: "\u001b[32mSession: session_01ABC123\u001b[0m\r\n" }),
  });
  const started = await runner.dispatchCloud({ model: "claude-haiku-5-5", instruction: "fix it, it's \"broken\"\nsecond line", cwd: "/work/repo" });
  assert.deepEqual(started, { sessionId: "session_01ABC123", url: "https://claude.ai/code/session_01ABC123" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "script");
  assert.deepEqual(calls[0].args.slice(0, 1), ["-qec"]);
  assert.equal(calls[0].args[2], "/dev/null");
  assert.equal(calls[0].cwd, "/work/repo");
  assert.equal(
    calls[0].args[1],
    `'/opt/my claude' '--model' 'claude-haiku-5-5' '--effort' '${CLOUD_EFFORT}' '--cloud' 'fix it, it'\\''s "broken"\nsecond line'`,
  );
  assert.equal(CLOUD_EFFORT, "high");
  assert.deepEqual(cloudCommand({ code: "cloud", claudeBin: "claude" }, "m", "x").args.slice(0, 1), ["-qec"]);
});

test("cloud dispatch fails clearly when the CLI fails or prints no session", async () => {
  const failing = createRunner({ exec: async () => ({ code: 3, out: "not logged in: run claude login\r\n" }) });
  await assert.rejects(failing.dispatchCloud({ model: "m", instruction: "x", cwd: "." }), /claude --cloud failed \(exit 3\): not logged in: run claude login/);
  const silent = createRunner({ exec: async () => ({ code: 0, out: "Started something, but no id\n" }) });
  await assert.rejects(silent.dispatchCloud({ model: "m", instruction: "x", cwd: "." }), /claude --cloud printed no session id: Started something, but no id/);
  const missing = createRunner({ exec: async () => ({ code: 127, out: "spawn claude ENOENT" }) });
  await assert.rejects(missing.dispatchCloud({ model: "m", instruction: "x", cwd: "." }), /exit 127.*ENOENT/);
});

test("with a fake DPI_CLAUDE_BIN: the real script line passes model, effort and instruction through and the session is parsed", { skip: !hasScript }, async () => {
  const t = await tempStore();
  const fake = fakeClaude(join(t.root, "fake"));
  try {
    const runner = createRunner();
    const started = await runner.dispatchCloud({ model: "claude-sonnet-5-5", instruction: "line one\nit's \"two\" $HOME `x`", cwd: t.work });
    assert.match(started.sessionId, /^session_01FAKE0001$/);
    assert.deepEqual(fake.calls(), [["--model", "claude-sonnet-5-5", "--effort", "high", "--cloud", "line one\nit's \"two\" $HOME `x`"]]);
    fake.mode("fail");
    await assert.rejects(runner.dispatchCloud({ model: "m", instruction: "x", cwd: t.work }), /claude --cloud failed \(exit 3\): not logged in/);
    fake.mode("nosession");
    await assert.rejects(runner.dispatchCloud({ model: "m", instruction: "x", cwd: t.work }), /printed no session id: Started something/);
    fake.restore();
    process.env.DPI_CLAUDE_BIN = join(t.root, "does-not-exist");
    await assert.rejects(createRunner().dispatchCloud({ model: "m", instruction: "x", cwd: t.work }), /claude --cloud failed \(exit 127\)/);
  } finally {
    fake.restore();
    await t.cleanup();
  }
});

test("steer and stop on a cloud session go through claude -p --cloud <session>", async () => {
  const calls: { file: string; args: string[] }[] = [];
  const runner = createRunner({ env: { DPI_CLAUDE_BIN: "/opt/claude" }, exec: async (file, args) => (calls.push({ file, args }), { code: 0, out: "" }) });
  await runner.steerCloud("session_01X", "use the other API");
  await runner.stopCloud("session_01X");
  assert.deepEqual(calls, [
    { file: "/opt/claude", args: ["-p", "use the other API", "--cloud", "session_01X"] },
    { file: "/opt/claude", args: ["-p", STOP_MESSAGE, "--cloud", "session_01X"] },
  ]);
  const broken = createRunner({ exec: async () => ({ code: 1, out: "session not found" }) });
  await assert.rejects(broken.steerCloud("session_01X", "hi"), /claude -p --cloud session_01X failed \(exit 1\): session not found/);
});

test("placement: code in a clean, pushed checkout goes to the cloud; everything else stays local and says why", async () => {
  const t = await tempStore();
  const { repo, git } = pushedCheckout(t.root);
  try {
    const runner = createRunner({ env: {} });
    assert.deepEqual(await runner.place(t.work), { backend: "local", code: false }, "a plain folder is not code work");
    assert.deepEqual(await runner.place(repo), { backend: "cloud", code: true });
    assert.deepEqual(await createRunner({ env: { DPI_RUNNER_CODE: "local" } }).place(repo), { backend: "local", code: true });

    writeFileSync(join(repo, "b.txt"), "b\n");
    assert.match((await runner.place(repo)).reason ?? "", /clean pushed checkout: the checkout has uncommitted changes/);
    git("add", ".");
    git("commit", "-q", "-m", "second");
    const unpushed = await runner.place(repo);
    assert.equal(unpushed.backend, "local");
    assert.match(unpushed.reason ?? "", /1 commits are not pushed/);
    git("push", "-q");
    assert.equal((await runner.place(repo)).backend, "cloud");
    git("checkout", "-q", "-b", "topic");
    assert.match((await runner.place(repo)).reason ?? "", /the branch has no upstream/);
  } finally {
    await t.cleanup();
  }
});

test("models escalate haiku to sonnet to opus and stop there", () => {
  assert.equal(strongerModel("claude-haiku-latest"), "claude-sonnet-latest");
  assert.equal(strongerModel("claude-haiku-5-5"), "claude-sonnet-latest");
  assert.equal(strongerModel("claude-sonnet-5-5"), "claude-opus-latest");
  assert.equal(strongerModel("anthropic/claude-sonnet-5.5"), "claude-opus-latest");
  assert.equal(strongerModel("claude-opus-5-5"), undefined);
  assert.equal(strongerModel("echo"), undefined);
});

test("an escalated instruction repeats the task and carries the failure or the partial result", () => {
  const failed = escalationInstruction("Fix the parser", { model: "claude-haiku-5-5", status: "blocked", reason: "tests still fail" });
  assert.match(failed, /^Fix the parser\n\nA previous attempt on claude-haiku-5-5 blocked: tests still fail\n/);
  const partial = escalationInstruction("Fix the parser", { model: "claude-haiku-5-5", status: "stopped", result: "half done" });
  assert.match(partial, /stopped, partial result: half done/);
});

test("code instructions carry the blast rule; other work is sent as written", () => {
  assert.equal(withBlastRule("do it", false), "do it");
  const sent = withBlastRule("do it\n", true);
  assert.ok(sent.startsWith("do it\n\nBlast rule for every code change:"));
  for (const part of ["npx -y gitnexus@1.6.12 impact <symbol> --direction upstream", "context <symbol>", "git grep -w <symbol>", "more than five files"])
    assert.ok(BLAST_RULE.includes(part), part);
});
