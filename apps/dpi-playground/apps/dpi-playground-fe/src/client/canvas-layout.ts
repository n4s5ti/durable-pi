// Lay the AG-UI canvas state out as a left-to-right graph: device → session → root agents → forks
// and subagents, one column per depth. Rows follow a depth-first walk, so every subtree is
// contiguous and its edges never cross another subtree's.
import type { CanvasAgent, CanvasState } from "@sdk/agui";
import type { DeviceStatus } from "@sdk/api";

export const COLUMN = 220;
export const ROW = 64;
export const NODE_W = 180;
export const NODE_H = 44;

export type CanvasNode =
  | {
      key: string;
      type: "device";
      x: number;
      y: number;
      label: string;
      status: DeviceStatus;
      detail: string;
    }
  | {
      key: string;
      type: "session";
      x: number;
      y: number;
      label: string;
      busy: boolean;
      detail: string;
      deviceId: string;
      sessionId: string;
      firstAgentId?: number;
    }
  | {
      key: string;
      type: "agent";
      x: number;
      y: number;
      label: string;
      busy: boolean;
      detail: string;
      deviceId: string;
      sessionId: string;
      agentId: number;
    };

export interface CanvasEdge {
  key: string;
  from: string;
  to: string;
}

export interface CanvasLayout {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  width: number;
  height: number;
}

const agentDetail = (a: CanvasAgent) => {
  const views = Object.keys(a.views ?? {}).length;
  return [
    a.kind === "root" ? "agent" : a.kind,
    a.background ? `${a.background} in background` : "",
    views ? `${views} view${views === 1 ? "" : "s"}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
};

export function layoutCanvas(state: CanvasState): CanvasLayout {
  const nodes: CanvasNode[] = [];
  const edges: CanvasEdge[] = [];
  let rows = 0;
  let depth = 0;
  // A first child shares its parent's row; any other node opens the next free row.
  const place = (column: number, shareRow?: number) => {
    const r = shareRow ?? rows;
    rows = Math.max(rows, r + 1);
    depth = Math.max(depth, column);
    return { x: column * COLUMN, y: r * ROW };
  };
  const rowOf = (n: CanvasNode) => n.y / ROW;

  for (const d of Object.values(state.devices)) {
    const deviceKey = `d:${d.id}`;
    const sessions = Object.values(d.sessions);
    const deviceNode: CanvasNode = {
      key: deviceKey,
      type: "device",
      ...place(0),
      label: d.name,
      status: d.status,
      detail: d.status === "online" ? `${sessions.length} sessions` : (d.error ?? d.status),
    };
    nodes.push(deviceNode);
    sessions.forEach((s, si) => {
      const sessionKey = `s:${d.id}/${s.id}`;
      const agents = Object.values(s.agents);
      const ids = new Set(agents.map((a) => a.id));
      const parentOf = (a: CanvasAgent) => {
        const p = a.parentId ?? a.ownerAgentId;
        return p !== null && p !== a.id && ids.has(p) ? p : null;
      };
      const sessionNode: CanvasNode = {
        key: sessionKey,
        type: "session",
        ...place(1, si === 0 ? rowOf(deviceNode) : undefined),
        label: s.name,
        busy: s.busy,
        detail: s.error ?? s.model,
        deviceId: d.id,
        sessionId: s.id,
        firstAgentId: agents.find((a) => parentOf(a) === null)?.id ?? agents[0]?.id,
      };
      nodes.push(sessionNode);
      edges.push({ key: `${deviceKey}>${sessionKey}`, from: deviceKey, to: sessionKey });
      const children = new Map<number | null, CanvasAgent[]>();
      for (const a of agents) children.set(parentOf(a), [...(children.get(parentOf(a)) ?? []), a]);
      const seen = new Set<number>();
      const walk = (a: CanvasAgent, column: number, parent: CanvasNode, first: boolean) => {
        if (seen.has(a.id)) return; // a parent cycle in bad data must not loop
        seen.add(a.id);
        const key = `a:${d.id}/${s.id}/${a.id}`;
        const node: CanvasNode = {
          key,
          type: "agent",
          ...place(column, first ? rowOf(parent) : undefined),
          label: a.name,
          busy: a.busy || a.background > 0,
          detail: agentDetail(a),
          deviceId: d.id,
          sessionId: s.id,
          agentId: a.id,
        };
        nodes.push(node);
        edges.push({ key: `${parent.key}>${key}`, from: parent.key, to: key });
        (children.get(a.id) ?? []).forEach((c, i) => walk(c, column + 1, node, i === 0));
      };
      (children.get(null) ?? []).forEach((a, i) => walk(a, 2, sessionNode, i === 0));
      // Agents whose parent chain loops never hang off a root: show them under the session anyway.
      for (const a of agents) if (!seen.has(a.id)) walk(a, 2, sessionNode, false);
    });
  }
  return {
    nodes,
    edges,
    width: depth * COLUMN + NODE_W,
    height: Math.max(rows, 1) * ROW - (ROW - NODE_H),
  };
}
