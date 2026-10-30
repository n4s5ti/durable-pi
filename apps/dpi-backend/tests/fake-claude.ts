// A stand-in for the claude CLI (DPI_CLAUDE_BIN) and a git checkout the cloud runner accepts, for the runner tests.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const SCRIPT = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(args) + "\\n");
const calls = fs.readFileSync(process.env.FAKE_CLAUDE_LOG, "utf8").trim().split("\\n").length;
const mode = process.env.FAKE_CLAUDE_MODE || "ok";
if (mode === "fail") {
  console.error("not logged in: run claude login");
  process.exit(3);
}
if (args[0] === "-p") process.exit(0);
if (mode === "nosession") {
  console.log("Started something, but no id");
  process.exit(0);
}
const say = () => console.log("\\x1b[32mSession created: session_01FAKE" + String(calls).padStart(4, "0") + "\\x1b[0m");
if (mode === "slow") setTimeout(say, 3000);
else say();
`;

/** A fake claude CLI in `dir`: it logs each call's argv as JSON and prints a session id. FAKE_CLAUDE_MODE: ok | fail | nosession | slow. */
export function fakeClaude(dir: string) {
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, "claude");
  const logFile = join(dir, "calls.jsonl");
  writeFileSync(bin, SCRIPT);
  chmodSync(bin, 0o755);
  writeFileSync(logFile, "");
  const keys = ["DPI_CLAUDE_BIN", "FAKE_CLAUDE_LOG", "FAKE_CLAUDE_MODE", "DPI_RUNNER_CODE", "DPI_SUBAGENT_MODEL"] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env.DPI_CLAUDE_BIN = bin;
  process.env.FAKE_CLAUDE_LOG = logFile;
  delete process.env.FAKE_CLAUDE_MODE;
  delete process.env.DPI_RUNNER_CODE;
  delete process.env.DPI_SUBAGENT_MODEL;
  return {
    bin,
    calls: () => (existsSync(logFile) ? readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]) : []),
    mode: (m: string | undefined) => (m === undefined ? delete process.env.FAKE_CLAUDE_MODE : (process.env.FAKE_CLAUDE_MODE = m)),
    restore: () => {
      for (const k of keys) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
    },
  };
}

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.email=t@example.com", "-c", "user.name=T", ...args], { encoding: "utf8", stdio: "pipe" });

/** A checkout with an upstream and nothing to push: the cloud runner takes work in it. */
export function pushedCheckout(root: string, name = "repo") {
  const origin = join(root, `${name}-origin.git`);
  const repo = join(root, name);
  execFileSync("git", ["init", "-q", "--bare", origin], { stdio: "pipe" });
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "first");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-q", "-u", "origin", "main");
  return { repo, git: (...args: string[]) => git(repo, ...args) };
}
