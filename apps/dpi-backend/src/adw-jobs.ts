// AI developer workflows as durable jobs: the plan → build → review → fix family. Each phase is a subagent in a fresh
// child conversation with its own tools and model; every result comes back as checked JSON and moves to the next
// phase in the run's checkpoint, so a restart resumes at the phase that was running.
//
//   plan-build              plan the work to specs/, then build it
//   plan-build-review       … then review the changes against the plan: PASS or FAIL with issues
//   plan-build-review-fix   … then fix the blockers and review again, up to max_rounds reviews
//   chore-implement         plan a maintenance chore, then implement it
//   expert-plan-build-improve  plan with an expert's expertise.yaml, build, then update the expertise
//
// The prompts are the session folder's .claude/commands/<name>.md when it exists (plan, build, review, fix, chore,
// implement, experts/<expert>/plan, experts/<expert>/self-improve), else the built-in ones below. A command gets its
// arguments as $1, $2… and all of them as $ARGUMENTS. A session's command must be a whole prompt: subagents here run
// tools, not other slash commands.
import type { JobDef, JobInputSpec } from "../../dpi-sdk/src/jobs.js";
import type { Data, Handler, Phase } from "./jobs.js";

const PLAN = `Plan this work: $1

Read the code you need first. Then write an implementation plan to a new markdown file under specs/ (create the folder
if needed), named for the work in kebab-case. The plan states the goal, the files to change and why, the steps in
order, and the commands that check the result. Write no other file.`;

const BUILD = `Implement the plan in $1.

Follow its steps in order and change only what they need. Then run the checks the plan names and fix what they report.
Do not commit.`;

const REVIEW = `Review the work done for: $1

The plan is $2. Compare the changes (git diff, and new files from git status) with the plan and the request. Run the
plan's checks. List each problem as a blocker (the work is wrong or incomplete), tech_debt (works, but should be
improved) or skippable. The verdict is PASS when there are no blockers. Do not change any file.`;

const CHORE = `Plan this chore: $1

A chore is maintenance: a refactor, a dependency or config change, cleanup, docs. Read the code it touches. Then write
a short plan to a new markdown file under specs/ (create the folder if needed), named chore-<name>.md in kebab-case:
what changes, the files, the steps in order, and the commands that check nothing broke. Write no other file.`;

const IMPLEMENT = `Implement the plan in $1.

Follow its steps in order and change only what they need. Then run the checks the plan names. Do not commit.`;

const EXPERT_PLAN = `Plan this work: $1

First read the expertise file $2 in full: it is the working knowledge of this part of the code (its files, how they
fit together, its conventions and pitfalls). Use it to find the right files fast, then read the code you need. Write
an implementation plan to a new markdown file under specs/ (create the folder if needed), named for the work in
kebab-case: the goal, the files to change and why, the steps in order, and the commands that check the result. Write
no other file.`;

const EXPERT_IMPROVE = `Bring the expertise file $3 up to date with the code.

It is the working knowledge of one part of the code. Compare it with the code it describes and with the changes just
made (git diff and git status). Correct what is wrong or outdated, add what the changes introduced, remove what no
longer exists. Keep its structure, keep it valid YAML, and keep it under 1000 lines. Change no other file.`;

const FIX = `Fix the blockers a review found in the work for: $1

The plan is $2. The review's issues:
$3

Change only what the fixes need, then run the plan's checks again. Do not commit.`;

type Issue = { severity: "blocker" | "tech_debt" | "skippable"; description: string };
type Review = { verdict: "PASS" | "FAIL"; issues: Issue[]; summary: string };

const isText = (v: unknown) => typeof v === "string" && v.trim() !== "";
const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
const model = (p: Phase, name: string) => String(p.input[name] ?? "auto");

