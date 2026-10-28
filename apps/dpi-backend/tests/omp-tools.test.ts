// The tools ported from Oh My Pi: todo's rules as a pure function, then every tool through a live session.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyTodo, renderTodo, splitPaths, type TodoPhase } from "../src/omp-tools.js";
import { faux, tempStore } from "./helpers.js";

const has = (bin: string) => {
  try {
    execFileSync("sh", ["-c", `command -v ${bin}`]);
    return true;
  } catch {
    return false;
  }
};

test("todo: init starts the first task, done moves on, only one task is active", () => {
  let p: TodoPhase[] = applyTodo([], { op: "init", list: [{ phase: "Build", items: ["a", "b"] }, { phase: "Ship", items: ["c"] }] });
  assert.deepEqual(p.flatMap((x) => x.tasks.map((t) => t.status)), ["active", "pending", "pending"]);
  p = applyTodo(p, { op: "done", task: "a" });
  assert.deepEqual(p.flatMap((x) => x.tasks.map((t) => t.status)), ["done", "active", "pending"]);
  p = applyTodo(p, { op: "start", task: "c" });
  assert.deepEqual(p.flatMap((x) => x.tasks.map((t) => t.status)), ["done", "pending", "active"]);
  p = applyTodo(p, { op: "block", task: "c", reason: "waiting on review" });
  assert.deepEqual(p.flatMap((x) => x.tasks.map((t) => t.status)), ["done", "active", "blocked"]);
  p = applyTodo(p, { op: "done", task: "b" });
  // Blocked tasks never start on their own.
  assert.deepEqual(p.flatMap((x) => x.tasks.map((t) => t.status)), ["done", "done", "blocked"]);
  p = applyTodo(p, { op: "unblock", task: "c" });
  assert.equal(p[1].tasks[0].status, "active");
  assert.match(renderTodo(p), /\[x\] a\n {2}\[x\] b\nShip\n {2}\[>\] c\n2\/3 done/);
});

test("todo: append, drop, rm, and errors name the problem", () => {
  let p: TodoPhase[] = applyTodo([], { op: "init", items: ["one"] });
  assert.equal(p[0].name, "Tasks");
  p = applyTodo(p, { op: "append", items: ["two", "three"] });
  p = applyTodo(p, { op: "drop", task: "two" });
  p = applyTodo(p, { op: "rm", task: "three" });
  assert.deepEqual(p[0].tasks.map((t) => `${t.content}:${t.status}`), ["one:active", "two:dropped"]);
  assert.throws(() => applyTodo(p, { op: "done", task: "nope" }), /No task "nope"/);
  assert.throws(() => applyTodo(p, { op: "append", items: ["one"] }), /Duplicate task "one"/);
  assert.throws(() => applyTodo(p, { op: "done" }), /needs task/);
  // A failed call leaves the input untouched.
  assert.equal(p[0].tasks.length, 2);
});

test("path lists split into paths and globs the way Oh My Pi reads them", () => {
  assert.deepEqual(splitPaths(undefined), { paths: [], globs: [] });
  assert.deepEqual(splitPaths("src; tests;!**/*.test.ts;*.md"), { paths: ["src", "tests"], globs: ["!**/*.test.ts", "*.md"] });
});

test("omp-tools: new agents get the tools, and each one runs in the session's folder", { skip: !has("rg") }, async () => {
  const t = await tempStore();
  mkdirSync(join(t.work, "src"), { recursive: true });
  writeFileSync(join(t.work, "src", "a.ts"), "export function alpha() {\n  return 1; // TODO tidy\n}\n");
  writeFileSync(join(t.work, "src", "b.ts"), "const beta = () => 2;\n");
  writeFileSync(join(t.work, "notes.md"), "todo list\n");
  const store = await t.open();
  try {
    const s = await store.create({ name: "Omp", cwd: t.work, model: faux });
    const { h, c } = await store.resolveAgent(s.id, "main");
    const names = (await store.agentDetail(store.row(s.id), c)).tools.map((x) => x.name);
    for (const name of ["think", "grep", "glob", "ast_grep", "todo"]) assert.ok(names.includes(name), `${name} offered`);

    let n = 0;
    const call = async (name: string, args: unknown) => {
      const sub = await store.send(c, { content: `tool: ${name} ${JSON.stringify(args)}`, requestId: `omp-${n++}` });
      assert.equal((await store.settled(h, sub.id as number, 15000)).status, "done");
      const text = (await store.transcript(c, "markdown")).text ?? "";
      return text.slice(text.lastIndexOf("Tool finished:"));
    };

    assert.match(await call("grep", { pattern: "TODO" }), /^Tool finished: src\/a\.ts\n {2}2: {2}return 1; \/\/ TODO tidy/);
    assert.match(await call("grep", { pattern: "todo", ignore_case: true, path: "*.md" }), /notes\.md\n {2}1:todo list/);
    assert.match(await call("grep", { pattern: "nothing-here" }), /No matches found/);
    assert.match(await call("glob", { pattern: "*.ts" }), /^Tool finished: src\/(a|b)\.ts\nsrc\/(a|b)\.ts/);
    assert.match(await call("think", { thought: "plan" }), /Noted\./);
    assert.match(await call("todo", { op: "init", items: ["read", "fix"] }), /\[>\] read\n {2}\[ \] fix/);
    assert.match(await call("todo", { op: "done", task: "read" }), /\[x\] read\n {2}\[>\] fix\n1\/2 done/);
    assert.match(await call("todo", { op: "view" }), /\[>\] fix/);
    if (has("ast-grep"))
      assert.match(await call("ast_grep", { pat: "function $NAME() { $$$ }", lang: "ts", path: "src" }), /src\/a\.ts:1: export function alpha\(\) \{ {2}\(\+2 lines\)/);
  } finally {
    await store.close();
    await t.cleanup();
  }
});
