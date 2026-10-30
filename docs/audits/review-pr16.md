pip3r/gitnexus wrapper findings resolved by removal in PR #21

# Blind review: PR #16, read-only gitnexus code-graph tool

- Diff under review: `git diff 38d2094^1 38d2094` (merged into `feat/oracle`; head of `feat/oracle` at review time `7f0fc16`).
- Files: `apps/dpi-backend/src/toolkit-gitnexus.ts` (new), `src/toolkit.ts` (registration and system-prompt line), `API.md`, `tests/toolkit-gitnexus.test.ts`.
- Reviewer had no contact with the author. Every claim below was re-checked against the code, the real GitNexus 1.6.12 CLI and pi-durable 1.4.0's `NodeExecutionEnv`.
- Tests for this review: `apps/dpi-backend/tests/review-pr16.test.ts`. Finding tests are skipped with `finding: <id>`. Run them with `REVIEW_PR16_FINDINGS=1 npx tsx --test tests/review-pr16.test.ts`, where each one fails on the merged code. The mutant tests are live: they pass on the merged code and kill mutants that the PR's own tests let survive.

## Verdict

**Not safe as merged.** The tool is not read-only in practice. With the default `DPI_GITNEXUS_CMD`, the first thing every call does is run `npx` in the repository being reviewed, and npx obeys that repository's `.npmrc` (F1). So a delegated agent that commits a `.npmrc` gets code execution in the oracle tool set, which was built to have no `bash`. The cypher keyword guard also fails open (F2). GitNexus 1.6.12 opens its database read-only, so writes still fail, but `LOAD FROM` (any local file) and `CALL` get through. The argv construction, the `-` refusal, the bounds, the timeout and the process kill hold up.

| id | severity | finding | test |
|----|----------|---------|------|
| F1 | high | Default `npx -y gitnexus@1.6.12` runs with cwd = the reviewed repo, so the repo's `.npmrc` (`script-shell`, `node-options`, `registry`+`cache`) runs repository-chosen code | `F1: a reviewed repo's .npmrc must not run its own code…` |
| F2 | medium | Cypher guard bypass: a quote character inside `/* */` comments hides `LOAD FROM`, `CALL`, `CREATE`, `SET`, `DELETE` | `F2: a quote inside /* */ comments hides…` |
| F3 | low | `extractJson` returns a leading single-line pino record that has no `msg` instead of the result | `F3: a pino record without msg…` |
| F4 | low (test gaps) | 7 of my 7 mutants against untested guards survived the PR's tests (M1-M7 below) | `M1`…`M7` (live; each kills its mutant) |

## Claims

| # | claim | grade | notes |
|---|-------|-------|-------|
| 1 | Commands limited to query/context/impact/trace/cypher/check/status | **met** | `GITNEXUS_COMMANDS.includes` before anything runs. Tested: control mutant C1/C2 killed. The status-first call order also holds (`gitnexusArgv(p, dir)` validates before the first exec; the call-log assertion kills its removal). |
| 2 | Typed args, no free argv | **met** | Every option goes out as `--flag=value`. `kind` is `^[A-Za-z]{1,40}$`; direction is an enum. |
| 3 | `-`-prefixed positionals refused | **met** | Checked after `trim()` (which also strips tabs and NBSP), so `" --help"` is refused. Tested (control C2 killed). |
| 4 | Depth bounds | **met** | `int()` 1-5 on impact and trace; tested at 0, 6, 2.5, -1 and 100. |
| 5 | argv only via `DPI_GITNEXUS_CMD` (default `npx -y gitnexus@1.6.12`) | **partly met** | The tool's own spawn has no shell. But the default command hands control to npm, which reads the cwd project's `.npmrc` and runs the bin through `script-shell` (F1). Splitting on whitespace means an operator path with spaces cannot be used (documented, operator-controlled, not model-controlled). |
| 6 | 120 s timeout | **met, with a note** | The command step gets 120 s. Before it, the `status --json` step has its own 60 s, so one call can take up to 180 s. On timeout the whole process group is SIGKILLed (Q4). |
| 7 | 40 KB cap | **met** | `gitnexusText` was tested. The note for the 2 MB capture limit (`+`) was untested (M4, now covered). |
| 8 | JSON extracted after banner/log lines | **partly met** | It works for pino records that have level, time and msg. A record without `msg`, or any other single-line JSON before the result, is returned as the answer (F3). It is latent with real 1.6.12, which logs to stderr, but the PR's own fake prints logs to stdout. |
| 9 | Clear no-index message | **met** | Tested. A status that has `error` alongside an index was untested (M6, now covered). |
| 10 | cypher read-only: listed keywords refused | **not met** | Bypass via quotes inside block comments (F2). Writes still fail only because GitNexus 1.6.12 opens LadybugDB read-only; the tool's own guard does not stop them. `LOAD FROM <any file>` and `CALL <table function>` run. |
| 11 | Not in WRITE_TOOLS | **met** | Tested. Because of F1, keeping it in the oracle set gives the oracle a code-execution path. |
| 12 | Backend suite 75/75, tsc clean | **partly met** | On `feat/oracle` here: 75 tests, **74 pass, 1 skipped**. The skip is pre-existing (`file, web and GitHub tools run in a live session`, skipped without `bsdtar`). `tsc --noEmit` exit 0. |

## Questions

### Q1. Can a cypher string write despite the keyword refusal?

**Yes, past the guard. GitNexus 1.6.12 then blocks writes, but not file loads or procedure calls.** Root cause (`src/toolkit-gitnexus.ts:79-82`): `cypherSkeleton` blanks string literals first and comments second. A quote inside a comment therefore opens a "string" that the guard blanks, while Cypher treats it as a comment:

```
MATCH (n) WITH count(n) AS c /* ' */ LOAD FROM "/any/file.csv" (header=false) RETURN * /* ' */
```

The guard sees `MATCH (n) WITH count(n) AS c /*  ''  */` and then removes the comment. Checked against the real CLI on a scratch index (`gitnexus cypher "<q>" --limit=50 --repo=<probe>`):

- `LOAD FROM "<scratch>/outside.csv"`: the guard passes it, and GitNexus returned `| 4 | secret-outside-graph |`, the contents of a file outside the repo.
- `CALL show_tables()`: the guard passes it, and GitNexus returned the 37 tables.
- `CREATE (f:Function {...})`, `SET`, `DETACH DELETE`: the guard passes them, and GitNexus answered `"Write operations ... are not allowed. The knowledge graph is read-only."` A follow-up `MATCH (f:Function) RETURN f.name` still listed only `a`, `b`.
- `` ` `` and `"` work as the hiding quote too.

