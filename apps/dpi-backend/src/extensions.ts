import type { SharedState } from "./shared-state.js";
import { Type } from "@earendil-works/pi-ai";
import { readState, type AppState } from "../../dpi-sdk/src/app-state.js";
import type { SessionSummary, ThinkingLevel } from "../../dpi-sdk/src/api.js";
import { THINKING_LEVELS } from "../../dpi-sdk/src/api.js";
import type { WireEntry } from "../../dpi-sdk/src/api.js";
import { jobRunDone, type JobRun } from "../../dpi-sdk/src/jobs.js";
import {
  defineDoc,
  defineTool,
  defineExtension,
  section,
  configure,
  AssistantEntry,
  type ConversationId,
  type EntryRecord,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import type { Context, JsonValue } from "@earendil-works/chord";
import { JobRuns, jobDef, resolveJobInput, type Jobs } from "./jobs.js";
import { searchHistory } from "./history.js";
import { answerText, clip as clipText, Delegations, nameFromTask, workerInstructions, workerRemoval, type Delegation, type DelegationEngine } from "./delegations.js";
import { DEFAULT_SUBAGENT_MODEL, subagentModelId } from "./runner.js";

export { DEFAULT_SUBAGENT_MODEL, subagentModelId };

export const Workspace = defineDoc<AppState>({
  kind: "demo.workspace",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => ({ goal: "Explore durable agents", counter: 0, notes: [] }),
  checkpointWhen: () => false,
});
const Receipt = defineDoc<{ applied: boolean; result: string }>({
  kind: "demo.receipt",
  version: 1,
  scope: "task",
  initial: () => ({ applied: false, result: "" }),
  checkpointWhen: () => false,
});

/**
 * Run one outside effect (a Slack post, an email, a deploy) at most once per tool task, so its tool can be `safe`.
 * `effect` gets an idempotency key to send to the service. A rerun after the receipt commit returns the stored
 * result; a crash between the call and the commit repeats the call with the same key, so the service must ignore a
 * duplicate key or let you ask whether the key ran. A service with neither cannot be made safe here.
 */
export async function once(
  api: Pick<ToolExecutionApi, "taskId" | "commit">,
  ctx: Context,
  sessionId: string,
  effect: (key: string) => Promise<string>,
) {
  const done = await api.commit(async (tx) => {
    const receipt = await tx.doc(Receipt, api.taskId);
    return receipt.applied ? receipt.result : undefined;
  }, ctx);
  if (done !== undefined) return done;
  const result = await effect(`${sessionId}:${api.taskId}`);
  return api.commit(async (tx) => {
    const receipt = await tx.doc(Receipt, api.taskId);
    if (!receipt.applied) Object.assign(receipt, { applied: true, result });
    return receipt.result;
  }, ctx);
}

/** ping_on_call_engineer pages once per agent; this records the page. */
const Pager = defineDoc<{ paged: boolean; at: number; page: string; summary: string }>({
  kind: "demo.pager",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ paged: false, at: 0, page: "", summary: "" }),
  checkpointWhen: () => false,
});

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One line per phase change, for the run_durable_job call's live output. */
function progressLines(run: JobRun) {
  return run.phases.flatMap((phase, i) => {
    const n = `${i + 1}/${run.phases.length} ${phase.label}`;
    if (phase.status === "done") return [`✓ ${n}: ${phase.summary ?? "done"}`];
    if (phase.status === "running") return [`▸ ${n}`];
    if (phase.status === "waiting") return [`⏸ ${n}: waiting for a person to approve in the chat`];
    if (phase.status === "failed" || phase.status === "aborted") return [`✗ ${n}: ${phase.summary ?? phase.status}`];
    return [];
  });
}

