// What Oh My Pi's read does beyond text files, as tools of their own beside pi-durable's read (adapted from Oh My Pi,
// MIT; see omp-tools.ts). SQLite opens read-only in this process; archives go through bsdtar (libarchive) and PDFs
// through pdftotext on the session's device; Office, OpenDocument and EPUB files are zips of XML read the same way.
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { DatabaseSync } from "node:sqlite";
import { clip, decodeEntities, htmlToMarkdown, MAX_TEXT, run, sessionPath, text } from "./omp-common.js";

// ------------------------------------------------------------------ read_sqlite

const quoteIdent = (name: string) => `"${name.replaceAll('"', '""')}"`;
const cell = (value: unknown) =>
  value === null || value === undefined
    ? "NULL"
    : value instanceof Uint8Array
      ? `<blob ${value.length} bytes>`
      : clip(String(value).replace(/\s+/g, " "), 200, "");

export function tableText(rows: Record<string, unknown>[]) {
  if (!rows.length) return "(no rows)";
  const columns = Object.keys(rows[0]);
  return [columns.join("\t"), ...rows.map((r) => columns.map((c) => cell(r[c])).join("\t"))].join("\n");
}

const readSqlite = defineTool({
  name: "read_sqlite",
  description:
    "Read a SQLite database file, opened read-only. With no table or sql: every table and view with its row count and schema. With table: its columns and rows (page with offset). With sql: the rows of one read-only query.",
  parameters: Type.Object({
    path: Type.String({ description: "Database file" }),
    table: Type.Optional(Type.String({ description: "Table or view to show" })),
    sql: Type.Optional(Type.String({ description: "One read-only SQL query" })),
    limit: Type.Optional(Type.Number({ description: "Most rows to show (default 50, max 500)" })),
    offset: Type.Optional(Type.Number({ description: "Rows to skip with table" })),
  }),
  replay: "safe",
  execute: async (args, api, ctx) => {
    const db = new DatabaseSync(await sessionPath(api, args.path, ctx), { readOnly: true });
    try {
      const limit = Math.min(500, Math.max(1, Math.floor(args.limit ?? 50)));
      if (args.sql) {
        const rows = db.prepare(args.sql).all() as Record<string, unknown>[];
        const more = rows.length > limit ? `\n\n${rows.length - limit} more rows; add LIMIT/OFFSET or raise limit` : "";
        return text(clip(tableText(rows.slice(0, limit)) + more));
      }
      if (args.table) {
        const columns = db.prepare(`PRAGMA table_info(${quoteIdent(args.table)})`).all() as { name: string; type: string; pk: number }[];
        if (!columns.length) throw Error(`No table or view "${args.table}"`);
        const offset = Math.max(0, Math.floor(args.offset ?? 0));
        const total = Number((db.prepare(`SELECT count(*) AS n FROM ${quoteIdent(args.table)}`).get() as { n: number }).n);
        const rows = db.prepare(`SELECT * FROM ${quoteIdent(args.table)} LIMIT ? OFFSET ?`).all(limit, offset) as Record<string, unknown>[];
        const head = `${args.table}: ${columns.map((c) => `${c.name} ${c.type}${c.pk ? " PK" : ""}`.trim()).join(", ")}`;
        const shown = `rows ${offset + 1}-${offset + rows.length} of ${total}`;
        const next = offset + rows.length < total ? `; next page: offset ${offset + rows.length}` : "";
        return text(clip(`${head}\n${shown}${next}\n\n${tableText(rows)}`));
      }
      const objects = db
        .prepare("SELECT name, type, sql FROM sqlite_schema WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all() as { name: string; type: string; sql: string | null }[];
      if (!objects.length) return text("No tables.");
      const lines = objects.map((o) => {
        const n = (db.prepare(`SELECT count(*) AS n FROM ${quoteIdent(o.name)}`).get() as { n: number }).n;
        return `${o.type} ${o.name} (${n} rows)\n  ${(o.sql ?? "").replace(/\s+/g, " ")}`;
      });
      return text(clip(lines.join("\n")));
    } finally {
      db.close();
    }
  },
});

// ------------------------------------------------------------------ archives

async function archiveEntries(api: Pick<ToolExecutionApi, "env">, path: string, ctx: Context) {
  const { code, out } = await run(api, ["bsdtar", "-tf", path], ctx);
  if (code !== 0) throw Error(out.trim() || `bsdtar could not list ${path}`);
  return out.split("\n").filter(Boolean);
}

async function archiveMember(api: Pick<ToolExecutionApi, "env">, path: string, member: string, ctx: Context) {
  const { code, out } = await run(api, ["bsdtar", "-xOf", path, member], ctx);
  if (code !== 0) throw Error(out.trim() || `No ${member} in ${path}`);
  return out;
}

const readArchive = defineTool({
  name: "read_archive",
  description:
    "Look inside an archive without unpacking it: zip, tar (gz, bz2, xz, zst), 7z, rar, iso, cpio and more (bsdtar). With no member: the entries. With member: that file's text.",
  parameters: Type.Object({
    path: Type.String({ description: "Archive file" }),
    member: Type.Optional(Type.String({ description: "Path of one entry, as the listing shows it" })),
  }),
  replay: "safe",
  execute: async (args, api, ctx) => {
    const path = await sessionPath(api, args.path, ctx);
    if (!args.member) {
      const entries = await archiveEntries(api, path, ctx);
      const rest = entries.length - 500;
      return text(entries.slice(0, 500).join("\n") + (rest > 0 ? `\n\n${rest} more entries` : "") || "Empty archive");
    }
    const body = await archiveMember(api, path, args.member, ctx);
    if (body.includes("\0")) return text(`${args.member} is binary (${body.length} bytes); extract it with bash to use it`);
    return text(clip(body));
  },
});

// ------------------------------------------------------------------ documents

/** Text of Office/OpenDocument XML: paragraph and line ends become newlines, tabs stay, everything else is dropped. */
export function xmlText(xml: string) {
  return decodeEntities(
    xml
      .replace(/<(w:tab|text:tab)\b[^>]*\/>/g, "\t")
      .replace(/<(w:br|a:br|text:line-break)\b[^>]*\/>/g, "\n")
      .replace(/<\/(w:p|a:p|text:p|text:h)>/g, "\n")
      .replace(/<[^>]*>/g, ""),
  )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const numbered = (entries: string[], re: RegExp) =>
  entries
    .filter((e) => re.test(e))
    .sort((a, b) => Number(re.exec(a)![1]) - Number(re.exec(b)![1]));

/** Column index of a cell reference: A1 → 0, AB7 → 27. */
const columnOf = (ref: string) => [...(/^[A-Z]+/.exec(ref)?.[0] ?? "A")].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

/** Each worksheet as tab-separated rows (at most 200), shared strings resolved. */
export function xlsxText(sharedXml: string, workbookXml: string, sheets: string[]) {
  const shared = [...sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => xmlText(m[1]));
  const names = [...workbookXml.matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map((m) => decodeEntities(m[1]));
  return sheets
    .map((xml, i) => {
      const rows = [...xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].slice(0, 200).map((row) => {
        const cells: string[] = [];
        for (const c of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
          const attrs = c[1];
          const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1] ?? "";
          const type = /\bt="(\w+)"/.exec(attrs)?.[1];
          const raw = /<v>([\s\S]*?)<\/v>/.exec(c[2] ?? "")?.[1] ?? /<t[^>]*>([\s\S]*?)<\/t>/.exec(c[2] ?? "")?.[1] ?? "";
          cells[ref ? columnOf(ref) : cells.length] = type === "s" ? (shared[Number(raw)] ?? "") : decodeEntities(raw);
        }
        return Array.from(cells, (v) => v ?? "").join("\t");
      });
      return `## ${names[i] ?? `Sheet ${i + 1}`}\n${rows.join("\n")}`;
    })
    .join("\n\n");
}

type Notebook = { cells?: { cell_type: string; source: string | string[] }[] };

export function notebookText(json: string) {
  const nb = JSON.parse(json) as Notebook;
  const src = (s: string | string[]) => (Array.isArray(s) ? s.join("") : s);
  return (nb.cells ?? []).map((c) => (c.cell_type === "code" ? `\`\`\`\n${src(c.source)}\n\`\`\`` : src(c.source))).join("\n\n");
}

async function documentText(api: Pick<ToolExecutionApi, "env">, path: string, pages: string | undefined, ctx: Context) {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1].toLowerCase() ?? "";
  if (ext === "pdf") {
    const argv = ["pdftotext", "-layout"];
    const range = pages && /^(\d+)(?:-(\d+))?$/.exec(pages.trim());
    if (pages && !range) throw Error('pages takes "N" or "N-M"');
    if (range) argv.push("-f", range[1], "-l", range[2] ?? range[1]);
    const { code, out } = await run(api, [...argv, path, "-"], ctx, 60);
    if (code !== 0) throw Error(out.trim() || "pdftotext failed");
    return out.replace(/\f/g, "\n\n---\n\n").trim();
  }
  if (ext === "ipynb") {
    const raw = await api.env!.readTextFile(path, ctx);
    if (!raw.ok) throw Error(raw.error.message);
    return notebookText(raw.value);
  }
  const zipped = ["docx", "pptx", "xlsx", "odt", "odp", "ods", "epub"];
  if (!zipped.includes(ext)) throw Error(`read_document reads pdf, ${zipped.join(", ")} and ipynb; use read for text files`);
  const entries = await archiveEntries(api, path, ctx);
  const get = (member: string) => archiveMember(api, path, member, ctx);
  if (ext === "docx") return xmlText(await get("word/document.xml"));
  if (ext === "pptx") {
    const slides = numbered(entries, /^ppt\/slides\/slide(\d+)\.xml$/);
    return (await Promise.all(slides.map(async (s, i) => `## Slide ${i + 1}\n${xmlText(await get(s))}`))).join("\n\n");
  }
  if (ext === "xlsx") {
    const sheets = numbered(entries, /^xl\/worksheets\/sheet(\d+)\.xml$/);
    const shared = entries.includes("xl/sharedStrings.xml") ? await get("xl/sharedStrings.xml") : "";
    return xlsxText(shared, await get("xl/workbook.xml"), await Promise.all(sheets.map(get)));
  }
  if (ext === "epub") {
    const pagesOf = entries.filter((e) => /\.x?html?$/i.test(e) && !/\bnav\.x?html$/i.test(e));
    return (await Promise.all(pagesOf.map(async (p) => htmlToMarkdown(await get(p))))).filter(Boolean).join("\n\n---\n\n");
  }
  return xmlText(await get("content.xml"));
}

const readDocument = defineTool({
  name: "read_document",
  description:
    "Read a document as text: PDF (pdftotext; pages like \"3\" or \"2-5\"), Word .docx, Excel .xlsx (each sheet as tab-separated rows), PowerPoint .pptx (per slide), OpenDocument .odt/.ods/.odp, EPUB and Jupyter .ipynb. Long documents page with offset.",
  parameters: Type.Object({
    path: Type.String({ description: "Document file" }),
    pages: Type.Optional(Type.String({ description: 'PDF pages, "N" or "N-M"' })),
    offset: Type.Optional(Type.Number({ description: "Characters to skip, for the next page of a long document" })),
  }),
  replay: "safe",
  execute: async (args, api, ctx) => {
    const body = await documentText(api, await sessionPath(api, args.path, ctx), args.pages, ctx);
    const offset = Math.max(0, Math.floor(args.offset ?? 0));
    const page = body.slice(offset, offset + MAX_TEXT);
    const rest = body.length - offset - page.length;
    return text((page || "(no text)") + (rest > 0 ? `\n\n[${rest} more characters; next page: offset ${offset + page.length}]` : ""));
  },
});

export const READ_TOOLS = [readSqlite, readArchive, readDocument];
