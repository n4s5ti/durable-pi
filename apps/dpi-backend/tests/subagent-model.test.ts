// Delegated agents' models: family aliases (claude-haiku-latest …), the subagent and start_session defaults
// (DPI_SUBAGENT_MODEL, else the newest Haiku), and clear errors for unknown ids.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { anthropicModels, MODEL_ALIASES, resolveModelAlias } from "../src/model-catalog.js";
import { DEFAULT_SUBAGENT_MODEL, subagentModelId } from "../src/extensions.js";
import { Store } from "../src/store.js";
import { faux, tempStore } from "./helpers.js";

test("model aliases: claude-<family>-latest is the family's newest catalog entry; other ids pass through", () => {
  assert.deepEqual(MODEL_ALIASES, {
    "claude-haiku-latest": "claude-haiku-5-5",
    "claude-sonnet-latest": "claude-sonnet-5-5",
    "claude-opus-latest": "claude-opus-5-5",
  });
  assert.equal(resolveModelAlias("claude-haiku-latest"), "claude-haiku-5-5");
  assert.equal(resolveModelAlias("claude-haiku-4-5"), "claude-haiku-4-5");
  assert.equal(resolveModelAlias("claude-fable-latest"), "claude-fable-latest", "no alias for other families");
  const ids = anthropicModels.map((m) => m.id);
  assert.ok(ids.includes("claude-haiku-5-5") && ids.includes("claude-haiku-4-5"), "4.5 stays offered");
  assert.equal(DEFAULT_SUBAGENT_MODEL, "claude-haiku-latest");
  const saved = process.env.DPI_SUBAGENT_MODEL;
  delete process.env.DPI_SUBAGENT_MODEL;
  assert.equal(resolveModelAlias(subagentModelId()), "claude-haiku-5-5");
  process.env.DPI_SUBAGENT_MODEL = " claude-sonnet-latest ";
  assert.equal(subagentModelId(), "claude-sonnet-latest");
  if (saved === undefined) delete process.env.DPI_SUBAGENT_MODEL;
  else process.env.DPI_SUBAGENT_MODEL = saved;
});

test("a subscription device offers Haiku 5.5 and resolves aliases for jobs, sessions and configure; unknown ids fail", async () => {
  const t = await tempStore();
  const authFile = join(t.root, "auth.json");
  writeFileSync(authFile, JSON.stringify({ anthropic: { type: "api_key", key: "sk-ant-test" } }));
  const store = await Store.open({ ...t.options, provider: "openrouter", authFile });
  try {
    const sub = store.deviceInfo().models.filter((m) => m.provider === "anthropic").map((m) => m.id);
    assert.ok(sub.includes("claude-haiku-5-5") && sub.includes("claude-haiku-4-5"), sub.join(","));
    assert.deepEqual(store.jobModel("claude-haiku-latest"), { provider: "anthropic", modelId: "claude-haiku-5-5" });
    assert.deepEqual(store.jobModel("claude-sonnet-latest"), { provider: "anthropic", modelId: "claude-sonnet-5-5" });
    assert.deepEqual(store.jobModel("claude-opus-latest"), { provider: "anthropic", modelId: "claude-opus-5-5" });
    assert.deepEqual(store.jobModel("claude-haiku-4-5"), { provider: "anthropic", modelId: "claude-haiku-4-5" });
    assert.deepEqual(store.validateModel({ provider: "anthropic", modelId: "claude-haiku-latest" }), { provider: "anthropic", modelId: "claude-haiku-5-5" });
    assert.throws(() => store.jobModel("claude-nope-9"), /Unknown model claude-nope-9\. Choose one of: .*claude-haiku-5-5/);
    assert.throws(() => store.jobModel("claude-fable-latest"), /Unknown model claude-fable-latest/);
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("subagent: the child is configured with the newest Haiku by default, with the given model when passed; unknown fails", async () => {
  const t = await tempStore();
  const store = await t.open();
  const saved = process.env.DPI_SUBAGENT_MODEL;
  delete process.env.DPI_SUBAGENT_MODEL;
  try {
    const s = await store.create({ name: "Delegate", cwd: t.work, model: faux });
    const { row, h, c } = await store.resolveAgent(s.id, "main");
    let n = 0;
    const call = async (args: unknown) => {
      const sub = await store.send(c, { content: `tool: subagent ${JSON.stringify(args)}`, requestId: `sa-${n++}` });
      assert.equal((await store.settled(h, sub.id as number, 20000)).status, "done");
      const md = (await store.transcript(c, "markdown")).text ?? "";
      return md.slice(md.lastIndexOf("Tool "));
    };
    const children = async () => (await store.agents(row)).filter((a) => a.kind === "subagent").map((a) => a.id).sort((a, b) => a - b);
    const childModel = async (id: number) => (await store.agentDetail(row, (await store.resolveAgent(s.id, String(id))).c)).config.model;

    // A faux device has no Haiku: the default falls back to the parent's model and says so (review-pr15 F7); a model named
    // in the call that is unknown still fails and creates no child.
    assert.match(await call({ task: "say hi" }), /claude-haiku-latest is not available on this device, so the parent's model faux\/echo was used/);
    assert.deepEqual(await childModel((await children())[0]), faux);
    assert.match(await call({ task: "say hi", model: "gpt-nope" }), /Unknown model gpt-nope/);
    assert.equal((await children()).length, 1);

    // Stand in for a subscription device's resolver (tested above) and record the ids asked for. The children then fail
    // their own run on this faux device, but their stored model is what the subagent tool configured.
    const asked: string[] = [];
    const real = store.jobModel.bind(store);
    store.jobModel = (id: string) => {
      asked.push(id);
      const resolved = resolveModelAlias(id);
      return anthropicModels.some((m) => m.id === resolved) ? { provider: "anthropic", modelId: resolved } : real(id);
    };
    await call({ task: "say hi" });
    let ids = await children();
    assert.equal(ids.length, 2, "the fallback child above and this one");
    assert.deepEqual(await childModel(ids[1]), { provider: "anthropic", modelId: "claude-haiku-5-5" });
    await call({ task: "think hard", model: "claude-sonnet-latest" });
    ids = await children();
    assert.deepEqual(await childModel(ids[2]), { provider: "anthropic", modelId: "claude-sonnet-5-5" });
    process.env.DPI_SUBAGENT_MODEL = "claude-opus-latest";
    await call({ task: "env default" });
    ids = await children();
    assert.deepEqual(await childModel(ids[3]), { provider: "anthropic", modelId: "claude-opus-5-5" });
    assert.deepEqual(asked, ["claude-haiku-latest", "claude-sonnet-latest", "claude-opus-latest"]);
    // The parent keeps its own model.
    assert.deepEqual((await store.agentDetail(row, c)).config.model, { provider: "faux", modelId: "echo" });

    // start_session uses the same resolver: an unknown model fails clearly and starts nothing.
    const sub = await store.send(c, { content: `tool: start_session ${JSON.stringify({ name: "Nope", cwd: ".", model: "gpt-nope" })}`, requestId: "ss-1" });
    assert.equal((await store.settled(h, sub.id as number, 20000)).status, "done");
    const md = (await store.transcript(c, "markdown")).text ?? "";
    assert.match(md.slice(md.lastIndexOf("Tool ")), /Unknown model gpt-nope/);
    assert.equal(store.list().some((r) => r.name === "Nope"), false);
  } finally {
    if (saved === undefined) delete process.env.DPI_SUBAGENT_MODEL;
    else process.env.DPI_SUBAGENT_MODEL = saved;
    await store.close();
    await t.cleanup();
  }
});
