// git: the read-only repository tool for the oracle tool set.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DIFF_MAX_CHARS, diffText, gitArgv, safePath, safeRef } from "../src/toolkit-git.js";
import { WRITE_TOOLS } from "../src/store.js";
import { faux, tempStore } from "./helpers.js";

test("git: refs that look like options are refused; every op is a read", () => {
  assert.throws(() => safeRef("--output=/tmp/x"), /Invalid ref/);
  assert.throws(() => safeRef("main; rm -rf ."), /Invalid ref/);
  assert.equal(safeRef("origin/main..HEAD~2"), "origin/main..HEAD~2");
  const writers = /^(commit|push|fetch|pull|checkout|switch|reset|merge|rebase|add|rm|mv|tag|config|gc|clean|restore|apply|am|cherry-pick|revert|init|clone)$/;
  for (const op of ["status", "log", "branches", "ahead_behind", "diff_stat", "diff", "show", "worktrees", "remotes"] as const)
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

test("git diff: argv is read-only, paths go after --, option-like paths and refs are refused, output is capped", () => {
  assert.deepEqual(gitArgv("diff", {}), [["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--"]]);
  assert.deepEqual(gitArgv("diff", { staged: true, path: "src/a.ts" }), [["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--cached", "--", "src/a.ts"]]);
  assert.deepEqual(gitArgv("diff", { ref: "main..feature", path: "docs" }), [["diff", "--no-ext-diff", "--no-textconv", "--no-color", "main..feature", "--", "docs"]]);
  assert.deepEqual(gitArgv("diff_stat", { path: "src" }), [["diff", "--stat", "--", "src"]]);
  assert.throws(() => gitArgv("diff", { path: "--output=/tmp/x" }), /Invalid path/);
  assert.throws(() => gitArgv("diff", { path: "-R" }), /Invalid path/);
  assert.throws(() => gitArgv("diff", { ref: "--ext-diff" }), /Invalid ref/);
  assert.throws(() => safePath("a\nb"), /Invalid path/);
  assert.equal(diffText("  \n"), "No differences");
  assert.equal(diffText("small"), "small");
  const big = diffText("x".repeat(DIFF_MAX_CHARS + 123));
  assert.equal(big.indexOf("[diff truncated"), DIFF_MAX_CHARS + 2);
  assert.match(big, /showed 40000 of 40123 characters/);
});

test("git diff: the oracle reads the patch text of unstaged, staged, a range and one path without changing the repo", async () => {
  const t = await tempStore();
  const repo = join(t.work, "proj");
  mkdirSync(repo);
  const g = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" }).toString();
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "Tester");
  writeFileSync(join(repo, "a.txt"), "one\n");
  writeFileSync(join(repo, "c.txt"), "keep\n");
  g("add", ".");
  g("commit", "-q", "-m", "first");
  writeFileSync(join(repo, "c.txt"), "keep\nsecond commit line\n");
  g("commit", "-q", "-am", "second");
  writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
  writeFileSync(join(repo, "b.txt"), "staged\n");
  g("add", "b.txt");
  const statusBefore = g("status", "--porcelain");
  const store = await t.open();
  try {
    const s = await store.create({ name: "GitDiff", cwd: t.work, model: faux });
    const { h, c, row } = await store.resolveAgent(s.id, "main");
    await store.configure(row, c, { toolSet: "oracle" });
    let n = 0;
    const call = async (args: unknown) => {
      const sub = await store.send(c, { content: `tool: git ${JSON.stringify(args)}`, requestId: `diff-${n++}` });
      assert.equal((await store.settled(h, sub.id as number, 15000)).status, "done");
      const text = (await store.transcript(c, "markdown")).text ?? "";
      return text.slice(text.lastIndexOf("Tool "));
    };
    const unstaged = await call({ op: "diff", repo: "proj" });
    assert.match(unstaged, /\+two/);
    assert.doesNotMatch(unstaged, /staged/);
    const staged = await call({ op: "diff", repo: "proj", staged: true });
    assert.match(staged, /\+staged/);
    assert.doesNotMatch(staged, /\+two/);
    assert.match(await call({ op: "diff", repo: "proj", ref: "HEAD~1..HEAD" }), /\+second commit line/);
    const onePath = await call({ op: "diff", repo: "proj", ref: "HEAD~1", path: "a.txt" });
    assert.match(onePath, /\+two/);
    assert.doesNotMatch(onePath, /second commit line/);
    assert.match(await call({ op: "diff", repo: "proj", path: "--output=leak.txt" }), /Invalid path/);
    assert.equal(g("status", "--porcelain"), statusBefore, "reading changed nothing");
  } finally {
    await store.close();
    await t.cleanup();
  }
});
