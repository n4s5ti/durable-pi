// git: the read-only repository tool for the oracle tool set.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitArgv, safeRef } from "../src/toolkit-git.js";
import { WRITE_TOOLS } from "../src/store.js";
import { faux, tempStore } from "./helpers.js";

test("git: refs that look like options are refused; every op is a read", () => {
  assert.throws(() => safeRef("--output=/tmp/x"), /Invalid ref/);
  assert.throws(() => safeRef("main; rm -rf ."), /Invalid ref/);
  assert.equal(safeRef("origin/main..HEAD~2"), "origin/main..HEAD~2");
  const writers = /^(commit|push|fetch|pull|checkout|switch|reset|merge|rebase|add|rm|mv|tag|config|gc|clean|restore|apply|am|cherry-pick|revert|init|clone)$/;
  for (const op of ["status", "log", "branches", "ahead_behind", "diff_stat", "show", "worktrees", "remotes"] as const)
    for (const argv of gitArgv(op, {})) assert.doesNotMatch(argv[0], writers, `${op} runs git ${argv[0]}`);
  assert.equal(WRITE_TOOLS.has("git"), false);
});

test("git: the oracle tool set offers it and it reports a repo's real state", async () => {
  const t = await tempStore();
  const repo = join(t.work, "proj");
  mkdirSync(repo);
  const g = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "Tester");
  writeFileSync(join(repo, "a.txt"), "one\n");
  g("add", "a.txt");
  g("commit", "-q", "-m", "first commit");
  writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
  writeFileSync(join(repo, "b.txt"), "staged\n");
  g("add", "b.txt");
  const store = await t.open();
  try {
    const s = await store.create({ name: "Git", cwd: t.work, model: faux });
    const { row, h, c } = await store.resolveAgent(s.id, "main");
    await store.configure(row, c, { toolSet: "oracle" });
    const offered = (await store.agentDetail(row, c)).tools.filter((x) => x.offered).map((x) => x.name);
    assert.ok(offered.includes("git") && !offered.includes("bash"));

    let n = 0;
    const call = async (args: unknown) => {
      const sub = await store.send(c, { content: `tool: git ${JSON.stringify(args)}`, requestId: `git-${n++}` });
      assert.equal((await store.settled(h, sub.id as number, 15000)).status, "done");
      const text = (await store.transcript(c, "markdown")).text ?? "";
      return text.slice(text.lastIndexOf("Tool "));
    };
    const status = await call({ op: "status", repo: "proj" });
    assert.match(status, /## main/);
    assert.match(status, /A {2}b\.txt/);
    assert.match(status, / M a\.txt/);
    assert.match(status, /1 file changed, 1 insertion/);
    assert.match(await call({ op: "log", repo: "proj" }), /first commit/);
    assert.match(await call({ op: "log", repo: "proj", ref: "--output=x" }), /Invalid ref/);
    // Reading never staged or committed anything.
    assert.equal(execFileSync("git", ["-C", repo, "rev-list", "--count", "HEAD"]).toString().trim(), "1");
    assert.match(execFileSync("git", ["-C", repo, "status", "--short"]).toString(), /^ M a\.txt\nA {2}b\.txt/);
  } finally {
    await store.close();
    await t.cleanup();
  }
});
