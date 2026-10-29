// The course library: the user's course material (transcripts and docs), searchable by Bags. A device-wide SQLite file
// (<dataDir>/library.sqlite, mode 600) kept apart from memory.sqlite: it is reference material, not memory, so it never
// appears in memory recall, standing rules or Hermes prefetch.
//
//   items     source (e.g. "idd"), lesson ("T8 The Agentic Layer"), kind (transcript | doc), ref (path relative to the
//             corpus root plus "@hh:mm:ss" for a transcript or "#heading" for a doc), text, originId
//   identity  originId makes imports idempotent ("idd:<relpath>:<n>"); to re-chunk a source, wipe it and import again
//   recall    FTS5 (porter stemming) and local embeddings fused by reciprocal rank, exactly like memory.ts; keyword
//             search alone when the embedder is down
//   lesson    a filter matches the whole lesson name or its first word: "T8" matches "T8 The Agentic Layer", not "T80 …"
import { chmodSync, closeSync, existsSync, openSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, GenerationTask, hook } from "@earendil-works/pi-durable";
import { ftsQuery, type Embedder } from "./memory.js";
import { text } from "./toolkit-common.js";

export const LIBRARY_KINDS = ["transcript", "doc"] as const;
export type LibraryKind = (typeof LIBRARY_KINDS)[number];

export interface LibraryItem {
  id: number;
  source: string;
  lesson: string;
  kind: LibraryKind;
  ref: string;
  text: string;
  originId: string;
  createdAt: string;
}

/** A recalled passage: `score` is its fused rank score, `similarity` its cosine to the query when it was embedded. */
export type LibraryHit = LibraryItem & { score: number; similarity?: number };

export interface NewLibraryItem {
  source: string;
  lesson: string;
  kind: LibraryKind;
  ref: string;
  text: string;
  originId: string;
}

export interface RecallOptions {
  lesson?: string;
  source?: string;
  limit?: number;
}

const MAX_TEXT = 12_000;
const RRF_K = 60;
const CANDIDATES = 50;

const str = (value: unknown, name: string, max: number) => {
  const s = typeof value === "string" ? value.trim() : "";
  if (!s) throw Error(`${name} is required`);
  if (s.length > max) throw Error(`${name} must be under ${max} characters`);
  return s;
};

export function validLibraryItem(input: Partial<NewLibraryItem>): NewLibraryItem {
  const source = str(input.source, "source", 40);
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(source)) throw Error("source must be lowercase letters, digits, - or _");
  if (!LIBRARY_KINDS.includes(input.kind as LibraryKind)) throw Error(`kind must be one of ${LIBRARY_KINDS.join(", ")}`);
  return {
    source,
    lesson: str(input.lesson, "lesson", 120),
    kind: input.kind as LibraryKind,
    ref: str(input.ref, "ref", 400),
    text: str(input.text, "text", MAX_TEXT),
    originId: str(input.originId, "originId", 300),
  };
}

/** "T8" and "t8 the agentic layer" match "T8 The Agentic Layer"; a bare number means that lesson ("8" → "T8"). */
export function lessonMatches(lesson: string, filter: string) {
  const f = (/^\d+$/.test(filter.trim()) ? `t${filter.trim()}` : filter.trim()).toLowerCase();
  const l = lesson.toLowerCase();
  return !f || l === f || l.startsWith(`${f} `);
}

const dot = (a: Float32Array, b: Float32Array) => {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
};

/** A type alias (not the interface) so node:sqlite's row records cast to it. */
type Row = { [K in keyof LibraryItem]: LibraryItem[K] };
const COLUMNS = "id, source, lesson, kind, ref, text, originId, createdAt";

export class LibraryStore {
  /** Every item's vector, loaded once and kept current: id -> [source, lesson, vector]. */
  private vectors?: Map<number, [string, string, Float32Array]>;
  private backfillTimer?: NodeJS.Timeout;
  private backfilling = false;
  lastEmbedError?: string;

  private constructor(
    private readonly db: DatabaseSync,
    readonly embedder?: Embedder,
  ) {}

