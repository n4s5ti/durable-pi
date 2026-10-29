// The data model a canvas view reads (see dpi-sdk/src/ui-spec.ts), and the actions its buttons run.
//
//   /state    the selected device's App State; writes go to the device (shared with the agent)
//   /agent    { docs: the selected agent's streamed docs, tasks: its live task rows }
//   /device   { jobs: the device's durable jobs with each one's newest run }
//   /local    scratch for this view only
//
// A write to any path outside /state is kept as a local overlay on top of the data, so an input can
// bind straight to a field of an item (a job's input value, say) and a button can read it back.
import { computed, inject, provide, reactive, type InjectionKey } from "vue";
import { readState, type AppState } from "@sdk/app-state";
import {
  absolutePath,
  readPointer,
  resolveValue,
  uiText,
  type UiAction,
  type UiScope,
} from "@sdk/ui-spec";
import { agentHandle, agentState, attempt, deviceFeed, deviceId, notify } from "./store";
import { jobDef, openAgent, revealRun } from "./jobs";
import { jobData, taskData } from "./tasks-data";

export interface UiData {
  /** The value at an absolute pointer, with this view's local edits applied. */
  read(pointer: string): unknown;
  /** Write a value: App State for /state paths, this view's overlay for any other. */
  write(pointer: string, value: unknown): Promise<void>;
  /** Whether a pointer can be written from this view. */
  writable(pointer: string): boolean;
  /** Run a button's action. */
  run(action: UiAction, scope: UiScope): Promise<void>;
  /** The action running now, if any (buttons disable while one runs). */
  readonly busy: string | undefined;
}

const KEY: InjectionKey<UiData> = Symbol("ui-data");

const shared = computed(() => (deviceFeed.sharedState.value?.value ?? {}) as AppState);
const model = computed(() => ({
  agent: { docs: agentState.value.docs, tasks: taskData.value },
  device: { jobs: jobData.value },
}));

function readBase(pointer: string): unknown {
  if (pointer === "/state" || pointer.startsWith("/state/")) {
    try {
      return readState(shared.value, pointer.slice("/state".length));
    } catch {
      return undefined;
    }
  }
  return readPointer(model.value, pointer);
}

/** Set a value inside a copy of `root` at a relative pointer, creating objects on the way. */
function setIn(root: unknown, rel: string, value: unknown): unknown {
  const keys = rel.split("/").slice(1);
  const out = (typeof root === "object" && root !== null ? JSON.parse(JSON.stringify(root)) : {}) as Record<string, unknown>;
  let at: Record<string, unknown> = out;
  keys.forEach((k, i) => {
    if (i === keys.length - 1) at[k] = value;
    else {
      if (typeof at[k] !== "object" || at[k] === null) at[k] = {};
      at = at[k] as Record<string, unknown>;
    }
  });
  return out;
}

/** Create the data for one view, owned by the view's device. */
export function provideUiData(viewDevice: () => string | undefined): UiData {
  const overlay = reactive<Record<string, unknown>>({});
  const state = reactive({ busy: undefined as string | undefined });

  const read = (pointer: string): unknown => {
    let value = pointer in overlay ? overlay[pointer] : readBase(pointer);
    for (const [key, v] of Object.entries(overlay))
      if (key.startsWith(`${pointer}/`)) value = setIn(value, key.slice(pointer.length), v);
    return value;
  };
  const ownDevice = () => !viewDevice() || viewDevice() === deviceId.value;
  const writable = (pointer: string) => !pointer.startsWith("/state/") || (!!agentHandle.value && ownDevice());

  async function write(pointer: string, value: unknown) {
    if (!pointer.startsWith("/state/")) {
      overlay[pointer] = value;
      return;
    }
    if (!writable(pointer)) throw Error("This view's App State belongs to another device.");
    const path = pointer.slice("/state".length);
    const exists = readBase(pointer) !== undefined;
    await agentHandle.value!.demo("state", { operation: exists ? "update" : "create", path, value, quiet: true });
  }

  async function run(action: UiAction, scope: UiScope) {
    if (state.busy) return;
    const args = Object.fromEntries(
      Object.entries(action.args ?? {}).map(([k, v]) => [k, resolveValue(v, scope, read)]),
    ) as Record<string, unknown>;
    const handle = agentHandle.value;
    state.busy = action.name;
    try {
      await attempt(async () => {
        switch (action.name) {
          case "setState":
            return write(absolutePath(String(args.path), scope), args.value ?? null);
          case "sendToAgent":
            if (!handle) throw Error("Select an agent first.");
            await handle.send(uiText(args.text));
            return notify("Sent to the agent.");
          case "runJob": {
            if (!handle) throw Error("Select an agent first.");
            const def = jobDef(String(args.job));
            if (!def) throw Error(`No durable job "${String(args.job)}" on this device.`);
            const given = inputValues(args.inputs);
            const input = Object.fromEntries(
              def.inputs.map((i) => {
                const raw = given[i.name] ?? String(i.default ?? "");
                return [i.name, i.type === "integer" ? Number(raw) : raw];
              }),
            );
            const started = await handle.demo<{ taskId: number }>("jobs", { job: def.id, input });
            notify(`${def.title} started. It runs in the chat.`);
            return revealRun(started.taskId);
          }
          case "decideJob":
            if (!handle) throw Error("Select an agent first.");
            await handle.demo(`jobs/${Number(args.run)}/approval`, { approved: !!args.approve });
            return;
          case "stopAll":
            if (!handle) throw Error("Select an agent first.");
            await handle.abort(true);
            return;
          case "showRun":
            return revealRun(Number(args.run));
          case "openAgent":
            return openAgent(Number(args.conversation));
        }
      });
    } finally {
      state.busy = undefined;
    }
  }

  const data: UiData = {
    read,
    write,
    writable,
    run,
    get busy() {
      return state.busy;
    },
  };
  provide(KEY, data);
  return data;
}

/** A job's input values from a bound object by name, or an array of {name, value?, default?}. */
function inputValues(v: unknown): Record<string, string> {
  if (Array.isArray(v))
    return Object.fromEntries(
      v
        .filter((i): i is Record<string, unknown> => typeof i === "object" && i !== null && typeof i.name === "string")
        .map((i) => [i.name as string, uiText(i.value ?? i.default ?? "")]),
    );
  if (typeof v === "object" && v !== null)
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, uiText(x)]));
  return {};
}

export const useUiData = () => inject(KEY)!;
