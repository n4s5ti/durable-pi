import { test } from "node:test";
import assert from "node:assert/strict";
import { statSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FileCredentialStore } from "../src/credentials.js";
import { Store } from "../src/store.js";
import { tempStore } from "./helpers.js";

test("FileCredentialStore: reads pi-ai auth.json, persists modify at 0600, picks up outside writes", async () => {
  const t = await tempStore();
  try {
    const path = join(t.root, "auth.json");
    const creds = new FileCredentialStore(path);
    assert.equal(creds.has("anthropic"), false);
    assert.deepEqual(await creds.list(), []);

    // `pi-ai login` writes the file while the backend runs; the next read sees it.
    writeFileSync(path, JSON.stringify({ anthropic: { type: "oauth", access: "a1", refresh: "r1", expires: 1 } }));
    assert.equal(creds.has("anthropic"), true);
    assert.deepEqual(await creds.list(), [{ providerId: "anthropic", type: "oauth" }]);

    // A refresh goes through modify and lands on disk, owner-only.
    const next = await creds.modify("anthropic", async (cur) => ({ ...cur!, access: "a2", expires: 2 }) as never);
    assert.equal((next as { access: string }).access, "a2");
    assert.equal(JSON.parse(readFileSync(path, "utf8")).anthropic.access, "a2");
    assert.equal(statSync(path).mode & 0o777, 0o600);

    // Returning undefined leaves the entry unchanged; delete removes it.
    await creds.modify("anthropic", async () => undefined);
    assert.equal((await creds.read("anthropic") as { access: string }).access, "a2");
    await creds.delete("anthropic");
    assert.equal(creds.has("anthropic"), false);
  } finally {
    await t.cleanup();
  }
});

test("Store: an anthropic credential adds direct Anthropic models and makes them the default", async () => {
  const t = await tempStore();
  const authFile = join(t.root, "auth.json");
  writeFileSync(authFile, JSON.stringify({ anthropic: { type: "api_key", key: "sk-ant-test" } }));
  const store = await Store.open({ ...t.options, provider: "openrouter", authFile });
  try {
    assert.equal(store.anthropic, true);
    const info = store.deviceInfo();
    assert.equal(info.defaultModel, "claude-sonnet-5-5");
    const sub = info.models.filter((m) => m.provider === "anthropic").map((m) => m.id);
    assert.ok(sub.includes("claude-opus-5-5") && sub.includes("claude-sonnet-5-5"), sub.join(","));
    assert.deepEqual(store.validateModel({ provider: "anthropic", modelId: "claude-opus-5-5" }), {
      provider: "anthropic",
      modelId: "claude-opus-5-5",
    });
    assert.throws(() => store.validateModel({ provider: "anthropic", modelId: "nope" }));
    assert.deepEqual(store.routedModel({ provider: "anthropic", modelId: "claude-opus-5-5" }), {
      provider: "anthropic",
      modelId: "claude-opus-5-5",
    });
    // OpenRouter models stay routable next to the subscription.
    assert.equal(store.routedModel({ provider: "openrouter", modelId: "anthropic/claude-opus-5.5" }).provider, "openrouter");
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("Store: without an anthropic credential nothing changes", async () => {
  const t = await tempStore();
  const store = await Store.open({ ...t.options, provider: "openrouter", authFile: join(t.root, "missing.json") });
  try {
    assert.equal(store.anthropic, false);
    assert.equal(store.deviceInfo().defaultModel, "anthropic/claude-sonnet-5.5");
    assert.throws(() => store.validateModel({ provider: "anthropic", modelId: "claude-opus-5-5" }));
  } finally {
    await store.close();
    await t.cleanup();
  }
});
