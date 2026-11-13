# Reviews

A review is a step the host runs on any task: another agent reads the task's changes once and lists findings, the
task's agent fixes them once or objects, the reviewer checks once whether its findings are closed, and whatever is still
open goes to the person. The same loop runs at every point of a task. This file is the one home of the loop; other
files link here.

<a id="points"></a>
## Points

| Point | `point` | Started by | Step name |
| --- | --- | --- | --- |
| The plan, before approval | `plan` | — (drawn, inactive; see [Later](#later)) | `Plan review` |
| Mid-task | `mid` | the agent ([`request_review`](#request-tool)); the host API also takes a host start | `Mid-task review` |
| Before the pull request | `pre-pr` | the person (the strip, `Review…`, the proposal), or the host when the person presses `Create PR` ([gate](#before-pr)) | `Review before PR` |

- **A review targets a task.** A solo task and a crew worker's part are covered the same way: a part is a task, and its
  review runs in the worker's own host. A worker's review carries the part number and the part's prompt and acceptance
  criteria; the crew's own check edge on parts ([Crew](crew.md#reviewer)) and its per-part round limit
  ([Crew](crew.md#review-limit)) stay as they are.
- One review of a task lives at a time. A finished review stays in the task's record, so each point shows its last
  result.
- Not in the main tree: a main-tree task has no reviews.

<a id="who"></a>
## Who reviews

One reviewer per review by default, resolved when the review starts. No knowledge about agents is coded in
([Agents and providers](agents-and-providers.md#providers)): the rule reads only the settings, the sign-in state and each
provider's own option catalog.

1. **The setting**, when set: Settings ▸ Agents ▸ Customize per action ▸ `Reviews` — `Plan review` (action
   `planReview`) for the plan, `Code reviews` (action `taskReview`) for mid-task and before-PR reviews. A remembered
   crew of `Code reviews` (from the launch dialog's `Remember for code reviews`) makes every agent below the crew's root
   a reviewer.
2. Otherwise **another provider** that is enabled, installed and signed in, with that provider's default model and
   effort from its own catalog (no launch options). Providers are tried in the app's provider order, skipping the
   task's own.
3. Otherwise **a fresh session on the task's own provider**, with that provider's defaults.
4. Otherwise nobody: the review is recorded as `failed` with `No reviewer is available: <reason>` and the strip says
   [`Review did not start`](#strip).

- The reviewer is named after its provider (`Codex`, `Claude`; `Codex 2` when the name is taken).
- When no app window is attached to the task's host, the host cannot read sign-in states: it takes rule 3.
- The person's launch dialog ([Starting](#start)) may pick an agent or a crew for that one review instead.

<a id="reviewer-sessions"></a>
### Reviewer sessions

- **A fresh session per review**, resumed only between the rounds of that review. Each reviewer is a worker task of the
  task (`crewTaskId` = the task, or the foreman's crew for a foreman task; `crewNodeId`, `parentTaskId` = the task,
  `readOnlyAgent`): isolated in a worktree on branch `<task branch>-<reviewer slug>` (the
  [worker naming rule](crew.md#workers)), the task's repos, no setup command and no `.env` copying. Writes are refused
  ("You check the work and do not write code.").
- **Its tree is the round's snapshot.** Before a round the host sets every repo of the reviewer's worktree to the round's
  result tree (`git read-tree -u --reset <tree>`), so the files on disk are the task's state under review, uncommitted
  changes included.
- **What it reads:** the task's prompt (the first prompt of the task), for a worker the part's prompt and acceptance
  criteria, the project's [review notes](pull-requests-and-ci.md#review-notes), the person's instructions when they gave
  any, and the round's diff through `read_report` / `read_diff`.
- The spec of the reviewers is kept in the task (`task.reviewCrew`: a crew spec whose root `Task agent` is the task's
  agent with `checkedBy` = the reviewers), so worker hosts and restarts read it like a crew's. Reviewers of an earlier
  review stay in it unchecked. A foreman task adds the reviewers below its root; findings go to the foreman, which
  returns work to its workers.
- Reviewer tasks stay service rows under the task's card in the sidebar ([Surfaces](#surfaces)).

<a id="start"></a>
## Starting

- **The agent** asks with [`request_review`](#request-tool); the host decides and runs a `mid` review.
- **The person** starts a `pre-pr` review from the proposal card, from `Review…` in the Changes commit strip, from
  `Start again…` in the strip, or from `Review first` in the New PR sheet. `Start review` on the proposal starts at
  once with the resolved reviewer; the others open the launch dialog of
  [Review with an agent](pull-requests-and-ci.md#review-launch) titled `Review before PR` with the note
  `<task title> · +N −M`: instructions, project review notes, `What` (`All changes · Since the last review`), `Who`
  (`Agent · Crew`; the agent capsule's inherited entry is `Auto` with the resolved reviewer as its detail) and
  `Remember for code reviews` (action `taskReview`). `Starting…` on the button; a failure keeps the dialog with `Could
  not start the review: …` and `Retry`.
- **The host** starts a `pre-pr` review when the person presses `Create PR` ([gate](#before-pr)), and its API takes
  `{point, startedBy: 'host', reason}` for a later threshold start.
- **The agent proposes** a review before the PR with MCP `propose_review(summary?)` (person tool, `whenToUse`: after
  the task's work and the agent's own checks are done, before the person creates a PR; never while a review runs). It
  returns at once with `proposed: true`; the proposal stays until the person starts the review or dismisses it with
  `Not now`. Refused while a review runs: `A review of this task is already running.`
- A review the person or the host starts while the task's agent is in a turn waits for that turn to end and reads its
  snapshot. A review the agent asks for reads at once (the host takes a checkpoint first) while the agent works on.

<a id="request-tool"></a>
### `request_review`

MCP `request_review(reason)` — a person tool of every GUI task agent except reviewers. `reason` (≤ 500 characters) is
what was just finished, e.g. `the data layer`; it shows in the chat row (`mid-task · Codex · after the data layer`).

- `whenToUse` (English, rule 12): after finishing a layer other work builds on — the data layer, a shared API, a schema
  or a migration — before building on top of it. Not after small steps, and not at the end of the task (the review
  before the PR covers that).
- The description tells the agent that the host decides, that the reviewer reads the task's state now, that it keeps
  working, and that findings arrive later as a prompt to fix or object to.
- The host answers at once: `{ started: true, reviewer: "Codex" }`, or `{ started: false, reason }` when a review of
  the task runs (`A review of this task is already running.`), nothing changed since the task start or the last
  review's snapshot (`Nothing changed since the last review.`), or no reviewer is available (the review is then
  recorded as `failed`).

<a id="loop"></a>
## The loop

The same at every point. A round is a `ReviewRun` of the task's host ([Crew](crew.md#reviewer)): the same idempotent
deliveries, stale verdicts (`stale_review`), restart recovery and the rule that silence is never approval.

1. **Read once.** The round pins a snapshot per repo — base = the task's change base (or the last review's trees for
   `Since the last review`), result = its latest checkpoint — syncs the reviewer's tree and prompts it (English):
   `Check task <id> of \`Task agent\` (reviewId …, first read)` with the task's prompt, the report, the notes and
   instructions, then: read with `read_report` / `read_diff`, leave only real, demonstrable findings with
   `submit_review(taskId, reviewId, comments)`, or `approve(taskId, reviewId)` when nothing must change; this is the
   only full read, nothing new can be raised later.
   - No findings → the review **passes**.
2. **Fix once or object.** The findings go to the task's agent as one batch (marker `review`, the
   [Sending a review](diff-and-review.md#send-review) format with each finding's id), headed `<reviewer> left N
   findings in the <point name>. Fix each one once, or object to it with review_reply(commentId, reason); <reviewer>
   then checks only whether each finding is closed.` and, for a `mid` review, `Then continue the task.` A finding the
   agent does not fix as asked gets MCP `review_reply(commentId, text)` (the task's own agent only); the reply joins
   the finding's thread.
3. **Check closure once.** The turn that answers the batch ends → the host opens a closure check from the new snapshot:
   `Check task <id> of \`Task agent\` (reviewId …, closure check)` with the reviewer's own findings, their state
   (`fixed`, the agent's objection) and the instruction: for each finding decide whether it is closed — an objection the
   reviewer accepts counts as closed; call `approve` when all are closed and the fix introduced no problem; otherwise
   `submit_review` with one item `{replyTo: <findingId>, text: why it is still open}` per open finding and, only for a
   problem the fix itself brought in, `{path, line, text, introduced: true}`. Nothing else may be raised.
   - `submit_review` items carry `path`/`start`/`text` as in a first read, or `replyTo` without a path; the tool's own
     description says so.
   - The host refuses any other item (`In a closure check only replyTo (a finding still open) or introduced: true (a
     problem the fix brought in) is accepted.`), a `replyTo` that is not this reviewer's finding of this review, and an
     `introduced` item in a file that did not change since the previous round (`<path> did not change since the last
     check; it cannot be a problem the fix introduced.`).
   - All closed → the review **passes**.
   - Anything open or new → the review goes to **the person** (`yours`). There is no automatic third round.
4. **The person decides** with the short list: `Fix {n}` sends the open and new findings to the agent as one more batch
   (step 2, headed `The person asks you to fix N findings that are still open…`), then one more closure check (step 3),
   then the person again if anything is still open. `Accept` ends the review as `accepted`: the open findings are
   recorded as accepted and their threads resolved.

- **Stop.** `Stop` (strip) cancels the open round and shuts the reviewers down; their tasks stay as the review's log until
  the task is archived or deleted. The review ends `stopped`.
- **Restart.** The review's record and its runs are on disk; after a host restart the review continues from its state:
  a round being read is dispatched again, a batch waiting for the agent's turn stays queued, a review waiting for the
  person keeps waiting.
- **Outdated.** A later change of the task's tree (agent or person) makes a passed or accepted review before the PR
  `outdated`: it covers only the snapshot it read. A mid-task review stays as it ended: the agent works on after it.
- **A mid-task review that ends** `passed` with no findings, or `accepted`, while the task's agent waits prompts it once
  with `The mid-task review passed. Continue the task.` (or `The person accepted the open findings of the mid-task
  review as they are. Continue the task.`).

<a id="findings"></a>
### Findings

A finding is a reviewer's comment of the review: a review thread in Changes attributed to the reviewer and the round
([Review from the foreman](crew.md#foreman-review)).

| State | Meaning | Tag |
| --- | --- | --- |
| `sent` | waits for the agent | `sent` (accent) |
| `fixed` | `Addressed` ([Addressed and resolved](diff-and-review.md#addressed)), or closed after a fix | `fixed` (`--green`, text struck through) |
| `answered` | the agent objected with a reason and the reviewer closed it | `answered` (`--fg3`) |
| `open` | the closure check says it is not closed | `open` (`--amber`) |
| `new` | a problem the fix introduced | `new` (`--amber`) |
| `accepted` | the person accepted it open | `accepted` (`--fg3`) |

- An open or new finding carries the reviewer's reason (its last reply in the thread).
- A finding of an older journal that a reviewer insisted on in a second round (`disputed`) reads as `open`.

<a id="strip"></a>
## The Review strip

One strip per task in the composer deck above the input (`ui/Deck`, with the queue and background strips), shown
while a review lives and after it until the next change, `×` or the archive. One S row: state glyph, the title (bold),
the state in muted text, the **step track**, actions, chevron.

- **Step track:** three 20-px steps with 12-px glyphs joined by 8 × 1 px connectors (`--fg` at 34 %, readable on the
  green and amber tones): plan, mid-task, before PR. Each step shows its point's last review: not started
  (`agent-backlog`, `--fg3`), live (spinner), waiting for the person (`agent-question`, `--amber`), passed or accepted
  (`check-pass`, `--green`), stopped, failed or outdated (`stop`, `--fg3`). The current review's step has the `--tint2`
  fill; a hovered step `--tint`. Each step has the tooltip `Plan review`, `Mid-task review`, `Review before PR`
  (with its state). A click opens the strip on that step's findings. The plan step is drawn but disabled.
- **A toned or hovered row fills the deck edge to edge** — horizontally across the deck's padding, and up to the deck's
  top edge when it is the deck's first row ([Queue deck placement](composer.md#queue-deck)).

| State | Glyph | Title · line | Actions | Tone |
| --- | --- | --- | --- | --- |
| Not started (the strip shows no row) | — | — | — | — |
| Waiting for the turn, reviewer reading | spinner | `Review` · `<point> · <reviewer> reading` | `Stop` | — |
| Author fixing | spinner | `Review` · `<agent> fixes <N findings>` | `Stop` | — |
| Reviewer verifying | spinner | `Review` · `<reviewer> checks the fixes` | `Stop` | — |
| Open findings handed to the person | `agent-question` | `Your call` · `<N findings> open` | `Fix {n}`, `Accept`; the list opens by itself | `--amber-soft` |
| Passed | `check-pass` | `Review passed` · `<N findings>` or `no findings` | before PR: `Create PR` (primary), `×`; mid-task: `×` | `--green-soft` |
| Accepted | `check-pass` (`--fg2`) | `Review closed` · `N accepted` | before PR: `Create PR`, `×`; mid-task: `×` | — |
| Stopped | `stop` | `Review stopped` · `<N findings>` or `no findings` | `Start again…`, `×` | — |
| Could not start | `agent-failed` (`--red`) | `Review did not start` · `<reviewer>: <reason>` or `No reviewer is available: …` | `Retry` (primary), `×` | — |

- `<point>` is `plan`, `mid-task` or `before PR`. **The findings count is a link** wherever it stands — the strip row
  and the chat rows: a dotted underline in the text colour at rest, solid on hover; a click expands the strip on the
  findings.
- `Create PR` has no ellipsis although it opens the New PR dialog: the strip names the step, not the dialog — an
  exception to the `…` rule of [UI copy](../ui-copy.md) that holds only here.
- **Expanded** (chevron or a click on the row): a full-width segment `Plan · Mid-task · Before PR` (the plan segment
  disabled) that picks whose review the sections show; `Reviewer` — a row per reviewer: provider glyph,
  `name · provider`, its state and time (`reading · 1m 12s`, `N findings`, `checking`, `approved`), `Log`; and
  `Findings N` — a row per finding: its text, `file:line · reviewer` (mono, muted) and its tag. Open and new findings
  stand first with the reviewer's reason under them. A click on a finding opens its thread in the diff.
- `Log` (strip, sidebar row, thread) opens the reviewer's task, which shows its log read-only.
- **Chat rows** (service rows, not cards): `review · <point> · <reviewer> · started` (a `mid` review adds `after
  <reason>`); `review · <point> · <reviewer> → <agent> · <N findings>` or `review · <point> · <reviewer> · passed`;
  `review · <point> · <agent> · N fixed · N answered`; `review · <point> · <N findings> open` (amber) or `passed`
  (green); `review · <point> · Fix N · by you`; `review · <point> · accepted · by you`; `review · <point> · stopped by
  you`; `review · <point> · did not start`; `review · <point> · changed after the review`. Journals written before these rows keep their older rows (`review · <who> · round 1 of 2 started` and the round rows).

<a id="surfaces"></a>
## Changes, threads, the sidebar and notifications

- **`Review…` in the Changes commit strip**, beside `Commit`, glyph `review`; absent only while the task has no changes
  and no review. It shows the live review's state: `Review` (spinner) while a round runs, `Fixing · N` while the agent
  fixes, `Your call` (`--amber`) when the person decides, `Reviewed` (`--green`) after a pass, and `Review…` with an
  accent dot when the tree changed after a review. A click expands the strip while a review lives or waits for the
  person, else opens the launch dialog.
- **Threads.** A reviewer's finding card shows the reviewer's provider glyph and name, the line link and its tag. Under
  it: the agent's reply, the reviewer's reason for `open`, and a footer — `Sent to <agent> · fixing` with `Log`,
  `<reviewer> closed it`, or `Your call` with `Open the review` (expands the strip).
- **Sidebar.** Reviewers are rows under the task's card, like crew workers: `<reviewer> · Review`, `· N findings ·
  waits`, `· Approved`, `· N open` (amber). A review waiting for the person makes the task `needs-you` with the reason
  line `Review · <N findings> open`; the card takes the `needs-you` fill. The rows stay until the next change after
  the review, or the archive.
- **Notifications.** The review handing open findings to the person is a `needs-you` notice
  ([Notice kinds](notifications-slack-notes-and-schedules.md#notice-kinds)).

<a id="before-pr"></a>
## Before the pull request

- **The gate.** `Create PR` on a task (not the main tree) whose changes no review before the PR has covered starts a
  `pre-pr` review instead of opening the New PR dialog, and expands the strip. A change is covered when the last
  `pre-pr` review read exactly the task's current trees and ended `passed`, `accepted` or `stopped`. When the review
  cannot start (no reviewer), the dialog opens at once and the strip says `Review did not start`. While a review runs,
  `Create PR` expands the strip.
- After the review passes or is accepted, the strip's `Create PR` opens the dialog.
- **The New PR sheet** shows a row above `Title`; `Create PR` in the sheet stays available in every state:

| Review | Row | Button |
| --- | --- | --- |
| none | `Not reviewed` · `N files changed since the task start` (`--amber-soft`) | `Review first` |
| outdated | `Changed since the review` · `N files after the review` | `Review again` |
| running | `Review in progress` · `<point> · <reviewer>` | `Open the review` |
| waiting for the person | `<N findings> open` · `<reviewer> and <agent> did not close them; your call` | `Open the review` |
| passed or accepted, unchanged | `Reviewed` · `<reviewer> · N findings, N fixed` (`--green-soft`) | — |

`Review first` / `Review again` close the sheet and open the launch dialog; `Open the review` closes it and expands
the strip.

<a id="data"></a>
## Data

- `task-review.json` in the task directory, `schemaVersion: 2` (rule 10): `proposal` (`summary`, `at`), `review` (the
  current or last review) and `past` (earlier reviews, newest last, at most 20). A review: `id`, `point`, `target`
  (`taskId`, `part?`), `startedBy` ∈ `person | agent | host`, `reason?`, `who` (agent or crew), `reviewer?`
  (`provider`, `model`, `effort`, `source` ∈ `setting | other | same | person`), `instructions`, `guidance`,
  `startedAt`, `state` ∈ `waiting | reading | fixing | verifying | yours | passed | accepted | stopped | failed |
  outdated`, `round` (runs opened: 1 = the read, then closure checks), `passes` (author passes), `reviewers`,
  `trees` (the result tree per repo of the last run), `base?`, `batch?` (the last batch sent to the agent: the turn
  that takes it opens the closure check, also after a restart), `failure?`, `finishedAt?`. A version-1 document reads as
  a `pre-pr` review started by the person; it is written back as version 2 on the next change.
- Findings are review comments in the task's `review.json` with `review` = `{reviewId, round, reviewer, open?, closed?,
  introduced?, accepted?}` (`disputed` of older files reads as `open`).
- Journal events (rule 2), each with `id` and `point`: `task-review.started` (`startedBy`, `reviewers`, `reason?`),
  `task-review.findings` (`findings`, `reviewers`), `task-review.answered` (`fixed`, `answered`: the findings of the
  pass the agent answered with `review_reply`, the rest count as fixed until the closure check),
  `task-review.verified` (`closed`, `open`, `introduced`), `task-review.decided` (`decision` ∈ `fix | accept`,
  `findings`), `task-review.finished` (`state` ∈ `passed | accepted | stopped | failed | outdated`, `failure?`). The proposal keeps `review.proposed`, `review.dismissed` and `review.replied`. The kinds of older
  journals — `review.started`, `review.finished` and the task's own `crew.review` rows — stay valid and replay as they
  were drawn.
- Host commands: `startReview` (the resolved reviewers, `who`, `reviewer`, `point`, `instructions`, `guidance`,
  `since`), `stopReview`, `decideReview` (`fix | accept`), `dismissReviewProposal`. The host asks the app for the
  reviewer with `review_reviewer` (`point`).

<a id="later"></a>
## Later

- The plan review: the plan checked against the source ticket, the backend contract and the repo, with two lists (plan
  vs ticket, gaps in the ticket), before approval.
- A threshold start of the mid-task review by the host (changed lines or files since the last review).
- A review strip on the phone.

<a id="non-goals"></a>
## Non-goals

- An automatic third round, or reviewers raising new findings after the first read.
- Choosing reviewers by a built-in ranking of agents or models.
