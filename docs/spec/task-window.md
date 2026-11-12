# Task window

The task window is everything right of the sidebar while a task (or a project's main tree) is open: one 48 px title strip with the toolbar, and a body of up to three columns — the chat, the work area and the panel (`Files · Changes · PR`). All of its surface state belongs to the task, survives switching tasks and projects, and is written to disk per task. Columns never collapse or switch layout because the window got narrow; they give way to their minimums and then the body scrolls sideways.

<a id="selection"></a>
## Selection and parallel work

- Agents always run in parallel; the window shows **one task at a time**. The sidebar is the only place that shows every agent's state, so its states and the `needs-you` queue must be exact (see [Sidebar](sidebar.md)).
- The unit of selection is `Project → Task`. Everything right of the sidebar follows it: chat, work area tabs, panel, the Files tree and the search scope. There is no "focused pane" concept.
- The title block always names the task and its repo, so a person never comments on the wrong task's code after switching.
- **Focus is never stolen.** An agent that needs the person changes its state to `needs-you`, joins the queue and notifies; it never switches the selection or raises the window. Navigation is the person's: `Next agent needing you` `⌘J`, `Previous agent needing you` `⇧⌘J`.
- Per-task state of the Changes panel (scroll, expanded files, comment drafts, threads) lives with the task, so switching back and forth loses nothing. Diff details: [Diff and review](diff-and-review.md).

<a id="layout-overview"></a>
## Structure

| Part | What it is | Spec |
| --- | --- | --- |
| Title strip | 48 px: title block, Commands, Agents, Search, `…`, Tools, Layout | [below](#toolbar) |
| Chat column | transcript and composer (GUI) or the agent's CLI terminal | [Chat](chat.md), [Composer](composer.md) |
| Work area (`Work area`) | editor groups with file, diff, terminal, browser and simulator tabs | [Task window workspace](task-window-workspace.md), [Editor](editor.md) |
| Panel | `Files · Changes · PR`, one tab visible | [below](#panel) |

- `Two columns` / `Three columns` (`appearance.taskColumns`, default `three`): in three columns the chat is its own column; in two columns there is no chat column and the chat is the pinned first tab of the work area. The main tree has no chat and ignores the choice.
- The `Layout` switch (last in the toolbar) turns the chat, the work area and the panel on and off independently: `View ▸ Layout ▸ Chat ⌘1`, `Work area ⌘2`, `Panel ⌘3`, `Show all`, `Reset column widths`. It is the only visibility control for columns; there is no separate right-side toggle or editor toggle. Details, defaults and the empty state: [Task window workspace](task-window-workspace.md).
- A task without a remembered layout opens with `defaultTaskLayout` `{ chat: true, work: true, panel: false }`; a work area without tabs is hidden, so a new task shows the chat alone. The main tree opens with the work area and the panel (`firstTaskLayout(true)`) and has only those two switches.
- While the work area is hidden its switch shows the number of open tabs, with a dot when one is unsaved. Anything that puts a document on screen (a new tab, another active tab, a diff or file chosen as the surface) shows the work area first (`opensEditor`); closing a tab does not.
- **The window width never changes the layout.** Narrowing the window does not hide a column, collapse one to zero or switch two/three columns; see [Width rules](#width-rules).

<a id="hide-controls"></a>
### Controls that hide

- A control that hides a surface looks like close (`×`, the shared `close` glyph); a chevron is used only for a surface that collapses in the direction it points.
- When a column is hidden while it holds keyboard focus, focus moves to that column's switch in `Layout`; `Space` brings it back.

<a id="title-strip"></a>
## Title strip

- One strip per window, `--strip-h` = 48 px; no repeated app or conversation headers below it. The same token sizes the sidebar header, the project screen header, the title without a task, error placeholders, the client window and sheets that sit under the strip.
- Background `--strip-bg` (= `--win`). On Windows and Linux the OS caption buttons use the same color (`apply-appearance` reads `--strip-bg`; initial `initialChromeColors` `#ffffff` / `#1e1e1e`) and the overlay height `titleStripHeight` 48 in `main/window-chrome.ts`. macOS traffic lights sit at `trafficLightPosition {14, 16}`, centred in the strip.
- The strip is the window drag region (`-webkit-app-region: drag`); buttons are `no-drag`. Padding 14 px; on Windows/Linux the right padding clears the OS controls (`--os-controls-right`).
- The project screen header shortens only the current user's home directory to `~` (`homeDirectory` comes with the workspace snapshot for display only; stored paths are unchanged); the project name is bold, the full path is the hover hint; paths outside home are not shortened.

<a id="toolbar"></a>
### Toolbar

Order, left to right:

| Item | Notes |
| --- | --- |
| Title block | `h1` task title, weight 600, `min-width` 70, ellipsis; second line weight 400 ([repo line](#repo-line)). Main tree: project name, then `main tree · <repo>` |
| Commands | project commands capsule (`ui/SegmentGroup`), [Search, menus and commands](search-menus-and-commands.md) |
| `Agents in work` | `activity` glyph and count (`fg`, 500). Someone waiting: a 6 px yellow dot at the glyph's top-right, the button stays neutral; open: `accent-soft` / `accent`. Popup: [Tasks](tasks.md) |
| rule · `Search Everywhere` (`⇧⌘K`) · rule | 1 px rules; the first only when Commands or Agents show |
| `…` | only when a button left the toolbar ([narrow toolbar](#narrow-toolbar)) |
| Tools | `Task tools` menu, `⇧⌘I`, [Task window workspace](task-window-workspace.md) |
| `Layout` | three switches and `▾` |

- The toolbar carries no change counts: the task's `+N −M` lives on the sidebar card and in the composer environment; turn changes live in the turn footer and turn rail; "unreviewed" is the eye on the sidebar card.
- Captions of toolbar controls (command name, counts, segment labels) are weight 500 in every state, so a selected item never changes width. Menus and popovers opened from the toolbar keep their own weights.
- All controls in the toolbar row share the row size (`data-size`, M 28), see [Appearance](appearance.md).

<a id="repo-line"></a>
### Repo line (second line of the title)

`TaskRepoLine`: one repo chip, `+N ▾` when the task has more than one repo, `· <task state>`, then the task links chip (which shrinks before the repo chip).

- **Repo chip:** project mark (`ui/ProjectMark` monogram in the project color on a 16 % tint, or the project image), main repo name (project root, else the task's first repo), branch (`ui/BranchName`, middle-truncated), `↑N` / `↓N`, lock of a repo held by another task, the task's open PR with its checks state. Hover covers the whole chip.
- **Click:** where the branch is the main tree's branch (main tree, task without isolation) it opens the branch picker ([Git](git.md)); in a worktree task it opens the repo actions (`Push`, `Checks`, `Open on GitHub`, `Create PR…`, `Open first change`), because the picker would switch the project's working tree, not the worktree.
- **`+N ▾` popover:** header `k/n` (repos in the task / repos of the project); repos outside the task are grey with `+` (`Add to the task`); an external folder without git shows `—` for the branch; an unavailable folder is a pale row with `Remove from the task…` disabled. A repo's PR counter stands in the popover row and in the panel root; a repo with the task's open PR shows that PR instead.
- Hit targets are at least 24 px high even where the visual pill is smaller (negative margins keep the row height).
- State words: `Queued`, `Preparing…`, `Working`, `Needs you`, `Done`, `Error`, `Interrupted`, `Rate limited`, `{agent} sign-in needed`, `Backlog`, `Completed task`, `in the archive`.
- The main tree opens from the project's sidebar menu, `Open main tree`; its repos and branches change through the panel roots. Default repos for new tasks are what the `New task` sheet remembers (`launchSettings.save`), see [Tasks](tasks.md).

<a id="toolbar-labels"></a>
### Toolbar labels setting

- `Settings ▸ Appearance`: `Icons only` (default) or `Icons and names`, key `toolbarLabels: 'icons' | 'labels'` in `settings.json`; a document without the field means `icons`. Applies immediately.
- With `labels` and a toolbar at least `headerLabelsMinimumWidth` (860 px) wide the strip gets `data-labels=true` and the title keeps `headerLabelsTitleMinimum` (180 px): buttons leave for `…` before the title drops under 180. Below 860 the setting has no effect; the stored choice is never changed by the width.
- A caption is whole or absent, never partially clipped and never ellipsised; icon-only buttons stay 28 px. The full name is always in the tooltip and accessible name.
- Commands also fold by an older width rule: `minimal` when labels show and the toolbar is under 860 + 160, `compact` under 620, else `full` (`commandsRule`); the narrower of this and the fit step wins (`narrower`).

<a id="narrow-toolbar"></a>
### Narrow toolbar and `…`

`renderer/toolbar-overflow.ts`. Only Commands and Agents can leave; the title, Search, Tools and Layout always stay.

| Step | Commands | Out |
| --- | --- | --- |
| 1 | full | — |
| 2 | compact (no name) | — |
| 3 | compact | Agents |
| 4 | minimal (state glyph and chevron) | Agents |
| 5 | — | Agents, Commands |

- The title shrinks to its minimum (70, or 180 with labels) before any step. Buttons that are absent (module off, no agents) take no step.
- The step is the first whose measured width fits (`fitToolbar`); every shown button is measured, a button that left keeps its last measure, unmeasured ones use `defaultToolbarWidths`. Only the step depends on the width, so there is no feedback loop.
- `…` (`more` glyph) appears only when something is out. Label `More · N`; when Agents are out and an agent needs the person it takes the amber soft tone and the label `More · N · Needs you` (no sign while Agents are in the toolbar).
- Menu: shared `MenuPopover`, title `More`, 250 px, section `Toolbar`, rows in toolbar order with the same glyphs and shortcuts: `Commands`, `Agents in work` with its count (opens the agents popup from `…`).
- Keyboard: `Enter` / `Space` opens with focus on the first row; `↑ ↓ Home End` move; `Enter` / `Space` runs and closes; `Esc` or a click outside closes and focus returns to `…`, except rows that open their own surface. Hover covers the whole row.

<a id="panel"></a>
## Panel: Files · Changes · PR

- One panel, three tabs, exactly one visible; task state `panel: 'files' | 'changes' | 'prs'`, default `changes`. `PR` exists only with the Pull requests module; a stored `prs` with the module off shows Changes and returns with the module.
- **Tabs:** a `Segments` tablist capsule (row M 28) stretched over the panel width, 8 px from its top and sides, no line under it; each segment has a 12 px glyph and its name, `Changes` has the changed file count as a `--fg3` tail; every segment carries `data-panel-tab`. Keys `← → Home End` as in any `Segments`.
- **Open / hide:** `Show files` `⇧⌘E`, `Show changes` `⇧⌘D`, `Pull requests` `⇧⌘P` open the panel on that tab; the same key while the panel shows that tab hides it (`panelShortcut`). `Panel ⌘3` in `Layout` toggles it. `Esc` inside the panel hides it unless a nested control (search, popup, field) consumed it; focus then goes to the Panel switch.
- Background is the window color `--content`; the panel has a 1 px `--sep` left border.
- **Width:** `changesWidth`, 200–500, default 400; handle `Resize files panel`. On `Changes` the panel never goes narrower than its header on one line (`useHeaderMinimum`, measured while the panel is ≤ 360 px; past it the header scrolls sideways). On a narrow panel (< 300 px) the PR header uses short captions; accessible names stay full.
- **Refresh:** `Create snapshot and refresh changes` (refresh glyph) stands in the filter rows of Files and Changes and sends the `checkpoint` command; it is not in the toolbar.
- The Changes tab (Diff / History / Turns modes, base chip, roots, commit strip) is specified in [Diff and review](diff-and-review.md) and [Git](git.md); the PR tab in [Pull requests and CI](pull-requests-and-ci.md).
- Diffs open as work-area tabs, not inside the panel; opening the file from a diff opens a neighbouring tab instead of replacing the diff. The same tab engine serves both column choices.

<a id="files-tree"></a>
## Files tree

The project tree is not a plain folder tree: a project is several git roots (root, submodules, ignored nested repos, worktrees, external folders), see [Projects](projects-and-board.md).

<a id="files-roots"></a>
### Roots

- Each repo of the task is a **root row** of the same list (`PanelRepoRoot`), scrolling with the files; its children are read under `root` (the project root) or `scope:<id>` (`repoFolder`). A nested repo is shown only as its own root, never also as a folder inside its parent. An external folder is a root too.
- A task whose folder is no repo gets a plain root first: the project name and `—` for the branch, no actions.
- Roots collapse with their chevron, a click or `← / →`; the collapsed state is remembered in the task state, separately for Files and Changes.
- `Add folder…` is the last row (tasks only, not the main tree).
- A row that is a scope boundary shows a framed kind badge (`sub` submodule, `⑂` worktree, `⧉` separate repo) and its branch in grey with the branch glyph.

<a id="files-visibility"></a>
### Listing and visibility

- Lazy: children are read on expand and cached; expanded folders are re-listed every 3 s; an unchanged listing keeps the old rows. Heavy folders are never scanned until opened.
- `.gitignore` of the nearest repository is honoured (`check-ignore` once per repository per level), but **known scopes and their ancestors are always visible**, even when the parent repo ignores them.
- `Show ignored files` / `Hide ignored files` (eye button, `aria-pressed`) and the footer `Ignored files are hidden · Show` (`Ignored files are shown · Hide`) list the rest of ignored entries; `.git` and `.brigadir` are never listed.
- A folder lists at most 5000 children; past it the tree says `Not all files are shown.`
- Git status is read with `GIT_OPTIONAL_LOCKS=0` and never touches the index. Domain row type `FileEntry` (`id`, `name`, `path`, `kind: 'directory' | 'file' | 'unavailable'`, `ignored`, `status`, `scopeName`, `scopeKind`); all tree IPC arguments are typed and checked in main.
- A task whose worktree was removed shows `Worktree removed` with a note that the files return when the task continues.

<a id="files-look"></a>
### Row look

- Row 26 px (`--control-h-s` + 2), text Geist 12.5/400, radius 6, 16 px per level, 8 px inset, 14 px disclosure column with a 10 px chevron, 16 px icon. Hover `--hover` over the whole row; selection `--sel` with `--selfg` text.
- Indent guides: 1 px `--tree-guide` under every open folder, `--tree-guide-on` for the folder holding the selection, translucent white on the selected row; drawn over the rows, no layout space.
- **Icons by name** (`core/file-kinds.ts`, names win over extensions): `ts mts cts` TS badge; `js mjs cjs` JS badge; `tsx jsx` React; `json jsonc json5` `{}`; `md mdx` `M↓`; `Dockerfile*`, `.dockerignore` whale; `.git*`; `.env*`; `*rc`, `.editorconfig`, `.buckconfig`; `yml yaml toml`; images (`png jpg jpeg gif webp svg ico icns`); `sh bash zsh` `>_`; `*.lock`, `pnpm-lock.yaml`, `package-lock.json`, `bun.lockb` lock; everything else grey lines. Folders: outline in `--fg2`, the same open or closed; `node_modules` in `--ft-lib`. Colors are semantic `--ft-*` tokens with light and dark values, independent of the accent; a selected row inverts the badge.
- **Git status colors the name:** modified and renamed `--accent`, added and untracked `--green`, deleted `--red`, conflict `--amber`; a folder takes the color of changed descendants; ignored names `--tree-ignored`. A changed file also ends with its letter `M A D R U C` (`fileStatusLetters`), the state name in its tooltip; the state is in the row's `aria-description`.
- The filter row: magnifier inside the field, the Find key hint inside on the right, then refresh and the eye; 8 / 8 / 6 px padding, 2 px between field and buttons.

<a id="files-interaction"></a>
### Interaction

- Click selects; double-click or `Enter` opens the file in the work area; `↑ ↓ Home End` move; `→` opens a folder or steps in, `←` closes or steps out; typing letters jumps by name (750 ms typeahead). Keyboard moves in the virtual list restore focus once the target row mounts.
- The editor's Find key focuses the filter while the tree has focus. The filter searches the bounded project index (`searchFiles`), not only expanded folders; results show paths with the same icons; `Esc` clears it; a skeleton shows while searching, then `No results`.
- Selection, filter, show-ignored, expanded folders and scroll position are parked per task.
- **Drag** a file or folder into the GUI composer or the CLI terminal: it adds the same immutable text attachment with an explicit file/directory reference as `To composer`; the drag carries only an opaque id and the task's own `TaskKey`; main resolves the path; an unsaved buffer is never passed off as the saved file. In the CLI the reference goes through the hook context queue.
- **Context menu** (native, `files:menu`): `Open in editor` (files only), `New file…`, `To composer`, `Open terminal here`, `Copy relative path`, `Copy absolute path`, `Reveal in Finder` (`Show in file manager` off macOS), —, `Delete…` ([Delete](#files-delete)). Main resolves the registered id and checks `safePath` on every action; the terminal starts through the task host in the file's folder (or the selected folder), the host re-checks the project-relative cwd and refuses symlinks and service folders; no shell `cd` interpolation; the agent's cwd is unchanged.

<a id="files-delete"></a>
### Delete

- **Entry points:** `Delete…` in the tree's context menu; `File ▸ Delete…` with `⌘⌫` on macOS and `Delete` on Windows and Linux, active while the focus is on a file or folder row of the tree; `Delete` (forward delete) on a selected row on macOS too. Repo roots and unavailable rows have neither.
- **Confirmation** (`files:delete`, a native warning dialog): `Delete {name}?`, detail `The file goes to the Trash.` or `The folder and everything in it go to the Trash.`, buttons `Cancel` (default) and `Delete`.
- The file or folder goes to the system Trash (`shell.trashItem`), never `rm`. Main resolves the registered id and checks `safePath`; it refuses the task root, a repo root (a folder with its own `.git`), anything inside `.git` or `.brigadir`, and a read-only file outside the project.
- A checkpoint follows, so the tree and Changes show the deletion at once; the deleted file is an ordinary Git deletion. A failure shows the toast `Could not delete «{name}».`
- Selection moves to the next row (or the previous one at the end of a folder) and the tree keeps focus.

<a id="surface-state"></a>
## Surface state belongs to the task

**Rule.** What a task shows is the task's: returning to a task shows it exactly as it was left; a new task starts clean and inherits nothing.

| Belongs to the task (`TaskState`) | App-wide |
| --- | --- |
| editor groups, tabs and active tab; tool tabs | `taskColumns` (two / three columns) |
| `chatShown`, `workShown`, `panelShown`; `panel` tab and Changes mode | `sidebarWidth`, `browserWidth`, `simulatorWidth` |
| transcript scroll, Files tree state, Changes scroll and drafts | review modal widths, `composerCapsuleCompact`, `sidebarSection` |
| `widths` override of `chatWidth`, `changesWidth`, `consoleHeight` | defaults for those three widths |

- **Parking, not rebuilding.** Each task's store lives in memory keyed `projectId/id`; returning reuses the same instance, so editor buffers, pages and terminals never die. The 5 most recently opened tasks are kept; a task with a composer draft, attachments, a review or comment draft, or an unsaved or saving buffer is never evicted. An evicted task first writes its surface, then its browser views are discarded, its consoles closed and its editor files released.
- On return the transcript is re-read from the journal, which stays the single source of truth (no "already applied" counter).
- **On disk:** each task's `surface.json` (written 500 ms after a change to a persisted field, and at once before the window closes): `editorGroups`, `documents`, `activeDocument`, `chatShown`, `workShown`, `panelShown`, `panel`, `changesView`, `toolPlace`, `bottomUnderChat`, `chatTab`, `widths`, `changeRange`, `terminalRestored`, `commitDiffs`. Reopening and hot exit: [Task window workspace](task-window-workspace.md).
- Dragging a width sets both the task's override and the default in `surface-layout.json`; `Reset column widths` restores the defaults and clears the task's overrides.

<a id="width-rules"></a>
## Width rules

| Key (`layoutLimits`, `core/layout.ts`) | Range | Default |
| --- | --- | --- |
| `chatWidth` | 380–8000 | 420 |
| `changesWidth` | 200–500 | 400 |
| `consoleHeight` (bottom group) | 120–600 | 260 |
| `sidebarWidth` | 220–480 | 280 |
| `browserWidth` | 420–8000 | 460 |
| `simulatorWidth` | 360–800 | 460 |
| `reviewFilesWidth` / `reviewColumnWidth` | 180–480 / 280–600 | 220 / 340 |
| `noteChatWidth` ([note chat](notifications-slack-notes-and-schedules.md#note-chat)) | 300–8000 | 352 |

8000 only rejects a broken file; the real ceiling is the window. `isSurfaceLayout` validates the file; an unreadable one falls back to `defaultSurfaceLayout`.

- **Minimums:** chat 380 (`chatMinimum`), work area 400 (`workAreaMinimum`), panel 200 or its Changes header (above). Hidden columns weigh nothing.
- **Chat ceiling** (`chatCeiling`): task body width − (400 + 1) − (open panel at its wished width, at least its header minimum, + 1), never below 380. The panel counts at its wish, not as drawn, so dragging the chat narrows only the work area and stops at its 400.
- **A saved width is a wish.** It is drawn clamped to the space available and stays unchanged on disk; when room returns, the width returns.
- **Handles work from the drawn width:** drag start, `aria-valuenow`, `aria-valuemax`, `End` and arrows start from what is visible, so there is no dead zone past the ceiling.
- **Narrow window, three columns:** the chat and the panel give way proportionally to their widths, each down to its minimum, before anything scrolls; the work area keeps its 400. Only when even the minimums do not fit does the task body scroll horizontally (`.body[data-columns='3']`, `overflow-x: auto`). No column collapses to zero and the layout never switches.

<a id="resize-handles"></a>
### Resize handles and column borders

- `ui/ResizeHandle` is the one accessible separator for every column and the bottom group: pointer drag plus arrows, `Home` (minimum) and `End` (maximum). The width is saved when the drag or key change ends (`onCommit`), not on every pointer move; main writes only the bounded numbers to `surface-layout.json`.
- The handle has **zero width in the layout**. Between columns only the column's own 1 px `--sep` left border shows; every column to the right of a neighbour carries it (in three columns the work area beside the chat too).
- Its grab zone lies over both neighbours, 4 px each side, cursor `col-resize` / `row-resize`. Over the native browser view only the DOM side catches events.
- A 2 px `--accent` line shows exactly on the border on hover and keyboard focus only.
- **Rule for new chrome:** a service element (handle, divider, drop zone, scrollbar) takes no layout pixels and has no background; if it must be visible, it is drawn over the content and only while interacting.

<a id="tab-strips"></a>
### Tab strips

- Tab strips (work-area groups, PR files, console tabs) have no visible scrollbar (`scrollbar-width: none`, `::-webkit-scrollbar { display: none }`): Chromium cannot make the overlay scrollbar click-through, and it covered the close buttons.
- Scrolling stays: trackpad horizontally; a vertical mouse wheel over an overflowing strip scrolls it sideways (`useTabStrip`); a non-overflowing strip does not capture the wheel.
- The active tab (new, clicked, or chosen with `⌥⌘← / →`) slides into view at the nearest edge; only the strip scrolls, never its ancestors. With `fade` the strip marks hidden edges (`data-fade="start" | "end" | "both"`) with a gradient.

<a id="window-menu"></a>
## Window and File menu

- `File ▸ Open a project…` `⌘O`, `Recent projects`, `Close task` `⇧⌘W` are always available, so a project can be switched at any time.
- `Recent projects` keeps up to 20 canonical paths in `recent-projects.json`. Reopening a known path returns the existing project id (no duplicate project). A missing folder keeps its history entry; the person can pick another folder in the native picker. `Clear recent projects` clears only the history. The menu is rebuilt through Electron's public API.
- On macOS the menu lives on without a window: after the window closes, a global command opens a new window and is delivered once the renderer subscribes; task-context commands of the previous task are unavailable.

<a id="later"></a>
## Later

- Toolbar indicator `N ✎` of unsent review comments beside the Layout switch (hidden at zero).
- Rename and delete in the Files tree context menu (destructive operations over a working agent need their own conflict rules).
- Icons for formats beyond the current set (css, html, swift, kotlin, python…).
- Files tree marker "touched by this task's agent", separate from git status, from attribution.
- An explicit separate "Working tree" view of changes that predate the task.

<a id="non-goals"></a>
## Non-goals

- Automatic layout changes on resize (hiding the panel or work area, switching two/three columns, collapsing a column to zero).
- Several tasks visible side by side; one task window shows one task.
- Change counts or other state-driven variable-width items in the toolbar: the toolbar's geometry changes only from the person's explicit settings.
- An eager scan of the whole project to list one folder; `git status` that updates the index.
