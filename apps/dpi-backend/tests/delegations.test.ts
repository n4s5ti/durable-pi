// Trigger todos and the runner, through live sessions on the faux provider: a todo's agent starts without another
// turn, settles the todo, survives a restart without a second spawn, and Bags can escalate, steer and stop it on
// either backend. The cloud backend runs against a fake DPI_CLAUDE_BIN.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { resolveModelAlias } from "../src/model-catalog.js";
import { WORKER_REMOVED, type DelegationsDoc } from "../src/delegations.js";
import { Store } from "../src/store.js";
import { applyTodo, renderTodo, type TodoPhase, type TodoRun } from "../src/toolkit.js";
import { DpiClient } from "../../dpi-sdk/src/client.js";
import type { WireEntry } from "../../dpi-sdk/src/api.js";
import { messageText } from "../../dpi-sdk/src/transcript.js";
import { fakeClaude, pushedCheckout } from "./fake-claude.js";
import { bootServer, faux, newToken, tempStore, until } from "./helpers.js";

type Mode = "works" | "anthropic";

/** A faux device where every model alias resolves: to the working faux model, or (anthropic) to a provider this device lacks, so a local run fails and a cloud run names the real model. */
async function world(options: { mode?: Mode; git?: boolean } = {}) {
  const t = await tempStore();
  const fake = fakeClaude(join(t.root, "fake"));
  const repo = options.git ? pushedCheckout(t.root) : undefined;
  let store = await t.open();
  const asked: string[] = [];
  const state = { mode: options.mode ?? "works" };
  const stub = (s: Store) => {
    s.jobModel = (id: string) => {
      asked.push(id);
      return state.mode === "works" ? { provider: "faux", modelId: "echo" } : { provider: "anthropic", modelId: resolveModelAlias(id) };
    };
  };
  stub(store);
  const s = await store.create({ name: "Bags", cwd: repo?.repo ?? t.work, model: faux });
  let n = 0;
  const w = {
    t,
    fake,
    repo,
    asked,
    state,
    get store() {
      return store;
    },
    session: s,
    main: () => store.resolveAgent(s.id, "main"),
    /** One tool call from the oracle's conversation, settled; returns the tool's result text. */
    async call(name: string, args: unknown) {
      const { h, c } = await w.main();
      const sub = await store.send(c, { content: `tool: ${name} ${JSON.stringify(args)}`, requestId: `d-${n++}` });
      assert.equal((await store.settled(h, sub.id as number, 30000)).status, "done");
      const md = (await store.transcript(c, "markdown")).text ?? "";
      return md.slice(md.lastIndexOf("Tool "));
    },
    async phases() {
      const { h, c } = await w.main();
      return ((await store.agentDoc(h, c, "toolkit.todo")) as { phases: TodoPhase[] }).phases;
    },
    async todo(content: string) {
      const hit = (await w.phases()).flatMap((p) => p.tasks).find((x) => x.content === content);
      assert.ok(hit, `todo ${content}`);
      return hit;
    },
    async records() {
      const { h, c } = await w.main();
      return ((await store.agentDoc(h, c, "dpi.delegations")) as DelegationsDoc).items;
    },
    async settledTodo(content: string, ...states: string[]) {
      await until(async () => states.includes((await w.todo(content)).status), 30000, `${content} ${states.join("/")}`);
      return w.todo(content);
    },
    async children() {
      const { row } = await w.main();
      return (await store.agents(row)).filter((a) => a.kind === "subagent");
    },
    async entriesOf(agentId: number) {
      const { c } = await store.resolveAgent(s.id, String(agentId));
      return store.activeEntries(c);
    },
    async restart() {
      await store.close();
      store = await t.open();
      stub(store);
    },
    async done() {
      fake.restore();
      await store.close();
      await t.cleanup();
    },
  };
  return w;
}