  static open(path: string, embedder?: Embedder) {
    // Paid personal material: owner-only before SQLite opens it (its -wal and -shm follow).
    if (!existsSync(path)) closeSync(openSync(path, "a", 0o600));
    chmodSync(path, 0o600);
    const db = new DatabaseSync(path);
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS items (
        id INTEGER PRIMARY KEY,
        source TEXT NOT NULL,
        lesson TEXT NOT NULL,
        kind TEXT NOT NULL,
        ref TEXT NOT NULL,
        text TEXT NOT NULL,
        originId TEXT NOT NULL UNIQUE,
        createdAt TEXT NOT NULL,
        embedding BLOB
      );
      CREATE INDEX IF NOT EXISTS items_source ON items(source, lesson);
      CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(text, content='items', content_rowid='id', tokenize='porter unicode61');
      CREATE TRIGGER IF NOT EXISTS items_ai AFTER INSERT ON items BEGIN
        INSERT INTO items_fts(rowid, text) VALUES (new.id, new.text);
      END;
      CREATE TRIGGER IF NOT EXISTS items_ad AFTER DELETE ON items BEGIN
        INSERT INTO items_fts(items_fts, rowid, text) VALUES ('delete', old.id, old.text);
      END;
    `);
    const store = new LibraryStore(db, embedder);
    if (embedder) store.scheduleBackfill(0);
    return store;
  }

  close() {
    clearTimeout(this.backfillTimer);
    this.backfillTimer = undefined;
    this.db.close();
  }

  pendingEmbeddings() {
    return (this.db.prepare("SELECT count(*) AS n FROM items WHERE embedding IS NULL").get() as { n: number }).n;
  }

  private scheduleBackfill(delayMs: number) {
    if (!this.embedder || this.backfillTimer) return;
    this.backfillTimer = setTimeout(() => {
      this.backfillTimer = undefined;
      void this.backfill().then(
        (n) => this.scheduleBackfill(n > 0 ? 0 : 30_000),
        (e) => {
          this.lastEmbedError = e instanceof Error ? e.message : String(e);
          this.scheduleBackfill(30_000);
        },
      );
    }, delayMs);
    this.backfillTimer.unref?.();
  }

  /** Embed up to `batch` items that have no vector yet; returns how many it embedded. */
  async backfill(batch = 32): Promise<number> {
    if (!this.embedder || this.backfilling) return 0;
    this.backfilling = true;
    try {
      const rows = this.db
        .prepare("SELECT id, source, lesson, text FROM items WHERE embedding IS NULL ORDER BY id LIMIT ?")
        .all(batch) as { id: number; source: string; lesson: string; text: string }[];
      if (!rows.length) return 0;
      const vectors = await this.embedder.embed(rows.map((r) => r.text), "document");
      const update = this.db.prepare("UPDATE items SET embedding = ? WHERE id = ?");
      this.db.exec("BEGIN");
      try {
        rows.forEach((r, i) => update.run(new Uint8Array(vectors[i].buffer, vectors[i].byteOffset, vectors[i].byteLength), r.id));
        this.db.exec("COMMIT");
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
      // An item wiped while its batch was embedding has no row left; only cache vectors of rows that still exist.
      rows.forEach((r, i) => this.vectors && this.get(r.id) && this.vectors.set(r.id, [r.source, r.lesson, vectors[i]]));
      this.lastEmbedError = undefined;
      return rows.length;
    } finally {
      this.backfilling = false;
    }
  }

  private loadVectors() {
    if (this.vectors) return this.vectors;
    const map = new Map<number, [string, string, Float32Array]>();
    for (const r of this.db.prepare("SELECT id, source, lesson, embedding FROM items WHERE embedding IS NOT NULL").all() as {
      id: number;
      source: string;
      lesson: string;
      embedding: Uint8Array;
    }[]) {
      const b = r.embedding;
      map.set(r.id, [r.source, r.lesson, new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4)]);
    }
    return (this.vectors = map);
  }

  /** Store one passage; an originId already present is skipped (returns the stored item). */
  add(input: Partial<NewLibraryItem>): { item: LibraryItem; created: boolean } {
    const it = validLibraryItem(input);
    const existing = this.db.prepare(`SELECT ${COLUMNS} FROM items WHERE originId = ?`).get(it.originId) as Row | undefined;
    if (existing) return { item: { ...existing }, created: false };
    const row = this.db
      .prepare(`INSERT INTO items(source, lesson, kind, ref, text, originId, createdAt) VALUES (?,?,?,?,?,?,?) RETURNING ${COLUMNS}`)
      .get(it.source, it.lesson, it.kind, it.ref, it.text, it.originId, new Date().toISOString()) as Row;
    this.scheduleBackfill(0);
    return { item: { ...row }, created: true };
  }

  /** Many at once in one transaction; invalid items are counted, not fatal. */
  addMany(items: Partial<NewLibraryItem>[]) {
    let added = 0;
    let skipped = 0;
    const errors: string[] = [];
    this.db.exec("BEGIN");
    try {
      for (const item of items) {
        try {
          if (this.add(item ?? {}).created) added++;
          else skipped++;
        } catch (e) {
          errors.push(e instanceof Error ? e.message : String(e));
        }
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return { added, skipped, invalid: errors.length, errors: [...new Set(errors)].slice(0, 5) };
  }

  get(id: number): LibraryItem | undefined {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM items WHERE id = ?`).get(id) as Row | undefined;
    return row ? { ...row } : undefined;
  }

  /** Keyword search (bm25), optionally within one lesson or source. */
  search(query: string, opts: RecallOptions = {}): LibraryItem[] {
    const limit = Math.min(100, Math.max(1, Math.floor(opts.limit ?? 10)));
    const match = ftsQuery(query);
    if (!match) return [];
    // The lesson filter runs in JS (lessonMatches), so over-fetch when one is set.
    const rows = this.db
      .prepare(
        `SELECT ${COLUMNS.split(", ").map((c) => `i.${c}`).join(", ")} FROM items_fts f JOIN items i ON i.id = f.rowid
         WHERE items_fts MATCH ? ${opts.source ? "AND i.source = ?" : ""}
         ORDER BY bm25(items_fts), i.id LIMIT ?`,
      )
      .all(...[match, ...(opts.source ? [opts.source] : []), opts.lesson ? 2000 : limit]) as Row[];
    return rows.filter((r) => !opts.lesson || lessonMatches(r.lesson, opts.lesson)).slice(0, limit).map((r) => ({ ...r }));
  }

  /**
   * Semantic and keyword recall fused by reciprocal rank, as in memory.ts. Without an embedder, or when the query
   * cannot be embedded in time, it is the keyword search.
   */
  async recall(query: string, opts: RecallOptions = {}): Promise<LibraryHit[]> {
    const limit = Math.min(50, Math.max(1, Math.floor(opts.limit ?? 8)));
    const keyword = this.search(query, { ...opts, limit: CANDIDATES });
    const keywordOnly = () => keyword.slice(0, limit).map((it, i) => ({ ...it, score: 1 / (RRF_K + i + 1) }));
    if (!this.embedder || !query.trim()) return keywordOnly();
    let q: Float32Array;
    try {
      [q] = await this.embedder.embed([query.slice(0, 2000)], "query");
    } catch (e) {
      this.lastEmbedError = e instanceof Error ? e.message : String(e);
      return keywordOnly();
    }
    this.scheduleBackfill(0);
    const pending = this.pendingEmbeddings();
    if (pending > 0 && pending <= 64) await this.backfill(64).catch(() => 0);
    const semantic: [number, number][] = [];
    for (const [id, [source, lesson, v]] of this.loadVectors()) {
      if (opts.source && source !== opts.source) continue;
      if (opts.lesson && !lessonMatches(lesson, opts.lesson)) continue;
      semantic.push([id, dot(q, v)]);
    }
    semantic.sort((a, b) => b[1] - a[1]);
    const similarity = new Map<number, number>();
    const score = new Map<number, number>();
    semantic.slice(0, CANDIDATES).forEach(([id, sim], i) => {
      similarity.set(id, sim);
      score.set(id, (score.get(id) ?? 0) + 1 / (RRF_K + i + 1));
    });
    keyword.forEach((it, i) => score.set(it.id, (score.get(it.id) ?? 0) + 1 / (RRF_K + i + 1)));
    const vectors = this.loadVectors();
    return [...score.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .flatMap(([id, s]) => {
        const it = this.get(id);
        if (!it) return [];
        const v = vectors.get(id);
        const sim = similarity.get(id) ?? (v ? dot(q, v[2]) : undefined);
        return [{ ...it, score: s, ...(sim === undefined ? {} : { similarity: sim }) }];
      });
  }

  /** Delete every passage of one source; returns how many went. */
  wipe(source: string) {
    const ids = this.db.prepare("DELETE FROM items WHERE source = ? RETURNING id").all(source) as { id: number }[];
    for (const { id } of ids) this.vectors?.delete(id);
    return { source, deleted: ids.length };
  }

  stats() {
    const rows = this.db.prepare("SELECT source, lesson, kind, count(*) AS n FROM items GROUP BY source, lesson, kind").all() as {
      source: string;
      lesson: string;
      kind: string;
      n: number;
    }[];
    const bySource: Record<string, number> = {};
    const byKind: Record<string, number> = {};
    const byLesson: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      bySource[r.source] = (bySource[r.source] ?? 0) + r.n;
      byKind[r.kind] = (byKind[r.kind] ?? 0) + r.n;
      byLesson[r.lesson] = (byLesson[r.lesson] ?? 0) + r.n;
      total += r.n;
    }
    return {
      total,
      bySource,
      byKind,
      byLesson,
      ...(this.embedder ? { pendingEmbeddings: this.pendingEmbeddings(), ...(this.lastEmbedError ? { embedError: this.lastEmbedError } : {}) } : {}),
    };
  }
}

