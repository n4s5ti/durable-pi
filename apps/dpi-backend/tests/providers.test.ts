import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { loadConfig } from "../src/config.js";
import { tempStore } from "./helpers.js";

/** Runs `fn` with exactly these provider env keys set (the rest cleared), restoring them afterwards. */
async function withKeys(keys: Record<string, string>, fn: () => Promise<void>) {
  const names = ["OPENROUTER_API_KEY", "GROQ_API_KEY", "DEEPSEEK_API_KEY", "CEREBRAS_API_KEY", "MISTRAL_API_KEY", "GEMINI_API_KEY", "NVIDIA_API_KEY"];
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  for (const n of names) delete process.env[n];
  Object.assign(process.env, { OPENROUTER_API_KEY: "sk-or-test" }, keys);
  try {
    await fn();
  } finally {
    for (const n of names) {
      if (saved[n] === undefined) delete process.env[n];
      else process.env[n] = saved[n];
    }
  }
}

// Ambient credentials of the host (e.g. AWS) may register more providers; assert only on the ones a test controls.
const providersOf = (store: Store) => [...new Set(store.deviceInfo().models.map((m) => m.provider))].sort();
const CONTROLLED = ["anthropic", "cerebras", "deepseek", "groq", "openai-codex", "openrouter"];
const controlled = (store: Store) => providersOf(store).filter((p) => CONTROLLED.includes(p));

test("an env API key registers that pi-ai provider: its models are listed, resolve and route; others stay out", async () => {
  await withKeys({ GROQ_API_KEY: "gsk-test", DEEPSEEK_API_KEY: "sk-test" }, async () => {
    const t = await tempStore();
    const store = await Store.open({ ...t.options, provider: "openrouter", authFile: join(t.root, "missing.json") });
    try {
      assert.deepEqual(controlled(store), ["deepseek", "groq", "openrouter"]);
      const groq = store.deviceInfo().models.filter((m) => m.provider === "groq");
      assert.ok(groq.some((m) => m.id === "openai/gpt-oss-120b"), groq.map((m) => m.id).join(","));
      const ref = { provider: "groq", modelId: "openai/gpt-oss-120b" };
      assert.deepEqual(store.validateModel(ref), ref);
      assert.deepEqual(store.routedModel(ref), ref);
      assert.deepEqual(store.jobModel("openai/gpt-oss-120b"), ref);
      assert.deepEqual(store.jobModel("groq/openai/gpt-oss-120b"), ref);
      assert.deepEqual(store.validateModel({ provider: "deepseek", modelId: "deepseek-v4-pro" }), { provider: "deepseek", modelId: "deepseek-v4-pro" });
      // Unknown ids fail clearly, also under a registered provider; unkeyed providers are not offered.
      assert.throws(() => store.validateModel({ provider: "groq", modelId: "nope" }), /Unknown model groq\/nope/);
      assert.throws(() => store.jobModel("groq/nope"), /Unknown model groq\/nope\. Choose one of: .*openai\/gpt-oss-120b/);
      assert.throws(() => store.validateModel({ provider: "cerebras", modelId: "gpt-oss-120b" }), /Unknown model cerebras\//);
      // OpenRouter is untouched: curated list, same default.
      assert.equal(store.deviceInfo().defaultModel, "anthropic/claude-sonnet-5.5");
      assert.equal(store.routedModel({ provider: "openrouter", modelId: "anthropic/claude-opus-5.5" }).provider, "openrouter");
      // A session starts on a Groq model.
      const s = await store.create({ name: "g", cwd: t.work, model: ref });
      const { row, c } = await store.resolveAgent(s.id, "main");
      assert.deepEqual((await store.agentDetail(row, c)).config.model, ref);
    } finally {
      await store.close();
      await t.cleanup();
    }
  });
});

test("without a key the provider's models are not offered and do not resolve", async () => {
  await withKeys({}, async () => {
    const t = await tempStore();
    const store = await Store.open({ ...t.options, provider: "openrouter", authFile: join(t.root, "missing.json") });
    try {
      assert.deepEqual(controlled(store), ["openrouter"]);
      assert.throws(() => store.validateModel({ provider: "groq", modelId: "openai/gpt-oss-120b" }), /Unknown model groq\//);
      assert.throws(() => store.jobModel("openai/gpt-oss-120b"), /Unknown model/);
      assert.equal(store.routedModel({ provider: "groq", modelId: "openai/gpt-oss-120b" }).provider, "openrouter");
    } finally {
      await store.close();
      await t.cleanup();
    }
  });
});

test("with an anthropic credential, Anthropic stays the default and a Groq key adds Groq next to it", async () => {
  await withKeys({ GROQ_API_KEY: "gsk-test" }, async () => {
    const t = await tempStore();
    const authFile = join(t.root, "auth.json");
    writeFileSync(authFile, JSON.stringify({ anthropic: { type: "api_key", key: "sk-ant-test" } }));
    const store = await Store.open({ ...t.options, provider: "openrouter", authFile });
    try {
      assert.deepEqual(controlled(store), ["anthropic", "groq", "openrouter"]);
      assert.equal(store.deviceInfo().defaultModel, "claude-sonnet-5-5");
      const ref = { provider: "groq", modelId: "openai/gpt-oss-120b" };
      assert.deepEqual(store.routedModel(ref), ref);
      assert.deepEqual(store.routedModel({ provider: "cerebras", modelId: "x" }), { provider: "anthropic", modelId: "claude-sonnet-5-5" });
      assert.deepEqual(store.jobModel("claude-haiku-latest"), { provider: "anthropic", modelId: "claude-haiku-5-5" });
    } finally {
      await store.close();
      await t.cleanup();
    }
  });
});

test("an auth.json entry registers an OAuth provider (openai-codex) with no env key", async () => {
  await withKeys({}, async () => {
    const t = await tempStore();
    const authFile = join(t.root, "auth.json");
    writeFileSync(authFile, JSON.stringify({ "openai-codex": { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 3600_000 } }));
    const store = await Store.open({ ...t.options, provider: "openrouter", authFile });
    try {
      assert.deepEqual(controlled(store), ["openai-codex", "openrouter"]);
      const codex = store.deviceInfo().models.find((m) => m.provider === "openai-codex")!;
      assert.deepEqual(store.validateModel({ provider: "openai-codex", modelId: codex.id }), { provider: "openai-codex", modelId: codex.id });
    } finally {
      await store.close();
      await t.cleanup();
    }
  });
});

test("DPI_PROVIDERS limits the extra providers; empty means all", async () => {
  await withKeys({ GROQ_API_KEY: "gsk-test", DEEPSEEK_API_KEY: "sk-test" }, async () => {
    const t = await tempStore();
    const store = await Store.open({ ...t.options, provider: "openrouter", authFile: join(t.root, "missing.json"), providers: ["deepseek"] });
    try {
      assert.deepEqual(providersOf(store), ["deepseek", "openrouter"]);
    } finally {
      await store.close();
      await t.cleanup();
    }
  });
  const env = { DPI_TOKEN: "x".repeat(32), DPI_HOME: "/nonexistent" };
  assert.deepEqual(loadConfig([], { ...env, DPI_PROVIDERS: " groq, deepseek ," }).providers, ["groq", "deepseek"]);
  assert.equal(loadConfig([], { ...env, DPI_PROVIDERS: "" }).providers, undefined);
  assert.equal(loadConfig([], env).providers, undefined);
});
