// The plan → build → review → fix jobs and the job-engine pieces they use: templates, JSON answers, one child
// conversation per subagent call with its own tools, and a review–fix loop.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { JOB_RUNS_DOC, type JobRun, type JobRunsDoc } from "../../dpi-sdk/src/jobs.js";
import { fillTemplate, lastJson } from "../src/jobs.js";
import type { Store } from "../src/store.js";
import { faux, tempStore, until } from "./helpers.js";

test("templates drop front matter and fill $ARGUMENTS and $1…$9", () => {
  assert.equal(fillTemplate("---\ndescription: x\n---\nPlan $1 using $2.\nAll: $ARGUMENTS", ["a b", "c"]), "Plan a b using c.\nAll: a b c");
  assert.equal(fillTemplate("Missing $3.", ["one"]), "Missing .");
});

test("the last JSON block of an answer is found, or the problem is named", () => {
  assert.deepEqual(lastJson('Done.\n```json\n{"a": 1}\n```'), { value: { a: 1 } });
  assert.deepEqual(lastJson('```json\n{"a": 1}\n```\nthen\n```\n{"a": 2}\n```'), { value: { a: 2 } });
  assert.deepEqual(lastJson('Here it is:\n{"verdict": "PASS"}'), { value: { verdict: "PASS" } });
  assert.deepEqual(lastJson("No JSON at all"), { error: "there is no JSON block" });
  assert.deepEqual(lastJson("```json\n{broken\n```"), { error: "the JSON block does not parse" });
});

const runs = async (store: Store, session: string) => {
  const { h, c } = await store.resolveAgent(session, "main");
  return ((await store.agentDoc(h, c, JOB_RUNS_DOC)) as JobRunsDoc).items;
};

/** Agent steps of a phase and the tools each one's child conversation offers. */
async function agentTools(store: Store, session: string, run: JobRun, phase: number) {
  const { h } = await store.resolveAgent(session, "main");
  const ids = [...new Set(run.phases[phase].steps.filter((s) => s.kind === "agent").map((s) => s.conversationId!))];
  return Promise.all(
    ids.map(async (id) => {
      const agent = await (await h.conversation(id as ConversationId, ctx))!.agent(ctx);
      return { id, tools: agent.tools.map((t) => t.name).sort() };
    }),
  );
}

