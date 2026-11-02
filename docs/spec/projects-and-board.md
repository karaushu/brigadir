# Projects, scope and the project screen

A project is a folder on disk together with every git root found under it. A task picks which of those repos it works in, and it can bring extra folders from outside the project. When a project is selected and no task is open, the project screen shows the project's tasks as a board or a list, its pull requests in PR mode, proposals for the project's agent instructions, and the project icon.

<a id="projects"></a>
## Projects and repos

- A **project** (`Project` in `packages/core/src/workspace.ts`) has `id`, `name` and `path`, plus project-level data: `icon`, `iconPick`, `commands`, `simulator`, `pullRequestBases` and `formatter`. Its data lives in `~/.brigadir/projects/<id>/` (`project.json`, `workspace.json`, `knowledge.json`, `icon.png`).
- The unit of work is a set of **repos** (internally `Scope`, `scopeId`, `scopes`), not a single repository. The UI always says `Repo` / `Repos` (`1 repo`, `2 repos`). The internal names stay in IPC, JSON and JSONL for compatibility.
- The project title shows the path with only the current user's home directory shortened to `~`, and the full path goes in a tooltip. Stored paths are never shortened. Desktop adds `homeDirectory` to the workspace snapshot only for display.
- `Add a project…` is the folder-plus button in the sidebar's `All projects` row. The project context menu has `New task`, `Open main tree`, `Project knowledge…`, `Project icon…`, `Reveal in Finder`, `Copy path` and `Remove project…`. `Remove project…` moves the project's data folder to the Trash.

<a id="repo-discovery"></a>
### Discovery

`discoverScopes(projectPath, managed)` in `packages/git/src/scopes.ts` walks the tree from the project's real path:

| Rule | Value |
| --- | --- |
| `.gitignore` | Ignored on purpose. This is the only way to find independent repos that the parent ignores. |
| A candidate | A directory holding a non-symlink `.git` (a directory or a file) |
| Depth | `discoveryDepth = 4` levels below the root |
| Skipped directories | `.git`, `node_modules`, `.pnpm-store`, `dist`, `.next`, `.build`, `build`, `vendor`, and every `.brigadir*` |
| Walk cap | 10 000 directories. Above that, discovery fails. |
| Validity | `git rev-parse --show-toplevel` must equal the candidate path. An uninitialized or invalid `.git` is not a repo. |
| Linked worktrees | A `.git` file that `git worktree list` reports as a linked worktree of the candidate is excluded, together with everything under it. This keeps `.claude/worktrees/*` from showing up as new repos. Worktrees the app manages are passed in through `managed`. |
| `id` | The first 16 hex characters of sha256 over the canonical path |
| `name` | The path relative to the root (`.` for the root). The UI shows the root under the project's name. |
| `remote` | `remote.origin.url` with credentials, query and fragment removed |

Repo kinds (`ScopeKind` in `packages/core/src/launch.ts`):

