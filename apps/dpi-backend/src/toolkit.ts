// The toolkit add-on: search, a task list, documents, the web and GitHub for Durable Pi agents. The search tools shell
// out to rg and ast-grep through the call's execution environment, so they search the session's folder on its device.
//
// License notice: parts of these tools (descriptions, the todo rules, path lists, the DuckDuckGo parser, the GitHub
// ops) are adapted from Oh My Pi, https://github.com/can1357/oh-my-pi, under the MIT License:
//   Copyright (c) 2025 Mario Zechner; Copyright (c) 2025-2026 Can Bölük; Copyright (c) 2026 Stencil Labs, Inc.
//   Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
//   documentation files (the "Software"), to deal in the Software without restriction, including without limitation
//   the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and
//   to permit persons to whom the Software is furnished to do so, subject to the following conditions: The above
//   copyright notice and this permission notice shall be included in all copies or substantial portions of the
//   Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
//   LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT
//   SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
//   OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
//   DEALINGS IN THE SOFTWARE.
//
//   think     a scratchpad: the model writes its reasoning down, nothing runs
//   grep      text and regex search (ripgrep)
//   glob      files by glob, newest first (ripgrep)
//   ast_grep  structural code search (ast-grep)
//   todo      a phased task list, one durable document per conversation
//
// and, in their own files:
//
//   read_sqlite, read_archive, read_document   toolkit-read.ts: files beyond plain text
//   web_search, fetch_url                      toolkit-web.ts: search providers and pages as Markdown
//   github                                     toolkit-github.ts: read-only GitHub through the gh CLI
//   git                                        toolkit-git.ts: read-only local repository state
//   pip3r                                      toolkit-pip3r.ts: read-only spot checks through the pip3r CLI
//   gitnexus                                   toolkit-gitnexus.ts: read-only code-graph lookups through GitNexus
import { Type } from "@earendil-works/pi-ai";
import { defineDoc, defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { run, text } from "./toolkit-common.js";
import { GIT_TOOLS } from "./toolkit-git.js";
import { GITHUB_TOOLS } from "./toolkit-github.js";
import { GITNEXUS_TOOLS } from "./toolkit-gitnexus.js";
import { PIP3R_TOOLS } from "./toolkit-pip3r.js";
import { READ_TOOLS } from "./toolkit-read.js";
import { WEB_TOOLS } from "./toolkit-web.js";

const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/**
 * A `path` list: `;`-separated paths and globs, `!glob` excludes. Bare globs match at any depth. No paths
 * means the session's folder, left implicit so results read `src/a.ts` rather than `./src/a.ts`.
 */
export function splitPaths(path: string | undefined) {
  const entries = (path ?? "").split(";").map((p) => p.trim()).filter(Boolean);
  const globs = entries.filter((e) => e.startsWith("!") || /[*?[{]/.test(e));
  const paths = entries.filter((e) => !globs.includes(e));
  return { paths, globs };
}

const PATH_DESCRIPTION =
  'Files, folders or globs separated by ";" (default "."). A bare glob like *.ts matches at any depth; dir/*.ts only that folder\'s direct children; !glob excludes, e.g. "src;!**/*.test.ts".';

// ------------------------------------------------------------------ think

const think = defineTool({
  name: "think",
  description:
    "Think out loud without acting: plan the next steps, check an assumption, or weigh tool results. Nothing runs and nothing changes. Prefer it over a bash echo.",
  parameters: Type.Object({ thought: Type.String({ description: "Your reasoning" }) }),
  replay: "safe",
  execute: async () => text("Noted."),
});

// ------------------------------------------------------------------ grep

const GREP_FILES = 50;
const GREP_LINES = 400;

const grep = defineTool({
  name: "grep",
  description:
    "Search file contents with a regex (ripgrep syntax). Case-sensitive and .gitignore-aware by default. A literal \\n in the pattern searches across lines. Results are grouped by file with line numbers; page with skip. Prefer it over grep or rg in bash.",
  parameters: Type.Object({
    pattern: Type.String({ description: "Regex to search for" }),
    path: Type.Optional(Type.String({ description: PATH_DESCRIPTION })),
    ignore_case: Type.Optional(Type.Boolean({ description: "Match case-insensitively" })),
    gitignore: Type.Optional(Type.Boolean({ description: "Respect .gitignore and skip hidden files (default true)" })),
    context: Type.Optional(Type.Number({ description: "Lines of context around each match (default 0, max 10)" })),
    skip: Type.Optional(Type.Number({ description: "Matching files to skip, for the next page" })),
  }),
  replay: "safe",
  execute: async (args, api, ctx) => {
    const { paths, globs } = splitPaths(args.path);
    const argv = ["rg", "--line-number", "--with-filename", "--no-heading", "--null", "--color=never", "--sort=path"];
    argv.push("--max-columns=300", "--max-columns-preview");
    if (args.ignore_case) argv.push("--ignore-case");
    if (args.gitignore === false) argv.push("--no-ignore", "--hidden", "--glob=!.git");
    if (args.pattern.includes("\\n")) argv.push("--multiline");
    const context = Math.min(10, Math.max(0, Math.floor(args.context ?? 0)));
    if (context) argv.push(`--context=${context}`);
    for (const glob of globs) argv.push(`--glob=${glob}`);
    argv.push("--regexp", args.pattern, "--", ...paths);
    const { code, out, truncated } = await run(api, argv, ctx);
    const files = new Map<string, string[]>();
    const errors: string[] = [];
    let last: string[] | undefined;
    for (const line of out.split("\n")) {
      const at = line.indexOf("\0");
      if (at < 0) {
        if (line === "--" && last) last.push("  …");
        else if (line.trim()) errors.push(line);
        continue;
      }
      const file = line.slice(0, at);
      last = files.get(file) ?? [];
      files.set(file, last);
      last.push(`  ${line.slice(at + 1)}`);
    }
    if (code === 2 && !files.size) throw Error(errors.join("\n") || "rg failed");
    if (!files.size) return text("No matches found");
    const skip = Math.max(0, Math.floor(args.skip ?? 0));
    const names = [...files.keys()];
    const page = names.slice(skip, skip + GREP_FILES);
    const lines: string[] = [];
    let shown = 0;
    for (const name of page) {
      if (lines.length >= GREP_LINES) break;
      lines.push(name, ...files.get(name)!.slice(0, GREP_LINES - lines.length));
      shown++;
    }
    const rest = names.length - skip - shown;
    if (rest > 0) lines.push(`\n${rest} more matching ${rest === 1 ? "file" : "files"}; call again with skip: ${skip + shown}`);
    if (truncated) lines.push("Output was cut short; narrow the path or pattern.");
    if (errors.length) lines.push(...errors.slice(0, 5));
    return text(lines.join("\n"));
  },
});

// ------------------------------------------------------------------ glob

const glob = defineTool({
  name: "glob",
  description:
    "List files matching a glob, newest first. A bare glob like *.md matches at any depth; use dir/** to stay under a folder. .gitignore is respected and hidden files are included by default (.git never). Prefer it over find or ls -R in bash.",
  parameters: Type.Object({
    pattern: Type.String({ description: 'Glob, e.g. "*.ts", "src/**/*.test.ts", "{README,CHANGELOG}.md"' }),
    path: Type.Optional(Type.String({ description: 'Folders to search, separated by ";" (default ".")' })),
    hidden: Type.Optional(Type.Boolean({ description: "Include hidden files (default true)" })),
    gitignore: Type.Optional(Type.Boolean({ description: "Respect .gitignore (default true)" })),
    limit: Type.Optional(Type.Number({ description: "Most files to list (default 200, max 1000)" })),
  }),
  replay: "safe",
  execute: async (args, api, ctx) => {
    const { paths } = splitPaths(args.path);
    const argv = ["rg", "--files", "--color=never", "--sortr=modified", "--glob=!.git"];
    if (args.hidden !== false) argv.push("--hidden");
    if (args.gitignore === false) argv.push("--no-ignore");
    argv.push(`--glob=${args.pattern}`, "--", ...paths);
    const { code, out } = await run(api, argv, ctx);
    const found = out.split("\n").filter((l) => l && !l.startsWith("rg: "));
    if (code === 2 && !found.length) throw Error(out.trim() || "rg failed");
    if (!found.length) return text("No files found");
    const limit = Math.min(1000, Math.max(1, Math.floor(args.limit ?? 200)));
    const rest = found.length - limit;
    return text(found.slice(0, limit).join("\n") + (rest > 0 ? `\n\n${rest} more; narrow the pattern or raise limit` : ""));
  },
});

// ------------------------------------------------------------------ ast_grep

const AST_MATCHES = 50;

type AstMatch = { file: string; lines: string; range: { start: { line: number }; end: { line: number } } };

const astGrep = defineTool({
  name: "ast_grep",
  description: `Structural code search with ast-grep: use it when syntax shape matters more than text (calls, declarations, language constructs).
- One language and one pattern per call. Set lang when the extension is ambiguous (cpp for .h).
- $NAME captures one node, $_ matches one without binding, $$$NAME zero or more, $$$ zero or more unbound. Names are UPPERCASE and whole nodes: prefix$VAR fails, $$NAME is invalid.
- The same metavariable twice must match identical code: $A == $A matches x == x, not x == y.
- A pattern must parse as one AST node; wrap fragments: class $_ { … }. C++ statement calls need a trailing ;.
- TS: allow annotations, e.g. async function $NAME($$$ARGS): $_ { $$$BODY }. function foo, method foo() and const foo = () => {} are different forms.
- Narrow path first; avoid scanning a whole repository. A parse error means the query failed, not that nothing matches.`,
  parameters: Type.Object({
    pat: Type.String({ description: "ast-grep pattern" }),
    path: Type.Optional(Type.String({ description: PATH_DESCRIPTION })),
    lang: Type.Optional(Type.String({ description: "Language, e.g. ts, tsx, py, rust, go, cpp" })),
    skip: Type.Optional(Type.Number({ description: "Matches to skip, for the next page" })),
  }),
  replay: "safe",
  execute: async (args, api, ctx) => {
    const { paths, globs } = splitPaths(args.path);
    const argv = ["ast-grep", "run", "--pattern", args.pat, "--json=stream"];
    if (args.lang) argv.push("--lang", args.lang);
    for (const g of globs) argv.push("--globs", g);
    argv.push("--", ...paths);
    const { out } = await run(api, argv, ctx);
    const matches: AstMatch[] = [];
    const problems: string[] = [];
    for (const line of out.split("\n")) {
      if (!line.trim()) continue;
      try {
        matches.push(JSON.parse(line) as AstMatch);
      } catch {
        problems.push(line);
      }
    }
    if (!matches.length) {
      if (problems.length) throw Error(problems.slice(0, 10).join("\n"));
      return text("No matches found");
    }
    matches.sort((a, b) => a.file.localeCompare(b.file) || a.range.start.line - b.range.start.line);
    const skip = Math.max(0, Math.floor(args.skip ?? 0));
    const page = matches.slice(skip, skip + AST_MATCHES).map((m) => {
      const first = m.lines.split("\n")[0].trim().slice(0, 200);
      const more = m.range.end.line - m.range.start.line;
      return `${m.file}:${m.range.start.line + 1}: ${first}${more ? `  (+${more} lines)` : ""}`;
    });
    const rest = matches.length - skip - page.length;
    if (rest > 0) page.push(`\n${rest} more; call again with skip: ${skip + page.length}`);
    if (problems.length) page.push(...problems.slice(0, 5));
    return text(page.join("\n"));
  },
});

// ------------------------------------------------------------------ todo

export type TodoStatus = "pending" | "active" | "done" | "blocked" | "dropped";
export type TodoTask = { content: string; status: TodoStatus; reason?: string };
export type TodoPhase = { name: string; tasks: TodoTask[] };
export type TodoArgs = {
  op: "init" | "start" | "done" | "rm" | "drop" | "block" | "unblock" | "append" | "view";
  list?: { phase: string; items: string[] }[];
  items?: string[];
  task?: string;
  phase?: string;
  reason?: string;
};

export const TodoList = defineDoc<{ phases: TodoPhase[] }>({
  kind: "toolkit.todo",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => ({ phases: [] }),
  checkpointWhen: () => false,
});
/** One per todo call, so a rerun after a crash returns the first result instead of applying the change twice. */
const TodoReceipt = defineDoc<{ applied: boolean; result: string }>({
  kind: "toolkit.todo-receipt",
  version: 1,
  scope: "task",
  initial: () => ({ applied: false, result: "" }),
  checkpointWhen: () => false,
});

const MARK: Record<TodoStatus, string> = { pending: "[ ]", active: "[>]", done: "[x]", blocked: "[!]", dropped: "[-]" };

export function renderTodo(phases: TodoPhase[]) {
  if (!phases.length) return "No tasks.";
  const all = phases.flatMap((p) => p.tasks).filter((t) => t.status !== "dropped");
  const lines = phases.flatMap((p) => [
    p.name,
    ...p.tasks.map((t) => `  ${MARK[t.status]} ${t.content}${t.status === "blocked" && t.reason ? ` (blocked: ${t.reason})` : ""}`),
  ]);
  return [...lines, `${all.filter((t) => t.status === "done").length}/${all.length} done`].join("\n");
}

/** The rules after a change: with nothing active the earliest pending task starts; only one stays active. */
function settle(phases: TodoPhase[], started?: TodoTask) {
  const tasks = phases.flatMap((p) => p.tasks);
  const active = tasks.filter((t) => t.status === "active");
  const keep = started ?? active[0];
  for (const t of active) if (t !== keep) t.status = "pending";
  if (!keep) {
    const next = tasks.find((t) => t.status === "pending");
    if (next) next.status = "active";
  }
  return phases;
}

/** Apply one todo call to a copy of the phases. Throws on an unknown task or phase, or duplicate names. */
export function applyTodo(current: TodoPhase[], args: TodoArgs): TodoPhase[] {
  const phases = plain(current);
  const find = (content: string | undefined) => {
    if (!content) throw Error(`${args.op} needs task: the task's exact text`);
    const hit = phases.flatMap((p) => p.tasks).find((t) => t.content === content);
    if (!hit) throw Error(`No task "${content}". Use the exact text from the list:\n${renderTodo(phases)}`);
    return hit;
  };
  const phaseOf = (name: string) => {
    const hit = phases.find((p) => p.name === name);
    if (!hit) throw Error(`No phase "${name}". Phases: ${phases.map((p) => p.name).join(", ") || "none"}`);
    return hit;
  };
  const unique = (contents: string[]) => {
    const seen = new Set(phases.flatMap((p) => p.tasks.map((t) => t.content)));
    for (const c of contents) {
      if (seen.has(c)) throw Error(`Duplicate task "${c}"`);
      seen.add(c);
    }
  };
  switch (args.op) {
    case "view":
      return phases;
    case "init": {
      const list = args.list?.length ? args.list : args.items?.length ? [{ phase: args.phase ?? "Tasks", items: args.items }] : [];
      if (!list.length) throw Error("init needs list: [{phase, items}] or items");
      if (new Set(list.map((l) => l.phase)).size !== list.length) throw Error("Phase names must be unique");
      // init replaces the list, so only the new tasks need unique names.
      phases.length = 0;
      unique(list.flatMap((l) => l.items));
      for (const entry of list) phases.push({ name: entry.phase, tasks: entry.items.map((content) => ({ content, status: "pending" as const })) });
      return settle(phases);
    }
    case "append": {
      if (!args.items?.length) throw Error("append needs items");
      unique(args.items);
      const name = args.phase ?? phases.at(-1)?.name ?? "Tasks";
      let phase = phases.find((p) => p.name === name);
      if (!phase) phases.push((phase = { name, tasks: [] }));
      phase.tasks.push(...args.items.map((content) => ({ content, status: "pending" as const })));
      return settle(phases);
    }
    case "start": {
      const t = find(args.task);
      if (t.status === "done") throw Error(`"${t.content}" is already done`);
      t.status = "active";
      delete t.reason;
      return settle(phases, t);
    }
    case "done": {
      if (!args.task && args.phase) for (const t of phaseOf(args.phase).tasks) t.status === "dropped" || (t.status = "done");
      else find(args.task).status = "done";
      return settle(phases);
    }
    case "drop": {
      if (!args.task && args.phase) for (const t of phaseOf(args.phase).tasks) t.status === "done" || (t.status = "dropped");
      else {
        const t = find(args.task);
        if (t.status !== "done") t.status = "dropped";
      }
      return settle(phases);
    }
    case "rm": {
      if (!args.task && args.phase) phases.splice(phases.indexOf(phaseOf(args.phase)), 1);
      else {
        const t = find(args.task);
        for (const p of phases) p.tasks = p.tasks.filter((x) => x !== t);
      }
      return settle(phases);
    }
    case "block": {
      const t = find(args.task);
      if (t.status === "done") throw Error(`"${t.content}" is already done`);
      t.status = "blocked";
      if (args.reason) t.reason = args.reason;
      return settle(phases);
    }
    case "unblock": {
      const t = find(args.task);
      if (t.status !== "blocked") throw Error(`"${t.content}" is not blocked`);
      t.status = "pending";
      delete t.reason;
      return settle(phases);
    }
  }
}

const todo = defineTool({
  name: "todo",
  description: `Keep a phased task list for this conversation; it survives restarts and shows your progress.
- Never spend a turn on todo alone: call it alongside your next real tool call (init beside the first read, done/start beside the next action).
- init before work with 3 or more steps or a list of requests; list every requested item separately. init replaces the list.
- Tasks are named by their exact text, never by made-up ids. If unsure of the text, view.
- After each change: with nothing active the earliest pending task starts, and only one task is active. Mark tasks done as soon as they are.
- block a task waiting on a person, agent or service (with reason); unblock it when it can move. Blocked tasks never start on their own.
- drop keeps a task visible as abandoned; rm deletes it. done, drop and rm take phase instead of task for a whole phase.`,
  parameters: Type.Object({
    op: Type.Union(["init", "start", "done", "rm", "drop", "block", "unblock", "append", "view"].map((o) => Type.Literal(o))),
    list: Type.Optional(
      Type.Array(Type.Object({ phase: Type.String(), items: Type.Array(Type.String()) }), { description: "Phases for init" }),
    ),
    items: Type.Optional(Type.Array(Type.String(), { description: "Tasks for append, or for a one-phase init" })),
    task: Type.Optional(Type.String({ description: "The task's exact text" })),
    phase: Type.Optional(Type.String({ description: "Phase name: where append adds, or a whole phase for done, drop and rm" })),
    reason: Type.Optional(Type.String({ description: "What a blocked task waits for" })),
  }),
  replay: "safe",
  execute: async (args, api, ctx) => {
    const op = args as TodoArgs;
    if (op.op === "view") return text(renderTodo((await api.snapshot(TodoList, api.conversationId, ctx))?.phases ?? []));
    const result = await api.commit(async (tx) => {
      const receipt = await tx.doc(TodoReceipt, api.taskId);
      if (receipt.applied) return receipt.result;
      const doc = await tx.doc(TodoList, api.conversationId);
      doc.phases = applyTodo(doc.phases, op);
      receipt.applied = true;
      receipt.result = renderTodo(doc.phases);
      return receipt.result;
    }, ctx);
    return text(result);
  },
});

export const TOOLKIT_TOOLS = [think, grep, glob, astGrep, todo, ...READ_TOOLS, ...WEB_TOOLS, ...GITHUB_TOOLS, ...GIT_TOOLS, ...PIP3R_TOOLS, ...GITNEXUS_TOOLS];

export const Toolkit = defineExtension({
  name: "toolkit",
  tools: TOOLKIT_TOOLS,
  sections: [
    section(
      "toolkit",
      () =>
        "Search with grep (text and regex), glob (files by name) and ast_grep (code structure) rather than grep, find or rg in bash. Track work of 3 or more steps with todo, called alongside your other tool calls, never on its own. Open SQLite files, archives and documents (PDF, Word, Excel, PowerPoint, EPUB) with read_sqlite, read_archive and read_document. Use web_search to find things online and fetch_url to read a page; use github for repositories, issues, pull requests, CI runs and files on GitHub, and git for a local repository's branch, changes and history (git diff for the patch itself). To review delegated work, spot-check with gitnexus on the code graph (impact of a change before approving it, context for a symbol's callers, trace for how one symbol reaches another) and pip3r (doctor or verify for repository health).",
      { tag: false },
    ),
  ],
});
