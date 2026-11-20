# Crew: orchestrator tasks and agent communication

Two kinds of task orchestrate other agents:

- An **Auto** task ([Auto](#auto)) runs one agent that writes the code itself and may hire workers for independent parts at any moment of the task. The person approves each hire on a card. This is the default task.
- A **Foreman** task runs a named crew chosen at launch: an orchestrator agent that writes no code proposes a split of the work, the person approves it, and the foreman hands parts to the crew's named agents (workers), reads their code-built reports and diffs, returns work through the review loop and accepts it into its own branch.

Everything runs over one app-owned MCP server (`brigadir`) inside ordinary ACP sessions; the orchestrating task's host, not the app window, executes the orchestration. Agents talk only along the crew tree: questions up (`ask_foreman`), facts on a shared notes log, and host-routed review edges between siblings.

Crew templates, the tree data contract and the crew editor are in [Agent and crew templates, crew editor](crew-templates-and-editor.md). Choosing a crew on the launch sheet is in [Tasks](tasks.md#launch-sheet). The sidebar crew card is in [Sidebar](sidebar.md#crew-card). The plan card UI is in [Turns, plans and questions in chat](chat-turns-plans-and-questions.md).

<a id="task-type"></a>
## Task kinds

| Kind | Glyph | Meaning |
| --- | --- | --- |
| Auto | none until its first hire, then the helmet | one agent writes the code and may hire workers ([Auto](#auto)); every GUI task without a named crew |
| Foreman | helmet (`task-brigadir`) | runs a named crew: splits, delegates, reviews and accepts work |
| Worker | none | does the work like an ordinary agent; the crew container says it is a worker |
| CLI task | none | one agent in the terminal; it never hires ([Terminal and CLI agents](terminal-and-cli-agents.md)) |

- The type glyph sits in the trailing part of the card with the isolation glyph, muted; the state icon stays the only leading icon and owns colour.
- Workers appear only in the sidebar, inside the card of the task that started them; the project board shows only human tasks (see [Projects and board](projects-and-board.md)). A worker whose orchestrating task is gone is shown as an ordinary task.
- An orchestrating task with workers runs in a worktree. Its branch is the **integration branch**; the result ships through the normal PR flow from it.
- **Why:** the mechanics (tasks, worktrees, snapshot diffs, review loop, queue, locks) already exist; the crew is a wrapper that exposes them to an agent, not a new engine.

<a id="launch"></a>
## Choosing the crew at launch

The `Crew` popup is the first group of the launch sheet's rail ([Tasks](tasks.md#sheet-rail)). It lists `Auto` first, then under the label `Crews` the library's crews: the built-in `Review crew` and the person's own crews.

- `Auto` is where every sheet starts, the fast path (`⌘N`) included. The choice is not remembered per project. Edit and Duplicate open on the task's own crew; when that crew left the library they open on `Auto`, with one line under the popup: `Crew “{name}” was deleted.`, which goes away with the next choice.
- A named crew or a one-off crew is snapshotted into the task (`task.crew`); the task never reads the library again.
- `CrewLaunch` is `{ auto: true }`, `{ templateId }` or `{ template }` (a one-off crew). Stored launches that predate `Auto` still load: `{ compose: true }`, a `templateId` of `compose` and an id the app no longer ships run as `Auto` (`unshippedCrewLaunch`, [Unshipped crew ids](crew-templates-and-editor.md#unshipped-crew-ids)).
- A task in the terminal (`CLI`) is always one agent: the popup is disabled on `Auto` with the hint `A CLI task runs one agent.`, and the task gets no `auto`.
- The PR review dialog has its own `Who` control and lists only reviewer crews ([Pull requests and CI](pull-requests-and-ci.md#review-crew)).

<a id="auto"></a>
## Auto

An Auto task is one agent that reads the task and the repo and writes the code itself. It may hire workers for parts of the task at any moment, not only at its start, and dismiss them. A small task, or one chain of dependent steps, runs with no plan card and no questions: the agent does it.

<a id="auto-root"></a>
### The task and its crew

- `task.auto` marks an Auto task: `{ roles, budget }` ([Roles](#auto-roles), [Budget](#auto-budget)). Main sets it at creation for a GUI task launched with `Auto`, unless the sheet's role is a checker (that task writes no code and stays a solo checker). A task whose role became a checker's in Edit task… (`readOnlyAgent`) runs as that solo checker too: the host gives it no Auto role, brief or tools.
- The agent is the root of its own crew from its first session: its host runs with `BRIGADIR_ROLE=auto`. Until the first hire the crew is that root alone (named after the provider, `Claude` or `Codex`, with the task's own provider and choices), plus the reviewers of the task's own review when one ran ([Reviews](reviews.md)). `task.crew` is written at the first approved hire; the sidebar card turns into the card with the tray at that moment ([Sidebar](sidebar.md#crew-card)).
- Reviews of [Reviews](reviews.md) apply to an Auto task and to each hired part as they are. A hired part gets no reviewer of its own unless the person adds one.

<a id="auto-tools"></a>
### Tools

The Auto agent has its whole tool set from its first session, so the list never changes in the middle of a session (Codex does not read it again): the person's tools, `hire_workers`, `dismiss_worker`, `request_model`, and the foreman's tools for working with workers (`prompt_task`, `task_status`, `read_report`, `read_transcript`, `read_diff`, `submit_review`, `accept_task`, `post_note`, `read_notes`). It has no `propose_plan` and no `create_worker_task`: a hire is the card and starts the workers itself. The host refuses a hire until its gates pass ([Gates](#auto-gates)).

<a id="auto-brief"></a>
### The brief (`autoBrief`)

The opposite of a foreman's: you do this task yourself and write the code. Hire only when the task has two or more parts that are independent (each writes its own files, none needs another's result to start) and each is large enough to pay for a session of its own; say on the card what each part is and why the parts are independent. A small task, or one chain of dependent steps, is done from start to end without a plan card and without questions. Then: how to hire (title, role, zone, the estimate of files and lines, the budget when the default does not fit, a prompt that stands on its own and names the command that proves the part); that a refused part stays with the agent; that its edits are committed before a hire and an accept, and that it no longer writes inside a zone it hired out; how reports, returns, `accept_task` and `dismiss_worker` work; the roles it hires from with provider, model and effort, the [model ladder](#model-ladder), and that a model outside the roles needs `request_model`. The role chosen on the sheet ([Role](tasks.md#sheet-role)) comes first, before the Auto brief. A Claude session also gets the plan sentence of a solo session ([Plan approval](chat-turns-plans-and-questions.md#plan-approval)), so a person who asks for a plan first gets one. The agent states the task's [class](reviews.md#classes) before its first edit (`classBrief`): a Medium or Large task presents a plan for approval first. A task without a worktree is told that an approved hire moves it into one ([Moving into a worktree](#auto-move)).

A named crew's foreman keeps its own brief and still writes no code ([Foreman brief](#foreman-brief)).

<a id="auto-hire"></a>
### Hiring

`hire_workers(summary, parts[1–16])`. A part: `title` (≤ 80), `role` (a role's name), `zone` (1–256 project-relative paths or globs it writes), `lines` and `files` (the agent's estimate of what it changes), `prompt` (≤ 100 000), optional `acceptance` (≤ 20 000), `scopes`, `minutes` and `tokens` (its budget).

1. The host checks the parts ([Gates](#auto-gates)). When no part passes, the call returns the refusals and no card shows.
2. Otherwise it writes `crew-hire.json` `{hire, decision: null}` and journals `crew.hire.requested`; the task goes `needs-you`. The [hire card](chat-turns-plans-and-questions.md#hire-card) waits for the person, with no host-side timeout, and the task stays `needs-you` when the agent's turn ends with the card still waiting (a message sent into the turn moves the call to the background). The card survives a restart: it comes from the journal, and the decision is kept in `crew-hire.json`.
3. The person may edit each part's title, role, budget and prompt, then approve (`Hire`, or `Hire {n}` when some parts are refused) or reject (`Do it yourself`). Zones, scopes and estimates are what the gates read and stay as proposed. The gates run again on the decision, against the workers running at that moment.
4. On approval (after the [move](#auto-move) for a task without isolation) the host commits the agent's edits ([Commit](#auto-commit)), adds one node per hireable part under the root (the role's resolved node, named after the role, `Developer`, then `Developer 2`, …, the role's name shortened so the number fits 80 characters; its id comes from the hire and the part), writes `task.crew`, and starts one worker task per part ([Workers are tasks](#workers)). The worker's record carries its hire, its part (`planPartId`), budget, zone and the commit it starts from from the moment it is written. `crew.hire.resolved` lists the edited parts (null — as proposed) and the started workers.
   - The decision is recorded only after every worker started. When the host stops in between, the card is still waiting; deciding it again starts only the parts that have no worker yet, reuses their nodes, and does not take the hire's own workers for overlapping zones.
   - A second press while a decision starts workers is refused (`The hire is being decided`).
   - A hire that starts a worker makes the task Large when it is not ([The host raises the class](reviews.md#class-raise)); when its parts are back the host starts a mid-task review ([Large](reviews.md#large-review)).
5. The tool returns `approved`, the started workers (task id, name, role, title, budget) and the parts that stay with the agent. Declined returns `approved: false`: the agent does the parts itself and goes on alone. When the call is gone (the turn ended, or the host restarted), the decision goes to the agent as a prompt marked `hire-decision`.
6. Only one hire waits at a time. The host takes the place before it awaits anything, so a second `hire_workers` in the same turn is refused (`A hire is already waiting for the person.`) and never replaces the first card.
7. A hired `Reviewer` (a check the agent hands out) reports like any part when its turn ends; a reviewer on a check edge or of the task's own review gives verdicts, not reports.

**Each hire is a new worker task.** One task per crew member, continuing across parts, is how a named crew works ([Next parts](#parts)); an Auto worker does one part and is dismissed.

<a id="auto-gates"></a>
### Gates

The host decides per part, in order (`autoHireGates`):

- **Too small:** the estimate is under 50 changed lines (`autoPartMinLines`). Reason `Too small for a worker: about {n} lines in one file.`
- **Not independent:** the zone overlaps an earlier hireable part of the same hire (`Not independent: part {n} writes {path} too.`) or a running worker (`Not independent: {worker} already writes {path}.`). Zones overlap when the static prefix of one entry lies inside the other's (a glob counts as its directory); exact glob disjointness is not decided.

A refused part stays with the agent and does not block the rest: the card shows its reason and `Hire {n}` counts the others.

<a id="auto-isolation"></a>
### Isolation

Workers start from the task's branch, so a hire needs the task in a worktree. An Auto task on GUI starts in `Worktree` on the sheet ([Tasks](tasks.md#isolation)). An Auto task that runs in the project's checkout hires too: an approved hire first moves the task into a worktree of its own ([Moving into a worktree](#auto-move)). Only a project without a git repository refuses `hire_workers` with `Hiring needs a worktree, and this project has no Git repository…`. While a move runs, another `hire_workers` is refused (`The task is moving into a worktree for the previous hire.`). The host keeps that decision in one place (`hireIsolation`).

<a id="auto-move"></a>
### Moving into a worktree

When the person approves a hire of a task without isolation, the host moves the task into a worktree before any worker starts.

1. **The decision waits for the turn.** The approval is written to `workspace-move.json` (`{hireId, decision, state: 'pending'}`); the hire's call returns `approved` with `moving: true` and tells the agent to end its turn. The card closes. The move starts when the turn ends (at once when no turn runs, for example when Codex ended the turn with the call open). Until the move ends no prompt starts; the person's messages wait in the queue.
2. **`Moving to a worktree`.** The host journals `workspace.move` `{state: 'moving'}` with the repos it moves, closes the agent's session and the task's consoles, stops the repo watcher and takes a last checkpoint; no capture runs after it. Background commands stop with the session. Until the move ends, Save, `Revert file changes…`, the refresh button and repo changes of the task are refused, and the host does not stop before the move has finished or rolled back.
3. **The worktree.** Branch: the name derived from the task's title (`suggestedBranch`), with `-2`, `-3`… when any repo already has it. Every repo of the project (root, submodules, nested repos) gets a working copy at its own `HEAD`, the same [preparation](tasks.md#worktree-preparation) as a task isolated from the start, with the task's `.env` copying and setup command. The base shown (`from main`) is the root repo's branch.
4. **What moves.** Only the task's own changes, read from snapshots, never from `git diff HEAD` ([Diff and review](diff-and-review.md#snapshot-engine)). Per repo, with `B` the tree at the task's start (its change base), `C` the last checkpoint and `H` the repo's `HEAD`, each path changed between `B` and `C`:
   - equal in `C` and `H` (already committed) — nothing to move;
   - unchanged between `B` and `H` — moves: the worktree gets `C`'s version;
   - also changed before the task (`B` differs from `H`) — the task's own change is merged onto `H` (`git merge-file`); a path that does not merge, or is not a text file on all three sides, stays: `conflicts with edits made before the task`;
   - changed in a checkpoint outside the agent's turns or by an explicit Save of the person (the [attribution](diff-and-review.md#why-changed) rules) — stays: `changed while {agent} worked`.
   Gitlinks move with their submodule's own repo. A path the agent wrote (its edit tools) that git ignores, or that lies in no repo of the worktree, cannot move and stays: `ignored by git`, `outside git`.
5. **Checked before anything changes in the project folder.** The host writes the moved paths into the worktree and checks every one against the blob it expects. Any failure up to here removes the new working copies and branches, nothing in the project folder has changed, and the move fails.
6. **The switch.** `task.launch` becomes `worktree` with the branch and base, `worktreeBranch` and a `ready` preparation are set, `snapshots.json` points its repos at the worktree under the same repo ids and gains a `move` checkpoint (each repo's `HEAD` tree), which becomes `task.changeBase`: the task's diff counts from the worktree's start, so it holds exactly what moved. From here on the task is a worktree task for every reader: files, editor, terminals, diff, reviews, branch and PR.
7. **The project folder.** Each moved path goes back to its version at the task's start (`B`): the agent's new files are removed, and empty folders they made with them. Git writes the start versions into a folder of its own first; each path is checked right before it is replaced in one rename, so a path the person changed since the last checkpoint is left as it is (`changed while moving`; its moved version is in the worktree). An index entry the agent staged for a moved path (`git add`, `git rm`) returns to `HEAD`. Edits that were in the project folder before the task stay. A restore that stopped half-way runs again from the start and skips what it already did.
8. **The session follows.** As part of the switch, a Claude session's transcript is copied to the worktree's folder of Claude Code's projects, so `session/load` finds it; then the host restarts itself in the worktree (journal `host.stopped` `moved`) and the agent resumes its session there.
9. **The hire goes on.** The new host journals `workspace.move` `{state: 'moved'}` (branch, base, repos, paths that stayed), commits the agent's moved edits as its part ([Commit](#auto-commit)), starts the workers from that commit, journals `crew.hire.resolved` and prompts the agent (`hire-decision`) with the hire's result, the worktree's path and branch and the paths that stayed. No prompt starts before that; the person's messages wait in the queue. The document stays `switched` until the hire is decided, so a restart in any step after the switch continues it; the task's owner finishes a half-written switch before anything reads the task's folder. When some workers started and a later one could not, the started ones stay hired and the rest goes back to the agent.

**When the move fails** (the branch, a working copy, the setup command, a write or the check), the changes stay where they were and the task keeps running in the project folder: `workspace.move` `{state: 'failed', message}` journals the reason as git or the step gave it, the hire resolves as not approved with `reason: 'no-worktree'`, and the agent is told to do the parts itself.

The person has no separate action to move a task.

<a id="auto-commit"></a>
### The agent's own commit

Before every hire and before every `accept_task`, the agent's uncommitted edits are committed to the task's branch as one commit of its own (`commitPreview` over the task's repos, untracked files included; the message comes from the commit message generator of the commit strip, falling back to the task title). `crew.lead.committed` records the commit per repo and the reason (`hire`, `accept`).

- Workers start from that commit, so they see the agent's work so far; `accept_task` squashes a part into a clean tree, so a conflict is a real conflict, not a dirty file in the way.
- The snapshot engine diffs trees, not commits ([Diff and review](diff-and-review.md#snapshot-engine)): the task's `+N −M`, its Changes panel at `Task start` and its review are the same after the commit. With the diff base `Last commit` the agent's committed edits leave that view, as any commit does ([Diff base](diff-and-review.md#diff-base)).
- A commit that fails stops the hire or the accept with the git error; nothing is started or squashed.

<a id="auto-guard"></a>
### Writes in a hired zone

After a hire the agent no longer writes inside the zones of its running workers.

- A write through the app's file layer (ACP `fs/write_text_file`) inside such a zone is refused: `This file belongs to «{part}», the part you hired out to {worker}…`.
- Claude (claude-agent-acp) and Codex (codex-acp) write files themselves and do not call `fs/write_text_file`, so that refusal rarely fires. After each turn of the agent, the host compares the task's tree in each repo with the commit the hire started from (`git diff --name-only` and untracked files) and names the files the agent changed inside a running worker's zone: `crew.zone.touched` in the journal and a prompt marked `zone-touched` that asks the agent to put them back or hand the change to the worker. Each file is named once. Accepting the part would otherwise conflict, which the merge strip shows.
- A zone is free again when its worker is dismissed.

<a id="auto-dismiss"></a>
### Dismissing a worker

A worker is dismissed when its part is accepted (`accept_task`), when the agent discards it (`dismiss_worker`), or when the person picks `Dismiss worker` on its row in the sidebar. The host stops its session, sets its task `completed`, records `dismissedAt` and `dismissReason` (`accepted`, `discarded`, `person`) and journals `crew.worker.dismissed`. A dismissed worker keeps its task, its worktree and its diff; a discarded part merges nothing. `prompt_task` and `submit_review` to a dismissed worker are refused. A worker dismissed while it waits for a slot, prepares its worktree or starts its session does not start: the launch stops at its next step and the task stays `completed`. Nothing of a dismissed worker waits on the host ([host lifecycle](architecture-and-platform.md#host-lifecycle)).

<a id="auto-budget"></a>
### Budget per part

Each hired part has a budget: working minutes and tokens. Defaults come from Settings ▸ Auto ▸ `Part budget` (40 min, 400k), copied into `task.auto.budget` at creation; the agent may set a part's own, and the person may edit it on the card. Limits: 5–600 minutes, 50k–20m tokens.

- **Working minutes** are minutes inside the worker's turns (from `turn.started` to its end; a running turn counts until now), not the time it waits for a review. **Tokens** are the worker task's own figure of the [task counter](agents-and-providers.md#task-tokens), one implementation with the task budget: input, cache writes and output of its finished turns, plus the running turn's estimate from the growth of its context; cache reads do not count.
- While the task is held at its [token budget](#budget-pause), waiting hires do not launch; an approved hire's workers wait with them.
- The agent's host checks every 30 s. A part over either budget goes to the person instead of running on: the host records `exceededAt`, journals `crew.budget.exceeded` in its own journal, and tells the worker's host, which stops the running turn, journals the same event and sets its task `needs-you` with `overBudget`. The sidebar row says `over budget`.
- The stop is sent at every check until the worker's host takes it (`budgetStopped`), so a disconnect or a restart of either host does not let the part run on.
- The person continues the worker with a message (its next turn clears `overBudget`; the budget is not checked again) or dismisses it. Until then `prompt_task` and `submit_review` from the agent to that worker are refused.

<a id="auto-roles"></a>
### Roles to hire from

- `task.auto.roles` is the role library at the task's start: every agent template that is not a foreman, resolved as nodes the way a crew resolves them, for the enabled providers; an own template with a built-in's name stands in for it (`crewPalette`). Library edits after launch do not reach the task.
- When no role fits a part, the agent hires it with a base role (`Developer`, or `Reviewer` for a check) and writes what the part needs into its prompt.
- The agent cannot use a model or provider outside the roles. `hire_workers` takes only role names.

<a id="auto-model"></a>
### Another model

`request_model(reason, role?, part?, provider?, model?, effort?)` asks for a model outside the roles; `role` is the base role the part keeps when the person declines (`Developer` by default).

- By default the [model question card](chat-turns-plans-and-questions.md#model-card) waits for the person (`crew.model.requested`, `needs-you`): the catalog models of the enabled providers, effort, and `Save as role`. `Use this model` adds a role to `task.auto.roles`: the base role's instructions on the chosen provider and options, named after the base role and the model, or the name given in `Save as role`, which also saves it to the library as an agent template. `Keep {role}` adds nothing. `crew.model.resolved` closes the card; the tool returns the role's name to hire with.
- With Settings ▸ Auto ▸ `Any catalog model` on, the app checks the provider, model and effort names against the provider's catalog at once (`auto_model`), the role is added without a card, and the chat shows the agent's choice as a service row. Without a model name, or with the setting off, the card shows.
- A model question does not survive a restart: the agent's call is gone with its session, and the card closes. A call cancelled while the host runs closes its card too: `crew.model.resolved` with `cancelled`, shown as `{role} · {part} · No answer`.



<a id="mcp-server"></a>
## Mechanism: one MCP server, roles and guards

Every agent session gets the app's MCP server `brigadir` in `session/new` (stdio). The server process is a stateless translator: stdio from the adapter ↔ the task host's socket. It is spawned and killed by the adapter, which is why it is not a mode of the host binary.

- Spawn environment: `BRIGADIR_HOST_SOCKET`, `BRIGADIR_HOST_INSTANCE`, `BRIGADIR_MCP_TOKEN`, `BRIGADIR_PROJECT_ID`, `BRIGADIR_TASK_ID`, and for crew members `BRIGADIR_ROLE`. The socket handshake authenticates the token and task id; a server connected to the wrong host is refused. Nothing is passed as visible process arguments.
- Crew calls go to the host as one `crew_tool` method `{tool, params: {...args, callId}}`. The MCP request id is the idempotency key (`callId`).
- Read-only crew tools carry `readOnlyHint`.

<a id="roles"></a>
### Process roles and their tools

`BRIGADIR_ROLE` is one of `auto` (the agent of an [Auto](#auto) task), `foreman` (root of a named crew), `lead` (a foreman node below the root), `developer`, `reviewer` (`crewProcessRole`, `crewTools` in `packages/orchestrator/src/tools.ts`).

| Tool | auto | foreman | lead | developer | reviewer |
| --- | --- | --- | --- | --- | --- |
| `hire_workers`, `dismiss_worker`, `request_model` | ✓ | | | | |
| `propose_plan` | | ✓ | ✓ | | |
| `create_worker_task` | | ✓ | ✓ | | |
| `prompt_task` | ✓ | ✓ | ✓ | | |
| `task_status` | ✓ | ✓ | ✓ | | |
| `read_report` | ✓ | ✓ | ✓ | | ✓ |
| `read_transcript` | ✓ | ✓ | ✓ | | |
| `read_diff` | ✓ | ✓ | ✓ | | ✓ |
| `submit_review` | ✓ | ✓ | ✓ | | ✓ |
| `approve` | | | | | ✓ |
| `accept_task` | ✓ | ✓ | ✓ | | |
| `ask_foreman` | | | ✓ | ✓ | ✓ |
| `post_note`, `read_notes` | ✓ | ✓ | ✓ | ✓ | ✓ |

- The person's tools (`ask_user`, `create_task`, editor context, PR review drafting) exist only in the root's session, Auto or foreman (`humanToolsAllowed`). Workers ask up the tree instead. `set_task_class` is the Auto agent's only, not a foreman's ([Task classes](reviews.md#class-tool)).
- **No separate task for the plan.** While a crew plan exists (it waits for the person or was approved; `crewPlanExists`), the root foreman's `tools/list` leaves out `create_task` and the server announces the change with `notifications/tools/list_changed`; a call from a stale list and the host itself answer `create_task is not available while your crew plan exists: run the plan in this task with create_worker_task.` A rejected plan brings the tool back. **Why:** the plan is executed by this task's crew; a separate task leaves the crew, its review loop and its integration branch behind.
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

Briefs are English (rule 12), built by code (`packages/orchestrator/src/brief.ts`) and delivered as the [session brief](agents-and-providers.md#session-brief): the appended system prompt where the agent takes one, else a `.context` block of the session's first prompt. The agent reads it, the transcript never shows it, it is not journaled, and a restarted host re-briefs its new session itself. The brief holds the role, not the work: the work comes as prompts, and after a compaction the host gives it back ([The assignment after a compaction](#assignment-after-compaction)).

<a id="foreman-brief"></a>
### Foreman and lead brief (`foremanBrief`)

Composed of: the fixed core (`foremanCore`), the lead's place in the tree (leads only), the roster or the compose palette, the crew tools sentence, the template's instructions, the node's extra instructions.

The core says:
1. **Role:** never modify files; split, delegate to named agents, read reports and diffs, review, accept.
2. **Loop:** `propose_plan` (one part per agent: title, agent, owned files, full prompt, written for an agent that sees nothing of the foreman's conversation: the goal, the behaviour expected, what stays untouched, and the command proving the part: a test, a typecheck, a build) → wait for the result, do not end the turn while approval is pending, continue immediately once approved → `create_worker_task` per part with the same agent name, and its acceptance criteria in `acceptance` when the part has reviewers → reports arrive by themselves (no `task_status` polling) → `read_report`, then `read_diff` one file at a time: where the report raises a question when a reviewer approved the part, the whole change when nobody checks it → return with `prompt_task` / `submit_review`, accept with `accept_task`. A part that comes back wrong a second time is returned with `effort` one level higher (see [Returning with more effort](#return-effort)). A return spends no review round and does not restart the count; a part past its [review limit](#review-limit) is accepted or put to the person, not returned for another review.
3. **Own task:** the plan runs in this task through `create_worker_task`; the foreman never creates a separate task for it, even when the person says "in a separate task" (that means the crew's workers). The foreman plans only through `propose_plan`: its session gets no sentence about the CLI's plan mode (see [Plan approval](chat-turns-plans-and-questions.md#plan-approval)).
4. **Splitting:** each worker's prompt states which files it owns and that others belong to other agents; a shared type/config goes to one agent, the rest read it; dependent parts go in waves. Each agent has one task for the whole crew; its next part is another `create_worker_task` after accepting the previous one.
5. **Questions and permissions:** answer a worker's question with `prompt_task` and its `questionId`; permissions are never the foreman's.
6. **Notes:** share facts with `post_note`, read others' with `read_notes`.
7. **Verification:** see [Checks in the running app](#smoke) below; the core carries that paragraph word for word.
8. **Research rule:** a question handed to a subagent is not researched in parallel by the foreman; end the message and wait for the result (the adapter holds the turn until background subagents finish), or run the subagent in the foreground when the next step depends on it. **Why:** the foreman's session lives for the whole crew, so every file it reads is carried by every later step. The same reason is behind the diff rule in the loop: reviewers read line by line, the foreman reads where the decision is its own.

The **roster** (`roster`) lists each child with summary, provider · model · effort (catalog names; "provider default model" when unset), `leads …`, zone, `checked by …`, and for reviewers `checks …`. It tells the foreman to pass `agent` to `create_worker_task` and `propose_plan`, how to match a part to a model (the [model ladder](#model-ladder)), that reports come after checks pass, and that reviewers get no code.

<a id="smoke"></a>
### Checks in the running app

One paragraph of the core (`verification` in `brief.ts`), so it reaches every foreman and lead, composing or not:

1. **A worker proves its part with the command its prompt names** (a test, a typecheck, a build). The foreman does not ask every worker to drive the simulator or the browser.
2. **A check in the running app is a smoke:** the flows the change touches, run **once, on the integrated work** (a part given after the parts it covers were accepted), **by one agent**, within a time box the part prompt states, 10 minutes unless the task needs another.
3. **Not a test matrix:** no list of checks with a screenshot each, no repeats to be sure, and no run per device or configuration unless the task is about that device.
4. **Nobody reviews the smoke report.** The foreman reads it and decides; a defect it finds is a part to fix, not a reason for another round of checks. The agent that runs the smoke gets no reviewer.
5. **Design fidelity is the designer's check**, not the smoke's. A part a designer checks names its design source in its prompt: a Figma node or frame, a mock-up file or a reference screen.

The crew tools sentence (`crewToolsBrief`) says the same in terms of the modules that are on: a part that needs a dev server, a build or the tests runs them as project commands; a check in the running app is the one smoke; the simulator is one device that agents take in turns. The [Tester](crew-templates-and-editor.md#builtin-templates) writes automated tests; a smoke is a different job, and its text says so.

**Why:** a check repeated by every worker, by a checker and by a tester multiplies the cost of one look at the app and finds nothing a single pass would miss; a check matrix with a reviewer on its report grows by escalation, not by risk.

<a id="model-ladder"></a>
### Model ladder

One paragraph of the brief (`modelLadder`), the same in the roster and in the compose palette. It names no model (rule 7): the foreman reads the names in the roster or the palette.

1. A well-scoped part built against a clear spec (a bug fix, one more case of an existing pattern) goes to a faster model.
2. A part that crosses modules, migrates data, tunes performance or has no clear spec goes to a stronger model.
3. Effort `medium` is the default. For a harder part raise it, up to `high`. The step past `high` is a stronger model in a fresh session (a new part for a stronger agent), not a higher effort: effort lets a model think longer, it adds no knowledge.

**Why:** a crew on one model pays the top price for every part; a reviewer is chosen for what the part needs checked, not to outrank its author.

<a id="worker-context"></a>
### Worker context (`workerContext`)

Template instructions, the node's addition, then its place in the tree **without models**: name, who it works for, its zone ("change only files inside it"), who checks it, whom it checks, its other siblings ("do not touch their files"), and "ask with `ask_foreman`, share with `post_note`, `read_notes` before touching a shared type". A reviewer also gets the check procedure (read with the `reviewId`, then `submit_review` or `approve`; two rounds, then the dispute goes to the parent). Other branches of the tree do not exist for a worker. **Why no models:** a neighbour's model is not information for the work and invites speculation instead of reading the diff.

A worker inherits the repo's `CLAUDE.md` by working in a copy of the tree; the foreman writes each part's prompt. Workers are not told to "report"; reports are mechanical.

<a id="assignment-after-compaction"></a>
### The assignment after a compaction

The role brief survives a [compaction](agents-and-providers.md#context-compacted) word for word in the system prompt. A crew member's current assignment came as prompts, and after a compaction the agent keeps only what the summary says of it. So when a crew member's host journals `context.compacted`, the host gives the assignment back as text. **Why:** an agent does not reliably follow an instruction to re-read its assignment from a file after a compaction.

**What the assignment is** (`crewAssignment`). Code builds it from the crew's own documents, never a model. The host that gave the assignment builds it: a member asks its parent's host on the crew link (`assignment`), and the root foreman's host builds its own.

- **A developer with an open part** (its record has no `acceptedAt`): `Part N: <title>`, then the part's prompt as `crew-part.json` keeps it (≤ 100 000 chars, clipped with a note), then the acceptance criteria, then the open review comments. A comment is open when the parent or one of the part's reviewers left it in the member's `review.json` after the part started, and it is not resolved. Each comment gives its author, file and lines, with the text clipped to 2 000 chars.
- **A reviewer with an open check** (a `reviewing` run sent to it that has no verdict from it): the check line `Check task … of <name> (reviewId …, round n of 2)`, a pointer to `read_report` and `read_diff` with that `reviewId`, then the part prompt and the acceptance criteria as the [check prompt](#reviewer) gives them.
- **The root foreman with an approved plan that is not done:** a digest of the plan, built from the approved plan (the `crew.plan.*` records that `crew-plan.json` mirrors), the worker records, the open checks and the questions. It gives the plan's summary (≤ 4 000 chars), then one line per part: title, agent and state. The state is one of `not started`, `queued`, `working`, `in review, round n of 2`, `reported`, `needs you`, `failed`, `stopped`, `waiting for a merge` or `accepted`. Each line also gives the executor (task id, and the member's part number and title when they differ from the plan's) and the member's open `ask_foreman` question (≤ 1 000 chars). The digest ends with a pointer to `task_status` and `read_report`. A part's member is the one that took that part of this plan (its record's `planPartId`); an earlier part of the same agent does not count, so a new plan for a member whose earlier part was accepted is not done. A plan is done when every part's member was accepted and none waits for a next part.
- **A lead:** its own part from its parent, then the digest of its own plan.
- Anything else (no open part, no open check, no approved plan, or every part accepted) has no assignment, and nothing is given.

**How it reaches the agent.** It goes as one hidden `.context` block, `Brigadir assignment`, the way the brief's [`.context` fallback](agents-and-providers.md#session-brief) goes. The block is in English (rule 12). Its first line is `Your context was compacted. This is your current assignment as it was given to you; where your summary differs, this text is right.` The transcript, the journal and the crew link never carry its text.

- While a turn runs, the block goes at the next step boundary (a top-level tool call that finishes) through the [steering](composer-steering-queue-and-ghost.md#steering) request, as a prompt with no text of its own. No `prompt.steered` is journaled, no row shows, and the turn stays the same turn, with one report at its end. When the turn has just ended and the agent starts a new turn for the block instead (codex-acp), that turn has no person's row, like a turn [the agent began on its own](chat-turns-plans-and-questions.md#agent-started-turns), and each of the two turns reports at its own end.
- When the agent declines the steer, or has no steering, the block waits for the next prompt. When the session is idle, the block rides on the member's next prompt, whoever sends it. A prompt that is itself the assignment gets no block: the host that sends a part's or a check's prompt marks it with the assignment's id (`part:<taskId>:<n>`, `check:<reviewId>`). The prompt's text never decides it, so a message that only quotes the part or the check gets the block.
- A parent that does not answer within 10 s (its host is down) leaves the block for the next step boundary or prompt.
- If the agent refuses the prompt that carried the block, the block goes with the next prompt, also after a restart.

**Once per compaction.** Once the agent took the block, the host journals `crew.assignment.restored`: when the steer was accepted, or when the turn of the prompt that carried it ended. A host that stops during that turn gives the block again with the next prompt. Its `compactedSeq` is the seq of the newest `context.compacted` when the block went out, so a compaction that came while the parent was answering is answered by the same block. Its `assignment` lists what the block held (`part`, `check`, `plan`). The list is empty when nothing was open or the prompt itself carried the assignment. A compaction is answered when a `crew.assignment.restored` with its seq or a later one follows it. On start, a host reads that from the journal, so a host that restarted between a compaction and the block gives the block with the next prompt. Each compaction gets its own block, so a second compaction in the same part gives the assignment again. Two compactions before one delivery get one block. Nothing displays the record.

**Size.** The whole block is at most 128 000 chars. The part prompt and the criteria go whole. Open comments fill what is left, in the order they were written, and the comments that do not fit are counted (`N more open comments are left out.`). A digest that would pass the bound ends with `[The rest of the digest is left out.]`.

**Codex.** codex-acp completes a compaction when its `contextCompaction` item ends, and reports the context size only after its next request. The `context.compacted` then comes with the next update of the turn, or with the turn's end. The block follows at the next step boundary of that turn, or with the next prompt.

<a id="plan"></a>
## The plan and its approval

Workers never start before the person approves the root foreman's plan.

`propose_plan` arguments:

| Field | Limits |
| --- | --- |
| `summary` | ≤ 20 000 chars |
| `parts[]` | 1–64; each `title` (≤ 80), `agent` (a child name), `prompt` (≤ 100 000), `files` (≤ 1024 project-relative paths or globs; empty = the agent's whole zone/scope), `scopes` |
| `crew[]` | only when composing; see [Composing the crew](#compose) |

- **Prompts of check parts** (the brief asks for them; the host does not check them): a smoke part names the flows, its time box (10 minutes by default) and that it reports and stops; a part a designer checks names its design source ([Checks in the running app](#smoke)).
- The host validates parts against the crew (`planDifferences`): `unknown_agent`, `reviewer_part`, `duplicate_agent` (one part per agent at a time), `outside_zone`, `empty`, and the non-blocking `idle_agent`. Any blocking difference is a tool error listing the messages (`The plan does not match the crew: …`), not a card. `crew` without composing → `Your crew is already set; call propose_plan without crew.` Only one plan may wait at a time.
- The card lets the person edit part titles, prompts, agents and files; differences introduced by edits are shown on the card and block `Start workers` (`planBlocked`; idle agents only show). Agent names arrive pre-filled in editable fields.
- `Start workers` approves; `Reject` rejects (the foreman revises or asks). The tool result returns `approved`, the possibly edited parts and the difference messages.
- **Plan review.** The root foreman's plan gets the [plan review](reviews.md#plan-review) when it is presented; the reviewer also checks the split ([The foreman's split](reviews.md#plan-split)). Findings come back as a rejection whose tool result carries `review` (the findings and the instruction to revise once or object, then call `propose_plan` again), or as the decision prompt when the turn already ended. `Start workers` stays available and ends the review.
- **Decision after the turn ended:** when the proposing turn has already completed (or the session failed / host stopped) while the MCP call stayed open, the decision is also sent as a separate prompt through the queue — approval lists the current (edited) parts and tells the foreman to create the worker tasks now; rejection asks for a new split. A live turn gets only the tool result.
- **One plan mechanism.** The foreman plans only with `propose_plan`, and the plan runs in the foreman's own task: from the proposal on, `create_task` is hidden from it (see [Process roles](#roles)), and its session never gets the plan-mode sentence of a solo Claude session.
- **Lead plans** are approved immediately by the host: the plan shows in the lead's activity, only the root plan waits for the person, and the root foreman can return the branch.
- **Waiting plan = needs-you.** `crew.plan.requested` sets the foreman to `needs-you`; `crew.plan.resolved` recomputes the status, and a turn that ends with the split still waiting leaves it `needs-you`. Sidebar, `⌘J`/`⇧⌘J`, `Active workers` and keep-awake treat it like a permission or question. A notification `The foreman proposes a split` with the attention sound and Dock badge closes when the plan is decided; it waits 750 ms (`planSettleMs`) so an auto-approved lead plan never notifies.
- **No client timeout on a waiting call:** for Claude over ACP the host sets `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` to 7 days unless the person set it; Codex gets `tool_timeout_sec = 604800` for the `brigadir` server; a CLI task's `cli-mcp.json` sets `timeout` 7 days. The server also sends `notifications/progress` every 60 s (`progressBeatMs`) while a call that sent a `progressToken` waits.

<a id="compose"></a>
### A crew snapshot with a palette (`compose`)

A task whose crew snapshot carries a palette (`task.crew.compose`, `templateId: "compose"`) has a foreman that proposes its crew with its plan. New tasks are not created this way (the sheet launches `Auto`); a task that has such a snapshot runs as follows.

- The palette snapshot holds every library agent template except the foreman, expanded as nodes (provider, model, effort, specialty, instructions), plus each enabled provider's catalog models and each model's effort levels. Template edits after launch do not affect the task.
- While `compose` is set and the root has no agents, the brief carries the palette instead of a roster (`composeBrief`): read the task and code first, then call `propose_plan` with `crew` and `parts` together; **the fewest agents the task's independent parts need**, non-overlapping zones; one developer and no reviewer is a whole crew for a single chain of dependent steps (a split pays only when parts can run side by side); a reviewer only where a part needs a second reader, named in that developer's `checkedBy` (one reviewer may check several); models by the [model ladder](#model-ladder); reviewers take no code; no leads (one level under the foreman). The palette lists every non-foreman template of the library by name, with its role, specialty and default model; an own template with the name of a built-in stands in for that built-in, so a name always means one template.
- `crew[]` entries: `name` (≤ 80, short, unique, names its area), `template` (palette template name), optional `summary` (≤ 240), `zone`, `provider`, `model`, `effort` (palette names), `checkedBy` (reviewer names). The host builds nodes (a different provider drops the template's choices), checks the editor's rules (unique names, a reviewer checks only developers, zones) and then the parts against this crew. Unknown template or model → tool error listing what is available.
- A composed crew needs at least one developer; reviewers are optional, and a reviewer nobody names in `checkedBy` checks nothing.
- The palette brief adds the check roles in the terms of [Checks in the running app](#smoke): a Designer only when the task names a design source to match; at most one agent runs the smoke, and nobody checks it.
- The plan card shows a `Crew members` section above the parts (provider glyph, name, template role, model · effort, specialty, `checks …`). `Edit crew…` opens the crew editor on the proposed crew as a one-off crew; on `Done` parts are re-checked and part agents are chosen from the new list. The foreman itself cannot be changed there (`The foreman is already working: its settings stay.`). Approve/reject covers crew and parts together.
- After approval the crew becomes `task.crew.root.agents`, `compose` is dropped, and the task is an ordinary crew; the host updates its context without a restart and the approval reply lists the approved roster (prefixed "The human edited your crew." when edited).

<a id="workers"></a>
## Workers are tasks

`create_worker_task(agent?, title, prompt, files, scopes, acceptance?)` — a foreman's, after plan approval only (`Call propose_plan first; …`), except in a PR review by a crew (see [Pull requests and CI](pull-requests-and-ci.md)). An Auto task's workers start from an approved hire ([Hiring](#auto-hire)) the same way from here on: the task, its branch and worktree, the part file, the slots.

- `agent` names one of the caller's children; it may be omitted only when there is exactly one non-reviewer child. Unknown name → error with the list. A reviewer cannot be given a part: the host starts reviewers itself.
- `files` outside the agent's zone → error. Title ≤ 80, prompt ≤ 200 000, `acceptance` ≤ 20 000.
- The part's prompt (clipped to 100 000 chars, marked `clipped`) and `acceptance` (what must hold for the part to count as done) are kept for its reviewers in `crew-part.json` in the member's own task directory, with the part number (see [Reviewer agents](#reviewer)); the next part replaces it. A file of its own keeps `crew-workers.json` small, whatever the prompts weigh.
- The worker task: `isolation: 'worktree'`, `baseRef` = the foreman's branch (or `HEAD` when the foreman is not isolated), the foreman's setup command and `.env` copying, `crewTaskId` (root crew), `crewNodeId`, `parentTaskId`, launch options from the node's requested choices (model, effort, mode). Unavailable options are recorded in `unavailableOptions`.
- **Branch name:** `<foreman branch>-<agent slug>` (dash, because `a/b` cannot coexist with ref `a`), then `-2`, `-3` only when taken in some repo of the project. An Auto worker's agent is its node, so `<branch>-developer`, `<branch>-developer-2`.
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

A named crew's node has one task, one session, one worktree and one branch for the crew's whole life. An [Auto](#auto) task hires a new worker task per part instead.

- The first `create_worker_task` for a node creates the task (part 1). After `accept_task`, the next `create_worker_task` for that node **continues the same task**: part `N+1`, same `taskId`, reply `part`, `continued: true`.
- Errors: current part not accepted yet → use `prompt_task` for it; next part waiting on a merge → waits for the human; the worker is busy in a person's turn → wait for the turn end; `scopes` naming a repo the task lacks → error listing its repos (ACP roots are fixed at session start). If the person deleted the worker task, a new task is created and the node record replaced.
- `prompt_task` on an accepted task between parts → error naming `create_worker_task`.
- Between parts the worker is `completed` and its host stopped; a new part goes `queued` → the host restarts and resumes the same session → `working`.
- **Sync before the part:** in each repo where the parent tree has the worker branch, the host creates `P` (tree = parent `HEAD`, parents = last accepted worker tip from `acceptedTips` and parent `HEAD`) and runs `git merge --no-edit P` in the worker tree — usually a fast-forward; new work the person did after acceptance stays. If the parent tree is mid-merge/squash → error. A conflict → the worker task goes `needs-you` with `MERGE_HEAD`, unresolved files and a `git-merge.json` entry (`from` crew branch, `into` worker branch); the tool reply says `needs-you` with the files and "do not resolve it yourself". The host polls every 3 s: `Finish merge` queues and starts the part; `Abort merge` withdraws it, restores the previous accepted part, emits `crew.part.dropped` and prompts the foreman with the `part-dropped` marker.
- **Diff base of a part:** after the worker host starts, the foreman's host asks it for a checkpoint, stores it as `changeBase` in the worker's `task.json`, and only then sends the part prompt. Every change surface of the task (Changes panel, `+N −M`, unreviewed, `read_diff`, report, outside-the-zone list, `ReviewRun` snapshots, comment anchors) counts from `changeBase`; the turn range stays absolute.
- The part prompt starts with an English header: part number and title, the previous part was accepted, the crew tree was merged in, so re-read files before changing them.
- The task title is the current part's title; the card row stays `<agent> · <part title>` and the `Workers` counter counts members, not parts. `part` lives in `crew-workers.json`, `task_status` returns it, and reports say `part N` from the second part on.
- Zones and files are checked per part; locks and worktree belong to the task; nothing is cleaned up after acceptance (cleanup happens with the task, see [Tasks](tasks.md#delete-task)).
- Context growth: a member's session compacts at the [compaction window](agents-and-providers.md#compaction-window) (200k by default), and its role brief rides in the appended system prompt, so it survives every compaction. After each compaction the host gives the open part back: its prompt, its acceptance criteria and its open review comments ([The assignment after a compaction](#assignment-after-compaction)). The chat shows each compaction as a [service row](chat.md#context-compacted).
- Compatibility: a record without `part` is part 1; without `acceptedTips` the sync base is the worker branch `HEAD`; crews with several tasks per node continue in the newest.

<a id="reports"></a>
## Reports: push, built by code

When a worker's turn ends, the worker host pushes a report to the parent with the task status that turn left (outbox `crew-outbox.json` survives a missing parent). The parent receives an ordinary `session/prompt` — queued if it is busy, so it arrives as the next turn. Nobody polls.

- **Done or not.** A report is *done* when the worker's task was `done` after that turn and the turn ended with `end_turn` (`crewReportDone`). Both come from the report's own turn: the status pushed with it and the last `turn.completed` at or before its `seq`, so a report that waited in the outbox while a later turn ran is judged by its own turn (a report from an older outbox without a status is judged by the status now). A turn that was cancelled, failed, hit a rate limit, stopped on `max_tokens`, `max_turn_requests` or a refusal, or left the task `needs-you` (a sync or merge conflict) is not done. Only a done report with changed files goes to the part's reviewers; any other report goes straight to the parent, opens no check and spends no round.

`buildReport` (`packages/orchestrator/src/report.ts`) builds it from the journal and the snapshot diff:

- header `Report from <name> · <title> (task …, part N)`, status, changed file count and `+N −M`;
- files (up to 200) with status and counts, project-relative paths;
- `Changes outside the assigned files (n)` (up to 20 names);
- checks with verdicts and round, and the disputed note when reviewers did not agree;
- `Usage: N turns, X in, Y out, Z cached` — tokens of the member's task so far, summed from its `turn.usage` records: `in` is input plus cache writes, `cached` is cache reads (see [Agents and providers](agents-and-providers.md#turn-usage)); unlike the [task's counter](agents-and-providers.md#task-tokens) it keeps cache reads, and only finished turns; the line is left out when the provider reported none. No model and no money: reviewers read the same report, and the foreman has the model in its roster;
- `Notes: N new` (never a separate push);
- the question the worker ended with;
- the worker's last message (≤ 4000 chars);
- a footer naming `read_diff`, `prompt_task`, `accept_task`.

A turn that got its [assignment back after a compaction](#assignment-after-compaction) reports once at its end, like any turn: the block opens no turn and no report of its own.

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
- A reviewer of the task's own review that asks while a plan holds the parent's turn — the Auto agent's plan for approval, the root foreman's split — answers that plan with the question ([plan chat](chat-turns-plans-and-questions.md#plan-chat)): it runs as the parent's next turn, and the parent presents the plan again after answering. A solo task's agent has no `prompt_task`; its reviewers' questions wait for the person as before.
- A question that ends while its prompt still waits in the parent's queue — cancelled with the caller's turn, or answered by the person — takes that prompt out (`prompt.removed`): the parent's agent may be held by a plan for approval or a hire card, and the prompt would otherwise run after the answer, for a question nobody waits on.
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

1. The developer ends a turn with a [done report](#reports) and the part has changed files; the host opens a `ReviewRun` and prompts each reviewer itself: `Check task … (reviewId …, round n of 2)`, the report, then the part's prompt as the foreman gave it (≤ 100 000 chars, clipped with a note) and its acceptance criteria when the foreman gave them, and the instruction to check against them and ask the foreman only what they leave open. The parent spends no turn. A report that is not done, or a part with no changed files, opens no check and goes straight to the parent.
2. Reviewers read with that `reviewId` and either `submit_review(taskId, reviewId, comments)` or `approve(taskId, reviewId)`.
3. The host collects one verdict per reviewer and delivers one comment batch to the developer, who fixes and reports again.
4. When all reviewers approve in a round, the report with verdicts goes to the parent, which accepts or returns (`prompt_task`). Only the parent returns work.
5. Comments in the last round → `disputed`: the report goes to the parent with both sides.

<a id="review-limit"></a>
**Rounds belong to the part.** The worker record counts the part's rounds (`rounds`): a round is a check the host opens, and nothing else. A return from the parent (`prompt_task`, `submit_review`) spends no round and does not restart the count; nothing within a part restarts it, and the next part starts from zero. The limit is two (`crewReviewRounds`). A developer nobody checks has no rounds and gets no notice.

- While the count is under the limit, a done report with changed files opens the next round (`round n of 2`, n = the count after it). Opening a round supersedes a run of the task still `reviewing`; a run left in `comments` keeps its state and no longer decides the round.
- Once the limit is reached, the host opens no check for that part. The parent is told **once** (`limitTold` on the record): the dispute report says the part reached its review limit, the comments stay open in the review thread, and the parent accepts the part with `accept_task` or puts the decision to the person (`ask_user`; a lead asks its own parent with `ask_foreman`) instead of returning it for another review. A report that arrives past the limit without a dispute (a change after the second check approved or during it) carries the same notice the first time; later reports of the part go to the parent as plain reports.

`ReviewRun` (`crew-reviews.json`): `reviewId`, `taskId`, `nodeId`, `name`, `title`, `part?` (the member's part, absent = 1), `reportSeq`, `reportHash`, `scopeSnapshots` (base and result tree OID per scope, from the part's `changeBase`), `round`, `reviewerNodeIds`, `dispatched`, `verdicts` (each `reviewerNodeId`, `reviewer`, `approved`, `comments`, `at`, `note?`, `commentIds?` — the ids of the comments it stored, which go out in the run's one batch once every verdict is in, also after a restart between two verdicts), `state` ∈ `reviewing | comments | approved | disputed | superseded | cancelled`.

- Report and diff of a run are immutable; reviewers' `read_report`/`read_diff` read that snapshot.
- Any newer report of the developer — done or not, with changes or without — supersedes a run still `reviewing`, and so does a tree change; an old verdict returns `stale_review`. OIDs are re-checked before handing the report up.
- One reviewer serves one run at a time; the rest queue FIFO and survive a restart. Waiting on a question or permission is not a finished review.
- A check whose reviewer turn ended without a verdict because it was cancelled (`Stop now` at the budget, a stop in the reviewer's chat), failed, or lost its host goes to that reviewer again — into a new host when the old one is gone — at most three times in all. A turn that ended by itself without a verdict is silence: it is not sent again.
- State and the delivery queue are written before waking an agent; deliveries have ids and are idempotent; a different verdict on a closed `reviewId` is rejected; restart restores runs and never treats silence as approval. An unrecoverable session gives `needs-you`, keeping snapshot and verdicts. The member's next part starts again from round 1.
- A task's own reviews — mid-task and before its pull request, a worker's part included — run their own loop ([Reviews](reviews.md#loop)); the per-part count applies only to this check edge.
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
- **Auto:** a waiting hire card or model question sets the Auto task `needs-you`. A worker over its budget is `needs-you` in its own row only: the card keeps its fill and sort place (`crewNeedsYou` leaves it out), since the agent goes on with its own work.
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

An Auto task's activity adds: the [hire card](chat-turns-plans-and-questions.md#hire-card) and its folded row (`crew.hire.requested` / `resolved`), the worker rows of the hire, `crew.worker.dismissed`, `crew.lead.committed`, `crew.budget.exceeded`, `crew.zone.touched`, the move into a worktree (`workspace.move`, below), the [model question card](chat-turns-plans-and-questions.md#model-card) and its row (`crew.model.*`). Turn markers: `hire-decision`, `zone-touched`.

The move into a worktree is one service row at the place of its first `workspace.move`, showing the newest state of that move (glyph, `workspace`, then):
- moving: a spinning glyph, `Moving to a worktree`, the repos (`business · design-tokens`);
- moved: the worktree glyph, the branch, `from {base}`, `{n} repos`, `moved` in green;
- some paths stayed: the branch, `from {base}`, `{n} paths stayed` in amber, and under the row each path with its reason (`apps/mobile/.env.local · ignored by git`), monospace 10.5, up to 20 and `{n} more`;
- failed: the failure glyph in red, `Could not move to a worktree`, the reason in red; the hire's folded row says `Not hired · {agent} does it itself · no worktree`.

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
| `crew-hire.json` | Auto | `{hire, decision}` of the newest hire; `decision: null` while the card waits |
| `workspace-move.json` | Auto | the move into a worktree: `id`, `hireId`, `decision`, `state` (`pending`, `moving`, `switched`, `moved`, `failed`), `branch`, `base`, `repos`, `moved` (per repo the paths and the blobs at the task's start, for the project folder), `stayed` |
| `crew-workers.json` | foreman/lead/Auto | `CrewWorkerRecord[]`: `taskId`, `nodeId`, `name`, `title`, `createdAt`, `planPartId`, `acceptedAt?`, `effectiveChoices?`, `unavailableOptions?`, `part?`, `acceptedTips?`, `next?` (`queued \| merging`, `previous`, `heads?`), and for the current part `rounds?`, `limitTold?`; an Auto worker also `hireId`, `planPartId` (its part of the hire), `budget`, `exceededAt?`, `budgetStopped?`, `zone`, `hiredFrom` (repo path → the commit it started from), `dismissedAt?`, `dismissReason?` |
| `crew-questions.json` | parent | `CrewQuestion[]` (`id`, `workerTaskId`, `parentTaskId`, `callId`, `agent`, `question`, `options`, `createdAt`, `escalateAt`, `state`, `answer?`, `answeredBy?`) |
| `crew-reviews.json` | parent | `ReviewRun[]` |
| `crew-notes.jsonl` | root foreman | `CrewNote` per line |
| `crew-outbox.json` | worker | reports not yet delivered: `seq`, `status?` (the task status that turn left) |
| `crew-part.json` | worker | the current part for its reviewers: `part`, `prompt` (≤ 100 000 chars), `acceptance?`, `clipped?` |
| `git-merge.json` | any | open merge/squash per repo (`from`, `into`, conflicts) |

<a id="budget-pause"></a>
## Token budget and pause

The crew is one task for the [token budget](agents-and-providers.md#task-budget): the count is the sum over the foreman, leads, workers and reviewers (all carry the root `crewTaskId`), per provider, and the budget is the root task's. When one provider's count reaches its budget the whole crew pauses ([reaching the budget](agents-and-providers.md#budget-reached)):

- turns that run now — the foreman's and every member's — finish; nothing new starts;
- the foreman's queue holds reports and the person's messages; every member's queue holds its parts, reviews and messages; the crew host holds waiting hires (`watchSlots` launches none);
- the foreman is `needs-you` with `{Provider} budget reached`; members keep their own states;
- `Stop now` cancels the foreman's turn and every member's running turn; `Finish turns, then stop` lets them end;
- raising the budget resumes the foreman's queue, the waiting hires in their order and each member's queue in its own order.

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
| Review rounds per part (checks the host opens) | 2 |
| Part acceptance criteria / part prompt in a reviewer's prompt | 20 000 / 100 000 chars |
| Assignment block after a compaction / one open comment in it / plan summary in a digest | 128 000 / 2 000 / 4 000 chars |
| Report file list / outside list | 200 / 20 |
| Concurrent worker launches | 2 (plus the global agent limit) |
| Waiting MCP call client timeout | 7 days; progress heartbeat 60 s |
| Parts per hire (Auto) | 16 |
| A part too small for a worker | under 50 estimated lines |
| Part budget (Auto) | 5–600 working minutes, 50k–20m tokens; default 40 min, 400k; checked every 30 s |
| Model question reason | 2 000 chars |

<a id="later"></a>
## Later

- Per-project additions to the foreman's role brief (global template instructions already add to it).
- Check edges between different branches of the tree.
- A reviewer that also owns a part of the code.
- Task classes (small, medium, large) stated by the agent, and the host's threshold that starts a mid-task review on its own.
- A token counter per task with a pause at a threshold.
- Asking on `Stop` of a foreman whether to stop its workers too (default yes).
- Foreman indicators (worst context) aggregated over its workers; tokens per accepted part on the plan card.
- Raising a worker's effort automatically after a disputed check.
- The design check as a host step: the contract table per design node, with the host verifying that each row's screenshot exists.
- The smoke as a host step with a time box the host enforces: at the limit it stops the run and asks for the report.

<a id="non-goals"></a>
## Non-goals

- Starting workers without the person's approval of the plan or the hire.
- An Auto agent using a model or provider outside its roles without the person's answer or the `Any catalog model` setting.
- The foreman (or a reviewer, or `ask_foreman`) deciding worker permissions.
- Automatic resolution of merge conflicts without the person asking.
- Polling worker state from the foreman.
- A direct worker ↔ worker channel or a shared crew chat.
- A separate `answer_worker` tool, or `prompt_task` as a second way to start a next part.
- Reviewers accepting work.
- The foreman merging branches through its own tools, rebasing worker branches, or forbidding overlaps in the plan (overlaps are shown instead).
- Changing a worker's model in the middle of its task.
- Claude's own subagents as workers (they have no worktree, states, diffs or review loop).
