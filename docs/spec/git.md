# Git

Brigadir lets you do the everyday git work of a task without leaving the app: commit what the agent changed (one commit or several), revert a file, push, read and search a branch's history, merge a branch and resolve conflicts in a three-column view, and switch or pull branches of the main tree. All git state is read from git itself; the app keeps no registry of branches or commits of its own. Worktree preparation adds two git conveniences: copying ignored `.env*` files and letting the agent name the branch.

<a id="principles"></a>
## Principles

| Rule | Detail |
| --- | --- |
| Two questions, two bases | The Changes list answers "what did the agent do in this task" (snapshot baseline, see [Diff engine](diff-and-review.md)). The commit flow answers "what goes into git" and reads `git status --untracked-files=all` per repo. Neither borrows the other's base. |
| Files, not folders | Commit lists use `--untracked-files=all`, so a new folder appears as its files, and counts are true. |
| Commit is a task action, push and PR are repo actions | One commit message flow covers all repos of a task; push and PR write to one remote of one repo. |
| Submodule before parent | Commits and pushes run deepest repo first; a parent's gitlink is updated only after its child commit succeeded. |
| Irreversible actions confirm and name the target | Revert, push, abort, discard, undo commit: the dialog names the file, repo or SHAs and states the effect. |
| Failures are visible | A failed revert, push, commit or hook never fails silently; the error stays where the action was started. |
| One git write per process at a time | Writes are serialized (`pending`, `isGitBusy`); none run while a file is being saved, a project is being deleted, or the task's agent turn is active. |
| Checkpoint after writes | Every action that writes to a task tree takes a checkpoint, so the task diff sees the result at once. |
| Hooks | Only an explicit human commit from the commit dialog runs the repo's hooks; every other git call the app makes runs with hooks off. |

<a id="commit-strip"></a>
## Commit strip

The bottom row of the `Diff` tab of the Changes panel (`CommitStrip`, row size `s`, 32 px). It is one row that combines the snapshot picker and the commit entry; it is not shown in `History` or `Turns`.

