# Chat (activity view)

The chat is the task's conversation surface: a virtualized log of the person's messages, the agent's answers, thoughts, tool calls, subagents and crew events, drawn by the same row engine as the diff panel. It folds routine work (runs of tool calls, thoughts, subagents) into one-line rows, keeps failures and live work visible, and turns paths, URLs and code in answers into working links and blocks.

Related: turn rail, turn status row, turn footer, plan and question cards — [Turns, plans and questions](chat-turns-plans-and-questions.md); the composer under the log — [Composer](composer.md); held and queued messages — [Steering and queue](composer-steering-queue-and-ghost.md); permission cards — [Agents and providers](agents-and-providers.md); the diff engine — [Diff and review](diff-and-review.md); PR links — [Pull requests and CI](pull-requests-and-ci.md).

<a id="row-engine"></a>
## Shared row engine

One renderer, `renderer/ui/Rows.tsx`, serves both heavy surfaces: the conversation and the diff. Virtualization, scrolling, following, find and keyboard targets are written once.

| Property | Behavior |
| --- | --- |
| Rows | Heterogeneous, variable height; only visible rows mount. Unmeasured rows use `estimatedHeight` (64 px) for offsets but are never painted at the estimate: a mounting row is measured in a layout effect before paint. |
| Measurement | Each row is a `flow-root` (children's margins count in its height). One shared `ResizeObserver` reports size changes and flushes before paint. |
| Width change | The size cache is cleared, then the already-mounted rows are re-measured immediately (their observers may not fire again); off-screen rows are re-measured when they mount. |
| Re-render | A row re-renders only when its data, the consumer's `render` or its focus changes; scrolling, measuring and following reuse mounted rows. |
| Position | Scroll top/left and the following flag are parked per task and restored when the surface remounts (switching Chat/Editor, reopening the task). |
| Bottom alignment | `alignBottom`: a short conversation sits at the bottom of the viewport (grows bottom-up like a chat); the diff grows top-down. |
| Companion | `RowsNav` (offsets, `scrollTo`, `scrollToOffset`, `toEnd`) lets the turn rail drive the view like a scrollbar. |

Rule: a wrapper that lays content out at a width other than the one it occupies must not have its own size (it must not change sibling layout).

<a id="find-in-view"></a>
### Find in view

- `⌘F` (`Find`) opens the search field of the focused surface (label `Find in current panel`); `Enter` / `Shift+Enter` move between matches, `Esc` closes.
- The search runs over the rows' data (`searchText`), not the mounted DOM, so it finds rows that are not mounted. Plain case-insensitive substring; at most 5000 matches (the counter shows `i/5000+`).
- Hits on screen are painted with the CSS Custom Highlight API: all hits `--find-hit`, hits in the current row `--find-current` under `--on-find`. One highlight registry serves the chat and any open diff. At most 2000 DOM ranges are painted.
- Conversation search text strips markup (a link's address, not its HTML) and includes headers, output and thoughts inside groups, and subagent name, type, prompt, rows and answer.
- Inputs, textareas, contenteditable and `aria-hidden` content are not searched.

<a id="following"></a>
### Following and scroll anchoring

- The log follows new output while the viewport is within 48 px of the bottom. Scrolling up stops following; a jump the reader asked for (turn rail, navigation, find) also stops it.
- When not following, a floating `To latest ↓` pill (`--card`, `--lift`) appears; it scrolls to the end and resumes following.
- Rows above the viewport that change height (expanding, streaming, re-measuring) are compensated so the visible row does not move. An explicit jump and following take priority over compensation.
- Clearing a navigation target on `pointerdown` must not re-insert link DOM before the `click` (sanitized HTML keeps a stable prop).

<a id="layout"></a>
## Column and rhythm

| Item | Value |
| --- | --- |
| Column | `--conversation-column-width: 880px`, centred in the chat (relative to the chat column, not the window, including with open panels and three columns). The composer, queue deck and status notices align to it; the scrollbar stays at the chat's edge. In a narrow chat the column takes the available width. |
| Text inset | Text stands 36 px from the chat's left edge and 40 px from the right; when the turn rail is shown it takes 28 px of the right margin. |
| Between turns | 34 px (`--turn-gap`, footer → next prompt). |
| Prompt → answer | 16 px. |
| Other rows | 12 px; paragraphs and list items are separate log rows. |
| Answer text | `--text-chat`, 13.5 / 22 at design size (scales with the chat text size setting, see [Appearance](appearance.md)). |

<a id="collapse-rules"></a>
## Collapse rules

Principle: what changed the world or failed is visible; what only read is folded.

| Row | Default |
| --- | --- |
| Thought | Collapsed to one line. |
| Two or more tool calls in a row | One collapsed group ([Tool groups](#tool-groups)); failed and running calls stay pinned under the header. |
| Single tool call, Edit (`category: edit`) | Expanded with its diff. |
| Single tool call, failed (incl. non-zero exit) | Expanded. |
| Single tool call, anything else (Bash exit 0, Read, …) | Collapsed. |
| MCP call | Collapsed; failed — expanded. |
| Subagent | Collapsed to its one-line header plus one line under it. |
| Code block over 8 lines | Shows 8 lines and `Show all · N`. |

All disclosure state (tool, group, pinned copy `pin/<id>`, thought, subagent, code block, crew answer) lives in the task's surface state (`activityExpanded`, `codeShown`), not in component state: the row's owner computes its height, and the state survives virtualization, streaming and switching surfaces.

<a id="rows"></a>
## Row catalog

`renderer/conversation-rows.ts` (`displayRows`) is a pure projection of the journal (`activityRows` from core) into display rows; the desktop and the phone chat share it.

| Kind | What it is |
| --- | --- |
| `message` (user) | The person's message. |
| `markdown` | One top-level Markdown block of an agent answer. |
| `message` (thought) | Agent reasoning. |
| `tool` | One tool call (or MCP call, drawn by `McpToolRow`). |
| `toolGroup` | A run of tool calls with thoughts between them. |
| `subagentBlock` | A subagent with its own rows and answer. |
| `turnStatus` | The live status line at the end of a running turn. |
| activity events | Crew plates, plan cards, crew answers, quick-ask service rows, task links, `session.failed` plate (`--red-soft` with glyph). |

Live permission and question cards are not log rows: they stand above the composer as "the app is waiting for you"; the log keeps their history.

<a id="user-message"></a>
### The person's message

- A `--tint` bubble, radius 12, as wide as its text (max column − 32 px), 13.5 / 21, padding 10 × 14.
- Rendered by `userMarkdown` (same renderer as answers, but a single line break is a line break). Mention tokens (`@[att:…]`, `@[task:…]`, `@[model:…]`) become pills or thumbnails; known `/` commands are marked as in the composer (see [Composer](composer.md)).
- Attachments show as shelf tiles ([Images in messages](#images)); code-line pills open the editor ([Code pills](#code-pills)).
- A message the host is still holding is drawn full width with its state and buttons on the right (see [Steering and queue](composer-steering-queue-and-ghost.md)).

<a id="answers"></a>
### Agent answers (Markdown)

- One renderer for the chat and the document preview: `renderer/markdown.ts` (markdown-it, `html: false`). HTML comments are hidden. Remote images in an answer never load: an image renders as its escaped alt text.
- An answer is split into rows per top-level block. Parsed blocks are cached by message id (`MarkdownCache`); a streamed delta re-parses only its message, and unchanged leading blocks keep their objects, so only the growing tail re-renders.
- Headings without rules (rules exist only in the document preview): H1 15, H2 14, H3–H6 13, weight 600, line 1.35, 6 px below.
- GFM tables draw as a grid: 12 px, cells 5 × 10, header `--tint` and 600, rows on `--hair` hairlines, alignment from Markdown, unequal content-sized columns.
- Blockquote: 2 px `--sep` line, 12 px indent, `--fg2` text. Lists are blocks like paragraphs, without browser margins.

<a id="thoughts"></a>
### Thoughts

| State | Label |
| --- | --- |
| Streaming (last row while the turn is busy) | `thinking` |
| Finished, ≥ 1 s | `thought · 8s` (whole seconds) |
| Finished, < 1 s or a single chunk | `thought` (no invented zero) |

The first chunk carries no duration (`nil`, not 0). A thought between tool calls goes inside their group as its own row and is not counted; a thought at the edge of a run stays outside.

<a id="tool-calls"></a>
## Tool call rows

<a id="tool-headline"></a>
### Header

One quiet line, 24 px (the S click target): chevron · status glyph · **name** · target · `+N lines` · spacer · `exit N` · duration.

- Domain: `ToolPatch` carries `name` (provider tool name; Claude `_meta.claudeCode.toolName`; CLI hooks send it too) and `exitCode` (from `_meta.terminal_exit.exit_code`, Codex `rawOutput.exit_code`, or an `Exit code N` prefix of a string `rawOutput` for Claude). A non-zero exit overrides the status to `failed`. Codex `rawOutput.formatted_output` becomes `output`.
- Target = first non-empty line of `title`, without the name prefix and without wrapping backticks (`toolHeadline` in core); the full `title` is the tooltip. A multi-line command shows `+N lines`.
- Without a name (Codex, old journals) only the target shows, in text colour; with a name the target is secondary. No second vocabulary of tool kinds.
- Paths inside the target are file links ([File links](#file-links)); a folder in a command target is not linked.
- Typography: 12 px `--fg3`, name 500 `--fg2`, target mono 11.5, `exit`, errors and time mono 10.5. `exit N` (non-zero only) uses the removed-line colour.
- The chevron sits in the margin left of the row and shows only on hover, focus, or while the row is open. The same `Chevron` is used by group, thought and subagent headers.
- Hover: `--tint` over the whole row (chevron to time), words one step brighter; press `--segment-press`; keyboard focus — 2 px `--accent` ring. A link in the target underlines over the row hover. Expanded calls inside a group stand on a `--hair` line; bodies (terminal, input, result) are `--code` plates with a hairline, radius 8.

<a id="tool-states"></a>
### States

| Status | Glyph / label | Counted as group error |
| --- | --- | --- |
| running | working glyph, `Working`; live elapsed | no |
| completed | green check, `Done` | no |
| failed | red, `Error` | yes |
| interrupted (turn ended without a result, host stop) | grey, `Interrupted` | no |

Durations come from journal timestamps; unfinished calls are closed at the turn boundary or host stop. Only visible running rows tick.

Steering that cuts off a call still being generated: if `session/prompt` of a turn into which a message was injected (`_session/steering` → `injected`) is rejected with `errorKind: "incomplete_tool_call"`, the transport writes `tool.changed {status: "interrupted"}` for each named call and then `turn.completed {reason: "end_turn"}`. The same rejection without steering stays `session.failed`.

<a id="execute-output"></a>
### Command output (`category: execute`)

- Body = output only: a read-only xterm (no PTY, input or kill), mono 11 / 17 `--fg2`, family from the terminal setting, padding 7 / 10, up to 10 visible lines with scroll, no empty line after a trailing newline. A multi-line command is shown above the output; JSON `rawInput` is never shown for commands.
- Output is the tail, at most 128 KiB (`toolOutputLimit`), with `Only the last 128 KiB are shown.` when cut. Why: the agent reads output into its context; megabytes of log would burn the window.
- A string `rawOutput` wins over the duplicate ```` ```console ```` fence in `content`; a non-string `rawOutput` (e.g. `tool_reference` arrays) is never stringified. An unknown terminal reference shows `Tool output is unavailable.`; no ACP terminal capability is announced.
- No kill button and no progress: in ACP a whole turn is cancelled, and output arrives in one piece at the end.
- Output is verbatim (`Exit code N` is not stripped).

<a id="tool-diff"></a>
### Inline diff of an edit

- One diff under the row, without a path header (the row names the file). Same renderer and syntax worker as the Changes panel: ±3 context lines, word-level spans at 24 % green/red, add/remove background under line numbers too, sign 14 px in `--diffAddedFg` / `--diffRemovedFg`. Height follows `--diff-line`; large previews use a bounded virtualized viewport.
- Data: `readToolDiff` (`activity:tool-diff`) by `TaskKey`, the `tool.changed` event seq and its content index; main reads normalized before/after from the journal. The renderer never passes a path or text for disk access. States: `The tool diff could not be read.`, `This file is too large to display.`
- The preview is a historical fact ("what this call did"); the Changes panel is current snapshot truth. Click or `Enter` on the body (`Open current diff`) calls `readToolChange` (`activity:tool-change`): main verifies seq/index and finds the file in the current snapshot regardless of the historical range; the panel switches to the current range. If the edit was reverted, the preview says `This file has no changes in the current snapshot.`

<a id="turn-changes"></a>
### Turn change list (data for the turn footer)

- The footer of a finished turn reads its changed files from the snapshots of that turn's range via read-only `readTurnChanges` (`activity:turn-changes`) by the seq of `turn.started`; it does not change the Changes panel's selected range. Loaded only for mounted footers; main serializes and keeps a bounded cache.
- At most 200 chips; a longer list shows the total and `Show changes · N`. No checkpoint range — no chips; changes made outside after the turn are not attributed to it.
- `Copy response` copies the Markdown of that turn's answer only (no prompt, thoughts, tools or neighbouring turns). The native `…` menu (`activity:turn-menu`) offers `Copy response` and `Show changes`.
- Chips use the shared `FilePath`: bold name, directory cut from the left, full path in the tooltip; a chip opens the file's diff with the exact turn range. Visuals of the footer: [Turns, plans and questions](chat-turns-plans-and-questions.md).

<a id="tool-groups"></a>
## Tool groups

Any run of two or more consecutive tool calls folds into one group (`toolRuns` in `core/tool-groups.ts`): Bash, Read, Grep, Edit/Write, failed calls and the running one. Thoughts between calls are inside; a thought at either edge stays out. A single call is a plain row (no "1 tool call" wrapper).

A group is closed by anything else: an agent message (agent text between calls always stays visible in the log), a user message, a permission or question card, a plan, crew events, a subagent block, the turn footer.

Header (24 px, full column width): chevron · group glyph (working glyph while a call runs) · count `21 tool calls` · `·` · mix by provider tool name, most frequent first, up to four then `+N` (`14 Bash · 5 Read · 2 Grep`) · file chips · `1 error` in red · spacer · time.

| Part | Rule |
| --- | --- |
| Count | `toolCallCount`; en `1 tool call` / `21 tool calls`, uk four forms (`виклик / виклики / викликів / виклику`). |
| Mix | `toolMixText`. Calls without a name (Codex) count but are not named; no names at all — no mix. An MCP call counts by its action words (`toolGroupName`), not `mcp__…`. |
| File chips | Edit/Write diffs give `dir/…/name +N −M` chips (`lineChangeCount`, `chipDirectory`); several edits of one file sum into one chip that opens the latest. Up to two chips, then `N more files` (`moreFileCount`). A chip opens the file's current diff in Changes (as `Open current diff`); the group stays as it is. |
| Errors | `toolErrorCount` — calls with status `failed`; `interrupted` is not an error. |
| Time | `toolGroupDuration`: the sum of the calls' own durations (a running call counts to now; the header ticks once a second from a shared timer). Not first-to-last wall time, which would include model thinking. |

Behavior:
- Collapsed by default, also while the turn runs. Under the collapsed header, failed and running calls are pinned in log order as one-line collapsed rows with their own chevron and their own disclosure (target `pin/<id>`).
- Expanded: all calls in order under a guide line from the chevron; pinned copies disappear. Calls inside keep their own defaults (failed and Edit expanded). Rows under the header are 4 px apart.
- Hover covers the whole header row; press `--segment-press`; keyboard focus `--accent` ring. File chips have their own hover above it.
- Narrow column: the mix yields first (ellipsis, then hidden), then chips shorten; count, errors and time stay.
- Navigation to a call inside a collapsed group expands the group and focuses the call (not its pinned copy). `Expand conversation` / `Collapse conversation` open and close groups together with the rows in them.

<a id="mcp-calls"></a>
## MCP call rows

`McpToolRow` draws a call to an MCP tool as an action in words instead of a raw name.

- Parsing in core (`mcpCall`, `core/mcp-tools.ts`), both spellings, provider-agnostic: Claude `mcp__<server>__<tool>` from `name` or `title`, arguments from `input`; Codex `mcp.<server>.<tool>` from `title`, arguments from `rawInput.arguments`. A Codex MCP call never takes the terminal path.
- **`brigadir` server tools** (ours, so their names are our UI text and are localized): each has three verb forms by state — running (`Accepting the part`), done (`Accepted the part`), failed or interrupted (`Could not accept the part`; in Ukrainian an impersonal form saying what did not happen), with the reason as a red second line. Special cases: `prompt_task` with `questionId` answers a worker; `simulator_act` takes its verb from `action`. The English form is the message key in `messages.ts`.
- A module glyph precedes the verb (helmet — crew, person — `ask_user`, browser, simulator, PR branch — PR review, plug — another server). After the verb, the crew member: from the `agent` argument or result, the report header, otherwise via `taskId` through the window's tasks; built-in names are translated, custom ones are kept.
- Second line, 11 px secondary: the target or outcome (part name and state, turns and files with plural forms, `commit <repo> <sha7>`, diff file with `+N −M`, first prompt line, page address, counts). While a blocking call runs it says what it waits for.
- **Other servers** stay untranslated: `server · Tool name` (`playwright · Browser navigate`: `_` → spaces, first letter capitalized), target = first string argument, result as is (JSON indented), failure = first error line. No knowledge registry of foreign tools.
- Expanded: fields instead of JSON (`task_status`: state, part, turns, changed files, working now, question, accepted; `read_report`: up to 8 files with status and `+N −M`, then `and N more`, plus `last message`; `accept_task`: commits and conflicts; single-file `read_diff`: coloured diff; prompts, questions, notes, review comments, answers as text). `Show JSON` / `Hide JSON` shows `Input` and `Result` verbatim. A failed call opens expanded.
- Crew plates `worker` / `accepted` that duplicate a call in the same turn (`crew.worker.created` / `crew.part.started` with the same part name, `crew.accepted` with the same `taskId`) are folded (`foldedCrewEvents`); events with no call (host-started verifier, manual accept) stay plates.
- The turn status row, the sidebar card's second line and the live agents popup (see [Tasks](tasks.md)) name the current MCP call with the same running form.
- Hover covers both lines and empty space; `Show JSON` has its own hover.

<a id="subagents"></a>
## Subagents

<a id="subagent-transport"></a>
### Transport and domain

- `initialize` announces `clientCapabilities.subagents: {}` (added on the wire; the SDK schema drops unknown fields). The SDK schema does not know the subagent updates either, so they are renamed to the ext notification `_brigadir/subagent` before the SDK and keep their place among updates.
- Two wire forms reach the same events. claude-agent-acp sends the **RFD form** to a client that declares `subagents` and is not JetBrains AIR; the older **draft form** stays readable.
  - RFD: on the parent session, `subagent_update {sessionId, title?, description?, capabilities?, state?}` — the first one for an unknown child announces it, later ones patch it. `title` is the name, `description` the subagent type. `state`: `running`; `idle` with `stopReason` `end_turn` → completed, `cancelled` → cancelled, any other reason → failed; `idle` with no reason and `unknown` → cancelled (the adapter saw the work end but cannot say how). `requires_action` changes nothing: the permission card shows it.
  - RFD: `session_message` replaces the hidden `Agent` call. On the child's session, a message *to* the child is its prompt (the first one fills `prompt`); a message *from* the child (a hand-back report) is its answer, an ordinary assistant `message.delta` of the child. Views on the parent session repeat these and are ignored.
  - RFD: the child's `config_option_update` gives its model (the name of the current `model` value; the `default` value is not a model and gives none).
  - Draft: `subagent_spawned {subagentSessionId, name, task, prompt}` and `subagent_state_update {state: completed | failed | cancelled}`; the launcher's `tool_call_update` (`_meta.claudeCode.toolResponse`: `agentId`, `agentType`, `resolvedModel`, and for synchronous subagents `totalDurationMs`, `totalTokens`) gives type, model, tokens and run time. There is no `Agent` row in either form.
- Announced child `sessionId`s are accepted for updates, `session/request_permission` and `fs/*` (permission cards appear in the log as usual). Only text, tool calls and the model come from a child session; its usage, commands and title stay with the adapter.
- Normalized events: `subagent.started {id, parentId, name, prompt}` (`parentId` for nested) and `subagent.changed {id, state?, prompt?, toolId?, type?, model?, tokens?, durationMs?}` — only what the adapter said; nothing is computed. `state: running` after an end means the agent gave the same subagent new work (`SendMessage`): the block works again. Child text and calls are ordinary `message.delta` / `tool.changed` with `subagentId`; `message.delta` also carries `parentId` (`parentToolUseId`) so subagent text is never merged into the agent's message. Step boundaries for steering ignore calls with `subagentId` or `parentId`.
- A subagent ends only by its own state, `session.failed`, `host.stopped` or a new `session.started`. The end of a turn does not end it: a subagent the agent ran in the background keeps working after the turn (see [Background work](chat-turns-plans-and-questions.md#background-commands)).
- Stop on a subagent sends `session/cancel` with the child's `sessionId` (the RFD grants `cancel`); the adapter answers with `idle cancelled`. Command `stopSubagent {id}`.
- Codex announces the capability; until its child sessions are observed, Codex subagents appear as ordinary tool rows (the same code handles child sessions if they arrive).
- Old journals without `subagent.*`: an expanded `think` call shows the `prompt` text from its input, not JSON.

<a id="subagent-block"></a>
### Subagent block

- A stable container at the place of `subagent.started`, accumulating its own rows regardless of arrival order; three parallel subagents read as three one-line blocks (4 px apart). It closes a tool group; calls before and after are separate groups.
- Header (24 px): chevron · state glyph (same as tool rows) · `Subagent` · type mono `--fg2` (when the adapter gave it) · `·` · name · spacer · `N tool calls` · errors · `·` · time. Time is `totalDurationMs`, otherwise start to end or now. Narrow column: type yields first, then name.
- Under the collapsed header, one line on the guide: while working, its live call (own chevron, target `pin/<id>`); when answered, the answer's first line (11 px `--fg2`), click expands the block. Failure — `error` in red in the header (the adapter sends no reason). Interrupted (the host or session ended without a state update, or `cancelled`) — grey glyph and `interrupted`.
- Expanded: `Prompt` (up to 3 lines, `Show in full` / `Show less`); the subagent's own rows through the same render (its calls fold into groups, nested subagents are blocks); `Answer` as Markdown up to 8 lines with `Show in full`; `model · N tokens` only when the adapter reported them (`formatTokenCount`, e.g. `34.6k tokens`). Without an answer yet: `Answer after the subagent finishes`.
- The answer is the subagent's last message after its last call. A final completed call whose whole input is one `message` string (handback-style builds) is recognized by shape and becomes the answer, not a call.
- Turn status row when only subagents work: `Working · 4m 21s · Subagent <name>` (+N for the rest). The sidebar card's second line reads `Subagent · <name>` while the latest work is a subagent's start or one of its calls (`task.activity.subagent`).
- Hover on the whole header; the answer line, `Show in full` and the live call have their own hover.

<a id="links"></a>
## Links

<a id="web-links"></a>
### Web links

- markdown-it `linkify: true` with schemes only: `http://`, `https://`, `mailto:`. `fuzzyLink`, `fuzzyEmail`, `fuzzyIP` are off; `ftp:` and `//` removed. So `docs/x.md`, `package-lock.json`, `src/foo.ts:42`, `www.host`, `a@b.com` stay text (and go through the file-link check). Why: without a scheme linkify treats `.md`, `.sh`, `.py`, `.rs` as TLDs. Inline code and fences are never linked. A trailing period or closing parenthesis stays outside; balanced parentheses inside the URL stay in.
- `externalLink` (core) is checked by the renderer before `links:open` and again in main's validator: `http(s)` to a named host without `user:pass@`, no spaces or control chars, ≤ 8192 chars, or `mailto:` an address. `javascript:`, `file:`, `data:` stay text.
- Click or `Enter`:

| Target | Opens |
| --- | --- |
| `http(s)` on `localhost`, `127.0.0.1`, `[::1]`, `*.localhost` (any port; `isLocalHost`) | The task's own browser (`setTaskBrowser` + `browserCommand {kind:'open'}`), revealing the right part if hidden. If the Browser module is off — system browser. |
| `https://github.com/<owner>/<repo>/pull/<N>` of one of the task's git roots (`pullRequestLink`) | The app's PR panel (tab from the URL tail). |
| Other `http(s)` / `mailto` | System browser / mail client via `links:open`. |
| Other schemes, relative paths | Nothing. |

- The window never navigates: clicks `preventDefault`; `will-navigate` and `setWindowOpenHandler` reject everything. The tooltip is the address.
- Look (same as a file link): `--accent`, no underline at rest, underline under the cursor over the whole link, `cursor: pointer`, focus ring 1 px `--accent` offset 2 px. A link that arrives in streamed parts re-renders only its block and ends as one link.

<a id="file-links"></a>
### File links

- `filePathCandidates` (core, lexical only) finds paths with `:line(:column)`, rejecting URLs, emails, versions (`2.23.1`), `..`, and bare names without a slash or extension. Quoted or inline-code targets may contain spaces and be extensionless.
- The renderer sends bounded batches (`readFileLinks`, `files:links`: ≤ 32 fragments, ≤ 32768 chars) through a serialized queue; main checks `TaskKey`, existence, file kind and containment/symlinks within the project, at most 64 checks per batch, and returns opaque editor IDs. `.git` and `.brigadir` are never targets; absolute paths only inside the project. No editor lease before a click.
- Paragraphs, inline code and tool headers use one renderer (`FileLinkText`); fenced code, existing URL links and code markup are not re-linked. HTML is built with DOM `textContent`, never by inserting unchecked path strings. A new checkpoint re-checks links; a late reply does not overwrite changed text.
- Click opens the file in the task's editor (`readEditorFile` / `openTaskEditor`) at the line, the same path as `Open Quickly`, keeping a dirty model; failure toasts `Could not open {file}.` with `Retry`. The link button has no button `min-height`, so it never makes a line taller.

<a id="path-tails"></a>
### Shortened paths

When a written path does not exist from the task root (`AppLayout/index.js:82`, `Header/index.tsx`), main searches the Files walk (the task's repos, without gitignored files) for a file whose path ends with `/<tail>`.

- One match — a link. Several — the one sharing the most leading folders with paths already resolved in the same batch wins. A tie, or an absolute path, stays text.
- Walk names are cached 30 s; the 64-check limit still applies.
- The link and its tooltip carry the resolved root-relative path, not the written tail.

<a id="folder-links"></a>
### Folder links

- A path with a slash (`docs/domains/dashboard`, `src/components/`, a tail like `AppLayout/lib`) that is a folder of the Files walk links to that folder, in the chat, the Markdown preview and the console (⌘+click). Bare names (`src`, `docs`) never link; gitignored folders stay text.
- Click opens the `Files` tab, clears the tree filter, expands the tree to the folder and the folder itself, selects and scrolls to it; focus stays where it was. Main returns the parent folder IDs with the folder ID, so no extra request is needed.
- Tooltip `Show in Files · <path>`; chat menu `Show in Files`, `Copy relative path` (root-relative, e.g. `src/components/AppLayout/lib`).

<a id="code-blocks"></a>
## Code blocks

<a id="code-syntax"></a>
### Highlighting

- Every fence, including inside quotes and lists, sends its bounded language and text through `readCodeSyntax` (`syntax:code`) to the shared Syntax worker/cache; semantic spans are shared with DiffCode and CodeMirror. Fence languages map by explicit aliases; unknown stays plain.
- Escaped text shows immediately; tokens apply after a 180 ms debounce, only to an unchanged block version.
- Limit: 1 000 000 characters / 4 MiB per request; larger blocks stay plain with `Syntax highlighting limit reached.`
- No hidden file reads to guess a language; the Markdown HTML, URL and image policies are unchanged.

<a id="code-controls"></a>
### Block controls

- Header line: language (mono 10.5 `--fg3`) and copy; code mono 12 / 19 full width, horizontally scrollable (3 px track), `--code` background with hairline, radius 10.
- Copy writes the exact plain code (no highlighting, no fences) through the bounded `clipboard:write-text` IPC; the button shows `Copied` with a green check for 2 s in place (the log does not jump); a failure toasts `The text could not be copied.`
- A block over 8 lines (`CODE_FOLD_LINES`) shows 8 and a `Show all · N` pill; `Show less` when open. State is per task/row/block (`codeShown`) and survives streaming, virtualization and surface switches; new syntax replies never re-expand it. `Expand conversation` / `Collapse conversation` open and fold all blocks. The document preview never folds.

<a id="diff-fences"></a>
### ```diff / ```patch blocks

Model: `renderer/fence-diff.ts`.

- +/− in a separate 16 px column; lines tinted `--diffAddedBg` / `--diffRemovedBg`; highlighting by the grammar of the `--- / +++` file (old and new side separately).
- Word diff between similar −/+ lines (a removed line looks for the next similar added line; lines with over 60 % changed are not similar).
- Tab = 4 spaces; the shared indent is removed; `diff --git`, `index` and `\ No newline` lines are hidden. A file row shows icon, path and its `+N −M`; a later `@@` or a lone `...` is a thin gap.
- Header: `diff`, total `+N −M`, copy of the raw text. No line numbers (agent `@@` numbers are often wrong); not folded at 8 lines.

<a id="code-pills"></a>
## Code pills in messages

A code-lines pill (`Progress.tsx:61-68 · new` from a diff, `src/a.ts:12-20` from the editor) in a sent message or in the composer opens the file in the task's editor: cursor on the first line, the range selected, centred, focus in the editor.

- A diff path is named inside its repo and resolved by the same lookup as chat file links (including tails).
- Line numbers are taken from the pill name as is, even if the file changed since.
- Fallback to the attachment text sheet: the old side (`· old`), a file that is gone or ambiguous, and drafts of the new-task sheet. Pills without lines open the attachment text sheet.

<a id="images"></a>
## Images in messages

<a id="image-tiles"></a>
### Tiles

- The person's message shows attachments as the same shelf tiles as the composer and the CLI shelf: 44 px tiles, a square thumbnail for images, an icon plus bold name and folder or size for files and fragments. No remove button. Tiles wrap in a row 8 px under the text; a message without text starts with the tiles. The queue deck keeps compact chips.
- Crop (`object-fit: cover`, same rule everywhere): height > 1.25 × width — anchored to top; width > 2.5 × height — to the left; otherwise centred.
- Thumbnails: main writes `thumb.png` next to `image.png` in the attachment folder (shorter side ≤ 176 px, longer ≤ 1200), on first request, cached (`attachment:thumbnail`). The full PNG is read only by the viewer. Data: `projects/<p>/tasks/<t>/attachments/<id>/image.png` + `attachment.json` with sha256; `turn.started` carries `{id, name, kind, bytes}`.
- States: loading — `--tint` with a soft shimmer, same size; missing file or sha256 mismatch — dashed `--sep` border, crossed image glyph, tooltip `<name> · could not be opened`; hover — `--accent` border on the whole tile; press — scale 0.97; focus — the shared button focus ring.
- A pasted image is stored with the English name `Pasted image` (it also goes to the agent) and shown as `t('Pasted image')` in the UI language; older localized names display the same way.
- A file attached by path is stored as a reference; `fileBytes` holds the real file size at attach time and the tile shows it.

<a id="image-viewer"></a>
### Full-window viewer

- Click, `Enter` or Space on a thumbnail opens `ui/ImageViewer` over the whole window: `--win` at 93 % with blur; 48 px header with name, pixel size, counter `{index} of {count}` centred and `Esc` (`ui/PopupClose`) on the right; the image fits the rest without upscaling.
- Several images of the message: 36 px side arrows and `←` / `→`; a 44 px thumbnail strip, current one with a 2 px `--accent` border; first/last disable the arrows.
- An image that fails shows the card `The image could not be opened` with `The attachment file is gone from the task data or has changed.`
- `Esc` closes and returns focus to the tile. Text attachments open in `DocumentDialog`, closed by `Esc` (`ui/PopupClose`).

<a id="context-menu"></a>
## Context menu

Right click (or `Ctrl`+click) in the log opens a native menu built in main (`chat:menu`, `isChatMenuState` validates a 6-key state). Items come from `chatMenuItems` (core) and appear only for the target under the click, in groups separated by separators; an all-disabled menu is not shown.

| Target | Items |
| --- | --- |
| Web link | `Open link` (same routing as a click), `Copy link` |
| PR link of the project | `Open in the PR panel`, `Open in system browser`, `Copy link` |
| File link | `Open in editor`, `Copy relative path`, `Copy path:line` (only when the link has a line) |
| Folder link | `Show in Files`, `Copy relative path` |
| Always | `Copy` (`CmdOrCtrl+C`, system copy role with formatting; disabled without a selection) |
| Code block (incl. header) | `Copy code` |
| Image tile | `Copy image` (the full image, `attachment:copy-image`) |
| A message | `Copy message` |

- `Copy message` copies one message whole: an agent answer's Markdown source (all its blocks), the person's message (also a held one) with attachments as display text, a thought's text, a subagent's answer.
- A right press inside the selection keeps it; outside clears it. The macOS select-word-on-right-click is undone, so `Copy` copies what the person selected.
- Inputs in the log, tool terminals, CodeMirror and surfaces with their own menu (tool diff) keep their own right click.
- Every input of the window without its own menu (composer, search, settings) gets the native edit menu: `Cut`, `Copy`, `Paste` | `Select All` with Electron roles; paste uses the same `paste` path as `⌘V`, so an image from the clipboard becomes an attachment.
- Each item has its menu glyph (see [Search, menus and commands](search-menus-and-commands.md)).
- Text in the log is selectable per character (DOM selection); `⌘C` goes through the standard `Edit ▸ Copy`.

<a id="navigation"></a>
## Keyboard navigation

All commands have items in `Navigate` and act on the surface that owns DOM focus (with three columns, only when focus is in the conversation). Dialogs, listboxes, the console and text inputs are not intercepted; turn navigation also works from the conversation's own composer.

| Command (`Navigate`) | Default (macOS) | Action |
| --- | --- | --- |
| `Next tool or hunk` / `Previous tool or hunk` (`next-block` / `previous-block`) | `⌥↓` / `⌥↑` | Between tool calls in the chat (between hunks in the diff); wraps; expands the owning group and focuses the call. |
| `Next turn` / `Previous turn` (`turn-next` / `turn-previous`) | `⌥⌘↓` / `⌥⌘↑` (PC: `Alt+PageDown` / `Alt+PageUp`) | Previous/next prompt via the turn rail. |
| `Expand conversation` / `Collapse conversation` (`activity-expand` / `activity-collapse`) | `⌥⌘]` / `⌥⌘[` | Opens/closes every tool, group (and its rows and pins), thought, subagent and code block. In the diff the same keys are `Expand all context` / `Collapse all context`. |
| `Find` | `⌘F` | [Find in view](#find-in-view). |

Keys follow the keymap (see [Search, shortcuts, menus](search-menus-and-commands.md)). Text focus moves only inside the transcript, never into composer menu option rows.

<a id="labels"></a>
## Service labels and durations

- All synthesized service rows (thought labels, `N tool calls`, `Subagent`, `N tools`, durations) are our UI text and are localized, with four `uk` plural forms; names that come from the agent (subagent name, provider tool names, foreign MCP names) are printed as received.
- Duration (`formatDuration`, core) is dense in English: `600ms`, `8.4s`, `12s`, `2m 4s`, `1h 5m`; Ukrainian uses U+202F before the unit: `600 мс`, `8,4 с`, `2 хв 4 с`. A fraction only below 10 s, one digit, locale decimal separator.
- Age in lists (sidebar) is a different quantity with spaced English forms (`3 min`, `2 hr`, `1 d`); do not merge the two formatters.

<a id="later"></a>
## Later

- A "show full output" viewer for tool output cut to the 128 KiB tail.
- Live confirmation of Codex subagent child sessions (today Codex subagents render as plain tool rows).

<a id="non-goals"></a>
## Non-goals

- A second Markdown or highlight pipeline, or another highlighter with its own colours; parsing or diffing on the UI thread.
- Fuzzy (scheme-less) URL detection; linking non-existent files, `.git`/`.brigadir`, or paths outside the project; filesystem access from the renderer.
- Kill or progress for a single ACP tool; running a shell to show stored output.
- Loading remote images from answers.
- Rerun/fork actions in the turn menu; `Copy as Markdown` for a partial selection; `Select All` in the chat menu.
- Line numbers or 8-line folding in ```diff blocks.
- Tool groups of one call; groups broken by failures or edits.
- Computing subagent time or tokens ourselves.
- Translating foreign MCP server or tool names.
