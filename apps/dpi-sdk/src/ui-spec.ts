// Agent-made UI as data: a tree from a closed component catalog, never HTML or QML. Agents publish
// views and save templates with the ui-tools add-on (dpi-backend/src/ui-tools.ts); the hub streams
// views on the AG-UI canvas, and the web UI and the Omarchy plugin each render the same catalog.
//
// This file is the one source for the catalog: COMPONENTS drives the checker below and the text
// agents read (uiCatalogText), so the two cannot drift. Conventions follow A2UI v1.0 where they
// overlap (see ai_docs/durable_pi/generative-ui-plan.md):
//
//   Data      a view reads one data model with four roots:
//               /state   the device's App State (shared, saved)
//               /agent   the selected agent: /agent/docs/<kind>, /agent/tasks
//               /device  the selected device: /device/jobs
//               /local   scratch values for this view in this browser tab (not saved)
//             A write to /state goes to App State; any other write stays local to the view.
//   Binding   most text, number, list and tone fields take {"@path": "/pointer"} instead of a value,
//             and text fields also take {"@template": "Run #${/agent/x} of ${n}"}.
//   each      repeats its child for every item of an array; inside it a pointer without a leading
//             "/" is relative to the item ("" is the item itself) and "@index" is its position.
//   when      any component may carry {"@path": p, eq?, not?} and renders only when it holds.
//   button    runs one named action from UI_ACTIONS on the user's click, never an arbitrary tool.
//   input     a text box bound to a data path, so the user and the agent fill the same field.

export const UI_TONES = ["default", "muted", "accent", "urgent"] as const;
export type UiTone = (typeof UI_TONES)[number];

export type UiBinding = { "@path": string } | { "@template": string };
export type Bind<T> = T | UiBinding;
export type UiPrimitive = string | number | boolean | null;
export type UiWhen = { "@path": string; eq?: UiPrimitive; not?: boolean };
export type UiAction = { name: UiActionName; args?: Record<string, Bind<UiPrimitive>> };

type Common = { when?: UiWhen };
export type UiNode = Common &
  (
    | { type: "card"; title?: Bind<string>; children: UiNode[] }
    | { type: "row" | "column"; children: UiNode[] }
    | { type: "text"; text: Bind<string>; tone?: Bind<UiTone> }
    | { type: "markdown"; text: Bind<string> }
    | { type: "metric"; label: Bind<string>; value: Bind<string>; unit?: Bind<string> }
    | { type: "badge"; text: Bind<string>; tone?: Bind<UiTone> }
    | { type: "progress"; value: Bind<number>; label?: Bind<string> }
    | { type: "list"; items: Bind<string[]> }
    | { type: "table"; columns: Bind<string[]>; rows: Bind<string[][]> }
    | { type: "input"; label: Bind<string>; path: string; placeholder?: Bind<string>; multiline?: boolean }
    | { type: "each"; path: string; child: UiNode; empty?: Bind<string> }
    | { type: "button"; label: Bind<string>; action: UiAction; tone?: Bind<UiTone> }
  );

export interface UiView {
  id: string;
  title: string;
  spec: UiNode;
  /** The template it was made from, if any. */
  template?: string;
  updatedAt: number;
}

export interface UiTemplate {
  name: string;
  description: string;
  /** Slot names found in the spec as {{name}}, in order of first use. */
  slots: string[];
  /** May hold {{slot}} placeholders in any string, and in progress.value as a string. */
  spec: unknown;
  updatedAt: number;
}

export const UI_LIMITS = {
  depth: 8,
  nodes: 200,
  text: 2000,
  items: 50,
  columns: 8,
  bytes: 32 * 1024,
  views: 8,
  templates: 64,
  id: 64,
  slotValue: 2000,
} as const;

export const UI_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SLOT = /\{\{\s*([a-z0-9_]{1,32})\s*\}\}/g;
const SLOT_ONLY = /^\{\{\s*[a-z0-9_]{1,32}\s*\}\}$/;

