# Editor

The editor is a CodeMirror 6 surface for reading and changing the task's files. It keeps files safe with opaque IDs, saves only when asked, and checks every save against what is on disk. It shares tabs with diffs, supports split editor groups, renders Markdown, and shows Git information inline: change marks, a change map, the line author and file history. Code intelligence, formatting and syntax grammars are in [Editor code intelligence](editor-code-intelligence.md).

<a id="editor-principles"></a>
## Principles

- **The editor and the diff are separate surfaces.** They share the syntax pipeline and the code theme, not a view. You cannot edit inside a diff, because that would break its two-sided line model.
- **Ways from a diff to the editor:** ⌘+click on a line number, `Enter` on a number, the header's `Open in editor`, the diff context menu and `Jump to source` (`F4`, see [below](#jump-to-source)). Double-clicking code in a diff selects a word. Details are in [Diff and review](diff-and-review.md).
- **What the editor does:** undo/redo, find and replace, auto-indent, bracket matching, toggle comment, explicit save, plus the language features in [Editor code intelligence](editor-code-intelligence.md). Multiple selections come only from `Select all matches` (`allowMultipleSelections` is on, `clickAddsSelectionRange` is off, so ⌘+click stays `Go to definition`).
- **Every explicit command has a native menu item** (menu-bar rule, see [Search, shortcuts and menus](search-menus-and-commands.md)). The parser-independent CodeMirror `language` data is used only for indentation, bracket matching and comment metadata.
- Colors come only from semantic tokens (see [Appearance](appearance.md)).

<a id="syntax-pipeline"></a>
### Syntax pipeline

One `packages/syntax` package, built on web-tree-sitter, serves CodeMirror, both sides of a diff and declaration bounds (`symbol_path`). Grammars are WASM files from `@vscode/tree-sitter-wasm`, packaged locally. Parsing runs in a bounded Node worker. The renderer sends text with a debounce and an opaque file ID, and main picks the language. A reply is applied only to the `EditorState.doc` version it was computed for. Above the limits, or after an error, the editor falls back to plain text and says so (`Syntax highlighting limit reached.`, or `Syntax highlighting is unavailable.` with `Retry`). Languages, limits and highlight weights are in [Editor code intelligence](editor-code-intelligence.md).

<a id="files-and-save"></a>
## Files and explicit save

**File identity.** The Files tree, diffs and search hand the renderer opaque file IDs. The renderer never sends a path to read or write; main resolves the ID inside the project. Symlinks, `.git`, non-UTF-8 files and binary files are not editable. A file outside the project (for example `lib.dom.d.ts` reached through go-to-definition) opens read-only, with the notice `This file is outside the project. Read only.`

**Limits.**

| Limit | Value |
|---|---|
| Open/save size (`editorByteLimit`) | 8 MiB. The body is not read above it (`This file is too large to display.`). |
| Large file (plain-text mode, `Large file. Plain text mode.`) | over 5 MiB or 50 000 lines |
| Files tree | 5000 entries per folder; service and build folders are skipped |
| Buffers kept in memory (`bufferLimit`, `bufferChars`) | 12 buffers or 16 MiB of text, LRU |

**Buffers.** CodeMirror keeps each document's state, undo history and scroll position while you switch surfaces, without keeping its DOM. A clean, inactive buffer may be evicted. Its tab and main's lease stay, and reactivating the tab reads the file again at the same selection and scroll. These buffers are never evicted:

