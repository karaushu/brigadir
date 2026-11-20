# Settings, modules and onboarding

The Settings window holds every global preference in `~/.brigadir/settings.json`. It follows a few rules: rows carry no explanatory captions, a row with a switch is one hover and click target, and new tasks read their launch defaults from it. Modules are parts of the app that switch off whole: their UI, menu items, shortcuts, background work and MCP tools all go with them. A module's own settings open in a popup from its row. The first-run intro is the same settings shown for the first time, step by step over a window that assembles itself.

Related: theme, accent, fonts and the settings form look in [Appearance](appearance.md); the Helper agent and prompt suggestion in [Steering, prompt queue and ghost suggestions](composer-steering-queue-and-ghost.md); CLI updates, model and effort in [Agents and providers](agents-and-providers.md); the remote access popup in [Remote access and mobile](remote-access-and-mobile.md); the Notes, Schedules and Slack modules in [Notifications, Slack, notes and schedules](notifications-slack-notes-and-schedules.md); shortcuts and the menu-bar rule in [Search, shortcuts, menus and project commands](search-menus-and-commands.md).

<a id="settings-window"></a>
## Settings window

`LayoutSettings` (renderer) is a modal `<dialog>` opened with `⌘,` (`Settings…`). Its header has the title and `Esc` (`ui/PopupClose`), then a tab row.

