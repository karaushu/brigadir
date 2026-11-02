# Search, shortcuts, menus and project commands

Every keyboard shortcut in Brigadir belongs to a native menu-bar item, and one typed catalog of commands in `core/menu.ts` drives the menu, the keymap and Search Everywhere's Actions tab. Search Everywhere is a single modal for tasks, files, text in files, PRs, project commands, actions and settings. Project commands are named shell lines that a project saves. They run as console tabs of a task, from the toolbar, from search, from an agent through MCP or from `package.json` scripts.

<a id="shortcuts"></a>
## Keyboard shortcuts

<a id="menu-bar-rule"></a>
### The menu-bar rule

- **Every shortcut has a menu-bar item.** This makes shortcuts easy to discover, and menu labels get translated with the rest of the UI ([UI text](appearance.md)).
- There are two exceptions. Keys that work only inside a modal and are labeled in that modal (Archive, Search Everywhere, Commit, the remote folder picker, `⌘↩` in dialogs) stay out of the menu bar. So does double Shift.
- System shortcuts are never overridden. `reservedAccelerators` lists them (Spotlight, App Switcher, Quit, Hide, Minimize, screenshots) along with the app's fixed items (`⌘,` Settings…, `⇧⌘1` Workspace, `⇧⌘2` Kit, `⌥⇧⌘I` Developer tools). On Windows and Linux, `pcReservedAccelerators` also covers keys the desktops own (Alt+F4, Alt+Tab, Ctrl+Alt+T, Ctrl+Alt+L, Ctrl+Shift+U, workspace arrows and others) and the app's F10, F11, Ctrl+Q and Ctrl+Z/Y/X/C/V/A.
- One key can mean different things depending on focus (macOS convention). For example, `⌘F` searches the transcript in chat and the diff in the diff view. `⌥↑/⌥↓` step between tool calls or hunks.
- `⇧⌘P` is **Pull requests**. There is no separate command palette, because the Actions tab of Search Everywhere does that job.

<a id="keymap"></a>
### Keymap

- Setting `keymap: { preset, overrides }` in app settings, default `{ preset: 'brigadir', overrides: {} }`.
- Presets: `brigadir`, `vscode`, `intellij`. A preset changes only the commands that have an equivalent in that editor; everything else keeps Brigadir's key. For example, VS Code gives `⌘P` Quick Open, `F12` Go to definition, `⌘B` Toggle sidebar and ``⌃` `` Terminal. IntelliJ gives `⌥⌘L` Format and `⌥F12` Terminal.
- In `overrides`, each key is a command id and each value is an accelerator, or `null` for no shortcut. Override precedence: override → preset → the command's own key in `core/menu.ts`.
- Accelerators are stored in canonical Electron form, with modifiers in `Ctrl, Alt, Shift, CmdOrCtrl` order.
- **Conflicts.** Two commands conflict only when they share a scope (`global`, `composer`, `chat`, `editor`, `diff`, `console`, `browser`, `simulator`, `pullRequests`) or when one of them is global. Some pairs never act at the same time, so they may share a key: composer formatting vs Ask the agent, and Add to queue vs Submit. `keymapConflicts` is empty for every shipped preset (unit test). When an assigned key is already taken, the other command can lose it (`assignShortcut(…, replace)`). A reserved key can never be assigned.
- A module that is switched off has no menu items, so its commands hold no keys (`keymapCommands`).
- **Windows/Linux** ([platform](architecture-and-platform.md)). PC defaults are derived from the macOS keys: `⌘`→Ctrl, `⌥`→Alt, `⇧` stays. `⌃` becomes Ctrl when the chord has no `⌘`, or Alt when it does. Ctrl+Alt with a typing key is AltGr on European layouts, so it moves to Ctrl+Shift and then Ctrl+Alt+Shift. Reserved and taken keys are skipped. Fixed PC keys (`pcKeys`) are:

  | Command | PC key |
  | --- | --- |
  | Next/Previous document | Ctrl+PageDown / Ctrl+PageUp |
  | Next/Previous turn | Alt+PageDown / Alt+PageUp |
  | Turns | Alt+Shift+U |
  | Next/Previous change (editor) | Alt+F5 / Alt+Shift+F5 |
  | Previous/Next location | Alt+Left / Alt+Right |
  | Filter tasks | Ctrl+Alt+Shift+T |
  | Archive task / Archive… | Ctrl+Alt+Shift+A / Alt+Shift+A |
  | Sidebar sections Tasks, Pull requests, Notes, Schedules | Alt+1 … Alt+4 |
  | Next/Previous group | Ctrl+F6 / Ctrl+Shift+F6 |
  | DevTools (browser) | F12 |
  | Find next / Find previous | F3 / Shift+F3 |