The sub-cases:

- **Line comments**: not usable, because `value()` refuses `\n`, so a `//` comment runs to the end of the query.
- **Multiple statements**: a `;` hidden by the same trick gets past the guard, but GitNexus answers `Prepare failed: ... We do not support prepare multiple statements.` So `DROP`, `ATTACH`, `INSTALL` and `EXPORT` (statement-level commands) are not reachable.
- **Unicode case**: no bypass. `toUpperCase()` maps `ſet` to `SET`, which is refused, and LadybugDB rejects it anyway (`Parser exception: Invalid input <MATCH (n) ſet>`).
- **Keywords inside identifiers**: a substring is fine (`n.settings`). A whole-word property or alias is over-refused (`RETURN n.set`). That fails closed, so it is not a finding.
- **Backticks**: blanked correctly on their own. They only matter as a hiding quote inside comments.
- **Backslash escapes**: they agree with LadybugDB (`RETURN 'a\'b'` gives `a'b`).
- **Procedures not named CALL**: none found reachable without `CALL` or `LOAD` (see Unconfirmed).

Fix direction (not applied): blank strings and comments in one left-to-right scan, so whichever opens first wins, or reject `/*` and `//` outright.

### Q2. Can any argument reach GitNexus as a flag or a different command?

**Model-supplied values: no. A different command: yes, through the cwd (F1).**

- Positionals that start with `-` are refused after trim. Everything else goes as `--flag=value`, so `--file=--content` stays a value. No `--` is ever emitted. Commander parses `--flag=value` after positionals, and npx does not consume options after the package spec: real runs with `--limit=50 --repo=<probe>` were honoured.
- npm runs the bin as `sh -c "gitnexus <args>"` through `script-shell`, but it quotes the arguments. `x; touch F`, `x $(touch F)`, `` x `touch F` `` and `x' ; touch F ; '` passed as a `query` all reached GitNexus as one argument (no marker file was created).
- `DPI_GITNEXUS_CMD` is split on whitespace with no quoting. It is operator-controlled, so this is a robustness limit, not an injection.
- **F1**: `exec` runs the command with `cwd = <reviewed repo>` (`src/toolkit-gitnexus.ts:254`, `:276`, `:295`), and npm reads that project's `.npmrc`. Three vectors were reproduced:
  - `script-shell=./evil.sh`: npm ran `evil.sh -c gitnexus status --json`. This works even with `npm_config_cache` set in the environment (as under `npm start`/`npm test`) and gitnexus already cached.
  - `node-options=--require ./evil.cjs`: the file ran.
  - `registry=http://127.0.0.1:48731/` plus `cache=.npm-cache`: npx fetched `gitnexus@1.6.12` from the repo's registry and ran it. The fake bin wrote `ran as gitnexus with argv ["status","--json"]`, and the registry log shows `/gitnexus` and `/gitnexus/-/gitnexus-1.6.12.tgz`. An `npm_config_cache` in the environment overrides the `cache=` key, so this vector needs a device where gitnexus is not cached yet. The other two do not.

  All three run during the `status --json` pre-check, before any argument checks matter. The fix (not applied) is to run npx from a neutral cwd and pass the folder explicitly (`status --repo=<dir>`), or require `DPI_GITNEXUS_CMD` to name an installed binary.

