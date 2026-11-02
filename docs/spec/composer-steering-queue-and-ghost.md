# Steering, prompt queue, ghost suggestions and quick questions

This file covers how the composer behaves while the agent is busy and after a turn ends. While a turn runs, the person's message either goes into that turn (steering, held by the host until the agent's next step boundary) or into a durable, visible FIFO queue. After a turn ends, an empty composer can show a ghost suggestion for the next prompt. Separately, a quick question about selected code opens in a popover and is answered by a separate agent session, outside the task chat.

Related: composer core in [Composer](composer.md); adapter steering and queue-depth probes, one-shot calls and the Helper agent in [Agents and providers](agents-and-providers.md); the foreman's waiting and crew service prompts in [Crew](crew.md); snapshots and revert in [Diff and review](diff-and-review.md).

<a id="prompt-queue"></a>
## Persistent prompt queue (FIFO)

The GUI session host keeps its own FIFO of prompts. The adapter never receives concurrent prompts, and the adapter's own queue (`promptQueueing`) is not used, because it holds only one prompt and loses prompts.

<a id="queue-journal"></a>
### Journal and reducer

| Event | Meaning |
| --- | --- |
| `prompt.queued {prompt, before?}` | Enqueued. Written to the fsynced task journal before the enqueue is acknowledged. `prompt` is a `QueuedPrompt` `{id (UUID), command, attachments}`. `before` inserts it in front of that id. |
| `turn.started {queuedPromptId}` | Consumes exactly that queued item. |
| `prompt.removed {id}` | Explicit removal, from the queue or from the hold. |
| `prompt.held {prompt}` | A mid-turn message the host holds until the step boundary (see [Steering](#steering)). Lives outside the FIFO. |
| `prompt.steered {prompt}` | The message was handed to the running turn. |
| `queue.paused` / `queue.resumed` | Pause; resume is always an explicit person action. |

- A pure core reducer (`reducePromptQueue`, `promptQueue(records)` in `core/prompt-queue.ts`) rebuilds the same state (`prompts`, `paused`, `held`, `rateLimits`) for the host and the renderer.
- `QueuedPrompt.command` is a `prompt` or `submitReview` command. A review that is already queued or has already started is not queued again.
- Limits: 32 items and 4,000,000 characters of text in total. A full queue fails with "The prompt queue is full". Queue mutations and dispatch are serialized. When the host shuts down, it waits for queue operations it already accepted.
- After a restart, only prompts that were explicitly queued continue. An interrupted active turn is never repeated.

<a id="queue-pause"></a>
### Pause and limits

- `session.failed` pauses the queue only when it is not empty and no subscription rate limit is active. An empty queue has nothing to protect: a prompt sent after a failure into an empty queue starts at once.
- If the host died during an active turn, the next host writes `host.stopped`, moves held messages into the FIFO, and pauses a non-empty queue. The task becomes `interrupted`, or `rate-limited` if a limit is active.
- While a rate limit blocks (`quotaBlocked`: a structured rate-limit window is live), nothing is dispatched. The queue continues after the reset, which comes from `rate-limit.expired` on a timer. Limits are never guessed from error text, and failed turns are never retried automatically.
- CLI tasks keep their own TUI input and hook queues. Nothing is duplicated there.

<a id="queue-deck"></a>
### Queue deck

The deck stands over the composer island in the shared `ui/Deck` component, together with background commands.

- **Only the person's messages have rows.** Crew service prompts (`command.crew`: a worker's question or report, a plan decision) wait in the same FIFO but get no row on desktop or phone (`isOwnQueuedPrompt`). They already appear as their own rows in the activity.
- The first row carries `Queued · N`. N counts the person's rows only. A queued review shows as `Review`.
- When the queue is paused, a header shows `The queue is paused.` and `Resume queue`. This also appears when only service prompts are queued, so the queue can still be resumed.
- Row actions sit at the right edge of the row, in this order: `Send now` (only for a `prompt` while steering is available), then edit (`Edit queued message` / `Edit queued review`) and `Remove queued message`. Edit and Remove stay in the same place on every row.
- Edit is allowed only after a successful removal:
  - For a prompt, it appends the text and attachments to the current draft and focuses the composer. If the draft cannot hold the message (over 1,000,000 characters or more than 10 attachments), it fails with `The draft cannot hold this queued message.`
  - For a queued review, it reopens the Review sheet with the original comments instead of turning the generated batch into plain text.
- Layout: the island overlaps the deck's bottom edge by 1 px (`margin-bottom: -9px` against the island's 8 px top inset), so the island's border is the seam between them. The first row's text sits 9 px below the deck's top. There are 16 px from the last row's text to the island. Rows are S 24.
- Phone: the composer shows `Queued · N` with `Send now` for the first message.

