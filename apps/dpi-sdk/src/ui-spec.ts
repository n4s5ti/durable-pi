// Agent-made UI as data: a tree from a closed component catalog, never HTML or QML. Agents publish
// views and save templates with the ui-tools add-on (dpi-backend/src/ui-tools.ts); the hub streams
// views on the read-only AG-UI canvas, and the web UI and the Omarchy plugin each render the same
// catalog. Read-only by design: no component carries an action.
//
//   card      { title?, children }       a framed group
//   row       { children }               side by side
//   column    { children }               stacked
//   text      { text, tone? }            a paragraph
//   markdown  { text }                   Markdown, sanitized by the renderer
//   metric    { label, value, unit? }    a big number with a caption
//   badge     { text, tone? }            a short status label
//   progress  { value, label? }          0..1
//   list      { items }                  bullet list of strings
//   table     { columns, rows }          strings only

export const UI_TONES = ["default", "muted", "accent", "urgent"] as const;
export type UiTone = (typeof UI_TONES)[number];

export type UiNode =
  | { type: "card"; title?: string; children: UiNode[] }
  | { type: "row" | "column"; children: UiNode[] }
  | { type: "text"; text: string; tone?: UiTone }
  | { type: "markdown"; text: string }
  | { type: "metric"; label: string; value: string; unit?: string }
  | { type: "badge"; text: string; tone?: UiTone }
  | { type: "progress"; value: number; label?: string }
  | { type: "list"; items: string[] }
  | { type: "table"; columns: string[]; rows: string[][] };

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
  depth: 6,
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

const FIELDS: Record<UiNode["type"], { required: string[]; optional: string[] }> = {
  card: { required: ["children"], optional: ["title"] },
  row: { required: ["children"], optional: [] },
  column: { required: ["children"], optional: [] },
  text: { required: ["text"], optional: ["tone"] },
  markdown: { required: ["text"], optional: [] },
  metric: { required: ["label", "value"], optional: ["unit"] },
  badge: { required: ["text"], optional: ["tone"] },
  progress: { required: ["value"], optional: ["label"] },
  list: { required: ["items"], optional: [] },
  table: { required: ["columns", "rows"], optional: [] },
};

export class UiSpecError extends Error {}

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
  const walk = (node: unknown, path: string, depth: number) => {
    if (depth > UI_LIMITS.depth) fail(path, `nested deeper than ${UI_LIMITS.depth}`);
    if (++nodes > UI_LIMITS.nodes) fail(path, `more than ${UI_LIMITS.nodes} components`);
    if (typeof node !== "object" || node === null || Array.isArray(node))
      return fail(path, "must be a component object");
    const n = node as Record<string, unknown>;
    const fields = FIELDS[n.type as UiNode["type"]];
    if (!fields)
      return fail(`${path}.type`, `unknown component "${String(n.type)}"; use one of ${Object.keys(FIELDS).join(", ")}`);
    for (const key of Object.keys(n))
      if (key !== "type" && !fields.required.includes(key) && !fields.optional.includes(key))
        fail(`${path}.${key}`, `not a field of ${String(n.type)}`);
    for (const key of fields.required) if (!(key in n)) fail(`${path}.${key}`, "is required");
    for (const key of ["title", "text", "label", "value", "unit"])
      if (key in n && !(n.type === "progress" && key === "value")) str(n[key], `${path}.${key}`);
    if ("tone" in n && !UI_TONES.includes(n.tone as UiTone))
      fail(`${path}.tone`, `must be one of ${UI_TONES.join(", ")}`);
    if (n.type === "progress") {
      const v = n.value;
      const slot = options.template && typeof v === "string" && /^\{\{\s*[a-z0-9_]{1,32}\s*\}\}$/.test(v);
      if (!slot && (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1))
        fail(`${path}.value`, "must be a number from 0 to 1");
    }
    if (n.type === "list") strings(n.items, `${path}.items`, UI_LIMITS.items);
    if (n.type === "table") {
      strings(n.columns, `${path}.columns`, UI_LIMITS.columns);
      if (!Array.isArray(n.rows)) return fail(`${path}.rows`, "must be an array of rows");
      if (n.rows.length > UI_LIMITS.items) fail(`${path}.rows`, `more than ${UI_LIMITS.items} rows`);
      n.rows.forEach((row, i) => strings(row, `${path}.rows[${i}]`, UI_LIMITS.columns));
    }
    if ("children" in n) {
      if (!Array.isArray(n.children)) return fail(`${path}.children`, "must be an array");
      n.children.forEach((c, i) => walk(c, `${path}.children[${i}]`, depth + 1));
    }
  };
  if (JSON.stringify(spec ?? null).length > UI_LIMITS.bytes)
    fail("", `larger than ${UI_LIMITS.bytes / 1024} KiB`);
  walk(spec, "", 1);
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
