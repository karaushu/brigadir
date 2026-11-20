# Smoke run and Ready to look

Two things the host does around a task's running app that are not reviews. A **smoke run** is one pass of an agent
through the flows a change touches, in the browser or on the simulator, under a time limit the host enforces: at the
limit the host takes the browser and the simulator away and asks for the report, so the findings are kept and the
check ends. **`Ready to look`** is the agent telling the person that a screen is assembled and can be looked at, while
the agent works on: the person often finds in minutes what agents miss, so they should see the screen as early as
it exists.

<a id="who"></a>

## Who runs a smoke, and when

- **A change a person can see, in a project with the browser or the simulator module on**, gets one smoke before the
  review before the PR: on the finished work, once, by one agent. Whether the change shows in the running app decides,
  not the task's [class](reviews.md#classes): a Small task that changes a screen runs one too, a Large one that
  changes no screen runs none. The agent decides whether its change shows; its brief and its class's `next` say so
  ([Briefs](#brief)).
- **Solo and Auto tasks:** the task's own agent runs it. An Auto agent runs it once its hired parts are back, on the
  integrated work; its workers do not (`smoke_start` refuses them and refuses the Auto agent while its workers run).
- **A named crew:** the foreman gives the smoke as a part to one worker, after the parts it covers were accepted
  ([Checks in the running app](crew.md#smoke)); that worker runs it with the same tools. Nobody reviews the report:
  the foreman reads it.
- **No browser or simulator module:** no smoke tools, no smoke sentence in any brief or prompt, no `ready_to_look`. The
  person checks the running app; reviews read the code only.
- **The review loop is where a missing or failed smoke counts** ([below](#review)); the host starts nothing and holds
  no `Create PR` for a smoke.

<a id="start"></a>

## `smoke_start`

MCP `smoke_start(steps)` — a tool of a solo task's agent, an Auto agent and a crew developer, listed while the
browser or the simulator module is on. Not of a foreman, a lead or a reviewer, and not of a terminal (CLI) session:
the host cannot ask it for the report, so it lists neither smoke tool (`ready_to_look` stays).

- `steps`: 1–12 lines of 1–120 characters, the flows the run goes through in the order it runs them (`Clients list`,
  `Client card · tabs`, `Add a note`). A flow, not a matrix: no repeat per device or theme unless the task is about it.
- The host journals `smoke.started` with the steps and the limit, and answers
  `{started: true, limitMinutes, endsAt, next}` — `next` (English, rule 12): go through the steps once with the
  browser or simulator tools, then call `smoke_report`; at the limit those tools stop answering and the report is due.
- **The limit** is Settings ▸ Agents ▸ `Reviews` ▸ `Smoke run limit`: minutes, default 10, 1–60. It is read at
  `smoke_start`; a change of the setting reaches the next run, not the running one.
- Refused: while a smoke of the task is open (`A smoke run is already open: file its report with smoke_report.`), by an
  Auto task's hired worker (`The smoke runs once on the integrated work: the agent that hired you runs it.`), by an Auto
  agent while its workers run (`Workers of this task still run: start the smoke when their parts are back.`), and when
  both modules are off (`The simulator and the browser are off in Settings.`).

<a id="limit"></a>

## The limit

The run is open from `smoke.started` until its report or until it is dropped. The host measures wall time from the
start, across turns and restarts.

- **At the limit** the host journals `smoke.stopped` (`cause: limit`). From then until the report, every `browser_*` and
  `simulator_*` call of the task is refused with `The smoke run reached its limit of N minutes. Stop checking and file
  the report now with smoke_report: what you checked, what failed, and what you could not check and why.` The agent's
  turn is not cancelled: what it found stays in its context and goes into the report. Other tools (files, the shell,
  the project commands) keep working.
- **The host asks for the report** at once: into the running turn through steering when the adapter steers
  ([Steering](composer-steering-queue-and-ghost.md#steering)), else as a prompt when the agent is idle. A turn that ends
  with the run still open is answered once by the prompt (marker `smoke-report`): `Your smoke run is still open. File
  its report now with smoke_report: …`. The ask's own turn (begun with that marker, by the prompt or adopted from
  steering) ending without the report drops the run (`smoke.dropped`, `reason: no-report`). An ask that waits in the
  queue is not sent twice; one the person removed from the queue is sent again at the next turn end. When the run
  is reported or dropped, its asks still in the queue are taken out.
- **The person** acts on the [deck row](#deck) while the run is running: `+5 min` journals `smoke.extended` (the
  run's limit grows by five minutes, up to 60 in all); `Stop` journals
  `smoke.stopped` (`cause: person`), with the same refusal and the same ask for the report.
- **The person stops the turn** while a run is open: the run is dropped (`smoke.dropped`, `reason: cancelled`); the
  host asks for nothing.
- **Restart.** The run lives in the journal. A host that starts with a run open arms the limit for the time left; a
  limit that passed while it was down journals `smoke.stopped` then, and asks for the report as above. A run that
  was already stopped is asked again unless an ask waits in the queue: the old host may have stopped before it asked
  or during the ask's turn.

<a id="report"></a>

## `smoke_report`

MCP `smoke_report(steps, summary)` — the same agents as `smoke_start`, only while a run of the task is open.

- `steps`: 1–24 items `{step, result, note?}`; `step` 1–120 characters; `result` ∈ `passed | failed | unchecked`;
  `note` (≤ 500) is required for `failed` (what goes wrong, on which screen) and `unchecked` (why it was not checked),
  else refused: `A failed or unchecked step needs a note: what goes wrong, or why it was not checked.`
- `summary`: 1–2000 characters, the report in a few sentences for the person and the reviewer.
- The host matches the started steps to the reported ones by text (case and outer spaces ignored); a started step the
  report leaves out is kept as `unchecked` with the note `not in the report`. Extra steps are kept.
- The host journals `smoke.reported` (the steps, the summary, the time from the start, and `stopped` when the run was
  stopped) and answers `{reported: true, failed, unchecked, next}`: with failures, `Fix each failed step now; the
  review before the pull request reads this report.`; else `Go on with the task.` The browser and simulator answer
  again.

<a id="review"></a>

## Into the review loop

No second loop: the smoke's failures reach the [review](reviews.md#smoke) that already runs on the task.

- A mid-task review and a review before the PR add the task's newest smoke report to the reviewer's prompt (first read
  and closure check): when it ran, how it ended, each step with its result and note, and the summary.
- **A failed step** that the change since the report does not fix is a finding, at the line that causes it or at the
  screen's file. An unchecked step is not a finding by itself.
- **No smoke:** when the browser or the simulator module is on and the task has no smoke report, the prompt says so,
  and a change that shows in the running app is a finding: `No smoke run checked this change in the running app.` It
  goes to the agent as any finding; the agent runs the smoke as its fix, and the closure check reads the new report.
- A crew reviewer of a part does not get the paragraph: the smoke covers the integrated work, not a part.

<a id="deck"></a>

## The deck row

One row in the composer deck (`ui/Deck`, above the Review strip, with the queue and background lists), its own list
`Smoke run`, shown while a run is open. Not a step of the Review strip.

| State                         | Glyph               | Title · line                                              | Actions                  | Tone           |
| ----------------------------- | ------------------- | --------------------------------------------------------- | ------------------------ | -------------- |
| Running                       | spinner             | `Smoke run` · `6:12 left of 10 min`                       | `+5 min`, `Stop`, chevron | —              |
| The last minute               | spinner             | `Smoke run` · `0:48 left of 10 min`                       | `+5 min`, `Stop`, chevron | `--amber-soft` |
| At the limit, waiting report  | `stop`              | `Smoke run` · `stopped at 10 min · <agent> writes the report` | chevron                  | —              |
| Stopped by the person         | `stop`              | `Smoke run` · `stopped by you · <agent> writes the report` | chevron                  | —              |

- The time counts down each second (`m:ss`); the limit names the run's current minutes (`of 15 min` after `+5 min`).
- The row hovers as a whole (rule 15); a click on it or the chevron expands the run's steps under it: one line per
  step, numbered, in `--fg2`.
- The row goes when the report is filed or the run is dropped; the chat row takes over.

<a id="chat"></a>

## Chat rows

Service rows ([Chat](chat.md)), not cards:

- **The report:** glyph `check-pass` (`--green`) when nothing failed and the run ended in time, `agent-failed`
  (`--red`) when a step failed, `stop` (`--fg2`) when it was stopped; `smoke`, the time (`7m 40s`; a run stopped at the
  limit shows the limit, `10 min`), then `stopped at the limit` (`--amber`) or `stopped by you`, then
  `<checked> of <all> steps` — a link (dotted underline) that opens the steps — and `done` (`--green`) or `<n> failed`
  (`--amber`). Under it the summary as text. Opened, each step: its result glyph, the step and its note.
- **Dropped:** glyph `stop`, `smoke`, the time, `no report` (`--amber`), and `stopped with the turn` or
  `the agent did not report`.
- The tool calls `smoke_start` and `smoke_report` stay as their tool rows; the start has no service row.

<a id="ready"></a>

## Ready to look

MCP `ready_to_look(screen, where, tab?)` — a tool of a solo task's agent, an Auto agent and a crew developer, listed
while the browser or the simulator module is on.

- `screen`: 1–80 characters, what can be looked at (`Details screen`). `where` ∈ `simulator | browser`. `tab`: a browser
  tab of the task (default: the tab the agent opened).
- The host fills in where it is: the task's device (its last [device row](browser-and-simulator.md#sim-chat-row)) or
  the tab's address. Refused when that module is off, when the task has no device yet (`Open the screen on the device
  first with simulator_open.`) or no page open in that tab (`Open the page first with browser_open.`).
- **Once per screen.** The same `screen` again (case and outer spaces ignored) journals nothing and answers
  `{notified: false, reason: 'The person was already told that <screen> is ready to look at.'}`. Otherwise
  `{notified: true}`; the call never waits, and the agent goes on.
- The host journals `task.ready` (`id`, `screen`, `where`, `device?`, `tab?`, `url?`).
- The brief says when ([Briefs](#brief)): as soon as a screen is assembled and shows in the browser or on the
  simulator, before the agent's own checks of it, once per screen.

<a id="ready-surfaces"></a>

### Where the person sees it

- **Chat row:** glyph `simulator` (or `browser`) in `--fg2`, `ready`, the screen, the device (or the page's host and
  path), and `Show` — a link (dotted underline at rest, solid on hover) that opens the task's simulator tab, or that
  browser tab, in the work area.
- **Sidebar:** the activity line reads `Ready to look` in `--accent`, over the tool activity, until the turn ends or a
  request of the agent waits ([Activity line](sidebar.md#activity-line)); the unread dot shows. The card's fill and
  state glyph do not change: the task is still working, not `needs-you`. The phone's task card reads the same line in
  `--accent` too.
- **OS notification:** its own notice kind `ready` ([Notice kinds](notifications-slack-notes-and-schedules.md#notice-kinds)),
  title the task's title, body `Ready to look: Details screen on iPhone 17 Pro.` (browser: `Ready to look: Details
  screen.`). A click opens the task and shows the screen as `Show` does. It is not `needs-you`: no badge, no
  amber, no entry in the center's `Needs you`.

<a id="brief"></a>

## Briefs

English (rule 12), built from the modules that are on and the role, in the MCP `instructions` and the tools line of
Codex and the CLI ([Tools awareness](agents-and-providers.md#tools-awareness)):

- **Solo and Auto agents:** when a change a person can see is done, check it once with a smoke run before the review
  before the pull request — `smoke_start` with the flows it touches, through them once, then `smoke_report` with what
  passed, what failed and what could not be checked and why; the person sets a time limit, and at the limit the browser
  and simulator tools stop answering until the report is filed. An Auto agent adds: after the hired parts are back,
  not per part. As soon as a screen is assembled, call `ready_to_look` once for it.
- **A crew developer:** run a smoke only when the part's prompt asks for it, with the same tools; `ready_to_look`
  when a screen of the part is assembled.
- **The class's `next`** ([`set_task_class`](reviews.md#class-tool)) adds, with either module on: `If your change shows
  in the running app, check it once with a smoke run (smoke_start, smoke_report) before the review before the pull
  request.`

<a id="data"></a>

## Data

Journal events (rule 2); the run's state is derived from them, so it needs no document of its own:

- `smoke.started` — `id`, `steps`, `limitMs`.
- `smoke.extended` — `id`, `limitMs` (the new total), `by: person`.
- `smoke.stopped` — `id`, `cause` ∈ `limit | person`.
- `smoke.reported` — `id`, `steps` (`step`, `result`, `note?`), `summary`, `elapsedMs`, `stopped?` (the cause).
- `smoke.dropped` — `id`, `reason` ∈ `cancelled | no-report`, `elapsedMs`.
- `task.ready` — `id`, `screen`, `where`, `device?`, `tab?`, `url?`.

Host commands: `extendSmoke` (`id`), `stopSmoke` (`id`). Settings: `reviews.smokeMinutes` (1–60, default 10).

<a id="later"></a>

## Later

- A smoke run on the phone (the deck row and its actions).
- The person asking for a smoke from the deck when none ran.

<a id="non-goals"></a>

## Non-goals

- A check matrix, a reviewer of the smoke report, or a run per part.
- Cancelling the agent's turn at the limit (the findings would be lost).
- Refusing tools of other servers (the agent's own browser or simulator tools): the host refuses only its own.
