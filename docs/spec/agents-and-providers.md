# Agents and providers

Brigadir talks to coding agents through their ACP adapters (`claude-agent-acp`, `codex-acp`) and turns everything the wire carries into its own domain events before anything reaches the UI or the disk. This file covers the transport seam, the verified behaviour of both adapters, sign-in and provider terms, subscription quota, the model/effort catalog, one-shot helper calls, adapter and CLI updates, how agents learn and use Brigadir's MCP tools, and the read-only `editor_state` / `pr_state` tools.

<a id="transport"></a>
## Transport and the domain seam

<a id="seam-rules"></a>
### Rules

| Rule | Detail |
| --- | --- |
| UI depends only on domain types | `AgentEvent` / `AgentCommand` in `@brigadir/core`. ACP SDK types never leave `packages/transport`; no `session/update` payload reaches a view. |
| Persist normalized events | The task journal is JSONL of `AgentEvent` records, never raw ACP messages (see [data layout](architecture-and-platform.md)). |
| Capabilities come from the agent | What a provider can do (modes, models, effort, commands, auth methods, session capabilities) is read from `initialize` and `session/new`. There is no per-provider knowledge table. |
| Launch names only | `adapterCommand` knows two names per provider: the binary (`claude-agent-acp` / `codex-acp`) and the npm package (`@agentclientprotocol/claude-agent-acp` / `@agentclientprotocol/codex-acp`). The provider glyph (`ProviderGlyph`) is a presentational map with a generic fallback; it knows no behaviour. |
| Unknown is ignored | An unknown `sessionUpdate` or `_meta` key maps to `{kind: 'unhandled'}`; it is never shown as an event. |
| Snapshots are the diff truth | ACP edit records are attribution labels at most. The adapters write files with their own tools and never call the client's `fs/*` or `terminal/*` for that, so the [diff engine](diff-and-review.md) works the same in GUI and Terminal modes. |

**Why.** The seam makes a second provider a new way to start a process, not a new layer; Codex runs without any change in a view.

<a id="domain-model"></a>
### Domain model

