# Blind review: PR #15, "Spot-check toolbelt, shared skills and Haiku subagents"

- Diff reviewed: `git diff d0d55ad^1 d0d55ad` (merge of `feat/toolbelt` into `feat/oracle`), 16 files, +1579/−34.
- Reviewed on `feat/oracle` at `7f0fc16`. PR #16 (gitnexus tool) came after it; gitnexus is only in scope for question 5.
- Tests added: `apps/dpi-backend/tests/review-pr15.test.ts`. Production code is unchanged.
  - **Guard tests** (5) pass today. Each one kills a mutant that the PR's own suite let survive.
  - **Finding tests** (8) fail today. They are skipped with `finding: <id>`. Run `PR15_FINDINGS=1 npx tsx --test tests/review-pr15.test.ts` to see them fail.

## Verdict summary

| Claim | Verdict |
|---|---|
| git `diff` op: path filter that refuses `-` paths, 40 KB cap, `--no-ext-diff`/`--no-textconv` | **Met as worded.** The file header goes further and says "no repo config can run a program while it reads". That is **not met**: see F6. The cap is 40,000 characters, not 40 KB. |
| pip3r: allowlisted subcommands, per-subcommand flag allowlist, refused write/index flags, `--no-auto-index` forced, argv only, not in WRITE_TOOLS | **Partly met.** The subcommand allowlist, argv-only execution and WRITE_TOOLS exclusion hold. Refused flags can still reach pip3r's argv as the token after a value flag (F2). The forced `--no-auto-index` and `--json` can be suppressed (F1). |
| skills add-on: search/view/update, symlink dedupe, view refuses traversal, single-occurrence CAS patch, front matter re-validated, atomic write, revision 700/600, audit line, skill_update in WRITE_TOOLS | **Partly met.** Front-matter validation can be bypassed through a `references/` symlink (F3). The compare-and-swap leaves a window between the re-check and the rename (F4). A failure after the rename is reported as "Not saved" (F5). The other parts hold. |
| `model` on subagent/start_session, default DPI_SUBAGENT_MODEL or `claude-haiku-latest`, aliases from catalog order, unknown ids fail without fallback, Haiku 5.5 added | **Met**, with one regression: the default only resolves on devices with an Anthropic subscription. On an OpenRouter-only device (the README's default install), subagent and start_session without `model` always fail (F7). |
| Backend suite 69/69, tsc clean | **Partly met.** At `d0d55ad` the suite has 69 tests: 68 pass and 1 is skipped (`file, web and GitHub tools run in a live session`, which predates this PR). tsc is clean. |

| Question | Answer |
|---|---|
| 1. Can a pip3r flag spelling reach pip3r while refused or unknown? | **Yes, in one form:** as the second token after a value flag. The `--flag=value`, short-flag, camelCase, case-variant and `--no-` forms are all refused. Details below; see F1 and F2. |
| 2. Can skill_update write outside the skill roots? | **No.** `..` and absolute paths are refused. A `references/` symlink that leaves the skill is refused. A skill whose real folder is outside every root is refused; that guard had no test before this review (M1). **However**, a symlink that stays inside the skill can carry a SKILL.md edit past front-matter validation (F3). |
| 3. Is the CAS race-free, and does a failed write lose the old content? | **Race-free within one backend process only.** `update` is fully synchronous, so two calls cannot interleave. Across processes, a write that lands between the re-check and `renameSync` is lost silently (F4). A failed write never loses old content (guard M7). A failure *after* the rename is reported as a failure even though the file changed and no audit line was written (F5). |
| 4. Does `resolveModel` ever fall back silently? | **No.** An empty or whitespace `model` counts as "not given" and uses the documented default. An alias that points to a model the device lacks throws `Unknown model claude-haiku-latest (claude-haiku-5-5)`. Unknown ids throw. The inverse problem is F7: the default fails on OpenRouter-only devices. |
| 5. Does toolSet `oracle` keep pip3r/gitnexus/skill_view, with skill_update dropped only under readOnly, in every direction? | **Yes for every toolSet→toolSet switch. No when the add-on is enabled after the switch** (F8). |

## Gate (re-run)

| What ran | Where | Output |
|---|---|---|
| `cd apps/dpi-backend && npm install` | feat/oracle 7f0fc16 | exit 0 |
| `timeout 580 npm test` | `d0d55ad` (the merge itself, in a worktree) | `# tests 69  # pass 68  # fail 0  # skipped 1`, exit 0 |
| `npx tsc --noEmit` | `d0d55ad` | exit 0, no output |
| `timeout 580 npm test` | 7f0fc16, before this review | `# tests 75  # pass 74  # fail 0  # skipped 1`, exit 0 |
| `timeout 580 npm test` | 7f0fc16 + `tests/review-pr15.test.ts` | `# tests 88  # pass 79  # fail 0  # skipped 9`, exit 0 |
| `npx tsc --noEmit` | 7f0fc16 + the new test | exit 0, no output |
| `PR15_FINDINGS=1 npx tsx --test tests/review-pr15.test.ts` | same | `# tests 13  # pass 5  # fail 8`: every finding test fails, every guard test passes |

## Findings (confirmed, each with a skipped failing test)

| Id | Severity | Where | Finding |
|---|---|---|---|
| F1 | Medium | `toolkit-pip3r.ts` `pip3rArgv` | The forced `--no-auto-index` and `--json` are added only `if (!out.includes(...))`, and `out` includes value tokens. `blast ["createStore", "--path", "--no-auto-index"]` gives the argv `blast createStore --path --no-auto-index --json --cwd /repo`. The tool's own parsing model says a value flag takes the next token, even one that starts with `-`. Under that model, pip3r sees `path="--no-auto-index"` and **no** `--no-auto-index` flag. Blast then indexes a missing repo by default, which is exactly what the header says can't happen. `--json` is suppressed the same way (`scout ["--grep", "--json"]`). |
| F2 | Medium (High if pip3r uses a yargs/minimist-style parser) | `toolkit-pip3r.ts` `pip3rArgv` | A refused flag written as the token after a value flag passes unchecked: `graphos ["--cypher", "--write"]` → `graphos --cypher --write …` and `graphos ["--search", "--clean", "--from", "--force"]` → `graphos --search --clean --from --force …`. A parser that does not let a string option swallow a dash token (yargs-parser, minimist) reads these as `--write` or `--clean --force`. The tool's guarantee then depends entirely on pip3r's parser, which this VM cannot check (see "Needs local verification"). Together F1 and F2 are a dilemma: whichever way pip3r parses, one of them gets through. |
| F3 | Low–Medium | `skills.ts` `SkillIndex.update` | Front-matter validation runs only when the *requested* path is `SKILL.md` (`rel === "SKILL.md"`), not when the *real* path is a SKILL.md. Take a `references/self.md → ../SKILL.md` symlink (or one pointing to a nested skill's SKILL.md). A patch through it renames the skill (`name: a` → `name: hijacked`) or deletes its front matter. Precondition: such a symlink already exists. The tools cannot create one, but agents with bash, or Hermes/OMP, can. |
| F4 | Low | `skills.ts` lines 482–483 | The pre-rename re-check and `renameSync` are two steps. Another process (Hermes, OMP, a second device sharing the folder) can write in between, and that write is overwritten with no error. The revision holds the content from *before* the other write, so the other write is gone everywhere. The comment says "a write that landed meanwhile is never overwritten", which overstates it. |
| F5 | Low–Medium | `skills.ts` lines 491–493 | `appendFileSync`/`chmodSync` on the audit log run after the rename. If they throw (for example `audit.jsonl` is unwritable, or the disk is full), `update` throws and the tool answers `Not saved: …`. In fact the file **was** replaced and no audit line exists. An agent that retries then gets a sha conflict, and the change is unaudited. |
| F6 | Low | `toolkit-git.ts` header and `diff`/`diff_stat` ops | `git diff` on a dirty worktree runs the repo's `filter.<driver>.clean` command for paths with a `filter=` attribute. `--no-ext-diff`/`--no-textconv` do not disable it. The header says "no repo config can run a program while it reads". Proven through a live oracle session: a marker file was created by the clean filter. A `diff=<driver>` textconv was *not* run by `diff` or `diff_stat` (probed). |
| F7 | Medium (regression) | `extensions.ts` `subagentModelId`, `store.ts` `jobModel` | The default `claude-haiku-latest` resolves to `claude-haiku-5-5`, an id only in `anthropicModels`. `jobModel` matches ids exactly, and an OpenRouter-only device lists only `curatedModels` (`anthropic/claude-…` ids, no Haiku at all). On such a device, `subagent` and `start_session` without `model` now always fail. Before the PR, the child inherited or copied the parent's model. The PR itself had to set `DPI_SUBAGENT_MODEL=echo` in `store.test.ts` to keep start_session working on faux. |
| F8 | Medium | `store.ts` `configure` (mechanism predates the PR) | `configure({toolSet})` computes the `remove` list from the tools of the extensions selected *at that moment*. Set an agent to `readOnly`, then enable the `skills` add-on, and `skill_update` is offered. `agentDetail` then reports the agent as `oracle`. The PR adds a new writer to this hole, and the follow-up charter commit `a97dacb` ("setup enables the skills add-on") makes this ordering likely. |

## Mutation testing

`node mutate.mjs` replaces one guard, runs the named test file, then restores the source. The runner is in the PR description, and each mutant is described below.

| Id | Mutant | PR #15's suite | With `review-pr15.test.ts` |
|---|---|---|---|
| M1 | delete the "real path inside a root" check in `update` | **survived** | killed by guard M1 |
| M2 | delete the sha re-check before `renameSync` | **survived** | killed by guard M2 |
| M3 | delete the `SKILL_FILE_MAX_BYTES` check in `resolveFile` | **survived** | killed by guard M3 |
| M4 | drop the NUL/CR/LF/length check on pip3r positional args | **survived** | killed by guard M4 |
| M5 | drop `p.repo.startsWith("-")` in pip3r `execute` | **survived** | not killed. Equivalent in effect: `sessionPath` makes the repo absolute and it is passed after `--cwd`, so `-x` cannot become a flag. No test added. |
| M6 | `args.model?.trim() \|\|` → `args.model \|\|` in subagent | **survived** | not killed. `" claude-sonnet-latest "` would fail as unknown rather than run. Cosmetic; no test added. |
| M7 | delete `unlinkSync(tmp)` in the write's `catch` | **survived** | killed (guard M2 sees the leftover temp file; guard M7 checks it too) |
| M8 | disable the expected-sha compare | killed | — |
| M9 | disable the `within(real, skill.path)` check | killed | — |
| M10 | delete the forced `--no-auto-index` | killed | — |
| M11 | drop `--no-textconv` from the diff argv | killed (argv-level only) | — |
| M12 | `value?.trim() ? value : DEFAULTS` → `value ? value : DEFAULTS` in `skillRoots` | **survived** | not killed. With `DPI_SKILL_DIRS="   "` there are no skills instead of the defaults. Cosmetic; no test added. |

## Question 1 in detail: pip3r flag spellings

| Spelling | Example | Result |
|---|---|---|
| `--flag=value` on a refused flag | `--write=true` | refused (author's test) |
| `--flag=value` on an allowed boolean | `--json=false` | passes; `--json` is still appended (`blast --json=false --json --cwd … --no-auto-index`). What pip3r does with both is unverified. |
| short flag with attached value | `-pfoo`, `-ci` | refused (unknown) |
| short flag with `=` | `-p=x` (blast) | passes. Allowed by design. |
| camelCase or case variant | `--huntSeedApply`, `--Write` | refused (unknown) |
| `--no-` prefix | `--no-write` | refused (unknown) |
| repeated flags | `-i -i --grep=a --grep=b` | passes. Harmless for read flags. |
| `--` | `--` | refused |
| **value that looks like a flag** | `--cypher --write`, `--path --no-auto-index` | **passes: F1, F2** |

## Question 5 in detail: tool-set switching

This was a probe in a live faux session with the skills add-on enabled first. Each row is the state after `configure` with the toolSet shown.

| Switch | Reported set | pip3r | gitnexus | skill_view | skill_update | bash |
|---|---|---|---|---|---|---|
| → oracle | oracle | yes | yes | yes | yes | no |
| oracle → readOnly | readOnly | yes | yes | yes | **no** | no |
| readOnly → oracle | oracle | yes | yes | yes | yes | no |
| oracle → all | all | yes | yes | yes | yes | yes |
| all → readOnly | readOnly | yes | yes | yes | **no** | no |
| readOnly → all | all | yes | yes | yes | yes | yes |
| all → oracle | oracle | yes | yes | yes | yes | no |
| `readOnly: true` / `readOnly: false` | readOnly / all | yes | yes | yes | no / yes | no / yes |
| readOnly, **then** enable skills | **oracle** | yes | yes | yes | **yes** | no (F8) |

## Unconfirmed (needs pip3r or a live device)

- **"Read only" is wider than "never writes".** `doctor`/`verify` with no check flag run every check the repo has, including its test script (the tool says so). A repo's `npm test`, lint or typecheck scripts are arbitrary code with full write access. The pip3r tool is in the oracle and readOnly sets and is not in WRITE_TOOLS.
- **Flags that point outside the repo folder.** `--cwd` is fixed, but `scout --read=`, `--directory=`, `--repos=`, `doctor --repo=`, `--lbug-path=` and `--hunt-target=` take paths. Whether they read outside the repo, or whether `doctor --logs=` writes a file, depends on pip3r v1.2.6.
- **Path swap between `realpathSync` and `renameSync`** in `update`: if a parent folder is replaced by a symlink in that window, the rename lands elsewhere. Needs local write access to the skill folder, so it is not an escalation for the tools themselves.
- **Hard links:** the atomic rename replaces the inode, so other hard links to a skill file keep the old content.

## Out of scope findings (not fixed, no tests)

- `DEFAULT_SKILL_DIRS` hard-codes `/home/n4s5ti/...`. On any other machine the default is two missing folders.
- The git `40 KB` cap counts UTF-16 code units, not bytes. Non-ASCII diffs can be several times larger in bytes.
