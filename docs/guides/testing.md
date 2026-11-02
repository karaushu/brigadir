# Running and testing Brigadir

This guide is for engineers and coding agents working on the Electron app. It covers running the app for development,
the test levels and when to run each, the synthetic providers the tests use, the opt-in live checks, the packaged-app
test, and what still has to be checked by hand.

All commands run from `electron/` (or from the repository root as `pnpm --dir electron <script>`). All paths below are
relative to `electron/` unless they start with `docs/`.

---

## 1. Running the app for development

```sh
pnpm install
pnpm dev
```

| Script | What it does |
| --- | --- |
| `pnpm dev` | Builds the Node services (`build:services`), builds the phone bundle once, then starts the Vite dev server with the app in the foreground. |
| `pnpm dev:secondary` | The same, launched in the background on a secondary display without taking focus. |
| `pnpm start` | Full production build, then runs it from a frozen copy of `apps/desktop/out/` (see [Frozen build per app session](../spec/architecture-and-platform.md#launch-snapshot)). |
| `pnpm start:secondary` | The same, in the background on a secondary display. |

All four go through `scripts/start-desktop.mjs`. In dev, a code change that needs a full reload saves open surfaces and
unsaved buffers first and reloads the window ([Reload after code changes in development](../spec/architecture-and-platform.md#dev-reload)).
`pnpm start` copies the build into `apps/desktop/.launch/<hash>/`, so rebuilding `out/` while that app runs never breaks
it; rebuild and relaunch to pick up new code.

### Isolated data

By default the app reads and writes `~/.brigadir/`, the same folder for dev and packaged builds
([Data root](../spec/architecture-and-platform.md#data-root)). Point a development copy at its own folder with an
absolute path:

```sh
BRIGADIR_DATA_DIR=/absolute/temporary/path pnpm dev
```

A missing folder starts as an empty workspace. The home folder itself and its parents are refused. Setting
`BRIGADIR_DATA_DIR` also turns off the one-time move from `~/.brigadir-v2` and the background refresh of the agent
adapters.

Do not run two copies of the app (for example a release build and a dev copy) on the same data folder: both start and
reattach the task host processes. Give the second copy its own `BRIGADIR_DATA_DIR`.

### Not stealing focus

Use `pnpm dev:secondary` (or `start:secondary`) whenever the app is launched by an agent or a script while someone is
working on the same machine. It sets:

- `BRIGADIR_BACKGROUND=1`: the window is shown inactive. On macOS the app starts as an accessory (no Dock icon or menu
  bar) and becomes a normal app the first time the person focuses its window.
- `BRIGADIR_DISPLAY=secondary`: the window opens on a display other than the primary one. With no secondary display it
  stays hidden until one is connected.
- `BRIGADIR_INTERACTIVE=1`: the window can still take focus when clicked.

Never bring the app forward from automation (`app.focus`, `BrowserWindow.focus`, OS keyboard or mouse automation). The
Playwright config sets the same background and secondary-display variables for every e2e run.

### Trying the UI without a paid provider

The synthetic ACP agent used by the tests also works in a dev copy:

```sh
BRIGADIR_DATA_DIR=/absolute/temporary/path \
BRIGADIR_TEST_AGENT="$PWD/packages/transport/fixtures/agent.mjs" pnpm dev
```

`BRIGADIR_FIXTURE_SCENARIO=<name>` picks one of its scenarios (section 3).

---

## 2. Test levels

| Level | Command | Who runs it, and when |
| --- | --- | --- |
| Types | `pnpm typecheck` | Every change. |
| Unit (vitest), touched code | `pnpm exec vitest run <paths> --reporter=dot --silent` | An agent working on a branch: only the tests of the code it touched. |
| Unit (vitest), everything | `pnpm test` | Before a merge, or when a shared package changed. Builds the services first. |
| Smoke e2e | `pnpm test:smoke` | Once per merge that changes `apps/desktop/src/main` or `packages/host`, `packages/transport` or `packages/git`. A pure UI or CSS merge runs no e2e. |
| Area e2e | `pnpm test:area <name>` | Only when asked for. |
| Full e2e | `pnpm test:full` | Only when asked for. |
| Everything except e2e | `pnpm check` | `typecheck`, `test` and `build` in one go. |

Run each level once. Do not rerun a suite to make it green; investigate the red test instead.

### vitest

`vitest.config.ts` picks up `packages/**/*.test.ts`, `scripts/**/*.test.ts` and `apps/**/*.test.ts(x)` in a Node
environment. Host and transport process tests start the built services (`host.cjs` and the relays), so run
`pnpm build:services` once before running them on their own; `pnpm test` does this for you.

Do not run a build and tests at the same time: the build copies native modules (`node-pty`) that the host tests load,
and a host started mid-copy fails.

### Playwright e2e

The e2e specs live in `tests/*.spec.ts` and launch the real Electron app from `apps/desktop/out/`, each with its own
temporary data folder and Chromium profile, in background mode. `test:full` builds first; `test:smoke` and `test:area`
do not, so run `pnpm build` first when the build is stale.

`scripts/test-e2e.mjs` runs each mode in two lanes:

1. tests without `@serial` in parallel (`BRIGADIR_E2E_WORKERS`, default 3);
2. tests tagged `@serial` (they use the system clipboard) one at a time.

| Mode | Selects |
| --- | --- |
| `smoke` | Tests tagged `@smoke`. |
| `area <name>` | Tests tagged `@area:<name>`; `<name>` is one of `chat`, `tasks`, `diff`, `editor`, `pr`, `settings`, `browser`, `shell`. |
| `full` | Every spec. |

Extra arguments go to `playwright test`, for example `pnpm test:smoke --reporter=line`. One spec on its own:
`pnpm exec playwright test tests/editor.spec.ts`. The reporter is quiet (`dot`), so only failures print in full; a
failed test keeps its trace in `test-results/`.

The smoke set is 15 specs: `board`, `changes`, `commits`, `composer`, `conversation`, `desktop`, `editor`,
`files-tree`, `launch`, `menu`, `projects`, `settings`, `sidebar-state`, `slash-menu`, `steering`.

The e2e config also sets `BRIGADIR_SKIP_INTRO=1` (no first-run intro), `BRIGADIR_REMOTE_WATCH=0` (no background
`git fetch`) and `BRIGADIR_ICON_PICK=0` (no agent-picked project icons). The specs that need one of these turn it back
on for their own app.

Some specs also enforce performance budgets:

- 10,000 conversation rows: fewer than 100 mounted rows, first view under 3 s, scrolling p95 under 50 ms, and Find
  reaches a row outside the mounted window (`conversation.spec.ts`).
- 50,000 diff rows: fewer than 120 mounted rows, first view under 3 s, scrolling p95 under 50 ms
  (`changes.spec.ts`).
- 60,000 editor lines: fewer than 200 mounted lines, open under 3 s, still editable (`editor.spec.ts`).

### Writing a new e2e test

- Add one only for behavior vitest cannot reach: a real process or PTY, git on disk, main and renderer IPC, a native
  menu, the clipboard, drag and drop. Prefer a new step in the existing spec of that flow.
- Tag it `@area:<name>`; add `@serial` if it touches the clipboard.
- Wait for events (`expect.poll`, `settle(page)` from `tests/settle.ts`), never `waitForTimeout`.
- Find elements by role or `data-testid`. Do not assert CSS, pixel sizes, computed styles or exact UI text. A test that
  goes red on a design or copy change is removed, not tuned to the new numbers.

---

## 3. Synthetic providers and fixtures

Normal tests never call a paid provider and never touch real project data. They use temporary repositories and data
folders, and these stand-ins:

| Fixture | Stands in for | Selected by |
| --- | --- | --- |
| `packages/transport/fixtures/agent.mjs` | An ACP agent over real stdio (Claude or Codex adapter). | `BRIGADIR_TEST_AGENT=<path>`; scenario from `BRIGADIR_FIXTURE_SCENARIO`, event log to `BRIGADIR_FIXTURE_LOG`. |
| `packages/transport/fixtures/cli.mjs` | A terminal (CLI) agent that fires the Claude/Codex hooks through the relay. | CLI-transport tests. |
| `packages/transport/fixtures/codex-app-server.mjs` | `codex app-server` for account and limits reads. | `BRIGADIR_CODEX_FIXTURE` (`chatgpt`, `api-key`, `two`). |
| `packages/transport/fixtures/claude-usage.mjs` | `claude -p /usage` and `claude auth status --json`. | Quota tests. |
| `packages/transport/fixtures/ghost.mjs` | The one-shot model behind composer hints. | `BRIGADIR_TEST_GHOST`, state file in `BRIGADIR_TEST_GHOST_STATE`. |
| `packages/transport/fixtures/claude.json`, `codex.json` | Reduced protocol samples of real sessions, one of each update kind. | Mapper and transport unit tests. |
| `packages/transport/fixtures/claude-agent-turn.jsonl`, `claude-background.jsonl` | Recorded wire of a turn the agent starts on its own, and of background tasks. | `agent.mjs` scenarios and unit tests. |
| `packages/forge/fixtures/gh.mjs` | The GitHub CLI (`gh`). | `BRIGADIR_TEST_GH=<path>`. |

`agent.mjs` scenarios include `catalog`, `model-effort`, `plan-modes`, `steering`, `steering-late`, `steering-codex`,
`agent-turn`, `agent-turn-codex`, `agent-turn-quick`, `background-live`, `subagents`, `crew`, `fs-policy`,
`auth-startup`, `ghost-model` and others; the comments at the top of the file describe each one. Without a scenario it
answers a prompt with a plain synthetic turn.

A passing fixture run shows that the app handles the recorded protocol. It does not show that today's real Claude or
Codex still behaves that way; that is what the live checks are for.

---

## 4. Opt-in live checks

These tests are skipped unless their variable is set. They start the real provider CLIs, use your signed-in accounts and
spend real turns. They work only in temporary folders.

```sh
BRIGADIR_LIVE_TRANSPORT=claude pnpm exec vitest run packages/transport/src/live.test.ts
BRIGADIR_LIVE_TRANSPORT=codex  pnpm exec vitest run packages/transport/src/live.test.ts
```

The transport smoke opens a read-only ACP conversation in an empty folder, asks for the single word `READY` and checks
that the turn ends cleanly and the folder stays empty. It records a JSON summary of the run.

Other live tests, run the same way with `pnpm build:services` first:

| Variable | Test | Checks |
| --- | --- | --- |
| `BRIGADIR_LIVE_CLI=claude\|codex` | `packages/host/src/live-cli.test.ts` | CLI hooks and session context survive a host restart. |
| `BRIGADIR_LIVE_RESUME=claude\|codex` | `packages/host/src/live-resume.test.ts` | A GUI host restart keeps the provider's context. |
| `BRIGADIR_LIVE_GATES=claude\|codex` | `packages/host/src/gates.test.ts` | Permission and question gates with a real agent. |
| `BRIGADIR_LIVE_PLAN=claude\|codex\|claude-approval\|claude-approve-mode` | `packages/host/src/live-plan.test.ts` | Plans and plan approval. |
| `BRIGADIR_LIVE_CREW=g3\|g4\|g5\|all` | `packages/host/src/live-crew.test.ts` | Crew runs end to end; the most expensive set. |
| `BRIGADIR_LIVE_SIMULATOR=<UDID>` | `apps/desktop/src/main/simulator.live.test.ts` | iOS Simulator streaming and input. |
| `BRIGADIR_LIVE_ANDROID=<AVD name>` | `apps/desktop/src/main/simulator.live.test.ts` | The same through the Android emulator. |

Run a live check after changing the transport, the provider adapters, the CLI hooks or the host lifecycle, or after a
provider CLI update changes behavior.

---

## 5. Packaged-app test

Static checks of a release package run as part of packaging and never launch the app:

- `pnpm dist:mac` builds the DMG into `dist/` and checks it. To check a DMG again:
  `pnpm dist:check dist/Brigadir-<version>-<arch>.dmg [--x64]`.
- `pnpm dist:linux` builds the Linux packages and checks them (`scripts/check-linux.mjs`).

To run the macOS bundle live, in the background with temporary data:

```sh
pnpm dist:mac
BRIGADIR_PACKAGED_APP="$PWD/dist/mac-arm64/Brigadir.app" pnpm exec playwright test tests/packaged.spec.ts
```

The test starts the bundle with the `PATH` Finder would give it and checks that main runs from `app.asar`, the login
shell's `PATH` is picked up, and the task host, helpers and synthetic agent start from `Contents/Resources/services`.
It runs only a bundle of this Mac's architecture; an x64 bundle on Apple Silicon is covered by the static check only.
Packaging details: [Packaging and identity](../spec/architecture-and-platform.md#packaging).

---

## 6. Manual acceptance

Automated tests drive the app through Chromium's DevTools protocol and synthetic input. These checks need real input
and real use; do them before a release, on a build made for people.

**Use a real multi-root project.** The reference case is a monorepo with several independent git roots: the root
repository, two submodules, a gitignored nested repository and a linked worktree. On such a project:

- [ ] Start a task with Claude and with Codex; answer a permission card and a question card.
- [ ] Check the diff and review flow: select lines, comment, send a review, see comments marked Addressed after the
      agent's change ([Diff and review](../spec/diff-and-review.md)).
- [ ] Make a small editor change and save it; then change the same file outside the app and resolve the conflict
      ([Disk and buffer](../spec/editor.md#disk-vs-buffer)).
- [ ] Attach terminal output and browser context to the composer and send them.
- [ ] Quit and reopen the app while an agent works: the task reconnects to its host and nothing is lost.

**Input and focus.**

- [ ] Move keyboard focus between the editor, the console, the browser page and the browser address field with a
      physical keyboard, including Cmd+[ and Cmd+], a non-Latin keyboard layout and IME composition.
- [ ] Pick a page element with the browser's node picker using a physical mouse click; check the chip preview, that
      removing the chip clears the highlight, and that navigating clears it too
      ([Node picking](../spec/browser-and-simulator.md#node-picking)).
- [ ] Click `Esc` on a tall dialog where it overlaps the toolbar. Native drag regions are invisible to Playwright,
      which clicks through the DevTools protocol.

**Terminal agents.**

- [ ] In a CLI task, interact with the real Claude and Codex terminal UI, interrupt with Ctrl+C, and jump to turns that
      are still in the scrollback and to ones that have dropped out of it
      ([Terminal and CLI agents](../spec/terminal-and-cli-agents.md#cli-interrupt)).

**Packaged app.**

- [ ] Install the DMG, open it from Finder and check notifications (the permission prompt and a delivered
      notification) and that agents find their CLIs on the login shell's `PATH`.

---

## 7. Known flaky areas

- **Build and tests at once.** Running `pnpm build` (or `build:services`) while vitest runs can fail a host test at
  startup, because native modules are being copied. Run them one after the other.
- **PTY process groups.** Host terminal tests occasionally fail once with a `setpgid` error from the system shell. A
  rerun of that file alone passes; it is not a reason to weaken the assertion.
- **Clipboard.** Specs that use the system clipboard must be tagged `@serial`. Untagged, they race with other workers
  and with whatever the person at the machine copies.
- **Performance budgets.** The row, frame and open-time budgets in `conversation`, `changes` and `editor` specs are
  real limits, but a machine under heavy load (another build, a full parallel run) can push a p95 over the line. Check
  the machine's load before treating a budget failure as a regression.
- **Stale build.** `test:smoke` and `test:area` run whatever is in `apps/desktop/out/`. A failure right after a source
  change is often an old build; run `pnpm build` first.