// ------------------------------------------------------------------ the extension

export const LIBRARY_PREAMBLE =
  "# Course library (passages recalled for this request)\nPassages from the user's course material that match the message. Use them when they help, and name the lesson when you draw on one; library_recall finds more.";

const where = (h: LibraryItem) => `${h.lesson} · ${h.ref} (${h.kind})`;

/** One passage as the tool and the auto-recall block show it. */
export const passage = (h: LibraryHit, max = 2_000) =>
  `[${where(h)}]\n${h.text.length > max ? `${h.text.slice(0, max)} …` : h.text}`;

/**
 * Is a hit relevant enough to put in front of a run uninvited? With a vector: cosine similarity at or above
 * `minSimilarity`. Keyword-only: most of the query's words appear in the passage.
 */
export function relevant(h: LibraryHit, query: string, minSimilarity: number) {
  if (h.similarity !== undefined) return h.similarity >= minSimilarity;
  const words = ftsQuery(query).match(/"([^"]+)"/g)?.map((w) => w.slice(1, -1)) ?? [];
  if (words.length < 2) return false;
  const body = h.text.toLowerCase();
  return words.filter((w) => body.includes(w)).length / words.length >= 0.6;
}

const textOf = (content: string | readonly { type: string; text?: string }[]) =>
  typeof content === "string"
    ? content
    : content
        .filter((b) => b.type === "text" && b.text)
        .map((b) => b.text)
        .join("\n");