- **Events** (`AgentEvent.kind`): `session.started`, `session.info`, `session.failed`, `message.delta` (roles `assistant`, `thought`, `user`), `tool.changed`, `plan.changed`, `plan.document`, `plan.removed`, `options.changed`, `mode.changed`, `commands.changed`, `usage.changed`, `turn.usage`, `rate-limit.changed`, `quota.observed`, `permission.requested`, `subagent.started`, `subagent.changed`, `background.started`, `background.changed`, `turn.completed`, `unhandled`. The host adds its own boundary records (`turn.started`, `host.stopped`, `rate-limit.expired`, …).
- **Commands** (`AgentCommand.kind`): `prompt`, `cancel`, `setMode`, `setOption`, `stopBackground`. Host-level session commands include `retryTurn` (see [sign-in recovery](#sign-in-recovery)).
- **Tool patches.** A patch with a missing field keeps the previous value; an empty array clears the field. Boolean options and grouped selects are kept as the agent sent them.
- **Parentage.** `_meta.claudeCode.parentToolUseId` (also on a subagent's message chunks) lives on the event record envelope, not on the event.
- `usage.changed` carries `used`, `capacity` and the adapter's `cost`; cost is never displayed (see [usage](#usage-principles)).
- <a id="turn-usage"></a>`turn.usage` carries the tokens of one finished turn as the adapter reported them in the `session/prompt` result: `input`, `output`, `cacheRead`, `cacheWrite` (non-negative integers; a missing counter is 0). It is journaled just before that turn's `turn.completed`, and not at all when the result has no `usage`. Nothing displays it; the crew report sums it (see [Crew](crew.md#reports)).

<a id="acp-connection"></a>
### Connection lifecycle

One `AgentTransport` owns exactly one adapter process and one session; the host owns persistence and task identity.

- **Framing.** Newline-delimited JSON-RPC over stdio, ACP `protocolVersion: 1`, `@agentclientprotocol/sdk` 1.4.0. Another protocol version fails the start.
- **`initialize` client capabilities:** `fs.readTextFile` / `fs.writeTextFile` (true when the host supplies handlers, so an agent can read unsaved editor buffers), `terminal: false`, `plan: {}`, and `subagents: {}` added on the wire. `clientInfo.name` is `brigadir`.
- **Start timeout** 60 s (`startupTimeoutMs`). A human permission or question has no timeout.
- **Session open.** `session/new` with `cwd` (absolute), `additionalDirectories` (deduplicated, absolute, only when the agent advertises `sessionCapabilities.additionalDirectories` — this is how monorepo scopes reach the agent structurally), and `mcpServers`. Resume uses `session/load` (requires `loadSession`). Fork uses `session/fork`, then `session/resume` or `session/load` when the fork answer carries no options; a failed fork falls back to a new session.
- **Claude raw SDK messages.** Claude sessions always pass `_meta.claudeCode.emitRawSDKMessages` with `rate_limit_event` plus `system` subtypes `session_state_changed`, `task_started`, `task_updated`, `task_notification` (agent-started turns and background tasks, see [turns](chat-turns-plans-and-questions.md)).
- **Permissions.** Cancel, connection close or stop answer `cancelled` and never become approval. A chosen option must be one of the offered ids. A `preapprove` hook may pick an option with no event and no card (used for [our own tools](#tool-permissions)).
- **Steering.** `_meta.steering.supported` of `initialize` enables `_session/steering`; see [steering](composer-steering-queue-and-ghost.md).
- **Stop.** The adapter runs in its own process group; close sends `SIGTERM` to the group, then `SIGKILL` after 1.5 s.
- **Adapter environment.**
  - Claude: `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` (the SDK session otherwise has no plan tool); with our MCP server, `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` = 7 days. A value the person set is kept.
  - Codex: `CODEX_CONFIG` merged over the person's own value: `tools.update_plan.enabled = true`, and full stdio descriptions of every MCP server in `mcp_servers`, with `tool_timeout_sec = 604800` for `brigadir` only. `session/new.mcpServers` is then `[]` (codex-acp overwrites `mcp_servers` from ACP and would drop the timeout). `~/.codex/config.toml` is never touched.

**Why the long MCP timeouts.** `ask_user`, `propose_plan` and similar tools wait for a person, possibly overnight; codex-acp aborts a tool call after 300 s and Claude after 30 min of silence by default.

<a id="adapter-queue"></a>
### Prompt queue lives in the host

`_meta.claudeCode.promptQueueing: true` means one slot: a newer prompt replaces the queued one, and the replaced prompt gets a successful `end_turn` with zero usage. Brigadir therefore never sends a second prompt into a running turn through `session/prompt`; the host keeps a FIFO, journals each queued text when it is queued, pauses on a rate limit and lets the person edit or remove entries. UI and rules: [prompt queue](composer-steering-queue-and-ghost.md).

<a id="transport-modes"></a>
### GUI and Terminal modes

The transport is a property of the task (`agents.transport`: `gui` | `terminal`, overridable on the New task sheet). GUI runs the ACP adapter; Terminal runs the provider's own CLI TUI in a PTY with hooks and is deliberately thinner. A live session cannot switch modes. Details: [agents in the CLI](terminal-and-cli-agents.md).

<a id="providers"></a>
## Providers

| Aspect | Rule |
| --- | --- |
| Values | `AgentTask.provider`: `claude` \| `codex`; a `task.json` without the field reads as `claude`. |
| Default | Settings ▸ Agents: `agents.provider` (default `claude`); `agents.enabled` says which providers are offered (at least one). The New task sheet overrides per task. |
| Immutability | A live session cannot change provider; the host gets it as `--provider` with every launch path. |
| Crew | A worker's provider comes from its role in the crew; one host process still runs one agent ([crew templates](crew-templates-and-editor.md)). |
| Missing binary | A start error with a hint; the provider is never auto-picked by which binaries exist. |
| Glyph | Composer chips, launch sheet, board cards and the project screen show `ProviderGlyph`. |

<a id="claude-adapter"></a>
## Claude adapter: verified behaviour

Facts measured on live `claude-agent-acp` sessions; the mapper relies on them.

| Area | Fact |
| --- | --- |
| Package | `@agentclientprotocol/claude-agent-acp`, bin `claude-agent-acp`, Node ≥ 22, runs on the Claude Agent SDK. |
| Auth | With a logged-in `claude`, `authMethods: []` and credentials are inherited. On another machine the list is non-empty (`claude-ai-login`, `console-login`, `gateway`, `gateway-bedrock`). `agentCapabilities.auth.logout` present. |
| Capabilities | `promptCapabilities {image, embeddedContext}`, `mcpCapabilities {http, sse}`, `loadSession`, `sessionCapabilities {additionalDirectories, close, delete, fork, list, resume}`, `_meta.claudeCode.promptQueueing`. `_meta` also carries `steering`, `goal` (`_session/goal`, unused) and `jetbrains.air` (`sessionFailure`, `agentFileChangeReport`; neither sends anything in practice). `initialize` carries no quota. |
| Modes | One axis: `mode` is both `modes.availableModes` and a config option: `auto` (classifier decides permissions; default), `default` (Manual), `acceptEdits`, `plan`, `dontAsk`, `bypassPermissions`. In `auto`, `session/request_permission` is rarely called. |
| Config options | `select` options with `id`/`category`/`name`/`description`/`currentValue`/`options[]`: `mode`, `model` (first entry `Default (recommended)`), `effort` (`default`, `low` … `max`, per model), `fast` (`on`/`off`). A generic renderer draws all of them. |
| Messages | `agent_message_chunk` grouped into one row by `messageId`. |
| Tool calls | `tool_call` / `tool_call_update` with `toolCallId`, `status`, `title`, `kind`, `locations[{path,line}]`, `content`, `rawInput`, `_meta.claudeCode.toolName`. The human description is `_meta.claudeCode.title` (the protocol `title` is the raw command). Observed `kind`: `read`, `edit`, `execute`, `think`, `other`, `human`; read-vs-mutation collapse uses `kind`, not tool names. |
| Output | No streaming of command output: the whole output arrives in one `tool_call_update` with `status: completed`. |
| Subagents | Launcher: `_meta.claudeCode {toolName: "Agent", subagent: true}`, `kind: think`; its `toolResponse` has `isAsync`, `agentId`, `resolvedModel`, totals. Nested events carry `parentToolUseId`. See [subagents](chat.md). |
| Commands | `available_commands_update` lists slash commands with descriptions, project commands included. |
| Usage | `usage_update {used, size}` for the context ring; `session/prompt` result `usage {inputTokens, outputTokens, cachedReadTokens, cachedWriteTokens, totalTokens}`; `_meta.quota.model_usage[]` per model including subagents. |
| Rate limit | `usage_update._meta["_claude/rateLimit"]` (see [quota sources](#quota-sources)). |
| Auth failure | `session/new` passes; `session/prompt` sends one assistant line with the CLI text, then fails with `RequestError` −32000 (`authRequired`). |
| Transcripts | ACP sessions are persisted by the CLI to `~/.claude/projects/<escaped-cwd>/<session-id>.jsonl`. |

<a id="subagent-model"></a>
### Subagent model

A Claude session's own subagents (search, reading, summaries) run on the session's model unless told otherwise. `agents.claudeSubagentModel` (Settings ▸ Agents ▸ `Subagent model`; null = `Same as the agent`) is a model value from the Claude catalog. The host reads it from `settings.json` when it starts an agent and passes it to the adapter as `CLAUDE_CODE_SUBAGENT_MODEL`; a value the person set in the environment stays. It applies to sessions started after the change, to every Claude task, crew members included. Such a session also gets one sentence in its first-prompt brief (`subagentBrief`): subagents run on their own model, so they get the work whose mistakes are cheap to spot (finding files, reading logs and long output, running tests), while edits and decisions stay with the agent, which checks a subagent's answer against the code before acting on it. Terminal sessions get neither the variable nor the sentence. **Why:** a foreman on the strongest model otherwise reads files at that model's price, and a mistake in a search is cheap to spot.

<a id="codex-adapter"></a>
## Codex adapter: verified behaviour

Only differences from Claude are listed. `codex-acp` is a Node wrapper over `codex app-server`; its npx install also contains the `codex` binary (`@openai/codex`).

| Area | Fact |
| --- | --- |
| `initialize` | `agentInfo.title: "Codex"`. `sessionCapabilities` add `subagents`; `mcpCapabilities {acp: false, http: true, sse: false}`; `auth.logout`. `authMethods`: `api-key` (`_meta.api-key.provider: "openai"`) and `chat-gpt`. Right after it, `_auth/status_update` with `authStatus.kind: "account"`, label, email, plan — the transport keeps only login kind and plan, never the email. |
| Modes | `read-only` ("Ask for approval"), `agent` ("Approve for me", current), `agent-full-access` ("Full access"); `_meta.kind` `standard` / `auto_review` / `full_access`. |
| Config options | `mode`, `collaboration_mode` (`default`/`plan`), `model` (`category: model`), `reasoning_effort` (`category: thought_level`; the effort control is recognised by `reasoning` in the id), `fast-mode` (`category: model_config`). The `models` list of `session/new` (model × effort pairs) is ignored. |
| Turn order | `available_commands_update` → `session_info_update` (`_meta.codex.threadStatus`) → chunks → tool calls → `usage_update` → result. |
| Text | `agent_message_chunk` has `_meta.codex.phase`: `commentary` (between tools) and `final_answer`; both are visible assistant text. |
| Read | `toolCallId: "exec-<uuid>"`, `title: "Read file '/abs/path'"`, completion has `rawOutput.formatted_output`. No tool name, no description. |
| Execute | `title` is the whole command, newlines included; `rawInput {command, cwd}`; `content [{type: terminal}]`; `rawOutput` is an object `{formatted_output, exit_code}`; `_meta.terminal_exit {exit_code, signal}`. A non-zero exit arrives as `failed`. |
| Edit | `title: "Editing files"`, no `locations`; file and change only in `content[{type: "diff", path, oldText, newText}]`; no `rawOutput`. |
| MCP calls | No tool name; `title` `mcp.<server>.<tool>`, `rawInput {server, tool, arguments}`. |
| Usage | `usage_update {used, size}` only; no quota over ACP (codex-acp swallows `account/rateLimits/updated`). `PromptResponse.usage` and `_meta.quota` count only the last request of a turn. |
| Session info | `session_info_update.title` (auto thread name) maps to `session.info`. |
| Permissions | None requested in `agent` mode for reads, commands or edits in the work tree. |

<a id="mapper-rules"></a>
### Mapper rules for both adapters

1. `ToolCall.headline` / `extraTitleLines`: the first non-empty line of the display title and the count of the rest. Rows, the turns strip and search use the provider's tool name, else `headline` — never the full title. A row without a tool name shows a path not in the headline plus `+N lines`; the full command text opens in the output under the row.
2. `rawOutput` as an object is read through `formatted_output`; Claude's string form is read as is.
3. An edit without `locations` takes paths from the `content` diff blocks; a preview patch is synthesised from `oldText`/`newText` as one hunk without file headers, only when `rawOutput` is empty.
4. A non-zero `_meta.terminal_exit.exit_code` turns `completed` into `failed`.
5. MCP calls are recognised from either spelling (`mcp__<server>__<tool>` or `mcp.<server>.<tool>`) by `mcpCall`, without knowing the provider.

No provider-specific row renderer exists; both adapters go through the one row engine.

<a id="client-mcp"></a>
## Brigadir's MCP server

The host passes its own stdio MCP server `brigadir` in `session/new` (`{name, command, args, env: [{name, value}]}`; for Codex through `CODEX_CONFIG`, see above).

- The adapter spawns the process itself and speaks MCP over stdio (`initialize`, `notifications/initialized`, `tools/list`, `tools/call`).
- The agent sees tools as `mcp__brigadir__<tool>`; Claude loads them deferred through `ToolSearch`, so a long tool list costs little context.
- `tools/call` carries `_meta["claudecode/toolUseId"]`, which links a call to its transcript row without our own correlation ids.
- Text results (`content: [{type: "text"}]`) reach the agent verbatim; our tools answer JSON.
- A tool without parameters (`editor_state`, `pr_state`) may be called without `arguments`.

Tool families: crew ([crew](crew.md)), human (`ask_user`, `create_task` — [tasks](tasks.md), `add_folder`, `slack_post` — [Slack](notifications-slack-notes-and-schedules.md#slack-agent-post)), browser and simulator ([browser and simulator](browser-and-simulator.md)), `commands_*` ([project commands](search-menus-and-commands.md)), `console_*` ([console](terminal-and-cli-agents.md)), `pr_comment` / `pr_comment_reply` ([pull requests](pull-requests-and-ci.md)), `editor_restart_language_servers` ([code intelligence](editor-code-intelligence.md)), and [`editor_state` / `pr_state`](#context-tools). Each call renders as an MCP row in the chat ([chat](chat.md)).

<a id="tools-awareness"></a>
### Agents know their tools

- **MCP `initialize` carries `instructions`** in English, built by `toolsInstructions(role, modules)` from the enabled modules and the session role: a real browser, the project's simulator and saved project commands exist; after UI changes open the page (`browser_open`), check it (`browser_ui`, `browser_screenshot`) and act (`browser_act`); use `simulator_*` for React Native; run dev servers, builds and tests through `commands_*`, not the shell; do not ask the person to check what the agent can check; the person sees every action. A disabled module is not mentioned.
- **First-prompt brief** (`sessionBrief`) repeats it briefly (`toolsBrief`) for Codex and CLI sessions, which may not show MCP instructions to the model. The commands sentence goes to every session where the Commands module is on and commands are saved.
- **Foreman brief** names the crew's tools (`crewToolsBrief`) so plans include a check step ("the worker checks the page in the browser").
- **Tool descriptions** say when to use a tool, not only what it does (`whenToUse` table in `host/src/mcp.ts`).
- **Workers** (developer, verifier, lead) get the browser (their own task's tabs) and commands (run in the worker's folder). `ask_user`, `create_task`, `add_folder`, `slack_post`, `editor_state`, `pr_state` stay with the foreman and solo agents (`humanToolsAllowed`).
- **Simulator queue** (`main/simulator-queue.ts`): one device per project. The first worker's `simulator_*` takes it; others wait, and their card shows `Waiting for the simulator` as its second line (sent as `simulator:event`, not persisted). The foreman and solo agents never take the device from a worker but queue ahead of all workers (among themselves in request order). The owner releases on `turn.completed`, `session.failed`, `host.stopped`, or 60 s after its last call ends. A waiting call waits up to 60 s, then gets "simulator busy, retry later".

<a id="tool-permissions"></a>
### Tool permissions

| Rule | Detail |
| --- | --- |
| No agent permission card for our tools | When the adapter asks permission for a tool of the `brigadir` server (`skipsAgentPermission` in `core/mcp-tools.ts`), the transport answers `allow_once` with no `permission.requested` event and no card. A tool of another server with the same name is not covered. |
| The host asks where consent matters | External domain in `browser_open` / `browser_act`; a project command without `agentRuns`; a folder in `add_folder` (git or not, e.g. `Add docs to the task · read only`); every `slack_post` (`Post to Slack as <bot> · <channel>`). |
| No consent at all | `ask_user`, `create_task`, `propose_plan`, `ask_foreman`, `post_note`, `prompt_task`, `create_worker_task`, `submit_review`, `approve`, `accept_task`, `pr_comment`, `pr_comment_reply`, `simulator_open`, `simulator_act`, and all reads. |
| `readOnlyHint: true` | `browser_state/read/console/network/screenshot/ui`, `simulator_state/ui/screenshot/logs/network`, `editor_state`, `pr_state`, `commands_list`, `commands_output`, `console_list`, `console_read`, `task_status`, `read_report`, `read_transcript`, `read_diff`, `read_notes` — so Claude calls them in Plan mode like `Read`. |

**Why.** The person's answer to a question is already consent; the adapter's card shows raw JSON without the meaning of the action, while the host knows the domain, command or folder and can ask clearly. `allow_always` is not used because it writes into the project's Claude settings.

<a id="auth"></a>
## Sign-in

- **Subscription, not API keys.** Agents run on the person's Claude / ChatGPT subscription through their own CLIs; `ANTHROPIC_API_KEY` is not needed.
- **Never read credentials.** Brigadir never reads the Keychain item `Claude Code-credentials` or `~/.codex/auth.json` content. The environment check only tests that Claude's item exists (macOS) or `~/.claude/.credentials.json` exists, then asks the CLI: `claude auth status` (`loggedIn`) / `codex login status` (exit 0). A stored but expired login shows `Sign-in expired`.
- **Sign-in commands** are the CLIs' own: `claude auth login --claudeai`, `codex login`. The intro and Settings ▸ Agents `Sign in…` run the same flow as the chat card below.
- **Unauthenticated Codex** fails `session/new`; the adapter's text becomes the task failure.

<a id="sign-in-recovery"></a>
### Expired sign-in recovery

1. **Cause in the domain event.** `session.failed.reason = 'auth'` only when the adapter answers ACP `authRequired` (−32000), on `session/prompt` or at session start; never guessed from text. The task stores `failure: 'auth' | null` beside `failed`; a new turn or session clears it.
2. **Card in the chat** in place of the failed reply: key glyph in an amber circle, `{agent} asks you to sign in again`, subtitle `Claude Code · subscription` or `Codex`, explanation (`Sign-in expired. Sign in again to resend automatically.`; at session start `Sign-in expired. Sign in again to restart the agent automatically.`), actions `Sign in to {agent}…` (primary) and `Try again`, and `Details` with the adapter's text verbatim. An assistant line that was the turn's only output is folded into `Details`. While unresolved, the composer footer shows the notice chip `{agent} · sign-in needed` whose popover is the same card ([notice chips](notifications-slack-notes-and-schedules.md)).
3. **States** (shared by every open task of that agent):

   | State | Shows |
   | --- | --- |
   | waiting | spinner, `Waiting for browser sign-in…`, `{agent} sign-in opened. The message sends automatically after sign-in.`, `Open the page again`, `Enter the code`, `Cancel` |
   | code (Claude only) | `Code from the page` field + `Sign in` |
   | not finished | one warning toast per attempt `Sign-in incomplete. The page was closed.` with a retry action; the card returns to `Sign in to {agent}…` |
   | signed in | collapses to `Signed in to {agent}. Message resent.` when the next turn is the same prompt; otherwise a past card reads `{agent} asked you to sign in again` without actions |

4. **Login runs in the app** (`main/agent-login.ts`): a child process with the login-shell PATH; the page URL is taken from its output (for `Open the page again`), the code is written to stdin. One process per agent, `Cancel` kills it, 10 min timeout. Success = exit 0 **and** the CLI's status check.
5. **Retry in the host.** `retryTurn` applies when the last boundary record is `session.failed` after `turn.started`: the host closes the adapter (fresh credentials need a fresh process), reopens with `session/load` and restarts the same prompt with its attachments. `Try again` sends the same command without signing in. A host with no process (failure at start) restarts the task.
6. **After sign-in** main sends `retryTurn` with `reason: 'auth'` to every live host of that agent's tasks; a host whose last failure is not about sign-in ignores it.
7. **Sidebar**: a task with `failure: 'auth'` shows an amber key and the second line `{agent} sign-in needed` (also tooltip and `aria-label`).

A one-shot call that fails on sign-in throws `Agent sign-in required` ([one-shot calls](#one-shot)).

<a id="provider-terms"></a>
### Provider terms

| Mode | Risk | Why |
| --- | --- | --- |
| Claude · Terminal (`claude` in a PTY) | low | unmodified binary with its own sign-in, explicitly allowed |
| Claude · GUI (ACP → Agent SDK) on a subscription | medium for personal use, high if distributed | Anthropic's terms expect products built on the Agent SDK to use API keys |
| Codex · Terminal | low | official CLI, own sign-in |
| Codex · GUI (`codex-acp` → app-server) | low | the official "Sign in with ChatGPT" path for local and open-source apps |

Rules that follow and are implemented:

- Tokens are never read, stored or forwarded; sign-in always happens inside the vendor CLI.
- Claude quota is read with the unmodified `claude -p /usage` (no model turn, no ACP) — see [quota sources](#quota-sources).
- Background helper calls default to Codex (Luna) to keep automatic traffic off the Claude subscription ([helper agent](#helper-agent)).
- Proxies that re-expose a subscription token as an API, or rotating accounts, are never used.

<a id="usage"></a>
## Usage, limits and quota

<a id="usage-principles"></a>
### What is shown

| Metric | Where |
| --- | --- |
| Remaining share of each subscription window + reset time | Quota button (sections rail foot and New task sheet) |
| Context of the session, % | Composer context ring: amber > 70%, red > 90%; click shows figures and `Continue in a new task` ([composer](composer.md)) |
| Tokens per turn / task | relative signal only (turn footer, card tooltip) |

- **No dollars on a subscription.** The adapter's `cost` is synthetic; it is carried in `usage.changed` but never displayed.
- **The number is always what is left** (`1 − utilization`); the bar shrinks with it.
- **Quota is global**, per provider account — never per task or project.
- **No data → no indicator.** A quota that lies is worse than none; no timer is ever derived from context usage or error text.

<a id="quota-sources"></a>
### Quota sources

ACP itself has no quota (the context-size RFD defers limits); each provider's source is its own.

| Provider · mode | Source | Gives |
| --- | --- | --- |
| Claude · GUI turns | `usage_update._meta["_claude/rateLimit"]` and the raw SDK `rate_limit_event` (requested via `emitRawSDKMessages`, because the adapter's own `usage_update` drops an event that arrives before the turn's first model answer) | top fields `status` (`allowed` \| `allowed_warning` \| `rejected`), `rateLimitType` (`five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, `seven_day_overage_included`, `overage`), `utilization` 0..1, `resetsAt` (unix), `surpassedThreshold`, overage fields (not always present); `unifiedWindows` — every window at once `{utilization, resetsAt}` |
| Claude · complete read | `claude -p /usage --output-format stream-json --verbose --no-session-persistence` run by main in `~/.brigadir/usage/` | `assistant` message (`model: "<synthetic>"`) with `usage_report.rate_limits.limits[]`: `session` → 5-hour, `weekly_all` → weekly, `weekly_scoped` with `scope.model.display_name` → weekly per model; `percent` is used 0–100, `resets_at` ISO. 0 tokens, ~5 s. Login kind from `system/init.apiKeySource` (`none` = subscription); plan from `claude auth status --json` `subscriptionType` (email dropped). Writes no transcript; user `SessionStart` hooks do run. |
| Claude · Terminal | our `statusLine` relay in the launch `--settings` | `rate_limits.{five_hour,seven_day}.{used_percentage, resets_at}` |
| Codex | one `codex app-server` process per app, `account/rateLimits/read` with `excludeResetCreditDetails: true`, `supportsLunaReserve` off | `RateLimitSnapshot {primary, secondary: {usedPercent, windowDurationMins, resetsAt} \| null, planType, …}`; window type by duration (300 min = 5-hour, 10080 = weekly), never by slot. Fails with an API key. |

Rules:

- Vendor payloads stop in `packages/transport/src/quota.ts`; the rest of the app sees `QuotaReading {id, kind: five-hour | weekly | weekly-model | other, model, minutes, remaining, resetsAt, exhausted}`. The host journals `quota.observed`.
- The `codex` binary is the one next to cached codex-acp, else `codex` from PATH; `claude` comes from PATH only. Without it that source is simply unknown.
- **Statusline relay.** Installed only when the person has their own status line (`cli-launch.userStatusLine`: local → project → user settings, `CLAUDE_CONFIG_DIR` or `~/.claude`, reading only the `statusLine` key; managed settings outrank ours). A static bundle script forwards `rate_limits` to the host via the hook relay and runs the person's status line with the same stdin, passing its stdout through unchanged; the host drops repeats. Without a personal status line none is installed (any status line hides TUI hints), and the task's quota comes from `/usage`. `rate_limits` in the status line is documented only for Pro/Max.
- **Never used:** `/api/oauth/usage` called directly, `~/.claude.json` `cachedUsageUtilization` (stale by construction), `/usage` inside a task session, parsing `/usage` or `/status` markdown, Codex rollout files.
- Claude quota is only as fresh as the last read; usage elsewhere (claude.ai, other terminals) shows on the next read. Every display therefore shows data age.

<a id="quota-store"></a>
### Quota store and refresh

`main/quota.ts` keeps one store per provider; a window is `QuotaReading` + `observedAt`.

| Trigger | Claude | Codex |
| --- | --- | --- |
| App start | complete read | complete read |
| Popover opens | read, at most once per 60 s per provider (the CLI also keeps a 60 s snapshot) | same |
| Background | every 10 min while the window is visible; a tick that fell on a hidden window runs when it becomes visible | same |
| Turns | every Claude turn's `rate-limit.changed` / `quota.observed` | after each completed Codex turn (if older than 15 s); while a Codex task was active in the last 10 min: every 60 s, then 30 / 15 / 5 s once the tightest window has < 25% / 10% / 1% left |
| Process | — | app-server stops after 5 idle minutes |

A failed read (the endpoint often answers 429) keeps the last values with their age. A window whose `resetsAt` is past is not shown. Tests pin a snapshot with `BRIGADIR_TEST_QUOTA`.

<a id="quota-display"></a>
### Quota display

- **Quota button** (`QuotaButton`): at the foot of the sections rail (30 px rings with the provider glyph inside, percent under) and on the New task sheet next to the agent choice. One gauge per provider that has a live window; a provider signed in with an API key is listed but has no gauge. Hover opens, click pins the `Subscription limits` popover (shared Popover with Esc).
- **Popover:** a block per provider with plan and data age (`updated just now` / `updated {time} ago`); a row per window — `5-hour limit`, `Weekly · all models`, `Weekly · {model}` (Codex: as many rows as its plan has windows) — with percent `left`, bar and reset phrase (`resets in {time}` for short windows, `resets {day}, {time}` for weekly, `reset time unknown`). API key: `Signed in with an API key. There is no subscription limit here.`
- **Tone** (`quotaTone`): normal from 25% left; amber below 25%; red below 10% or when exhausted (`Limit reached`). `allowed_warning` does not change colour by itself.
- **Stale** after 1 hour without new data (`QUOTA_STALE_MS`): rows dimmed, age amber.
- **Eye per window** (`Show in the indicator`): picks which window the gauge shows for that provider; selected eye in accent; clicking it again clears. Without a choice the gauge shows the tightest window; a chosen window that is currently absent is replaced by the tightest one while the choice stays. Stored globally in `<data>/quota-view.json` (`{schemaVersion: 1, watch: {claude, codex}}`).

<a id="rate-limited"></a>
### Behaviour at the limit

- Only `rejected` (`rate-limit.changed`) blocks the task, its prompt queue and composer; `allowed_warning` lets work continue. An unknown status word is ignored.
- Independent windows are kept in the journal. A known deadline closes with a durable `rate-limit.expired` record, not an invented `allowed`; an expiry with an old deadline never clears a newer rejection of the same window. An unknown reset keeps the block until a structured update.
- The task shows the hourglass with time to reset in the sidebar; the composer shows the chip `{agent} limit · {time}` whose popover opens by itself once per new reset time; the draft is kept.
- Queued messages stay queued and go automatically after the reset. An interrupted turn is never re-run without an explicitly queued message. Manual pause is separate and never cleared by a timer.
- A new rejection gives one urgent notification with the time; repeats and the following `session.failed` do not duplicate it.
- CLI (Terminal) tasks get no artificial limit from text or context usage.

<a id="catalog"></a>
## Model, effort and launch options

<a id="catalog-probe"></a>
### Catalog probe

- `probeAgentCatalog` (main, once per app run per provider) starts a session in a temporary folder with no prompt, records `session.started` options and modes, then sets each model in turn with `session/set_config_option` and stores the options the provider answers: `ProviderCatalog.byModel[model] = AgentOption[]`. Timeout 30 s; a model the provider refuses gets no entry.
- `templates:catalog` prefers the probe (cached for the run); a task's stored catalog is a fallback only when the probe fails. A failed probe is forgotten after 5 min (sign-in or CLI install needs no restart). `Check now` in CLI updates also forgets catalogs.
- `catalogOptions(catalog, model)` (`byModel[model] ?? options`) is the one source for the New task sheet, crew editor, template editor, crew roster warnings and `task:create` validation.

Observed per-model differences (why `byModel` exists): Claude Haiku has no effort; Codex `*-luna` lacks `ultra`, some older models stop at `xhigh`; the provider's current effort is not always the first level (Codex lists `Low` first but sets `High`).

<a id="launch-options"></a>
### Launch options on the sheet

1. **Model popup is exactly the provider catalog.** On open and after a provider change the first catalog entry is selected (Claude `Default (recommended)`, Codex the first model).
2. **Every option the provider advertises for the selected model** is shown as the same full-width popup, one per row under the model, in `orderAgentOptions` order: effort, mode, `Fast`, the rest (Codex `Collaboration mode`). Mode shows the choice name; others show `Name · choice`. `Fast mode` is an `On | Off` segmented toggle in its own rail group.
3. **Effort** starts at the provider's own value for that model; a model without effort shows no effort row; changing the model resets effort to the new model's default.
4. **Only changed options go into `launchOptions`** of the task (`{id, value}[]`, ≤ 128); otherwise the provider applies its own.
5. **Patient apply.** Options are set one by one, model first; an option the provider rejects after an earlier one is skipped, not a launch failure.
6. **Icons** (`ui/OptionIcon`, also in composer chips, template editor and crew inspector): effort — a disc filled by the level's position among that model's levels (`ui/EffortIcon`; provider `default` is a dot); mode — by a word in the value: question mark (`default`, `manual`, `ask`, `read-only`), pencil (`accept`, `edit`), list (`plan`), bolt (`auto`, `agent`), open lock (`bypass`, `full`), monogram for unknown; Fast — fast-forward, filled when on, outlined when off; other — `console`. The map is pictures only; it adds no behaviour.

<a id="builtin-role-models"></a>
### Built-in roles

Built-in roles (Foreman, Developer, Reviewer) accept provider, model and effort changes stored separately from code and overlaid on read; name, permissions, mode and instructions stay the app's. Changing a model in a template or crew node drops an effort the new model lacks. Details: [crew templates](crew-templates-and-editor.md).

<a id="one-shot"></a>
## One-shot calls

`oneShotText` (`packages/transport/src/one-shot.ts`): one prompt, one text answer, the process ends. No task, journal, `AgentEvent` persistence, MCP server or filesystem capability.

| Rule | Detail |
| --- | --- |
| Consumers | commit messages and commit split, PR title/description, PR summary, review word and verdict hint, branch names, project icon, next-prompt hint, relay summary, project knowledge. |
| Folder | helper calls run in `<data>/ghost`; `/usage` in `<data>/usage`. |
| Only on explicit action | Text the person sees is always editable before it acts (commit, PR); generation runs on a click, never on panel open, diff change or timer. Exception: background conveniences listed above and crew subtask acceptance commits (made by code under the approved plan). |
| Failure never blocks | No answer, crash or no provider → amber note, the action stays available with its fallback. Retry is a separate `Generate again` button; no automatic retries. |
| Prompts in English | The answer's language is inferred from the material (e.g. `git log --format=%B -20`), not from the UI language. Commit material: recent messages, `commit.template`, diff (`--stat` always, hunks within budget), `CLAUDE.md`. |
| Model and effort | `model` (exact catalog value) or `preferredModel` (name match); `effort` exact, else `lowestEffort` (first level that is not `default`). Text an adapter sends after an option change (e.g. `Auto mode unavailable…`) is discarded; only text after the prompt counts. |
| Guards | input ≤ 200 000 chars; output over `characterLimit` (default 12 000) fails; any tool call fails; default timeout 90 s (helper hints 15 s). |
| Quota | `stopAtRateWarning` stops background conveniences at a Claude `allowed_warning`; text the person asked for runs until the window is spent. Branch name and project icon are skipped when the provider's window is exhausted. Codex has no ACP quota events, so it stops only on an exhausted window. |
| Errors | Sign-in failure → `Agent sign-in required`. An adapter `Internal error` is extended with its `data.details` (e.g. a broken native binary), so the PR overview says `… : {reason}`. |
| No history left behind | After the answer, and also after cancel, timeout, quota stop or tool failure, the session is deleted with ACP `session/delete` when the agent advertises `sessionCapabilities.delete` (both do): Claude removes the transcript, Codex archives the thread (gone from ChatGPT Recents, kept in Codex's archive). Deletion runs in the background with a 3 s ceiling; the call returns at once. Task sessions are never deleted. |

PR patch for summaries and "Ask the agent": raw diff read up to 8 MiB, then `fitPatch` to the budget (summary 96 000, ask 48 000 chars): small files whole, the rest share what is left equally; a trimmed file keeps its header, ends on a whole line and says how many lines were removed.

<a id="helper-agent"></a>
### Helper agent and per-action agents

- **Helper agent** (`settings.helperAgent`, null = default): provider, model, catalog name, effort. Default target (`ghostDefaults`): Codex Luna; Claude Haiku when Codex is off or its known catalog has no Luna; before a catalog is known the model is matched by name during the call. A chosen provider that is off, or a model its catalog no longer lists, falls back to the default with a note in Settings. Effort null = lowest level.
- **Per-action agents** (`settings.actionAgents`): only changed actions are stored; key = action, value = same shape as `helperAgent`. Task actions: `review`, `reviewSuggestions`, `agentFix`, `conflicts` (inherit the Default agent; effort null = model default). Helper actions: `prSummary`, `reviewDrafts`, `commitMessage`, `prText`, `branchName`, `split`, `projectIcon`, `promptHint` (inherit the Helper agent). Slack actions (group `Slack`, shown while the Slack module is on): `slackAnswers` — `Slack: answers` (classifying a mention, the facts answer, a note summary; inherits the Helper agent) and `slackCode` — `Slack: code questions` (code questions and asking a task's agent; unset → the Default agent for code questions and the task's own provider when asking its agent). A file without the key, or a bad entry, reads as inherit (`migrateActionAgents`).
- **Resolution order** (`actionChoice`): one-time capsule choice → action agent → Default / Helper agent. A disabled provider is skipped; an action agent whose model a known catalog no longer lists is skipped (an unknown catalog never cancels a setting). Project knowledge stays with the Helper agent.
- **`Remember for …`** (`ui/RememberCheck`) in the in-place capsule and in the Agent section of `Review with an agent ▾`: unchecked — `Only this time. Default: Helper agent in Settings ▸ Agents.`; checked — every choice is saved to the action (`Saved in Settings ▸ Agents.`), and checking after a one-time choice saves it at once. Not remembered between dialog openings. Saved through its own IPC `settings:action-agent` (action, agent or null) that changes only that entry; denied to remote phone clients.
- **Settings ▸ Agents ▸ `Customize per action`** is described in [settings](settings-modules-and-onboarding.md).

<a id="adapter-cache"></a>
## Adapter cache and CLI updates

<a id="adapter-launch"></a>
### Adapter launch and cache

1. `claude-agent-acp` / `codex-acp` on `PATH` runs directly.
2. Else the newest **complete** install in the npx cache (`$npm_config_cache/_npx`, default `~/.npm/_npx`) runs directly. Complete = a semver `package.json` for the adapter, an executable `.bin` entry, and every package listed in `node_modules/.package-lock.json` has its own `package.json` (no lockfile = incomplete).
3. Else `npx --yes <package>`.

A minute after the window opens, main installs `@latest` of both adapters into the cache without running them (`npx --yes --package=<pkg>@latest -- node -e ''`, killed after 180 s); the new version is used from the next session start. Before that it deletes the provider's incomplete installs so npx downloads them again. Test runs with their own data dir skip this.

**Why.** Through `npx` every session paid a registry check and kept an `npm exec` parent alive (~2× memory). An interrupted download leaves a truncated native binary that npx would reuse forever (every spawn fails with EBADMACHO).

<a id="cli-updates"></a>
### CLI updates

| Aspect | Rule |
| --- | --- |
| What | `claude update` and `codex update` — the CLIs' own commands, found on the login-shell PATH, enabled providers only. The CLI knows how it was installed. |
| When | First check a minute after launch, then hourly; runs only if 24 h passed since the last check. Status in `<data>/cli-updates.json` (`{schemaVersion: 1, status: {checkedAt, results}}`). |
| Switch | Settings ▸ Agents row `CLI updates`: `Update in the background` (`agents.updateClis`, default on). It overrides Claude Code's own `autoUpdates: false`. |
| `Check now` | Ignores the switch and the 24 h gate; also refreshes the ACP adapters; afterwards re-reads agent status (versions) and forgets model catalogs so new models appear without restart. |
| Status line | `Not checked yet`, `Checking…` (button disabled), `Checked {time} · no new versions`, `{agent} updated to {version}` (comma-separated), amber `Could not update {agent}`; time as today / yesterday / date. Command output goes to the main log only. No toasts or notifications. |
| Running agents | Keep their version; the new one applies on their next start. Brigadir never restarts agents for an update. |
| Limits | One run at a time (a click joins a running one); 5 min timeout per command; a missing CLI is skipped; one failure does not stop the other; stdin closed immediately and `CODEX_NON_INTERACTIVE=1` for Codex. Outcome per CLI from `--version` before/after: `updated`, `current`, `failed`. |

<a id="concurrency"></a>
## Concurrent agents limit

- `agents.maxConcurrent`: null = unlimited, 1–99. Settings ▸ Agents `Concurrent agents` stepper, `Unlimited` at zero.
- Every start (new task, Start/Resume, Resume from a menu) passes the launch queue in main. Active = tasks `working` / `needs-you` plus just-launched ones still `queued`. Over the limit the task stays `queued`, its key is written to `launch-queue.json`, the window shows `Waiting for a free slot.` and the first prompt is not sent.
- Promotion in queue order after `turn.completed`, `session.failed`, `host.stopped`, host disconnect or settings change, plus a 3 s observer while the queue is non-empty; it starts the host and, for a GUI task without turns, sends the saved `task.prompt`. Stop on a queued task removes it (`interrupted`); a failed promotion is `interrupted`; a restart restores the queue for tasks still `queued`.
- The heuristic next-prompt hint and the model-written hint are described in [ghost suggestions](composer-steering-queue-and-ghost.md).

<a id="context-tools"></a>
## What the person is looking at: `editor_state` and `pr_state`

Two read-only tools of the `brigadir` server, input schema `{}`. The agent pulls state when it needs it ("fix this", "the selected code", "reply to this comment"); nothing is pushed per cursor move or added to prompts.

<a id="editor-state"></a>
### `editor_state`

- **`active`** — the active document of the focused editor group. With more than one group: `group` (1-based, tree order) and `groups[]` (each with `group`, `focused` and its visible document in the `active` format); with one group there is no `groups`.
- **`tabs`** — tabs of all groups without duplicates (`group` when several groups): file or diff, path relative to the task's work folder, unsaved changes. Tool tabs are `kind: terminal | browser | simulator` with `title` only (consoles are read with `console_read`, pages with `browser_*`).
- **File:** view `editor` or `markdown-preview`; `repo` (the task git root whose path is the longest prefix) and `repoPath` when that root is not the work folder; `cursor` `line:column` (1-based), `cursors` when there are several carets; `selections` — up to 16 non-empty ranges each with `lines`, `from`, `to`, `text`; visible lines; `dirty`; line count.
- **Diff:** `repo` (always), path, `source` (`changes`, `history`, `commit`, `pr`), base (`task` — task start, `head` — last commit, `turns N–M`, or the commit/PR label), view `unified` / `split`, visible lines, selected diff lines with side (`old` / `new`) and text, `selection.changed` (ranges that are changes on that side) and `selection.kind` (`added`, `removed`, `context`, `mixed`).
- **Held diff selection.** The renderer remembers the last diff selection per file even after focus moves to the composer or CLI console; a new selection replaces it; a click in the diff, Esc, a comment or closing the tab clears it; it survives diff remounts. The visible highlight still disappears when focus leaves the diff.
- **Right panel:** shown or not, tab `changes` / `files` / `prs`.

<a id="pr-state"></a>
### `pr_state`

- The PR open in the task's `Pull requests` panel; if none, the PR of the active tab when it is a PR file or PR overview.
- Number, title, URL, state, author, `head → base`, panel tab, `viewer` (the person's GitHub login).
- Threads (id, `file:line`, side, resolved/outdated, comments with author, time, text), general comments and reviews; items written by the viewer have `mine: true`.
- `drafts` — unsent review drafts of the project (agent drafts marked, discussion under each, agent replies `from: agent`); see [review drafts](pull-requests-and-ci.md).
- `files` — path, `change`, `additions`, `deletions`, `viewed`, `open` / `active`; up to 300, then `moreFiles`. `viewed: {n, of}`. `openTabs` — PR files in tabs of all groups.

<a id="context-flow"></a>
### Data path, limits and empty states

- **Path:** agent → host (`mcpRequest`) → main (`ui.request('context', {tool})`) → renderer via `context:request` with an id; the renderer answers through the named preload method `answerContextRequest(id, report)` (no generic invoke; main checks the sender and the shape with `isContextReport`). The renderer reads the task store (`useTaskState`, live even for a hidden task) and live sources of mounted surfaces (CodeMirror cursor and viewport, diff selection). Main adds repo-relative paths, the diff base from settings, the PR from the GitHub cache (20 s) and drafts from disk.
- **Privacy:** main asks only for the task whose session calls (the host maps the session token to the task; the agent passes no key); paths relative to that task, `repo` only from its scopes.
- **Limits:** selection text 20 000 chars shared across all selections (overflow: `truncated: true` and full `length`); PR comment text 4 000 chars each; up to 200 threads; up to 300 files. Renderer silent for 3 s → a call error with the reason.
- **Empty is an answer, not an error:** app window closed → `{window: "closed"}` and a sentence; task not selected in the window → `visible: false` with the last tab state; no tabs → empty list and a sentence; no PR → `{open: false}` and a hint (`Pull requests` panel, `⇧⌘P`); GitHub not answering → `error`, `files: []`.
- **Availability:** `editor_state` wherever human tools are allowed (solo sessions and the foreman); `pr_state` additionally requires the `Pull requests` module and disappears with it. Workers and the verifier have neither.
- **Brief and description:** each description says when to call it ("this", "here", "the selected code"); sessions with human tools get one English sentence about them in the brief.
- **Chat rows** (the only UI): `Reading the editor` / `Read the editor` / `Could not see your editor` and `Reading the PR` / `Read the PR` / `Could not read the PR`; module glyph `editor` or the PR branch; second line — active file `path:line` and `N lines selected` (four `uk` forms), for a diff path and base, `nothing is open`, `the window is closed`; for a PR `#N title` and thread count, `no PR is open`.

<a id="later"></a>
## Later

- Claude GUI on a subscription defaulting to Terminal (GUI only with an API key or as an explicit choice with the risk named).
- Distributing builds to other people only after written confirmation from Anthropic; until then Claude over ACP for them would need an API key, and the intro wording about API keys is revisited with it.
- Remote access limited to machines of the subscription owner (another person's access is account sharing).
- Usage history by day, model and task.
- `_session/goal` and `agentFileChangeReport` (advertised, unused).
- Codex `session_info_update.title` as the task title.
- Verify whether two Codex processes on one `~/.codex` race on token refresh; status line `rate_limits` on Team plans.

<a id="non-goals"></a>
## Non-goals

- A Brigadir-owned registry of provider capabilities, modes or models.
- Brigadir's own login UI or reading/storing agent tokens.
- Dollar cost display on subscriptions.
- Mixing two providers in one host process.
- Auto-approving permissions or answering human questions with placeholders.
- A Brigadir system prompt separate from MCP instructions and the first-prompt brief.
- Proxies or account rotation around provider limits.
