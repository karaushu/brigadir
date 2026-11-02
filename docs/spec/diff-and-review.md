# Diff and review

Brigadir shows what a task changed by comparing git tree snapshots it takes itself, never `git diff HEAD`. The
**Changes** panel lists changed files per repo, a file opens as a diff document (unified or side by side), and any code
selection in a diff or the editor can become a review comment. Comments are batched and sent to the agent as one prompt,
tracked through `Pending → Sent → Addressed → Resolved`, and every hunk can answer **Why did this change?** from the
snapshot history.

Related: the row engine is in [Chat](chat.md); commit strip, History, merge and conflicts in [Git](git.md); PR diffs and
PR review in [Pull requests and CI](pull-requests-and-ci.md); editor gutter marks and editor comments in
[Editor](editor.md); the quick question under a selection in
[Steering, queue, ghost and quick questions](composer-steering-queue-and-ghost.md); snapshot performance in
[Architecture](architecture-and-platform.md).

<a id="snapshot-engine"></a>
## Snapshot engine

<a id="snapshots"></a>
### Snapshots and checkpoints

The source of truth is git tree objects written through a private index, one per `(task, repo)`:

```bash
export GIT_INDEX_FILE=~/.brigadir/projects/<p>/tasks/<task>/snap-index-<scopeId>
git add -A                  # gitignored files never enter the tree
git write-tree              # → tree; a snapshot commit is chained to the previous one
```

| Rule | Detail |
| --- | --- |
| User state untouched | The user's index, HEAD and branch are never modified; `git status` stays clean. |
| Index reuse | The private index is reused between snapshots (its stat cache makes later snapshots cheap; the gain grows with file count, ~6× at ~2 000 files). It is first seeded from `HEAD` so tracked files that later became gitignored are not lost. |
| Refs | One tip ref per task and repo, `refs/brigadir-v2/tip/<project>/<task>/<scope>`; snapshot commits form a parent chain, so the tip keeps all of them from `git gc`. Legacy per-checkpoint refs `refs/brigadir-v2/snap/<project>/<task>/<scope>/<n>` are kept only where a commit would otherwise become unreachable. Refs stay when a task or project is deleted (it goes to the Trash and can be restored). |
| Document | `snapshots.json` in the task folder (`schemaVersion: 1`, `scopes`, `checkpoints`), written by the host only; read cap 32 MiB. |
| Repo discovery | `.git` is searched to depth 4, including gitignored independent repos; heavy folders and symlinks are skipped; submodules and worktrees are recognised. |
| No git | A project without any repo still runs the conversation; the panel says `No Git snapshots`. |

A checkpoint is `{id, at, reason, trees[]}`; `reason` is one of:

| Reason | Taken |
| --- | --- |
| `baseline` | Before the agent starts (checkpoint 0). |
| `tools` | After every 5 completed tool calls, and before/after each agent file write through ACP (only the touched repo). |
| `turn` | At each turn end. |
| `refresh` | When the repo watcher sees a HEAD change or a repo appear/disappear, and on the panel's refresh button. |
| `user-before` / `user-after` | Around an explicit Save in the built-in editor and around a file revert. |
| `quick-before` / `quick-after` | Around a quick question's edit. |

Saving is explicit (no autosave), so the user's own edit is a clean delta between `user-before` and `user-after`.

The refresh button (`Create snapshot and refresh changes`) asks the running host for a checkpoint; without a live host,
main takes the same owner lock, writes a `refresh` checkpoint into the validated journal and releases the lock — no agent
is started. An unfinished turn of a host that is gone is first closed with `host.stopped`, so external edits never get
agent attribution. Closing the window waits for pending refreshes and review writes, like Save.

<a id="diff-base"></a>
### Diff base setting

**Settings ▸ Editor ▸ `Diff base`** (radio, glyph before each option), stored globally as `editor.diffBase` in
`settings.json`; a missing field reads as `'task'`.

