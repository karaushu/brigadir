# Terminal, console and agents in the CLI

Every task has a console: real login shells in PTYs, shown as terminal tabs of the task's work area. The console exists to hand command output to the agent in one move. A task can also run its agent's own CLI TUI (Claude Code or Codex) in a PTY in place of the chat (the CLI transport). Hooks, MCP and the shared diff engine keep that mode inside the app's model of turns, diff and review.

<a id="roles"></a>
## Terminal roles

| Role | Where | Process | Lifetime owner |
| --- | --- | --- | --- |
| Inline tool output | Chat tool row (`ToolTerminal`) | none: static xterm render of the finished tool output | the chat row ([Chat](chat.md)) |
| Console (`role: 'console'`) | Terminal tabs of the work area ([Workspace](task-window-workspace.md)) | the person's login shell, or a project command | task's session host |
| CLI agent (`role: 'agent'`) | The chat column of a CLI task | `claude` / `codex` TUI | task's session host |

- ACP adapters run commands themselves and return the result in a tool call. They never use the person's console. Under ACP a command's output arrives in one final `tool_call_update` with no streaming, so the chat can only show "running", the description and elapsed time. To watch a long build live, run it in the console or use the CLI transport.
- An agent never gets the person's shell, its history or its input. In CLI mode the agent runs in its own PTY. The console stays the person's.
- The console belongs to a task. With no task open there is no console, because a shell without a task has no defined `cwd`.

<a id="pty-host"></a>
## PTYs in the session host

- Each PTY (`node-pty`) lives in the task's session host and is mirrored by a DOM-free `@xterm/headless` terminal with `SerializeAddon`. Opening the console can start the host without starting ACP. Opening a console never starts the agent.
- The renderer mounts only the visible xterm (WebGL addon, with a fallback to the default renderer when the context is lost) and disposes it when it switches tasks. On reattach, `read` returns a serialized snapshot of the terminal state, never a raw tail of escape sequences.
- **IPC.** Terminal commands (`TerminalCommand`: `list`, `create`, `run`, `stop`, `read`, `unwatch`, `close`, `close-consoles`, `clear`, `text`, `input`, `resize`) are accepted only from the UI role of the authenticated host socket, never from MCP. The renderer sends a session id, input and sizes. The host decides the `cwd` and the shell. Limits: input ≤ 65 536 chars per command; `resize` cols 2–500, rows 1–200; a `create` directory is relative, with no `..`, `.git` or `.brigadir` segment.
- **Limits.** 8 terminals per task (consoles plus the agent). 5000 lines of scrollback in both the host and the renderer. Output larger than 1 MiB that waits for the parser pauses the child PTY until the parser catches up. Events carry slices of at most 32 768 UTF-16 units and never split a surrogate pair.
- **Watching.** Output events go only to terminals that a client has `read` and not yet `unwatch`ed. Exits, command blocks and run states always go. Main counts watchers per client, so one client's `unwatch` does not stop output that another still shows (see [remote terminal](remote-access-and-mobile.md)). Main releases a window's watches only when a navigation really replaces the document: a reload of the same URL (ignoring `#…`), a crash or a close. Navigations that `will-navigate` cancels keep the watches, so the console keeps echoing after a stray link click or a dropped file.
- **Frozen exit.** 60 s after a process exits, the host keeps only strings: the serialized buffer, the visible screen, the turn anchors and (for consoles) a plain tail of 400 lines. The headless terminal is then disposed. `read`, `text`, `clear` and `console_read` answer from these strings.
- **Never on disk.** Scrollback is never persisted and journals never contain it: it can hold `env` output, tokens in command lines and cloud credentials. After a restart a terminal is empty. Only the tab layout is restored (see [Workspace](task-window-workspace.md)).

<a id="environment"></a>
## Environment and shells

| | Console | CLI agent |
| --- | --- | --- |
| Program | `loginShell()`: `$SHELL`, else the passwd shell, else `/bin/zsh` (macOS) or `/bin/sh` (elsewhere); only an absolute, executable path counts | macOS: `/bin/zsh -l -c 'exec "$@"' brigadir <cli> …`. Elsewhere the login shell runs it the same way (`fish`: `exec $argv`); a non-POSIX shell is replaced by `/bin/sh -l` |
| `cwd` | the task's scope root (its worktree when isolated), or a folder inside it | the task's scope root |
| Integration | shell integration (below) | hook and MCP env (below) |

