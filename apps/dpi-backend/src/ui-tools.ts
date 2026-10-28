// The ui-tools add-on: an agent publishes read-only views made from a closed component catalog
// (dpi-sdk/src/ui-spec.ts) and saves templates any agent on this device can reuse. Views are a
// per-conversation document; they ride on the device tree to the hub, which streams them on the
// AG-UI canvas. A spec is data, never code, and no component carries an action.
//
//   ui_render          publish or replace a view by id
//   ui_clear           remove a view, or all of them
//   ui_template_save   save a spec with {{slots}} under a name (device-wide)
//   ui_template_list   the saved templates, their descriptions and slots
//   ui_template_use    fill a template's slots and publish the result as a view
import { Type } from "@earendil-works/pi-ai";
import { defineDoc, defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import {
  checkUiSpec,
  fillTemplate,
  slotsOf,
  UI_ID,
  UI_LIMITS,
  type UiNode,
  type UiView,
} from "../../dpi-sdk/src/ui-spec.js";
import type { SharedState } from "./shared-state.js";
import { text } from "./omp-common.js";

/** The agent's published views by id, each as checked JSON. A fork starts with its parent's views. */
export const UiViews = defineDoc<{ views: Record<string, string> }>({
  kind: "ui.views",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ views: {} }),
  checkpointWhen: () => false,
});

const CATALOG = `Components (JSON objects, "type" plus these fields; anything else is rejected):
card {title?, children} · row {children} · column {children} · text {text, tone?} · markdown {text} ·
metric {label, value, unit?} (value is a string) · badge {text, tone?} · progress {value 0..1, label?} ·
list {items: string[]} · table {columns: string[], rows: string[][]}. tone: default, muted, accent, urgent.
Limits: depth ${UI_LIMITS.depth}, ${UI_LIMITS.nodes} components, ${UI_LIMITS.text} characters per string, ${UI_LIMITS.items} list items or rows, ${UI_LIMITS.columns} columns, ${UI_LIMITS.views} views per agent.`;

const idParam = Type.String({ description: "View id: lowercase letters, digits, . _ -, up to 64" });

/**
 * An object, so models send one, or that object as JSON text, which some models send anyway (Sonnet
 * 5.5 did). Fields beyond `type` are checked by checkUiSpec either way.
 */
const specParam = (description: string) =>
  Type.Union(
    [
      Type.Object({ type: Type.String({ description: "Component type from the catalog" }) }, { additionalProperties: true }),
      Type.String({ description: "The same component as JSON text" }),
    ],
    { description },
  );

/** Models sometimes send an object parameter as JSON text; accept that, then check it like any spec. */
const specOf = (spec: unknown) => {
  if (typeof spec !== "string") return spec;
  try {
    return JSON.parse(spec) as unknown;
  } catch {
    throw Error("spec must be a component object (or its JSON)");
  }
};

const checkId = (id: string, what = "view id") => {
  if (!UI_ID.test(id)) throw Error(`Bad ${what} "${id}": use lowercase letters, digits, . _ - (1-64 chars)`);
};
const checkTitle = (title: string) => {
  if (!title.trim() || title.length > 120) throw Error("title must be 1-120 characters");
};

async function publish(
  api: Parameters<NonNullable<Parameters<typeof defineTool>[0]["execute"]>>[1],
  ctx: Parameters<NonNullable<Parameters<typeof defineTool>[0]["execute"]>>[2],
  view: UiView,
) {
  await api.commit(async (tx) => {
    const doc = await tx.doc(UiViews, api.conversationId);
    if (!(view.id in doc.views) && Object.keys(doc.views).length >= UI_LIMITS.views)
      throw Error(`You already show ${UI_LIMITS.views} views; replace one by id or ui_clear one first.`);
    doc.views[view.id] = JSON.stringify(view);
  }, ctx);
  return text(`Showing view "${view.id}" on the canvas.`);
}

/** The views stored in an agent's UiViews document, oldest first. */
export const viewsOf = (doc: { views: Record<string, string> } | undefined): UiView[] =>
  Object.values(doc?.views ?? {})
    .map((json) => JSON.parse(json) as UiView)
    .sort((a, b) => a.updatedAt - b.updatedAt);