- Shortcuts are shown as `⇧⌘K` on macOS and `Ctrl+Shift+K` on a PC (`formatAccelerator`). On a PC, the Meta (Windows/Super) key is never recorded.
- You edit the keymap in Settings, in the Appearance tab ([Settings](settings-modules-and-onboarding.md)).

<a id="default-shortcuts"></a>
### Default shortcuts (Brigadir preset, macOS)

| Menu | Item · key |
| --- | --- |
| File | Open a project… `⌘O` · Connect… `⌥⌘O` · Close task `⇧⌘W` · Close tab `⌘W` · Reopen closed tab `⇧⌘T` · New task `⌘N` · New file… `⌥⌘N` · Open Quickly… `⇧⌘O` · Open Quickly (alias) `⌘P` · Search Everywhere… `⇧⌘K` · Find in Files… `⇧⌘F` · Find Action… `⇧⌘A` · Archive task `⌃⌘A` · Project commands… `⌥⌘R` · Run current command `⌃⌘R` · Stop current command `⌃⌘.` · New command… · New note · New schedule… · Save `⌘S` |
| Edit | Undo `⌘Z` · Redo `⇧⌘Z` (plus the system roles) · Formatting ▸ Bold `⌘B`, Italic `⌘I`, Code `⌘E`, Link `⌘K` (composer text only) |
| Editor | Find `⌘F` · Find and replace `⌥⌘F` · Find next `⌘G` · Find previous `⇧⌘G` · Replace all `⌥⌘↩` · Indent `⌘]` · Outdent `⌘[` · Toggle comment `⌘/` · Format document `⇧⌥F` · Go to definition `⌘B` · Find references `⌥F7` · Show completions `⌃Space` · Show parameters `⇧⌘Space` · Next/Previous problem `F2`/`⇧F2` · Next/Previous change `⌃⌥⇧↓`/`⌃⌥⇧↑` · Revert change `⌥⌘Z` · File history (no key) · Restart language servers · Ask the agent `⌘I` |
| Navigate | Notifications `⇧⌘N` · Next/Previous agent needing you `⌘J`/`⇧⌘J` · Next/Previous document `⌥⌘→`/`⌥⌘←` · Next/Previous tool or hunk `⌥↓`/`⌥↑` · Next/Previous turn `⌥⌘↓`/`⌥⌘↑` · Expand/Collapse conversation `⌥⌘]`/`⌥⌘[` · Previous/Next location `⌃-`/`⌃⇧-` |
| Diff | Toggle diff layout `⌥⌘U` · Expand/Collapse all context `⌥⌘]`/`⌥⌘[` · Comment on selection `⌥⌘C` · Next/Previous hunk · Jump to source `F4` · Commit… `⌥⌘K` |
| Browser | Focus address `⇧⌘L` · Select node `⇧⌘C` · Screenshot to chat `⌥⌘B` · DevTools `⌥⌘I` · Reload `⌘R` · Back `⌘[` · Forward `⌘]` |
| Simulator | Home `⇧⌘H` · Rotate `⌘→` · Reload app `⌘R` · Screenshot to chat `⌥⌘M` · React Native DevTools · Shut down simulator |
| Console | Clear terminal `⌘K` · Next/Previous terminal `⌃⇥`/`⌃⇧⇥` · Show the agent `⌥⌘Y` · New terminal ``⌃⇧` `` |
| View | Toggle sidebar `⌃⌘S` · Layout ▸ Chat `⌘1`, Work area `⌘2`, Panel `⌘3`, Show all, Reset column widths · Editor groups ▸ (Split right/down, Split and move right/down, Move to the other group, Next/Previous group `⌥⇥`/`⌥⇧⇥`, Unsplit, Unsplit all) · Tasks (section) `⌃⌘1` · Pull requests (section) `⌃⌘2` · Notes `⌃⌘3` · Schedules `⌃⌘4` · Tools… `⇧⌘I` · Filter tasks `⌥⇧⌘F` · Increase/Decrease/Reset font size `⌘+`/`⌘−`/`⌘0` · Archive… `⌥⌘A` · Stop `⌘.` · Add to queue `⌘↩` · Turns `⇧⌘U` · Pull requests `⇧⌘P` · Browser `⇧⌘B` · Simulator `⇧⌘M` · Terminal `⇧⌘Y` · Show changes `⇧⌘D` · Show files `⇧⌘E` · Focus composer `⌘L` · Refresh pull requests `⌘R` · Markdown preview `⇧⌘V` · Next agent mode `⇧⇥` · Submit `⌘↩` · Submit and go or allow always `⇧⌘↩` · Deny permission `⌘⌫` · Workspace `⇧⌘1` · Kit `⇧⌘2` |

Keys that live outside the menu bar:

- Composer: `↩` sends, `⇧↩` inserts a new line, `Tab` accepts a ghost suggestion while one is visible ([Composer](composer.md)).
- Double Shift opens Search Everywhere ([below](#search-everywhere)).
- Terminal and browser addenda are in [Terminal](terminal-and-cli-agents.md) and [Browser](browser-and-simulator.md).
- `⌘.` cancels the turn (`session/cancel`). In a focused console it sends Ctrl-C.

<a id="context-confirmation"></a>
### Context confirmation through the native menu

`⌘↩`, `⇧⌘↩` and `⌘⌫` are menu items (Submit, Submit and go or allow always, Deny permission). The renderer routes each one to the card that has DOM focus:

| Focus | `⌘↩` | `⇧⌘↩` | `⌘⌫` |
| --- | --- | --- | --- |
| Permission card | allow once | allow always (only if the provider offers an `allow_always` option) | deny |
| Filled question card | send the answer (only when it is valid) | — | — |
| Comment draft | Send to chat (Attach comment in the CLI) | Send to chat and go | — |
| Focused task composer while the agent works | Add to queue | — | — |
| None of the above | submit the ready review | — | — |

- Esc in a comment draft cancels it.
- If a permission, question or plan proposal is pending but not focused, `⌘↩` does nothing. It never skips past the card to submit the review.
- A busy, invalid or disconnected state blocks sending twice.
- The data and validation for answers live in the shared task model, not in the view.

<a id="menus"></a>
## Native menus

<a id="menu-catalog"></a>
### Command catalog and enabling

- All app commands are typed entries in `menuCommands` (`core/menu.ts`). Each entry has an `id`, menu `group`, `label` (message key), default `accelerator`, `channel` (`workspace` | `editor`), `action` and `when` (a `MenuContext` key or `always`). There is one list. A second, independent list of shortcuts must never exist.
- **IPC.** The renderer publishes only booleans (`menu:context`, validated by `isMenuContext`). It never sends paths or code. `menu:run` runs a known command id, which Search Everywhere's Actions tab uses. Clicking a menu item sends `workspace:action` or `editor:action` to the focused client.
- `menuCommandEnabled` is the only enabling rule:
  - Nothing is enabled under a modal (`context.modal`).
  - When the browser has native focus, it takes priority. Editor, document, diff, chat, console, font, review, find, save, composer and PR commands are disabled, so a global shortcut never edits a background file, starts the console or submits a review behind another surface.
  - Browser Back, Forward and Reload need browser focus.
  - Simulator Home, Rotate and Reload need a focused simulator screen. Elsewhere `⌘→` stays end of line.
  - Commands for surfaces that are missing are disabled.
- App items are disabled until the renderer is ready (`menuReady`), so a click during startup is never lost against a renderer that cannot handle it.
- Native Edit ▸ Undo/Redo go to the active CodeMirror history when an editor has focus. Plain text fields and the browser keep their native history.
- The Filter tasks item shows a field above the task list. Esc clears and hides it.
- New task uses the current project.
- Open a project… opens the system folder picker.
- Close task keeps the editor buffers parked.
- Next agent mode cycles only through the modes the provider declares.
- Menu items appear together with the feature they belong to. There are no placeholder actions.
- The label `Search Everywhere…` stays in English in every locale. All other items are translated.

<a id="menu-structure"></a>
### Menu structure

- **macOS:** Brigadir · File · Edit · Editor · Navigate · Diff · Browser · Simulator · Console · View · Window.
  - The app menu contains About Brigadir, Check for Updates… ([auto-update](architecture-and-platform.md#auto-update)), Settings… `⌘,`, Templates…, Show the intro again…, Services, Hide/Hide Others/Show All and Quit.
  - File starts with Open a project… and then Open Recent (recent projects).
- **Windows/Linux:** there is no app menu.
  - File ends with Settings…, Templates… and Exit Brigadir (Ctrl+Q).
  - Help holds the intro, Check for Updates… and About.
  - Window has Minimize and an unkeyed Close. Ctrl+W belongs to Close tab, and the window closes the system way (Alt+F4).
  - The menu opens from a ☰ button in the window frame ([window frame](architecture-and-platform.md)).
- The Browser and Simulator menus disappear when their modules are off ([Modules](settings-modules-and-onboarding.md)).
- **Separators.** Long menus are split into groups by meaning (`menuGroupStarts`, `withGroupSeparators`) without changing item order. A module that is switched off never leaves two separators in a row.
  - Editor: search · text editing · language server · changes and Git · services, then Show line author.
  - View: window layout · font · Archive… · turn · task sections · focus actions · answer card, then Workspace and Kit, then the developer tools.
- **View ▸ Layout** starts with the column choice. In three columns it then shows Chat/Work area/Panel, a separator, Show all and Reset column widths. In two columns it shows only Panel `⌘3` and Reset column widths. The Panel item's glyph follows its state (`layout-two-panel` / `layout-two`). Chat, Work area and Show all are hidden there but keep their keys (`acceleratorWorksWhenHidden`) ([Layouts](task-window-workspace.md)).
- `⌘W` closes the document tab that has focus and does nothing when there are no tabs.
- Clear terminal and the chat navigation keys (`⌥⌘↑/↓/[/]`, `⌥↑/↓`) come only from the keymap. They are never hard-coded.
- Context menus are specified with their surfaces: [editor](editor.md), [document tab](editor.md), [chat](chat.md), [sidebar](sidebar.md). The project-command row menu is [below](#commands-menu).

<a id="menu-after-background-launch"></a>
### Menu after a background launch (macOS)

A background launch (`--secondary`) never activates the app. It starts with activation policy `accessory`, which shows windows but hides the menu bar. The first time one of its windows gets focus, the policy switches to `regular` so the menu bar shows. Automated runs that never take focus stay `accessory`.

<a id="menu-glyphs"></a>
### Menu glyphs

- **Every item of every native menu has a glyph.** That covers context menus (editor, chat, console, the system edit menu of text fields, document tab, sidebar task/archived task/project/command rows, Files and Changes `files:menu`, turn menu, sheet attachment menu, board card model/effort pickers) and the whole menu bar: `menuCommands`, app items, Open Recent, Edit roles, View and Window roles, and submenu titles (Formatting, Layout, Editor groups).
- Top-level menu titles have no glyphs. Items that macOS adds itself (AutoFill, Dictation, the window list) stay system items.
- Checked value items in pickers (model and effort values) have no glyph. Only their header has one.
- **One map, one set of bitmaps.** `core/menu-icons.ts` holds:
  - `menuIconNames`: every glyph that any menu shows.
  - Per-menu maps that main builds: `taskMenuIcons`, `projectMenuIcons`, `commandMenuIcons`, `fileMenuIcons`, `turnMenuIcons`, `attachMenuIcons`, `pickerMenuIcons`, `appMenuIcons`, `roleMenuIcons`.
  - `menuCommandIcons`, next to `menuCommands`.
  - Core menus (`editorMenuItems`, `chatMenuItems`, `terminalMenuItems`, `documentTabMenuItems`) carry `icon` on each item.
- After startup the renderer rasterizes each name once (PNG 1× and 2×) from `ui/Glyph` and sends the set over `menu:icons`. Main keeps the set (`main/menu-icons.ts`: `setMenuIcons`, `menuIcon(name)`) and rebuilds the menu bar when it arrives. A menu opened before that is text only.
- **The glyph shows the target, not only the action.**
  - Open in the PR panel shows a PR branch. Show in Files shows a folder.
  - Next/Previous pairs show their object with an arrow: problem, change, needs-you agent, block, turn, tab, group.
  - Copy relative path uses `copy`, absolute path uses `copy-absolute`, and `path:line` uses pages with `#`.
