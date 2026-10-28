// Read-only GitHub, adapted from Oh My Pi's github tool (MIT; see omp-tools.ts). Every op is one gh CLI call in the
// session's folder, so `repo` defaults to that checkout and gh's own login applies. Oh My Pi's writing ops
// (pr_create, pr_push, pr_checkout) are left out: they belong to bash, where read-only agents never get them.
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { clip, run, text } from "./omp-common.js";

export const GITHUB_OPS = [
  "repo_view",
  "file_read",
  "issue_view",
  "issue_list",
  "pr_view",
  "pr_diff",
  "pr_checks",
  "pr_list",
  "search_issues",
  "search_prs",
  "search_code",
  "search_commits",
  "search_repos",
  "run_list",
  "run_view",
] as const;

export type GithubArgs = {
  op: (typeof GITHUB_OPS)[number];
  repo?: string;
  number?: number;
  query?: string;
  path?: string;
  ref?: string;
  state?: "open" | "closed" | "merged" | "all";
  limit?: number;
  failed_logs?: boolean;
};

/** The gh command for one op. Throws when the op lacks what it needs. */
export function githubArgv(a: GithubArgs): string[] {
  const limit = String(Math.min(100, Math.max(1, Math.floor(a.limit ?? 20))));
  const repo = a.repo ? ["--repo", a.repo] : [];
  const need = <T>(value: T | undefined, what: string): T => {
    if (value === undefined || value === "") throw Error(`${a.op} needs ${what}`);
    return value;
  };
  const n = () => String(need(a.number, "number"));
  switch (a.op) {
    case "repo_view":
      return ["gh", "repo", "view", ...(a.repo ? [a.repo] : [])];
    case "file_read": {
      const path = need(a.path, "path").replace(/^\/+/, "");
      const target = a.repo ? `repos/${a.repo}` : "repos/{owner}/{repo}";
      return ["gh", "api", "-H", "Accept: application/vnd.github.raw", `${target}/contents/${path}${a.ref ? `?ref=${encodeURIComponent(a.ref)}` : ""}`];
    }
    case "issue_view":
      return ["gh", "issue", "view", n(), ...repo, "--comments"];
    case "pr_view":
      return ["gh", "pr", "view", n(), ...repo, "--comments"];
    case "pr_diff":
      return ["gh", "pr", "diff", n(), ...repo];
    case "pr_checks":
      return ["gh", "pr", "checks", n(), ...repo];
    case "issue_list":
    case "pr_list": {
      const state = a.state ?? "open";
      if (a.op === "issue_list" && state === "merged") throw Error("issue_list takes state open, closed or all");
      return ["gh", a.op === "issue_list" ? "issue" : "pr", "list", ...repo, "--limit", limit, "--state", state, ...(a.query ? ["--search", a.query] : [])];
    }
    case "search_issues":
    case "search_prs":
    case "search_commits":
    case "search_repos":
    case "search_code": {
      const kind = a.op.slice("search_".length);
      if (kind === "code") need(a.query, "query");
      const scope = a.repo && kind !== "repos" ? ["--repo", a.repo] : [];
      return ["gh", "search", kind, ...(a.query ? [a.query] : []), ...scope, "--limit", limit];
    }
    case "run_list":
      return ["gh", "run", "list", ...repo, "--limit", limit, ...(a.ref ? ["--branch", a.ref] : [])];
    case "run_view":
      return ["gh", "run", "view", n(), ...repo, ...(a.failed_logs ? ["--log-failed"] : [])];
  }
}

const github = defineTool({
  name: "github",
  description: `Read GitHub through the gh CLI and its login on this device. Read only: write changes with bash and git.
- repo is owner/repo; omit it for the session folder's own checkout.
- repo_view: description and README. file_read: path from repo at ref (default branch); use it for files on GitHub, never curl.
- issue_view / pr_view (with comments), pr_diff, pr_checks: need number. issue_list / pr_list: state (default open) and query filter.
- search_issues, search_prs, search_commits, search_repos, search_code: query with GitHub search syntax (repo:, org:, is:, label:, author:…); search_code needs query.
- run_list: recent Actions runs (ref filters by branch). run_view: one run by number (its id); failed_logs adds the failing steps' logs.`,
  parameters: Type.Object({
    op: Type.Union(GITHUB_OPS.map((o) => Type.Literal(o))),
    repo: Type.Optional(Type.String({ description: "owner/repo; default: the session folder's checkout" })),
    number: Type.Optional(Type.Number({ description: "Issue, pull request or run number" })),
    query: Type.Optional(Type.String({ description: "Search terms, or a filter for issue_list and pr_list" })),
    path: Type.Optional(Type.String({ description: "File path for file_read" })),
    ref: Type.Optional(Type.String({ description: "Branch, tag or commit for file_read; branch for run_list" })),
    state: Type.Optional(Type.Union(["open", "closed", "merged", "all"].map((s) => Type.Literal(s)))),
    limit: Type.Optional(Type.Number({ description: "Most items for lists and searches (default 20, max 100)" })),
    failed_logs: Type.Optional(Type.Boolean({ description: "run_view: include the failed steps' logs" })),
  }),
  replay: "safe",
  execute: async (args, api, ctx) => {
    const { code, out } = await run(api, githubArgv(args as GithubArgs), ctx, 60);
    if (code !== 0) throw Error(clip(out.trim(), 2000, "") || `gh exited ${code}`);
    return text(clip(out.trim() || "No results", undefined, "narrow the query or lower limit"));
  },
});

export const GITHUB_TOOLS = [github];
