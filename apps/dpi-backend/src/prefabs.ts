// Prefabs: dpi's own map on the live canvas, after AI Agents Map but about this device only. Each one
// turns facts the backend already has (its model providers, the model catalog, sessions and their
// usage, the add-ons) into a read-only view from the ui-spec catalog. The device publishes all of
// them on its tree; an agent can pin a snapshot of one as its own view with the ui_prefab tool.
//
//   dpi.providers   model providers: credential kind, status, OpenRouter limit and spend
//   dpi.models      the model catalog: provider, tier, context, price, default and in use
//   dpi.usage       tokens and cost, overall, by session and by model
//   dpi.addons      the add-ons any agent can turn on
//
// Credentials: only whether one exists and its kind. A value never enters a view.
import type { ModelInfo, UsageTotals } from "../../dpi-sdk/src/api.js";
import { UI_LIMITS, type UiNode, type UiView } from "../../dpi-sdk/src/ui-spec.js";

export const PREFAB_NAMES = ["dpi.providers", "dpi.models", "dpi.usage", "dpi.addons"] as const;
export type PrefabName = (typeof PREFAB_NAMES)[number];

export const PREFAB_INFO: Record<PrefabName, { title: string; description: string }> = {
  "dpi.providers": { title: "Providers", description: "This device's model providers: sign-in, status, limits and spend." },
  "dpi.models": { title: "Models", description: "The model catalog: provider, tier, context size, price; default and in use." },
  "dpi.usage": { title: "Usage", description: "Tokens and cost on this device, by session and by model." },
  "dpi.addons": { title: "Add-ons", description: "The add-ons any agent on this device can turn on." },
};

export type ProviderStatus = "ok" | "rejected" | "error" | "unchecked" | "missing";

export interface ProviderFacts {
  id: string;
  name: string;
  /** "API key", "subscription (OAuth)" or "none"; never the credential itself. */
  credential: string;
  status: ProviderStatus;
  detail?: string;
  models: number;
  /** From OpenRouter's GET /api/v1/key; null limit means no limit is set. */
  limitUsd?: number | null;
  remainingUsd?: number | null;
  usageUsd?: number;
  usageDailyUsd?: number;
  usageMonthlyUsd?: number;
  freeTier?: boolean;
}

export interface SessionUsage {
  name: string;
  model: string;
  agents: number;
  busy: boolean;
  usage: UsageTotals | undefined;
}

export interface AddonFacts {
  name: string;
  title: string;
  description: string;
  onForNewSessions: boolean;
}

export interface DeviceFacts {
  providers: ProviderFacts[];
  models: ModelInfo[];
  defaultModel: string;
  sessions: SessionUsage[];
  addons: AddonFacts[];
}

const MAX_ROWS = UI_LIMITS.items;

const cut = (text: string, max = 200) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function tokens(n: number) {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

export function usd(n: number | null | undefined) {
  if (n === null || n === undefined || !Number.isFinite(n)) return "–";
  if (n !== 0 && Math.abs(n) < 0.01) return "<$0.01";
  return `$${n.toFixed(2)}`;
}

/** Rows past the limit become one "+N more" row so a table never breaks the catalog's bounds. */
function capped(rows: string[][], width: number) {
  if (rows.length <= MAX_ROWS) return rows;
  const kept = rows.slice(0, MAX_ROWS - 1);
  kept.push([`+${rows.length - kept.length} more`, ...Array(width - 1).fill("")]);
  return kept;
}

const STATUS_TONE = { ok: "accent", rejected: "urgent", error: "urgent", unchecked: "muted", missing: "muted" } as const;
const STATUS_TEXT = {
  ok: "working",
  rejected: "key rejected",
  error: "check failed",
  unchecked: "not checked",
  missing: "not set up",
} as const;

export function providersView(facts: DeviceFacts): UiNode {
  if (!facts.providers.length) return { type: "text", text: "No model providers configured.", tone: "muted" };
  return {
    type: "column",
    children: facts.providers.map((p): UiNode => {
      const children: UiNode[] = [
        {
          type: "row",
          children: [
            { type: "badge", text: STATUS_TEXT[p.status], tone: STATUS_TONE[p.status] },
            { type: "metric", label: "Sign-in", value: p.credential },
            { type: "metric", label: "Models", value: String(p.models) },
          ],
        },
      ];
      if (p.detail) children.push({ type: "text", text: cut(p.detail), tone: p.status === "ok" ? "muted" : "urgent" });
      if (p.usageUsd !== undefined)
        children.push({
          type: "row",
          children: [
            { type: "metric", label: "Spent today", value: usd(p.usageDailyUsd) },
            { type: "metric", label: "This month", value: usd(p.usageMonthlyUsd) },
            { type: "metric", label: "All time", value: usd(p.usageUsd) },
          ],
        });
      if (typeof p.limitUsd === "number" && p.limitUsd > 0) {
        const remaining = Math.max(0, p.remainingUsd ?? p.limitUsd - (p.usageUsd ?? 0));
        children.push({
          type: "progress",
          value: Math.min(1, Math.max(0, 1 - remaining / p.limitUsd)),
          label: `Limit ${usd(p.limitUsd)}, ${usd(remaining)} left`,
        });
      } else if (p.limitUsd === null) children.push({ type: "text", text: "No spending limit on this key.", tone: "muted" });
      if (p.freeTier) children.push({ type: "badge", text: "free tier", tone: "muted" });
      return { type: "card", title: p.name, children };
    }),
  };
}

export function modelsView(facts: DeviceFacts): UiNode {
  const inUse = new Set(facts.sessions.map((s) => s.model));
  const rows = [...facts.models]
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.tier.localeCompare(b.tier) || a.name.localeCompare(b.name))
    .map((m) => [
      cut(m.name, 60),
      m.provider,
      m.tier,
      tokens(m.contextWindow),
      usd(m.cost.input),
      usd(m.cost.output),
      [m.id === facts.defaultModel ? "default" : "", inUse.has(m.id) ? "in use" : ""].filter(Boolean).join(", "),
    ]);
  const columns = ["Model", "Provider", "Tier", "Context", "In $/M", "Out $/M", ""];
  return {
    type: "column",
    children: [
      {
        type: "row",
        children: [
          { type: "metric", label: "Models", value: String(facts.models.length) },
          { type: "metric", label: "Default", value: cut(facts.models.find((m) => m.id === facts.defaultModel)?.name ?? facts.defaultModel, 60) },
          { type: "metric", label: "In use", value: String(inUse.size) },
        ],
      },
      rows.length ? { type: "table", columns, rows: capped(rows, columns.length) } : { type: "text", text: "No models.", tone: "muted" },
    ],
  };
}

