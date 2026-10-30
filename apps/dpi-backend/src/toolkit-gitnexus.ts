// gitnexus: read-only code-graph spot checks (impact, callers, paths, flows, read-only Cypher) on a repository GitNexus
// has already indexed, without bash (the oracle tool set keeps it). It runs the GitNexus CLI (DPI_GITNEXUS_CMD, default
// `npx -y gitnexus@1.6.12`) argv only, no shell, in a repository folder that must exist.
//
//   commands   GITNEXUS_COMMANDS (query, context, impact, trace, cypher, check, status), the one list to change if names
//              change. Never analyze, index, clean, remove, setup, serve, mcp, wiki, publish, update, embeddings or group.
//   arguments  typed per command, never free argv; options always go as `--flag=value` so a value cannot become a flag,
//              and a positional (symbol, from, to, query) that starts with "-" is refused
//   cypher     read only: it must start with MATCH, OPTIONAL MATCH, WITH, UNWIND or RETURN, and any writing or loading
//              keyword outside string literals is refused; rows are capped with --limit
//   repo       every call first runs `status --json` in the folder. No index there means a clear "ask for a manual
//              index" message (this tool never builds one); otherwise the call is pinned to that index with
//              --repo=<root>, so GitNexus never falls back to another registered repository
import { Type } from "@earendil-works/pi-ai";
import type { Context } from "@earendil-works/chord";
import { defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { sessionPath, text } from "./toolkit-common.js";

export const GITNEXUS_COMMANDS = ["query", "context", "impact", "trace", "cypher", "check", "status"] as const;
export type GitnexusCommand = (typeof GITNEXUS_COMMANDS)[number];

/** The most output one call hands back; more is cut with a note saying so. */
export const GITNEXUS_MAX_CHARS = 40_000;
/** Seconds one GitNexus call may take. */
export const GITNEXUS_TIMEOUT = 120;
export const GITNEXUS_DEFAULT_CMD = "npx -y gitnexus@1.6.12";
/** Rows a cypher call returns at most (and by default). */
export const CYPHER_MAX_ROWS = 200;
const CYPHER_DEFAULT_ROWS = 50;
const MAX_VALUE = 500;
const MAX_CYPHER = 4000;
const MAX_CAPTURE = 2_000_000;

/** Keywords that write, load or reach outside the graph; refused anywhere outside a string literal. */
export const CYPHER_REFUSED = [
  "CREATE", "MERGE", "DELETE", "DETACH", "SET", "REMOVE", "DROP", "ALTER", "COPY", "LOAD", "CALL", "INSTALL", "ATTACH",
  "EXPORT", "IMPORT", "CHECKPOINT", "USE", "BEGIN", "COMMIT", "ROLLBACK", "FOREACH",
];

/** The GitNexus command as argv: DPI_GITNEXUS_CMD split on whitespace, read at each call. */
export const gitnexusCmd = () => (process.env.DPI_GITNEXUS_CMD?.trim() || GITNEXUS_DEFAULT_CMD).split(/\s+/);

export interface GitnexusParams {
  command: string;
  repo?: string;
  target?: string;
  uid?: string;
  file?: string;
  kind?: string;
  direction?: string;
  depth?: number;
  include_tests?: boolean;
  from?: string;
  to?: string;
  to_file?: string;
  query?: string;
  limit?: number;
}

function value(name: string, v: unknown, max = MAX_VALUE): string {
  if (typeof v !== "string" || !v.trim()) throw Error(`${name} must be a non-empty string`);
  if (/[\0\n\r]/.test(v) || v.length > max) throw Error(`Invalid ${name}: ${JSON.stringify(v.slice(0, 80))}`);
  return v.trim();
}

/** A value that GitNexus reads as a positional argument: it may not start with "-", or it would be parsed as a flag. */
function positional(name: string, v: unknown, max = MAX_VALUE) {
  const s = value(name, v, max);
  if (s.startsWith("-")) throw Error(`${name} may not start with "-": ${JSON.stringify(s.slice(0, 80))}`);
  return s;
}

function int(name: string, v: unknown, min: number, max: number) {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw Error(`${name} must be a whole number from ${min} to ${max}`);
  return String(v);
}

/** Cypher with string literals and comments blanked out, so keyword checks only see the query's own words. */
export function cypherSkeleton(query: string) {
  return query
    .replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`[^`]*`/g, " '' ")
    .replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, " ");
}

/** Throws unless `query` is a single read-only Cypher statement. Exported for tests. */
export function checkCypher(query: string) {
  const skeleton = cypherSkeleton(query).trim();
  if (/['"`]/.test(skeleton.replace(/''/g, ""))) throw Error("cypher has an unclosed string literal");
  if (!/^(OPTIONAL\s+MATCH|MATCH|WITH|UNWIND|RETURN)\b/i.test(skeleton))
    throw Error("cypher must be a read query starting with MATCH, OPTIONAL MATCH, WITH, UNWIND or RETURN");
  if (/;\s*\S/.test(skeleton)) throw Error("cypher must be a single statement");
  const words = new Set(skeleton.toUpperCase().match(/[A-Z_]+/g) ?? []);
  const bad = CYPHER_REFUSED.filter((k) => words.has(k));
  if (bad.length) throw Error(`cypher is refused: ${bad.join(", ")} can write or load data. This tool only reads.`);
}

