// Audit of PR #15 (toolbelt: git diff, pip3r, shared skills, Haiku subagents); see docs/audits/review-pr15.md.
// Two kinds of test live here:
//   guard tests   pass today; each one kills a mutant that survived the PR's own suite (M1, M2, M3, M4, M7)
//   finding tests F1-F3 and F5-F8 failed before the fixes and now pass; F4 (a write between the re-check and the rename)
//                 cannot be closed without a lock, so its comment was corrected and its test stays skipped
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs, { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALLOWED, PIP3R_SUBCOMMANDS, pip3rArgv, REFUSED, type Pip3rSub } from "../src/toolkit-pip3r.js";
import { sha256, SKILL_FILE_MAX_BYTES, SkillConflict, SkillIndex, SkillInvalid } from "../src/skills.js";
import { faux, tempStore } from "./helpers.js";

const finding = (id: string) => (process.env.PR15_FINDINGS ? false : `finding: ${id} (documented limit)`);
const who = { session: "audit", agent: "Main" };
const SKILL = "---\nname: a\ndescription: A test skill.\n---\nBody\n";

/** One root holding skill `a` (with references/notes.md); the caller adds whatever else it needs. */
function skillTree() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "dpi-pr15-")));
  const root = join(base, "root");
  mkdirSync(join(root, "a", "references"), { recursive: true });
  writeFileSync(join(root, "a", "SKILL.md"), SKILL);
  writeFileSync(join(root, "a", "references", "notes.md"), "note one\n");
  const index = () => new SkillIndex({ roots: [root], dataDir: join(base, "data"), checkMs: 0 });
  return { base, root, file: join(root, "a", "SKILL.md"), index, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

/** Swap one node:fs function for the duration of fn, ESM named imports included. */
function withFs<K extends "renameSync" | "fsyncSync">(name: K, impl: (orig: (typeof fs)[K]) => (typeof fs)[K], fn: () => void) {
  const orig = fs[name];
  fs[name] = impl(orig);
  syncBuiltinESMExports();
  try {
    fn();
  } finally {
    fs[name] = orig;
    syncBuiltinESMExports();
  }
}

/** The flags pip3r would see in an argv if, as the tool assumes, a value flag always takes the next token. */
function flagsSeen(sub: Pip3rSub, argv: string[]) {
  const takesValue = new Set(ALLOWED[sub].filter((f) => f.endsWith("=")).map((f) => f.slice(0, -1)));
  const flags: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("-")) continue;
    flags.push(a.split("=")[0]);
    if (!a.includes("=") && (takesValue.has(a) || a === "--cwd")) i++;
  }
  return flags;
}

// ------------------------------------------------------------------ guard tests (pass today)

test("guard M1: a skill whose real folder is outside every root can be viewed but never patched", () => {
  const t = skillTree();
  try {
    mkdirSync(join(t.base, "elsewhere"));
    writeFileSync(join(t.base, "elsewhere", "SKILL.md"), "---\nname: ext\ndescription: Outside.\n---\nBody\n");
    symlinkSync(join(t.base, "elsewhere"), join(t.root, "ext"));
    const index = t.index();
    const v = index.view("ext");
    assert.throws(
      () => index.update({ name: "ext", old_string: "Body", new_string: "Changed", expected_sha256: v.sha256 }, who),
      /outside the shared skill folders/,
    );
    assert.equal(readFileSync(join(t.base, "elsewhere", "SKILL.md"), "utf8"), v.content);
  } finally {
    t.cleanup();
  }
});

test("guard M2: a write that lands between the read and the rename re-check is detected and kept", () => {
  const t = skillTree();
  try {
    const index = t.index();
    const sha = index.view("a").sha256;
    const external = SKILL.replace("Body", "Written by another agent");
    // fsyncSync runs on the temp file after the first read and before the re-check.
    withFs("fsyncSync", (orig) => ((fd: number) => {
      writeFileSync(t.file, external);
      return orig(fd);
    }) as typeof fs.fsyncSync, () => {
      assert.throws(() => index.update({ name: "a", old_string: "Body", new_string: "Mine", expected_sha256: sha }, who), SkillConflict);
    });
    assert.equal(readFileSync(t.file, "utf8"), external);
    assert.deepEqual(readdirSync(join(t.root, "a")).sort(), ["SKILL.md", "references"], "no temp file left");
  } finally {
    t.cleanup();
  }
});

test("guard M3: files over SKILL_FILE_MAX_BYTES are refused by view and update", () => {
  const t = skillTree();
  try {
    const big = join(t.root, "a", "references", "big.md");
    writeFileSync(big, "x".repeat(SKILL_FILE_MAX_BYTES + 1));
    const index = t.index();
    assert.throws(() => index.view("a", "references/big.md"), /the limit is/);
    assert.throws(
      () => index.update({ name: "a", file_path: "references/big.md", old_string: "x", new_string: "y", expected_sha256: sha256(readFileSync(big)) }, who),
      /the limit is/,
    );
  } finally {
    t.cleanup();
  }
});