<a id="steering"></a>
## Steering: sending into the running turn

When the agent advertises steering, a message the person sends during a GUI turn goes into that same turn. In Claude Code, too, a message typed while the agent works is read mid-turn. Without steering, a mid-turn answer waits behind the whole turn.

<a id="steering-conditions"></a>
### When a message steers

- The agent advertised `initialize._meta.steering.supported = true`. The transport passes this on as `session.started.steering: true`. There is no registry of our own.
- Only the person's own composer message steers: the `prompt` command with `steer: true`. This flag cannot be combined with `crew`. Foreman prompts to workers, answers to questions restored after a restart, plan refusals, merge prompts and other app prompts have no flag and always go through the FIFO.
- All of these must also hold: our own `session/prompt` is running, the FIFO is empty and not paused, and no rate limit blocks.
- Everything else goes through the FIFO: worker reports and questions, `submitReview`, and anything sent while the queue is not empty. Pressing Enter behind a non-empty queue queues the message, so queue order is never broken.
- CLI tasks are not affected; the CLI reads input itself.

<a id="steering-hold"></a>
### Holding to the step boundary

Neither adapter can withdraw a message once it is injected. To keep it editable, the host holds it first.

1. On Enter, the host writes `prompt.held`. Later messages sent during the hold are also held, in send order. The text is in the journal at once, so a crash does not lose it.
2. At the step boundary, the host sends every held message through `_session/steering`, one at a time, in order. The boundary is the first of these:
   - a **top-level** tool reaches `completed` or `failed`. With parallel tools, the first one to finish counts. Subagent tools (`parentId`, `_meta.claudeCode.parentToolUseId`, or a `subagentId`) are not boundaries, and Codex child sessions are filtered out by the transport;
   - the person answers a permission request, an agent question, or a task proposal;
   - **Claude only:** 5 s after Enter, timed from the `prompt.held` record (`BRIGADIR_STEER_HOLD_MS` overrides this in tests). Codex has no window, because it only injects at its own step boundary anyway, so holding costs nothing there;
   - the turn ends. Held messages then become `prompt.queued` with the same ids and run as the next turns, without `_session/steering`.
