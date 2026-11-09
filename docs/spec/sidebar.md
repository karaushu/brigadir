# Sidebar

The sidebar is the only place that tells the person about every other agent while one task fills the main area, so it is
built to be read at a glance: project groups under one header each, one row per task, a state glyph that never moves, and colour only
where something needs attention. A 48 px sections rail on its left switches what the sidebar lists (Tasks, Pull
requests, Notes, Schedules) and carries the global tools (notifications, Remote, limits, Settings).

<a id="layout"></a>
## Layout

```
┌rail┬─ strip (traffic lights · toggle) ─────────┐  ← one 48 px strip, --sep hairline under rail and list
│ ▦  │ [Filter tasks ……………………]  [≡]               │  ← text filter + «Filter by status»
│ ⑂  │ ▦ All projects               ⌂3  [+📁]       │  ← 36 px row: all-projects board, archive, add project
│ ✎  │ ──────────────────────────────────────────── │  ← --hair line over every project
│ ◷  │ ◼ web-app                  (!2)  ⌂3   +      │  ← 40 px project header; on hover ◼ becomes ⌄
│    │  ! Fix kit Button focus ring        ●  ✱     │  ← task row: glyph · title · tail
│    │    Permission · git push                     │     activity line (live tasks)
│    │    ⑂ brigadir/kit-focus   +12 −3  #503 👁    │     tree line
│    │ ┌ ◌ ⛑ Split kit exports          3   ⌄ ┐     │  ← crew card (soft fill), workers under the title
│    │ │      ◌ Developer · tokens          ✱ │     │
│    │ └─────────────────────────────────────┘     │
│    │  Completed · 2 ▾                             │  ← fold row of the completed tasks
│    │  ✓ Migrate pnpm workspace          2h       │  ← quiet 32 px completed row
│    │ ──────────────────────────────────────────── │
│    │ ◼ mobile                   (!1)  ⌂4   +      │  ← collapsed project: needs-you pill, archive, «+»
│ 🔔 │                                              │
│ ⇄  │                                              │  ← rail foot: Notifications, Remote,
│ ◔  │                                              │     limits, Settings
│ ⚙  │                                              │
└────┴──────────────────────────────────────────────┘
```

- The sidebar runs the full window height. The window buttons sit on its strip; the task or project toolbar covers only
  the main area to its right. The strip (`--strip-h`, 48 px) is a window drag region; on macOS the traffic lights are
  centred in it (`trafficLightPosition`), on one line with the toggle and the main area's title.
- Background is the flat opaque `--sb` token, not a translucent material, so the frame never changes tone with what is
  behind the window. Colours are semantic tokens with light/dark variants, never hardcoded.
- There is no footer: the limits, Remote, notifications and Settings live at the foot of the rail.
- There is no tree indentation for tasks. Grouping is done by the project header with the hairline over it, and by the
  crew card. Project groups have no frame.

<a id="grid"></a>
### One grid