/** The data model's top-level roots. */
export const UI_DATA_ROOTS = ["state", "agent", "device", "local"] as const;
const SEGMENT = "[^/]{1,64}";
const ABSOLUTE = new RegExp(`^/(${UI_DATA_ROOTS.join("|")})(/${SEGMENT}){0,11}$`);
const RELATIVE = new RegExp(`^(${SEGMENT}(/${SEGMENT}){0,11})?$`);
/** ${pointer} placeholders in an @template string. */
export const UI_TEMPLATE_REF = /\$\{([^}]{0,780})\}/g;

/** Field kinds: what a value must be, and whether it may be bound to data instead. */
type Kind =
  | "text" // string, or @path / @template
  | "ratio" // number 0..1, or @path
  | "texts" // string[], or @path
  | "rows" // string[][], or @path
  | "tone" // a UI_TONES value, or @path
  | "flag" // boolean
  | "children" // UiNode[]
  | "child" // UiNode
  | "data" // a data pointer string (absolute, or relative inside each)
  | "action"; // a UiAction

type Field = { kind: Kind; required?: boolean; note?: string };
type ComponentDef = { fields: Record<string, Field>; summary: string };

export const COMPONENTS: Record<UiNode["type"], ComponentDef> = {
  card: { summary: "a framed group", fields: { title: { kind: "text" }, children: { kind: "children", required: true } } },
  row: { summary: "children side by side", fields: { children: { kind: "children", required: true } } },
  column: { summary: "children stacked", fields: { children: { kind: "children", required: true } } },
  text: { summary: "a paragraph", fields: { text: { kind: "text", required: true }, tone: { kind: "tone" } } },
  markdown: { summary: "Markdown, sanitized", fields: { text: { kind: "text", required: true } } },
  metric: {
    summary: "a big value with a caption",
    fields: { label: { kind: "text", required: true }, value: { kind: "text", required: true }, unit: { kind: "text" } },
  },
  badge: { summary: "a short status label", fields: { text: { kind: "text", required: true }, tone: { kind: "tone" } } },
  progress: {
    summary: "a bar",
    fields: { value: { kind: "ratio", required: true, note: "0..1" }, label: { kind: "text" } },
  },
  list: { summary: "bullet list", fields: { items: { kind: "texts", required: true, note: "string[]" } } },
  table: {
    summary: "strings only",
    fields: {
      columns: { kind: "texts", required: true, note: "string[]" },
      rows: { kind: "rows", required: true, note: "string[][]" },
    },
  },
  input: {
    summary:
      "a text box the user types into, bound to the string at path. A /state path is App State, shared with you (create it with update_state, read it with read_state); any other path is local to the view",
    fields: {
      label: { kind: "text", required: true },
      path: { kind: "data", required: true },
      placeholder: { kind: "text" },
      multiline: { kind: "flag" },
    },
  },
  each: {
    summary: "repeats child for every item of the array at path; inside, relative paths read the item",
    fields: { path: { kind: "data", required: true }, child: { kind: "child", required: true }, empty: { kind: "text", note: "shown when there are none" } },
  },
  button: {
    summary: "runs a named action when the user clicks it",
    fields: { label: { kind: "text", required: true }, action: { kind: "action", required: true }, tone: { kind: "tone" } },
  },
};

/** Named actions a button may run, with their arguments. Each runs only on the user's click. */
export const UI_ACTIONS = {
  setState: { args: { path: true, value: false }, summary: "write value (a string, number, boolean or null) to path" },
  sendToAgent: { args: { text: true }, summary: "send text to the selected agent as a message from the user" },
  runJob: { args: { job: true, inputs: false }, summary: "start a durable job; inputs is bound to an object of values by name, or to an array of {name, value?} (missing ones use their defaults)" },
  decideJob: { args: { run: true, approve: true }, summary: "approve or decline a job run waiting for approval" },
  stopAll: { args: {}, summary: "stop the agent's foreground and background work" },
  showRun: { args: { run: true }, summary: "scroll the chat to a job run's card" },
  openAgent: { args: { conversation: true }, summary: "open another agent (a subagent) by conversation id" },
} as const satisfies Record<string, { args: Record<string, boolean>; summary: string }>;
export type UiActionName = keyof typeof UI_ACTIONS;

