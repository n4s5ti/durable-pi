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
    [{ type: "button", text: "Deploy" }, /unknown component "button"/],
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
