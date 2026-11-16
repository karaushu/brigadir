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

- **Events** (`AgentEvent.kind`): `session.started`, `session.info`, `session.failed`, `message.delta` (roles `assistant`, `thought`, `user`), `tool.changed`, `plan.changed`, `plan.document`, `plan.removed`, `options.changed`, `mode.changed`, `commands.changed`, `usage.changed`, `context.compacted`, `turn.usage`, `rate-limit.changed`, `quota.observed`, `permission.requested`, `subagent.started`, `subagent.changed`, `background.started`, `background.changed`, `turn.completed`, `unhandled`. The host adds its own boundary records (`turn.started`, `host.stopped`, `rate-limit.expired`, …) and the [budget](#budget-reached) records `budget.reached` and `budget.decided`.
- **Commands** (`AgentCommand.kind`): `prompt`, `cancel`, `setMode`, `setOption`, `stopBackground`. Host-level session commands include `retryTurn` (see [sign-in recovery](#sign-in-recovery)).
- **Tool patches.** A patch with a missing field keeps the previous value; an empty array clears the field. Boolean options and grouped selects are kept as the agent sent them.
- **Parentage.** `_meta.claudeCode.parentToolUseId` (also on a subagent's message chunks) lives on the event record envelope, not on the event.
- `usage.changed` carries `used`, `capacity` and the adapter's `cost`; cost is never displayed (see [usage](#usage-principles)).
- <a id="context-compacted"></a>`context.compacted` says the agent compacted its context: `before` and `after` are the context sizes in tokens around the compaction, each a non-negative integer or null when the adapter gave none. It comes once per compaction that the adapter reports as completed ([compaction signal](#compaction-signal)), and the chat shows it as a [service row](chat.md#context-compacted). For a crew member, the host then gives the member's current assignment back ([Crew](crew.md#assignment-after-compaction)).
- <a id="turn-usage"></a>`turn.usage` carries the tokens of one finished turn as the adapter reported them in the `session/prompt` result: `input`, `output`, `cacheRead`, `cacheWrite` (non-negative integers; a missing counter is 0). It is journaled just before that turn's `turn.completed`, and not at all when the result has no `usage`. The [token counter](#task-tokens) and the crew report ([Crew](crew.md#reports)) sum it.

<a id="acp-connection"></a>
### Connection lifecycle

One `AgentTransport` owns exactly one adapter process and one session; the host owns persistence and task identity.

- **Framing.** Newline-delimited JSON-RPC over stdio, ACP `protocolVersion: 1`, `@agentclientprotocol/sdk` 1.4.0. Another protocol version fails the start. The SDK sends request params as given, so fields newer than its types (`systemPrompt`, `session.compaction`) reach the adapter unchanged.
- **`initialize` client capabilities:** `fs.readTextFile` / `fs.writeTextFile` (true when the host supplies handlers, so an agent can read unsaved editor buffers), `terminal: false`, `plan: {}`, `session: {compaction: {}}` ([compaction signal](#compaction-signal)), and `subagents: {}` added on the wire. `clientInfo.name` is `brigadir`.
- **Start timeout** 60 s (`startupTimeoutMs`). A human permission or question has no timeout.
- **Session open.** `session/new` with `cwd` (absolute), `additionalDirectories` (deduplicated, absolute, only when the agent advertises `sessionCapabilities.additionalDirectories` — this is how monorepo scopes reach the agent structurally), and `mcpServers`. Resume uses `session/load` (requires `loadSession`). Fork uses `session/fork`, then `session/resume` or `session/load` when the fork answer carries no options; a failed fork falls back to a new session. When the agent advertises `sessionCapabilities.systemPrompt`, each of these requests carries the [session brief](#session-brief) as `systemPrompt` in `append` mode.
- **Claude raw SDK messages.** Claude sessions always pass `_meta.claudeCode.emitRawSDKMessages` with `rate_limit_event` plus `system` subtypes `session_state_changed`, `task_started`, `task_updated`, `task_notification` (agent-started turns and background tasks, see [turns](chat-turns-plans-and-questions.md)).
- **Permissions.** Cancel, connection close or stop answer `cancelled` and never become approval. A chosen option must be one of the offered ids. A `preapprove` hook may pick an option with no event and no card (used for [our own tools](#tool-permissions)).
- **Steering.** `_meta.steering.supported` of `initialize` enables `_session/steering`; see [steering](composer-steering-queue-and-ghost.md).
- **Stop.** The adapter runs in its own process group; close sends `SIGTERM` to the group, then `SIGKILL` after 1.5 s.
- **Adapter environment.**
  - Claude: `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` (the SDK session otherwise has no plan tool); with our MCP server, `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` = 7 days; `CLAUDE_CODE_AUTO_COMPACT_WINDOW` = the [compaction window](#compaction-window). A value the person set is kept.
  - Codex: `CODEX_CONFIG` merged over the person's own value: `tools.update_plan.enabled = true`, `model_auto_compact_token_limit` = the [compaction window](#compaction-window), and full stdio descriptions of every MCP server in `mcp_servers`, with `tool_timeout_sec = 604800` for `brigadir` only. `session/new.mcpServers` is then `[]` (codex-acp overwrites `mcp_servers` from ACP and would drop the timeout). `~/.codex/config.toml` is never touched.

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
| Capabilities | `promptCapabilities {image, embeddedContext}`, `mcpCapabilities {http, sse}`, `loadSession`, `sessionCapabilities {additionalDirectories, close, delete, fork, list, resume, systemPrompt}` (`systemPrompt` takes `append` and `override` on new, load, resume and fork), `_meta.claudeCode.promptQueueing`. `_meta` also carries `steering`, `goal` (`_session/goal`, unused) and `jetbrains.air` (`sessionFailure`, `agentFileChangeReport`; neither sends anything in practice). `initialize` carries no quota. |
| Modes | One axis: `mode` is both `modes.availableModes` and a config option: `auto` (classifier decides permissions; default), `default` (Manual), `acceptEdits`, `plan`, `dontAsk`, `bypassPermissions`. In `auto`, `session/request_permission` is rarely called. |
| Config options | `select` options with `id`/`category`/`name`/`description`/`currentValue`/`options[]`: `mode`, `model` (first entry `Default (recommended)`), `effort` (`default`, `low` … `max`, per model), `fast` (`on`/`off`). A generic renderer draws all of them. |
| Messages | `agent_message_chunk` grouped into one row by `messageId`. |
| Tool calls | `tool_call` / `tool_call_update` with `toolCallId`, `status`, `title`, `kind`, `locations[{path,line}]`, `content`, `rawInput`, `_meta.claudeCode.toolName`. The human description is `_meta.claudeCode.title` (the protocol `title` is the raw command). Observed `kind`: `read`, `edit`, `execute`, `think`, `other`, `human`; read-vs-mutation collapse uses `kind`, not tool names. |
| Output | No streaming of command output: the whole output arrives in one `tool_call_update` with `status: completed`. |
| Subagents | RFD form (our client): `subagent_update` announces and patches a child session (`title`, `description`, `state`), `session_message` carries its prompt and hand-back, the `Agent` call is hidden. Draft form (AIR): `subagent_spawned` / `subagent_state_update`, launcher `toolResponse` with `isAsync`, `agentId`, `resolvedModel`, totals. Nested events carry `parentToolUseId`. See [subagents](chat.md#subagent-transport). |
| Commands | `available_commands_update` lists slash commands with descriptions, project commands included. |
| Usage | `usage_update {used, size}` for the context ring; `session/prompt` result `usage {inputTokens, outputTokens, cachedReadTokens, cachedWriteTokens, totalTokens}`; `_meta.quota.model_usage[]` per model including subagents. |
| Rate limit | `usage_update._meta["_claude/rateLimit"]` (see [quota sources](#quota-sources)). |
| Auth failure | `session/new` passes; `session/prompt` sends one assistant line with the CLI text, then fails with `RequestError` −32000 (`authRequired`). |
| Compaction | `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (clamped to 100k–1M) wins over `autoCompactWindow` in the person's settings. Compaction fires about 33k below the window: near 167k at 200k, near 967k on a 1M model without the variable. With `session.compaction` declared, a compaction is `compaction_update` (`in_progress`, summary chunks, `completed`, often sent twice), then `usage_update` with the retained size; sizes and trigger travel only in a JetBrains `_meta`. Without the capability it is a `Compact conversation` tool call (`kind: think`, facts in `rawOutput`). The appended system prompt is re-sent with every request and came back verbatim after two compactions; text of the first user message survives only as the summary quotes it. After about 54 idle minutes with a context of at least 200k the adapter sends `/compact` itself. |
| Transcripts | ACP sessions are persisted by the CLI to `~/.claude/projects/<escaped-cwd>/<session-id>.jsonl`. |

<a id="subagent-model"></a>
### Subagent model

A Claude session's own subagents (search, reading, summaries) run on the session's model unless told otherwise. `agents.claudeSubagentModel` (Settings ▸ Agents ▸ `Subagent model`; null = `Same as the agent`) is a model value from the Claude catalog. The host reads it from `settings.json` when it starts an agent and passes it to the adapter as `CLAUDE_CODE_SUBAGENT_MODEL`; a value the person set in the environment stays. It applies to sessions started after the change, to every Claude task, crew members included. Such a session also gets one sentence in its first-prompt brief (`subagentBrief`): subagents run on their own model, so they get the work whose mistakes are cheap to spot (finding files, reading logs and long output, running tests), while edits and decisions stay with the agent, which checks a subagent's answer against the code before acting on it. Terminal sessions get neither the variable nor the sentence. **Why:** a foreman on the strongest model otherwise reads files at that model's price, and a mistake in a search is cheap to spot.

<a id="compaction-window"></a>
### Compaction window

`agents.compactionWindow` (Settings ▸ Agents ▸ `Compaction window`) is the context size in tokens at which a session Brigadir starts compacts its context. The menu offers `Agent's default` (null: nothing is passed), 100k, 200k and 400k; the default is 200k, and a settings file without the key reads as 200k. A saved value from 100k to 1M that the menu does not list stays shown as it is. The host reads it from `settings.json` when it starts an agent and passes it to the transport:

- Claude: `CLAUDE_CODE_AUTO_COMPACT_WINDOW`. Claude compacts about 33k under it.
- Codex: `model_auto_compact_token_limit` in `CODEX_CONFIG`. Codex compacts when the context reaches it.

A value the person set wins, and then nothing is passed:

- Claude: the variable in the environment; `autoCompactWindow`, or `env.CLAUDE_CODE_AUTO_COMPACT_WINDOW`, in `settings.json` of the Claude config folder (`CLAUDE_CONFIG_DIR`, else `~/.claude`) or in `.claude/settings.json` / `.claude/settings.local.json` of the session folder.
- Codex: the key in the person's own `CODEX_CONFIG`, or a `model_auto_compact_token_limit` key, in any table, in `config.toml` of `CODEX_HOME` (else `~/.codex`) or in `.codex/config.toml` of the session folder. Only real keys count: the same text inside a string (multi-line ones included), a comment or an array is not one.

A file that does not exist or cannot be parsed sets nothing. The window is fixed for an adapter process, so the setting applies to sessions started after the change: every GUI task, crew members included. Terminal sessions do not get it. **Why:** models with a 1M window otherwise compact near 967k, and every tool call of a long session re-reads that context.

<a id="session-brief"></a>
### Session brief

Every GUI session gets one brief, built by `sessionBrief` (`packages/host/src/crew.ts`) when the host starts: the crew role brief, the task's agent role and the tool sentences (checklist, plan, subagents, project commands, tool modules). It is built from `task.json` and the settings, never from the conversation, so it stays the same for the session.

- When the agent advertises `sessionCapabilities.systemPrompt`, the brief goes as ACP `systemPrompt` (`{mode: "append", content: [{type: "text", text}]}`) on `session/new`, and again on every `session/load`, `session/fork` and `session/resume`. Claude appends it to its own system prompt and Codex to its developer instructions. The system prompt is re-sent with every model request, so the brief survives compaction word for word.
- Otherwise the brief goes as the hidden `Brigadir brief` `.context` block of the session's first prompt.
- When the agent rejects the `systemPrompt` as invalid params, the transport repeats that request without it, and the brief goes as `.context` of the next prompt. This holds for a `session/load` after a restart as well: the brief rebuilt by the new host still reaches the agent.
- Either way, the transcript and the journal never show it.
- A crew part prompt, a review batch and the scope manifest are prompts, not the brief: they change during the session. After a compaction the host gives a crew member its current assignment again as a hidden `.context` block ([Crew](crew.md#assignment-after-compaction)).
- Claude keeps the system prompt it got at the session's first request. A brief that changed on a later load (a setting changed between two host starts) takes effect after the next compaction.

<a id="compaction-signal"></a>
### Compaction signal

`initialize` declares `clientCapabilities.session.compaction: {}`, so both adapters report a compaction as ACP `compaction_update` (one `compactionId`: `in_progress`, then `completed`, `failed` or `cancelled`) instead of a `Compact conversation` tool call. The transport:

- turns each compaction of the session that reaches `completed` into one `context.compacted`. `before` is `used` of the last `usage_update` before the compaction. The event goes on the event chain with the next update of the session that is not about the compaction: when that is a `usage_update`, `after` is its `used` (Claude sends one at once with the retained size) and the event goes ahead of its `usage.changed`; when it is anything else, or the turn ends first (`turn.completed` or `session.failed`), `after` is null (Codex reports usage only after its next request);
- ignores the other statuses, `compaction_summary_chunk` (the summary is neither shown nor journaled), the compactions of a subagent's session and those replayed while `session/load` runs.

codex-acp completes a compaction when its `contextCompaction` item ends (`thread/compacted` from an older Codex). A compaction still running when the turn ends is finished `failed` or `cancelled`, so it gives no `context.compacted`.

Journals written before the capability keep their `Compact conversation` tool rows.

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
| System prompt | `sessionCapabilities.systemPrompt: {}`: `append` mode with text blocks only, on new, load and fork. It is joined to the configured `developer_instructions`; a changed one on a loaded, busy thread is refused. |
| Compaction | Config key `model_auto_compact_token_limit` (also `model_auto_compact_token_limit_scope` and `model_post_turn_compact_threshold_percent`, unused). With `session.compaction` declared, `compaction_update` without sizes; the sizes come from `usage_update`, sent after each request. A compaction under a configured limit was not observed in a run. |
| Permissions | None requested in `agent` mode for reads, commands or edits in the work tree. |

<a id="mapper-rules"></a>
### Mapper rules for both adapters

1. `ToolCall.headline` / `extraTitleLines`: the first non-empty line of the display title and the count of the rest. Rows, the turns strip and search use the provider's tool name, else `headline` — never the full title. A row without a tool name shows a path not in the headline plus `+N lines`; the full command text opens in the output under the row.
2. `rawOutput` as an object is read through `formatted_output`; Claude's string form is read as is.
3. An edit without `locations` takes paths from the `content` diff blocks; a preview patch is synthesised from `oldText`/`newText` as one hunk without file headers, only when `rawOutput` is empty.
4. A non-zero `_meta.terminal_exit.exit_code` turns `completed` into `failed`.
5. MCP calls are recognised from either spelling (`mcp__<server>__<tool>` or `mcp.<server>.<tool>`) by `mcpCall`, without knowing the provider.
6. A compaction is `context.compacted`, never a tool row ([compaction signal](#compaction-signal)).

No provider-specific row renderer exists; both adapters go through the one row engine.

<a id="client-mcp"></a>
## Brigadir's MCP server

The host passes its own stdio MCP server `brigadir` in `session/new` (`{name, command, args, env: [{name, value}]}`; for Codex through `CODEX_CONFIG`, see above).

- The adapter spawns the process itself and speaks MCP over stdio (`initialize`, `notifications/initialized`, `tools/list`, `tools/call`).
- The agent sees tools as `mcp__brigadir__<tool>`; Claude loads them deferred through `ToolSearch`, so a long tool list costs little context.
- `tools/call` carries `_meta["claudecode/toolUseId"]`, which links a call to its transcript row without our own correlation ids.
- Text results (`content: [{type: "text"}]`) reach the agent verbatim; our tools answer JSON.
- A tool without parameters (`editor_state`, `pr_state`) may be called without `arguments`.

Tool families: crew ([crew](crew.md)), human (`ask_user`, `create_task`, `tasks_list`, `task_send` — [tasks](tasks.md), `propose_review`, `request_review`, `review_reply` — [reviews](reviews.md), `add_folder`, `slack_post` — [Slack](notifications-slack-notes-and-schedules.md#slack-agent-post)), browser and simulator ([browser and simulator](browser-and-simulator.md)), `commands_*` ([project commands](search-menus-and-commands.md)), `console_*` ([console](terminal-and-cli-agents.md)), `pr_comment` / `pr_comment_reply` ([pull requests](pull-requests-and-ci.md)), `editor_restart_language_servers` ([code intelligence](editor-code-intelligence.md)), and [`editor_state` / `pr_state`](#context-tools). Each call renders as an MCP row in the chat ([chat](chat.md)).

<a id="tools-awareness"></a>
### Agents know their tools

- **MCP `initialize` carries `instructions`** in English, built by `toolsInstructions(role, modules)` from the enabled modules and the session role: a real browser, the project's simulator and saved project commands exist; after UI changes open the page (`browser_open`), check it (`browser_ui`, `browser_screenshot`) and act (`browser_act`); use `simulator_*` for React Native, where `simulator_act` already waits for the screen and lists what changed and `simulator_wait` replaces sleeping, `device` asks for a kind of device (`iPhone`, `iPad`, `Android`, a model) and a crew worker gets its own device and its own Metro port; run dev servers, builds and tests through `commands_*`, not the shell; do not ask the person to check what the agent can check; the person sees every action. A crew developer is told to open the page or the device when its task prompt asks for a check there: its part is proved by the command its prompt names ([Checks in the running app](crew.md#smoke)). A disabled module is not mentioned.
- **First-prompt brief** (`sessionBrief`) repeats it briefly (`toolsBrief`) for Codex and CLI sessions, which may not show MCP instructions to the model. The commands sentence goes to every session where the Commands module is on and commands are saved.
- **Foreman brief** names the crew's tools (`crewToolsBrief`) and how a plan uses them: a part that needs a dev server, a build or the tests runs them as project commands; a check in the running app is one smoke by one agent on the integrated work, not a step of every part ([Checks in the running app](crew.md#smoke)).
- **Tool descriptions** say when to use a tool, not only what it does (`whenToUse` table in `host/src/mcp.ts`).
- **Workers** (developer, verifier, lead) get the browser (their own task's tabs) and commands (run in the worker's folder). `ask_user`, `create_task`, `tasks_list`, `task_send`, `propose_review`, `review_reply`, `add_folder`, `slack_post`, `editor_state`, `pr_state` stay with the foreman and solo agents (`humanToolsAllowed`).
- **Simulator queue** (`main/simulator-queue.ts`): one lane per device. Each task holds a lease on one device ([Devices and leases](browser-and-simulator.md#sim-lease)), and a crew worker gets a device of its own when one can start, so workers on different devices never wait for each other. Tasks whose leases are on the same device take turns in its lane: the first call takes the device; others wait, and their card shows `Waiting for the simulator` as its second line (sent as `simulator:event` with the waiting tasks of the project across all lanes, not persisted). The foreman and solo agents never take a device from a worker but queue ahead of all workers in that lane (among themselves in request order). The holder releases on `turn.completed`, `session.failed`, `host.stopped`, or 60 s after its last call ends. A waiting call waits up to 60 s, then gets "simulator busy, retry later". `simulator_state` does not queue.

<a id="tool-permissions"></a>
### Tool permissions

| Rule | Detail |
| --- | --- |
| No agent permission card for our tools | When the adapter asks permission for a tool of the `brigadir` server (`skipsAgentPermission` in `core/mcp-tools.ts`), the transport answers `allow_once` with no `permission.requested` event and no card. A tool of another server with the same name is not covered. |
| The host asks where consent matters | External domain in `browser_open` / `browser_act`; a project command without `agentRuns`; a folder in `add_folder` (git or not, e.g. `Add docs to the task · read only`); `slack_post` (`Post to Slack as <bot> · <channel>`) unless `agents.slackPostWithoutAsking`. |
| No consent at all | `ask_user`, `create_task`, `task_send`, `propose_review`, `review_reply`, `propose_plan`, `ask_foreman`, `post_note`, `prompt_task`, `create_worker_task`, `submit_review`, `approve`, `accept_task`, `pr_comment`, `pr_comment_reply`, `simulator_open`, `simulator_act`, and all reads. |
| `readOnlyHint: true` | `browser_state/read/console/network/screenshot/ui`, `simulator_state/ui/wait/screenshot/logs/network`, `editor_state`, `pr_state`, `commands_list`, `commands_output`, `console_list`, `console_read`, `tasks_list`, `task_status`, `read_report`, `read_transcript`, `read_diff`, `read_notes` — so Claude calls them in Plan mode like `Read`. |

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
| Tokens a task used, per provider, against its budget | composer environment line, sidebar card, `Task usage` popover ([task tokens](#task-tokens)) |
| What the account's remaining share did while a task ran | foot of the `Task usage` popover ([quota while a task ran](#task-quota-span)) |

- **No dollars on a subscription.** The adapter's `cost` is synthetic; it is carried in `usage.changed` but never displayed.
- **The number is always what is left** (`1 − utilization`); the bar shrinks with it.
- **Quota is global**, per provider account. No share of it is ever attributed to a task or a project: other tasks, other terminals and claude.ai draw on the same windows. What a task shows is the account's remaining share when the task started and now, labelled as the account's.
- **Tokens are per task and exact only at a turn end.** A finished turn's `turn.usage` is exact; a running turn has only an estimate, always marked `≈`.
- **No data → no indicator.** A quota that lies is worse than none; no timer is ever derived from context usage or error text. A task whose agents reported no usage shows no counter.

<a id="task-tokens"></a>
### Tokens of a task

- **What is counted.** For each finished turn: `input + cacheWrite + output` of its `turn.usage` — the text the model took in for the first time and the text it wrote. **Cache reads are not counted.** Every model call re-reads the whole context from the prompt cache, so cache reads count the same text again on each call: on recorded crew journals they were 30 to 200 times everything else (one task: 418m cache reads against 1.96m counted). A budget of millions means something only for new text. Cache reads cost a subscription about a tenth of new input per token, so on a long session they can still be most of what the account is charged; the [account line](#task-quota-span) shows that cost as it is.
- **The parts** stay available: the provider line's tooltip in `Task usage` says `New input {a} · written to cache {b} · output {c} · re-read from cache {d}, not counted`.
- **Running turn: an estimate.** While a turn runs, the count adds the growth of the context during that turn: the sum of every rise of `used` between consecutive `usage.changed` records since its `turn.started` (a fall, a compaction, adds nothing). The turn's `turn.usage` replaces the estimate. On recorded journals the growth was 55–100 % of the exact figure of the same turn (median 77 % for Claude, 93 % for Codex) and lower when a turn ran subagents (their context is not in `used`) or rewrote an expired cache. A count that holds an estimate is shown with `≈`; the mark goes when no turn it includes still runs.
- <a id="opening-share"></a>**A session's opening.** The first `used` of a session that arrives inside a turn is its opening: the system prompt, the tools, a loaded history. Much of it is often already in the provider's cache from other sessions, and cache reads are not counted, so the opening adds only a share of itself: the share the provider charged the last time. At that turn's `turn.usage` the host learns the share the opening cost (`input + cacheWrite + output` less the growth after the opening, divided by the opening, 0 to 1) and keeps it per provider in `token-openings.json` in the data folder (`{schemaVersion: 1, providers: {claude?, codex?}}`); a host takes it at start, unless its own journal taught it one. With nothing learned yet the opening counts whole. On a recorded fresh Claude task the opening was 49k and the turn's exact count 25.7k: with the learned share the estimate is within 3 % of it, and the whole opening would be nearly double. An opening that arrives between turns (a session loaded before the next prompt) adds nothing.
- **Whose tokens.** A task's count is the sum over its own agent and every task that carries its id as `crewTaskId`: a crew's foreman, leads, workers and reviewers, and the reviewers of a solo task's own review ([Reviews](reviews.md#reviewer-sessions)). It is kept per provider, from each member task's `provider`.
- **Where it lives.** Each host keeps its own task's figure in `task.json` as `tokens` (`input`, `cacheWrite`, `output`, `cacheRead`, the running estimate, whether a turn runs, and its [account readings](#task-quota-span)); it writes it at turn boundaries and, during a turn, at most every 3 s and only when the short number changes. Summing over members is a pure function in `packages/core/src/task-tokens.ts`, used by the views and by the host that checks the budget, so a member's own figure is never summed twice. Old tasks without the field count from their journal the next time their host runs. A figure left on disk by an earlier host (a first turn cancelled without usage) is rewritten from the journal, down to zero.
- **Format.** `formatTokenCount` (`620k`, `1.2m`).

<a id="task-budget"></a>
### Task budget

- **A budget is tokens per task, per provider.** Claude tokens on a subscription and Codex tokens on a key cost differently, so there is no common threshold. A provider without a budget has no limit.
- **Default** in Settings ▸ Agents, `Task budget`: one popup per enabled provider with `No limit`, `500k`, `1m`, `2m`, `5m`, `10m`; `No limit` by default (`agents.taskBudget`, `{claude, codex}`, null for no limit). A task created after the change takes it into its `task.json` as `tokenBudget` (`{claude?, codex?}`); tasks that exist keep theirs. Old tasks have no `tokenBudget` and no limit.
- **Per task** the same popup stands in the provider line of the `Task usage` popover. It changes this task's budget at once (`setTokenBudget`), never the default; the budget belongs to the crew's root task and covers every member. A member task's own `tokenBudget`, if any, is never used.
- **Near** is 80 % of a provider's budget; **reached** is at or above it.

<a id="budget-reached"></a>
### Reaching the budget

- **When.** The root task's host checks the count after each of its own `turn.usage` and `usage.changed` (at most once a second), every 3 s while a budget is set (members' figures come from their `task.json`), and right before it starts anything, so a turn whose exact usage passes the budget is asked about before the next queued message runs. When any provider's count reaches its budget, the host journals `budget.reached` (`id`, `provider`, `tokens`, `budget`, `estimated`) and the whole task pauses, whatever the other provider's count.
- **Overshoot.** A count that passes the budget in the middle of a turn asks at once, from the estimate. Running turns are not stopped by the question, so the task can end above its budget by what those turns still use; an estimate that runs low (see above) asks later than the exact count would.
- **What pauses.** Nothing new starts: the root's prompt queue and every member's queue hold their messages (a message sent meanwhile is queued, also one sent to a member); crew deliveries (reports up, parts, reviews down) wait in the receiving task's queue; new hires wait for their launch; steering is refused, and a message already held for the running turn goes to the queue instead of into the turn; `Retry` of a failed turn is refused (the automatic retry after a sign-in leaves it for later). Turns that run now finish. ACP can cancel a turn but not suspend it, so a pause is never a suspension of a running turn. Each member reads the root's hold from the root's `task.json` (`tokenHold`) before it starts or hires anything (an idle lead too) and every 3 s while it works or is held. The person's manual queue pause ([queue](composer-steering-queue-and-ghost.md#queue-deck)) is separate and is not changed.
- **The question** is one card in the chat and, while it waits, a strip above the composer ([question card](chat-turns-plans-and-questions.md#budget-card)). The task is `needs-you` with its own reason, `{Provider} budget reached` ([Sidebar](sidebar.md#activity-line)).
- **Answers** (`decideBudget`), journaled as `budget.decided` (`id`, `decision`, `budget` for a raise):
  - `raise` — `Raise to {n}`: the provider's budget becomes `n`, the next value above both the budget and the count (`1m`, `2m`, `3m`, `5m`, `10m`, `20m`, `50m`, `100m`); the split button's menu lists it and the next two, then `No limit for this task`. Everything held resumes.
  - `unlimited` — `No limit for this task`: the provider's budget is removed. Everything held resumes.
  - `finish` — `Finish turns, then stop`: running turns finish; the task stays paused at its budget.
  - `stop` — `Stop now`: running turns of the root and of every member are cancelled; the task stays paused at its budget.
- **Changing the budget in the popover** while the question waits answers it: a value above the count (or `No limit`) is a `raise` (`unlimited`), a value at or below it asks again with the new figures (a new `budget.reached`; the earlier card folds), so `Finish` and `Stop` hold at the budget that is set. After `finish` or `stop` the task stays paused until its budget for that provider changes; a change lifts the pause, and a count still at or above the new budget asks again.
- **Resuming** runs everything that was held in its own order: the root's queue first in FIFO order, waiting hires in the order they waited, each member's queue in its FIFO order as the member sees the hold lift (within 3 s).
- **After a restart** the hold is rebuilt from the journal and the budget: a `budget.reached` without a later `budget.decided` still waits, and a `finish` or `stop` still holds while the budget is unchanged. `budget.reached` is never journaled twice for one pause.

<a id="task-quota-span"></a>
### Quota while a task ran

The foot of `Task usage` shows, for each provider whose sessions in the task journaled `quota.observed`, the account's remaining share of the 5-hour and the weekly window at the task's first reading and at its latest: `Claude · 5-hour limit 71% → 52%` under the caption `Account limits since the task started`. It is the whole account's share, not the task's: anything else on the account moved it too. When the window reset after the task's first reading, the first reading of the current window is used and the row says `since it reset`. Each host keeps its first reading, its first reading of the current window and its latest one in `tokens`; nothing new is fetched. Codex quota is read by the app, not by a task's session, so a Codex-only task has no such row.

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
- **Per-action agents** (`settings.actionAgents`): only changed actions are stored; key = action, value = same shape as `helperAgent`. Task actions: `review`, `reviewSuggestions`, `taskReview` (`Code reviews`: the reviewer of mid-task and before-PR reviews, also takes a crew; unset → `Auto` — [who reviews](reviews.md#who)), `planReview` (`Plan review`; unset → `Auto`), `agentFix`, `conflicts` (inherit the Default agent; effort null = model default). Helper actions: `prSummary`, `reviewDrafts`, `commitMessage`, `prText`, `branchName`, `split`, `projectIcon`, `promptHint` (inherit the Helper agent). Slack actions (group `Slack`, shown while the Slack module is on): `slackAnswers` — `Slack: answers` (classifying a mention, the facts answer, a note summary; inherits the Helper agent) and `slackCode` — `Slack: code questions` (code questions and asking a task's agent; unset → the Default agent for code questions and the task's own provider when asking its agent). A file without the key, or a bad entry, reads as inherit (`migrateActionAgents`).
- **Resolution order** (`actionChoice`): one-time capsule choice → action agent → Default / Helper agent. A disabled provider is skipped; an action agent whose model a known catalog no longer lists is skipped (an unknown catalog never cancels a setting). Project knowledge stays with the Helper agent.
- **`Remember for …`** (`ui/RememberCheck`) in the in-place capsule and in the launch dialog of `Review with an agent…`: unchecked — `Only this time. Default: Helper agent in Settings ▸ Agents.`; checked — every choice is saved to the action (`Saved in Settings ▸ Agents.`), and checking after a one-time choice saves it at once. Not remembered between dialog openings. Saved through its own IPC `settings:action-agent` (action, agent or null) that changes only that entry; denied to remote phone clients.
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
- A budget in time or money next to the token budget; a forecast of when a task reaches its budget.
- `_session/goal` and `agentFileChangeReport` (advertised, unused).
- Codex `session_info_update.title` as the task title.
- Verify whether two Codex processes on one `~/.codex` race on token refresh; status line `rate_limits` on Team plans.
- Compaction at the turn boundary: when a turn ends with the context near the [compaction window](#compaction-window) and nothing is queued, the host sends `/compact` before the next prompt. An automatic compaction in the middle of a turn was measured as mostly uncached; one at a turn boundary is several times cheaper. It needs a marker on the host's own `turn.started` so the chat draws it as a service row, crew hosts that do not take that turn's end for a worker's report, a trigger point per provider (Claude compacts about 33k under the window, so 80 % of 200k leaves only 7k), and a check of Codex's own `model_post_turn_compact_threshold_percent`.
- Verify a Codex compaction at the configured limit in a live run.

<a id="non-goals"></a>
## Non-goals

- A Brigadir-owned registry of provider capabilities, modes or models.
- Brigadir's own login UI or reading/storing agent tokens.
- Dollar cost display on subscriptions.
- Mixing two providers in one host process.
- Auto-approving permissions or answering human questions with placeholders.
- A Brigadir system prompt other than the appended [session brief](#session-brief) and MCP instructions.
- Proxies or account rotation around provider limits.