/** The catalog as agents read it in the ui_render and ui_template_save tool descriptions. */
export function uiCatalogText(): string {
  const fields = (def: ComponentDef) =>
    Object.entries(def.fields)
      .map(([k, f]) => `${k}${f.required ? "" : "?"}${f.note ? ` ${f.note}` : ""}`)
      .join(", ");
  const components = Object.entries(COMPONENTS)
    .map(([name, def]) => `${name} {${fields(def)}}: ${def.summary}`)
    .join("\n");
  const actions = Object.entries(UI_ACTIONS)
    .map(([name, a]) => `${name}(${Object.keys(a.args).join(", ")}): ${a.summary}`)
    .join("\n");
  return `Components (JSON objects, "type" plus these fields; anything else is rejected):
${components}
tone: ${UI_TONES.join(", ")}. Any component may also have when {"@path", eq?, not?} and renders only when the value at @path is truthy (or equals eq; not inverts).
Data: text, number, list, table and tone fields take {"@path": "/pointer"} instead of a value, and text fields also take {"@template": "Hi \${/state/user/name}"}. Roots: /state (App State), /agent/docs/<kind> and /agent/tasks (the selected agent), /device/jobs, /local (scratch, this view only). Inside each, a path without a leading / is relative to the item ("" is the item) and "@index" is its position. Prefer bindings over copying values in, so the view stays live as the data changes.
Button actions ({"name", "args"}; args may be bound):
${actions}
Limits: depth ${UI_LIMITS.depth}, ${UI_LIMITS.nodes} components, ${UI_LIMITS.text} characters per string, ${UI_LIMITS.items} list items, rows or repeats, ${UI_LIMITS.columns} columns, ${UI_LIMITS.views} views per agent.`;
}

export class UiSpecError extends Error {}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isPrimitive = (v: unknown) => v === null || ["string", "number", "boolean"].includes(typeof v);

/**
 * Check `spec` against the catalog and limits; returns it typed. Unknown types and unknown fields
 * are rejected, never passed through. With `template: true`, progress.value may be a "{{slot}}"
 * string, since a template is filled before it renders.
 */
