# Building a module

This guide is for engineers and coding agents adding a new **module** to Brigadir. It describes how modules are
put together in the code and gives the files, in order, that a new module touches. The `notes` and `schedules`
modules are the main references; `slack` is the reference for a module with its own settings popup and a secret.

Read first: [Settings, modules and onboarding](../spec/settings-modules-and-onboarding.md#modules) (the module
contract), [Architecture and platform](../spec/architecture-and-platform.md) (processes, IPC, data), and the project
rules in [`AGENTS.md`](../../AGENTS.md) and [`electron/AGENTS.md`](../../electron/AGENTS.md). Visible text follows
[the glossary](../glossary.md) and [the UI copy guide](../ui-copy.md); colors follow [the design tokens](../design-tokens.md).

All code paths below are relative to `electron/`.

---

## 1. What a module is

A module is a built-in part of the app that **switches off whole**. When it is off, all of these go:

- its column, panel, rail section, project tab or toolbar button;
- its items in `View`, in its own menu, and in context menus, **and so their shortcuts** (no menu item, no key);
- its background work: timers, processes, network requests, watchers;
- its MCP tools, so they stop using context in every agent session;
- its IPC: calls answer with the module's "off" sentence.

Its data stays on disk. When the module is switched on again, it comes back where it was. Saved per-task flags stay
too; they just have no effect while the module is off.

The current modules (`packages/core/src/modules.ts`):

