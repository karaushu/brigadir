# Overview

Brigadir (Ukrainian: Бригадир) is a cross-platform Electron app for orchestrating coding agents. It keeps projects and tasks in a sidebar, shows each agent's conversation as an activity view, and has a Git diff panel built for reviewing work through comments, across a monorepo made of several git roots. Its core job is accepting work, not doing it: a foreman orchestrates, and reviewing what was done is what the product is built around.

<a id="identity"></a>
## Product identity

| Item | Value |
| --- | --- |
| Visible name | **Brigadir** (`en`), **Бригадир** (`uk`) |
| Product name / executable | `Brigadir` / `brigadir` (`packaging/electron-builder.config.mjs`) |
| App id | `com.karaushu.brigadir` |
| Data folder | `~/.brigadir/`. The app moves a legacy `~/.brigadir-v2/` there on start. See [Data layout](architecture-and-platform.md) |
| Task worktrees | `~/.brigadir/worktrees/<projectId>/<taskId>`, outside the repository, so `git status` stays clean |
| Snapshot refs | `refs/brigadir-v2/tip/<projectId>/<taskId>/<scopeId>` (one tip per task and repo). Per-checkpoint `refs/brigadir-v2/snap/<projectId>/<taskId>/<scopeId>/<n>` stay only where a commit would otherwise become unreachable (`packages/git/src/snapshot-refs.ts`) |

- One stable technical identifier, two localized visible names. The Latin spelling is `Brigadir`, not the official transliteration `Bryhadyr`.
- **Why the name:** a foreman doesn't do the work himself. He accepts it. Orchestration is common to every tool of this kind, so review of finished work is the core.

<a id="reference-case"></a>
## Reference case

Every feature is checked against a real monorepo with **five independent git roots** that are linked in three different ways:

| Path | Kind | Notes |
| --- | --- | --- |
| `.` | root repo | tracked |
| `kit/` | submodule (gitlink) | own remote |
| `skills/` | submodule | own remote |
| `apps/admin/` | **separate repo, gitignored by the parent** | own branch. Invisible to the parent git, as neither a gitlink nor an untracked path |
| `apps/demo/` | plain folder | tracked by the parent |
| (worktree) | linked worktree | of the root |

The workspace file covers `kit` and `apps/*`, so one logical task can touch three repositories at once. **A feature is done only when it works on this kind of repo.** Scope rules are in [Projects and scope](projects-and-board.md).

<a id="mvp-scope"></a>
## Core scope

The core is the chain that justifies the product's existence. All of these links ship:

1. A scope model for monorepos: a project is a set of git roots ([Projects](projects-and-board.md)).
2. A snapshot diff per scope, built from git trees, not from `git diff HEAD` ([Diff and review](diff-and-review.md)).
3. Comments and the review loop ([Diff and review](diff-and-review.md)).
4. One row engine that serves both the diff and the activity view ([Chat](chat.md)).
5. ACP transport and the activity view ([Agents and providers](agents-and-providers.md), [Tasks](tasks.md)).
6. An editor for small edits ([Editor](editor.md)).
7. Several agents working in parallel, with notifications and the `needs-you` queue ([Tasks](tasks.md), [Notifications](notifications-slack-notes-and-schedules.md)).
8. `en` and `uk` i18n, built in from the start instead of retrofitted ([Appearance](appearance.md)).
9. Settings: theme, and fonts per surface ([Appearance](appearance.md), [Settings](settings-modules-and-onboarding.md)).

These grew out of that core and also ship: first-run intro, signed and notarized DMG, turn rail, project commands, LSP and autocomplete, Files tree, CI runs, crews with agents that review agents, browser and simulator MCP tools, and remote and phone access.

<a id="principles"></a>
### Cross-cutting principles

