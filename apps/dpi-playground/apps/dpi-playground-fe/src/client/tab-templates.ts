// Inspector tabs built from the ui-spec catalog instead of hand-written Vue (generative UI plan,
// A3). Each is a plain view spec bound to the data model in ui-data.ts; the hand-written panel stays
// behind a toggle until the template matches it.
import { checkUiSpec, type UiNode } from "@sdk/ui-spec";

/** The Tasks tab: durable jobs (inputs, run, approve) and the live task tree. */
export const TASKS_TAB: UiNode = checkUiSpec({
  type: "column",
  children: [
    {
      type: "card",
      title: "Durable jobs",
      children: [
        {
          type: "text",
          tone: "muted",
          text: "Repeatable workflows with named phases and a checkpoint after each. Start one here, or ask your agent (list_durable_jobs, run_durable_job, check_durable_job).",
        },
        {
          type: "each",
          path: "/device/jobs",
          empty: "This device has no durable jobs.",
          child: {
            type: "card",
            title: { "@path": "title" },
            children: [
              {
                type: "row",
                children: [
                  { type: "badge", text: { "@path": "time" }, tone: "muted" },
                  { type: "badge", text: "needs approval", tone: "accent", when: { "@path": "approval" } },
                  { type: "badge", text: { "@template": "→ /state${resultPath}" }, tone: "muted" },
                ],
              },
              { type: "text", text: { "@path": "summary" } },
              { type: "text", tone: "muted", text: { "@path": "phases" } },
              {
                type: "each",
                path: "inputs",
                child: {
                  type: "input",
                  label: { "@path": "name" },
                  placeholder: { "@path": "placeholder" },
                  path: "value", // a local edit on the item; runJob reads it back below
                },
              },
              {
                type: "row",
                when: { "@path": "last" },
                children: [
                  {
                    type: "text",
                    text: { "@template": "Run #${last/run}: ${last/statusLabel} ${last/phase}" },
                  },
                  { type: "button", label: "Show in chat", action: { name: "showRun", args: { run: { "@path": "last/id" } } } },
                  {
                    type: "button",
                    label: "Approve",
                    tone: "accent",
                    when: { "@path": "last/approvalPending" },
                    action: { name: "decideJob", args: { run: { "@path": "last/id" }, approve: true } },
                  },
                  {
                    type: "button",
                    label: "Decline",
                    when: { "@path": "last/approvalPending" },
                    action: { name: "decideJob", args: { run: { "@path": "last/id" }, approve: false } },
                  },
                ],
              },
              {
                type: "button",
                label: { "@template": "Run ${title}" },
                tone: "accent",
                action: { name: "runJob", args: { job: { "@path": "id" }, inputs: { "@path": "inputs" } } },
              },
            ],
          },
        },
      ],
    },
    {
      type: "card",
      title: "Agent activity",
      children: [
        {
          type: "text",
          tone: "muted",
          text: "Every model response and tool call is its own durable task. After a restart each one resumes or reports how it ended.",
        },
        {
          type: "each",
          path: "/agent/tasks",
          empty: "Nothing running. Send a message or run a job.",
          child: {
            type: "row",
            children: [
              { type: "text", text: { "@template": "${indent}${name}" } },
              { type: "badge", text: { "@path": "statusLabel" } },
              { type: "text", tone: "muted", text: { "@template": "#${id} ${what} ${phase}" } },
            ],
          },
        },
        {
          type: "button",
          label: "Stop all",
          tone: "urgent",
          when: { "@path": "/agent/tasks" },
          action: { name: "stopAll" },
        },
      ],
    },
  ],
});
