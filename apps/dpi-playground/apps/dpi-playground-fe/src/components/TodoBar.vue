<script setup lang="ts">
// The agent's toolkit todo list (the `toolkit.todo` document), drawn like the pi-tasks widget and
// attached to the top of the chat box. Read only; the agent changes it with its todo tool. Hidden
// when the list is empty or every task is finished (pi-tasks' default auto-clear on list complete).
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue";
import { agentState } from "../client/store";

type Status = "pending" | "active" | "done" | "blocked" | "dropped";
type Task = { content: string; status: Status; reason?: string };
type Phase = { name: string; tasks: Task[] };
type Row = { kind: "phase"; name: string } | { kind: "task"; n: number; task: Task };

const SPINNER = ["✳", "✴", "✵", "✶", "✷", "✸", "✹", "✺", "✻", "✼", "✽"];
const MAX_VISIBLE = 10;

const phases = computed<Phase[]>(
  () => (agentState.value.docs["toolkit.todo"] as { phases?: Phase[] } | undefined)?.phases ?? [],
);
const tasks = computed(() => phases.value.flatMap((p) => p.tasks).filter((t) => t.status !== "dropped"));
const count = (...s: Status[]) => tasks.value.filter((t) => s.includes(t.status)).length;
const visible = computed(() => tasks.value.length > 0 && count("done") < tasks.value.length);

const header = computed(() => {
  const parts = [
    count("done") && `${count("done")} done`,
    count("active") && `${count("active")} in progress`,
    count("pending", "blocked") && `${count("pending", "blocked")} open`,
  ].filter(Boolean);
  return `${tasks.value.length} tasks (${parts.join(", ")})`;
});

/** Tasks numbered #1.. in list order; phase names only when there is more than one phase. */
const rows = computed(() => {
  const out: Row[] = [];
  let n = 0;
  for (const p of phases.value) {
    const live = p.tasks.filter((t) => t.status !== "dropped");
    if (phases.value.length > 1 && live.length) out.push({ kind: "phase", name: p.name });
    for (const task of live) out.push({ kind: "task", n: ++n, task });
  }
  return out;
});
const shown = computed(() => {
  let tasksSeen = 0;
  return rows.value.filter((r) => r.kind === "phase" || ++tasksSeen <= MAX_VISIBLE);
});
const hidden = computed(() => Math.max(0, tasks.value.length - MAX_VISIBLE));

// Spinner frame and elapsed time for the active task, timed from when this page first saw it active.
const frame = ref(0);
const now = ref(Date.now());
const since = reactive(new Map<string, number>());
let timer: ReturnType<typeof setInterval> | undefined;
watch(
  () => tasks.value.filter((t) => t.status === "active").map((t) => t.content),
  (active) => {
    for (const k of [...since.keys()]) if (!active.includes(k)) since.delete(k);
    for (const k of active) if (!since.has(k)) since.set(k, Date.now());
    if (active.length && !timer)
      timer = setInterval(() => {
        frame.value++;
        now.value = Date.now();
      }, 150);
    else if (!active.length && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  },
  { immediate: true },
);
onBeforeUnmount(() => timer && clearInterval(timer));

const elapsed = (content: string) => {
  const s = Math.floor((now.value - (since.get(content) ?? now.value)) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m${s % 60 ? ` ${s % 60}s` : ""}` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}`;
};
</script>

<template>
  <div v-if="visible" class="todo-widget" role="status" aria-label="Tasks">
    <div class="tw-line tw-accent">{{ `● ${header}` }}</div>
    <template v-for="r in shown" :key="r.kind === 'phase' ? `p:${r.name}` : `t:${r.n}`">
      <div v-if="r.kind === 'phase'" class="tw-line tw-dim tw-phase">{{ r.name }}</div>
      <div v-else-if="r.task.status === 'active'" class="tw-line">
        <span class="tw-accent">{{ SPINNER[frame % SPINNER.length] }}</span
        ><span class="tw-dim">{{ ` #${r.n} ` }}</span
        ><span class="tw-accent">{{ `${r.task.content}…` }}</span
        ><span class="tw-dim">{{ ` (${elapsed(r.task.content)})` }}</span>
      </div>
      <div v-else-if="r.task.status === 'done'" class="tw-line">
        <span class="tw-success">✓</span
        >{{ " " }}<s class="tw-dim">{{ `#${r.n} ${r.task.content}` }}</s>
      </div>
      <div v-else class="tw-line">
        <span>◻</span><span class="tw-dim">{{ ` #${r.n} ` }}</span
        ><span>{{ r.task.content }}</span
        ><span v-if="r.task.status === 'blocked'" class="tw-dim">{{
          ` › blocked${r.task.reason ? `: ${r.task.reason}` : ""}`
        }}</span>
      </div>
    </template>
    <div v-if="hidden" class="tw-line tw-dim">{{ `  … and ${hidden} more` }}</div>
  </div>
</template>