- the active buffer;
- dirty or saving buffers;
- a buffer with a pending disk conflict;
- the file of the comment draft;
- a buffer with undo/redo history;
- a file that a passive [editor group](#editor-groups) shows.

**Save is explicit.** `File ▸ Save` (`⌘S`) or the header's `Save` button. There is no autosave and no silent overwrite of outside edits.

- **Version check.** A write compares the SHA-256 of the version that was read with the current bytes on disk. A mismatch is a conflict (see [Disk versus buffer](#disk-vs-buffer)). Before the rename, the version and the path are checked again. This is not a file-level compare-and-swap against outside processes that ignore locks.
- **The file's form is kept.** Permissions, BOM and line endings are preserved. In a mixed LF/CRLF file, existing CRs stay as they are and a new `Enter` inserts LF. The write is temp file + fsync + rename.
- **Lease.** Main holds a lease on the canonical path across the tasks of its window, so a file open in another task is read-only (`This file is open in another task.`). The lease is not an inter-process lock against other editors.
- **Disk check.** The active file is checked against disk on window focus, on every checkpoint and every 2 s while the window is visible.

**Save transaction.** A live session host runs `user-before` snapshot → write → `user-after` snapshot → `file.saved` event, serially and only between turns. Main has an internal RPC for this. The renderer has no `save_file` command that takes a path. Without a live host, main takes the same `host.lock`, opens the journal before any write and runs the same transaction without starting an agent. An old schema or a live owner blocks the write. A stale lock is released only when its PID is gone and the inode matches. No process is killed. The reason for this design: snapshots and the journal must have a single writer, even when the agent is closed.

**Closing with unsaved edits.**

- Closing a tab with a dirty buffer shows the strip `There are unsaved changes.` with `Keep editing` / `Discard changes` (see [Closing tabs](#closing-tabs)).
- Closing the window or quitting does not ask. Dirty buffers go into the task's `drafts/` and come back when the window opens again (see [Task window workspace](task-window-workspace.md)).
- An explicit Discard is still required when hot exit could not keep the buffer: a file in the project's main tree, a file over 8 MiB, or a window that did not answer.
- Closing a window waits for a write that is in progress.

<a id="disk-vs-buffer"></a>
### Disk versus buffer

If a file changes on disk while its buffer is dirty, the editor does not merge silently. It shows `This file changed on disk.` with these actions:

| Action | Effect |
|---|---|
| `Reload` | Replaces the buffer with the disk text and refreshes the gutter marks and the line author at once. |
| `Keep mine` | Keeps the buffer and makes the disk text its base, so any buffer state that differs from disk is dirty, including ⌘Z back to the old text. The buffer keeps its own line endings, and a new Save is needed. |
| `Show changes` | Opens the inline comparison `Disk file and unsaved edits` (limited to 2 MiB on each side). |

- **A clean buffer reloads silently** when the disk changes. Gutter marks update immediately.
- **⌘Z after a reload is allowed.** The reload is its own history step (`isolateHistory: 'full'` on both sides). The buffer is then dirty against the disk text, so a following ⌘S is a deliberate overwrite.
- **The conflict clears itself** when the disk text again equals the buffer text (`EditorModel.settle`): the buffer becomes the base and the banner goes away. If the disk returns to the text the buffer was read from, there is no conflict and the buffer stays dirty against disk.
- **Stray CR.** In a mixed LF/CRLF file each raw `\r` is drawn as `␍` (`highlightSpecialChars`, class `cm-raw-cr`, `--fg3`) with the tooltip `Stray CR character on this line`. A file with all CRLF endings shows no marks. No other control characters are marked.
- **Formatting does not convert line endings.** The Prettier worker always formats with `endOfLine: 'lf'`, and the file keeps its own line endings. Converting line endings would be a separate action.

<a id="save-during-turn"></a>
### Save during a turn

You can save while the agent is working. The save itself happens at the turn boundary, so attribution and the single snapshot writer stay intact.

1. While a turn runs, the button reads `Save after the turn`. The editor sends the usual save request with the flag `afterTurn`. The host holds the request instead of refusing it. Without the flag, a busy host refuses the save.
2. The text saved is the buffer at the moment of `⌘S`, after format-on-save. Edits made after `⌘S` stay unsaved. A second `⌘S` for the same file replaces the queued request, and the earlier one ends without writing.
3. When the turn ends, the host writes queued saves **before** the next prompt from the queue and before held messages (`kickPrompts` runs the save queue first). It uses the same transaction: version check, snapshots, `file.saved`. In a CLI task the write happens after the hooks' turn end.
4. If the agent changed the file during the turn, the version mismatches, nothing is written and the editor shows `This file changed on disk.` If the agent wrote exactly the same text, the buffer simply becomes clean.
5. While the request waits, the notice `The save waits for the turn to end.` shows under the header, and Save stays disabled until the next edit.
6. Main does not count a queued request as one of its writes. Commit, Git operations and quitting do not wait for it. Quitting mid-turn leaves the buffer unsaved; hot exit restores it, and if the host lives on and writes after the turn, the restored buffer meets the disk as clean.

<a id="editor-chrome"></a>
## Header, gutter and footer

- **Header** is a size-S row (`data-size="s"`, 32 px, hairline `--hair` below). It holds the file path (`ui/FilePath`, the same component as the diff header and passive groups: interface font 12, folder `--fg2`, name weight 500). After the path come, in order: the Markdown view switch (`.md` / `.markdown` only), `Select a declaration`, `Find`, `Wrap lines` and `Save`.
- **Notices** under the header: queued save, lease, read-only, large file, syntax state, format result (with a clickable `line N`), disk conflict.
- **Gutter.** Line numbers sit on the code background with no fill or border of their own. The current line's number is `--fg` and the line itself is `--hover` across the full width. A 7 px change-mark strip sits between the numbers and the code (see [Change marks](#change-marks)).
- **Footer** is 24 px, 10.5 `--fg2`, with a hairline above. It shows, in order:
  - `line:column`;
  - `LF` / `CRLF`;
  - the language name, `Markdown` or `Plain text`;
  - the format-on-save source (`Prettier` / `Language server`);
  - ` · outside Git` for a file outside any Git root;
  - transient notices such as `Copied`.

  In a split, only the focused group has a footer. Indentation is not shown in the footer.

<a id="find-panel"></a>
## Find in file

Find uses CodeMirror's search mechanics: its query, match highlighting, case/word/regex options and `$1` replacement groups. Only the panel is our own: `ui/FindPanel`, mounted through `createPanel`. It floats over the code as a card and does not push the code down.

- **Commands:** `Find` ⌘F, `Find and replace` ⌥⌘F, `Find next` ⌘G, `Find previous` ⇧⌘G (F3 / Shift+F3 on Windows and Linux), `Replace all` ⌥⌘↩. They live in the Editor menu, and `Save` is in the File menu.
- **Counter.** Typing selects the nearest match from the caret, as VS Code does, so the counter shows the current match at once (`3 of 12`). With the caret outside a match it shows `? of 12`. It counts up to 10 000 (`10000+`). Other states: `No results`, `Invalid regex`.
- **Keys:** `↩` / `⇧↩` go to the next or previous match. ⌘G / ⇧⌘G work in the field and in the code while the panel is open. `⌥↩` runs `Select all matches`. In the replace field, `↩` replaces and `⌥⌘↩` runs `Replace all`. `Esc` closes the panel and returns focus to the code, from the field or from the code.
- **Scrolling** keeps the current match 72 px below the top edge, so the card does not cover it.
- **Select all matches** creates multiple selections, and typing edits all of them. `Esc` leaves a single selection.
- **On the [change map](#change-map)** matches appear as `--amber` 75 % ticks (up to 2000), and the current match as a full-width `--amber` tick. The map appears for find results even when the file has no changes.
- **Replace is unavailable** when the file is read-only, locked by another task, or shown as a Markdown preview. ⌥⌘F in a preview switches to `Code` first.

`Open Quickly` and Search Everywhere share a bounded file index in main (opaque IDs, paths relative to the project, scope name). It has at most 50 000 files and 100 results, and symlinks and service folders are skipped. See [Search, shortcuts and menus](search-menus-and-commands.md).

<a id="indentation"></a>
## Indentation

A single module decides indentation for CodeMirror, the language server and the Settings display. Because of that, `Enter`, `Indent` (⌘]), `Outdent` (⌘[) and formatting always agree. The Tab key is not bound in the editor, so focus never gets stuck there.

**Settings** (`settings.editor`; missing fields read as defaults):

| Key | Values | Default |
|---|---|---|
| `indentStyle` | `'auto' \| 'tabs' \| 'spaces'` | `'auto'` |
| `indentSize` | `2 \| 3 \| 4 \| 6 \| 8`: spaces per level (for `spaces`, and for `auto` in a file with no indentation yet) | `2` |
| `tabWidth` | `'auto' \| 2 \| 3 \| 4 \| 6 \| 8`: on-screen width of a tab character (`EditorState.tabSize`) | `'auto'` |

**Resolution.** Each value is resolved separately, and the first source found wins:

1. **The project's config for this file.** First the project's Prettier: `resolveConfig(file, { editorconfig: true })`, which merges Prettier's `overrides` and `.editorconfig`. `useTabs` gives the style, and `tabWidth` gives the space size and the `auto` tab width. When Prettier is absent or gives no value, the app's own `.editorconfig` reader applies:
   - it reads files from the file's folder up to its Git root or a `root = true` file, and a nearer file or a later section wins;
   - globs `*`, `**`, `?`, `[…]`, `{a,b}`, `{n..m}`;
   - keys `indent_style`, `indent_size` (`tab` takes `tab_width`) and `tab_width`.
2. **An explicit setting** (`indentStyle` other than `auto`; `indentSize` for `spaces`).
3. **Detection from the file's content** (only for `auto`). If more lines are indented with tabs than with spaces, the style is tabs. Otherwise the step is the most frequent positive difference between neighbouring non-empty lines within 2–8 (` * ` comment lines are ignored), with the smaller value on a tie, or failing that the smallest indent within 2–8. A file with no indentation uses the language's size (Python 4) or `indentSize`.
4. **Default:** spaces, `indentSize`.

**Exception for tab width on screen:** a numeric `tabWidth` setting overrides the project's config (it is a personal reading width, and the file still holds the same `\t`). `auto` takes the project's width, and the fallback is 4. Detection runs once when the file opens or reloads, not on every edit.

**Where the result goes.**

- **CodeMirror:** `EditorState.tabSize` and `indentUnit` in the `indent` compartment, reconfigured without reopening the file when settings or main's answer change. Passive split groups use the same compartment.
- **The language server:** `textDocument/formatting` receives `{ tabSize, insertSpaces }`, always with the project's tab width rather than the displayed one.
- **Bridge:** `editorIndentInfo(key, id)` returns `{ project: ProjectIndent | null }` (`useTabs`, `tabWidth`, `indentSize`, `styleSource`, `widthSource`; source `'prettier' | 'editorconfig'`). Each `ProjectFormatterInfo` from `readFormatters` carries `indent: { style, tabWidth, source }` for the project root. Prettier types never reach the renderer.

**Enter.**

- The new line takes the indentation of the line before the cursor. On a blank line it uses the nearest non-blank line above, looking back up to 200 lines.
- One unit is added after an opening `[ { (`, or after `:` in Python.
- A closing bracket right after the cursor removes the unit only when there is no text before the cursor. In mid-line it only cancels the opening.
- After a line ending in `;`, the indent is that of the line where the statement began, found by walking bracket balance up to the line after `;`, `{`, `}` or a comment.
- Between `{}` Enter produces two lines, as CodeMirror's explode does.

**Settings ▸ Editor ▸ `Indentation`** sits between `Code` and `Git` and has three segment rows:

- `Indent style`: `Automatic` · `Tabs` · `Spaces`;
- `Indent size`: `Auto` · `2 3 4 6 8`, inactive when `Tabs` is chosen;
- `Tab width`: `Auto` · `2 3 4 6 8`.

Under `Projects`, each project's formatter row also names the indentation source when a config sets it, for example `Prettier 3.3.3 · tabs, width 4`, or `Prettier not found · .editorconfig: tabs, width 4`. When your numeric tab width overrides the project's, the row ends with `· your setting`. The row waits up to 2.5 s for the config before it shows without indentation.

<a id="line-wrap"></a>
## Line wrap

- `Wrap lines` is an icon button with `aria-pressed` and an accent tint when on. In the editor header it sits between `Find` and `Save`. In the diff file header it sits after the Unified / Side by side / Preview switch.
- There is **one value per task** (`wrap` in task state) for the diff and the editor: toggling it in one changes both. It is **on by default** and is not written to disk.
- It is disabled in a Markdown preview, where lines always wrap (tooltip `Lines always wrap in the preview`).
- The editor uses `EditorView.lineWrapping`: continuation lines start at the line's left edge, with no hanging indent.
- The diff's `Diff options` popup holds only the snapshot choice. It is always present in the Changes header, and with no snapshots it says `No snapshots yet`.

<a id="change-marks"></a>
## Change marks in the gutter

The editor shows what changed in the open file, counted from the same base as the Changes panel.

1. **Base = the `Diff base` setting** (`settings.editor.diffBase`, see [Diff and review](diff-and-review.md)):
   - `task`: the file's blob in checkpoint 0 of its scope;
   - `head`: the blob in `HEAD`.

   A file missing from the base is entirely added. A file outside every Git scope (a folder without Git, or a gitignored file) has no change marks. The range selected in the Changes panel never affects the gutter.
2. **The current side is the live buffer.** Unsaved edits show at once. This is the one deliberate difference from the Changes panel, whose current side is the latest snapshot.
3. **Marks** sit in a strip between the line numbers and the code:
   - added: a `--green` bar;
   - changed: an `--accent` bar;
   - deleted: a `--red` triangle on the boundary where lines were removed.

   The active line and problem marks never cover the strip.
4. **Clicking a mark opens a peek.** The peek is an inline block under the hunk, not a popover. It shows:
   - the old lines (`--diffRemovedBg`);
   - the base label (`Task base` or `HEAD · <hash>`) and `n of N` among the file's hunks;
   - `Previous change` / `Next change` arrows, `Revert`, `Open diff`, and `Esc` (`ui/PopupClose`).

   Peek actions:
   - `Revert` edits the buffer back to the base for this hunk as one undo step. It does not write to disk. It is unavailable when editing is not allowed (agent busy, file locked, read-only, open conflict) or when the peek lacks some old lines. Main sends at most 200 removed lines per hunk and 2000 per file, and the rest show as `… N`; a hunk can only be reverted whole. After a revert the caret moves to the hunk start, the peek closes and focus returns to the editor.
   - `Open diff` opens the file's diff tab scrolled to the hunk. If the file is not in the panel's diff (the change exists only in the buffer), the diff opens without scrolling and says so.

   The peek closes on `Esc` or on an edit inside the hunk, and focus returns to the editor. Clicks and edits outside the hunk keep it open so the code does not jump while you type. After a recount the peek stays with the same hunk, not the same index. A base change or the hunk disappearing closes it.
5. **Menu ▸ Editor:** `Next change` ⌃⌥⇧↓, `Previous change` ⌃⌥⇧↑, `Revert change` ⌥⌘Z (the hunk under the caret). Moving to a change puts the caret on the hunk's first line and opens its peek.
6. **Computation.** Main reads the base text once per open file through a narrow IPC keyed by the opaque file ID, and reads it again when the base changes (new snapshot, commit on `head`, setting switch). The diff is `diffLines` from `@brigadir/diff` in the diff worker pool. It runs 200 ms after an edit and applies only to the doc version it was computed for. The diff's own limits apply (`tooLarge`, binary): above them there are no marks. After a reload or keep-mine, `refreshMarks` updates marks and the line author at once.

<a id="change-map"></a>
### Change map

- **Layout.** A 12 px strip at the right edge runs the full height of the code, with a `--hair` line on its left. The code's scroll area ends before it. A file with no changes from the base (and no find results) has no map, and the code runs to the edge.
- **Marks** are scaled to the whole file:
  - added: `--green`;
  - changed: `--accent` (6 px wide, radius 2, at least 3 px tall);
  - deleted: a red 7 × 8 notch from the right edge at the line boundary.

  A grey band (`--fg` 14 %) shows the visible part of the file. A file that fits on screen has no band.
- **Hover** widens a mark by 4 px and names it: `Added · 107–110 · +4`, `Changed · 19–21`, `Deleted · after 114 · −1`, or `before 1` above the first line. The hover target is at least 24 px tall.
- **Click** on a mark puts the caret on the change's first line, centred on screen. Click elsewhere on the map scrolls to that spot. The peek still opens from the gutter strip only. Marks are not in the Tab order; the keyboard uses `Next change` / `Previous change`.

<a id="line-author"></a>
## Line author

The setting is `settings.editor.lineAuthor` (default on). The toggle is Settings ▸ Editor ▸ `Git` ▸ `Line author`, and the same setting appears as the checkbox `Editor ▸ Show line author`. Turning it off removes the tail and the card. The menu items stay.

- **Tail.** After the end of the caret line, when the selection is empty, a dim `--fg3` text appears in the editor font, 32 px after the line end: the commit glyph (`base-head`, 12 px) followed by `<author>, <age>`. The age is a long relative form, for example `1 year, 7 months ago` (with four plural forms in Ukrainian).
  - It appears after the caret rests for 200 ms (`lineAuthorDelay`), so arrowing through lines does not flicker.
  - It is hidden while you type and returns with main's next answer.
  - It is a CodeMirror decoration after the line end: it takes no layout space, and a long line pushes it out of view.
- **Lines with no commit have no tail.** This covers lines changed on disk after `HEAD`, lines changed only in the buffer, and every line of an untracked file. `authorAt` returns `null`. The buffer state is already shown by the change marks and the tab's unsaved dot.
- **Commit card** (`LineAuthorCard`) appears when the pointer moves onto the tail and rests for 300 ms. A tail that appears under a still pointer does not open it. It closes when the pointer leaves both the tail and the card (200 ms grace), on `Esc`, or when the caret moves. It is a tooltip-like surface, so it has no `Esc` button. It shows:
  - initials and author;
  - `<age> · <date time>`;
  - the commit subject and body (up to three lines, read on first show);
  - the short hash with `Copy hash`;
  - `File history` and `Open commit`. `Open commit` opens that file's diff in that commit as a read-only commit tab, scrolled to the line the commit left.
- **States without a tail:** file outside Git (footer ` · outside Git`, Git menu items disabled), untracked file, blame still loading, file over 1 MB or 20 000 lines, binary file.

**Implementation.**

- **Blame runs in main.** It is `git blame --porcelain` as a child process in the Git root that owns the file: the longest prefix among the task's Git scopes, selected or not, because reading is not writing.
- **Cache** (`EditorBlames`): keyed by path, disk `mtime` and size, and the repo's `HEAD`, so blame runs again only after a save or a commit. It holds up to 32 files, LRU.
- **Buffer against disk.** The buffer is matched to disk through line hunks in the diff worker, never on the main thread. Lines inside hunks have no commit; the other lines take the blame of their disk line.
- **What the renderer gets:** for each line, a commit index (or "none") and the line number in that commit. The commit body is fetched separately when the card first shows.
- `git blame --contents -` is not used, because it would re-run blame over the whole history on every keystroke.

<a id="file-history"></a>
### File history

`File history` appears in the editor context menu, the commit card and `Editor ▸ File history`. It has no default shortcut (⌥⌘H is macOS Hide Others), but a key can be assigned in the keymap. It opens the Changes panel in `History` mode filtered to the file:

- **Repo and branch.** The repo is the Git root that owns the file (a file in a submodule opens that submodule's repo), and the branch is that repo's current branch.
- **Filter chip.** A chip under the selectors reads `File · <name> · <path from repo root>` on `--accent-soft`. Its `×` (`Remove the file filter`) shows all of the branch's commits again. Picking another repo drops the filter; picking another branch keeps it.
- **Counter.** Above the list: the number of commits with the file, or `100+`.
- **Rows.** Each commit row shows the subject, hash, `<author> · <short age>` and this file's `+N −M`. A rename shows `renamed from <path>` and a merge is marked. History follows renames (`git log --follow`).
- **Click** on a commit opens the file's diff in that commit directly. The row of the open tab is lit with `--accent-soft`.
- **Short ages** (also without a filter): `now`, `5 min`, `3 h`, `4 d`, `2 wk`, `4 mo`, `1 y 7 mo`.
- **Paging:** 100 commits per page with `Show 100 more`, up to 1000. The same applies to branch history.
- **States:** an untracked file shows `Git does not track this file yet. No commits.`, and loading shows `Loading…`.

<a id="editor-context-menu"></a>
## Context menu

Right-click on code, or `⇧F10` from the keyboard, opens a native menu built in main (`core/editor-menu.ts`, `EditorMenuState` validated by `isEditorMenuState`). The menu adds no new abilities: it gathers existing actions next to the click, with the same accelerators as the menu bar (taken from the active keymap). The items always appear in the same order. An item that does not apply is disabled, not hidden. Each item has its glyph (`editorMenuIcons`).

| Group | Items | Disabled when |
|---|---|---|
| Scripts (only in `package.json`) | `Run script`, `Add to commands…` | the caret line is not a top-level `scripts` entry |
| Agent and review | `Ask the agent` ⌘I, `Add a comment`, `To composer` | `Add a comment` follows the selection panel's rules: unsaved buffer, more than 100 lines, conflict |
| Code | `Go to definition` ⌘B, `Find references` ⌥F7 | no word under the caret |
| Change | `Open diff`, `Revert change` ⌥⌘Z | no gutter hunk under the caret; revert also follows the editing rules |
| Git | `File history`, `Commit of this line` | file outside Git; commit also on a line with no commit or while blame is loading |
| Edit | `Cut`, `Copy`, `Paste`, `Toggle comment` ⌘/, `Format document` ⇧⌥F | no selection (Cut/Copy); file not editable (read-only, locked) |
| Paths | `Copy path:line`, `Copy relative path`, `Open terminal here`, `Show in file manager` | `Open terminal here` is disabled for a file outside the project |

- A right-click outside the selection moves the caret to the click point. A right-click inside the selection leaves the selection as it is. The macOS right-click word selection is disabled, because it would silently change the range a comment attaches to. `⇧F10` opens the menu at the caret.
- Without a selection, the comment, `To composer` and `Copy path:line` act on the caret line. The path format is the project-relative path plus `:N`, or `:N-M` for several lines (`pathWithLines`), matching the composer attachment label. A file outside the project copies its `~/…` path.
- Right-clicking the selection panel, a comment draft, the hunk peek or a note does not open the editor menu.

<a id="editor-comments"></a>
## Review comments from the editor

- **Shared review.** An editor comment goes into the same `review.json` and the same batch as a diff comment, and uses the same controls and cards ([Diff and review](diff-and-review.md)).
- **Anchoring.** A comment can attach only to a saved, unmodified version of a file inside the task's Git scope. Main checks the content version and takes the blob of the current checkpoint. If the file does not match the snapshot yet, the UI asks for Save / Refresh (`The file changed. Refresh the changes.`). For a dirty buffer, the quote can still go to the composer.
- **`symbol_path`.** The anchor stores the `symbolPath` of the smallest declaration that contains the range, so a comment on a line inside a function is tied to that function. Anchors are never re-anchored automatically by name: an ambiguous context stays outdated. The review blob read limit is 2 MiB.
- **Selection panel.** It is the shared floating panel (`SelectionFloat`) with `Ask the agent · Comment · To composer`. `Select a declaration` is not in this panel; it is the header button only.
- **Draft placement.** With a comment draft open, the panel and the draft move into a CodeMirror block widget right after the last selected line, and later lines shift down. The draft is parked across surface switches and is protected from buffer eviction.
- **Saved comments** render inline as block widgets (`File comment`). Outdated ones are listed below the editor.

<a id="markdown-views"></a>
## Markdown views

**Switch.** `.md` and `.markdown` files have a `Markdown view` segment switch in the header with three options:

| Option | Glyph | What it shows |
|---|---|---|
| `Code` | `code` | the plain CodeMirror editor |
| `Side by side` | `md-side` | the column split in half: code on the left, live preview on the right, with synchronized scroll |
| `Preview` | `md-preview` | the rendered document only |

- It uses the shared `Segments` component: hover over the whole segment, ←/→ to switch. Tooltips include the shortcut (`Code · ⇧⌘V`); `Side by side` shows only its name.
- When the editor column is narrower than 440 px, the labels hide and the glyphs remain, with the same accessible names.
- In `Side by side` the side you scroll leads, and the other moves to the same source line. Preview blocks carry `data-line` from markdown-it's token map.

**Preview rendering.**

- **Engine and look.** The same markdown-it as the chat (`html: false`; remote images show only as alt text), with the chat's look (`MarkdownBlock`: code blocks with header, `Copy code`, collapse, tables, quotes). It is laid out at document scale: 760 px measure, no rules under headings.
- **Source.** The preview renders the **buffer**, not the disk, updating 150 ms after an edit. Unsaved edits show, the dirty dot and `Save` stay, and ⌘S saves.
- **Links.**
  - A relative link opens the file in a new editor tab (tooltip `Open in editor · <path>`).
  - `#anchor` scrolls to the heading.
  - `http://`, `https://` and `mailto:` open in the system browser (`links:open`). Bare URLs with a scheme become links.
  - `localhost` and `*.localhost` open in the task browser when that module is on.
- **Double-click** on a block opens `Code` at the block's first line. In `Side by side` it places the caret there.

**Which view a tab opens in.**

- A new `.md` tab opens in `Preview`.
- An open at a specific line (⌘+click in a diff, a search result, a definition, the line author) opens `Code`.
- `Open in editor` from a diff takes the diff's view: `Preview` from a change preview, `Code` from code.
- The plan copy for approval opens in `Code`, and so does a file with conflict markers, because the conflict strip and side buttons live only in code.
- The view belongs to the tab (`markdownViews` in task state, keyed by document ID). It survives buffer eviction and is not written to disk.
- A large file stays in `Code`, and the switch is disabled with `The file is too large for the preview`.

**Find in preview.** ⌘F opens the same `ui/FindPanel`, without the replace toggle and replace row. Matches are highlighted in the preview text with CSS Custom Highlights (`--amber` 22 %, current `--amber` 58 %, as in code). `Enter` goes to the next match and scrolls to it. ⌥⌘F switches to `Code` first, because replace edits the source. `Esc` returns focus to the preview.

**Keeping your place when switching.**

- `Preview` → `Code`: the caret goes to the first line of the block at the top of the preview. That line moves to the top and is briefly highlighted (`--accent-soft`, 900 ms).
- `Code` → `Preview`: the block with the caret goes to the top with a short `--accent` frame.
- `Code` → `Side by side`: the preview aligns to where the code is.
- With `prefers-reduced-motion`, the highlight stays but is not animated.

**Diff of a Markdown file.**

- The Unified / Side by side switch gains a third option, `Preview`. There is one value per task (`diffPreview`), not written to disk.
- The change preview is the new document with marked blocks. A block is a paragraph, heading, code block or quote; lists split into items and tables into rows.
  - An added block gets `--diffAddedBg` with a `--green` bar.
  - The old version of a removed block stands right before its former place in `--diffRemovedBg` with a `--red` bar, so a changed block reads old-above-new.
  - A new file is one document with a green bar on the left and no fill.
  - Blank-line changes mark nothing.
  - There is no word-level marking in the preview.
- ⌘F there searches the document (`n of N`, `Enter` / `⇧Enter`).

**Menu.** `View ▸ Markdown preview` ⇧⌘V is a checkbox. It is active when a `.md` document (editor or diff) is on screen and focus is not in another field. It is checked while a preview is visible.

- In the editor it toggles between code and preview. From `Code` it goes to the tab's last preview view (`Preview` first, otherwise `Side by side`). From `Preview` or `Side by side` it goes to `Code`.
- In a diff it toggles between the preview and the last code mode.

**Language.** The footer says `Markdown`, but Markdown is not a syntax language: it has no grammar or language server (`documentLanguage` / `isMarkdownPath` in `core/syntax.ts`, separate from `syntaxLanguage`).

<a id="document-tabs"></a>
## Document tabs

Files, diffs, History commits, PR files and a PR's Overview share one tab strip per editor group. Terminal, browser and simulator tabs live in the same strip as tool tabs (see [Task window workspace](task-window-workspace.md)).

- **Identity** (`core/document-tabs.ts`):
  - a file tab is `file:<fileId>`;
  - a diff tab is `diff:<scope>/<path>` and reads content through the current immutable file IDs of the selected checkpoint range;
  - a file that vanished from the range is never replaced by another file; its tab shows an explicit empty state.
- **Opening from a diff.** Opening a file from a diff adds a file tab right after the diff tab, and the diff stays. Opening something that is already open activates the existing tab.
- **State.** Tabs, the active document and groups are parked with the task. The review popup opens over the current surface and returns to the same tab and drafts when it closes. Closing a diff never destroys the file's undo history or a comment draft.

**Tab strip** (`ui/TabStrip` `.documents`).

- **Row.** It is 40 px (size M 28 + 12) with a `--hair` line below. Its height is the same in one group and in a grid.
- **Pills.** Tabs are size M 28 pills, radius 7, 2 px apart, 12.5 `--fg2`.

  | State | Look |
  |---|---|
  | Hover | `--hover` on the whole pill |
  | Active | `--tint` and `--fg` |
  | Pressed | `--tint2`, scale 0.97 |
  | Keyboard focus | `--ring-soft` |
  | Active tab of a group without focus | `--sep` outline, no fill |

  The tab's button covers the whole pill, so a click in its padding selects it.
- **Close button.** The × is drawn at 16 px with a 24 px target. It shows on the active tab and under the pointer. On other tabs it stays transparent in place. It is disabled (0.35) while the file is being written.
- **Unsaved dot.** An unsaved tab shows a 6 px `--fg2` dot in the ×'s place, named `Unsaved` and marked with `data-dirty`. Under the pointer or with focus inside the tab it shows the × again. Clicking the dot closes the tab, with the unsaved-changes prompt.
- **Content.**
  - File, commit file and PR file tabs show `ui/FileIcon` at 16 px. A PR file that is still loading shows a spinning `check-run` icon.
  - A local diff shows a `±` mark on `--accent` 16 %.
  - A PR Overview shows `pr-branch` and the name `Overview`.
  - A PR number or commit follows the name (`#503`, `@629a71b`, 10.5 `--fg3`).
  - A selected tab does not recolor its icon.
- **`+ ▾`** is an `IconButton` at row size right after the tabs. It opens the Tools menu, which starts with `New file…`.
- **Tooltip.** Every tab's `title` is its full path.

<a id="tab-namesakes"></a>
### Namesakes

`documentTabTails` gives same-named tabs in one strip the shortest folder tail that tells them apart:

| Where the paths first differ | Tail shown |
|---|---|
| parent folder | `…/FeedbackListItem` (no `…/` when that folder is at the repo root) |
| two levels up | `Orders/Header` |
| further up | `Orders/…/Header` |

- If two namesakes would still get the same tail, both get their whole run of folders (`X/a/c`).
- A file at the repo root has no tail; its namesakes get theirs.
- Tool tabs and the PR Overview take no part.
- A diff and a file where one path ends with the other are the same file, not namesakes.
- The tail is set `direction: rtl` between LRM marks, so it truncates from the head (`…ackListItem`). It is at most 200 px wide, and the name never shrinks.

<a id="closing-tabs"></a>
### Closing tabs

These all call one close function:

- the ×;
- a middle click anywhere on the tab (`auxclick`, `button === 1`);
- `File ▸ Close tab` ⌘W (the focused group's active tab);
- the tab menu items.

What the close function does:

- **Releasing.** A clean buffer is released. An evicted buffer gives up its lease, and a diff or commit drops its cache.
- **Next tab.** The neighbouring tab becomes active.
- **Unsaved buffers** are never closed silently. An `--amber-soft` strip over the editor says `There are unsaved changes.` and lists the paths, with `Keep editing` and `Discard changes` (solid red) buttons. `Discard changes` closes the listed tabs without writing. `Keep editing` keeps all of them.
- **A tab that is being saved** stays open, and middle click does nothing on it.
- **A file still open in another group** keeps its buffer and does not prompt.

Middle-button `mousedown` is cancelled with `preventDefault`, so there is no autoscroll, no paste and no focus move or drag start. Right-click and other buttons never close a tab. There are no pinned tabs, so every tab can be closed.

<a id="tab-menu"></a>
### Tab context menu

Right-clicking a tab, or `⇧F10` / the menu key on a focused tab, opens a native menu built in main (`documentTabMenuItems`, state validated by `isDocumentTabMenuState`). The items always appear in the same order. An item that does not apply is disabled, and every item has a glyph rasterized from `ui/Glyph` (see [Search, shortcuts and menus](search-menus-and-commands.md)).

| Group | Items | Disabled when |
|---|---|---|
| Close | `Close`, `Close other tabs`, `Close all tabs`, `Close unmodified tabs`, `Close tabs to the right`, `Reopen closed tab` ⇧⌘T | Others: the only tab in its group. Unmodified: every buffer is dirty. Right: the last tab. Reopen: the group's closed-tab stack is empty |
| Paths | `Copy relative path`, `Copy absolute path`, `Show in file manager` | the tab has no local file (PR file, commit, Overview). A local-changes diff uses the path from the project root |
| Split | `Split right`, `Split down`, `Split and move right`, `Split and move down`, `Move to the other group`, `Unsplit`, `Unsplit all` | Move: the only tab in its group. The last three: a single group |
| Work area (bottom group only) | `Under the chat` (checkbox) | see [Task window workspace](task-window-workspace.md) |

- **Close actions.** Group closes (`documentsToClose`) run the single close function for each tab and show one unsaved-changes strip for all dirty buffers.
- **Active tab.** `Close other tabs` and `Close tabs to the right` make the clicked tab active when they remove the active one.

<a id="reopen-closed-tab"></a>
### Reopen closed tab

`File ▸ Reopen closed tab` (`reopen-tab`) is ⇧⌘T on macOS and Ctrl+Shift+T on Windows and Linux. It is also in the tab menu.

- **Stack** (`core/closed-tabs.ts`, `closed-tabs-store.ts`). Each editor group has its own stack, newest on top, with up to 30 entries (`closedTabLimit`).
  - It lives in window memory for the whole app session, keyed by task, outside the task state that the five-task LRU drops. It is not written to disk.
  - An entry records the tab, its group and its index in the strip. A file also keeps its caret and scroll. A diff keeps its source (changes file, commit, History or PR entry), so the tab can read the diff again.
  - Terminal, browser and simulator tabs never enter the stack.
- **Reopening.** The command takes the newest entry of the focused group. Entries of a group that no longer exists belong to the focused group. A tab that the group already shows again is skipped. The tab returns to its former place in the strip.
- **Availability.** It works with focus in the tab strip, the editor, a diff or anywhere in the task outside a text field, terminal or browser. It is disabled when the stack is empty.

<a id="editor-groups"></a>
## Editor groups (split)

- **Model.** The documents area (the middle column in three columns, `Editor` in two) is a tree of splits (`core/editor-groups.ts`, `editorGroups` in task state). Each leaf is a group with its own tab strip and active tab. The grid is arbitrary: any group can be split right or down again. The flat `documents` / `activeDocument` fields hold the focused group's tabs, so opening files, agent actions, ⌘S, search and the tab menu work on that group.
- **Split and move.**
  - `Split right` / `Split down` open the tab in a new group beside the current one as well. Both views share one buffer and see each other's edits.
  - `Split and move right` / `Split and move down` move the tab there instead. A group's only tab cannot be moved this way.
  - The new group takes half of the split group and gets focus.
  - Other actions: `Move to the other group`, `Unsplit` (the group merges into its neighbour) and `Unsplit all`.
- **Focus.** Only the focused group is live (editor, diff or PR surface). Its active tab has the accent marker. Other groups show their document passively: a file is read-only with code colours, the same header and the same indentation resolution, and a diff uses the same `DiffView`. A passive group's active tab has a `--fg3` marker. The first click in a passive group (document, tab or header) focuses it. A click in code puts the caret at the click point and keeps the scroll. The reason only one group is live: one `EditorState` per buffer, and the cursor, jump target, find state and drafts are kept in task state for one surface.
- **Drag and drop.** Dragging a tab onto a group's document:

  | Drop zone | Result |
  |---|---|
  | right third | new group to the right |
  | bottom third | new group below |
  | elsewhere on the document | into this group |
  | onto a tab strip | at the accent insertion marker |

  A plain drop moves the tab, and `⌥` copies it. The zone is drawn as an accent frame on `--accent-soft`, with a chip reading `Split right`, `Split down` or `Move here`.
- **Last tab.** Closing a group's last tab removes the group, and its neighbour takes the space and focus. The last group remains even when empty; an empty work area hides (see [Task window workspace](task-window-workspace.md)).
- **Boundary.** The boundary between groups is a `ui/ResizeHandle` over the content, taking no layout pixels (`Resize editor groups`). The split ratio lives with the split.
- **No split button.** The tab strip has no split button. Splitting is done from the tab menu, the menu bar or by dragging.
- **Menu bar:** `View ▸ Editor groups`, a submenu under Layout, holds the seven split items plus `Next group` ⌥⇥ and `Previous group` ⌥⇧⇥ (Ctrl+F6 / Ctrl+Shift+F6 on Windows and Linux, where Alt+Tab switches windows). The split items have no default keys and can be bound in the keymap.
- **Lifetime.** Group state lives with the task while the app runs, and it survives hiding the work area.

<a id="new-file"></a>
## New file

- **Entry points:**
  - `New file…` is the first item of the Tools menu, both in the toolbar button and in a group's `+ ▾`;
  - `File ▸ New file…` ⌥⌘N (⌘N is `New task`);
  - in the Files tree context menu: on a folder it creates the file in that folder, on a file in that file's folder.
- **Popover** `New file`. It is a shared `ui/Popover` with a header and `Esc`, anchored to the button that opened it. From ⌥⌘N, the app menu or the tree it anchors to the toolbar's Tools button. It has one mono path field, prefilled with the folder of the active file or the folder selected in the tree, relative to the task root (the worktree), with a trailing `/` and the caret at the end. In a project with several repos, the root repo's name and `/` appear as a fixed lead inside the field.
- **`Enter`** creates the file and any missing folders. It then opens the file in a tab in the group chosen by the `Open in` setting, focuses the editor and shows the work area if it was hidden. The new file is an ordinary untracked Git file, and the Changes panel shows it as usual.
- **Validation** (`core/new-file.ts`, `newFilePath`): `./` and doubled slashes are dropped.

  | Input | Result |
  |---|---|
  | Empty name (empty field or trailing `/`) | `Enter` does nothing; no reason is shown |
  | Absolute, `~`, drive letter or `..` | `The path is outside the task` |
  | `.git` or `.brigadir` in the path | `Not inside .git or .brigadir` |
  | Existing file | `File already exists` with an `Open` button |

  When the field is not focused and shows a reason, it has a 1 px `--red` border.

<a id="jump-to-source"></a>
## Jump to source

`Diff ▸ Jump to source` (`diff-jump-to-source`) is bound to `F4` on every platform and in every keymap. It opens the file of the current diff in the editor, at the line, with caret and focus there and the line centred.

- **Line.** The line is the start of the selection in the diff. Without a selection it is the caret line, then the focused line number, then the first visible diff line. An old-side or deleted line leads to where its block stands in the new file, as with ⌘+click on a number.
- **Works in:**
  - the task diff;
  - a commit diff from Commits or a commit preview;
  - a PR file, when the task tree has a file at the same repo path. The match is exact, checked through `files:links`, and the line is the PR diff's new-side number.
- **Disabled for:**
  - a PR file the task tree lacks;
  - a deleted file;
  - a submodule;
  - History;
  - a passive split group.

<a id="later"></a>
## Later

- Change mark color by author (agent or human) from snapshot attribution.
- A per-project tab width setting for projects without Prettier or `.editorconfig`.
- The other `.editorconfig` keys: `insert_final_newline`, `trim_trailing_whitespace`, `end_of_line`, `charset`.
- A full file-tree watcher. Today the active file is checked on focus, on each checkpoint and every 2 s.
- A default shortcut for `Wrap lines`, and a persistent wrap setting.

<a id="non-goals"></a>
## Non-goals

- Editing inside a diff.
- Autosave, silent merge of disk changes, or a second snapshot writer.
- Starting an agent only to perform a Save.
- Code folding and click-to-add multi-cursor.
- Untitled buffers without a path; a separate "New folder" item (folders come from the file path; Git does not track empty folders).
- Line-author attribution of uncommitted lines to agent turns.
- `git blame` of the live buffer.
- Staging a hunk from the gutter peek: the user's Git index is read-only.
- Rename symbol, quick fixes and code actions in the context menu.
- `Why did this change?` in the editor; attribution lives in the diff.
- An annotation column for blame.
- Pinned tabs.
- Converting line endings as a side effect of formatting or saving.