const phaseLabel = (run: JobRun) => run.phases.find((p) => p.id === run.phase)?.label;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** One run as check_durable_job reports it: compact enough for a model, complete enough to act on. */
function runReport(run: JobRun, now: number) {
  return {
    taskId: run.id,
    job: run.job,
    title: run.title,
    run: run.run,
    status: run.status,
    ...(jobRunDone(run) ? {} : { phase: phaseLabel(run) }),
    ...(run.approval === "pending" ? { next: "Waiting for a person to approve in the chat" } : {}),
    ...(run.approval && run.approval !== "pending" ? { approval: run.approval } : {}),
    startedBy: run.startedBy,
    background: run.background,
    seconds: Math.round(((run.endedAt ?? now) - run.startedAt) / 100) / 10,
    ...(run.resumed ? { resumedAfterRestart: run.resumed } : {}),
    ...(run.result ? { result: run.result } : {}),
    ...(run.error ? { error: run.error } : {}),
    phases: run.phases.map((p) => ({
      phase: p.label,
      status: p.status,
      ...(p.summary ? { summary: p.summary } : {}),
      ...(p.progress ? { progress: `${p.progress.done}/${p.progress.total}` } : {}),
      ...(p.steps.length
        ? { steps: p.steps.map((s) => `${s.status} ${s.kind} ${s.label}${s.detail ? `: ${clip(s.detail.replace(/\s+/g, " "), 160)}` : ""}`) }
        : {}),
    })),
  };
}

/** Creates a session on this device, exactly once per `key`, and optionally sends its first prompt. */
export type SpawnSession = (input: {
  key: string;
  name: string;
  cwd: string;
  model: { provider: string; modelId: string };
  thinkingLevel?: ThinkingLevel;
  prompt?: string;
}) => Promise<{ session: SessionSummary; submissionId?: number }>;

const MODEL_CHOICE =
  "Model id from this device's model list, or an alias: claude-haiku-latest, claude-sonnet-latest (when the task needs more reasoning), claude-opus-latest.";