| Value | Label | Base tree |
| --- | --- | --- |
| `task` (default) | `Task start` — "Changes since task start." | Checkpoint 0 of the task, or the task's `changeBase` checkpoint when set (a crew part's start). |
| `head` | `Last commit` — "Uncommitted changes." | `HEAD^{tree}` of each repo, read at the time of the read; an empty tree before the first commit. |

The current side is always the latest snapshot; untracked files are in the snapshot tree, so in `head` mode they show as
added, as in `git status`. The engine, file ids, blob anchors and worker pool are identical in both modes.

- **Switches:** the Changes panel, diff tabs, `+N −M` on sidebar cards, the editor gutter, the task's "not reviewed" state
  and the base of `Revert file changes…`. One base in the whole app.
- **Does not switch:** turn footer chips and turn ranges (always snapshot-based), relay "task diff" (always task start),
  the commit strip (always `git status`).
- A commit is a HEAD change, so the watcher refreshes and the panel rereads with the new base; changing the setting
  rereads open tasks.
- In `head` mode an agent's commit removes its lines from the diff, and their comments disappear from view until the lines
  are in the diff again (anchors survive). Changes made before the task have no snapshots, so attribution says
  `Unattributed change`.

<a id="snapshot-ranges"></a>
### Snapshot ranges

A range is two existing checkpoint numbers `{base, current}` (`base ≤ current`), never SHAs from the renderer; main/host
resolve the trees from the stored document. Default: base of the setting → latest checkpoint. A range is chosen by
clicking a turn (Turns view) or in **Diff options ▸ Compare snapshots**: `All changes` ("From first to latest snapshot")
plus two pickers (base / end) listing `#id` badges with the date and time (`DD.MM.YYYY HH:mm:ss`). Picking a base above
the end moves the end, and vice versa. The commit strip at the foot of the Changes tab shows the same picker as
`Current snapshot · N` (`Saved snapshots` without a live host). Review anchors keep the exact blobs of the chosen range.
IPC: `changes:timeline`, `changes:range`.

<a id="scope-kinds"></a>
### Repo kinds

| Kind | Behaviour |
| --- | --- |
| Folder without git | No tree, so no diff, no `+N −M`, no Changes entry, no review, no attribution. The agent may read it but not write it. |
| Submodule | Its paths are filtered out of the parent; the child repo's own diff is listed under its own scope. A parent's gitlink file reads `Submodule reference`. |
| External repo (outside the project root) | Diffed normally. Opening its file from a diff opens it **read only** with the repo as root and a `~` path in the header; gutter and review work by absolute path. Saving is refused because Save goes through the host journal, which accepts only paths under the project root. |
| Released worktree | Its repos read as unavailable; snapshot objects are read from the project's own repo at the same relative path. |

<a id="file-diff"></a>
### Computing a file diff

- File list and counts: one `git diff-tree -M -C` between the two trees, raw records plus `--numstat`. Only the open
  file's blobs are read (`git cat-file --batch`).
- Lines come from Brigadir's own diff over the two blobs, never from parsing `git diff` text: **patience** (anchors on
  unique common lines, so moved blocks stay blocks), an exact LCS fallback within a budget, then a bounded linear-space
  Myers, then "all removed + all added". Changed runs are removed-first. Word-level spans on paired lines (skipped when the
  pair exceeds 20 000 characters).
- Runs in a worker thread pool (2 workers), so a large file never blocks the window. Renderer passes only `TaskKey` and an
  immutable 64-hex file id; main re-derives scope, path and SHAs (`changes:read`, `changes:file`, `changes:syntax`).
- Limits: 2 MiB per blob side, 100 000 lines, 20 000 characters per line. Beyond them the file shows
  `This file is too large to display.` with no truncated text. Binary files show `Binary file`.
- Generated files (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `*.tsbuildinfo`) carry a `Generated file` label.
- Mode changes show as `100644 → 100755` in the file header.

<a id="revert-file"></a>
### Revert file