| Principle | Rule |
| --- | --- |
| **Providers are exactly what ACP gives** | The app keeps no registry of agent knowledge: no manifests, per-provider hooks or resume recipes. A supported provider is one that has an ACP adapter. Capabilities come from `initialize` negotiation, not from a table of ours. |
| **Process per session** | A host process owns the agent, and the app window only attaches to it. This seam is expensive to retrofit, so it exists everywhere ([Architecture](architecture-and-platform.md)). |
| **The window is not the terminal** | The host writes every byte of output to disk. Scrollback is restored by replaying the full log, not a ring buffer. |
| **Managed vs observed: no guessing** | Watching a process is not enough to synthesize a resume recipe, to trust an old hook event for a new agent, or to install provider config after start. Observation can't recover shell quoting, env, aliases, wrappers or launch flags. |
| **Session id is minted at launch** | `--session-id <uuid>` is passed at start, so providers resume exactly. Providers that can't take it are known only once their hooks report an id. |
| **Spec before code** | When the implementation diverges from the spec, the spec is corrected first, then the code. Sections are never deleted. They move to Later or Non-goals with a reason. |

<a id="vocabulary"></a>
### Vocabulary

This is a vocabulary only, not a component. "Agent runtime" means "what the ACP adapter knows".

| Term | Meaning |
| --- | --- |
| **Preset** | A saved command the person owns, e.g. `claude`, `claude --model opus`, a script. A preset is not a "supported agent". |
| **Agent runtime** | Knowledge about an agent: recognition, hooks, MCP, resume, transcripts, allowed actions |
| **Managed launch** | A session whose runtime is known **before** the process starts |
| **Active observation** | A recognized process occupying a terminal now. It may differ from what was launched. |
| **Conversation** | A provider's durable conversation with its own id. It outlives a session (`Session ≠ Conversation`). |

<a id="unpeel"></a>
### Ideas adopted from Unpeel

These ideas come from Unpeel, a terminal-first session manager with no diffs, no monorepo model and no ACP.

- **Full output log on disk** and the attach-only window (above).
- **Minted session ids** (above).
- **Auto titles from the first prompt.** The sidebar reads as a task list, not a list of shells. A manual title always beats the auto title ([Tasks](tasks.md)).
- **`busy / done / needs-you` as visible states.** The UI says `needs-you`, and the model keeps the exact state, e.g. awaiting permission ([Sidebar](sidebar.md)).
- **Worktrees outside the repo** under the data folder, shown under their task ([Tasks](tasks.md)).

<a id="ui-conventions"></a>
## Settled UI conventions

These choices are fixed, and each has a reason that still guides changes:

| Question | Rule | Why |
| --- | --- | --- |
| Ukrainian word for a layout column | **«стовпець»** in visible text and in prose, never «колонка» | The glossary forbids synonyms |
| Minimum width of the side panel | **320 px** in every layout | It is the same panel. A smaller minimum would make one layout cramped. |
| Name of a review note | **`Add a comment`** (`Додати коментар`) | The object is a comment in the glossary, in threads and in the `<review_comment>` tag |
| Editor action that selects the enclosing block | **`Select a declaration`** (`Виділити оголошення`), not "function" | CSS has no functions. "Declaration" also covers CSS rules. |
| Anchor of a comment made from the editor | The current content, side `new`, `blob_sha` from the working tree | It mirrors diff anchors, which hold the `blob_sha` of their side |
| Captions under settings rows | **None**, except descriptions under radio buttons | A radio description tells two options apart, so it is part of the control ([Settings](settings-modules-and-onboarding.md)) |

<a id="open-questions"></a>
## Open questions

- Does a second diff need to be visible at once now that editor split groups exist? The current answer is no ([Editor](editor.md)).
- Does ACP's `initialize` return an agent icon? If so, the agent slot should use it instead of the bundled glyph.
- How should `needs-you` look on each surface? On a sidebar card it is an amber **fill**. On a project-board card it is an amber **border** over a warm fill, and in the board's list view an amber border plus `--amber-soft`. The sidebar and the project screen should share one vocabulary, but here the two surfaces still differ ([Sidebar](sidebar.md), [Project board](projects-and-board.md)).

<a id="empirical-checks"></a>
## Empirical checks

<a id="empirical-open"></a>
### Still to verify

- What `_session/goal` (`actions: set/clear`) does. Is it a persistent session goal? Brigadir doesn't use it.
- Whether the ACP adapter's session id maps to a resumable id of the native CLI.
- How far the adapter lags behind the native CLI in features, on the reference monorepo.
- Whether hooks and plugins pass through the Agent SDK.
- Whether `agentFileChangeReport` is accurate. The adapter announces it on opt-in, but in a run where the agent created a file it sent no report. No such channel exists in practice, so attribution stays on snapshots.
- Snapshot time on the reference monorepo with a reused index versus an empty one.
- A `needsYou(question)` heuristic in `auto` mode. `request_permission` doesn't arrive, and the protocol has no "agent asked a question" signal.

