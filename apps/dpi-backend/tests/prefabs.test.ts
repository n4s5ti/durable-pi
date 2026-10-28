// Prefab views from device facts: every output passes the ui-spec catalog check (even past every
// table limit), shows what the facts say, and keeps updatedAt while nothing changed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkUiSpec } from "../../dpi-sdk/src/ui-spec.js";
import type { ModelInfo, UsageTotals } from "../../dpi-sdk/src/api.js";
import { buildPrefabs, checkOpenRouter, PREFAB_NAMES, tokens, usd, type DeviceFacts } from "../src/prefabs.js";

const model = (id: string, provider = "anthropic", tier = "S"): ModelInfo => ({
  id,
  provider,
  name: id,
  tier,
  icon: "x.png",
  contextWindow: 200000,
  reasoning: true,
  cost: { input: 3, output: 15 },
});
const usage = (model: string, totalTokens: number, cost: number): UsageTotals => ({
  models: {
    [model]: {
      input: totalTokens,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens,
      cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
    },
  },
  tools: {},
});

const facts = (patch: Partial<DeviceFacts> = {}): DeviceFacts => ({
  providers: [
    { id: "anthropic", name: "Anthropic", credential: "subscription (OAuth)", status: "unchecked", models: 2 },
    {
      id: "openrouter",
      name: "OpenRouter",
      credential: "API key",
      status: "rejected",
      detail: "OpenRouter answered 401: the key is not valid.",
      models: 30,
    },
  ],
  models: [model("claude-sonnet-5-5"), model("claude-opus-5-5"), model("deepseek/flash", "openrouter", "A")],
  defaultModel: "claude-sonnet-5-5",
  sessions: [
    { name: "m1dstr3am", model: "claude-opus-5-5", agents: 2, busy: true, usage: usage("claude-opus-5-5", 1_250_000, 4.2) },
    { name: "sesh1", model: "claude-sonnet-5-5", agents: 1, busy: false, usage: undefined },
  ],
  addons: [
    { name: "toolkit", title: "Toolkit", description: "Search and todo.", onForNewSessions: true },
    { name: "ui-tools", title: "UI tools", description: "Views on the canvas.", onForNewSessions: false },
  ],
  ...patch,
});

test("prefabs: one view per prefab, each inside the catalog, showing the facts", () => {
  const views = buildPrefabs(facts(), [], 1000);
  assert.deepEqual(views.map((v) => v.id), [...PREFAB_NAMES]);
  for (const v of views) checkUiSpec(v.spec);
  const text = (id: string) => JSON.stringify(views.find((v) => v.id === id)!.spec);
  assert.match(text("dpi.providers"), /"text":"key rejected","tone":"urgent"/);
  assert.match(text("dpi.providers"), /OpenRouter answered 401/);
  assert.match(text("dpi.models"), /"claude-sonnet-5-5","anthropic","S","200.0k","\$3.00","\$15.00","default, in use"/);
  assert.match(text("dpi.models"), /"claude-opus-5-5","anthropic","S","200.0k","\$3.00","\$15.00","in use"/);
  assert.match(text("dpi.usage"), /"label":"Tokens","value":"1.3M"/);
  assert.match(text("dpi.usage"), /\["m1dstr3am","2","busy","1.3M","\$4.20"\]/);
  assert.match(text("dpi.addons"), /\["Toolkit","Search and todo.","on for new sessions"\]/);
});

test("prefabs: OpenRouter limits show as spend and a progress bar, no limit says so", () => {
  const limited = facts({
    providers: [
      {
        id: "openrouter",
        name: "OpenRouter",
        credential: "API key",
        status: "ok",
        models: 30,
        limitUsd: 20,
        remainingUsd: 5,
        usageUsd: 15,
        usageDailyUsd: 1.5,
        usageMonthlyUsd: 9,
      },
    ],
  });
  const spec = JSON.stringify(buildPrefabs(limited)[0].spec);
  assert.match(spec, /"type":"progress","value":0.75,"label":"Limit \$20.00, \$5.00 left"/);
  assert.match(spec, /"label":"Spent today","value":"\$1.50"/);
  const open = facts({
    providers: [{ id: "openrouter", name: "OpenRouter", credential: "API key", status: "ok", models: 1, limitUsd: null, usageUsd: 0 }],
  });
  assert.match(JSON.stringify(buildPrefabs(open)[0].spec), /No spending limit on this key/);
});