- Glyphs are 16 × 16 with a 1.2 stroke and round caps (shared `Line` frame). Sources are listed in [third-party assets](../third-party-assets.md).
- **macOS only.** Glyphs are template images, so the system tints them for the theme and the highlighted row. On Windows and Linux the menus are text only: the renderer does not rasterize glyphs and main does not set them.
- Tests: `core/menu-icons.test.ts` checks that every menu-bar command and context item has a glyph from the set and that only shown glyphs are rasterized. The e2e menu specs check template images recursively.

<a id="search-everywhere"></a>
## Search Everywhere

A modal for finding things and running actions, modeled on JetBrains' Search Everywhere.

<a id="search-entry-points"></a>
### Entry points

| Trigger | Opens on |
| --- | --- |
| Double Shift (two Shift presses ≤ 300 ms apart, nothing between them, no modifiers, from any focus including the composer) | All |
| File ▸ Search Everywhere… `⇧⌘K`, the toolbar's Search button | All |
| File ▸ Find in Files… `⇧⌘F` | Text. A one-line selection in the editor becomes the query. |
| File ▸ Find Action… `⇧⌘A` | Actions |
| File ▸ Project commands… `⌥⌘R` | Commands (only when the Commands module is on) |
| File ▸ Open Quickly… `⇧⌘O` / alias `⌘P` | Quick Open: the same component limited to Files, with no tab strip |

