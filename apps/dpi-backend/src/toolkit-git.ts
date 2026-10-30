// git: read-only repository state for agents without bash (the oracle tool set). One op per call, argv only, no
// shell. Every command reads: `--no-optional-locks` keeps `git status` from refreshing the index, and refs and paths
// that look like options are refused so no argument can turn into a flag; core.fsmonitor is off so a repo's config
// cannot run a hook. `diff` prints patch text without external diff drivers or textconv filters, so no repo config can
// run a program while it reads.
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { clip, run, sessionPath, text } from "./toolkit-common.js";

const OPS = ["status", "log", "branches", "ahead_behind", "diff_stat", "diff", "show", "worktrees", "remotes"] as const;

/** The most patch text `diff` hands back; more is cut with a note saying so. */
export const DIFF_MAX_CHARS = 40_000;
type Op = (typeof OPS)[number];

/** A ref or range the model may name: branch, tag, sha, `a..b`, `@{upstream}`, `HEAD~3`. Never an option. */
export function safeRef(ref: string) {
  if (!ref || ref.startsWith("-") || !/^[\w./@{}^~:+-]+$/.test(ref) || ref.length > 200)
    throw Error(`Invalid ref: ${JSON.stringify(ref)}`);
  return ref;
}

/** A path filter for diff: relative to the repo, never an option, no NUL or newline. Passed after `--`. */
export function safePath(path: string) {
  if (!path || path.startsWith("-") || /[\0\n\r]/.test(path) || path.length > 500) throw Error(`Invalid path: ${JSON.stringify(path)}`);
  return path;
}

/** The read-only git argv for one op. Exported for tests. */
export function gitArgv(op: Op, args: { ref?: string; count?: number; staged?: boolean; path?: string }): string[][] {
  const count = String(Math.min(50, Math.max(1, Math.floor(args.count ?? 10))));
  const ref = args.ref === undefined ? undefined : safeRef(args.ref);
  const path = args.path === undefined || args.path === "" ? undefined : safePath(args.path);
  switch (op) {
    case "status":
      return [
        ["status", "--short", "--branch", "--untracked-files=normal"],
        ["diff", "--cached", "--shortstat"],
        ["diff", "--shortstat"],
        ["stash", "list", "--format=%gd %cs %s"],
      ];
    case "log":
      return [["log", `--max-count=${count}`, "--date=short", "--format=%h %ad %an %s%d", ...(ref ? [ref] : [])]];
    case "branches":
      return [["branch", "--all", "--sort=-committerdate", "--format=%(refname:short) %(committerdate:short) %(upstream:short) %(upstream:track) %(subject)"]];
    case "ahead_behind":
      return [["rev-list", "--left-right", "--count", `HEAD...${ref ?? "@{upstream}"}`]];
    case "diff_stat":
      return [["diff", "--stat", ...(args.staged ? ["--cached"] : []), ...(ref ? [ref] : []), ...(path ? ["--", path] : [])]];
    case "diff":
      return [
        [
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--no-color",
          ...(args.staged ? ["--cached"] : []),
          ...(ref ? [ref] : []),
          "--",
          ...(path ? [path] : []),
        ],
      ];
    case "show":
      return [["show", "--stat", "--date=short", "--format=%h %ad %an%n%s%n%b", ref ?? "HEAD"]];
    case "worktrees":
      return [["worktree", "list"]];
    case "remotes":
      return [["remote", "--verbose"]];
  }
}

const git = defineTool({
  name: "git",
  description:
    `Read a git repository without changing it: status (branch, ahead/behind, changed files, staged and unstaged size, stashes), log, branches (newest first, with upstream tracking), ahead_behind (HEAD against a ref, default its upstream), diff_stat, diff (the patch text: unstaged changes by default, staged with staged: true, or a ref or range such as main..feature; narrow it with path; cut at ${DIFF_MAX_CHARS / 1000} KB with a note), show (one commit with its files), worktrees, remotes. Use diff to see what a delegated agent actually changed before you approve it. It cannot commit, fetch, check out or change anything. Remote state is as of the last fetch; use github for live PRs and CI.`,
  parameters: Type.Object({
    op: Type.Union(OPS.map((o) => Type.Literal(o))),
    repo: Type.Optional(Type.String({ description: "Repository folder, relative to your working directory. Default \".\"." })),
    ref: Type.Optional(Type.String({ description: "Ref or range for log, ahead_behind, diff_stat, diff and show, e.g. origin/main, main..feature, HEAD~3." })),
    count: Type.Optional(Type.Number({ description: "Commits for log (default 10, max 50)." })),
    staged: Type.Optional(Type.Boolean({ description: "diff_stat and diff: the staged changes instead of the unstaged ones." })),
    path: Type.Optional(Type.String({ description: "diff and diff_stat: only this file or folder, relative to the repository." })),
  }),
  replay: "safe",
  execute: async (args, api, ctx) => {
    const repo = args.repo ?? ".";
    if (repo.startsWith("-")) throw Error(`Invalid repo: ${JSON.stringify(repo)}`);
    const dir = await sessionPath(api, repo, ctx);
    const parts: string[] = [];
    for (const argv of gitArgv(args.op as Op, args)) {
      const { code, out } = await run(api, ["git", "--no-optional-locks", "--no-pager", "-c", "core.fsmonitor=false", "-C", dir, ...argv], ctx);
      if (code !== 0) {
        if (args.op === "status" && argv[0] === "stash") continue;
        throw Error(out.trim() || `git ${argv[0]} failed with exit code ${code}`);
      }
      if (out.trim()) parts.push(args.op === "ahead_behind" ? aheadBehind(out) : out.trimEnd());
    }
    if (args.op === "diff") return text(diffText(parts.join("\n")));
    return text(clip(parts.join("\n") || "Nothing to report", 20_000, "narrow with count or ref"));
  },
});

/** Patch text cut at DIFF_MAX_CHARS, saying so when it was cut. Exported for tests. */
export function diffText(out: string) {
  if (!out.trim()) return "No differences";
  if (out.length <= DIFF_MAX_CHARS) return out;
  return `${out.slice(0, DIFF_MAX_CHARS)}\n\n[diff truncated: showed ${DIFF_MAX_CHARS} of ${out.length}${out.length >= 400_000 ? "+" : ""} characters; narrow it with path or a smaller range, or use diff_stat for the file list]`;
}

const aheadBehind = (out: string) => {
  const [ahead, behind] = out.trim().split(/\s+/);
  return `ahead ${ahead}, behind ${behind}`;
};

export const GIT_TOOLS = [git];