/** Whether the agent's event stream carries a delegation event starting with `text`. */
const events = async (w: Awaited<ReturnType<typeof world>>, text: string) => {
  const { c } = await w.main();
  return (await w.store.activeEntries(c)).some((e) => e.kind === "dpi.delegation" && ((e as { data?: { text?: string } }).data?.text ?? "").startsWith(text));
};

/** The text of each user prompt among an agent's entries. */
const prompts = (entries: WireEntry[]) => entries.filter((e) => e.kind === "pi.user").map((e) => (e.model ?? []).map(messageText).join(""));

const userTurns = async (w: Awaited<ReturnType<typeof world>>, agentId: number) =>
  (await w.entriesOf(agentId)).filter((e) => e.kind === "pi.user").length;

test("trigger todo: adding it spawns the agent with exactly the instruction, no extra turn; done carries the result", async () => {
  const w = await world();
  try {
    await w.call("todo", { op: "init", items: ["plain one", "plain two"] });
    const view = await w.call("todo", { op: "trigger", task: "Say hi", instruction: "say hi to the build" });
    assert.match(view, /\[>\] plain one\n {2}\[ \] plain two\n {2}\[(~|x)\] Say hi/, "the plain todo keeps the active slot");
    const todo = await w.settledTodo("Say hi", "done");
    assert.equal(todo.kind, "trigger");
    assert.equal(todo.run?.backend, "local");
    assert.equal(todo.run?.result, "Echo: say hi to the build", "the result is the child's final answer text");
    assert.ok(todo.run?.conversationId !== undefined);
    // Exactly the instruction reached the child, once, on the default Haiku alias.
    const kids = await w.children();
    assert.equal(kids.length, 1);
    assert.equal(kids[0].id, todo.run!.conversationId);
    const entries = await w.entriesOf(kids[0].id);
    assert.deepEqual(prompts(entries), ["say hi to the build"]);
    assert.deepEqual(w.asked, ["claude-haiku-latest"]);
    // The oracle took no turn for it: its own user entries are just the two calls.
    assert.equal(await userTurns(w, 1), 2);
    // done is visible in todo view, in the stored doc and in the event stream.
    assert.match(await w.call("todo", { op: "view" }), /\[x\] Say hi \{local echo agent #\d+; result: Echo: say hi to the build\}\n1\/3 done/);
    assert.ok(await events(w, "Todo \"Say hi\" done: Echo: say hi to the build"));
    // Bags sees the same record shape from the delegation tool.
    const listed = JSON.parse((await w.call("delegation", { op: "list" })).replace(/^Tool finished: /, "")) as Record<string, unknown>[];
    assert.deepEqual(listed.map((d) => [d.id, d.source, d.backend, d.status, d.todo, d.result]), [[1, "todo", "local", "done", "Say hi", "Echo: say hi to the build"]]);
    // Plain todos behave as before around it.
    await w.call("todo", { op: "done", task: "plain one" });
    assert.equal((await w.todo("plain two")).status, "active");
    // A trigger todo's lifecycle is the agent's: it cannot be started or unblocked by hand.
    assert.match(await w.call("todo", { op: "start", task: "Say hi" }), /is a trigger todo/);
  } finally {
    await w.done();
  }
});

test("trigger todo: model and cwd are honoured, the label defaults to the instruction's first line", async () => {
  const w = await world();
  try {
    await w.call("todo", { op: "trigger", instruction: "inspect the folder\nand report", model: "claude-sonnet-latest", cwd: "project" });
    const todo = await w.settledTodo("inspect the folder", "done");
    assert.deepEqual(w.asked, ["claude-sonnet-latest"]);
    const { row } = await w.main();
    const detail = await w.store.agentDetail(row, (await w.store.resolveAgent(w.session.id, String(todo.run!.conversationId))).c);
    assert.equal(detail.config.cwd, join(w.t.work, "project"));
  } finally {
    await w.done();
  }
});

test("trigger todo: a failing agent leaves the todo blocked with the reason, visible in view and the event stream", async () => {
  const w = await world({ mode: "anthropic" });
  try {
    await w.call("todo", { op: "trigger", task: "Doomed", instruction: "do the impossible" });
    const todo = await w.settledTodo("Doomed", "blocked", "done");
    assert.equal(todo.status, "blocked");
    assert.match(todo.reason ?? "", /Child agent #\d+ gave no answer/);
    assert.match(await w.call("todo", { op: "view" }), /\[!\] Doomed \(blocked: Child agent #\d+ gave no answer \([a-z]+\)\)/);
    assert.ok(await events(w, "Todo \"Doomed\" blocked: Child agent"));
    assert.equal(Object.values(await w.records())[0].status, "blocked");
  } finally {
    await w.done();
  }
});

test("trigger todo: a graceful restart mid-run resumes the same child and never spawns a second", async () => {
  const w = await world();
  try {
    await w.call("todo", { op: "trigger", task: "Long job", instruction: `slow: ${"x ".repeat(900)}` });
    const [child] = await w.children();
    await until(async () => (await w.entriesOf(child.id)).some((e) => e.kind === "pi.user"), 20000, "child prompt");
    assert.equal((await w.todo("Long job")).status, "running");
    await w.restart();
    const todo = await w.settledTodo("Long job", "done", "blocked");
    assert.equal(todo.status, "done");
    assert.equal((await w.children()).length, 1);
    assert.equal(await userTurns(w, child.id), 1, "the instruction was admitted once");
    assert.equal(Object.keys(await w.records()).length, 1);
  } finally {
    await w.done();
  }
});

test("trigger todo: a SIGKILL mid-run resumes the same child and never spawns a second", async () => {
  const t = await tempStore();
  const token = newToken();
  const server = await bootServer({ home: join(t.root, "home"), startDirs: t.work, token });
  try {
    const client = new DpiClient(server.base, token);
    const s = await client.createSession({ name: "Kill", cwd: t.work, model: faux });
    const main = client.agent(s.id, "main");
    const call = JSON.stringify({ op: "trigger", task: "Long job", instruction: `slow: ${"x ".repeat(900)}`, model: "echo" });
    await main.send(`tool: todo ${call}`);
    const todo = async () => ((await main.doc<{ phases?: TodoPhase[] }>("toolkit.todo")).value.phases?.[0]?.tasks[0]);
    await until(async () => (await todo())?.run?.conversationId !== undefined, 20000, "child created");
    const childId = (await todo())!.run!.conversationId!;
    const prompts = async () => (await client.agent(s.id, childId).entries({ scope: "all" })).items.filter((e) => e.kind === "pi.user").length;
    await until(async () => (await prompts()) === 1, 20000, "child prompt");
    await server.stop("SIGKILL");
    await server.start();
    await until(async () => (await todo())?.status === "done", 40000, "done after restart");
    assert.equal(await prompts(), 1);
    assert.equal((await client.session(s.id).agents()).filter((a) => a.kind === "subagent").length, 1);
  } finally {
    await server.stop();
    await t.cleanup();
  }
});

test("cloud: a trigger todo in a clean pushed checkout starts a Claude cloud session and records its link", async () => {
  const w = await world({ git: true, mode: "anthropic" });
  try {
    await w.call("todo", { op: "trigger", task: "Cloud fix", instruction: "fix the bug in a.txt", model: "claude-sonnet-latest" });
    const todo = await w.settledTodo("Cloud fix", "running");
    assert.equal(todo.run?.backend, "cloud");
    await until(async () => (await w.todo("Cloud fix")).run?.sessionId !== undefined, 30000, "session recorded");
    const run = (await w.todo("Cloud fix")).run!;
    assert.equal(run.sessionId, "session_01FAKE0001");
    assert.equal(run.url, "https://claude.ai/code/session_01FAKE0001");
    assert.equal(run.model, "claude-sonnet-5-5");
    // The CLI got the resolved model, effort high, and the instruction with the blast rule.
    const [argv] = w.fake.calls();
    assert.deepEqual(argv.slice(0, 5), ["--model", "claude-sonnet-5-5", "--effort", "high", "--cloud"]);
    assert.ok(argv[5].startsWith("fix the bug in a.txt\n\nBlast rule for every code change:"));
    assert.match(argv[5], /npx -y gitnexus@1\.6\.12 impact <symbol> --direction upstream/);
    assert.equal((await w.children()).length, 0, "nothing ran locally");
    assert.match(await w.call("todo", { op: "view" }), /\[~\] Cloud fix \{running on cloud claude-sonnet-5-5 https:\/\/claude\.ai\/code\/session_01FAKE0001\}/);
    const [rec] = Object.values(await w.records());
    assert.deepEqual([rec.backend, rec.status, rec.sessionId], ["cloud", "running", "session_01FAKE0001"]);
    // The CLI cannot report an outcome back, so Bags closes it.
    await w.call("todo", { op: "done", task: "Cloud fix" });
    assert.equal((await w.todo("Cloud fix")).status, "done");
  } finally {
    await w.done();
  }
});

test("cloud: a dirty checkout, DPI_RUNNER_CODE=local and a plain folder all run local, with the reason recorded", async () => {
  const w = await world({ git: true });
  try {
    process.env.DPI_RUNNER_CODE = "local";
    await w.call("todo", { op: "trigger", task: "Local by policy", instruction: "say policy" });
    assert.equal((await w.settledTodo("Local by policy", "done")).run?.backend, "local");
    delete process.env.DPI_RUNNER_CODE;
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(w.repo!.repo, "dirty.txt"), "x\n");
    await w.call("todo", { op: "trigger", task: "Dirty", instruction: "say dirty" });
    const dirty = await w.settledTodo("Dirty", "done");
    assert.equal(dirty.run?.backend, "local");
    assert.match(dirty.run?.backendReason ?? "", /uncommitted changes/);
    assert.deepEqual(w.fake.calls(), [], "the cloud CLI never ran");
  } finally {
    await w.done();
  }
});

test("cloud: a failing CLI blocks the todo with the CLI's message", async () => {
  const w = await world({ git: true });
  try {
    w.fake.mode("fail");
    await w.call("todo", { op: "trigger", task: "No login", instruction: "fix it" });
    const todo = await w.settledTodo("No login", "blocked");
    assert.match(todo.reason ?? "", /claude --cloud failed \(exit 3\): not logged in: run claude login/);
    w.fake.mode("nosession");
    await w.call("todo", { op: "trigger", task: "No id", instruction: "fix it again" });
    assert.match((await w.settledTodo("No id", "blocked")).reason ?? "", /printed no session id/);
  } finally {
    await w.done();
  }
});

test("cloud: a restart that cuts the dispatch blocks the todo instead of starting a second session", async () => {
  const w = await world({ git: true });
  try {
    w.fake.mode("slow");
    await w.call("todo", { op: "trigger", task: "Slow launch", instruction: "fix it" });
    await until(async () => w.fake.calls().length === 1, 20000, "CLI started");
    await w.restart();
    const todo = await w.settledTodo("Slow launch", "blocked");
    assert.match(todo.reason ?? "", /A restart cut the cloud dispatch/);
    assert.equal(w.fake.calls().length, 1, "no second session was started");
  } finally {
    await w.done();
  }
});

test("escalate (local): the same instruction reruns on the next model with the failure carried in; the todo follows", async () => {
  const w = await world({ mode: "anthropic" });
  try {
    await w.call("todo", { op: "trigger", task: "Hard task", instruction: "solve the hard thing", model: "claude-haiku-latest" });
    await w.settledTodo("Hard task", "blocked");
    w.state.mode = "works";
    const out = await w.call("delegation", { op: "escalate", task: "Hard task" });
    assert.match(out, /"escalated":\{"id":2,"source":"todo","label":"Hard task","backend":"local","status":"running"/);
    assert.equal(w.asked[0], "claude-haiku-latest");
    assert.ok(w.asked.slice(1).every((id) => id === "claude-sonnet-latest"));
    const todo = await w.settledTodo("Hard task", "done");
    assert.equal(todo.run?.id, 2);
    assert.equal(todo.reason, undefined);
    assert.match(todo.run?.result ?? "", /^Echo: solve the hard thing\n\nA previous attempt on claude-haiku-5-5 blocked: Child agent #\d+ gave no answer/);
    const records = await w.records();
    assert.equal(records["1"].escalatedTo, 2);
    assert.equal(records["2"].escalatedFrom, 1);
    // Opus is the top of the ladder.
    await w.call("delegation", { op: "escalate", task: "Hard task", model: "claude-opus-latest" });
    await w.settledTodo("Hard task", "done");
    assert.match(await w.call("delegation", { op: "escalate", task: "Hard task" }), /already runs on echo|nothing to escalate/);
  } finally {
    await w.done();
  }
});

test("escalate (cloud): a running cloud session is stopped and the instruction restarts on a stronger model", async () => {
  const w = await world({ git: true, mode: "anthropic" });
  try {
    await w.call("todo", { op: "trigger", task: "Cloud hard", instruction: "solve it", model: "claude-haiku-latest" });
    await until(async () => (await w.todo("Cloud hard")).run?.sessionId !== undefined, 30000, "first session");
    await w.call("delegation", { op: "escalate", task: "Cloud hard" });
    await until(async () => w.fake.calls().length === 3, 30000, "stop message and second dispatch");
    const calls = w.fake.calls();
    assert.deepEqual(calls[1].slice(0, 1).concat(calls[1].slice(2)), ["-p", "--cloud", "session_01FAKE0001"], "the first session was told to stop");
    assert.deepEqual(calls[2].slice(0, 5), ["--model", "claude-sonnet-5-5", "--effort", "high", "--cloud"]);
    assert.match(calls[2][5], /^solve it\n\nA previous attempt on claude-haiku-5-5 stopped: stopped to escalate\n/);
    assert.match(calls[2][5], /Blast rule for every code change:/);
    await until(async () => (await w.todo("Cloud hard")).run?.sessionId === "session_01FAKE0003", 30000, "second session");
    const todo = await w.todo("Cloud hard");
    assert.equal(todo.status, "running");
    assert.equal(todo.run?.id, 2);
    assert.equal((await w.records())["1"].status, "stopped");
  } finally {
    await w.done();
  }
});

test("steer (cloud): claude -p <message> --cloud <session>; a finished agent cannot be steered", async () => {
  const w = await world({ git: true });
  try {
    await w.call("todo", { op: "trigger", task: "Steer me", instruction: "fix it" });
    await until(async () => (await w.todo("Steer me")).run?.sessionId !== undefined, 30000, "session");
    await w.call("delegation", { op: "steer", task: "Steer me", message: "use the other API" });
    assert.deepEqual(w.fake.calls()[1], ["-p", "use the other API", "--cloud", "session_01FAKE0001"]);
    await w.call("delegation", { op: "stop", id: 1 });
    assert.match(await w.call("delegation", { op: "steer", id: 1, message: "too late" }), /Delegation #1 is stopped; steer needs a running agent/);
  } finally {
    await w.done();
  }
});

test("steer (local): the message is queued into the running child as steering", async () => {
  const w = await world();
  try {
    await w.call("todo", { op: "trigger", task: "Steer local", instruction: `slow: ${"x ".repeat(900)}` });
    const [child] = await w.children();
    await until(async () => (await userTurns(w, child.id)) === 1, 20000, "child prompt");
    await w.call("delegation", { op: "steer", task: "Steer local", message: "use the other API" });
    await until(async () => (await userTurns(w, child.id)) === 2, 20000, "steer admitted");
    assert.equal(prompts(await w.entriesOf(child.id))[1], "use the other API");
  } finally {
    await w.done();
  }
});

test("stop (local and cloud): the agent ends, the record says stopped and the todo is blocked, not failed", async () => {
  const w = await world({ git: true });
  try {
    // Local: a long run in a plain folder.
    await w.call("todo", { op: "trigger", task: "Stop local", instruction: `slow: ${"x ".repeat(900)}`, cwd: w.t.work });
    const [child] = await w.children();
    await until(async () => (await userTurns(w, child.id)) === 1, 20000, "child prompt");
    await w.call("delegation", { op: "stop", task: "Stop local" });
    await until(async () => (await w.todo("Stop local")).status === "blocked", 20000, "blocked");
    assert.equal((await w.todo("Stop local")).reason, "stopped");
    assert.equal(Object.values(await w.records()).find((r) => r.todo === "Stop local")?.status, "stopped");
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal((await w.todo("Stop local")).reason, "stopped", "the aborted run did not overwrite it with a failure");
    // Cloud.
    await w.call("todo", { op: "trigger", task: "Stop cloud", instruction: "fix it" });
    await until(async () => (await w.todo("Stop cloud")).run?.sessionId !== undefined, 30000, "session");
    await w.call("delegation", { op: "stop", task: "Stop cloud" });
    const last = w.fake.calls().at(-1)!;
    assert.deepEqual([last[0], last[2], last[3]], ["-p", "--cloud", "session_01FAKE0001"]);
    assert.match(last[1], /^Stop now\./);
    assert.deepEqual([(await w.todo("Stop cloud")).status, (await w.todo("Stop cloud")).reason], ["blocked", "stopped"]);
  } finally {
    await w.done();
  }
});

test("S1 S2 S3 S6: subagent returns the final answer and a link, runs with worker tools in the given cwd, named from its task", async () => {
  const w = await world();
  try {
    const out = await w.call("subagent", { task: "List the files\nthen stop", cwd: "project" });
    assert.match(out, /^Tool finished: Echo: List the files\nthen stop\n\nChild: agent #\d+/m, "only the final answer text plus a link");
    assert.doesNotMatch(out, /"role"|"content"|thinking/);
    const [child] = await w.children();
    assert.equal(child.name, "List the files", "S6: named from the task text");
    const { row } = await w.main();
    const detail = await w.store.agentDetail(row, (await w.store.resolveAgent(w.session.id, String(child.id))).c);
    const offered = detail.tools.filter((t) => t.offered).map((t) => t.name);
    for (const gone of WORKER_REMOVED) assert.ok(!offered.includes(gone), `S2: ${gone} is not offered to a worker`);
    for (const kept of ["bash", "read", "write", "edit", "grep", "todo"]) assert.ok(offered.includes(kept), `S2: ${kept} stays`);
    assert.equal(detail.config.cwd, join(w.t.work, "project"), "S3: cwd resolves against the parent's folder");
    // The parent still has the delegation tools.
    const main = await w.store.agentDetail(row, (await w.main()).c);
    for (const tool of ["subagent", "start_session", "delegation"]) assert.ok(main.tools.some((t) => t.name === tool && t.offered), tool);
    const [rec] = Object.values(await w.records());
    assert.deepEqual([rec.source, rec.backend, rec.status, rec.conversationId], ["subagent", "local", "done", child.id]);
  } finally {
    await w.done();
  }
});

test("subagent in a clean pushed checkout goes to the cloud and returns at once with the link", async () => {
  const w = await world({ git: true, mode: "anthropic" });
  try {
    const out = await w.call("subagent", { task: "fix a.txt", model: "claude-haiku-latest" });
    assert.match(out, /Started in the cloud: https:\/\/claude\.ai\/code\/session_01FAKE0001 \(delegation #1, claude-haiku-5-5\)/);
    assert.equal((await w.children()).length, 0);
    assert.deepEqual(w.fake.calls()[0].slice(0, 5), ["--model", "claude-haiku-5-5", "--effort", "high", "--cloud"]);
    w.fake.mode("fail");
    assert.match(await w.call("subagent", { task: "fix again" }), /Cloud dispatch failed: claude --cloud failed \(exit 3\)/);
    const records = Object.values(await w.records());
    assert.deepEqual(records.map((r) => r.status), ["running", "blocked"]);
  } finally {
    await w.done();
  }
});

test("start_session: a prompt in a pushed checkout starts a cloud session; an idle session stays on this device", async () => {
  const w = await world({ git: true, mode: "anthropic" });
  try {
    const cloud = await w.call("start_session", { name: "Worker", cwd: ".", prompt: "fix a.txt" });
    assert.match(cloud, /Started cloud session "Worker" \(https:\/\/claude\.ai\/code\/session_01FAKE0001, claude-haiku-5-5, delegation #1\)/);
    assert.equal(w.store.list().some((r) => r.name === "Worker"), false);
    w.state.mode = "works";
    const idle = await w.call("start_session", { name: "Idle", cwd: "." });
    assert.match(idle, /Started session "Idle"/);
    assert.equal(w.store.list().some((r) => r.name === "Idle"), true);
    assert.equal(w.fake.calls().length, 1);
  } finally {
    await w.done();
  }
});

test("a read only agent cannot trigger: trigger needs the subagent tool, and delegation is a writer", async () => {
  const w = await world();
  try {
    const { row, c } = await w.main();
    await w.store.configure(row, c, { toolSet: "readOnly" });
    assert.match(await w.call("todo", { op: "trigger", task: "Sneaky", instruction: "x" }), /trigger needs the subagent tool/);
    const names = (await w.store.agentDetail(row, c)).tools.filter((t) => t.offered).map((t) => t.name);
    assert.ok(!names.includes("delegation") && !names.includes("subagent"));
    assert.ok((await w.store.agentDetail(row, c)).tools.find((t) => t.name === "delegation")?.writes);
    assert.equal((await w.children()).length, 0);
  } finally {
    await w.done();
  }
});

const RUN: TodoRun = { id: 1, backend: "local", model: "m", startedAt: 1 };

test("todo rules: a trigger todo never takes the active slot, and plain todos keep their exact shape", () => {
  let p: TodoPhase[] = applyTodo([], { op: "init", list: [{ phase: "Build", items: ["a", "b"] }] });
  assert.deepEqual(p, [{ name: "Build", tasks: [{ content: "a", status: "active" }, { content: "b", status: "pending" }] }], "plain tasks gain no new fields");
  p = applyTodo(p, { op: "trigger", task: "t", instruction: "do it", run: RUN });
  assert.deepEqual(p[0].tasks.map((x) => x.status), ["active", "pending", "running"]);
  assert.deepEqual(p[0].tasks[2], { content: "t", status: "running", kind: "trigger", instruction: "do it", run: RUN });
  p = applyTodo(p, { op: "done", task: "a" });
  assert.deepEqual(p[0].tasks.map((x) => x.status), ["done", "active", "running"], "the next plain task starts; the trigger todo is left alone");
  p = applyTodo(p, { op: "done", phase: "Build" });
  assert.deepEqual(p[0].tasks.map((x) => x.status), ["done", "done", "running"], "a whole-phase done does not finish a running agent");
  assert.match(renderTodo(p), /\[~\] t \{running on local m\}\n2\/3 done/);
  assert.throws(() => applyTodo(p, { op: "start", task: "t" }), /"t" is a trigger todo/);
  assert.throws(() => applyTodo(p, { op: "unblock", task: "t" }), /is a trigger todo/);
  assert.throws(() => applyTodo(p, { op: "trigger", task: "t", instruction: "again", run: RUN }), /Duplicate task "t"/);
  assert.throws(() => applyTodo(p, { op: "trigger", task: "u", run: RUN }), /needs instruction/);
  assert.throws(() => applyTodo(p, { op: "trigger", task: "u", instruction: "x" }), /no run/);
  // Blocking and unblocking plain tasks is unchanged.
  const q = applyTodo(applyTodo([], { op: "init", items: ["x", "y"] }), { op: "block", task: "x", reason: "waiting" });
  assert.deepEqual(q[0].tasks.map((x) => x.status), ["blocked", "active"]);
});