<a id="search-modal"></a>
### Modal layout and keyboard

- The modal is `min(640px, 100vw − 32px)` wide and sits 64 px below the top of the window, not centered. Slow text results then add rows at the bottom while the field stays still.
- The Text tab widens it to 1000 (list 410 on the left, preview on the right), animated with the `--motion` token.
- The hairline is a ring outside the content. The shadow is `--shadow`. All colors come from semantic tokens.
- **Header.** The shared `ui/Input` L field and a borderless `PopupClose` Esc button in place of a close icon. Clicking the button or pressing Escape closes the search and returns focus. The button's accessible name is translated.
- **Tab strip** under the field: `All · Agents · Files · Text · PR · Commands · Actions`.
  - Each tab has a match counter, and a tab with zero matches is dimmed. On All every tab shows its count; on other tabs only the selected one does.
  - PR and Commands disappear entirely when their modules are off (`visibleSearchTabs`), and `Tab` skips them.
  - Selected tab: `--sel`. Hovered tab: `--segment-hover` with `--fg` text. Controls use the S scale.
- **Accessibility.** The input is a combobox with a listbox and `aria-activedescendant`. Arrows keep focus in the field. Matches are highlighted in JSX and never inserted as HTML.
- **Hover equals selection over the whole row** (both lines), filled with `--sel`. More N, text options and fields have their own hover. More N hovers with 12 % accent.
- **Keys:**
  - `⇥`/`⇧⇥` switch tabs from the field. Elsewhere Shift-Tab and the buttons keep native focus navigation.
  - `↑↓` move between rows. `↩` runs the main action and `⌘↩` the second one, depending on the row type. Enter on the Esc button never opens a result.
  - `⌘→` on a row in All opens that row's group tab.
  - On Text: `⌥↓`/`⌥↑` jump to the next/previous file, and `⌥C` `⌥W` `⌥X` toggle the text options.
  - `Esc` closes the modal.