export function checkUiSpec(spec: unknown, options: { template?: boolean } = {}): UiNode {
  let nodes = 0;
  const fail = (path: string, message: string): never => {
    throw new UiSpecError(`${path || "spec"}: ${message}`);
  };
  const str = (v: unknown, path: string) => {
    if (typeof v !== "string") fail(path, "must be a string");
    if ((v as string).length > UI_LIMITS.text) fail(path, `longer than ${UI_LIMITS.text} characters`);
  };
  const strings = (v: unknown, path: string, max: number) => {
    if (!Array.isArray(v)) return fail(path, "must be an array of strings");
    if (v.length > max) fail(path, `more than ${max} entries`);
    v.forEach((s, i) => str(s, `${path}[${i}]`));
  };
  const pointer = (v: unknown, path: string, inEach: boolean) => {
    if (typeof v !== "string") return fail(path, "must be a data path string");
    if (ABSOLUTE.test(v)) return;
    if (inEach && (v === "@index" || RELATIVE.test(v))) return;
    fail(
      path,
      inEach
        ? `must be a data path under /${UI_DATA_ROOTS.join(", /")}, a path relative to the item, or "@index"`
        : `must be a data path under /${UI_DATA_ROOTS.join(", /")}, such as /state/form/q1`,
    );
  };
  /** A binding object, if `v` is one; checks it. */
  const binding = (v: unknown, path: string, inEach: boolean, template: boolean): boolean => {
    if (!isObject(v) || !("@path" in v || "@template" in v)) return false;
    const keys = Object.keys(v);
    if (keys.length !== 1) fail(path, 'a binding holds exactly one of "@path" or "@template"');
    if ("@path" in v) pointer(v["@path"], `${path}.@path`, inEach);
    else {
      if (!template) fail(path, '"@template" works only on text fields');
      str(v["@template"], `${path}.@template`);
      for (const m of (v["@template"] as string).matchAll(UI_TEMPLATE_REF)) pointer(m[1], `${path}.@template \${${m[1]}}`, inEach);
    }
    return true;
  };
  const field = (kind: Kind, v: unknown, path: string, depth: number, inEach: boolean, type: string) => {
    switch (kind) {
      case "text":
        if (!binding(v, path, inEach, true)) str(v, path);
        return;
      case "ratio": {
        if (binding(v, path, inEach, false)) return;
        const slot = options.template && typeof v === "string" && SLOT_ONLY.test(v);
        if (!slot && (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1))
          fail(path, "must be a number from 0 to 1");
        return;
      }
      case "texts":
        if (!binding(v, path, inEach, false)) strings(v, path, type === "table" ? UI_LIMITS.columns : UI_LIMITS.items);
        return;
      case "rows":
        if (binding(v, path, inEach, false)) return;
        if (!Array.isArray(v)) return fail(path, "must be an array of rows");
        if (v.length > UI_LIMITS.items) fail(path, `more than ${UI_LIMITS.items} rows`);
        v.forEach((row, i) => strings(row, `${path}[${i}]`, UI_LIMITS.columns));
        return;
      case "tone":
        if (!binding(v, path, inEach, false) && !UI_TONES.includes(v as UiTone))
          fail(path, `must be one of ${UI_TONES.join(", ")}`);
        return;
      case "flag":
        if (typeof v !== "boolean") fail(path, "must be a boolean");
        return;
      case "data":
        pointer(v, path, inEach);
        return;
      case "children":
        if (!Array.isArray(v)) return fail(path, "must be an array");
        v.forEach((c, i) => walk(c, `${path}[${i}]`, depth + 1, inEach));
        return;
      case "child":
        walk(v, path, depth + 1, type === "each" || inEach);
        return;
      case "action": {
        if (!isObject(v)) return fail(path, "must be an action object {name, args?}");
        for (const k of Object.keys(v)) if (k !== "name" && k !== "args") fail(`${path}.${k}`, "not a field of an action");
        const def = UI_ACTIONS[v.name as UiActionName];
        if (!def) return fail(`${path}.name`, `unknown action "${String(v.name)}"; use one of ${Object.keys(UI_ACTIONS).join(", ")}`);
        const args = v.args ?? {};
        if (!isObject(args)) return fail(`${path}.args`, "must be an object");
        for (const [k, a] of Object.entries(args)) {
          if (!(k in def.args)) fail(`${path}.args.${k}`, `not an argument of ${String(v.name)}`);
          if (!binding(a, `${path}.args.${k}`, inEach, true) && !isPrimitive(a))
            fail(`${path}.args.${k}`, "must be a string, number, boolean, null or a binding");
          if (typeof a === "string") str(a, `${path}.args.${k}`);
        }
        for (const [k, required] of Object.entries(def.args))
          if (required && !(k in args)) fail(`${path}.args.${k}`, "is required");
        if (v.name === "setState" && typeof args.path === "string") pointer(args.path, `${path}.args.path`, inEach);
        return;
      }
    }
  };
  const walk = (node: unknown, path: string, depth: number, inEach: boolean) => {
    if (depth > UI_LIMITS.depth) fail(path, `nested deeper than ${UI_LIMITS.depth}`);
    if (++nodes > UI_LIMITS.nodes) fail(path, `more than ${UI_LIMITS.nodes} components`);
    if (!isObject(node)) return fail(path, "must be a component object");
    const def = COMPONENTS[node.type as UiNode["type"]];
    if (!def)
      return fail(`${path}.type`, `unknown component "${String(node.type)}"; use one of ${Object.keys(COMPONENTS).join(", ")}`);
    for (const key of Object.keys(node))
      if (key !== "type" && key !== "when" && !(key in def.fields)) fail(`${path}.${key}`, `not a field of ${String(node.type)}`);
    for (const [key, f] of Object.entries(def.fields)) {
      if (!(key in node)) {
        if (f.required) fail(`${path}.${key}`, "is required");
        continue;
      }
      field(f.kind, node[key], `${path}.${key}`, depth, inEach, node.type as string);
    }
    if ("when" in node) {
      const w = node.when;
      if (!isObject(w) || !("@path" in w)) return fail(`${path}.when`, 'must be {"@path", eq?, not?}');
      for (const k of Object.keys(w)) if (!["@path", "eq", "not"].includes(k)) fail(`${path}.when.${k}`, "not a field of when");
      pointer(w["@path"], `${path}.when.@path`, inEach);
      if ("eq" in w && !isPrimitive(w.eq)) fail(`${path}.when.eq`, "must be a string, number, boolean or null");
      if ("not" in w && typeof w.not !== "boolean") fail(`${path}.when.not`, "must be a boolean");
    }
  };
  if (JSON.stringify(spec ?? null).length > UI_LIMITS.bytes) fail("", `larger than ${UI_LIMITS.bytes / 1024} KiB`);
  walk(spec, "", 1, false);
  return spec as UiNode;
}

