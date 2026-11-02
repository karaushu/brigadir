# Task window workspace and layouts

The middle column of a task window is the **Work area**: editor groups whose tabs hold files, diffs, terminals, browser
pages and the simulator alike, opened from one **Tools** button. A **Layout** switch shows or hides the chat, the work
area and the panel. The task window is saved per task and reopens as it was closed. An empty work area is never shown.
In the optional two-column layout the chat becomes a pinned tab of the work area.

Column geometry, the title strip and narrow-window rules are in [Task window](task-window.md). Editor groups
(split, drag, group menu) are in [Editor](editor.md). The content of each tool is described in
[Terminal, console and agents in the CLI](terminal-and-cli-agents.md) and [Browser and simulator](browser-and-simulator.md).

<a id="work-area"></a>
## Work area

- The middle column is called `Work area`. "Editor" names only a code document and the settings section. "Workspace"
  is not used for this column because it already names the Projects and tasks screen.
- Terminals, browser tabs and the simulator are **tabs of editor groups**, the same as files. There are no separate
  browser, simulator or console columns. The console at the bottom is an ordinary bottom group: its tabs, splits and
  height work like those of any other group. A tool tab can be dragged into another group, next to a file.
- A tab shows the same tool content that a dedicated column used to show: the browser's address and action bars, the
  terminal grid, the simulator device.
- Group tab strips are 32 px high (the shared tab strip component).

<a id="tools-menu"></a>
### Tools button and menu

The toolbar has one **Tools** button (`Task tools`). It is not a split button. It shows a glyph, the number of open
tool tabs, an agent dot and `▾`. The menu is a shared `ui/Popover` menu (`ToolsMenu.tsx`):

| Item | Key | Notes |
|---|---|---|
| `New file…` | `⌥⌘N` | Opens the New file popover at the button ([Editor](editor.md)) |
| `New terminal` | `⌃⇧\`` | Works anywhere in a task, not only with the console focused |
| `New browser` | `⇧⌘B` | Only when the browser module is on |
| `Simulator` | `⇧⌘M` | Only when the simulator module is on |
| `Open · N` | — | Every tool tab of the task across all groups. A click reveals the tab, even when the work area is hidden. Browser rows show the agent dot |
| `Where to open`: `In the focused group` (default) · `In the bottom group` | — | Radio. Saved per task (`toolPlace`) |

- `⇧⌘I` (`View ▸ Tools…`) opens the menu.
- `⇧⌘B` (`View ▸ Browser`), `⇧⌘Y` (`View ▸ Terminal`) and `⇧⌘M` (`View ▸ Simulator`) jump to the last tab of their kind
  and open a new one when none exists. `⇧⌘Y` is disabled in the project's main tree, which has no task terminal.
- The toolbar has no separate Console, Browser or Simulator buttons.
- On Windows and Linux, browser DevTools uses `F12`, because `Ctrl+Shift+I` opens Tools.
- Toolbar order: task name · commands · agents · search · `Tools ▾` · `Layout`. The overflow `…` holds only commands
  and agents. At the 820 px minimum window width it appears only when a command name is long.

<a id="browser-tabs"></a>
### Browser tabs and the agent

- A task can have **any number of browser tabs**, and each tab is its own view. Caching and freezing are described in
  [Browser and simulator](browser-and-simulator.md): at most 10 live views per app, frozen 60 s after the agent's
  last action, and inactive tabs always frozen except during those 60 s.
- An agent works in **its own tab**. The first `browser_open` creates the tab and later calls navigate it.
  `tab: "new"` creates another tab. Every `browser_*` tool takes an optional `tab`, and `browser_state` lists the task's
  tabs (address, title, whether the agent opened it, whether it is on screen). `browser_show` brings the agent's tab
  to the front. The agent has one clipboard per task, not one per tab.
