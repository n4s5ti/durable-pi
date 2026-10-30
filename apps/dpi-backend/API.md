# dpi-backend API v1

The contract every Durable Agent Network client uses: the web hub, `dpi-tui`, scripts, other agents. Types live in [`../dpi-sdk/src/api.ts`](../dpi-sdk/src/api.ts). [`../dpi-sdk/src/client.ts`](../dpi-sdk/src/client.ts) is a typed client for browsers and Node.

## Conventions

- **Auth.** Every `/v1/*` route requires `Authorization: Bearer <DPI_TOKEN>`. `X-DPI-Token: <DPI_TOKEN>` also works, for proxies that strip `Authorization`. Only `GET /healthz` is open.
- **Vocabulary.** A **session** is one harness and one agent database on the device. An **agent** is a pi-durable conversation in that session: the root (`Main`), a fork, or a subagent. The agent id is the conversation id.
- **Addressing.** `:s` is a session UUID or its unique name (case-insensitive). `:a` is a numeric agent id, `main`, or a unique agent name. Ambiguous names return `409 ambiguous`.
- **Idempotency.** `POST .../messages` takes a required `requestId`, and pi-durable admits each one exactly once. `POST /sessions`, `POST .../agents` and `POST .../fork` accept an `Idempotency-Key` header of up to 128 characters. A repeat gets the stored response with `Idempotent-Replay: true`. Keys are kept for at least 24h, and reusing a key on another route returns `400 invalid`.
- **Errors.** Every error has the shape `{ "error": { "code", "message" } }`. Codes: `unauthorized` 401, `not_found` 404, `invalid` 400, `busy` 409 (reject-if-busy), `conflict` 409 (stale App State revision), `ambiguous` 409, `unavailable` 503 (session failed to open), `internal` 500. Clients can also see `offline`: the SDK raises it when a device cannot be reached, and the hub's proxy returns it with 502.
- **Versioning.** `/v1` and `apiVersion: 1` in `GET /v1/device` and in every `hello` frame. Changes inside v1 are additive.

## Routes

