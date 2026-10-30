// pip3r: read-only spot checks for reviewing delegated work, without bash (the oracle tool set keeps it). It runs the
// pip3r CLI (DPI_PIP3R_BIN, default `pip3r` on PATH) argv only, no shell, in a repository folder that must exist.
//
//   subcommands  PIP3R_SUBCOMMANDS (blast, doctor, verify, graphos, scout), the one list to change if names change;
//                graphos is used only as a code-graph lookup (symbols, refs, deps)
//   flags        an allowlist per subcommand, taken from `pip3r <sub> --help` (v1.2.6). pip3r also accepts camelCase
//                spellings (--huntSeedApply), so anything not on the list is refused rather than matched against a
//                denylist. The writing and provisioning flags are named in REFUSED so the refusal can say why.
//   read only    graphos and blast always get --no-auto-index (blast indexes a missing repo by default); --json is
//                always added; --cwd is the repo and cannot be overridden
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { run, sessionPath, text } from "./toolkit-common.js";

export const PIP3R_SUBCOMMANDS = ["blast", "doctor", "verify", "graphos", "scout"] as const;
export type Pip3rSub = (typeof PIP3R_SUBCOMMANDS)[number];

/** The most output one call hands back; more is cut with a note saying so. */
export const PIP3R_MAX_CHARS = 40_000;
const MAX_ARGS = 40;

/** Flags that write, index, provision or file issues, refused with a reason. */
const DOCTOR_REFUSED: Record<string, string> = {
  "--hunt-seed": "seeds Multica issues",
  "--hunt-seed-apply": "creates Multica issues",
  "--seed-profile": "Multica issue seeding",
  "--seed-workspace": "Multica issue seeding",
  "--hunt-seed-max": "Multica issue seeding",
  "--verify-refactor": "refactor scoring is not a spot check here",
};
export const REFUSED: Record<Pip3rSub, Record<string, string>> = {
  blast: { "--auto-index": "builds a code index" },
  graphos: {
    "--write": "allows write/DDL Cypher",
    "--clean": "unregisters the repo and deletes graph artifacts",
    "--force": "confirms a clean",
    "--all": "applies a clean to every registration",
    "--index": "builds a code index",
    "--index-path": "builds a code index",
    "--incremental": "updates a code index",
    "--embeddings": "generates embeddings into the index",
    "--write-context": "writes context files",
    "--export-flag": "exports graph data to files",
  },
  doctor: DOCTOR_REFUSED,
  verify: DOCTOR_REFUSED,
  scout: {},
};
const ALWAYS_REFUSED: Record<string, string> = {
  "--cwd": "the repo parameter sets the folder",
  "-c": "the repo parameter sets the folder",
  "--help": "not needed",
  "-h": "not needed",
};

// Flags each subcommand accepts (from --help), minus the refused ones. "=" marks a flag that takes a value.
const DOCTOR_FLAGS = [
  "--json", "--deep", "--meta", "--graph", "--no-graph", "--repo=", "--lbug-path=", "--has", "--no-has", "--format-check",
  "--no-format-check", "--typecheck", "--no-typecheck", "--lint", "--no-lint", "--test", "--no-test", "--continue-on-error",
  "--strict", "--logs=", "--hunt", "--no-hunt", "--hunt-baseline=", "--hunt-target=", "--scope=", "--no-hunt-seed",
  "--no-hunt-seed-apply", "--investigate", "--no-investigate",
];
export const ALLOWED: Record<Pip3rSub, string[]> = {
  blast: [
    "--no-auto-index", "--json", "--direction=", "--include-tests", "--path=", "-p=", "--repo=", "-r=", "--lbug-path=",
    "--max-depth=", "-d=", "--risk-only", "--max-matches=", "--min-confidence=", "--relation-types=",
  ],
  doctor: DOCTOR_FLAGS,
  verify: DOCTOR_FLAGS,
  graphos: [
    "--status", "--repos", "--cypher=", "--search=", "--from=", "--to=", "--drift", "--deps", "--refs=", "--tree",
    "--symbols=", "--file-path=", "--line=", "--hotspots", "--explain=", "--inspect=", "--path=", "--repo=", "-r=",
    "--lbug-path=", "--json", "--limit=", "-n=", "--content", "--depth=", "-d=", "--direction=", "--no-auto-index",
  ],
  scout: [
    "--grep=", "--grep-ast=", "--hybrid=", "--lang=", "--glob=", "--read=", "--git-info", "--json", "--ignore-case", "-i",
    "--max-results=", "-n=", "--include=", "-g=", "--exclude=", "--directory=", "--include-hidden", "--chunk-lines=",
    "--chunk-symbols=", "--chunk-size=", "--pkg-grep", "--pkg-read", "--pkg-name=", "-p=", "--pattern=",
    "--pkg-file-path=", "--multi-search", "--repos=",
  ],
};

/** The pip3r binary: DPI_PIP3R_BIN, read at each call, or `pip3r` on PATH. */
export const pip3rBin = () => process.env.DPI_PIP3R_BIN?.trim() || "pip3r";

const CHECKS = ["--has", "--format-check", "--typecheck", "--lint", "--test"];

/**
 * Seconds a call may take: 300 for doctor and verify when the repo's test script may run (--test, or no check flag,
 * which runs every check the repo has, unless --no-test), else 120.
 */
export function pip3rTimeout(sub: Pip3rSub, args: readonly string[]) {
  if (sub !== "doctor" && sub !== "verify") return 120;
  if (args.includes("--test")) return 300;
  if (args.includes("--no-test")) return 120;
  return args.some((a) => CHECKS.includes(a)) ? 120 : 300;
}

