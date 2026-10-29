// A stored extension selection can name an extension this build no longer installs (the live Bags session
// selects `hindsight`, which is being removed). The session must still open, take a message and finish the run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineExtension, defineTool, GenerationTask, Harness, hook, section } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { installFaux } from "../src/faux.js";
import { faux, tempStore } from "./helpers.js";

// Shaped like hindsight: a tool, a system prompt section and GenerationTask hooks that memo per run.
const Throwaway = defineExtension({
  name: "throwaway-memory",
  tools: [
    defineTool({
      name: "throwaway_recall",
      description: "Recall a stored fact.",
      parameters: Type.Object({ query: Type.String() }),
      execute: async () => ({ output: [{ type: "text", text: "the fact" }] }),
    }),
  ],
  sections: [section("throwaway-memory", () => "# Throwaway Memory\nActive.", { tag: false })],
  hooks: [
    hook(GenerationTask, {
      beforeRequest: async (_request, api, ctx) => {
        if (!(await api.memo<boolean>("throwaway-recalled", ctx))) await api.memo<boolean>("throwaway-recalled", true, ctx);
        return undefined;
      },
      onYield: async (_answer, api, ctx): Promise<undefined> => {
        await api.memo<boolean>("throwaway-retained", true, ctx);
        return undefined;
      },
    }),
  ],
});

test("missing extension: a session whose agent selects an uninstalled extension opens, takes a message and finishes", async () => {
  const t = await tempStore();
  try {
    // 1. A real backend session.
    let store = await t.open();
    const session = await store.create({ name: "Stale", cwd: t.work, model: faux });
    const dbPath = (await store.resolveAgent(session.id, "main")).row.dbPath;
    await store.close();

    // 2. A build that installs the extension: the agent turns it on, the way PATCH .../extensions stores a selection
    // (the whole array by name), and a run calls its tool. Name-only stand-ins store the backend's default selection.
    const models = createModels();
    installFaux(models);
    const registry = createRegistry();
    const selection = [CodingTools, defineExtension({ name: "playground" }), defineExtension({ name: "toolkit" }), Throwaway];
    for (const extension of selection) registry.install(extension);
    const h = await Harness.open(
      await openNodeSqliteStorage(dbPath),
      { models, registry, env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? t.work }) },
      ctx,
    );
    const main = await h.root(ctx);
    await main.configure({ extensions: selection }, ctx);
    const stored = ["coding-tools", "playground", "toolkit", "throwaway-memory"];
    assert.deepEqual((await main.agent(ctx)).extensions.map((e) => e.name), stored);
    h.resume();
    const first = await main.submit({ type: "input", content: 'tool: throwaway_recall {"query":"x"}', requestId: "with-extension" }, ctx);
    assert.equal((await first.wait(ctx)).status, "done");
    await h.close(ctx);

    // 3. This build lacks it. The backend opens the session, runs a message to completion and still edits the agent.
    store = await t.open();
    try {
      const { row, h, c } = await store.resolveAgent(session.id, "main");
      assert.match(JSON.stringify((await store.entries(c, undefined, 50)).items), /Tool finished: the fact/);
      assert.deepEqual((await c.agent(ctx)).extensions.map((e) => e.name), stored.slice(0, 3), "the missing name is skipped");
      const submission = await store.send(c, { content: "still there?", requestId: "after-removal" });
      const settled = await store.settled(h, submission.id as number, 20000);
      assert.equal(settled.status, "done", JSON.stringify(settled));
      assert.match(JSON.stringify(settled), /Echo: still there\?/);
      const offered = (await store.agentDetail(row, c)).tools.filter((x) => x.offered).map((x) => x.name);
      assert.ok(!offered.includes("throwaway_recall"), "the removed extension's tool is not offered");
      assert.ok(offered.includes("bash"));
      const ext = await store.setExtension(row, c, { name: "jev-damage-control", enabled: true });
      assert.equal(ext.extensions.find((e) => e.name === "jev-damage-control")?.enabled, true);
      const again = await store.send(c, { content: "and again", requestId: "after-edit" });
      assert.equal((await store.settled(h, again.id as number, 20000)).status, "done");
    } finally {
      await store.close();
    }
  } finally {
    await t.cleanup();
  }
});
