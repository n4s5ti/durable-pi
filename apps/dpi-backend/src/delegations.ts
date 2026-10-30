// Delegations: one record shape for everything Bags hands to another agent (subagent, start_session, trigger todos),
// whichever backend the runner picked. The record holds the backend, the session id and link, the status and the result
// or reason; a trigger todo mirrors it. Trigger todos and escalations run as one background task each:
//
//   local   spawn (create the child once)  →  run (send the instruction, wait, settle the record and the todo)
//   cloud   launch (claim, start the cloud session through the runner, record its session and link)
//
// A task survives a restart at its checkpoint. The instruction is sent under a request id derived from the task, so a
// replayed run finds the first submission, and a cloud launch is claimed before the claude CLI runs: a restart that
// cuts a launch blocks the delegation instead of starting a second session. The claude CLI offers no way to read a
// cloud session's outcome back, so a cloud delegation stays running with its link until Bags marks it (todo done or
// block, delegation stop).
import type { Context } from "@earendil-works/chord";
import {
  configure,
  defineDoc,
  defineTask,
  type Agent,
  type ConversationId,
  type RunningTask,
  type TaskRuntime,
  type ToolExecutionApi,
  type ToolRegistration,
  type Tx,
} from "@earendil-works/pi-durable";
import { isAbsolute, resolve } from "node:path";
import type { WireMessage } from "../../dpi-sdk/src/api.js";
import { messageText } from "../../dpi-sdk/src/transcript.js";
import { TodoList, type TodoRun, type TodoTask } from "./toolkit.js";
import { escalationInstruction, strongerModel, withBlastRule, type Backend, type Runner } from "./runner.js";

export type DelegationSource = "todo" | "subagent" | "start_session";
export type DelegationStatus = "running" | "done" | "blocked" | "stopped";
export type ModelRef = { provider: string; modelId: string };

export type Delegation = {
  id: number;
  source: DelegationSource;
  /** What the work is, short: the todo's text or the task text. */
  label: string;
  backend: Backend;
  /** Why the runner did not use the cloud for code work (an unpushed branch, say). */
  backendReason?: string;
  status: DelegationStatus;
  /** The model as resolved on this device. */
  model: string;
  /** Bags's instruction, as written. The runner adds the blast rule when it sends code work. */
  instruction: string;
  cwd?: string;
  code: boolean;
  /** Cloud: the claude.ai session. Local start_session: the new session's id. */
  sessionId?: string;
  url?: string;
  /** Local: the child conversation (agent) doing the work. */
  conversationId?: number;
  result?: string;
  reason?: string;
  /** The delegation this one reran, and the one that reran this. */
  escalatedFrom?: number;
  escalatedTo?: number;
  /** The trigger todo this delegation drives, by its text. */
  todo?: string;
  /** The tool call that made this record, so a replayed call finds it. */
  key?: string;
  startedAt: number;
  endedAt?: number;
};

export type DelegationsDoc = { next: number; items: Record<string, Delegation> };

export const Delegations = defineDoc<DelegationsDoc>({
  kind: "dpi.delegations",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ next: 1, items: {} }),
  checkpointWhen: () => false,
});

/** A task has started its cloud dispatch, so a rerun of the phase must not start another. */
const LaunchClaim = defineDoc<{ claimed: boolean }>({
  kind: "dpi.delegation-claim",
  version: 1,
  scope: "task",
  initial: () => ({ claimed: false }),
  checkpointWhen: () => false,
});

const MAX_RECORDS = 60;
const RESULT_CHARS = 4000;
/** A copy that outlives the commit: a document object read inside one cannot be used after it. */
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A short name for an agent, from the first line of its task. */
export const nameFromTask = (text: string) => clip((text.trim().split("\n")[0] ?? "").replace(/\s+/g, " ").trim(), 60);

/** Tools a delegated worker never gets: no delegating further, no jobs, no paging, no memory or expertise writes. */
export const WORKER_REMOVED = new Set([
  "subagent",
  "start_session",
  "delegation",
  "run_durable_job",
  "ping_on_call_engineer",
  "remember",
  "forget",
  "expertise_update",
  "skill_update",
]);

/** The registrations to remove from a worker child, found in the agent that spawns it. */
export function workerRemoval(agent: Pick<Agent, "extensions">): ToolRegistration[] {
  const seen = new Map<string, ToolRegistration>();
  for (const extension of agent.extensions)
    for (const tool of extension.tools ?? []) if (WORKER_REMOVED.has(tool.name) && !seen.has(tool.name)) seen.set(tool.name, tool as ToolRegistration);
  return [...seen.values()];
}

