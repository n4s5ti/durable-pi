// The course library: the store on its own, the extension in a live session (faux model), the routes, and its
// separation from Bags memory. All passages here are synthetic; no course material is used.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LibraryStore, lessonMatches, type NewLibraryItem } from "../src/library.js";
import type { Embedder } from "../src/memory.js";
import { bootServer, faux, newToken, tempStore } from "./helpers.js";

const item = (n: number, lesson: string, text: string, kind: "transcript" | "doc" = "transcript", source = "idd"): NewLibraryItem => ({
  source,
  lesson,
  kind,
  ref: kind === "transcript" ? `transcripts/${lesson.split(" ")[0]}.vtt@00:0${n % 10}:00` : `docs/${lesson.split(" ")[0]}.md#Heading ${n}`,
  text,
  originId: `${source}:${lesson.split(" ")[0]}:${n}`,
});

const CORPUS: NewLibraryItem[] = [
  item(1, "T1 Hello Agentic Coding", "Welcome to the first lesson, where we install the tools and say hello."),
  item(2, "T3 Success Is Planned", "The plan is the prompt: write the spec before you build anything."),
  item(3, "T5 Close The Loops", "Close the loops: the agent runs the tests and validates its own work."),
  item(4, "T5 Close The Loops", "Loop review: a reviewer agent checks screenshots against the spec.", "doc"),
  item(5, "T7 ZTE", "Zero touch engineering ships a change without a person in the middle."),
  item(6, "T8 The Agentic Layer", "An AI developer workflow chains agents into a deterministic pipeline."),
  item(7, "T10 Agentic Prompt Engineering", "Marker q7x9z: prompt formats rise in tiers.", "doc"),
];

// A tiny deterministic embedder: each concept is one dimension, so a paraphrase lands on the same axis.
const CONCEPTS: RegExp[] = [/loop|tests?\b|validat|verif|correct/i, /plan|spec\b|blueprint/i, /workflow|pipeline|assembly/i, /zero touch|unattended|without a person/i];
class FakeEmbedder implements Embedder {
  fail = false;
  async embed(texts: string[]) {
    if (this.fail) throw Error("embedder down");
    return texts.map((t) => {
      const v = Float32Array.from(CONCEPTS.map((c) => (c.test(t) ? 1 : 0)), (x) => x + 0.01);
      const n = Math.hypot(...v);
      return v.map((x) => x / n);
    });
  }
}