`Revert file changes…` (file header, undo-arrow glyph) restores the file to the base of the displayed diff after a
confirmation naming the file (in `head` mode: "Restore the file to the last commit. Changes made before the task are lost
too."). The host lock owner writes it between `user-before` and `user-after` checkpoints; the git index is untouched.

- Current bytes and mode must equal the end of the shown range; newer edits are a conflict ("The file changed after this
  snapshot. Refresh before reverting."), never overwritten.
- A new file is deleted; a deleted one is restored only if the path is free; a rename restores the old path only if free.
- Symlinks, gitlinks, binary and too-large files are refused with a visible error; an unsaved editor buffer of the file
  blocks the revert until it is saved or discarded. IPC: `changes:revert`.

<a id="changes-panel"></a>
## Changes panel

The panel tab is named `Changes` (`Show changes`, `⌘⇧D`); its view switch is `Diff | History | Turns`.

<a id="changes-header"></a>
### Header

One row: view switch, base chip, flexible space, `Find file` search toggle, refresh, `Diff options`. All controls share the
row height.

- **Base chip.** Glyph `base-task` (flag) or `base-head` (commit node) and the option name on `--tint`. Tooltip:
  `Diff base: <value>. <description>` and `Change in Settings ▸ Editor`; a click opens Settings on the Editor tab — the
  chip never toggles the base. With a range selected it reads `Snapshots #<base>–#<current>` on `--accent-soft` with a
  `history` glyph and an `×` (`Show all changes`) that returns to the setting's base; then it is not clickable. Shown only
  in the Diff view.
- **Narrow panel.** Below 360 px the chip shows only its glyph. On the Diff tab the panel never gets narrower than its
  one-row header measured in the app (font and locale change it); the minimum is the widest header among the modes
  already opened, and an open search field does not change it. Files and PR tabs keep a 200 px minimum.
- **Overflow.** When the header is wider than the panel, the row scrolls horizontally (wheel or trackpad, no visible
  scrollbar, the shared `ui/use-tab-strip` behaviour); controls never shrink or overlap. The open search field spans the
  whole header and does not scroll.

<a id="changes-list"></a>
### File list

Grouped by repo in the order the panel shows repos; each row has file name and directory on two lines and `+N −M` (or
`Binary file`). The panel's initial width is 400 px; a saved width wins.

Selection and scrolling: click, double click and context menu change the selection without scrolling the list; keyboard
navigation scrolls only to the nearest viewport edge when the next row is outside it; returning to a task restores its
scroll. The filter follows the same rules.

<a id="changes-empty"></a>
### Empty states

`No changes` or `No Git snapshots` stands at the top of the panel, under the header, at the panel's text scale — never
centred in the empty height. With no changes the `+N −M` indicator disappears; zero is not shown as a number.

<a id="diff-view"></a>
## File diff view

A changed file opens as a document tab in the task's document column (the same view serves History commits and PR
files). The file header: path, `+N −M`, mode change, `Generated file`, layout segment, `Wrap lines`, `Open in editor`,
`Why did this change?`, `Revert file changes…`.

<a id="diff-layouts"></a>
### Unified and side by side

| Layout | Row model |
| --- | --- |
| `Unified` (default) | One row per line. |
| `Side by side` | One row per aligned pair `(old?, new?)`; gaps come straight from the diff. |

- Both layouts use the shared virtualized row engine; side by side is one table, so scrolling is synchronised by
  construction — never two text views side by side. Horizontal scroll is one shared offset for both sides; column width
  comes from content (monospace: gutter + longest line), equal to the viewport only with wrap on.
- Only the person changes the layout: the segment (icon-only; plus `Preview` for Markdown files), **Diff ▸ Toggle diff
  layout** `⌥⌘U`. There is no automatic fallback to unified in a narrow panel — a surface that switches by itself while
  being read looks broken.
- `Wrap lines` is an icon toggle in the file header (pressed = accent tone); disabled in Preview, where lines always wrap.
- Layout, wrap and preview are per-task surface state.

<a id="side-labels"></a>
### Side labels

Above the code both sides are labelled with what is compared, in both layouts:

| Case | Old side | New side |
| --- | --- | --- |
| Task base | `Before the task · <blob7>` | `Current snapshot · <blob7>` |
| Range | `Before the task #0` or `Base snapshot #N · <blob7>` | `Current snapshot #N · <blob7>` |
| `head` base | `HEAD <commit7> · <blob7>` | `Current snapshot · <blob7>` |
| Commit (History) | its own label | `Commit preview` |

A missing side prints `∅`; a label never silently drops the hash. A historical base is never called the task start.

**Why:** the diff answers "what did this task do", which differs from `git diff HEAD` when there were uncommitted changes
before the start, or the agent committed, checked out, stashed or rebased. An agent can truthfully report changes the
panel does not show (they existed before the task); the label makes the comparison explicit.

<a id="diff-folding"></a>
### Folding, navigation and find

- Unchanged runs keep 3 lines of context around changes; a longer run collapses into a full-width
  `Show unchanged lines · N` strip (`ui/DiffCode` `DiffFold`, `--tint`, hover `--tint2`). **Diff ▸ Expand all context**
  `⌥⌘]`, **Collapse all context** `⌥⌘[`; opening find expands everything.
- **Diff ▸ Next hunk / Previous hunk**, **Jump to source** `F4`.
- Syntax highlighting per side; `Syntax highlighting is unavailable.` / `Syntax highlighting limit reached.` when it fails.

<a id="open-in-editor"></a>
### Line numbers and opening the editor

A line number is navigation only (`Open in editor · new:12`, tooltip `⌘+click opens in editor`); a plain click does nothing
and never takes focus or selection.

- ⌘+click (Ctrl+click elsewhere) or `Enter` on a number, the file header's `Open in editor` and the line context menu all
  open the editor with caret and focus on the line, scrolled to the middle (also when the tab was already open, also in
  split groups).
- A new-side line opens at itself; a removed line opens at the deletion point — the line right after its block
  (`editorLines`). A History commit opens the file from that commit.
- Where `Open in editor` is disabled (history, gitlink, deleted file), ⌘+click does nothing.
- Double click selects a word, triple click a line; neither opens the editor.

<a id="selection"></a>
## Selection

<a id="diff-selection"></a>
### Text selection in a diff

Code is selected as text, as in the editor; there is no line-range selection from the gutter.

- The native selection shows the exact characters on `--accent-soft`, laid over (not replacing) the `+`/`−` row tint.
- A drag may start or end anywhere in a code row (text, sign, indent, empty space to the right); an end outside code rows
  takes the row under the pointer. In side by side the drag stays in the column where it started (`user-select: none` on
  the other side), and `⇧`+←/→/↑/↓ move the selection focus through that column's lines (`extendInLane`), keeping the
  column position across shorter lines.
- The selection is read when the gesture ends (pointer up, or each `selectionchange` with no button down: `⇧`+arrows,
  double/triple click, click elsewhere). Only `[data-code-line]` cells count — no numbers, signs or end-of-line marks.
  A piece with no characters (selection starting at a line end, triple click reaching the next line) touches no line; a
  blank line inside does.
- Anchor side: `new` if any new line is covered, otherwise `old`. The anchor is the lines touched; the verbatim text is
  kept as the quote.
- While a draft or quick-question popover holds focus, the characters stay painted with the CSS Custom Highlight
  `::highlight(code-selection)` (`code-highlight.ts`), rebuilt when rows virtualize, without touching the DOM.
- The selection does not fade when the table loses focus. A selection set by find (typed query, next/previous match,
  `Select all matches`) gets no panel until the person changes it.
- The diff selection is what the agent's `editor_state` reports, held while focus moves to chat or console.

<a id="selection-panel"></a>
### Selection panel

One component (`ui/ReviewControls` `SelectionActions` inside `SelectionFloat`) for the editor and every diff (Changes, PR,
diffs in chat).

| Action | Effect |
| --- | --- |
| `Ask the agent` (primary) | Quick question popover about the selection. |
| `Comment` | Opens the comment draft on the selected lines (pressed state while the draft is open). Disabled for more than 100 lines (`Select up to 100 lines for a comment.`). |
| `To composer` (paperclip) | Attaches the selection to the composer as a reference with its `Selected text:` quote; nothing is sent. |
| caption | `symbol · 110` / `· 110–111`, plus `· old` only for the old side. |

- A bare selection takes no layout space: the panel is a pill as wide as its content, floating over the lines below the
  selection, left edge where the selection starts, kept inside the visible code (4 px from the edges, never over the
  gutter), flipped above when there is no room below; overlay shadow `0 4px 14px var(--shadow)`. It moves with the text.
- No panel while the selection is still being made (mouse button down in code, or `Shift` held with focus in code); it
  appears where the gesture ends.
- Pressing a panel button keeps the selection (`mousedown` default prevented).
- `Esc` drops the selection and the panel, unless a draft is open, focus is in a field, a dialog is open, or another
  handler took the key.
- If the selection scrolls out of the viewport, the panel goes with it; the action stays on **Diff ▸ Comment on selection**
  `⌥⌘C`.
- In a main-tree task, `To composer` / `Send to chat` start a quick task with the code as context instead.

<a id="review-comments"></a>
## Review comments

<a id="anchors"></a>
### Anchor and re-anchoring

A comment is never `(file, line)`:

```ts
Anchor = { scopeId, path, side: 'old' | 'new', blob, start, end,
           quote: string[], before: string[2], after: string[2],   // whitespace-normalized context
           contextHash /* SHA-256 */, symbolPath /* enclosing tree-sitter symbol or null */ }
```

Main builds the anchor itself from the open diff's file id, side and range, validated on the current blobs (range ≤ 100
lines; quoted lines ≤ 4 000 characters each). Re-anchoring:

