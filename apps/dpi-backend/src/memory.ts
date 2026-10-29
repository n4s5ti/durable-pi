// DPI memory: one long-term memory for the oracle, its voice (Bags) and Hermes. A device-wide SQLite file
// (<dataDir>/memory.sqlite) with full-text search, so it needs no extra server.
//
//   kinds     fact | preference | feedback | event | observation
//             feedback = a standing rule from the user about how DPI or Bags should behave. Active
//             feedback is put in front of every run (and the voice reads it at session start), so the
//             user's corrections change behaviour from the next request on.
//   search    FTS5 bm25 over the words of the query, newest first on ties
//   identity  originId makes imports idempotent (e.g. "hindsight:<bank>:<id>"); exact duplicates of an
//             active memory's kind and text are not stored twice
//   forget    soft: the row stays with active=0 and a reason, so nothing is lost by mistake
import { chmodSync, closeSync, existsSync, openSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, GenerationTask, hook, section } from "@earendil-works/pi-durable";
import { text } from "./toolkit-common.js";

export const MEMORY_KINDS = ["fact", "preference", "feedback", "event", "observation"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export interface Memory {
  id: number;
  kind: MemoryKind;
  text: string;
  source: string;
  tags: string[];
  occurredAt?: string;
  createdAt: string;
  originId?: string;
  active: boolean;
}

export interface NewMemory {
  kind: MemoryKind;
  text: string;
  source?: string;
  tags?: string[];
  occurredAt?: string;
  originId?: string;
}

const MAX_TEXT = 8_000;
const STOP = new Set(
  "a an and are as at be but by do does for from has have how i if in is it its me my of on or our so that the their them then there these they this to was we were what when where which who why will with you your".split(
    " ",
  ),
);

/** The words of a query as an FTS5 OR-expression, each quoted so no word is read as syntax. */
export function ftsQuery(query: string): string {
  const words = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) ?? [])].filter((w) => !STOP.has(w));
  return words.slice(0, 32).map((w) => `"${w.replaceAll('"', "")}"`).join(" OR ");
}

export function validMemory(input: Partial<NewMemory>): NewMemory {
  if (!MEMORY_KINDS.includes(input.kind as MemoryKind)) throw Error(`kind must be one of ${MEMORY_KINDS.join(", ")}`);
  const body = typeof input.text === "string" ? input.text.trim() : "";
  if (!body) throw Error("text is required");
  if (body.length > MAX_TEXT) throw Error(`text must be under ${MAX_TEXT} characters`);
  const tags = Array.isArray(input.tags) ? input.tags.filter((t) => typeof t === "string" && t.trim()).map((t) => t.trim().slice(0, 80)) : [];
  return {
    kind: input.kind as MemoryKind,
    text: body,
    source: typeof input.source === "string" && input.source.trim() ? input.source.trim().slice(0, 80) : "dpi",
    tags: tags.slice(0, 20),
    ...(typeof input.occurredAt === "string" && input.occurredAt.trim() ? { occurredAt: input.occurredAt.trim().slice(0, 40) } : {}),
    ...(typeof input.originId === "string" && input.originId.trim() ? { originId: input.originId.trim().slice(0, 200) } : {}),
  };
}

type Row = {
  id: number;
  kind: MemoryKind;
  text: string;
  source: string;
  tags: string;
  occurredAt: string | null;
  createdAt: string;
  originId: string | null;
  active: number;
};

const toMemory = (r: Row): Memory => ({
  id: r.id,
  kind: r.kind,
  text: r.text,
  source: r.source,
  tags: JSON.parse(r.tags) as string[],
  ...(r.occurredAt ? { occurredAt: r.occurredAt } : {}),
  createdAt: r.createdAt,
  ...(r.originId ? { originId: r.originId } : {}),
  active: r.active === 1,
});

/** Turns text into vectors for semantic recall. Documents and queries may be embedded differently. */
export interface Embedder {
  embed(texts: string[], as: "document" | "query"): Promise<Float32Array[]>;
}