async function withLibrary(embedder: Embedder | undefined, fn: (lib: LibraryStore, dir: string) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "dpi-library-"));
  const lib = LibraryStore.open(join(dir, "library.sqlite"), embedder);
  try {
    await fn(lib, dir);
  } finally {
    lib.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("library: imports idempotently by originId, validates items, is owner-only and survives a reopen", async () => {
  await withLibrary(undefined, (lib, dir) => {
    assert.deepEqual(lib.addMany(CORPUS), { added: 7, skipped: 0, invalid: 0, errors: [] });
    const again = lib.addMany([...CORPUS, { ...CORPUS[0], text: "xyzzy replacement, same originId" }]);
    assert.deepEqual(again, { added: 0, skipped: 8, invalid: 0, errors: [] }, "a second import adds nothing");
    assert.equal(lib.search("xyzzy").length, 0, "the stored text is the first import's");
    const bad = lib.addMany([
      { ...CORPUS[0], originId: "idd:x:1", kind: "video" as never },
      { ...CORPUS[0], originId: "idd:x:2", source: "Bad Source" },
      { ...CORPUS[0], originId: "" },
    ]);
    assert.equal(bad.invalid, 3);
    assert.match(bad.errors.join("|"), /kind must be one of transcript, doc/);
    assert.match(bad.errors.join("|"), /source must be lowercase/);
    assert.match(bad.errors.join("|"), /originId is required/);
    assert.equal(statSync(join(dir, "library.sqlite")).mode & 0o777, 0o600, "owner-only file");
    const second = LibraryStore.open(join(dir, "library.sqlite"));
    assert.equal(second.stats().total, 7);
    assert.deepEqual(second.stats().byKind, { transcript: 5, doc: 2 });
    assert.equal(second.stats().byLesson["T5 Close The Loops"], 2);
    second.close();
  });
});

test("library: keyword recall stems words and filters by lesson; T1 never matches T10", async () => {
  await withLibrary(undefined, async (lib) => {
    lib.addMany(CORPUS);
    const found = await lib.recall("validate the tests", { limit: 3 });
    assert.equal(found[0].originId, "idd:T5:3", "porter stemming: validate ~ validates");
    assert.equal(found[0].similarity, undefined, "no embedder, no similarity");
    assert.deepEqual(
      (await lib.recall("agent", { lesson: "T5" })).map((h) => h.lesson),
      ["T5 Close The Loops", "T5 Close The Loops"],
    );
    assert.equal((await lib.recall("agent", { lesson: "T8 the agentic layer" })).length, 1);
    assert.equal((await lib.recall("agent", { lesson: "8" })).length, 1, "a bare number is the lesson");
    assert.ok(lessonMatches("T1 Hello Agentic Coding", "T1"));
    assert.ok(!lessonMatches("T10 Agentic Prompt Engineering", "T1"));
    assert.equal((await lib.recall("prompt", { lesson: "T1" })).length, 0, "T10's prompt passage is not T1's");
    assert.deepEqual(await lib.recall("the and of"), [], "stop words alone find nothing");
  });
});

test("library: semantic and keyword recall are fused; a paraphrase finds the passage, a rare word still counts", async () => {
  const embedder = new FakeEmbedder();
  await withLibrary(embedder, async (lib) => {
    lib.addMany(CORPUS);
    while (lib.pendingEmbeddings() > 0) await lib.backfill();
    // No shared words with the passage, so only the semantic list can find it.
    assert.equal(lib.search("verifying correctness automatically").length, 0);
    const para = await lib.recall("verifying correctness automatically", { limit: 3 });
    assert.equal(para[0].lesson, "T5 Close The Loops");
    assert.ok((para[0].similarity ?? 0) > 0.9);
    assert.equal((await lib.recall("an assembly line of coding agents", { limit: 1 }))[0].originId, "idd:T8:6");
    assert.equal((await lib.recall("blueprint ahead", { limit: 1 }))[0].originId, "idd:T3:2");
    // Fusion: the rare word is only on the keyword list, the concept only on the semantic one; both make the top two.
    const both = await lib.recall("verifying correctness q7x9z", { limit: 2 });
    assert.deepEqual(new Set(both.map((h) => h.originId)), new Set(["idd:T10:7", "idd:T5:3"]));
    // The lesson filter holds on the semantic list too.
    const t3 = await lib.recall("verifying correctness automatically", { lesson: "T3", limit: 8 });
    assert.ok(t3.length > 0 && t3.every((h) => h.lesson === "T3 Success Is Planned"), JSON.stringify(t3.map((h) => h.lesson)));
    embedder.fail = true;
    assert.equal((await lib.recall("zero touch engineering", { limit: 1 }))[0].originId, "idd:T7:5", "keywords when the embedder is down");
    assert.equal(lib.stats().embedError, "embedder down");
  });
});

test("library: wipe removes one source, its vectors and its search entries, and leaves the others", async () => {
  await withLibrary(new FakeEmbedder(), async (lib) => {
    lib.addMany(CORPUS);
    lib.addMany([item(1, "B1 Other Course", "A different course about pipelines and plans.", "doc", "other")]);
    while (lib.pendingEmbeddings() > 0) await lib.backfill();
    assert.deepEqual(lib.wipe("idd"), { source: "idd", deleted: 7 });
    assert.deepEqual(lib.wipe("idd"), { source: "idd", deleted: 0 });
    assert.equal(lib.stats().total, 1);
    assert.deepEqual(lib.stats().bySource, { other: 1 });
    assert.equal(lib.search("zero touch engineering").length, 0);
    const left = await lib.recall("deterministic pipeline workflow", { limit: 8 });
    assert.deepEqual(left.map((h) => h.source), ["other"]);
    assert.equal(lib.addMany(CORPUS).added, 7, "a wiped source imports again");
  });
});

test("library extension: library_recall output, auto-recall above the threshold only, beside memory and never in it", async () => {
  const t = await tempStore();
  const store = await t.open();
  try {
    assert.ok(existsSync(join(t.options.dataDir, "library.sqlite")) && store.libraryPath !== store.memoryPath);
    store.library.addMany(CORPUS);
    const s = await store.create({ name: "Lib", cwd: t.work, model: faux });
    const { row, h, c } = await store.resolveAgent(s.id, "main");
    assert.equal((await store.extensionsOf(row, c)).extensions.find((e) => e.name === "library")?.enabled, false, "off by default");
    await store.setExtension(row, c, { name: "library", enabled: true });
    await store.setExtension(row, c, { name: "memory", enabled: true });
    let n = 0;
    const send = async (content: string) => {
      const sub = await store.send(c, { content, requestId: `lib-${n++}` });
      assert.equal((await store.settled(h, sub.id as number, 15000)).status, "done");
      const md = (await store.transcript(c, "markdown")).text ?? "";
      return md;
    };
    let out = await send('tool: library_recall {"query":"agent tests","lesson":"T5","limit":2}');
    const result = out.slice(out.lastIndexOf("Tool finished:"));
    assert.match(result, /1\. \[T5 Close The Loops · transcripts\/T5\.vtt@00:03:00 \(transcript\)\]\nClose the loops: the agent runs the tests/);
    assert.match(result, /2\. \[T5 Close The Loops · docs\/T5\.md#Heading 4 \(doc\)\]/);
    assert.doesNotMatch(result, /T8|T3/);
    out = await send('tool: library_recall {"query":"nothing like this xyzzy"}');
    assert.match(out.slice(out.lastIndexOf("Tool finished:")), /No matching passages in the course library\./);

    // Auto-recall (keyword-only here: most of the message's words must be in the passage). The faux model echoes.
    out = await send("zero touch engineering ships change");
    const echo = out.slice(out.lastIndexOf("Echo:"));
    assert.match(echo, /Course library \(passages recalled for this request\)[\s\S]*\[T7 ZTE · transcripts\/T7\.vtt@00:05:00 \(transcript\)\]/);
    assert.equal((echo.match(/^- \[/gm) ?? []).length, 1, "only passages above the threshold");
    out = await send("what is the weather like in denver");
    assert.doesNotMatch(out.slice(out.lastIndexOf("Echo:")), /Course library/);

    // Memory sits beside it and never sees the library: recall, rules and stats stay empty.
    store.memory.add({ kind: "fact", text: "The user's workstation has an RTX 3080 Ti GPU." });
    out = await send("zero touch engineering ships change on my workstation GPU");
    const both = out.slice(out.lastIndexOf("Echo:"));
    assert.match(both, /Your long-term memory \(recalled for this request\)/);
    assert.match(both, /Course library \(passages recalled/);
    assert.deepEqual(await store.memory.recall("zero touch engineering"), []);
    assert.deepEqual(store.memory.rules(), []);
    assert.equal(store.memory.stats().total, 1);

    // library_recall only reads: the read-only set keeps it.
    await store.configure(row, c, { toolSet: "readOnly" });
    const offered = (await store.agentDetail(row, c)).tools.filter((x) => x.offered).map((x) => x.name);
    assert.ok(offered.includes("library_recall"));
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("library routes: import in batches, recall with a lesson, stats, wipe; /v1/memory never returns passages", async () => {
  const t = await tempStore();
  const token = newToken();
  const server = await bootServer({ home: join(t.root, "home"), startDirs: t.work, token });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${server.base}/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  try {
    assert.deepEqual((await call("POST", "/library/import", { items: CORPUS.slice(0, 4) })).body, { added: 4, skipped: 0, invalid: 0, errors: [] });
    assert.deepEqual((await call("POST", "/library/import", { items: CORPUS })).body, { added: 3, skipped: 4, invalid: 0, errors: [] });
    assert.equal((await call("POST", "/library/import", { items: Array(1001).fill(CORPUS[0]) })).status, 400);
    const found = await call("GET", "/library?query=agent%20tests&lesson=T5&limit=1");
    assert.equal(found.status, 200);
    assert.equal(found.body.items.length, 1);
    assert.deepEqual(Object.keys(found.body.items[0]).sort(), ["createdAt", "id", "kind", "lesson", "originId", "ref", "score", "source", "text"]);
    assert.equal(found.body.items[0].lesson, "T5 Close The Loops");
    assert.equal((await call("GET", "/library/stats")).body.total, 7);
    assert.deepEqual((await call("GET", "/memory?query=zero%20touch%20engineering")).body.items, []);
    assert.deepEqual((await call("GET", "/memory/rules")).body.items, []);
    assert.equal((await call("GET", "/memory/stats")).body.total, 0);
    assert.equal((await call("DELETE", "/library")).status, 400, "source is required");
    assert.deepEqual((await call("DELETE", "/library?source=idd")).body, { source: "idd", deleted: 7 });
    assert.equal((await call("GET", "/library/stats")).body.total, 0);
  } finally {
    await server.stop();
    await t.cleanup();
  }
});