| Route | Body / query | Returns |
|---|---|---|
| `GET /healthz` | (no auth) | `{ok:true}` |
| `GET /v1/device` | | `DeviceInfo`: uid, name, hostname, platform, `apiVersion`, `durableVersion`, `startedAt`, models, `defaultModel`, `startDirs`, storage, `codeDir` (the checkout it runs from), capabilities, `jobs` (durable job definitions) |
| `GET /v1/tree` | | `DeviceTree`: sessions with agents and busy/background |
| `GET /v1/events` | `?docs=app.shared-state` | device stream |
| `GET /v1/fs/dirs` | `?path=` (empty = start dirs) | `{path, parent, dirs[]}`, one level, directories only |
| `GET /v1/library` | `?query=&lesson=&source=&limit=` (`limit` defaults to 8, max 50) | `{items:[{id, source, lesson, kind, ref, text, originId, createdAt, score, similarity?}]}`: the course library's passages, keyword (FTS5) and embedding recall fused by reciprocal rank; keywords only while the embedder is down. `lesson` matches the whole name or its first word (`T8`, `8` or `T8 The Agentic Layer`). The library is `library.sqlite`, apart from memory: it never appears in memory recall or rules |
| `GET /v1/library/stats` | | `{total, bySource, byKind, byLesson, pendingEmbeddings?, embedError?}` |
| `POST /v1/library/import` | `{items:[{source, lesson, kind: transcript\|doc, ref, text, originId}]}` (≤1000 items; the 256 KB body limit means batches of about 250) | `{added, skipped, invalid, errors}`; a known `originId` is skipped, so imports are idempotent. To re-chunk a source, wipe it first |
| `DELETE /v1/library` | `?source=` (required) | `{source, deleted}`: removes every passage of that source |
| `GET /v1/expertise/:name` | | `{name, content, revision, updatedAt}`: the expertise document of the session called `:name` (matched case-insensitively; `name` comes back lower case). A name never written returns `{name, content: "", revision: 0, updatedAt: null}`, never 404 |
| `PUT /v1/expertise/:name` | `{content, reason, expectedRevision?}` | `{name, revision, updatedAt}`: replaces the whole document (markdown, ≤8000 characters) as a new revision. `reason` is required (≤500 characters). Too long, a missing reason or a bad `expectedRevision` returns `400 invalid`; an `expectedRevision` that is not the current revision returns `409 conflict` |
| `GET /v1/expertise/:name/revisions` | `?limit=` (default 20, max 200) | `{items:[{revision, reason, createdAt, chars}]}` newest first; every write is kept with its full content |
| `DELETE /v1/expertise/:name` | `{reason, expectedRevision?}` | `{name, revision}`: empties the document as a new revision; the history stays |
| `GET /v1/skills` | `?query=&limit=` (default 10, max 50) | `{items:[{name, description, path, score}]}`: the shared skills ranked by keyword overlap with `query` (a name word counts three times a description word); no query lists them in index order. Read only |
| `GET /v1/skills/:name` | `?file=` (a path under the skill folder; default `SKILL.md`) | `{name, description, path, file, sha256, bytes, content, files}`: one skill file with its sha256 and the skill's linked files (`references/`, `templates/`, `scripts/`, `assets/`). An unknown skill or file returns `404 not_found`; an absolute path, `..` or a link out of the skill folder returns `400 invalid`. There is no write route |
| `GET /v1/docs/app.shared-state` | | `{kind, value, revision}` |
| `GET /v1/sessions` | | `SessionSummary[]` |
| `POST /v1/sessions` | `{name, cwd, model:{provider,modelId}, thinkingLevel?}` | `201 SessionSummary` |
| `GET / PATCH / DELETE /v1/sessions/:s` | PATCH `{name}` | summary (with its `compaction` thresholds); DELETE aborts all work, moves the files to `archive/` and returns `{archived}` |
| `GET / PATCH /v1/sessions/:s/compaction` | PATCH `{enabled?, reserveTokens?, backgroundTokens?, keepRecentTokens?}` | the session's automatic compaction thresholds, read by pi-durable at its next request. Values are margins: the blocking summary starts at the model's context window minus `reserveTokens`, and the background one `backgroundTokens` earlier (0 turns it off). Default: a background summary at 200k tokens and a blocking one at 250k, or pi-durable's margins on smaller windows. Switching an agent to a window the thresholds do not fit refits them |
| `GET /v1/sessions/:s/events` | | session stream |
| `GET /v1/sessions/:s/tasks` | `?status=live\|terminal&limit=` | task nodes / recent outcomes |
| `POST /v1/sessions/:s/tasks/:taskId/abort` | | `{status}` |
| `GET /v1/sessions/:s/inspect` | | recovery inspection |
| `GET /v1/sessions/:s/stuck` | | `{blocked:[{taskId,kind,conversationId,reason}], queued:[{submissionId,conversationId}]}`: tasks no definition can run (restore it, or abort the task: it ends `orphaned`) and follow-ups queued where no foreground work runs (withdraw them or send a new message). Reads only |
| `POST /v1/sessions/:s/backup` | | `{backup}`: copies the idle session's `agent.sqlite` (and `-wal`/`-shm`) to `$DPI_BACKUP_DIR/<id>-<ms>/`. The session closes for the copy and reopens; requests for it meanwhile get `503 unavailable`. `409 conflict` while any task is live or a submission is queued; `503` without `DPI_BACKUP_DIR` |
| `GET /v1/sessions/:s/submissions/:id` | `?waitMs=` (≤300000) | `SendResult`, optionally long-polled |
| `GET / POST /v1/sessions/:s/agents` | POST `{from?, name?}` | `AgentSummary[]` / `201 AgentSummary` |
| `GET / PATCH .../agents/:a` | PATCH `{name}` | `AgentDetail` (config with `readOnly`, every tool with `replay`, `writes` and `offered`, extensions) / summary |
| `GET .../agents/:a/events` | `?docs=demo.job-runs` | agent stream |
| `GET .../agents/:a/entries` | `?scope=all\|active&cursor=&limit=` | `{items, next}` stored history; `limit` defaults to 500 (max 2000). `scope=active` returns `{items}`, the active context, unpaged |
| `GET .../agents/:a/transcript` | `?format=json\|markdown` | normalized transcript |
| `POST .../agents/:a/messages` | `{content, whenBusy?: followUp\|steer\|reject, requestId, waitMs?}` (`whenBusy` defaults to `followUp`; `waitMs` ≤300000) | `202 {submissionId, status:"queued"\|"pending"}`, `200 {status:"done", answer:{entryId,text}}` or `200 {status:"unanswered", reason}` |
| `DELETE .../agents/:a/inbox/:submissionId` | | withdraw a queued input |
| `POST .../agents/:a/abort` | `{background?}` | stops foreground work (and background with `true`) |
| `POST .../agents/:a/fork` | `{entryId, name?}` | `201 AgentSummary` |
| `GET / PATCH .../agents/:a/config` | `{model?, thinkingLevel?, instructions?, cwd?, readOnly?}` | config; applies from the next request. `readOnly` filters the agent's tools to the ones that only read |
| `GET / PATCH .../agents/:a/extensions` | PATCH `{name, enabled}` or `{prompt, enabled}` | `{extensions, builtIn}`: the custom extensions `system-prompts` (a checklist of the prompts in `prompts/`) and `jev-damage-control` (Jev judges each bash command and blocks destructive ones; the command goes to the Jev API, and a Jev error lets it run). Both are off by default. A change applies from the agent's next request |
| `POST .../agents/:a/compact` | `{instructions?}` | `{taskId}` |
| `POST .../agents/:a/reset` | `{note?}` | `{ok}` |
| `GET .../agents/:a/docs/:kind` | `demo.job-runs` | `{kind, value}` |
| `POST .../agents/:a/demo/state` | `{operation, path, value?, expectedRevision?}` | `{ok, value, revision}`: the new App State. A stale `expectedRevision` returns `409 conflict` |
| `POST .../agents/:a/demo/jobs` | `{job, input?}` | `201 {taskId}`: a durable job run the conversation owns in the background, anchored by a `demo.job` entry |
| `POST .../agents/:a/demo/jobs/:taskId/approval` | `{approved}` | `{ok}`; `409 conflict` when the run is not waiting |