/** A planning subagent writes a plan file; the phase checks the file exists. */
async function plan(p: Phase, command = "plan", fallback = PLAN, args = [String(p.input.prompt)]) {
  const prompt = await p.template(command, args, fallback);
  const { plan_path } = await p.agentJson<{ plan_path: string }>(
    prompt,
    '{"plan_path": "specs/<name>.md"}',
    (v) => (isText((v as { plan_path?: unknown })?.plan_path) ? undefined : "plan_path must name the plan file"),
    { tools: "code", model: model(p, "model") },
  );
  const lines = (await p.exec(`test -f ${quote(plan_path)} && wc -l < ${quote(plan_path)}`, `check ${plan_path}`)).trim();
  return { done: `Plan in ${plan_path} (${lines} lines)`, data: { plan_path } };
}

/** A building subagent implements the plan in the run's data. */
async function build(p: Phase, command = "build", fallback = BUILD) {
  const planPath = String(p.data.plan_path);
  const prompt = await p.template(command, [planPath], fallback);
  const built = await p.agentJson<{ summary: string; files: string[] }>(
    prompt,
    '{"summary": "<what changed>", "files": ["<path>", "…"]}',
    (v) => {
      const b = v as { summary?: unknown; files?: unknown };
      if (!isText(b?.summary)) return "summary must say what changed";
      if (!Array.isArray(b.files) || b.files.some((f) => typeof f !== "string")) return "files must list the changed paths";
    },
    { tools: "code", model: model(p, "model") },
  );
  return { done: built.summary, data: { build_summary: built.summary, files: built.files } };
}

function checkReview(v: unknown) {
  const r = v as Partial<Review>;
  if (r?.verdict !== "PASS" && r?.verdict !== "FAIL") return 'verdict must be "PASS" or "FAIL"';
  if (!Array.isArray(r.issues)) return "issues must be a list (empty when there are none)";
  for (const i of r.issues)
    if (!["blocker", "tech_debt", "skippable"].includes(i?.severity) || !isText(i?.description))
      return "each issue needs severity blocker, tech_debt or skippable, and a description";
  if (!isText(r.summary)) return "summary must sum up the review";
}

async function review(p: Phase): Promise<Review> {
  const prompt = await p.template("review", [String(p.input.prompt), String(p.data.plan_path)], REVIEW);
  const r = await p.agentJson<Review>(
    prompt,
    '{"verdict": "PASS" | "FAIL", "issues": [{"severity": "blocker" | "tech_debt" | "skippable", "description": "…"}], "summary": "…"}',
    checkReview,
    { tools: "read", model: model(p, "review_model") },
  );
  // A blocker means FAIL, whatever the verdict says.
  return { ...r, verdict: r.issues.some((i) => i.severity === "blocker") ? "FAIL" : r.verdict };
}

const reviewText = (r: Review) => {
  const blockers = r.issues.filter((i) => i.severity === "blocker").length;
  return r.verdict === "PASS" ? `PASS: ${r.summary}` : `FAIL, ${blockers} ${blockers === 1 ? "blocker" : "blockers"}: ${r.summary}`;
};

/** An expert is a folder of commands under .claude/commands/experts/ with its knowledge in expertise.yaml. */
function expertiseFile(p: Phase) {
  const expert = String(p.input.expert);
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(expert)) throw Error("expert must be a folder name: letters, digits, - and _");
  return { expert, file: `.claude/commands/experts/${expert}/expertise.yaml` };
}

const MAX_EXPERTISE_LINES = 1000;
const lineCount = async (p: Phase, file: string, label: string) => Number((await p.exec(`wc -l < ${quote(file)}`, label)).trim());

/** Every run saves its outcome at /jobs/<job id> in App State. */
async function save(p: Phase, job: string, result: Data) {
  await p.saveState(`/jobs/${job}`, { run: p.run.n, at: new Date(p.now()).toISOString(), prompt: String(p.input.prompt), ...result });
}

// ------------------------------------------------------------------ definitions

