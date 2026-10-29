// Custom harness extensions an agent can turn on and off. Each is a plain pi-durable extension in the registry; the
// agent's stored selection (`configure({ extensions: { add | remove } })`) decides whether it runs, from the next
// request on. New sessions start with toolkit selected; the others are off until an agent turns them on.
//
//   system-prompts       a checklist of built-in system prompts, rendered as one section
//   jev-damage-control   Jev judges every bash command before it runs and blocks destructive ones
//   toolkit              search, todo, documents, web and GitHub tools (toolkit.ts)
//   ui-tools             read-only views on the live canvas and device-wide UI templates (ui-tools.ts)
//   hindsight            Hermes' long-term memory: auto recall, auto retain and three tools (hindsight.ts)
//
// A hook runs outside the commit line and can run again after a crash. A hook that asks a person or an outside API
// must store the answer with `api.memo`, as the Jev guard does. A `safe` tool rerun after a crash skips `beforeTool`.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defineDoc, defineExtension, hook, section, ToolTask, type Extension } from "@earendil-works/pi-durable";
import type { HarnessExtensionInfo } from "../../dpi-sdk/src/api.js";
import { askJev, type JevAnswer, type JevQuestion } from "./jev.js";
import type { SharedState } from "./shared-state.js";
import { Toolkit } from "./toolkit.js";
import { createUiTools } from "./ui-tools.js";
import { createMemoryExtension, type MemoryStore } from "./memory.js";
import { createHindsight, hindsightSettings } from "./hindsight.js";
import { ReloadExtension } from "./reload.js";
import { createLibraryExtension, type LibraryStore } from "./library.js";

const PROMPTS_DIR = join(import.meta.dirname, "../prompts");

export const PROMPTS = [
  {
    id: "smart_ass_opus_fix.md",
    title: "Smart Ass Opus fix",
    description: "Clear, concise, actionable communication: the most important point last, no filler, reference codes.",
  },
  {
    id: "one_sentence.md",
    title: "One sentence",
    description: "Replies in one sentence unless you ask for more. Easy to see turn on and off.",
  },
].map((p) => ({ ...p, text: readFileSync(join(PROMPTS_DIR, p.id), "utf8").trim() }));

/** Which built-in prompts this agent's system-prompts extension renders. */
export const PromptChecklist = defineDoc<{ enabled: string[] }>({
  kind: "ext.system-prompts",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ enabled: [PROMPTS[0].id] }),
  checkpointWhen: () => false,
});

// ------------------------------------------------------------------ jev-damage-control

/** The jev-bash gate's questions and thresholds (harness/extensions/jev-bash/bash-gate.ts). */
const BASH_QUESTIONS: Record<string, JevQuestion> = {
  effect: {
    type: "choice",
    instructions: "What does running `command` do to the machine?",
    criteria: {
      read_only: "Lists, reads, searches, tests, builds into a scratch directory; nothing durable changes",
      reversible: "Changes files or state that git or a reinstall can restore: edits, installs, generated output",
      irreversible:
        "Deletes or overwrites things with no way back: removing directories, force pushing, dropping data, rewriting history",
    },
  },
  destructive_intent: {
    type: "noul",
    instructions: "Does `command` aim to remove or wipe something rather than build or inspect?",
    criteria: {
      true: "rm -rf, drop, purge, force, reset --hard, truncate, overwriting real data",
      false: "Reading, listing, testing, installing, generating, or editing in place",
    },
  },
};

type Verdict = { block: boolean; reason: string };

function gate(a: Record<string, JevAnswer>): Verdict {
  const effect = a.effect as Extract<JevAnswer, { type: "choice" }>;
  const destructive = (a.destructive_intent as Extract<JevAnswer, { type: "noul" }>).noul;
  if (effect.choice === "irreversible" && effect.confidence >= 0.6)
    return { block: true, reason: `irreversible (${effect.confidence.toFixed(2)}): nothing would restore what this removes or overwrites` };
  if (destructive >= 0.7)
    return { block: true, reason: `destructive intent (${destructive.toFixed(2)}): this command aims to wipe something` };
  return { block: false, reason: `${effect.choice} (${effect.confidence.toFixed(2)}), destructive ${destructive.toFixed(2)}` };
}

/** The faux provider's stand-in for Jev, so tests and offline demos never call the network. */
const OFFLINE_DANGER = /\brm\s+-[a-z]*[rf]|\bgit\s+push\b.*--force|\bgit\s+reset\s+--hard|\bdropdb\b|\bmkfs|\bdd\s+.*of=|\btruncate\b/;
async function judgeOffline(command: string): Promise<Verdict> {
  return OFFLINE_DANGER.test(command)
    ? { block: true, reason: "destructive intent (offline rules): this command aims to wipe something" }
    : { block: false, reason: "allowed (offline rules)" };
}