const WORKER_INSTRUCTIONS =
  "You are a worker agent. Do exactly the task you are given with your code and read tools; do not delegate and do not ask questions. End with a short final answer: what you did, what you found and anything left undone.";

/** The child's system instructions: the worker brief, plus the blast rule for code work. */
export const workerInstructions = (code: boolean) => withBlastRule(WORKER_INSTRUCTIONS, code);

/** The text of an answer entry's assistant messages: the final answer without thinking or tool calls. */
export const answerText = (model: unknown) =>
  ((model ?? []) as WireMessage[])
    .map(messageText)
    .join("")
    .trim();

/** The cwd a delegation runs in: absolute or `~` as given, relative to the parent's folder. */
export const resolveCwd = (parent: string | undefined, cwd: string | undefined) =>
  cwd === undefined ? undefined : cwd.startsWith("~") || isAbsolute(cwd) ? cwd : resolve(parent ?? ".", cwd);

// ------------------------------------------------------------------ the engine

type Outcome = { status: "done"; result: string } | { status: "blocked"; reason: string } | { status: "stopped"; reason?: string };

export interface DelegationDeps {
  runner: Runner;
  /** A device model id or alias as a model ref; throws on an unknown id. */
  resolveModel: (id: string) => ModelRef;
  /** Name a child agent after its task. */
  nameAgent?: (conversationId: number, name: string) => void;
}

export type Plan = Omit<Delegation, "id" | "status" | "startedAt" | "endedAt"> & { modelRef: ModelRef };

type Input = { id: number; backend: Backend; modelRef: ModelRef };
type State = { phase: "spawn" } | { phase: "run"; child: number } | { phase: "launch" };
type Result = { status: string };
type Running = RunningTask<Input, State, Result>;
type Run = TaskRuntime<Input, State, Result, object>;

/** The slice of a tool call the engine needs. */
export type ToolApi = Pick<ToolExecutionApi, "taskId" | "conversationId" | "agent" | "commit" | "snapshot" | "conversation">;

const todoOf = (todos: { phases: { tasks: TodoTask[] }[] }, id: number) =>
  todos.phases.flatMap((p) => p.tasks).find((t) => t.kind === "trigger" && t.run?.id === id);

/** The record's current facts as the todo stores them. */
export function runOf(d: Delegation): TodoRun {
  return {
    id: d.id,
    backend: d.backend,
    model: d.model,
    ...(d.backendReason ? { backendReason: d.backendReason } : {}),
    ...(d.sessionId ? { sessionId: d.sessionId } : {}),
    ...(d.url ? { url: d.url } : {}),
    ...(d.conversationId !== undefined ? { conversationId: d.conversationId } : {}),
    ...(d.result ? { result: clip(d.result, 600) } : {}),
    startedAt: d.startedAt,
    ...(d.endedAt ? { endedAt: d.endedAt } : {}),
  };
}

