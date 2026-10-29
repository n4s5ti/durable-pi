import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkUiSpec,
  fillTemplate,
  slotsOf,
  UI_LIMITS,
  UiSpecError,
} from "../../dpi-sdk/src/ui-spec.js";

const dashboard = {
  type: "card",
  title: "Build",
  children: [
    { type: "row", children: [{ type: "metric", label: "Tests", value: "412", unit: "passing" }] },
    { type: "progress", value: 0.75, label: "Deploy" },
    { type: "badge", text: "green", tone: "accent" },
    { type: "table", columns: ["step", "time"], rows: [["lint", "4s"]] },
    { type: "list", items: ["a", "b"] },
    { type: "markdown", text: "**done**" },
  ],
};

test("ui spec: every catalog component passes", () => {
  assert.deepEqual(checkUiSpec(dashboard), dashboard);
});

test("ui spec: unknown components, unknown fields and bad values are rejected", () => {
  const bad: [unknown, RegExp][] = [
    [{ type: "html", text: "<script>" }, /unknown component "html"/],
    [{ type: "text", text: "x", onClick: "rm -rf" }, /onClick: not a field of text/],
    [{ type: "button", text: "Deploy" }, /text: not a field of button/],
    [{ type: "button", label: "Go", action: { name: "runTool", args: {} } }, /unknown action "runTool"/],
    [{ type: "button", label: "Go", action: { name: "setState", args: { value: 1 } } }, /args.path: is required/],
    [{ type: "button", label: "Go", action: { name: "sendToAgent", args: { text: { a: 1 } } } }, /must be a string, number/],
    [{ type: "text", text: { "@path": "/etc/passwd" } }, /must be a data path under \/state/],
    [{ type: "text", text: { "@path": "relative" } }, /must be a data path under/],
    [{ type: "text", text: { "@path": "/state/a", "@template": "x" } }, /exactly one/],
    [{ type: "progress", value: { "@template": "x" } }, /works only on text fields/],
    [{ type: "input", label: "Q", path: "/intake/q1" }, /must be a data path under/],
    [{ type: "each", path: "/state/list", child: "nope" }, /must be a component object/],
    [{ type: "text", text: "x", when: { path: "/state/a" } }, /when: must be/],
    [{ type: "text" }, /text: is required/],
    [{ type: "badge", text: "x", tone: "red" }, /tone: must be one of/],
    [{ type: "progress", value: 2 }, /must be a number from 0 to 1/],
    [{ type: "progress", value: "{{p}}" }, /must be a number from 0 to 1/],
    [{ type: "table", columns: ["a"], rows: [[1]] }, /rows\[0\]\[0\]: must be a string/],
    [{ type: "card", children: "nope" }, /children: must be an array/],
    ["just text", /must be a component object/],
  ];
  for (const [spec, message] of bad)
    assert.throws(
      () => checkUiSpec(spec),
      (e: Error) => e instanceof UiSpecError && message.test(e.message),
      JSON.stringify(spec),
    );
});

test("ui spec: depth, size and count limits hold", () => {
  let deep: unknown = { type: "text", text: "leaf" };
  for (let i = 0; i < UI_LIMITS.depth; i++) deep = { type: "column", children: [deep] };
  assert.throws(() => checkUiSpec(deep), /nested deeper/);
  const wide = {
    type: "column",
    children: Array.from({ length: UI_LIMITS.nodes }, () => ({ type: "badge", text: "x" })),
  };
  assert.throws(() => checkUiSpec(wide), /more than 200 components/);
  assert.throws(
    () => checkUiSpec({ type: "text", text: "x".repeat(UI_LIMITS.text + 1) }),
    /longer than/,
  );
  assert.throws(
    () =>
      checkUiSpec({ type: "list", items: Array.from({ length: UI_LIMITS.items + 1 }, () => "i") }),
    /more than 50 entries/,
  );
});

