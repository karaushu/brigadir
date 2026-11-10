# Settings, modules and onboarding

The Settings window holds every global preference in `~/.brigadir/settings.json`. It follows a few rules: rows carry no explanatory captions, a row with a switch is one hover and click target, and new tasks read their launch defaults from it. Modules are parts of the app that switch off whole: their UI, menu items, shortcuts, background work and MCP tools all go with them. A module's own settings open in a popup from its row. The first-run intro is the same settings shown for the first time, step by step over a window that assembles itself.

Related: theme, accent, fonts and the settings form look in [Appearance](appearance.md); the Helper agent and prompt suggestion in [Steering, prompt queue and ghost suggestions](composer-steering-queue-and-ghost.md); CLI updates, model and effort in [Agents and providers](agents-and-providers.md); the remote access popup in [Remote access and mobile](remote-access-and-mobile.md); the Notes, Schedules and Slack modules in [Notifications, Slack, notes and schedules](notifications-slack-notes-and-schedules.md); shortcuts and the menu-bar rule in [Search, shortcuts, menus and project commands](search-menus-and-commands.md).

<a id="settings-window"></a>
## Settings window

`LayoutSettings` (renderer) is a modal `<dialog>` opened with `⌘,` (`Settings…`). Its header has the title and `Esc` (`ui/PopupClose`), then a tab row.

| Tab | Key | Height (all `min(…, 100vh − 48px)`) | Contents |
| --- | --- | --- | --- |
| Appearance | `appearance` | 900 | `Appearance` (Theme, Accent), `Toolbar labels`, `Task layout`, `Tasks` ▸ `View`, typography, `Keyboard` ▸ `Keymap` |
| Editor | `editor` | 440 | see [Editor](editor.md), [Code intelligence](editor-code-intelligence.md) |
| Language | `language` | 470 | `Interface language` (`Follow system`, `Українська`, `English`), restart line; `Updates` card with the `Brigadir` row ([auto-update](architecture-and-platform.md#auto-update)) |
| Notifications | `notifications` | 560 | `When`, `macOS permission`, `Sound` with per-slot sounds, quiet-while-viewing |
| Agents | `agents` | 500 | `Providers`, `Agents`, `Tasks` cards ([below](#agents-tab)) |
| Templates | `templates` | 640, window 780 wide | see [Crew templates](crew-templates-and-editor.md) |
| Modules | `modules` | 410 | the module list ([below](#modules)) |

- The window is 620 px wide, with seven tabs on an 80 px step (76 px each) and a sliding indicator. The tab padding is 4 / 6. Tabs move with Left/Right/Home/End.
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
- The same pressed style applies to the icon buttons in the PR panel header (`Find PR`, `Refresh`, `Open on GitHub`): hover `--tint` + `--fg`, pressed `--segment-press` + `scale .96`, with no scale under reduced motion. While reading, the `Refresh` glyph spins at 0.8 s per turn and finishes its turn after the reply. Under reduced motion it does not spin and shows at 55 %.

<a id="agents-tab"></a>
### Agents tab and launch defaults

| Card | Rows |
| --- | --- |
| `Providers` | `Claude Code`, `Codex`: switch + `AgentStatus` (found / sign-in state, `Sign in…`, `Check`, `How to install`); `CliUpdatesRow` |
| `Agents` | `Default agent` (Claude / Codex segments), `Helper agent` capsule, `Subagent model` (Claude catalog models, first item `Same as the agent`; shown while Claude is on; caption "Claude's own subagents search and read on this model."), `Customize per action` rows, `Launch in` (`GUI` / `Terminal`), `Isolation for new tasks` (`No isolation` / `Worktree`), `Max concurrent` (0 = `Unlimited`, up to 99), keep-awake row, `Prompt suggestion` |
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
| `agents.transport` | `gui` \| `terminal`, `gui` | Agents ▸ `Launch in` |
| `agents.isolation` | `in-place` \| `worktree`, `in-place` | Agents ▸ `Isolation for new tasks` |
| `editor.codeTheme` | `brigadir` \| `vscode` \| `intellij`, `brigadir` | Editor ▸ `Code theme` |
| `projects.defaultView` | `board` \| `list`, `board` | Appearance ▸ `Tasks` ▸ `View` |
| `keymap` | `{preset, overrides}`, `brigadir`, `{}` | Appearance ▸ `Keyboard` ▸ `Keymap` |
| `modules` | see [Modules](#modules) | Modules |

- `agents.isolation` is the starting value for each new task. The New task sheet's choice applies to that task only. Foreman tasks always run in a worktree.
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
| `simulator` | `Simulator` | iOS and Android · found tools, or `Xcode not found` / `Android SDK not found` in amber | off | no |
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
- In Settings, a module that is **on and has settings** shows a ⚙ button before the switch: `IconButton` M 28 × 28, ghost, glyph `search-setting`, `--fg2`, hover `--tint` + `--fg`. Its name and tooltip (system `title`) are `Browser settings`, `Pull request settings`, `Remote access settings` and `Slack settings`. The button sits on top of the row, has its own hover and never toggles the row. A module that is off has no ⚙, and its open popup closes. The intro passes no settings handlers, so it has no ⚙.
- The intro passes `onHover` so the spotlight can follow the hovered row.

<a id="module-settings-popup"></a>
### Module settings popup

`ModuleSettingsDialog` on `ui/ModalDialog` is one popup for every module with settings. Its header shows the module's name and `Esc` (`ui/PopupClose`). It is 600 px wide, 56 px from the top, as tall as its content, with a scrolling body that uses the settings form with 16 px between sections. It opens above Settings. Esc or `Esc` returns to `Modules` with focus on the ⚙, and a second Esc closes Settings. Dialogs opened from inside it (password, log, pairing, `Forget`) open above the popup.

| Module | Popup contents |
| --- | --- |
| `Browser` | `Agents can act on any site without confirmation` (`agents.browserActAnywhere`, off) — "No permission card for actions. Local pages never ask." |
| `Pull requests` | `PR summary`: `Summarize a PR when its review opens` (`agents.prSummary`, on) |
| `Remote access` | the whole remote access settings: `This machine · Connect to another` part switch (`Segments` in `tabs` style), overview scheme and facts, switch and password, name, phone, devices, log, `Change password…`, machines, `Forget`. See [Remote access](remote-access-and-mobile.md). |
| `Slack` | see [Slack](notifications-slack-notes-and-schedules.md) |

- Settings that stay where they are: a command's `agentRuns` (command editor), where Review with an agent runs (chosen in the button) and `Customize per action` (that is a choice of agent, not a module setting).
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

The order is Welcome, Appearance, Agents, Crew, Git and GitHub, Editor, Tasks, Modules, Notifications, Keyboard shortcuts, Remote access, First project, All set.

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
- A diagram of the built-in crew `default`: the foreman at the root, then `Developer 1`, `Developer 2` and `Reviewer`, with dashed review edges from the reviewer to both developers. Work runs along the edges: assignments go down, reports go dashed to the reviewer, and accepted work goes up. The node the work reaches lights up. The legend reads `gives work and accepts it` and `checks`. Reduced motion removes the running work.
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

<a id="later"></a>
## Later

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