| Kind | Meaning |
| --- | --- |
| `root` | The project folder itself |
| `submodule` | A repo for which `--show-superproject-working-tree` is non-empty |
| `nested` | An independent repo under the root, gitignored or not |
| `worktree` | A `.git` file that is not an excluded linked worktree |
| `external` | A git repo outside the root, added by hand ([Folders from outside](#external-folders)) |
| `folder` | A folder without git, added by hand. It is context the agent reads. |

<a id="discovery-refresh"></a>
### Refresh without rewriting history

- Refresh and the host's watcher, which watches for `.git` directories appearing or disappearing, re-run bounded discovery. Watch events are debounced. The app's own refs and indexes and the build and dependency trees are ignored.
- A new repo gets its baseline when it is first found. Earlier checkpoints are never rewritten.
- A repo that disappears stays in metadata with `available: false`. The other repos keep working.
- Paths are checked for symlinks and for escaping the project. Discovery does not follow symlinks.
- A metadata change emits `scopes.changed`, even when the tree delta is empty.
- An existing choice survives rediscovery. A repo found after the project was set up arrives **unselected**.

<a id="repo-selection"></a>
## Repo selection: in the task or not

A repo has one stored state per task, `selected` (`ScopeChoice.selected`). The app keeps no other per-repo flag. Everything else is a function of `selected` in `packages/core/src/scope-select.ts`, and no result of these functions is ever stored:

| Function | True when | Used for |
| --- | --- | --- |
| `inTask` | selected and a git repo | diff, lock, write access, manifest |
| `watched` | not selected, a git repo, still listed | snapshot that backs `scope.violation` |
| `contextOnly` | selected and `folder` | read-only context: no diff, no lock, no writes |
| `writableByAgent` | `inTask` and available | the host's write policy |
| `snapshotted` | a git repo that is available and listed | every git repo of the project is snapshotted, selected or not |

Rules:

- A selected git repo appears in the diff, takes a lock and is writable by the agent. An unselected repo gives no diff, takes no lock and cannot be written.
- "Writes but hidden" and "visible but read-only" do not exist. A verifier that must not write takes the same repos as its parent, and the host refuses its writes because of its role (`checks: true`), not because of its repo set. See [Crew](crew.md).
- Locks equal the task's selected git repos (`launch-locks.ts`), so a conflict shows up when the chip is picked, not after start.
- The unreviewed-changes dot counts only selected repos. Writes into an unselected repo surface as `scope.violation`, which is a different signal.
- The selection UI is a row of chips in the launch sheet: an unselected repo shows as `+ name`, a selected one as `× name`, and `Add folder…` ends the row. See [Tasks](tasks.md).
- The task's Repos panel keeps one menu item per row, `Add to the task` or `Remove from the task…`. While the agent runs, the item is disabled with the reason `Stop the task before changing its repos.` A repo outside the task shows a lock mark labelled `Outside the task` and no `+N −M`. See [Sidebar](sidebar.md).
- `Files` panel visibility follows `inTask`.

<a id="selection-compat"></a>
### Reading older records

`isScopeChoice` accepts either `selected` or the old pair `diffEnabled` / `agentWritable`. `normalizeScopeChoice` maps the old pair as follows: `selected = agentWritable`, so `diff: true, write: false` becomes unselected and `diff: false, write: true` becomes selected. The old fields are dropped when the record is read and never written back. Files take the new shape on their next save. `schemaVersion` does not change.

<a id="external-folders"></a>
## Folders from outside the project

A task can include a folder outside the project root:

- `external`: a git repo, for example a backend next to the frontend. It has a diff and the agent can write to it.
- `folder`: a folder without git. The agent only reads it.

**The folder belongs to one task.** Whether it comes from the launch sheet, the task's Repos panel, `add_folder` or `create_task`, the folder lives only in that task's `launch.scopes`. It is never written to the project's `workspace.json` and never becomes a project default. Old `folders` entries in `workspace.json` are not read and disappear with the next write of the project settings.

| Rule | Behaviour |
| --- | --- |
| Description | `LaunchSettingsStore.describeFolder` in `main/launch-settings.ts`: `realpath`, must be a directory, `id` = sha256(canonical path)[0..16], kind `external` when `rev-parse --show-toplevel` equals the path, otherwise `folder` |
| Name | The folder's own basename. If that name is taken in the project or task, the parent's name goes first (`parent/name`). The full path, shown with `~`, is the second line and the tooltip. |
| Storage | An absolute canonical path. It is never stored relative to the project or with `~`. `~` is only a display form. |
| Inside the root | Refused (`The folder is inside the project`). Discovery owns those repos. |
| No git | No tree, so no snapshot, checkpoint, `+N −M`, change list, lock, review or attribution. The chip carries the tail `no git`. The manifest gives it `writable: false` and the host write policy refuses writes to it. |
| Folder missing | The entry stays with `available: false`, and the row reads `Folder unavailable`. It takes no lock, gives no diff and is not passed to the agent. The task does not fail. Only the person removes the entry. A repo under the root that is missing fails the launch instead (`A selected repo is unavailable`). |
| Worktree isolation | An external repo is not copied into the worktree. An isolated task works on it in place and takes a normal lock on it. |
| Deselecting | Deselecting removes the folder from the task: the row disappears and the folder is no longer snapshotted or watched. Adding it again uses `Add folder…`. A repo under the root stays listed as unselected. |
| Launch revalidation | `resolve()` rechecks every outside folder's path and id at launch. |
| Content | The app never reads or injects the folder's contents. The manifest gets its path, name, kind and access, like any repo. |

The launch sheet lists only the repos under the project root and the folders added in that same sheet. A task proposed by `create_task` takes the source task's selected folders plus its own `folders`.

<a id="folders-mid-task"></a>
### Adding a folder to a running task

- **Person**: `Add folder…` is the last row of the task's Repos panel (IPC `scopes:add-folder`) and is not shown for the main tree. It opens the system folder picker (`Add a folder from {machine}`) and works while the agent is running. A failure shows a toast with `Retry`.
- **Agent**: the MCP tool `add_folder` takes an absolute path. The host refuses missing paths and paths inside the project, and answers `The folder is already in the task.` when the folder is already there. Otherwise main describes the folder and a permission card asks `Add <name> to the task` (with ` · read only` for a `folder`), with `Allow` and `Deny`. Both kinds ask. The tool returns `added`, `name`, `path` and `writable`.
- The folder joins the task at once: diff, lock (for in-place tasks), write policy and the repo manifest that goes with the next prompt. ACP roots change at the next turn boundary: before the next prompt the host reconnects the adapter with `session/load` and the new `additionalDirectories`. In `Terminal` mode the folder goes into the next prompt's `additionalContext` and the CLI keeps running.
- A git repo that another task holds locked is not added. A folder is removed through its row's menu, and only while the agent is stopped.

**Why.** The need for another folder comes up in the middle of work, and stopping the task for it loses the turn. Reconnecting at a turn boundary loses nothing, because `session/load` restores the session.

<a id="worktree-isolation"></a>
## Isolation is per repo

`git worktree add` does not populate submodules, and a gitignored nested repo never reaches a worktree. An isolated environment is therefore one worktree **per in-task git repo** under the root, assembled into the same path structure, followed by the project's `setupCommand`. External repos and `folder`s are excluded and stay in place. The order is fixed, because `git worktree add` refuses a non-empty directory:

1. the root's worktree (it leaves submodule directories empty);
2. submodule worktrees, created in those empty directories (the root then sees a valid gitlink and its `git status` stays clean);
3. worktrees of the nested independent repos;
4. `setupCommand`, for example `pnpm install`.

Unselected repos still go into the worktree as context. The UI shows each repo's isolation state, worktree or in place. Preparation, locks and cleanup are covered in [Tasks](tasks.md).

<a id="write-policy"></a>
## Write policy and violations

- ACP fs callbacks validate paths against the root and apply the policy of the **most specific** repo containing the path. A writable nested repo inside a read-only one is allowed.
- Writes to an unselected repo or a `folder` are refused with a reason. Writes to existing files use compare-and-swap, and new files are created exclusively, so a write never overwrites someone else's change. The host serializes agent writes with the person's Save and with checkpoints.
- Unselected git repos are still snapshotted. A change to one during a turn produces a durable `scope.violation` event with the changed paths. The UI keeps the latest warning for each repo. OS and sound notifications follow the notification preferences, and the in-app warning is always available. A Save by the person is not a violation. The signal records that a change happened. It does not name the process that made it and is not a shell sandbox. A `folder` has no tree, so it cannot be watched, which is one more reason the agent may not write to it.

<a id="agent-context"></a>
## Roots and repo context for the agent

- `additionalDirectories` (ACP `sessionCapabilities.additionalDirectories`) receives every selected, available, non-root repo path, `folder`s included. Without it the agent could not read them. It is sent on `session/new` and `session/load` only when the adapter negotiated it. It extends the cwd and is not a sandbox; the manifest and the host policy hold write access.
- The repo manifest (`packages/host/src/scope-context.ts`) lists each visible repo's name, kind, path, `writable` and the sanitized origin remote. GUI tasks send it with the first prompt, after metadata changes and after a reconnect. CLI tasks send it through the `UserPromptSubmit` hook's `additionalContext`. The person's prompt is never rewritten.
- Agent prompts are in English whatever the UI language.

<a id="project-screen"></a>
## Project screen

The detail area shows the project screen when a project or `All projects` is selected and no task is open. It is the project's home page, not a second sidebar.

<a id="screen-layout"></a>
### Layout

| Part | Contents |
| --- | --- |
| Title strip (`ProjectTitlebar`, 48 px) | The project name (tooltip: the path shortened with `~`) or `All projects`; the live agents button; `Search Everywhere` |
| Toolbar (`ProjectToolbar`, row `data-size="m"`) | Left: the section title with glyph and count, `Tasks N` or `Pull requests N`. Tasks: the knowledge counter (when there are proposals), the `Archive` button, the `Board / List` segment, then `New task` with the shortcut hint (primary button, shown when there are tasks or a status filter is active, never on `All projects`). Pull requests: the repo picker, the `All · Yours · Waiting for you` filter, `Board / List`, then the new PR button. |
| Knowledge strip | Under the toolbar, in the Tasks section of a single project only |
| Body | Board or list, the PR board, an empty state, or skeleton columns while loading |

- The sections rail picks Tasks or Pull requests (see [Sidebar](sidebar.md)). With the Pull requests module off, the screen always shows Tasks.
- In a window up to 1050 px wide, `Board / List` and the PR filter show glyphs with tooltips. The knowledge strip keeps the board's 16 px inset.
- The `Tasks` count is the number of cards shown.
- While `project-views.json` is being read, `Board / List` is disabled and skeleton columns appear after 150 ms. The section can still change. A failed read leaves the current view and shows the toast `Could not read the project view.` with `Retry`. A failed save rolls back and shows `Could not save the project view.`.

<a id="screen-states"></a>
### States and rules

- **One state, the sidebar's.** Cards use the same status icon, status label and running predicate as the sidebar. Only the presentation is duplicated, never the source. Live progress comes from the task model, which journal events update, so the screen polls nothing.
- **No `+N −M` on cards.** It would cost a git call per task. The unread dot comes from comparing `activitySeq` with `task-reads.json` and costs nothing.
- **Empty state.** `No tasks yet` with a primary `New task` button and the shortcut beside it in the button's font. Under a status filter it reads `No matches` with no button. Nothing is shown until the disk has been read.
- The status filter from the sidebar footer (and its "quiet scheduled runs" toggle) applies to the screen the same way it applies to the sidebar.

<a id="person-tasks"></a>
### Only the person's tasks

- The board and the list share one predicate with the sidebar: `personTasks` in `core/sidebar.ts`. A worker whose foreman is in the project (`crewTaskId`) lives inside its foreman. An orphaned worker is an ordinary task. Sub-foremen and their workers carry the root's `crewTaskId` and are hidden the same way.
- Under a status filter, a foreman stays if it or any of its workers matches. A foreman whose worker waits for the person gets the needs-you frame and sorts with needs-you (`crewNeedsYou`, see [Crew](crew.md)).
- The card shows a helmet for a foreman and `person` for an agent. Next to the helmet is the number of live workers (`working`, `needs-you`, `preparing`), with the tooltip `Active workers`. Zero is not shown.
- The `In progress` limit `N / M` counts every agent, workers included (`working` + `needs-you` across the scope against `agents.maxConcurrent`), and ignores the status filter. Its tooltip is `Concurrent agents`.
- Whatever the board shows, the `⌘J` / `⌘⇧J` queue, the sidebar footer chips, the collapsed-project badge, the Agents tab in Search Everywhere and the live agents popup still include workers.

<a id="board"></a>
## Task board

The board and the list are two views of one grouping, `boardSections` in `packages/core/src/board.ts`. The choice persists per project.

<a id="board-columns"></a>
### Columns

| Column | Statuses | Empty hint | Header action |
| --- | --- | --- | --- |
| `Backlog` | `backlog` | `Deferred tasks` | `+`: `New task in backlog` (opens the launch sheet with "to backlog" preset) |
| `In progress` | everything else | `Drop to start` | `+`: `New task`; plus the `N / M` limit |
| `Completed` | `completed` | `Accepted tasks` | `Archive the list` (only when the column has cards) |

- The order follows the flow of work, not attention, and `⌘J` does not change with it. Inside `In progress`, cards sort by attention: `needs-you`, then `working`/`preparing`, `queued`, `rate-limited`/`failed`, `interrupted`, `done`. Ties go to the freshest `updatedAt`, then the title. `Backlog` and `Completed` sort by freshness.
- Attention lives on the card: `needs-you` gets an amber frame and fill (opaque `color-mix(--amber 9%, --card)`) plus its status line, and unreviewed changes get the trailing unread dot.
- An empty column or list section stays, drawn as a dashed placeholder with its hint, because it is a drop target. The drop outline takes no layout space.
- The list has the same three sections and the same drag and drop.
- The board scrolls horizontally, and columns never collapse.
- The word "column" never appears in visible text. A column header is the section name with `· N`.
- `+` and `Archive` are quiet at rest and get a fill on hover. `All projects` has no `+` and no `New task`, because a task is created in a project.

<a id="board-moves"></a>
### Drops

`boardMove(from, to)` defines every allowed drop. Main (`main/boards.ts`, `Boards.move`) validates the task key and the move. The renderer never gets write paths.

| From → to | Action |
| --- | --- |
| `Backlog` → `In progress` | Start: through the main `LaunchQueue`, the same path the launch sheet uses |
| `Completed` → `In progress` | Nothing runs and no prompt is sent; status becomes `done` |
| `In progress` → `Completed` | Stop, then `completed` |
| `In progress` → `Backlog` | Stop, release the host (`stopForRemoval`), then `backlog` |

- Any other drop is refused visibly: the column does not highlight and the card returns to its place. `Backlog → Completed` would finish a task no agent has seen, and `Completed → Backlog` would put a task with a journal into a state that means "no agent now".
- **Stop** cancels preparation, dequeues a queued task, pauses the prompt queue (`pausePromptQueue`), cancels the running turn and waits up to 15 s. The paused queue persists, and resuming it is the person's action. Without the pause, the queue would start its next prompt in a task that was just finished.
- A task moved back to `Backlog` keeps its journal and baseline. Starting it again resumes. Its card reads `Backlog` instead of `Not started` (`hasStarted`).
- Only the person sets `completed`: by a drop or a menu item. Late agent events never overwrite it. A `failed` task moved to `Completed` loses its error line, but the reason stays in the journal.
- **A drop never navigates.** The screen stays where it is whatever the action does to the agent. A click right after a drag is swallowed (300 ms latch). Every drop has an equivalent in the task context menu, so dragging adds no capability.
- First prompts are serialized in the main `LaunchQueue`. A duplicate request for the same task joins the one in flight. Cancelling a lock-conflict dialog keeps the task in the backlog. Starting a worktree that is already prepared again does not repeat setup or the first prompt.

<a id="board-card"></a>
### Card

`BoardCard` (`renderer/ProjectBoard.tsx`) is both the board card and the list row (rule: one look, one component).

1. **State line**: the type glyph (helmet or `person`) with the live worker count, the status icon and label, the unread dot, and hover actions. Labels: `Not started`, `Backlog` (a backlog task that has started before), `Queued`, `Preparing…`, `Working`, `Needs you`, `Turn completed`, `Stopped`, `Error`, `Rate limited`, `Completed`. The label stays on one line.
2. **Title**: one line, ending in an ellipsis. In the list, the type glyph sits before the title.
3. **Description**: the start of the prompt, at most two lines. It is hidden when it equals the title. Empty lines are not reserved.
4. **Model and effort chips**: `Chip` S with the provider mark (Claude in `--providerClaude`, OpenAI for Codex) and the provider's names (`modelName`, `effortName`).
5. **Meta line**: one repo shows its name, several show a count (`3 repos`); the root shows the project name. Then the worktree branch (`ui/BranchName`, middle-truncated, never shrinking before the repos do), the attachment clip with a count for backlog tasks, the PR badges, and the relative age. On `All projects` the project icon and name replace the repos.
6. Relay links (`RelayLinks`) can follow under the card.

Hover lights the frame across the whole card and shows a grab cursor. Hover actions keep their space at all times (opacity changes, not layout) so the row does not jump:

| Action | Shown on |
| --- | --- |
| `Edit task` | `backlog` tasks that have not started. Opens the same launch sheet, filled in and titled `Edit task`. Saving rewrites the existing `task.json`; a prompt already sent can never be edited. Clicking such a card does the same. |
| `Archive` | `completed` tasks that can be archived (`canArchive`) |

Deleting a completed task is done from the context menu or the Archive window, not the board. The main channels `board:delete` and `board:clear` still exist, and the latter opens a dialog that names the count, crew workers (`Crew workers are deleted too: {n}.`) and uncommitted worktree files. The UI does not call them. `Archive the list` opens `Archive the list… N tasks` (`Archive hides the tasks and deletes nothing.`) and archives every task in the column that can be archived, workers only together with their foreman. See [Tasks](tasks.md).

<a id="card-options"></a>
### Model and effort from the card

- Each chip opens the same native menu as the composer and launch-sheet chips (`Boards.optionMenu`, header `Model` / `Effort`).
- A chip is disabled while the task is `working` or `needs-you`, for terminal tasks, and when there is no select option. The disabled chip keeps its frame and has the tooltip `Agent options are available after the first launch.`.
- Catalog: the task's own `agentOptions`. A backlog task with no catalog borrows the most recent catalog already announced by a GUI task of the same provider. The app never starts an agent just to fill a chip.
- For a backlog task or a disconnected agent, the choice goes into `task.json` (`agentOptions`, `launchOptions`, `modelName` / `effortName`). On a live session it is sent as `setOption`. At launch the saved choice is applied through the provider before the first prompt, and a stale value the catalog rejects is not masked with an invented substitute. A CLI task gets model and effort from launch flags instead.

<a id="board-data"></a>
### Data the board reads

- The board reads only task metadata, never a journal or git per card. `task.json` carries the provider names of model and effort, the last announced catalog, chosen deferred options, `hasStarted`, `activitySeq`, `scopeNames` and `worktreeBranch`. `updatedAt` comes from the metadata file's mtime, with no migration write. Viewing a task does not rewrite the host-owned `task.json`.
- `project-views.json` (`ProjectViews` in `main/views.ts`, `schemaVersion: 1`) has two maps keyed by project id, with `*` for `All projects`:
  - `views`: `board` | `list`. Default: `settings.projects.defaultView`, set in Settings ▸ Appearance ▸ Tasks.
  - `modes`: `{ tab, filter, repo? }`. `filter` is `all` | `mine` | `waiting`; `repo` is `<projectId>/<scopeId>`.
- Corrupt or newer documents are never overwritten. Writes are serialized, and quit waits for them to finish.

<a id="all-projects"></a>
## All projects

- The sidebar row `All projects` (board glyph) sits above the project list. It also holds the archive button and `Add a project…`, as separate buttons that share the row's selected background. It opens the **same** screen with the tasks of every open project: the same columns, the same `Board / List` and the same drops. This answers "who is waiting for me" across all projects.
- Sorting runs across all projects. The project is a property of the card (its icon and name), not a grouping axis.
- Only one thing is selected in the sidebar at a time. While `All projects` is shown, no project is current: no project row is highlighted, the repo panel is hidden, and `New task` (button, `⌘N`, menu item) is unavailable. The screen is left when a task or a project is selected.
- `Archive the list` stays and acts on every project's completed tasks.

<a id="project-colors"></a>
### Project colour slots

- A slot is a pure function of the project id, never stored: FNV-1a over the id gives the preferred index among 9 slots (`projectColors`). The layout is computed over all open projects sorted by id, and a collision probes forward. Up to nine projects always get distinct slots. Adding a project can shift the slots of projects whose preferred index it takes.
- One layout serves the whole app, so the sidebar and the boards agree.
- The slot gives the default colour of a project icon (`projectIconColorAt`) and the board tokens `--project-0…8`. The palette avoids red, amber and the accent blue, which already mean failure, "needs you" and selection. Any two slots differ in saturation as well as hue.

<a id="pr-mode"></a>
## PR mode

The Pull requests section of the project screen (and of `All projects`) shows the project's PRs as a board or list. It uses the same data and cache as the task's PR panel and makes no extra GitHub requests. With the `Pull requests` module off, the section does not exist. GitHub access, the review modal and PR actions are in [Pull requests and CI](pull-requests-and-ci.md).

<a id="pr-columns"></a>
### Columns and filter

`prColumns` in `packages/core/src/pr-board.ts`:

| Column | Contents | Empty hint |
| --- | --- | --- |
| `Draft` | Drafts, even ones with reviews | `No drafts` |
| `Open` | Open, not draft, no review yet | `No open PRs` |
| `In review` | Open, not draft, and either a non-author review on GitHub (`APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`; a requested reviewer does not count) or a review started here: drafts, a general note or decision, or viewed files in the PR's review file. The header glyph's tooltip is `Reviewed on GitHub, or a review started here`. | `Nobody is reviewing yet` |
| `Closed` | Merged or closed in the last 7 days | `Nothing closed in 7 days` |

- In the open columns, PRs waiting for you come first, then fresher `updatedAt`. `Closed` sorts by close time.
- The filter is `All · Yours · Waiting for you` (`ui/Segments`, row M). `Yours` means you are the author. `Waiting for you` means you were asked to review, and it shows its count. The filter persists with the mode.
- The section count covers only `Open` + `In review` for the chosen repo. The filter does not change it.
- No new flag marks "review started". The review modal writes `viewed: {n, of}` to the PR's review file so the card can show progress.

<a id="pr-repo-picker"></a>
### Repo picker

- When more than one repo is on GitHub, `ui/RepoPicker`, the same picker as in the PR panel, sits before the filter. It shows `All repos ▾` or the chosen repo with a soft accent fill. Its menu lists `All repos` with its open-PR count, a separator, then each repo with its count; a repo without PRs shows a muted `No PRs`. The choice persists in `modes[...].repo`, and a repo that no longer exists falls back to `All repos`.
- On `All projects` the picker covers every project's repos, labelled `project · repo`, and the root shows as just the project name.
- A card names its repo only while the board holds more than one repo of its project and no repo is chosen. On `All projects` the project icon stays, the repo name replaces the project name, and the full name is in the icon's tooltip.

<a id="pr-card"></a>
### PR card and actions

- A PR card is the same `ui` card as a task card: frame, whole-card hover. It shows state and `#N`, repo, a "waiting for you" mark, comments and checks. The title runs to two lines. Reviewers appear as avatars with their state (a requested reviewer is outlined). `Your review · N drafts · V/T viewed` appears as an accent button when a review started here. Then author, branch (`ui/BranchName`) and age. A `Task` button appears when the PR belongs to a task's branch. A closed PR has a quieter title and no checks or reviewers. The list shows the same sections as rows.
- **Click**: the review modal opens over the project screen, without entering a task, and `Esc` returns to the board. The modal is keyed by the project's main tree and the PR, because review drafts belong to the PR. Actions that need an agent go where they already live: `Review with an agent` creates a review task, and "to the agent" on your own PR goes to the PR branch's task or a new quick task. The `Task` button opens the task. Right-click opens the PR row menu.
- **Drag**: only `Draft → Open`, which runs "Ready for review" (`markPullRequestReadyForReview`) and then reloads. Every other drop is refused visibly, so PRs cannot be closed or merged by dragging.
- **New PR**: in this section the toolbar's primary action is the new PR button, also on `All projects`.
- **States**: skeleton columns while loading. Without gh or without sign-in, a GitHub glyph with `Install GitHub CLI (gh) to create pull requests.` / `Sign in with gh auth login to use GitHub.` / `GitHub status could not be read.` and `Retry`. With no PRs, `No pull requests` with `Nothing open, nothing closed in the last 7 days.`. Errors show a toast with `Retry`.

<a id="pr-badge"></a>
### PR badge on task cards

A task card shows a badge for its branch's PR in the meta line, before the age: state mark, `#N`, a review glyph if a review has started, and checks. Only open PRs and drafts get a badge. A task with several repos shows up to two badges, then `+N`. Clicking a badge opens the review modal over the screen (reading GitHub first if needed). If GitHub does not list that PR, the task opens with its own PR panel. Clicking the rest of the card behaves as usual.

<a id="project-knowledge"></a>
## Project knowledge

Brigadir notices when agents in **different tasks** ask the person the same question, and proposes adding the answer to the project's agent instructions. Nothing is ever written without the person.

<a id="knowledge-mining"></a>
### Mining

- **Signal**: only structured `question.requested` / `question.resolved` pairs from task journals. A question is a protocol fact and the answer sits right beside it. Text heuristics are not used.
- **Clustering** (`packages/core/src/knowledge.ts`): tokens with stop words removed and light stemming. Two questions match with at least 2 shared tokens and Jaccard ≥ 0.34. A cluster with sources from two different `taskId`s becomes a proposal. Two turns of one task are not enough.
- **Rate**: at most one new proposal per project per day. Restoring a rejected proposal bypasses this limit; it restores the right to be shown, and the next run rebuilds the card.
- **Reading budget**: a byte cursor plus turn counter per task (`JournalCursor`), at most 256 KiB per task and 1 MiB per run, with journal rotation handled. Only lines that contain a `"question` marker are parsed. Runs happen when a project opens and after turns. State lives in `~/.brigadir/projects/<id>/knowledge.json` (32 MiB cap), which holds proposals, rejected signatures, restorations, receipts and cursors.
- Further detectors plug in as new suppliers of `KnowledgeExchange` pairs.

<a id="knowledge-card"></a>
### Proposal card

- The strip sits under the screen's toolbar in both views, for a single project's Tasks section, and not on `All projects`. With proposals present, the toolbar shows a knowledge button with their count. Clicking it expands the first card. Its context menu, and the project context menu's `Project knowledge…`, open `Rejected proposals` (a sheet with `Restore`, S buttons).
- **Collapsed**: `Repeated question · N tasks`, the question, the line `Add the answer to the project instructions so future tasks can use it.`, then `Show text`, `Reject` and `Add`. `Add` on a collapsed card expands it and never writes blind.
- **Expanded**:
  - `Destination`: a repo popup (root by default) and an editable `Instruction file` (default `CLAUDE.md`), `At the end of the file` (`· New file` when it does not exist).
  - `Current file` reveals the file's current text.
  - An editable `Addition` textarea, mono 12.
  - The note `An agent writes this text using your subscription. You can edit it before adding.` with `Generate again`.
  - `Sources`, buttons that open each source task at its turn.
  - A footer with the path, `Refresh preview`, `Reject` and `Add`.
- **Text generation**: a one-shot call to the helper agent, made only when the card is expanded or on `Generate again`, never during mining. The prompt is in English and treats the exchanges as untrusted data.
- **Write**: the addition is appended to the working tree and left uncommitted; the person commits it. The preview is bound to the whole file. `Add` and `Undo` compare the full file content again before changing it. If the file changed after the write, Undo is not offered, so nobody else's work is cut. Prepared receipts let an interrupted write recover.
- **After Add**: a receipt row shows a green check, `Added to CLAUDE.md`, the added lines inline (`DiffCode bare`), `Undo` and `Show the file`. The receipt is a row because it holds an action; a toast could not. The file dialog names the file, with the full path as the name's tooltip.
- **Reject** is permanent for that question signature until it is restored.

<a id="project-icon"></a>
## Project icon

The project icon (`Project.icon`, `packages/core/src/project-icon.ts`) appears in the sidebar, on boards and in the archive. Each icon has one of nine colours (`red`, `orange`, `yellow`, `green`, `teal`, `blue`, `purple`, `pink`, `gray`).

| Kind | Source |
| --- | --- |
| `lucide` | A Lucide name. `by: agent` (picked automatically) or `person` |
| `monogram` | Letters of the name |
| `repo` | An app icon found in the repo (Expo, React Native, web, Electron or Tauri locations, monorepo apps one level down), as a ≤ 96 px PNG |
| `image` | `~/.brigadir/projects/<id>/icon.png` (square PNG, at most 512 px). `image` in `project.json` holds a 72 px PNG data URL, so snapshots and remote windows never read the file. `by: agent` means Codex drew it. |

- **Automatic pick**: for a project without an icon, the hint model gets the name, the `package.json` `description` and the first README line as material, not as instructions, and returns a Lucide name, colour, reason and suggestions (`iconPick`, 30 s timeout). If it fails it falls back to a monogram in the project's slot colour. Asked projects are tracked in `project-icon-asks.json`. A background pick never replaces an existing icon.
- **Picker** (`Project icon`, from the icon or `Project icon…`): tabs `Icon` / `Monogram` / `Image`, a `Colour` choice (not on `Image`) and `Reset to monogram`. Every choice saves at once.
  - `Icon`: the agent's pick with its reason and `Pick again`, `Search icons` over names and tags, `Suggested`, `All icons`.
  - `Image`: `Your image` (or `Drawn by Codex`) as a 36 px tile with `Or drag or paste it` and `Choose file…`. Drag onto the tab or `⌘V` also works. An existing `icon.png` stays offered after switching to another icon, and clicking the tile brings it back. Then `Generate with Codex` with an optional `What should it show?` field (`Enter` also generates) and `Generate`, which shows a spinner and `Generating…`; the result becomes the icon at once. Last comes `Found in the repo`. A read failure shows `Could not use this image.`.
- **Image pipeline**: the renderer decodes the image with `<img>` (PNG, JPEG, GIF, WebP, SVG, AVIF, BMP, ICO), crops it to a centered square of at most 512 px and encodes PNG. Main receives only PNG bytes (`setProjectImageIcon`, ≤ 8 MB), re-encodes them through `nativeImage` and writes `icon.png` plus the 72 px thumbnail. Bytes rather than a path, so a remote window works the same way. Copying makes the icon independent of the original file.
- **Generation**: `codex exec --json --ephemeral --skip-git-repo-check -s read-only --enable image_generation` runs in the helper directory with stdin closed and a 3-minute limit. The English prompt asks for a square app icon with one simple centred symbol, a solid background and no text, built from the name, `description`, README line and the person's hint. Main takes `thread_id` from `thread.started`, and after `turn.completed` it reads the newest PNG in `$CODEX_HOME/generated_images/<thread_id>/`, stores it and removes that directory. If Codex is turned off, missing from PATH or out of its weekly window, the toast is `Codex is not available.`. Other failures show `Could not generate an icon.`.
- `Reset to monogram` keeps `icon.png`. A new image or generation overwrites it. `Remove project…` sends it to the Trash with the project. A paired phone client cannot change icons.

<a id="later"></a>
## Later

- A second knowledge detector based on repeated identical tool calls (`Grep`/`Read` on the same config files), added as another `KnowledgeExchange` supplier.
- History of generated icon variants.

<a id="non-goals"></a>
## Non-goals

- Bulk actions on the project screen (stop all, merge all).
- A separate filter or search on the project screen; the sidebar footer filter applies.
- Custom board lanes or a `lane` field; columns come only from status.
- A "show workers" toggle on the board.
- `+N −M` on board cards.
- A "mark as reviewed" drop; the unread marker clears when the diff is opened.
- Closing or merging PRs by dragging.
- Writing agent instructions automatically, committing them, analysing knowledge in real time during a turn, or keeping a separate knowledge file next to `CLAUDE.md`.
- Agent writes into a folder without git, or creating a git repo in an added folder.
- Storing added folders relative to the project, or removing missing folders automatically.
- A per-repo "show diff" flag that changes write access.
