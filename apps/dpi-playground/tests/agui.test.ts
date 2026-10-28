import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyPatch,
  CANVAS_LIMITS,
  diffState,
  emptyCanvas,
  projectCanvas,
  type CanvasState,
} from "../../dpi-sdk/src/agui.js";
import type { AgentSummary, NetworkDevice, SessionSummary } from "../../dpi-sdk/src/api.js";

const agent = (id: number, patch: Partial<AgentSummary> = {}): AgentSummary => ({
  id,
  name: `agent-${id}`,
  named: false,
  kind: "root",
  busy: false,
  background: 0,
  ...patch,
});

const session = (id: string, agents: AgentSummary[], patch: Partial<SessionSummary> = {}) =>
  ({
    id,
    name: `Session ${id}`,
    cwd: "/home/someone/secret-project",
    model: "faux/model",
    createdAt: 1,
    dbPath: "/home/someone/.dpi/sessions/x.sqlite",
    busy: false,
    agents,
    ...patch,
  }) satisfies SessionSummary;

const device = (id: string, sessions: SessionSummary[], patch: Partial<NetworkDevice> = {}) =>
  ({
    id,
    name: id,
    kind: "url",
    url: `http://${id}.tailnet.example:4780`,
    source: "config",
    hasToken: true,
    status: "online",
    tree: { uid: `uid-${id}`, name: id, sessions, at: 1 },
    ...patch,
  }) as NetworkDevice;

test("agui: the projection keeps shape and liveness, never locations", () => {
  const state = projectCanvas([
    device("box-a", [
      session("s1", [agent(1), agent(2, { kind: "fork", parentId: 1, busy: true })]),
    ]),
  ]);
  const text = JSON.stringify(state);
  for (const leak of ["secret-project", "x.sqlite", "tailnet.example", "uid-box-a", "hasToken"])
    assert.equal(text.includes(leak), false, `${leak} must not reach a view`);
  const forked = state.devices["box-a"].sessions.s1.agents["2"];
  assert.deepEqual(forked, {
    id: 2,
    name: "agent-2",
    kind: "fork",
    parentId: 1,
    ownerAgentId: null,
    busy: true,
    background: 0,
    views: {},
  });
});

test("agui: agent views pass the catalog check again at the hub, or are dropped", () => {
  const good = { type: "metric", label: "Tests", value: "412" };
  const views = [
    { id: "build", title: "Build", spec: good, updatedAt: 5 },
    { id: "evil", title: "Evil", spec: { type: "html", text: "<script>" }, updatedAt: 6 },
    { id: "Bad Id", title: "Bad", spec: good, updatedAt: 7 },
    ...Array.from({ length: 10 }, (_, i) => ({
      id: `v${i}`,
      title: "V",
      spec: good,
      updatedAt: i,
    })),
  ];
  const state = projectCanvas([
    device("box", [session("s", [agent(1, { views } as Partial<AgentSummary>)])]),
  ]);
  const projected = state.devices.box.sessions.s.agents["1"].views;
  assert.deepEqual(projected.build, {
    id: "build",
    title: "Build",
    spec: good,
    template: null,
    updatedAt: 5,
  });
  assert.equal("evil" in projected, false, "a spec outside the catalog never reaches a renderer");
  assert.equal("Bad Id" in projected, false);
  assert.ok(Object.keys(projected).length <= 8, "at most UI_LIMITS.views per agent");
  const changed = projectCanvas([
    device("box", [
      session("s", [
        agent(1, {
          views: [{ ...views[0], spec: { ...good, value: "413" } }],
        } as Partial<AgentSummary>),
      ]),
    ]),
  ]);
  assert.ok(
    diffState(state, changed).some(
      (op) =>
        op.op === "replace" &&
        op.path === "/devices/box/sessions/s/agents/1/views/build/spec/value",
    ),
    "a changed metric is one narrow replace",
  );
});

