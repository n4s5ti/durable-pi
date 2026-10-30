// Skills: the procedures the user's agents share (Hermes and OMP read the same folders), searchable and viewable by
// Durable Pi agents, and patchable one lesson at a time.
//
//   roots      DPI_SKILL_DIRS (colon-separated), default the Hermes and pi-agent skill folders. A skill is a directory
//              holding SKILL.md with YAML front matter `name` and `description`; skills may sit in category folders
//              and inside other skills. Symlinked entries resolve to their real path and each real directory counts
//              once; on a name collision the first root (then the first path in sorted order) wins.
//   index      read lazily and cached; at most every CHECK_MS the folders and SKILL.md files it saw are stat'ed again,
//              and any changed mtime rebuilds it, so a new or edited skill shows without a restart
//   update     a targeted patch only (old_string exactly once) on SKILL.md or an existing file under references/,
//              compare-and-swap on the file's sha256, front matter checked, written atomically to the real path
//              (symlinks stay), the old content kept under <dataDir>/skill-revisions/<name>/ (dir 700, files 600)
//              and one JSONL audit line per write. No create, delete or whole-file write.
import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, GenerationTask, hook, section } from "@earendil-works/pi-durable";
import { text } from "./toolkit-common.js";

export const DEFAULT_SKILL_DIRS = "/home/n4s5ti/.local/share/hermes-home/skills:/home/n4s5ti/.local/share/pi-agent/skills";
/** Text one skill_view hands the model. */
export const SKILL_VIEW_MAX_CHARS = 40_000;
/** The largest file skill_view reads or skill_update writes. */
export const SKILL_FILE_MAX_BYTES = 512 * 1024;
const MAX_DEPTH = 6;
const CHECK_MS = 2000;
const LINKED_DIRS = ["references", "templates", "scripts", "assets"];
const SKIP_DIRS = new Set([...LINKED_DIRS, "node_modules", "__pycache__"]);

export class SkillNotFound extends Error {}
export class SkillInvalid extends Error {}
/** expected_sha256 is not the file's current sha256. */
export class SkillConflict extends Error {}

export interface Skill {
  name: string;
  description: string;
  /** The skill directory's real path. */
  path: string;
  /** The root it was found under, as configured. */
  root: string;
  /** Whether SKILL.md had front matter with a name. */
  frontmatter: boolean;
}

export interface SkillHit extends Skill {
  score: number;
}

/** Roots from DPI_SKILL_DIRS, or the default Hermes and pi-agent folders. */
export function skillRoots(value = process.env.DPI_SKILL_DIRS) {
  return (value?.trim() ? value : DEFAULT_SKILL_DIRS).split(":").map((s) => s.trim()).filter(Boolean);
}

export const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

// ------------------------------------------------------------------ front matter

const unquote = (v: string) => {
  const s = v.trim();
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    try {
      return String(JSON.parse(s));
    } catch {
      return s.slice(1, -1);
    }
  }
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) return s.slice(1, -1).replace(/''/g, "'");
  return s.replace(/\s+#.*$/, "");
};

/**
 * The top-level scalar keys of a SKILL.md's YAML front matter (plain, quoted, folded `>` and literal `|` values), or
 * undefined when the file has no closed front matter block. Nested maps and lists are skipped.
 */
export function parseFrontmatter(content: string): Record<string, string> | undefined {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(content.replace(/^\uFEFF/, ""));
  if (!m) return undefined;
  const lines = m[1].split(/\r?\n/);
  const out: Record<string, string> = {};
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_][\w-]*):(?:[ \t]+(.*))?$/.exec(lines[i]);
    if (!kv) continue;
    const raw = (kv[2] ?? "").trim();
    const block = /^([>|])[+-]?$/.exec(raw);
    if (block || raw === "") {
      const body: string[] = [];
      while (i + 1 < lines.length && (/^[ \t]+\S/.test(lines[i + 1]) || lines[i + 1].trim() === "")) body.push(lines[++i].trim());
      // A bare key followed by a nested map or list is not a scalar.
      if (!block && body.some((l) => /^[\w-]+:(\s|$)/.test(l) || l.startsWith("- "))) continue;
      out[kv[1]] = block?.[1] === "|" ? body.join("\n").trim() : body.filter(Boolean).join(" ").trim();
    } else out[kv[1]] = unquote(raw);
  }
  return out;
}

