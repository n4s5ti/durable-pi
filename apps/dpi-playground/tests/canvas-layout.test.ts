import { test } from "node:test";
import assert from "node:assert/strict";
import { COLUMN, ROW, layoutCanvas } from "../apps/dpi-playground-fe/src/client/canvas-layout.js";
import { emptyCanvas, type CanvasAgent, type CanvasState } from "../../dpi-sdk/src/agui.js";

const agent = (id: number, patch: Partial<CanvasAgent> = {}): CanvasAgent => ({
  id,
  name: `agent-${id}`,
  kind: "root",
  parentId: null,
  ownerAgentId: null,
  busy: false,
  background: 0,
  views: {},
  ...patch,
});

const state = (agents: CanvasAgent[]): CanvasState => ({
  version: 1,
  moreDevices: 0,
  devices: {
    box: {
      id: "box",
      name: "box",
      status: "online",
      error: null,
      lastSeenAt: null,
      moreSessions: 0,
      views: {},
      sessions: {
        s1: {
          id: "s1",
          name: "One",
          model: "m",
          busy: false,
          error: null,
          moreAgents: 0,
          agents: Object.fromEntries(agents.map((a) => [String(a.id), a])),
        },
      },
    },
  },
});

const at = (layout: ReturnType<typeof layoutCanvas>, key: string) => {
  const node = layout.nodes.find((n) => n.key === key);
  assert.ok(node, key);
  return { col: node.x / COLUMN, row: node.y / ROW };
};

test("canvas layout: device → session → root → fork, one column per depth", () => {
  const layout = layoutCanvas(
    state([
      agent(1),
      agent(2, { kind: "fork", parentId: 1 }),
      agent(3, { kind: "subagent", ownerAgentId: 2 }),
      agent(4),
    ]),
  );
  assert.deepEqual(at(layout, "d:box"), { col: 0, row: 0 });
  assert.deepEqual(at(layout, "s:box/s1"), { col: 1, row: 0 });
  assert.deepEqual(at(layout, "a:box/s1/1"), { col: 2, row: 0 });
  assert.deepEqual(at(layout, "a:box/s1/2"), { col: 3, row: 0 });
  assert.deepEqual(at(layout, "a:box/s1/3"), { col: 4, row: 0 });
  assert.deepEqual(at(layout, "a:box/s1/4"), { col: 2, row: 1 });
  assert.deepEqual(layout.edges.map((e) => e.key).sort(), [
    "a:box/s1/1>a:box/s1/2",
    "a:box/s1/2>a:box/s1/3",
    "d:box>s:box/s1",
    "s:box/s1>a:box/s1/1",
    "s:box/s1>a:box/s1/4",
  ]);
  assert.equal(layout.width, 4 * COLUMN + 180);
});

test("canvas layout: bad parent data never hangs or drops an agent", () => {
  const layout = layoutCanvas(
    state([
      agent(1, { parentId: 2 }),
      agent(2, { parentId: 1 }),
      agent(3, { parentId: 3 }),
      agent(4, { parentId: 99 }),
    ]),
  );
  const agents = layout.nodes.filter((n) => n.type === "agent").map((n) => n.key);
  assert.equal(new Set(agents).size, 4, "every agent drawn once");
  assert.deepEqual(layoutCanvas(emptyCanvas()).nodes, []);
});