/**
 * The argv after the GitNexus binary for one call, from typed parameters. `root` is the indexed repository the call is
 * pinned to (--repo=<root>). Throws on an unknown command, a missing or invalid value, or a write in cypher. Exported
 * for tests.
 */
export function gitnexusArgv(p: GitnexusParams, root: string): string[] {
  const cmd = p.command as GitnexusCommand;
  if (!GITNEXUS_COMMANDS.includes(cmd))
    throw Error(`gitnexus ${JSON.stringify(p.command)} is not allowed; use one of ${GITNEXUS_COMMANDS.join(", ")}. This tool never indexes.`);
  const repo = `--repo=${value("repo", root, 4096)}`;
  const out: string[] = [cmd];
  const opt = (flag: string, v: string) => out.push(`--${flag}=${v}`);
  const symbol = (what: string) => {
    if (p.uid !== undefined) opt("uid", value("uid", p.uid));
    else if (p.target !== undefined) out.push(positional("target", p.target));
    else throw Error(`gitnexus ${what} needs target (a symbol name) or uid`);
    if (p.file !== undefined) opt("file", value("file", p.file));
  };
  switch (cmd) {
    case "query":
      out.push(positional("query", p.query));
      if (p.limit !== undefined) opt("limit", int("limit", p.limit, 1, 20));
      break;
    case "context":
      symbol("context");
      if (p.limit !== undefined) opt("limit", int("limit", p.limit, 1, 100));
      break;
    case "impact":
      symbol("impact");
      if (p.direction !== undefined) {
        if (p.direction !== "upstream" && p.direction !== "downstream") throw Error("direction must be upstream or downstream");
        opt("direction", p.direction);
      }
      if (p.kind !== undefined) {
        if (!/^[A-Za-z]{1,40}$/.test(String(p.kind))) throw Error("kind must be a node kind such as Function, Class or Method");
        opt("kind", p.kind);
      }
      if (p.depth !== undefined) opt("depth", int("depth", p.depth, 1, 5));
      if (p.include_tests) out.push("--include-tests");
      if (p.limit !== undefined) opt("limit", int("limit", p.limit, 1, 100));
      break;
    case "trace":
      out.push(positional("from", p.from), positional("to", p.to));
      if (p.file !== undefined) opt("from-file", value("file", p.file));
      if (p.to_file !== undefined) opt("to-file", value("to_file", p.to_file));
      if (p.depth !== undefined) opt("depth", int("depth", p.depth, 1, 5));
      if (p.include_tests) out.push("--include-tests");
      break;
    case "cypher": {
      const q = positional("query", p.query, MAX_CYPHER);
      checkCypher(q);
      out.push(q);
      opt("limit", p.limit === undefined ? String(CYPHER_DEFAULT_ROWS) : int("limit", p.limit, 1, CYPHER_MAX_ROWS));
      break;
    }
    case "check":
      out.push("--cycles", "--json");
      break;
    case "status":
      out.push("--json");
      break;
  }
  out.push(repo);
  return out;
}

const isLogLine = (line: string) => {
  try {
    const v = JSON.parse(line) as Record<string, unknown>;
    return typeof v === "object" && v !== null && "level" in v && "time" in v && "msg" in v;
  } catch {
    return false;
  }
};

/**
 * The JSON value GitNexus printed, as its text: the object that starts at the first line beginning with "{" (the
 * banner and pino log lines come before it; single-line pino records are skipped). Lines after it that are not part of
 * the object are dropped. Undefined when there is none. Exported for tests.
 */
