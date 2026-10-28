// AG-UI (https://docs.ag-ui.com) state events for read-only views of the network. The hub projects
// what it knows into one keyed state object and streams it: STATE_SNAPSHOT on connect, then
// STATE_DELTA (RFC 6902 JSON Patch) on every change. Views only render it; nothing flows back.
// Every collection is an object keyed by id (never an array) so a delta names exactly what changed.
import type { AgentKind, DeviceStatus, NetworkDevice } from "./api.js";

export const CANVAS_LIMITS = { devices: 32, sessions: 32, agents: 64, text: 120 } as const;

export interface CanvasAgent {
  id: number;
  name: string;
  kind: AgentKind;
  parentId: number | null;
  ownerAgentId: number | null;
  busy: boolean;
  background: number;
}

export interface CanvasSession {
  id: string;
  name: string;
  model: string;
  busy: boolean;
  error: string | null;
  agents: Record<string, CanvasAgent>;
  moreAgents: number;
}

export interface CanvasDevice {
  id: string;
  name: string;
  status: DeviceStatus;
  error: string | null;
  lastSeenAt: number | null;
  sessions: Record<string, CanvasSession>;
  moreSessions: number;
}

export interface CanvasState {
  version: 1;
  devices: Record<string, CanvasDevice>;
  moreDevices: number;
}

export type JsonPatchOp =
  | { op: "add" | "replace"; path: string; value: unknown }
  | { op: "remove"; path: string };

export type AguiEvent =
  | { type: "RUN_STARTED"; threadId: string; runId: string; timestamp?: number }
  | { type: "STATE_SNAPSHOT"; snapshot: CanvasState; timestamp?: number }
  | { type: "STATE_DELTA"; delta: JsonPatchOp[]; timestamp?: number }
  | { type: "RUN_ERROR"; message: string; code?: string; timestamp?: number };

export const emptyCanvas = (): CanvasState => ({ version: 1, devices: {}, moreDevices: 0 });

const clip = (value: unknown) => {
  const text = String(value ?? "");
  return text.length > CANVAS_LIMITS.text ? `${text.slice(0, CANVAS_LIMITS.text - 1)}…` : text;
};
const clipOrNull = (value: unknown) => (value ? clip(value) : null);

/**
 * What a view may see of the network. Leaves out device URLs, working directories and database
 * paths: the hub can listen on a tailnet, and a canvas needs shape and liveness, not locations.
 */
export function projectCanvas(devices: NetworkDevice[]): CanvasState {
  const state = emptyCanvas();
  state.moreDevices = Math.max(0, devices.length - CANVAS_LIMITS.devices);
  for (const d of devices.slice(0, CANVAS_LIMITS.devices)) {
    const sessions = d.tree?.sessions ?? [];
    const device: CanvasDevice = {
      id: clip(d.id),
      name: clip(d.name || d.id),
      status: d.status,
      error: clipOrNull(d.error),
      lastSeenAt: d.lastSeenAt ?? null,
      sessions: {},
      moreSessions: Math.max(0, sessions.length - CANVAS_LIMITS.sessions),
    };
    for (const s of sessions.slice(0, CANVAS_LIMITS.sessions)) {
      const session: CanvasSession = {
        id: clip(s.id),
        name: clip(s.name || s.id),
        model: clip(s.model),
        busy: s.busy === true,
        error: clipOrNull(s.error),
        agents: {},
        moreAgents: Math.max(0, s.agents.length - CANVAS_LIMITS.agents),
      };
      for (const a of s.agents.slice(0, CANVAS_LIMITS.agents))
        session.agents[String(a.id)] = {
          id: a.id,
          name: clip(a.name),
          kind: a.kind,
          parentId: a.parentId ?? null,
          ownerAgentId: a.ownerAgentId ?? null,
          busy: a.busy === true,
          background: Math.max(0, Number(a.background) || 0),
        };
      device.sessions[session.id] = session;
    }
    state.devices[device.id] = device;
  }
  return state;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const escapeToken = (key: string) => key.replaceAll("~", "~0").replaceAll("/", "~1");
const unescapeToken = (token: string) => token.replaceAll("~1", "/").replaceAll("~0", "~");

/** The RFC 6902 patch from `prev` to `next`. Objects recurse; anything else is replaced whole. */
export function diffState(prev: unknown, next: unknown, path = ""): JsonPatchOp[] {
  if (isRecord(prev) && isRecord(next)) {
    const ops: JsonPatchOp[] = [];
    for (const key of Object.keys(prev))
      if (!(key in next)) ops.push({ op: "remove", path: `${path}/${escapeToken(key)}` });
    for (const [key, value] of Object.entries(next)) {
      const at = `${path}/${escapeToken(key)}`;
      if (!(key in prev)) ops.push({ op: "add", path: at, value });
      else ops.push(...diffState(prev[key], value, at));
    }
    return ops;
  }
  return JSON.stringify(prev) === JSON.stringify(next)
    ? []
    : [{ op: "replace", path, value: next }];
}

/**
 * Apply a patch from {@link diffState} to a copy of `state`. Throws on a path that does not
 * resolve: the view is out of sync and must reconnect for a fresh snapshot, never guess.
 */
export function applyPatch<T>(state: T, ops: JsonPatchOp[]): T {
  let root: unknown = structuredClone(state);
  for (const op of ops) {
    if (op.path === "") {
      if (op.op === "remove") throw Error("Cannot remove the document root");
      root = structuredClone(op.value);
      continue;
    }
    if (!op.path.startsWith("/")) throw Error(`Bad JSON Pointer: ${op.path}`);
    const tokens = op.path.slice(1).split("/").map(unescapeToken);
    const last = tokens.pop()!;
    let parent: unknown = root;
    for (const token of tokens) {
      if (!isRecord(parent) || !(token in parent)) throw Error(`No such path: ${op.path}`);
      parent = parent[token];
    }
    if (!isRecord(parent)) throw Error(`No such path: ${op.path}`);
    if (op.op === "add") parent[last] = structuredClone(op.value);
    else if (!(last in parent)) throw Error(`No such path: ${op.path}`);
    else if (op.op === "remove") delete parent[last];
    else parent[last] = structuredClone(op.value);
  }
  return root as T;
}
