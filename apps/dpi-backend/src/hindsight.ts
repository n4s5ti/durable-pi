// The hindsight add-on: the same long-term memory the Hermes agent uses, a local Hindsight server
// (vectorize-io/hindsight). It mirrors Hermes' hindsight memory provider in hybrid mode:
//
//   auto recall   before the first request of a run, recall against the user's message and add the
//                 memories to that run's requests (Hermes: auto_recall + recall_sync)
//   auto retain   after the final answer, store the user/assistant turn (Hermes: auto_retain)
//   tools         hindsight_retain, hindsight_recall, hindsight_reflect, same schemas as Hermes
//
// Settings come from Hermes' own file, ~/.local/share/hermes-home/hindsight/config.json (api_url,
// recall_budget, recall_max_tokens, recall_types), so both agents read and write one bank. The bank
// follows Hermes' bank_id_template for its default profile ("hermes-{profile}" -> hermes-default).
// DPI_HINDSIGHT_URL and DPI_HINDSIGHT_BANK override. A Hindsight outage never stops a run: recall and
// retain fail open with a log line.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, GenerationTask, hook, section } from "@earendil-works/pi-durable";
import { text } from "./toolkit-common.js";

type HermesHindsight = {
  api_url?: string;
  bank_id?: string;
  bank_id_template?: string;
  recall_budget?: string;
  recall_max_tokens?: number;
  recall_types?: string | string[];
};

const HERMES_CONFIG = join(homedir(), ".local/share/hermes-home/hindsight/config.json");
const TIMEOUT_MS = 20_000;
const SOURCE = "durable-pi";
const PREAMBLE =
  "# Hindsight Memory (persistent cross-session context)\n" +
  "Use this to answer questions about the user and prior sessions. " +
  "Do not call tools to look up information that is already present here.";

function readHermes(): HermesHindsight {
  try {
    return JSON.parse(readFileSync(HERMES_CONFIG, "utf8")) as HermesHindsight;
  } catch {
    return {};
  }
}

export function hindsightSettings() {
  const cfg = readHermes();
  const template = cfg.bank_id_template?.trim();
  const bank =
    process.env.DPI_HINDSIGHT_BANK ||
    (template ? template.replaceAll("{profile}", "default") : "") ||
    cfg.bank_id ||
    "hermes";
  const types = typeof cfg.recall_types === "string" ? cfg.recall_types.split(",") : cfg.recall_types;
  return {
    url: (process.env.DPI_HINDSIGHT_URL || cfg.api_url || "http://127.0.0.1:9177").replace(/\/$/, ""),
    bank,
    budget: cfg.recall_budget || "mid",
    maxTokens: cfg.recall_max_tokens || 4096,
    types: (types ?? []).map((t) => t.trim()).filter(Boolean).length
      ? (types ?? []).map((t) => t.trim()).filter(Boolean)
      : ["observation"],
  };
}

type Settings = ReturnType<typeof hindsightSettings>;