const PROMPT: JobInputSpec = { name: "prompt", type: "string", default: "", description: "What to build: the request the plan starts from" };
const MODEL: JobInputSpec = {
  name: "model",
  type: "string",
  default: "auto",
  description: "Model id for planning, building and fixing; auto uses the agent's own model",
};
const REVIEW_MODEL: JobInputSpec = { name: "review_model", type: "string", default: "auto", description: "Model id for the review; auto uses the agent's own model" };

const PHASES = {
  plan: { id: "plan", label: "Plan", summary: "A subagent writes an implementation plan to specs/" },
  build: { id: "build", label: "Build", summary: "A subagent with write and edit implements the plan" },
  review: { id: "review", label: "Review", summary: "A read-only subagent checks the changes against the plan: PASS or FAIL" },
  reviewFix: {
    id: "review",
    label: "Review and fix",
    summary: "Review; on FAIL a subagent fixes the blockers and the review runs again",
    kind: "repeat" as const,
  },
};

export const ADW_JOB_DEFS: JobDef[] = [
  {
    id: "plan-build",
    title: "Plan and build",
    summary: "A planning subagent writes a plan to specs/, then a building subagent implements it. Nothing is committed.",
    phases: [PHASES.plan, PHASES.build],
    inputs: [PROMPT, MODEL],
    approval: false,
    resultPath: "/jobs/plan-build",
    seconds: 600,
  },
  {
    id: "plan-build-review",
    title: "Plan, build and review",
    summary: "Plan and build, then a read-only subagent reviews the changes against the plan and gives PASS or FAIL.",
    phases: [PHASES.plan, PHASES.build, PHASES.review],
    inputs: [PROMPT, MODEL, REVIEW_MODEL],
    approval: false,
    resultPath: "/jobs/plan-build-review",
    seconds: 900,
  },
  {
    id: "plan-build-review-fix",
    title: "Plan, build, review and fix",
    summary: "Plan and build, then review; on FAIL fix the blockers and review again, until PASS or max_rounds reviews.",
    phases: [PHASES.plan, PHASES.build, PHASES.reviewFix],
    inputs: [
      PROMPT,
      MODEL,
      REVIEW_MODEL,
      { name: "max_rounds", type: "integer", default: 2, min: 1, max: 5, description: "Most reviews, counting the first" },
    ],
    approval: false,
    resultPath: "/jobs/plan-build-review-fix",
    seconds: 1200,
  },
  {
    id: "chore-implement",
    title: "Chore and implement",
    summary: "A subagent plans a maintenance chore to specs/, then another implements it. Nothing is committed.",
    phases: [
      { id: "chore", label: "Plan the chore", summary: "A subagent writes a short chore plan to specs/" },
      { id: "implement", label: "Implement", summary: "A subagent with write and edit carries out the plan" },
    ],
    inputs: [{ ...PROMPT, description: "The chore: a refactor, dependency or config change, cleanup, docs" }, MODEL],
    approval: false,
    resultPath: "/jobs/chore-implement",
    seconds: 400,
  },
  {
    id: "expert-plan-build-improve",
    title: "Expert plan, build and improve",
    summary:
      "Plan with an expert's expertise.yaml, build the plan, then update the expertise with what changed so the next run starts smarter.",
    phases: [
      { id: "plan", label: "Expert plan", summary: "A subagent reads the expertise file, then writes a plan to specs/" },
      PHASES.build,
      { id: "improve", label: "Improve the expertise", summary: "A subagent updates expertise.yaml from the code and the changes" },
    ],
    inputs: [
      PROMPT,
      {
        name: "expert",
        type: "string",
        default: "",
        description: "The expert's folder under .claude/commands/experts/, which holds its expertise.yaml",
      },
      MODEL,
    ],
    approval: false,
    resultPath: "/jobs/expert-plan-build-improve",
    seconds: 900,
  },
];