| State | When |
| --- | --- |
| `exact` | Same blob SHA. |
| `relocated` | Exactly one match of context + quote in the new blob; the card shows `Relocated` and `old → new` lines. |
| `outdated` | No match or several; the card shows `Outdated`. A comment is never moved silently. |

Partial-line selections are commented as whole lines; the anchor has no columns. The verbatim selection is stored in
`ReviewComment.excerpt` (≤ 400 000 characters); old comments without it quote the anchor lines.

<a id="comment-cards"></a>
### Draft and comment cards

Identical in the diff and the editor: selection panel, draft card, added comment card and review footer are written once.

**Draft** (`CommentDraft`): header with the user initial, `New comment` / `Edit comment`, the lines in mono (`109–111`,
`· old`) and a `Draft` chip; the quote (`ui/CodeQuote`: first 3 lines without shared indent, then `+N lines`, syntax
coloured); a textarea (placeholder `Comment on the selected code`, ≤ 10 000 characters, grows to a ceiling then scrolls);
footer ordered by consequence:

| Button | Effect |
| --- | --- |
| `Cancel` | Discards the text. |
| `Add a comment` (`Save` when editing) | Adds to the review batch. |
| `Send to chat` (split) | Sends the comment to the agent now; the right half `Send to chat and go` also switches to the chat. In a terminal task: `Attach comment` / `Attach comment and go`. |