/**
 * The argv after the binary for one call: the subcommand, the checked arguments, then --json, --cwd <dir> and, for
 * graphos and blast, --no-auto-index. Throws on an unknown subcommand or any flag not on the allowlist. Exported for
 * tests.
 */
export function pip3rArgv(sub: string, args: readonly string[] = [], dir: string): string[] {
  if (!PIP3R_SUBCOMMANDS.includes(sub as Pip3rSub))
    throw Error(`pip3r ${JSON.stringify(sub)} is not allowed; use one of ${PIP3R_SUBCOMMANDS.join(", ")}`);
  const s = sub as Pip3rSub;
  if (!Array.isArray(args)) throw Error("args must be a list of strings");
  if (args.length > MAX_ARGS) throw Error(`At most ${MAX_ARGS} args`);
  const allowed = new Map(ALLOWED[s].map((f) => [f.replace(/=$/, ""), f.endsWith("=")]));
  const out: string[] = [s];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (typeof arg !== "string" || /[\0\n\r]/.test(arg) || arg.length > 1000) throw Error(`Invalid argument: ${JSON.stringify(arg)}`);
    if (arg === "--") throw Error("`--` is not allowed; pass values right after their flag");
    if (!arg.startsWith("-")) {
      out.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    const why = REFUSED[s][flag] ?? ALWAYS_REFUSED[flag];
    if (why) throw Error(`pip3r ${s} ${flag} is refused: ${why}. This tool only reads.`);
    if (!allowed.has(flag))
      throw Error(`pip3r ${s} ${flag} is not on this tool's list of read-only flags (spell flags in kebab-case as in pip3r ${s} --help)`);
    out.push(arg);
    // A value flag written as two tokens takes the next one. It may not start with "-", so every "-" token in `out` is a
    // flag whichever way pip3r parses, and the forced flags below cannot be swallowed or hidden as a value.
    if (allowed.get(flag) && eq < 0) {
      if (i + 1 >= args.length) throw Error(`pip3r ${s} ${flag} needs a value`);
      const value = args[++i];
      if (typeof value !== "string" || /[\0\n\r]/.test(value) || value.length > 1000) throw Error(`Invalid value for ${flag}`);
      if (value.startsWith("-")) throw Error(`pip3r ${s} ${flag} value may not start with "-"; write ${flag}=${value} to pass one`);
      out.push(value);
    }
  }
  if (!out.includes("--json")) out.push("--json");
  out.push("--cwd", dir);
  if ((s === "graphos" || s === "blast") && !out.includes("--no-auto-index")) out.push("--no-auto-index");
  return out;
}

/** Output cut at PIP3R_MAX_CHARS, saying so when it was cut. */
export function pip3rText(out: string, truncatedAtSource = false) {
  if (!out.trim()) return "(no output)";
  if (out.length <= PIP3R_MAX_CHARS && !truncatedAtSource) return out;
  return `${out.slice(0, PIP3R_MAX_CHARS)}\n\n[pip3r output truncated: showed ${Math.min(PIP3R_MAX_CHARS, out.length)} of ${out.length}${truncatedAtSource ? "+" : ""} characters; narrow it with --path, --max-matches, --limit or --risk-only]`;
}

const pip3r = defineTool({
  name: "pip3r",
  description:
    "Spot-check tools for reviewing delegated work, read only. blast: impact of changing a symbol before you approve a change (pass the symbol as an arg; --direction upstream|downstream, --max-depth, --risk-only). " +
    "doctor / verify: repository health checks (format, typecheck, lint, graph; --test runs the repo's tests and may take minutes). " +
    "graphos: a code-graph lookup for spot checks on an existing index: symbols, refs and deps (--search, --symbols, --refs, --inspect, --deps). scout: grep, AST search and file reads. " +
    "Use git diff to see what changed and this to judge it. Caveats: blast can miss call edges on some repos, so zero callers means unknown, not safe. doctor never proves code is dead. " +
    "doctor --hunt needs --hunt-target outside a pip3r checkout, and --scope takes CLI command paths, not file paths. " +
    "Never indexes or writes: flags that index, write, clean, export or file issues are refused; --json is always added.",
  parameters: Type.Object({
    command: Type.Union(PIP3R_SUBCOMMANDS.map((s) => Type.Literal(s)), { description: "The pip3r subcommand." }),
    repo: Type.String({ description: "Repository folder, relative to your working directory or absolute. It must exist." }),
    args: Type.Optional(
      Type.Array(Type.String(), {
        description: 'Extra arguments in kebab-case as in pip3r <command> --help, e.g. ["createStore", "--max-depth", "2"] for blast or ["--search", "auth"] for graphos.',
      }),
    ),
  }),
  replay: "safe",
  execute: async (params, api, ctx) => {
    const p = params as { command: string; repo: string; args?: string[] };
    if (typeof p.repo !== "string" || !p.repo.trim() || p.repo.startsWith("-")) throw Error(`Invalid repo: ${JSON.stringify(p.repo)}`);
    const dir = await sessionPath(api, p.repo, ctx);
    const argv = pip3rArgv(p.command, p.args ?? [], dir);
    const { code, out, truncated } = await run(api, [pip3rBin(), ...argv], ctx, pip3rTimeout(p.command as Pip3rSub, argv), dir);
    const body = pip3rText(out.trimEnd(), truncated);
    return text(code === 0 ? body : `pip3r ${p.command} exited with code ${code}\n\n${body}`);
  },
});

export const PIP3R_TOOLS = [pip3r];
