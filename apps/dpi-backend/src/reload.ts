// The reload add-on: one tool the agent calls after changing Durable Pi's own code.
//   clients  bump the `ext.reload` counter; every playground tab and dpi-tui attached to this agent
//            reloads when it sees the counter change (they ignore the value they first load with)
//   backend  restart the dpi-backend service; the current run is interrupted and resumes on the new code
//   all      both
// The restart is the backend stopping itself (SIGTERM, the normal clean shutdown) a moment after the tool
// returns, so the result is stored first; systemd's Restart=always starts it again, with no sudo needed.
// Outside systemd there is nothing to bring it back, so backend reloads are refused there.
// replay "unsafe": a crash never restarts twice.
import { Type } from "@earendil-works/pi-ai";
import { defineDoc, defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { text } from "./toolkit-common.js";

export const RELOAD_DOC = "ext.reload";
export const ReloadSignal = defineDoc<{ n: number; at: number }>({
  kind: RELOAD_DOC,
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ n: 0, at: 0 }),
  checkpointWhen: () => false,
});

/** systemd sets INVOCATION_ID for every service process. */
const underSystemd = () => !!process.env.INVOCATION_ID;

const reload = defineTool({
  name: "reload",
  description:
    "Reload Durable Pi after changing its code. clients: every playground tab and TUI attached to this agent reloads (run the playground's npm run build first for web changes). backend: restart the dpi-backend service so backend changes load; this run is interrupted and resumes on the new code. all: both.",
  parameters: Type.Object({
    target: Type.Optional(
      Type.Union([Type.Literal("clients"), Type.Literal("backend"), Type.Literal("all")], {
        description: "What to reload (default clients)",
      }),
    ),
  }),
  replay: "unsafe",
  execute: async (args, api, ctx) => {
    const target = (args as { target?: "clients" | "backend" | "all" }).target ?? "clients";
    if (target !== "clients" && !underSystemd())
      return text("dpi-backend is not running under systemd here, so nothing would start it again. Restart it by hand.");
    const done: string[] = [];
    if (target !== "backend") {
      const n = await api.commit(async (tx) => {
        const doc = await tx.doc(ReloadSignal, api.conversationId);
        doc.n += 1;
        doc.at = Date.now();
        return doc.n;
      }, ctx);
      done.push(`Clients attached to this agent reload now (signal ${n}).`);
    }
    if (target !== "clients") {
      setTimeout(() => process.kill(process.pid, "SIGTERM"), 1500);
      done.push("The backend restarts in about 4 seconds; this run resumes after it.");
    }
    return text(done.join(" "));
  },
});

export const ReloadExtension = defineExtension({
  name: "reload",
  tools: [reload],
  sections: [
    section(
      "reload",
      () =>
        "After changing Durable Pi's own code, call reload so it takes effect: clients for playground or TUI changes (build the playground first), backend for dpi-backend changes, all for both.",
      { tag: false },
    ),
  ],
});
