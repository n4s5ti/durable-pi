// A deterministic, free model for tests and offline demos (DPI_PROVIDER=faux).
//   "!<command>"   → one bash tool call running <command>, then a reply quoting its output
//   "slow: <text>" → streams <text> slowly
//   "spawn: <name>[ | <prompt>]" → one start_session call in the current folder
//   "jobs?"        → one list_durable_jobs call
//   "job: <id>[ <input json>][ wait]" → one run_durable_job call (wait: the call waits for the run)
//   "check:[ <task id>|<job id>]" → one check_durable_job call
//   "search: <words>" → one search_history call
//   "page: <summary>" → one ping_on_call_engineer call
//   "tool: <name> <args json>" → one call of any tool, e.g. tool: grep {"pattern":"TODO"}
//   "state: <operation> <path>[ <value json>]" → one update_state call
//   "adw-plan:" / "adw-build:" / "adw-review:" / "adw-fix:" / "adw-improve:" (job phases) → one tool call, then the step's JSON
//   "Release check: …" (the release-check job's subagent) → one bash call
//   anything else  → "Echo: <text>"
import type { MutableModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai/providers/faux";

export const fauxModels = [{ id: "echo", name: "Faux Echo" }] as const;

type AnyMessage = { role: string; content?: unknown; toolCallId?: string };
const textOf = (m?: AnyMessage) =>
  typeof m?.content === "string"
    ? m.content
    : Array.isArray(m?.content)
      ? (m!.content as { type: string; text?: string }[]).map((b) => (b.type === "text" ? (b.text ?? "") : "")).join("")
      : "";

/**
 * A job phase whose prompt starts "adw-<step>:" (from test .claude/commands files): one real tool call, then the JSON
 * the step asks for. Review passes once fixed.txt exists, which the fix step creates.
 */
const ADW_ACTIONS = {
  plan: ["write", { path: "specs/faux-plan.md", content: "# Plan\n\n1. Build it\n" }],
  build: ["bash", { command: "echo built > built.txt" }],
  review: ["bash", { command: "test -f fixed.txt && echo PASS || echo FAIL" }],
  fix: ["bash", { command: "touch fixed.txt" }],
  improve: ["bash", { command: "echo 'built_txt: made by the build step' >> .claude/commands/experts/faux/expertise.yaml" }],
} as const;

function fauxAdw(step: keyof typeof ADW_ACTIONS, last: AnyMessage | undefined) {
  if (last?.role !== "toolResult") {
    const [tool, args] = ADW_ACTIONS[step];
    return fauxAssistantMessage([fauxText(`Doing the ${step} step.`), fauxToolCall(tool, { ...args })], { stopReason: "toolUse" });
  }
  const passed = textOf(last).includes("PASS");
  const answer = {
    plan: { plan_path: "specs/faux-plan.md" },
    build: { summary: "Built it", files: ["built.txt"] },
    review: passed
      ? { verdict: "PASS", issues: [], summary: "Matches the plan" }
      : { verdict: "FAIL", issues: [{ severity: "blocker", description: "fixed.txt is missing" }], summary: "One blocker" },
    fix: { summary: "Created fixed.txt" },
    improve: { summary: "Added built.txt", changes: ["built_txt"] },
  }[step];
  return fauxAssistantMessage(fauxText(`Done.\n\`\`\`json\n${JSON.stringify(answer)}\n\`\`\``));
}

export function installFaux(models: MutableModels) {
  const handle = fauxProvider({
    provider: "faux",
    models: fauxModels.map((m) => ({ id: m.id, name: m.name, contextWindow: 128000, maxTokens: 8192 })),
    tokensPerSecond: 400,
  });
  const reply: FauxResponseFactory = (context) => {
    handle.appendResponses([reply]);
    const messages = context.messages as unknown as AnyMessage[];
    const last = messages.at(-1);
    const adw = /^adw-(plan|build|review|fix|improve):/.exec(textOf(messages.find((m) => m.role === "user")).trim())?.[1];
    if (adw) return fauxAdw(adw as keyof typeof ADW_ACTIONS, last);
    if (last?.role === "toolResult")
      return fauxAssistantMessage(fauxText(`Tool finished: ${textOf(last).trim().slice(0, 400)}`));
    const prompt = textOf([...messages].reverse().find((m) => m.role === "user")).trim();
    if (prompt.startsWith("!"))
      return fauxAssistantMessage([fauxText("Running it."), fauxToolCall("bash", { command: prompt.slice(1).trim() })], {
        stopReason: "toolUse",
      });
    if (prompt.startsWith("spawn:")) {
      const [name, first] = prompt.slice(6).split("|").map((s) => s.trim());
      return fauxAssistantMessage(
        [fauxText("Starting it."), fauxToolCall("start_session", { name, cwd: ".", ...(first ? { prompt: first } : {}) })],
        { stopReason: "toolUse" },
      );
    }
    const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
      fauxAssistantMessage([fauxText(`Calling ${name}.`), fauxToolCall(name, args)], { stopReason: "toolUse" });
    if (prompt === "jobs?") return call("list_durable_jobs", {});
    if (prompt.startsWith("job:")) {
      const m = prompt.slice(4).trim().match(/^(\S+)\s*(\{.*\})?\s*(wait)?$/);
      return call("run_durable_job", {
        job: m?.[1] ?? "",
        ...(m?.[2] ? { input: JSON.parse(m[2]) } : {}),
        ...(m?.[3] ? { wait: true } : {}),
      });
    }
    if (prompt.startsWith("check:")) {
      const ref = prompt.slice(6).trim();
      return call("check_durable_job", /^\d+$/.test(ref) ? { task_id: Number(ref) } : ref ? { job: ref } : {});
    }
    if (prompt.startsWith("search:")) return call("search_history", { query: prompt.slice(7).trim() });
    if (prompt.startsWith("page:")) return call("ping_on_call_engineer", { summary: prompt.slice(5).trim() });
    if (prompt.startsWith("state:")) {
      const [operation, path, ...value] = prompt.slice(6).trim().split(" ");
      return call("update_state", { operation, path, ...(value.length ? { value_json: value.join(" ") } : {}) });
    }
    if (prompt.startsWith("tool:")) {
      const m = prompt.slice(5).trim().match(/^(\S+)\s*(\{.*\})?$/s);
      return call(m?.[1] ?? "", m?.[2] ? JSON.parse(m[2]) : {});
    }
    if (prompt.startsWith("Release check:"))
      return call("bash", { command: "git log --oneline -5 2>/dev/null || echo 'no git history'; ls | head -5" });
    if (prompt.startsWith("slow:")) return fauxAssistantMessage(fauxText(prompt.slice(5).trim().repeat(4)));
    return fauxAssistantMessage(fauxText(`Echo: ${prompt}`));
  };
  handle.setResponses([reply]);
  models.setProvider(handle.provider);
  return handle;
}
