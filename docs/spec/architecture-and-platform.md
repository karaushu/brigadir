# Architecture, platform, data and performance

Brigadir is an Electron app: a React renderer, a Node main process and one detached Node "host" process per task that owns the agent, its journal and its sockets. All state lives as JSON/JSONL under `~/.brigadir/`, readable by hand. This file covers the process model and its IPC boundaries, the data layout, exit and crash behaviour, keep-awake, the window frame, packaging per OS and auto-update, and the performance rules and limits the rest of the app relies on.

<a id="stack"></a>
## Stack and code layout

The app is built on Electron: renderer in the web stack, core on Node, hosts and helpers on Node or as small native binaries. Cross-platform where it costs nothing; macOS and Linux ship full builds.

| Path | Role |
| --- | --- |
| `apps/desktop/src/main` | Electron main: windows, menu bar, `nativeTheme`, accent, IPC handlers, session clients, quit guard |
| `apps/desktop/src/preload` | typed bridge built from the channel table (`createDesktopBridge`) |
| `apps/desktop/src/renderer` | React + TypeScript UI, store in `zustand`, CSS Modules over design tokens |
| `apps/desktop/src/renderer-mobile` | phone web client (see [Remote access and mobile](remote-access-and-mobile.md)) |
| `apps/desktop/src/services` | service entry points bundled to `out/services` (host, workers, helpers) |
| `packages/core` | domain types (`Scope`, `Project`, `AgentTask`, `SessionEvent`/`SessionCommand`, review, crew), message catalog, keymap, IPC channel table; no Node, no DOM |
| `packages/persistence` | data root, JSON/JSONL, atomic writes, schema checks, data-dir move |
| `packages/git` | git CLI, snapshot trees and refs, worktrees |
| `packages/forge` | `gh` CLI |
| `packages/diff` | line diff, hunks, side-by-side pairs, word level, anchors |
| `packages/syntax` | `web-tree-sitter` (wasm) highlighting, symbol paths |
| `packages/transport` | ACP client and mapping ACP → domain events |
| `packages/orchestrator` | crew plan, tools, permissions, crew tree |
| `packages/host` | `host.cjs`: process per task, PTY, journal, socket, MCP server, native `mcp-relay` / `cli-relay` sources |
| `packages/lsp` | language server client |
| `packages/remote` | remote-access gateway protocol |