## Agent tools

Every agent gets the coding tools `read`, `write`, `edit` and `bash`, plus the playground tools `read_state`, `update_state`, `list_durable_jobs`, `run_durable_job`, `check_durable_job`, `search_history`, `ping_on_call_engineer`, `subagent`, `start_session` and `handoff`. `readOnly` removes the eight that write: `bash`, `write`, `edit`, `update_state`, `run_durable_job`, `ping_on_call_engineer`, `subagent` and `start_session`. `GET .../agents/:a` lists each tool with its replay policy and whether it is offered.

### Delegated agents' models

`subagent {task, model?}` and `start_session {name, cwd, model?, prompt?}` run the delegated agent on `DPI_SUBAGENT_MODEL` (read at each call), by default `claude-haiku-latest`; pass `model` (for example `claude-sonnet-latest` when the task needs more reasoning) to pick another. Wherever a device model id is taken (these tools, job `model` inputs, and anthropic `{provider, modelId}` in session creation and agent config), the aliases `claude-haiku-latest`, `claude-sonnet-latest` and `claude-opus-latest` resolve to the newest model of that family in the device's Anthropic catalog (now `claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5`). An id the device does not offer fails the call with the ids to choose from; nothing falls back to another model, so a device without the subscription (or the faux provider) needs `DPI_SUBAGENT_MODEL` or an explicit `model`.

### Spot-check tools (toolkit)

The toolkit's read-only tools stay in every tool set, `oracle` and `readOnly` included, so an agent that delegates can review the work without bash.