In a focused draft `⌘↩` (**View ▸ Submit**) runs the primary action (`Send to chat`, or `Add a comment` where there is
no chat), `⌘⇧↩` runs `Send to chat and go`, `Esc` cancels. Closing a draft by any exit also clears the selection. While a
draft is open the selection is frozen. Drafts are per task and survive switching tasks; a draft whose lines are no longer
shown says `Select code again to attach this draft.`

**Placement.** An open draft and added comments are real rows **between lines**, right after the last line of their
range; they scroll with the code and push lines down (in the editor: block widgets that reserve space below the line).
The row height grows with the text without recreating the cell, so focus is never lost while typing.

**Added comment** (`CommentCard`): `You`, lines (`→ relocated lines`, `· old`), position chip, status chip, `Resolve` /
`Reopen` once sent, `Edit comment` (back to a draft in place; the edited comment leaves the batch rather than being
duplicated) and `Remove comment` (no confirmation); then the quote and the text. Comments are visible as soon as the file
opens, each at its lines.

<a id="comment-states"></a>
### Lifecycle and states

| State | Meaning |
| --- | --- |
| `Pending` | Added, not sent. Unsent comments are the person's private notes; there is no separate "note to self" toggle. |
| `Sent` | This version was accepted in a batch recorded in the journal. |
| `Addressed` | The next agent delta touched the tracked range (see below). |
| `Resolved` | Explicitly resolved by the person (`resolvedVersion` = current version). |

