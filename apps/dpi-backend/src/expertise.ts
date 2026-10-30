// Expertise: a document an agent writes about its own work and rewrites after each task, so it improves itself (IDD
// lesson T13, Agent Experts). A device-wide SQLite file (<dataDir>/expertise.sqlite, mode 600), apart from memory.sqlite
// and library.sqlite.
//
//   documents  one per name; the name is a session's name ("oracle", "exam"), matched case-insensitively like session
//              addressing, so every agent of a session reads and writes the same document
//   content    markdown, at most 8000 characters; an empty document has revision 0 and was never written
//   revisions  every write (including a reset to "") is a new revision with its full content and a reason, so the
//              earlier content stays readable; revision numbers count up from 1 per document
//   conflicts  a write may carry expectedRevision; when the document has moved on, it is refused (ExpertiseConflict)
import { chmodSync, closeSync, existsSync, openSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { text } from "./toolkit-common.js";

export const EXPERTISE_MAX_CHARS = 8000;
export const EXPERTISE_MAX_REASON = 500;
const MAX_NAME = 100;

export interface ExpertiseDoc {
  name: string;
  content: string;
  revision: number;
  updatedAt: string | null;
}

export interface ExpertiseRevision {
  revision: number;
  reason: string;
  createdAt: string;
  chars: number;
}

/** Bad input: an empty or long name, content over the limit, a missing or long reason. */
export class ExpertiseInvalid extends Error {}
/** expectedRevision is not the document's current revision. */
export class ExpertiseConflict extends Error {}

/** The document key for a name: trimmed and lower case, as session names are matched. */
export function expertiseName(name: unknown) {
  const n = typeof name === "string" ? name.trim().toLowerCase() : "";
  if (!n) throw new ExpertiseInvalid("name is required");
  if (n.length > MAX_NAME) throw new ExpertiseInvalid(`name must be at most ${MAX_NAME} characters`);
  return n;
}

function validContent(content: unknown) {
  if (typeof content !== "string") throw new ExpertiseInvalid("content must be a string");
  if (content.length > EXPERTISE_MAX_CHARS)
    throw new ExpertiseInvalid(`content is ${content.length} characters; the limit is ${EXPERTISE_MAX_CHARS}`);
  return content;
}

function validReason(reason: unknown) {
  const r = typeof reason === "string" ? reason.trim() : "";
  if (!r) throw new ExpertiseInvalid("reason is required");
  if (r.length > EXPERTISE_MAX_REASON) throw new ExpertiseInvalid(`reason must be at most ${EXPERTISE_MAX_REASON} characters`);
  return r;
}

function validExpected(expected: unknown) {
  if (expected === undefined || expected === null) return undefined;
  if (typeof expected !== "number" || !Number.isSafeInteger(expected) || expected < 0)
    throw new ExpertiseInvalid("expectedRevision must be a non-negative integer");
  return expected;
}

export class ExpertiseStore {
  private constructor(private readonly db: DatabaseSync) {}

  static open(path: string) {
    // Owner-only before SQLite opens it (its -wal and -shm follow).
    if (!existsSync(path)) closeSync(openSync(path, "a", 0o600));
    chmodSync(path, 0o600);
    const db = new DatabaseSync(path);
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS documents (
        name TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        revision INTEGER NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS revisions (
        name TEXT NOT NULL,
        revision INTEGER NOT NULL,
        content TEXT NOT NULL,
        reason TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        PRIMARY KEY (name, revision)
      );
    `);
    return new ExpertiseStore(db);
  }

  close() {
    this.db.close();
  }

  /** The current document; a name never written is empty at revision 0. */
  get(name: string): ExpertiseDoc {
    const key = expertiseName(name);
    const row = this.db.prepare("SELECT content, revision, updatedAt FROM documents WHERE name = ?").get(key) as
      | { content: string; revision: number; updatedAt: string }
      | undefined;
    return row ? { name: key, content: row.content, revision: row.revision, updatedAt: row.updatedAt } : { name: key, content: "", revision: 0, updatedAt: null };
  }

  /** Replace the whole document as a new revision. A stale expectedRevision throws ExpertiseConflict. */
  update(name: string, input: { content: unknown; reason: unknown; expectedRevision?: unknown }) {
    const key = expertiseName(name);
    const content = validContent(input.content);
    const reason = validReason(input.reason);
    const expected = validExpected(input.expectedRevision);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.get(key).revision;
      if (expected !== undefined && expected !== current)
        throw new ExpertiseConflict(`expertise ${key} is at revision ${current}, not ${expected}; read it again and redo the change`);
      const revision = current + 1;
      const updatedAt = new Date().toISOString();
      this.db.prepare("INSERT INTO revisions(name, revision, content, reason, createdAt) VALUES (?,?,?,?,?)").run(key, revision, content, reason, updatedAt);
      this.db
        .prepare(
          "INSERT INTO documents(name, content, revision, updatedAt) VALUES (?,?,?,?) ON CONFLICT(name) DO UPDATE SET content=excluded.content, revision=excluded.revision, updatedAt=excluded.updatedAt",
        )
        .run(key, content, revision, updatedAt);
      this.db.exec("COMMIT");
      return { name: key, revision, updatedAt };
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** Empty the document as a new revision; the history stays. */
  reset(name: string, input: { reason: unknown; expectedRevision?: unknown }) {
    const { name: key, revision } = this.update(name, { content: "", reason: input.reason, expectedRevision: input.expectedRevision });
    return { name: key, revision };
  }

  /** Revisions newest first, without their content. */
  revisions(name: string, limit = 20): ExpertiseRevision[] {
    const n = Math.min(200, Math.max(1, Math.floor(limit)));
    return (
      this.db
        .prepare("SELECT revision, reason, createdAt, length(content) AS chars FROM revisions WHERE name = ? ORDER BY revision DESC LIMIT ?")
        .all(expertiseName(name), n) as { [K in keyof ExpertiseRevision]: ExpertiseRevision[K] }[]
    ).map((r) => ({ revision: r.revision, reason: r.reason, createdAt: r.createdAt, chars: r.chars }));
  }

  /** One revision with its full content. */
  revision(name: string, revision: number) {
    const row = this.db
      .prepare("SELECT revision, content, reason, createdAt FROM revisions WHERE name = ? AND revision = ?")
      .get(expertiseName(name), revision) as { revision: number; content: string; reason: string; createdAt: string } | undefined;
    return row ? { ...row } : undefined;
  }
}

// ------------------------------------------------------------------ the extension

export const EXPERTISE_HEADER =
  "# Your expertise\nLessons you wrote from your own past work. Apply them. When one proves wrong or incomplete, revise it with expertise_update.";

/** The system section for a document: nothing while it is empty. */
export function expertiseSection(content: string) {
  return content.trim() ? `${EXPERTISE_HEADER}\n\n${content}` : undefined;
}

/**
 * The expertise add-on for one session. `sessionName` is read at every use, so the agents always use the document
 * named after their session, and every request reads the store, so a write through the API shows on the next request.
 */
export function createExpertiseExtension(expertise: ExpertiseStore, sessionName: () => string) {
  const read = defineTool({
    name: "expertise_read",
    description:
      "Read your expertise document: the lessons you wrote from your own past work, with its revision number. It is also in your system prompt whenever it is not empty.",
    parameters: Type.Object({}),
    replay: "safe",
    execute: async () => {
      const doc = expertise.get(sessionName());
      return text(
        doc.content
          ? `Expertise "${doc.name}", revision ${doc.revision}:\n\n${doc.content}`
          : `Expertise "${doc.name}" is empty (revision ${doc.revision}). Write your first lessons with expertise_update.`,
      );
    },
  });
  const update = defineTool({
    name: "expertise_update",
    description: `Rewrite your whole expertise document (markdown, at most ${EXPERTISE_MAX_CHARS} characters). After a task, keep the lessons that held, fix the ones that proved wrong or incomplete, add what you learned, and drop what no longer earns its place. Send the complete new document, not a diff, with a short reason for the change. Every revision is kept.`,
    parameters: Type.Object({
      content: Type.String({ description: `The complete new document, at most ${EXPERTISE_MAX_CHARS} characters.` }),
      reason: Type.String({ description: `Why it changed, in one sentence (at most ${EXPERTISE_MAX_REASON} characters).` }),
    }),
    replay: "unsafe",
    execute: async (args) => {
      const a = args as { content?: unknown; reason?: unknown };
      if (typeof a.content === "string" && a.content.length > EXPERTISE_MAX_CHARS)
        return text(
          `Not saved: the document is ${a.content.length} characters and the limit is ${EXPERTISE_MAX_CHARS}. Shorten it by at least ${a.content.length - EXPERTISE_MAX_CHARS} characters (merge or drop lessons) and call expertise_update again.`,
        );
      try {
        const saved = expertise.update(sessionName(), { content: a.content, reason: a.reason });
        return text(`Saved expertise "${saved.name}" as revision ${saved.revision}.`);
      } catch (e) {
        return text(`Not saved: ${e instanceof Error ? e.message : String(e)}. Fix it and call expertise_update again.`);
      }
    },
  });
  return defineExtension({
    name: "expertise",
    tools: [read, update],
    sections: [section("expertise", () => expertiseSection(expertise.get(sessionName()).content), { tag: false })],
  });
}
