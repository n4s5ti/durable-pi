// Helpers shared by the toolkit add-on's tools (see toolkit.ts).
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";

const MAX_OUTPUT = 400_000;
/** The most text one result hands the model. */
export const MAX_TEXT = 60_000;

export const text = (value: string) => ({ output: [{ type: "text" as const, text: value }] });

/** Cut text to `max` characters with a note saying how much was left out. */
export function clip(value: string, max = MAX_TEXT, hint = "") {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n\n[${value.length - max} more characters cut${hint ? `; ${hint}` : ""}]`;
}

/** Run a program (argv, no shell) in the call's environment; its stdout and stderr arrive merged. */
export async function run(api: Pick<ToolExecutionApi, "env">, argv: string[], ctx: Context, timeout = 30) {
  if (!api.env) throw Error("This session has no execution environment");
  let out = "";
  const result = await api.env.exec(argv, { timeout, onOutput: (chunk) => void (out.length < MAX_OUTPUT && (out += chunk)) }, ctx);
  if (!result.ok) {
    if (result.error.code === "spawn_error") throw Error(`Could not run ${argv[0]}; is it installed on this device? ${result.error.message}`);
    throw Error(`${argv[0]}: ${result.error.message}`);
  }
  return { code: result.value.exitCode, out, truncated: out.length >= MAX_OUTPUT };
}

/** A path as the session sees it: relative paths start at the session's folder. */
export async function sessionPath(api: Pick<ToolExecutionApi, "env">, path: string, ctx: Context) {
  if (!api.env) throw Error("This session has no execution environment");
  const absolute = await api.env.absolutePath(path, ctx);
  if (!absolute.ok) throw Error(`${path}: ${absolute.error.message}`);
  const exists = await api.env.exists(absolute.value, ctx);
  if (!exists.ok || !exists.value) throw Error(`${path} does not exist`);
  return absolute.value;
}

const ENTITIES: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'" };

/** Unescape HTML and XML entities. */
export function decodeEntities(value: string) {
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&([a-z]+|#39);/gi, (all, name: string) => ENTITIES[name.toLowerCase()] ?? all);
}

/** Tag-free text of an HTML fragment, whitespace collapsed. */
export function htmlText(value: string) {
  return decodeEntities(value.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

/**
 * Readable Markdown from an HTML page: the <main> or <article> when there is one, without scripts, styles and page
 * chrome; headings, links, lists, code and paragraphs kept.
 */
export function htmlToMarkdown(html: string) {
  let body = html.replace(/<!--[\s\S]*?-->/g, "");
  body = body.replace(/<(script|style|noscript|svg|template|iframe|head)\b[\s\S]*?<\/\1>/gi, "");
  const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(body)?.[1] ?? /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(body)?.[1];
  if (main) body = main;
  else body = body.replace(/<(nav|header|footer|aside|form)\b[\s\S]*?<\/\1>/gi, "");
  const md = body
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, code: string) => `\n\n\`\`\`\n${decodeEntities(code.replace(/<[^>]*>/g, ""))}\n\`\`\`\n\n`)
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n: string, t: string) => `\n\n${"#".repeat(Number(n))} ${htmlText(t)}\n\n`)
    .replace(/<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi, (_, _q, href: string, t: string) => {
      const label = htmlText(t);
      return label && !href.startsWith("#") && !href.startsWith("javascript:") ? `[${label}](${decodeEntities(href)})` : label;
    })
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, t: string) => `\`${htmlText(t)}\``)
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, _t, t: string) => `**${htmlText(t)}**`)
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<(br|hr)\b[^>]*>/gi, "\n")
    .replace(/<\/(p|div|section|tr|ul|ol|table|blockquote|dl|dd|dt)>/gi, "\n")
    .replace(/<(p|div|section|tr|blockquote)\b[^>]*>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " | ")
    .replace(/<[^>]*>/g, "");
  return decodeEntities(md)
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
