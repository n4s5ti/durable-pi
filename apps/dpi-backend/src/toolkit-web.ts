// Web search and page reading (license notice in toolkit.ts).
// Providers are tried in order and each needs its key in the backend's environment: BRAVE_API_KEY, TAVILY_API_KEY,
// EXA_API_KEY, SEARXNG_URL (a SearXNG instance with JSON output). DuckDuckGo's HTML page needs none and comes last.
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { clip, decodeEntities, htmlText, htmlToMarkdown, MAX_TEXT, text } from "./toolkit-common.js";

export type SearchResult = { title: string; url: string; snippet?: string; date?: string };
type Recency = "day" | "week" | "month" | "year";
type Query = { query: string; limit: number; recency?: Recency };

/** DuckDuckGo and many sites answer a browser, not a script. */
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";
const TIMEOUT_MS = 20_000;

async function getJson(url: string, init: RequestInit) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw Error(`HTTP ${res.status}: ${clip((await res.text()).trim(), 300, "")}`);
  return (await res.json()) as Record<string, unknown>;
}

const DAYS: Record<Recency, number> = { day: 1, week: 7, month: 31, year: 366 };

/** Results from DuckDuckGo's HTML page, with its redirect links unwrapped. */
export function parseDuckDuckGo(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const blockRe =
    /<div\b[^>]*\bclass="[^"]*\bresult\b[^"]*"[^>]*>([\s\S]*?)(?=<div\b[^>]*\bclass="[^"]*\bresult\b|<div\b[^>]*\bclass="[^"]*\bnav-link\b|$)/g;
  const titleRe = /<a\b[^>]*\bclass="[^"]*\bresult__a\b[^"]*"[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/;
  const snippetRe = /<(?:a|div|span)\b[^>]*\bclass="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|span)>/;
  for (const match of html.matchAll(blockRe)) {
    const title = titleRe.exec(match[1]);
    if (!title) continue;
    const href = title[1].replace(/&amp;/gi, "&");
    const wrapped = /[?&]uddg=([^&]+)/.exec(href)?.[1];
    let url: string | undefined;
    try {
      url = wrapped ? decodeURIComponent(wrapped) : href.startsWith("//") ? `https:${href}` : /^https?:\/\//.test(href) ? href : undefined;
    } catch {}
    const titleText = htmlText(title[2]);
    if (!url || !titleText || url.includes("duckduckgo.com/y.js")) continue;
    const snippet = snippetRe.exec(match[1]);
    results.push({ title: titleText, url, ...(snippet ? { snippet: htmlText(snippet[1]) } : {}) });
  }
  return results;
}

type Provider = { name: string; ready: () => boolean; search: (q: Query) => Promise<SearchResult[]> };

const PROVIDERS: Provider[] = [
  {
    name: "brave",
    ready: () => !!process.env.BRAVE_API_KEY,
    search: async (q) => {
      const url = new URL("https://api.search.brave.com/res/v1/web/search");
      url.searchParams.set("q", q.query);
      url.searchParams.set("count", String(Math.min(q.limit, 20)));
      url.searchParams.set("extra_snippets", "true");
      url.searchParams.set("text_decorations", "false");
      if (q.recency) url.searchParams.set("freshness", { day: "pd", week: "pw", month: "pm", year: "py" }[q.recency]);
      const body = await getJson(url.toString(), { headers: { Accept: "application/json", "X-Subscription-Token": process.env.BRAVE_API_KEY! } });
      const web = (body.web as { results?: Record<string, unknown>[] } | undefined)?.results ?? [];
      return web.map((r) => ({
        title: String(r.title ?? ""),
        url: String(r.url ?? ""),
        snippet: [r.description, ...((r.extra_snippets as string[] | undefined) ?? [])].filter(Boolean).map(String).join(" … "),
        ...(r.age ? { date: String(r.age) } : {}),
      }));
    },
  },
  {
    name: "tavily",
    ready: () => !!process.env.TAVILY_API_KEY,
    search: async (q) => {
      const body = await getJson("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.TAVILY_API_KEY}` },
        body: JSON.stringify({ query: q.query, max_results: Math.min(q.limit, 20), include_raw_content: false, ...(q.recency ? { time_range: q.recency } : {}) }),
      });
      return ((body.results as Record<string, unknown>[] | undefined) ?? []).map((r) => ({
        title: String(r.title ?? ""),
        url: String(r.url ?? ""),
        snippet: String(r.content ?? ""),
        ...(r.published_date ? { date: String(r.published_date) } : {}),
      }));
    },
  },
  {
    name: "exa",
    ready: () => !!process.env.EXA_API_KEY,
    search: async (q) => {
      const since = q.recency ? new Date(Date.now() - DAYS[q.recency] * 86_400_000).toISOString() : undefined;
      const body = await getJson("https://api.exa.ai/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": process.env.EXA_API_KEY! },
        body: JSON.stringify({ query: q.query, numResults: Math.min(q.limit, 20), type: "auto", contents: { highlights: true }, ...(since ? { startPublishedDate: since } : {}) }),
      });
      return ((body.results as Record<string, unknown>[] | undefined) ?? []).map((r) => ({
        title: String(r.title ?? r.url ?? ""),
        url: String(r.url ?? ""),
        snippet: String(r.summary ?? (r.highlights as string[] | undefined)?.join(" … ") ?? r.text ?? ""),
        ...(r.publishedDate ? { date: String(r.publishedDate).slice(0, 10) } : {}),
      }));
    },
  },
  {
    name: "searxng",
    ready: () => !!process.env.SEARXNG_URL,
    search: async (q) => {
      const url = new URL("/search", process.env.SEARXNG_URL);
      url.searchParams.set("q", q.query);
      url.searchParams.set("format", "json");
      if (q.recency) url.searchParams.set("time_range", q.recency);
      const body = await getJson(url.toString(), { headers: { Accept: "application/json" } });
      return ((body.results as Record<string, unknown>[] | undefined) ?? []).map((r) => ({
        title: String(r.title ?? ""),
        url: String(r.url ?? ""),
        snippet: String(r.content ?? ""),
        ...(r.publishedDate ? { date: String(r.publishedDate).slice(0, 10) } : {}),
      }));
    },
  },
  {
    name: "duckduckgo",
    ready: () => true,
    search: async (q) => {
      const form = new URLSearchParams({ q: q.query, kl: "us-en", b: "" });
      if (q.recency) form.set("df", q.recency[0]);
      const res = await fetch("https://html.duckduckgo.com/html/", {
        method: "POST",
        body: form.toString(),
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": BROWSER_UA, Referer: "https://html.duckduckgo.com/" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const html = await res.text();
      if (!res.ok) throw Error(`HTTP ${res.status}`);
      if (/anomaly-modal|challenge-form|Unfortunately, bots use DuckDuckGo/i.test(html))
        throw Error("DuckDuckGo answered with a bot check; set BRAVE_API_KEY, TAVILY_API_KEY or EXA_API_KEY for reliable search");
      return parseDuckDuckGo(html);
    },
  },
];

export const SEARCH_PROVIDERS = PROVIDERS.map((p) => p.name);

export function formatResults(provider: string, results: SearchResult[]) {
  if (!results.length) return `No results (${provider})`;
  const lines = results.map((r, i) => {
    const snippet = r.snippet ? `\n   ${clip(decodeEntities(r.snippet).replace(/\s+/g, " ").trim(), 400, "")}` : "";
    return `${i + 1}. ${r.title}${r.date ? ` (${r.date})` : ""}\n   ${r.url}${snippet}`;
  });
  return `${lines.join("\n")}\n\n(${provider})`;
}

const webSearch = defineTool({
  name: "web_search",
  description:
    "Search the web. Returns titles, URLs and snippets; read a result with fetch_url. Uses the first configured provider (Brave, Tavily, Exa, SearXNG), else DuckDuckGo, and falls through to the next one when a provider fails.",
  parameters: Type.Object({
    query: Type.String({ description: "What to search for; site:, quotes and -term work with most providers" }),
    limit: Type.Optional(Type.Number({ description: "Results (default 8, max 20)" })),
    recency: Type.Optional(Type.Union(["day", "week", "month", "year"].map((r) => Type.Literal(r)), { description: "Only recent results" })),
    provider: Type.Optional(Type.Union(SEARCH_PROVIDERS.map((p) => Type.Literal(p)), { description: "Use only this provider" })),
  }),
  replay: "safe",
  execute: async (args) => {
    const query: Query = { query: args.query, limit: Math.min(20, Math.max(1, Math.floor(args.limit ?? 8))), recency: args.recency as Recency | undefined };
    const chain = args.provider ? PROVIDERS.filter((p) => p.name === args.provider) : PROVIDERS.filter((p) => p.ready());
    const failures: string[] = [];
    for (const provider of chain) {
      if (args.provider && !provider.ready()) throw Error(`${provider.name} is not configured on this device`);
      try {
        const results = (await provider.search(query)).filter((r) => r.url).slice(0, query.limit);
        return text(formatResults(provider.name, results));
      } catch (e) {
        failures.push(`${provider.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    throw Error(`Web search failed.\n${failures.join("\n")}`);
  },
});

// ------------------------------------------------------------------ fetch_url

const MAX_BYTES = 5 * 1024 * 1024;

const fetchUrl = defineTool({
  name: "fetch_url",
  description:
    "Read a web page or file over HTTP(S). HTML comes back as Markdown (the main content, links kept); JSON and text as they are. Long pages page with offset. GET only.",
  parameters: Type.Object({
    url: Type.String({ description: "http or https URL" }),
    raw: Type.Optional(Type.Boolean({ description: "Return HTML as it is instead of Markdown" })),
    offset: Type.Optional(Type.Number({ description: "Characters to skip, for the next page" })),
  }),
  replay: "safe",
  execute: async (args) => {
    const url = new URL(args.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw Error("fetch_url takes http and https URLs");
    const res = await fetch(url, {
      headers: { "User-Agent": BROWSER_UA, Accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5" },
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const type = res.headers.get("content-type") ?? "";
    const size = Number(res.headers.get("content-length") ?? 0);
    if (size > MAX_BYTES) throw Error(`${url} is ${size} bytes; download it with bash instead`);
    if (/^(image|audio|video)\/|application\/(pdf|zip|octet-stream)/.test(type))
      throw Error(`${url} is ${type || "binary"}; download it with bash, then read_document or read_archive it`);
    const body = (await res.text()).slice(0, MAX_BYTES);
    const isHtml = /html/.test(type) || /^\s*<(!doctype html|html)\b/i.test(body);
    const title = isHtml ? htmlText(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1] ?? "") : "";
    const content = isHtml && !args.raw ? htmlToMarkdown(body) : body;
    const offset = Math.max(0, Math.floor(args.offset ?? 0));
    const page = content.slice(offset, offset + MAX_TEXT);
    const rest = content.length - offset - page.length;
    const head = [`${res.status} ${res.url}`, title && `# ${title}`].filter(Boolean).join("\n");
    return text(`${head}\n\n${page || "(empty)"}${rest > 0 ? `\n\n[${rest} more characters; next page: offset ${offset + page.length}]` : ""}`);
  },
});

export const WEB_TOOLS = [webSearch, fetchUrl];