Editing a comment creates a new version, which is `Pending` again and re-enters the next batch.

<a id="review-storage"></a>
### Storage: `review.json`

`~/.brigadir/projects/<p>/tasks/<task>/review.json` (`schemaVersion: 1`), written by one serial writer in main
(`atomicJson`):

- `comments[]`: `ReviewComment {id (UUID), version, text, at, anchor, excerpt?, author?, resolvedVersion?,
  addressedVersion?, addressedCheckpoint?}` (`author` names an agent reviewer; human comments have none).
- `notes[]` (optional; documents without it read as empty): general notes `{id, version, text, at, resolvedVersion?}`
  with no file anchor.
- Limits: 500 comments + notes together, 10 000 characters per text, 16 MiB per document.
- Drafts can be added without a live host; sending needs an active or resumable session.
- A file opened in the editor outside the task's repos, not yet in a snapshot, or changed after it simply has no review
  (`review:editor-read` returns `null`, not an error).
- IPC: `review:read`, `review:add`, `review:editor-read`, `review:editor-add`, `review:note`, `review:edit`,
  `review:resolve`, `review:remove`, `review:remove-selection`, `review:positions`, `review:file`, `review:prepare`;
  `review:changed` notifies the renderer of a write from any source (UI, MCP, crew).

<a id="review-footer"></a>
## Review footer and sending

<a id="footer"></a>
### Footer

A two-row strip (`ReviewFooter`): the general-note row (`General note` field full width + `Add note`), then the summary
`N comments · N files` (with a `zoom` glyph; opens the review popup), the amber warning `The draft has not been added.`,
the trash (`Delete all`, no label) and `Send review` (`Attach review` in a terminal task).

| Rule | Detail |
| --- | --- |
| Visibility | Shown once the review has a comment or note, or any non-empty draft (diff, editor or general note); an empty review has no footer. Never in main-tree tasks, and hidden while the review popup is open. |
| Placement | Belongs to the document column and never spans under Files/Changes or the workspace. With no document column on screen it sits under the chat; with neither, under the task's empty state. |
| Counts | The summary counts added comments and notes only; `Send review` counts and is enabled only for unsent ones. |
| Draft warning | Shown only when a draft has non-whitespace text, so unsent thoughts are never mistaken for counted ones. |
| Compact | A chevron button (`Collapse review panel` / `Expand review panel`, `aria-expanded`, `aria-controls`) hides the note row; summary, send and warning stay. State `reviewCompact` is parked with the task; collapsing never clears the text. Expanded by default. |
| Delete all | Shown only when there are comments/notes or a non-empty general-note draft; disabled while a request runs. |

<a id="send-review"></a>
### Sending a review

Entry points: `Send review` in the footer, and **View ▸ Submit** `⌘↩` while the review is the context.

- `review:prepare` builds one prompt from all unsent comments (creation order), then unsent general notes:

  ```text
  Address the following review comments for this task. The quoted code belongs to the specified snapshot; verify its
  current location before editing.

  1. File "src/App.tsx", scope <scopeId>, new side, blob <sha>, lines 42-58.
  Comment: …
  Quoted code: "…"
  Selected text: "…"            (only when an excerpt exists)

  2. General note: …
  ```

  `scope` is always included so the agent knows the git root. Prompt cap 1 000 000 characters.
- The batch id is a SHA-256 of the `(id, version)` list. The host records `turn.started.review` with these ids before the
  prompt; a repeat with the same id (UI restart, double click) never starts a second turn. `Sent` is read from the journal,
  not from a second write after the IPC reply.