export function extractJson(out: string): string | undefined {
  const lines = out.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("{") || isLogLine(lines[i])) continue;
    const tryParse = (end: number) => {
      const body = lines.slice(i, end + 1).join("\n").trim();
      try {
        JSON.parse(body);
        return body;
      } catch {
        return undefined;
      }
    };
    const whole = tryParse(lines.length - 1);
    if (whole) return whole;
    for (let j = i; j < lines.length; j++) {
      if (j !== i && !lines[j].startsWith("}")) continue;
      const body = tryParse(j);
      if (body) return body;
    }
  }
  return undefined;
}

/** Output text without pino log records and Node stack frames, for error messages. */
export function plainLines(out: string) {
  return out
    .split(/\r?\n/)
    .filter((l) => !isLogLine(l) && !/^\s+at .+\(?.*:\d+:\d+\)?$/.test(l) && !/^Node\.js v\d/.test(l))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const NO_INDEX = /not-indexed|not-git-repository|Repository not indexed|Not a git repository|Multiple repositories indexed|Repository "[^"]*" not found|No (?:indexed )?repositories (?:are )?indexed|no index found/i;

/** The message when a folder has no GitNexus index this tool can use. */
export const noIndexMessage = (repo: string) =>
  `No GitNexus index for ${repo}; ask for a manual index. This tool never builds one; fall back to grep and git meanwhile.`;

/** True when GitNexus output says the folder has no usable index. Exported for tests. */
export const saysNoIndex = (out: string) => NO_INDEX.test(out);

/** Output cut at GITNEXUS_MAX_CHARS, saying so when it was cut. */
export function gitnexusText(out: string, truncatedAtSource = false) {
  if (!out.trim()) return "(no output)";
  if (out.length <= GITNEXUS_MAX_CHARS && !truncatedAtSource) return out;
  return `${out.slice(0, GITNEXUS_MAX_CHARS)}\n\n[gitnexus output truncated: showed ${Math.min(GITNEXUS_MAX_CHARS, out.length)} of ${out.length}${truncatedAtSource ? "+" : ""} characters; narrow it with limit, depth, file or a tighter query]`;
}

interface Status {
  repository?: string;
  branch?: string;
  status?: string;
  error?: string;
  index?: { commit?: string; indexedAt?: string; runnerIdentity?: unknown; incompleteReasons?: unknown[] };
  current?: { commit?: string; runnerIdentity?: unknown };
  contentDrift?: { status?: string };
}

/** One line on how fresh the index is: indexed commit against HEAD, and GitNexus's own verdict. Exported for tests. */
export function stalenessLine(s: Status) {
  const short = (c?: string) => (c ? c.slice(0, 7) : "unknown");
  const idx = s.index?.commit;
  const head = s.current?.commit;
  const same = idx && head ? (idx === head ? "the index is at HEAD" : "the index is NOT at HEAD, so recent changes are missing") : "commit match unknown";
  return `Index: ${s.repository ?? "?"} at commit ${short(idx)}, HEAD ${short(head)} (${same}); indexed ${s.index?.indexedAt ?? "?"}; gitnexus staleness: ${s.status ?? "unknown"}; uncommitted edits are never in the index.`;
}

// argv form: the environment runs argv[0] directly, without a shell, so no value is ever parsed by one.
async function exec(api: Pick<ToolExecutionApi, "env">, argv: string[], ctx: Context, cwd: string, timeout = GITNEXUS_TIMEOUT) {
  if (!api.env) throw Error("This session has no execution environment");
  let stdout = "";
  let stderr = "";
  const result = await api.env.exec(
    argv,
    {
      cwd,
      timeout,
      inheritEnv: true,
      env: { NO_COLOR: "1", CI: "1", FORCE_COLOR: "0" },
      onOutput: (chunk, _c, info) => {
        if (info.stream === "stderr") stderr.length < MAX_CAPTURE && (stderr += chunk);
        else stdout.length < MAX_CAPTURE && (stdout += chunk);
      },
    },
    ctx,
  );
  if (!result.ok) {
    if (result.error.code === "spawn_error") throw Error(`Could not run ${argv[0]}; is it installed on this device? ${result.error.message}`);
    throw Error(`${argv[0]}: ${result.error.message}`);
  }
  return { code: result.value.exitCode, stdout, stderr, truncated: stdout.length >= MAX_CAPTURE };
}