/** Ollama /api/embed (default nomic-embed-text, which wants search_document: / search_query: prefixes). */
export class OllamaEmbedder implements Embedder {
  constructor(
    readonly url = process.env.DPI_EMBED_URL || "http://127.0.0.1:11434",
    readonly model = process.env.DPI_EMBED_MODEL || "nomic-embed-text:latest",
    readonly timeoutMs = 60_000,
  ) {}

  async embed(texts: string[], as: "document" | "query") {
    const prefix = this.model.startsWith("nomic-embed-text") ? (as === "query" ? "search_query: " : "search_document: ") : "";
    const res = await fetch(`${this.url.replace(/\/$/, "")}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.model, input: texts.map((t) => prefix + t.slice(0, 6000)), keep_alive: "30m" }),
      signal: AbortSignal.timeout(as === "query" ? Math.min(this.timeoutMs, 5_000) : this.timeoutMs),
    });
    if (!res.ok) throw Error(`embed ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { embeddings?: number[][] };
    if (!body.embeddings || body.embeddings.length !== texts.length) throw Error("embed returned the wrong number of vectors");
    return body.embeddings.map(normalized);
  }
}

function normalized(v: ArrayLike<number>) {
  const out = Float32Array.from(v);
  let norm = 0;
  for (const x of out) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

const dot = (a: Float32Array, b: Float32Array) => {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
};

const RRF_K = 60;
const CANDIDATES = 50;

export class MemoryStore {
  /** Active memories' vectors, loaded once and kept current: id -> [kind, vector]. */
  private vectors?: Map<number, [MemoryKind, Float32Array]>;
  private backfillTimer?: NodeJS.Timeout;
  private backfilling = false;
  lastEmbedError?: string;

  private constructor(
    private readonly db: DatabaseSync,
    readonly embedder?: Embedder,
  ) {}

  static open(path: string, embedder?: Embedder) {
    // Memories are private: create the file owner-only before SQLite opens it (its -wal and -shm follow).
    if (!existsSync(path)) closeSync(openSync(path, "a", 0o600));
    chmodSync(path, 0o600);
    const db = new DatabaseSync(path);
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY,
        kind TEXT NOT NULL,
        text TEXT NOT NULL,
        source TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        occurredAt TEXT,
        createdAt TEXT NOT NULL,
        originId TEXT UNIQUE,
        active INTEGER NOT NULL DEFAULT 1,
        forgottenReason TEXT
      );
      CREATE INDEX IF NOT EXISTS memories_kind ON memories(kind, active);
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(text, tags, content='memories', content_rowid='id');
      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, text, tags) VALUES (new.id, new.text, new.tags);
      END;
      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, text, tags) VALUES ('delete', old.id, old.text, old.tags);
      END;
    `);
    const columns = (db.prepare("PRAGMA table_info(memories)").all() as { name: string }[]).map((c) => c.name);
    if (!columns.includes("embedding")) db.exec("ALTER TABLE memories ADD COLUMN embedding BLOB");
    const store = new MemoryStore(db, embedder);
    if (embedder) store.scheduleBackfill(0);
    return store;
  }

  close() {
    clearTimeout(this.backfillTimer);
    this.backfillTimer = undefined;
    this.db.close();
  }

  /** Memories still waiting for a vector. */
  pendingEmbeddings() {
    return (this.db.prepare("SELECT count(*) AS n FROM memories WHERE active = 1 AND embedding IS NULL").get() as { n: number }).n;
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

  /** Embed up to `batch` memories that have no vector yet; returns how many it embedded. */
  async backfill(batch = 64): Promise<number> {
    if (!this.embedder || this.backfilling) return 0;
    this.backfilling = true;
    try {
      const rows = this.db
        .prepare("SELECT id, kind, text, tags FROM memories WHERE active = 1 AND embedding IS NULL ORDER BY id LIMIT ?")
        .all(batch) as { id: number; kind: MemoryKind; text: string; tags: string }[];
      if (!rows.length) return 0;
      const vectors = await this.embedder.embed(rows.map((r) => r.text), "document");
      const update = this.db.prepare("UPDATE memories SET embedding = ? WHERE id = ?");
      this.db.exec("BEGIN");
      try {
        rows.forEach((r, i) => update.run(new Uint8Array(vectors[i].buffer), r.id));
        this.db.exec("COMMIT");
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
      rows.forEach((r, i) => this.vectors?.set(r.id, [r.kind, vectors[i]]));
      this.lastEmbedError = undefined;
      return rows.length;
    } finally {
      this.backfilling = false;
    }
  }

  private loadVectors() {
    if (this.vectors) return this.vectors;
    const map = new Map<number, [MemoryKind, Float32Array]>();
    for (const r of this.db.prepare("SELECT id, kind, embedding FROM memories WHERE active = 1 AND embedding IS NOT NULL").all() as {
      id: number;
      kind: MemoryKind;
      embedding: Uint8Array;
    }[]) {
      const bytes = r.embedding;
      map.set(r.id, [r.kind, new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)]);
    }
    return (this.vectors = map);
  }

  /**
   * Semantic and keyword recall fused by reciprocal rank: the best of both lists rise, either alone still counts.
   * Without an embedder, or when the query cannot be embedded in time, it is the keyword search.
   */
  async recall(query: string, opts: { kinds?: MemoryKind[]; limit?: number } = {}): Promise<Memory[]> {
    const limit = Math.min(100, Math.max(1, Math.floor(opts.limit ?? 10)));
    const keyword = this.search(query, { kinds: opts.kinds, limit: CANDIDATES });
    if (!this.embedder || !query.trim()) return keyword.slice(0, limit);
    let q: Float32Array;
    try {
      [q] = await this.embedder.embed([query.slice(0, 2000)], "query");
    } catch (e) {
      this.lastEmbedError = e instanceof Error ? e.message : String(e);
      return keyword.slice(0, limit);
    }
    this.scheduleBackfill(0);
    const kinds = opts.kinds?.length ? new Set(opts.kinds) : undefined;
    const semantic: [number, number][] = [];
    for (const [id, [kind, v]] of this.loadVectors()) if (!kinds || kinds.has(kind)) semantic.push([id, dot(q, v)]);
    semantic.sort((a, b) => b[1] - a[1]);
    const score = new Map<number, number>();
    semantic.slice(0, CANDIDATES).forEach(([id], i) => score.set(id, (score.get(id) ?? 0) + 1 / (RRF_K + i + 1)));
    keyword.forEach((m, i) => score.set(m.id, (score.get(m.id) ?? 0) + 1 / (RRF_K + i + 1)));
    const ranked = [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
    return ranked.map(([id]) => this.get(id)).filter((m): m is Memory => !!m && m.active);
  }

  /** Store one memory; returns the existing one for a known originId or an identical active memory. */
  add(input: Partial<NewMemory>): { memory: Memory; created: boolean } {
    const m = validMemory(input);
    const existing = (
      m.originId
        ? this.db.prepare("SELECT * FROM memories WHERE originId = ?").get(m.originId)
        : this.db.prepare("SELECT * FROM memories WHERE kind = ? AND text = ? AND active = 1").get(m.kind, m.text)
    ) as Row | undefined;
    if (existing) return { memory: toMemory(existing), created: false };
    const row = this.db
      .prepare(
        "INSERT INTO memories(kind, text, source, tags, occurredAt, createdAt, originId) VALUES (?,?,?,?,?,?,?) RETURNING *",
      )
      .get(m.kind, m.text, m.source!, JSON.stringify(m.tags ?? []), m.occurredAt ?? null, new Date().toISOString(), m.originId ?? null) as Row;
    this.scheduleBackfill(0);
    return { memory: toMemory(row), created: true };
  }

  /** Many at once in one transaction; invalid items are counted, not fatal. */
  addMany(items: Partial<NewMemory>[]) {
    let added = 0;
    let skipped = 0;
    const errors: string[] = [];
    this.db.exec("BEGIN");
    try {
      for (const item of items) {
        try {
          if (this.add(item).created) added++;
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

  search(query: string, opts: { kinds?: MemoryKind[]; limit?: number } = {}): Memory[] {
    const limit = Math.min(100, Math.max(1, Math.floor(opts.limit ?? 10)));
    const kinds = (opts.kinds ?? []).filter((k) => MEMORY_KINDS.includes(k));
    const kindSql = kinds.length ? `AND m.kind IN (${kinds.map(() => "?").join(",")})` : "";
    const match = ftsQuery(query);
    if (!match) {
      return (
        this.db
          .prepare(`SELECT * FROM memories m WHERE active = 1 ${kindSql} ORDER BY id DESC LIMIT ?`)
          .all(...kinds, limit) as Row[]
      ).map(toMemory);
    }
    return (
      this.db
        .prepare(
          `SELECT m.* FROM memories_fts f JOIN memories m ON m.id = f.rowid
           WHERE memories_fts MATCH ? AND m.active = 1 ${kindSql}
           ORDER BY bm25(memories_fts), m.id DESC LIMIT ?`,
        )
        .all(match, ...kinds, limit) as Row[]
    ).map(toMemory);
  }

  /** Active feedback, oldest first: the user's standing rules for DPI and Bags. */
  rules(limit = 50): Memory[] {
    return (
      this.db
        .prepare("SELECT * FROM (SELECT * FROM memories WHERE kind = 'feedback' AND active = 1 ORDER BY id DESC LIMIT ?) ORDER BY id")
        .all(limit) as Row[]
    ).map(toMemory);
  }

  get(id: number): Memory | undefined {
    const row = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as Row | undefined;
    return row ? toMemory(row) : undefined;
  }

  forget(id: number, reason: string): Memory {
    const row = this.db
      .prepare("UPDATE memories SET active = 0, forgottenReason = ? WHERE id = ? RETURNING *")
      .get(reason.slice(0, 500) || "forgotten", id) as Row | undefined;
    if (!row) throw Error(`No memory ${id}`);
    this.vectors?.delete(id);
    return toMemory(row);
  }

  stats() {
    const rows = this.db.prepare("SELECT kind, active, count(*) AS n FROM memories GROUP BY kind, active").all() as {
      kind: string;
      active: number;
      n: number;
    }[];
    const byKind: Record<string, number> = {};
    let total = 0;
    let forgotten = 0;
    for (const r of rows) {
      if (r.active) {
        byKind[r.kind] = (byKind[r.kind] ?? 0) + r.n;
        total += r.n;
      } else forgotten += r.n;
    }
    return {
      total,
      forgotten,
      byKind,
      ...(this.embedder ? { pendingEmbeddings: this.pendingEmbeddings(), ...(this.lastEmbedError ? { embedError: this.lastEmbedError } : {}) } : {}),
    };
  }
}

const line = (m: Memory) => `[${m.id}] (${m.kind}${m.occurredAt ? `, ${m.occurredAt.slice(0, 10)}` : ""}) ${m.text}`;

export const RECALL_PREAMBLE =
  "# DPI memory (recalled for this request)\nLong-term memories that match the user's message. Use them; do not look up what is already here.";

export function rulesBlock(rules: Memory[]) {
  if (!rules.length) return "";
  return (
    "# Standing feedback from the user\nThese are the user's corrections about how you work. Follow them; they override your defaults.\n" +
    rules.map((r) => `- ${r.text}`).join("\n")
  );
}

const textOf = (content: string | readonly { type: string; text?: string }[]) =>
  typeof content === "string"
    ? content
    : content
        .filter((b) => b.type === "text" && b.text)
        .map((b) => b.text)
        .join("\n");

export function createMemoryExtension(memory: MemoryStore, opts: { recallLimit?: number } = {}) {
  const remember = defineTool({
    name: "remember",
    description:
      "Store something in DPI's long-term memory, shared with the voice (Bags) and Hermes. kind: fact (about the user, projects, the world), preference (how the user likes things), feedback (a correction or instruction from the user about how you or Bags should behave; it becomes a standing rule for every future request), event (something that happened, with occurred_at), observation (a conclusion you drew). Store durable things only, one memory per call, in a plain self-contained sentence.",
    parameters: Type.Object({
      kind: Type.Union(MEMORY_KINDS.map((k) => Type.Literal(k))),
      text: Type.String({ description: "The memory, one self-contained sentence or short paragraph." }),
      tags: Type.Optional(Type.Array(Type.String(), { description: "Optional tags, e.g. a project name." })),
      occurred_at: Type.Optional(Type.String({ description: "ISO date of an event, when it has one." })),
    }),
    replay: "unsafe",
    execute: async (args) => {
      const a = args as { kind: MemoryKind; text: string; tags?: string[]; occurred_at?: string };
      const { memory: m, created } = memory.add({ kind: a.kind, text: a.text, tags: a.tags, occurredAt: a.occurred_at, source: "dpi" });
      return text(created ? `Remembered as memory ${m.id}.` : `Already remembered as memory ${m.id}.`);
    },
  });
  const recall = defineTool({
    name: "recall",
    description: "Search DPI's long-term memory by words. Returns matching memories with their ids, newest first on ties.",
    parameters: Type.Object({
      query: Type.String({ description: "Words to search for." }),
      kind: Type.Optional(Type.Union(MEMORY_KINDS.map((k) => Type.Literal(k)))),
      limit: Type.Optional(Type.Number({ description: "Most results (default 10, max 50)." })),
    }),
    replay: "safe",
    execute: async (args) => {
      const a = args as { query: string; kind?: MemoryKind; limit?: number };
      const found = await memory.recall(a.query, { kinds: a.kind ? [a.kind] : undefined, limit: Math.min(50, a.limit ?? 10) });
      return text(found.map(line).join("\n") || "No matching memories.");
    },
  });
  const forget = defineTool({
    name: "forget",
    description:
      "Retire a memory that is wrong or out of date, by id (from recall). It stops being recalled; the record is kept. Use it when the user withdraws a piece of feedback or corrects a fact, then remember the corrected version.",
    parameters: Type.Object({
      id: Type.Number(),
      reason: Type.String({ description: "Why it is retired." }),
    }),
    replay: "unsafe",
    execute: async (args) => {
      const a = args as { id: number; reason: string };
      const m = memory.forget(Math.floor(a.id), a.reason);
      return text(`Forgot memory ${m.id}.`);
    },
  });

  type Recalled = { block: string };
  return defineExtension({
    name: "memory",
    tools: [remember, recall, forget],
    sections: [
      section(
        "memory",
        () =>
          [
            "# Memory\nYou have one long-term memory, shared with your voice and with Hermes. Matching memories are recalled into each request automatically; use recall for more. When the user corrects how you or Bags behave, or tells you how they want things done, store it with remember kind feedback. Store new durable facts and preferences as you learn them. Retire wrong memories with forget.",
            rulesBlock(memory.rules()),
          ]
            .filter(Boolean)
            .join("\n\n"),
        { tag: false },
      ),
    ],
    hooks: [
      hook(GenerationTask, {
        // Recall once per run against its latest user message; every request of the run carries the same block.
        beforeRequest: async (request, api, ctx) => {
          const at = request.messages.findLastIndex((m) => m.role === "user");
          if (at < 0) return;
          const target = request.messages[at] as Extract<(typeof request.messages)[number], { role: "user" }>;
          let got = await api.memo<Recalled>("memory-recall", ctx);
          if (!got) {
            const user = textOf(target.content).trim();
            let block = "";
            if (user) {
              try {
                const found = await memory.recall(user, { kinds: ["fact", "preference", "event", "observation"], limit: opts.recallLimit ?? 8 });
                if (found.length) block = `${RECALL_PREAMBLE}\n\n${found.map((m) => `- ${line(m)}`).join("\n")}`;
              } catch (e) {
                console.error("[memory] recall failed, run continues:", e instanceof Error ? e.message : e);
              }
            }
            got = await api.memo<Recalled>("memory-recall", { block }, ctx);
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
    ],
  });
}