- GUI transport: one domain command `submitReview`; if the agent is busy it joins the prompt queue. Terminal transport: the
  review is held and attached to the next CLI prompt ("Review attached to your next CLI prompt."; `Remove queued review`
  discards it). The formatted text is identical on both transports.
- A resumable stopped task is resumed first. The review appears in the chat as the user's message with that text.

<a id="addressed"></a>
### Addressed and resolved

- `Addressed` means only that the first agent delta after the batch touched the tracked range — not that the fix is good.
  Manual saves (`user-*` checkpoints) and unknown changes never count. The range is traced back through unchanged spans
  (rename keeps it, copy does not); once the commented lines themselves are rewritten, exact tracking stops. The scan
  covers the last 128 snapshots; insufficient history or an ambiguous anchor leaves `Sent`.
- Positive evidence is saved as `addressedVersion` + `addressedCheckpoint`, so later bounded scans and restarts never
  revert it; the write is skipped if the comment changed meanwhile.
- General notes have no lines and are never auto-addressed.
- `Resolve` / `Reopen` is an explicit action on a sent version; editing creates a new pending version.
- An explicit comment always goes to the agent, even on lines the person edited.

<a id="review-popup"></a>
## Review comments popup

The footer summary opens a dialog (620 px wide, 48 px from the top, height by content, list scrolls within ~408 px):
header with the comment glyph, `Review comments`, the summary and `PopupClose` (Esc).

