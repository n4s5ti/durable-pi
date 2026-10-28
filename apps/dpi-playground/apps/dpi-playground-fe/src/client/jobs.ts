// Durable jobs in the web client: the device's job definitions, this agent's runs (the `demo.job-runs`
// document), and the actions a run card or the Tasks tab can take.
import { computed, reactive, ref } from "vue";
import { JOB_RUNS_DOC, type JobDef, type JobRun, type JobRunsDoc } from "@sdk/jobs";
import {
  agentHandle,
  agentState,
  attempt,
  device,
  hideInspector,
  narrow,
  notify,
  select,
  selected,
  sessionHandle,
} from "./store";

export const jobDefs = computed<JobDef[]>(() => device.value?.info?.jobs ?? []);
export const jobDef = (id: string) => jobDefs.value.find((d) => d.id === id);

/** This agent's runs, newest first. */
export const jobRuns = computed<JobRun[]>(() => {
  const doc = agentState.value.docs[JOB_RUNS_DOC] as JobRunsDoc | undefined;
  return Object.values(doc?.items ?? {}).sort((a, b) => b.id - a.id);
});
export const runById = (id: number) => jobRuns.value.find((r) => r.id === id);
export const runByCall = (callId: string) => jobRuns.value.find((r) => r.toolCallId === callId);

/** One clock for every elapsed timer on the page. */
export const now = ref(Date.now());
setInterval(() => (now.value = Date.now()), 1000);

export const seconds = (ms: number) =>
  ms < 1000 ? `${Math.max(0, Math.round(ms))}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;

export const pending = ref<string>();

async function act<T>(key: string, fn: () => Promise<T>): Promise<T | undefined> {
  if (pending.value) return;
  pending.value = key;
  try {
    return await attempt(fn);
  } finally {
    pending.value = undefined;
  }
}

/** Scroll the chat to a run's card (it renders where the run started). */
export function revealRun(id: number) {
  if (narrow.value) hideInspector();
  setTimeout(() =>
    document
      .querySelector(`[data-job-run="${id}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" }),
  );
}

/** What the Tasks tab's fields hold for each job, by input name; an untouched field is its default. */
export const jobInputs = reactive<Record<string, Record<string, string>>>({});
export const inputValue = (def: JobDef, name: string) =>
  jobInputs[def.id]?.[name] ?? String(def.inputs.find((i) => i.name === name)?.default ?? "");
export const setInput = (def: JobDef, name: string, value: string) => ((jobInputs[def.id] ??= {})[name] = value);
/** Text inputs a run cannot start without: an empty default means the job needs a value. */
export const missingInputs = (def: JobDef) =>
  def.inputs.filter((i) => i.type === "string" && i.default === "" && !inputValue(def, i.name).trim()).map((i) => i.name);
/** A job's typical run time, in seconds or minutes. */
export const typicalTime = (s: number) => (s < 90 ? `~${s}s` : `~${Math.round(s / 60)} min`);

export async function startJob(def: JobDef) {
  const input = Object.fromEntries(
    def.inputs.map((i) => [i.name, i.type === "integer" ? Number(inputValue(def, i.name)) : inputValue(def, i.name)]),
  );
  const started = await act(`start:${def.id}`, () =>
    agentHandle.value!.demo<{ taskId: number }>("jobs", { job: def.id, input }),
  );
  if (started) {
    notify(`${def.title} started. It runs in the chat.`);
    revealRun(started.taskId);
  }
}

export const decide = (run: JobRun, approved: boolean) =>
  act(`decide:${run.id}`, () =>
    agentHandle.value!.demo(`jobs/${run.id}/approval`, { approved }),
  );

export const stopRun = (run: JobRun) =>
  act(`stop:${run.id}`, () => sessionHandle.value!.abortTask(run.id));

export function openAgent(conversationId: number) {
  if (selected.value) select({ ...selected.value, agentId: conversationId });
}