test("ui spec: templates fill every slot, including a progress value, and nothing else", () => {
  const template = {
    type: "card",
    title: "{{service}} health",
    children: [
      { type: "metric", label: "Latency", value: "{{ms}}", unit: "ms" },
      { type: "progress", value: "{{uptime}}", label: "Uptime {{service}}" },
    ],
  };
  checkUiSpec(template, { template: true });
  assert.deepEqual(slotsOf(template), ["service", "ms", "uptime"]);
  const filled = fillTemplate(template, { service: "api", ms: "42", uptime: "0.99" });
  assert.deepEqual(filled, {
    type: "card",
    title: "api health",
    children: [
      { type: "metric", label: "Latency", value: "42", unit: "ms" },
      { type: "progress", value: 0.99, label: "Uptime api" },
    ],
  });
  assert.throws(() => fillTemplate(template, { service: "api" }), /missing values for ms, uptime/);
  assert.throws(
    () => fillTemplate(template, { service: "api", ms: "1", uptime: "lots" }),
    /must be a number from 0 to 1/,
  );
});

test("ui spec: bindings, each, when and button actions pass", () => {
  const view = {
    type: "card",
    title: { "@template": "Jobs on ${/device/jobs/0/title}" },
    when: { "@path": "/device/jobs" },
    children: [
      { type: "progress", value: { "@path": "/state/build/ratio" } },
      { type: "badge", text: "x", tone: { "@path": "/state/build/tone" } },
      {
        type: "each",
        path: "/device/jobs",
        empty: "No jobs",
        child: {
          type: "column",
          children: [
            { type: "text", text: { "@template": "#${@index} ${title}" } },
            { type: "each", path: "inputs", child: { type: "input", label: { "@path": "name" }, path: "value" } },
            { type: "text", text: { "@path": "" }, when: { "@path": "last/approvalPending", eq: true } },
            {
              type: "button",
              label: "Run",
              action: { name: "runJob", args: { job: { "@path": "id" }, inputs: { "@path": "inputs" } } },
            },
          ],
        },
      },
      { type: "input", label: "Q1", path: "/state/intake/q1" },
      { type: "button", label: "Stop", tone: "urgent", action: { name: "stopAll" } },
      { type: "button", label: "Yes", action: { name: "setState", args: { path: "/state/intake/q1", value: "yes" } } },
    ],
  };
  assert.deepEqual(checkUiSpec(view), view);
});

test("ui spec: renderers resolve bindings against the data and the each item", async () => {
  const { resolveValue, whenHolds, absolutePath } = await import("../../dpi-sdk/src/ui-spec.js");
  const data = { state: { a: "A", n: 0 }, device: { jobs: [{ title: "Build", inputs: [{ name: "x" }] }] } };
  const read = (p: string) => p.slice(1).split("/").reduce<any>((at, k) => at?.[k], data);
  const item = { base: "/device/jobs/0", index: 0 };
  assert.equal(resolveValue({ "@path": "/state/a" }, {}, read), "A");
  assert.equal(resolveValue({ "@path": "title" }, item, read), "Build");
  assert.equal(resolveValue({ "@path": "@index" }, item, read), 0);
  assert.equal(resolveValue({ "@template": "${title} #${@index}: ${/state/a}" }, item, read), "Build #0: A");
  assert.equal(absolutePath("inputs/0/name", item), "/device/jobs/0/inputs/0/name");
  assert.equal(whenHolds({ "@path": "/state/n" }, {}, read), false);
  assert.equal(whenHolds({ "@path": "/state/n", eq: 0 }, {}, read), true);
  assert.equal(whenHolds({ "@path": "/device/jobs", not: true }, {}, read), false);
});

test("ui spec: the catalog text agents read is generated from the catalog", async () => {
  const { uiCatalogText, COMPONENTS, UI_ACTIONS } = await import("../../dpi-sdk/src/ui-spec.js");
  const text = uiCatalogText();
  for (const name of [...Object.keys(COMPONENTS), ...Object.keys(UI_ACTIONS)]) assert.match(text, new RegExp(`\\b${name}\\b`));
});