- Grouped by repo in the Changes panel's order (repo name, branch, file count; `Unknown repository` keeps comments of a
  repo no longer present). One row per file: file name + directory, a direction badge (`Diff` for a changed file,
  `Editor` for an unchanged one, amber `Outdated` when any anchor is outdated), the first comment's text, `N comments ·
  42, 50–58` and the file's `+N −M`. `Show comments` expands the full cards (edit/resolve/remove). General notes are
  their own rows.
- Each mounted file row asks main for live positions by one comment UUID (`review:positions`); main finds the
  scope/path group, checks versions and reads the blobs of the selected range — for an unchanged file, the blob from the
  checkpoint tree via a literal pathspec. Unavailable repo, binary/large blob or a read error shows
  `Comment location is unavailable.`, never a guessed state. Requests are serialised; late answers after a review or range
  change are dropped.
- Clicking a row: a changed file opens its diff scrolled to the comment; an unchanged file opens in the editor at the first
  comment's line. IPC accepts only the comment UUID; main resolves scope/path; a missing file keeps the note readable and
  shows an error.
- Footer strip: `↑↓ Select result · ↩ Open result` and `Delete all`. Sending and the general-note field stay under the
  document. Empty state: `No review comments yet` — "Select code in the editor or diff to comment."
- The summary is a pure function (`reviewFiles` in core) shared with the footer, so both count the same comments.

<a id="review-delete"></a>
### Deleting comments

| Where | Removes | Asks |
| --- | --- | --- |
| `×` on a comment card | That comment | No |
| Trash on a popup file row (`Remove file comments`) | Visible versions of that file's comments, atomically | No |
| Footer trash / popup `Delete all` | All comments and general notes, plus the general-note draft | Yes |

The confirmation is the shared `ConfirmDialog` (danger): `Delete all review comments?`, the count and what is removed,
red `Delete`; focus starts on Cancel, Esc cancels, an error keeps the dialog open. The set of `(id, version)` and the
draft are frozen when the dialog opens: comments added later survive, a changed version rejects the whole operation ("The
review changed…"), and a draft edited meanwhile is not cleared. Main validates the selection and shows no second prompt.
General notes go with the comments because they belong to the same batch.

<a id="why-changed"></a>
## Why did this change?

`Why did this change?` (glyph `why`) is available on each line on hover (gutter button), in the line context menu, and for
the whole file in the file header. It opens a popover with snapshot-history entries; hovering never runs git.

- **Request:** `changes:attribution` takes `TaskKey`, a registered file id and an optional new-side range
  (`start..end`, < 5 000 lines). A new-side line asks about itself; a removed line asks about its replacement hunk's new
  lines or its deletion point; the file header asks about the file.
- **Walk:** main walks back from the end of the displayed range over at most 128 checkpoints, following the path through
  renames (a copy does not inherit the source's history). Only pairs whose trees differ for that path are diffed, with
  zero-context git hunks (patch ≤ 512 KiB, cached by blob pair). The range is mapped back through unchanged spans,
  accounting for insertions above it. When the lines themselves are rewritten, that entry has line precision and older
  entries fall back to file precision.
- **Entry:** `{checkpoint, at, author: 'user' | 'agent' | 'unknown', turn, turnNumber, prompt, excerpt, quick?, precision:
  'lines' | 'file'}`. `user` = the change came with a `file.saved` event (explicit Save); `agent` = a `tools`/`turn`/
  `refresh` checkpoint inside an agent turn; quick-question edits are attributed to the question; anything else is
  `unknown`. Binary or oversized patches fall back to file precision.
- **Popover:** newest entry expanded (`Turn N` / `During agent turn` / `Quick question` / `Your edit` /
  `Unattributed change`, `These lines` or `This file`, the agent's message excerpt and the tool that touched the file),
  older entries as rows; `Go to turn`; `Some history could not be checked.` when truncated. User edits say so plainly
  ("Your edit. No agent turn.") without an invented turn. Esc or a click outside closes it and returns focus.
- **Go to turn:** switches to the chat scrolled to the turn, highlighted until the next click/scroll, with a
  `Back to diff` strip.

<a id="change-counters"></a>
## Change counters

Every `+N −M` line-change counter (sidebar card, Repos section, crew roster, commit strip, Changes header and list,
History and merge, review popup, turn footer, turn rail and panel, tool-group file chips, PR files) uses the shared
`ui/ChangeCount` / `ui/ChangeCounts`:

- **Format** — `formatChangeCount` (`packages/core/src/change-count.ts`): below 1000 as is; from 1000 one decimal,
  **truncated** (never rounded), no `.0`, suffix `k`, from a million `M` (`1540 → 1.5k`, `1999 → 1.9k`, `5036 → 5k`,
  `999 999 → 999.9k`, `1 250 000 → 1.2M`). Dot and suffix are the same in every locale.
- **Exact value stays.** The short number is painted from an attribute; the element text (copying, `textContent`,
  accessible name) is the exact locale-grouped number (`+5 036 −2 480`). A `title` with the exact pair is added only when
  a number is shortened.
- **Signs** — `ui/ChangeSign` draws `+`/`−` as SVG sized to the digits (`.6em × .72em`, on the baseline, stroke like the
  digit stroke, `currentColor`), so both signs align in any fallback font; the text sign stays visually hidden in the DOM.
  Signs in the diff gutter itself remain text.
- Only line-change counters use this; tokens use `formatTokenCount`, other counts format as usual; summaries for agents
  keep exact numbers.

<a id="later"></a>
## Later

- Task steps: a `Next step` button that makes a new snapshot the diff base while keeping the earlier bases reachable (`From task start`), persisted as `task.steps`.
- Step divider in the conversation.
- Empty diff that also states how many working-tree files changed outside the task, and an optional "Working tree" section diffed against HEAD.
- An "edited by you" mark on files in the diff list.
- Unsent-comment badge on the Changes toolbar button and a `Submit review (N comments)` ghost suggestion in the composer.
- Symbol-path fallback (tree-sitter) in re-anchoring; `symbolPath` is already stored.
- Choosing the comment side by the clicked gutter for pairs that have both sides.
- Multi-select checkboxes for comments.
- Editing files of external repos from the editor (needs a save path, checkpoints and locks for that repo).

<a id="non-goals"></a>
## Non-goals

- `git diff HEAD` or the user's index as a diff source; staging from Brigadir.
- Automatic diff-layout switching, or blocking side by side in a narrow panel.
- Separate horizontal scroll per side in side by side.
- Column-precise comment anchors (the quote carries the exact text instead).
- A per-project diff base, or a base toggle in the panel header.
- Automatic `Resolve`; `Addressed` from manual edits or from any change in the file.
- A permanent attribution column in the gutter.