Third-party protocol SDKs: ACP via `@agentclientprotocol/sdk`. Anything they lack is written on top, never forked. The MCP server is implemented inside the host with the same zod schemas (no separate MCP package or process, see [MCP served by the host](#mcp-relay)).

Renderer libraries: `xterm.js` with the WebGL renderer for terminals, CodeMirror 6 for the editor (code intelligence on top of it), `markdown-it` for Markdown, `WebContentsView` with `webContents.debugger` (CDP) for the in-task browser. No Tailwind, no shadcn, no Monaco: controls are drawn from Brigadir's own tokens.

<a id="layer-rules"></a>
### Layer rules

- Dependencies point downward only; a feature never depends on another feature. Details are in `ARCHITECTURE.md`.
- The renderer sees only `core` types, and only through the preload bridge.
- UI depends on the domain model (`SessionEvent` / `SessionCommand`), never on ACP types; raw `session/update` payloads never reach a view or the preload.
- One virtualized row component serves both diff and activity view.
- One active surface per window lives in the DOM; inactive terminals and pages stay buffered in the host or main.

<a id="stack-rules"></a>
### Project rules in this stack

| Rule | Implementation |
| --- | --- |
| Semantic colors only | `var(--token)` from the design tokens; no hex in components; accent from Settings, or `systemPreferences.getAccentColor()` into `--accent` for the system option |
| Theme from one place | `nativeTheme` → `prefers-color-scheme`; no theme switches inside components |
| All visible text through the catalog | one message catalog for main and renderer, `t(locale, "key")`, key = English text; `uk` uses 4 plural forms via `Intl.PluralRules` plus its own form table |
| Stable on-disk JSON | sorted keys, 2-space indent, trailing newline, runtime schema validation |
| No app sandbox | renderer: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`; main and hosts are unsandboxed because they launch agents and read project folders |

<a id="processes"></a>
## Processes

| Process | Started by | Lifetime | Notes |
| --- | --- | --- | --- |
| Electron main | user | app session | owns windows, IPC, stores of UI state, session clients |
| Renderer | main | one per window | sandboxed; reloads on crash |
| Host (`services/host.cjs`) | main, via `spawn(process.execPath, …, {detached: true})` with `ELECTRON_RUN_AS_NODE=1` | one per task; survives window close, app quit and app crash | stdout/stderr go to the task's `host.log` |
| Agent adapter / CLI | host | while the host runs a session | child of the host |
| `mcp-relay` (native) | the agent, as its MCP server | one per agent session | copies bytes between agent stdio and the host socket |
| CLI hooks / statusline | the agent CLI | per hook call | `zsh -f hook.zsh` on macOS, native `cli-relay` on Linux |
| Worker threads | main | pooled, exit after 30 s idle | diff, syntax, reanchoring |
| LSP servers, Prettier, Android helper | main | on demand | run on `process.execPath` with `ELECTRON_RUN_AS_NODE` |

The host is a plain child process, not a `utilityProcess`: the same process must run without Electron (tests, CLI use) and must not be tied to the app's lifetime.

<a id="ipc-boundary"></a>
## Main / preload / renderer boundary

- **One channel table.** `packages/core/src/ipc-channels.ts` has exactly one row per `DesktopBridge` member: IPC channel, kind (`invoke`, `subscribe`, or `local` that never crosses IPC), class, and for invokes the runtime argument validator. The preload builds named methods from it; main registers each handler with its validator. The remote gateway routes by the same rows (class `remote` runs on the working machine, `client` on the machine that shows the window; `remote: 'forbidden'` / `'guarded'` restrict remote callers).
- **No generic channel.** No `invoke(channel, args)`, no arbitrary file paths or shell commands in the bridge. Paths and launch commands are chosen by main.
- **Sender check.** Every handler verifies the sender is our window, its main frame, and the exact entry URL (`isTrustedSender`, `main/trusted-sender.ts`); dev builds compare origin and path of the dev-server URL.
- **Subscriptions** return an unsubscribe function and never pass the Electron event object to the renderer.
- **Navigation.** The window loads only the local build or the exact dev-server origin. `will-navigate` is cancelled and `setWindowOpenHandler` denies new windows; a page-initiated reload also goes through `will-navigate`, so reloads are requested from main (`window:reload`). A CSP limits scripts to the app's own bundle.
- **Remote pages** in the in-task browser have no app preload, a separate session and separate permissions.
- **Renderer errors** reach main only through `renderer:error`, which accepts an object of bounded-length string fields.

Why: TypeScript types do not check messages at runtime, so every crossing is validated where it lands.

<a id="session-host"></a>
## Session host

Each task runs in its own host process. The host owns the agent's stdio, normalizes ACP into domain events, writes every event to the task journal itself, owns checkpoints, the prompt queue, question and permission brokers, terminals and the MCP server. The app is a client: closing the window disconnects it, quitting the app leaves hosts running, and the next app start reattaches. One crash takes down one task, not every agent.

<a id="host-files"></a>
### Host files

All under the task directory `projects/<projectId>/tasks/<taskId>/` unless stated.

| File | Content |
| --- | --- |
| `host-config.json` | written by main before spawn: `dataDir`, task key, `mcpEntry`, `runtime`, `consoleOnly`, `allowScopeConflict` |
| `host.json` | host identity: `schemaVersion`, `protocolVersion: 1`, key, `pid`, `startedAt`, random `instance`, `socket` path, per-role tokens (`uiToken`, `mcpToken`, `hookToken`, `crewToken`), `appVersion` — the app version `host.cjs` was built with (absent in hosts of older builds) |
| `host.lock` | exclusive owner record: `pid`, `processStart`, `instance`; taken inside a transaction on `host-owner.guard` |
| `host.log` | host stdout/stderr; launch errors point to it |
| `run/<hash>.sock` (data root) | the host's Unix socket |

- **Socket path.** The name is the first 24 hex chars of a SHA-256 of root, project, task and instance, so every launch has a unique name. If the path would reach 104 bytes (`sun_path`), the socket goes to `/tmp/brigadir.<uid>/`. The directory is created `0700`, must be a real directory owned by the user (not a symlink); sockets are `0600`.
- **Ownership.** Only one host may write a task. `host.lock` is reclaimed only when its PID is absent or its process start identity differs (checked with the native `process-owner` helper, which handles PID reuse). A live PID is never a reason to kill a process.
- **Launch.** Main reattaches if a host answers; otherwise it checks the journal, reclaims an absent owner, writes `host-config.json`, spawns the host and polls the small `status` RPC every 100 ms (up to 90 s). A dead child fails at once ("Host stopped during startup. See host.log."); the full snapshot crosses the socket once the agent has started.
- **Status on read.** A task recorded as `working` or `needs-you` whose host cannot be reached is shown as `interrupted`.
- **Tasks start from an action**, never from a window appearing; opening a task never launches anything.

<a id="socket-protocol"></a>
### Socket protocol

Newline-delimited JSON-RPC (`Peer`), the same framing as ACP, two-way: either side may send requests. The vocabulary is domain types only, so the journal and the socket share one format.

- **Handshake.** First message, within 5 s or the socket is closed: `protocolVersion: 1`, `instance`, task `key`, `role`, `token`. The reply carries `protocolVersion`, `instance`, `key`, `startedAt` and, from hosts that record it, `appVersion`.
- **Roles.**

| Role | Who | May call |
| --- | --- | --- |
| `ui` | main | everything; a new UI peer displaces the previous one and starts with no terminal subscriptions |
| `mcp` | `mcp-relay` (`stdio: true`) | MCP session handed off to the host's MCP server; outside stdio only its task's own tools such as `ask_user` |
| `hook` | CLI hooks, terminal transport only | `cli_hook`, `cli_statusline` |
| `crew` | a parent foreman host | `start_agent`, `snapshot`, `status`, `command` |

- **App → host methods:** `command` (a `SessionCommand`, e.g. `answerPermission`, `answerQuestion`, `decidePlan`, `submitReview`, queue and steering commands, `checkpoint`, `shutdown`, `retire`), `status`, `snapshot` (`{afterSeq}` returns only newer records), `visible` (whether the task is selected in a window), `start_agent`, `save_file`, `revert_file`, `terminal` (`read`, `unwatch`, `create`, `run`, `close-consoles`, …), `background_output`, `editor_state` / `pr_state` answers.
- **Host → app:** notifications `event` (journal records) and `terminal`; requests where a person or the window must decide: `folder`, `task_agent`, `browser`, `browser_show`, `browser_allowed` / `browser_remember`, `browser_act_allowed` / `browser_act_remember`, `simulator`, `code_restart`.
- **`status`** returns `connected`, `seq` of the last record, `started` (seq of the last `session.started`), `failed` (seq of the last `session.failed`) and optional `busy`. A host that predates a method answers `Invalid command` or "not available to this role", and the client falls back to one full `snapshot` (host and app update independently).
- **Frames** are parsed in linear time (only the new chunk is scanned); limit 32 MiB per frame.

<a id="permissions-without-ui"></a>
### Permissions and questions with no window

A task lives with the window closed, so a permission request or question may have nobody to show it to.

- The host keeps the adapter's request pending **with no timeout**. The request is journaled (`permission.requested` / `question.requested`), the task becomes `needs-you`, the notification fires regardless of the window, and the app answers on connect with `answerPermission` / `answerQuestion`.
- There is no auto-deny timeout and there will not be: silent refusals overnight stop agents halfway on things the person would have allowed.
- `ask_user` blocks until an explicit answer. Options return their text labels; free text and multi-select only when the question allows them. The first valid answer wins. A UI disconnect never answers for the person; MCP cancel or disconnect resolves the question as interrupted, never as approval.
- **Reconnect mid-question.** A request in flight to a window that drops goes back to the queue, but must not clear a window that connected later. Brokers (permissions and plans alike) remember the connection number and, after each `await`, check that the connection is still theirs. A handler that let go of state across an `await` does not use it afterwards; references to state are taken before `await`, not after.

<a id="host-checkpoints"></a>
### Checkpoints belong to the host

The host takes snapshot trees and appends `checkpoint.created` itself, so the timeline has no gaps while the window is closed. See [Diff and review](diff-and-review.md) for the snapshot model; the write and ref rules are in [Snapshot refs](#snapshot-refs) and [Snapshot cost](#perf-snapshots).

<a id="host-lifecycle"></a>
### Host lifecycle and stop reasons

The host ends through one stop path that journals `host.stopped` with a reason, closes the adapter, `mcp-relay` and terminals it owns, and releases repo locks.

| Trigger | Reason | Effect on task status |
| --- | --- | --- |
| Stop by the person | user stop | per task model |
| A finished turn | none: the session stays open for the next message | — |
| Idle for `hostIdleMs` (15 min) | `idle` | unchanged |
| Host of another app version, at its first moment with nothing running ([auto-update](#auto-update)) | `update` | unchanged |
| Task dir gone or replaced, or socket file gone | `orphaned` | — |
| All consoles closed on a console-only host with no agent | `console_closed` | — |
| Crew reviewer whose parts are all accepted and reviews finished | stop | unchanged |

- **Idle stop** applies to GUI (ACP) tasks only. The 15-minute countdown runs while all of these hold: no turn or agent start, no file write, no open permission or question, no queued prompts (including a paused queue), no live person's console, no active quota wait, the task is not selected in any window (main sends `visible` on every change and on connect; losing the UI peer clears it), it is not a crew worker, lead or reviewer, and a foreman only when its whole crew is finished; status is not `preparing` or `queued`. Any journal record or command restarts the countdown. CLI (terminal-transport) tasks and consoles never idle-stop. `BRIGADIR_TEST_IDLE_MS` shortens it in tests.
- **After an idle or update stop** the chat does not show "Agent is not running." or a Resume button; the composer stays usable. Sending a message or review starts the host the normal way (`session:start` → launch queue, with the lock-conflict dialog and agent limit), shows "Starting…", then delivers the prompt once with the same attachments and resumes the same provider session (`session/load`). If the start fails, is cancelled or queued, the existing error or queue row shows and the draft and attachments stay.
- **Orphan check.** Every 5 s (`orphanCheckMs`, timer unref'd) the host `stat`s its task dir (device and inode recorded at start) and `lstat`s its socket. No idle blocker cancels this; journal and lock writes during that stop are best effort and the process always exits. Crew workers have their own dirs and stop on their own. The host is never tied to the parent PID, IPC disconnect or stdin, since that would stop agents on ⌘Q or a crash.
- **Crew reviewer** stops (host and agent) when every part it reviews is accepted and its reviews are done; a running turn finishes first. Status and worktree stay. A new round starts it again through `dispatchReviews` → `spawn` with session resume. A reviewer the person resumed by hand is not stopped again before the next round.
- **Resume after a crash.** A new host resumes the ACP session only when the adapter advertised `loadSession`. History replayed by `loadSession` is not journaled again: before `session.started` the host drops replay events, because the journal is already the source of history.
- **Interrupted turn.** A new owner of a task whose last turn did not end appends `host.stopped`, pauses the prompt queue and sets the task `interrupted` before accepting clients. Resuming the queue is an explicit action. It never invents a successful end or a user cancellation.
- **Stop states stay distinct.** `done` means the agent finished its turn; a deliberate stop never draws attention; `interrupted` means work was running when its host went away, and is a candidate for attention with a Resume action.

<a id="mcp-relay"></a>
### MCP served by the host

The agent launches the native `mcp-relay` as its MCP server. It sends a `mcp` handshake with `stdio: true` and from then only copies bytes; one connection per session. The host answers `initialize`, `tools/list` and `tools/call` itself with the zod schemas of the tools, lists tools by the task's role (`BRIGADIR_ROLE` stays in the agent env) and re-checks permissions per call. `tools/list`, `initialize` and validation errors match byte for byte the recorded output of the earlier SDK server (`packages/host/fixtures/mcp-sdk-1.30.json`). Why: a separate MCP process on the Electron runtime cost about 75 MB RSS and 100 ms per session; the relay costs under 2 MB and 2 ms.

<a id="pty-and-hooks"></a>
### PTY output and CLI hooks

- The host sends PTY output to the UI only for terminals a mounted panel subscribed to with `read`; `unwatch` (panel cleanup) stops it. `exited` and `block` events always go out. Turn anchors are attached to an event only when they change. After a reconnect main repeats `read`.
- PTY output is fed into a headless xterm with one write in flight; output arriving meanwhile is parsed and published together. The child is paused only when over 1 MiB is queued. Events are published after parsing. The headless xterm provides `read`, turn anchors and reconnect restore; a terminal that exited keeps a serialized buffer after 60 s instead of a live headless xterm.
- CLI hooks: macOS runs `/bin/zsh -f hook.zsh` (zsh and bash send `base64(command NUL cwd)`); Linux runs `cli-relay hook` / `cli-relay statusline`. Contract: input at most 1 MiB, role `hook` with its own token, method `cli_hook` / `cli_statusline`, stdout carries only a non-empty `result`, 8 s per reply. `hook.cjs` remains only for CLIs already running. PostToolUse and Stop reply at once and snapshots run on a separate chain before `turn.completed`; UserPromptSubmit still snapshots before replying. A failed tool snapshot is journaled as `snapshot.failed`. A changed hook command can make Codex ask once to trust hooks.

<a id="persistence"></a>
## Data and persistence

<a id="data-root"></a>
### Data root

- **Location:** `~/.brigadir/` (`%USERPROFILE%\.brigadir\` on Windows), not `~/Library/Application Support`, so data can be grepped and read by hand. It is the same for dev and packaged builds and independent of the bundle id.
- **`BRIGADIR_DATA_DIR`** overrides it for tests and development (absolute path only). `resolveDataRoot` canonicalizes the root and refuses the home folder itself or any of its parents (`unsafe_path`). Tests never write into the real home.
- **Move from `~/.brigadir-v2`.** `main/data-dir-move.ts` is main's first import and calls `moveDataDir` synchronously before any store opens, only when `~/.brigadir` does not exist and `~/.brigadir-v2` is a directory:
  - rename the folder;
  - in every `*.json` outside `worktrees/`, rewrite strings equal to the old root or starting with `<old root>/` (atomic, formatting kept); `*.jsonl` journals are history and are not touched;
  - `git -C <root>/<relativePath> worktree repair` for every repo in a `worktree.json`, so source repos see the new location;
  - rename `~/.claude/projects/<encoded old root>…` folders to the encoded new root so Claude sessions resume in worktrees;
  - postpone the whole move if any task's `host.lock` or another copy's `run/app-<pid>.lock` points to a live process; until then `defaultDataDir` keeps using the old folder. Each running copy writes `run/app-<pid>.lock` at start (`markAppRunning`) and removes it on exit.
  - If `~/.brigadir` already exists it wins and `~/.brigadir-v2` is left alone. `BRIGADIR_DATA_DIR` disables the move.
- Not renamed: the git ref namespace `refs/brigadir-v2/…` in users' repos (recorded in `snapshots.json` and tasks).

<a id="data-layout"></a>
### Layout

```
~/.brigadir/
  settings.json            app settings (all sections)
  sidebar.json  task-reads.json  task-labels.json  project-views.json
  recent-projects.json  surface-layout.json  launch-queue.json  scope-locks.json
  pr-suggestions.json  quota-view.json  cli-updates.json  project-icon-asks.json
  notifications.jsonl      notification center log
  run/                     host sockets, app-<pid>.lock, scope-locks.guard (0700)
  logs/renderer.jsonl      renderer error log
  usage/                   provider usage readers' data
  ghost/                   ghost-suggestion state
  templates/  notes/  remote/  slack/  attachments/  drafts/
  worktrees/<projectId>/<taskId>/   task worktrees
  projects/<projectId>/
    project.json  workspace.json  knowledge.json  [icon.png]
    pull-requests/         PR summaries and review drafts
    tasks/<taskId>/
      task.json            task metadata and status
      events.jsonl         journal of domain events
      snapshots.json       checkpoint list
      surface.json         task surface state
      worktree.json  review.json  crew-*.json  attachments/  snap-index-*
      host-config.json  host.json  host.lock  host-owner.guard  host.log
```

Module-specific files are described in their own spec files. The minimal contract of the two core documents:

- `project.json`: `{schemaVersion: 1, project: {id, name, path, …}}`.
- `task.json`: `{schemaVersion: 1, task: {id, projectId, title, status, provider?, prompt?, …}}`. Statuses are defined in [Tasks](tasks.md). The initial prompt is saved before launch, so a failed launch never loses the person's text.
- IDs are safe path segments; a document's id must equal its folder, a task's `projectId` its parent. Symlinked entries and documents over 1 MiB are read issues, not data.

<a id="formats"></a>
### Formats and write rules

- **Two formats:** JSON for state, JSONL for append streams. No TOML, no YAML: the app writes these files itself (scope checkboxes, remembered launch defaults), so comment-preserving formats would lose their advantage on the first click. The spec documents schemas; files carry no comments.
- **JSON** via `jsonText`: keys sorted recursively, 2-space indent, trailing newline, for stable git diffs.
- **Atomic writes** (`atomicJson` / `atomicText`): temp file `0600` → write → `fsync` → `rename` → `fsync` of the directory. Known documents keep extra fields they do not understand.
- **Schema version in every document and every journal record.** Readers report `unsupported_schema` for an unknown version and never rename or rewrite the file. Corruption (`invalid_document`, `incomplete_record`, `unsafe_path`, `unreadable`) is reported separately from an empty state. A missing data root is an empty state. Schemas get a new version only when a required contract changes.
- **No tokens or credentials** in the data root; agent logins live where the agent CLI keeps them.
- **Retention:** nothing is deleted automatically. Deleting a task or project moves its folder to the OS Trash (`shell.trashItem`) and keeps its snapshot refs, so a restored task keeps its history.
- **Read-modify-write of `task.json`** is serialized per file within a process, so a status write cannot restore an older launch field.

<a id="journal"></a>
### Journal (`events.jsonl`)

- One record per line: `{schemaVersion: 1, seq, at, event}` where `seq` is consecutive from 1 and `event` is a validated domain event. Raw ACP is never persisted: it is ephemeral, versioned by the protocol and provider-specific. The normalized journal is what restores the activity view after a restart and makes a second transport cheap.
- New facts are added as **new event kinds**, not as new required fields, so old records stay readable.
- **Durability.** Records are fsynced before they are published to clients. Streaming kinds (`message.delta`, `tool.changed`, `usage.changed`) are written at once but fsynced together every 50 ms; every other record (turn boundaries, permissions, questions, `prompt.queued`, checkpoints, `session.*`, `host.stopped`, crew records) returns only after an fsync that also covers the streamed records before it. `close()` flushes the rest. A power loss or kernel panic can lose up to 50 ms of streamed text or tool progress; a process crash loses nothing. Why: a full fsync on macOS costs about 4.4 ms, which capped a host at about 220 events per second.
- **Damage.** An unterminated last line is reported as `incomplete_record`, and appending is refused until an explicit recovery. A damaged or unknown-schema journal is never silently truncated or rewritten.
- **Reads.** The renderer reads a task's journal once, then only tails (`session:read(key, afterSeq?)`); `sessionStateOnly` gives state without records; `session:activity` returns `{connected, busy, started}`. Activity details and crew tools read journals and notes incrementally. `knowledge.json` is rewritten only when it changes.

<a id="snapshot-refs"></a>
### Snapshot refs in users' repos

Git snapshots live in the repos themselves. Brigadir writes only under `refs/brigadir-v2/`; branches, the user's index and other refs are never touched, and read-only calls run with `GIT_OPTIONAL_LOCKS=0`.

- Each capture that creates a snapshot commit moves one ref per task and repo: `refs/brigadir-v2/tip/<project>/<task>/<scope>`, with `update-ref <ref> <new> <old>`. No per-checkpoint ref is created. The tip lies outside `snap/` because `snap/…/<scope>` cannot be a ref while per-checkpoint refs exist under it.
- The new commit's parent is the last snapshot of that repo in the task, so the tip keeps every earlier snapshot reachable; a repo that disappears and returns continues its own chain.
- **Only what stays reachable is deleted.** Older tasks may hold per-checkpoint refs `refs/brigadir-v2/snap/<project>/<task>/<scope>/<n>`. They are consolidated lazily on the first committing capture in a repo per `Snapshots` instance: `for-each-ref` (up to 1024 refs per pass), one `update-ref --stdin` transaction for the tip and a keeper, a second for deletions with each ref's old value. A per-checkpoint ref is removed only after `merge-base --independent` proves its commit is an ancestor of, or equal to, a commit another remaining ref holds. Ends of broken chains and unproven tips keep their own refs. The pass is idempotent and retried on failure.
- `snapshots.json` records either the tip or a historical per-checkpoint name in each checkpoint's `ref`; reads go by tree and commit SHA only.

<a id="exit"></a>
## Exit

Closing the window and quitting wait for named pending writes, then always finish.

- `saves` in `main/index.ts` lists every store whose writes must land: files, layout, surfaces, browsers, reviews, composer, settings, project views, task reads, notice log, launches, preparations, scope controls, launch settings, relays, commits, forge, knowledge, sidebar state, projects, live agents, quota view, task labels; quitting also waits for consoles the window closes.
- `QuitGuard` (`main/quit-guard.ts`):
  - the continuation (`app.quit()` or `window.close()`) always runs in a later macrotask, never inside the `close` / `before-quit` event it cancelled (Electron ignores `app.quit()` there);
  - a failed write settles its wait (it already reported itself) and logs `[quit] <stage>: <name> failed: …`;
  - every 5 s it logs `[quit] <stage>: waiting N s for <names>`;
  - 30 s after the first quit request, across all wait rounds, it logs `… gave up after N s waiting for <names>; quitting without them` and quits. "Keep editing" in the unsaved-changes dialog cancels the countdown.
- The unsaved-changes dialog stays: it waits for a person, not for a write.
- Hosts are disconnected, not stopped (see [Session host](#session-host)). On `will-quit` main releases the keep-awake assertion.

<a id="crash-recovery"></a>
## Crash recovery

A renderer error never leaves a blank window; agents and commands keep running in their hosts.

<a id="launch-snapshot"></a>
### Frozen build per app session

`scripts/start-desktop.mjs` without `--dev` copies `apps/desktop/out/` into `apps/desktop/.launch/<content hash>/` and runs `main/index.js` from there; main resolves `services`, `preload` and `renderer` relative to itself. The whole session, including hosts it started, reads one build, so rebuilding `out/` cannot break lazy chunks or mix protocol versions. The hash is exposed as `BRIGADIR_BUILD` and logged. A snapshot with the same hash is reused; old snapshots are deleted at start unless a live process has their path on its command line (hosts started from a snapshot outlive the window and keep launching `mcp-relay` from it). `--dev` (Vite dev server) and Playwright runs are unchanged. `--secondary` launches in the background on a secondary display without taking focus (`BRIGADIR_BACKGROUND`, `BRIGADIR_DISPLAY=secondary`).

<a id="error-boundaries"></a>
### Error boundaries

| Level | Wraps | On error |
| --- | --- | --- |
| Window | `App` in `main.tsx` | full-window screen on `--win` with a draggable strip under the window controls; centered 440 px column: `review-warning` glyph, title "Window error", text "Agents and commands keep running.", buttons **Reload the window** (primary) and **Copy details**, expandable **Error details** (mono, up to 220 px, scrolls) |
| Task window / project screen | `TaskView` / `ProjectScreen`, keyed by task | sidebar stays usable; resets when another task is selected |
| Columns and panels | chat, document surface, right panel, console, browser, simulator, board | only that area fails |

Below window level the failed area shows a centered block: `review-warning` glyph, a per-surface title ("Task window error", "Chat error", "Document error", "Panel error", "Console error", "Browser error", "Simulator error", "Board error") and buttons **Show again** (remounts the surface) and **Copy details**. Copy details puts time, route, message, stack and component stack on the clipboard; the label reads "Copied" for 1.5 s.

- **Missing chunk.** The renderer catches `vite:preloadError` and `lazy()` failures for a missing module and asks main to reload (`reloadWindow`). A `sessionStorage` mark allows at most one such reload per 30 s; if the chunk is still missing, the window-level screen explains "The application files changed. Restart Brigadir."
- **Log.** Every boundary hit and automatic reload appends a line to `~/.brigadir/logs/renderer.jsonl` (time, boundary level, message, stack, component stack, build hash) and to main's stderr. The file is trimmed to its last 200 lines once it passes 512 KB.
- **Renderer process gone.** On `render-process-gone` (except `clean-exit`) main reloads the window. A second loss within a minute shows a native dialog "Repeated Brigadir window crash" / "The window process stopped two times in one minute." with **Reload the window** and **Quit Brigadir**.
- `BRIGADIR_TEST_CRASH=<surface>` throws inside the named surface for tests.

<a id="dev-reload"></a>
### Reload after code changes in development

Only in dev (`import.meta.hot`): on `vite:beforeFullReload` the window saves surfaces and unsaved buffers into task drafts (the same hot exit as on quit) and reloads through main (`window:reload`); drafts return to the editor afterwards. If an unsaved buffer cannot be kept by hot exit (a main-tree file, over the draft limit, read-only), the window does not reload itself and shows a toast "The app code changed. Save your changes and reload the window." with **Reload the window**. The navigation ban stays, so built apps behave the same. Why: a long-lived dev window otherwise loads lazy modules from a newer copy while the rest runs old code, splitting state in two.

<a id="keep-awake"></a>
## Keep awake

The computer does not idle-sleep while agents work.

- **Who holds it:** a task with status `working` and a live host: a GUI turn, a foreman and each worker (separate tasks), a CLI task whose agent is in a turn. Not `needs-you`, `rate-limited`, `queued`, `preparing`, `done`, `interrupted`, `failed`. A `working` task whose host cannot be reached counts as `interrupted` (same reading as the sidebar, `sessions.workspace()`).
- **How:** main holds one `powerSaveBlocker.start('prevent-app-suspension')` while at least one such task exists, on every OS. On macOS this is the `PreventUserIdleSystemSleep` assertion under main's PID: the display still turns off; lid close, the Apple menu Sleep and low battery still sleep the machine. When no task qualifies the blocker is released after 30 s; new work within 30 s cancels the release, so gaps between turns do not toggle it.
- **Recompute** on status-changing events (`turn.*`, `permission.*`, `question.*`, `session.failed`, `host.stopped`, `rate-limit.*`, `crew.accepted`), on host disconnect and on a settings change, debounced 0.5 s; plus once a minute (hosts main has not attached to, crashed hosts). One recompute at a time; a request during one schedules one more.
- **Setting:** Settings ▸ Agents, row **Keep awake** with the switch "Keep the computer awake while agents work" (`agents.keepAwake`, default on; a `settings.json` without the key reads as on) and the caption "The display can turn off. Lid-close sleep follows system settings." Turning it off releases at once. While on and an agent works, the row shows "Working: {count}" (4 plural forms in `uk`). No indicator elsewhere.
- **IPC:** `keep-awake:changed` `{working, holding}`, `keep-awake:read`.
- **Exit:** released on `will-quit`; an agent running after the app quits does not hold the machine awake.
- `BRIGADIR_TEST_KEEP_AWAKE_RELEASE_MS` shortens the release delay in tests.

<a id="window-frame"></a>
## Window frame on Windows and Linux

There is one `BrowserWindow`; settings, intro, search and modals are dialogs and popovers inside it. `main/window-chrome.ts` picks the frame per platform.

| | macOS | Windows / Linux |
| --- | --- | --- |
| Frame | `titleBarStyle: 'hiddenInset'`, traffic lights at `{x: 14, y: 16}` | `titleBarStyle: 'hidden'` + `titleBarOverlay {color, symbolColor, height: 48}` in our 48 px top strip; minimize / maximize / close drawn by the OS (Windows) or Chromium (Linux) |
| Menu | system menu bar | Electron menu bar hidden; accelerators stay; **Application menu** button (☰) at the window's top-left opens the same app menu (`Menu.getApplicationMenu().popup`) under it |
| Keyboard | — | `F10` or a lone `Alt` press opens the menu, caught by main in `before-input-event` (any focus, not while recording a shortcut) |

- **Overlay colors** come from the renderer: after every theme or accent change it reads the strip background and `--fg` from computed tokens (symbol color blended to opaque hex) and sends `window:chrome-colors` → `setTitleBarOverlay`. Until the renderer loads, main uses `initialChromeColors` by `nativeTheme`.
- **Right inset.** Every strip under the OS buttons pads its right edge by `--os-controls-right = 100vw − (env(titlebar-area-x) + env(titlebar-area-width))`, fallback 138 px (3 × 46 on Windows), plus the strip's own 6 px. The browser and simulator columns, when last on the right, take the overlay height (48 px instead of 36) for their first strip.
- **☰ button:** square `--control-h-m`, `left: 10px`, centered in the strip, `--fg2`, hover `--fg`, open `--accent-soft` + `--accent`. On Windows and Linux the ☰ is the menu bar for the rule that every shortcut has a menu item.
- **Menus on Windows/Linux:** no "Brigadir" menu. File gains **Settings…** (`Ctrl+,`), **Templates…** and Quit (`Ctrl+Q`); a **Help** menu holds **Show the intro again…** and **About Brigadir**. Services, Hide and Show all exist only on macOS. Window has Minimize and Close (no key; `Ctrl+W` is File ▸ Close tab, the window closes with `Alt+F4`). Other menus match macOS.
- **Shortcuts on Windows/Linux** use one PC table (`core/keymap.ts`, `keymap-pc.test.ts`): `⌘` → `Ctrl`, `⌥` → `Alt`, `⇧` stays; `⌃` alone → `Ctrl`, or `Alt` if that Ctrl is taken; `⌃` next to `⌘` → `Alt`. `Ctrl+Alt+<printable>` is AltGr in many layouts, so it becomes `Ctrl+Shift+…`, or `Ctrl+Alt+Shift+…` if taken. Keys reserved by Windows, GNOME, KDE or IBus (`Alt+F4`, `Alt+Tab`, `Ctrl+Alt+T`, `Ctrl+Alt+L`, `Ctrl+Shift+U`, `Ctrl+Alt+arrows`, …) are never defaults and cannot be recorded; the Windows/Super key is never recorded. Where the direct reading is taken, Windows conventions apply (documents `Ctrl+PageDown/PageUp`, turns `Alt+PageDown/PageUp`, gutter changes `Alt+F5` / `Alt+Shift+F5`, back/forward `Alt+Left/Right`, browser DevTools `F12`, find next `F3`). The test checks all three key sets (Brigadir, VS Code, IntelliJ) on `win32` and `linux` for zero conflicts, no reserved key, no AltGr combination and no lost shortcut. Full shortcut list: [Search, shortcuts, menus and project commands](search-menus-and-commands.md).
- **One label source.** Every shortcut shown in UI (tooltip, `kbd`, context menu) comes from the active keymap for the platform (`commandShortcut`, renderer `ui/use-command-shortcut.ts`; context menus set `commandAccelerator`). Fixed gestures go through `formatAccelerator`; bare keys render as glyphs on macOS (`↩ ⇥ ⎋ ⌫`) and as names elsewhere (`Enter`, `Tab`, `Esc`, `Backspace`); translations naming a key by glyph pass `withPlatformKeys`. No literal `⌘ ⌥ ⌃ ⇧` in renderer text. Primary-modifier checks (⌘↩ in forms, ⌘+click) read Ctrl on PC through `renderer/ui/primary-key.ts`.
- **Linux desktops:** GNOME and KDE both get Chromium's caption buttons (not Breeze); button set and order follow GTK `gtk-decoration-layout`. On Wayland Chromium provides client-side shadows and resize; drag zones use `-webkit-app-region`; double-click on the strip maximizes. Glyph color follows `nativeTheme`, background is ours.
- **Dev preview on a Mac:** `BRIGADIR_CHROME_PLATFORM=win32|linux` (unpackaged only) switches the renderer to the PC layout (`data-platform` on `<html>`), the ☰, the File/Help menus and the PC key table, and hides the traffic lights; the overlay itself is not drawn on macOS, so a 138 px empty strip stands in for the OS buttons.

<a id="packaging"></a>
## Packaging and identity

Full builds only: macOS (DMG) and Linux (AppImage, `.deb`, `.rpm`). Each build is both a working machine and a remote-access device. Windows is a later full build; `dist.mjs --win` refuses with the list of blockers. The only client without a working machine is the phone web version.

<a id="build-layout"></a>
### Build layout

- `electron-vite build` emits `out/main`, `out/preload`, `out/renderer`; `scripts/build-services.mjs` emits `out/services` (host, workers, `node-pty`, LSP, native helpers, shell rc files, `scrcpy-server`). `out/main/index.js` bundles everything except `electron`, so the package needs no `node_modules`.
- Tool: `electron-builder` with `electron/packaging/electron-builder.config.mjs`, driven by `electron/scripts/dist.mjs`: `pnpm build`, a stage `dist/stage/app` (`out/main|preload|renderer` and a generated dependency-free `package.json`) and `dist/stage/services`, then package and verify.
- `app.asar` holds only UI and main. `services` ships through `extraResources` outside asar (`Contents/Resources/services`, Linux `resources/services`) because `zsh`, the agent CLI and `node-pty` run helpers by path and cannot read an archive. Main resolves it in one place, `main/services-dir.ts`: `process.resourcesPath/services` when packaged, `out/services` in dev.
- **PATH from a login shell.** Apps started from Finder get a short `PATH`; the packaged main sets `process.env.PATH` from `loginShellPath()` before starting services, and hosts, agents, git and `gh` inherit it.

<a id="macos-package"></a>
### macOS

- `pnpm dist:mac` (`--x64`, `--all`) builds `dist/Brigadir-<version>-arm64.dmg` and/or `-x64.dmg` (two per-arch DMGs, not universal). Helpers compile fat (`BRIGADIR_MAC_ARCHS=arm64,x86_64`) with `clang`, so both DMGs share one `services`; `node-pty` ships only its arch's prebuild. Electron comes from the `@electron/get` cache.
- Identity: `appId` `com.karaushu.brigadir`, `productName` `Brigadir`, icon compiled by `actool` from `resources/brigadir.icon` (Icon Composer) into `Assets.car` and `brigadir.icns`. `CFBundleVersion` is the commit count.
- Signing: always hardened runtime with entitlements `allow-jit`, `allow-unsigned-executable-memory`, `disable-library-validation`; no App Sandbox (so no Mac App Store); the `RunAsNode` fuse stays on because hosts need it.
  - no env: ad-hoc signature, no notarization, with a warning that Gatekeeper blocks the downloaded DMG on other Macs;
  - `CSC_LINK` (+ `CSC_KEY_PASSWORD`) or `CSC_NAME`: Developer ID Application;
  - plus `APPLE_API_KEY` + `APPLE_API_KEY_ID` + `APPLE_API_ISSUER`, or `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`, or `APPLE_KEYCHAIN_PROFILE`: notarization with stapling. Notarization without Developer ID is a script error.
- `pnpm dist:mac` also builds a zip per architecture for Squirrel.Mac in the same electron-builder run, so one `latest-mac.yml` lists both. `scripts/check-dist.mjs` mounts the DMG read-only and checks `Info.plist` (id, name, icon), `app-update.yml` (provider `github`, the `releases` repository), `app.asar` without `node_modules`, required services (`host.cjs`, `fonts`, `sim-helper`, `notification-auth.node`, `process-owner`, `mcp-relay`, `cli-relay`, `scrcpy-server`, LSP, shell rc, `node-pty` of its arch), each Mach-O's arch and signature, `codesign --verify --deep --strict`, hardened runtime on, no sandbox. `tests/packaged.spec.ts` runs with `BRIGADIR_PACKAGED_APP=<path to .app>`.
- **Local dev copy.** `pnpm start` / `pnpm dev` run a local `Brigadir.app` copy of the Electron runtime (`scripts/desktop-runtime.mjs`) with `CFBundleName`/`CFBundleDisplayName` `Brigadir`, id `com.karaushu.brigadir.dev` (so notification permission and Keychain entries never mix with releases) and the same icon; cached by Electron version and icon hash, outside git, ad-hoc signed after editing `Info.plist`. `node_modules/electron` is never modified.

<a id="linux-package"></a>
### Linux

- `pnpm dist:linux [--x64] [--arm64] [--skip-build]`: stage `dist/stage-linux-<arch>` with `services` for that arch; `electron-builder` (`linuxBuilderConfig`) makes AppImage and `.deb`, `scripts/rpm.mjs` (nfpm) makes `.rpm`. Package `brigadir`, executable `brigadir`, install dir `/opt/Brigadir`, icon `packaging/icons/icon.png`. `.deb` depends on `libsecret-1-0` and Electron's libraries and recommends `git`, `gnome-keyring | kwalletmanager`; `.rpm` depends on `libsecret` and recommends `git`, `gnome-keyring`. The release number is the commit count.
- Native modules are cross-compiled from a Mac (or Linux CI) with `zig cc` / `zig c++` for `x86_64-linux-gnu.2.28` and `aarch64-linux-gnu.2.28` (`scripts/linux-natives.mjs`): `process-owner`, `mcp-relay`, `cli-relay`, and `node-pty/prebuilds/linux-<arch>/pty.node` built from the `node-pty` source (N-API, static libc++, needs glibc ≥ 2.28). macOS-only files never enter the Linux package.
- `scripts/check-linux.mjs` (helpers in `scripts/package-files.mjs`): every ELF has the right arch, no Mach-O or macOS helper, required services present, `app.asar` without `node_modules`, `app-update.yml` of the releases repository and `latest-linux*.yml` of this version listing an AppImage; inspects `.deb`, `.rpm` and AppImage contents.
- **AppImage limit.** Hosts run from the AppImage's FUSE mount, so they stop when the app quits and tasks recover on next start as after a crash. Agents that keep working with no window need `.deb` or `.rpm`. A language restart (`settings:restart`) from an AppImage relaunches `$APPIMAGE`.
- CI: `.github/workflows/release-builds.yml` builds full Linux x64 + arm64 on `ubuntu-22.04` with zig and macOS on `macos-26`; a tag `v*` publishes to the releases repository ([auto-update](#auto-update), [docs/guides/releasing.md](../guides/releasing.md)).

<a id="linux-differences"></a>
### Linux platform differences

| Area | macOS | Linux |
| --- | --- | --- |
| Agent terminal shell | `/bin/zsh -l` | login shell: `$SHELL`, else the `passwd` entry (`os.userInfo().shell`), else `/bin/sh`; sh-like shells (`sh`, `bash`, `zsh`, `dash`, `ksh`, `mksh`, `yash`) run `-l -c 'exec "$@"' brigadir <cli> …`, fish `-l -c 'exec $argv' <cli> …`, others (nu, xonsh, tcsh, elvish) `/bin/sh -l`. Console and project commands use `$SHELL -l -c`. Shell integration (`ZDOTDIR`, `bashrc`, `fish.fish`) is the same |
| CLI hooks / statusline | `zsh -f hook.zsh`, `statusline.zsh` | `cli-relay hook` / `cli-relay statusline` (person's own statusline via `/bin/sh -c`) |
| Claude login check | Keychain (`/usr/bin/security`) | `.credentials.json` in `CLAUDE_CONFIG_DIR` or `~/.claude` (also Windows) |
| Brigadir's own secret (remote-access key) | `safeStorage` | `safeStorage` via libsecret (GNOME Keyring or KWallet); without it the gateway does not listen and Settings ▸ Remote shows "No secret service (GNOME Keyring or KWallet): …" |
| Sounds | `afplay`, system `.aiff` | freedesktop theme dirs (`/usr/share/sounds/freedesktop/stereo`, `/usr/local/share/…`, `~/.local/share/sounds`), `.oga/.ogg/.wav`; defaults map to `message-new-instant`, `complete`, `dialog-warning`; player: first of `pw-play`, `paplay`, `canberra-gtk-play -f`; failure: "The sound could not be played." |
| Fonts | CoreText helper `fonts` | `fc-list`: family, monospace (`spacing` 90/100), box-drawing (U+2500, U+2502, U+2514, U+2518, U+251C); no watching, new fonts after restart |
| Notification permission | native addon state | none: `notifications:permission` returns `unknown`; intro and Settings hide the permission row |
| Simulator | iOS (`xcrun simctl`) and Android | Android only (`toolchain.ios` false); SDK from `ANDROID_HOME`, `ANDROID_SDK_ROOT`, `~/Library/Android/sdk`, `~/Android/Sdk`; empty state "Android SDK not found" / "Install Android Studio to run Android simulators. iOS simulators need macOS." |
| Terminal dark mode (OSC 10/11 `system`) | system appearance | `gsettings get org.gnome.desktop.interface color-scheme` = `prefer-dark` |
| Background command processes | `lsof`, `ps` | `/proc/<pid>/fd`, `/proc/<pid>/stat` |
| Hidden agent browser window | parked window with opacity 0 | never-shown window; focus emulation keeps the page live |
| System accent | `getAccentColor()` | read inside `try`; empty result falls back to the app accent |

<a id="auto-update"></a>
### Auto-update

Brigadir updates itself from the GitHub Releases of its public repository, so the app needs no token; CI publishes with the workflow's `GITHUB_TOKEN`. The repository is named in one place: the `releases` field (`owner/repo`) of `apps/desktop/package.json`. electron-builder publishes to it (`publish` provider `github`, `packaging/electron-builder.config.mjs`) and writes `app-update.yml` into the package; the app reads the same field for release page links. The field holds the placeholder `OWNER/brigadir-releases` until the repository exists; publishing with the placeholder fails, and an app built with it never checks. Building and publishing: [docs/guides/releasing.md](../guides/releasing.md).

**How each build updates** (`updateSupport`, `main/app-updates.ts`):

| Build | Support | What happens |
| --- | --- | --- |
| Development (`pnpm dev`, `pnpm start`, not packaged) | off | never checks; the menu item is disabled; Settings say `This build does not check for updates.` |
| Packaged with the placeholder `releases` | off | the same |
| macOS signed with Developer ID | install | Squirrel.Mac (`MacUpdater`) installs the zip published next to the DMG; `latest-mac.yml` lists the zip of each architecture |
| macOS ad-hoc or otherwise not Developer ID (`codesign -dv` has no `Authority=Developer ID Application`) | notify | checks and announces the version with a link to its release page; Squirrel.Mac refuses an update to such an app |
| Linux AppImage (`$APPIMAGE` set) | install | `AppImageUpdater` replaces the AppImage; `latest-linux.yml` (x64) and `latest-linux-arm64.yml` |
| Linux `.deb` / `.rpm` | notify | checks `latest-linux*.yml` and announces the version with its release page; the person installs the package. `resources/package-type` is not trusted: the `.rpm` is built from the same unpacked folder as the `.deb` |

**Behavior** (`AppUpdates`, `main/app-updates.ts`; driver on electron-updater, `main/app-updater.ts`):

- Checks a minute after start, then every 6 hours, and on **Check for Updates…** — Brigadir ▸ after About Brigadir on macOS, Help on Windows and Linux. A check already going is joined; a version already downloaded is not checked again. Test builds with `BRIGADIR_DATA_DIR` schedule nothing.
- electron-updater never downloads or installs on its own (`autoDownload` and `autoInstallOnAppQuit` off). A newer version downloads in the background when the build installs and Settings ▸ Language ▸ `Updates` ▸ `Download in the background` (`updates.autoDownload`, default on) is on; a background download goes straight to `Downloading…` without an `available` state. With the switch off, checking still runs and the version is announced.
- **Toasts** (class T, `renderer/AppUpdates.tsx`, reusing `ui/Toast`, each also in the notification center):
  - downloaded: info `Brigadir {version} is ready` with `Restart to update`, once per version per window, again on a manual check;
  - found but not downloaded: info `Brigadir {version} is available` with `Download update` — downloads in the background where the build installs, opens the release page where it only notifies;
  - a manual check: success `Brigadir is up to date`, or error `Could not check for updates.` with `Retry`. Background checks show no toast; a failure turns the Settings line amber.
- **Settings ▸ Language ▸ `Updates`**, row `Brigadir`: the switch `Download in the background` (enabled only where the build installs), one button that follows the state — `Check now`, `Download update`, `Restart to update`, `Cancel restart` — and one line under them: `Version {version} · checked {time}`, `Checking…`, `Downloading {version}… {percent}%`, `Brigadir {version} is available`, `Brigadir {version} is ready`, amber `Could not check for updates.` / `Could not download the update.` / `Could not install the update.` with the time, or `This build does not check for updates.` Search Everywhere finds the switch.
- **Never while a turn runs.** A running turn is a task `working` or `needs-you`.
  - `Restart to update` with no turn running quits and starts the new version: on macOS Squirrel.Mac relaunches after it installs; an AppImage installs silently and the app relaunches from the installed file after the quit (`app.relaunch` in `will-quit`).
  - With turns running it waits: the toast and the Settings line say `Turns running: {count}. Brigadir restarts when they end.` with `Cancel restart`. Session events that may end a turn recount (debounced 500 ms); at zero the app restarts.
  - **Install on quit:** a downloaded update installs when the app quits and no turn runs. `QuitGuard` waits for the decision (`appUpdate`): on macOS Squirrel.Mac takes the update from electron-updater's local server (up to 20 s), and the quit installs it without reopening; an AppImage replaces its file. With turns running, or during a restart for the interface language, the update stays downloaded for the next quit or restart.
  - Errors outside a check or download (e.g. Squirrel.Mac refusing the signature) leave `Could not install the update.`; `Check now` downloads again.
- **Hosts of the old bundle.** Hosts outlive the app and run from files inside the old bundle. `host.cjs` is built with the app version (`BRIGADIR_APP_VERSION` from `apps/desktop/package.json`) and records it as `appVersion` in `host.json`. A packaged app that attaches to a host of another version, or without a version, sends `retire`. The host then stops with reason `update` at its first moment with nothing running — the idle blockers except `visible`: no turn or agent start, file save, open permission or question, queued prompt, background command, quota wait, live console, crew role; CLI (terminal-transport) tasks are never retired. The chat treats it like an idle stop: no `Agent is not running.`, and the next message starts a host of the new app and resumes the session (`session/load`). A host older than `retire` answers `Invalid command` and keeps running until it stops by itself. Development builds replace nothing.
- `BRIGADIR_UPDATE_URL` (packaged builds only) points the updater at a generic update server instead of the releases repository, for testing.
- Visible text is in the message catalog with Ukrainian; the count of running turns is a number after a colon, so it needs no plural forms.

<a id="version"></a>
### Version and About

- The version is `version` in `apps/desktop/package.json`, currently `1.0.0`. Every build handed to people gets a new semver version: any new feature → minor (`1.X+1.0`), fixes only → patch (`1.X.Y+1`), decided from `git log v<previous>..HEAD` (`feat` vs `fix`). Whoever builds packages bumps it in a `chore(release): X.Y.Z` commit on the main branch and tags `vX.Y.Z`; agents in branches never change it.
- About Brigadir shows the app version (`app.setAboutPanelOptions({ applicationVersion: app.getVersion() })`); the build number is `dev` in the dev copy and the commit count in packages.

<a id="performance"></a>
## Performance rules and limits

A tool that lags is not used, so these rules are contracts, not tuning. Each one changes a cross-process contract or visible behaviour.

<a id="perf-refresh"></a>
### Refresh on events, not on ticks

- The repo panel and lock readers (`ScopePanel`, `useScopeLocks`) reload only on records that can change repo rows, locks or `+N −M`: `session.started`, `session.failed`, `host.stopped`, `turn.started`, `turn.completed`, `checkpoint.created`, `scopes.changed`, `file.saved`, `crew.accepted`, and `null` (disconnect or task change). The list lives in `core/session.ts` (`affectsScopes`). Fallback timer: 30 s, only in a visible window. The terminal list reloads only on lifecycle and turn events.
- Starting and stopping tasks poll `status`, never the full journal; `CrewHost.await` waits for events instead of polling.
- Network state: local git state refreshes after turns; GitHub state (`gh`) is read on window focus, task selection, Retry, the Checks dialog and our own push/PR, never on every turn. A PR created inside the app shows at once.

<a id="perf-workers"></a>
### Worker pools

- Syntax and diff/reanchor run in persistent `worker_threads` pools: `view` 2 workers (diff, editor, review, queue 32), `code` 1 (code blocks in replies), `lookup` 1 (declarations), `diff` 2. Queues are bounded; a job keeps a 10 s deadline and a 256 MiB heap (past the deadline the worker is replaced); a crash fails only its job; workers exit after 30 s idle. One shared worker is avoided: a large diff would block the editor and chat.
- `changes:file` returns a diff without highlighting; the renderer asks `changes:syntax` (`readFileSyntax`) after showing it. Highlight cache: LRU of 16. `FileDiff` cache: LRU of 16 files and 32 MB. `DiffLine.spans` are numbers (token end × 2, +1 if changed), not copied text.
- While typing, editor highlighting shifts with the text until the new result arrives instead of disappearing.
- `files:check` (`checkEditorFile`) compares `stat` (including ctime/inode, not only mtime) and returns text only when the version changed; polling stops while the window is hidden.

<a id="perf-snapshots"></a>
### Snapshot cost

- An agent's file write, ⌘S and revert snapshot "before" and "after" only in the repo that holds the file; other repos' trees are copied from the previous checkpoint. Refresh, baseline, every 5 tool calls, and turn start and end snapshot every repo. A change in another repo, including a `scope.violation`, shows from the next full snapshot.
- Diffs between unchanged trees are cached by tree-SHA pair; `markAddressed` walks only new deltas.
- The first task index is a copy of the user's index without extensions plus `read-tree -m HEAD` (an unusual index takes the slow path). `--index-output` is never used: it takes the user's index lock.

<a id="perf-git"></a>
### Git in users' repos

- Every read-only git call in a user's repo runs with `GIT_OPTIONAL_LOCKS=0`, so `git status` never rewrites the user's index or takes `index.lock` while an agent works; unmerged paths come from `ls-files -u`.
- The repo watcher reruns discovery only when a `.git` appears or disappears, `.gitmodules` changes, or a new folder is a known repo or its ancestor; a HEAD change rescans only that repo. History does not reload separately on `checkpoint.created`. A relay runs one `git diff` per repo.
- `gh` responses are cached per repo: metadata 10 min, auth `ready` 5 min, PR and checks 20 s. `forge:read` takes a third argument `fresh`; focus, Retry, the Checks dialog and our own push/PR read fresh, switching tasks uses the cache. At most 4 `gh` and 6 git processes run at once. A default-branch change on GitHub shows within 10 minutes.

<a id="perf-limits"></a>
### Limits for pathological input

| Limit | Value | Behaviour |
| --- | --- | --- |
| Diffable text | ≤ 100,000 lines and ≤ 20,000 chars per line per side | otherwise `tooLarge`, no hunks |
| Diff algorithm | patience anchors, LCS table when it fits, bounded Myers (10M steps per file) otherwise | ordinary code gets the same diff; no histogram diff |
| Highlighting | 5 MiB per file (`syntaxLimit`), 2 s parse + 2 s walk, 150,000 tokens, 20,000 chars per line | "Syntax highlighting limit reached." / "Syntax highlighting is unavailable." |
| Editor file | 8 MiB (`editorByteLimit`) | "{file} is too large for the editor."; binaries refuse separately |
| Inactive editor buffers | LRU of 12 buffers or 16M chars per task | clean inactive buffers are evicted; the tab stays and rereads the file on activation at the same line and column; never evicted: active, dirty, saving, conflicted, with a comment draft or with undo history |
| Commit and History tab diffs | LRU of 4, outside the store | if main forgot the revision: "The file could not be read." |
| `@` file list | cached 5 s per repo | a new file appears in `@` within 5 s |
| JSON-RPC frame | 32 MiB | |
| JSON document read | 1 MiB | `invalid_document` |

"Too large" is always a different message from "binary": they are different facts. Large files open read-friendly rather than being refused, and buffers are never cut (a cut buffer would save a truncated file).

<a id="perf-agent-responses"></a>
### Bounded responses to agents

| Tool | Bound |
| --- | --- |
| `browser_console`, `browser_network` | newest 100 entries within 32 KiB of text; a cached but unmounted page view publishes no state, `mount` sends the full state |
| `propose_plan` | full `parts` only when the person edited them, otherwise `{edited: false, parts: [{title, agent}]}` |
| `read_notes` | ≤ 64 KiB per page |
| `read_transcript` | lines ≤ 2000 chars, page ≤ 64 KiB, `omitted` field |
| `read_diff` | without `path`: up to 200 changed files and `more`; with `path`: unified diff with 3 context lines and line numbers in `@@` headers, ≤ 64 KiB (`truncated`); `full: true` returns before and after texts, each ≤ 64 KiB |

Crew worker launches run outside `CrewHost`'s serial queue, at most two at once, each taking a slot; a stop interrupts setup and the worker stays queued for the next foreman start. A worker sends its parent only `session.started`, `session.failed`, `turn.completed` and `host.stopped`; the foreman watches an unaccepted worker's `host.json` until it can connect. See [Crew](crew.md).

<a id="later"></a>
## Later

- Windows full build: named pipes instead of `.sock`, ConPTY, PowerShell integration, `.ico`/PNG icon set, Windows `AppUserModelID`, NSIS target (config already present).
- Menu mnemonics (`&` on top-level menus) on Windows/Linux, checked with the first Windows build.
- Primary-key handling for simulator keys and ⌥⌘[ / ⌥⌘] in the conversation on PC.
- Verification of the frame on real Windows builds and on GNOME/KDE (button layout, Wayland/X11), and of a full Linux install on Fedora.
- Font watching on Linux; Linux package signing.
- Installing `.deb` and `.rpm` updates through the package manager (electron-updater's `DebUpdater` / `RpmUpdater`); today they only announce a version.
- asar integrity fuse together with Developer ID signing.
- Simulator empty state and Linux frame verified against design references in a full Linux build.

<a id="non-goals"></a>
## Non-goals

- Any WebView hybrid with a native shell, Tauri, or a Rust-native UI.
- A daemon singleton for all sessions, XPC-style service registration, or agents as direct children of the app.
- An in-process host mode: the host always runs as its own process.
- A timeout that auto-answers permissions or questions.
- Killing hosts on app quit, on parent PID loss or on a stale PID file.
- Silent journal truncation or rewriting files of unknown schema; importing or migrating data of the archived native version.
- A client-only build role; Windows client packages.
- Mac App Store (needs App Sandbox, which the app does not use).
- Universal (fat Electron) DMG; `asarUnpack` or `asar: false` for services.
- Renaming the `refs/brigadir-v2/` ref namespace or the app id.
- Monaco, Tailwind, shadcn or third-party design systems.
