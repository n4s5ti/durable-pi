// DPI memory: the store on its own, then the extension in a live session (faux model).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ftsQuery, MemoryStore, rulesBlock } from "../src/memory.js";
import { faux, tempStore } from "./helpers.js";

const withStore = (fn: (m: MemoryStore, dir: string) => void) => {
  const dir = mkdtempSync(join(tmpdir(), "dpi-memory-"));
  const m = MemoryStore.open(join(dir, "memory.sqlite"));
  try {
    fn(m, dir);
  } finally {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  }
};

test("memory: stores, dedupes, searches by words, filters by kind, and survives a reopen", () => {
  withStore((m, dir) => {
    const gpu = m.add({ kind: "fact", text: "The user's workstation has an RTX 3080 Ti GPU.", tags: ["hardware"] });
    assert.equal(gpu.created, true);
    assert.equal(m.add({ kind: "fact", text: "The user's workstation has an RTX 3080 Ti GPU." }).created, false, "same kind and text");
    m.add({ kind: "preference", text: "The user prefers terse, evidence-first answers." });
    m.add({ kind: "fact", text: "pip3r is a CLI framework built on Stricli.", originId: "hindsight:hermes-default:1" });
    assert.equal(m.add({ kind: "fact", text: "changed text", originId: "hindsight:hermes-default:1" }).created, false, "same originId");

    assert.match(m.search("what GPU does my workstation have")[0].text, /RTX 3080 Ti/);
    assert.deepEqual(m.search("answers", { kinds: ["fact"] }), []);
    assert.equal(m.search("answers", { kinds: ["preference"] }).length, 1);
    assert.equal(m.search("").length, 3, "an empty query lists the newest");
    assert.throws(() => m.add({ kind: "nope" as never, text: "x" }), /kind must be one of/);
    assert.throws(() => m.add({ kind: "fact", text: "  " }), /text is required/);
    const again = MemoryStore.open(join(dir, "memory.sqlite"));
    assert.equal(again.stats().total, 3, "a second handle on the file sees the same memories");
    again.close();
  });
});

test("memory: query words never become FTS syntax", () => {
  assert.equal(ftsQuery('rm -rf "*" OR NOT near(x)'), '"rm" OR "rf" OR "not" OR "near"');
  assert.equal(ftsQuery("the and of"), "");
  withStore((m) => {
    m.add({ kind: "fact", text: "Quoted \"words\" and stars * survive." });
    assert.equal(m.search('"words" * AND (').length, 1);
  });
});

test("memory: feedback becomes standing rules, oldest first; forget retires one and keeps the record", () => {
  withStore((m) => {
    const a = m.add({ kind: "feedback", text: "Bags should not say 'riveting stuff'." }).memory;
    m.add({ kind: "feedback", text: "Give the answer before the detail." });
    m.add({ kind: "fact", text: "Not a rule." });
    assert.deepEqual(m.rules().map((r) => r.text), ["Bags should not say 'riveting stuff'.", "Give the answer before the detail."]);
    assert.match(rulesBlock(m.rules()), /Standing feedback from the user[\s\S]*- Give the answer before the detail\./);
    m.forget(a.id, "user changed their mind");
    assert.deepEqual(m.rules().map((r) => r.text), ["Give the answer before the detail."]);
    assert.equal(m.get(a.id)?.active, false);
    assert.equal(m.search("riveting").length, 0);
    assert.deepEqual(m.stats(), { total: 2, forgotten: 1, byKind: { feedback: 1, fact: 1 } });
    assert.equal(rulesBlock([]), "");
  });
});

test("memory: addMany imports in one transaction and counts what it skipped", () => {
  withStore((m) => {
    const result = m.addMany([
      { kind: "fact", text: "one", originId: "x:1" },
      { kind: "fact", text: "two", originId: "x:2" },
      { kind: "fact", text: "one again", originId: "x:1" },
      { kind: "bogus" as never, text: "bad" },
    ]);
    assert.deepEqual(result, { added: 2, skipped: 1, invalid: 1, errors: ["kind must be one of fact, preference, feedback, event, observation"] });
  });
});

test("memory extension: remember, recall and forget as tools; recall and rules reach the model", async () => {
  const t = await tempStore();
  const store = await t.open();
  try {
    const s = await store.create({ name: "Mem", cwd: t.work, model: faux });
    const { row, h, c } = await store.resolveAgent(s.id, "main");
    await store.setExtension(row, c, { name: "memory", enabled: true });
    let n = 0;
    const send = async (content: string) => {
      const sub = await store.send(c, { content, requestId: `mem-${n++}` });
      assert.equal((await store.settled(h, sub.id as number, 15000)).status, "done");
      return (await store.transcript(c, "markdown")).text ?? "";
    };
    let out = await send('tool: remember {"kind":"fact","text":"The user\'s workstation has an RTX 3080 Ti GPU."}');
    assert.match(out.slice(out.lastIndexOf("Tool finished:")), /Remembered as memory 1\./);
    out = await send('tool: remember {"kind":"feedback","text":"Lead with the answer."}');
    assert.equal(store.memory.rules().length, 1);
    out = await send('tool: recall {"query":"GPU"}');
    assert.match(out.slice(out.lastIndexOf("Tool finished:")), /\[1\] \(fact\) The user's workstation has an RTX 3080 Ti GPU\./);

    // Auto-recall puts matching memories in front of the user's message; the faux model echoes what it got.
    out = await send("what GPU is in my workstation");
    assert.match(out.slice(out.lastIndexOf("Echo:")), /DPI memory \(recalled for this request\)[\s\S]*RTX 3080 Ti/);

    out = await send('tool: forget {"id":2,"reason":"withdrawn"}');
    assert.equal(store.memory.rules().length, 0);
    const readOnly = await store.configure(row, c, { toolSet: "readOnly" });
    assert.equal(readOnly.toolSet, "readOnly");
    const offered = (await store.agentDetail(row, c)).tools.filter((x) => x.offered).map((x) => x.name);
    assert.ok(offered.includes("recall") && !offered.includes("remember") && !offered.includes("forget"));
  } finally {
    await store.close();
    await t.cleanup();
  }
});