- **Footer.** Key hints for the selected row's type, spelled for the platform. Status on the right (searching the text…, counts, no matches).
- **Empty state.** `Nothing found for «query»` plus a line saying where the search looked (tasks of every project, files, text, PR when the module is on, actions and settings). While the text search is still running, the state is not empty.

<a id="search-tabs"></a>
### Tabs and row actions

| Tab | Source and matching | `↩` | `⌘↩` |
| --- | --- | --- | --- |
| Agents | Tasks of every open project. Case-insensitive substring of title, project name **and prompt**. Order: needs you → working → the rest by recency. Archived tasks form their own group, In the archive, but only for a typed query ([archive](tasks.md)). | Show the task | Show changes. For an archived task: Restore from archive (`↩` opens it read-only). |
| Files | The same fuzzy file index as Quick Open and `@` mentions ([Composer](composer.md)). It belongs to the shown task. With no task shown, it searches the selected project's main tree. | Open in the editor (in the main tree when there is no task) | To composer (needs a task) |
| Text | Find in Files, [below](#search-text) | Open at the line and column | Line to chat: a `file:line` code chip (needs a task) |
| PR | The project's PR list that is already loaded (PR cache), with no new request per keystroke. Matches number (`#42` or `42`), title, author and branch. Groups as in the PR panel: Waiting for you · Yours · Others · Recently closed. Rows use `ui/PRGlyphs` (`PRStateGlyph`, `PRMarkGlyph`). | Open in the PR panel (task, else main tree) | Open on GitHub |
| Commands | [Project commands](#commands-search) | Run and show | Run in the background |
| Actions | Enabled menu-bar commands. Uses `menuCommandEnabled` with the focus context captured before the modal opened, and follows modules. Then settings rows. | Run the action as if picked from the menu | Change shortcut: opens the keymap editor in Settings ▸ Appearance |

- **Actions rows** show a glyph, the label, the menu name and the current keymap shortcut. They match on the UI-language label and on the English label; an English match shows the English label dimmed. Items that open this modal (Search Everywhere…, Find in Files…, Find Action…, Open Quickly…, its alias, Project commands…) are left out. Font size items appear only where the menu enables them (`font` context).
- **Settings rows** come from the settings form and show the path `Settings ▸ Tab ▸ Section` plus the current value.
  - A switch row uses `SwitchMark` (the look of `Switch` S without the button). `↩` toggles it in place and the modal stays open.
  - Every other setting, including a switch that cannot be turned off right now (the last enabled agent), opens its Settings tab and highlights the row (1.5 s `--accent-soft`, scrolled into view).
  - Settings match on row name, section and value in both languages.
- **All**:
  - With a query: groups in the fixed order `Agents · Files · Actions · PR · Commands · Text` (`allGroups`), with up to 3 rows each (`allGroupLimit`). The group header shows the name, the count and `More N →`, which opens the group's tab with the same query. Empty groups disappear. Settings sit inside Actions. Text comes last because it arrives last: its rows are added below and nothing above moves. Code lines in All have their leading indent removed.
  - Empty query: **Recently opened** shows up to 6 tasks, files, PRs and actions opened from search during this run of the app, newest first. It lives in renderer memory and is never written to disk. Tasks that need you or are working fill the remaining slots. With no recents and no live tasks, the list has no padding.
- **Rows:**
  - The task status glyph is 14 px.
  - An archived task's name stays `--fg2`, even when the row is selected.
  - The repo chip is 15 px with an inner hairline.
  - The root repo `.` is shown under the project's name.

<a id="search-text"></a>
### Text (Find in Files)

- **List.** Matches are grouped by file (`name · path · count`), with `number  code` rows and the match highlighted.
- **Preview.** Header `file · path · line N · M matches in file`, numbered code lines, and matched lines filled with `--sel`. Syntax colors come from the same `readCodeSyntax` as chat code blocks.
- **Options above the list:**
  - `Aa` match case, `W` whole word, `.*` regular expression, toggled with `⌥C` `⌥W` `⌥X`. An option that is on uses `--sel`.
  - `Mask`: comma-separated globs, where `!` excludes. A glob without `/` matches the file name.
  - Repo picker: `All repos` or one repo, a `Popup` S with a `ui/Popover` menu and a ✓ on the selected entry.
  - The options persist for the rest of the run.
- **Progress.** A bar under the options, `Searching further… N of M files` in the list, and `N matches in M files · searching…` in the footer.
- **Engine, in main** (`main/text-search.ts`, channels `search:text`, `search:text-cancel`, `search:text-event`, `search:peek`, `search:text-repos`):
  - It searches the files of the same index as the Files tab. That index already respects each repo's `.gitignore` and covers every git root of a monorepo (root, submodules, a gitignored nested repo, worktrees) plus repos outside the task.
  - The engine is `rg`, taken from the login-shell `PATH`, `/opt/homebrew/bin` or `/usr/local/bin`. Without it the engine is `git grep --no-index`. ripgrep is not bundled.
  - Files go in batches of 200 in index order, two processes at a time. Each batch emits an event with its matches and the scanned count, so progress is honest and rows are added at the bottom. `git grep` output is re-sorted to index order and then line order.
  - Limits (`textSearchLimits`): 2000 matches per search, 100 per file, and lines cut to 400 characters. When a limit is hit, the search stops with `Showing the first 2,000 matches`.
  - A new query cancels the previous one and kills its processes. Closing the modal does the same.
- **Timing.** In All, text search starts after a 250 ms pause and from 3 characters. On the Text tab it starts after the same pause from 1 character. An invalid regex does not start a search and shows `Invalid regular expression`.
- **Without a task**, Files and Text search the selected project's main tree, which the modal opens the same way the repo row does ([Projects](projects-and-board.md)). With no project, a hint row replaces the results.

<a id="project-commands"></a>
## Project commands

<a id="commands-model"></a>
### Model and storage

- A command has a name, a shell line, a repo of the project and an optional folder inside that repo. Saved in `projects/<id>/project.json`, field `commands` (pretty-printed JSON with sorted keys, [data](architecture-and-platform.md)). Nothing is written into the repo, so the command file never shows up in a task's diff.
- `ProjectCommand = { id, name, command, repo, directory, agentRuns? }`
  - `repo` is relative to the project root (`''` = root). `directory` is relative to the repo.
  - `agentRuns` is optional; absent means `false`.
- Limits: 64 commands per project, a name of up to 80 characters on one line, a line of up to 8000 characters.
- Folders are relative. They never contain `..` and never enter `.git` or `.brigadir`. A typed folder is normalized (`./apps/admin/` → `apps/admin`).
- **IPC** (`commands:runs`, `commands:run`, `commands:scripts`, `commands:save`, `commands:menu`). For a saved command the renderer sends only `{ commandId }`. Main reads the line and folder from `project.json`. A one-off run sends `{ line, directory? }`.
- The Commands module switches off the whole feature: the toolbar button, the search tab, the menu items and the MCP tools ([Modules](settings-modules-and-onboarding.md)).

<a id="commands-run"></a>
### Running

- **Commands always run in the task's console** ([Terminal](terminal-and-cli-agents.md)). The tab carries the command's name and shows a state glyph instead of the terminal icon.
- `cwd` is the selected repo **in the task's tree** (the worktree when the task is isolated) plus the command's folder.
- The shell is the console's: `$SHELL -l -c '<line>'`, with the person's environment, not the agent's.
- Without a shown task, commands do not run. There is no project-level console.
- **One command = one tab per task.**
  - Running a live command again restarts it in the same tab: Ctrl-C (through the tty, plus `SIGINT` to the process group), `SIGTERM` to the group after 3 s, `SIGKILL` after 5 s, then a new process with the buffer cleared.
  - Stop follows the same escalation.
  - After a stop or an exit, the tab stays with its output until it is closed.
  - Closing a live tab, closing the task and quitting follow the console rules (`SIGHUP`, the same confirmation).
  - Command tabs do not survive a restart.
- A one-off run (Run once) opens a tab named after the line (cut to 40 characters) and saves nothing.

<a id="commands-states"></a>
### States

| `RunState` | Label | When |
| --- | --- | --- |
| (none) | not run yet | no tab in this task |
| `starting` | starting | alive, no local address seen yet |
| `running` | running | alive, and the output contained `http://localhost:N` or `http://127.0.0.1:N` (ANSI stripped, `outputPort`) |
| `failed` | crashed | exit ≠ 0 and ≠ 130 |
| `done` | finished | exit 0 |
| `stopped` | stopped | stopped by the person, or exit 130 (Ctrl-C) |

- A running command shows a `:N` chip. Clicking it opens the address in the task's browser ([Browser](browser-and-simulator.md)).
- A failed command shows `exit N`. In the console, a failed run gets the console's failure strip with Restart and Show the agent.

<a id="commands-toolbar"></a>
### Toolbar button

- **Placement.** In the task toolbar right after the task title (title · Commands · Agents · Search · Tools · Layout).
- **Content:**
  - The state glyph and the name of the **current** command: the last one run or picked in this task, else a live one, else the first.
  - `+N` when other commands run in the background, and a chevron.
  - Next to it, ▶ Run, or for a live command ↻ Restart and ■ Stop.
  - With no commands, the button is labeled `Commands`.
- **Narrow toolbars** ([Task window](task-window.md)). The button shrinks to `compact` (state glyph, chevron and action; the name moves to the tooltip) below 620 px of toolbar width. It shrinks to `minimal` (state glyph and chevron only) near the toolbar-labels threshold (threshold + 160). There Run and Stop live in the menu and on `⌃⌘R` / `⌃⌘.`. Below that it moves into the toolbar's `…` overflow.
- Run current command and Stop current command act on the current command of the open task. They do nothing while a dialog is open.

<a id="commands-menu"></a>
### Commands menu

- A `ui/Popover` with the header `Commands · <project>` and Esc ([Esc rule](appearance.md)).
- **Rows.** State glyph, name, repo (or the project name), the line in monospace, a `:N` port chip or `exit N`, and a ▶/■ button. Clicking a row shows its console tab, or runs a command that has not been run yet.
- Rows take `--tint` on hover and under `:has(:focus-visible)`, never `:focus-within`. A menu opened by a click therefore highlights only the hovered row, and a menu opened from the keyboard highlights the first row with its focus ring.
- **Right-click** opens a native menu (`commands:menu`). Its set of items is fixed; items that do not apply are disabled: Run/Stop · Restart · Show in console · Open in browser · Edit… · Duplicate · Delete. Glyphs come from `commandMenuIcons`.
- **Footer.** `New command…`. When the project has no commands: `No commands`, a `pnpm run dev` example and a primary `Add command…` button.

<a id="commands-search"></a>
### Commands in Search Everywhere

- Rows show a glyph, name, line, repo and state, grouped into `Running now` and `Commands`. The query filters on name and line.
- A non-empty query adds a group `New` with two rows. `Run once` (`⌥↩`) opens an unsaved tab. `Save as command…` opens the editor with the typed line filled in.
- **Keys:**
  - `↩` runs and shows the tab. For a live command it only shows the tab.
  - `⌘↩` runs in the background.
  - `⌃⌘R` restarts, `⌃⌘.` stops (keymap keys of Run/Stop current command).
  - `⌘E` opens the editor.
- **Without a shown task**, the commands are still listed, but a hint row `Open a task to run a command` stands in for running. Only the name dims (`--fg3`); the selection, glyph and line keep full contrast. Editing works without a task.

<a id="command-editor"></a>
### Command editor

- A modal sheet, 600 px wide, with Esc in the header. Focus goes to `Name` on every open.
- **Fields:**
  - `Name`.
  - `Command`: monospace 12/18, two lines, 56 px tall, with a `Scripts ▾` button on its label row (see [package scripts](#package-scripts)).
  - `Repo`: `Button` M per project root, with the repo name in monospace 12/500.
  - `Folder inside the repo` (optional). Under it, `In this task` shows the path where the command will start in this task (`worktree/…` when isolated). Without a task, it shows the path from the project.
  - A checkbox `Agents can run it without confirmation` (`agentRuns`, off by default).
- **Buttons:** `Delete` (existing commands only, `appearance="danger"`), `Cancel`, `Save`, `Save and run` (only with a task).
- A folder that leaves the repo (`..`) disables Save.
- Errors appear as a line above the footer and name the action (`Could not save the command.`, `Could not run «name».`).
- While saving, the whole checkbox row dims.
- The shared `Choice` checkbox and radio show a `--fg2` ring when their `label` row is hovered.

<a id="agent-command-tools"></a>
### Agent tools for commands

These MCP tools belong to the `commands` module, so switching the module off removes them ([agent tools](agents-and-providers.md)). The agent's briefing tells it, in English, to check `commands_list` before starting a dev server or a long script itself.

| Tool | Args | Behavior |
| --- | --- | --- |
| `commands_list` | — | Read-only. Saved commands with `id`, name, line, repo, folder, the absolute `cwd` in this task's tree, `agentRuns`, the state (`not run`, `starting`, `running`, `failed`, `done`, `stopped`), the local address and the exit code. Only this task's runs are included. |
| `commands_run` | `id`, `restart` (false), `wait` 0–120 s (20), `lines` 1–400 (40) | Runs a saved command in this task's console, like Run. A live command is left alone unless `restart: true`, and the reply says it already runs, with its port. Waits until a local address appears or the process exits, then returns the state, URL, exit code and the last lines. |
| `commands_output` | `id`, `lines` 1–400 (80) | Read-only. The last lines without ANSI codes, with state, URL and exit code. |
| `commands_stop` | `id`, `lines` (40) | Stops a command like Stop (Ctrl-C, then `SIGTERM`/`SIGKILL` to the group). |

- **Arbitrary lines are never accepted.** The agent has its own shell tool for those, under its own permissions. Run once stays a person-only action.
- **Permission.** Reading needs no permission. Running or stopping a command without `agentRuns` shows a permission card `Run <name> · <line>`, with the folder in the request input:
  - `Allow in this task` allows that command in the task until the app restarts.
  - `Always allow agents` sets `agentRuns: true` in `project.json`. Agents of every task in the project then run and stop it without asking.
  - `Deny` returns a refusal to the agent.
- **Same tab, same button.** An agent run opens the same console tab and updates the toolbar button (host `run` event), so the person sees it and can stop or restart it.
- **Chat rows** are ordinary MCP tool rows: Running/Ran a command (with name and `:N`), reading output, Stopped a command ([Chat](chat.md)).

<a id="package-scripts"></a>
### `package.json` scripts

- **Discovery** (`commands:scripts`, read-only):
  - Main reads the `package.json` files of each project repo in the main tree using `git ls-files --cached --others --exclude-standard`. That excludes `node_modules`, submodules and nested repos, which count as separate repos.
  - Up to 64 files and 200 scripts per file (`packageFileLimit`, `packageScriptLimit`). A repo without Git contributes only its root `package.json`.
  - A script is a string pair from the top-level `scripts` object. Values of other types are skipped.
- **Command line**: `<manager> run <name>`. The name is single-quoted when it contains anything besides letters, digits and `_ - : . / @`.
  - The manager comes from `packageManager` (`pnpm@9…` → `pnpm`). Otherwise it comes from the first lock file found walking up from the `package.json` folder to the repo root (`pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, `bun.lock`/`bun.lockb` → bun, `package-lock.json` → npm). Otherwise it is `npm`.
  - The script body is never copied, so edits to `package.json` take effect without touching the command.
- **Editor context menu** (files named `package.json` only, [Editor](editor.md)). A first group with `Run script` and `Add to commands…`.
  - Both items are enabled when the caret (or the right-click point) is on a key/value line inside the top-level `scripts`. Otherwise they are disabled, and the group's set of items never changes.
  - The script comes from the buffer, so unsaved edits count.
  - `Run script` is a one-off run in a task console tab. `cwd` is that `package.json`'s folder in the task tree. Nothing is saved.
  - `Add to commands…` opens the command editor filled from the script: Name = script name, Command = the line, Repo = the file's repo, Folder = the `package.json` folder. If an identical command (same repo, folder and line) already exists, that command opens for editing instead.
- **`Scripts ▾` in the command editor.** Shown when the selected repo has scripts.
  - It opens a `ui/Popover` with the header `Scripts · package.json` and Esc. Rows show the script name and its body in monospace. When the repo has several `package.json` files, the rows are grouped under each file's path.
  - Picking a script fills Command and Folder. It fills Name too when Name is empty or still holds the previously picked script's name.
  - Switching the repo reloads the list.
  - The whole row is the hover target.

<a id="later"></a>
## Later

- Search inside chat transcripts.
- Persisting Search Everywhere's Recently opened to disk.
- Autostart of commands when a task opens.
- Environment variables in the command editor. For now, put them in the line itself (`PORT=5174 pnpm dev`).
- A repo-shared commands file (`.brigadir/commands.json`).
- Agents saving new commands through a confirmation card, as `create_task` works.
- Commands running in other tasks of the project listed in `commands_list`.
- A ▶ gutter marker next to each `package.json` script.
- A light glyph variant for menus on Windows/Linux.

<a id="non-goals"></a>
## Non-goals

- Running a project command without a task in the main tree. That would need a second console lifecycle.
- `commands_run` with an arbitrary line, or running every saved command without asking. A saved line can be `pnpm deploy:prod`.
- Bundling ripgrep, and running `git grep` per repo. The second skips gitignored nested repos and submodules.
- Prefix syntax in search (`#`, `@`). Tabs and shortcuts cover the same entry points.
- Copying script bodies into commands, or listing scripts as a live unsaved group in the Commands menu.
- Putting every modal-only key into the menu bar.
- `⌘W` closing the window.