/** Slot names used in a template spec, in order of first use. */
export function slotsOf(spec: unknown): string[] {
  const found = new Set<string>();
  for (const m of JSON.stringify(spec ?? null).matchAll(SLOT)) found.add(m[1]);
  return [...found];
}

/** Fill every {{slot}} and check the result as a view spec. Every slot needs a value. */
export function fillTemplate(spec: unknown, values: Record<string, string>): UiNode {
  const missing = slotsOf(spec).filter((s) => typeof values[s] !== "string");
  if (missing.length) throw new UiSpecError(`missing values for ${missing.join(", ")}`);
  for (const [k, v] of Object.entries(values))
    if (String(v).length > UI_LIMITS.slotValue) throw new UiSpecError(`value for ${k} is too long`);
  const fill = (node: unknown): unknown => {
    if (typeof node === "string") return node.replace(SLOT, (_, name: string) => values[name]);
    if (Array.isArray(node)) return node.map(fill);
    if (typeof node !== "object" || node === null) return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) out[k] = fill(v);
    if (out.type === "progress" && typeof out.value === "string") out.value = Number(out.value);
    return out;
  };
  return checkUiSpec(fill(spec));
}

// ------------------------------------------------------------------ resolving data (renderers)

/** Where a component sits in the data: the absolute path of the current each item, and its index. */
export type UiScope = { base?: string; index?: number };

/** A pointer made absolute against the scope; "@index" stays as is. */
export function absolutePath(pointer: string, scope: UiScope): string {
  if (pointer.startsWith("/") || pointer === "@index") return pointer;
  if (scope.base === undefined) return `/${pointer}`;
  return pointer ? `${scope.base}/${pointer}` : scope.base;
}

/** Read a JSON Pointer from any JSON value; undefined when missing. */
export function readPointer(root: unknown, pointer: string): unknown {
  if (!pointer || pointer === "/") return root;
  let at: unknown = root;
  for (const raw of pointer.slice(1).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(at)) at = at[Number(key)];
    else if (isObject(at)) at = at[key];
    else return undefined;
  }
  return at;
}

/** The text a value shows as. */
export const uiText = (v: unknown): string =>
  v === undefined || v === null ? "" : typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(v);

/** Resolve a field that may be a binding, with `read` taking absolute pointers. */
export function resolveValue(v: unknown, scope: UiScope, read: (pointer: string) => unknown): unknown {
  if (!isObject(v)) return v;
  if (typeof v["@path"] === "string") {
    const p = absolutePath(v["@path"], scope);
    return p === "@index" ? scope.index : read(p);
  }
  if (typeof v["@template"] === "string")
    return v["@template"].replace(UI_TEMPLATE_REF, (_, ref: string) => {
      const p = absolutePath(ref, scope);
      return uiText(p === "@index" ? scope.index : read(p));
    });
  return v;
}

/** Whether a component's `when` holds. */
export function whenHolds(when: UiWhen | undefined, scope: UiScope, read: (pointer: string) => unknown): boolean {
  if (!when) return true;
  const v = resolveValue({ "@path": when["@path"] }, scope, read);
  const ok = "eq" in when ? v === when.eq : Array.isArray(v) ? v.length > 0 : !!v;
  return when.not ? !ok : ok;
}
