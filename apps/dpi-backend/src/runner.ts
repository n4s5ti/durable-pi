// The runner: every delegation (subagent, start_session, a trigger todo) goes through here. Bags chooses what the work
// is and in what order; the runner chooses where it runs, by this device's policy and not by a tool argument:
//
//   local   a child conversation or a new session on this device
//   cloud   a Claude Code cloud session started through the claude CLI from a clean, pushed checkout
//
// DPI_RUNNER_CODE (cloud | local, default cloud) is the policy for code-changing work, which the runner reads off the
// folder: a git checkout is code work, anything else runs local. DPI_CLAUDE_BIN names the claude CLI (default claude).
// A checkout the cloud cannot clone (uncommitted changes, an unpushed branch) runs local and the record says why.
//
// This file holds no durable state; delegations.ts records what the runner started.
import { execFile } from "node:child_process";
import { resolveModelAlias } from "./model-catalog.js";

export type Backend = "local" | "cloud";

/** The model subagent, start_session and trigger todos use when the call names none: DPI_SUBAGENT_MODEL, read at each
 * call, or the newest Haiku. */
export const DEFAULT_SUBAGENT_MODEL = "claude-haiku-latest";
export const subagentModelId = () => process.env.DPI_SUBAGENT_MODEL?.trim() || DEFAULT_SUBAGENT_MODEL;

export const DEFAULT_CLAUDE_BIN = "claude";
/** The cloud session's reasoning effort, for every cloud dispatch. */
export const CLOUD_EFFORT = "high";

/** Every instruction the runner sends for code changes carries this (the owner's blast rule). */
export const BLAST_RULE = [
  "Blast rule for every code change:",
  "- Before editing any function, class, exported constant or route, run `npx -y gitnexus@1.6.12 impact <symbol> --direction upstream` and `npx -y gitnexus@1.6.12 context <symbol>`, and pair them with `git grep -w <symbol>` (a missing result is not proof of no callers).",
  "- If the affected surface is more than five files, stop and report it instead of editing.",
  "- After editing, re-run the same impact check and confirm every caller.",
  "- Report each symbol you changed with its callers before and after.",
].join("\n");

/** Sent to a cloud session that has to stop: the claude CLI has no stop verb, so the session is told to end. */
export const STOP_MESSAGE = "Stop now. Do not make further changes or start new work; reply with one line saying where you stopped.";

export type ExecResult = { code: number; out: string };
export type Exec = (file: string, args: string[], options?: { cwd?: string; timeout?: number }) => Promise<ExecResult>;

/** Run a file without a shell and never throw: a missing binary or a signal is a non-zero code with the reason in `out`. */
export const defaultExec: Exec = (file, args, options) =>
  new Promise((resolve) => {
    execFile(file, args, { cwd: options?.cwd, timeout: options?.timeout ?? 120_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      const out = `${stdout}${stderr}`;
      if (!error) return resolve({ code: 0, out });
      const code = (error as NodeJS.ErrnoException).code;
      resolve({ code: typeof code === "number" ? code : code === "ENOENT" ? 127 : 1, out: out || error.message });
    });
  });

/** POSIX single-quote a word for a shell command line. */
export const shellQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string) => s.replace(/\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007|\r/g, "");
const tail = (s: string) => clip(stripAnsi(s).trim().split("\n").slice(-6).join("\n"), 600);

export class RunnerError extends Error {}

export type RunnerConfig = { code: Backend; claudeBin: string };

export function runnerConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  const code = (env.DPI_RUNNER_CODE?.trim() || "cloud").toLowerCase();
  if (code !== "cloud" && code !== "local") throw new RunnerError(`DPI_RUNNER_CODE must be cloud or local, not ${env.DPI_RUNNER_CODE}`);
  return { code, claudeBin: env.DPI_CLAUDE_BIN?.trim() || DEFAULT_CLAUDE_BIN };
}

/** The claude CLI line that starts a cloud session: `script` gives the CLI the terminal it insists on. */
export function cloudCommand(config: RunnerConfig, model: string, instruction: string) {
  const inner = [config.claudeBin, "--model", model, "--effort", CLOUD_EFFORT, "--cloud", instruction].map(shellQuote).join(" ");
  return { file: "script", args: ["-qec", inner, "/dev/null"], inner };
}

export const SESSION_ID = /\bsession_[A-Za-z0-9]+\b/;
export const sessionUrl = (sessionId: string) => `https://claude.ai/code/${sessionId}`;