| Tab | Key | Contents |
| --- | --- | --- |
| Appearance | `appearance` | `Appearance` (Theme, Accent), `Toolbar labels`, `Task layout`, `Tasks` ▸ `View`, typography, `Keyboard` ▸ `Keymap` |
| Editor | `editor` | see [Editor](editor.md), [Code intelligence](editor-code-intelligence.md) |
| Language | `language` | `Interface language` (`Follow system`, `Українська`, `English`), restart line; `Updates` card with the `Brigadir` row ([auto-update](architecture-and-platform.md#auto-update)) |
| Notifications | `notifications` | `When`, `macOS permission`, `Sound` with per-slot sounds, quiet-while-viewing |
| Agents | `agents` | `Providers`, `Agents`, `Auto`, `Reviews`, `Tasks` cards ([below](#agents-tab)) |
| Templates | `templates` | see [Crew templates](crew-templates-and-editor.md) |
| Modules | `modules` | the module list ([below](#modules)) |

- The window is one size for every tab, 780 × 720 (`min(…, 100vw − 48px)` × `min(…, 100vh − 48px)`), so switching tabs never moves or resizes it; a taller page scrolls. Form tabs are a 588 px column in the middle of the page; `Templates` (list and editor) and `Modules` (the module list) take the whole width. Seven tabs on an 80 px step (76 px each) with a sliding indicator, centred. The tab padding is 4 / 6. Tabs move with Left/Right/Home/End.
- The header uses `--sb` and styles only its own header (`.dialog > header`). Popovers, the keymap dialog and module popups inside the window keep their own headers.
- The window loads the settings on open. While loading it shows skeleton rows. If the read fails it shows `The settings could not be loaded.` and `Retry`. A failed save shows `The settings could not be saved.` inline.
- While a save is in flight the form is `<fieldset disabled>`. `useKeepFocusWhileBusy` (`ui/keep-focus.ts`) gives focus back to the control that started the save once the form is enabled again, unless focus has moved elsewhere. A `ui/Popover` waits for its disabled trigger before it returns focus. This keeps Tab order and Esc working across saves.
- Search Everywhere can open Settings at a row: the tab opens, the row (`data-settings-row`) scrolls to the centre and is lit with `--accent-soft` for 1.5 s. `initialTab: 'remote'` opens `Modules` with the remote access popup.
- Every open `dialog` and `:popover-open` element sets `-webkit-app-region: no-drag` (`tokens.css`). Without this, macOS would take clicks on a tall dialog's `Esc` where it overlaps the toolbar's drag region. Playwright clicks through CDP, so e2e tests cannot catch this.

<a id="no-captions"></a>
### No explanatory captions

Settings tabs have no static explanations under cards or controls. Only these are shown:

- **States and statuses**, e.g. `Prettier 3.9.5`, "Prettier not found", the found simulator tools.
- **Errors and warnings**: a sound that failed to play, a missing font, unreadable formatters, the language restart line. Warnings use amber.
- **Option descriptions in radio groups** (`Toolbar labels`, `Task layout`), because they are the content of the choice.
- **Module second lines** in `Modules` and the overview and facts in the remote access popup. A module is turned on once and rarely, and its name does not say what will disappear or what opens to the network.
- A one-line scope hint on a few rows, e.g. `Default agent` ("New tasks, Review with an agent, Agent fixes it, resolving conflicts."), `Prompt suggestion` ("Written by the helper agent.") and `Archive completed`.

Why: the removed text repeated the control's name or described mechanics nobody needs in order to choose. Any new explanation must fit one of the categories above.

<a id="settings-text"></a>
### Labels and text rules

- One concept has one label. The notification picker is `When` in both the notification section and the sound section. Its values reuse state terms: `When you are needed`, `When a turn ends`, `Never`. The intro shows each value's description as a second line, and the Settings menu shows it as `aria-description`:

  | Value | Description |
  | --- | --- |
  | needs-you | The agent asks a question or asks for permission. |
  | turn-ended | When the agent finishes each turn. |
  | off | Brigadir does not show notifications. |

- The sound picker's empty slot is `None`, which is localized. System sound names (`Ping`, `Tink`, `Basso`) stay as they are. The slot for the `failed` state is labelled `Error`, because a slot names an event, not a protocol field.
- No abbreviations such as "Off." The answer to `When` is `Never`.
- A sound plays as soon as it is picked. There is no ▶ button.
- **Language restart:** the restart line sits inside the language card, under the picker, and only when the chosen language differs from the running one. It reads `The language will change after restart.` with a `Restart` button. A device window never restarts the working machine, so it has no button there.
- Section headings belong to the group below them: 20 px above, 6 px below.
- Code font defaults: terminal 13 px × 1.0, diff 11 px × 1.6, editor 12 px × 1.6. Line height is size × multiplier, rounded to a whole pixel. All sizes are 8–24.
- Fractional steppers (`Line height`, `Scroll speed`) are text fields that use the interface language's decimal separator (`1.0` in English, `1,0` in Ukrainian). Either separator is accepted on input. Integer steppers stay `number` inputs.
- A popup menu is never narrower than its button (`min-width: max(200px, 100%)` in the shared `Popup`). It is at most 300 px tall and scrolls beyond that.

<a id="row-hover"></a>
### Rows with a switch: one target

A settings row (`SettingsRow`, and the `Rights` row in Templates) whose control is a switch is hovered and pressed as a whole: the label on the left, the switch, the text beside it, the hint under it and the empty space.

| State | Look |
| --- | --- |
| Hover | `--tint` fill on the whole row, reaching the separator and the card corners (radius 8 on first and last rows) |
| Pressed | `--segment-press`; toggles on release |
| Keyboard focus | the global focus ring on the switch plus the row's hover fill; Space toggles |
| Disabled (e.g. the last enabled provider) | no hover, no press, same look (it does not dim: it is disabled during every save and would flicker) |

- Mechanics: the switch's `::after { inset: 0 }` covers the row. The switch has no hover of its own.
- Nested buttons (`Check now`, `Sign in…`, `Check`, `How to install`) and the copyable install command sit on top with their own hover. Clicking them does not toggle, and the row underneath stays hovered.
- Radio options (`SettingsOption`) use the same tokens: hover `--tint`, pressed `--segment-press`.
- The same pressed style applies to the icon buttons in the PR panel header (`Find PR`, `Refresh`, `Open on GitHub`): hover `--tint` + `--fg`, pressed `--segment-press` + the shared press scale ([motion](appearance.md#motion)). While reading, the `Refresh` glyph spins at `--motion-spin` and finishes its turn after the reply; under reduced motion it turns at 2.4 s.

<a id="agents-tab"></a>
### Agents tab and launch defaults

| Card | Rows |
| --- | --- |
| `Providers` | `Claude Code`, `Codex`: switch + `AgentStatus` (found / sign-in state, `Sign in…`, `Check`, `How to install`); `CliUpdatesRow` |
| `Agents` | `Default agent` (Claude / Codex segments), `Helper agent` capsule, `Subagent model` (Claude catalog models, first item `Same as the agent`; shown while Claude is on; caption "Claude's own subagents search and read on this model."), `Compaction window` (`Agent's default`, `100k`, `200k`, `400k`; caption "New sessions compact their context when it reaches this many tokens."), `Task budget` (one popup per enabled provider, each named by its provider when two are on: `No limit`, `500k`, `1m`, `2m`, `5m`, `10m`; caption "A task pauses and asks when its agents use this many tokens. New tasks only."; [task budget](agents-and-providers.md#task-budget)), `Customize per action` rows (groups `Tasks`, `Reviews`, `One-off texts`, `Slack`; `Reviews` holds `Plan review` and `Code reviews`, whose inherited entry is `Auto` — [who reviews](reviews.md#who); `Plan review` also has `Off`), `Launch in` (`GUI` / `Terminal`), `Isolation for CLI tasks` (`No isolation` / `Worktree`), `Max concurrent` (0 = `Unlimited`, up to 99), `Keep awake` and `Display` rows, `Prompt suggestion` |
| `Auto` | `Models` ▸ `Any catalog model` (switch; caption `Off: for a model outside the roles the agent asks first.` / `On: the agent picks a model for a part without asking.`), `Part budget` (minutes and thousands of tokens, steppers; caption `A worker over its budget stops and asks.`) — [Auto](crew.md#auto) |
| `Reviews` | `Small task limit` (files and changed lines, steppers; caption `A small task that grows past this gets a mid-task review.`) — [tripwire](reviews.md#tripwire); `Smoke run limit` (minutes, stepper; caption `At the limit the run stops and the agent reports.`) — [the limit](smoke-run.md#limit) |
| `Tasks` | `Archive completed` (`Never`, after 1 / 3 / 7 / 30 days) |

- A disabled provider is not offered in New task, in templates or as `Default agent`. Tasks that already use it still open. A provider that was not found cannot be turned on. The last enabled provider's switch is disabled. Turning off the default provider moves `agents.provider` to one that is on.
- `Default agent` and `Launch in` are the global defaults for New task. The sheet reads the saved choice before it shows its controls. If the read fails it shows an error and `Retry`, never a silent fallback. The sheet can override both for one task without changing the default. Live and stored tasks never change when the default changes.
- `Helper agent` uses the same `ComposerOptions` capsule as the `Customize per action` rows: provider glyph · model · effort glyph · effort · chevron, with a menu headed `Helper agent` and `Esc`. The menu lists the enabled providers' groups, then `Effort`. It has no `Same as …` option. Choosing an item saves it and keeps the menu open (`locked={false}`). Esc closes only the menu and returns focus to the capsule.
- An effort list that does not fit in segments (more than three levels) gets an `Effort` row of its own above the list.
- Status buttons in a row use the row's size (M), per [one row, one height](appearance.md).

<a id="settings-keys"></a>
## Stored settings introduced by onboarding

Everything the intro can change lives in `settings.json` (`schemaVersion` 1). A missing field reads as its default.

| Field | Values, default | Where in Settings |
| --- | --- | --- |
| `onboarding.completedVersion` | number ≥ 1 or `null`; `null` | nowhere; `null` opens the intro on start (`onboardingVersion` = 1) |
| `agents.enabled` | `{claude, codex}`, both `true`, at least one `true` | Agents ▸ `Providers` |
| `agents.provider` | `claude` \| `codex`, `claude`; must be enabled | Agents ▸ `Default agent` |
| `agents.claudeSubagentModel` | Claude catalog model value or `null`, `null` | Agents ▸ `Subagent model` ([Agents and providers](agents-and-providers.md#subagent-model)) |
| `agents.compactionWindow` | integer 100 000–1 000 000 tokens or `null` (agent's default), `200000` | Agents ▸ `Compaction window` ([Agents and providers](agents-and-providers.md#compaction-window)) |
| `agents.taskBudget` | `{claude, codex}`, each an integer 1 000–10¹² tokens or `null` (no limit); both `null` | Agents ▸ `Task budget`; copied into each new task as `tokenBudget` ([Agents and providers](agents-and-providers.md#task-budget)) |
| `agents.transport` | `gui` \| `terminal`, `gui` | Agents ▸ `Launch in` |
| `agents.isolation` | `in-place` \| `worktree`, `in-place` | Agents ▸ `Isolation for CLI tasks` |
| `auto.anyModel` | boolean, `false` | Agents ▸ `Auto` ▸ `Any catalog model` ([Auto](crew.md#auto-model)) |
| `auto.partBudget` | `{minutes 5–600, tokens 50 000–20 000 000}`, `{40, 400000}` | Agents ▸ `Auto` ▸ `Part budget`; copied into each new Auto task ([Auto](crew.md#auto-budget)) |
| `reviews.smallTask` | `{files 1–500, lines 10–20 000}`, `{15, 300}` | Agents ▸ `Reviews` ▸ `Small task limit`; read by each task's host at every check ([tripwire](reviews.md#tripwire)) |
| `reviews.smokeMinutes` | 1–60, `10` | Agents ▸ `Reviews` ▸ `Smoke run limit`; read at each `smoke_start` ([the limit](smoke-run.md#limit)); a `reviews` object without it reads as `10` |
| `editor.codeTheme` | `brigadir` \| `vscode` \| `intellij`, `brigadir` | Editor ▸ `Code theme` |
| `projects.defaultView` | `board` \| `list`, `board` | Appearance ▸ `Tasks` ▸ `View` |
| `keymap` | `{preset, overrides}`, `brigadir`, `{}` | Appearance ▸ `Keyboard` ▸ `Keymap` |
| `modules` | see [Modules](#modules) | Modules |

- `agents.isolation` is the starting value for each new CLI task. An Auto task on GUI and a crew start in a worktree ([Tasks](tasks.md#isolation)). The New task sheet's choice applies to that task only.
- `projects.defaultView` applies to projects without a saved view. The switch on the project screen still remembers each project's own view.
- Code themes recolour only the syntax tokens (`--syntax-*`) of the editor and the diff. Each theme has light, dark and High Contrast palettes in `tokens.css`. The window chrome does not change.
- Keymap (`core/keymap.ts`): `keymap.preset` gives each `core/menu.ts` command its base shortcut, and `keymap.overrides[commandId]` sets a custom one or `null` for none. The menu bar and every handler take shortcuts from one function, `commandAccelerator`. Two commands conflict only when they are in the same scope (`shortcutScope`: global, chat, editor, diff, console, browser, simulator, pullRequests, composer) or when one of them is global. Reserved accelerators cannot be assigned: on macOS `⌘Space`, `⌘Tab`, `⌘Q`, `⌘H`, `⌘M`, `⇧⌘3`, `⇧⌘4` plus the app's fixed items; Windows and Linux have their own table. The VS Code and IntelliJ presets override only the commands that have an equivalent, and no preset conflicts with itself (`keymap.test.ts`). While a shortcut is being recorded, IPC `keymap:recording` drops the menu accelerators. Details: [shortcuts](search-menus-and-commands.md).
- `Keymap` row: the preset name, `· N changed`, and `Customize…`, which opens the intro's `KeymapEditor` in `KeymapDialog`. It is one component for the intro and Settings.

<a id="modules"></a>
## Modules

A module is a part of the app that switches off whole: its column or section, toolbar button, menu items with their shortcuts, background processes and requests, and its MCP tools. The console, editor and crew are not modules.

`modules` in `settings.json` (`core/modules.ts`):

| Key | Row name | Second line | Default | Has settings |
| --- | --- | --- | --- | --- |
| `browser` | `Browser` | Pages in the task window, for you and the agent. | on | yes |
| `simulator` | `Simulator` | iOS and Android · found tools, or `Xcode not found` / `Android SDK not found` in amber | off | yes |
| `pullRequests` | `Pull requests` | PR list and review from GitHub. | on | yes |
| `commands` | `Commands` | A button that runs project commands. | on | no |
| `remoteAccess` | `Remote access` | Control this machine from another computer. | on (access itself stays off) | yes |
| `notes` | `Notes` | Markdown notes with their own agent chat. | on | no |
| `schedules` | `Scheduled tasks` | Run a task later or on repeat. | on | no |
| `slack` | `Slack` | Task and CI messages from your CI bot. | off | yes |

- `withModuleDefaults`: a file written before a module existed takes that module's default, and the keys it has stay as read. Main and host parse it the same way.
- The simulator is off by default because only projects with a mobile app need it, and its tools cost context in every session. The other modules shipped as on before they could be switched off, so an update must not remove them.
- Changes apply at once, without a restart (`restartRequired` is not set).

<a id="module-off"></a>
### What a module that is off removes

- **UI:** its column or section in every task or screen, its toolbar button, and its items in `View` and its own menu. With no menu item there is no shortcut either (`commandModule`, `keymapCommands`): the key is free and does nothing. Saved per-task flags (e.g. `showsBrowser`, a saved `PR` panel choice) stay on disk without effect, so the UI comes back where it was when the module is turned on again.
- **Processes:** the browser closes its `WebContentsView`s. The simulator stops its helper, CDP clients and the devices it started.
- **MCP tools:** a tool belongs to a module by its name prefix (`browser_*`, `simulator_*`, …) or by the explicit table (`pr_comment`, `pr_comment_reply`, `pr_state` → `pullRequests`; `note_read`, `note_edit` → `notes`). These tools are filtered out of `tools/list` in the single `brigadir` MCP server: `mcpTools(role)` takes the set of enabled modules, and the list cache is keyed by role and that set. There are no per-module servers.
- **Live sessions:** the host watches `settings.json` itself (`packages/host/src/modules.ts`, a directory watch because saves are atomic renames). On a change it sends `notifications/tools/list_changed` to every open MCP connection. Claude rereads the list within the current turn. Codex keeps its list until a new session or a resume, so a call to a tool of an off module always returns `moduleOffMessages[module]`, e.g. `The browser is off in Settings.` A module turned on stays invisible to a live Codex session until it restarts, and the app does not force that restart.

Module-specific effects:

| Module off | Effect |
| --- | --- |
| `pullRequests` | No PR counter on the repo row (the repo row still opens the main tree); no PR section or `PR` segment, the panel shows `Changes`; no `Pull requests` items or shortcuts; PR overview and PR file tabs close (review drafts and summaries stay on disk); no GitHub list or PR requests and no refresh on focus; PR IPC answers `Pull requests are off in Settings.`; no PR MCP tools; a review task stays a normal task with chat and worktree, and its PR parts are hidden. `Create PR` and the task's PR state are part of the task's git flow and stay. |
| `commands` | No command button in the task toolbar; Search Everywhere has no Commands tab and `⌥⌘R` opens nothing; the four `File` items (`Project commands…`, run, stop and new command) and their shortcuts are gone; **running commands stop** like `Stop` (`SIGINT`, 3 s, `SIGTERM`) without a confirmation, and their console tabs keep the output until closed (with `Stop` but no restart or run again); the simulator's "Metro is not running" warning has no `Commands…` button; the command list in `project.json` stays. |
| `browser`, `simulator` | See [Browser and simulator](browser-and-simulator.md). |
| `remoteAccess`, `notes`, `schedules`, `slack` | See [Remote access](remote-access-and-mobile.md) and [Notes, schedules, Slack](notifications-slack-notes-and-schedules.md). |

Why one switch per module: every MCP tool goes into the context of every session (a deferred-tool entry in Claude Code, a full schema in Codex). A column without its tools, or tools without their column, would break the rule that the agent sees what the person sees.

<a id="module-list"></a>
### Module list

`ModuleList` (`ui/ListCard`) is one component used by both `Settings ▸ Modules` and the intro's `Modules` step.

- Each row shows the module's glyph, name, second line and a switch on the right. The whole row toggles and hovers (rule 15). A module that is off is dimmed.
- The simulator row reads the toolchain (`readSimulatorToolchain`) when it mounts, and its second line shows what was found (`Xcode 27 · Android SDK`).
- `locked` keeps a switch still. In a device's window, `remoteAccess` is locked so a device never turns off the working machine's access.
- In Settings, a module that is **on and has settings** shows a ⚙ button before the switch: `IconButton` M 28 × 28, ghost, glyph `search-setting`, `--fg2`, hover `--tint` + `--fg`. Its name and tooltip (system `title`) are `Browser settings`, `Simulator settings`, `Pull request settings`, `Remote access settings` and `Slack settings`. The button sits on top of the row, has its own hover and never toggles the row. A module that is off has no ⚙, and its open popup closes. The intro passes no settings handlers, so it has no ⚙.
- The intro passes `onHover` so the spotlight can follow the hovered row.

<a id="module-settings-popup"></a>
### Module settings popup

`ModuleSettingsDialog` on `ui/ModalDialog` is one popup for every module with settings. Its header shows the module's name and `Esc` (`ui/PopupClose`). It is 600 px wide, 56 px from the top, as tall as its content, with a scrolling body that uses the settings form with 16 px between sections. It opens above Settings. Esc or `Esc` returns to `Modules` with focus on the ⚙, and a second Esc closes Settings. Dialogs opened from inside it (password, log, pairing, `Forget`) open above the popup.

| Module | Popup contents |
| --- | --- |
| `Browser` | `Agents can act on any site without confirmation` (`agents.browserActAnywhere`, off) — "No permission card for actions. Local pages never ask." |
| `Pull requests` | `PR summary`: `Summarize a PR when its review opens` (`agents.prSummary`, on) |
| `Remote access` | the whole remote access settings: `This machine · Connect to another` part switch (`Segments` in `tabs` style), overview scheme and facts, switch and password, name, phone, devices, log, `Change password…`, machines, `Forget`. See [Remote access](remote-access-and-mobile.md). |
| `Simulator` | `Local devices` (`agents.simulatorDevices`, 2, `Stepper` 1–8) — "How many simulators run at once." A settings file without the key reads as 2. See [Device cap and memory](browser-and-simulator.md#sim-cap). |
| `Slack` | see [Slack](notifications-slack-notes-and-schedules.md); section `Agents`: `Agents can post without confirmation` (`agents.slackPostWithoutAsking`, off) — [Agents post as the bot](notifications-slack-notes-and-schedules.md#slack-agent-post) |

- Settings that stay where they are: a command's `agentRuns` (command editor), where Review with an agent runs (chosen in its launch dialog), project review notes (the project menu) and `Customize per action` (that is a choice of agent, not a module setting).
- Deep links: anything that opens remote access settings (toasts and chips, the `Remote` chip's menu items, Search Everywhere) opens `Settings ▸ Modules` with the remote access popup and the requested dialog or part. If the module is off, only `Modules` opens. The search path is `Settings ▸ Modules ▸ Remote access ▸ <section>`.

<a id="intro"></a>
## First-run intro

`renderer/Intro.tsx` is a full-window `<dialog>`. Rather than a separate wizard, the app window assembles itself behind a card. Each choice is saved to the real settings at once (a queued `saveSettings` with the whole settings object), so theme, accent, sizes, code theme, layout and modules change through the app's own tokens. A spotlight outlines the part of the window the current step changes.

- **When it opens:** on start when `onboarding.completedVersion` is `null` (an empty data folder), and from the app menu item `Show the intro again…` (EN label `Repeat setup…`) under `Settings…`. It starts from the current values and resets nothing.
- **Finishing:** `Done`, the `All set` buttons, or Esc on the welcome or done screen writes `onboarding.completedVersion = onboardingVersion`.
- **Skip:** a ghost button `Skip esc` in the card header (and on the welcome screen) jumps to `All set`, or back to `Agents` when no usable agent exists. Esc on any step does the same. Skip is a meaningful action ("skip setup"), so it is a deliberate exception to the `PopupClose` rule.
- `Back` and `Next` sit in the card footer, with dots for the steps. `Next` is disabled on `Agents` until the check has run and at least one agent is usable. On `First project` the button reads `Done` once a project has been added, and `Later` before that.
- **Language:** the intro and its demo window (cards, chat, board, states, demo tasks) follow the chosen language at once. The app's own language changes after a restart: `All set` then shows the restart note and a `Restart` button. English texts come from `messages.ts`. The English name is "Brigadir".
- **E2E:** with `BRIGADIR_SKIP_INTRO=1`, main writes a completed onboarding into a fresh settings file, so the intro does not open over every test.

<a id="intro-steps"></a>
### Steps

The order is Welcome, Appearance, Agents, Crew, Git and GitHub, Editor, Tasks, Modules, Notifications, Keyboard shortcuts, Remote access, Brigadir, First project, All set.

| Step | Card contents | Spotlight / window |
| --- | --- | --- |
| Welcome (`hello`) | helmet mark drops in, the name rises letter by letter, `Get started`, `Language` (`Follow system` / `Українська` / `English`) | — |
| `Appearance` | `Theme` cards (System / Light / Dark with previews), `Accent`, `Text size` stepper − N + (8–24; moves interface and chat together, resetting the chat's own size), `Task layout` cards (`Two columns` "Chat as a tab" / `Three columns` "Chat as a column") | whole window reflects the choice |
| `Agents` | provider list with check state (ok / warn / miss / checking), switch, `Sign in…` / `Cancel` / `How to install` (copyable command); `Default` (disabled or missing providers greyed); `Launch in` GUI / Terminal (the demo chat switches between chat and CLI look); `Check` | chat |
| `Crew` | see [Crew step](#intro-crew) | crew card in sidebar, then chat |
| `Git and GitHub` | `Git` and `GitHub CLI` status rows (`Signed in to github.com`, `Sign in with gh auth login to use GitHub.`, `Not found. You need it for pull requests and checks.`), `Diff base` (`Task start` / `Last commit`), `Isolation for new tasks` | the Changes panel, whose header shows "since task start" / "since last commit" |
| `Editor` | `Code theme` cards, `Font` (bundled mono, installed `JetBrains Mono` / `Fira Code`, `Other font…` opens a searchable popup of every installed mono font, each in its own face), `Size`, `Ligatures`, live code sample, `Language servers` and `Format on save` rows | editor; the window temporarily shows three columns, the chosen layout is unchanged |
| `Tasks` | `Board` / `List` (`projects.defaultView`); the window shows the project screen in that view | `All projects` |
| `Modules` | `ModuleList` without ⚙ | the hovered module's part of the window (none without hover); from here on the window shows only modules that are on |
| `Notifications` | `When` options with descriptions; when not `Never`: `Sound` row and `macOS permission` row (macOS only) with `Allow` | demo banner |
| `Keyboard shortcuts` | `KeymapEditor`: preset `Brigadir` / `VS Code` / `IntelliJ`, every menu shortcut in sections (General, Chat, Editor, Changes, Console, Browser, View …), search by action or keys; click a shortcut to record, Esc cancels; conflicts show in the row, with `Replace` for a command conflict and only `Cancel` for a reserved key | card centred |
| `Remote access` | see [Remote access step](#intro-remote) | `Remote` tile while access is on |
| `Brigadir` | title `Brigadir`, `Ask about tasks and code, change settings or set things up — in a chat.`; three rows with a glyph: `Tasks and code` (`What is up with my tasks? How is the main flow built?`), `Settings` (`Make the code font one size bigger. Three columns instead of two.`), `Setups` (`Set up a Slack bot for me. Turn on access from my laptop.`); the note `The helmet in the rail opens it. In Search Everywhere, the last row asks Brigadir.` Next turns nothing on | the window opens the Brigadir section: its tile selected in the rail, its list in the sidebar and the empty chat with the example tiles ([Brigadir chat](#brigadir-chat-entry)) |
| `First project` | "Drag a folder here, or" `Choose a folder…`; then the folder name and path, `Another folder…`, found repos appearing one by one (260 ms apart) with their kind (`Root`, `Submodule`, `Separate repo`, `Worktree`, `Folder`) | project list |
| `All set` | "Settings are always in ⌘,", `Go through again`, `Restart` (if needed), `New task ⌘N` (closes the intro and opens New task for the added project) | — |

Rules:

- **Agent check:** IPC `environment:check` (`main/environment.ts`, `core/environment.ts`) runs with the login shell's PATH. For each provider it reports `found`, `via` (`path` / `cache` / `npx`), `version` and `signIn` (`signed-in` / `signed-out` / `expired` / `unknown`). Sign-in is detected from `~/.codex/auth.json` and from whether a Claude Code Keychain entry exists, without reading the secret. It also reports git with its version and `gh` through `ForgeAuth`. `Sign in…` runs the agent's own login as a child process of the app (no Terminal), and the intro rereads the agents when the login ends or fails. Install commands come from `installCommands`.
- A provider that is not found cannot be turned on, and the last enabled one cannot be turned off.
- The intro's agent list is the list of providers Brigadir can run. Adding a provider means updating this step.
- The intro never asks for notification permission by itself. Only `Allow` requests it.
- A dropped folder is opened like a chosen one (IPC `project:add-path`, absolute folder path only). In a device's window a dropped local folder is refused with a message. A failed pick or drop shows `The settings could not be saved.` as a red line in the footer.
- The demo window uses the app's real components in display mode: sections rail, `ComposerIsland` with Send M 28, `PlanCard`, `CrewCard`, board. Its sidebar footer shows only the quota rings, and nothing until the first quota is known; agent, git and GitHub states live in the step cards. On Windows and Linux the sidebar strip has an inactive `app-menu` button, and the toolbar leaves room for the OS window buttons (`--os-controls-right`).
- Card hover: cards with a preview (theme, task layout) get a `--fg3` border without fill. Other cards and options (board view, `When`, code themes) use the shared button hover layer (`--segment-hover`). Rows with a switch hover and toggle as a whole.
- Intro controls are the system ones: `Segments`, the − N + stepper and the 28 × 16 switch. The Claude glyph uses the `--providerClaude` colour.

<a id="intro-crew"></a>
### Crew step

- Title `Crew`. The subtitle says a task can go to one agent or to a crew, and that the foreman splits it among agents and accepts their work.
- A diagram of the [starter tree](crew-templates-and-editor.md#builtin-templates): the foreman at the root, then `Developer 1`, `Developer 2` and `Reviewer`, with dashed review edges from the reviewer to both developers. Work runs along the edges: assignments go down, reports go dashed to the reviewer, and accepted work goes up. The node the work reaches lights up. The legend reads `gives work and accepts it` and `checks`. Reduced motion removes the running work.
- `Select a provider`: rows `Foreman`, `Developers` and `Reviewer` with Claude / Codex segments. These set the provider of the built-in templates `foreman-default`, `developer` and `reviewer` (`templates/builtin/<id>.json`), the same choice as in Settings ▸ Templates. Changing a provider clears the template's model and effort choices. A role without its own provider uses the default agent. A disabled provider is greyed. The note under the rows depends on whether one or two agents are on. If the templates cannot be read, the segments are disabled and the footer shows `Could not read the role templates.`
- The window shows the same crew: the foreman's card in the sidebar with its workers (shown before plan approval, unlike the app, so the crew's members are visible), with provider marks that follow the choice. The foreman's chat shows the plan brief waiting for the person (`Reject` / `Start workers`), and `Changes` is muted. The window temporarily uses two columns, and the chosen layout is unchanged.
- The spotlight has two stages: first the crew card, with only the person's message in the chat, then the chat after 2.6 s, where the foreman's work appears.

<a id="intro-remote"></a>
### Remote access step

This step exists only while the `remoteAccess` module is on and the window is not a device's window, so there is one dot fewer when it is off.

- `RemoteScheme`: `<machine name> · This machine`, a lock on a dashed line, then `Another computer · macOS, Linux`. Two dots run along the line only while access is on. When access is off the line is empty and the lock is grey, and an enabled lock turns green. Reduced motion stops the dots. The same component is used in the remote access popup.
- Subtitle: "Control this machine from Brigadir on another computer: tasks, terminal, browser and simulator run here."
- Row `Allow control from other devices` ("Needs a password and a one-time pairing of each device."), off by default. Turning it on without a saved password opens `Password` and `Repeat the password` fields, a counter "At least 10 characters · now N", the red line `The passwords do not match.` and `Turn on`. Turning the switch back folds the form, so there is no `Cancel`. With a saved password the switch turns access on at once.
- While access is off, `RemoteFacts` shows three facts: home network or Tailscale without port forwarding; the full Brigadir runs on macOS and Linux and each can control the other; the machine does not sleep while access is on, but a closed laptop lid still sleeps it.
- While access is on, a status line shows "Listening · LAN … · Tailscale …" and `Port {port}. No port forwarding on the router.`, followed by `Add devices in Settings ▸ Modules ▸ Remote access.` The window shows the `Remote` tile, and the spotlight is on it. Pairing is not part of the intro. `Next` turns nothing on.
- The intro saves the whole settings object, so it copies the live `remoteAccess.enabled` into its draft. Otherwise the next save would turn access off.

<a id="brigadir-chat"></a>
## Brigadir chat

A chat with Brigadir itself — the same agent that answers in Slack ([Slack agent](notifications-slack-notes-and-schedules.md#slack-agent)), here in the app and with the app's settings in its hands. The person asks in their own words: about tasks («what's with the ATT task in b2c?»), about code in any project («how does b2c decide when to show consent mode?»), for work («make a task from master in b2c…»), or of the app itself («set up Slack», «three columns instead of two», «code font one size bigger»). It answers, looks things up read-only, makes and hands over tasks, changes settings and walks through setups; it never edits files and never sees a secret.

<a id="brigadir-chat-entry"></a>
### Where it is

- **Rail section**: `Brigadir` is a section of the sections rail like Pull requests, Notes and Schedules ([sidebar](sidebar.md#rail-sections)): a tile under `Schedules` with the glyph `helmet-chat` (the helmet with a chat bubble), `⌃⌘5` · `Alt+5`, `View ▸ Brigadir` (`section-brigadir`). It is not a module and has no off switch.
- **Its list** (the sidebar, in the shared list look): group `Chats` — the chats, newest first: the title is the first line of the first message until the Helper agent names the chat in 2 to 6 words in the message's language (a Helper failure, an empty answer or the quota keeps the first line; `Rename…` changes it either way), the time of the last message is the second line; the chat that runs a setup the person began and left unfinished has the setup and its step there instead (`Slack · 3 of 5 · Bot token`). There is no list of setups: a setup that is done or not begun shows nowhere. Group `In the archive` — archived chats, folded at first. Each group folds by its name, as a project group does. The filter row is `Filter chats` with `New chat` (`+`). A chat's context menu has `Rename…`, `Archive` (the chat moves to `In the archive`; its files stay), on an archived chat `Restore` instead of `Archive` (back to `Chats`), and `Delete…` (`Delete the chat?`, «The chat and its history are deleted. Settings it changed stay.»). The rail tile has an accent dot while a setup the person began is left unfinished.
- **Its screen** (the main area): the open chat, with the header — the helmet, the chat's title, the second line `Brigadir` — `Open Settings` and `New chat`. The log is the [note chat](notifications-slack-notes-and-schedules.md#note-chat)'s (the person's bubble, the answer in Markdown, a row per tool call, `Done · 8s`), 680 px wide in the middle, and the cards are `ui/ChatCard`; the composer is the [chat composer](composer.md#chat-composer) without a capsule. A tool row of Brigadir's own tools says what it did (`Changed a setting`, `Asking for a token`); Claude's loader of deferred tools has no row. Leaving for Tasks brings back the task that was open, as Pull requests does.
- **No chat open** (a new chat, or the section's first opening): the helmet-chat glyph, the title `Brigadir` and six example tiles in a 3 × 2 grid over the composer; a click sends the tile's text as the first message. The examples cover the three kinds of work, with the person's own project names: `Set up a Slack bot for me`, `Make the code font one size bigger`, `Three columns instead of two`, `What is up with my tasks in {project}?`, `How is the main flow built in {project}?` (the open project, else the first; without projects these two are left out), `Turn on access from my laptop`.
- **Search Everywhere**: the `Brigadir` group, last in `All` and `Actions`, holds one row `Ask Brigadir: «<query>»` for any query that is not empty; `↩` on it closes the search, opens the section in a new chat and sends the query as its first message.
- **Elsewhere**: the Settings window's header has `Ask Brigadir` beside `Esc` (Settings closes, the section opens); the Slack popup's `Bot` section, while there is no bot, has `Set up with Brigadir` (Settings closes, a new chat starts with `Set up a Slack bot for me`); the Remote access popup, while access is off, has the row `Set up with Brigadir` under the switch (Settings closes, a new chat starts with `Turn on access from my laptop`).
- Not persisted in `sidebarSection`: like Notes and Schedules it is a screen of its own.

<a id="brigadir-chat-session"></a>
### The agent

- The agent of `Brigadir chat` in Customize per action (its own group `Brigadir`; unset → the Default agent). It is a `QuickAsks` session of mode `aboutCode`, as the Slack agent's is: it starts in the open project's main tree (else the first project's) with every project's folder added, reads files and runs only [commands that read](notifications-slack-notes-and-schedules.md#slack-side-commands); every edit and every other command is declined.
- Its prompt (English, [rule 12](../../AGENTS.md)) is the Slack agent's ([what the agent gets](notifications-slack-notes-and-schedules.md#slack-agent)): every project, today's date, Brigadir's tasks (the open task first, then the newest of every project) — plus the [settings registry](#settings-registry) as a list (key, label, tab, type, allowed values, current value) and the setup guides. The task list is refreshed with each message. It answers in the language the person writes in, in the app's Markdown, with code where it helps (unlike Slack).
- **Chats.** Each chat is its own agent session, kept as normalized events in `~/.brigadir/assistant/chats/<id>/events.jsonl` ([rule 2](../../AGENTS.md)) with `chat.json` (title, times, archived) and the messages' attachments in `attachments/` ([chat composer](composer.md#chat-composer)); it survives a restart and its session resumes on the next message. The session closes after 10 idle minutes. `New chat` starts an empty one; settings already changed and secrets already sealed live in Brigadir, not in a chat. A chat is not a task: no board column, branch or PR.
- **A setup outlives its chat.** Each setup's progress (which steps are done, the Slack app id, the chat that runs it) is kept in `~/.brigadir/assistant/setups.json`. A new chat's prompt lists the setups left unfinished, and the agent offers to go on: `Continue the Slack setup (3 of 5)?`.

<a id="settings-registry"></a>
### Settings registry

One typed list in `core/settings-registry.ts` describes every setting a person can change: key path, label (catalog key), tab and row (`data-settings-row`), type and allowed values, default, spec anchor, and how the chat may touch it — `set`, `confirm` (a change that opens the machine to the network, removes a module's UI or lets agents act without asking: `remoteAccess.enabled`, `modules.*` to off, `agents.slackPostWithoutAsking`) or `read`. Secrets are not in it. The Settings window and the chat validate through the same entry, so the chat can never write a value the window would refuse.

<a id="brigadir-chat-tools"></a>
### Tools

| Tool | What it does | What the agent gets back |
| --- | --- | --- |
| `settings_find {query}` | registry entries matching words in any language | key, label, tab, type, values, current value |
| `settings_set {key, value}` | validates and saves; `confirm` entries first show a card with `Apply` · `Cancel` | the new value, or the refusal and its reason |
| `settings_open {key}` | opens Settings at the row, lit as from Search Everywhere | `opened` |
| `setup_start {kind}` | starts a guided setup (`slack`, `remoteAccess`) and shows its steps card | the steps and which are done |
| `secret_request {kind}` | shows a secret card (`slackBotToken`, `slackAppToken`); the value goes from the field to main and the key store | the check's result: `connected as @<bot>`, missing scopes, or Slack's error — never the value |
| `open_link {url}` | opens a link the setup built (Slack's app pages) in the browser, after the person clicks it | `opened` |
| `create_task {projects, title, prompt, base}` | the [agent-created task](tasks.md#agent-created-tasks) card in the chat, `Start` · `Decline`; `base` as in [Slack](notifications-slack-notes-and-schedules.md#slack-agent) | the task's id, or `declined` |
| `send_to_task {task, text}` | the message goes to that task's agent, as a steer from the person | `sent` or the refusal (gone, archived, busy) |
| `ask_task {task, question}` | a [quick question](composer-steering-queue-and-ghost.md#quick-question) to that task's agent in its own side session | its answer |
| `open_task {task}` | opens the task in Tasks | `opened` |
| `note {text, title?, project?}` | saves a [note](notifications-slack-notes-and-schedules.md#notes) (the title becomes its first heading; a project by id or name, else no project) and shows a note card | the note's id |
| `watch {task, kinds}` | this chat hears of the task's events: `ci` (a check run ends), `merged` (its PR merges), `done` (a turn ends or the task completes); each kind once | `watching` |
| `unwatch {task?}` | stops watching the task, or every task without one | `stopped` or `nothing was watched` |

- The tools are served by main (`main/brigadir-chat-mcp.ts`): the agent spawns the same `mcp-relay` a task's agent does, with a token of its chat, on `~/.brigadir/run/brigadir-chat.sock` (`/tmp/brigadir.<uid>/` when that path is too long for a socket). The tool list and JSON-RPC are the host's (`serveToolSet`), so the schemas and errors read as a task's do. Brigadir's tools never show the agent's own permission card. A task is found by its id or exact title from the task list.

- A pasted secret never enters the conversation, the journal, a log or the agent's context; the card shows `Token in Keychain` once it is sealed.
- Watches are kept in `~/.brigadir/assistant/watches.json` (chat, task, the kinds left), so they survive a restart. The events are the ones the [Slack notices](notifications-slack-notes-and-schedules.md#slack-events) carry; an event reaches the chat as an event card whether Slack is on or not, and the kind is then dropped from the watch.
- `open_link` opens only links Brigadir built for a setup (the Slack manifest link, `https://api.slack.com/apps/<app id>/…`); any other URL is refused.

<a id="brigadir-chat-cards"></a>
### Cards in the chat

- **Setting changed**: one row — a green tick, the setting's place (`Editor ▸ Size`), `<old> → <new>`, `Undo` and `Open in Settings` (the row, lit). `Undo` puts the old value back while the setting still has the new one; after another change it fails with `The setting changed since. Undo is off.` Undone, the row shows the old value and `Undone`.
- **Confirm**: `<label> · <old> → <new>`, the [module consequence](#module-off) or the network fact as one line, `Apply` · `Cancel`. Nothing changes until `Apply`.
- **Setup steps**: the steps top to bottom, joined by a line — done green with a tick, the current one ringed in the accent, the rest numbered; the header says `1 of 5` or `Done`. It updates as steps finish and stays in the chat as the record.
- **Secret**: the field (`type=password`), `Connect`, and the result line of the check; `Replace…` once connected. It goes to the key store, never to the agent.
- **Link**: the button the setup built (`Create in Slack`, `Open App-Level Tokens`), opened only on a click.
- **Note saved**: `Note saved`, the note's title and `Open note` (opens it in Notes).
- **Event**: a dot in the event's tone (green `CI passed`, `PR merged`, `Task completed`; red `CI failed`; amber `CI cancelled`; accent `Turn ended`), the task's title, the GitHub link when there is one and `Open task`.

<a id="slack-setup"></a>
### Slack setup

`setup_start {kind: "slack"}`, from `Set up with Brigadir` or the person's words. Steps:

1. **Name** — the agent asks what the bot is called (default `Brigadir`). The bot's name is set in Slack, and agents know the bot by it ([bot name](notifications-slack-notes-and-schedules.md#slack-bot-name)).
2. **Create in Slack** — a link to `https://api.slack.com/apps?new_app=1&manifest_json=<manifest>` with that name, every bot scope Brigadir uses (`chat:write`, `users:read`, `channels:read`, `groups:read`, `app_mentions:read`, `channels:history`, `groups:history`, `im:history`), the bot events `app_mention`, `message.channels`, `message.groups`, `message.im`, Socket Mode, Interactivity and the app's Messages tab. The person picks the workspace and presses `Create`.
3. **Bot token** — `Install to Workspace`, then the secret card for `xoxb-…`. The check is `auth.test`; scopes missing from its `x-oauth-scopes` are named with a link to the app's `OAuth & Permissions` page and `Reinstall to Workspace`.
4. **App-level token** — a link to the app's `Basic Information ▸ App-Level Tokens` (`connections:write`), then the secret card for `xapp-…`, checked with `apps.connections.open`. `Create tasks from Slack` turns on.
5. **You** — the person's member ID (`Profile ▸ ⋯ ▸ Copy member ID`), saved as `slack.memberId`; the agent ends with a mention test: «Write @<bot> hi in any channel».

Every developer needs their own Slack app: Slack spreads one app's Socket Mode events across all its open connections, so with a shared app a mention would reach a random person's Brigadir. The agent says so when the person mentions a team.

<a id="later"></a>
## Later
- More Brigadir chat setups: notifications and sounds, a project's Slack channel, an agent provider's sign-in.

- A per-project override of a module's global switch in `project.json`.
- Agent templates that hide disabled providers.
- Renderer keyboard handlers that listen without a menu item should also read their keys from `keymap`.

<a id="non-goals"></a>
## Non-goals

- Separate MCP servers per module. One `brigadir` server with a filter gives the same context saving with one relay and one token.
- Switching off only a module's MCP tools while keeping its UI.
- Turning the simulator on automatically based on project contents (e.g. `react-native` in `package.json`). That would be knowledge about other tools.
- A confirmation before turning off `Commands` while commands are running.
- `gh` status in the `Pull requests` row. The PR panel already reports a missing `gh` or login.
- Pairing a device inside the intro. The code lasts 5 minutes, and a second device is rarely at hand on first run.
- Hover-only tooltips as a replacement for removed captions.