function describe(content: string, dir: string) {
  const fm = parseFrontmatter(content);
  const name = fm?.name?.trim() || basename(dir);
  let description = fm?.description?.trim() ?? "";
  if (!description) {
    const body = fm ? content.replace(/^---[\s\S]*?\n---[^\n]*\n?/, "") : content;
    description = /^#+\s+(.+)$/m.exec(body)?.[1]?.trim() ?? "";
  }
  return { name, description: description.slice(0, 500), frontmatter: Boolean(fm?.name?.trim()) };
}

// ------------------------------------------------------------------ search

const STOP = new Set(
  "a an and are as at be by can do does for from has have how i if in into is it its me my of on or our so that the their them then there these this to use used uses using via was we what when where which who why will with you your user users".split(" "),
);
const stem = (w: string) => (w.length > 5 && w.endsWith("ing") ? w.slice(0, -3) : w.length > 4 && w.endsWith("ed") ? w.slice(0, -2) : w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
export const tokens = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2 && !STOP.has(w)).map(stem));

// ------------------------------------------------------------------ the index

type Indexed = Skill & { nameTokens: Set<string>; descTokens: Set<string> };
interface Snapshot {
  byName: Map<string, Indexed>;
  list: Indexed[];
  stamps: Map<string, number>;
  checkedAt: number;
  df: Map<string, number>;
}

const mtime = (path: string) => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return -1;
  }
};

const within = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

/** A relative path under a skill directory: no absolute paths, no `..`, no NUL. */
export function safeSkillPath(filePath: unknown) {
  if (typeof filePath !== "string" || !filePath.trim()) throw new SkillInvalid("file_path must be a relative path such as references/notes.md");
  const p = filePath.trim().replace(/\\/g, "/");
  if (isAbsolute(p) || p.startsWith("/") || /^[A-Za-z]:/.test(p)) throw new SkillInvalid(`file_path must be relative to the skill: ${JSON.stringify(filePath)}`);
  const parts = p.split("/").filter((s) => s && s !== ".");
  if (!parts.length || parts.some((s) => s === "..") || /\0/.test(p) || p.length > 300)
    throw new SkillInvalid(`file_path may not leave the skill folder: ${JSON.stringify(filePath)}`);
  return parts.join("/");
}

export interface SkillWho {
  session: string;
  agent: string;
}

export class SkillIndex {
  private snap?: Snapshot;
  readonly roots: string[];
  readonly dataDir: string;
  private readonly checkMs: number;

  constructor(opts: { roots?: string[]; dataDir: string; checkMs?: number }) {
    this.roots = opts.roots ?? skillRoots();
    this.dataDir = opts.dataDir;
    this.checkMs = opts.checkMs ?? CHECK_MS;
  }

  get revisionsDir() {
    return join(this.dataDir, "skill-revisions");
  }

  get auditPath() {
    return join(this.revisionsDir, "audit.jsonl");
  }

  /** The current index, rebuilt when a folder or SKILL.md it saw has changed. */
  private index(): Snapshot {
    const now = Date.now();
    const s = this.snap;
    if (s && now - s.checkedAt < this.checkMs) return s;
    if (s && [...s.stamps].every(([path, t]) => mtime(path) === t)) {
      s.checkedAt = now;
      return s;
    }
    this.snap = this.scan();
    return this.snap;
  }

  /** Drop the cache so the next read rescans. */
  invalidate() {
    this.snap = undefined;
  }