export function createPlayground(
  shared: SharedState,
  sessionId: string,
  spawn: SpawnSession,
  jobs: Jobs,
  /** A device model id or alias as a model ref; throws on an unknown id. */
  resolveModel: (id: string) => { provider: string; modelId: string },
  /** Where delegated work runs and what is recorded about it (delegations.ts). */
  delegations: DelegationEngine,
) {
  const readAppState = defineTool({
    name: "read_state",
    description:
      "Read the shared App State object used by every session, conversation and fork, or a field at a JSON Pointer path. Empty path reads the whole object.",
    parameters: Type.Object({ path: Type.Optional(Type.String()) }),
    replay: "safe",
    execute: async (args) => {
      const { value } = await shared.snapshot();
      return {
        output: [{ type: "text", text: JSON.stringify(readState(value, args.path ?? "")) }],
      };
    },
  });
  const updateState = defineTool({
    name: "update_state",
    description:
      'CRUD the same shared App State for every agent and fork in this demo. create adds a new field, update replaces an existing value, delete removes it, increment adds a signed number. value_json must be JSON-encoded text: 3 for a number, true for a boolean, "hello" (including quotes) for a string, {"enabled":true} for an object, or [1,2] for an array. Omit value_json for delete. Use JSON Pointer paths: /counter, /settings/enabled, /notes/- to append. Escape ~ as ~0 and / as ~1. Empty path with update replaces the whole root object, with delete clears it. Read first with read_state. UI controls update live. Changes are atomic and replay-safe.',
    parameters: Type.Object({
      operation: Type.Union([
        Type.Literal("create"),
        Type.Literal("update"),
        Type.Literal("delete"),
        Type.Literal("increment"),
      ]),
      path: Type.String(),
      value_json: Type.Optional(
        Type.String({
          description:
            "JSON-encoded value. Objects and arrays must be encoded as JSON here, not passed as native tool argument objects.",
        }),
      ),
    }),
    replay: "safe",
    execute: async (args, api, ctx) => {
      const next = await shared.change(
        {
          operation: args.operation,
          path: args.path,
          value: args.value_json === undefined ? undefined : JSON.parse(args.value_json),
        },
        `agent:${sessionId}:${api.taskId}`,
      );
      const value = await api.commit(async (tx) => {
        const receipt = await tx.doc(Receipt, api.taskId);
        if (!receipt.applied) {
          await tx.appendEntry(api.conversationId, {
            kind: "demo.state-change",
            data: { taskId: api.taskId, text: `App State: ${args.operation} ${args.path || "/"}` },
          });
          receipt.applied = true;
          receipt.result = JSON.stringify(next);
        }
        return receipt.result;
      }, ctx);
      return { output: [{ type: "text", text: value }] };
    },
  });
  const recentRuns = async (api: Pick<ToolExecutionApi, "conversationId" | "snapshot">, ctx: Context) =>
    Object.values((await api.snapshot(JobRuns, api.conversationId, ctx))?.items ?? {}).sort((a, b) => b.id - a.id);
  const listJobs = defineTool({
    name: "list_durable_jobs",
    description:
      "List the durable jobs you can start with run_durable_job: each job's id, what it does, its named phases, the inputs it takes (type, default, limits), whether it waits for a person's approval, the App State path where every run saves its result, and its recent runs in this conversation with their task ids for check_durable_job.",
    parameters: Type.Object({}),
    replay: "safe",
    execute: async (_args, api, ctx) => {
      const runs = await recentRuns(api, ctx);
      return {
        output: [
          {
            type: "text",
            text: JSON.stringify(
              jobs.defs.map((d) => ({
                job: d.id,
                title: d.title,
                summary: d.summary,
                phases: d.phases.map((p) => `${p.label}: ${p.summary}`),
                inputs: Object.fromEntries(
                  d.inputs.map((i) => [
                    i.name,
                    { type: i.type, default: i.default, ...(i.min !== undefined ? { min: i.min, max: i.max } : {}), description: i.description },
                  ]),
                ),
                needsApproval: d.approval,
                savesTo: d.resultPath,
                typicalSeconds: d.seconds,
                recentRuns: runs
                  .filter((r) => r.job === d.id)
                  .slice(0, 5)
                  .map((r) => ({ taskId: r.id, run: r.run, status: r.status, phase: phaseLabel(r) })),
              })),
            ),
          },
        ],
      };
    },
  });
  const runJob = defineTool({
    name: "run_durable_job",
    description:
      'Start a durable job: a repeatable workflow with named phases that runs as one checkpointed task and shows live in the chat. Call list_durable_jobs first for ids and inputs. It runs in the background: you get its task id at once, the conversation owns the run, and you check it with check_durable_job. Set wait true only when the user wants you to wait for the result; then the call owns the run, an interrupt stops it, and you get the outcome of every phase. Example: {"job":"workspace-snapshot","input":{"path":"."}}.',
    parameters: Type.Object({
      job: Type.String({ description: "Job id from list_durable_jobs." }),
      input: Type.Optional(
        Type.Record(Type.String(), Type.Union([Type.String(), Type.Number()]), {
          description: "The job's inputs by name. Omitted inputs use their defaults.",
        }),
      ),
      wait: Type.Optional(
        Type.Boolean({ description: "Wait for the run to finish, including any approval. Default false." }),
      ),
    }),
    replay: "safe",
    execute: async (args, api, ctx) => {
      const def = jobDef(args.job);
      if (!def) throw Error(`Unknown job ${args.job}. Jobs: ${jobs.defs.map((d) => d.id).join(", ")}`);
      const input = resolveJobInput(def, args.input ?? {});
      const wait = args.wait === true;
      // A replay after a crash finds the run this call started instead of starting another.
      const taskId = await api.commit(async (tx) => {
        const receipt = await tx.doc(Receipt, api.taskId);
        if (receipt.applied) return Number(receipt.result);
        const id = await jobs.start(tx, api.conversationId, {
          def,
          input,
          startedBy: "agent",
          toolCallId: api.callId,
          ...(wait ? { owner: api.taskId } : {}),
          now: Date.now(),
        });
        receipt.applied = true;
        receipt.result = String(id);
        return id as number;
      }, ctx);
      await api.details({ taskId, job: def.id }, ctx);
      const read = async () => (await api.snapshot(JobRuns, api.conversationId, ctx))?.items[String(taskId)];
      if (!wait) {
        const run = await read();
        return {
          output: [
            {
              type: "text",
              text: `Started ${def.title} run #${run?.run ?? "?"} as durable task #${taskId}. It runs in the background, shows live in the chat and saves its result to App State ${def.resultPath}. Check it with check_durable_job {"task_id":${taskId}}.`,
            },
          ],
          details: { taskId, job: def.id },
        };
      }
      const printed = new Set<string>();
      let run = await read();
      for (;;) {
        for (const line of run ? progressLines(run) : [])
          if (!printed.has(line)) {
            printed.add(line);
            api.output(`${line}\n`);
          }
        if (!run || jobRunDone(run)) break;
        await pause(400);
        run = await read();
      }
      const ok = run?.status === "completed";
      return {
        output: [
          {
            type: "text",
            text: run
              ? `${def.title} run #${run.run} ${run.status}${ok ? `: ${run.result}` : run.error ? `: ${run.error}` : ""}.\n${progressLines(run).join("\n")}${ok ? `\nResult saved to App State ${def.resultPath}.` : ""}`
              : `${def.title} task #${taskId} has no record.`,
          },
        ],
        isError: !ok,
        details: { taskId, job: def.id },
      };
    },
  });
  const checkJob = defineTool({
    name: "check_durable_job",
    description:
      "Check durable job runs in this conversation. With task_id, one run in full: status, current phase, every phase's outcome and steps (commands, the subagent's tool calls, App State writes), approval, result or error. With job, that job's latest run. With neither, a short list of recent runs. Task ids come from run_durable_job and list_durable_jobs.",
    parameters: Type.Object({
      task_id: Type.Optional(Type.Integer({ minimum: 1, description: "The run's task id." })),
      job: Type.Optional(Type.String({ description: "A job id: check its latest run." })),
    }),
    replay: "safe",
    execute: async (args, api, ctx) => {
      const runs = await recentRuns(api, ctx);
      const run =
        args.task_id !== undefined
          ? runs.find((r) => r.id === args.task_id)
          : args.job !== undefined
            ? runs.find((r) => r.job === args.job)
            : undefined;
      if (args.task_id === undefined && args.job === undefined)
        return {
          output: [
            {
              type: "text",
              text: JSON.stringify(
                runs.slice(0, 10).map((r) => ({ taskId: r.id, job: r.job, run: r.run, status: r.status, phase: phaseLabel(r) })),
              ),
            },
          ],
        };
      if (!run)
        throw Error(
          `No run ${args.task_id !== undefined ? `with task id ${args.task_id}` : `of ${args.job}`} in this conversation. Runs: ${runs.map((r) => `${r.id} (${r.job} #${r.run})`).join(", ") || "none"}`,
        );
      return { output: [{ type: "text", text: JSON.stringify(runReport(run, Date.now())) }] };
    },
  });
  const searchHistoryTool = defineTool({
    name: "search_history",
    description:
      "Search your own full stored history, including entries from before a reset, handoff or compaction that you can no longer see. Filter by words (query), by tool name (tool), by entry kind, or by entry number range (from_entry, to_entry). Pass entry to read one entry in full by its number. Results come newest first (order oldest to reverse) and are paged with limit and offset; use next_offset for the next page. Each result says whether the entry is active, compacted or before reset.",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Words that must all appear, case-insensitive." })),
      tool: Type.Optional(Type.String({ description: "Only calls to and results from this tool, for example bash." })),
      entry: Type.Optional(Type.Integer({ minimum: 1, description: "Read this one entry in full." })),
      kind: Type.Optional(
        Type.Union([
          Type.Literal("user"),
          Type.Literal("assistant"),
          Type.Literal("tool_call"),
          Type.Literal("tool_result"),
          Type.Literal("event"),
        ]),
      ),
      from_entry: Type.Optional(Type.Integer({ minimum: 1, description: "Oldest entry number to include." })),
      to_entry: Type.Optional(Type.Integer({ minimum: 1, description: "Newest entry number to include." })),
      order: Type.Optional(Type.Union([Type.Literal("newest"), Type.Literal("oldest")])),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Results per page. Default 10." })),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: "Results to skip. Default 0." })),
    }),
    replay: "safe",
    execute: async (args, api, ctx) => {
      const { entries, activeFrom } = await api.commit(async (tx) => {
        const all: EntryRecord[] = [];
        let page = await tx.scanEntries({ conversationId: api.conversationId }, 500);
        all.push(...page.items);
        while (page.next && all.length < 10_000) {
          page = await tx.scanEntries({ conversationId: api.conversationId }, 500, page.next);
          all.push(...page.items);
        }
        return { entries: all, activeFrom: (await tx.latestHeadMarker(api.conversationId))?.head as number | undefined };
      }, ctx);
      const resets = entries.filter((e) => e.kind === "pi.reset").map((e) => e.id as number);
      const result = searchHistory(entries as unknown as WireEntry[], args, {
        activeFrom,
        lastReset: resets.length ? Math.max(...resets) : undefined,
      });
      return { output: [{ type: "text", text: JSON.stringify(result) }] };
    },
  });
  // No replay policy: the default `unsafe` means a crash mid-call returns an interrupted result and never pages twice.
  const pingOnCall = defineTool({
    name: "ping_on_call_engineer",
    description:
      "Page the human on-call engineer with a short summary. A real side effect: it is not replay-safe, so a crash returns an interrupted result instead of paging again, and it works once per agent. Only use it when the user asks you to page someone.",
    parameters: Type.Object({
      summary: Type.String({ description: "What the engineer needs to know, one or two sentences." }),
      severity: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("high"), Type.Literal("critical")])),
    }),
    execute: async (args, api, ctx) => {
      const prior = await api.snapshot(Pager, api.conversationId, ctx);
      if (prior?.paged)
        throw Error(
          `Already paged at ${new Date(prior.at).toISOString()} (${prior.page}). ping_on_call_engineer works once per agent.`,
        );
      const severity = args.severity ?? "high";
      const page = `PG-${String(api.taskId).padStart(4, "0")}`;
      api.output("Dialing the on-call engineer…\n");
      await pause(1500);
      await api.commit(async (tx) => {
        const pager = await tx.doc(Pager, api.conversationId);
        if (pager.paged) throw Error(`Already paged (${pager.page}).`);
        Object.assign(pager, { paged: true, at: Date.now(), page, summary: args.summary.slice(0, 300) });
      }, ctx);
      api.output(`Paged on-call, ${severity} severity: ${page}\nWaiting for acknowledgement…\n`);
      await pause(1500);
      api.output("Acknowledged.\n");
      return {
        output: [
          {
            type: "text",
            text: `Paged the on-call engineer (${page}, ${severity}). They acknowledged. Do not page again for this.`,
          },
        ],
      };
    },
  });
  /** One delegation as Bags reads it: the same shape whatever backend ran it. */
  const report = (d: Delegation) => ({
    id: d.id,
    source: d.source,
    label: d.label,
    backend: d.backend,
    ...(d.backendReason ? { backendReason: d.backendReason } : {}),
    status: d.status,
    model: d.model,
    ...(d.url ? { url: d.url } : {}),
    ...(d.sessionId ? { sessionId: d.sessionId } : {}),
    ...(d.conversationId !== undefined ? { agent: d.conversationId } : {}),
    ...(d.todo ? { todo: d.todo } : {}),
    ...(d.result ? { result: clipText(d.result, 600) } : {}),
    ...(d.reason ? { reason: d.reason } : {}),
    ...(d.escalatedFrom ? { escalatedFrom: d.escalatedFrom } : {}),
    ...(d.escalatedTo ? { escalatedTo: d.escalatedTo } : {}),
  });
  const link = (d: Delegation) => d.url ?? (d.conversationId !== undefined ? `agent #${d.conversationId}` : d.sessionId ?? `delegation #${d.id}`);

  const subagent = defineTool({
    name: "subagent",
    description:
      "Delegate a self-contained task to a child agent with code and read tools only. Where it runs is decided by this device, not by you: work in a clean, pushed git checkout runs in a Claude cloud session and returns at once with the session link; anything else runs here and returns the child's final answer with a link to the child. The child runs on Haiku by default (claude-haiku-latest); pass model: claude-sonnet-latest when the task needs more reasoning. An unknown model fails the call. Use the delegation tool to escalate, steer or stop it.",
    parameters: Type.Object({
      task: Type.String(),
      model: Type.Optional(Type.String({ description: `${MODEL_CHOICE} Default: claude-haiku-latest.` })),
      cwd: Type.Optional(
        Type.String({ description: "Existing folder for the child. Relative paths resolve against your working directory. Default: yours." }),
      ),
    }),
    replay: "safe",
    execute: async (args, api, ctx) => {
      // Planned before anything is created, so an unknown model fails the call instead of falling back to another one.
      const p = await delegations.plan(api, ctx, {
        source: "subagent",
        label: nameFromTask(args.task) || "Subagent",
        instruction: args.task,
        model: args.model?.trim() || subagentModelId(),
        cwd: args.cwd?.trim() || undefined,
        key: `subagent:${api.taskId}`,
      });
      if (p.backend === "cloud") {
        const d = await delegations.dispatchFromTool(api, ctx, p);
        await api.details({ delegationId: d.id, ...(d.sessionId ? { sessionId: d.sessionId } : {}) }, ctx);
        return {
          output: [
            {
              type: "text",
              text: d.status === "blocked" ? `Cloud dispatch failed: ${d.reason}` : `Started in the cloud: ${link(d)} (delegation #${d.id}, ${d.model}). It runs on its own; steer or stop it with the delegation tool.`,
            },
          ],
          isError: d.status === "blocked",
          details: { delegationId: d.id } as JsonValue,
        };
      }
      const agent = await api.agent(ctx);
      const now = Date.now();
      const { id, delegationId } = await api.commit(async (tx) => {
        const found = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
        const d = await delegations.record(tx, api.conversationId, p, now);
        if (found) return { id: found.id as number, delegationId: d.id };
        const child = await tx.createConversation({
          ownership: { kind: "task", taskId: api.taskId },
        });
        await configure(tx, child.id, {
          tools: { remove: workerRemoval(agent) },
          model: p.modelRef,
          instructions: workerInstructions(p.code),
          ...(p.cwd ? { cwd: p.cwd } : {}),
        });
        await delegations.change(tx, api.conversationId, d.id, (x) => void (x.conversationId = child.id as number));
        return { id: child.id as number, delegationId: d.id };
      }, ctx);
      delegations.nameAgent?.(id, p.label);
      await api.details({ conversationId: id, delegationId }, ctx);
      const finish = (outcome: Parameters<DelegationEngine["settle"]>[3]) =>
        api.commit((tx) => delegations.settle(tx, api.conversationId, delegationId, outcome, Date.now()), ctx);
      try {
        const child = await api.conversation(id as ConversationId, ctx);
        if (!child) throw Error("Child missing");
        const result = await (
          await child.submit(
            { type: "input", content: args.task, requestId: `child:${api.taskId}` },
            ctx,
          )
        ).wait(ctx);
        const answer =
          result.status === "done" && result.type === "input"
            ? await api.commit((tx) => tx.entry(AssistantEntry, result.answer), ctx)
            : undefined;
        // Only the child's final answer comes back, not its thinking or tool calls.
        const text = answer ? answerText(answer.model) : "";
        await finish(text ? { status: "done", result: text } : { status: "blocked", reason: `no answer (${result.status})` });
        return {
          output: [
            {
              type: "text",
              text: text ? `${text}\n\nChild: agent #${id}` : `Child agent #${id} gave no answer (${result.status}).`,
            },
          ],
          ...(text ? {} : { isError: true }),
          details: { conversationId: id, delegationId },
        };
      } catch (e) {
        await finish({ status: "stopped", reason: (e as Error).message }).catch(() => {});
        throw e;
      }
    },
  });
  const startSession = defineTool({
    name: "start_session",
    description:
      "Start a new session: its own harness and working directory, independent of this one. It keeps running if you are interrupted. Returns immediately; you do not wait for it. Where it runs is decided by this device: a session with a prompt on a clean, pushed git checkout runs in a Claude cloud session and returns its link; anything else is a session on this device. It runs on Haiku by default (claude-haiku-latest); pass model: claude-sonnet-latest when the work needs more reasoning. An unknown model fails the call.",
    parameters: Type.Object({
      name: Type.String({ description: "Session name shown in the network tree." }),
      cwd: Type.String({
        description: "Existing folder on this device. Relative paths resolve against your working directory.",
      }),
      model: Type.Optional(
        Type.String({ description: `${MODEL_CHOICE} Default: claude-haiku-latest.` }),
      ),
      prompt: Type.Optional(
        Type.String({ description: "First message for the new session. Default: none, the session starts idle." }),
      ),
    }),
    replay: "safe",
    execute: async (args, api, ctx) => {
      const prompt = args.prompt?.trim() || undefined;
      const p = await delegations.plan(api, ctx, {
        source: "start_session",
        label: args.name,
        instruction: prompt ?? "",
        model: args.model?.trim() || subagentModelId(),
        cwd: args.cwd,
        key: `start_session:${sessionId}:${api.taskId}`,
      });
      // An idle session has nothing to run in the cloud.
      if (p.backend === "cloud" && prompt) {
        const d = await delegations.dispatchFromTool(api, ctx, p);
        return {
          output: [
            {
              type: "text",
              text: d.status === "blocked" ? `Cloud dispatch failed: ${d.reason}` : `Started cloud session "${args.name}" (${link(d)}, ${d.model}, delegation #${d.id}). It runs on its own.`,
            },
          ],
          isError: d.status === "blocked",
          details: { delegationId: d.id, ...(d.sessionId ? { sessionId: d.sessionId } : {}) },
        };
      }
      const parent = await api.agent(ctx);
      const thinking = THINKING_LEVELS.find((level) => level === parent.thinkingLevel);
      const { session, submissionId } = await spawn({
        key: p.key!,
        name: args.name,
        cwd: p.cwd ?? parent.cwd ?? ".",
        model: p.modelRef,
        thinkingLevel: thinking,
        prompt,
      });
      const sent =
        submissionId === undefined
          ? "It has no prompt yet."
          : `Sent its first message as submission #${submissionId}. It runs on its own.`;
      return {
        output: [
          {
            type: "text",
            text: `Started session "${session.name}" (${session.id}) in ${session.cwd} with ${session.model}. ${sent}`,
          },
        ],
        details: { sessionId: session.id, ...(submissionId === undefined ? {} : { submissionId }) },
      };
    },
  });
  const delegation = defineTool({
    name: "delegation",
    description:
      'Support operations for work handed to other agents (subagent, start_session, trigger todos). Where the work runs is not yours to decide; this is how you steer it. list shows every delegation: backend, status, link, result or reason. escalate reruns the same instruction on a stronger model (haiku, then sonnet, then opus; or model) with the failure or partial result carried into it; a running one is stopped first, and a trigger todo follows the new run. steer injects guidance into a running agent (message). stop ends a running agent. Name the delegation by id, or by task, the text of its trigger todo. Example: {"op":"escalate","task":"Fix the failing test"}.',
    parameters: Type.Object({
      op: Type.Union(["list", "escalate", "steer", "stop"].map((o) => Type.Literal(o))),
      id: Type.Optional(Type.Integer({ minimum: 1, description: "The delegation's id." })),
      task: Type.Optional(Type.String({ description: "A trigger todo's exact text, instead of id." })),
      message: Type.Optional(Type.String({ description: "steer: the guidance to inject." })),
      model: Type.Optional(Type.String({ description: "escalate: a specific stronger model. Default: the next one up." })),
    }),
    // No replay policy: a crash mid-call returns an interrupted result, so a steer is never sent twice.
    execute: async (args, api, ctx) => {
      const say = (value: unknown) => ({ output: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }] });
      if (args.op === "list") {
        const items = Object.values((await api.snapshot(Delegations, api.conversationId, ctx))?.items ?? {}).sort((a, b) => b.id - a.id);
        return say(items.slice(0, 20).map(report));
      }
      const d = await delegations.find(api, ctx, { id: args.id, task: args.task });
      if (args.op === "steer") {
        if (!args.message?.trim()) throw Error("steer needs message: the guidance to inject");
        await delegations.steer(api, ctx, d, args.message.trim());
        return say(`Sent to delegation #${d.id} (${d.backend}, ${link(d)}).`);
      }
      if (args.op === "stop") {
        await delegations.stop(api, ctx, d);
        return say(`Stopped delegation #${d.id} (${d.backend}, ${link(d)}).`);
      }
      const next = await delegations.escalate(api, ctx, d, args.model);
      return say({ escalated: report(next), from: d.id });
    },
  });
  const handoff = defineTool({
    name: "handoff",
    description:
      "Start a fresh model context with a concise handoff note. Old transcript stays stored.",
    parameters: Type.Object({ note: Type.String() }),
    execute: async (args) => ({
      output: [{ type: "text", text: "Context handed off." }],
      control: { handoff: args.note },
    }),
  });
  return defineExtension({
    name: "playground",
    tasks: [...jobs.tasks, ...delegations.tasks],
    tools: [
      readAppState,
      updateState,
      listJobs,
      runJob,
      checkJob,
      searchHistoryTool,
      pingOnCall,
      subagent,
      startSession,
      delegation,
      handoff,
    ],
    sections: [
      section(
        "playground",
        () =>
          `You are a concise coding agent in the Durable Pi playground. Explain only what matters. Use only the tools you are offered; read only agents get no tools that write. Use read_state to inspect App State and update_state to create, update, delete, or increment any field. App State is shared across all agents, sessions, conversations and forks in this demo. It survives browser closure, interrupted agents, and backend restarts. Forks use the current shared object rather than a historical copy. Read before writing because other agents and humans can change it. Use only read_state and update_state for this object, never inspect or edit its database files. App State is a flexible JSON object: numbers, booleans, strings, arrays, nested objects, and null all render as live controls in the UI. Read before editing. Use list_durable_jobs and run_durable_job to run a repeatable durable job (a named workflow with checkpointed phases) when asked; pass only the inputs list_durable_jobs documents. Runs continue in the background: check them with check_durable_job, and wait only when asked. Use search_history to look back at earlier messages, tool calls or entries by number, including what came before a reset, handoff or compaction. Use ping_on_call_engineer only when asked to page someone; it works once. Use subagent only when explicitly asked to delegate. Use start_session only when asked to start a new session; it runs on its own. Use delegation to escalate, steer or stop work you handed to an agent. Never claim an action happened without using its tool. Background runs finish independently; do not wait in bash. A browser disconnect does not stop your work.`,
        { tag: false },
      ),
    ],
  });
}
