// Blind review of PR #16 (the gitnexus tool), see docs/audits/review-pr16.md. Two kinds of tests:
//   finding tests  fail on the merged code; skipped with "finding: <id>" so the suite stays green. Run them with
//                  REVIEW_PR16_FINDINGS=1 npx tsx --test tests/review-pr16.test.ts
//   mutant tests   pass on the merged code and fail on a mutant the PR's own tests let survive (M1-M7 in the doc)
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import {
  checkCypher,
  CYPHER_REFUSED,
  extractJson,
  GITNEXUS_TOOLS,
  gitnexusArgv,
  noIndexMessage,
  runGitnexus,
} from "../src/toolkit-gitnexus.js";

const finding = (id: string) => (process.env.REVIEW_PR16_FINDINGS ? false : `finding: ${id}`);
const ctx = {} as Context;

/** An env whose exec answers from `reply(argv)`, recording every argv; enough for runGitnexus and the tool. */
function stubEnv(reply: (argv: string[]) => string | string[]) {
  const calls: string[][] = [];
  const env = {
    absolutePath: async (p: string) => ({ ok: true, value: `/abs/${p}` }),
    exists: async () => ({ ok: true, value: true }),
    exec: async (argv: string[], opts: { onOutput?: (c: string, x: Context, i: { stream: string }) => void }) => {
      calls.push(argv);
      const out = reply(argv);
      for (const chunk of Array.isArray(out) ? out : [out]) opts.onOutput?.(chunk, ctx, { stream: "stdout" });
      return { ok: true, value: { exitCode: 0 } };
    },
  };
  return { api: { env } as never, calls };
}

const STATUS = JSON.stringify({ repository: "/r", status: "up-to-date", index: { commit: "a" }, current: { commit: "a" } });

test("F1: a reviewed repo's .npmrc must not run its own code through the default `npx -y gitnexus@1.6.12`", { skip: finding("F1") }, async () => {
  // What a delegated agent can commit: a package.json, a script, and a project .npmrc that npx reads from its cwd.
  // npm_config_cache in the environment (as under `npm start`) does not help: neither key is overridden by it.
  const vectors = {
    "script-shell": ["script-shell=./evil.sh", "evil.sh", '#!/bin/sh\necho "$*" > PWNED\nexec /bin/sh "$@"\n'],
    "node-options": ["node-options=--require ./evil.cjs", "evil.cjs", 'require("fs").writeFileSync("PWNED", "node-options")\n'],
  };
  const saved = process.env.DPI_GITNEXUS_CMD;
  delete process.env.DPI_GITNEXUS_CMD; // the default command
  try {
    for (const [name, [npmrc, file, body]] of Object.entries(vectors)) {
      const repo = mkdtempSync(join(tmpdir(), "pr16-f1-"));
      try {
        writeFileSync(join(repo, "package.json"), '{"name":"victim","version":"1.0.0"}');
        writeFileSync(join(repo, ".npmrc"), `${npmrc}\n`);
        writeFileSync(join(repo, file), body, { mode: 0o755 });
        await runGitnexus({ env: new NodeExecutionEnv({ cwd: repo }) }, { command: "status" }, repo, ctx).catch(() => "");
        const ran = existsSync(join(repo, "PWNED")) ? readFileSync(join(repo, "PWNED"), "utf8").trim() : "";
        assert.equal(ran, "", `${name}: the repo's own code ran inside the read-only tool (${ran})`);
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    }
  } finally {
    if (saved !== undefined) process.env.DPI_GITNEXUS_CMD = saved;
  }
});

test("F2: a quote inside /* */ comments hides LOAD FROM, CALL and CREATE from the cypher guard", { skip: finding("F2") }, () => {
  for (const q of [
    `MATCH (n) WITH count(n) AS c /* ' */ LOAD FROM "/etc/passwd" (header=false) RETURN * /* ' */`,
    "MATCH (n) WITH count(n) AS c /* ' */ CALL show_tables() RETURN * /* ' */",
    `MATCH (n) /* ' */ CREATE (f:Function {id:"x", name:"x"}) /* ' */ RETURN count(n) AS c`,
    "MATCH (n) WITH n /* \" */ SET n.name = 'x' /* \" */ RETURN n",
    "MATCH (n) /* ` */ DETACH DELETE n /* ` */ RETURN 1",
  ])
    assert.throws(() => checkCypher(q), /refused/, q);
});

test("F3: a pino record without msg before the result is returned instead of the result", { skip: finding("F3") }, () => {
  // What pino prints for logger.warn({ truncation }) with no message string: level and time, no msg.
  const log = '{"level":40,"time":1793329272249,"name":"gitnexus","truncation":{"truncated":true}}';
  assert.equal(extractJson(`  GitNexus Context (1.6.12)\n${log}\n{"status":"found"}\n`), '{"status":"found"}');
});

test("M1: backtick identifiers are read queries, not unclosed strings", () => {
  for (const q of ["MATCH (`n`) RETURN `n`.name", "MATCH (n) RETURN n.name AS `set`", "MATCH (n) RETURN n.name AS `it's`"])
    assert.doesNotThrow(() => checkCypher(q), q);
});

test("M2: every keyword API.md lists is refused after a MATCH", () => {
  // The documented list, written out: iterating CYPHER_REFUSED would shrink with it.
  const documented = "CREATE MERGE DELETE DETACH SET REMOVE DROP ALTER COPY LOAD CALL INSTALL ATTACH EXPORT IMPORT CHECKPOINT USE BEGIN COMMIT ROLLBACK FOREACH";
  assert.deepEqual([...CYPHER_REFUSED].sort(), documented.split(" ").sort());
  for (const k of documented.split(" ")) assert.throws(() => checkCypher(`MATCH (n) ${k.toLowerCase()} x RETURN n`), new RegExp(`refused: .*${k}`), k);
});

test("M3: the tool refuses a repo starting with '-' before it touches the environment", async () => {
  const { api, calls } = stubEnv(() => STATUS);
  await assert.rejects(GITNEXUS_TOOLS[0].execute({ command: "status", repo: "-x" } as never, api, ctx as never) as Promise<unknown>, /Invalid repo/);
  assert.deepEqual(calls, []);
});

test("M4: output cut at the 2 MB capture says so with a '+'", async () => {
  const { api } = stubEnv((argv) => (argv.includes("status") ? STATUS : Array(25).fill("x".repeat(100_000))));
  assert.match(await runGitnexus(api, { command: "context", target: "a" }, "/r", ctx), /of \d+\+ characters/);
});

test("M5: a cypher query over 4000 characters is refused", () => {
  assert.throws(() => gitnexusArgv({ command: "cypher", query: `MATCH (n) WHERE n.name = '${"x".repeat(4000)}' RETURN n` }, "/r"), /Invalid query/);
});

test("M6: a status with an error answers no index even when it names an index, and runs nothing else", async () => {
  const { api, calls } = stubEnv(() => JSON.stringify({ ...JSON.parse(STATUS), error: "stale-lock" }));
  assert.equal(await runGitnexus(api, { command: "context", target: "a" }, "/r", ctx, "proj"), noIndexMessage("proj"));
  assert.equal(calls.length, 1);
});

test("M7: a NUL in a value is refused", () => {
  assert.throws(() => gitnexusArgv({ command: "context", target: "a\0b" }, "/r"), /Invalid target/);
});