export const ADW_HANDLERS: Record<string, Record<string, Handler>> = {
  "plan-build": {
    plan,
    build: async (p) => {
      const out = await build(p);
      await save(p, "plan-build", { plan: String(p.data.plan_path), summary: out.done, files: out.data.files });
      return out;
    },
  },
  "plan-build-review": {
    plan,
    build,
    review: async (p) => {
      const r = await review(p);
      await save(p, "plan-build-review", { plan: String(p.data.plan_path), verdict: r.verdict, issues: r.issues, summary: r.summary });
      return { done: reviewText(r), data: { verdict: r.verdict } };
    },
  },
  "plan-build-review-fix": {
    plan,
    build,
    review: async (p) => {
      const round = p.iteration + 1;
      const r = await review(p);
      const last = r.verdict === "PASS" || round >= Number(p.input.max_rounds);
      if (last) {
        await save(p, "plan-build-review-fix", { plan: String(p.data.plan_path), verdict: r.verdict, rounds: round, issues: r.issues, summary: r.summary });
        return { done: `${reviewText(r)} (${round} ${round === 1 ? "review" : "reviews"})`, data: { verdict: r.verdict, rounds: round } };
      }
      const blockers = r.issues.filter((i) => i.severity === "blocker");
      const prompt = await p.template(
        "fix",
        [String(p.input.prompt), String(p.data.plan_path), blockers.map((i) => `- ${i.description}`).join("\n")],
        FIX,
      );
      const fixed = await p.agentJson<{ summary: string }>(
        prompt,
        '{"summary": "<what was fixed>"}',
        (v) => (isText((v as { summary?: unknown })?.summary) ? undefined : "summary must say what was fixed"),
        { tools: "code", model: model(p, "model") },
      );
      return { again: { ...p.data, last_fix: fixed.summary }, summary: `Review ${round}: ${reviewText(r)}. Fixed: ${fixed.summary}` };
    },
  },
  "chore-implement": {
    chore: (p) => plan(p, "chore", CHORE),
    implement: async (p) => {
      const out = await build(p, "implement", IMPLEMENT);
      await save(p, "chore-implement", { plan: String(p.data.plan_path), summary: out.done, files: out.data.files });
      return out;
    },
  },
  "expert-plan-build-improve": {
    plan: async (p) => {
      const { expert, file } = expertiseFile(p);
      if ((await p.shell(`test -f ${quote(file)}`)).code !== 0)
        throw Error(`No expertise file ${file}. Create it first: what this expert knows about its part of the code, as YAML.`);
      return plan(p, `experts/${expert}/plan`, EXPERT_PLAN, [String(p.input.prompt), file]);
    },
    build,
    improve: async (p) => {
      const { expert, file } = expertiseFile(p);
      const before = await lineCount(p, file, `count lines in ${file}`);
      // A self-improve command takes check_git_diff and focus_area first; the file comes third.
      const prompt = await p.template(`experts/${expert}/self-improve`, ["true", "", file], EXPERT_IMPROVE);
      const out = await p.agentJson<{ summary: string; changes: string[] }>(
        prompt,
        '{"summary": "<how the expertise changed>", "changes": ["<one change>", "…"]}',
        (v) => {
          const r = v as { summary?: unknown; changes?: unknown };
          if (!isText(r?.summary)) return "summary must say how the expertise changed";
          if (!Array.isArray(r.changes) || r.changes.some((c) => typeof c !== "string")) return "changes must list the changes";
        },
        { tools: "code", model: model(p, "model") },
      );
      const after = await lineCount(p, file, `count lines in ${file} after the update`);
      if (after > MAX_EXPERTISE_LINES) throw Error(`${file} has ${after} lines; keep it under ${MAX_EXPERTISE_LINES}`);
      await save(p, "expert-plan-build-improve", {
        expert,
        plan: String(p.data.plan_path),
        build: String(p.data.build_summary),
        expertise: out.summary,
        changes: out.changes,
        lines: after,
      });
      return { done: `${out.summary} (${before} → ${after} lines)`, data: { expertise_changes: out.changes } };
    },
  },
};