| Key | Default | Own settings popup | Spec |
| --- | --- | --- | --- |
| `browser` | on | yes | [Browser and simulator](../spec/browser-and-simulator.md#browser) |
| `simulator` | off | no | [Browser and simulator](../spec/browser-and-simulator.md) |
| `pullRequests` | on | yes | [Pull requests and CI](../spec/pull-requests-and-ci.md) |
| `commands` | on | no | [Project commands](../spec/search-menus-and-commands.md#project-commands) |
| `remoteAccess` | on (access itself off) | yes | [Remote access](../spec/remote-access-and-mobile.md#module-and-settings) |
| `notes` | on | no | [Notes](../spec/notifications-slack-notes-and-schedules.md#notes) |
| `schedules` | on | no | [Schedules](../spec/notifications-slack-notes-and-schedules.md#schedules) |
| `slack` | off | yes | [Slack](../spec/notifications-slack-notes-and-schedules.md#slack) |

### Should it be a module?

Make it a module when **all** of these hold:

- A person can use Brigadir fully without it, and some people will not want it.
- It has its own surface (a section, column, panel or button), **or** background work, **or** MCP tools that cost
  agent context.
- It can be switched off with nothing else breaking. Other features may check whether it is on, but they never need
  it.

Do **not** make it a module when:

- It is part of the core flow. The console, editor and crew are not modules.
- It is one option of an existing part. Put it in that part's settings, or in an existing module's settings popup.
- It would switch off only the MCP tools and keep the UI, or the reverse. The agent must see what the person sees, so
  one switch covers both.
- It is a per-project choice. Module switches are global. Per-project overrides are listed under "Later" in the spec.
- It needs its own MCP server. There is one `brigadir` server, and it filters tools by module.
- It would be switched on automatically based on what a project contains. That would mean building our own
  knowledge about other tools.

Default **on** is for modules most people use. Default **off** is for modules that only some projects need, or that
need setup (the simulator's tools cost context in every session; Slack needs a bot token).

---

## 2. Architecture recap for modules

### Processes and layers

| Process | Code | What a module puts here |
| --- | --- | --- |
| Main | `apps/desktop/src/main` | services with their lifecycle, IPC handlers, menu items, notices |
| Preload | `apps/desktop/src/preload` | nothing by hand: the bridge is built from the channel table |
| Renderer | `apps/desktop/src/renderer` | screens, rail section, settings rows; shared controls in `renderer/ui/` |
| Host (one per task) | `packages/host` | MCP tools and their checks; runs as a separate Node process |
| Phone client | `apps/desktop/src/renderer-mobile` | usually nothing: a phone is denied module channels |

Packages sit below `apps/desktop`, and dependencies only point down:

- `packages/core`: domain types, validators, the message catalog, menus, keymap, the IPC channel table. No Node APIs
  and no DOM.
- `packages/persistence`: stores on disk (`safePath`, `atomicJson`, `readDocument`).
- `packages/host`, `packages/orchestrator`: the MCP server, and the tool descriptions for each role.

A feature never depends on another feature. Module code lives in its own files (`main/schedules.ts`,
`renderer/SchedulesScreen.tsx`, `core/schedules.ts`, `persistence/schedules.ts`). When two features need the same
thing, move it down into `core`, `persistence` or `renderer/ui/`. Other features may read the module's switch, as
`NewTask.tsx` reads `modules.schedules` to show `When`, but they do not import the module's code.

UI depends on the domain model (`SessionEvent` / `SessionCommand`), **never on ACP types**. If a module runs its own
agent session (the note chat does), it journals normalized events, not raw ACP. See
[Layer rules](../spec/architecture-and-platform.md#layer-rules).

### The IPC boundary

- `packages/core/src/ipc-channels.ts` has one row per `DesktopBridge` member: channel, kind (`invoke` / `subscribe`),
  class (`remote` runs on the working machine, `client` on the machine that shows the window), and a runtime
  validator for every argument. There is no generic channel.
- `packages/core/src/bridge.ts` declares the typed member, and the preload builds it from the row.
- `packages/core/src/web-channels.ts` decides, for each row, what a phone may call. The type will not build until the
  row has an entry.
- Main registers each handler with `handle(channel, …)`, and it gates the channels of a module that is off (see
  step 5).

See [Main / preload / renderer boundary](../spec/architecture-and-platform.md#ipc-boundary).

### Where state lives

- Everything lives under `~/.brigadir/` (`BRIGADIR_DATA_DIR` in tests). The switch is in `settings.json` →
  `modules.<key>`. A module's own settings go in a top-level block of `settings.json` (`slack`), and its data goes in
  its own folder (`notes/`, `slack/`, `projects/<id>/schedules/<id>/`).
- State is JSON written with `atomicJson`: keys sorted recursively, 2-space indent, trailing newline, a
  `schemaVersion` in every document. Append streams are JSONL (`runs.jsonl`, `<id>.chat.jsonl`). No TOML, no YAML.
  See [Formats and write rules](../spec/architecture-and-platform.md#formats).
- No tokens or credentials go in the data root as plain text. Slack seals its token with the OS key store
  (`vault().open` / seal; `slack/token.json` holds only the sealed bytes).

### Three readers of one switch

| Reader | How it reads `modules` |
| --- | --- |
| Main | `appliedSettings.modules[key]`, updated by `settings:save` |
| Renderer | `useWorkspace((s) => s.appearance.modules[key])`, published by main (`machineAppearance`); a device's window shows the **working machine's** modules |
| Host | `ModuleSettings` (`packages/host/src/modules.ts`) watches the data directory for `settings.json` (saves are atomic renames) and tells MCP sessions |

---

## 3. Adding a module, step by step

Do the steps in this order. Each step names the files and shows the pattern from real code. Use `notes` as the
model for a section with data and an agent chat, `schedules` for a background service, and `slack` for settings and
a secret.

The compiler finds many of the places for you. `AppModules`, `moduleOffMessages`, `moduleRows` in `ModuleList.tsx`,
`moduleTarget` in `Intro.tsx` and `webChannels` are all exhaustive `Record`s, so `pnpm typecheck` lists them. The
other places are hand lists. They are marked **(hand list)** below.

### Step 0. Spec first

If the code is going to differ from the spec, change the spec first.

1. Add a row to the module table in
   [settings-modules-and-onboarding.md#modules](../spec/settings-modules-and-onboarding.md#modules): key, row name,
   second line, default, whether it has settings.
2. Add its line to [What a module that is off removes](../spec/settings-modules-and-onboarding.md#module-off).
3. Write the module's own section in the spec file for its area. Give it an `<a id="…">` anchor. Start with one
   sentence on the switch, the way the notes section does:

   > Module `notes`, on by default, no own settings. Off: removes the rail section, menu items and the note chat; files
   > in `~/.brigadir/notes/` stay and return when it is switched on.

4. Cover the data layout, IPC channels, menu items with their shortcuts (macOS and Windows/Linux), MCP tools, and
   what stops when the module is off.
5. Put what is not built now under "Later" or "Non-goals", with the reason. Nothing is deleted from the spec.

Code comments cite the spec as `spec/<file>#<anchor>`.

### Step 1. Registry: `packages/core/src/modules.ts`

Add the key, the default, the "off" sentence, and, when names do not follow the prefix rule, the tool and command
tables:

```ts
export const appModules = [/* … */ 'notes', 'schedules', 'slack'] as const;
export const defaultModules: AppModules = { /* … */ notes: true, schedules: true, slack: false };

/** MCP tools of a module that are not named by its prefix. */
const moduleTools: Record<string, AppModule> = {
	pr_comment: 'pullRequests',
	note_read: 'notes',
	note_edit: 'notes',
};
export const moduleOffMessages: Record<AppModule, string> = {
	/* … */
	notes: 'Notes are off in Settings.',
	schedules: 'Scheduled tasks are off in Settings.',
};
/** Menu commands of a module that are not named by it. */
const moduleCommands: Record<string, AppModule> = {
	'note-new': 'notes',
	'schedule-new': 'schedules',
};
```

How names are matched:

- `toolModule(name)` looks in `moduleTools`, then checks `name.startsWith(`${key}_`)`. Tools named `<key>_*` need no
  table entry.
- `commandModule(id)` looks in `moduleCommands`, then checks `id === key || id.startsWith(`${key}-`)`. Menu ids like
  `notes`, `browser-reload` need no entry.
- A **camelCase key never matches** a snake_case tool or a kebab-case command (`pullRequests` vs `pr_state`,
  `pull-requests`). With such a key, list every tool and command explicitly. A one-word key is simpler.

Update the doc comment above `appModules` with one line for the new module.

### Step 2. Settings

The switch needs no migration. `withModuleDefaults` gives a missing key its default, and main
(`apps/desktop/src/main/settings.ts`) and the host (`packages/host/src/modules.ts`) both use it:

```ts
/** `settings.json` written before a module existed lacks its key — that module takes its default. */
export function withModuleDefaults(value: unknown): unknown {
	return isRecord(value) ? { ...defaultModules, ...value } : value;
}
```

If the module has **its own settings**, follow `slack`:

1. In `packages/core/src/<module>.ts`, define the type, `default<Module>Settings`, `is<Module>Settings` and
   `with<Module>Defaults` (the last one fills keys added later).
2. In `packages/core/src/settings.ts`, add the field to `AppSettings`, to `defaultAppSettings`, and to
   `isAppSettings`.
3. In `apps/desktop/src/main/settings.ts` → `read()`, add the block when it is missing and fill a partial one:

```ts
...(!('slack' in value) ? { slack: structuredClone(defaultSlackSettings) } : {}),
...value,
...('slack' in value ? { slack: withSlackDefaults(value.slack) } : {}),
```

4. Secrets never go in `settings.json`. Seal them through the key store and keep the sealed bytes in the module's
   folder. Main takes a token over IPC and never sends it back (`connectSlack` is `remote: 'forbidden'`).

### Step 3. Domain types and the store

- In `packages/core/src/<module>.ts`, define types, id checks and validators (`isNoteId`, `isScheduleDraft`), plus
  any pure logic (`nextRun`, `dueDecision`). Export it from `packages/core/src/index.ts`. Add vitest tests next to the
  file.
- In `packages/persistence/src/<module>.ts`, write a store class built with `static at(dataDir)`. Every path goes
  through `safePath`; writes are serialized; documents carry `schemaVersion`; streams are appended. Export it from
  `packages/persistence/src/index.ts`. Excerpt from `SchedulesStore`:

```ts
private async dir(projectId: string, id: string, make = false) {
	if (!isId(projectId) || !isScheduleId(id)) throw new ReadFailure('unsafe_path');
	const dir = await safePath(this.root, 'projects', projectId, 'schedules', id);
	if (make) await mkdir(dir, { recursive: true, mode: 0o700 });
	return dir;
}
```

A broken file is skipped and reported, never fatal (`list()` skips unreadable schedules).

### Step 4. Main: lifecycle

Put the service in its own file, `apps/desktop/src/main/<module>.ts`, with injected dependencies. One of them is
`enabled()`, and the service checks it on **every** pass, not only at start:

```ts
// main/schedules.ts
export type SchedulerDeps = { /* store, tasks(), start(), notify(), changed() … */ enabled(): boolean };

private async check() {
	if (!this.deps.enabled()) return;
	// …
}
```

Wire it in `apps/desktop/src/main/index.ts`:

```ts
const scheduler = new Scheduler({ /* … */ enabled: () => appliedSettings.modules.schedules });
scheduler.start();
app.on('will-quit', () => scheduler.stop());
```

React to the switch in the `settings:save` handler. A module that is switched off must **stop** its work there: close
views, stop processes, drop timers, forget tokens held in memory. A module that is switched on must start again:

```ts
handle('settings:save', async (value) => {
	const modulesChanged = !sameModules(value.modules, appliedSettings.modules),
		slackChanged = value.modules.slack !== appliedSettings.modules.slack;
	const saved = await settings.save(value);
	appliedSettings = saved;
	if (slackChanged) void slack.refresh();          // off → forgets the token and its queue
	if (modulesChanged) scheduleSettings?.();        // on → scheduler.kick()
	if (modulesChanged) rebuildMenu?.();             // items and shortcuts appear or go
	if (!saved.modules.browser) browsers.close();
	if (saved.modules.simulator) simulators.reopen();
	else simulators.close();
	// …
});
```

Anything else in main that does work for the module checks the switch as well. Notices and Slack posts check
`appliedSettings.modules.slack`. Main-built context menus take a function (`sidebarMenus.schedules = () =>
appliedSettings.modules.schedules` hides `Repeat…`).

### Step 5. IPC and the preload bridge

1. **Channel rows**, `packages/core/src/ipc-channels.ts`. Give the module its own channel prefix (`notes:`,
   `schedules:`) and validate every argument:

```ts
readScheduleRuns: {
	kind: 'invoke',
	channel: 'schedules:runs',
	class: 'remote',
	arity: 2,
	validate: (a) => a.length === 2 && isId(a[0]) && isScheduleId(a[1]),
},
onSchedulesChanged: { kind: 'subscribe', channel: 'schedules:changed', class: 'remote' },
```

   Use `remote: 'forbidden'` for anything a remote client must never do (entering or removing a secret).

2. **Bridge type**, `packages/core/src/bridge.ts`. Add the member with a one-line doc comment that cites the spec.
3. **Phone access**, `packages/core/src/web-channels.ts`. Module channels are normally `'deny'`. The phone is for
   answering agents and reading state, not for modules.
4. **Handlers**, `apps/desktop/src/main/index.ts`:

```ts
handle('schedules:list', () => scheduler.list());
handle('schedules:run-now', (projectId: string, id: string) => scheduler.runNow(projectId, id));
```

5. **Gate (hand list).** Add the prefix to `channelModule` in `main/index.ts`, so every handler of the module throws
   `moduleOffMessages[key]` while the module is off:

```ts
const channelModule = (channel: string): AppModule | null =>
	channel.startsWith('prs:') ? 'pullRequests'
	: /* … */ channel.startsWith('notes:') ? 'notes'
	: channel.startsWith('schedules:') ? 'schedules'
	: null;
```

   Leave a channel out only on purpose. `slack:read` answers while Slack is off so that Settings can show the `off`
   state.

6. Broadcast changes with `clients.broadcast('<module>:changed', …)`, so every window and a device's window follow
   along.

### Step 6. UI entry points

Every entry point reads the switch and renders nothing while the module is off.

- **Module row** in `apps/desktop/src/renderer/ModuleList.tsx` → `moduleRows` (glyph, name, second line). This one
  component serves both `Settings ▸ Modules` and the intro, so the row shows up in both:

```ts
notes: { glyph: 'note', name: 'Notes', detail: 'Markdown notes with their own agent chat.' },
schedules: { glyph: 'schedule', name: 'Scheduled tasks', detail: 'Run a task later or on repeat.' },
```

- **Glyph** in `renderer/ui/Glyph.tsx`. Reuse a source icon. A new one is recorded in [`docs/third-party-assets.md`](../third-party-assets.md).
- **Section, column or button.** For a rail section, add it to `SectionsRail.tsx` (`SectionId`, the `modules` prop,
  a `tile(…)`), the route to `renderer/store.ts` (`openNotes` / `closeNotes`, which close the other routes), and the
  screen to `App.tsx`, guarded by the switch:

```tsx
const notesOpen = !!notesRoute && appearance.modules.notes;
// …
{modules.notes && tile('notes', t(locale, 'Notes'), 'notes', 'note')}
```

  For a toolbar button or a work-area tab, follow the browser and commands: the same switch hides the button and the
  `Tools ▾` item.
- **Other features' entry points** read the switch, never the module's code. `NewTask.tsx` shows `When` only with
  `modules.schedules`, and `RelayLinks.tsx` shows a task's "From the note" link only with `modules.notes`.
- **Settings popup** (only if the module has settings, as `slack` does), in `renderer/ModuleSettings.tsx`. Add the key
  to `modulesWithSettings` **(hand list)**, a branch in `ModuleSettingsDialog` that renders the module's settings
  component (`SlackSettings.tsx`) on the shared settings form, and the ⚙ label in `ModuleList.tsx` → `settingsLabels`
  (`'Slack settings'`). The popup is `ui/ModalDialog` with `ui/PopupClose`; do not build another shell.
- **Search Everywhere ▸ Settings** **(hand list)**, `packages/core/src/search.ts` → `moduleNames`, makes the module's
  switch searchable. The module's own settings rows go in `settingDefinitions`.

### Step 7. Menus and shortcuts

Every shortcut has a menu item. A module's commands live in `packages/core/src/menu.ts`:

```ts
workspace('File', 'New note', 'note-new', undefined, 'always'),
workspace('File', 'New schedule…', 'schedule-new', undefined, 'project'),
workspace('View', 'Notes', 'notes', 'Ctrl+Command+3', 'always'),
workspace('View', 'Schedules', 'schedules', 'Ctrl+Command+4', 'always'),
```

Then:

1. Add each action id to the `WorkspaceAction` union in `packages/core/src/files.ts`.
2. Make sure `commandModule(id)` returns your module (from the id prefix or `moduleCommands`). Main's `buildMenu`,
   `keymapCommands` (the keymap dialog and conflict checks), Search Everywhere's Actions and `menu:run` all filter by
   it, so a module that is off leaves its items out and frees its keys.
3. Glyphs: add an entry to `menuCommandIcons` in `menu.ts`. The glyph name must be in `menuIconNames`
   (`packages/core/src/menu-icons.ts`) and in `ui/Glyph`. Menus that belong to the module itself get their own table
   (`noteMenuIcons`, `scheduleMenuIcons`), and `menu-icons.test.ts` checks it.
4. Windows/Linux: when the straight Ctrl/Alt reading of a key clashes with the system or with AltGr, add it to
   `pcKeys` in `packages/core/src/keymap.ts` (`notes: 'Alt+3'`, `schedules: 'Alt+4'`). The keymap tests check that
   every preset is free of conflicts and that every command has a keymap section.
5. In the renderer, handle the action in `App.tsx`'s `onWorkspaceAction` and check the switch again, because an
   action can arrive from a window whose menu has not been rebuilt yet:

```ts
if (action === 'schedules' && useWorkspace.getState().appearance.modules.schedules) {
	if (useWorkspace.getState().schedules) setSidebarHidden((value) => !value);
	else openSchedules();
}
```

The only keys allowed without a menu item are keys inside a modal that the modal itself labels.

### Step 8. MCP tools

Skip this step if the module gives agents nothing. If it does:

1. **Define** the tools in `packages/host/src/mcp.ts` (`humanTools`), named `<key>_<verb>`, with a zod `shape`. Write
   the description in English, for the agent: what it returns, when to call it, its limits. `run` forwards to the
   host:

```ts
{
	name: 'commands_list',
	description: 'The saved commands of this project … Call it before you start a server or a script yourself. Read-only.',
	shape: {},
	run: async (args, call, signal) => text(await call('commands_list', args, signal)),
},
```

2. **Filtering needs no code.** `mcpTools(role, modules)` drops every tool for which `toolModule(name)` is a module
   that is off, and it caches the list per role and per set of modules. When `ModuleSettings` sees `settings.json`
   change, `serveMcp` sends `notifications/tools/list_changed`.
3. **Check again where the call runs.** In `packages/host/src/server.ts`, the handler checks
   `modules.current()[key]`. If the work happens in the app, main's host-request handler in `main/index.ts` checks
   `appliedSettings.modules[key]` too:

```ts
if (!modules.current().browser) throw new Error(moduleOffMessages.browser);   // host
if (method === 'simulator') {
	if (!appliedSettings.modules.simulator) throw new Error(moduleOffMessages.simulator); // main
}
```

4. **Tell the agent the tools exist**, in `packages/orchestrator/src/tools-brief.ts` (`toolsInstructions` for MCP
   `initialize`, `toolsBrief` for the first-prompt brief). Add one line, only while the module is on. Never name a
   module that is off.
5. **Crew roles.** Only the person's own session and the root foreman get human tools (`humanToolsAllowed`). A tool
   that every crew role should have goes into `workspaceModules` in `packages/orchestrator/src/tools.ts`.
6. **Golden fixture.** `tools/list` must match `packages/host/fixtures/mcp-sdk-1.30.json` byte for byte. Update the
   fixture in the same change and review its diff.

If the module adds an **option to a shared tool** instead of tools of its own (schedules adds `start: 'schedule'` to
`create_task`), the prefix filter cannot drop it. Gate the option where the call is handled, and describe it in the
spec.

### Step 9. Strings, `packages/core/src/messages.ts`

- Every visible string is a key in the `uk` map. The key is the English text and the value is the Ukrainian. Use
  `t(locale, 'Key')` in both renderer and main. `MessageKey` is `keyof typeof uk`, so a string missing from the
  catalog fails the type check.
- When one English word needs two Ukrainian words, give the key a suffix and add the English to the `english`
  overrides: `'Repeat (schedule)': 'Repeat'`, `'Pull requests (module)': 'Pull requests'`.
- Counts use a function with **four Ukrainian forms** (`one`, `few`, `many`, `other`) through `Intl.PluralRules`.
  Never use two forms. Add a vitest case for 1, 2, 5, 11, 21, 22:

```ts
export function missedRunsText(locale: Locale, count: number): string {
	const n = new Intl.NumberFormat(locale).format(count),
		form = new Intl.PluralRules(locale).select(count);
	if (locale !== 'uk') return `${n} ${count === 1 ? 'run' : 'runs'} missed`;
	const forms: Record<string, string> = { one: 'запуск', few: 'запуски', many: 'запусків', other: 'запуску' };
	return `Пропущено ${n} ${forms[form] ?? forms.other}`;
}
```

- Errors that main throws in English are shown translated when they are catalog keys (`isMessageKey`). If the
  module's "off" sentence can reach a person through an IPC error, add it to `uk` too (as `'Scheduled tasks are off in
  Settings.'` is).
- Prompts, tool descriptions, `moduleOffMessages` and wrapper prompts for agents are in **English**, whatever the UI
  language.
- Terms come from [the glossary](../glossary.md); names are short, and second lines plainly say what the module does ([UI copy](../ui-copy.md)).
  Text says nothing platform-specific.

### Step 10. Intro (onboarding `Modules` step)

- The row shows up by itself, because the intro uses `ModuleList`. The intro passes no settings handlers, so there
  is no ⚙.
- `apps/desktop/src/renderer/Intro.tsx` → `moduleTarget` (an exhaustive `Record`): the part of the sample window that
  the spotlight lights when the row is hovered. A module with no part of the window gives `{ current: null }`, as
  `slack` does.
- If the module adds a rail section or a toolbar button, add it to the intro's sample window too, behind
  `showModules && draft.modules.<key>` (and in the `SectionsRail` `modules` prop the intro passes).
- If the module has its own intro step, the step exists only while the module is on (see the `remote` step's filter
  in `flow`).

### Step 11. Tests

On a branch, run only the vitest suites for code you touched, then `pnpm typecheck`:

```sh
npx vitest run packages/core/src/modules.test.ts packages/core/src/<module>.test.ts \
  packages/persistence/src/<module>.test.ts apps/desktop/src/main/<module>.test.ts \
  packages/host/src/modules.test.ts packages/host/src/mcp.test.ts apps/desktop/src/main/settings.test.ts \
  --reporter=dot --silent
pnpm typecheck
```

What to add or update:

| File | What |
| --- | --- |
| `packages/core/src/modules.test.ts` | defaults; `toolModule` / `commandModule` for the new names |
| `packages/core/src/<module>.test.ts` | validators, pure logic, plural forms |
| `packages/persistence/src/<module>.test.ts` | store round trip, broken file skipped, unsafe ids refused |
| `apps/desktop/src/main/<module>.test.ts` | the service with fake deps, including `enabled()` turning false |
| `apps/desktop/src/main/settings.test.ts` | a file without the key reads the default; own settings block filled |
| `packages/host/src/modules.test.ts`, `mcp.test.ts` | every full `AppModules` literal gains the key; tools leave the list when off |
| `packages/core/src/menu-icons.test.ts`, `keymap.test.ts` | new menu tables and shortcuts |

e2e tests check **behavior** only (process, IPC, a native menu, git on disk), never CSS, pixels or exact copy. Existing
specs: `tests/modules.spec.ts` (a module switches off whole and comes back) and `tests/intro.spec.ts` (the Modules step
lists every row). Update the saved `modules` objects and the row count there; add a step to `modules.spec.ts` only
for behavior vitest can't reach (a process that must stop, for example). Running the e2e suites is the
coordinator's job, not a branch's. Check visual fidelity with screenshots in both themes.

---

## 4. Rules that apply

- **Domain model, not ACP.** No ACP type or raw `session/update` payload reaches the preload or a view. Persist
  normalized events.
- **Semantic color tokens only.** `var(--token)` from the design tokens, with no hex in components. The theme comes
  from `nativeTheme`; components never switch the theme.
- **All visible text through the catalog**, `t(locale, key)`, in main and renderer alike.
- **Four Ukrainian plural forms**, always.
- **Prompts and tool text for agents in English.**
- **One look, one component.** Before writing a control, search `renderer/ui/` and use what is there: `ListCard`,
  `ListRow`, `Rail`, `RailSection`, `Popover`, `ModalDialog`, `PopupClose`, `ConfirmDialog`, `NoticeChip`,
  `Loading`, and in `ui/Controls`, `IconButton`, `Switch`, `Choice`, `SplitButton`. If something is close, extend it with a prop. A feature's
  CSS only places controls; it does not restyle them. A second copy of a look moves into `ui/`.
- **One row, one height.** A row declares `data-size`, and the controls in it take that size and set none of their
  own.
- **Hover covers the whole target.** A row that selects as a whole also hovers as a whole. Nested buttons (the ⚙ in a
  module row) sit on top with their own hover and never toggle the row. There is no empty padding under a section's
  last row.
- **Esc closes every modal**, through `ui/PopupClose` in the header: popups, sheets and confirm dialogs. Keep hover,
  keyboard focus, Escape and focus return.
- **Every shortcut has a menu item.** The only exception is keys inside a modal that the modal labels.
- **Motion** uses the shared renderer motion tokens and respects `prefers-reduced-motion` (`docs/motion.md`).
- **On-disk state** is JSON through `atomicJson` (sorted keys, pretty-printed), plus JSONL for streams. No TOML or
  YAML.
- **No App Sandbox.** Agents and helpers must keep access to the key store and to folders.
- **Tests by level.** On a branch, vitest for the touched code plus typecheck. New e2e only for behavior; no pixel or
  copy assertions.
- **Spec first.** If the code differs from the spec, fix the spec first. Spec sections move to "Later" or "Non-goals";
  they are never deleted.
- **Versions** are bumped only by whoever builds packages. Agents on a branch never bump them.

---

## 5. Definition of done

- [ ] Spec: a row in the module table, a line in "What a module that is off removes", the module's own section with
      data, IPC, menus and shortcuts (both platforms), MCP tools and off behavior; "Later" and "Non-goals" filled in.
- [ ] `core/modules.ts`: key, default, `moduleOffMessages`, and `moduleTools` / `moduleCommands` for every name that
      does not follow the prefix rule.
- [ ] Settings: an older `settings.json` without the key reads the default; an own settings block has a default, a
      validator and a fill for missing keys; no secret in `settings.json`.
- [ ] Data in its own folder through a `persistence` store: `safePath`, `schemaVersion`, atomic JSON, JSONL streams.
- [ ] Main: the service checks `enabled()` on every pass; switching the module off stops processes, timers, requests
      and in-memory secrets; switching it on starts them again; stopped on `will-quit`.
- [ ] IPC: rows with validators, the bridge member, a `web-channels` decision, handlers, and the prefix in
      `channelModule`.
- [ ] UI: a `ModuleList` row and glyph; every entry point (rail, toolbar, `Tools ▾`, project tab, other features'
      options) hidden while off; the settings popup and ⚙ label if it has settings; searchable in Search Everywhere.
- [ ] Menus: items in `menu.ts`, `WorkspaceAction`, menu glyphs, `commandModule` coverage, PC keys; every shortcut
      has a menu item; the renderer action is guarded by the switch.
- [ ] MCP: tools named `<key>_*`, checked again in the host and in main, a line in the tools brief while on, the golden
      fixture updated; tools leave `tools/list` and `list_changed` goes out when the module is switched off.
- [ ] Strings: every visible string in `uk`, four plural forms with tests, agent text in English, glossary terms.
- [ ] Intro: `moduleTarget` entry; the sample window shows the module's part while it is on.
- [ ] Tests: vitest for touched code is green and `pnpm typecheck` passes; full `AppModules` literals in tests and
      e2e updated.
- [ ] Checked by hand in both themes: switching off and on in Settings and in the intro, with a live Claude session
      and a live Codex session open.

---

## 6. Pitfalls

- **`isAppModules` wants exactly the known keys.** Adding a key breaks every test fixture and e2e spec that writes a
  full `modules` object (`main/settings.test.ts`, `core/modules.test.ts`, `host/modules.test.ts`, `host/mcp.test.ts`,
  `tests/modules.spec.ts`), and the intro row count in `tests/intro.spec.ts`. Search for the last module's key
  (`slack: false`) to find them.
- **Settings written before the module existed lack its key.** Always read through `withModuleDefaults`. Never
  read `modules.<key>` from raw JSON anywhere else: the host and main must agree.
- **A module that is off must stop its work, not just hide its UI.** Hiding the section is not enough. Timers,
  processes, watchers, sockets, live command runs and queued posts stop in `settings:save` or on the service's next
  `enabled()` check. The commands module stops running commands; the browser closes its views; Slack forgets its
  token from memory.
- **Codex keeps its tool list.** Claude rereads `tools/list` after `list_changed`, but Codex keeps the list it read
  at session start. A call to a tool of a module that is now off reaches `callTool`. That is why `toolModule` must
  recognize the name, so the agent gets `moduleOffMessages[key]` and not `Tool … not found`. A module switched **on**
  stays invisible to a live Codex session until it restarts; the app does not force that restart.
- **Prefix matching uses the literal key.** `pullRequests_` never matches `pr_*`, and `pullRequests-` never matches
  `pull-requests`. With a camelCase key, every tool and command goes into the explicit tables.
- **Hand lists drift.** `channelModule` (main), `modulesWithSettings` (`ModuleSettings.tsx`), the Search Everywhere
  `moduleNames` (`core/search.ts`) and `workspaceModules` (orchestrator) are not derived from `appModules`, so the
  type check will not remind you. Search Everywhere's module switches currently stop at `remoteAccess`.
- **Options on shared tools are not filtered.** The prefix filter removes whole tools, not parameters. An option a
  module adds to a shared tool (`create_task` with `start: 'schedule'`) has to be gated where the call is handled.
- **Guard actions in the renderer too.** Main rebuilds the menu after a switch, but an action can already be on its
  way, and `menu:run` from a device's window is forwarded. Check `appearance.modules[key]` in the action handler.
- **Do not delete data on off.** Files, per-task flags and saved panel choices stay. Switching back on restores the
  same state.
- **The host is a separate process.** It learns about a switch only through its directory watch on `settings.json`,
  which is debounced by 50 ms. Tests that toggle modules wait for `list_changed`, not for a timer.
- **Remote windows.** A device's window shows the working machine's modules. It may save settings but never switch
  `remoteAccess`. Calls that enter or remove a secret are `remote: 'forbidden'`.
- **The MCP fixture is byte-exact.** Changing a tool's description changes `mcp-sdk-1.30.json`. Review that diff as
  carefully as the code.
- **New glyphs need a source.** A glyph used in a native menu has to be a `ui/Glyph` name listed in `menuIconNames`,
  or the menu shows no icon. Record a new icon's origin in [`docs/third-party-assets.md`](../third-party-assets.md).

---

## Reference: files the `notes` and `schedules` modules touch

| Area | `notes` | `schedules` |
| --- | --- | --- |
| Registry | `packages/core/src/modules.ts` | same |
| Domain | `packages/core/src/notes.ts`, `note-chat.ts` | `packages/core/src/schedules.ts`, `workspace.ts`, `task-proposal.ts` |
| Store | `packages/persistence/src/notes.ts` | `packages/persistence/src/schedules.ts` |
| Main | `main/index.ts`, `main/note-chats.ts` | `main/index.ts`, `main/schedules.ts`, `main/task-proposals.ts`, `main/sidebar-menu.ts`, `main/notice-log.ts` |
| IPC | `core/ipc-channels.ts`, `core/bridge.ts`, `core/web-channels.ts` | same |
| Menus | `core/menu.ts`, `core/menu-icons.ts`, `core/files.ts`, `core/keymap.ts` | same |
| Renderer | `NotesScreen.tsx`, `NoteEditor.tsx`, `SectionsRail.tsx`, `App.tsx`, `store.ts`, `ModuleList.tsx`, `Intro.tsx` | `SchedulesScreen.tsx`, `SidebarSchedules.tsx`, `ui/ScheduleEditor.tsx`, `NewTask.tsx`, `TaskProposal.tsx`, `SectionsRail.tsx`, `App.tsx`, `store.ts`, `ModuleList.tsx`, `Intro.tsx`, `ui/Glyph.tsx` |
| MCP | (the note chat uses the agent's own edit tool) | `packages/host/src/mcp.ts`, `server.ts`, `fixtures/mcp-sdk-1.30.json` |
| Strings | `core/messages.ts` | same |
| Tests | `core/notes.test.ts`, `persistence/notes.test.ts`, `core/modules.test.ts`, `host/modules.test.ts`, `host/mcp.test.ts`, `main/settings.test.ts`, `tests/modules.spec.ts` | `core/schedules.test.ts`, `persistence/schedules.test.ts`, `main/schedules.test.ts`, `core/menu-icons.test.ts`, the same module tests, `tests/intro.spec.ts` |

`slack` adds: `packages/core/src/slack.ts` (settings type, defaults, validator), `core/settings.ts`,
`main/settings.ts` (the migration), `main/slack.ts` (the client with the sealed token), `renderer/SlackSettings.tsx`
and `renderer/ModuleSettings.tsx` (the popup branch).