// ------------------------------------------------------------------ the extensions

export const ADDON_INFO: Omit<HarnessExtensionInfo, "enabled" | "prompts">[] = [
  {
    name: "system-prompts",
    title: "System prompts",
    description: "Adds the checked prompts to this agent's system prompt. A change applies from the next request.",
  },
  {
    name: "jev-damage-control",
    title: "Jev damage control",
    description:
      "Before every bash call, Jev judges the command in about 300 ms and blocks irreversible or destructive ones. The decision is a durable memo, so a restart never re-asks. If Jev is down, commands run.",
  },
  {
    name: "toolkit",
    title: "Toolkit",
    description:
      "grep, glob and ast_grep search; a todo list that survives restarts; think; read_sqlite, read_archive and read_document (PDF, Office, EPUB); web_search and fetch_url; read-only github. On for new sessions.",
  },
  {
    name: "ui-tools",
    title: "UI tools",
    description:
      "Read-only views on the live canvas from a fixed component catalog (cards, metrics, tables, progress…), plus UI templates saved on this device for any agent to reuse: ui_render, ui_clear, ui_template_save, ui_template_list, ui_template_use.",
  },
  {
    name: "reload",
    title: "Reload",
    description:
      "A reload tool for working on Durable Pi itself: reloads every playground tab and TUI attached to the agent, restarts dpi-backend, or both.",
  },
  {
    name: "library",
    title: "Course library",
    description:
      "The user's course transcripts and docs (library.sqlite on this device, apart from Bags memory). Adds library_recall, and puts the two most relevant passages in front of each run when they clear a similarity threshold.",
  },
  {
    name: "memory",
    title: "Bags memory",
    description:
      "Bags' long-term memory (memory.sqlite on this device), shared with Hermes. Recalls matching memories into each run, puts the user's standing feedback in front of every request, and adds remember, recall and forget.",
  },
  {
    name: "hindsight",
    title: "Hindsight memory",
    description: `The Hermes agent's long-term memory (bank ${hindsightSettings().bank}). Recalls relevant memories into each run, stores every finished turn, and adds hindsight_retain, hindsight_recall and hindsight_reflect. If Hindsight is down, runs continue without it.`,
  },
];

export function createAddons(opts: { offline: boolean; shared: SharedState; memory: MemoryStore; library: LibraryStore }) {
  const prompts = defineExtension({
    name: "system-prompts",
    sections: [
      section(
        "system-prompts",
        async (input, ctx) => {
          const checklist = await input.read.snapshot(PromptChecklist, input.conversationId, ctx);
          const enabled = checklist?.enabled ?? [PROMPTS[0].id];
          const text = PROMPTS.filter((p) => enabled.includes(p.id)).map((p) => p.text);
          return text.length ? text.join("\n\n") : undefined;
        },
        { tag: false },
      ),
    ],
  });
  const judge = opts.offline ? judgeOffline : async (command: string) => gate(await askJev({ command }, BASH_QUESTIONS));
  const jev = defineExtension({
    name: "jev-damage-control",
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call, api, ctx) => {
          if (call.name !== "bash") return;
          const command = String((call.arguments as { command?: unknown }).command ?? "");
          let verdict = await api.memo<Verdict>("jev-damage-control", ctx);
          if (!verdict) {
            try {
              verdict = await api.memo<Verdict>("jev-damage-control", await judge(command), ctx);
            } catch (e) {
              // Fails open: a Jev outage must not stop bash. The log line is the only record that the guard was skipped.
              console.error("[jev-damage-control] unjudged, ran anyway:", command, "-", e instanceof Error ? e.message : e);
              return;
            }
          }
          if (verdict.block) return { block: `jev-damage-control blocked this command: ${verdict.reason}` };
        },
      }),
    ],
  });
  const uiTools = createUiTools(opts.shared);
  const hindsight = createHindsight({ offline: opts.offline });
  const memory = createMemoryExtension(opts.memory);
  const library = createLibraryExtension(opts.library);
  const all: Record<string, Extension> = {
    "system-prompts": prompts,
    "jev-damage-control": jev,
    toolkit: Toolkit,
    "ui-tools": uiTools,
    reload: ReloadExtension,
    hindsight,
    memory,
    library,
  };
  return { all, list: [prompts, jev, Toolkit, uiTools, ReloadExtension, hindsight, memory, library] };
}

export type Addons = ReturnType<typeof createAddons>;
