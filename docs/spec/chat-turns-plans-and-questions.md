# Turns, plans and questions in chat

The conversation is divided into turns. Each turn has a mark on the turn rail, which also works as the chat's scrollbar. A status row shows while the turn runs, and a footer summarizes it when it ends. Turns the agent starts on its own, and commands it leaves running in the background, are tracked the same way. Plans show up in three forms: the agent's live checklist, a plan document waiting for approval, and the Foreman's split card. Agent questions are blocking `ask_user` calls that the chat renders as answerable cards.

All of this is drawn from normalized `AgentEvent`s and the task journal. No view reads ACP payloads. Plans and questions come only from what the protocol delivers: the app never guesses a plan or a question from reply text.

<a id="turns"></a>
## Turns

<a id="turn-model"></a>
### What a turn is

- A turn runs from `turn.started` to `turn.completed`. A `session.failed` or a `host.stopped` also ends the live state.
- `turn.started` carries the prompt `text`. A turn the agent began itself has `origin: 'agent'` and an empty `text` (see [Turns the agent starts](#agent-started-turns)).
- `turn.completed` has a reason. `cancelled` shows as `Interrupted`, a failure shows as `Error`, and anything else shows as `Done`.
- `core/turns.ts` (`summarize`) turns the journal into numbered turn summaries: `seq`, `number`, `at`, `status`, `duration` and the checkpoint `range` of the turn. The rail, the status row, the footer and the sidebar all read these.

<a id="turn-rail"></a>
### Turn rail

The rail is a vertical strip on the right edge of the conversation with one mark per prompt. A prompt can come from the person or, for a worker, from the Foreman. The rail appears once there are two prompts. Tasks that use the Terminal transport have no rail; they show turns in the CLI `Turns` strip instead (see [Terminal and CLI agents](terminal-and-cli-agents.md)).

| Property | Value |
| --- | --- |
| Rail width | 28 px, vertically centred in the conversation; messages keep a 44 px right inset so the rail never covers them |
| Vertical room | Conversation height minus 2 × 40 px (the bottom margin clears the "jump to latest" pill) |
| Mark | 2 px stroke, right-aligned |
| Mark length / colour | off screen 8 px `--fg3`; on screen 12 px `--fg2`; hovered or focused 18 px `--fg`; running turn `--accent` |
| Step | 7 px while the rail fits; below that it shrinks evenly, with no lower bound (marks closer than 2 px merge into a band) |
| Lens | Dock-like magnification. Under the pointer the step grows to about 10 px, neighbours fall off as a Gaussian (σ = 3.5 marks) and far marks shrink, so the rail never grows past its room (`RAIL = { pitch: 7, margin: 40, lens: 10, sigma: 3.5 }` in `turn-rail.ts`) |

Rules:

- **Every mark can be hit, whatever the turn count.** The pointer is matched against the rail's rest layout, and the lens keeps the focused mark where it was at rest. Marks do not slide under a cursor that stays still.
- **Hover card.** It appears to the left of the rail at the height of the mark, 300 px wide, with no delay and no click. It shows up to three lines of the prompt (then `…`), `Turn N`, `+N −M` when the turn changed files (the same numbers as the footer), and the time of `turn.started`. Today's turns show `formatTime` (`14:32`); turns from other days show `formatDateTime` (`DD.MM.YYYY · HH:MM`). A running turn shows a spinner and `Running` in place of the time. The card does not take the mouse and disappears when the pointer leaves the rail.
- **A click only scrolls.** The top of the prompt lands 14 px below the top of the viewport, and following is turned off, as with a manual scroll. The rail never filters the diff or selects a range; the Turns panel does that.
- **Shortcuts.** These are in the `Navigate` menu, right under `Next tool or hunk` / `Previous tool or hunk`: `Next turn` `⌥⌘↓` (`turn-next`) and `Previous turn` `⌥⌘↑` (`turn-previous`). They are active while the rail is shown (context `turnRail`), from the conversation or its composer. Steps count from the top of the viewport. `⌥⌘↑` goes to the nearest prompt that starts above. `⌥⌘↓` goes to the first prompt below; past the last one it goes to the end and turns following on.
- **Keyboard and accessibility.** The rail is a `nav` labelled `Conversation turns` and takes one Tab stop. `↑` / `↓` and `Home` / `End` move between marks, and `↩` / Space scroll to the focused one. The rail exposes a single roving button over the focused mark, labelled `Turn N: <first line of prompt>`, and the focused mark shows the hover card.
- **Data.** The rail reads the conversation rows. Nothing new is persisted. "On screen" comes from the same observer that tracks the conversation's scroll position. Each conversation has one rail and one card, with no per-mark state.
- **Rendering.** Marks are painted on a `<canvas>` in O(N) with no reconciliation; 10 000 DOM marks pushed frame p95 from 14 to 45 ms. Colours are theme tokens, re-read when the theme or accent changes. The lens eases over `--motion-fast`. Under reduced motion it does not animate, and the first paint (or a change in turn count) snaps without easing.
- Turns the agent started have no prompt and therefore no mark. Their rows sit between the marks of the neighbouring turns.

<a id="rail-scrollbar"></a>
### The rail as the scrollbar

The conversation hides the system scrollbar (`Rows scrollbar="hidden"`). Wheel, trackpad, keys and the "jump to latest" pill work as usual.

- **Viewport band.** Each mark owns a cell that stands for its turn, from its prompt to the next prompt. The scroll offset maps linearly into the cell of its turn (`railY` / `railOffset`). So the band covers exactly the marks of the turns on screen and follows the lens when the cells stretch.
- **The band shows only while the pointer is on the rail**, not at rest and not while scrolling; the on-screen marks already show the position. On the rail the band spans the full rail width (28 px), has radius 6, is at least 20 px tall (centred on the viewport) and is filled with `--fg` 7 %. With the pointer on the band itself it darkens to `--fg` 13 % and the cursor becomes `grab`.
- **The lens and the card keep working on the band.** A mark under the band is still a click target. A press without movement is a click, which scrolls to the turn under the pointer. Moving more than 3 px starts a drag: the viewport follows the band, the lens turns off, the cursor becomes `grabbing`, and the pointer keeps its place inside the band.
- **Conversations without a rail** (fewer than two prompts) show `ScrollThumb` instead: a 4 px thumb at the edge, at least 24 px tall. It shows while the view moves (for one second after the last move) and while the pointer is in the 12 px edge zone. On hover it widens to 8 px, and it can be dragged. It takes no layout space.

<a id="turn-status-row"></a>
### Turn status row

While a turn runs, the last row of the log is a status line, for example `⟳ Working · 34 s · pnpm install`. It uses the same `StatusIcon` (`working`) as the sidebar, followed by the state word, the elapsed time and the target. It sits where the turn footer will appear, with no background, in small secondary text.

- **When it shows.** From the click on Send (before the `turn.started` echo, `shownTurnStatus(records, submittedAt)`) until `turn.completed`, `session.failed` or `host.stopped`. It hides while the turn waits for the person: a pending permission, `ask_user` question, crew question, `create_task` proposal or crew plan. The card itself is the call to action. A queued prompt does not restart it. A CLI-transport task has its own status line instead.
- **State word** (`core/turn-status.ts`, computed from the tail of the turn with no new events):
  - `Working`: at least one tool call has not finished. The target is the headline of the latest one started (`toolHeadline`: its target, else its name), followed by `+N` for further calls running in parallel. A running MCP call is named the way its own row names it. When only subagents work, the row shows `Subagent <name>` and `+N`.
  - `Writing`: the last event of the turn is an answer delta.
  - `Thinking`: anything else (thought stream, waiting for the model after a send or after a tool).
- **Elapsed time** counts from the `at` of `turn.started`, or from the click before the echo. It uses whole seconds in the footer's format (`34 s`, `1 min 4 s`) and is not shown during the first second. When the turn ends, the footer takes the same place with the same duration.
- **One timer.** The status row seconds and the tool-row timers all tick from one shared second timer (`useSecondTick`, `ui/second-tick.ts`), never a `setInterval` per row. The timer stops when no row is subscribed and while the window is hidden.
- **Motion.** Only the icon spins; text never animates. Under `prefers-reduced-motion` the icon is still.
- **Accessibility.** The row has `role="status"`. The state word and the target are announced; the seconds are `aria-hidden`.

<a id="turn-footer"></a>
### Turn footer

Each completed turn ends with a footer: `Done · 1 min 4 s` (or `Interrupted` / `Error`), then `Copy response`, `Turn actions` (`…`), an optional background chip, and **changed-file chips** with `+N −M`.

- Chips come from the turn's **snapshot checkpoints**, not from parsing tool calls (see [Diff and review](diff-and-review.md)). They are the real delta of the turn, including changes made through the terminal (`sed`, code generators). `activity:turn-changes` (`readTurnChanges`) returns at most 200 files plus `total`.
- Clicking a chip opens the Changes panel and the diff on that file, limited to the turn's range.
- The chip path is truncated **from the left**, with the file name in bold (`FilePath`), the same pattern as the diff file header and the sidebar repo section.
- **Two lines at most.** The footer, including `Done · time`, the buttons and the chips, takes at most two lines. A measurement against the chat width (re-run on resize) decides how many chips fit. At the end of the second line an S button `Show all · N` (N = all changed files of the turn) takes the place of the last chip if it would otherwise wrap to a third line. Expanded, the footer shows every chip (up to 200) and `Show less`. When the turn changed more than 200 files, a `Show changes · N` button also shows; it opens the Changes panel on the turn's range. If everything fits in two lines there is no button. The expanded state is local to the footer and not saved.
- On one line the chips stand on the right; once they wrap they follow the buttons.
- The `…` menu (native) has `Copy response` and `Show changes`; `Show changes` is disabled when the turn has no range.
- Copy failures and read failures are toasts; the footer only shows `Copied` for 2 s.

<a id="agent-started-turns"></a>
### Turns the agent starts

Claude Code starts a turn by itself when a background task finishes or when a peer sends it a message. These are real turns: the agent works and can change files.

- **Domain.** The host writes the usual `turn.started` with `origin: 'agent'` and empty `text`, and the usual `turn.completed` when the agent reports idle. There are no new event kinds. Everything that reads the journal (status `working` → `done` / `interrupted`, `needs-you` on a permission card, `activitySeq`, the end-of-turn notification, keep-awake, `ask_user` and `create_task`) works without special cases. Retrying a turn after a sign-in failure skips agent turns, since there is nothing to resend.
- **Transport signal.** Claude reports its state through the raw SDK message `session_state_changed`, requested via `_meta.claudeCode.emitRawSDKMessages` with the filter `{type: "system", subtype: "session_state_changed"}`. Codex reports it through `threadStatus`. An agent turn opens when the agent is not `idle` (Codex: `active`) and all of these hold: there is no prompt of ours, no steer is in flight (`steerWatch`), and `initialize` has finished (history replayed by `session/load` opens nothing). It closes on `idle` (Codex: any status other than `active`) once every prompt the person added has been answered. `turn.completed` is queued inside the status handler: after everything the turn sent and before anything from a later turn. Its reason is `cancelled` after Stop, otherwise the `stopReason` of the last added prompt, otherwise `end_turn`. The host gives the transport the `agentTurn(finished)` hook. Without the hook, agent turns are not tracked.
- **Host.** On the hook the host does what it does for a person's turn: a `turn` checkpoint, `busy`, a new turn generation, tool counters and `turn.started {origin: 'agent'}`. The end goes through the same `turnFinished` and then the queue.
- **Races.**
  - The host is starting a prompt (`beginPrompt` between `busy` and `send`). The hook answers "no" and the turn belongs to the host's prompt. If `send` won the race, the transport hands the turn over (`taken`): Claude folds the prompt into its loop, so there is one turn with the person's row. If the previous turn has just ended and `busy` is still set, the hook waits for `turnFinished`.
  - The person presses Enter during an agent turn. The message is held to a step boundary, then sent with `_session/steering`. Claude answers `promptRequired`, so the transport sends it as `session/prompt`, which the same turn answers. `prompt.steered` stays and the turn stays one turn (see [Steering](composer-steering-queue-and-ghost.md)).
  - The agent starts a turn while ours is still closing. `idle` → `running` can come about 50 ms apart. `turn.completed` is queued in the same step as the prompt response, and the transport remembers that turn's number. So `running` after it opens the agent turn at once, even before `busy` is released, and its `turn.started` is ordered after our `turn.completed`. A repeated `running` with no `idle` in between opens nothing.
  - `⌘↩`, the queue, crew prompts and reviews: FIFO after the agent turn ends, as after any turn.
  - Stop sends `session/cancel`. Claude closes the turn at once (`turn.completed cancelled`, status `interrupted`). If `idle` never arrives, the transport closes the turn itself after 20 s (`BRIGADIR_STEER_STOP_MS`, default `20_000`).
  - Host restart during an agent turn: the last boundary in the journal is `turn.started`, so the new host writes `host.stopped`, and held messages become a paused queue, as for any turn.
- **UI.** Nothing new. The log shows no person bubble: after the previous footer come the agent's calls and text, the status row and the turn's own footer. The sidebar, notifications and composer island (`Stop`, send now or queue) take the turn from the journal.
- **Codex.** `codex-acp` starts turns only on a client request (`session/prompt`, `_session/steering`, `_session/goal`, which Brigadir does not send). The `threadStatus` path would open a turn the same way if Codex ever started one by itself. This has not been confirmed live.
- **Known limits.** An adapter without raw `session_state_changed` gets no agent-turn tracking. Updates of an agent loop that arrive before the host's own `turn.started`, when the host prompt starts at the same instant, land in the previous turn. A lost `idle` leaves the turn "working" until Stop (plus 20 s).

<a id="background-commands"></a>
### Background commands

A command the agent runs with `run_in_background` (Claude Bash) ends its tool call at once, but the work goes on. The chat shows that work in an `In the background · N` deck, a footer chip and a sidebar line.

**Source (Claude only).** The source is the raw SDK `task_*` messages, requested together with `session_state_changed` (`emitRawSDKMessages` filters `task_started`, `task_updated` and `task_notification`). JetBrains AIR `asyncTasks` is deliberately not used: as a capability it changes the rest of the wire. Claude loses `output` of finished Read/Bash calls, `parentId` of subagent calls and `subagent.changed`; Codex loses `exitCode` and changes `rawOutput`.

- A background command is `task_started` with `is_backgrounded: true`, or a later `task_updated {is_backgrounded: true}`. `local_agent` (subagents), `local_monitor` and anything with `subagent_type` are ignored.
- The end comes from `task_updated {patch.status}` / `task_notification {status: completed | failed}`. A non-zero exit is `failed`. The output file (`…/tasks/<id>.output`) is named in the tool result. The wire carries no live output or progress.

**Domain.**

| Item | Shape |
| --- | --- |
| Start | `background.started {id, toolId, name}`, where `name` is the agent's own description |
| Change / end | `background.changed {id, state?: completed \| failed \| stopped, reason?: person \| closed \| restarted, outputPath?}`. The end is journaled once |
| Command | `stopBackground {id}` |
| State | `core/background.ts`: `backgroundCommands`, `liveBackground`, `backgroundDeck`, `turnBackground`, `backgroundSummary`. A command with no end before a `host.stopped` or a new `session.started` counts as `stopped` |
| Ids / paths | `isBackgroundId` (`[A-Za-z0-9_-]{1,96}`); `isBackgroundPath` (absolute, no `..`, ends in `/tasks/<id>.output`) |

**Behaviour.**

1. **Stop.** The transport sends `SIGTERM` to the processes that hold this command's output file (found with `lsof`). Only descendants of its own adapter (checked through the `ppid` chain) are signalled, and the whole group when the shell leads it. It journals `stopped` (`reason: person`) at once; a later SDK `failed` does not become a second end. Claude then wakes up and replies briefly that the command was killed; that reply is a new agent turn.
2. **Output.** Only the host reads it, and only the file the adapter named for this command. It is read-only, at most 64 KB (`backgroundTailBytes`) from the end, keeping the last 200 lines (`backgroundTailLines`). An empty file shows `No output yet`; a missing file shows `The output file is gone.` IPC `session:background-output` → host `background_output`.
3. **Closing the task or the app, restarting the host.** Brigadir leaves the command alone: no stop, no prompt, no notification. Before `host.stopped` the host journals each live command as `stopped` with `reason: closed`; a new host journals `reason: restarted` at start. The UI shows the same "stopped" as after Stop, and the reason stays in the journal. While a background command is alive, the host does not shut down for inactivity.
4. **Deck.** It sits over the composer island and shares the `ui/Deck` component (`Deck`, `DeckList`, `DeckRow`) with the prompt queue: two lists of one deck, background above the queue. The list is labelled `Background commands`. A row shows the state icon, the name, the time since start (whole seconds, none for the first), `Output` and `Stop`. Rows are size S (24 px). Hover covers the whole row, the buttons hover on top, and focus draws an accent ring. When a command ends:
   - finished: `background finished · <time>` for 4 s (`backgroundSettleMs`), with no actions, then the row leaves;
   - failed: `error · <time>` with `Output` and `Remove`, until the agent's next turn begins or the person removes it;
   - stopped: the row leaves at once. After Stop an info toast says `The background command is stopped`; stopping is a neutral action by the person, not a success.
5. **Output popover.** A `ui/Popover` over the row with the header `Output`, the dim command name, `Stop` (while running) and `Esc` (`ui/PopupClose`). The tail (`Last lines · updates every second`) refreshes every second while the command runs.
6. **Footer chip** on the turn that started the command. While commands run it reads `⟳ in background N`, and a click scrolls the deck into view and highlights it. After they end it shows a summary: `✓ background command · <time>` for one, or `N background commands`. The icon is the worst state (failed, then stopped).
7. **Sidebar.** When the turn is over, the card shows the turn-finished state with no fill (fill means the agent is working). Under the title it shows a quiet line, `⟳ In the background · <name>` or `In the background · N background commands`, in `--fg2`. Its icon spins slowly and stays still under reduced motion. While the agent works again, the card shows its normal action line. The host keeps the summary in `task.background`.
8. **Notifications** follow the existing `When` picker (see [Notifications](notifications-slack-notes-and-schedules.md)):
   - A failure notifies like a failure (`The background command failed.`) for every value except `Never`.
   - A success notifies like the end of a turn (`The background command finished.`), only if the agent does not start a turn within 5 s. If it does, that turn's end notification is the only one.
   - A stop (by the person, by closing, or by a restart) never notifies.

<a id="plans"></a>
## Plans

<a id="plan-entities"></a>
### Three kinds of plan

| Entity | Who | Source | Where |
| --- | --- | --- | --- |
| **Plan row** (`PlanRow`) | Any agent | ACP `session/update` `plan`, normalized to `plan.changed {entries}` | One row in the transcript |
| **Plan for approval** | Any agent in plan mode | A permission whose tool kind is ACP `switch_mode`; plan documents `plan.document` | A card in the chat |
| **Plan card** (`PlanCard`) | The Foreman | `crew.plan.requested` / `crew.plan.resolved` | A card in the Foreman's chat |

The UI names are kept apart (`Plan row`, `Plan card`). The plan row is fed **only** by ACP `plan`. The app never reads `TodoWrite` / `TaskCreate` tool calls and never synthesizes a plan from reply text. The adapter does that translation.

<a id="plan-row"></a>
### Plan row (agent checklist)

- **One live plan per session.** Each `plan` carries all `entries` and replaces the previous one, so the row is updated in place instead of a new row being added.
- **Collapsed by default, laid out like a tool row.** It shows a chevron, the plan glyph, `Plan`, `d/n` in monospace, then one segment per step: done steps in a secondary colour, the current step in accent, the rest in the separator colour. With more than 12 steps (`planSummary(...).segments === false`) the segments become one progress bar so the row does not grow. Next comes the current step's text, truncated. With no current step it shows the next pending step, and when every step is done it shows `done`.
- **Expanding.** A click opens the list (`<details>`, like tool rows), indented 24 px. A completed step has the done glyph and struck-through text; the current step has the working glyph in accent with primary text; a pending step has an empty circle. Step icons are labelled `Done` / `Working` / `Queued`.
- **Whole plan on the spot.** When the checklist has a plan behind it, the row shows the S ghost accent button `Whole plan · N lines`. It is the same button as on the approval card. It opens a card under the row with the plan's Markdown and the same frame as the approval card, with `Collapse plan` at the bottom, and the button reads `Collapse plan` while the card is open. This is separate from the chevron: it never expands the steps. The open state lives with the task's other activity expansions. The plan behind the checklist (`checklistPlan(records, before)`) is the last plan for approval before the checklist (Claude: the `ExitPlanMode` text), else the last plan document the agent did not remove (Codex `plan_update`). With neither, there is no button.

<a id="checklist-tools"></a>
### Making agents keep a checklist

Neither provider sends `plan` out of the box. The transport and the session brief turn it on.

| Provider | What Brigadir sets | Override |
| --- | --- | --- |
| Claude | `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` in the adapter environment. This gives Claude `TaskCreate` / `TaskUpdate` / `TaskList` / `TaskGet`, and the adapter emits `plan` on each change | A value the person set (including `0`) is kept |
| Codex | `tools.update_plan.enabled = true` in `CODEX_CONFIG`. `codex-acp` translates `turn/plan/updated` into ACP `plan` | A person's own `tools.update_plan` is kept, and other `tools` keys and `mcp_servers` are preserved. The person's `~/.codex/config.toml` is never written |

Every session's first prompt gets a hidden `Brigadir brief` block (in `.context`). Sessions without a crew get it too. The brief includes `checklistBrief` (English): keep a step checklist with the todo, task or plan tool (`update_plan` in Codex) for work of three or more steps, mark each step, and do not repeat the checklist as a list in messages. See `sessionBrief` in `packages/host/src/crew.ts`.

<a id="plan-approval"></a>
### Plan for approval

A plan the agent writes in plan mode, so the person can read it, edit it and approve it.

**What the providers send.**
- Claude in `Plan` mode writes its plan file, then calls `ExitPlanMode`. This arrives as a permission request whose tool kind is `switch_mode`, with the plan Markdown in `content` and options such as `Yes, and use auto mode`, `Yes, clear context … and use auto mode`, `Yes, and bypass permissions`, `Yes, manually approve edits` (`allow_once`) and `No, keep planning`.
- Codex in `Plan` collaboration sends the plan as ACP `plan_update` (kind `markdown`), because the client declares `clientCapabilities.plan`. After the turn it asks for permission to implement, with one `allow_once` option (`implement`).
- **Reaching plan mode.** A Claude session that talks to the person (no crew, or the Foreman) gets `planApprovalBrief`: when the person asks for a plan before work starts, enter plan mode with `EnterPlanMode`, research without changes and present the plan with `ExitPlanMode`, never as a plain message. `EnterPlanMode` works from `auto` without a permission prompt. Workers do not get this sentence, because their counterpart is the Foreman. Codex cannot enter `Plan` by itself; the person picks it in the agent menu (see [Agents and providers](agents-and-providers.md)). The app itself never switches modes based on words in the prompt.

**Rules** (`core/plan-approval.ts`, `PlanApproval.tsx`):

1. **What counts.** A permission request with `tool.category === 'switch_mode'` (`isPlanApproval`). The plan text is the tool's text `content`, else the last plan document of the session before the request that was not removed (`planApprovalText`). `rawInput` (for example `planFilePath`) is never read. A `switch_mode` permission without any text stays an ordinary permission card.
2. **Plan documents.** The transport declares `clientCapabilities.plan` and maps `plan_update` kind `markdown` → `plan.document {planId, text}` and `plan_removed` → `plan.removed`. Kinds `items` and `file` are not shown. While the agent writes a plan without a request, the transcript shows a `Plan · <agent> is writing…` card at the place of that `planId`'s first `plan.document`, updated in place.
3. **Card.** It takes the request's place in the chat, at the width of the conversation column.
   - Header: a "waiting for you" dot, the document glyph, `Plan for approval`, `<agent> is waiting for approval`, an `edited in the editor` badge when it applies, and `Open in editor` on the right.
   - Body: the chat's Markdown renderer, folded to about 210 px with a fade, plus `Whole plan · N lines` / `Collapse plan`.
   - From the second revision on, a bar over the body switches `Changes · Plan` (see [Changes between revisions](#plan-revisions)).
   - Footer: the file name of the plan copy, `Plan further…` and a split `Approve plan` button whose chevron (`How to approve`) lists the agent's options.
4. **Approve plan returns the mode the session had before the plan.**
   - The prior mode comes from the journal (`planPriorMode`). The mode sequence is built from `session.started` `modeId`, `mode.changed` and the value of the `mode` option category from `session.started` / `options.changed`, with repeats dropped. The last entry is the plan's mode and the entry before it is the prior mode. With no transition, there is no prior mode.
   - Option choice (`planApproveChoice`), with no per-agent table. Take the words of the prior mode's id and name (from `availableModes` or the mode option; camelCase is split, so `acceptEdits` → `accept edits`) and find the `allow_*` options whose `optionId` + name contain all words of the id or all words of the name. Of those, take the single minimal one: the one whose words are a subset of every other candidate's. So `auto` → `exit-plan-auto` (not `exit-plan-clear-auto`), `default` → `exit-plan-default`, `bypassPermissions` → `exit-plan-bypass`.
   - No single match, for example `acceptEdits` when `auto` exists. `Approve plan` sends the first `allow_once` (else the first `allow_*`) with `returnMode` on the `answerPermission` command. The host remembers the plan's mode and the target. The first time the agent leaves the plan mode for a different mode within that turn, the host follows up with `session/set_mode` to the target. This is the only mode change the host makes mid-turn; the person still changes modes between turns. If the agent never leaves the plan mode within the turn (Codex), or the person changes the mode, the return is cancelled. A mode outside the agent's catalog is not returned. `permission.resolved` stores `returnMode`.
   - No prior mode, or a manual one: `allow_once`, with no `returnMode`.
   - Picking from the chevron menu is an explicit choice and does not ask for a mode return. The checkmark in the menu marks the option `Approve plan` would send.
   - Codex: the `Plan` collaboration does not change the session mode, so the words never match and `Approve plan` sends `implement` (`allow_once`) with `returnMode`. The agent does not leave the mode within the turn, so the host cancels the return.
   - The macOS notification's `Allow` on a plan request stays `allow_once`.
5. **Plan further…** opens the field `What should change in the plan?` (`⌘↩ send · Esc cancel`, `Cancel`, `Send to the agent`). It answers with the first `reject_once` (else the first `reject_*`) and then sends the English prompt `planFeedbackPrompt(text)`.
6. **Open in editor** writes a copy of the plan into the task folder, `plans/<slug>-<hash8>.md`. The slug comes from the first heading or line: ASCII, at most 60 characters, `plan` as fallback. The hash is the first 8 hex characters of the request id's SHA-256. There is one file per request, never overwritten. The copy opens as a normal editor tab in code view. Main reads and writes it as a `plan` resource, which is writable with no lock and no snapshot, because it is app data, not the work tree. The agent's own plan file is never touched. If opening fails, an error toast offers `Retry`.
7. **Edited in the editor.** While the request is live, the card polls the copy every 1.5 s and on window focus. When the copy differs (`samePlanText` ignores line endings and trailing blanks), the header shows `edited in the editor` and `Approve plan` becomes `Send edits`. That sends `reject_*` plus `planEditsPrompt(copy)`, which gives the agent the whole edited text and asks it to present the plan again. A plan the agent has not seen can never be approved.
8. **After the answer** the card folds into a row with a chevron that expands the plan read-only, with the same `Changes · Plan` bar from the second revision on; `Open in editor` stays.
   - Approved: `The plan is approved · <mode>`. The mode is the actual mode after approval (`planApprovedMode`): within the approval turn, `returnMode` if the session reached it, else the first mode after the plan's own. Its name comes from `availableModes`, else the mode option. With no transition there is no mode.
   - Rejected: `Plan in revision`, plus the person's own words recovered from the feedback prompt (`planPromptFeedback`).
9. **Sidebar.** A task with such a request shows `Plan for approval` in place of the permission line.
10. **Chat hidden.** When the plan copy is open in the editor and the chat is not visible, the space above the document shows a single line, `Plan for approval · <title> · <agent> is waiting for approval`, with `Back to chat`, in place of a generic permission card.
11. **Chat while the plan waits.** <a id="plan-chat"></a>The person can talk to the agent about a plan that waits for approval. Enter in the composer (a `prompt` with `steer`, desktop or phone) is not held behind the request:
    - The host answers the plan request with its first `reject_once` (else the first `reject_*`), then queues the message as `planChatPrompt(text)` without `steer`, so it runs right after the agent's turn ends. The English prompt says that the person wrote while the plan waited: answer a question, revise the plan only where the message asks for a change, and present the plan for approval again, unchanged when nothing changes.
    - `⌘↩` (the queue) keeps its meaning and waits behind the request like any queued message.
    - The person's row shows only their own words (`planChatWords`). The folded card reads `Plan in revision` with no quote.
    - While the request waits, the composer placeholder reads `Ask about the plan or say what to change`.
    - Without a reject option, the message is held as before.

There is no global `⌘↩` for `Approve plan`, because it would collide with the composer. Shortcuts exist only inside the `Plan further…` field.

<a id="plan-revisions"></a>
### Changes between plan revisions

Each time the agent presents the plan again, the card shows what changed since the plan before, in the plan's own Markdown (`core/plan-revisions.ts`, `diff/plan-diff.ts`, `PlanChanges.tsx`).

1. **Revisions come from the journal.** A revision is a plan for approval with text (`permission.requested` with `switch_mode`, its text by `planApprovalText`). Its number is its place among those requests of the session, from 1. Nothing new is stored.
2. **What it is compared with** (`planRevisionBase`): the revision before it. When the person answered that revision with `Send edits`, the base is the edited text recovered from the prompt (`planEditsPrompt`), because that is the version the agent received. The first revision has no base and its card looks as before: no bar, no counters.
3. **Bar.** Over the body: `Segments` (row size S) `Changes · Plan`, the hint `since revision N` (`since your edits` for an edited base) and the `+N −M` of `ui/ChangeCounts` on the right. The counters count changed non-empty lines.
4. **Changes view.** The plan's Markdown, block by block (a heading, a paragraph, a list item, a quote, a whole table or code block). A block is matched with the old one of the same kind when at least 60 % of the old words stay (and 30 % of the new):
   - an added block on `--diffAddedBg` with a 3 px green bar on the left;
   - a removed block on `--diffRemovedBg` with a red bar, its text struck through in the secondary colour;
   - a changed block with an accent bar; inside it, removed words are struck through on a red tint and new words sit on a green tint, the word diff of the file diff. A table or a code block is never split into words: it shows removed, then added;
   - the title (the first heading) always shows. A section (from a heading to the next one) without changes folds; a run of such sections is one `DiffFold` band: `<names> · unchanged` (one or two names, else `N sections`) and its line count on the right. Inside a changed section a run of more than two unchanged blocks between changes folds the same way into `N unchanged lines`. A click on a band shows its blocks in place.
5. **Folding.** The view folds to the body's 210 px like the plan; under it `All changes · N sections` / `Collapse changes` and, on the right, `Whole plan · N lines`, which switches to `Plan` and opens it whole.
6. **Which view opens.** `Changes`, unless more than half of the lines changed (added and removed lines over the lines of both sides): then `Plan`, with the amber tag `Rewritten` and the hint `most lines changed since revision N`. A revision with nothing changed opens on `Plan` too, with the hint `no changes since revision N`. The choice belongs to the card and is not stored.
7. **Folded rows** of answered revisions (`Plan in revision`, `The plan is approved`) open with the same bar against their own base.

<a id="crew-plan-card"></a>
### Foreman plan card

The Foreman's proposed split appears as a card in its chat at the place of `crew.plan.requested`, at the width of the conversation column. It is not a modal, so `Esc` only cancels a prompt edit. The orchestration flow (`propose_plan`, the Foreman composing the crew, attention) is described in [Crew](crew.md).

- **Header.** The helmet glyph, `The foreman proposes a split`, provider glyphs of the crew and `crew <name> · N agents` (four Ukrainian plural forms). Below the header comes the Foreman's full summary, 13 pt in the primary colour.
- **Part = brief section.** A 20 pt numbered circle, a title that is always a field (`ui/TextInput`, row size S, max 80 characters), `assigned to` and the agent chip with a popover of the node's children. Below that are the files in monospace and the scope tags, then the worker **prompt** (12 pt / 1.55, secondary colour) folded to two lines, with `Whole prompt` / `Collapse prompt`.
- **Editing a prompt in place.** Hovering shows `Edit prompt`, and a click turns the text into a field. `⌘↩` (shown as `Done ⌘↩`) closes the edit and `Esc` restores the text from before it.
- **Differences next to their part.** Each difference with a `partId` shows in amber under its part with a warning glyph; the part number and the agent chip border turn amber too. The app builds the text from the difference's code and fields (`agent`, `part`, `zone`, `outside`) in the UI language; the English `message` is for the agent. Differences with no part (`idle_agent`, `empty`) go to the footer.
- **Footer.** It shows `N parts for M agents` and, with reviewers, `· <names> checks each`. When something blocks, it shows `Part {n}: differences with the crew. Start waits for a fix.` in amber. On the right are `Reject` and `Start workers`. `Start workers` is disabled while a blocking difference, an empty title or an empty prompt remains (`Every part needs a title and a prompt.`).
- **After the decision** the card becomes a framed row: helmet, `Plan approved` or `Plan rejected`, `N parts`, then the agents with glyphs (approved) or `the foreman will make a new plan` (rejected), and the time and a chevron on the right. The chevron expands a read-only list of parts (number, title, agent). The source is `crew.plan.resolved`: its `parts`, or the request's parts when the person did not edit anything.

<a id="questions"></a>
## Questions

<a id="ask-user"></a>
### `ask_user`: the agent asks the person

A question is a **tool call**, not text in the turn. The agent calls the Brigadir MCP tool `ask_user`. The call **blocks the turn** until the person answers, and the answer comes back as the tool result. This is the only way a task enters `needsYou(question)`.

| Field | Meaning |
| --- | --- |
| `question` | The question, Markdown, required (trimmed, 1–100 000 characters) |
| `header` | A short topic label for the card chip (≤ 100 characters, default empty) |
| `options` | Up to 100 `{label, description}` choices (default none) |
| `allowsFreeText` | Whether the person can type an answer of their own (default `true`) |
| `allowsMultiple` | Whether several options can be picked (default `false`) |

- **An answer of the person's own is always available unless the agent forbids it.** The option set is the agent's guess at the answer space and is often incomplete.
- **The answer is text, not an index.** The result is `{labels, text}`: the chosen labels plus any free text. An index would mean nothing in a later turn.
- The tool description tells the agent not to use it for anything it can check with its own tools. The call is refused (`Question is invalid or no turn is active`) when the payload is invalid or no turn is active. That works in agent-started turns too.
- **Available to every task.** The tool socket and `brigadir-mcp` run for all sessions, and `ask_user` is offered to ordinary tasks, workers and the Foreman alike. The orchestration tools stay Foreman-only (see [Crew](crew.md)). The host's `SessionHost` answers `ask_user` itself, before the orchestration dispatcher, so an ordinary task still has no dispatcher at all.
- **Journal events.** `question.requested {question}` is written *before* the person answers, and `question.resolved {id, answer | null}` when it ends. The task's state therefore comes from the journal, so the sidebar, the board and a restarted app all see "waiting for you", not just an attached window. The status fold treats them like a permission: requested sets `needs-you`, resolved clears it.
- **No timeout of ours.** A closed app delays the answer but never loses it. The adapters' own tool timeouts are pushed out of the way: when the `brigadir` MCP server is attached, Claude gets `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT = 604 800 000` ms (7 days, unless the person set it), and Codex gets `tool_timeout_sec = 604800` on the `brigadir` server, also in CLI launches. There is never a default answer on the person's behalf.
- **Endings without an answer.** The person presses `Skip` (`answerQuestion` with `answer: null`), the turn is stopped (the call's abort signal), or a host restart finds the question still pending (`pendingInputs`). In each case `question.resolved` gets `answer: null`, and the agent gets the error `No answer was provided`; what to do next stays the agent's decision.
- A held mid-turn message is flushed once the question resolves.

<a id="question-card"></a>
### Question card

`ui/SessionInputs` `Question`, shown in the chat at the place of `question.requested` while the question is pending.

| Part | Look |
| --- | --- |
| Card | Body `--card`; border `--amber` mixed 50 % with `--sep`; radius 10; no padding of its own. Content below the header has 14 px side and 12 px bottom insets, 10 px between blocks |
| Header strip | `--amber-soft`, padding 7 × 14 px, bottom line `--amber` 28 %. It holds the glyph, `Question`, the `header` chip (`--tint`, text `--fg`, no border) and on the right `waiting <age>` (11 px, `--fg2`, shown after one minute) |
| Question | Markdown, 13 px, weight 500 (see below) |
| Options | **One list**: border `--sep`, radius 8, background `--content`; rows 8 × 10 px with no border of their own, separated by `--sep` lines. Hover is `--tint` over the whole row, description included; selected is `--accent-soft`. The last row's fill reaches the list border |
| Radio / checkbox | Empty state: a 1.5 px `--fg2` ring with no fill. Option description: 11 px `--fg2` |
| Own answer | The last row of the list: a field with placeholder `Your answer…` (`--fg2`) and a radio or checkbox that is checked while the field has text |
| Footer | Hint (11 px): `{key} to answer`, or `{n} selected` when several are chosen. `Skip` and `Submit answer` are 11 px buttons on `--tint` with no border, hover `--fg` 11 %. `Submit answer` stays the primary (`--accent-fill`) button at 45 % opacity until the answer is valid, never grey |

- The amber lives only in the header strip and the border, so the "needs you" signal is where the eye looks, and text and controls sit on surfaces their tokens were chosen for. The **permission card** (strip with `Permission` and the tool and path, actions below) and the **crew question row** (strip with the question, then the escalated answer) belong to the same family.
- **Markdown.** On desktop the question text renders with the chat's `MarkdownBlock` (`QuestionText`: code, bold, lists, links, code highlighting and task file links); `Question` takes a ready `body`, like `PermissionCard`, and falls back to plain text without one. The phone renders it with its card Markdown, in task questions and escalated worker questions. Blocks within one question are 6 px apart. Option labels and descriptions stay plain text.
- **After resolution** the card collapses to the plain-text line `<question> · Resolved`. The `question.resolved` row shows the answer, `labels · text`, or `No answer`. One-line summaries (the resolved line, the sidebar activity, the crew question row) stay plain text.
- On the phone the card uses touch sizes (52 px rows, 44 px buttons) and no key hint. A crew question on the phone has no `Skip`, because the worker waits for an answer.

<a id="later"></a>
## Later

- Marks on the turn rail for a turn that failed or waits for a permission, coloured like the sidebar state.
- Background commands for Codex. Its background terminals exist only through AIR `asyncTasks`, which alters `exitCode` and `rawOutput` of ordinary calls.
- Plan documents of kinds `items` and `file`.
- Comparing any two revisions of a plan, not only a revision and the one before it.

<a id="non-goals"></a>
## Non-goals

- Live token counts in the status row. Neither provider gives a reliable per-turn number mid-turn.
- Joke verbs ("Pondering…") or shimmer/pulse animations on the status text.
- A marker row such as "the agent continued after a background task" at the start of an agent turn. The footer, the work, the status row and the next footer already read clearly, and the background chip says how the command ended.
- Plans or questions guessed from reply text: numbered lists, `[x]` / `[ ]`, trailing question marks, headings.
- Reading provider-specific tool calls (`TodoWrite`, `TaskCreate`, `rawInput.planFilePath`) or keeping a per-agent table of option ids.
- Switching sessions into `Plan` mode based on words in the prompt.
- Answering a question for the person after a timeout.
- Markdown in question option labels.
- Stopping, asking about or notifying for background commands when a task or the app closes.
