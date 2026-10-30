// Skills: the shared skill folders. The index (nesting, symlinks, collisions, live refresh), view and its path guards,
// skill_update's compare-and-swap patch with revisions and audit, the add-on in a live session (faux model) with the
// tool sets, and the read-only routes. Every write here lands in temp copies, never in the real skill folders.
import { test } from "node:test";
import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseFrontmatter,
  safeSkillPath,
  sha256,
  SkillConflict,
  SkillIndex,
  SkillInvalid,
  SkillNotFound,
  SKILLS_NOTE,
  suggestionBlock,
} from "../src/skills.js";
import { ORACLE_REMOVED, WRITE_TOOLS } from "../src/store.js";
import { bootServer, faux, newToken, tempStore } from "./helpers.js";

const skillMd = (name: string, description: string, body = "Body.\n") => `---\nname: ${name}\ndescription: ${description}\nversion: 1.0.0\nmetadata:\n  hermes:\n    tags: [x]\n---\n\n# ${name}\n\n${body}`;

/** Two roots: nesting, a symlinked skill dir, a symlinked SKILL.md, a name collision, linked files, an escape link. */
function makeTree() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "dpi-skills-")));
  const a = join(base, "rootA");
  const b = join(base, "rootB");
  const w = (path: string, content: string) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  };
  w(join(a, "devops", "blast-radius-check", "SKILL.md"), skillMd("blast-radius-check", "Use when a change needs impact analysis before approving it."));
  w(join(a, "devops", "blast-radius-check", "references", "notes.md"), "# Notes\n\nCallers can be missing.\n");
  w(join(a, "devops", "blast-radius-check", "scripts", "run.sh"), "#!/bin/sh\necho hi\n");
  // Nested: a skill inside another skill, without front matter.
  w(join(a, "devops", "blast-radius-check", "deep", "SKILL.md"), "# Deep dive\n\nNo front matter.\n");
  // A folded description.
  w(join(a, "creative", "folded", "SKILL.md"), "---\nname: folded\ndescription: >\n  Draw diagrams\n  in the browser.\n---\nBody\n");
  // Collision: rootA's "shared" wins over rootB's.
  w(join(a, "shared-a", "SKILL.md"), skillMd("shared", "From root A."));
  w(join(b, "shared", "SKILL.md"), skillMd("shared", "From root B."));
  // rootB holds the real dirs that rootA links to.
  w(join(b, "linked-real", "SKILL.md"), skillMd("linked-dir", "A skill whose folder is a symlink in root A."));
  w(join(b, "linked-real", "references", "ref.md"), "ref one\nref two\n");
  symlinkSync(join(b, "linked-real"), join(a, "linked-dir"));
  w(join(b, "files", "linked-file.md"), skillMd("linked-file", "A skill whose SKILL.md is a symlink."));
  mkdirSync(join(a, "linked-file"));
  symlinkSync(join(b, "files", "linked-file.md"), join(a, "linked-file", "SKILL.md"));
  // A reference that escapes the skill folder.
  w(join(base, "outside.txt"), "secret outside\n");
  symlinkSync(join(base, "outside.txt"), join(a, "devops", "blast-radius-check", "references", "escape.md"));
  // Hidden and dangling entries are skipped.
  w(join(a, ".hidden", "SKILL.md"), skillMd("hidden", "Never indexed."));
  symlinkSync(join(base, "nowhere"), join(a, "dangling"));
  return { base, a, b, data: join(base, "data"), cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

const who = { session: "oracle", agent: "Main" };

test("skills index: nested skills, symlinked dirs and files resolved once, first root wins, hidden and dangling skipped, new skills show without restart", () => {
  const t = makeTree();
  try {
    const index = new SkillIndex({ roots: [t.a, t.b, join(t.base, "missing-root")], dataDir: t.data, checkMs: 0 });
    const names = index.list().map((s) => s.name).sort();
    assert.deepEqual(names, ["blast-radius-check", "deep", "folded", "linked-dir", "linked-file", "shared"]);
    assert.equal(index.get("shared")?.description, "From root A.");
    assert.equal(index.get("shared")?.root, t.a);
    assert.equal(index.get("linked-dir")?.path, join(t.b, "linked-real"), "the real path");
    assert.equal(index.get("linked-dir")?.root, t.a, "found first through root A's symlink");
    assert.equal(index.get("deep")?.description, "Deep dive", "no front matter: name from the folder, description from the heading");
    assert.equal(index.get("deep")?.frontmatter, false);
    assert.equal(index.get("folded")?.description, "Draw diagrams in the browser.");
    assert.equal(index.get("hidden"), undefined);

    // Search ranks by name and description words.
    assert.deepEqual(index.search("blast radius", 3).map((h) => h.name)[0], "blast-radius-check");
    assert.equal(index.search("zzz nothing", 3).length, 0);
    assert.equal(index.search("", 2).length, 2);
    assert.match(suggestionBlock(index, "Check the blast radius before approving this change"), /- blast-radius-check: Use when a change needs impact/);
    assert.equal(suggestionBlock(index, "hello there"), "");
    assert.ok(SKILLS_NOTE.length + suggestionBlock(index, "blast radius shared folded linked diagrams").length < 1500);

    // A new skill appears on the next read.
    mkdirSync(join(t.a, "devops", "fresh"));
    writeFileSync(join(t.a, "devops", "fresh", "SKILL.md"), skillMd("fresh", "Added while running."));
    assert.equal(index.get("fresh")?.description, "Added while running.");
    // An edited description too.
    writeFileSync(join(t.a, "devops", "fresh", "SKILL.md"), skillMd("fresh", "Edited while running."));
    assert.equal(index.get("fresh")?.description, "Edited while running.");
  } finally {
    t.cleanup();
  }
});

test("skills view: SKILL.md or a linked file with its sha256; traversal, absolute paths and escaping links are refused", () => {
  const t = makeTree();
  try {
    const index = new SkillIndex({ roots: [t.a, t.b], dataDir: t.data, checkMs: 0 });
    const v = index.view("blast-radius-check");
    assert.equal(v.file, "SKILL.md");
    assert.match(v.content, /^---\nname: blast-radius-check/);
    assert.equal(v.sha256, sha256(readFileSync(join(t.a, "devops", "blast-radius-check", "SKILL.md"))));
    assert.deepEqual(v.files, ["references/escape.md", "references/notes.md", "scripts/run.sh"]);
    assert.equal(index.view("blast-radius-check", "references/notes.md").content, "# Notes\n\nCallers can be missing.\n");
    assert.throws(() => index.view("blast-radius-check", "../../shared-a/SKILL.md"), SkillInvalid);
    assert.throws(() => index.view("blast-radius-check", "references/../../../outside.txt"), /may not leave/);
    assert.throws(() => index.view("blast-radius-check", "/etc/passwd"), /must be relative/);
    assert.throws(() => index.view("blast-radius-check", "references/escape.md"), /may not leave the skill folder/);
    assert.throws(() => index.view("blast-radius-check", "references/none.md"), SkillNotFound);
    assert.throws(() => index.view("nope"), SkillNotFound);
    assert.throws(() => safeSkillPath("a/../../b"), /may not leave/);
    assert.equal(safeSkillPath("./references//x.md"), "references/x.md");
  } finally {
    t.cleanup();
  }
});

test("skill_update: one unique patch, compare-and-swap, front matter kept, symlinks preserved, revision and audit written", () => {
  const t = makeTree();
  try {
    const index = new SkillIndex({ roots: [t.a, t.b], dataDir: t.data, checkMs: 0 });
    const linkPath = join(t.a, "linked-file", "SKILL.md");
    const realPath = join(t.b, "files", "linked-file.md");
    const before = readFileSync(realPath, "utf8");
    const sha = index.view("linked-file").sha256;

    // Happy path through a symlinked SKILL.md.
    const r = index.update({ name: "linked-file", old_string: "Body.\n", new_string: "Body.\n\n- Lesson: check callers twice.\n", expected_sha256: sha }, who);
    assert.ok(lstatSync(linkPath).isSymbolicLink(), "the symlink is still a symlink");
    const after = readFileSync(realPath, "utf8");
    assert.equal(after, before.replace("Body.\n", "Body.\n\n- Lesson: check callers twice.\n"));
    assert.equal(r.newSha256, sha256(after));
    assert.equal(r.oldSha256, sha);
    assert.equal(r.path, realPath);
    // The revision keeps the old content, owner-only.
    assert.equal(readFileSync(r.revision, "utf8"), before);
    assert.equal(statSync(r.revision).mode & 0o777, 0o600);
    assert.equal(statSync(join(t.data, "skill-revisions")).mode & 0o777, 0o700);
    assert.equal(statSync(join(t.data, "skill-revisions", "linked-file")).mode & 0o777, 0o700);
    assert.match(r.revision, /skill-revisions\/linked-file\/\d{4}-\d\d-\d\dT[\d-]+Z-SKILL\.md$/);
    const audit = readFileSync(join(t.data, "skill-revisions", "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(audit.length, 1);
    assert.deepEqual(
      [audit[0].session, audit[0].agent, audit[0].name, audit[0].file, audit[0].oldSha256, audit[0].newSha256],
      ["oracle", "Main", "linked-file", "SKILL.md", sha, r.newSha256],
    );
    assert.match(audit[0].time, /^\d{4}-/);
    assert.equal(statSync(join(t.data, "skill-revisions", "audit.jsonl")).mode & 0o777, 0o600);
    // No temp files left beside the real file.
    assert.deepEqual(readdirSync(join(t.b, "files")), ["linked-file.md"]);

    // A reference file under a symlinked skill folder.
    const refSha = index.view("linked-dir", "references/ref.md").sha256;
    index.update({ name: "linked-dir", file_path: "references/ref.md", old_string: "ref two", new_string: "ref two (fixed)", expected_sha256: refSha }, who);
    assert.equal(readFileSync(join(t.b, "linked-real", "references", "ref.md"), "utf8"), "ref one\nref two (fixed)\n");
    assert.ok(lstatSync(join(t.a, "linked-dir")).isSymbolicLink());

    // Stale sha256: refused, nothing written.
    const current = readFileSync(realPath, "utf8");
    assert.throws(() => index.update({ name: "linked-file", old_string: "Lesson", new_string: "Rule", expected_sha256: sha }, who), SkillConflict);
    assert.equal(readFileSync(realPath, "utf8"), current);
    const fresh = sha256(current);

    // old_string must occur exactly once.
    assert.throws(() => index.update({ name: "linked-file", old_string: "linked-file", new_string: "x", expected_sha256: fresh }, who), /more than once/);
    assert.throws(() => index.update({ name: "linked-file", old_string: "not there", new_string: "x", expected_sha256: fresh }, who), /does not occur/);
    assert.throws(() => index.update({ name: "linked-file", old_string: "", new_string: "x", expected_sha256: fresh }, who), /old_string is required/);
    assert.throws(() => index.update({ name: "linked-file", old_string: "Lesson", new_string: "x" }, who), /expected_sha256 is required/);

    // Front matter must still parse with the same name and a description.
    const sk = (old_string: string, new_string: string) => () => index.update({ name: "linked-file", old_string, new_string, expected_sha256: fresh }, who);
    assert.throws(sk("name: linked-file\n", "name: renamed\n"), /changes the skill's name/);
    assert.throws(sk("description: A skill whose SKILL.md is a symlink.\n", "description:\n"), /without a description/);
    assert.throws(sk("tags: [x]\n---\n", "tags: [x]\n\n"), /breaks SKILL\.md's front matter/);
    assert.equal(readFileSync(realPath, "utf8"), current, "every refusal left the file alone");

    // Only SKILL.md and existing references; no create.
    const bsha = index.view("blast-radius-check").sha256;
    assert.throws(() => index.update({ name: "blast-radius-check", file_path: "scripts/run.sh", old_string: "hi", new_string: "ho", expected_sha256: bsha }, who), /SKILL\.md or an existing file under references/);
    assert.throws(() => index.update({ name: "blast-radius-check", file_path: "references/new.md", old_string: "a", new_string: "b", expected_sha256: bsha }, who), SkillNotFound);
    assert.throws(() => index.update({ name: "blast-radius-check", file_path: "references/../../x.md", old_string: "a", new_string: "b", expected_sha256: bsha }, who), /may not leave/);
    assert.throws(() => index.update({ name: "blast-radius-check", file_path: "references/escape.md", old_string: "secret", new_string: "b", expected_sha256: sha256("secret outside\n") }, who), /may not leave/);
    assert.equal(readFileSync(join(t.base, "outside.txt"), "utf8"), "secret outside\n");
    assert.equal(readFileSync(join(t.data, "skill-revisions", "audit.jsonl"), "utf8").trim().split("\n").length, 2, "only the two writes were audited");

    assert.deepEqual(parseFrontmatter("---\nname: 'q'\ndescription: \"d: e\"\n---\n"), { name: "q", description: "d: e" });
    assert.equal(parseFrontmatter("no front matter"), undefined);
  } finally {
    t.cleanup();
  }
});

test("skills add-on: tools in a live session, the note in the system prompt; readOnly drops skill_update, oracle keeps it; routes read", async () => {
  const tree = makeTree();
  const saved = process.env.DPI_SKILL_DIRS;
  process.env.DPI_SKILL_DIRS = `${tree.a}:${tree.b}`;
  // Suggestions go in front of the user's message, where the faux model would read them instead of the tool call.
  process.env.DPI_SKILLS_SUGGEST = "off";
  const t = await tempStore();
  const store = await t.open();
  try {
    assert.ok(WRITE_TOOLS.has("skill_update") && !WRITE_TOOLS.has("skill_view") && !WRITE_TOOLS.has("skill_search"));
    assert.ok(!ORACLE_REMOVED.has("skill_update"));
    const s = await store.create({ name: "Skills", cwd: t.work, model: faux });
    const r = await store.resolveAgent(s.id, "main");
    await store.setExtension(r.row, r.c, { name: "skills", enabled: true });
    let n = 0;
    const lastTool = async (content: string) => {
      const sub = await store.send(r.c, { content, requestId: `s-${n++}` });
      assert.equal((await store.settled(r.h, sub.id as number, 20000)).status, "done");
      const md = (await store.transcript(r.c, "markdown")).text ?? "";
      return md.slice(md.lastIndexOf("Tool finished:"));
    };
    const tool = (name: string, args: unknown) => `tool: ${name} ${JSON.stringify(args)}`;
    assert.match(await lastTool(tool("skill_search", { query: "blast radius" })), /1\. blast-radius-check: Use when a change needs impact/);
    const viewed = await lastTool(tool("skill_view", { name: "linked-file" }));
    const sha = /sha256: ([0-9a-f]{64})/.exec(viewed)?.[1];
    assert.equal(sha, sha256(readFileSync(join(tree.b, "files", "linked-file.md"))));
    assert.match(await lastTool(tool("skill_view", { name: "blast-radius-check", file_path: "../shared-a/SKILL.md" })), /Cannot view: file_path may not leave/);
    assert.match(
      await lastTool(tool("skill_update", { name: "linked-file", old_string: "Body.", new_string: "Body. Lesson: one.", expected_sha256: sha })),
      /Patched linked-file\/SKILL\.md\. sha256 is now [0-9a-f]{64}/,
    );
    assert.match(readFileSync(join(tree.b, "files", "linked-file.md"), "utf8"), /Body\. Lesson: one\./);
    assert.match(
      await lastTool(tool("skill_update", { name: "linked-file", old_string: "Lesson: one.", new_string: "x", expected_sha256: sha })),
      /Not saved: linked-file\/SKILL\.md changed since you read it/,
    );
    const audit = JSON.parse(readFileSync(join(t.options.dataDir, "skill-revisions", "audit.jsonl"), "utf8").trim());
    assert.deepEqual([audit.session, audit.agent], ["Skills", "Main"]);

    // Auto-suggest: the faux model echoes its prompt, so the echo shows the block put in front of the message; an
    // unrelated message gets none.
    process.env.DPI_SKILLS_SUGGEST = "on";
    const echo = async (content: string) => {
      const sub = await store.send(r.c, { content, requestId: `s-${n++}` });
      assert.equal((await store.settled(r.h, sub.id as number, 20000)).status, "done");
      const md = (await store.transcript(r.c, "markdown")).text ?? "";
      return md.slice(md.lastIndexOf("Echo:"));
    };
    const suggested = await echo("Check the blast radius before approving this change");
    assert.match(suggested, /^Echo: Skills that may fit this message \(skill_view one before you start\):\s+- blast-radius-check: Use when a change needs impact/);
    assert.match(suggested, /Check the blast radius before approving this change/);
    assert.match(await echo("hello there"), /^Echo: hello there/);
    const stored = JSON.stringify((await store.entries(r.c, undefined, 500)).items.filter((e) => e.kind === "pi.user"));
    assert.doesNotMatch(stored, /Skills that may fit/, "never stored in the transcript's user entries");
    delete process.env.DPI_SKILLS_SUGGEST;

    const system = JSON.stringify((await store.entries(r.c, undefined, 500)).items.find((e) => e.kind === "pi.system") ?? null);
    assert.match(system, /# Shared skills/);

    const offered = async () => (await store.agentDetail(r.row, r.c)).tools.filter((x) => x.offered).map((x) => x.name);
    await store.configure(r.row, r.c, { toolSet: "readOnly" });
    let names = await offered();
    assert.ok(names.includes("skill_search") && names.includes("skill_view") && !names.includes("skill_update"), names.join(","));
    await store.configure(r.row, r.c, { toolSet: "oracle" });
    names = await offered();
    assert.ok(names.includes("skill_update") && !names.includes("bash"), names.join(","));
  } finally {
    await store.close();
    await t.cleanup();
  }

  // The read-only routes, on a real server.
  const home = mkdtempSync(join(tmpdir(), "dpi-skills-home-"));
  const token = newToken();
  const server = await bootServer({ home, startDirs: home, token });
  try {
    const get = async (path: string) => {
      const res = await fetch(`${server.base}${path}`, { headers: { authorization: `Bearer ${token}` } });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    const found = await get("/v1/skills?query=blast%20radius&limit=2");
    assert.equal(found.status, 200);
    const items = found.body.items as { name: string; description: string; path: string; score: number }[];
    assert.equal(items[0].name, "blast-radius-check");
    assert.ok(items.length <= 2);
    const one = await get("/v1/skills/linked-dir");
    assert.equal(one.status, 200);
    assert.equal(one.body.name, "linked-dir");
    assert.match(String(one.body.content), /name: linked-dir/);
    assert.match(String(one.body.sha256), /^[0-9a-f]{64}$/);
    assert.deepEqual(one.body.files, ["references/ref.md"]);
    assert.equal((await get("/v1/skills/linked-dir?file=references/ref.md")).body.content, "ref one\nref two\n");
    assert.equal((await get("/v1/skills/linked-dir?file=../shared/SKILL.md")).status, 400);
    assert.equal((await get("/v1/skills/no-such-skill")).status, 404);
    assert.equal((await get("/v1/skills?limit=0")).status, 400);
  } finally {
    await server.stop();
    rmSync(home, { recursive: true, force: true });
    if (saved === undefined) delete process.env.DPI_SKILL_DIRS;
    else process.env.DPI_SKILL_DIRS = saved;
    tree.cleanup();
  }
});