test("guard M4: a positional argument with NUL, CR or LF, or over 1000 characters, never reaches pip3r", () => {
  for (const bad of ["sym\nbol", "sym\rbol", "sym\0bol", "s".repeat(1001)])
    assert.throws(() => pip3rArgv("blast", [bad], "/repo"), /Invalid argument/, JSON.stringify(bad.slice(0, 10)));
});

test("guard M7: a failed rename leaves the old content in place, the revision written and no temp file", () => {
  const t = skillTree();
  try {
    const index = t.index();
    const sha = index.view("a").sha256;
    withFs("renameSync", () => (() => {
      throw Object.assign(Error("EIO: simulated"), { code: "EIO" });
    }) as typeof fs.renameSync, () => {
      assert.throws(() => index.update({ name: "a", old_string: "Body", new_string: "Mine", expected_sha256: sha }, who), /EIO/);
    });
    assert.equal(readFileSync(t.file, "utf8"), SKILL);
    assert.deepEqual(readdirSync(join(t.root, "a")).sort(), ["SKILL.md", "references"], "the temp file was removed");
    const revs = readdirSync(join(t.base, "data", "skill-revisions", "a"));
    assert.equal(revs.length, 1);
    assert.equal(readFileSync(join(t.base, "data", "skill-revisions", "a", revs[0]), "utf8"), SKILL);
  } finally {
    t.cleanup();
  }
});

// ------------------------------------------------------------------ finding tests (fail today, skipped)

test("F1: the forced --no-auto-index and --json survive a value flag that would swallow them", () => {
  // A two-token value may not start with "-", so a flag name can never be passed as a value.
  assert.throws(() => pip3rArgv("blast", ["createStore", "--path", "--no-auto-index"], "/repo"), /may not start with "-"/);
  assert.throws(() => pip3rArgv("scout", ["--grep", "--json"], "/repo"), /may not start with "-"/);
  const blast = pip3rArgv("blast", ["createStore", "--path=--no-auto-index"], "/repo");
  assert.ok(flagsSeen("blast", blast).includes("--no-auto-index"), blast.join(" "));
  assert.ok(flagsSeen("blast", blast).includes("--json"), blast.join(" "));
});

test("F2: a refused flag never reaches pip3r's argv, not even as the next token after a value flag", () => {
  for (const sub of PIP3R_SUBCOMMANDS) {
    const valueFlag = ALLOWED[sub].find((f) => f.endsWith("=") && f.startsWith("--"))!.slice(0, -1);
    for (const refused of Object.keys(REFUSED[sub])) {
      let argv: string[] | undefined;
      try {
        argv = pip3rArgv(sub, [valueFlag, refused], "/repo");
      } catch {
        continue;
      }
      assert.ok(!argv.includes(refused), `pip3r ${sub} receives ${refused}: ${argv.join(" ")}`);
    }
  }
});

test("F3: SKILL.md's front matter is re-validated even when the patch goes through a references/ symlink to it", () => {
  const t = skillTree();
  try {
    symlinkSync("../SKILL.md", join(t.root, "a", "references", "self.md"));
    const index = t.index();
    const sha = index.view("a", "references/self.md").sha256;
    assert.throws(
      () => index.update({ name: "a", file_path: "references/self.md", old_string: "name: a\n", new_string: "name: hijacked\n", expected_sha256: sha }, who),
      SkillInvalid,
    );
    assert.equal(readFileSync(t.file, "utf8"), SKILL);
  } finally {
    t.cleanup();
  }
});

test("F4: a write that lands between the sha re-check and the rename is not silently overwritten", { skip: finding("F4") }, () => {
  const t = skillTree();
  try {
    const index = t.index();
    const sha = index.view("a").sha256;
    const external = SKILL.replace("Body", "Written by another agent");
    withFs("renameSync", (orig) => ((from: fs.PathLike, to: fs.PathLike) => {
      writeFileSync(t.file, external);
      return orig(from, to);
    }) as typeof fs.renameSync, () => {
      try {
        index.update({ name: "a", old_string: "Body", new_string: "Mine", expected_sha256: sha }, who);
      } catch {}
    });
    assert.equal(readFileSync(t.file, "utf8"), external, "the other agent's write was lost");
  } finally {
    t.cleanup();
  }
});