export function libraryAutoRecallSettings() {
  const sim = Number(process.env.DPI_LIBRARY_MIN_SIMILARITY);
  return {
    autoRecall: process.env.DPI_LIBRARY_AUTO_RECALL !== "off",
    minSimilarity: Number.isFinite(sim) && sim > 0 ? sim : 0.62,
    autoLimit: 2,
  };
}

export function createLibraryExtension(
  library: LibraryStore,
  opts: Partial<ReturnType<typeof libraryAutoRecallSettings>> = {},
) {
  const settings = { ...libraryAutoRecallSettings(), ...opts };
  const libraryRecall = defineTool({
    name: "library_recall",
    description:
      "Search the user's course library (lesson transcripts and course docs) by meaning and words. Returns passages with their lesson, a ref (file plus @timestamp for a transcript or #heading for a doc) and the text. Filter by lesson with its number or name, e.g. \"T8\".",
    parameters: Type.Object({
      query: Type.String({ description: "What to look for, in your own words." }),
      lesson: Type.Optional(Type.String({ description: 'Only this lesson, e.g. "T8" or "T8 The Agentic Layer".' })),
      limit: Type.Optional(Type.Number({ description: "Most passages (default 5, max 8)." })),
    }),
    replay: "safe",
    execute: async (args) => {
      const a = args as { query: string; lesson?: string; limit?: number };
      const limit = Math.min(8, Math.max(1, Math.floor(a.limit ?? 5)));
      const found = await library.recall(a.query, { lesson: a.lesson || undefined, limit });
      return text(found.map((h, i) => `${i + 1}. ${passage(h)}`).join("\n\n") || "No matching passages in the course library.");
    },
  });

  type Recalled = { block: string };
  return defineExtension({
    name: "library",
    tools: [libraryRecall],
    hooks: settings.autoRecall
      ? [
          hook(GenerationTask, {
            // Recall once per run against its latest user message; every request of the run carries the same block.
            beforeRequest: async (request, api, ctx) => {
              const at = request.messages.findLastIndex((m) => m.role === "user");
              if (at < 0) return;
              const target = request.messages[at] as Extract<(typeof request.messages)[number], { role: "user" }>;
              let got = await api.memo<Recalled>("library-recall", ctx);
              if (!got) {
                const user = textOf(target.content).trim();
                let block = "";
                if (user) {
                  try {
                    const found = (await library.recall(user, { limit: 8 })).filter((h) => relevant(h, user, settings.minSimilarity));
                    const top = found.slice(0, settings.autoLimit);
                    if (top.length) block = `${LIBRARY_PREAMBLE}\n\n${top.map((h) => `- ${passage(h, 1_200)}`).join("\n\n")}`;
                  } catch (e) {
                    console.error("[library] recall failed, run continues:", e instanceof Error ? e.message : e);
                  }
                }
                got = await api.memo<Recalled>("library-recall", { block }, ctx);
              }
              if (!got.block) return;
              const content =
                typeof target.content === "string"
                  ? `${got.block}\n\n${target.content}`
                  : [{ type: "text" as const, text: got.block }, ...target.content];
              const messages = [...request.messages];
              messages[at] = { ...target, content };
              return { messages };
            },
          }),
        ]
      : [],
  });
}