<a id="empirical-settled"></a>
### Verified facts

| Question | Finding |
| --- | --- |
| `_meta.steering.supported` | `_session/steering` embeds the prompt into the running turn ([Steering](composer-steering-queue-and-ghost.md)) |
| Effort as a `configOption` | Yes: `default/low/medium/high/xhigh/max`, plus `fast` |
| `availableModes` | One axis, six modes, default `auto` |
| `embeddedContext`, `image` | Both announced |
| Usage and context fields | `usage_update {used,size}` in `session/update`, plus per-turn `usage` |
| Rate limit and reset time | Not in `sessionFailure`. It comes in `usage_update._meta["_claude/rateLimit"]` ([Agents and providers](agents-and-providers.md)) |
| Scopes via `additionalDirectories` | Works. The agent reads a gitignored separate repo, which the parent git doesn't see, through this channel. |
| Per-scope worktree assembly | A submodule worktree inside the root worktree, plus the gitignored repo at the same path layout, works. The root worktree must be created first. |

<a id="acceptance-audits"></a>
## Acceptance audits

<a id="sequential-acceptance"></a>
### Sequential feature acceptance

- Repeat acceptance runs one feature at a time and is recorded in `electron/docs/e2-feature-pass.md`. Old green tests and old screenshots are inputs, not proof of a fresh visual check. Each pass covers states and real interactions in both themes, not only that a surface opens.
- Static screenshots finish their finite transitions first. A separate motion test keeps normal motion and the intermediate states.
- Fixes this audit locked in (they remain invariants):
  - Composer focus works offline, because drafting needs no host. Long attachment names in the preview wrap instead of pushing out Close.
  - Review popup header is 40 px (8 px vertical padding), with an accent icon. Long file names don't push out actions. The Why popover moves focus into Close, and Close or Escape returns it to the trigger. An outside click doesn't take focus from the new target.
  - Files and editor: an empty search has a loading state and a no-results state. Disclosure buttons stay within the 20 px row. Disk/buffer comparison and bracket-error marks use `diffAddedBg` / `diffRemovedBg`. Show diff changes neither the disk nor the buffer.
  - Browser: mouse selection goes through Chromium `WebContents` input, with no synthetic overlay result. A click on the native picker on a secondary display produces an attachment. Request-detail headers use a 12 px gap and an 8 px bottom inset.
  - Console: Close sits on each terminal tab and New sits beside the tabs. After a process exits, its xterm is read-only and stops sending PTY resize requests, so resizing an exited terminal raises no false failure.
  - Search: a pending file search can't deadlock Agents loading, and late file results can't hide agent results. The field is 14 px with one shared focus frame, basename/path columns and fuzzy-match emphasis.
  - Question card: **Skip** sends `answerQuestion` with `answer: null`. IPC validates it, and it is stored as "no answer". It never picks an option or makes up an answer. The MCP caller gets an explicit no-answer error and may continue its turn. Duplicate answers are rejected ([Questions](chat-turns-plans-and-questions.md)).

<a id="states-and-platforms"></a>
### States and platforms

No surface may stay silent, show something false, or leave the person without a way out.

