// The Omarchy plugin's Agui.js is a QML `.pragma library` file, not a module: load it into a
// node:vm context the way QML would see it, and hold it to the same patches the hub sends.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import {
  diffState,
  emptyCanvas,
  projectCanvas,
  type CanvasState,
  type JsonPatchOp,
} from "../../dpi-sdk/src/agui.js";
import type { AgentSummary, NetworkDevice, SessionSummary } from "../../dpi-sdk/src/api.js";

interface PluginAgui {
  applyPatch(state: unknown, ops: JsonPatchOp[]): CanvasState;
  readLine(pending: string[], chunk: string): { pending: string[]; events: unknown[] };
  toNetwork(state: CanvasState): {
    ok: boolean;
    devices: {
      id: string;
      status: string;
      sessions: { name: string; busy: boolean; agents: number }[];
    }[];
  };
  toGraph(state: CanvasState): {
    nodes: { id: string; type: string; busy: boolean }[];
    edges: { id: string; from: string; to: string }[];
  };
}

const source = readFileSync(resolve(import.meta.dirname, "../../omarchy-plugin/Agui.js"), "utf8");
const agui = (() => {
  const context = vm.createContext({});
  vm.runInContext(source.replace(/^\.pragma library\s*$/m, ""), context);
  // Round-trip through JSON so assertions compare plain objects, not another realm's.
  const plain =
    <T>(fn: (...args: never[]) => T) =>
    (...args: unknown[]) =>
      JSON.parse(JSON.stringify((fn as (...a: unknown[]) => T)(...args)));
  const c = context as unknown as PluginAgui;
  return {
    applyPatch: plain(c.applyPatch),
    readLine: plain(c.readLine),
    toNetwork: plain(c.toNetwork),
    toGraph: plain(c.toGraph),
    raw: c,
  } as PluginAgui & { raw: PluginAgui };
})();

const agent = (id: number, patch: Partial<AgentSummary> = {}): AgentSummary => ({
  id,
  name: `agent-${id}`,
  named: false,
  kind: "root",
  busy: false,
  background: 0,
  ...patch,
});
const session = (id: string, agents: AgentSummary[]): SessionSummary => ({
  id,
  name: id,
  cwd: "/w",
  model: "m",
  createdAt: 1,
  dbPath: "/d",
  busy: false,
  agents,
});
const device = (id: string, sessions: SessionSummary[]) =>
  ({
    id,
    name: id,
    kind: "url",
    url: "http://x",
    source: "config",
    hasToken: true,
    status: "online",
    tree: { uid: "u", name: id, sessions, at: 1 },
  }) as NetworkDevice;

test("plugin Agui.js: SSE lines become events; comments and other fields are skipped", () => {
  let r = agui.readLine([], ": ping");
  assert.deepEqual(r, { pending: [], events: [] });
  // A one-line event completes without the blank line SSE puts after it.
  r = agui.readLine(r.pending, 'data: {"type":"RUN_STARTED","threadId":"t","runId":"r"}');
  assert.deepEqual(r.events, [{ type: "RUN_STARTED", threadId: "t", runId: "r" }]);
  // What Quickshell's SplitParser really delivers next: the blank line folded into the chunk.
  r = agui.readLine(r.pending, '\ndata: {"type":"STATE_SNAPSHOT","snapshot":{}}');
  assert.deepEqual(r.events, [{ type: "STATE_SNAPSHOT", snapshot: {} }]);
  assert.deepEqual(r.pending, []);
  r = agui.readLine(r.pending, '\ndata: {"type":"STATE_DELTA",');
  assert.deepEqual(r.events, []);
  r = agui.readLine(r.pending, "id: 7");
  assert.deepEqual(r.events, []);
  r = agui.readLine(r.pending, 'data: "delta":[]}\r');
  assert.deepEqual(r.events, [{ type: "STATE_DELTA", delta: [] }]);
  assert.deepEqual(r.pending, []);
  assert.deepEqual(agui.readLine([], ""), { pending: [], events: [] });
  assert.throws(() => agui.raw.readLine(["{not json"], ""));
});

test("plugin Agui.js: applies every delta the hub can send, and throws on one that does not fit", () => {
  const steps: CanvasState[] = [
    emptyCanvas(),
    projectCanvas([device("box", [session("s/1", [agent(1)])])]),
    projectCanvas([
      device("box", [
        session("s/1", [agent(1, { busy: true }), agent(2, { kind: "fork", parentId: 1 })]),
      ]),
    ]),
    projectCanvas([device("a~b", [])]),
  ];
  for (let i = 1; i < steps.length; i++)
    assert.deepEqual(agui.applyPatch(steps[i - 1], diffState(steps[i - 1], steps[i])), steps[i]);
  assert.throws(() =>
    agui.raw.applyPatch(steps[1], [{ op: "replace", path: "/devices/nope/status", value: "x" }]),
  );
  assert.throws(() => agui.raw.applyPatch(steps[1], [{ op: "move", path: "/version" } as never]));
});

test("plugin Agui.js: the bar's network view and the canvas graph come from the same state", () => {
  const view = {
    id: "build",
    title: "Build",
    spec: { type: "badge", text: "green" },
    updatedAt: 1,
  };
  const state = projectCanvas([
    device("box", [
      session("s1", [
        agent(1, { views: [view] }),
        agent(2, { kind: "fork", parentId: 1, background: 1 }),
      ]),
    ]),
  ]);
  const network = agui.toNetwork(state);
  assert.equal(network.ok, true);
  assert.deepEqual(network.devices[0].sessions, [{ name: "s1", busy: true, agents: 2 }]);
  const graph = agui.toGraph(state);
  assert.deepEqual(
    graph.nodes.map((n) => [n.id, n.type, n.busy]),
    [
      ["d:box", "device", false],
      ["s:box/s1", "session", false],
      ["a:box/s1/1", "agent", false],
      ["v:box/s1/1/build", "view", false],
      ["a:box/s1/2", "agent", true],
    ],
  );
  assert.deepEqual(
    graph.edges.map((e) => e.id),
    [
      "d:box>s:box/s1",
      "s:box/s1>a:box/s1/1",
      "a:box/s1/1>v:box/s1/1/build",
      "a:box/s1/1>a:box/s1/2",
    ],
  );
  assert.deepEqual(
    graph.nodes.find((n) => n.type === "view"),
    {
      id: "v:box/s1/1/build",
      type: "view",
      label: "Build",
      detail: "view",
      online: true,
      busy: false,
      spec: { type: "badge", text: "green" },
    },
  );
});