- A new agent tab is added to a group. If the task is on screen, the tab opens in front and the call waits for it for up
  to 3 s. An existing tab stays where the person left it, and the agent works with it from the invisible window. An agent
  call **never shows a hidden work area** (see [Empty work area](#empty-work-area)).
- The project has one simulator, and every simulator tab shows the same device.

<a id="agent-tab-state"></a>
### Agent state on a tool tab

| State | Tab | `Open · N` row and Tools button |
|---|---|---|
| Agent acting | Accent spinner instead of the glyph, label `agent`, tooltip with the current action | Agent dot |
| Agent acted in the last 60 s (page still live) | Normal glyph and an accent dot | Agent dot |
| No agent | Normal tab | — |

While the agent is working with an open tab (until 60 s after its last action), the tab shows the following:
- a bar above the page reading `Agent in the browser · <action>`, with an action counter and an `In chat` button that
  scrolls to the agent's tool rows;
- an accent frame around the page;
- the action ring with its caption (for example `click · Save`).

The page returns from the invisible window without reloading.

<a id="agent-yields"></a>
### Person and agent on one page

The agent's mouse goes through CDP and never moves the person's pointer, so only focus and typing can clash. There is no
pause button and the agent never stops (`main/browser-yield.ts`):

- When the person types in the agent's tab or holds a mouse button (to select or drag), the host holds the agent's
  **next** action until 1.5 s pass with no such input (`yieldQuiet = 1500`). Scrolling and hovering do not hold it.
- While the action is held, the bar shows `The agent is waiting until you finish` and no ring is drawn.
- If the input goes on without a break for more than 10 s (`yieldLimit = 10_000`), the action is returned undone with
  "The person is working on this page…". The agent decides whether to retry or do something else.
- A reply that comes after a wait says the person interacted with the page, and gives the new URL or title if they
  changed.

<a id="native-page-snapshot"></a>
### Native page under overlays

The page is a native view drawn over the DOM. When a popover, dialog or toast is open over it, or a tab or group border
is being dragged, the live view is removed from the window. A snapshot (`capturePage`, about 15 ms) is shown in its
place as a plain `<img>`. Drop zones, menus and toasts draw on top of the snapshot, so a page never leaves a hole under a
menu.

<a id="bottom-group-under-chat"></a>
### Bottom group under the chat

- The work area's bottom group can **stand under the chat** column, which shows the chat and, for example, the agent's
  page together. This works with the work area visible (it then shows its other groups) or hidden.
- To move the group there, use either of these:
  - the tab menu check item `Under the chat`;
  - drag a tab of the bottom group onto the chat column. The whole column is one target, and its lower half becomes a
    drop zone with the chip `Under the chat`. Dropping moves the **whole group**, not only the tab.
- To move it back, drag a tab of the group onto the work area. The whole work area is one target, with a lower-half zone
  labelled `Work area`, and the group becomes the bottom group again.
- While a tab is dragged out from under the chat, the work area's group documents do not accept it; their tab strips do.
  The document of the group under the chat accepts no tabs, because a split there would take it out from under the chat.
  Only its tab strip accepts tabs.
- Drag visuals are shared with group drags (`DropZone`, `GroupDropTarget`, `ColumnDropTarget` in `EditorGroups.tsx`).
  The dragged tab dims to 0.4 and a ghost card (glyph and name) follows the cursor.
- The group's width is saved as `widths.bottom`. The setting is `bottomUnderChat`.
- The group is not available in two columns (see [Two columns](#two-columns)).

<a id="terminal-close"></a>
### Closing a terminal tab

`×` asks `Stop this terminal process?` only when closing would stop something:
- A console is `busy` when the tty's foreground process (`IPty.process`) is not the shell the PTY started. A PTY that
  cannot name its foreground process falls back to an open command block (OSC 777).
- A project-command tab asks while its process is alive.
- `×` re-reads the host list and applies `closeAsks` (`core/terminal.ts`). A shell at its prompt, or a tab that has
  exited, closes without asking.
- If the host does not report `busy` (an older host) or the list fails, the tab asks.

Why: a prompt shown on every close teaches people to click `Stop` without reading. Command blocks alone are unreliable
under `ssh`, `sudo -s`, nested shells or `exec`.

<a id="tool-tab-look"></a>
### Tool tab details

- **Console.** The command row (line, port, Restart, Stop) uses the panel color. The output below it uses `--term`. Strips
  above and below the output (`Exit N · name`, `Stopped manually…`, `Session ended`, `Stop this terminal process?`) are
  S rows, 32 px high: 12 px left inset, last button 6 px from the right edge, 12 px text. Their `×` is a square soft S
  `IconButton`, and `Stop` in the question is solid red. The `Exit N` row of an exited shell is amber and 30 px high.
- **CLI-task terminal** (`TerminalPanel`, role `agent`) uses the same `--term` tone as the console (light `#F6F6F7`,
  dark `#141414`) in the xterm theme and behind it. The host answers the CLI's `OSC 11` with the same color
  (`terminal-colors.ts`).
- **Browser.**
  - The address bar uses the panel color, and only the field is tinted. A tab with no page is `New page`, with an empty
    address (not `about:blank`).
  - `Mobile` is a 390 px viewport centered in the tab with `--tint` margins. A narrower tab shows it full width. The
    touch cursor is Chromium's own, so the app draws none.
  - The last-failure strip matches the console's (32 px, `×`). A page error is a row under the strips with a `--hair`
    line.
  - In the drawer, entries and request rows are 28 px on hairlines. `Show the agent` is an S button at the start of the
    row. An open console or network button with errors stays red. An empty `…` is not shown.
  - **Address without scheme.** At rest the field shows the address without `http://` / `https://`
    (`localhost:5173/loyalty`). A bare host has no trailing `/`, and `?` and `#` are kept. Other schemes (`file://`,
    `data:`) show in full. A focused field (click, `⌘L`, new tab) shows the full address and selects it. Enter without a
    scheme adds `http://`. No lock glyph is drawn (`displayAddress`, `browser-tabs.ts`).
- **Simulator.**
  - The device picker is a ghost `Popup` trigger: `tint` on hover and while open, no ring, and ✓ by the selected device.
    Groups are `iOS` / `Android`.
  - A running device shows a green dot. Its row ends with a 24 px `quit` button (`Shut down <device>`) that shuts down
    that device without changing the project's selection (`shutdown` carries `device`).
  - Keyboard: `→` or `Tab` moves to the row's button; `Enter` / `Space` shuts the device down; `←`, `⇧Tab`, `↑` / `↓`
    return to the list; `Esc` closes.
  - The `Metro is not running` strip is 32 px high, with `Commands…` 6 px from the edge.
- **PR file tab.** The `From the summary…` / `Definition of…` breadcrumb is a 32 px S row. `The file could not be read.`
  is 36 px high, with `Retry` 6 px from the edge.
- **Surface crash screen.** Actions on a surface are S (24). Actions on the window are M (28).

<a id="layout-switch"></a>
## Layout switch

`Layout` is the last control in the toolbar (`LayoutSwitch.tsx`). In three columns it is a flat capsule of three
independent on/off switches (`ui/Controls` `Switches`), **Chat**, **Work area** and **Panel**, followed by `▾`. Each
switch toggles its own column. It does not switch between columns.

| Rule | Behavior |
|---|---|
| Glyph | A window frame with two dividers. The switch's own column is filled when it is on. Only the fill shows the state, and the capsule is not raised |
| Glyph color | One opaque color with opacity on the whole glyph (`#fff` · 0.55 dark, `#000` · 0.5 light; hover 0.87 / 0.85, as `--fg2` / `--fg`). The fill sits under the frame, and a column that is on takes over its adjacent dividers (no light seams) |
| Any column may go | Chat, work area and panel each turn off, and all three can be off together. With neither the chat nor the work area visible, the task shows its [empty state](#empty-state) |
| Hidden work area | Its switch shows the number of its tabs. The number is amber when a tab has unsaved changes |
| Empty work area | Turning it on opens Tools instead ([below](#empty-work-area)) |
| `▾` | 18 px wide, below the 24 px target size (marked `data-allow-small`) |
| Main tree | Only two switches, `Work area` and `Panel`. Both turn off |

- **Shortcuts** (`View ▸ Layout`): `⌘1` Chat, `⌘2` Work area, `⌘3` Panel, then `Show all` and `Reset column widths`.
  The Projects and tasks screen (`Workspace`) and `Kit` use `⇧⌘1` / `⇧⌘2`. On the Notes screen `⌘1` is the note's chat.
- **`▾` menu:** `Two columns` / `Three columns` (radios with fixed `layout-two` / `layout-three` glyphs), a separator,
  `Chat ⌘1`, `Work area ⌘2` (with `· N` when hidden) and `Panel ⌘3` as check items, a separator, `Show all` and
  `Reset column widths`.
- `Show all` turns on all three columns. Without work-area tabs it shows the chat and the panel only.
- `Reset column widths` resets the task's own widths and the default widths.
- The switch replaces the editor button, the right-side toggle, the two-column `Chat / Editor` segment and the old
  two/three-column setting. The layout is just the state of the three switches, and it is saved per task.
- The sidebar toggle in the sidebar header uses the same kind of glyph: a frame with the left column filled.
- The toolbar row has a single height (control size scale, see [Appearance](appearance.md)).

<a id="default-layout"></a>
### Layout of a new task

- A task with no saved layout starts as `defaultTaskLayout = { chat: true, work: true, panel: false }`
  (`core/task-layout.ts`). Because a new task has no tabs, the work area is hidden, so **a new task opens with the chat
  only**. The work area appears with the first opened tab, and the panel opens through its switch, `⌘3`, `⇧⌘E`, `⇧⌘D` or
  `⇧⌘P`.
- The main tree (`firstTaskLayout(true)`) opens with the panel on, because it has no chat and has room.
- Tasks with a saved layout open with it.
- Why the panel is off: the chat (380), the work area (400) and the panel (400 default width) plus the sidebar do not
  fit a 1280 px window. The panel's minimum is lower (200), so the three columns still fit when the panel is turned on.

<a id="panel-tabs"></a>
### Panel tabs

`Files · Changes · PR` live in the panel header, not the toolbar. They are a full-width `Segments` capsule above the
panel's mode header (`Changes / History / Turns`, `Pull requests · CI`). `Changes` carries the number of changed files.
`⇧⌘E` (Show files), `⇧⌘D` (Show changes) and `⇧⌘P` (Pull requests) open the panel on their tab. Pressing the same key
again hides the panel. See [Task window](task-window.md) for the panel itself.

<a id="empty-work-area"></a>
## Empty work area

The work area is **empty** when none of its groups has a tab. This counts document groups and the bottom group while it
is in the work area, but not a group standing under the chat (`workAreaTabs`). In a task, an empty work area is never
shown (`fitWorkArea`, run after every change in `renderer/task-state.ts`).

| Event | Result |
|---|---|
| Last work-area tab closed | The work area hides and the chat takes the width. Nothing else comes back: with the chat and the panel off, the task shows its empty state |
| Task restored with no work-area tabs, or a new task | Opens with the work area hidden |
| Person opens something | The work area shows again. This covers a file from the tree, Search Everywhere / `⌘P`, a diff from the panel, a terminal, browser or simulator from Tools or its shortcut, go to definition (`⌘+click`), a link from the chat and `New file…` |
| Agent adds a tab (its browser tab, or a command tab started in the background) | The tab joins a group. A hidden work area **stays hidden** and its switch shows the tab count |
| Work area switched on with no tabs (switch, `⌘2`, `View ▸ Layout ▸ Work area`) | Opens the Tools menu under the toolbar's `Tools` button (`opensToolsInstead`). The chosen item shows the work area with that tab, and `Esc` keeps it hidden |
| Last tab closed while a group stands under the chat | One empty group above the bottom group holds the place. The work area hides, and the next file opens in that group. A bottom group dragged back takes that place |

- No new state is written: visibility is the stored `columns.work`, and emptiness is computed from the groups.
- `Select a file` remains only in the panel's diff list (files exist but none is selected) and in the tab of a disabled
  module. A group with no tabs disappears, so there is never an empty group among other groups.
- **Review panel.** When the work area is not visible (empty or switched off), a non-empty review stands under the chat.
  With neither the chat nor the work area visible, it stands under the task's empty state. It never disappears. See
  [Diff and review](diff-and-review.md).
- **Main tree.** A work area with no tabs is **not** hidden. It shows the [empty state](#empty-state) (variant
  `main-tree`). The panel keeps its usual width, and the quick-task field (`New quick task`) stays at the bottom of the
  work area. The work-area switch only toggles it (no Tools menu), and when it is off the same empty state holds its
  place.

<a id="empty-state"></a>
### Empty state

One component (`renderer/EmptyPlace.tsx`, rows `ui/ActionRow`) is used in two places: the main tree's work area without
tabs (`main-tree`), and a task with both the chat and the work area off (`task`, which also applies when everything is
off). Its layout:

- the helmet glyph, 44 px, `--fg3` at 0.6 opacity;
- 18 px below it, a 248 px column of M rows (28 px, radius 6, 1 px apart). Each row has a 14 px `--fg2` glyph, a 12 px
  `--fg` name and an 11 px `--fg2` shortcut on the right. Hover fills the whole row with `--tint`.

| Variant | Rows |
|---|---|
| `task` | `Show the chat` `⌘1` (the chat column glyph) · `New file…` `⌥⌘N` · `Open Quickly…` `⌘P` |
| `main-tree` | `New file…` `⌥⌘N` · `Open Quickly…` `⌘P` · `New browser` `⇧⌘B` (only with the browser module on) |

Each row runs the same command as its menu item. `New file…` opens its popover next to the row. An enabled panel stands
beside the empty state at its usual width. Turning off the last column loses nothing: groups, tabs and widths come back
with the first column turned on, and `surface.json` keeps "all off" across a restart.

<a id="restore-window"></a>
## Reopening the window as it was closed

Each task stores its window in `surface.json` in the task folder (`main/surface.ts`, schema `core/surface.ts`,
`surfaceSchemaVersion = 1`, written atomically as sorted, pretty-printed JSON).

<a id="surface-json"></a>
### `surface.json`

| Field | Content |
|---|---|
| `groups` | `root` tree of `group` (`tabs`, `active`) and `split` (`direction` `right`/`down`, `ratio` 0.05–0.95) nodes; `focused`; `next` |
| `columns` | `chat`, `work`, `panel` booleans (the Layout switches) |
| `widths` | `chat`, `panel`, `bottom` (the group under the chat), px |
| `panel` | `tab` (`changes`/`files`/`prs`) and `mode` (`diff`/`history`/`turns`) |
| `toolPlace` | `focused` / `bottom` (Tools ▸ Where to open) |
| `bottomUnderChat` | Bottom group under the chat |
| `chatTab` | Two columns: the pinned Chat tab is shown (absent means it is shown) |

| Tab `kind` | Stored |
|---|---|
| `file` | `path` and `place` (caret anchor/head as line/column, `scrollTop`, `scrollLeft`) for every file tab |
| `diff` | `scope`, `path`, `range`. One change range per task (`changeRange`) is written into every diff tab and restored from the first. A missing file shows an empty state |
| `terminal` | Host `session`, `title`, `directory` (folder inside the task, `null` for its root) |
| `browser` | `tab`, `title`, `url` (`http(s)` or empty), `mobile` |
| `simulator` | `title`, `device` |

- **Write path.** The renderer sends the group tree with tab identities (an opaque file id, a session, a browser tab).
  Main replaces the file ids with paths and adds what only it knows: the terminal folder (`TerminalInfo.directory` from
  the host), the page address, title and mode, and the simulator device. Without a live host or view it keeps the last
  written value. Writes happen 500 ms after a change (`surfaceDelay`) and immediately before quitting, through one write
  queue per task, and quit waits for all queues.
- **Read path.** Paths become opaque ids again. A file that no longer exists drops out of its group, and a group left
  without tabs disappears.
- **Not stored:** a commit or PR diff (`history:…`), a read-only file outside the project, a plan copy, and the
  project's main tree (it has no task folder).
- **Foreign schema.** A file with another `schemaVersion` is neither read nor overwritten, even when another copy of the
  app wrote it meanwhile.
- **Widths.** Dragging a border changes both the task's width and the default in the shared `surface-layout.json`. A
  task without its own widths uses the defaults.
- Window size and position (`x`, `y`, `width`, `height`, `maximized`) are stored as `window` in `surface-layout.json`,
  next to `sidebarWidth` ([Sidebar](sidebar.md)).

<a id="restore-tabs"></a>
### What each tab restores

- **Terminal.** Reconnects to the live host session. Consoles get `SIGHUP` on quit, so after an app restart each
  console comes back as `Session ended · Open again`. A live session is picked up after a window reload or crash
  recovery. `Open again` opens a clean shell in the same folder in place of the tab. This also applies to a project
  command tab: **commands never rerun after a restart**.
- **Browser.** Comes back as a tab with its address and title. The page loads only when the tab is activated.
  - **Desktop / Mobile belongs to the tab** (`main/browser-modes.ts`, keyed by task#tab). The toolbar segment changes
    the active tab only. The mode survives cache eviction and restart.
  - A mode change rewrites the task's `surface.json` at once (`TaskSurfaces.refresh`), because the mode is known in
    main, not in the renderer.
  - A new tab opens in Desktop: pages cannot open windows (`setWindowOpenHandler` → deny), and new tabs come only from
    Tools, `⇧⌘B` or the agent. A closed tab forgets its mode.
  - Agent `browser_*` calls never change the mode.
  - The old app-wide `browser-preferences.json` is read once to seed the restored tabs and is then deleted.
- **Simulator.** Restores the device. The project has one device (`project.json`).

<a id="hot-exit"></a>
### Unsaved buffers (hot exit)

- Quitting (`⌘Q`, update, restart) and closing a window, including on macOS when the app keeps running, **do not ask**.
  Each dirty buffer's text, undo, selection and scroll go into the task's `drafts/` folder. Each draft is a file named
  by a hash of its path, never by the path itself. After the restart the tab reopens with the same unsaved text and its
  dot. If the file changed on disk meanwhile, the normal write conflict applies ([Editor](editor.md)).
- A draft is deleted from disk as soon as its tab reads it. Drafts are written only before a window closes, not on each
  keystroke, so a crash loses unsaved text.
- Closing a **tab** still asks to save or discard (`There are unsaved changes.`).
- The window dialog (`Keep editing` / `Discard changes`) remains only for buffers that hot exit cannot keep:
  - a main-tree file (no task folder);
  - a buffer larger than 8 MiB (`draftTextLimit`);
  - any buffer in a window that did not answer within 2 s.

  The dialog lists only those files, and it also appears on quit. `Keep editing` removes the drafts just written for
  that close.

<a id="restore-order"></a>
### Start-up order

- The app opens on the last task ([Sidebar](sidebar.md)) and reads `surface.json` only for the task it shows. Other
  tasks read their file when they are opened.
- The selected task (`sidebar.json`), its `surface.json` and `surface-layout.json` are read together with the workspace
  snapshot (`preloadSurface`, at most 1.5 s). The task store created after that takes the surface synchronously, before
  the first render, so no frame shows the default layout. Until then the content area is blank, as during workspace
  loading.
- A preloaded surface whose task was never shown returns its drafts to `drafts/` on close.
- The window reopens where it was as long as a connected display shows at least 100 × 60 px of its top strip.
  Otherwise it is centered on the primary display (`fitWindowBounds`, minimum 820 × 560). A maximized window is maximized
  again, except in a background launch. A `--secondary` instance takes only the size.

Why: a restart (update, crash, rebuild) used to lose the whole working layout. Loading browsers lazily keeps start-up
fast and memory within the view cache.

<a id="two-columns"></a>
## Two columns: the chat as a pinned tab

The app setting `taskColumns` (`two` | `three`, default `three`) chooses the task layout. It is set only by hand, never
from the window width. The setting appears in these places:
- `Layout ▾` and `View ▸ Layout` (radios with glyphs);
- `Settings ▸ Appearance ▸ Task layout` (`Chat as a column` / `Chat as a tab`), which Search Everywhere finds;
- the intro's Appearance step, as cards. The intro's Editor and Modules steps always show three columns.

The main tree has no chat and ignores the setting.

<a id="pinned-chat-tab"></a>
### Pinned Chat tab

- The chat is the first tab of the work area's first group (`chatGroup`): labelled `Chat`, with no `×`, not draggable
  and never scrolled away. A thin divider separates it from the file tabs. The file tabs scroll under it, with edges
  fading into a gradient. Without file tabs the strip shows only `Chat` and `+ ▾`, with no divider, and a group with no
  tabs also shows the chat.
- When open, the Chat tab fills its group, with the transcript and composer centered at up to 760 px. Splits beside it
  remain. The panel is on the right as usual.
- The work area is always on screen (`twoColumnsLayout`: `chat: false, work: true`, panel as stored). The task's own
  `chat` / `work` values are kept for three columns, so switching back restores the same layout.
- `chatTab` in `surface.json` stores whether the Chat tab is selected. The chat is hidden only when the person picks a
  document in the first group (`chatTabAfter`). Closing a tab, a split, a resize or a quiet agent tab (background
  browser or command) does not hide it.
- The group under the chat is unavailable, and that group returns to the work area.

<a id="chat-tab-state"></a>
### Chat tab state while a file is shown

| `ChatTabState` | Look |
|---|---|
| `idle` | `chat` glyph |
| `running` | Spinner |
| `waiting` (agent needs the person) | Amber `agent-permission` glyph and amber dot |
| `unread` (a turn ended while the chat was not on screen) | Accent dot; cleared when the chat is shown (`chatUnreadAfter`) |

An agent request that arrives while a file is shown appears as a row above the document, the same one used when the
chat is hidden: `Deny` · `Allow` · `Open chat`. `Open chat` also appears in three columns when the chat is hidden.

<a id="two-columns-controls"></a>
### Controls in two columns

- `Layout` is one button showing the current layout glyph, plus `▾`. Both open the menu. The glyph is `layout-two-panel`
  (panel column filled) when the panel is open and `layout-two` when it is hidden.
- Menu: `Two columns` / `Three columns`, separator, `Panel ⌘3` (check item; its glyph follows the panel state), separator,
  `Reset column widths`. `View ▸ Layout` mirrors this and keeps Chat, Work area and Show all hidden with their keys
  working (`acceleratorWorksWhenHidden`).
- Shortcuts (`twoColumnsShortcut`):
  - `⌘1` always selects the Chat tab, and pressing it again does not hide it.
  - `⌘2` returns to the document the group showed before the chat, or opens Tools when the work area has no tabs.
  - `⌘3` toggles the panel.
  - `⌃Tab` skips the Chat tab.
  - `Show all` only shows the panel.

Why: on a 13-inch screen three columns leave the work area about 380 px, so reading a diff meant hiding and re-showing
the chat. A pinned tab keeps the chat one click or `⌘1` away. A closable chat tab could be lost, and a separate chat
group would bring back the width problem.

<a id="non-goals"></a>
## Non-goals

- A separate tool strip or tool rail beside the editor groups, or the browser as an overlay above the work area.
- One browser per task.
- Off-screen rendering of the browser into the DOM. The overlay snapshot covers the visible cases.
- A pause or "take control" button for the agent's browser, or moving the agent into a new tab when the person types.
- Switching between two and three columns automatically from the window width, or hiding the panel automatically on
  resize.
- An empty-work-area placeholder in a task: an empty work area hides instead.
- Asking about unsaved files on quit or window close, or rerunning commands after a restart.
- Reading every task's `surface.json`, or loading every browser page, at start-up.