| # | Surface | Behaviour |
| --- | --- | --- |
| 1 | `Add folder…` in the **New task** sheet | A failure isn't swallowed. A toast would sit under the modal sheet, so an inline line `Could not add the folder.` (`--red`, 11 px) appears under the `Repos and folders` chips. The next attempt or closing the sheet clears it. Inside a task, the Repos panel uses a toast with `Try again` ([Tasks](tasks.md)). |
| 2 | Agent status rows | Only the states that have data: `Looking…`, `Not found on this Mac` with `How to install` and the command, sign-in needed or expired, `Waiting for the sign-in in the browser…` with `Cancel`, via `npx`, and ready with its version. `AgentCheck` has no "installing" or "outdated" state. CLI freshness lives in the CLI updates row ([Agents and providers](agents-and-providers.md)). |
| 3 | Environment check that threw (IPC or main) | It never searches forever. Intro: subtitle `Could not check the agents.`, each agent row `Not checked` with an amber mark, switches disabled, and under the list `Check again. You can also set up the agents later in Settings ▸ Agents.` with `Check`. **Next** is disabled because no agent is confirmed, and **Skip** goes to the end of the intro. Settings ▸ Agents shows `Not checked` in amber with `Check`. |
| 4 | Intro sign-in | It follows sign-in the way Settings does. After `Sign in…` the row shows `Waiting for the sign-in in the browser…` and `Cancel`. Cancelling or finishing sign-in restores the row and re-reads the agents ([Onboarding](settings-modules-and-onboarding.md)). |
| 5 | Simulator with no devices | Simulator glyph, `No simulators`, and a sentence that depends on the machine's tools: `Create a simulator in Xcode or Android Studio, then check again.` (both SDKs), `Create a simulator in Xcode, then check again.` (Xcode only), `Create a virtual device in Android Studio, then check again.` (Android SDK only). `Check` re-reads devices. The device picker lists iOS first, then Android, with `iOS` / `Android` group headers only when both platforms are present ([Simulator](browser-and-simulator.md)). |
| 6 | Modified/deleted merge conflict | Shown as a conflict, not as resolved. `ConflictFile.deleted` is `ours` \| `theirs` \| `both`, read from index stages (`git ls-files -u`): no stage 2 means our branch deleted it, no stage 3 means theirs did. The row has an amber ●, `deleted in {branch}` / `deleted on both sides`, and `Keep the file` (the side that changed it: `checkout --ours\|--theirs` + `add`) or `Delete the file` (`git rm`). Such a file has no `Both` option. `Mark resolved` on a file missing from disk runs `git rm`. The file is never handed to the agent, because it has no marker places. The same actions appear in the `Conflicts` dialog row ([Git](git.md)). |
| 7 | Connect: "not responding" | `Try again` repeats the last attempt with the same password. The password field remounts empty after a failure, so the dialog keeps the password of the unanswered attempt in memory while it is open, and never on disk. If there is nothing to repeat (the failure came from pairing), the password field returns ([Remote access](remote-access-and-mobile.md)). |
| 8 | Browser **…** in a remote machine's window, for a page on that machine's localhost | DevTools and open-in-default-browser aren't available there, so the **…** button is hidden instead of opening an empty menu. |
| 9a | `Open System Settings` (notifications) | macOS only, because main can open the notification pane only there. Linux and Windows show the button neither in notification settings nor in the toast. |
| 9b | **Keep awake** | All OSes. Main holds `powerSaveBlocker.start('prevent-app-suspension')` with no platform check (IOKit on macOS, `SetThreadExecutionState` on Windows, D-Bus inhibit on Linux). The row text is platform-neutral ([Architecture](architecture-and-platform.md)). |
| 9c | Intro on Windows and Linux | **Skip** on the first step sits left of the OS window buttons (`--os-controls-right` + 6). Step cards near the top-right start below the 48 px strip. |

Tests: vitest `merge-flow.test.ts`, `simulator-picker.test.ts`. E2E: `intro-states.spec.ts`, `simulator.spec.ts`, `git-history.spec.ts`, `remote-access.spec.ts`, `remote-access-r4.spec.ts`, `task-add-folder.spec.ts`.

<a id="later"></a>
## Later

- Transcript export with content switches (user / assistant / reasoning / tool calls and results / file changes and diffs / plan) and a range (last 20/50/100 or the whole chat). It has the same options as the agent's MCP `read_transcript`, so what the person copies and what the agent reads match.
- One prompt sent to two providers in parallel in two worktrees, with two diffs side by side.
- A separate OS window per task, e.g. for a second monitor.

<a id="non-goals"></a>
## Non-goals

- **App Store distribution.** It requires App Sandbox, and a sandboxed app would pass the sandbox to child agent processes and lose Keychain and folder access.
- **A provider knowledge registry.** No manifests, per-provider hooks or resume recipes. Capabilities come from ACP.
- **Terminal-first as the main paradigm.** The app is ACP-first. A provider's own CLI TUI can still run in a terminal ([Terminal and CLI agents](terminal-and-cli-agents.md)), but the app doesn't chase CLI/TUI parity.
- **Cloud sync** of app state.
- **Automatic merge** without a person.