Everything in the list stands on one grid, so nothing looks shifted (measured from the list's left and right edges):

| Line | Value |
| --- | --- |
| Content edge | 12 px from both edges; rounded controls (filter field, `All projects`, the crew card) start 8 px in |
| Glyph column | centre at 23 px: `All projects`, the project tile, task, completed and crew glyphs |
| Text column | 41 px: project names, task titles, `All projects`, completed titles; `Completed · N` starts on the glyph column (15 px) |
| Right edge | every trailing glyph ends 12 px from the right edge: provider, `+`, archive, age, `Filter by status`; inside the crew card everything trailing (count, chevron glyph, worker providers) ends 11 px from the card's edge |
| Project header | 40 px, the 22 px tile centred: 9 px above and below |

<a id="window-chrome"></a>
### Strip and sidebar toggle

- One toggle button for both states, `Hide sidebar · ⌃⌘S` / `Show sidebar · ⌃⌘S` in its hint (`View ▸ Toggle sidebar`,
  command `sidebar-toggle`, `Ctrl+Command+S`; the VS Code keymap preset uses `CmdOrCtrl+B`).
- Sidebar shown: the toggle sits on the sidebar's top edge, 10 px from its right edge; it follows the edge when the width
  changes.
- Sidebar hidden: the toggle moves into the main area's header right after the traffic lights (`left: 84px`), and the
  header title moves over to clear it. On Windows and Linux the ☰ app-menu button stays at the top of the rail and the
  toggle stands 10 px after the rail. When the Remote chip is shown it follows the toggle.
- The toggle and the resize grip are placed last in the DOM: Electron resolves `-webkit-app-region` in document order,
  so a `no-drag` control before a drag strip would be swallowed.
- Hiding fades the list out (`opacity`, `--motion-fast`), then collapses its width to 0; the hidden list is `inert` and
  `aria-hidden`. The rail stays.

<a id="width"></a>
### Width

| Rule | Value |
| --- | --- |
| Range | 220–480 px, default 280 |
| Stored | `sidebarWidth` in `surface-layout.json`; a file without it reads 280, an out-of-range value is rejected |
| Grip | shared `ui/ResizeHandle` on the right border: zero layout pixels, 4 px grab zone each side, `col-resize`, a 2 px `--accent` line only on hover and keyboard focus; runs the full height including the strip (`no-drag`) |
| Keyboard | ←/→ by 20 px, Home/End to the limits |
| Narrow window | effective width `min(saved, max(220, 100vw − 540px))`; the saved value is kept and comes back when the window widens |
| Hidden sidebar | no grip; the width is kept for the next show |

Why: long task and project names truncate at 280 px on wide screens, while laptops want the pixels for the chat; every
other column already resizes by its edge, so no separate setting exists.

<a id="section-rail"></a>
## Sections rail

A 48 px column left of the list, `--sb` ground, `ui/Rail` (`Rail`, `RailSection`) built from `IconButton`s. The whole
column is one control size: `data-size="xl"`, tiles 40 px, glyph 18, radius 10 (one-row-one-height rule). A `--hair`
vertical line separates it from the list, starting under the strip.

| State | Look |
| --- | --- |
| Hover | `--tint` over the whole tile |
| Open section | `--sel` fill, glyph `--accent` (hover keeps it) |
| Pressed / popover open | `--tint2` |
| Focus | accent focus ring |

No labels: the name and shortcut are in the hint (`Pull requests · ⌃⌘2`), shown after 500 ms, immediately while the
pointer travels along the rail. No stripes or borders.

<a id="rail-sections"></a>
### Sections (top)

| Tile (EN label) | Glyph | Opens | Count / dot | Shortcut (macOS · Win/Linux) |
| --- | --- | --- | --- | --- |
| `Tasks` | `board` | the task list below (default section) | amber pill: tasks in `needs-you` | `⌃⌘1` · `Alt+1` |
| `Pull requests` | `pr-branch` | PR list, see [Pull requests](pull-requests-and-ci.md) | accent pill: PRs waiting for your review | `⌃⌘2` · `Alt+2` |
| `Notes` | `note` | Notes screen and the notes list, see [Notes](notifications-slack-notes-and-schedules.md) | none | `⌃⌘3` · `Alt+3` |
| `Schedules` | `schedule` | Schedules screen and list, see [Schedules](notifications-slack-notes-and-schedules.md) | dot: red — last run failed, amber — missed run waits, accent — a run is working | `⌃⌘4` · `Alt+4` |

- Count pill: 14 px, on the glyph's top-right corner, ringed in the rail colour; above 9 it reads `9+`.
- Shortcuts are `View` menu items (commands `section-tasks`, `section-prs`, `notes`, `schedules`); ☰ on Windows/Linux has
  the same items.
- A module that is off (Pull requests, Notes, Schedules) removes its tile; the other shortcuts do not shift.
- Clicking the open section's tile, or pressing its shortcut again, hides/shows the sidebar. Another section's tile shows
  the sidebar with that section.
- `Pull requests` opens on all projects; a project group in the PR list narrows the board. What Tasks showed (a task or a
  project board) is remembered and restored on return to Tasks. Opening a task from anywhere (⌘J, a notification) while
  in Pull requests switches back to Tasks.
- Persisted: `sidebarSection` in `surface-layout.json` (`tasks` | `prs`); a missing or unknown value opens Tasks. Notes and
  Schedules are screens of their own and are not stored there.
- Every section's list uses the same look as tasks (one look, one component): a filter row, a 36 px «All …» row where it
  makes sense, project groups under a header, rows with a 14 px glyph and a second line, hover and selection on the whole row.
  Empty sections show one sentence and one action (`No notes yet` · `New note`, `No schedules` · `New schedule`,
  `No pull requests`). The section's `+` action sits in its filter row.
- Notes has no «All notes» row (the right side always shows one note).

<a id="rail-foot"></a>
### Rail foot

| Tile | Behaviour |
| --- | --- |
| `Notifications` | bell; opens the notification center popover to the right, see [Notification center](notifications-slack-notes-and-schedules.md) (`⇧⌘N`) |
| Remote | the machine button with a state dot (green: connected, grey: listening); absent when remote access is off; see [Remote access](remote-access-and-mobile.md) (`⌥⌘O`) |
| Limits | one taller tile: per provider a 30 px ring with the provider glyph inside and the shown window's percent under it (10 / 600; `--amber` < 25 %, `--red` < 10 %, else `--fg2`). Claude: 5-hour ring outside, weekly inside; Codex: one ring. Click opens the quota popover to the right; see [Usage and quota](agents-and-providers.md) |
| `Settings` | gear glyph `settings`, opens Settings (`⌘,`) |

Popovers from the foot open with `Popover side="right"`.

<a id="tasks-section"></a>
## Tasks section

<a id="filter-row"></a>
### Filter row and «All projects»

- `Filter tasks` — shared `ui/SearchField`, always visible. `View ▸ Filter tasks` (`⌥⌘⇧F`, command `sidebar-filter`;
  `Ctrl+Alt+Shift+T` on Windows/Linux) shows the sidebar and focuses and selects the field. In the field, Esc clears the
  text; Esc on an empty field moves focus to the main area. `⌘F` stays the find of the focused surface.
- `Filter by status` button beside it — see [Status filter](#status-filter).
- `All projects` row, 36 px, radius 8, glyph 16, text 13.5 / 500: whole-row hover `--hover`, selected `--sel` while the all-projects board is open.
  Its tail: the archive counter (opens the Archive window for all projects) and `Add a project…` (folder-plus).
- `Add a project…` adds the folder to the persisted project list and selects it; adding an already listed project just
  selects it. Several open projects are the normal case, not a mode.

<a id="hierarchy"></a>
### Hierarchy

`Project → Task`, with crew workers living inside their foreman's card. A worker whose foreman is gone shows as an
ordinary task. Repos are not parents of tasks (a task spans several repos), so they are not part of the sidebar tree.

<a id="project-groups"></a>
### Project groups

| Element | Rule |
| --- | --- |
| Group | no frame and no fill: a 1 px `--hair` line over every project across the full width, 8 px under the last row of an open project, none under a collapsed one; rows and their hover run edge to edge |
| Header | 40 px, padding `0 7px 0 12px`, gap 7, name 14 / 600 `--fg`. The name button stretches over the whole header, so the empty space opens the project board too; whole-row hover `--hover` |
| Selected header | `--sel` when that project's board is open and no task is (the same fill as `All projects`); hover does not remove it. Opening a task removes it: there is one selection in the sidebar |
| Project tile | 22 px, radius 6 (`ProjectIcon` size 22) |
| Chevron | no chevron at rest. Under the pointer anywhere on the header, or with keyboard focus on it, the tile shows the chevron in its place: the `Expand project` / `Collapse project` button lies over the tile, drawn as the tile's own tone (`--project-tone` 16 %) with the chevron in the tone, and fades in with `--motion-fast`; the glyph rotates −90° when collapsed (`--motion-travel`). A click on the tile folds the project |
| Project icon | the picker opens from `Project icon…` in the project menu, or with Enter on the tile's own button (`Project icon · {project}`), which keyboard focus still reaches; while the agent picks, a spinner stands in the tile and `Picking an icon…` replaces the archive counter and `+`. See [Project icon](projects-and-board.md) |
| Tail | open or collapsed, the same: amber `Needs you` pill when anyone waits (20 px, radius 10, `--amber-soft`, 11.5 / 600, glyph 11; pops when it grows, never on first render), the archive counter (opens the Archive window for this project) and `+` `New task` |
| Empty project | muted `No tasks` row on the text column |
| Disclosure | animated `grid-template-rows` 0fr → 1fr with opacity; hidden content is `inert` |

Collapse state is persisted per project (`collapsed` in `sidebar.json`) and outlives relaunch.

<a id="project-menu"></a>
### Project context menu

Right click, the context-menu key or Shift+F10 on a header opens a native menu (with glyphs):
`New task`, `Open main tree`, `Project knowledge…`, `Project icon…`, `Show in file manager`, `Copy path`, —,
`Remove project…`. `Open main tree` opens the project's main working tree, as the button in the project screen's title
strip does (see [Projects](projects-and-board.md#screen-layout)).

<a id="task-rows"></a>
## Task rows

A task is a full-width row inside its group (`.task`), no card of its own and **no fill by state**: the only fills are
hover (`--hover`, drawn as a `::after` layer so it adds to whatever is under it) and selection (`--sel`). State is carried
by the leading glyph and, for needs-you, the amber second line.

| Part | Content |
| --- | --- |
| Row | padding `8px 12px 9px 15px`, gap 10, edge to edge, no radius |
| Glyph | state glyph, 16 px, on the glyph column (see [State glyphs](#state-icons)) |
| Title | 13.5 / 18 (`--text-13-5`), weight 400 (500 when selected), one line with ellipsis. Auto-title from the first prompt; a manual title always wins |
| Title-line tail | in order: rate-limit reset time (`rate-limited`), unread dot, «Archives today / tomorrow» clock, schedule glyph (a run of a schedule), accent browser glyph `Agent in the browser`, provider glyph (`claude` / `openai`, 11 px, `--fg3`, monochrome). The title truncates before the tail |
| Sign-in line | `failed` with `failure: 'auth'`: amber `{agent} sign-in needed`, and the glyph becomes the amber key |
| Activity line | only for `working`, `needs-you`, `preparing`, or a task blocked by a lock; amber in `needs-you` |
| Background line | after the turn, while background work continues: `In the background · {name}` with a slow spinner |
| Crew summary | collapsed crew without an activity line: `{n} working · {n} done` |
| Tree line | branch/worktree, change counts, open PR, unreviewed mark (see [Tree line](#tree-line)) |
| Backlog line | backlog without a tree: `no branch · queued`, plus a paperclip with the attachment count |

- The second lines are 12 / 16, 3 px apart, and run the full width of the row, under the tail: the tail lives in the
  title line only.
- Native `title` of the row: `{title} · Pinned · {status}`.
- Click opens the task; right click / context-menu key / Shift+F10 opens the [task menu](#task-menu). All actions address
  the clicked row, not the current selection.
- Rows are memoised per task, locale and selection; a workspace reload keeps unchanged task objects.
- Reordering animates retained rows only (`useSidebarOrder`, FLIP with `--motion-travel`); new, filtered or disclosed rows
  never replay an entrance; reduced motion disables it.
- A quiet scheduled run shown through the filter is drawn at 0.7 opacity.

<a id="task-order"></a>
### Order within a project

`sidebarTasks` (core), one predicate shared with the board:

1. Tasks not `completed`: pinned first, then `needs-you` → `working`/`preparing` → unreviewed changes → the rest, newest
   `updatedAt` first.
2. Then `completed` tasks: pinned first, then newest `completedAt` (falls back to `updatedAt`).

Archived tasks and crew workers (whose foreman exists) are excluded (`personTasks`); quiet scheduled runs are excluded
unless the filter's `Quiet scheduled runs` is on. There is no manual drag ordering.

<a id="activity-line"></a>
### Activity line

The «what is it doing now» line, derived in main and never written to `task.json`:

| `activity.kind` | Source event | Text |
| --- | --- | --- |
| `tool` | `tool.changed` (title + first `locations[].path`; a partial patch of the same tool keeps title/path) | `Edit · Cart.tsx` (MCP tools get their readable title) |
| `permission` | `permission.requested` | `Permission · {tool title}` |
| `plan` | `permission.requested` that is a plan approval | `Plan for approval` |
| `question` | `question.requested` | `Question · {text}` |
| `proposal` | `task.proposal.requested` | `New task · {title}` |
| none | — | `Waiting for the repo` when blocked by a lock, else the state label |

- `TaskActivities` reads only tasks in `working`/`needs-you`: at most the last 64 KiB of `events.jsonl`, whole JSONL
  records only (the first partial line is dropped, symlinks are not followed), cached by file identity (≤ 1024 entries),
  4 parallel readers. The Live agents popup shares this reader.
- Reset on `turn.started`, `turn.completed`, `session.failed`, `host.stopped`, `permission.resolved`, `question.resolved`,
  `task.proposal.resolved`. A `needs-you` task drops a tool activity; a `working` task drops a non-tool one.
- Titles are capped at 240 characters, paths at 1024. Subagent events do not drive the foreman's line.
- The renderer refreshes on a bounded throttle so a continuous tool stream cannot postpone the update forever.

<a id="tree-line"></a>
### Tree line: worktree, branch and changes

| Part | Rule |
| --- | --- |
| Glyph | `sidebar-worktree` for a task in its own worktree, `sidebar-branch` for work in place |
| Branch | `ui/BranchName` (`--fg3`), title `Worktree · {branch}` / `Branch · {branch}`; detached HEAD shows amber `Detached HEAD` |
| Planned branch | a `preparing`/`queued` worktree task shows the planned branch before the tree exists, or `brigadir/…` while the agent is still naming it |
| Counts | `+N −M` from the task's snapshot diff (`changeSummary`), monospace tabular digits; compact form `1.2k` |
| PR | `#N` of the task branch's **open** (or draft) PR only |
| Unreviewed | eye glyph `sidebar-unreviewed`, independent of the counts |

- **No zero counts.** `+0 −0` is never shown (task row, repo rows, sums). When anything changed both numbers show,
  zero included (`+0 −3`): the pair reads as one value. Mode-only or binary changes can give `+0 −0` with the unreviewed
  eye still on.
- **Nothing overlaps.** The line gives way in a fixed order: the branch middle → the PR → the branch tail (kept from the
  start, `brigadir/…support`) → the counts as whole parts (`−M` first, then `+N`). The branch prefix up to the first `/`
  and the unreviewed eye keep their size; parts keep 6 px gaps; nothing is cut mid-letter. Verified down to 220 px.
- Data: `TaskDiffs` in main caches per `snapshots.json` identity; a changed snapshot runs a bounded `git numstat` between
  immutable trees (no patches, blobs or index writes); unchanged histories run no Git. A new repo's baseline is its first
  appearance; nested repos are not counted again in their parent. Under the HEAD diff base the cache key includes each
  HEAD. `hasUnreviewedChanges` is «the task diff has files». Worktree and branch come from `launch.isolation`,
  `launch.branch`, `worktreeBranch` (`taskTree`).

Why: the counts matter most while the agent works (how far it got), and the branch/worktree says where it works without
opening the task.

<a id="state-icons"></a>
## State glyphs

One leading glyph per row. **Shape distinguishes, colour reinforces** — colour is never the only carrier.

| Status (`AgentTask['status']`) | EN label | Glyph | Colour |
| --- | --- | --- | --- |
| `working`, `preparing` | `Working`, `Preparing…` | `agent-run` (spinner) | `--accent` |
| `needs-you` (permission / plan) | `Needs you` | `agent-permission` | `--amber` |
| `needs-you` (question) | `Needs you` | `agent-question` | `--amber` |
| `done` (turn finished, waits for the person) | `Done` | `agent-idle` (tick in a circle) | `--green` |
| `completed` (person marked it completed) | `Completed` | `agent-completed` (tick without circle) | `--fg3` |
| `failed` | `Error` | `agent-failed` | `--red` |
| `failed` with auth failure | `{agent} sign-in needed` | `agent-key` | `--amber` |
| `interrupted` | `Interrupted` | `agent-stopped` | `--fg2` |
| `rate-limited` | `Rate limited` | `agent-hourglass` | `--fg2` |
| `queued` | `Queued` | `agent-queued` | `--fg2` |
| `backlog` | `Backlog` | `agent-backlog` (broken outline of the idle circle) | `--fg2` |

- `StatusIcon` / `StatusGlyph` (`ui/Controls`) are the one implementation, used by sidebar rows, crew workers (12 px),
  board cards and list, Search Everywhere, the Live agents popup and the Archive window.
- Only the glyph is coloured; titles and state captions keep their own colours.
- Only running states animate: one CSS rotation, `1s steps(8)`, no per-row timers; `prefers-reduced-motion` stops it.
- `needs-you` is the only state allowed to be loud. Failed and other coloured states get no fill: fill would mean «live»,
  not «important».
- Arrival of `done` / `needs-you` plays the attention flash, and a waiting row repeats it every 30 s until seen; see
  [Attention](notifications-slack-notes-and-schedules.md). It never plays on first render, reload or expansion.
- The Dock badge (macOS) / app badge count is the number of `needs-you` tasks across projects (plus what connected
  machines report). A collapsed project shows its own count in the header.

<a id="unread-dot"></a>
### Unread dot

A 6 px `--accent` dot in the title line means **«the agent wrote something since you last looked»** — not «there is an
unreviewed diff» (that is the separate eye on the tree line).

- The host stores `activitySeq` (the journal seq of the last status-bearing event, excluding `*.resolved` events) on the
  task.
- Main keeps `task-reads.json` (`seen: { "<projectId>/<taskId>": seq }`). When a task becomes visible
  (`notifications:visible`) its current `activitySeq` is marked seen.
- `hasUnread = activitySeq > seen`, computed on every `workspace:read`. A task that was never opened and has no activity
  is not unread. If `task-reads.json` cannot be read, the workspace reports an issue for it.

<a id="done-rows"></a>
## Completed tasks

Completed tasks come last in their group as quiet rows, not cards, under a fold row.

<a id="completed-fold"></a>
- Fold row: 32 px, `Completed · N` (12.5 / 500, `--fg3`) starting on the glyph column, then a filled triangle (10 px,
  `--fg3`) 5 px after the text; it points down while open and right while folded (`--motion-travel`). The whole row is
  one button with whole-row hover `--hover`, `aria-expanded`, hint `Collapse completed` / `Expand completed`. Folding is
  per project, open by default, and persists like a folded project (`completedCollapsed` in `sidebar.json`). Filters and
  search open it for the time they are on.
- Row: 32 px, padding `0 12px 0 15px`, gap 10, text 13 `--fg2`, one line with ellipsis. Content: the quiet tick (16),
  title, unread dot, archive-soon clock, completion age (`relativeAge` of `completedAt`, `--text-12`, `--fg3`, tabular
  digits). No branch, counts or provider glyph.
- Whole-row hover `--hover`. Under the pointer or on keyboard focus (`:focus-visible`) the age and clock give way to a
  24 × 24 `Archive` button with its own hover (hint `Archive · ⌃⌘A`); it is absent when the task cannot be archived. The
  archive button is a sibling raised over the row button, so it never opens the task.
- Selected (task open): `--sel`, text `--fg`; the row does not grow.
- Click opens; right click opens the task menu; a swipe archives (see [Archive](tasks.md)).
- A completed foreman is the same row; its workers are not listed.
- Filters and search show completed tasks as these rows too.

<a id="crew-card"></a>
## Crew card

A foreman task is a soft card inside its group: `--hover` fill (white 3 % in dark), radius 10, margin `2px 8px 6px`,
6 px under the last worker. The fill means «container» and
is the same in every state, except that a foreman in `needs-you` (e.g. its plan awaits approval) tints the whole card
`--amber-soft`. A worker waiting for the person colours only its own glyph and lifts the attention flash onto the header.
See [Crew](crew.md) for what a crew is.

| Part | Rule |
| --- | --- |
| Header | a task row (padding-left 7, right 11, so the glyph stays on the glyph column) with the helmet (15) before the title; title 600 and activity 500 while expanded, both 400 when collapsed |
| Header tail | collapsed: up to two provider glyphs; always: worker count pill (16 px high, ≥ 24 wide, `--tint2`, `Workers`); space for the chevron |
| Chevron | absolute 24 × 24 target on the title line, 4 px inside the card's right edge, `Expand crew` / `Collapse crew`; `--tint` on hover; a mouse click does not take focus, the keyboard does (`:focus-visible` ring) |
| Workers | straight under the header, no plate: indented 26 px inside the card so their glyphs stand under the title |
| Worker row | 30 px, 12.5 px text `{Agent} · {part}` (agent name in `--fg2`), 13 px state glyph in a 14 px slot, gap 9, 11 px to the card's right edge; tail: unread dot, provider glyph. Hover `--tint`, selected `--sel`. Lead depth indents 14 px per level; a nested foreman shows its helmet before its glyph |
| Worker extra line | `Waiting for the simulator` while it waits for the project's one device |
| Branch of a worker | not shown; it derives from the crew worktree |

- **Selection.** A selected expanded crew is selected whole: `--sel` over the card (header and the area around the workers);
  the header button stretches over the card so its hover covers the same area, while the workers and chevron lie above with
  their own hover. A selected worker highlights only its row.
- **Collapsed.** Folded, the card is the header alone in the same tone (`--amber-soft` for needs-you, `--sel` when
  selected), 6 px to the next row.

<a id="crew-collapse"></a>
### Collapse persists

Folding a crew card is the person's choice, like folding a project: opening the foreman or a worker, switching tasks,
reload and relaunch never unfold it. Default is expanded. Stored as `crewCollapsed` (foreman task ids) in
`sidebar.json` via `sidebar:crew-collapse`; a failed write shows an error toast and re-reads. Attention does not unfold
the card — only the chevron does.

<a id="worker-preview"></a>
### Full text of a truncated worker row

When a worker title is really truncated (`scrollWidth > clientWidth`), hovering anywhere on the row for 1000 ms (or
keyboard focus) opens the shared `ui/Popover` (width 420) without moving focus: full task title, agent name, state, and
when known provider, model, effort, branch, repo and the full task description (`TaskPreviewContent`). Text wraps, is
selectable and copyable, and scrolls within the window. The pointer may move onto the popover; leaving both closes it
after the usual 120 ms. Esc, an outside click, scrolling the sidebar or selecting a task close it; leaving, clicking, Esc,
scroll or resize before the second elapses cancels the timer. Untruncated rows never open it and have no native title.

<a id="selection"></a>
## Selection and hover

- Selection is the soft fill alone — `--sel` — with no accent border (the 1 px border stays transparent, so sizes do not
  change). Selection wins over every other row fill.
- There is one selection in the sidebar: a task row, a project header (its board) or `All projects`.
- Hover covers the same area as selection (whole row, including the empty space); nested buttons sit above with their
  own hover; rows reach both edges of the list with no empty padding beside them.

<a id="status-filter"></a>
## Status filter

One `Filter by status` ghost `IconButton` (`filter` glyph) next to `Filter tasks`; `aria-expanded` while open. Click opens
a `ui/MenuPopover` below it (header with title and `Esc`), focused on the checked row:

| Row | Matches | Count |
| --- | --- | --- |
| `All tasks` | everything (clears the filter) | live tasks |
| — | | |
| `Needs you` | `needs-you` | |
| `Running` | `working`, `preparing` | |
| `Unreviewed` | `hasUnreviewedChanges` | |
| — (Schedules module on) | | |
| `Quiet scheduled runs` (check) | also lists quiet scheduled runs | quiet runs |

- Rows are radios with the same state glyphs as rows and global counts across projects. Choosing the active filter
  again clears it. ↑/↓, Home/End, Space/Enter come from the shared menu.
- Active filter: a 6 px dot over the glyph's top-right corner in the state's colour (`--amber` for Needs you, `--accent`
  for Running and Unreviewed, `--accent` for quiet runs), with a 1.5 px ring of the sidebar colour; it scales/fades in
  (`--motion-enter-time`; instant without motion). Accessible name `Filter by status · Needs you`. The dot is the
  `IconButton` `dot` prop.
- The Pull requests section has the same button for `All · Yours · Waiting for you` (`PR filter`).

<a id="filter-behaviour"></a>
### Filter behaviour

- Text filter: case-insensitive title substring (locale-aware). It combines with the status filter.
- Only projects with matching tasks are listed; a foreman stays when any of its workers matches. `No matches` when
  nothing does.
- While a filter is active, groups are temporarily expanded with their own collapse state; the saved collapse is not
  rewritten and comes back when the filter clears.
- Hidden tasks are not reachable by keyboard.
- Filters are never persisted: a fresh launch never hides work.
- Unread and unreviewed are separate: reading a message does not mean the diff was reviewed.

<a id="task-menu"></a>
## Task context menu

Native menu with glyphs; right click, the context-menu key or Shift+F10; it acts on the clicked task.

| Group | Items (shown when applicable) |
| --- | --- |
| Open | `Open task` |
| Continue | `Continue with a new agent` (stopped task whose session started; `Start task` if it never started), `Continue in a new task` (not backlog/preparing) |
| Copy | `Duplicate task…`, `Repeat…` (Schedules module), `Show task diff` |
| Board | `Edit task…` (unstarted backlog), `Add to backlog` / `Start task` / `Move to in progress` / `Mark completed` (allowed board moves), `Rename task…`, `Pin task` / `Unpin task`, `Copy task title`, `Stop` (connected, running or queued) |
| End | `Archive` (`⌃⌘A`, disabled while an agent works in it or its crew), `Delete task…` |

- `Duplicate task…` opens an editable launch draft with the same initial prompt, provider/transport and repo/isolation
  settings; a new worktree gets a new branch; a backlog task duplicates into backlog. Nothing is created until submit;
  journal, session and diff are not copied; a live host is never cloned.
- `Show task diff` opens that task's change list without starting an agent.
- `Continue with a new agent` goes through the normal launch queue, locks and recovery, keeping the task id, journal and
  diff baseline; a supported transport resume is kept (a CLI task is not switched to ACP).
- A stopped task offers the same continue actions over its composer: state text on the left, `Resume`/`Start` and
  `Continue in a new task` grouped on the right, 8 px apart (wrapping keeps the right alignment).
- An archived task's menu: `Open task`, `Restore from archive`, `Show task diff`, `Copy task title`, `Delete task…`.

<a id="delete"></a>
### Delete and remove

- `Delete task…` / `Remove project…` confirm with the name and warnings: running agents and terminals stop, task
  worktrees are removed (branches stay), crew workers are deleted too, uncommitted worktree changes are lost (file count),
  unsaved editor buffers are listed. Where possible the dialog offers `Archive` instead (archive deletes nothing).
- Hosts are closed before the task's or project's local data moves to the system Trash. Repository files are never
  deleted. Concurrent commands on the project are blocked while removal runs.

<a id="open-last"></a>
## Opening the last task

On launch the app reopens what was open last: a task (in its project), a project board, or `All projects`.

- Stored as `selected: { project, task? }` in `sidebar.json` (`project` is an id or `*`; `*` never has a task). Every
  selection change is written through `sidebar:select`; an unchanged selection does not rewrite the file.
- Restored once, on the first workspace load, and only if the person has not chosen something meanwhile. The last task's
  `surface.json` and the shared widths are preloaded with the workspace (up to 1.5 s) so the first frame is the restored
  layout; the content area stays empty until then.
- A task that is gone or archived falls back to its project; a missing project falls back to the first project. The
  project's main tree is not restored. Filters are not restored.

<a id="persistence"></a>
## Persistence

| File (`~/.brigadir/`) | Fields | Notes |
| --- | --- | --- |
| `sidebar.json` | `schemaVersion: 1`, `collapsed` (project ids), `archiveOpen`, `crewCollapsed` (foreman ids), `completedCollapsed` (project ids), `selected` | empty optional fields are not written; ids validated, ≤ 10 000 each; writes are serialised; IPC `sidebar:read`, `sidebar:collapse`, `sidebar:crew-read`, `sidebar:crew-collapse`, `sidebar:completed-read`, `sidebar:completed-collapse`, `sidebar:selection-read`, `sidebar:select`, `sidebar:archive-read`, `sidebar:archive-open` |
| `surface-layout.json` | `sidebarWidth`, `sidebarSection` | shared with other column widths |
| `task-reads.json` | `seen` | unread baseline |

A failed read of `sidebar.json` shows `Could not read the sidebar state.` with a retry; collapse controls stay disabled
until it is read.

<a id="repos"></a>
## Repos

The sidebar has no repos block: a task's repos live in its header (the main repo chip and `+N ▾` opening the
`Repos k/n` popover) and as roots of its Files and Changes panels; see [Task window](task-window.md) and [Git](git.md).
The display rules that the old sidebar block defined still hold there:

- Visible term is **repo** (`Repo` / `Repos`, `1 repo` / `2 repos`); code, IPC and JSON keep `scope`/`scopeId`.
- The root repo is shown under the project's name, never `.`; one function gives the display name everywhere
  (the domain keeps `.`). A folder without git is a row with the folder glyph, no branch and no counts.
- A repo row shows state only: name, kind (`Submodule`), branch (a branch-picker button on the main tree), `↑N` / `↓N`,
  lock, `+N −M` (never `+0 −0`), PR mark. A repo outside the task is dimmed with `outside the task` and an
  `Add to the task` button.
- Lock: the owner task's name, and when several tasks write the same repo, amber with `+N`; the full list in the tooltip
  (`Busy · …`). See [Locks](tasks.md).
- All control lives in the `Repo actions` menu (`⋯`), every item with a glyph, e.g. `Commit…`, `Resolve conflicts…`,
  `Remove from the task…` / `Add to the task`, `Push commits…`, `Create PR…` or (PR exists) `Checks…` and
  `Open on GitHub`, `Open first change`, and on the main tree a Git group (`Switch branch…`, `New branch…`, `Pull`,
  `Stash changes`, `Restore from stash…`, `Undo last commit…`, `Discard changes…`). A blocked item stays visible and
  shows its reason as a line under it (e.g. `Stop the task before changing its repos.`), so the reason is keyboard
  reachable. `Remove worktree…` sits in the worktree actions.
- Repos discovered after setup arrive read-only (outside the task) — a security boundary no default overrides.
- The PR badge (`#N` with checks state) shows only while the branch's PR is open or draft; after merge or close there is
  no badge and `Create PR…` is available again — the repo's open/closed counter and the PR panel carry the history.
  The PR state is still read with `--state all` and stored on the task.
- Push, Create PR and the PR badge share one height (24 px), vertically centred content and a 4 px radius in every state,
  in the header and in Changes; PR buttons use the shared outline pull-request glyph (`currentColor`, 11 px in compact
  actions). `Create PR…` creates the topic branch itself when the current branch equals the base; see
  [Pull requests](pull-requests-and-ci.md).
- Repo choices are per task; project defaults never change other tasks' rights. Write-access changes apply on the next
  start (ACP `additionalDirectories` are negotiated at new/load), through the normal lock conflict flow.

<a id="i18n"></a>
## Text and localisation

State labels and action names are localised (see [UI text](appearance.md)). Branch names, paths, repo names and
agent-generated titles are not. Tooltips carry the words where the row shows only a glyph or a number.

<a id="later"></a>
## Later

- Shared long-lived worktree as a child level under a project (`Project → worktree → Task`), only if shared worktrees appear.
- `contextExhausted` state glyph (amber triangle) once the state exists.
- Rail keyboard model: ↑/↓ between tiles, → into the section's list, ←/→ to fold groups in lists.
- Per-section memory of selection, folded groups and scroll position across relaunch.
- Agent and crew template library as a rail section, once it has its own list.

<a id="non-goals"></a>
## Non-goals

- Manual drag ordering of tasks.
- A project switcher that hides other projects' tasks; several projects at once are the norm.
- A separate «Needs you» section duplicating rows.
- Fills by task state on rows, a coloured state stripe, or a coloured provider glyph — colour in a row belongs to state.
- Archive or search as rail sections (Archive is a counter; search is a popup over everything).
- A separate settings field for the sidebar width.