export function createDelegations(deps: DelegationDeps) {
  const { runner } = deps;

  /** Change a record and its todo together. A todo follows the record only while it is running, unless `reopen`. */
  async function change(tx: Tx, conversationId: ConversationId, id: number, edit: (d: Delegation) => boolean | void, reopen = false) {
    const doc = await tx.doc(Delegations, conversationId);
    const d = doc.items[String(id)];
    if (!d || edit(d) === false) return undefined;
    const todo = d.todo ? todoOf(await tx.doc(TodoList, conversationId), id) : undefined;
    if (todo) {
      todo.run = runOf(d);
      if (todo.status === "running" || reopen) {
        todo.status = d.status === "running" ? "running" : d.status === "done" ? "done" : "blocked";
        if (d.status === "blocked" || d.status === "stopped") todo.reason = d.reason ?? "stopped";
        else delete todo.reason;
      }
    }
    return d;
  }

  /** Settle a running record exactly once; false when it already ended (stopped, say). */
  async function settle(tx: Tx, conversationId: ConversationId, id: number, outcome: Outcome, now: number) {
    let settled = false;
    const d = await change(tx, conversationId, id, (d) => {
      if (d.status !== "running") return false;
      d.status = outcome.status;
      d.endedAt = now;
      if (outcome.status === "done") d.result = clip(outcome.result, RESULT_CHARS);
      else if (outcome.reason) d.reason = clip(outcome.reason, 1000);
      settled = true;
    });
    if (!d || !settled) return false;
    const what = d.todo ? `Todo "${d.todo}"` : `Delegation #${d.id}`;
    const text = d.status === "done" ? `${what} done: ${clip(d.result ?? "", 300)}` : `${what} ${d.status === "stopped" ? "stopped" : "blocked"}: ${d.reason ?? "no reason given"}`;
    await tx.appendEntry(conversationId, { kind: "dpi.delegation", data: { delegationId: d.id, status: d.status, text } });
    return true;
  }

  /** Where this work goes, decided before anything is created: the model, the folder and the backend. */
  async function plan(
    api: Pick<ToolApi, "agent">,
    ctx: Context,
    input: { source: DelegationSource; label: string; instruction: string; model: string; cwd?: string; todo?: string; key?: string },
  ): Promise<Plan> {
    const modelRef = deps.resolveModel(input.model);
    const parent = await api.agent(ctx);
    const cwd = resolveCwd(parent.cwd, input.cwd);
    const placement = await runner.place(cwd ?? parent.cwd ?? ".");
    return {
      source: input.source,
      label: input.label,
      backend: placement.backend,
      ...(placement.reason ? { backendReason: placement.reason } : {}),
      model: modelRef.modelId,
      modelRef,
      instruction: input.instruction,
      ...(cwd ? { cwd } : {}),
      code: placement.code,
      ...(input.todo ? { todo: input.todo } : {}),
      ...(input.key ? { key: input.key } : {}),
    };
  }

  /** Add a record. A call with a `key` already recorded gets that record back. */
  async function record(tx: Tx, conversationId: ConversationId, p: Plan, now: number, extra: Partial<Delegation> = {}) {
    const doc = await tx.doc(Delegations, conversationId);
    const found = p.key ? Object.values(doc.items).find((d) => d.key === p.key) : undefined;
    if (found) return plain(found);
    const { modelRef: _model, ...rest } = p;
    const d: Delegation = { ...rest, id: doc.next, status: "running", startedAt: now, ...extra };
    doc.next += 1;
    doc.items[String(d.id)] = d;
    const ids = Object.keys(doc.items).map(Number).sort((a, b) => a - b);
    for (const old of ids.slice(0, Math.max(0, ids.length - MAX_RECORDS))) delete doc.items[String(old)];
    return plain(d);
  }

  const Task = defineTask<Input, State, Result, object>({
    name: "dpi.delegation",
    version: 1,
    initial: (input) => ({ phase: input.backend === "cloud" ? "launch" : "spawn" }),
    phases: {
      spawn: (task, runtime, ctx) => guard(task, runtime, ctx, async () => {
        const agent = await runtime.agent(ctx);
        await runtime.commit(async (tx) => {
          const d = (await tx.doc(Delegations, task.conversationId)).items[String(task.input.id)];
          if (!d || d.status !== "running") return finished("skipped");
          const created = await tx.createConversation({ ownership: { kind: "task", taskId: task.id } });
          await configure(tx, created.id, {
            tools: { remove: workerRemoval(agent) },
            model: task.input.modelRef,
            instructions: workerInstructions(d.code),
            ...(d.cwd ? { cwd: d.cwd } : {}),
          });
          await change(tx, task.conversationId, d.id, (x) => void (x.conversationId = created.id as number));
          return { status: "running", checkpoint: { phase: "run", child: created.id as number } };
        }, ctx);
      }),
      run: (task, runtime, ctx) => guard(task, runtime, ctx, async () => {
        const state = task.state.checkpoint as Extract<State, { phase: "run" }>;
        const doc = await runtime.snapshot(Delegations, task.conversationId, ctx);
        const d = doc?.items[String(task.input.id)];
        if (!d || d.status !== "running") return end(task, runtime, ctx, "skipped");
        deps.nameAgent?.(state.child, nameFromTask(d.label));
        const child = await runtime.conversation(state.child as ConversationId, ctx);
        if (!child) throw Error(`Child agent #${state.child} is missing`);
        // The request id belongs to the task, so a restart finds the first submission instead of sending twice.
        const submission = await child.submit({ type: "input", content: d.instruction, requestId: `delegation:${task.id}` }, ctx);
        const settled = await submission.wait(ctx);
        const view = settled.status === "done" && settled.type === "input" ? await runtime.context(state.child as ConversationId, ctx) : undefined;
        // Only the child's final answer text, not its thinking or tool calls.
        const text = answerText(view?.entries.find((e) => e.id === (settled as { answer?: unknown }).answer)?.model);
        const outcome: Outcome = text
          ? { status: "done", result: text }
          : { status: "blocked", reason: `Child agent #${state.child} gave no answer (${settled.status})` };
        await end(task, runtime, ctx, outcome.status, outcome);
      }),
      launch: (task, runtime, ctx) => guard(task, runtime, ctx, async () => {
        let go: "go" | "skip" | "interrupted" = "skip";
        let d: Delegation | undefined;
        await runtime.commit(async (tx) => {
          const found = (await tx.doc(Delegations, task.conversationId)).items[String(task.input.id)];
          d = found && plain(found);
          if (!d || d.status !== "running") return undefined;
          const claim = await tx.doc(LaunchClaim, task.id);
          go = claim.claimed ? "interrupted" : "go";
          claim.claimed = true;
          return undefined;
        }, ctx);
        if (go === "skip" || !d) return end(task, runtime, ctx, "skipped");
        const rec: Delegation = d;
        if (go === "interrupted")
          return end(task, runtime, ctx, "blocked", {
            status: "blocked",
            reason: "A restart cut the cloud dispatch, so a session may have started. Check claude.ai/code before rerunning; escalate reruns it.",
          });
        let started: { sessionId: string; url: string };
        try {
          started = await runner.dispatchCloud({ model: rec.model, instruction: withBlastRule(rec.instruction, rec.code), cwd: rec.cwd ?? "." });
        } catch (e) {
          return end(task, runtime, ctx, "blocked", { status: "blocked", reason: (e as Error).message });
        }
        await runtime.commit(async (tx) => {
          await change(tx, task.conversationId, rec.id, (x) => {
            x.sessionId = started.sessionId;
            x.url = started.url;
          });
          return finished("launched");
        }, ctx);
      }),
    },
    abort: async (task, runtime, ctx) => {
      await runtime.commit(async (tx) => {
        await settle(tx, task.conversationId, task.input.id, { status: "stopped", reason: "stopped" }, runtime.now());
        return { status: "terminal", outcome: { status: "aborted" } };
      }, ctx);
    },
  });

  const finished = (status: string) => ({ status: "terminal" as const, outcome: { status: "completed" as const, result: { status } } });

  /** Settle the record (when there is an outcome) and end the task in one commit. */
  const end = (task: Running, runtime: Run, ctx: Context, status: string, outcome?: Outcome) =>
    runtime.commit(async (tx) => {
      if (outcome) await settle(tx, task.conversationId, task.input.id, outcome, runtime.now());
      return finished(status);
    }, ctx);

  /** A phase that throws blocks its delegation with the error instead of faulting the task. */
  async function guard(task: Running, runtime: Run, ctx: Context, body: () => Promise<unknown>) {
    try {
      await body();
    } catch (e) {
      if (runtime.signal.aborted) throw e;
      await runtime.commit(async (tx) => {
        await settle(tx, task.conversationId, task.input.id, { status: "blocked", reason: (e as Error).message }, runtime.now());
        return finished("failed");
      }, ctx);
    }
  }

  /** Create the record and its background task together, inside the caller's commit. */
  async function start(tx: Tx, conversationId: ConversationId, p: Plan, now: number, extra: Partial<Delegation> = {}) {
    const d = await record(tx, conversationId, p, now, extra);
    await tx.createTask(
      Task,
      { id: d.id, backend: d.backend, modelRef: p.modelRef },
      { ownership: { kind: "conversation" }, conversationId, background: true },
    );
    return d;
  }

  // ---------------------------------------------------------------- Bags's support operations

  /** A delegation by id, or the latest one that drives the trigger todo with this text. */
  async function find(api: ToolApi, ctx: Context, ref: { id?: number; task?: string }) {
    const items = Object.values((await api.snapshot(Delegations, api.conversationId, ctx))?.items ?? {}).sort((a, b) => b.id - a.id);
    const hit = ref.id !== undefined ? items.find((d) => d.id === ref.id) : ref.task !== undefined ? items.find((d) => d.todo === ref.task) : undefined;
    if (hit) return hit;
    const known = items.slice(0, 10).map((d) => `#${d.id} ${d.todo ?? d.label}`).join("; ") || "none";
    throw Error(`No delegation ${ref.id !== undefined ? `#${ref.id}` : ref.task !== undefined ? `for todo "${ref.task}"` : "named: give id or task"}. Recent: ${known}`);
  }

  /** Only a running agent can be steered or stopped. */
  const needRunning = (d: Delegation, verb: string) => {
    if (d.status !== "running") throw Error(`Delegation #${d.id} is ${d.status}; ${verb} needs a running agent`);
  };

  /** Inject guidance into a running agent: the claude CLI for cloud, a steering message for local. */
  async function steer(api: ToolApi, ctx: Context, d: Delegation, message: string) {
    needRunning(d, "steer");
    if (d.backend === "cloud") {
      if (!d.sessionId) throw Error(`Delegation #${d.id} has no cloud session yet`);
      return runner.steerCloud(d.sessionId, message);
    }
    const requestId = `steer:${api.taskId}`;
    if (d.conversationId !== undefined) {
      const child = await api.conversation(d.conversationId as ConversationId, ctx);
      if (!child) throw Error(`Child agent #${d.conversationId} is missing`);
      await child.submit({ type: "input", content: message, requestId, whenBusy: "steer" }, ctx);
    } else throw Error(`Delegation #${d.id} has no agent to steer yet`);
  }

  /** End a running agent. A cloud session is told to stop (the CLI has no stop verb); a local one is aborted. */
  async function stop(api: ToolApi, ctx: Context, d: Delegation, reason = "stopped") {
    needRunning(d, "stop");
    const mark = () => api.commit((tx) => settle(tx, api.conversationId, d.id, { status: "stopped", reason }, Date.now()), ctx);
    if (d.backend === "cloud") {
      if (d.sessionId) await runner.stopCloud(d.sessionId);
      await mark();
      return;
    }
    // Marked first, so the run that is about to end finds the record stopped and does not call it a failure.
    await mark();
    if (d.conversationId !== undefined) await (await api.conversation(d.conversationId as ConversationId, ctx))?.abort(ctx);
  }

  /** Rerun the instruction on a stronger model, carrying the failure or partial result into it. */
  async function escalate(api: ToolApi, ctx: Context, d: Delegation, model?: string) {
    const next = model?.trim() || strongerModel(d.model);
    if (!next) throw Error(`Delegation #${d.id} already runs on ${d.model}, the strongest model; there is nothing to escalate to`);
    deps.resolveModel(next);
    if (d.status === "running") await stop(api, ctx, d, "stopped to escalate");
    const latest = (await find(api, ctx, { id: d.id })) ?? d;
    const p = await plan(api, ctx, {
      source: latest.todo ? "todo" : latest.source,
      label: latest.label,
      instruction: escalationInstruction(latest.instruction, { model: latest.model, status: latest.status, result: latest.result, reason: latest.reason }),
      model: next,
      cwd: latest.cwd,
      todo: latest.todo,
      key: `escalate:${api.taskId}`,
    });
    const now = Date.now();
    return api.commit(async (tx) => {
      const n = await start(tx, api.conversationId, p, now, { escalatedFrom: latest.id });
      await change(tx, api.conversationId, latest.id, (x) => void (x.escalatedTo = n.id));
      if (latest.todo) {
        const todo = todoOf(await tx.doc(TodoList, api.conversationId), latest.id);
        if (todo) {
          todo.status = "running";
          delete todo.reason;
          todo.run = runOf(n);
        }
      }
      return n;
    }, ctx);
  }

  /** Start a cloud session for a tool call (subagent, start_session) at most once: claimed before the CLI runs. */
  async function dispatchFromTool(api: ToolApi, ctx: Context, p: Plan) {
    const now = Date.now();
    const state = await api.commit(async (tx) => {
      const doc = await tx.doc(Delegations, api.conversationId);
      const found = Object.values(doc.items).find((d) => d.key === p.key);
      if (found) return { found: plain(found) };
      const claim = await tx.doc(LaunchClaim, api.taskId);
      if (claim.claimed) return { interrupted: true };
      claim.claimed = true;
      return {};
    }, ctx);
    if (state.found) return state.found;
    if (state.interrupted)
      return api.commit((tx) => record(tx, api.conversationId, p, now, { status: "blocked", endedAt: now, reason: "A restart cut the cloud dispatch, so a session may have started. Check claude.ai/code before rerunning." }), ctx);
    try {
      const started = await runner.dispatchCloud({ model: p.model, instruction: withBlastRule(p.instruction, p.code), cwd: p.cwd ?? "." });
      return await api.commit((tx) => record(tx, api.conversationId, p, now, started), ctx);
    } catch (e) {
      return api.commit((tx) => record(tx, api.conversationId, p, now, { status: "blocked", endedAt: now, reason: (e as Error).message }), ctx);
    }
  }

  return { tasks: [Task], plan, record, start, settle, change, find, steer, stop, escalate, dispatchFromTool, nameAgent: deps.nameAgent };
}

export type DelegationEngine = ReturnType<typeof createDelegations>;