/** The instruction as sent: Bags's text, plus the blast rule when it changes code. */
export const withBlastRule = (instruction: string, code: boolean) => (code ? `${instruction.trimEnd()}\n\n${BLAST_RULE}` : instruction);

// ------------------------------------------------------------------ models

const FAMILIES = ["haiku", "sonnet", "opus"] as const;
const familyOf = (modelId: string) => FAMILIES.find((f) => modelId.includes(`-${f}-`) || modelId.endsWith(`-${f}`));

/** The next stronger model alias (haiku → sonnet → opus), or undefined at the top or for a model outside the ladder. */
export function strongerModel(modelId: string): string | undefined {
  const resolved = resolveModelAlias(modelId);
  const family = familyOf(modelId) ?? familyOf(resolved);
  const next = family && FAMILIES[FAMILIES.indexOf(family) + 1];
  return next ? `claude-${next}-latest` : undefined;
}

/** The instruction for a rerun on a stronger model: the same task, with the failure or partial result carried in. */
export function escalationInstruction(instruction: string, from: { model: string; status: string; result?: string; reason?: string }) {
  const carried = from.status === "done" ? `finished with: ${from.result ?? "no result"}` : from.reason ? `${from.status}: ${from.reason}` : from.result ? `${from.status}, partial result: ${from.result}` : from.status;
  return `${instruction.trimEnd()}\n\nA previous attempt on ${from.model} ${carried}\nContinue from that rather than starting over, and fix what went wrong.`;
}

// ------------------------------------------------------------------ the runner

export type Placement = { backend: Backend; code: boolean; reason?: string };

export function createRunner(options: { env?: NodeJS.ProcessEnv; exec?: Exec } = {}) {
  const env = () => options.env ?? process.env;
  const exec = options.exec ?? defaultExec;
  const config = () => runnerConfig(env());
  const git = async (cwd: string, ...args: string[]) => exec("git", ["-C", cwd, ...args], { timeout: 20_000 });

  /** Where work in `cwd` runs. A git checkout is code work; the cloud takes it only from a clean, pushed branch. */
  async function place(cwd: string): Promise<Placement> {
    const policy = config().code;
    const inside = await git(cwd, "rev-parse", "--is-inside-work-tree");
    if (inside.code !== 0 || inside.out.trim() !== "true") return { backend: "local", code: false };
    if (policy === "local") return { backend: "local", code: true };
    const local = (reason: string): Placement => ({ backend: "local", code: true, reason: `cloud needs a clean pushed checkout: ${reason}` });
    const dirty = await git(cwd, "status", "--porcelain");
    if (dirty.code !== 0) return local("git status failed");
    if (dirty.out.trim()) return local("the checkout has uncommitted changes");
    const upstream = await git(cwd, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}");
    if (upstream.code !== 0) return local("the branch has no upstream");
    const ahead = await git(cwd, "rev-list", "--count", "@{u}..HEAD");
    if (ahead.code !== 0) return local("git rev-list failed");
    if (Number(ahead.out.trim()) > 0) return local(`${ahead.out.trim()} commits are not pushed`);
    return { backend: "cloud", code: true };
  }

  /** Start a cloud session for `instruction` from the checkout in `cwd`. Throws a RunnerError that says what failed. */
  async function dispatchCloud(input: { model: string; instruction: string; cwd: string }) {
    const cfg = config();
    const { file, args } = cloudCommand(cfg, input.model, input.instruction);
    const result = await exec(file, args, { cwd: input.cwd, timeout: 180_000 });
    if (result.code !== 0) throw new RunnerError(`claude --cloud failed (exit ${result.code}): ${tail(result.out) || "no output"}`);
    const sessionId = stripAnsi(result.out).match(SESSION_ID)?.[0];
    if (!sessionId) throw new RunnerError(`claude --cloud printed no session id: ${tail(result.out) || "no output"}`);
    return { sessionId, url: sessionUrl(sessionId) };
  }

  /** Inject guidance into a running cloud session. */
  async function steerCloud(sessionId: string, message: string) {
    const result = await exec(config().claudeBin, ["-p", message, "--cloud", sessionId], { timeout: 180_000 });
    if (result.code !== 0) throw new RunnerError(`claude -p --cloud ${sessionId} failed (exit ${result.code}): ${tail(result.out) || "no output"}`);
  }

  return { config, place, dispatchCloud, steerCloud, stopCloud: (sessionId: string) => steerCloud(sessionId, STOP_MESSAGE) };
}

export type Runner = ReturnType<typeof createRunner>;
