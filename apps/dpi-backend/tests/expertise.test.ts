// Expertise (IDD T13, Agent Experts): the store on its own, the HTTP contract, and the add-on in live sessions (faux
// model): the system section, the tools, per-session documents and the tool sets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXPERTISE_HEADER, EXPERTISE_MAX_CHARS, ExpertiseConflict, ExpertiseInvalid, ExpertiseStore } from "../src/expertise.js";
import { WRITE_TOOLS, type Store } from "../src/store.js";
import { bootServer, faux, newToken, tempStore } from "./helpers.js";

const SECTION_INTRO =
  "# Your expertise\nLessons you wrote from your own past work. Apply them. When one proves wrong or incomplete, revise it with expertise_update.\n\n";

function withStore(fn: (store: ExpertiseStore, dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "dpi-expertise-"));
  const store = ExpertiseStore.open(join(dir, "expertise.sqlite"));
  try {
    fn(store, dir);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("expertise store: empty at revision 0, every write a revision, expectedRevision conflicts, size and reason limits", () => {
  withStore((store, dir) => {
    assert.equal(statSync(join(dir, "expertise.sqlite")).mode & 0o777, 0o600, "owner-only file");
    assert.deepEqual(store.get("oracle"), { name: "oracle", content: "", revision: 0, updatedAt: null });
    assert.deepEqual(store.revisions("oracle"), []);

    const first = store.update("oracle", { content: "- Lesson one", reason: "first task" });
    assert.equal(first.revision, 1);
    assert.match(first.updatedAt, /^\d{4}-\d\d-\d\dT/);
    assert.equal(store.update("oracle", { content: "- Lesson one\n- Lesson two", reason: "second task", expectedRevision: 1 }).revision, 2);
    assert.deepEqual(store.get("Oracle"), { name: "oracle", content: "- Lesson one\n- Lesson two", revision: 2, updatedAt: store.get("oracle").updatedAt }, "names match case-insensitively");

    // A stale expectedRevision is refused and changes nothing.
    assert.throws(() => store.update("oracle", { content: "lost", reason: "stale", expectedRevision: 1 }), ExpertiseConflict);
    assert.throws(() => store.update("oracle", { content: "lost", reason: "stale", expectedRevision: 0 }), /at revision 2, not 0/);
    assert.equal(store.get("oracle").revision, 2);

    // Limits: 8000 characters exactly is fine, one more is not; the reason is required and bounded.
    assert.equal(store.update("oracle", { content: "x".repeat(EXPERTISE_MAX_CHARS), reason: "at the limit" }).revision, 3);
    assert.throws(() => store.update("oracle", { content: "x".repeat(EXPERTISE_MAX_CHARS + 1), reason: "too long" }), /8001 characters; the limit is 8000/);
    assert.throws(() => store.update("oracle", { content: "ok", reason: "  " }), ExpertiseInvalid);
    assert.throws(() => store.update("oracle", { content: "ok", reason: "r".repeat(501) }), /reason must be at most 500/);
    assert.throws(() => store.update("oracle", { content: 7, reason: "not text" }), /content must be a string/);
    assert.throws(() => store.update("oracle", { content: "ok", reason: "r", expectedRevision: -1 }), /non-negative integer/);
    assert.throws(() => store.update(" ", { content: "ok", reason: "r" }), /name is required/);
    assert.equal(store.get("oracle").revision, 3, "refused writes leave no revision");

    // Reset empties the document as a new revision and keeps every earlier one with its content.
    assert.deepEqual(store.reset("oracle", { reason: "start over" }), { name: "oracle", revision: 4 });
    assert.equal(store.get("oracle").content, "");
    assert.deepEqual(
      store.revisions("oracle").map((r) => [r.revision, r.reason, r.chars]),
      [
        [4, "start over", 0],
        [3, "at the limit", 8000],
        [2, "second task", 25],
        [1, "first task", 12],
      ],
    );
    assert.deepEqual(store.revisions("oracle", 2).map((r) => r.revision), [4, 3]);
    assert.equal(store.revision("oracle", 1)?.content, "- Lesson one");
    assert.equal(store.revision("oracle", 2)?.content, "- Lesson one\n- Lesson two");

    // Documents are separate per name.
    assert.deepEqual(store.get("exam"), { name: "exam", content: "", revision: 0, updatedAt: null });
    assert.equal(store.update("exam", { content: "exam lesson", reason: "r" }).revision, 1);
    assert.equal(store.get("oracle").revision, 4);

    // It survives a reopen.
    const again = ExpertiseStore.open(join(dir, "expertise.sqlite"));
    assert.equal(again.get("exam").content, "exam lesson");
    assert.equal(again.revisions("oracle").length, 4);
    again.close();
  });
});

test("expertise routes: empty read, PUT, 400, 409, revisions newest first, DELETE keeps history; the add-on sees an API write on its next request", async () => {
  const t = await tempStore();
  const token = newToken();
  const server = await bootServer({ home: join(t.root, "home"), startDirs: t.work, token });
  const call = async (method: string, path: string, body?: unknown, auth = true) => {
    const res = await fetch(`${server.base}/v1${path}`, {
      method,
      headers: { ...(auth ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  try {
    assert.equal((await call("GET", "/expertise/oracle", undefined, false)).status, 401, "same auth as every /v1 route");
    assert.deepEqual(await call("GET", "/expertise/oracle"), { status: 200, body: { name: "oracle", content: "", revision: 0, updatedAt: null } });
    assert.deepEqual(await call("GET", "/expertise/oracle/revisions"), { status: 200, body: { items: [] } });

    const put = await call("PUT", "/expertise/oracle", { content: "- Verify git state with git, never guess.", reason: "missed unpushed work" });
    assert.equal(put.status, 200);
    assert.deepEqual(Object.keys(put.body).sort(), ["name", "revision", "updatedAt"]);
    assert.equal(put.body.name, "oracle");
    assert.equal(put.body.revision, 1);
    const got = await call("GET", "/expertise/oracle");
    assert.deepEqual(got.body, { name: "oracle", content: "- Verify git state with git, never guess.", revision: 1, updatedAt: put.body.updatedAt });

    // 400: too long, no reason, a long reason, a bad expectedRevision. 409: a stale expectedRevision.
    const tooLong = await call("PUT", "/expertise/oracle", { content: "x".repeat(8001), reason: "r" });
    assert.equal(tooLong.status, 400);
    assert.equal(tooLong.body.error.code, "invalid");
    assert.equal((await call("PUT", "/expertise/oracle", { content: "ok" })).status, 400);
    assert.equal((await call("PUT", "/expertise/oracle", { content: "ok", reason: "" })).status, 400);
    assert.equal((await call("PUT", "/expertise/oracle", { content: "ok", reason: "r".repeat(501) })).status, 400);
    assert.equal((await call("PUT", "/expertise/oracle", { content: "ok", reason: "r", expectedRevision: "1" })).status, 400);
    const stale = await call("PUT", "/expertise/oracle", { content: "lost", reason: "stale", expectedRevision: 0 });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, "conflict");
    const fresh = await call("PUT", "/expertise/oracle", { content: "- Lesson A\n- Lesson B", reason: "second task", expectedRevision: 1 });
    assert.deepEqual([fresh.status, fresh.body.revision], [200, 2]);
    assert.equal((await call("GET", "/expertise/oracle")).body.revision, 2, "refused writes changed nothing");

    // DELETE empties the document as a new revision and keeps the history.
    assert.equal((await call("DELETE", "/expertise/oracle", {})).status, 400, "reason is required");
    assert.deepEqual(await call("DELETE", "/expertise/oracle", { reason: "start over" }), { status: 200, body: { name: "oracle", revision: 3 } });
    assert.deepEqual((await call("GET", "/expertise/oracle")).body.content, "");
    const revs = await call("GET", "/expertise/oracle/revisions");
    assert.equal(revs.status, 200);
    assert.deepEqual(
      revs.body.items.map((r: any) => [r.revision, r.reason, r.chars]),
      [
        [3, "start over", 0],
        [2, "second task", 21],
        [1, "missed unpushed work", 41],
      ],
    );
    assert.deepEqual(Object.keys(revs.body.items[0]).sort(), ["chars", "createdAt", "reason", "revision"]);
    assert.deepEqual((await call("GET", "/expertise/oracle/revisions?limit=1")).body.items.map((r: any) => r.revision), [3]);
    assert.equal((await call("GET", "/expertise/oracle/revisions?limit=x")).status, 400);

    // The add-on in a live session named "exam": no section while empty; an API write shows on the next request.
    const session = await call("POST", "/sessions", { name: "exam", cwd: t.work, model: faux });
    assert.equal(session.status, 201);
    const a = `/sessions/${session.body.id}/agents/main`;
    const ext = await call("GET", `${a}/extensions`);
    assert.equal(ext.body.extensions.find((e: any) => e.name === "expertise")?.enabled, false, "off by default");
    assert.equal((await call("PATCH", `${a}/extensions`, { name: "expertise", enabled: true })).status, 200);
    let n = 0;
    const turn = async (content: string) => {
      const sent = await call("POST", `${a}/messages`, { content, requestId: `exp-${n++}`, waitMs: 20000 });
      assert.equal(sent.body.status, "done", JSON.stringify(sent.body));
      const entries = (await call("GET", `${a}/entries?limit=500`)).body.items as { kind: string }[];
      return JSON.stringify(entries.find((e) => e.kind === "pi.system") ?? null);
    };
    assert.doesNotMatch(await turn("hello"), /Your expertise/, "an empty document adds no section");
    assert.equal((await call("PUT", "/expertise/exam", { content: "- Exam lesson q7x9z: grade blind.", reason: "from the API" })).status, 200);
    const system = await turn("hello again");
    assert.ok(system.includes(JSON.stringify(`${SECTION_INTRO}- Exam lesson q7x9z: grade blind.`).slice(1, -1)), system.slice(0, 2000));
    assert.doesNotMatch(system, /Verify git state/, "the oracle's document is not the exam session's");
  } finally {
    await server.stop();
    await t.cleanup();
  }
});

test("expertise add-on: tools read and rewrite the session's own document; too long is a message; per session; readOnly drops expertise_update, oracle keeps it", async () => {
  const t = await tempStore();
  const store = await t.open();
  try {
    assert.ok(existsSync(join(t.options.dataDir, "expertise.sqlite")));
    assert.equal(statSync(store.expertisePath).mode & 0o777, 0o600);
    assert.ok(new Set([store.expertisePath, store.memoryPath, store.libraryPath]).size === 3, "its own file");
    assert.ok(WRITE_TOOLS.has("expertise_update") && !WRITE_TOOLS.has("expertise_read"));

    const open = async (name: string) => {
      const s = await store.create({ name, cwd: t.work, model: faux });
      const resolved = await store.resolveAgent(s.id, "main");
      await store.setExtension(resolved.row, resolved.c, { name: "expertise", enabled: true });
      return resolved;
    };
    let n = 0;
    const lastTool = async (r: Awaited<ReturnType<Store["resolveAgent"]>>, content: string) => {
      const sub = await store.send(r.c, { content, requestId: `t-${n++}` });
      assert.equal((await store.settled(r.h, sub.id as number, 20000)).status, "done");
      const md = (await store.transcript(r.c, "markdown")).text ?? "";
      return md.slice(md.lastIndexOf("Tool finished:"));
    };
    const tool = (name: string, args: unknown) => `tool: ${name} ${JSON.stringify(args)}`;

    const oracle = await open("Oracle");
    const exam = await open("exam");
    assert.match(await lastTool(oracle, tool("expertise_read", {})), /Expertise "oracle" is empty \(revision 0\)/);
    assert.match(
      await lastTool(oracle, tool("expertise_update", { content: "- Oracle lesson: delegate builds.", reason: "first task" })),
      /Saved expertise "oracle" as revision 1\./,
    );
    assert.deepEqual(
      [store.expertise.get("oracle").content, store.expertise.get("oracle").revision],
      ["- Oracle lesson: delegate builds.", 1],
      "the document is named after the session",
    );
    assert.match(await lastTool(oracle, tool("expertise_read", {})), /Expertise "oracle", revision 1:[\s\S]*- Oracle lesson: delegate builds\./);

    // Too long: nothing saved, and the model is told how much to cut.
    const long = await lastTool(oracle, tool("expertise_update", { content: "y".repeat(EXPERTISE_MAX_CHARS + 50), reason: "too much" }));
    assert.match(long, /Not saved: the document is 8050 characters and the limit is 8000\. Shorten it by at least 50 characters/);
    assert.equal(store.expertise.get("oracle").revision, 1);
    assert.match(await lastTool(oracle, tool("expertise_update", { content: "z", reason: " " })), /Not saved: reason is required/);

    // The other session sees only its own document.
    assert.match(await lastTool(exam, tool("expertise_read", {})), /Expertise "exam" is empty \(revision 0\)/);
    assert.match(await lastTool(exam, tool("expertise_update", { content: "- Exam lesson.", reason: "exam task" })), /Saved expertise "exam" as revision 1\./);
    assert.equal(store.expertise.get("oracle").content, "- Oracle lesson: delegate builds.");
    assert.equal(store.expertise.get("exam").content, "- Exam lesson.");
    assert.equal(store.expertise.revisions("exam").length, 1);

    // Each session's system section shows its own lessons, and a store write shows on the next request.
    const system = async (r: typeof oracle) =>
      JSON.stringify((await store.entries(r.c, undefined, 500)).items.find((e) => e.kind === "pi.system") ?? null);
    await lastTool(exam, "hello");
    assert.match(await system(exam), /# Your expertise[\s\S]*- Exam lesson\./);
    assert.doesNotMatch(await system(exam), /Oracle lesson/);
    store.expertise.update("exam", { content: "- Revised exam lesson.", reason: "outside write" });
    await lastTool(exam, "hello again");
    assert.match(await system(exam), /- Revised exam lesson\./);
    assert.ok(EXPERTISE_HEADER.startsWith("# Your expertise\n"));

    // Turned off, the section goes away.
    await store.setExtension(exam.row, exam.c, { name: "expertise", enabled: false });
    await lastTool(exam, "off now");
    assert.doesNotMatch(await system(exam), /Your expertise/);

    // Tool sets: readOnly drops the writer and keeps the reader; oracle keeps both.
    const offered = async () => (await store.agentDetail(oracle.row, oracle.c)).tools.filter((x) => x.offered).map((x) => x.name);
    await store.configure(oracle.row, oracle.c, { toolSet: "readOnly" });
    let names = await offered();
    assert.ok(names.includes("expertise_read") && !names.includes("expertise_update"), names.join(","));
    await store.configure(oracle.row, oracle.c, { toolSet: "oracle" });
    names = await offered();
    assert.ok(names.includes("expertise_read") && names.includes("expertise_update"), names.join(","));
    assert.ok(!names.includes("bash"));
  } finally {
    await store.close();
    await t.cleanup();
  }
});