- Both start from the app's environment without `BRIGADIR_*`, `ELECTRON_RUN_AS_NODE`, `NO_COLOR` and `FORCE_COLOR`. They then set `TERM=xterm-256color`, `COLORTERM=truecolor`, `TERM_PROGRAM=Brigadir` and `TERM_PROGRAM_VERSION`. The launcher's colour flags never make a CLI monochrome. The person's shell profile and the CLI's own settings still apply, and ANSI colours survive in live output and in snapshots.
- The console never sees the agent's tokens (`BRIGADIR_*`). The agent gets only its own hook and MCP variables, on top of what the login shell exports.
- The app runs without App Sandbox: a sandboxed child would lose folder and Keychain access.
- The person's commands and the agent write to the same tree. A `pnpm install` run in the console shows up in the task's diff, because the diff is a tree snapshot, not attribution ([Diff](diff-and-review.md)). Changes are not filtered by who made them.

<a id="console"></a>
## Console sessions

<a id="console-tabs"></a>
### Tabs and lifecycle

- Each session is a tab of the work area, named after the deepest repo that holds its `cwd` (the root repo shows the project name), otherwise after the shell binary. A project command tab is named after the command ([Project commands](search-menus-and-commands.md)).
- **New terminal** (`⌃⇧\``) opens a session in the task root. **Open terminal here** in the file tree opens one in that folder.
- A session lives as long as the host. Switching tasks or hiding the work area does not stop it. A build keeps running and its output is there when the person comes back.
- Closing a tab sends `SIGHUP`. If a command runs in the foreground (the tty's foreground process is not the shell itself), closing asks **Stop this terminal process?** first. Closing a task or project, and quitting the app, closes every console. A host left with no agent then stops, so no orphaned `pnpm dev` keeps a port. Closing rules: [Workspace](task-window-workspace.md).
- Live consoles keep an idle host alive.
- The tab label and its × form one control: the corners at the seam are square, the outer corners are rounded, and × reaches the tab's right edge with its own 24 × 24 hover target.

<a id="shell-integration"></a>
### Shell integration

Static scripts in the app bundle (`packages/host/resources/shell`) add markers. The person's config files are never modified.

| Shell | Injection |
| --- | --- |
| zsh | `ZDOTDIR` points to the bundled wrapper, which restores the person's `ZDOTDIR`, sources their `.zshrc` and adds `preexec` / `precmd` hooks |
| bash | `-l -c 'exec "$1" --rcfile <bundled bashrc> -i'` |
| fish | `-l -C 'source <bundled fish.fish>'` |
| other | plain `-l`; no markers |

- Before each command the shell emits `OSC 777;brigadir;<base64(command NUL cwd)>` and `OSC 133;C`. After it, the shell emits `OSC 133;D;<exit>` and `OSC 133;A`. The headless parser reads these markers. A marker is untrusted display metadata: it cannot trigger IPC or write to the journal. Command text is capped at 8000 chars.
- Each command becomes an in-memory `TerminalBlock` with `command`, `cwd` (relative to the project), `startedAt`, `duration`, `exitCode` and `output`. The output is read from the parsed buffer between the markers. If the start of the output has left the scrollback, the block says so.
- **Bounded output** (`boundedOutput`): more than 400 lines keeps the first 100 lines, then `[… N lines omitted …]`, then the last 300. More than 16 KiB keeps the first 4000 bytes, then `[… output omitted …]`, then the last 12 000. The tail matters most, because the error is at the end.
- **Without markers** the session still works. The tab is named after its scope, there is no failure strip, and **Show the agent** takes the selection or the visible screen.

<a id="show-the-agent"></a>
### Show the agent

- Available from the context menu, the failure strip and **Console ▸ Show the agent** (`⌥⌘Y`, enabled when the focused console has output). It attaches a text attachment named `Terminal output` (`Terminal output (<tab>):\n…`) to the composer in GUI tasks, or to the CLI shelf in CLI tasks. Focus does not move.
- Content, in order of preference: the selection; else the last finished command block (`command`, `cwd:`, `exit: <code> · <ms> ms`, output); else the visible screen (≤ 16 384 chars). The text is plain, with no ANSI. Command output does not exist on disk, so it is sent as a snapshot, never as a file reference.
- **Failure strip.** When a command exits with a code other than 0 or 130 (Ctrl-C), a strip `Exit <code> · <command>` with **Show the agent** and × appears under the grid. It stays until the next command or until dismissed. Nothing is ever sent automatically: the agent may be mid-turn. A failed project command tab shows the same strip with **Restart** / **Run again** added.

<a id="console-keys"></a>
### Keys and menu-bar items

| Item | Key | Enabled |
| --- | --- | --- |
| View ▸ Terminal | `⌘⇧Y` | task open; goes to the last terminal tab or opens one |
| Console ▸ New terminal | `⌃⇧\`` | task open |
| Console ▸ Clear terminal | `⌘K` | console focused |
| Console ▸ Next / Previous terminal | `⌃⇥` / `⌃⇧⇥` | console focused, several tabs |
| Console ▸ Show the agent | `⌥⌘Y` | console focused, has output |
| View ▸ Stop | `⌘.` | in a focused console: Ctrl-C to the session |

<a id="console-selection"></a>
### Selection and clipboard

- `⌘C` copies the xterm selection (`copyText`). `⌘A` selects all. `⌘V` uses the textarea's `paste` event, with bracketed paste. On other platforms these are `Ctrl+Shift+C` / `Ctrl+Shift+A`, because `Ctrl+C` stays the shell's interrupt. The selection is mirrored into xterm's helper textarea, so **Edit ▸ Copy** works too.
- Selection colour is `--accent-soft`, resolved by the page to an opaque-parseable `rgba()` (`terminal-color.ts`). xterm drops non-opaque canvas-parsed colours and would otherwise fall back to an invisible white. It is recomputed when the theme or accent changes. The same applies to the CLI terminal and the inline tool output.
- When a program captures the mouse (a fullscreen TUI, `vim`, `htop`), a plain click and drag go to the program. `⌥`+drag (`macOptionClickForcesSelection`; `Shift` on other platforms) selects text anyway. Right-click never selects a word (`rightClickSelectsWord: false`). A right-click outside the selection clears it; one inside keeps it.

<a id="console-links"></a>
### Links and ⌘+click

- A plain click always belongs to the terminal. Only `⌘`+click (Ctrl+click on other platforms) opens a link. While `⌘` is held and the pointer moves, the link under it is underlined in `--accent`, the cursor becomes a hand, and a tip shows `⌘+click opens the link` or, for a file, `⌘+click opens in editor`.
- **Detected text links** (own provider, no `@xterm/addon-web-links`): `http(s)` and `mailto` URLs that `externalLink` allows. Trailing punctuation and unbalanced brackets are trimmed, and a URL wrapped across screen rows is matched whole. `path[:line[:col]]` candidates come from `filePathCandidates`. Main confirms that each path exists in the task's roots, so a path that does not exist is not clickable. A file opens in the editor at that line. A folder shows it in Files.
- **OSC 8 links** emitted by a CLI go through the same routing. xterm's default `confirm()` + `window.open` is replaced.
- **Routing** (`openTaskLink`, shared with the chat): `localhost`, `127.0.0.1`, `[::1]` and `*.localhost` open in the task browser (in the system browser when the Browser module is off). A PR of this project opens in the PR panel ([Pull requests](pull-requests-and-ci.md)). Everything else opens in the system browser.

<a id="console-menu"></a>
### Context menu

A native menu. Every item acts on the console, because the selection lives in xterm and no system role can reach it. State is sent over IPC `terminal:menu` (`TerminalMenuState`: `selection`, `link` ∈ `web | pr | mail | file | folder | null`, `browser`, `canPaste`; validated by `isTerminalMenuState`). **Paste** reads the clipboard through `clipboard:read-text` (≤ 1 MB).

| Under the pointer | Link group |
| --- | --- |
| web link | Open in task browser (Browser module on) · Open in system browser · Copy link |
| PR link (PR module on) | Open in the PR panel · then the web group |
| mailto | Open in system browser · Copy link |
| file | Open in editor |
| folder | Show in Files |

Then **Copy** (disabled with no selection) · **Paste** · **Select all**, then **Show the agent** · **Clear terminal** (with the keymap's key). **Open in the PR panel** for a PR in another repo falls back to the system browser, as in the chat.

<a id="render-and-theme"></a>
## Render, theme and font

- **Colours.** Background `--term` and foreground/cursor `--fg`, the same for the console and the CLI agent. The host answers a CLI's `OSC 10/11 ;?` queries with the window's colours, taken from `appearance` in `settings.json`: light `#f6f6f7` / `#252525`, dark `#141414` / `#e0e0e0`. `system` is resolved via `defaults read -g AppleInterfaceStyle` on macOS and the GNOME/KDE `color-scheme` on Linux. The reply is sent before the DA reply, so a CLI that picks its theme from the background (Claude Code's `auto`) matches the window.
- **Font.** Settings ▸ Appearance ▸ Terminal: **Font** (bundled mono, System mono or an installed mono family), **Size** (default 13) and **Font weight**: Light 300 · Regular 400 (default) · Medium 500 · Semibold 600 (`terminal.fontWeight`). Bold stays 700. Line height is fixed at 1.0 and the terminal has no ligatures option. Weight applies to the console, the CLI agent and the inline tool output.
- **Fit.** The padding sits on the outer mount. xterm opens in an inner element without padding, which `FitAddon` measures, so the last row and the cursor never fall under the edge. `.xterm-viewport` is transparent, so the leftover fraction of a row shows the console background. The inline tool output uses the same structure.
- **Resize.** The local grid follows every frame. The PTY gets a size only after 120 ms of quiet and only if it changed, because every `SIGWINCH` makes a TUI redraw.
- **Scroll position** of a normal buffer is remembered per terminal while the task is away. Typing scrolls to the bottom.

<a id="wheel"></a>
### Wheel and trackpad

- When the program tracks the mouse in SGR mode (`?1006h`, for example Claude Code's fullscreen renderer), every line-height of travel sends one SGR wheel report (buttons 64/65 at the pointer cell). The remainder carries over between events and is reset when the direction turns. Each event sends at most 3 × rows reports. Line-mode and page-mode deltas are converted directly.
- Without mouse tracking, without SGR, or with Shift held, xterm scrolls its own scrollback. In a Codex CLI task the normal buffer always scrolls the local scrollback, even with mouse tracking on. In the alternate screen the events stay with the CLI.
- **Scroll speed** (Settings ▸ Appearance ▸ Terminal): a multiplier from 0.2 to 4 in steps of 0.1, stored as `terminal.scrollSpeed`. The default 1 matches a native terminal, and a missing key reads as 1. It applies live, with no CLI restart.

<a id="agent-console-tools"></a>
## Agent reads the console

Two read-only MCP tools (`readOnlyHint`), available to every role (solo, foreman, worker) in every task. No module turns them off.

| Tool | Params | Returns |
| --- | --- | --- |
| `console_list` | none | the task's console sessions (open tabs, command runs included): `id`, title, folder, absolute `cwd`, running or exited with a code, the saved command (`commandId`, name) if the tab runs one, and the last shell command with its state, exit code and duration. An empty list carries a `note` saying the person opens the console with View ▸ Terminal |
| `console_read` | `id?`, `lines` 1–400 (default 80) | the session's last lines as plain text (no ANSI, wrapped rows joined, blank rows below the output dropped) plus the same fields as `console_list`. Without `id` it reads the only session or the newest one. An exited session returns its frozen tail |

- The CLI agent's own terminal is never listed.
- MCP `instructions` and the first-prompt brief tell the agent to read the console itself whenever the person mentions the console, a log, an on-screen error or a running server.
- Chat rows: `Checked the console` (with the session count) and `Read the console` (with the tab name and line count); expanded, the row shows the text that was read. Glyph `console`.
- No `console_write`: typing into the person's shell would bypass the agent's own shell permissions.

<a id="cli-transport"></a>
## Agent in the CLI

<a id="transport"></a>
### Transport is a task property

- `task.transport` is `gui` (ACP, chat) or `terminal` (CLI TUI in a PTY). It is chosen on the New task sheet in the **Transport** segment (GUI / CLI). The default for new tasks is Settings ▸ Agents ▸ **Launch in** (GUI / Terminal), stored as `agents.transport` with default `gui`. Quick tasks use the default too.
- A launched task keeps its transport for life. An ACP session cannot become a PTY or the other way round.
- In a CLI task the chat column is the agent's terminal, full height, with only the attachment shelf above it. Files, diff, editor, review comments, scope locks, crew, queue, notifications and the Turns panel work the same in both modes. Only the conversation moves into the TUI.
- **Why the CLI mode exists.** The CLI offers what the ACP adapter does not: `/` commands, permission modes on `⇧⇥`, plan mode, `--resume` and image paste. A TUI also needs height, so the mode takes the column rather than a console tab.
- **Absent in CLI mode:** the transcript and per-turn text comments, the composer as an input field, ghost suggestions, plan-approval cards. Anything tied to the transcript has to be given its own place in CLI mode, or it does not exist there. Questions, permissions and proposals appear in the task window's **Needs you** row above the column.

<a id="cli-start"></a>
### Start and the launch stage

- A CLI task starts no ACP session. The host claims scope locks as it would for ACP, takes the diff baseline before the PTY starts, writes the launch files and creates the `agent` terminal.
- Prompt delivery is the host's job in one place. Every entry point (in place, worktree, foreman, queue promotion, board drop, lock-conflict exits, Continue) creates the task with its transport, and the host passes the prompt as a CLI argument. The prompt is never typed into the PTY and never sent over ACP. The task title and relay links are set as in GUI mode.
- The prompt is optional: an empty first prompt leaves the TUI at an empty input line.
- **Launch stage** (`AgentLaunchState`), shown while there is no live agent terminal: the provider glyph, its name (Claude Code / Codex), one line of explanation and one primary button.

| State | Heading / text | Control |
| --- | --- | --- |
| first read | `Opening terminal…` / `Checking the saved session.` | wait dots |
| `queued`, no session, no terminal | `Starting {agent}…` / `The agent is starting in this task’s terminal.` | wait dots; no button |
| never started | `{agent}` / `Start the agent to work on this task in the terminal.` | Start {agent} |
| has `session.started` | `{agent}` / `Continue the saved session in the terminal.` | Resume {agent} · Continue in a new task |
| read failed | `The terminal could not be opened.` | Retry |
| start failed / non-zero exit | error line (`Could not start the agent.` / `The agent exited with code {code}.`) | Start or Resume again |

- Whether a task can resume comes from a recorded `session.started`, not from a live PTY or the task status. A second start is blocked while one is pending. There is no autostart and no fake progress.
- An immediate start from `LaunchQueue` notifies the window with a record-less `session:event`, so the panel re-reads terminals as soon as the PTY exists instead of waiting for `SessionStart`.

<a id="cli-args"></a>
### Launch arguments

| | Claude Code | Codex |
| --- | --- | --- |
| Hooks | `--settings <task>/cli-settings.json` (`hooks`, plus `statusLine` when the person has one) | `-c hooks.<Event>=[{hooks=[{type="command",command=…,timeout=3}]}]` per event |
| MCP | `--mcp-config <task>/cli-mcp.json` (`mcpServers.brigadir`, tool timeout 7 days) | `-c mcp_servers.brigadir={command=…,env_vars=[…],tool_timeout_sec=604800}` (no hook token) |
| Model / effort (first start only) | `--model <m>` `--effort <e>` | `-m <m>` `-c model_reasoning_effort="<e>"` |
| Resume | `--resume <sessionId>` | `resume -- <sessionId>` |
| Prompt (first start, if any) | `-- <prompt>` | `-- <prompt>` |

- Settings are added only for this launch. The person's CLI config and hook trust are never rewritten or bypassed. Codex may ask the person to review its hooks with `/hooks`.
- Model and effort come from the sheet's `launchOptions`, classified by `agentOptionKind`. The values are the ACP catalog's, which both CLIs accept as they are. `default` gives no flag. A resume adds no model or effort flag: the session keeps its model, which the person changes with `/model`. Mode and Fast mode are not passed to the CLI.
- The prompt goes after `--`: a variadic flag such as `--add-dir` would otherwise swallow it.
- `<task>/cli-launch.json` records `schemaVersion`, `provider`, `resume`, `args` and `at`, so what the CLI was started with is visible on disk.
- Env passed to the CLI: `BRIGADIR_HOST_SOCKET`, `BRIGADIR_HOST_INSTANCE`, `BRIGADIR_PROJECT_ID`, `BRIGADIR_TASK_ID`, `BRIGADIR_HOOK_TOKEN`, `BRIGADIR_MCP_TOKEN`, `BRIGADIR_ROLE` (crew role) and `BRIGADIR_USER_STATUSLINE` when a statusline is relayed.
- `⌃V` is not intercepted, so a CLI can read an image from the clipboard itself.

<a id="hooks"></a>
### Hooks: state comes from the CLI

- Events: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop` and `SessionEnd`, plus `Interrupt` (Codex) or `PostToolUseFailure` (Claude). Timeout is 10 s (3 s for `SessionEnd` / `Interrupt`; Codex uses 3 s for all).
- **Relay.** On macOS the relay is `/bin/zsh -f hook.zsh` (about 5 ms). Elsewhere a bundled C `cli-relay hook` speaks the same contract. The relay reads stdin up to 1 MiB, opens the host socket with role `hook` and its own token, and calls `cli_hook`. It prints only a non-null result. The hook role cannot answer for the person, drive a PTY or read files. The host stays the single writer of the journal and the snapshots.
- **Normalisation** (`cliHook` in transport): foreign JSON never reaches the renderer. `session_id` must match `[A-Za-z0-9_-]{1,200}`. Hooks from subagents (`agent_id`) are ignored. The prompt is cut to its first line, ≤ 500 chars, for the turn title. Neither the response nor the TUI text nor tool output is copied.

| Hook | Host does |
| --- | --- |
| `SessionStart` (new id) | closes an open turn as cancelled; journals `session.started` with the provider session id |
| `UserPromptSubmit` | ignores a repeated `turn_id`; closes an open turn; checkpoint `turn`; journals `turn.started` (title, attached review, attachments, `attachmentBatchId`); replies with `additionalContext` |
| `PreToolUse` / `PostToolUse` / `PostToolUseFailure` | `tool.changed` (`in_progress` / `completed` / `failed`); every 5th finished tool takes a `tools` checkpoint alongside the hooks |
| `Stop` / `Interrupt` / `SessionEnd` | checkpoint `turn`; `turn.completed` (`end_turn`, or `cancelled` for `Interrupt` / `SessionEnd`) |
| PTY exit | completes only a turn that is still open (`cancelled` on a non-zero code); releases scope locks |

- A hook whose session id differs from the current session is rejected.
- The sidebar status follows turns: `turn.started` sets it to working and `turn.completed` sets it to idle.
- The diff panel refreshes on turn boundaries from the hooks, as it does on `turnEnded` in ACP mode.
- **Session id.** The id that `--resume` gets comes from `SessionStart` (the `session.started` event), never from an id Brigadir proposed. Resume uses exactly that id, with no picker, no `--last` and no repeat of the first prompt. A window switch is not an exit.
- MCP calls never carry state. Turn boundaries, status and attribution come from hooks. MCP is only the channel for actions the agent cannot do from its own shell: the task browser, questions, commands, the console and the other `brigadir` tools of its role ([Agents](agents-and-providers.md)). MCP cannot drive the TUI, and full programmatic control (`--input-format=stream-json`) would need `--print`, which has no TUI.
- **Claude statusline.** Only when the person has a `statusLine` of their own (looked up in local, then project, then user settings), the relay prints it unchanged and passes `rate_limits` to the host, which journals `quota.observed` on change ([Usage](agents-and-providers.md)). Without one, nothing is added.

<a id="cli-context"></a>
### Context, reviews and comments ride the next prompt

- The person types in the TUI. Brigadir never adds a second input field over the PTY, because the TUI owns its input (pickers, `⇧⇥`, `Esc Esc`, `/` completion, permission prompts).
- **Attachments.** Show the agent, editor selection, files, screenshots, page nodes and pasted or dropped files on the CLI column become attachments queued in `<task>/cli-context.json` (`attachContext` / `removeContext`). On the next `UserPromptSubmit` the host adds them to `additionalContext` as `<attached_context name="…">…</attached_context>`. An image becomes `<attached_image name="…">` with the PNG path for the agent to read with its image tool. Named tags keep attached content apart from the person's own words.
- The first prompt's `additionalContext` also carries the role brief, once per session. It carries the scope manifest whenever the manifest changes, and relay resources (`File in this task's workspace: …`) on the first turn.
- **Shelf.** Queued context shows above the terminal on the same tile shelf as the composer (`AttachmentChips shelf`: 44 px tiles, glyph, bold name with range, folder or source line, image thumbnail, × on hover). The shelf spans only the CLI column. Tiles stay in one horizontally scrolling row with a 12 px field. There is no visible caption: the accessible description is `Context attached to your next CLI prompt.` Clicking a tile previews it and × removes it from the queue. The shelf is truth-synced from the host (`pendingAttachments`), and `turn.started` removes the tiles it carried. Notice chips (class S) of a CLI task stand in this shelf.
- Attaching from elsewhere (the editor, diff or console) switches the task's main surface back to the CLI, so the action has a visible result.
- **Review.** In a CLI task, submitting a review queues it in `<task>/cli-review.json`, and it goes with the next prompt. The UI names it **Attach review**, says `Review attached to your next CLI prompt.` and lets the person remove it. It counts as sent only when `turn.started` carries it, not on click. A batch already accepted is not duplicated after a restart (same review id). A comment draft offers **Attach comment** / **Attach comment and go**. The draft clears only after the host accepts it; on an error it stays.

<a id="cli-interrupt"></a>
### Interrupt

**View ▸ Stop** (`⌘.`) in a CLI task writes Ctrl-C to the agent PTY. Pending MCP questions and proposals then close with `answer=null`, and the current turn completes as `cancelled`. Brigadir does not wait for a provider hook (Claude sends none after an interrupted MCP call), and late hooks do not complete the turn twice. The CLI process and its session stay alive for the next prompt. The event records the person's request, not a guarantee that every child process stopped. A Ctrl-C typed directly in the TUI is the TUI's own business and depends on the provider's hooks.

<a id="cli-lifecycle"></a>
### Lifecycle

- The agent PTY lives in the session host, like an ACP agent. Closing the window does not stop it. Closing or archiving the task does.
- There is at most one live agent terminal per task. Starting again replaces an exited one.
- A CLI task has a journal like any other task (`session.started`, turns, tools, checkpoints), so it is never mistaken for an orphan, and it reopens with `--resume`.
- The buffer is not persisted. After a restart the column shows the launch stage with **Resume**.
- `⌘K` and new-terminal keys act on the console, never on the agent's terminal.

<a id="turns-panel"></a>
### Turns panel and PTY anchors

- One journal projection serves GUI and CLI (`TurnSummary`): number, title (first line of the prompt, shown up to 120 chars), start, duration, tool count, status (`running`, `done`, `interrupted`, `failed`) and checkpoint range. The current turn uses the last recorded checkpoint, with no invented end. The panel never shows the response or tool output, so it is not a second transcript.
- It opens as the **Turns** panel tab (View ▸ Turns, `⌘⇧U`) and has a search field. Selecting a turn lists **Changes of turn N** with **Why did this change?** and switches the main surface to the conversation.
- In a CLI task, on `turn.started` the host places an xterm marker at the agent's current line once earlier output has been parsed, but only in the normal buffer. Markers live in RAM, move with reflow and scrollback, and are capped at 1000. They travel with terminal events only when they change. Selecting a turn scrolls to its anchor and tints the turn's lines `--accent-soft` with a 2 px `--accent` left border. If the anchor was trimmed, the process restarted, or the TUI is on the alternate screen, a strip says `Turn N · This turn is no longer in the terminal buffer.` with **Dismiss**. The turn's diff works regardless of the buffer. **Back to diff** returns to the diff when the jump came from there.
- Turns are never detected by parsing ANSI or TUI text.

<a id="later"></a>
## Later

- Smooth (sub-line) scrolling in the console's own scrollback.
- Passing the sheet's mode and Fast mode to the CLI (their CLI flags do not map one to one).
- Giving the agent the person's console selection through a tool.
- JSONL backfill of turn boundaries for CLI sessions started outside Brigadir.

<a id="non-goals"></a>
## Non-goals

- Competing with standalone terminals: split panes, buffer search, profiles, `tmux` integration, per-terminal colour schemes. There is one app theme.
- A second copy of shell history: the shell keeps it.
- Sending a failure to the agent automatically, or keeping a list of commands that are "allowed to fail".
- Persisting terminal buffers to disk.
- Typing into the person's shell on the agent's behalf (`console_write`), or running agent commands in the person's console.
- An own input field over the CLI TUI, a model/quota strip above it, or a console strip under it.
- Switching a live task between GUI and CLI.
- Writing the sheet's model into `~/.codex/config.toml` or Claude's `settings.json`.
