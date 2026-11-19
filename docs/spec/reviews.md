# Reviews

A review is a step the host runs on any task: another agent reads the task's changes once and lists findings, the
task's agent fixes them once or objects, the reviewer checks once whether its findings are closed, and whatever is still
open goes to the person. The same loop runs at every point of a task. This file is the one home of the loop; other
files link here.

<a id="points"></a>

## Points

| Point                     | `point`  | Started by                                                                                                            | Step name          |
| ------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------- | ------------------ |
| The plan, before approval | `plan`   | the host, when the plan is presented ([The plan review](#plan-start)); the person again from the strip                | `Plan review`      |
| Mid-task                  | `mid`    | the agent ([`request_review`](#request-tool)); the host API also takes a host start                                   | `Mid-task review`  |
| Before the pull request   | `pre-pr` | the person (the strip, `Review…`, the proposal), or the host when the person presses `Create PR` ([gate](#before-pr)) | `Review before PR` |

- **A review targets a task.** A solo task, an [Auto](crew.md#auto) task, a hired part and a crew worker's part are
  covered the same way: a part is a task, and its review runs in the worker's own host. A worker's review carries the part number and the part's prompt and acceptance
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
   `planReview`) for the plan, `Code reviews` (action `taskReview`) for mid-task and before-PR reviews. The menu
   of `Plan review` has `Off` under `Auto` (`settings.planReviewOff`): no plan review starts by itself, and the
   strip's `Review again` still starts one. A remembered
   crew of `Code reviews` (from the launch dialog's `Remember for code reviews`) makes every agent below the crew's root
   a reviewer; a remembered crew the library no longer offers (deleted or hidden) counts as none, and the next rules
   decide.
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
  returns work to its workers. An Auto task keeps them in `reviewCrew` until its first hire and below the root of its
  crew from then on; its agent fixes the findings itself or hands them to the worker of that zone.
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
- **The host** starts a `pre-pr` review when the person presses `Create PR` ([gate](#before-pr)), a `plan` review when a plan is
  presented ([The plan review](#plan-start)), and its API takes
  `{point, startedBy: 'host', reason}` for a later threshold start.
- **The agent proposes** a review before the PR with MCP `propose_review(summary?)` (person tool, `whenToUse`: after
  the task's work and the agent's own checks are done, before the person creates a PR; never while a review runs). It
  returns at once with `proposed: true`; the proposal stays until the person starts the review or dismisses it with
  `Not now`. Refused while a review runs: `A review of this task is already running.`
- A review the person or the host starts while the task's agent is in a turn waits for that turn to end and reads its
  snapshot. A review the agent asks for reads at once (the host takes a checkpoint first) while the agent works on. A
  plan review reads at once: the agent's turn waits for the plan's answer.

<a id="request-tool"></a>

### `request_review`

MCP `request_review(reason)` — a person tool of every GUI task agent except reviewers. `reason` (≤ 500 characters) is
what was just finished, e.g. `the data layer`; it shows in the chat row (`mid-task · Codex · after the data layer`).

- `whenToUse` (English, rule 12): after finishing a layer other work builds on — the data layer, a shared API, a schema
  or a migration — before building on top of it. Not after small steps, and not at the end of the task (the review
  before the PR covers that).
- The description tells the agent that the host decides, that the reviewer reads the task's state now, that it keeps
  working, and that findings arrive later as a prompt to fix or object to.
- The host takes a checkpoint first (the agent may have written through its own shell), then answers at once:
  `{ started: true, reviewer: "Codex" }`, or `{ started: false, reason }` when a review of
  the task runs (`A review of this task is already running.`), nothing changed since the task start or the last
  review's snapshot (`Nothing changed since the last review.`), or no reviewer is available (the review is then
  recorded as `failed`).

<a id="loop"></a>

## The loop

The same at every point. A round is a `ReviewRun` of the task's host ([Crew](crew.md#reviewer)): the same idempotent
deliveries, stale verdicts (`stale_review`), restart recovery and the rule that silence is never approval.

1. **Read once.** The round pins a snapshot per repo — base = the task's change base (or the last review's trees for
   `Since the last review`), result = its latest checkpoint — syncs the reviewer's tree and prompts it (English):
   `Check task <id> of \`Task agent\` (reviewId …, first read)`with the task's prompt, the report, the notes and
instructions, then: read with`read_report`/`read_diff`, leave only real, demonstrable findings with
`submit_review(taskId, reviewId, comments)`, or `approve(taskId, reviewId)` when nothing must change; this is the
   only full read, nothing new can be raised later. The prompt says what a finding is ([Findings](#findings)), that a
   doubt is checked by the reviewer itself — it reads the files of its tree and runs commands that change no files: the
   project's tests or type check, a short script that calls the changed code — and ends in a defect it found or an
   approval, and that what needs no fix goes in the approval's [remark](#remark).
   - No findings → the review **passes**.
2. **Fix once or object.** The findings go to the task's agent as one batch (marker `review`, the
   [Sending a review](diff-and-review.md#send-review) format with each finding's id), headed `<reviewer> left N
findings in the <point name>. Fix each one once, or object to it with review_reply(commentId, reason); <reviewer>
then checks only whether each finding is closed.` and, for a `mid` review, `Then continue the task.` A finding the
   agent does not fix as asked gets MCP `review_reply(commentId, text)` (the task's own agent only); the reply joins
   the finding's thread.
3. **Check closure once.** The turn that took the batch ends → the host opens a closure check from the new snapshot. A
   foreman hands fixes to its workers: its closure check opens at the first turn end after the batch at which its crew
   has no open work (an objection without edits leaves none, so it opens at once). The check:
   `Check task <id> of \`Task agent\` (reviewId …, closure check)` with the reviewer's own findings, their state
(`fixed`, the agent's objection) and the instruction: for each finding decide whether it is closed — an objection the
reviewer accepts counts as closed; call `approve`when all are closed and the fix introduced no problem; otherwise`submit_review`with one item`{replyTo: <findingId>, text: why it is still open}`per open finding and, only for a
problem the fix itself brought in,`{path, line, text, introduced: true}`. Nothing else may be raised.
   - `submit_review` items carry `path`/`start`/`text` as in a first read, or `replyTo` without a path; the tool's own
     description says so.
   - The host refuses any other item (`In a closure check only replyTo (a finding still open) or introduced: true (a
problem the fix brought in) is accepted.`), a `replyTo` that is not this reviewer's finding of this review, and an
     `introduced` item in a file that did not change in its repo since the previous round, matched by repo and path
     (`<path> did not change since the last check; it cannot be a problem the fix introduced.`).
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
([Review from the foreman](crew.md#foreman-review)). It names something wrong in the change — wrong behaviour, a broken
contract, a missed requirement, work outside the task — with its evidence: the lines and what goes wrong. A wish for
more checks, tests or a fuller report is not a finding: one round of fixing costs more than the check it asks for. The
same rule stands in a crew reviewer's prompt, except how it checks a doubt: its own tree is not the worker's change, so it
reads the whole diff and the report instead of running commands. The [plan review](#plan-review) keeps its own rules.

<a id="requests"></a>
**Network requests.** Every code review traces the requests the change adds or alters, and skips this when it touches
none. For each screen or action the reviewer counts the requests of one open or one action and when they fire (on open,
on focus, on every render, per list item). It is a finding when the same data is requested from more than one place, a
request fires per list item or again on every focus or render with no cache, requests wait on each other without need,
or one screen fires more than three requests at once, even to different endpoints. The finding names every call site
(`path:line`), gives the count and proposes the change: reuse the existing query or cache, give the request one owner,
load a secondary section when it is shown, or ask the back-end for one endpoint.

<a id="remark"></a>
**A remark.** `approve(taskId, reviewId, note?)` takes an optional `note` (up to 2000 characters): something the person
should know that needs no fix — a risk to watch, the check the reviewer ran. It is stored with the approval, starts no
fix and no round, has no thread, no tag and no count, and never becomes a finding. The expanded strip shows it under the
reviewer's row.

| State      | Meaning                                                                                     | Tag                                      |
| ---------- | ------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `sent`     | waits for the agent                                                                         | `sent` (accent)                          |
| `fixed`    | `Addressed` ([Addressed and resolved](diff-and-review.md#addressed)), or closed after a fix | `fixed` (`--green`, text struck through) |
| `answered` | the agent objected with a reason and the reviewer closed it                                 | `answered` (`--fg3`)                     |
| `open`     | the closure check says it is not closed                                                     | `open` (`--amber`)                       |
| `new`      | a problem the fix introduced                                                                | `new` (`--amber`)                        |
| `accepted` | the person accepted it open                                                                 | `accepted` (`--fg3`)                     |

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
  (with its review's own state: `stopped`, `did not start` and `outdated` share the glyph, not the word). A click opens
  the strip on that step's findings.
- **A toned or hovered row fills the deck edge to edge** — horizontally across the deck's padding, and up to the deck's
  top edge when it is the deck's first row and down to the island's top border when it is the deck's last ([Queue deck placement](composer.md#queue-deck)).

| State                                  | Glyph                    | Title · line                                                                     | Actions                                                           | Tone           |
| -------------------------------------- | ------------------------ | -------------------------------------------------------------------------------- | ----------------------------------------------------------------- | -------------- |
| Not started (the strip shows no row)   | —                        | —                                                                                | —                                                                 | —              |
| Waiting for the turn, reviewer reading | spinner                  | `Review` · `<point> · <reviewer> reading`                                        | `Stop`                                                            | —              |
| Author fixing                          | spinner                  | `Review` · `<agent> fixes <N findings>`; the plan: `<agent> revises the plan`    | `Stop`                                                            | —              |
| Reviewer verifying                     | spinner                  | `Review` · `<reviewer> checks the fixes`                                         | `Stop`                                                            | —              |
| Open findings handed to the person     | `agent-question`         | `Your call` · `<N findings> open`; the plan adds `· <N gaps>`                    | `Fix {n}`, `Accept`; the list opens by itself                     | `--amber-soft` |
| Passed                                 | `check-pass`             | `Review passed` · `<N findings>` or `no findings`; the plan adds `· <N gaps>`    | before PR: `Create PR` (primary), `×`; mid-task and plan: `×`     | `--green-soft` |
| Accepted                               | `check-pass` (`--fg2`)   | `Review closed` · `N accepted`                                                   | before PR: `Create PR`, `×`; mid-task and plan: `×`               | —              |
| Stopped                                | `stop`                   | `Review stopped` · `<N findings>` or `no findings`                               | `Start again…` (the plan: `Review again` while a plan waits), `×` | —              |
| Could not start                        | `agent-failed` (`--red`) | `Review did not start` · `<reviewer>: <reason>` or `No reviewer is available: …` | `Retry` (primary), `×`                                            | —              |

- `<point>` is `plan`, `mid-task` or `before PR`. **The findings count is a link** wherever it stands — the strip row
  and the chat rows: a dotted underline in the text colour at rest, solid on hover; a click expands the strip on the
  findings.
- `Retry` on a review whose reviewer failed to start stops that review first (it still waits for the read), then starts
  a new one.
- `Create PR` has no ellipsis although it opens the New PR dialog: the strip names the step, not the dialog — an
  exception to the `…` rule of [UI copy](../ui-copy.md) that holds only here.
- **Expanded** (chevron or a click on the row): a full-width segment `Plan · Mid-task · Before PR` that picks whose review the sections show; `Reviewer` — a row per reviewer: provider glyph,
  `name · provider`, its state and time (`reading · 1m 12s`, `N findings`, `checking`, `approved`), `Log`, and under it
  the [remark](#remark) of an approval, if any; and
  `Findings N` — a row per finding: its text, `path:line · reviewer` (the file's whole path, mono, muted) and its tag. Open and new findings
  stand first with the reviewer's reason under them. A click on a finding opens its thread in the diff. The plan's sections differ ([Plan review
  surfaces](#plan-surfaces)). The sections are the deck's fill ([Queue deck](composer-steering-queue-and-ghost.md#queue-deck)):
  they get the room they need up to a bound set by the window, the strip's row stays in place over them, and they scroll
  under it with a fading foot while more lies below.
- `Log` (strip, sidebar row, thread) opens the reviewer's task, which shows its log read-only.
- **Chat rows** (service rows, not cards): `review · <point> · <reviewer> · started` (a `mid` review adds `after
<reason>`); `review · <point> · <reviewer> → <agent> · <N findings>` or `review · <point> · <reviewer> · passed`;
  `review · <point> · <agent> · N fixed · N answered`; for the plan the findings row adds `· <N gaps>`, and a review
  that the plan's approval ended reads `review · plan · ended by the approval · <N findings> open`; `review · <point> · <N findings> open` (amber) or `passed`
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
  `pre-pr` review read exactly the task's current repos and trees (a repo that joined later is not covered) and ended
  `passed`, `accepted` or `stopped`. When the review cannot start (no reviewer), the dialog opens at once and the strip
  says `Review did not start`. While any review runs or waits for the person, mid-task included, `Create PR` expands
  the strip.
- After the review passes or is accepted, the strip's `Create PR` opens the dialog.
- **The New PR sheet** shows a row above `Title`; `Create PR` in the sheet stays available in every state:

| Review                        | Row                                                                          | Button            |
| ----------------------------- | ---------------------------------------------------------------------------- | ----------------- |
| none                          | `Not reviewed` · `N files changed since the task start` (`--amber-soft`)     | `Review first`    |
| outdated                      | `Changed since the review` · `N files after the review`                      | `Review again`    |
| running                       | `Review in progress` · `<point> · <reviewer>`                                | `Open the review` |
| waiting for the person        | `<N findings> open` · `<reviewer> and <agent> did not close them; your call` | `Open the review` |
| passed or accepted, unchanged | `Reviewed` · `<reviewer> · N findings, N fixed` (`--green-soft`)             | —                 |

`Review first` / `Review again` close the sheet and open the launch dialog; `Open the review` closes it and expands
the strip.

<a id="plan-review"></a>

## The plan review

The same loop on a plan that waits for the person's approval, before they approve: a plan for approval of a solo task
([Plan for approval](chat-turns-plans-and-questions.md#plan-approval)) or the root foreman's split
([Crew](crew.md#plan)). The reviewer reads the plan once, the author revises it once or objects, the reviewer checks
the revision, and what is still open waits next to the plan with `Fix {n}` / `Accept`. `Approve plan` (and `Start
workers`) stays available all the time.

<a id="plan-start"></a>

### When it starts

- **By itself, when the plan is presented**: a plan for approval with text (`permission.requested` with `switch_mode`)
  or the root foreman's `propose_plan` (a lead's plan is approved by the host and has none). Not when `Plan review` is
  `Off` ([Who reviews](#who)), not when no app is attached to the task's host or the app does not answer who reviews (the
  host cannot read the setting), not in the
  main tree, and not while another review of the task lives.
- **One full read per plan.** A plan is every presentation from the first one after the last approved plan (an approved
  plan for approval, or `Start workers`) up to its approval. A plan that already had a plan review gets no new read by
  itself: a revision presented while the author answers the findings, or while the person decides, gets the
  [closure check](#plan-loop); after a review that passed, was accepted or stopped, nothing. The person asks for a new
  read with `Review again` in the strip while a plan waits.
- The review reads at once: the agent's turn waits for the plan's answer. The reviewer's tree is the task's latest
  checkpoint, as in a code review ([Reviewer sessions](#reviewer-sessions)).

<a id="plan-inputs"></a>

### What the reviewer reads

A reviewer on any provider reads everything through host tools; it needs no connector of its own.

- **The task's prompt** (and, for a crew, nothing of the workers: they have not started).
- **The plan**: `read_plan(taskId, reviewId)` → `{revision, text}`: the plan's Markdown as presented (a split is
  rendered as Markdown: the summary, then per part its number, title, executor with its role, provider and model, files,
  scopes and prompt, then the crew's roster). In a closure check it adds `read` (the revision the first read had), `previous` (the
  revision the previous round read) and `diff`: a line diff of the plan between `previous` and this one. The text is cut at 200 000
  characters with a note.
- **The sources**: `read_sources(taskId, reviewId, sourceId?)` → the saved sources as `{id, title, url?, chars, text}`;
  texts are cut when the call passes 200 000 characters, and `sourceId` reads one source whole.
- **The repo**: the files of its worktree, read-only — the backend contract in the repo included.

<a id="save-source"></a>

#### `save_source`

MCP `save_source(title, url?, text)` — a person tool of a solo task's agent and the root foreman. It saves the text of a
source the plan is written from — a ticket, a spec, an API contract — into the task's folder, so a reviewer on another
provider reads the same version the plan was written from.

- `whenToUse` (English, rule 12): the task comes from a ticket, a spec or a contract the agent was given or fetched (for
  example from Notion, Jira or Linear); save it before presenting a plan. The session brief of a solo task and of the
  root foreman says the same (`sourcesBrief`).
- Limits: `title` 1–200 characters, `url` an `http(s)` address of at most 2000, `text` 1–200 000 characters; at most 20
  sources and 1 000 000 characters per task. A source with the same title (case ignored) replaces the earlier one: its text is written whole
  (an atomic replace) before the index names it.
- Files: `sources/<slug>-<hash8>.md` (the slug of the title as for plan copies, the hash of the source's id) and the
  index `sources/sources.json` ([Data](#data)). Returns `{saved: true, id, chars}`; an error names the limit.
- The journal gets `source.saved` (`id`, `title`, `url?`, `chars`).

<a id="plan-verdict"></a>

### The verdict

MCP `submit_plan_review(taskId, reviewId, findings, gaps)` (a reviewer's tool; `approve(taskId, reviewId)` when nothing
must change and the ticket has no gaps). At most 12 items in all (a closure check adds at most 12 `introduced` ones, and a review
holds at most 48 findings: past that the host takes replies only — `This review holds at most 48 findings…`), ranked: the most severe first.

| List               | `kind`                                                                                                                                                                                                                                                                                                                                        | Tag                                                                   | Goes to    |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------- |
| Plan vs ticket     | `missed` (a requirement the plan misses), `contradicts` (the plan contradicts the ticket or the contract), `out-of-scope` (the plan does what the ticket does not ask)                                                                                                                                                                        | `missed`, `contradicts`, `out of scope` (`--amber`)                   | the author |
| Plan vs code       | `assumption` (a wrong assumption about existing code), `left-open` (a decision left open that will produce defects: concurrency, failures and retries, data loss, empty and error states, how many requests a screen fires), `unverifiable` (a check that cannot be verified as written), `split` (the foreman's split, [below](#plan-split)) | `wrong assumption`, `left open`, `cannot verify`, `split` (`--amber`) | the author |
| Gaps in the ticket | `gaps[]` — what the ticket itself leaves open                                                                                                                                                                                                                                                                                                 | `gap` (`--tint`, `--fg2`)                                             | the person |

- The reviewer counts the network requests the plan makes one screen or action fire ([Network requests](#requests)). A
  plan that opens a screen with more than three requests at once, or requests data an existing query already holds, gets
  a `left-open` finding that names the requests and proposes fewer.
- A finding is `{kind, text, where?}`; a gap `{text, where?}`. Gaps never count as findings: not in the strip's counts, a
  reviewer's row or the chat rows. `text` ≤ 2000 characters; `where` ≤ 200, the place in the
  ticket, the contract or the plan (`CRM-412 · Notes`, `api-contract.yaml:88`, `plan.md:41`).
- A first read without findings and gaps is an `approve`. Gaps alone pass the review: they are questions for the
  person, not for the author, and they never keep the review open.

<a id="plan-loop"></a>

### The loop on a plan

1. **Read once**: `Check the plan of task <id> (reviewId …, plan review, first read)` with the task's prompt and the
   instruction to read the plan, the sources and the repo once, and to answer with the verdict above.
2. **Revise once or object.** The findings go to the author as one batch: `<reviewer> left N findings in the plan
review. Revise the plan once: fix each finding in the plan, or object to it with review_reply(commentId, reason) where
commentId is the finding's id; then present the plan for approval again with ExitPlanMode, unchanged if you object to every
finding` (a foreman: `then call propose_plan again with the revised split, …`) `. <reviewer> then checks only whether each finding is closed.` with each
   finding's id, kind, place and text (`- id p1 [missed] (CRM-412 · Notes): …`). `Fix {n}` sends `The person asks you
to fix N findings of the plan review that are still open…` with the reviewer's reasons. A solo task's waiting plan is answered with its first `reject_once` (else the first
   `reject_*`, else the request is cancelled), as in [plan chat](chat-turns-plans-and-questions.md#plan-chat), and the batch runs right after the
   turn; a foreman's waiting `propose_plan` returns `approved: false` with the batch as `review` (after its turn ended,
   the batch comes as the decision prompt). With no plan waiting (the person answered it meanwhile, a foreman's split too), the batch only queues, and the turn
   that takes it is the author's pass; if the author presents the plan before that turn, that plan is answered with the
   batch and the queued copy is taken out.
3. **Check closure once.** The next presentation of the plan opens the closure check on that revision:
   `Check the plan of task <id> (reviewId …, closure check)` with the reviewer's findings, the author's objections and
   `read_plan` with the revision diff. The reviewer answers `approve`, or `submit_plan_review` with
   `{replyTo: <findingId>, text}` per finding still open and `{kind, text, where?, introduced: true}` only for a
   problem the revision brought in; gaps are not asked again. The host refuses other items with the messages of the code
   loop. When the author's turn ends without presenting the plan again, the check runs on the plan as it was.
4. **The person decides** while the plan waits: the open findings stand in the strip with `Fix {n}` / `Accept`.
   `Fix {n}` answers the waiting plan and sends the batch again (step 2), then one more closure check. `Accept` closes
   the review as `accepted`; the plan keeps waiting for approval. A revision presented while the person decides (from
   chat, `Plan further…` or edits) gets a closure check of the open findings.

- **Approval ends it, also mid-delivery.** A batch not yet sent is not sent, and one waiting in the author's queue is
  taken out. `Approve plan`, `Start workers` or any approving option ends a live plan review: an open round is
  cancelled; findings still open are recorded as `accepted` and the review ends `accepted`, or `stopped` when it had no
  findings yet. The chat row says `ended by the approval`.
- A rejection by the person (`Plan further…`, `Send edits`, a message in chat, `Reject`) does not stop the review.
- A plan review never becomes `outdated`; the next plan after an approval gets a review of its own.

<a id="plan-split"></a>

### The foreman's split

For a split the reviewer also checks the split itself and files each problem as `split`: parts that are not independent,
a part that depends on another part's files while both run in parallel, and an executor that does not fit its part
(its role, provider or model). Every other list applies to the split as to a plan.

<a id="plan-surfaces"></a>

### Plan review surfaces

- **The strip.** The plan step lives like the others. Expanded on the plan, it shows the sources as chips (`note`
  glyph, the title; a click opens the saved text in the editor), the `Reviewer` rows, then `Plan vs ticket N`, `Plan vs
code N` and `Gaps in the ticket N`. A finding row: its text, `<where> · <reviewer>` (muted), and a tag — its kind
  while it waits for the author, then its state ([Findings](#findings)); open ones stand first with the reviewer's reason.
  A gap row has no reviewer and the tag `gap`. Plan findings have no thread in the diff. A finished plan review (passed,
  closed or stopped) offers `Review again` while a plan waits.
- **The plan card** (plan for approval and the foreman's split card): a line above the footer — the sources as the same
  chips, then the review's state: spinner and `Review · <reviewer> reading` (or `<reviewer> checks the fixes`, `<agent>
revises the plan`), or
  `<N findings>` and `<N gaps>` as links (open findings in `--amber`, `· N open`), or `Review passed` with
  `check-pass`. A click on the state expands the strip on the plan step.

<a id="data"></a>

## Data

- `task-review.json` in the task directory, `schemaVersion: 2` (rule 10): `proposal` (`summary`, `at`), `review` (the
  current or last review) and `past` (earlier reviews, newest last, at most 20). A review: `id`, `point`, `target`
  (`taskId`, `part?`), `startedBy` ∈ `person | agent | host`, `reason?`, `who` (agent or crew), `reviewer?`
  (`provider`, `model`, `effort`, `source` ∈ `setting | other | same | person`), `instructions`, `guidance`,
  `startedAt`, `state` ∈ `waiting | reading | fixing | verifying | yours | passed | accepted | stopped | failed |
outdated`, `round` (runs opened: 1 = the read, then closure checks), `passes` (author passes), `reviewers`,
  `trees` (the result tree per repo of the last run), `base?`, `batch?` (the last batch sent to the agent: the turn
  that takes it opens the closure check, also after a restart), `failure?`, `finishedAt?`. A plan review adds `plan`
  (`kind` ∈ `approval | split`; `id`, `revision`, `text` — the permission request or the crew plan presented last, its
  revision and its plan; `read` — the revision of the first read; `seen`, `seenText?` — the revision the current round
  reads; `base?`, `baseText?` — the one the previous round read, the closure check's diff base; `sentAt?` — the journal
  seq of the last batch; `queued?` — that batch waits in the author's queue; `approved?` — the plan was approved, so the next presentation is a new plan) and `findings` (`id`, `kind`, `text`, `where?`,
  `reviewer`, `round`, and the marks `open?`, `closed?`, `introduced?`, `accepted?`, `answer?`, `reason?`). Both
  are optional: earlier documents load as they are. A review that goes to `past` keeps its plan's revisions and `approved`,
  not its texts; readers take the document up to 16 MiB. A version-1 document reads as
  a `pre-pr` review started by the person; a review that was fixing takes its batch from the journal (the turn that
  took it, else the queued prompt); it is written back as version 2 on the next change.
- Sources: `sources/sources.json`, `schemaVersion: 1`, `sources` (`id`, `title`, `url?`, `file`, `chars`,
  `savedAt`), and one Markdown file per source.
- Code findings are review comments in the task's `review.json` with `review` = `{reviewId, round, reviewer, open?, closed?,
introduced?, accepted?}` (`disputed` of older files reads as `open`).
- Journal events (rule 2), each with `id` and `point`: `task-review.started` (`startedBy`, `reviewers`, `reason?`),
  `task-review.findings` (`findings`, `reviewers`, `gaps?` for a plan), `task-review.answered` (`fixed`, `answered`: the findings of the
  pass the agent answered with `review_reply`, the rest count as fixed until the closure check),
  `task-review.verified` (`closed`, `open`, `introduced`), `task-review.decided` (`decision` ∈ `fix | accept`,
  `findings`), `task-review.finished` (`state` ∈ `passed | accepted | stopped | failed | outdated`, `failure?`, `open?` and
  `approval?` when the plan's approval ended it). `source.saved` (`id`, `title`, `url?`, `chars`). The proposal keeps `review.proposed`, `review.dismissed` and `review.replied`. The kinds of older
  journals — `review.started`, `review.finished` and the task's own `crew.review` rows — stay valid and replay as they
  were drawn.
- Host commands: `startReview` (the resolved reviewers, `who`, `reviewer`, `point`, `instructions`, `guidance`,
  `since`), `stopReview`, `decideReview` (`fix | accept`), `dismissReviewProposal`. The host asks the app for the
  reviewer with `review_reviewer` (`point`).

<a id="later"></a>

## Later

- A threshold start of the mid-task review by the host (changed lines or files since the last review).
- A review strip on the phone.

<a id="non-goals"></a>

## Non-goals

- An automatic third round, or reviewers raising new findings after the first read.
- Choosing reviewers by a built-in ranking of agents or models.