test("F5: skill_update never reports a failure after it has already replaced the file", () => {
  const t = skillTree();
  try {
    // The audit line cannot be appended (audit.jsonl is a directory); the rename has already happened by then.
    mkdirSync(join(t.base, "data", "skill-revisions", "audit.jsonl"), { recursive: true });
    const index = t.index();
    const sha = index.view("a").sha256;
    const r = index.update({ name: "a", old_string: "Body", new_string: "Mine", expected_sha256: sha }, who);
    assert.match(r.auditWarning ?? "", /replaced but the audit line could not be written/);
    assert.equal(readFileSync(t.file, "utf8"), SKILL.replace("Body", "Mine"));
    assert.equal(r.newSha256, sha256(readFileSync(t.file)));
  } finally {
    t.cleanup();
  }
});

test("F6: git diff runs no program from the repo's config (filter.<driver>.clean)", async () => {
  const t = await tempStore();
  const repo = join(t.work, "proj");
  mkdirSync(repo);
  const g = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" }).toString();
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "Tester");
  writeFileSync(join(repo, "a.txt"), "one\n");
  g("add", ".");
  g("commit", "-q", "-m", "first");
  const marker = join(t.root, "filter-ran");
  g("config", "filter.evil.clean", `touch ${marker}; cat`);
  writeFileSync(join(repo, ".gitattributes"), "a.txt filter=evil\n");
  writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
  const store = await t.open();
  try {
    const s = await store.create({ name: "Filter", cwd: t.work, model: faux });
    const { h, c, row } = await store.resolveAgent(s.id, "main");
    await store.configure(row, c, { toolSet: "oracle" });
    const sub = await store.send(c, { content: `tool: git ${JSON.stringify({ op: "diff", repo: "proj" })}`, requestId: "f6" });
    assert.equal((await store.settled(h, sub.id as number, 15000)).status, "done");
    assert.match((await store.transcript(c, "markdown")).text ?? "", /\+two/);
    assert.equal(existsSync(marker), false, "git diff ran the repo's clean filter");
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("F7: on a device without the default subagent model, subagent and start_session use the parent's model and say so", async () => {
  const t = await tempStore();
  const store = await t.open();
  const saved = process.env.DPI_SUBAGENT_MODEL;
  delete process.env.DPI_SUBAGENT_MODEL;
  try {
    const s = await store.create({ name: "NoHaiku", cwd: t.work, model: faux });
    const { row, h, c } = await store.resolveAgent(s.id, "main");
    const call = async (name: string, args: unknown, n: number) => {
      const sub = await store.send(c, { content: `tool: ${name} ${JSON.stringify(args)}`, requestId: `f7-${n}` });
      assert.equal((await store.settled(h, sub.id as number, 20000)).status, "done");
      const md = (await store.transcript(c, "markdown")).text ?? "";
      return md.slice(md.lastIndexOf("Tool "));
    };
    // The faux device lists no Haiku, as an OpenRouter-only device does not.
    assert.throws(() => store.jobModel("claude-haiku-latest"), /Unknown model claude-haiku-latest/);
    const sa = await call("subagent", { task: "say hi" }, 1);
    assert.match(sa, /claude-haiku-latest is not available on this device, so the parent's model faux\/echo was used/);
    const kids = (await store.agents(row)).filter((a) => a.kind === "subagent");
    assert.equal(kids.length, 1);
    assert.deepEqual((await store.agentDetail(row, (await store.resolveAgent(s.id, String(kids[0].id))).c)).config.model, faux);
    const ss = await call("start_session", { name: "Fallback", cwd: ".", prompt: "hello" }, 2);
    assert.match(ss, /Started session "Fallback".*with echo.*parent's model faux\/echo was used/s);
    // A model named in the call still fails when unknown, without a fallback.
    assert.match(await call("subagent", { task: "x", model: "gpt-nope" }, 3), /Unknown model gpt-nope/);
    assert.equal((await store.agents(row)).filter((a) => a.kind === "subagent").length, 1);
  } finally {
    if (saved !== undefined) process.env.DPI_SUBAGENT_MODEL = saved;
    await store.close();
    await t.cleanup();
  }
});

test("F8: an agent set to readOnly is not offered skill_update when the skills add-on is enabled afterwards", async () => {
  const t = await tempStore();
  const store = await t.open();
  try {
    const s = await store.create({ name: "ReadOnlyFirst", cwd: t.work, model: faux });
    const r = await store.resolveAgent(s.id, "main");
    await store.configure(r.row, r.c, { toolSet: "readOnly" });
    await store.setExtension(r.row, r.c, { name: "skills", enabled: true });
    const detail = await store.agentDetail(r.row, r.c);
    const offered = detail.tools.filter((x) => x.offered).map((x) => x.name);
    assert.ok(offered.includes("skill_view"));
    assert.ok(!offered.includes("skill_update"), `toolSet is now ${detail.config.toolSet}: ${offered.join(",")}`);
  } finally {
    await store.close();
    await t.cleanup();
  }
});