/** Run one checked call in `dir`: status first (no index means the no-index message), then the command pinned to it. */
export async function runGitnexus(api: Pick<ToolExecutionApi, "env">, p: GitnexusParams, dir: string, ctx: Context, shownRepo = dir) {
  const bin = gitnexusCmd();
  gitnexusArgv(p, dir); // validate everything before anything runs
  const pre = await exec(api, [...bin, "status", "--json"], ctx, dir, 60);
  const preJson = extractJson(pre.stdout);
  let status: Status | undefined;
  try {
    status = preJson ? (JSON.parse(preJson) as Status) : undefined;
  } catch {
    status = undefined;
  }
  if (!status) {
    if (saysNoIndex(pre.stdout + pre.stderr)) return noIndexMessage(shownRepo);
    return `gitnexus status failed (exit ${pre.code}); cannot tell whether ${shownRepo} is indexed.\n\n${gitnexusText(plainLines(pre.stdout + "\n" + pre.stderr))}`;
  }
  if (status.error || !status.index || !status.repository) return noIndexMessage(shownRepo);
  const header = stalenessLine(status);
  if (p.command === "status") {
    const slim = { ...status, index: { ...status.index, runnerIdentity: undefined }, current: { ...status.current, runnerIdentity: undefined } };
    return `${header}\n\n${JSON.stringify(slim, null, 1)}`;
  }
  const argv = gitnexusArgv(p, status.repository);
  const { code, stdout, stderr, truncated } = await exec(api, [...bin, ...argv], ctx, dir);
  const json = extractJson(stdout);
  if (!json && saysNoIndex(stdout + stderr)) return noIndexMessage(shownRepo);
  const body = json ?? (plainLines(stdout) || plainLines(stderr));
  const shown = gitnexusText(body, truncated);
  return code === 0 ? `${header}\n\n${shown}` : `gitnexus ${p.command} exited with code ${code}\n${header}\n\n${shown}`;
}

const str = (description: string) => Type.Optional(Type.String({ description }));

const gitnexus = defineTool({
  name: "gitnexus",
  description:
    "GitNexus code graph for spot checks, read only, on a repository that is already indexed. impact: what breaks if a symbol changes (target or uid; direction upstream = callers and dependants, downstream = what it uses; depth 1-5). " +
    "context: callers, callees and processes of a symbol. trace: how symbol `from` reaches symbol `to` (shortest call path). query: execution flows for a concept (query text). " +
    "cypher: a read-only Cypher query (MATCH ... RETURN; writes, CALL and LOAD are refused; rows capped). check: import cycles. status: index freshness. " +
    "Caveats: a missing result is not proof of no callers (callbacks passed as properties, cross-language fields and registry dispatch have no edges), so fall back to grep before calling code dead. " +
    "Ambiguous names return candidates: pass file (or kind) or the candidate's uid. Check the staleness field and the Index line every answer starts with: an index behind HEAD misses recent changes, and uncommitted edits are never indexed. " +
    "A folder without an index answers that it needs a manual index; never try to build one (this tool cannot), ask for it.",
  parameters: Type.Object({
    command: Type.Union(GITNEXUS_COMMANDS.map((s) => Type.Literal(s)), { description: "The GitNexus command." }),
    repo: Type.String({ description: "Repository folder (or a folder inside it), relative to your working directory or absolute. It must exist." }),
    target: str("impact, context: the symbol name, e.g. createStore."),
    uid: str("impact, context: an exact symbol uid from an earlier result, e.g. Function:src/a.ts:foo; overrides target."),
    file: str("impact, context: file path to pick among same-named symbols; trace: the from symbol's file."),
    kind: str("impact: node kind to pick among same-named symbols, e.g. Function, Class, Method."),
    direction: Type.Optional(Type.Union([Type.Literal("upstream"), Type.Literal("downstream")], { description: "impact: upstream (default) or downstream." })),
    depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 5, description: "impact: relationship depth (default 3); trace: max path length." })),
    include_tests: Type.Optional(Type.Boolean({ description: "impact, trace: include test files." })),
    from: str("trace: the starting symbol."),
    to: str("trace: the symbol to reach."),
    to_file: str("trace: the to symbol's file, to pick among same-named symbols."),
    query: str("query: the concept to search for; cypher: the read-only Cypher query."),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: CYPHER_MAX_ROWS, description: "query: processes (max 20); context, impact: symbols per level (max 100); cypher: rows (default 50, max 200)." })),
  }),
  replay: "safe",
  execute: async (params, api, ctx) => {
    const p = params as GitnexusParams;
    if (typeof p.repo !== "string" || !p.repo.trim() || p.repo.startsWith("-")) throw Error(`Invalid repo: ${JSON.stringify(p.repo)}`);
    const dir = await sessionPath(api, p.repo, ctx);
    return text(await runGitnexus(api, p, dir, ctx, p.repo));
  },
});

export const GITNEXUS_TOOLS = [gitnexus];