test("agui: the projection is bounded and says how much it left out", () => {
  const many = Array.from({ length: CANVAS_LIMITS.agents + 5 }, (_, i) => agent(i));
  const sessions = Array.from({ length: CANVAS_LIMITS.sessions + 3 }, (_, i) =>
    session(`s${i}`, i === 0 ? many : []),
  );
  const devices = Array.from({ length: CANVAS_LIMITS.devices + 2 }, (_, i) =>
    device(`box-${i}`, i === 0 ? sessions : [], { name: "n".repeat(500) }),
  );
  const state = projectCanvas(devices);
  assert.equal(Object.keys(state.devices).length, CANVAS_LIMITS.devices);
  assert.equal(state.moreDevices, 2);
  const first = state.devices["box-0"];
  assert.equal(Object.keys(first.sessions).length, CANVAS_LIMITS.sessions);
  assert.equal(first.moreSessions, 3);
  assert.equal(Object.keys(first.sessions.s0.agents).length, CANVAS_LIMITS.agents);
  assert.equal(first.sessions.s0.moreAgents, 5);
  assert.equal(first.name.length, CANVAS_LIMITS.text);
});

test("agui: a delta applied to the old state yields the new one, change by change", () => {
  const steps: CanvasState[] = [
    emptyCanvas(),
    projectCanvas([device("box-a", [])]),
    projectCanvas([device("box-a", [session("s1", [agent(1)])])]),
    projectCanvas([device("box-a", [session("s1", [agent(1, { busy: true }), agent(2)])])]),
    projectCanvas([
      device("box-a", [session("s1", [agent(2)])], { status: "offline", error: "gone" }),
      device("a/b~c", [session("x/y", [agent(7)])]),
    ]),
    projectCanvas([device("a/b~c", [])]),
    emptyCanvas(),
  ];
  for (let i = 1; i < steps.length; i++) {
    const delta = diffState(steps[i - 1], steps[i]);
    assert.ok(delta.length > 0, `step ${i} changes something`);
    assert.deepEqual(applyPatch(steps[i - 1], delta), steps[i], `step ${i}`);
  }
  const busy = diffState(steps[2], steps[3]);
  assert.ok(
    busy.some(
      (op) => op.op === "replace" && op.path === "/devices/box-a/sessions/s1/agents/1/busy",
    ),
    "a busy flip is one narrow replace, not a new snapshot",
  );
  assert.ok(
    diffState(steps[4], steps[5]).some(
      (op) => op.op === "remove" && op.path === "/devices/a~1b~0c/sessions/x~1y",
    ),
    "keys are escaped as JSON Pointer tokens",
  );
  assert.deepEqual(diffState(steps[3], structuredClone(steps[3])), [], "no change, no delta");
});

test("agui: a patch that does not fit the state throws instead of guessing", () => {
  const state = projectCanvas([device("box-a", [])]);
  for (const op of [
    { op: "replace", path: "/devices/box-z/status", value: "online" },
    { op: "remove", path: "/devices/box-z" },
    { op: "add", path: "/devices/box-z/sessions/s1", value: {} },
    { op: "replace", path: "devices", value: {} },
    { op: "remove", path: "" },
  ] as const)
    assert.throws(() => applyPatch(state, [op]), undefined, JSON.stringify(op));
  assert.equal(state.devices["box-a"].status, "online", "the input state is never mutated");
});

test("agui: dpi's own device views (prefabs) are projected and re-checked too", () => {
  const good = { type: "badge", text: "working", tone: "accent" };
  const d = device("box", []);
  d.tree!.views = [
    {
      id: "dpi.providers",
      title: "Providers",
      spec: good,
      template: "dpi.providers",
      updatedAt: 3,
    },
    { id: "dpi.bad", title: "Bad", spec: { type: "script", text: "x" }, updatedAt: 4 },
  ];
  const views = projectCanvas([d]).devices.box.views;
  assert.deepEqual(Object.keys(views), ["dpi.providers"]);
  assert.equal(views["dpi.providers"].template, "dpi.providers");
  assert.deepEqual(projectCanvas([device("bare", [])]).devices.bare.views, {});
});