  private scan(): Snapshot {
    const stamps = new Map<string, number>();
    const seen = new Set<string>();
    const byName = new Map<string, Indexed>();
    const list: Indexed[] = [];
    const walk = (dir: string, depth: number, root: string) => {
      if (seen.has(dir)) return;
      seen.add(dir);
      stamps.set(dir, mtime(dir));
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
      } catch {
        return;
      }
      if (entries.some((e) => e.name === "SKILL.md")) {
        try {
          const file = realpathSync(join(dir, "SKILL.md"));
          stamps.set(file, mtime(file));
          const st = statSync(file);
          if (st.isFile() && st.size <= SKILL_FILE_MAX_BYTES) {
            const d = describe(readFileSync(file, "utf8"), dir);
            if (!byName.has(d.name)) {
              const skill: Indexed = { ...d, path: dir, root, nameTokens: tokens(d.name), descTokens: tokens(d.description) };
              byName.set(d.name, skill);
              list.push(skill);
            }
          }
        } catch {
          // A dangling SKILL.md symlink: not a skill.
        }
      }
      if (depth >= MAX_DEPTH) return;
      for (const e of entries) {
        if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
        if (!e.isDirectory() && !e.isSymbolicLink()) continue;
        try {
          const real = realpathSync(join(dir, e.name));
          if (statSync(real).isDirectory()) walk(real, depth + 1, root);
        } catch {
          // A dangling symlink.
        }
      }
    };
    for (const root of this.roots) {
      let real: string;
      try {
        real = realpathSync(root);
      } catch {
        stamps.set(root, -1);
        continue;
      }
      walk(real, 0, root);
    }
    const df = new Map<string, number>();
    for (const s of list) for (const t of new Set([...s.nameTokens, ...s.descTokens])) df.set(t, (df.get(t) ?? 0) + 1);
    return { byName, list, stamps, checkedAt: Date.now(), df };
  }

  private plain = (s: Indexed): Skill => ({ name: s.name, description: s.description, path: s.path, root: s.root, frontmatter: s.frontmatter });

  list(): Skill[] {
    return this.index().list.map(this.plain);
  }

  get(name: string): Skill | undefined {
    const s = this.index().byName.get(String(name ?? "").trim());
    return s && this.plain(s);
  }

  private require(name: unknown) {
    const n = typeof name === "string" ? name.trim() : "";
    if (!n) throw new SkillInvalid("name is required");
    const s = this.index().byName.get(n);
    if (!s) throw new SkillNotFound(`No skill named ${JSON.stringify(n)}; find one with skill_search`);
    return s;
  }

  /**
   * Skills ranked by IDF-weighted keyword overlap with the query: a word in the name counts three times one in the
   * description, and the whole name in the query adds more. `matched` is how many query words hit, `nameHits` how
   * many hit the name.
   */
  rank(query: string) {
    const snap = this.index();
    const q = tokens(query);
    const lower = query.toLowerCase();
    const n = snap.list.length || 1;
    const hits: (SkillHit & { matched: number; nameHits: number; named: boolean })[] = [];
    for (const s of snap.list) {
      let score = 0;
      let matched = 0;
      let nameHits = 0;
      for (const t of q) {
        const idf = Math.log(1 + n / (1 + (snap.df.get(t) ?? 0)));
        if (s.nameTokens.has(t)) {
          score += 3 * idf;
          matched++;
          nameHits++;
        } else if (s.descTokens.has(t)) {
          score += idf;
          matched++;
        }
      }
      const named = s.name.length >= 4 && lower.includes(s.name.toLowerCase());
      if (named) score += 10;
      if (score > 0) hits.push({ ...this.plain(s), score: Math.round(score * 1000) / 1000, matched, nameHits, named });
    }
    return hits.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  }

  search(query: string, limit = 5): SkillHit[] {
    const l = Math.min(50, Math.max(1, Math.floor(Number.isFinite(limit) ? limit : 5)));
    if (!query.trim()) return this.list().slice(0, l).map((s) => ({ ...s, score: 0 }));
    return this.rank(query)
      .slice(0, l)
      .map(({ matched: _m, nameHits: _n, named: _d, ...hit }) => hit);
  }

  /**
   * Up to `limit` skills clearly relevant to a message: named in it, or at least two of its words hit the skill and at
   * least one of them is in the skill's name.
   */
  suggest(message: string, limit = 3): SkillHit[] {
    return this.rank(message.slice(0, 4000))
      .filter((h) => h.named || (h.nameHits >= 1 && h.matched >= 2))
      .slice(0, limit)
      .map(({ matched: _m, nameHits: _n, named: _d, ...hit }) => hit);
  }

  /** Files under the skill's references/, templates/, scripts/ and assets/, relative to it. */
  linkedFiles(skillDir: string) {
    const files: string[] = [];
    const walk = (dir: string, depth: number) => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
      } catch {
        return;
      }
      for (const e of entries) {
        if (files.length >= 200 || e.name.startsWith(".")) continue;
        const path = join(dir, e.name);
        if (e.isDirectory() && depth < 4) walk(path, depth + 1);
        else if (e.isFile() || e.isSymbolicLink()) files.push(relative(skillDir, path).split(sep).join("/"));
      }
    };
    for (const d of LINKED_DIRS) walk(join(skillDir, d), 0);
    return files;
  }

  /** The real path of a file in a skill; refuses anything outside the skill folder. */
  private resolveFile(skill: Indexed, filePath: string) {
    const rel = filePath === "SKILL.md" ? "SKILL.md" : safeSkillPath(filePath);
    let real: string;
    try {
      real = realpathSync(join(skill.path, rel));
    } catch {
      throw new SkillNotFound(`${skill.name} has no file ${rel}`);
    }
    if (rel !== "SKILL.md" && !within(real, skill.path)) throw new SkillInvalid(`file_path may not leave the skill folder: ${rel}`);
    const st = statSync(real);
    if (!st.isFile()) throw new SkillInvalid(`${rel} is not a file`);
    if (st.size > SKILL_FILE_MAX_BYTES) throw new SkillInvalid(`${rel} is ${st.size} bytes; the limit is ${SKILL_FILE_MAX_BYTES}`);
    return { rel, real, mode: st.mode & 0o777 };
  }

  /** SKILL.md, or one file under the skill, with its sha256 and the skill's linked files. */
  view(name: unknown, filePath?: unknown) {
    const skill = this.require(name);
    const { rel, real } = this.resolveFile(skill, filePath === undefined || filePath === null || filePath === "" ? "SKILL.md" : (filePath as string));
    const buf = readFileSync(real);
    return {
      name: skill.name,
      description: skill.description,
      path: skill.path,
      file: rel,
      sha256: sha256(buf),
      bytes: buf.length,
      content: buf.toString("utf8"),
      files: this.linkedFiles(skill.path),
    };
  }

  /** The real roots a write may land in. */
  private realRoots() {
    return this.roots.flatMap((r) => {
      try {
        return [realpathSync(r)];
      } catch {
        return [];
      }
    });
  }

  /**
   * Replace the one occurrence of `old_string` in SKILL.md or an existing file under references/, if the file's sha256
   * is still `expected_sha256`. Keeps the old content as a revision and appends an audit line.
   */
  update(
    input: { name?: unknown; old_string?: unknown; new_string?: unknown; file_path?: unknown; expected_sha256?: unknown },
    who: SkillWho,
  ) {
    const skill = this.require(input.name);
    const fp = input.file_path === undefined || input.file_path === null || input.file_path === "" ? "SKILL.md" : safeSkillPath(input.file_path);
    if (fp !== "SKILL.md" && !fp.startsWith("references/"))
      throw new SkillInvalid("skill_update edits SKILL.md or an existing file under references/ only");
    const expected = typeof input.expected_sha256 === "string" ? input.expected_sha256.trim().toLowerCase() : "";
    if (!/^[0-9a-f]{64}$/.test(expected)) throw new SkillInvalid("expected_sha256 is required: the sha256 skill_view returned for this file");
    if (typeof input.old_string !== "string" || !input.old_string) throw new SkillInvalid("old_string is required");
    if (typeof input.new_string !== "string") throw new SkillInvalid("new_string must be a string");
    if (input.old_string === input.new_string) throw new SkillInvalid("new_string is the same as old_string");
    const oldString = input.old_string;
    const newString = input.new_string;

    const { rel, real, mode } = this.resolveFile(skill, fp);
    if (!this.realRoots().some((root) => within(real, root)))
      throw new SkillInvalid(`${rel} resolves to ${real}, outside the shared skill folders; it is not editable here`);
    const before = readFileSync(real);
    const oldSha = sha256(before);
    if (oldSha !== expected)
      throw new SkillConflict(`${skill.name}/${rel} changed since you read it (sha256 is now ${oldSha}); view it again and redo the patch`);
    const current = before.toString("utf8");
    let count = 0;
    for (let at = current.indexOf(oldString); at >= 0 && count < 2; at = current.indexOf(oldString, at + 1)) count++;
    if (count === 0) throw new SkillInvalid(`old_string does not occur in ${rel}`);
    if (count > 1) throw new SkillInvalid(`old_string occurs more than once in ${rel}; include more surrounding text so it is unique`);
    const at = current.indexOf(oldString);
    const next = current.slice(0, at) + newString + current.slice(at + oldString.length);
    if (Buffer.byteLength(next) > SKILL_FILE_MAX_BYTES) throw new SkillInvalid(`the patched file would exceed ${SKILL_FILE_MAX_BYTES} bytes`);
    // The file's real name decides, so a references/ symlink to a SKILL.md gets the same checks.
    if (rel === "SKILL.md" || basename(real) === "SKILL.md") {
      const fm = parseFrontmatter(next);
      if (skill.frontmatter || fm) {
        if (!fm) throw new SkillInvalid("the patch breaks SKILL.md's front matter (it no longer parses); keep the --- block intact");
        if ((fm.name ?? "").trim() !== skill.name)
          throw new SkillInvalid(`the patch changes the skill's name to ${JSON.stringify(fm.name ?? "")}; it must stay ${JSON.stringify(skill.name)}`);
        if (!(fm.description ?? "").trim()) throw new SkillInvalid("the patch leaves SKILL.md without a description");
      }
    }
    const newSha = sha256(next);

    // The revision copy first, so a failed write never loses the old content.
    const revDir = join(this.revisionsDir, skill.name.replace(/[^\w.-]/g, "_").replace(/^\.+/, "_"));
    mkdirSync(revDir, { recursive: true, mode: 0o700 });
    chmodSync(this.revisionsDir, 0o700);
    chmodSync(revDir, 0o700);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    let revision = join(revDir, `${stamp}-${rel.replace(/\//g, "__")}`);
    for (let i = 1; ; i++) {
      try {
        const fd = openSync(revision, "wx", 0o600);
        try {
          writeSync(fd, before);
        } finally {
          closeSync(fd);
        }
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST" || i > 50) throw e;
        revision = join(revDir, `${stamp}-${i}-${rel.replace(/\//g, "__")}`);
      }
    }

    // Atomic replace of the real file: a temp file beside it, synced, then renamed over it. The sha256 re-check just
    // before the rename narrows the window for a write from another process to the instant between the check and the
    // rename; it does not close it, and a write landing there is overwritten (its content is in no revision).
    const tmp = join(dirname(real), `.${basename(real)}.dpi-${process.pid}-${randomBytes(4).toString("hex")}.tmp`);
    try {
      const fd = openSync(tmp, "wx", mode || 0o644);
      try {
        writeSync(fd, next);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      chmodSync(tmp, mode || 0o644);
      if (sha256(readFileSync(real)) !== oldSha) throw new SkillConflict(`${skill.name}/${rel} changed while patching; view it again and redo the patch`);
      renameSync(tmp, real);
    } catch (e) {
      try {
        unlinkSync(tmp);
      } catch {}
      throw e;
    }

    // The file is replaced by now: a failing audit line is reported next to the success, never as "Not saved".
    const line = { time: new Date().toISOString(), session: who.session, agent: who.agent, name: skill.name, file: rel, path: real, oldSha256: oldSha, newSha256: newSha, revision };
    let auditWarning: string | undefined;
    try {
      appendFileSync(this.auditPath, `${JSON.stringify(line)}\n`, { mode: 0o600 });
      chmodSync(this.auditPath, 0o600);
    } catch (e) {
      auditWarning = `the file was replaced but the audit line could not be written: ${(e as Error).message}`;
    }
    this.invalidate();
    return { name: skill.name, file: rel, path: real, oldSha256: oldSha, newSha256: newSha, revision, ...(auditWarning ? { auditWarning } : {}) };
  }
}