3. Once one held message of this turn has gone to the FIFO, the rest of this turn's held messages follow it there, even at a later boundary. The agent never reads a later message before an earlier one.
4. When a held message moves to the FIFO (turn end, declined steer, restart), it is inserted **before** everything queued after its own `prompt.held` (`prompt.queued {before}`). A worker report, a review, or a later message from the person cannot overtake it.
5. Remove and Edit use the existing `removeQueuedPrompt` command and the `prompt.removed` event, which accept a held message too. After `prompt.steered`, the command fails with "no longer queued" (`The message has already left the queue.`). These actions are serialized with dispatch, so a message cannot be removed and sent at the same time.
6. `steerQueuedPrompt {id}` (the deck's `Send now`) moves a queued `prompt` from the FIFO into the hold. It is allowed only while a turn runs with steering, the queue is not paused, no limit blocks, and the item is not a crew prompt.

Why the 5 s window for Claude: Claude interrupts generation on a steer and moves a running foreground tool to the background. Holding until the next boundary can cost Claude anywhere from the rest of a tool run to a whole generation, which is tens of seconds. The window caps that cost at about the length of an "undo send". The window is a host policy keyed by `task.provider` and based on measurements. Re-measure it whenever an adapter changes.

<a id="steering-outcomes"></a>
### Steer request and outcomes

The host writes `prompt.steered` **before** sending `_session/steering` `{sessionId, prompt, _meta:{steering:{idleBehavior:"promptRequired"}}}`.

| Outcome | What happens |
| --- | --- |
| `injected` | Nothing more happens. The activity shows a normal person row where the message was sent. There is no new turn, no turn-rail mark and no queue row. |
| `declined` (`promptRequired`, request error, the turn just ended) | `prompt.queued` with the same id. The prompt runs as the next turn, and the activity shows it once, at that turn. |
| `adopted` (Codex `startedNewTurn`) | The adapter started its own turn. The host adopts it instead of cancelling, because the text is already in the Codex thread and a resend would duplicate it. The transport waits until our `turn.completed` is journaled, then the host writes `turn.started {queuedPromptId}` before any update of the new turn. A checkpoint failure is logged as `snapshot.failed` and does not stop the turn. |

Adapter behaviour as measured:

| Adapter | Turn running | No turn |
| --- | --- | --- |
| `claude-agent-acp` | `injected`: read between tool calls; the turn still ends with one `session/prompt` response | `promptRequired`: nothing runs, the prompt stays with the host |
| `codex-acp` | `injected` (app-server `turn/steer`) | ignores `idleBehavior`: `startedNewTurn`, the adapter's own turn; its end is `session_info_update._meta.codex.threadStatus.type` other than `active` |

<a id="adopted-turns"></a>
### Adopted turns (Codex)

- **End.** Any `threadStatus` other than `active` (`idle`, `systemError`, `notLoaded`) after the post-steer `active` closes the adopted turn with `turn.completed`.
- **Wire order.** codex-acp answers our `session/prompt` only after the last notification of the old turn. To keep that order, the transport always reads adapter stdout synchronously, before the SDK does, but only lines that carry `stopReason` or `threadStatus`. It counts `session/prompt` requests sent against responses seen on the wire, and while there are fewer responses than requests, any status belongs to the old turn. An `active` → non-`active` pair seen after the response belongs to the new turn, even if it arrives before the steer's own answer. That turn closes on that same status, by its wire number, once the SDK reaches it, so output earlier in the same chunk is journaled first.
- **Watchdog.** If the adopted turn never became `active` and no `session/update` arrived for 30 s, the transport closes it and journals `unhandled` with the reason (`BRIGADIR_STEER_WATCHDOG_MS`).
- **One at a time.** While an adopted turn lives, the host sends no `session/prompt` of its own. A second steer during it is declined and goes to the FIFO. In this state the composer offers `Add to queue`.
- **Stop.** Stop during an adopted turn sends cancel. If no end status arrives within 20 s (`BRIGADIR_STEER_STOP_MS`), the transport closes the turn itself. The wait is 20 s rather than less because Codex can take a while to kill a stubborn process, and a FIFO prompt must not start while the old prompt is alive.
- If the host cannot open the adopted turn (journal failure), the turn is cancelled and the message counts as delivered, with no retry. An adapter that never sent `threadStatus` cannot close such a turn, so it is cancelled and the message stays delivered (`prompt.steered`).

<a id="turn-generations"></a>
### Busy state and generations

- Host and transport `busy` belong to a turn generation (`turnGen`). An adopted turn can begin before the previous turn's `finally` runs, and that `finally` must not clear the new turn's `busy`.
- While a steer is in flight (`steerPending`), the target turn does not clear `busy`. After the answer, the steer clears it only if nothing else runs. So `setOption`, `setMode` or a file save cannot slip in at the moment Codex starts its turn.
- A Claude turn that fails because a steer cut off a tool call while it was being written is described in [Chat: tool call states](chat.md#tool-states).

<a id="steering-limits"></a>
### Known limits

- If the person stops right after `injected`, Claude may not have passed the text to the model yet, though the log shows it as delivered.
- If the host crashes between `prompt.steered` and the adapter's answer, the message is in the log but not in the queue. Interrupted turns are not repeated.
- If the connection drops after the adapter accepted a steer, the host sees an error and queues the prompt. After a restart the queue is paused and visible, so the person can remove the duplicate.
- Updates and the checkpoint of an adopted turn that arrive before the steer's answer are attributed to the previous turn. This can only happen in a race at the turn boundary.
- While a steer is in flight, the composer command waits for the answer, and Stop and Send are disabled. This usually lasts a fraction of a second.
- A declined steer briefly shows as a log row, then moves into the queue deck.
- If an adopted turn is already `active` and its end status is lost, the turn hangs until Stop. The watchdog does not apply here, because a long quiet build is a normal live turn.
- Wire counters live for the whole connection, so one mismatch with the SDK persists. Known gaps: a status of another session in the same chunk as the `session/new` response, JSON-RPC batches (arrays), a status whose text contains `stopReason`, and an error response to our `session/prompt`, which is counted one microtask late.
- It is unproven whether a steer sent right after a tool finishes interrupts Claude's thinking.

<a id="composer-during-turn"></a>
## Composer during a turn

| State | Island buttons | Send tooltip | Empty-field placeholder |
| --- | --- | --- | --- |
| Turn runs, steering available, field empty | `Stop` (primary) | — | `↩ send now · ⌘↩ to the queue` |
| Turn runs, steering available, field has text | `Stop` (secondary) + `Send` (primary) | `Send now · ↩ · To the queue · ⌘↩` | — |
| Turn runs, no steering, or the queue is not empty, paused, or limited, or the turn was adopted | `Stop` + `Send` (aria `Add to queue`) | `Add to queue` | `↩ to the queue` |
| Idle | `Send` | `Send` | `{send} send · {newline} new line · @ files · / commands` |

- `Stop` tooltip: `Stop · ⌘.`. All shortcuts in tooltips and placeholders come from the keymap and are spelled for the platform.
- **⌘↩** queues the message without `steer`. The menu item is **View ▸ Add to queue ⌘↩** (`composer-queue`, keymap group Chat), placed right after Stop. It is enabled only when the composer field has focus, the agent works, steering is available and there is text. ⌘↩ is also the accelerator of Submit (`review-send`), but that needs focus outside a text field or in a permission, question or comment card. `menuCommandEnabled` disables `composer-queue` whenever any Submit context is active, so the two items are never enabled together.
- **Send menu**: right-click, a 500 ms long press, Shift+F10 or the context-menu key. It opens only when the message would steer. It is a `MenuPopover` (318 px) with a `Send` header and Esc (`ui/PopupClose`), and two items:
  - `Send now`: "Sent at the agent's next step", `↩`.
  - `To the queue`: "Sent after the turn ends", `⌘↩`.

  Arrow keys move between items, Escape closes, and focus returns to Send.
- **Held-message row in the activity**: the person's row shows where it was sent, with a clock and `Waiting for the agent`. Under a pending permission request or question, the clock is amber and the text reads "Sent after you answer the request". The row has 22×22 `Edit message` and `Remove message` buttons, which use the same `edit` / `close` glyphs as the deck. Edit removes the message and puts its text back in the field. Once the agent takes the message, the row becomes a normal message row.

<a id="ghost"></a>
## Ghost next-prompt suggestion

After a turn ends, an empty composer can show the likely next message as its placeholder, with a `Tab` key badge (aria: `Accept the suggestion with Tab`). ACP has no such concept; this mechanism is ours. It has two stages: free heuristics first, then an opt-in paid one-shot call.

<a id="ghost-display"></a>
### Display rules

- Shown only when all of these hold: the composer is empty (no text, no attachments), the last turn completed, the task is not busy, no rate limit is live, and the agent is connected or idle-stopped. A host stopped for idleness ends no turn, so the last hint stays.
- Not shown while a permission card or question is pending, or while the queue is not empty.
- A heuristic hint appears 400 ms after it becomes available, so it does not flicker.
- `Tab` accepts the hint. A text hint becomes editable composer text with the cursor at the end. A review hint sends the review. `Tab` is captured only while a hint is visible.
- `Esc` dismisses the hint for that turn and cancels a pending call. The dismissal is stored in the task's state (`ghostDismissedTurn`, keyed by the `turn.completed` seq) and survives switching tasks.
- `↩` on an empty composer with a visible hint does not send it; press `Tab` first.
- The hint uses the placeholder colour and the same font, not italic. Focus does not move, and no other keys are captured.

<a id="ghost-heuristics"></a>
### Stage 1: heuristics (`ghostSuggestion`)

| Condition | Hint |
| --- | --- |
| Unsent review comments or notes | `Submit review (N comments)`. Tab sends the review. |
| The last turn's plan has unfinished entries | `Proceed` |

There are no heuristics after a cancelled turn. When a heuristic hint exists, the paid call never runs.

<a id="ghost-headless"></a>
### Stage 2: generated hint

- **Off by default.** Settings ▸ Agents ▸ `Prompt suggestion`, switch `Suggest the next prompt` (`settings.suggestNextPrompt`), with the hint "Written by the helper agent." Turning it off cancels all running calls.
- **Who writes it.** The [Helper agent](agents-and-providers.md) (`settings.helperAgent`), or a per-action override for `promptHint` (`settings.actionAgents`). The default is a Codex catalog entry whose value or name contains `luna`. If Codex is off or its known catalog has no Luna, the default is a Claude entry with `haiku`. If neither is found, it is the first enabled provider's own model. Before a catalog is known, the model is matched by name at call time. A catalog that is unknown or failed to probe never makes a choice unavailable. Effort is the lowest level the model advertises: the first `thought_level` after `default`. Fast and mode are left alone. The model is set by its exact catalog value through `configOptions`; failing to set it does not fail the call. Settings shows amber fallback notes when a choice is unavailable:
  - `{provider} is off. The helper uses {model}.`
  - `Model “{model}” is unavailable in {provider}. The helper uses {default}.`
  - `{provider} is off. Helper jobs are unavailable.`

  At startup, if hints are on, the helper provider's catalog is warmed (`helperCatalogProvider`), so the first hint does not wait for the probe.
- **Call.** A text-only one-shot (`oneShotText`, see [Agents and providers](agents-and-providers.md)) with no task tools. It runs in the stable folder `~/.brigadir/ghost/` (`ghostDirectory()`), so provider transcripts of these calls collect in one place. It has a 15 s timeout and a 400-character limit. Adapter text that arrives before our prompt is not part of the answer.
- **Input** (`ghostTail`): the person's last prompt (the last 1,200 characters) and the final assistant text of the last turn (the **last** 4,000 characters, because questions, plans and summaries come at the end). Changed file names are not sent.
- **Prompt** (`ghostPrompt`, English): predict the user's next message as one short line, under 15 words, in the language and tone **the user writes in**, or the assistant's language if the user's message is empty. Once accepted with Tab, the hint becomes the person's own text, so it must be in their language. The conversation is passed as untrusted JSON.
- **Output** (`ghostLine`): the first non-empty line that is not a code fence, with bullets and quotes stripped, cut to 200 characters. An empty answer means no hint.
- **Policy.** `ghostHeadlessPolicy` is a pure, tested function. It returns a reason, not a boolean, because an unneeded call fails silently and only burns quota. The reasons, in check order: `disabled`, `hidden`, `composer`, `dismissed`, `not-complete` (the last turn did not end with `end_turn`), `pending`, `queued`, `heuristic`, `quota`, `empty-response`, `allowed`.
- **Visibility.** A task that is not on screen never pays. The renderer requires its root to intersect the viewport while the document is visible. Main requires the task to be the visible task in a window that is visible and not minimized.
- **One attempt per completed turn** (per task and turn, failures and cancellations included; results are cached for up to 128 turns). The renderer requests the hint 400 ms after the policy allows it, over `ghost:request` / `ghost:cancel`. The policy is checked again after the answer arrives.
- **Cancelling kills the adapter process, not only the result.** All of these abort the call:
  - typing, or any other change that breaks the policy (renderer effect cleanup);
  - switching tasks;
  - any of `turn.started`, `host.stopped`, `session.failed`, `permission.requested`, `question.requested`, `task.proposal.requested`, `crew.plan.requested` or `prompt.queued` for the task;
  - the window hiding or minimizing, the setting turning off, or quitting.
- **Quota is checked against the hint's provider, not the task's.**
  - Claude: a structured `allowed_warning` or `rejected` window from task events or from the hint calls themselves blocks hints until it resets (`ghostQuotaBlocked`). This is a lower threshold than task work uses: the last percent of the window belongs to real work. Context usage is not a subscription limit.
  - Codex: blocked only while a Codex window is actually exhausted in the global quota reading (`quotaExhausted`), because codex-acp sends no rate-limit events.
  - A warning from one provider never stops a hint written by the other.
- **Failures are silent.** A limit, a missing adapter or no answer all simply mean "no hint". No error strip is shown.

<a id="quick-question"></a>
## Quick question under a selection

A question about selected code is answered in a popover by a separate, lightweight session of an agent. It does not depend on the task agent's state: it works mid-turn, on a stopped task, and without a live host. Nothing goes into the task chat.

<a id="quick-entry"></a>
### Entry

- The input is a text selection in the editor or in the diff. The popover anchors to the lines the selection touches and stands under the line where it ends. The selected text is quoted in the popover and in the prompt (`excerpt`).
- There are three ways in:
  - the `Ask the agent` button in the selection panel. It is primary unless `Create task` is also shown, and its tooltip is `Ask the agent · ⌘I`;
  - the menu item **Editor ▸ Ask the agent ⌘I** (`ask-agent`, context `askAgent`: a selection in the editor or diff). The menu bar takes ⌘I before CodeMirror's `Mod-i` (`selectParentSyntax`);
  - the editor context menu: `Ask the agent ⌘I` above `Add comment`.

<a id="quick-popover"></a>
### Popover

- It floats over the code just under the selection's last line, without shifting lines, and scrolls with the text. Its width is `min(536px, visible code width)`.
- Header: a spark glyph, `Ask the agent`, `file · lines`, the chip `outside the task chat`, and Esc (`ui/PopupClose`).
- The question field (`What do you want to know about these lines?`) has focus. `⌘↩` or `Ask` sends. `Esc` closes and returns focus to the code. The selection panel is hidden while the popover is open, and the selection stays.
- The answer streams as Markdown (`MarkdownBlock`, code blocks with Copy). The status row reads `Starting` or `Writing · 4 s`, plus the current tool, with `Stop`, which cancels the quick session's turn. When done, it shows `Claude · 6 s`, adding `· The answer was stopped` if stopped. Below the answer, `Ask more…` sends a follow-up into the same quick session.
- **Model capsule.** This is the composer's `ComposerOptions` capsule with only a model (no effort, mode, Fast, or compact toggle). It sits at the left of the footer before the first question, then at the left of the `Ask more…` row. It is disabled while the agent answers. Its menu is a `Popover` with a `Model` header and Esc, listing models grouped by provider (Claude, Codex) from the catalogs. The task's model is marked `task`, and `Loading…` shows while catalogs load.
  - The default inherits the task: the request is sent as `{}`, and the session forks or mirrors the task's options.
  - Another model sends `provider` + `model` and starts a new quick session. The field reads `Ask {agent}…`, with the hint `New {agent} session. Answers above are not passed on.` The thread shows a `New session · Codex · <model>` divider, and earlier turns stay above it. The new session gets only the selection.
- **Limit.** The error card shows a `{agent} limit · {time}` chip (`ui/NoticeChip` → `NoticeLabel`). `Try again` is disabled while a known reset is still ahead, and the card says `Pick another model below.` In the model menu, that provider's group is dimmed with `Limit · {time}`. After another model is picked, the card's button becomes `Ask again with {agent}`, which asks the same question in a new session. The reset time comes from the quick session's `rate-limit.changed` (the `failed` event carries `resetsAt`), or else from the exhausted quota window.
- Errors read `The agent did not answer: {reason}.` with `Try again`. An exhausted limit gives the reason `the subscription limit is used up`. A removed task worktree fails the question at once.

<a id="quick-session"></a>
### Who answers

- A separate ACP session of the chosen provider. By default this is the task's provider, model, effort and permission mode, taken from the task's latest `session.started` / `options.changed` / `mode.changed`. It runs in the task's folder (worktree or project folder) with the same additional repos. It runs in its own adapter process and never touches the task's session.
- **Fork** when the adapter advertises `sessionCapabilities.fork` (ACP `session/fork`, used for the task's provider only). The agent then remembers why it wrote the code, and the prompt prefix is served from the prompt cache.
  - `claude-agent-acp` forks the on-disk transcript and returns a new id, which is then resumed or loaded.
  - `codex-acp` returns an already open session (`threadFork`).
- **Without a fork** (no support, task not started, or the fork failed), it is a new session with context: the selection ±30 lines, the path, the file's diff from the task base (up to 24,000 characters), the task title, and its first prompt (up to 4,000 characters).
- No Brigadir MCP server: the quick question does not need crew, PR or browser tools.
- The prompt (`quickAskPrompt`) is in English. It says to answer briefly in the UI language, in Markdown, and to change files only when asked. It warns that the task agent may be editing files right now, describes the `replace a-b` block format, and says not to continue the task. Follow-ups send only the question with the same `path:lines`.
- The session closes with the popover, or after 10 minutes without questions.

<a id="quick-edits"></a>
### Agent edits, Apply and Hand to the agent

- **The agent may edit files itself.** Before each prompt and after each turn of the quick session, the task takes checkpoints with the reasons `quick-before` and `quick-after` (session command `quickAsk {phase}`, through the live host or the lock owner without one). The edits enter the task diff between those two snapshots.
  - In `Who changed this`, the `quick-after` snapshot is attributed to `Quick question` with the question text, even when a task turn is running. Task-agent edits that land between the two snapshots get the same label, because snapshots cannot tell processes apart.
  - The quick question's files are the paths from its write tools (`edit`, `delete`, `move`), intersected with the files changed in that snapshot range.
  - The popover card reads `Changed <file> +N −M`, with `View diff` (the task diff over that range) and `Revert` (`revertFile` on that range). Revert restores a file only if nobody changed it since; otherwise it shows `The file changed after the question. It cannot be reverted.`
  - The task journal gets `quick-ask.changed {question (≤200 chars), files, before, after}` and a log row such as `The quick question changed 1 file`, with 4 Ukrainian plural forms. It is written only when files changed. The answer itself is never journaled.
- **Apply** is for code the agent only proposed. The agent proposes it in a fenced block with the info string `replace <start>-<end>`, holding the complete new text of those lines; at most 8 blocks are parsed (`quickAskSuggestions`).
  - The popover shows it as a diff: old lines from the editor buffer, new ones from the block.
  - `Apply` makes one CodeMirror transaction in the buffer, without writing to disk, so ⌘Z undoes it. Afterwards the popover shows `Applied to {file}` and `Undo the apply`.
  - If the buffer lines changed after the answer, Apply is disabled with `Lines changed after the answer. Ask again.`
  - In the diff there is no buffer, so Apply shows `Open the file in the editor to apply.`
- **`Hand to the agent`** puts an inline lines pill (`file:start-end`, the same content as `To composer`) into the task composer, followed on a new line by the question and answer. Any existing draft stays in front. The chat opens with focus in the composer.

<a id="quick-permissions"></a>
### Permissions, locks and lifetime

- Permissions follow the task's mode. In manual mode, a permission request from the quick session appears inside the popover (tool name and the provider's options, like the chat permission card). Closing the popover answers "cancelled". `Auto` and `Bypass` never ask.
- A quick question belongs to the task and takes no lock of its own. It works under the task's repo lock. If the task has no isolation and another task holds its repo, or the task is a read-only agent, edits are forbidden:
  - the session starts in manual mode;
  - every write request is declined;
  - the prompt says not to change files;
  - the popover shows, in amber, `“{task}” holds the repo. The agent only answers.`
- There are no file locks between the task agent and the quick question. The adapter's `Edit` refuses to write a file that changed since it was read, and Revert checks the bytes.
- The question and answer live in renderer memory until the window closes, keyed by task, file and lines. Pressing ⌘I again on the same lines shows the last answer with `New question`, and the popover notes `The answer stays until the window closes.` Nothing is written to disk.
- IPC: `quick:ask`, `quick:follow-up`, `quick:stop`, `quick:close`, `quick:permission`, `quick:revert`. Events stream on `quick:event` (`started`, `text`, `tool`, `permission`, `changes`, `done`, `failed`). Request limits are in `quickAskLimits`: question 4,000; selection 60,000; surrounding text 120,000; diff 24,000; prompt 4,000; journal question 200; answer 60,000 characters.

<a id="later"></a>
## Later

- Cycling through several ghost candidates when heuristics produce more than one.
- More ghost heuristics: the most likely option of an agent's multiple-choice question; "fix the failing test" after failing tests.
- A separate "quick question model" setting, if the task's model proves too slow or costly for quick questions.
- Re-binding the steering wire counters on every steer, to close the known counter gaps.

<a id="non-goals"></a>
## Non-goals

- Steering worker reports into the foreman's turn. It would break the foreman's read-report → `read_diff` → accept loop. Reports arrive between turns.
- `session/cancel` plus a resend for Codex `startedNewTurn`. That would duplicate the text in the thread and leave side effects of the aborted turn.
- Sending immediately and withdrawing later: no adapter can withdraw an injected message.
- A visible timer for the 5 s hold window.
- Holding Claude messages to the boundary without a window cap.
- Asking the main agent to append a suggestion to its reply (for example via `--append-system-prompt`). It clutters the transcript and is unreliable.
- A paid ghost call when a heuristic already produced a hint, and automatic retries of a ghost call.
- An app-side registry of "cheap" models or of agent behaviour. Models come from the adapters' catalogs.
- Writing quick-question answers into the task journal, running the quick session inside the task host, or a file lock for the duration of a question.