test("prefabs: past every catalog limit the views still pass, with a +N more row", () => {
  const big = facts({
    models: Array.from({ length: 100 }, (_, i) => model(`model-${i}-${"x".repeat(300)}`)),
    sessions: Array.from({ length: 60 }, (_, i) => ({
      name: `session ${i} ${"y".repeat(500)}`,
      model: "m",
      agents: 3,
      busy: false,
      usage: usage(`model-${i}`, i * 1000, i / 10),
    })),
    addons: Array.from({ length: 70 }, (_, i) => ({ name: `a${i}`, title: `A${i}`, description: "z".repeat(5000), onForNewSessions: false })),
  });
  for (const v of buildPrefabs(big)) checkUiSpec(v.spec);
  assert.match(JSON.stringify(buildPrefabs(big)[1].spec), /"\+51 more"/);
});

test("prefabs: updatedAt holds while a view is unchanged", () => {
  const first = buildPrefabs(facts(), [], 1000);
  const again = buildPrefabs(facts(), first, 2000);
  assert.deepEqual(again.map((v) => v.updatedAt), [1000, 1000, 1000, 1000]);
  const busier = facts();
  busier.sessions[1].busy = true;
  const changed = buildPrefabs(busier, again, 3000);
  assert.equal(changed.find((v) => v.id === "dpi.usage")!.updatedAt, 3000);
  assert.equal(changed.find((v) => v.id === "dpi.models")!.updatedAt, 1000);
});

test("prefabs: number formats", () => {
  assert.deepEqual([tokens(0), tokens(999), tokens(1500), tokens(2_500_000), tokens(3e9)], ["0", "999", "1.5k", "2.5M", "3.0B"]);
  assert.deepEqual([usd(0), usd(0.004), usd(4.2), usd(null)], ["$0.00", "<$0.01", "$4.20", "–"]);
});

test("prefabs: the OpenRouter key check reads limits, names a rejected key, and never throws", async () => {
  const answer = (status: number, body: unknown) => async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  const ok = await checkOpenRouter(
    "sk-or-secret",
    answer(200, { data: { limit: 20, limit_remaining: 5, usage: 15, usage_daily: 1.5, usage_monthly: 9, is_free_tier: false, label: "x" } }),
  );
  assert.deepEqual(ok, {
    status: "ok",
    limitUsd: 20,
    remainingUsd: 5,
    usageUsd: 15,
    usageDailyUsd: 1.5,
    usageMonthlyUsd: 9,
    freeTier: false,
  });
  assert.equal((await checkOpenRouter("k", answer(200, { data: { limit: null } }))).limitUsd, null);
  const rejected = await checkOpenRouter("sk-or-secret", answer(401, { error: { message: "User not found." } }));
  assert.equal(rejected.status, "rejected");
  assert.match(rejected.detail!, /answered 401/);
  assert.equal((await checkOpenRouter("k", answer(500, "oops"))).status, "error");
  assert.equal((await checkOpenRouter("k", answer(200, "x".repeat(70_000)))).status, "error");
  const down = await checkOpenRouter("sk-or-secret", async () => {
    throw new TypeError("fetch failed: sk-or-secret");
  });
  assert.equal(down.status, "error");
  for (const r of [ok, rejected, down]) assert.equal(JSON.stringify(r).includes("sk-or-secret"), false, "the key never shows");
  let sent = "";
  await checkOpenRouter("sk-or-secret", async (_url, init) => {
    sent = String(new Headers(init?.headers).get("authorization"));
    return new Response("{}", { status: 200 });
  });
  assert.equal(sent, "Bearer sk-or-secret");
});