test("plan-build, plan-build-review and plan-build-review-fix run their phases with fresh subagents", async () => {
  const t = await tempStore();
  // The session's own commands replace the built-in prompts; the faux model acts on their adw-<step>: prefix.
  mkdirSync(join(t.work, ".claude", "commands"), { recursive: true });
  for (const step of ["plan", "build", "review", "fix"])
    writeFileSync(join(t.work, ".claude", "commands", `${step}.md`), `---\ndescription: ${step}\n---\nadw-${step}: $ARGUMENTS`);
  const store = await t.open();
  try {
    const s = await store.create({ name: "ADW", cwd: t.work, model: faux });
    const m = await store.resolveAgent(s.id, "main");
    const start = async (job: string, input: Record<string, unknown>) => (await store.startJob(m.row, m.h, m.c, { job, input })).taskId as number;
    const settle = async (id: number) => {
      await until(async () => ["completed", "failed"].includes((await runs(store, s.id))[id]?.status ?? ""), 60000, `run ${id}`);
      return (await runs(store, s.id))[id];
    };

    await assert.rejects(() => start("plan-build", {}), /prompt must be a non-empty string/);

    // plan-build: a plan file, then the build; each phase its own child conversation and tool set.
    let run = await settle(await start("plan-build", { prompt: "make built.txt", model: "echo" }));
    assert.equal(run.status, "completed", run.error);
    assert.ok(existsSync(join(t.work, "specs", "faux-plan.md")));
    assert.ok(existsSync(join(t.work, "built.txt")));
    assert.match(run.phases[0].summary ?? "", /Plan in specs\/faux-plan\.md \(3 lines\)/);
    assert.equal(run.phases[1].summary, "Built it");
    assert.ok(run.phases[0].steps.some((s) => s.kind === "note" && s.label === "Prompt from .claude/commands/plan.md"));
    const [planChild] = await agentTools(store, s.id, run, 0);
    const [buildChild] = await agentTools(store, s.id, run, 1);
    assert.notEqual(planChild.id, buildChild.id);
    for (const tool of ["write", "edit", "bash", "grep"]) assert.ok(buildChild.tools.includes(tool), `build offers ${tool}`);
    const saved = (await store.deviceDoc("app.shared-state")).value as { jobs: Record<string, { summary: string; files: string[] }> };
    assert.deepEqual(saved.jobs["plan-build"].files, ["built.txt"]);

    // plan-build-review: the review has no fixed.txt, so it fails with a blocker; its subagent cannot write.
    run = await settle(await start("plan-build-review", { prompt: "make built.txt" }));
    assert.equal(run.status, "completed", run.error);
    assert.match(run.phases[2].summary ?? "", /^FAIL, 1 blocker: One blocker/);
    const [reviewChild] = await agentTools(store, s.id, run, 2);
    assert.ok(!reviewChild.tools.includes("write") && !reviewChild.tools.includes("edit"), "review is read-only");
    assert.ok(reviewChild.tools.includes("bash") && reviewChild.tools.includes("read"));

    // plan-build-review-fix: review FAIL, fix, review PASS in the second round.
    run = await settle(await start("plan-build-review-fix", { prompt: "make built.txt", max_rounds: 3 }));
    assert.equal(run.status, "completed", run.error);
    assert.ok(existsSync(join(t.work, "fixed.txt")));
    assert.match(run.phases[2].summary ?? "", /^PASS: Matches the plan \(2 reviews\)/);
    const loop = await agentTools(store, s.id, run, 2);
    assert.equal(loop.length, 3, "review, fix, review: three child conversations");
    const fixState = (await store.deviceDoc("app.shared-state")).value as { jobs: Record<string, { verdict: string; rounds: number }> };
    assert.deepEqual([fixState.jobs["plan-build-review-fix"].verdict, fixState.jobs["plan-build-review-fix"].rounds], ["PASS", 2]);

    // chore-implement: the session's chore and implement commands drive the same plan and build steps.
    writeFileSync(join(t.work, ".claude", "commands", "chore.md"), "adw-plan: $1");
    writeFileSync(join(t.work, ".claude", "commands", "implement.md"), "adw-build: $1");
    run = await settle(await start("chore-implement", { prompt: "tidy up" }));
    assert.equal(run.status, "completed", run.error);
    assert.deepEqual(run.phases.map((ph) => ph.label), ["Plan the chore", "Implement"]);
    assert.ok(run.phases[0].steps.some((st) => st.label === "Prompt from .claude/commands/chore.md"));
    assert.equal(run.phases[1].summary, "Built it");

    // An unknown model fails the run at its first subagent, naming the choices.
    run = await settle(await start("plan-build", { prompt: "x", model: "no-such-model" }));
    assert.equal(run.status, "failed");
    assert.match(run.error ?? "", /Unknown model no-such-model\. Choose one of: echo/);
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("expert-plan-build-improve plans from the expertise, builds, then updates the expertise", async () => {
  const t = await tempStore();
  const expert = join(t.work, ".claude", "commands", "experts", "faux");
  mkdirSync(expert, { recursive: true });
  writeFileSync(join(expert, "expertise.yaml"), "overview: a faux project\nfiles: []\n");
  writeFileSync(join(expert, "plan.md"), "adw-plan: $1 (expertise in $2)");
  writeFileSync(join(expert, "self-improve.md"), "adw-improve: check_git_diff=$1 file=$3");
  writeFileSync(join(t.work, ".claude", "commands", "build.md"), "adw-build: $1");
  const store = await t.open();
  try {
    const s = await store.create({ name: "Expert", cwd: t.work, model: faux });
    const m = await store.resolveAgent(s.id, "main");
    const start = async (input: Record<string, unknown>) =>
      (await store.startJob(m.row, m.h, m.c, { job: "expert-plan-build-improve", input })).taskId as number;
    const settle = async (id: number) => {
      await until(async () => ["completed", "failed"].includes((await runs(store, s.id))[id]?.status ?? ""), 60000, `run ${id}`);
      return (await runs(store, s.id))[id];
    };

    await assert.rejects(() => start({ prompt: "x" }), /expert must be a non-empty string/);

    let run = await settle(await start({ prompt: "make built.txt", expert: "faux" }));
    assert.equal(run.status, "completed", run.error);
    assert.deepEqual(run.phases.map((ph) => ph.label), ["Expert plan", "Build", "Improve the expertise"]);
    assert.equal(run.phases[2].summary, "Added built.txt (2 → 3 lines)");
    // The plan prompt names the expertise file; the improve step gets check_git_diff=true, no focus area, and the file.
    const [planChild] = await agentTools(store, s.id, run, 0);
    const [improveChild] = await agentTools(store, s.id, run, 2);
    const firstPrompt = async (id: number) => {
      const conv = (await m.h.conversation(id as ConversationId, ctx))!;
      return ((await store.transcript(conv, "markdown")).text ?? "").split("\n").find((l) => l.startsWith("adw-")) ?? "";
    };
    assert.equal(await firstPrompt(planChild.id), "adw-plan: make built.txt (expertise in .claude/commands/experts/faux/expertise.yaml)");
    assert.equal(await firstPrompt(improveChild.id), "adw-improve: check_git_diff=true file=.claude/commands/experts/faux/expertise.yaml");
    const saved = (await store.deviceDoc("app.shared-state")).value as {
      jobs: Record<string, { expert: string; lines: number; changes: string[] }>;
    };
    const result = saved.jobs["expert-plan-build-improve"];
    assert.deepEqual([result.expert, result.lines, result.changes], ["faux", 3, ["built_txt"]]);

    // A missing expertise file, or a name that is not a folder name, stops the run at the plan.
    run = await settle(await start({ prompt: "x", expert: "nobody" }));
    assert.equal(run.status, "failed");
    assert.match(run.error ?? "", /No expertise file \.claude\/commands\/experts\/nobody\/expertise\.yaml/);
    run = await settle(await start({ prompt: "x", expert: "../etc" }));
    assert.match(run.error ?? "", /expert must be a folder name/);
  } finally {
    await store.close();
    await t.cleanup();
  }
});
