# Crew: orchestrator tasks and agent communication

A **Foreman** task runs an orchestrator agent that writes no code: it proposes a split of the work, the person approves it, and then the foreman hands parts to named crew agents (workers), reads their code-built reports and diffs, returns work through the review loop and accepts it into its own branch. Everything runs over one app-owned MCP server (`brigadir`) inside ordinary ACP sessions; the foreman's host, not the app window, executes the orchestration. Agents talk only along the crew tree: questions up (`ask_foreman`), facts on a shared notes log, and host-routed review edges between siblings.

Crew templates, the tree data contract and the crew editor are in [Agent and crew templates, crew editor](crew-templates-and-editor.md). Choosing a crew on the launch sheet is in [Tasks](tasks.md#launch-sheet). The sidebar crew card is in [Sidebar](sidebar.md#crew-card). The plan card UI is in [Turns, plans and questions in chat](chat-turns-plans-and-questions.md).

<a id="task-type"></a>
## The Foreman task type

| Kind | Glyph | Meaning |
| --- | --- | --- |
| Foreman | helmet (`task-brigadir`) | splits, delegates, reviews and accepts work |
| Worker | none | does the work like an ordinary agent; the crew container says it is a worker |
| Ordinary task | none | one agent works alone (the default) |

- The type glyph sits in the trailing part of the card with the isolation glyph, muted; the state icon stays the only leading icon and owns colour.
- Workers appear only in the sidebar, inside their foreman's card; the project board shows only human tasks (see [Projects and board](projects-and-board.md)). A worker whose foreman is gone is shown as an ordinary task.
- The foreman task is isolated in a worktree by default. Its branch is the **integration branch**; the crew's result ships through the normal PR flow from it.
- **Why:** the mechanics (tasks, worktrees, snapshot diffs, review loop, queue, locks) already exist; the crew is a wrapper that exposes them to an agent, not a new engine.

<a id="launch"></a>
## Choosing the crew at launch

The `Crew` popup on the launch sheet (when the type is `Foreman`) lists `Foreman composes` first (generation glyph), then a divider and `Crew templates`.

- `Foreman composes` is the default for a project where no crew was chosen yet and for the fast path (`⌘N`). The last choice is remembered per project (`launchDefaults.crewTemplateId`; `"compose"` = `composeCrewId`).
- With `Foreman composes`, the crew row shows only the foreman chip with its model. `Set up…` opens the crew editor with the foreman alone: its model and effort change there; adding agents turns it into a one-off crew.
- A template or one-off crew is snapshotted into the task (`task.crew`); the task never reads the library again.

<a id="mcp-server"></a>
## Mechanism: one MCP server, roles and guards

Every agent session gets the app's MCP server `brigadir` in `session/new` (stdio). The server process is a stateless translator: stdio from the adapter ↔ the task host's socket. It is spawned and killed by the adapter, which is why it is not a mode of the host binary.

- Spawn environment: `BRIGADIR_HOST_SOCKET`, `BRIGADIR_HOST_INSTANCE`, `BRIGADIR_MCP_TOKEN`, `BRIGADIR_PROJECT_ID`, `BRIGADIR_TASK_ID`, and for crew members `BRIGADIR_ROLE`. The socket handshake authenticates the token and task id; a server connected to the wrong host is refused. Nothing is passed as visible process arguments.
- Crew calls go to the host as one `crew_tool` method `{tool, params: {...args, callId}}`. The MCP request id is the idempotency key (`callId`).
- Read-only crew tools carry `readOnlyHint`.

<a id="roles"></a>
### Process roles and their tools

`BRIGADIR_ROLE` is one of `foreman` (root), `lead` (a foreman node below the root), `developer`, `reviewer` (`crewProcessRole`, `crewTools` in `packages/orchestrator/src/tools.ts`).

| Tool | foreman | lead | developer | reviewer |
| --- | --- | --- | --- | --- |
| `propose_plan` | ✓ | ✓ | | |
| `create_worker_task` | ✓ | ✓ | | |
| `prompt_task` | ✓ | ✓ | | |
| `task_status` | ✓ | ✓ | | |
| `read_report` | ✓ | ✓ | | ✓ |
| `read_transcript` | ✓ | ✓ | | |
| `read_diff` | ✓ | ✓ | | ✓ |
| `submit_review` | ✓ | ✓ | | ✓ |
| `approve` | | | | ✓ |
| `accept_task` | ✓ | ✓ | | |
| `ask_foreman` | | ✓ | ✓ | ✓ |
| `post_note`, `read_notes` | ✓ | ✓ | ✓ | ✓ |

- The person's tools (`ask_user`, `create_task`, editor context, PR review drafting) exist only in the root foreman's session (`humanToolsAllowed`). Workers ask up the tree instead.
- Workspace tools stay with every role: `browser_*`, `simulator_*`, `commands_*` (when their modules are on) and `console_*`. The simulator is one device per project: crew members queue for it, the foreman and solo agents go first.
- **Two guards.** Structure: `tools/list` shows only the role's tools. Check: the host refuses a tool outside the role (`Tool X is not available to this agent`) and a reviewer call on a task outside its check edges. There is no `decide_permission` tool for any role.
- One nesting rule: a worker gets no orchestration tools unless its node has subordinates (then it is a lead, see [Subordinates](#subordinates)).

<a id="host-runs-orchestration"></a>
### The foreman's host executes orchestration

`create_worker_task` creates a task, prepares its worktree and spawns the worker host. This runs in the **foreman task's host**, not in the app, so a crew keeps working with the window closed.

- `propose_plan` keeps the request pending in the host, like a permission request, with no host-side timeout. App open → the card shows at once; app closed → the request waits; already started workers keep running.
- The host reads incoming requests off the JSON-RPC reader (handlers run outside it), so a host→app request in the middle of a turn cannot deadlock.
- Worker tasks created by the host appear in the app's task list through the `crew.worker.created` event.

<a id="brief"></a>
## Role briefs

Briefs are English (rule 12), built by code (`packages/orchestrator/src/brief.ts`) and delivered as a `.context` block of the session's first prompt: the agent reads it, the transcript never shows it, it is not journaled, and a restarted host re-briefs its new session itself.

<a id="foreman-brief"></a>
### Foreman and lead brief (`foremanBrief`)

Composed of: the fixed core (`foremanCore`), the lead's place in the tree (leads only), the roster or the compose palette, the crew tools sentence, the template's instructions, the node's extra instructions.

The core says:
1. **Role:** never modify files; split, delegate to named agents, read reports and diffs, review, accept.
2. **Loop:** `propose_plan` (one part per agent: title, agent, owned files, full prompt, written for an agent that sees nothing of the foreman's conversation: the goal, the behaviour expected, what stays untouched, and the command proving the part: a test, a typecheck, a build) → wait for the result, do not end the turn while approval is pending, continue immediately once approved → `create_worker_task` per part with the same agent name → reports arrive by themselves (no `task_status` polling) → `read_report`, then `read_diff` one file at a time: where the report raises a question when a reviewer approved the part, the whole change when nobody checks it → return with `prompt_task` / `submit_review`, accept with `accept_task`. A part that comes back wrong a second time is returned with `effort` one level higher (see [Returning with more effort](#return-effort)).
3. **Splitting:** each worker's prompt states which files it owns and that others belong to other agents; a shared type/config goes to one agent, the rest read it; dependent parts go in waves. Each agent has one task for the whole crew; its next part is another `create_worker_task` after accepting the previous one.
4. **Questions and permissions:** answer a worker's question with `prompt_task` and its `questionId`; permissions are never the foreman's.
5. **Notes:** share facts with `post_note`, read others' with `read_notes`.
6. **Research rule:** a question handed to a subagent is not researched in parallel by the foreman; end the message and wait for the result (the adapter holds the turn until background subagents finish), or run the subagent in the foreground when the next step depends on it. **Why:** the foreman's session lives for the whole crew, so every file it reads is carried by every later step. The same reason is behind the diff rule in the loop: reviewers read line by line, the foreman reads where the decision is its own.

The **roster** (`roster`) lists each child with summary, provider · model · effort (catalog names; "provider default model" when unset), `leads …`, zone, `checked by …`, and for reviewers `checks …`. It tells the foreman to pass `agent` to `create_worker_task` and `propose_plan`, how to match a part to a model (the [model ladder](#model-ladder)), that reports come after checks pass, and that reviewers get no code.

<a id="model-ladder"></a>
### Model ladder

One paragraph of the brief (`modelLadder`), the same in the roster and in the compose palette. It names no model (rule 7): the foreman reads the names in the roster or the palette.

1. A well-scoped part built against a clear spec (a bug fix, one more case of an existing pattern) goes to a faster model at its default effort.
2. A part that crosses modules, migrates data, tunes performance or has no clear spec goes to a stronger model.
3. For a harder part, raise effort first, up to `high`. Past `high`, the next model up at a lower effort costs about the same and knows more: effort lets a model think longer, it adds no knowledge.
4. Whoever checks a part is at least as strong as whoever wrote it.

**Why:** a crew on one model pays the top price for every part; the check edge is what makes a cheaper developer safe.

<a id="worker-context"></a>
### Worker context (`workerContext`)

Template instructions, the node's addition, then its place in the tree **without models**: name, who it works for, its zone ("change only files inside it"), who checks it, whom it checks, its other siblings ("do not touch their files"), and "ask with `ask_foreman`, share with `post_note`, `read_notes` before touching a shared type". A reviewer also gets the check procedure (read with the `reviewId`, then `submit_review` or `approve`; two rounds, then the dispute goes to the parent). Other branches of the tree do not exist for a worker. **Why no models:** a neighbour's model is not information for the work and invites speculation instead of reading the diff.

A worker inherits the repo's `CLAUDE.md` by working in a copy of the tree; the foreman writes each part's prompt. Workers are not told to "report"; reports are mechanical.

<a id="plan"></a>
## The plan and its approval

Workers never start before the person approves the root foreman's plan.

`propose_plan` arguments:

| Field | Limits |
| --- | --- |
| `summary` | ≤ 20 000 chars |
| `parts[]` | 1–64; each `title` (≤ 80), `agent` (a child name), `prompt` (≤ 100 000), `files` (≤ 1024 project-relative paths or globs; empty = the agent's whole zone/scope), `scopes` |
| `crew[]` | only when composing; see [Composing the crew](#compose) |

- The host validates parts against the crew (`planDifferences`): `unknown_agent`, `reviewer_part`, `duplicate_agent` (one part per agent at a time), `outside_zone`, `empty`, and the non-blocking `idle_agent`. Any blocking difference is a tool error listing the messages (`The plan does not match the crew: …`), not a card. `crew` without composing → `Your crew is already set; call propose_plan without crew.` Only one plan may wait at a time.
- The card lets the person edit part titles, prompts, agents and files; differences introduced by edits are shown on the card and block `Start workers` (`planBlocked`; idle agents only show). Agent names arrive pre-filled in editable fields.
- `Start workers` approves; `Reject` rejects (the foreman revises or asks). The tool result returns `approved`, the possibly edited parts and the difference messages.
- **Decision after the turn ended:** when the proposing turn has already completed (or the session failed / host stopped) while the MCP call stayed open, the decision is also sent as a separate prompt through the queue — approval lists the current (edited) parts and tells the foreman to create the worker tasks now; rejection asks for a new split. A live turn gets only the tool result.
- **Lead plans** are approved immediately by the host: the plan shows in the lead's activity, only the root plan waits for the person, and the root foreman can return the branch.
- **Waiting plan = needs-you.** `crew.plan.requested` sets the foreman to `needs-you`; `crew.plan.resolved` recomputes the status. Sidebar, `⌘J`/`⇧⌘J`, `Active workers` and keep-awake treat it like a permission or question. A notification `The foreman proposes a split` with the attention sound and Dock badge closes when the plan is decided; it waits 750 ms (`planSettleMs`) so an auto-approved lead plan never notifies.
- **No client timeout on a waiting call:** for Claude over ACP the host sets `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` to 7 days unless the person set it; Codex gets `tool_timeout_sec = 604800` for the `brigadir` server; a CLI task's `cli-mcp.json` sets `timeout` 7 days. The server also sends `notifications/progress` every 60 s (`progressBeatMs`) while a call that sent a `progressToken` waits.

<a id="compose"></a>
### Composing the crew (`Foreman composes`)

- `CrewLaunch` has a third kind `{compose: true, template?}`. Main stores in `task.crew.compose` a palette snapshot: every library agent template except the foreman, expanded as nodes (provider, model, effort, specialty, instructions), plus each enabled provider's catalog models and each model's effort levels. Template edits after launch do not affect the task.
- While `compose` is set and the root has no agents, the brief carries the palette instead of a roster (`composeBrief`): read the task and code first, then call `propose_plan` with `crew` and `parts` together; as many agents as needed, non-overlapping zones; one developer and one reviewer when the task is a single chain of dependent steps (a split pays only when parts can run side by side); models by the [model ladder](#model-ladder); **at least one reviewer, and every developer in some reviewer's `checkedBy`** (one reviewer may check several); reviewers take no code; no leads (one level under the foreman).
- `crew[]` entries: `name` (≤ 80, short, unique, names its area), `template` (palette template name), optional `summary` (≤ 240), `zone`, `provider`, `model`, `effort` (palette names), `checkedBy` (reviewer names). The host builds nodes (a different provider drops the template's choices), checks the editor's rules (unique names, a reviewer checks only developers, zones) and then the parts against this crew. Unknown template or model → tool error listing what is available.
- **Reviewer rule:** the host rejects a composed crew with no reviewer, or with a developer nobody checks; the English error names the palette's reviewer templates and the unchecked developers. It applies only when the palette has a template with the reviewer role. The person's own edit is not checked: `Edit crew…` may remove the reviewer.
- The plan card shows a `Crew members` section above the parts (provider glyph, name, template role, model · effort, specialty, `checks …`). `Edit crew…` opens the crew editor on the proposed crew as a one-off crew; on `Done` parts are re-checked and part agents are chosen from the new list. The foreman itself cannot be changed there (`The foreman is already working: its settings stay.`). Approve/reject covers crew and parts together.
- After approval the crew becomes `task.crew.root.agents`, `compose` is dropped, and the task is an ordinary crew; the host updates its context without a restart and the approval reply lists the approved roster (prefixed "The human edited your crew." when edited).

<a id="workers"></a>
## Workers are tasks

`create_worker_task(agent?, title, prompt, files, scopes)` — after plan approval only (`Call propose_plan first; …`), except in a PR review by a crew (see [Pull requests and CI](pull-requests-and-ci.md)).

- `agent` names one of the caller's children; it may be omitted only when there is exactly one non-reviewer child. Unknown name → error with the list. A reviewer cannot be given a part: the host starts reviewers itself.
- `files` outside the agent's zone → error. Title ≤ 80, prompt ≤ 200 000.
- The worker task: `isolation: 'worktree'`, `baseRef` = the foreman's branch (or `HEAD` when the foreman is not isolated), the foreman's setup command and `.env` copying, `crewTaskId` (root crew), `crewNodeId`, `parentTaskId`, launch options from the node's requested choices (model, effort, mode). Unavailable options are recorded in `unavailableOptions`.
- **Branch name:** `<foreman branch>-<agent slug>` (dash, because `a/b` cannot coexist with ref `a`), then `-2`, `-3` only when taken in some repo of the project.
- **Scopes:** a worker's worktree contains all enabled repos so the workspace builds; `scopes` narrows which are selected. Multi-root bases resolve per repo (`origin/HEAD`, then `origin/main`/`origin/master`, then `HEAD`).
- **Read everything, write your own.** Reading covers all project repos. Writing is limited by the worktree (writes cannot leak into other tasks) and checked afterwards: the report lists **changes outside the assigned files** — visibility, not a ban.
- Workers count against the concurrent agent limit (`agents.maxConcurrent`); beyond it they wait `queued` and start when a slot frees, at most two launching at a time.
- Reviewers of an agent start together with its first part, as file-less workers (`readOnlyAgent: true`: the host refuses their ACP file writes with "You check the work and do not write code."), and wait. A reviewer whose checks are all over is shut down; its worktree stays.

<a id="return-effort"></a>
### Returning with more effort

`prompt_task(taskId, text, effort?)`: `effort` is a level of the worker's current model, by the catalog's name or value (`High`).

- The host reads the levels from the worker session's latest options, sets the level with `setOption` before the prompt, records it in the worker's `effectiveChoices`, and replies `effort` with the level's name. It stays for the rest of the member's task.
- Errors (English, with what is available): an unknown level lists the model's levels; a model without effort levels says so; `effort` with `questionId` is refused, because an answer returns into a running turn.
- The order the brief gives: first say what to verify and how; on the second return raise effort one level; a part that still fails goes to a stronger agent as a new part. The host never raises effort by itself, and never changes a worker's model: a session's cache and reasoning belong to its model.

<a id="parts"></a>
### One task per crew member; next parts

A crew node has one task, one session, one worktree and one branch for the crew's whole life.

- The first `create_worker_task` for a node creates the task (part 1). After `accept_task`, the next `create_worker_task` for that node **continues the same task**: part `N+1`, same `taskId`, reply `part`, `continued: true`.
- Errors: current part not accepted yet → use `prompt_task` for it; next part waiting on a merge → waits for the human; the worker is busy in a person's turn → wait for the turn end; `scopes` naming a repo the task lacks → error listing its repos (ACP roots are fixed at session start). If the person deleted the worker task, a new task is created and the node record replaced.
- `prompt_task` on an accepted task between parts → error naming `create_worker_task`.
- Between parts the worker is `completed` and its host stopped; a new part goes `queued` → the host restarts and resumes the same session → `working`.
- **Sync before the part:** in each repo where the parent tree has the worker branch, the host creates `P` (tree = parent `HEAD`, parents = last accepted worker tip from `acceptedTips` and parent `HEAD`) and runs `git merge --no-edit P` in the worker tree — usually a fast-forward; new work the person did after acceptance stays. If the parent tree is mid-merge/squash → error. A conflict → the worker task goes `needs-you` with `MERGE_HEAD`, unresolved files and a `git-merge.json` entry (`from` crew branch, `into` worker branch); the tool reply says `needs-you` with the files and "do not resolve it yourself". The host polls every 3 s: `Finish merge` queues and starts the part; `Abort merge` withdraws it, restores the previous accepted part, emits `crew.part.dropped` and prompts the foreman with the `part-dropped` marker.
- **Diff base of a part:** after the worker host starts, the foreman's host asks it for a checkpoint, stores it as `changeBase` in the worker's `task.json`, and only then sends the part prompt. Every change surface of the task (Changes panel, `+N −M`, unreviewed, `read_diff`, report, outside-the-zone list, `ReviewRun` snapshots, comment anchors) counts from `changeBase`; the turn range stays absolute.
- The part prompt starts with an English header: part number and title, the previous part was accepted, the crew tree was merged in, so re-read files before changing them.
- The task title is the current part's title; the card row stays `<agent> · <part title>` and the `Workers` counter counts members, not parts. `part` lives in `crew-workers.json`, `task_status` returns it, and reports say `part N` from the second part on.
- Zones and files are checked per part; locks and worktree belong to the task; nothing is cleaned up after acceptance (cleanup happens with the task, see [Tasks](tasks.md#delete-task)).
- Context growth is left to the agent's own compaction.
- Compatibility: a record without `part` is part 1; without `acceptedTips` the sync base is the worker branch `HEAD`; crews with several tasks per node continue in the newest.

<a id="reports"></a>
## Reports: push, built by code

When a worker's turn ends, the worker host pushes a report to the parent (outbox `crew-outbox.json` survives a missing parent). The parent receives an ordinary `session/prompt` — queued if it is busy, so it arrives as the next turn. Nobody polls.

`buildReport` (`packages/orchestrator/src/report.ts`) builds it from the journal and the snapshot diff:

- header `Report from <name> · <title> (task …, part N)`, status, changed file count and `+N −M`;
- files (up to 200) with status and counts, project-relative paths;
- `Changes outside the assigned files (n)` (up to 20 names);
- checks with verdicts and round, and the disputed note when reviewers did not agree;
- `Usage: N turns, X in, Y out, Z cached` — tokens of the member's task so far, summed from its `turn.usage` records: `in` is input plus cache writes, `cached` is cache reads (see [Agents and providers](agents-and-providers.md#turn-usage)); the line is left out when the provider reported none. No model and no money: reviewers read the same report, and the foreman has the model in its roster;
- `Notes: N new` (never a separate push);
- the question the worker ended with;
- the worker's last message (≤ 4000 chars);
- a footer naming `read_diff`, `prompt_task`, `accept_task`.

`read_transcript(taskId, limit ≤ 200, default 40)` exists only for "where did it get stuck". `read_diff` lists changed files (≤ 200) or, with `path`, one unified diff; `full: true` returns before/after text (≤ 64 KiB each). **Why:** the foreman's context is the main constraint; transcripts of several workers would burn it.

<a id="accept"></a>
## Integrating results: `accept_task`

Integration is deterministic code, in acceptance order, per git root.

1. Refused while the worker is busy, before its first report, while its next part has not started, or while another accept of the same task runs. Open checks of the part are cancelled (the next part starts from round 1).
2. The worker tree is committed into the worker branch as `<agent>: <title>` (that commit stays in the worker branch only).
3. The commit message is generated **before** the merge, by the same one-shot generator as the commit strip (`commitMessageContext` / `commitMessagePrompt` in `@brigadir/git`): inputs are `git log --format=%B -20` of the foreman tree, the part diff from `merge-base` (`--stat` always, hunks within budget), the root `CLAUDE.md`, `git config commit.template`, and the part title. English prompt; reply language from the log. Fallback `<agent>: <part title>` on failure, 60 s timeout, no provider or empty reply; no retries.
4. `git merge --squash` of the worker branch into the foreman tree and one ordinary single-parent commit: **one commit per accepted part**, no merge commits. Squashing does not start when the foreman's index has staged changes.
5. **Conflict:** the message goes to `SQUASH_MSG`, `MERGE_MSG` is removed, `git-merge.json` records `from` worker branch → `into` foreman branch; the foreman goes `needs-you`. Neither foreman nor worker resolves conflicts. The merge strip treats a squash in progress like a merge: `Finish merge` = `git commit --no-edit` (uses `SQUASH_MSG`), abort = `git reset --merge`; agent resolution stays available on request (see [Git](git.md)). No new merge or accept into that tree starts until it is finished.
6. **Already accepted:** nothing is committed when the worker branch is an ancestor of `HEAD` or the squash leaves the index unchanged.
7. The worker tips are saved in `acceptedTips`, the record gets `acceptedAt`, `crew.accepted` is emitted and the worker host is shut down.
8. Leads squash their workers into the lead branch (one commit per worker part); the root squashes the lead branch (one commit per lead part).

Worker branches and worktrees are removed with the worker task. `+N −M` and the foreman diff come from tree snapshots, so they are identical to a no-ff merge.

<a id="foreman-review"></a>
### Review from the foreman

`submit_review(taskId, comments[1–200] {path, start?, end?, text ≤ 10 000})` produces the same `<review_comment>` batch as the person's `Submit review` (see [Diff and review](diff-and-review.md)). The protocol carries no author; the UI attributes the thread to the foreman or reviewer. Addressed-detection stays on snapshots.

<a id="communication"></a>
## Crew communication

<a id="topology"></a>
### Topology: a delegation tree with check edges

- The crew is a tree: foreman at the root, agents below, optional subordinates below an agent. Assignments go down, reports go up, and whoever assigned a part accepts it.
- One kind of horizontal edge: **check** (`checkedBy`) between children of the same parent, from reviewer to developer.
- No other channels: no worker ↔ worker messages, no shared chat. Shared knowledge goes through [notes](#notes), questions go to the parent via [`ask_foreman`](#ask-foreman).
- All channels are MCP tools and prompt text, so they are provider-neutral (Claude and Codex in one crew).

<a id="ask-foreman"></a>
### Questions up: `ask_foreman`

`ask_foreman(question ≤ 100 000, options[] ≤ 100)` blocks the caller's turn until answered. The question arrives at the parent as a pushed prompt (`question` marker) with its `questionId`; the parent answers with `prompt_task(taskId, text, questionId)`, and the host returns the text as the **tool result** in the same worker turn. There is no `answer_worker`.

| State | Meaning |
| --- | --- |
| `pending` | written before the push to the parent |
| `escalated` | `escalateAt` (created + 5 min, `crewQuestionEscalationMs`, persisted) passed; the worker shows `needs-you` and the person may answer (`The foreman did not answer in five minutes. You can answer for it.` / `Submit answer`) |
| `answered` | first valid answer wins (`answeredBy: foreman \| human`); a repeat of the same answer is idempotent |
| `cancelled` | the task was cancelled; the tool returns a cancellation error, never a permission |

- `prompt_task` without `questionId` is an ordinary queued prompt and does not close a question; a wrong addressee or closed question is an error.
- After a restart an overdue question escalates at once. If the ACP session resumes, the answer returns into its tool call; if the call is lost, the question stays visible and the stored answer goes with the next turn's context under the same id.
- `ask_foreman` never carries permissions.

<a id="notes"></a>
### Crew notes: `post_note` / `read_notes`

- `post_note(text ≤ 8 KiB UTF-8, files[] ≤ 64)` for every role; a short fact for others ("`OrderID` is now `UUID`"). Not a chat: no replies, addressees or deletion. A retried call returns the existing note.
- `read_notes(since)` takes the last read `seq` (exclusive) and returns up to 100 notes, `nextCursor`, `hasMore`.
- Note fields: `id`, monotonic `seq`, `authorTaskId`, `crewNodeId`, `author`, `createdAt`, `text`, `files?`. The root crew host serialises appends to `crew-notes.jsonl`, including leads' crews. Other crews have no access; paths are checked inside the project; a truncated last JSONL line after a crash is not a note.
- Workers read notes themselves when needed; the foreman learns of new notes from reports; the person sees notes as service rows in the foreman's activity.

<a id="reviewer"></a>
### Reviewer agents and check edges

A node whose template has `role: reviewer` owns no code. It gets `read_report`, `read_diff`, `submit_review`, `approve` on the developers that name it in `checkedBy`, plus `ask_foreman` and notes. It cannot accept, create, prompt or query status.

Routing (in the parent's host): a developer's report does not go to the parent until its reviewers have passed it.

1. The developer ends a turn; the host opens a `ReviewRun` and prompts each reviewer itself: `Check task … (reviewId …, round n of 2)` with the report. The parent spends no turn.
2. Reviewers read with that `reviewId` and either `submit_review(taskId, reviewId, comments)` or `approve(taskId, reviewId)`.
3. The host collects one verdict per reviewer and delivers one comment batch to the developer, who fixes and reports again.
4. When all reviewers approve in a round, the report with verdicts goes to the parent, which accepts or returns (`prompt_task`). Only the parent returns work.
5. Comments in round 2 (or a change after round 2) → `disputed`: the report goes to the parent with both sides; the parent decides.

`ReviewRun` (`crew-reviews.json`): `reviewId`, `taskId`, `nodeId`, `name`, `title`, `reportSeq`, `reportHash`, `scopeSnapshots` (base and result tree OID per scope, from the part's `changeBase`), `round`, `reviewerNodeIds`, `dispatched`, `verdicts`, `state` ∈ `reviewing | comments | approved | disputed | superseded | cancelled`.

- Report and diff of a run are immutable; reviewers' `read_report`/`read_diff` read that snapshot.
- A new report or tree change supersedes earlier approvals; an old verdict returns `stale_review`. OIDs are re-checked before handing the report up.
- One reviewer serves one run at a time; the rest queue FIFO and survive a restart. Waiting on a question or permission is not a finished review.
- State and the delivery queue are written before waking an agent; deliveries have ids and are idempotent; a different verdict on a closed `reviewId` is rejected; restart restores runs and never treats silence as approval. An unrecoverable session gives `needs-you`, keeping snapshot and verdicts. A part returned after acceptance starts again from round 1.
- Edges only between children of one parent: a reviewer from another branch would not see that branch's brief or zone.

<a id="subordinates"></a>
### Subordinates: leads

A node with `agents` is a **lead**: its host runs with `BRIGADIR_ROLE=lead`, the foreman tool set limited to its children and zone, plus `ask_foreman` to its own parent. It writes no code. Its template is Foreman (the inspector locks the template while it has subordinates).

- For its children it is the foreman: their questions, checked reports and acceptance go to it.
- Its plan is auto-approved and visible in its activity.
- Upwards it hands **one branch report** (`branch-report` marker) after accepting the parts it delegated. A lead part that delegated nothing reports at once (diff of that part only, often empty); a part that delegated waits until all open worker parts are accepted. A lead's first part without any worker gives no branch report.
- The editor allows two levels below the foreman (foreman → lead → worker) and warns beyond that ("More than two levels. Each level adds a context handoff."); the data model allows any depth.
- In the sidebar subordinates sit under the lead's row and collapse with it.

<a id="permissions"></a>
## Permissions: never the foreman's

- **Permissions go to the person; substantive questions go to the parent.** A worker's permission request (command, write outside the worktree, action outside its mode) reaches the person's connection in the worker's task; the foreman's session gets nothing.
- The foreman's host connects to worker hosts as a client but never decides for the person: an empty answer from a non-deciding client means "no decision" — the request returns to the queue and waits for a real client, the same as a client dropping mid-question.
- A worker's mode is the one its template requests; the worktree makes edits safe.

<a id="attention"></a>
## Attention escalation

- **`crewNeedsYou`** (`core/sidebar.ts`): any worker of the crew (leads and their workers carry the root `crewTaskId`) in `needs-you` — permission, escalated question, sync or merge conflict. The foreman's own `status` is not changed; the attention is drawn over it:
  - board and list: the foreman card takes the `needs-you` amber border and `--amber-soft` fill and sorts with waiting tasks;
  - sidebar: the foreman card's header takes the `needs-you` fill, expanded or collapsed; worker rows have no fill, the amber stays in their icon.
  - It clears by itself when no worker waits.
- **Foreman status:** `needs-you` on a waiting plan; a foreman turn that ends with a worker's question unanswered ends `needs-you` instead of `done` (it relayed the question to the person); answering it outside a turn clears it if nothing else waits. During a turn the question is the foreman's, not the person's. A conflicted `accept_task` also sets `needs-you`.
- **Notification** `A worker is waiting for your answer.` with sound and Dock badge at the end of such a turn or on escalation (once), closed by the answer.
- **Repeated flash:** a sidebar row (task, foreman or worker) in `needs-you` repeats the attention flash every 30 s until the person has seen it (task selected in a focused window); after a restart repeats run for tasks already waiting, without the first flash. Notifications are not repeated.

<a id="stop-delete"></a>
## Stop and delete

- `Delete` of a foreman removes its whole subtree; the confirmation adds `Crew workers are deleted too: {n}.` and the uncommitted-changes warning for their worktrees. `Clear the list…` likewise takes descendants.
- Stopping the foreman cancels its own turn; workers keep their hosts, and reports wait in their outboxes until the foreman's host is back.

<a id="activity"></a>
## Activity rows and chat

The foreman's activity shows crew events as service rows (shared chat row engine, see [Chat](chat.md)): `crew.plan.requested`/`resolved`, `crew.worker.created` and `crew.part.started` (same row: glyph, `worker`, `<agent> · <part title>`), `crew.part.dropped` (`<agent> · merge aborted, part withdrawn`), `crew.report`, `crew.review` (`round {n} of 2`, `approved`, `disputed`), `crew.note`, `crew.question.*` (`waiting for the foreman`, `answered by the foreman`, `answered by you`), `crew.accepted`, `crew.worker.stopped`. Turn markers on the foreman's `turn.started`: `report`, `question`, `plan-decision`, `branch-report`, `part-dropped`.

Tool rows use verbs such as `Assigning a part` / `Assigned a part`, `Accepting the part`, `Asking the foreman`, `Answered the worker`, `Reading the crew log`.

Visual specifics of the crew surfaces:
- the plan card is a chat card (no border, `--lift` shadow, radius 12, `--hair` lines between header, crew, parts and footer); the foreman's brief inside it is chat Markdown one step smaller (12.5/19);
- the part's agent chip is a shared `Popup chip`: `--tint` pill, size S 24, width from the value, no chevron; list marks the agent with ✓ (`PopupMarks`); an amber ring marks a difference;
- small text (files, `assigned to`, `edited`, zone, `N parts`) is 10.5, scope tags 9.5; crew service plates 11.5 with 10.5 tails, stacked 6 px apart;
- the worker question plate: `Submit answer` is word-wide under the field.

<a id="files"></a>
## Files on disk

In the task directory under `~/.brigadir/` (JSON with sorted keys and `schemaVersion`; streams as JSONL):

| File | Task | Content |
| --- | --- | --- |
| `crew-plan.json` | foreman/lead | `{plan, decision}`; `decision: null` while pending |
| `crew-workers.json` | foreman/lead | `CrewWorkerRecord[]`: `taskId`, `nodeId`, `name`, `title`, `createdAt`, `planPartId`, `acceptedAt?`, `effectiveChoices?`, `unavailableOptions?`, `part?`, `acceptedTips?`, `next?` (`queued \| merging`, `previous`, `heads?`) |
| `crew-questions.json` | parent | `CrewQuestion[]` (`id`, `workerTaskId`, `parentTaskId`, `callId`, `agent`, `question`, `options`, `createdAt`, `escalateAt`, `state`, `answer?`, `answeredBy?`) |
| `crew-reviews.json` | parent | `ReviewRun[]` |
| `crew-notes.jsonl` | root foreman | `CrewNote` per line |
| `crew-outbox.json` | worker | report seqs not yet delivered |
| `git-merge.json` | any | open merge/squash per repo (`from`, `into`, conflicts) |

<a id="limits"></a>
## Limits

| What | Limit |
| --- | --- |
| Plan parts | 64 |
| Part prompt in a plan / worker prompt | 100 000 / 200 000 chars |
| Files per part | 1024 |
| Note text / files | 8 KiB / 64 |
| Notes per `read_notes` page | 100 |
| Question escalation | 5 min |
| Review rounds | 2 |
| Report file list / outside list | 200 / 20 |
| Concurrent worker launches | 2 (plus the global agent limit) |
| Waiting MCP call client timeout | 7 days; progress heartbeat 60 s |

<a id="later"></a>
## Later

- Per-project additions to the foreman's role brief (global template instructions already add to it).
- Check edges between different branches of the tree.
- A reviewer that also owns a part of the code.
- Automatic choice of the number of agents beyond `Foreman composes`.
- Asking on `Stop` of a foreman whether to stop its workers too (default yes).
- Foreman indicators (tokens, worst context, quota) aggregated over its workers; tokens per accepted part on the plan card.
- Raising a worker's effort automatically after a disputed check.

<a id="non-goals"></a>
## Non-goals

- Starting workers without the person's plan approval.
- The foreman (or a reviewer, or `ask_foreman`) deciding worker permissions.
- Automatic resolution of merge conflicts without the person asking.
- Polling worker state from the foreman.
- A direct worker ↔ worker channel or a shared crew chat.
- A separate `answer_worker` tool, or `prompt_task` as a second way to start a next part.
- Reviewers accepting work.
- The foreman merging branches through its own tools, rebasing worker branches, or forbidding overlaps in the plan (overlaps are shown instead).
- Changing a worker's model in the middle of its task.
- Claude's own subagents as workers (they have no worktree, states, diffs or review loop).