async function call<T>(s: Settings, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${s.url}/v1/default/banks/${encodeURIComponent(s.bank)}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw Error(`Hindsight ${path} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

/**
 * Hindsight rejects recall queries over 500 tokens. Whitespace collapsed and cut to 1200 characters
 * keeps even dense code (about 3 characters a token) under it.
 */
export const RECALL_QUERY_CHARS = 1200;
export const recallQuery = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, RECALL_QUERY_CHARS);

const recall = async (s: Settings, query: string) =>
  (
    await call<{ results?: { text?: string }[] }>(s, "/memories/recall", {
      query,
      budget: s.budget,
      max_tokens: s.maxTokens,
      types: s.types,
    })
  ).results?.filter((r) => r.text) ?? [];

const retain = (s: Settings, item: Record<string, unknown>, documentId?: string) =>
  call(s, "/memories", { items: [{ ...item, ...(documentId ? { document_id: documentId } : {}) }], async: true });

const metadata = (conversationId: string, messageCount: number) => ({
  retained_at: new Date().toISOString(),
  message_count: String(messageCount),
  source: SOURCE,
  session_id: conversationId,
  platform: SOURCE,
});

const textOf = (content: string | readonly { type: string; text?: string }[]) =>
  typeof content === "string"
    ? content
    : content
        .filter((b) => b.type === "text" && b.text)
        .map((b) => b.text)
        .join("\n");

export function createHindsight(opts: { offline: boolean }) {
  const s = hindsightSettings();

  const retainTool = defineTool({
    name: "hindsight_retain",
    description:
      "Store information to long-term memory. Hindsight automatically extracts structured facts, resolves entities, and indexes for retrieval.",
    parameters: Type.Object({
      content: Type.String({ description: "The information to store." }),
      context: Type.Optional(Type.String({ description: "Short label (e.g. 'user preference', 'project decision')." })),
      tags: Type.Optional(
        Type.Array(Type.String(), { description: "Optional per-call tags to merge with configured default retain tags." }),
      ),
      occurred_at: Type.Optional(
        Type.String({
          description:
            "When the remembered event actually happened, as an ISO-8601 date or datetime. Pass this whenever the memory references a specific event time so Hindsight can anchor it on the timeline. Omit for timeless facts/preferences.",
        }),
      ),
    }),
    replay: "unsafe",
    execute: async (args, api) => {
      const { content, context, tags, occurred_at } = args as {
        content: string;
        context?: string;
        tags?: string[];
        occurred_at?: string;
      };
      if (opts.offline) return text("Hindsight is not used offline.");
      await retain(s, {
        content,
        timestamp: occurred_at?.trim() || new Date().toISOString(),
        metadata: metadata(String(api.conversationId), 1),
        ...(context ? { context } : {}),
        ...(tags?.length ? { tags } : {}),
      });
      return text("Memory stored successfully.");
    },
  });

  const recallTool = defineTool({
    name: "hindsight_recall",
    description:
      "Search long-term memory. Returns memories ranked by relevance using semantic search, keyword matching, entity graph traversal, and reranking.",
    parameters: Type.Object({ query: Type.String({ description: "What to search for." }) }),
    replay: "safe",
    execute: async (args) => {
      if (opts.offline) return text("Hindsight is not used offline.");
      const results = await recall(s, (args as { query: string }).query);
      return text(results.map((r, i) => `${i + 1}. ${r.text}`).join("\n") || "No relevant memories found.");
    },
  });

  const reflectTool = defineTool({
    name: "hindsight_reflect",
    description:
      "Synthesize a reasoned answer from long-term memories. Unlike recall, this reasons across all stored memories to produce a coherent response.",
    parameters: Type.Object({ query: Type.String({ description: "The question to reflect on." }) }),
    replay: "safe",
    execute: async (args) => {
      if (opts.offline) return text("Hindsight is not used offline.");
      const res = await call<{ text?: string }>(s, "/reflect", {
        query: (args as { query: string }).query,
        budget: s.budget,
      });
      return text(res.text || "No relevant memories found.");
    },
  });

  type Recalled = { user: string; block: string };

  return defineExtension({
    name: "hindsight",
    tools: [retainTool, recallTool, reflectTool],
    sections: [
      section(
        "hindsight",
        () =>
          `# Hindsight Memory\nActive. Bank: ${s.bank}, budget: ${s.budget}.\nRelevant memories are automatically injected into context. Use hindsight_recall to search, hindsight_reflect for synthesis, hindsight_retain to store facts.`,
        { tag: false },
      ),
    ],
    hooks: [
      hook(GenerationTask, {
        // Recall once per run (memo), against the run's latest user message; every request of the
        // run carries the same block, added to that user message only for the request.
        beforeRequest: async (request, api, ctx) => {
          if (opts.offline) return;
          const at = request.messages.findLastIndex((m) => m.role === "user");
          if (at < 0) return;
          const target = request.messages[at] as Extract<(typeof request.messages)[number], { role: "user" }>;
          let got = await api.memo<Recalled>("hindsight-recall", ctx);
          if (!got) {
            const user = textOf(target.content).trim();
            let block = "";
            if (user) {
              try {
                const results = await recall(s, recallQuery(user));
                if (results.length) block = `${PREAMBLE}\n\n${results.map((r) => `- ${r.text}`).join("\n")}`;
              } catch (e) {
                console.error("[hindsight] recall failed, run continues:", e instanceof Error ? e.message : e);
              }
            }
            got = await api.memo<Recalled>("hindsight-recall", { user, block }, ctx);
          }
          if (!got.block) return;
          const content =
            typeof target.content === "string"
              ? `${got.block}\n\n${target.content}`
              : [{ type: "text" as const, text: got.block }, ...target.content];
          const messages = [...request.messages];
          messages[at] = { ...target, content };
          return { messages };
        },
        // Retain the turn after the final answer, the way Hermes does: one JSON list of the user and
        // assistant messages, prefixed "User:" and "Assistant:". The memo keeps a rerun from storing twice.
        onYield: async (answer, api, ctx): Promise<undefined> => {
          if (opts.offline) return undefined;
          if (await api.memo<boolean>("hindsight-retained", ctx)) return undefined;
          const recalled = await api.memo<Recalled>("hindsight-recall", ctx);
          const assistant = textOf(answer.content as { type: string; text?: string }[]).trim();
          if (!recalled?.user || !assistant) return undefined;
          const now = new Date().toISOString();
          const turn = [
            { role: "user", content: `User: ${recalled.user}`, timestamp: now },
            { role: "assistant", content: `Assistant: ${assistant}`, timestamp: now },
          ];
          try {
            await retain(
              s,
              {
                content: JSON.stringify(turn),
                timestamp: now,
                metadata: metadata(String(api.conversationId), 2),
                tags: [`session:${String(api.conversationId)}`],
              },
              `dpi-${String(api.conversationId)}-${String(api.taskId)}`,
            );
          } catch (e) {
            console.error("[hindsight] retain failed, answer kept:", e instanceof Error ? e.message : e);
          }
          await api.memo<boolean>("hindsight-retained", true, ctx);
          return undefined;
        },
      }),
    ],
  });
}