// ------------------------------------------------------------------ the extension

export const SKILLS_NOTE =
  "# Shared skills\nSkills are the procedures the user's agents share with you (Hermes and OMP read the same folders): tested commands, pitfalls and workflows. Before domain work, find a matching skill with skill_search, read it with skill_view and follow it. Change one with skill_update only for a general lesson that will hold next time (a wrong command, a missing step, a pitfall): lessons, not logs of what you did. Patch the smallest unique span and pass the sha256 that skill_view returned.";

export const SKILLS_SUGGEST_HEADER = "Skills that may fit this message (skill_view one before you start):";

const oneLine = (s: string, max: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** The suggestion block for a message, or "" when nothing is clearly relevant. */
export function suggestionBlock(index: SkillIndex, message: string) {
  const top = index.suggest(message, 3);
  return top.length ? `${SKILLS_SUGGEST_HEADER}\n${top.map((s) => `- ${s.name}: ${oneLine(s.description, 160)}`).join("\n")}` : "";
}

type Content = string | readonly { type: string; text?: string }[];
const textOf = (content: Content) =>
  typeof content === "string" ? content : content.map((b) => (b.type === "text" ? (b.text ?? "") : "")).join("\n");

export function createSkillsExtension(index: SkillIndex, who: { sessionName: () => string; agentName?: (conversationId: number) => string }) {
  const search = defineTool({
    name: "skill_search",
    description:
      "Search the shared skills (procedures with tested commands and pitfalls, shared with Hermes and OMP) by name and description. Returns name, description and path; read one with skill_view.",
    parameters: Type.Object({
      query: Type.String({ description: "What the work is about, e.g. \"blast radius\" or \"tailscale serve\"." }),
      limit: Type.Optional(Type.Number({ description: "Most skills (default 5, max 10)." })),
    }),
    replay: "safe",
    execute: async (args) => {
      const a = args as { query: string; limit?: number };
      const limit = Math.min(10, Math.max(1, Math.floor(a.limit ?? 5)));
      const hits = index.search(String(a.query ?? ""), limit);
      return text(hits.map((h, i) => `${i + 1}. ${h.name}: ${oneLine(h.description, 300)}\n   ${h.path}`).join("\n") || "No matching skills.");
    },
  });
  const view = defineTool({
    name: "skill_view",
    description: `Read a skill's SKILL.md, or one of its files (file_path relative to the skill, e.g. references/api.md), with the file's sha256 (skill_update needs it) and the list of its linked files. Text over ${SKILL_VIEW_MAX_CHARS / 1000} KB is cut.`,
    parameters: Type.Object({
      name: Type.String({ description: "The skill's name, as skill_search returns it." }),
      file_path: Type.Optional(Type.String({ description: "A file under the skill folder; default SKILL.md." })),
    }),
    replay: "safe",
    execute: async (args) => {
      const a = args as { name: string; file_path?: string };
      try {
        const v = index.view(a.name, a.file_path);
        const cut = v.content.length > SKILL_VIEW_MAX_CHARS;
        return text(
          [
            `Skill ${v.name}: ${v.file} (${v.path})`,
            `sha256: ${v.sha256}`,
            `linked files: ${v.files.length ? v.files.join(", ") : "none"}`,
            "",
            cut ? `${v.content.slice(0, SKILL_VIEW_MAX_CHARS)}\n\n[cut: showed ${SKILL_VIEW_MAX_CHARS} of ${v.content.length} characters]` : v.content,
          ].join("\n"),
        );
      } catch (e) {
        return text(`Cannot view: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  });
  const update = defineTool({
    name: "skill_update",
    description:
      "Patch a shared skill with one general lesson (a wrong command, a missing step, a pitfall), never a log of your work. Replaces old_string, which must occur exactly once, with new_string in SKILL.md or an existing file under references/. Pass expected_sha256 from skill_view; if the file changed since, nothing is written. SKILL.md must keep its name and description. The old content is kept as a revision. It cannot create, delete or rewrite whole files.",
    parameters: Type.Object({
      name: Type.String({ description: "The skill's name." }),
      old_string: Type.String({ description: "Exact text to replace; must occur once in the file." }),
      new_string: Type.String({ description: "The replacement text." }),
      file_path: Type.Optional(Type.String({ description: "SKILL.md (default) or references/<file>." })),
      expected_sha256: Type.String({ description: "The file's sha256 from skill_view." }),
    }),
    replay: "unsafe",
    execute: async (args, api) => {
      const id = Number(api.conversationId);
      try {
        const r = index.update(args as Record<string, unknown>, {
          session: who.sessionName(),
          agent: who.agentName?.(id) ?? `#${id}`,
        });
        return text(`Patched ${r.name}/${r.file}. sha256 is now ${r.newSha256}; the old content is kept as a revision.${r.auditWarning ? ` Warning: ${r.auditWarning}.` : ""}`);
      } catch (e) {
        return text(`Not saved: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  });

  type Suggested = { block: string };
  return defineExtension({
    name: "skills",
    tools: [search, view, update],
    sections: [section("skills", () => SKILLS_NOTE, { tag: false })],
    hooks: [
      hook(GenerationTask, {
        // Once per run against its latest user message, like library auto-recall; every request of the run carries the
        // same block, and it is never stored in the transcript.
        beforeRequest: async (request, api, ctx) => {
          const at = request.messages.findLastIndex((m) => m.role === "user");
          if (at < 0) return;
          const target = request.messages[at] as Extract<(typeof request.messages)[number], { role: "user" }>;
          let got = await api.memo<Suggested>("skills-suggest", ctx);
          if (!got) {
            let block = "";
            // DPI_SKILLS_SUGGEST=off keeps the tools and the note and drops the suggestions; read per run.
            try {
              const user = process.env.DPI_SKILLS_SUGGEST === "off" ? "" : textOf(target.content as Content).trim();
              if (user) block = suggestionBlock(index, user);
            } catch (e) {
              console.error("[skills] suggest failed, run continues:", e instanceof Error ? e.message : e);
            }
            got = await api.memo<Suggested>("skills-suggest", { block }, ctx);
          }
          if (!got.block) return;
          const content =
            typeof target.content === "string" ? `${got.block}\n\n${target.content}` : [{ type: "text" as const, text: got.block }, ...target.content];
          const messages = [...request.messages];
          messages[at] = { ...target, content };
          return { messages };
        },
      }),
    ],
  });
}
