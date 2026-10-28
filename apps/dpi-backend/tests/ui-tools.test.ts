// The ui-tools add-on through a live session: views land on the agent (and so on the device tree the
// hub streams), templates are device-wide, and anything outside the component catalog is refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { faux, tempStore } from "./helpers.js";

test("ui-tools: render, replace, template save/list/use across sessions, clear, and refusals", async () => {
  const t = await tempStore();
  const store = await t.open();
  try {
    const s1 = await store.create({ name: "Ui one", cwd: t.work, model: faux });
    const s2 = await store.create({ name: "Ui two", cwd: t.work, model: faux });
    const agent = async (sessionId: string) => {
      const { h, c } = await store.resolveAgent(sessionId, "main");
      const row = store.row(sessionId);
      const before = (await store.agentDetail(row, c)).tools.map((x) => x.name);
      assert.equal(before.includes("ui_render"), false, "off until the agent turns it on");
      await store.setExtension(row, c, { name: "ui-tools", enabled: true });
      let n = 0;
      const call = async (name: string, args: unknown) => {
        const sub = await store.send(c, {
          content: `tool: ${name} ${JSON.stringify(args)}`,
          requestId: `ui-${sessionId}-${n++}`,
        });
        assert.equal((await store.settled(h, sub.id as number, 15000)).status, "done");
        const text = (await store.transcript(c, "markdown")).text ?? "";
        return text.slice(text.lastIndexOf("Tool "));
      };
      const views = async () =>
        (await store.tree()).sessions.find((x) => x.id === sessionId)!.agents[0].views ?? [];
      return { call, views };
    };

    const a = await agent(s1.id);
    const status = { type: "card", title: "Build", children: [{ type: "metric", label: "Tests", value: "412" }] };
    assert.match(await a.call("ui_render", { id: "build", title: "Build status", spec: status }), /Showing view "build"/);
    let views = await a.views();
    assert.deepEqual(
      views.map((v) => [v.id, v.title, v.spec]),
      [["build", "Build status", status]],
      "the view rides on the device tree",
    );

    status.children[0].value = "413";
    await a.call("ui_render", { id: "build", title: "Build status", spec: status });
    views = await a.views();
    assert.equal(views.length, 1, "same id replaces");
    assert.equal((views[0].spec as typeof status).children[0].value, "413");

    // Refused: not in the catalog, an action field, a bad id. Nothing changes.
    assert.match(
      await a.call("ui_render", { id: "x", title: "X", spec: { type: "html", text: "<script>alert(1)</script>" } }),
      /unknown component "html"/,
    );
    assert.match(
      await a.call("ui_render", { id: "x", title: "X", spec: { type: "badge", text: "go", onClick: "deploy" } }),
      /onClick: not a field of badge/,
    );
    assert.match(await a.call("ui_render", { id: "Bad Id", title: "X", spec: status }), /Bad view id/);
    assert.equal((await a.views()).length, 1);

    // A template saved in one session is listed and used in another.
    const health = {
      type: "card",
      title: "{{service}}",
      children: [
        { type: "metric", label: "Latency", value: "{{ms}}", unit: "ms" },
        { type: "progress", value: "{{uptime}}", label: "Uptime" },
      ],
    };
    assert.match(
      await a.call("ui_template_save", { name: "service-health", description: "One service's health", spec: health }),
      /Saved template "service-health" with slots service, ms, uptime/,
    );
    const b = await agent(s2.id);
    assert.match(await b.call("ui_template_list", {}), /service-health: One service's health \[slots: service, ms, uptime\]/);
    assert.match(
      await b.call("ui_template_use", {
        name: "service-health",
        id: "api",
        title: "API",
        values: { service: "api", ms: "42", uptime: "0.99" },
      }),
      /Showing view "api"/,
    );
    const [used] = await b.views();
    assert.equal(used.template, "service-health");
    assert.deepEqual(used.spec, {
      type: "card",
      title: "api",
      children: [
        { type: "metric", label: "Latency", value: "42", unit: "ms" },
        { type: "progress", value: 0.99, label: "Uptime" },
      ],
    });
    assert.match(
      await b.call("ui_template_use", { name: "service-health", id: "db", title: "DB", values: { service: "db" } }),
      /missing values for ms, uptime/,
    );
    assert.match(await b.call("ui_template_use", { name: "nope", id: "x", title: "X", values: {} }), /No template "nope"/);

    assert.match(await a.call("ui_clear", { id: "build" }), /Removed 1 view/);
    assert.deepEqual(await a.views(), [], "a cleared view leaves the tree");
    assert.match(await b.call("ui_clear", { id: "*" }), /Removed 1 view/);
  } finally {
    await store.close();
    await t.cleanup();
  }
});