export function usageView(facts: DeviceFacts): UiNode {
  const total = { tokens: 0, cost: 0 };
  const byModel = new Map<string, { tokens: number; cost: number }>();
  const rows = facts.sessions.map((s) => {
    let t = 0;
    let c = 0;
    for (const [model, u] of Object.entries(s.usage?.models ?? {})) {
      t += u.totalTokens;
      c += u.cost.total;
      const m = byModel.get(model) ?? { tokens: 0, cost: 0 };
      m.tokens += u.totalTokens;
      m.cost += u.cost.total;
      byModel.set(model, m);
    }
    total.tokens += t;
    total.cost += c;
    return { row: [cut(s.name, 60), String(s.agents), s.busy ? "busy" : "", tokens(t), usd(c)], cost: c };
  });
  const sessionColumns = ["Session", "Agents", "", "Tokens", "Cost"];
  const modelRows = [...byModel.entries()]
    .sort((a, b) => b[1].cost - a[1].cost || b[1].tokens - a[1].tokens)
    .slice(0, 10)
    .map(([model, u]) => [cut(model, 60), tokens(u.tokens), usd(u.cost)]);
  return {
    type: "column",
    children: [
      {
        type: "row",
        children: [
          { type: "metric", label: "Tokens", value: tokens(total.tokens) },
          { type: "metric", label: "Cost", value: usd(total.cost) },
          { type: "metric", label: "Sessions", value: String(facts.sessions.length) },
        ],
      },
      rows.length
        ? {
            type: "table",
            columns: sessionColumns,
            rows: capped(
              rows.sort((a, b) => b.cost - a.cost).map((r) => r.row),
              sessionColumns.length,
            ),
          }
        : { type: "text", text: "No sessions yet.", tone: "muted" },
      ...(modelRows.length ? [{ type: "table" as const, columns: ["Model", "Tokens", "Cost"], rows: modelRows }] : []),
    ],
  };
}

export function addonsView(facts: DeviceFacts): UiNode {
  const columns = ["Add-on", "What it does", ""];
  return {
    type: "table",
    columns,
    rows: capped(
      facts.addons.map((a) => [a.title, cut(a.description, 300), a.onForNewSessions ? "on for new sessions" : ""]),
      columns.length,
    ),
  };
}

const finite = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const orNull = (v: unknown) => (v === null ? null : finite(v));

/**
 * OpenRouter's GET /api/v1/key for this device's key: whether it is accepted, its limit and spend.
 * Bounded (5 s, 64 KiB) and never throws; the key goes only into the Authorization header.
 */
export async function checkOpenRouter(key: string, fetchImpl: typeof fetch = fetch): Promise<Partial<ProviderFacts>> {
  try {
    const res = await fetchImpl("https://openrouter.ai/api/v1/key", {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(5000),
    });
    if (res.status === 401 || res.status === 403)
      return { status: "rejected", detail: `OpenRouter answered ${res.status}: it does not accept this key. Replace OPENROUTER_API_KEY.` };
    if (!res.ok) return { status: "error", detail: `OpenRouter answered ${res.status} to the key check.` };
    const text = await res.text();
    if (text.length > 64 * 1024) return { status: "error", detail: "OpenRouter's key check answer was too large." };
    const data = ((JSON.parse(text) as { data?: Record<string, unknown> }).data ?? {}) as Record<string, unknown>;
    return {
      status: "ok",
      limitUsd: orNull(data.limit),
      remainingUsd: orNull(data.limit_remaining),
      usageUsd: finite(data.usage),
      usageDailyUsd: finite(data.usage_daily),
      usageMonthlyUsd: finite(data.usage_monthly),
      freeTier: data.is_free_tier === true,
    };
  } catch (e) {
    const reason = e instanceof Error && e.name === "TimeoutError" ? "no answer in 5 s" : "the request failed";
    return { status: "error", detail: `Could not check the key with OpenRouter (${reason}).` };
  }
}

const BUILDERS: Record<PrefabName, (facts: DeviceFacts) => UiNode> = {
  "dpi.providers": providersView,
  "dpi.models": modelsView,
  "dpi.usage": usageView,
  "dpi.addons": addonsView,
};

/** Every prefab as a view. `previous` keeps updatedAt when a view's spec did not change. */
export function buildPrefabs(facts: DeviceFacts, previous: UiView[] = [], now = Date.now()): UiView[] {
  const before = new Map(previous.map((v) => [v.id, v]));
  return PREFAB_NAMES.map((name) => {
    const spec = BUILDERS[name](facts);
    const old = before.get(name);
    const same = old && JSON.stringify(old.spec) === JSON.stringify(spec);
    return { id: name, title: PREFAB_INFO[name].title, spec, template: name, updatedAt: same ? old.updatedAt : now };
  });
}
