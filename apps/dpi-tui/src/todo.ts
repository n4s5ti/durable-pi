// The agent's toolkit todo list (the `toolkit.todo` document) above the editor, drawn like the
// pi-tasks widget and the playground's chat-box widget. Hidden when empty or every task is finished.
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { c } from "./theme.ts";

export const TODO_DOC = "toolkit.todo";

type Status = "pending" | "active" | "done" | "blocked" | "dropped";
type Task = { content: string; status: Status; reason?: string };
type Phase = { name: string; tasks: Task[] };

const SPINNER = ["✳", "✴", "✵", "✶", "✷", "✸", "✹", "✺", "✻", "✼", "✽"];
const MAX_VISIBLE = 10;

const duration = (ms: number) => {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m${s % 60 ? ` ${s % 60}s` : ""}` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}`;
};

export class TodoWidget implements Component {
  private phases: Phase[] = [];
  /** When this client first saw each task active, by task text. */
  private since = new Map<string, number>();
  frame = 0;

  /** Feed the latest document. Returns true while a task is active, so the caller keeps animating. */
  set(doc: unknown) {
    this.phases = (doc as { phases?: Phase[] } | undefined)?.phases ?? [];
    const active = this.tasks().filter((t) => t.status === "active").map((t) => t.content);
    for (const k of [...this.since.keys()]) if (!active.includes(k)) this.since.delete(k);
    for (const k of active) if (!this.since.has(k)) this.since.set(k, Date.now());
    return active.length > 0;
  }

  private tasks() {
    return this.phases.flatMap((p) => p.tasks).filter((t) => t.status !== "dropped");
  }

  visible() {
    const tasks = this.tasks();
    return tasks.length > 0 && tasks.some((t) => t.status !== "done");
  }

  render(width: number) {
    if (!this.visible()) return [];
    const tasks = this.tasks();
    const n = (...s: Status[]) => tasks.filter((t) => s.includes(t.status)).length;
    const parts = [
      n("done") && `${n("done")} done`,
      n("active") && `${n("active")} in progress`,
      n("pending", "blocked") && `${n("pending", "blocked")} open`,
    ].filter(Boolean);
    const lines = [c.accent(`● ${tasks.length} tasks (${parts.join(", ")})`)];
    let num = 0;
    for (const p of this.phases) {
      const live = p.tasks.filter((t) => t.status !== "dropped");
      if (this.phases.length > 1 && live.length && num < MAX_VISIBLE) lines.push(c.muted(`  ${p.name}`));
      for (const t of live) {
        if (++num > MAX_VISIBLE) continue;
        const id = c.muted(`#${num}`);
        if (t.status === "active")
          lines.push(
            `  ${c.accent(SPINNER[this.frame % SPINNER.length])} ${id} ${c.accent(`${t.content}…`)} ${c.muted(`(${duration(Date.now() - (this.since.get(t.content) ?? Date.now()))})`)}`,
          );
        else if (t.status === "done") lines.push(`  ${c.ok("✔")} ${c.muted(c.strike(`#${num} ${t.content}`))}`);
        else
          lines.push(
            `  ◻ ${id} ${t.content}${t.status === "blocked" ? c.muted(` › blocked${t.reason ? `: ${t.reason}` : ""}`) : ""}`,
          );
      }
    }
    if (num > MAX_VISIBLE) lines.push(c.muted(`    … and ${num - MAX_VISIBLE} more`));
    return lines.map((l) => truncateToWidth(` ${l}`, width, "..."));
  }

  invalidate() {}
}