- `git {op, repo?, ref?, count?, staged?, path?}`: `status`, `log`, `branches`, `ahead_behind`, `diff_stat`, `diff`, `show`, `worktrees`, `remotes`. `diff` returns the patch text of the unstaged changes, the staged ones (`staged: true`) or a ref or range (`main..feature`), narrowed to one `path`, cut at 40 KB with a note saying it was cut. Every call runs argv only as `git --no-optional-locks --no-pager -c core.fsmonitor=false -C <repo>`; `diff` adds `--no-ext-diff --no-textconv --no-color` so no repo config runs a program. A ref or path that starts with `-` is refused, and the path goes after `--`.
- `pip3r {command, repo, args?}`: runs the pip3r CLI (`DPI_PIP3R_BIN`, default `pip3r` on `PATH`) argv only, in `repo` (required, must exist). `command` is one of `blast` (impact of a change), `doctor` and `verify` (health checks), `graphos` (code-graph lookup: symbols, refs, deps) and `scout` (grep and reads). Each command's flags come from an allowlist taken from `pip3r <command> --help`; anything else is refused, which also catches pip3r's camelCase spellings. Writing and provisioning flags are refused with a reason: graphos `--write`, `--clean`, `--force`, `--all`, `--index`, `--index-path`, `--incremental`, `--embeddings`, `--write-context`, `--export-flag`; blast `--auto-index`; doctor and verify `--hunt-seed`, `--hunt-seed-apply`, the seeding options and `--verify-refactor`; and `--cwd`/`-c` and `--` everywhere. `--json` and `--cwd <repo>` are always added, and graphos and blast always get `--no-auto-index`. Timeout 120 s, 300 s for doctor and verify when the repo's tests may run; output is cut at 40 KB with a note. Caveats in the tool description: blast can miss call edges, so zero callers means unknown, not safe; doctor never proves code is dead; `doctor --hunt` needs `--hunt-target` outside a pip3r checkout, and `--scope` takes CLI command paths, not file paths.
- `gitnexus {command, repo, target?, uid?, file?, kind?, direction?, depth?, include_tests?, from?, to?, to_file?, query?, limit?}`: read-only code-graph lookups on a repository GitNexus has already indexed, through the GitNexus CLI (`DPI_GITNEXUS_CMD`, default `npx -y gitnexus@1.6.12`, split on whitespace) argv only, with `NO_COLOR=1` and `CI=1`, in `repo` (required, must exist). `command` is one of `impact` (blast radius of a symbol; `direction` upstream or downstream, `depth` 1-5, `kind`, `include_tests`), `context` (callers, callees and processes), `trace` (shortest call path from `from` to `to`), `query` (execution flows for a concept), `cypher` (read only), `check` (import cycles) and `status` (index freshness). Arguments are typed, never free argv: options go as `--flag=value`, and a positional (symbol, from, to, query) that starts with `-` is refused. Cypher must start with `MATCH`, `OPTIONAL MATCH`, `WITH`, `UNWIND` or `RETURN`, be one statement, and use none of `CREATE`, `MERGE`, `DELETE`, `DETACH`, `SET`, `REMOVE`, `DROP`, `ALTER`, `COPY`, `LOAD`, `CALL`, `INSTALL`, `ATTACH`, `EXPORT`, `IMPORT`, `CHECKPOINT`, `USE`, `BEGIN`, `COMMIT`, `ROLLBACK`, `FOREACH` outside string literals; rows are capped at 50 by default, 200 at most. Every call first runs `status --json` in the folder: no index there answers "No GitNexus index for <repo>; ask for a manual index", and otherwise the command is pinned to that index with `--repo=<root>` so GitNexus never falls back to another registered repository. The answer starts with an Index line (indexed commit against HEAD and GitNexus's staleness verdict), then the JSON GitNexus printed (banner and log lines dropped). Timeout 120 s; output is cut at 40 KB with a note. The tool never runs analyze, index, clean or any other writing command. Caveats in the tool description: a missing result is not proof of no callers (callbacks passed as properties, cross-language fields and registry dispatch have no edges); ambiguous names need `file`, `kind` or `uid`.

## Course library

`oracle/library_ingest.py` turns the course transcripts (WEBVTT) and docs (markdown) into passages of about 250 words and imports them with `POST /v1/library/import`. Agents with the `library` add-on get `library_recall {query, lesson?, limit≤8}`, and each run gets the two best passages in front of the user's message when their cosine similarity clears `DPI_LIBRARY_MIN_SIMILARITY` (default 0.62; keyword-only: most query words present). `DPI_LIBRARY_AUTO_RECALL=off` keeps the tool and drops the automatic passages.

## Expertise

The `expertise` add-on (off by default) gives a session's agents a document of lessons they write from their own work and rewrite after each task (IDD T13, Agent Experts). The document is named after the session (`oracle`, `exam`), so two sessions never see each other's, and it lives in `expertise.sqlite` (mode 600), apart from memory and the library. While it is not empty, each request's system prompt carries it under `# Your expertise`. It is read from the store at every request, so a `PUT /v1/expertise/:name` shows on the agent's next request. Tools: `expertise_read {}` (reads) and `expertise_update {content, reason}` (rewrites the whole document; over 8000 characters it is refused with a message saying how much to cut). `expertise_update` writes, so `readOnly` drops it and the `oracle` set keeps it.

## Shared skills

The `skills` add-on (off by default) gives agents the skill folders Hermes and OMP share: `DPI_SKILL_DIRS` (colon-separated), by default `~/.local/share/hermes-home/skills` and `~/.local/share/pi-agent/skills` of the device user. A skill is a directory with a `SKILL.md` whose YAML front matter has `name` and `description`; skills may sit in category folders and inside other skills. Symlinks resolve to their real path and each real directory counts once; on a name clash the first root wins. The index is read lazily and rebuilt when a folder or `SKILL.md` it saw changes (checked at most every 2 s), so new skills show without a restart.

- `skill_search {query, limit≤10}`: name, description and path of the best keyword matches.
- `skill_view {name, file_path?}`: `SKILL.md` or one file under the skill folder (no absolute paths, no `..`, no links out of the folder), its sha256 and the linked files; text over 40 KB is cut.
- `skill_update {name, old_string, new_string, file_path?, expected_sha256}`: one targeted patch on `SKILL.md` or an existing file under `references/`. `old_string` must occur exactly once, and a file whose sha256 is no longer `expected_sha256` is refused. `SKILL.md` must keep its name and a non-empty description. The new content is written atomically to the real path (symlinks stay links, file mode kept), only inside the configured roots. The old content is kept as `<dataDir>/skill-revisions/<name>/<timestamp>-<file>` (folder 700, file 600), and each write appends `{time, session, agent, name, file, path, oldSha256, newSha256, revision}` to `<dataDir>/skill-revisions/audit.jsonl`. It cannot create, delete or rewrite whole files. It writes, so `readOnly` drops it and the `oracle` set keeps it.

The system prompt carries a short note (search, view before domain work, update only with a general lesson: lessons, not logs). Each run also gets up to three skills in front of the user's message when they are clearly relevant (named in the message, or two of its words hit the skill with one in its name); like library recall, that block is never stored. `DPI_SKILLS_SUGGEST=off` drops the suggestions and keeps the tools.

## Durable jobs

A durable job is a repeatable workflow with named phases. Each run is one pi-durable task (`demo.job.<id>`) whose checkpoint phases are the job's phases, so a restart resumes the current phase. The run's record, with every phase and step (commands, a subagent's tool calls, App State writes, checkpoints, the approval), is the conversation document `demo.job-runs`; types are in [`../dpi-sdk/src/jobs.ts`](../dpi-sdk/src/jobs.ts). Every run saves its result to App State under `/jobs/<id>`.

| Job | Phases | Inputs |
|---|---|---|
| `workspace-snapshot` | scan → measure → save → verify | `path` |
| `release-check` | plan → gather (read-only subagent) → approve (waits for a person) → publish → verify | `commits` |
| `change-watch` | baseline → watch (one checkpoint per check) → report | `path`, `checks`, `interval_seconds` |
| `plan-build` | plan (writes `specs/*.md`) → build | `prompt`, `model` |
| `plan-build-review` | plan → build → review (read-only, PASS or FAIL with issues) | `prompt`, `model`, `review_model` |
| `plan-build-review-fix` | plan → build → review and fix (repeats: fix the blockers, review again, up to `max_rounds` reviews) | `prompt`, `model`, `review_model`, `max_rounds` |
| `chore-implement` | plan the chore (`specs/chore-*.md`) → implement | `prompt`, `model` |
| `expert-plan-build-improve` | expert plan (reads `.claude/commands/experts/<expert>/expertise.yaml`) → build → improve the expertise (under 1000 lines) | `prompt`, `expert`, `model` |

The last five are AI developer workflows: a plan → build → review → fix family, a chore runner, and an expert that keeps its own expertise file up to date. None of them commits.

A phase's subagent runs in a fresh child conversation the run owns, one per call and retry, so a restart finds the same child and its request instead of asking again. Each call picks a tool set: `read` (`read`, `bash` and the toolkit's read-only tools) or `code` (adds `write` and `edit`), and a model by device model id; `auto` (the default) keeps the model of the agent that started the run, and an unknown id fails the run with the ids to choose from. Phases that need a result ask for a JSON block at the end of the answer and check it; a missing or invalid block is asked for again in the same conversation, twice at most. Prompts come from the session folder's `.claude/commands/<name>.md` when it has one (`plan`, `build`, `review`, `fix`, `chore`, `implement`, `experts/<expert>/plan`, `experts/<expert>/self-improve`; `$ARGUMENTS` and `$1`…`$9` are filled in, front matter dropped), otherwise from the job's built-in prompt. A command must be a whole prompt: subagents run tools, not other slash commands.

Inputs are validated when the run starts: integers within their range, and strings non-empty. A string input whose default is empty (`prompt`, `expert`) is required; the Tasks tab keeps the run button off until it is filled.

Agents use the playground tools: `list_durable_jobs` (ids, phases, inputs, approval, result path and recent runs with their task ids), `run_durable_job {job, input?, wait?}` and `check_durable_job {task_id? | job?}` (one run's phases, steps and result, a job's latest run, or recent runs). A run starts in the background, owned by the conversation; with `wait: true` the call owns it and waits, so an interrupt stops it. The same extension adds `search_history {query?, tool?, entry?, kind?, from_entry?, to_entry?, order?, limit?, offset?}`, which pages through the agent's whole stored history including entries before a reset or compaction, and `ping_on_call_engineer {summary, severity?}`, a simulated pager (no external call) that is not replay-safe and works once per agent.

## Streams

Server-Sent Events. Each connection sends `hello`, then a snapshot, then deltas, plus a `: ping` comment every 15s. Treat 45s of silence as a dead socket. Reconnects get a fresh snapshot and nothing is replayed (pi-durable's watch semantics). A viewer that falls 2 MB behind is disconnected. Closing a stream never stops work.

```
id: 7
event: batch
data: {"type":"batch","events":[{"type":"message_update", ...}]}
```

| Scope | Frames |
|---|---|
| device `/v1/events` | `tree {tree}` (deduped, coalesced 250ms), `activity {items:[{type:"agent.started"\|"agent.finished", sessionId, agentId, at, preview?}]}`, `doc {kind, value, revision}` |
| session `/v1/sessions/:s/events` | `session {agents, tasks, usage}`, then `agents`, `tasks`, `usage` |
| agent `.../agents/:a/events` | `snapshot {snapshot, inbox}`, `batch {events}` (pi-durable `watchEvents()` verbatim), `inbox {items}` (queued content), `doc {kind, value}` |
| all | `hello {apiVersion, scope, serverTime}` |

The hub's multiplexed stream (`/api/stream`) carries these frames per subscription and adds `stream {streamId}`, `network {devices}`, `fault {error}` and `disconnected {reason}`.

To render a transcript from the agent stream in JS, feed frames to `AgentModel` from the SDK. It handles text/thinking/tool-call deltas, tool output windows, results, resets and overflow snapshots.

## Recipes

```bash
T=<token>; U=https://my-dpi-vm-1.exe.xyz   # any device URL from dpi-network.yaml
# Send work and wait for the answer, all in one request:
curl -s -X POST $U/v1/sessions/my-session/agents/main/messages -H "Authorization: Bearer $T" \
  -H 'content-type: application/json' -d '{"content":"Summarize the failing tests","requestId":"ci-4812","waitMs":120000}'
# Read the whole conversation as markdown:
curl -s "$U/v1/sessions/my-session/agents/main/transcript?format=markdown" -H "Authorization: Bearer $T" | jq -r .text
# Watch everything on a device:
curl -sN $U/v1/events -H "Authorization: Bearer $T"
```
