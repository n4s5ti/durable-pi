// The Tasks tab's data, shared by the hand-written TasksPanel and the template version (ui-data.ts
// serves it to views as /agent/tasks and /device/jobs).
import { computed, type Component } from "vue";
import { Activity, Bot, Layers, ShieldCheck, Workflow, Wrench } from "lucide-vue-next";
import type { TaskNode } from "@sdk/api";
import { jobRunDone } from "@sdk/jobs";
import { tasks } from "./store";
import { jobDef, jobDefs, jobRuns, typicalTime } from "./jobs";

export const statusLabel = (value: string) =>
  ({
    running: "Running",
    waiting: "Waiting",
    completed: "Completed",
    aborted: "Stopped",
    declined: "Declined",
    failed: "Failed",
    pending: "Queued",
    completing: "Finishing",
    terminal: "Finished",
  })[value] ?? value;

export const kindOf = (t: TaskNode): { icon: Component; name: string; what: string } =>
  t.kind === "pi.tool"
    ? { icon: Wrench, name: t.label ?? "Tool call", what: "tool call" }
    : t.kind === "pi.generation"
      ? { icon: Bot, name: "Model response", what: "generation" }
      : t.kind === "pi.compaction"
        ? { icon: Layers, name: "Compaction", what: "compaction" }
        : t.kind.startsWith("demo.job.")
          ? { icon: Workflow, name: t.label ?? jobDef(t.kind.slice(9))?.title ?? t.kind, what: "durable job" }
          : t.kind === "demo.job-approval"
            ? { icon: ShieldCheck, name: "Approval", what: "waits for you" }
            : { icon: Activity, name: t.label ?? t.kind, what: t.kind };

export const phaseOf = (t: TaskNode) => {
  if (!t.state.phase) return "";
  if (t.kind.startsWith("demo.job."))
    return jobDef(t.kind.slice(9))?.phases.find((p) => p.id === t.state.phase)?.label ?? t.state.phase;
  return t.state.phase;
};

export type TaskRow = { task: TaskNode & { effectiveBackground: boolean }; depth: number };

/** The live task tree, flattened in display order with each row's depth. */
export const taskRows = computed<TaskRow[]>(() => {
  const all = tasks.value;
  const ids = new Set(all.map((t) => t.id));
  const children = new Map<number | undefined, typeof all>();
  for (const t of all) {
    const parent = t.owner !== undefined && ids.has(t.owner) ? t.owner : undefined;
    children.set(parent, [...(children.get(parent) ?? []), t]);
  }
  const out: TaskRow[] = [];
  const walk = (parent: number | undefined, depth: number) => {
    for (const task of (children.get(parent) ?? []).sort((a, b) => a.id - b.id)) {
      out.push({ task, depth });
      walk(task.id, depth + 1);
    }
  };
  walk(undefined, 0);
  return out;
});

/** /agent/tasks: one plain row per task, ready to bind. */
export const taskData = computed(() =>
  taskRows.value.map(({ task, depth }) => ({
    id: task.id,
    depth,
    indent: "  ".repeat(depth) + (depth ? "└ " : ""),
    name: kindOf(task).name,
    what: kindOf(task).what,
    kind: task.kind,
    status: task.state.status,
    statusLabel: statusLabel(task.state.status),
    phase: phaseOf(task),
    conversationId: task.conversationId,
    background: task.effectiveBackground,
    conversations: task.conversations ?? [],
  })),
);

/** /device/jobs: each job definition with its newest run in this agent, ready to bind. */
export const jobData = computed(() =>
  jobDefs.value.map((def) => {
    const run = jobRuns.value.find((r) => r.job === def.id);
    return {
      id: def.id,
      title: def.title,
      summary: def.summary,
      approval: def.approval,
      time: typicalTime(def.seconds),
      resultPath: def.resultPath,
      phases: def.phases.map((p, i) => `${i + 1}. ${p.label}`).join("  "),
      inputs: def.inputs.map((i) => ({
        name: i.name,
        type: i.type,
        description: i.description,
        default: String(i.default ?? ""),
        placeholder: i.default !== undefined && i.default !== "" ? `${i.description} (default ${i.default})` : i.description,
      })),
      last: run
        ? {
            id: run.id,
            run: run.run,
            status: run.status,
            statusLabel: statusLabel(run.status),
            done: jobRunDone(run),
            phase: run.phases.find((p) => p.id === run.phase)?.label ?? "",
            approvalPending: run.approval === "pending",
          }
        : null,
    };
  }),
);