| Part | Behavior |
| --- | --- |
| Left | Snapshot picker `Current snapshot · N ▾` (`Saved snapshots · N` when the agent is not connected). Opens the same `Compare snapshots` popover as the filter in the Changes header (`ui/DiffOptions`, prop `snapshot`); the snapshot name truncates with "…" in a narrow panel. |
| Right | `+N −M` — sum over all files in the commit preview of all repos (one row per task in a monorepo) — and the soft primary button `Commit` (key `Commit changes`) with tooltip `Commit… · ⌥⌘K`. It opens the [commit dialog](#commit-dialog). Counts and button never shrink. |

States:

| State | Row shows |
| --- | --- |
| Nothing to commit, no result | Only the picker; the row keeps its height. |
| Task preparing, or a merge/rebase stopped in a task repo | Only the picker. Entry to conflicts is the [conflicts banner](#conflicts-entry); the preview is not read during a merge (no `Could not load the changes to commit.` toast). The strip returns after `Continue`/`Abort` (event `mergeEnded`) or the next checkpoint. |
| Agent turn running | Button enabled; the dialog itself refuses to commit during a turn. |
| Dialog commits running (dialog may be hidden with Esc) | Spinner in place of the label, same width, `aria-disabled`, accessible name `Committing…`; counts stay until the run ends, then the strip re-reads. |
| Just committed, nothing left | `✓ <sha>` (or `✓ N commits`, summed over repos; all SHAs in the tooltip) in place of counts and button, plus soft `Push` / `Push all` with tooltip `Push commits · <SHAs>` while a committed repo has unpushed commits. |
| Committed part, changes left | A SHA line above the row: `Committed a41c9e2 9b1e07d`, in a monorepo `Committed business a41c9e2 · mobile 5d…` (truncated with "…"), then `·` and `Push` / `Push all`. A git error shows in red below it. |

- The strip re-reads its preview on `turn.completed`, `checkpoint.created`, `file.saved`, `scopes.changed` (debounced 2 s), on window focus and when a dialog run ends. A read failure shows the warning toast `Could not load the changes to commit.` with `Retry`.
- `Push` is offered while the repo's forge snapshot reports `pushAhead > 0`; without a forge snapshot it is always offered.
- There is no collapse state. The legacy `commitCollapsed` key in `surface-layout.json` is read and discarded.
- `⌘↩` is not bound in the Changes panel; the commit action owns `⌥⌘K` with its menu item, and the global `⌘↩` keeps queuing the composer message.

<a id="commit-dialog"></a>
## Commit dialog

A modal (`CommitDialog`, width 640, shared `ui/ModalDialog` with Esc) that splits the task's uncommitted changes into one or more commits ("baskets").

<a id="commit-dialog-entry"></a>
### Entry points

- The strip's `Commit` button.
- Menu bar `Diff ▸ Commit…` — `⌥⌘K` / `Ctrl+Alt+K` (menu command id `commit`).
- The repo `…` menu: `Commit…` with a file count, before `Push commits…`; opens with that repo's baskets on top.
- Open state is `commitDialog` in the task state; baskets live in `commitBaskets` and survive closing the dialog. Esc hides the dialog without stopping a running sequence; the result appears in the strip and a toast.

<a id="commit-baskets"></a>
### Basket model

Pure model in `@brigadir/core` `commit-baskets.ts`.

- A basket is `{ id, scopeId, message, files, reason? }`; a file is a path in its repo and belongs to exactly one basket of its repo.
- First open: one basket per repo with all its files; the first basket's message starts from the task title.
- Numbers `C1…Cn` run across repos in commit order: repos in preview order (deepest first, submodule before parent), baskets of a repo in their own order.
- Moving a file to another repo's basket is refused (drop target marked `no`, hint `Only commits of {repo}`).
- After a preview refresh, new files land in the first basket of their repo; vanished files disappear.
- `×` on a file chip removes it from all baskets (`Leave out of the commit`; stored as `aside` in task state). It is not committed and does not come back on the next preview read until moved into a basket. The footer then says `1 commit · {files} not in a commit`.
- An empty basket is skipped with a note (`{commit} is empty and will be skipped`); `Commit {n}` counts only non-empty baskets.
- Interaction: drag chips and list rows between baskets; dropping on `New commit` creates a basket; clicking a file opens a popover with its diff (`commits:file`) whose header has a basket picker.
- Keys inside the dialog: `⌘↩` — `Commit {n}`; `⌘M` — `Move to` for the selection; `⌘Z` — undo the agent's proposal.

<a id="commit-sequence"></a>
### Commit sequence

Implemented in `@brigadir/git` `commitBaskets`; IPC `commits:baskets`, progress broadcast `commits:progress` (`basketId`, `running` / `done` / `failed` / `skipped`).

1. One `revision` check at the start against a fresh preview. A stale preview is refused (`Files changed. Review the changes to commit.`) and the dialog re-reads the preview at once.
2. For each basket in order: the repo `HEAD` must equal what is expected (the starting `HEAD` or the SHA just made by the previous basket).
3. The basket tree is `HEAD` plus the entries of its files taken from the **reviewed preview tree** (`ls-tree` → `update-index --index-info` in a temporary index; deletions and the old path of a rename use mode `0`; the gitlink of a submodule committed in this run gets its new SHA).
4. The real index is set to exactly that tree (`read-tree`), then `git commit`. What is committed is what the person saw, even if a hook or the agent changed the working tree between baskets. Files left for later baskets are not staged afterwards; working-tree content is never touched.
5. Hooks (`pre-commit`, `commit-msg`) run, timeout 10 min. A failing hook stops the sequence on that basket: its output shows in the basket (`Hook failed`), the rest show `Waiting`; the button becomes `Retry {commit}` / `Retry {first} and {last}` / `Retry {first}–{last}`, and `Ask the agent` puts the hook output into the composer.
6. Any error stops the rest of the plan. After the sequence the result (every SHA) is written to the task's `commits.json` and a task checkpoint is taken.

Result: toast `Committed {commits} to {repo}.` / `Committed {commits} in {repos}.` with `Push` / `Push all`. `Commit and push` opens the push dialog right after committing.

Not available: committing during an agent turn (`Wait for the agent to finish before committing`); hunks of one file in different baskets.

<a id="commit-messages"></a>
### Messages and splitting with the agent

- Each basket has an editable message. `✦` in a basket and `Generate messages` (fills only empty ones) run the one-shot message generator over the tree `HEAD` + that basket's files. Generation runs only on click; a failure (`Could not generate the commit message.`) leaves any typed text usable.
- `Split with the agent` (click only): a one-shot call of the helper model (same path as [branch naming](#agent-branch-names); English prompt), longer timeout than a name because it reads the whole diff. The answer is JSON `{commits:[{repo,message,reason,files}]}`.
  - While running: banner `{agent} is splitting the changes into commits…` with `Stop` (cancels the call); baskets stay editable.
  - Validation: unknown or already named files are ignored; files of a repo the agent did not name go into its last basket for that repo.
  - The proposal replaces the baskets; the banner's `Undo` (and `⌘Z`) restores the previous ones. Failure: `Could not split the changes.` with `Split again`.
- The phone web client has no commit dialog (its channels are denied).

<a id="file-actions"></a>
## File actions in the Changes list

A file in the Changes list (context menu) and in the open diff header carries:

| Action | Behavior |
| --- | --- |
| `Open in editor` | Opens the file in the editor tab; also a button in the diff file header. |
| `Why did this change?` | Attribution, see [Diff and review](diff-and-review.md). |
| `Revert file changes…` | IPC `changes:revert`. Native warning dialog whose message names the file; buttons `Cancel` / `Revert` (destructive). |

Revert rules:

- The base is the base of the displayed diff, not `HEAD`: "put back what was there at the start of the step" (`Restore the file to the base of the displayed diff.`). `git checkout HEAD -- <path>` would also destroy unrelated uncommitted edits.
- When the diff base is `head` (see [diff base](diff-and-review.md)), the file returns to the last commit (`Restore the file to the last commit. Changes made before the task are lost too.`).
- A file added in the step is reverted by deleting it.
- A failed revert is reported visibly.
- Read-only views (a commit's file in History, PR files) have no revert.

<a id="push"></a>
## Push

- **Where.** In the repo row (scope group header), next to the PR badge: `↑N`, the number of commits ahead of origin. Zero shows nothing. Also shown in main-tree rows; clicking `↑N` from a row whose main tree is not open first opens the main tree of that repo, then the dialog. Also `Push commits…` in the repo `…` menu, and `Push` / `Push all` after a commit.
- **One sign, one number.** A branch that does not exist on origin yet shows the same `↑N`, counted from `origin/<base>`; the dialog text says whether the push creates (`First push`) or updates (`Update branch`) the branch.
- **Dialog `Push commits`.** Lists short SHAs and subjects under `Commits to push`, states the consequence (`This push updates PR #N` — checks run again) and shows the order for submodules (submodule before parent, the same order as PR creation). It is a decision, not an "are you sure".
- **Errors stay in the dialog**; it does not close until the push succeeds.
- **Several repos.** `Push all` opens the push dialog of each repo in turn (commit order). IPC `forge:prepare-push`, `forge:push`.
- Push is never one click away from commit as a split button: commit is local and undoable, push is not.

<a id="history"></a>
## History

The Changes panel header is one row: `Diff / History` tabs (`tablist`, not radios, because the toolbar already has a `Diff` radio), `Filter files` taking the remaining width, refresh and diff options. At the minimum panel width (200) the field shrinks; the row never wraps. The `Unified / Side by side` switch lives in the open diff's header, not here.

`History` shows the history of one branch of one repo:

- Selectors `Repo` and `Branch`. Only git scopes (`root`, `sub`, `external`) are listed; a non-git `folder` scope is absent. Any git scope of the project can be read, selected in the task or not (reading is not writing). A scope with `available: false` stays listed but disabled, labelled by its source of truth: an external folder says the folder is unavailable, a repo under the root says `A selected repo is unavailable`.
- Commits with their files; up to 100 per page (`100+` when more), `Show 100 more` up to 1000.
- File filter: a chip under the selectors narrows the list to commits touching one file (`Remove the file filter`); a file git does not track shows `No commits with this file yet: Git does not track it.`
- Clicking a file opens an ordinary diff tab labelled with the commit (`total.ts @6ee8632`). That tab is read-only: no comments, no revert, no `Open in editor`; the right side is labelled by the commit.
- Branch comparison does not live in History.
- IPC: `git:scopes`, `git:branches`, `git:history` (`scopeId, branch, path?, limit?, query?`), `git:commit`, `git:commit-file`.

<a id="history-search"></a>
### Search

The header search (`⌘F`, magnifier) in `History` searches git across the whole history of the selected repo and branch (and file, when filtered), not only the loaded page.

| Match | Git |
| --- | --- |
| Subject and body | `log --grep=<query>` |
| Author name and email | `log --author=<query>` |
| SHA prefix (4+ hex characters) | `rev-parse` + `merge-base --is-ancestor` (reachable from the branch; with a file filter, only if the commit touched the file) |

- The query is literal and case-insensitive (`--regexp-ignore-case --fixed-strings`); `[`, `.*`, `(` are not regex. It is passed as one argv element, no shell. Main accepts a trimmed single-line string of at most 200 characters without control characters.
- `--grep` and `--author` run as two passes (combined, git would require both), each reading `limit + 1`; results merge by commit time without duplicates, so the page knows whether there is more.
- Same rows; the counter shows the number found (`+` when more), `Show 100 more` up to 1000; `Nothing found` when empty. An empty query shows the normal list.
- The query is sent after 200 ms of quiet; meanwhile the visible rows narrow locally by the same text and the counter says `Searching…`. Answers to stale queries are dropped. Search pages are cached by the branch tip SHA like normal pages.

<a id="merge"></a>
## Merge a branch

`Merge…` sits to the right of the `Diff / History` tabs and opens the dialog `Merge a branch` (Esc in the header).

- `Into` is the current branch of the repo, marked `current`, and cannot be changed (another target would need a checkout of the task's tree).
- `What to merge` opens immediately with focus in `Search branches`; the list is split into `Recent` and `Remote branches`, each row says when the branch was updated. After a choice a summary appears: commits, files and expected conflicts (predicted with `git merge-tree --write-tree`, the tree is not touched). `Merge` is disabled until a source is chosen; `Already up to date` when nothing would come.
- `Merge…` is enabled only for a repo that is in the task (`inTask`), because only those hold a lock and pass the write policy; otherwise the reason `Add the repo to the task before merging.`
- Refusals: tracked uncommitted changes (`Commit or stash the changes before merging.`), agent working (`Wait for the agent to finish before merging.`), another merge in progress (`A merge is already in progress.`), target other than the current branch (`Merge into the current branch only.`).
- A worktree task merges into its own copy of the repo. An external repo stays in place, so merging into it from a worktree task asks first: `Merge into a repo outside the worktree?`, naming the repo and its full `~` path, with `The task runs in a worktree, but this repo stays in place: the merge writes to your working tree.` and footer actions `Merge here` / `Cancel` (Esc in addition, not instead).
- The merge is `git merge --no-ff` with message `Merge <from> into <into>`. If it stops with conflicts, the dialog closes and the [Conflicts dialog](#conflicts) opens. Nothing is ever resolved silently.
- IPC: `git:merge-preview`, `git:merge`, `git:merge-state`, `git:merge-states`.

<a id="conflicts"></a>
## Conflicts

<a id="merge-state"></a>
### State and record

- The state comes from git: `conflictKind` (`@brigadir/git`) — `rebase-merge` / `rebase-apply` → rebase; `MERGE_HEAD` or a crew squash merge → merge. A crew acceptance that stops leaves a `merge --squash` conflict (no `MERGE_HEAD`, message in `SQUASH_MSG`); it counts as a merge in progress, is finished with `commit --no-edit` and aborted with `git reset --merge`.
- `MergeState`: `kind`, `step` (`commit N of M` from `msgnum`/`end`), `head` (short SHA that abort returns to; for rebase `orig-head`), `agentRunning`, and per `ConflictFile` a `resolution` (`yours` / `theirs` / `merged` / `kept` / `deleted`) and `agent` (`running` / `review` / `failed`).
- The task's `git-merge.json` (`MergeRecord`) keeps what git forgets: what conflicted at the start, `resolutions`, `pending` (files of the last agent request) and `step` (the next rebase commit starts a new record). A merge started in a terminal gets a record on first read; its source is the branch pointing at `MERGE_HEAD` (`mergeSource`).
- Sides are named from the person's point of view. In a rebase git's "ours" is the base, so main swaps sides (`swapSide`) in texts, in `checkout --ours/--theirs` and in `deleted in {branch}`.

<a id="conflicts-entry"></a>
### Entry points

- **Banner** over Diff and History (`ConflictsBanner`, shared `ui/Banner`): `Merge stopped · N conflicts` / `Rebase stopped · …` → `Resolve…`; all resolved → `Conflicts resolved` → `Continue…` (`Continue commits the merge`). It reads `readMergeStates` on every checkpoint and task file change, so it also catches merges started in a terminal.
- **Repo `…` menu:** section `Merge in progress` / `Rebase in progress` with `Resolve conflicts…` (counter) and `Abort merge…`. In the main tree's Git group, branch-changing actions are disabled with `Finish or abort the merge first.`
- **After `Merge`** that did not resolve itself.
- **PR overview:** `Resolve conflicts… ▾` — main action `Resolve in the dialog`, menu `Ask the agent to resolve`; the task on the PR branch opens with the dialog (see [Pull requests](pull-requests-and-ci.md)).
- The commit strip is hidden while a merge or rebase is stopped; the merge commit is made by `Continue`.

<a id="conflicts-dialog"></a>
### Conflicts dialog

`ConflictsDialog` (`ui/ModalDialog` 640, Esc; open state `conflictsDialog` in task state). Rows are `ui/FileListBox` (shared with the commit dialog), hover covers the whole row.

| Row kind | Actions |
| --- | --- |
| Text conflict | `Accept yours` / `Accept theirs`, `Merge…` (texts up to 2 MB), `✦` (`Resolve with the agent`) |
| Binary | `Merge…` disabled with `The file is not text: accept one side.` |
| Modified / deleted | `Keep the file` / `Delete the file` |
| Agent result | `Resolved by the agent · review` + `Accept` (counts as resolved only after `Accept`; sets `resolution: merged`) |
| Resolved (hover or focus) | `Back to the conflict` |

- Checkboxes → `{n} selected` with `Accept yours` / `Accept theirs` for the selection.
- Footer: `Abort merge…` / `Abort rebase…` (confirm dialog with the SHA it returns to, the number of resolved files and agent results that will be lost); status `{n} of {m} resolved · {n} to review` / `Waiting for the agent` / ✓ `All {n} resolved`; `Continue`.
- `Continue`: merge — `git commit --no-edit` (only when no unresolved files remain in the index); rebase — `git rebase --continue` with `GIT_EDITOR=true`. If the next rebase commit stops with conflicts, the dialog stays with the new list (`The next commit stopped with conflicts.`).
- Toasts: `Merged {from} into {into}.` with `Push`; abort — `Merge aborted. The tree is back to <sha>.`
- Only the person creates the merge commit; it is never made automatically after the agent resolves.
- IPC: `git:conflict-take`, `git:conflict-resolved`, `git:conflict-texts`, `git:conflict-apply`, `git:conflict-reopen`, `git:merge-finish`, `git:merge-abort`, `git:merge-agent`, `git:merge-agent-stop`.

<a id="three-way-merge"></a>
### Manual merge in three columns

`MergeView` over the pure model `@brigadir/diff` `merge3.ts`.

- diff3 over lines of base and both sides; touching changes form one chunk, as in git. Chunk kinds `conflict` / `ours` / `theirs` / `same`; a choice is `ChunkPick { taken, ignored, edited?, agent? }`.
- Actions per chunk: `»` / `«` / `«+` / `✕`; `Accept both` (yours, then theirs) on the current chunk in the panel above the columns; `Apply non-conflicting changes`; `Previous conflict` / `Next conflict`.
- Three CodeMirror views: `Yours` and `Theirs` read-only, `Result` editable. Chunk positions and picks live in a state field that undo reverts together with the text (`invertedEffects`); each chunk action is its own history step. Editing inside a chunk marks it resolved.
- Columns align with hatched fillers to the tallest side of each chunk and scroll together; chunk buttons are overlays at the right edge of Yours (`✕ »`) and Result (`« ✕`), 24 px targets; a marker strip of all chunks on the right; word diff of each side against the base.
- `Apply` writes the file (line endings and CRLF follow your side) and runs `git add`. Closing with unapplied choices asks `Close without applying?`.
- Window narrower than 900 px: Yours / Theirs become segments above Result.
- Editor tabs opened directly on a file with conflict markers still get the editor's marker bars (`editor-conflicts.ts`).

<a id="agent-resolve"></a>
### Resolving with the agent

Only on the person's explicit request; nothing resolves conflicts automatically.

- `✦` in the dialog header (all or selected), in a row, or in the merge view calls `askAgentToResolve(paths)`: a separate turn in the same task with an English prompt — resolve the markers, keep the intent of both sides, run checks, and do not commit (no `git add`, `git commit`, `git merge --continue`). Only text conflicts; the files become `pending`.
- While the turn runs those rows show `Resolving…`; other files stay workable (Abort and Continue wait). A banner `{agent} is resolving {files}…` offers `Stop` (cancels the turn; unfinished files return to normal).
- Markers left → `Agent failed` and a banner with `Try again`.
- No markers → `Resolved by the agent · review`. The merge view loads the agent's text into Result (`fromResult`), marks each chunk with `✦`, and the hover explains the choice from the text itself (`Kept yours.` / `Kept theirs.` / `Kept both…` / `Wrote its own version…`); `Undo` restores the base with conflicts.
- The result is also an ordinary diff: line attribution, comments and `Send review` work as for any turn.

<a id="back-to-conflict"></a>
### Back to the conflict

`git update-index --unresolve` (the index resolve-undo record), then `git checkout -m`. A file deleted on one side returns as the other side's file. The record forgets the choice and the agent mark.

<a id="main-tree-branches"></a>
## Branches of the main tree

<a id="branch-picker"></a>
### Branch picker

- In the Repo section without a task and in the main tree, the branch name in a repo's second line is a button that looks like text at rest; on hover it gets a fill and a chevron, tooltip `Switch branch · <repo>`. In a task repo the branch is not a button (in a worktree it belongs to the task).
- The picker (`BranchPicker`, `ui/Popover`, title `Branch · <repo>`, Esc) has `Search branches` and groups `Local branches` / `Remote branches`. The current branch has a check and `current`; local branches show `↓N` / `↑N` against upstream. A remote branch with a local pair is not duplicated. A branch checked out in another worktree is disabled with `Checked out in the worktree of {task}.` At the bottom: `New branch…`.
- Opening reads local refs immediately; `fetch --prune origin` runs in the background at most once a minute per repo and refreshes the list.
- Keyboard: Tab to the branch button, ↩/Space opens, arrows and ↩ in search, Esc steps back, then closes and returns focus.

<a id="branch-switch"></a>
### Switching

- Local branch: `switch <b>`; remote-only: `switch -c <b> --track <remote>/<b>`.
- Before switching, `fetch` of that branch from origin; afterwards a local branch that is only behind upstream is fast-forwarded (`merge --ff-only`); a diverged one is only switched (`↓↑` stays visible). Fetch failure: error toast with `Switch without pull`. Success toast `<repo> → <b>`, with `pulled {commits}` when commits came.
- Submodules are not touched (no `submodule update`); each submodule is its own row with its own branch.
- IPC: `main-tree:branch`, `main-tree:switch`, `main-tree:switch-state`, `main-tree:switch-to`, `main-tree:create-branch`.

<a id="dirty-tree"></a>
### Dirty tree

The picker replaces its content with a step `<current> → <b>`: a chip with the number of uncommitted changes, the file list and four choices:

| Choice | Effect |
| --- | --- |
| `Stash and switch` (primary) | `stash push -u -m "brigadir: <current> → <b>"`, then switch; the toast offers `Restore`. |
| `Bring the changes` | Plain `switch`; if git refuses, a toast explains, nothing changes, and offers `Stash and switch`. |
| `Commit first` | Opens the repo's main tree on the Changes panel with the commit strip. |
| `Discard and switch…` | Confirmation, then `reset --hard` and `clean` limited to the new files in the list. |

`To the list` and Esc return to the list.

**Stash by SHA, not by index.** The stash stack is shared by all worktrees of a repo and can change concurrently. The app records the SHA of its entry right after `stash push`, applies with `stash apply <sha>`, and drops only after success, locating the current `stash@{n}` by that SHA. On a conflict while restoring the entry stays (`Could not restore: the changes conflict. The entry stays in the stash.`).

<a id="new-branch"></a>
### New branch

A step of the same picker: `Name` (prefilled from the search text) and `from` (default `origin/<current>` if it exists, else the current branch). `Create and switch` runs `switch -c <name> --no-track <from>`; uncommitted changes move to the new branch. `--no-track` keeps a later push from going into `from`.

<a id="git-menu"></a>
### Git group in the main tree `⋯` menu

| Item | Behavior |
| --- | --- |
| `Switch branch…`, `New branch…` | The picker. |
| `Pull` (tail `↓N`) | As a click on `↓N` ([Pull and freshness](#pull)): fast-forward, or rebase of a diverged branch. Disabled with a reason when there is no upstream (`The branch has no upstream on origin.`) or it was deleted from origin after a PR merge. Nothing new → toast `Nothing new on origin.` |
| `Stash changes` (tail: change count) | `Changes stashed.` |
| `Restore from stash…` (tail: entry count) | Popover `Stash · <repo>`: entries with branch and message; on hover `Restore` and delete. |
| `Undo last commit…` | `reset --soft HEAD~1`; changes stay in the tree. Disabled when the commit is already on any remote (`The commit is already on origin. Only a new commit (revert) can undo it.`) or is the repo's first commit. |
| `Discard changes…` | Destructive, confirmed (`Discard changes in {repo}?`). |

All confirmations are dialogs with Esc in the header. IPC `main-tree:stashes`, `main-tree:stash`, `main-tree:stash-restore`, `main-tree:stash-drop`, `main-tree:pull`, `main-tree:undo-commit`, `main-tree:discard`.

**No writes under a live task.** If a task without isolation holds the repo's lock, the picker shows a notice naming that task with `Open task` (`The repo is busy with another task.`) and its list is disabled; Git items that write are disabled with the same reason. Worktree tasks do not interfere. Main repeats these checks before every action.

<a id="pull"></a>
## Pull and freshness

- **Background fetch.** For every git repo of each project's main tree (root, submodules, nested repos; not folders, not task worktrees): `fetch` on app start, on window focus and every 5 min, at most once per 5 min per repo (`FETCH_INTERVAL`); also when the branch picker or the task sheet opens. It never changes the tree and is silent on network errors (counters keep the previous values). The Repo section re-reads only when remote refs changed (`RemoteWatch`).
- **`↓N` chip** next to `↑N` in a repo's second line, same component and size S, plain text arrows (`↓3`, `↑14`). The number is upstream commits missing locally. Shown in rows without a task (project defaults, main tree) and in task rows without isolation; not in worktree task rows; not when upstream was deleted from origin.
- **Click on `↓N` pulls at once.** Only behind → fast-forward, toast `<repo> · pulled N commits`. Diverged (`↑N` too) → the local commits are rebased onto the upstream (`git rebase @{upstream}`: no merge commit, nothing is pushed), toast `<repo> · pulled N commits, M commits on top`; `↑M` stays for the person to push. Uncommitted changes the incoming commits touch (fast-forward) or any uncommitted change git refuses to rebase over (`Commit or stash the changes first: a diverged branch pulls by rebase.`), or a repo held by another task → a toast explains and the tree is unchanged. A task without isolation can pull its own repo while its agent is idle. The menu `Pull` does the same.
- **A rebase that stops on a conflict is aborted at once** (`git rebase --abort`), so the tree and the branch are as before. Error toast `{repo}: the pull stopped on a conflict in {files}. Nothing changed.` with `Resolve with agent`.
- <a id="pull-agent"></a>**Resolve with agent** hands the rebase to an agent, the way a failed CI job goes to one ([Pull requests](pull-requests-and-ci.md#ci)): in a task without isolation the prompt goes to that task's agent; in the main tree it opens the `New quick task` sheet (`Pull · <repo>`, no isolation, on the current branch; [Quick task](tasks.md#quick-task)). The prompt (English) names the repo, the branch, the upstream, both counts and the conflicting files: rebase onto the upstream and resolve each conflict keeping what both sides meant; for a submodule pointer take the commit that contains both sides when there is one, else ask the person; do not push; say what was chosen.

<a id="sheet-branches"></a>
## Branch and pull at task start (no isolation)

In the New task sheet with isolation off, the worktree fields are replaced by a `Branch` group (`SheetBranches`): one row per selected git repo, `Branch of {repo}`, with the same list as the picker (search, groups, tails, disabled worktree branches, `New branch…`).

- Default is the current branch; the choice is not remembered for the project (`launch.switches`).
- A different branch adds `Before the start, {repo} switches from {from} to {to}.` (or `… switches to a new branch {to} from {from}.`).
- Dirty tree: segments `Stash | Bring them` and `Commit first…` (the task goes to the backlog with the chosen branch and the repo's main tree opens on Changes). Discarding is not offered in the sheet.
- A repo held by another task: list disabled, reason in a line.
- When the branch that stays is behind origin: `Before the start, {repo} pulls {commits} from origin.` with the switch `Pull before the start`, on by default (`launch.pull`, never remembered for the project).
- Preparation steps before the agent starts:
  - `switch:<repo>` (`Switching branch · {repo}`) — same rules as the picker; a fetch failure falls back to the local branch. Failure → task `failed` with the reason and the tree unchanged; a restart after success does not switch again.
  - `pull:<repo>` — fetch and fast-forward; best effort: diverged, overlap, no network or another task's lock start the task as it is.

<a id="worktree-env"></a>
## `.env` files in a new worktree

| Aspect | Rule |
| --- | --- |
| What | In every repo of the task worktree (root, submodules, nested repos), files that git **ignores** and whose name starts with `.env` (`.env`, `.env.local`, `.env.development.local`, `.envrc`), at the same relative paths. The list comes from `git ls-files --others --ignored --exclude-standard --directory`; an ignored folder (`node_modules/`) arrives as one entry and is skipped whole. Tracked `.env.example` is already in the worktree. A symlinked `.env` is copied by content. |
| When | After all worktree repos are created and **before** the setup command, so installs, migrations and dev scripts see the variables. Preparation step `env`, status `Copying .env…`. A file already present in the worktree is never overwritten. |
| How | A copy, never a symlink: the agent may change ports, databases or keys without touching the main tree or other tasks. |
| Setting | `Settings ▸ Editor ▸ Git ▸ Copy .env` (`agents.copyEnvFiles`, default on; older `settings.json` gets the default). Caption `Copies ignored .env files into a new worktree.` Found by settings search. |
| Sheet | `Copy .env` switch in the worktree block under the setup command; each new task starts from the setting, the choice belongs to the task (`launch.copyEnvFiles`) and is not written to project settings. Collapsed with the worktree fields when isolation is off. |
| Other worktrees | Crew workers take the parent task's choice; a task that moves to a worktree after a repo conflict uses its own sheet choice. A task without the field does not copy. |

<a id="agent-branch-names"></a>
## Agent-chosen branch names

- The branch field in the sheet is empty by default with placeholder `brigadir/auto`. Typed text is a manual name and is never changed; clearing the field returns to auto. There is no Auto/Manual toggle.
- Auto sets `launch.branchAuto: true`; `launch.branch` still holds a fallback derived from the text (`suggestedBranch(title, prompt, id)`), so the task is valid from its first write. A task without the field already has a final name.
- **When:** the first worktree preparation step, before `worktree add`: step `branch`, status `Choosing the branch name…`. A one-shot call (`writeHintOneShot`) to the helper model (per-job target `branchName`, lowest effort), 15 s timeout, call folder `ghost/`, answer limit 120 characters. The prompt-suggestion toggle does not affect it; an exhausted provider quota skips the call.
- **What:** 2–4 English kebab-case words about the task from title and prompt. The answer passes the same filter as `deriveBranch` (ASCII, stop words, ≤ 4 words, ≤ 48 characters) via `branchFromAnswer` and gets the `brigadir/` prefix. Empty, invalid, failed or timed-out answers keep the fallback, with no error.
- **Collision:** if the name exists as a branch in any repo of the task, `-2`, `-3`… is appended (`freeBranch`). A manual name still reports a collision as an error.
- **Fixed after the step:** `launch.branch` holds the chosen name and `branchAuto` is removed, so retries after a failure, crew branches (`<foreman branch>-<agent>`) and PRs all see the same branch.
- Also auto with an empty name: continuation tasks, agent-created tasks (`create_task`), editing a backlog task, moving to a worktree after a repo conflict, and duplicating a task.
- Cost: a task with an auto name starts about 5–13 s later; the name appears on the sidebar card after the step.

<a id="later"></a>
## Later

- Hunks of one file in different commit baskets (needs partial staging on top of snapshots).
- Mark files changed before the task started (`before task`) in the commit dialog list.
- Push of several repos in one dialog with the cross-repo order shown (today `Push all` opens one dialog per repo).
- Per-chunk explanations from the agent in the three-column merge (needs a structured answer format).

<a id="non-goals"></a>
## Non-goals

- A separate Git tab or window; git lives in the Changes panel and repo menus.
- Branch comparison in History; searching all branches (`--all`); regex search.
- Merging into a repo outside the task, into a branch other than the current one, or into a tree with uncommitted changes.
- Conflict resolution without the person asking (by the foreman, a worker or automatically) and an automatic merge commit after the agent resolves.
- A standalone three-pane resolver window or a `⌘G` merge popup.
- Pulling silently on fetch, rebase/merge of a diverged branch from the pull chip, rebase, cherry-pick or branch deletion in the main-tree Git menu.
- `Bring the changes` as the default for a dirty switch; discard from the New task sheet.
- Symlinking `.env` files, copying all ignored files, or a per-project list of paths to copy.
- A separate model for branch names; generating the branch name while typing.
- `git commit --only -- <paths>` or staging basket files from the working tree.