export function createUiTools(shared: SharedState) {
  const render = defineTool({
    name: "ui_render",
    description: `Show a read-only view on the user's live canvas, attached to you. Publishing an existing id replaces that view. Use it for dashboards, status, results and summaries the user should see at a glance.\n${CATALOG}`,
    parameters: Type.Object({
      id: idParam,
      title: Type.String({ description: "Shown above the view" }),
      spec: specParam("The root component"),
    }),
    replay: "safe",
    execute: async (args, api, ctx) => {
      const { id, title, spec } = args as { id: string; title: string; spec: unknown };
      checkId(id);
      checkTitle(title);
      return publish(api, ctx, { id, title, spec: checkUiSpec(specOf(spec)), updatedAt: Date.now() });
    },
  });

  const clear = defineTool({
    name: "ui_clear",
    description: "Remove one of your views from the canvas, or all of them with id \"*\".",
    parameters: Type.Object({ id: Type.String({ description: 'A view id, or "*" for all' }) }),
    replay: "safe",
    execute: async (args, api, ctx) => {
      const { id } = args as { id: string };
      const removed = await api.commit(async (tx) => {
        const doc = await tx.doc(UiViews, api.conversationId);
        const ids = id === "*" ? Object.keys(doc.views) : id in doc.views ? [id] : [];
        for (const k of ids) delete doc.views[k];
        return ids.length;
      }, ctx);
      return text(removed ? `Removed ${removed} view${removed === 1 ? "" : "s"}.` : `No view "${id}".`);
    },
  });

  const save = defineTool({
    name: "ui_template_save",
    description: `Save a reusable view layout for every agent on this device. Put {{slot}} placeholders (lowercase, digits, _) in any string, and in progress.value as the string "{{slot}}". Saving an existing name replaces it.\n${CATALOG}`,
    parameters: Type.Object({
      name: Type.String({ description: "Template name: lowercase letters, digits, . _ -" }),
      description: Type.String({ description: "When to use it, in one sentence" }),
      spec: specParam("The root component, with {{slot}} placeholders"),
    }),
    replay: "safe",
    execute: async (args) => {
      const { name, description, spec } = args as { name: string; description: string; spec: unknown };
      checkId(name, "template name");
      if (!description.trim() || description.length > 300) throw Error("description must be 1-300 characters");
      const template = specOf(spec);
      checkUiSpec(template, { template: true });
      const slots = slotsOf(template);
      await shared.saveTemplate({ name, description, slots, spec: template, updatedAt: Date.now() });
      return text(`Saved template "${name}"${slots.length ? ` with slots ${slots.join(", ")}` : " (no slots)"}.`);
    },
  });

  const list = defineTool({
    name: "ui_template_list",
    description: "List the UI templates saved on this device: name, what it is for, and its slots.",
    parameters: Type.Object({}),
    replay: "safe",
    execute: async () => {
      const all = Object.values(await shared.templates()).sort((a, b) => a.name.localeCompare(b.name));
      if (!all.length) return text("No UI templates yet. Save one with ui_template_save.");
      return text(
        all.map((t) => `${t.name}: ${t.description}${t.slots.length ? ` [slots: ${t.slots.join(", ")}]` : ""}`).join("\n"),
      );
    },
  });

  const use = defineTool({
    name: "ui_template_use",
    description: "Fill a saved template's slots and show the result as one of your views (replacing that id if it exists).",
    parameters: Type.Object({
      name: Type.String({ description: "Template name" }),
      id: idParam,
      title: Type.String({ description: "Shown above the view" }),
      values: Type.Record(Type.String(), Type.String(), { description: "A string for every slot" }),
    }),
    replay: "safe",
    execute: async (args, api, ctx) => {
      const { name, id, title, values } = args as { name: string; id: string; title: string; values: Record<string, string> };
      checkId(id);
      checkTitle(title);
      const template = (await shared.templates())[name];
      if (!template) throw Error(`No template "${name}". See ui_template_list.`);
      const spec: UiNode = fillTemplate(template.spec, values ?? {});
      return publish(api, ctx, { id, title, spec, template: name, updatedAt: Date.now() });
    },
  });

  return defineExtension({
    name: "ui-tools",
    tools: [render, clear, save, list, use],
    sections: [
      section(
        "ui-tools",
        () =>
          "You can show the user read-only views on their live canvas with ui_render: dashboards, status and results built from a fixed component catalog (no HTML). Before building a layout from scratch, check ui_template_list and reuse a template with ui_template_use; save layouts worth repeating with ui_template_save. Keep views current: replace a view by id as things change, and ui_clear views that no longer matter.",
        { tag: false },
      ),
    ],
  });
}
