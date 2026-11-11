# Tasks

A task is one unit of agent work inside a project: a prompt, the repos it may touch, an isolation mode, and one agent session (or a crew, see [Crew](crew.md)). This file covers the task model and its states, how a task is created and started (the New task sheet, fast start, backlog, quick tasks, agent proposals), how its workspace is prepared and locked, and how it ends (stop, delete, worktree removal, archive).

<a id="task-model"></a>
## Task model

A task is stored as `projects/<projectId>/tasks/<taskId>/task.json` (`{schemaVersion: 1, task}`, pretty-printed with sorted keys) under `~/.brigadir/`. The type is `AgentTask` in `packages/core/src/workspace.ts`. Fields that matter for this file:

| Field | Meaning |
| --- | --- |
| `id`, `projectId`, `title`, `status` | Identity, display title, state (see [States](#task-states)). |
| `prompt` | The first message; may be empty (a backlog task can be a name only). |
| `provider`, `transport` | `claude` \| `codex`; `gui` \| `terminal` ([CLI tasks](terminal-and-cli-agents.md)). |
| `launch` (`TaskLaunch`) | `isolation` (`in-place` \| `worktree`), `branch`, `branchAuto`, `baseRef`, `setupCommand`, `copyEnvFiles`, `scopes[]` (`ScopeChoice`: `id`, `name`, `kind`, `selected`, `path`, `worktreeOf`), and for in-place starts `switches[]` / `pull[]`. |
| `preparation` | `{state: 'preparing' \| 'failed' \| 'ready', step, error?}` while/after the workspace is prepared. |
| `blockedBy` | Task keys holding the locks this queued task waits for. |
| `launchOptions`, `modelName`, `effortName` | Model/effort/mode picked before start; applied with `setOption` before the first prompt. |
| `attachments[]` | Backlog/sheet attachments sent with the first prompt. |
| `hasStarted` | The journal has a `turn.started`. |
| `continuesTaskId` | Relay source (one-way link, see [Relay](#relay)). |
| `originTaskId` | The task whose agent proposed this one with `create_task`. |
| `relaySelection`, `relayIssue` | Which relay attachments were chosen; `summary-failed` \| `source-unavailable`. |
| `archived`, `completedAt` | See [Archive](#archive). |
| `agentRole` | The role a solo agent works as: `{templateId, name, instructions}`, a snapshot taken at creation ([Role](#sheet-role)). |
| `crew`, `crewTaskId`, `crewNodeId`, `parentTaskId` | Foreman snapshot and worker links ([Crew](crew.md)). |
| `scheduleRun` | A run of a schedule ([Schedules](notifications-slack-notes-and-schedules.md)). |

Manual title and pin are **not** in `task.json`: main owns them in `~/.brigadir/task-labels.json` keyed by project/task, because a live host may rewrite `task.json` at any moment. The workspace snapshot, search, header, menus, Active agents and notifications show the manual title over `task.json`. `Rename task…` rejects empty or multi-line names and keeps the input on a failed write; an unknown schema in the file is never overwritten. A title typed on the sheet is the manual title and always beats the auto title derived from the prompt.

Task-directory files: `task.json`, `events.jsonl` (normalized journal), `host.json` / `host.lock` (live host), `worktree.json` (worktree manifest), `worktree-released.json`, `worktree-setup.log`, `relay.json`, `attachments/<id>/`. Data-wide: `scope-locks.json`, `launch-queue.json`, `task-labels.json`, `drafts/`. Per-project launch defaults live in `projects/<projectId>/workspace.json`.

`task.json` writes inside one process are serialized per file (`SessionStore`): every read-modify-write waits for the previous one, so a status write at `turn.completed` cannot drop a concurrent `launch` update.

<a id="task-states"></a>
## States

`TaskStatus`: `backlog`, `queued`, `preparing`, `working`, `needs-you`, `done`, `interrupted`, `failed`, `rate-limited`, `completed`.

| State | Meaning |
| --- | --- |
| `backlog` | Saved intent; nothing is initialized (no host, session, worktree, locks, baselines or journal). Set only by the person. |
| `queued` | Waits for a concurrency slot or a scope lock (`blockedBy`). Never means "started without a prompt". Sidebar line: `Waiting for the repo` when lock-blocked. |
| `preparing` | Worktree or in-place preparation runs (`preparation.step`). |
| `working` | A turn runs. |
| `needs-you` | A permission, a question, a plan or a task proposal waits for the person. The most important state: it is never hidden. |
| `done` | The turn ended; the host may still be alive and waits for the person. |
| `interrupted` | Stopped by the person. |
| `failed` | Start, preparation or agent failure. |
| `rate-limited` | Subscription limit hit; resumes at reset. |
| `completed` | The person marked it completed (board column / menu / swipe). Set only by the person. |

Rules:

- Agents never write `backlog` or `completed`.
- `needs-you(permission)` is a protocol fact; a "question" in plain end-of-turn text is a heuristic on top of a finished turn.
- Orthogonal markers: unread (`hasUnread`) and unreviewed changes (`hasUnreviewedChanges`: done with a non-empty diff not yet opened). Their presentation is in [Sidebar](sidebar.md).
- A GUI start that did not send a first prompt (empty or whitespace-only) and is still `queued` after `start()` becomes `done`: the host is up and the person writes next. CLI tasks keep the status their hooks report.
- Stop on a backlog task never marks it `interrupted`: nothing was running, and the intent must stay in the backlog.

<a id="launch-sheet"></a>
## New task sheet

One sheet (`NewTask.tsx`) serves New task, Edit task… (backlog), Duplicate task…, Continue in a new task, schedule creation and "Task options…" from an agent proposal. It is an in-app modal with the shared `PopupClose` (`Esc`) in the header; footer actions keep their own buttons.

<a id="sheet-layout"></a>
### Layout

- Two columns, 780 px wide (narrower windows reflow; 600 px is a supported width). Left: task name and prompt. Right: a 248 px parameter rail on `--tint`, separated by `--sep`, grouped with 14 px gaps, 14 px top and bottom padding.
- Header: the task name field in place of a heading (borderless text, placeholder `Task name (optional)`), the project name, the `Task type` segment `Agent` | `Brigadir`, and `Esc`. The dialog is named for screen readers through `aria-label`.
- Prompt: the shared CodeMirror prompt editor, borderless, 13.5 / 21 like the composer, at least 84 px. Placeholder `Write a message… (optional)`. Markdown is rendered in place; markers hide except on the caret line. `@` inserts mentions (files of selected repos and folders, crew nodes for a Brigadir task, agents `Claude` / `Codex`), shown as pills; mentions go to the agent as paths or English template names ([Composer](composer.md)). The hint row `+ · @ · ⌘V` sits right under the text; clicking the empty rest of the column puts the caret in the text.
- A task can be created with only a name (backlog) or only a prompt.
- Focus opens in the prompt.

<a id="sheet-rail"></a>
### Parameter rail

Groups for type `Agent`:

| Group | Controls |
| --- | --- |
| `Role` | Role popup: `No role` first, then the agent templates ([Role](#sheet-role)). |
| `Agent` | Provider popup, model popup (same control family), effort and mode, Fast mode; the subscription limits button sits right of the group label. |
| `Transport` | `GUI` \| `CLI`. |
| `Isolation` | Segment `No isolation` \| `Worktree` (data value `in-place` / `worktree`). Worktree only: `Branch name` (empty = auto, placeholder `brigadir/auto`), `from` + `Base ref`, `Copy .env`, `Setup command`. No isolation only: a `Branch` group per git repo (current branch, switchable before start; pull and dirty-tree handling, see [Git](git.md)). |
| `Repos and folders` | Chip row (see [Repos](#sheet-repos)). |

Type `Brigadir` replaces `Agent` with `Crew` (template popup with `Foreman composes` first, `Set up…`, the crew tree with provider marks and models) and drops `Transport` (a crew always runs in the GUI). Choosing `Brigadir` switches isolation to `Worktree`. Details: [Crew templates](crew-templates-and-editor.md).

- Worktree fields expand and collapse with the shared disclosure motion; values persist while the sheet is open.
- Starting isolation comes from `agents.isolation` (Settings ▸ Agents), not from the last choice in the project.
- Repos, isolation, base ref, setup command and `.env` copying are remembered per project (`workspace.json`); the caption `Saves launch settings for this project.` says so. The branch is generated per task and never becomes a default. Crew template choice is remembered as `crewTemplateId`.
- Rail labels: 11 px `--fg2` on a 16 px line, 6 px above the control; git refs (branch, setup command, base ref) are mono 11.5. Controls use the shared `ui/` sizes; rail popups open `align="end"` and show `PopupMarks` (✓).
- A project with no git repo shows `A Git repository is required for worktree isolation.` in red under the fields.

<a id="sheet-role"></a>
### Role

A task of type `Agent` can give its agent a **role**: an agent template from the library, so a task that is only documents, only tests or only a look at a screen goes to a specialist without a crew.

- The popup lists `No role` (the default: an agent with no role text), then every template of the library that is not a foreman, built-in ones first, in the library's order. Each item carries the template's glyph: code for one that writes, review for a checker.
- Picking a template that has a provider sets the sheet's provider, model and effort to the template's; the person can change them after. A template without a provider, or with a provider turned off in Settings ▸ Agents, leaves the sheet's agent as it is. `No role` changes nothing.
- A checker (a template with reviewer rights) writes no code: the task gets `readOnlyAgent`, takes no repo lock and runs in the GUI, so `Transport` is not offered. It reports what it found to the person.
- The role is a snapshot (`agentRole`): the task never reads the library again. It is not remembered for the project: the next sheet opens with `No role`. Edit task… and Duplicate task… open with the task's role. In the edit sheet a role whose template is gone stays chosen by its name; a duplicate of such a task opens with `No role`.
- Schedules and Continue in a new task have no role control.
- The role text goes to the agent in the session brief ([What the agent is told](#agent-context)).

<a id="sheet-model"></a>
### Model and effort on the sheet

- The model popup lists exactly the provider's catalog (first item selected); there is no synthetic `Default` item. The catalog is the same as for crews and the backlog card (`templates:catalog`).
- If no task taught the catalog yet, the app probes the agent (`probeAgentCatalog`): starts the transport in a temporary folder, reads `session.started`, closes it — no prompt, task or journal. The result is cached for the app run; a failed probe is forgotten after five minutes. While loading, the same popup is shown disabled with `Loading…`; if the agent never answers, the control disappears.
- Changing the provider resets the model pick. Choices go to `launchOptions` and are applied at session start. Effort levels per model: [Agents and providers](agents-and-providers.md).

<a id="sheet-base-ref"></a>
### Base ref

A searchable popup, not a text field. List: `for-each-ref refs/heads refs/remotes` of the **root** repo, sorted by last commit date, without `*/HEAD`, at most 60 (`listRefs`). A remembered value that no longer exists stays first rather than being silently replaced. The list scrolls on its own and opens where there is room; the search field `Search branches` on top handles arrows, `Enter`, `Esc`; empty result `No branches match`. In a monorepo the one base name is checked in every root during preparation.

<a id="sheet-repos"></a>
### Repos and folders

- One chip row: a selected repo is `× name`, an unselected one `+ name`. Order is the project's discovery order, root first, and never jumps on selection.
- Folders from outside the project stand in the same row with a folder glyph; an external git repo carries `↗`, a folder without git carries `no git` (read-only).
- `Add folder…` (dashed chip, last in the row) opens the system folder picker. The folder joins **this task only**; project launch defaults include only repos under the project root. A just-added chip shows an accent ring that fades in about 2 s.
- A selected repo always takes a lock (see [Locks](#locks)), so the lock conflict check runs whenever a repo is chosen.
- Repo selection model, discovery and read-only rules: [Projects](projects-and-board.md).

<a id="sheet-attachments"></a>
### Attachments

`+` ▸ `Attach files…`, `⌘V` and drag from Finder onto the left column (the rail and footer do not accept drops). Same paste kind detection, main-side path (`attachment:paste`, `attachment:paths`) and limits as the composer: **10 attachments, 8 MB total, images up to 4 MB**. Attachments render as pills/thumbnails inside the text. `+` ▸ `Description from a .md file…` inserts the text of a `.md`/`.markdown` file (≤ 1 MB) at the caret, once — the file is not linked or attached.

Storage: for a task that does not exist yet, files go to `drafts/<projectId>/<draftId>/attachments/`; `Start`/`Save` moves them into the task (`rename`), `Cancel` deletes the draft, leftovers are removed at app start. Task attachments live in `attachments/<id>/` with metadata in `task.json` `attachments[]`. An attachment removed in the edit sheet leaves the list; its file stays until the task is deleted.

<a id="sheet-footer"></a>
### Footer

| Sheet | Left | Right |
| --- | --- | --- |
| New task | `Add to backlog` toggle pill (`+` off, `×` on; label never changes) | `Cancel`, primary `Start` (`Save` when the toggle is on; `Starting…` while busy) |
| Edit task (backlog) | `Start task` (saves, then starts) | `Cancel`, `Save` |
| Schedule | — | `Cancel`, `Schedule` |

<a id="fast-start"></a>
## Fast start

`⌘N` (File ▸ New task) or `+` on a project opens the sheet with focus in the prompt; typing and `↩` starts with the project's defaults and type `Agent`. Nothing on the sheet lengthens this path: every rail value is pre-filled. A Brigadir task on the fast path takes the default crew. Prompt templates are not a feature: `/command` text is passed to the agent, which runs its own custom commands.

<a id="branch-names"></a>
## Branch names

- Empty branch field = auto: the agent names the branch at the preparation step (one-shot call, 2–4 English kebab-case words, `branchFromAnswer`); see [Git](git.md). Until then the task holds a derived name (`withAutoBranch`, `branchAuto: true`).
- Derivation (`deriveBranch`, `suggestedBranch`): ASCII only, `brigadir/<slug>` from the title, else the prompt; Ukrainian text is transliterated by the national table (KMU 2010); stop words of both languages are dropped; one-letter words are dropped except digits; up to 6 words / 48 chars. Without usable words: `brigadir/task-<6 chars of id>`.
- Crew worker branches: `<foreman branch>-<agent>`, with `-2`, `-3` only on collision.
- Validity is checked by the app before start (`Enter a valid ASCII branch name.`), not by git at `worktree add`.

<a id="isolation"></a>
## Isolation

| Mode | Where the agent writes | Locks |
| --- | --- | --- |
| `No isolation` (`in-place`) | The project's working trees on their current branches (optionally switched/pulled before start). | Takes a write lock on every selected repo. |
| `Worktree` | `~/.brigadir/worktrees/<projectId>/<taskId>`: one worktree tree for all roots, outside every repo. | Takes no source locks. |

A worktree task's root is used by the host, files, editor, terminals and snapshots. Managed nested copies keep the source scope's kind; other nested worktrees are not discovered as scopes.

<a id="worktree-preparation"></a>
### Worktree preparation

Order is fixed: **root → submodules → nested repos → `.env` copy → setup command**. In a fresh root worktree, submodule folders exist as empty gitlinks and `git worktree add` refuses a non-empty folder, so the reverse order is impossible.

- A branch is created in **every** repository (root, each submodule, each nested repo).
- A durable manifest (`worktree.json`) records the copies. On a first run an existing branch is rejected (`Branch already exists in <repo>`); a retry after partial failure reuses the copies of its own manifest; after `Remove worktree…` the branch named in `worktree-released.json` is accepted, any other existing branch is still refused.
- Preparation is a task state (`preparing` with `preparation.step`), not a modal spinner. The task window shows `Preparing workspace` with the current step: `Naming the branch…`, `Switching the branch`, `Pulling from origin`, `Creating working copies…`, `Copying .env…`, `Running setup…`; plus `Cancel` and, after failure, `Retry`. A start waiting for a slot shows `Waiting for a free slot.`
- `Setup log` (soft disclosure button) shows `worktree-setup.log`, polled every second while preparing: raw host output with `--- time ---` markers, no wrapping (horizontal scroll), mono 11 / 17, bounded size.
- Setup failure → preparation `failed` with `Setup command failed (<code>). See worktree-setup.log.`; the copies are already usable and stay.
- The setup supervisor kills its process group if the controlling process dies; its kernel identity is recorded before the shell starts, so a retry never overlaps a still-exiting previous command.
- Removal walks copies in reverse order, leaves source files and branches, refuses to traverse symlinks, and never adopts an unregistered existing folder as its own.
- `.env` copying: [Git](git.md). An interrupted preparation is recovered at app start.

<a id="agent-worktrees"></a>
### Worktrees the agent creates

- The session brief tells every agent not to run `git worktree add` itself and to ask the person first (`worktreeBrief`).
- If it does anyway: after every completed tool whose input contains `worktree`, the host runs `git worktree list` in each writable repo of the task. A new path outside the project root and outside `~/.brigadir/worktrees`, not present when the host started, joins the task as a folder (`launch.scopes`, lock, snapshot, ACP roots from the next turn). No permission card: same repo, already writable.
- A folder from outside that is a checkout of the task root's repo (same `git-common-dir`) gets `worktreeOf` = root id, whether added by the agent, `Add folder…` or `add_folder`. The composer footer and sidebar card show `Worktree · <its branch>`; diff and Repos show both. The newest such checkout wins; when it disappears the root's branch returns.

<a id="agent-context"></a>
### What the agent is told

- Scope boundaries go structurally through `additionalDirectories` of the session.
- An English repository-context block (type, branch, writable/read-only) is added to the first GUI prompt or the initial CLI prompt. User files such as `CLAUDE.md` are never edited.
- A task with a role starts its session brief with the role: one sentence that the agent works alone and answers to the person, then the role text. For a built-in template the text is its solo variant (`soloInstructions` in `packages/core/src/solo-role.ts`): what the role does, without the crew tools. For an own template it is the template's Instructions as written, with a sentence to turn to the person wherever they name a foreman, a crew or crew tools. A checker is also told it changes no files.
- Read-only repos: the policy layer rejects writes; writes that bypass it through shell commands are caught by snapshots and surface as the notice `The task only reads these repos, but files in them changed during the turn.`
- Commit and push across submodules run in dependency order (submodule before parent): [Git](git.md).

<a id="locks"></a>
## Locks and conflicts

<a id="lock-registry"></a>
### Lock registry

- One registry for all projects, `~/.brigadir/scope-locks.json`, keyed by canonical scope paths (`LockHolder`: `key`, `title`, `acquiredAt`).
- Mutations are serialized by `flock` in a child helper whose stdin belongs to the controlling process; EOF releases the system lock. The guard file is never deleted. Main and host wait asynchronously.
- A conflicting claim takes nothing; an explicit override records both owners. Corrupt or newer-schema JSON and a failed process-identity read are never overwritten.
- Owner identity = PID + kernel start identity + random instance. A small C helper reads `sysctl(KERN_PROC_PID)` on macOS; Linux reads `/proc` start ticks with the boot id. Records without kernel identity are released only when the PID disappears. Why: a reused PID must not make a dead lock look alive.

Who holds a lock:

- Main checks locks before start; the host repeats an atomic claim before creating the agent, so two racing starts cannot both write.
- An idle GUI host keeps its lock until it stops. Stop, park and delete end the host and release the lock. A GUI host with nothing to do stops after 15 min (`hostIdleMs`), as after Stop; the next message resumes the session. A CLI task releases its lock when its process exits.
- Refreshing an unchanged PR record writes no journal event and does not reset the idle clock (`samePullRequest` compares fields, not serialized JSON), so a `done` task's host can fall asleep and free its lock.

<a id="lock-conflict"></a>
### Lock conflict dialog

Shown at launch (and when a busy repo is chosen), before anything starts. Title `Repo is busy`; one line per owner: "`<repo>` is busy with the task **X**. Locked N min ago." — N counts from that owner's `acquiredAt`, not from the task's start.

| Option | Effect |
| --- | --- |
| `Isolate in a worktree` | Separate repo copies without locks. Disabled with `This task has already used its workspace. Create a new task to use a worktree.` when the task cannot switch. |
| `Wait in queue` | `queued` with `blockedBy`; starts by itself when the repo is free; a dead owner is noticed within 3 s. |
| `Work despite the lock` | Override for this one launch. Both tasks write to one repo; their diffs mix; both show the contention marker. |
| `Cancel` / `Esc` | Nothing starts; focus returns. |

- There is no "don't ask again": this is the one place where a silent default is dangerous.
- While an override lasts, the repo is **contended**: both tasks carry the amber contention chip in the composer footer and the repo group header ([Notice chips](notifications-slack-notes-and-schedules.md)); the scope heading shows the lock marker with its owners.

<a id="launch-queue"></a>
### Launch queue and concurrency

- `agents.maxConcurrent` (Settings ▸ Agents ▸ `Concurrent agents`; `null` = `Unlimited`, max 99). Starts beyond the limit wait as `queued`. Backlog tasks occupy no slot.
- The queue is durable (`launch-queue.json`) and resumes after restart. An observer runs every 3 s **only while someone waits**, because slots and locks free up without any action of ours (an owner may just die). A busy head is skipped. A start counts as an occupied slot for 15 s until its status is visible.
- Two different queues: the prompt queue inside a task ([Composer queue](composer-steering-queue-and-ghost.md)) and this task queue.

<a id="backlog"></a>
## Backlog

- `Add to backlog` on the sheet saves the task as `backlog`. Nothing is initialized; the tree snapshot is taken at `Start task`, as for any task. A backlog task holds no lock and no concurrency slot.
- `Start task` (card menu, board, edit sheet) runs the same launch path as New task from the stored state (prompt, options, repos, crew, attachments) — there is no second launch code. An empty stored prompt is not delivered and never clears what the person typed in the composer.
- Empty-task cleanup (`prompt` empty) never removes a backlog task.
- Only the person creates backlog tasks; crew workers are never in the backlog.
- The project screen shows backlog as its own last section, after recent tasks, outside the `⌘J` attention queue; the sidebar has no backlog chip — the card itself (open outline) carries it. See [Projects and board](projects-and-board.md), [Sidebar](sidebar.md).

<a id="backlog-edit"></a>
### Editing a backlog task

- `Edit task…` exists only for a backlog task the agent has not seen (`!hasStarted`). It opens the same sheet with the stored manual title, model, options (`launchOptions`) and attachments; saving writes the same `task.json` and validates options against the chosen model's catalog. An empty name returns to the auto title.
- First prompt: the host adds the task's `attachments[]` to the first prompt together with relay attachments — GUI as ACP blocks (`image`, `attached_context` with a file link), CLI as `<attached_image>` / `<attached_context>`. A task with no text but with attachments still sends a first prompt. Total with relay ≤ 10.
- A backlog card with attachments shows a paperclip with a count (board, list, sidebar second line); it disappears after start.
- `Duplicate task…` opens the sheet seeded from the source (name, prompt, repos, crew) but does not copy attachments.

<a id="relay"></a>
## Continue in a new task

A new task that starts with the knowledge of a previous one. Entry points: the stopped-task banner (next to `Continue with a new agent`, a different action: same task, new agent), the task context menu (`Continue in a new task`), the archived-task strip, and File ▸ `Continue in a new task` (menu item without a shortcut). Not offered for `backlog` or `preparing` tasks (a backlog task has no journal).

- The sheet opens with launch options inherited (shown `As in X`) and always a **new** branch, plus two removable chips: `Task summary` and `Task diff`, each with a short token estimate (`≈ 4.2k`, chars / 4, no context percentage). A total line sits under the chips.
- Summary: generated only after an explicit continuation, by a disposable ACP call without tools/MCP/fs, with timeout, cancel and output bounds (`relayJournal` caps input). A crew worker's summary is its ready report (no model call). Failure is visible (`The summary could not be generated. You can start without it.` + `Generate again`) and never blocks the start.
- Diff: a snapshot-tree diff against the source task's baseline (includes new files). Default is `--stat` plus up to 20 file links; `Full patch` adds the patch (shortened to the attachment limit with a notice).
- Delivery: attachments go as `.context` blocks with English framing; the person's text is sent as typed. GUI sends `ResourceLink`s only for regular files that exist in the **new** task's tree; CLI uses `additionalContext`. The initial prompt is not rewritten; later turns and reconnects do not repeat the handoff. Text assets and `relay.json` are written before the task is queued.
- A worker is continued as an ordinary task.
- Backlog keeps the link and the selection, not the attachments; current context is prepared at `Start task` (note `Backlog keeps the link…`).
- Link: `continuesTaskId` only, one-way. `Continued in` is derived by searching the project's tasks. The new task shows `Continuation of X` in its header and on its board card (the one exception to the four-line card); the sidebar does not show it. A deleted source or failed summary keeps a visible warning (`relayIssue`; `Previous task unavailable`).

<a id="agent-created-tasks"></a>
## Tasks proposed by the agent (`create_task`)

An agent can propose a new task in the **same** project with context and extra folders; the person decides.

- Available to a plain task (GUI and CLI) and the root foreman; not to workers, leads or reviewers (`humanToolsAllowed`).
- Arguments: `title?` (≤ 80), `prompt` (English, a complete brief), `context[]` (≤ 10: `summary`, `diff` with `full?`, `file` (absolute path), `text` (`name`, `text`)), `folders[]` (≤ 5 absolute paths outside the project root), `agent?` (`provider`, `model?`, `effort?`), `start` (`now` default \| `backlog` \| `schedule` with `schedule.rule`, see [Schedules](notifications-slack-notes-and-schedules.md)).
- Inheritance: repos, isolation, transport and folders from the current task; the branch is always new. Without `agent`, provider/model/effort are inherited; with it, the named provider and the provider defaults for whatever is left out.
- Validation before the card: the host refuses without an active turn, for a folder inside the project root, and for missing folders or files. The host asks main (`ui.request('task_agent')`) to resolve `agent` against the provider's catalog (model by value or case-insensitive name; effort among the model's levels). Unknown model/effort, a disabled provider or an empty catalog fail the call with the available values; no card appears.
- Proposal is a journal event, not a task field: `task.proposal.requested` / `task.proposal.resolved` (`core/task-proposal.ts`). The source task is `needs-you` while the card waits; sidebar line `New task · <title>`; notification `The agent proposes a new task.`
- Card `{agent} proposes a task` (plan-card family): title, first prompt lines, context and folder chips; when `agent` was given, the first chip is the agent (`Codex · <model> · <effort>`). Actions: `Create`, `Task options…` (opens the sheet pre-filled via `proposal:draft`; a task created there is linked via `proposal:adopt`; closing the sheet keeps the card), `Decline`. Stop, restart or host death answer `null` (declined).
- Main creates the task (`main/task-proposals.ts`): first into the backlog, then attachments (summary without a model call, diff as in relay, files by link, notes as text), `originTaskId`, the resolved agent; then it answers the host and, for `start: now`, queues the launch. Folders are added as `external` (git) or `folder` (no git) to the new task only.
- The new task shows `Created from X` in its header and board card. The agent gets the new id and title but cannot drive it (no `prompt_task` / `accept_task`).

<a id="quick-tasks"></a>
## Main tree and quick tasks

<a id="main-tree"></a>
### Main tree

Clicking a repo row in the sidebar opens the project's main working tree for that repo on its current local branch, even with no tasks: editor (saves write straight into the working tree) and the right panel `Files | Changes | PR`. The row is highlighted, no task card is. The toolbar shows the project name and `main tree · <repo>`, without the Chat | Editor switch; changes are against the last commit and the commit strip works.

- Implementation: a hidden task record `main-tree` (`MAIN_TREE_ID`) per project — no provider, never launched, status `done`, all project repos. Sidebar, board and search skip it (`readWorkspace` without `includeMainTrees`); project removal includes it. It cannot be archived.
- Its diff base is always `head` (`Changes.baseFor`). No host runs (`session:start` and prompts are refused), so its snapshot refreshes on open and window focus.

<a id="quick-task"></a>
### Quick task

Every "send to agent" without a task (editor selection, PR comments, the field `New quick task in {branch}…` at the bottom of the main tree, `⌘N` there) opens the `New quick task` sheet: name and prompt (`What should the agent do?`) prefilled with context chips, the agent from Settings, `No isolation`. `More options…` opens the full New task sheet. After start the person stays in the main tree; the task appears as a sidebar card with an `Open` toast. Locks apply as for any in-place task.

PR branch ≠ current branch: if the main tree is clean, the quick task fetches the PR branch and `git switch`es to it, and the sheet says so; if dirty, the sheet offers a worktree from `origin/<head>`. The person can also switch the main tree's branch from the repo row picker ([Git](git.md)).

<a id="live-agents"></a>
## Active agents popup

A button in the title strip of the task window, the project screen and the Notes screen (also in the toolbar `…` overflow): pulse glyph `activity` + live count; an amber dot on the pulse when someone needs you; tooltip `Active agents`. The count area is stable; `—` before the first read, `?` on error. No keyboard shortcut.

The popup (`Active sessions across all projects`) lists **live host processes** of every saved project, including idle ones between turns, workers and tasks whose project is not open. It is independent of the sidebar status filter.

- Source: every task's `host.json` / `host.lock`, kernel start identity check, and the last 64 KiB of `events.jsonl` for the current activity. Observation never attaches to a task socket. PID and token never reach the renderer.
- Refresh: on open, every 1 s while open, every 5 s otherwise (only while the document is visible), and 200 ms after session events (`session.started`, `turn.*`, `question.requested`, `permission.requested`, `task.proposal.requested`, `crew.plan.requested`, `host.stopped`).
- Rows grouped by project (section heading = project name): state icon, title, provider glyph, second line (current activity or the state label: `Working`, `Needs you`, `Preparing…`, `Queued`, `Rate limited`, `Error`, `Interrupted`, `Waiting for a prompt`), age. Clicking a row opens the task (and its project).
- Loading: skeleton rows; read errors: `Some agents could not be read.` + `Retry`; empty: `No active agents`.

| Action | Mechanism | Result |
| --- | --- | --- |
| `Stop` | Pauses the prompt queue and cancels the turn through the task socket | Process lives; the next prompt goes into the same session |
| `Force quit process…` | Inline confirmation `End this session?` (`Cancel` / `Force quit process`), then an authenticated shutdown of exactly the shown instance (same cleanup as SIGTERM) | Session ends |
| `Stop all` (footer) | `Stop` for every active row | — |

There is no "force quit all". A row's actions menu also opens with right-click, `ContextMenu` or `⇧F10`. The instance check means a process replaced between display and action is never hit.

A worker stopped from outside is recorded by the person's action (`interrupted` in its `task.json`), so the foreman's report says it was stopped rather than "still working".

<a id="ending-tasks"></a>
## Stopping, deleting and removing worktrees

<a id="task-menu"></a>
### Task context menu

Native menu on a sidebar card (`sidebar-menu.ts`): `Open task` | `Continue with a new agent` / `Start task` (when not connected) · `Continue in a new task` | `Duplicate task…` · `Repeat…` · `Show task diff` | `Edit task…` (backlog) · board moves (`Add to backlog`, `Mark completed`, `Start task`, `Move to in progress`) · `Rename task…` · `Pin task` / `Unpin task` · `Copy task title` · `Stop` | `Archive ⌃⌘A` (disabled while not archivable) · `Delete task…`.

`Stop` cancels a preparation, dequeues a queued start, or pauses the prompt queue, stops the host and sets `interrupted`.

<a id="remove-worktree"></a>
### Remove worktree

`Remove worktree…` removes a worktree task's copies without deleting the task. It lives in the `Worktree actions` (`…`) menu in the header of the Repos popover, and in the repo menu of a single-repo task — never as a per-repo action, because the worktree is one tree for all roots and a partial removal breaks the task.

- Present only when the task has a prepared worktree; disabled while the task is live with `Stop the task before removing its worktree.`
- In-app confirmation (`ConfirmDialog`, danger): `Remove the worktree?` — "Removes the task's repo copies. Branches and commits stay. The next start creates worktrees." — `Cancel` / red `Remove`.
- Afterwards the task keeps its history; `worktree.json` is gone and `worktree-released.json` holds the branch, so the next start prepares a new worktree on the same branch.

<a id="released-worktree"></a>
### Tasks whose worktree was removed

A removed worktree (`worktree-released.json` present, `worktree.json` absent; `SessionStore.releasedWorktree`) is an expected state, derived on read, never a failure. `SessionStore.workspace(key)` returns `{path, released}` with the former path.

| Surface | Behavior |
| --- | --- |
| Snapshots, chat, Diff (Turns/Changes), `+N −M`, change attribution | Work from snapshots: missing scope folders are `available: false`, `Scope.source` points at the project repo at the same relative path (objects and refs live there); comparison uses the task base even when `head` is chosen. |
| Files tree | Empty list with `released: true` and the calm note `Worktree removed` / "Resuming the task recreates its worktree and files."; polling continues, so the tree returns by itself. |
| File search, Text search, file links, code navigation | Empty results, no errors. |
| Editor open from diff/anchor | Refused with `WorkspaceReleased` ("The task worktree was removed"). |
| Agent context (`context-state`) | Repo paths stay absolute. |
| Slash catalog | The project's catalog. |
| Quick Ask | A `failed` event with an explanation; the agent never starts in the main tree instead. |

<a id="delete-task"></a>
### Deleting a task

- Native confirmation. Lines added as applicable: `Task worktrees will be removed; branches stay.`, `Crew workers are deleted too: {n}.`, `Uncommitted changes in worktrees will be lost: {files}.` (sum of `git status --porcelain` over every repo of every worktree, submodules counted by themselves, not by the parent).
- For an archivable task the dialog offers `Archive` (default, `↩`), `Delete task`, `Cancel`, with the line "Keeps the task and history. Removes its clean worktree; preserves uncommitted changes."
- Cascade: deleting a task deletes every task under it — workers (`crewTaskId`) and sub-foremen (`parentTaskId`). Each goes the same way: stop, `git worktree remove --force` in every repo plus folder removal, task data to the Trash. Same for project removal.
- A worker whose crew no longer exists shows in the sidebar as an ordinary task so it can be opened and deleted; nothing is deleted automatically at start.
- Branches are never deleted here; branch deletion lives in the git interface.
- The board's Completed column has no trash: it archives (see below). Delete stays in the context menu and the Archive window.

<a id="archive"></a>
## Archive

Hide finished tasks without losing anything.

<a id="archive-model"></a>
### Model

- `task.archived = {at, by: 'manual' | 'auto', status, worktree: 'removed' | 'kept' | 'none', uncommitted?}` (`TaskArchive`). Archive is a field, not a status: the status is unchanged, so host, board, notifications and Active agents need no archive knowledge. `status` is the status at archiving; Restore puts the task back into the same column.
- `personTasks` returns only non-archived tasks: sidebar, board, project list and Clear the list never see archived ones. A worker archived with its foreman is shown inside the foreman (`archivedTasks`).
- `task.completedAt` is set by `setStatus('completed')` and cleared by any other status. Migration: completed tasks without it are stamped with the current time on the first auto-archive pass (`unstampedCompleted`), so they leave after N days rather than all at once.

<a id="archive-actions"></a>
### Archiving and restoring

- Archivable (`canArchive`): status in `done`, `completed`, `interrupted`, `failed`, `backlog`; not in the launch queue; no descendant `working`, `needs-you`, `preparing`, `queued`, `rate-limited`; not the main tree. Otherwise the menu item and shortcut are disabled (`Cannot archive while the agent is working.`) and the swipe does nothing.
- Archiving takes the task with its descendants, stops the host (`stopForRemoval`) and the task browser; journal, snapshots and drafts stay; nothing goes to the Trash; no confirmation.
- Worktree: clean → removed like `Remove worktree…` (`worktree: 'removed'`); with uncommitted changes → **kept** (`worktree: 'kept'`, `uncommitted: N`, amber mark in the row); no worktree → `'none'`.
- Restore (`Restore`, `Restore from archive`) clears `archived` on the task and descendants and restores each status. The worktree is not recreated immediately; normal preparation recreates it when the task continues (branch from `worktree-released.json`).
- Main refuses to launch or continue an archived task.

Entry points:

| Where | What |
| --- | --- |
| File ▸ `Archive task` | `⌃⌘A` (Windows/Linux `Ctrl+Alt+Shift+A`); always in the menu bar, disabled without an archivable open task |
| Card menu | `Archive ⌃⌘A` before `Delete task…` |
| Sidebar swipe | Two-finger swipe left on a card (`swipeAction`): completed/backlog → archive (accent); in progress with no agent at work (`done`, `interrupted`, `failed`, not queued, no busy descendant) → complete (`--green`, `boards.move(key, 'completed')`). Partial swipe reveals the 92 px action, ≥ 92 px at gesture end performs it. Working/waiting/preparing/queued/rate-limited: no swipe. |
| Board Completed column | Header `Archive the list` (native dialog with the count: "Keeps tasks and history. Removes clean worktrees; preserves uncommitted changes."), per-card archive button (no question) |
| Toast | Bottom of the sidebar, 6 s: `«<title>» is in the archive` or `“<title>” completed`, with `Restore` (undo; for complete it moves the task back to in progress → `done`) |

<a id="auto-archive"></a>
### Auto-archive

Settings ▸ Agents ▸ Tasks ▸ `Archive completed`: `Never`, `After 1 day`, `After 3 days` (default), `After 7 days`, `After 30 days` (`agents.archiveAfterDays`: `1 | 3 | 7 | 30 | null`; a missing key reads as 3; a stored value is never migrated). Hint: `Only tasks marked completed.`

- Main runs a pass at start, hourly and right after the setting changes. Candidates: the person's tasks (not workers), status `completed`, not pinned, `completedAt` at least N days old; archived with `by: 'auto'` through the same path.
- A card leaving within a day shows a clock in its title line: `Archives today` / `Archives tomorrow`.

<a id="archive-window"></a>
### Archive window

Opened by: View ▸ `Archive…` `⌥⌘A` (Windows/Linux `Alt+Shift+A`); the archive button in the sidebar header next to `All projects` (count of the whole archive, hidden when empty); the mini button in a project row (that project's count, hidden at 0); the `Archive N` button in the project screen toolbar left of Board / List (the project, or all on All projects); a Search Everywhere group `In the archive` (only for a typed query, under live tasks; `↩` opens read-only, `⌘↩` restores; data from `archiveSearch` in `core`).

- Modal over the window, `min(880, 100vw − 48) × min(600, 100vh − 80)`, `PopupClose`.
- Header: `Archive`, search `Search the archive: title, prompt, branch` (focused), project popup (`All projects` or one, with ✓, opens below), segments `All` / `Manually` / `Auto`.
- List grouped by archive time: `Today`, `This week`, then months. Row: status mark in the archived status's color (Done green, failed red, completed `--fg3`, interrupted/backlog `--fg2`), project icon, title, project · branch, way mark (box = manual, clock = auto) with `manual · yesterday`, provider glyph; `Restore from archive` on hover/selection (hidden by opacity, so Tab reaches it). Selected row `--sel`. Right-click opens the native row menu (`Open task`, `Restore from archive`, `Show diff`, `Copy task title`, `Delete task…`).
- Preview: title, `project · agent · in the archive <when>`, prompt, branch, worktree state (removed / kept with N uncommitted files / main tree), colored `+N −M`; `Restore` (primary), `Open`, `Delete` (danger outline button).
- Multi-select with `⌘`-click / `⇧`-click: full-height panel `Selected {n}` with `Restore {n}` and `Delete…`.
- Keys: `↑↓` select, `↩` restore (only from the search field or a row; a focused button keeps its own Enter), `⌘O` open, `⌘⌫` delete…, `Esc` close. The footer repeats them and says `Completed tasks archive after {days}` with a `Settings` link (Agents tab); `Delete all…` deletes every shown row after one count confirmation.
- No matches: `The archive has no «{query}».` + `Search all tasks` (Search Everywhere with the same query).
- Delete from the window: in-app dialog opened with `Delete` focused over `--modal-scrim` — "Delete N tasks from the archive?", "Chat logs and change snapshots go to the Trash", `Branches stay: …`, worktree state; `Cancel` / red `Delete`; then the normal deletion path without a second question.

<a id="archived-task"></a>
### An archived task when opened

The log reads as usual; above the composer a strip `The task is in the archive. The transcript is read-only.` with `Restore from archive` (primary) and `Continue in a new task`. The composer is `inert` at 50 %.

<a id="later"></a>
## Later

- `contextExhausted` state with its card and sidebar icon.
- `Fork from here` (new task seeded from a point in an existing one).
- Active agents: worker rows nested under their foreman's chevron, auto-expanding when a worker needs you; foreman row reading "Leads N workers".
- Central approval inbox: one batched permission queue across all agents, deny with a reason, remembered decisions per `(tool, pattern, scope)`.
- `Other…` in the Base ref popup for starting from a tag or SHA.
- `create_task` into another project or across several projects.
- Copying attachments with `Duplicate task…`.
- A role for scheduled tasks and for Continue in a new task; the role shown in the task header.
- Bounded snapshot history for the main tree (it currently grows with every save, up to two checkpoints each).
- The new task composer as a non-modal draft in the central area instead of a sheet.

<a id="non-goals"></a>
## Non-goals

- Own prompt templates with placeholders: agents' slash commands already cover it, and a second concept would fight over the `/` prefix.
- "Don't ask again" on the lock conflict dialog; force-quitting all agents at once.
- Removing the worktree of a single repo of a task.
- Asking about worktree cleanup after a PR merge; a "also delete branch" option in delete dialogs; auto-deleting orphan workers at start.
- Archiving or silently removing a worktree with uncommitted changes.
- Automatic relay when context runs out; passing the full transcript to the new task.
- An agent driving a task it proposed outside a crew, or writing `task.json` / `workspace.json` directly.
- Branch names with non-ASCII characters.