### Q3. Does JSON extraction mis-handle a log line that starts with `{` before the real result?

**Yes, for single-line JSON that `isLogLine` does not recognise (F3).** `isLogLine` needs all of `level`, `time` and `msg`. Pino omits `msg` when it logs only an object (`logger.warn({ truncation })`). For such a line, `extractJson` first fails to parse the whole remainder, then tries the shortest prefix, which is that one line. It parses, so the line is returned. Reproduced: input `banner\n{"level":40,"time":…,"name":"gitnexus","truncation":{…}}\n{"status":"found"}` returns the log record.

- A multi-line or non-JSON `{` line before the result is handled: that start fails and the scan moves on.
- Latent with real 1.6.12, whose banner and pino output go to stderr (checked: `context a 2>/dev/null` prints only the JSON). It becomes live with any `DPI_GITNEXUS_CMD` or version that logs to stdout, which is what the PR's own fake models.

### Q4. Is the timeout enforced and the child killed?

**Yes.**

- pi-durable 1.4.0 `NodeExecutionEnv.exec` takes the timeout in seconds, spawns with `detached: true` (a new process group) and on timeout calls `process.kill(-pid, "SIGKILL")`.
- Reproduced through `runGitnexus` with a real `NodeExecutionEnv` and a fake command that forks a child and a grandchild (like npx → node): the call threw `/bin/sh: timeout:60` after 60.1 s. The parent was gone, and the child and grandchild were in state `Z` (killed, waiting for init to reap them). `pgrep` found no surviving `sleep 300`.
- A descendant that calls `setsid()` itself would escape the group kill. npx and node do not.
- Note: the error says `npx: timeout:120` (argv[0] plus the raw code), which is terse but correct.

## Mutants (mine, against guards the PR's tests do not exercise)

Each mutant was applied to `src/toolkit-gitnexus.ts`, then `npx tsx --test` was run, then the file was restored (script in Evidence).

| id | mutant | PR tests alone | with review tests |
|----|--------|----------------|-------------------|
| M1 | `cypherSkeleton`: drop the backtick literal alternative | SURVIVED | KILLED |
| M2 | `CYPHER_REFUSED`: drop `USE` | SURVIVED | KILLED |
| M3 | tool `execute`: drop `p.repo.startsWith("-")` | SURVIVED | KILLED |
| M4 | `exec`: `truncated: false` (no `+` note at the 2 MB capture) | SURVIVED | KILLED |
| M5 | `MAX_CYPHER` 4000 → 1 000 000 | SURVIVED | KILLED |
| M6 | `runGitnexus`: ignore `status.error` | SURVIVED | KILLED |
| M7 | `value()`: allow NUL | SURVIVED | KILLED |
| C1 | control: drop `CALL` (tested by the PR) | KILLED | — |
| C2 | control: disable the `-` positional guard (tested by the PR) | KILLED | — |

The first M2 test iterated `CYPHER_REFUSED` itself and let the mutant survive. It now pins the list documented in API.md.

## Unconfirmed

- Scalar or table functions that read outside the graph without `CALL`/`LOAD`. None found in LadybugDB's grammar paths I tried. Not exhaustively searched.
- A future GitNexus that opens the database read-write for `cypher` would turn F2 into real writes. Today the read-only open is the only thing stopping them, and this PR does not pin or test it.
- The O(lines × `{`-lines) scan in `extractJson` on 2 MB of output. Not measured; GitNexus's JSON escapes newlines, so repository content cannot add `{`-led lines.

## Evidence

All of this ran in this VM (node v22.22.0, npm 10.9.4, gitnexus 1.6.12 through npx).

```
$ cd apps/dpi-backend && npm install && timeout 580 npm test        # before adding the review tests
# tests 75 / # pass 74 / # fail 0 / # skipped 1   (skip: "file, web and GitHub tools run in a live session", no bsdtar)
$ npx tsc --noEmit                                                  # exit 0

$ REVIEW_PR16_FINDINGS=1 npx tsx --test tests/review-pr16.test.ts
not ok 1 - F1 …  script-shell: the repo's own code ran inside the read-only tool (-c gitnexus status --json)
not ok 2 - F2 …  Missing expected exception: MATCH (n) WITH count(n) AS c /* ' */ LOAD FROM "/etc/passwd" (header=false) RETURN * /* ' */
not ok 3 - F3 …  expected: '{"status":"found"}'  actual: '{"level":40,"time":1793329272249,"name":"gitnexus","truncation":{"truncated":true}}'
ok 4-10 - M1 … M7
```

The final gate after adding the review tests is in the PR body.
