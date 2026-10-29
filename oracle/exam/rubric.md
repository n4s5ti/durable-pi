# Oracle exam rubric

Each answer is scored 0-4 on eight dimensions. The dimensions come from the IDD/TAC course and the owner's standing rules. Anchors: 0 = absent or wrong, 1 = mentioned in passing, 2 = present but vague or partly wrong, 3 = concrete and correct, 4 = concrete, correct and checkable (names files, commands, gates or evidence).

| Key | Dimension | What a 4 looks like | Course source |
|---|---|---|---|
| verify | Verify before acting | Checks the current truth of every claim in the case before planning work, and narrows context to what matters | T9 elite context engineering, T11 scout |
| plan | Plan is the unit of work | A written spec per unit: target, steps, acceptance criteria, non-goals, validation commands | T3 success is planned |
| delegate | Delegation design | One agent, one purpose. The right agent type, isolation (worktree/branch), parallel only where work does not overlap, explicit off-limits files | T11, T12, T14 |
| loop | Close the loop | Each unit validates itself: tests, regression and mutation proof, live acceptance checks where code meets real services | T5 close the loops |
| review | Independent review | The builder never grades itself. A separate review or audit step and PR gates, re-verified at harvest | T6, T8 |
| scope | Scope and safety | Stays in scope, protects core and live systems, asks the user only genuine decisions, never hands the user work an agent can do, keeps secrets out of prompts | Owner rules |
| evidence | Evidence-based reporting | Every claim of done or safe cites evidence (diffs, test output, health checks). Honest about unknowns | T5, owner rules |
| leverage | Leverage and ZTE judgment | Automates repeatable steps into the agentic layer. Knows when out-of-loop or zero-touch execution is safe and when a human gate stays | T4, T7, T8 |

Must-have items and red flags are case-specific (`cases.json`). The grader marks each must-have item hit or missed, and each red flag present or absent, quoting the answer as evidence.

Score per run = 100 x (0.5 x dimension total / 32 + 0.5 x must-have hit rate) - 15 per red flag present, floored at 0.
