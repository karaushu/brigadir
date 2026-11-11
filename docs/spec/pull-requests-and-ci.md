# Pull requests and CI

Brigadir works with GitHub only through the GitHub CLI (`gh`): it creates PRs for each repo of a task, lists and opens PRs of the project's repos, runs a full review (with drafts, an agent or a crew), merges when GitHub allows it, and shows CI runs, steps and deployments after a merge. The aim is a full development cycle, from writing the task to CI, without leaving the app; logs, re-runs and dashboards stay on GitHub.

<a id="gh-integration"></a>
## GitHub through `gh`

- Every GitHub call goes through `gh`: `gh auth status`, `gh repo view`, `gh pr list/view/checks/create`, `gh api` (REST) and `gh api graphql`. No OAuth app, no stored tokens: credentials belong to `gh` (see [data layout](architecture-and-platform.md)).
- `gh` missing → `Install GitHub CLI (gh) to create pull requests.`; not signed in → `Sign in with gh auth login to use GitHub.`. One banner carries this; the PR features are off, the PR list counter shows `?`.
- Package split: `@brigadir/forge` shells out to `gh` (layer 1, not part of `@brigadir/git`: forge is networked, authorized and may be absent); local git stays in `@brigadir/git`; coordination lives in `main/forge.ts` (task repos, Create PR, push, checks) and `main/pull-requests.ts` (PR panel, review, CI).
- **The orchestrator performs GitHub actions, not the agent.** Push order, scope, cwd and the `gh` call are code. Agents write only text (PR title/body, summaries, review drafts). Asking an agent in the composer to "create a PR" still works as an explicit escape hatch.
- A network error is never shown as "no PRs" / "no checks": an empty list appears only on a successful answer. A repo without workflows (`gh pr checks` exits non-zero with "no checks reported") reads as `No checks`, not as an error.
- The whole PR UI (panel, counters, links, `pr_comment*` tools, `⌘R` menu item) is switched off with the `Pull requests` module ([Modules](settings-modules-and-onboarding.md)).

<a id="pr-per-repo"></a>
## A PR belongs to a repo, not to a task

A task spans several git roots, so **one task → up to N PRs**, one per GitHub repo. Every PR action is per repo (the repo row's `…` menu, the PR panel, the dialog's repo line).

| Fact | Detail |
| --- | --- |
| Model | `task.pullRequests: Record<scopeId, PRRef>` in the task file; `PRRef = {number, url, title, state: OPEN\|CLOSED\|MERGED, head, base}` |
| Recorded by | The task's host (owner of the task file), including merged/closed refs |
| Branch's PR | `gh pr list --head <branch> --state all`; an open PR wins, otherwise the newest |
| Open PR | Blocks a second PR for that branch; shows the task badge |
| Merged/closed PR | History only: no task badge ([PR badge](sidebar.md)); `Create PR…` is available again; the trace stays in the repo's PR counter and the PR panel |
| "Commits ahead" | Counted from `origin/<base>`, never from the local base branch (the merge moves origin) |
| Base branch | Task fix/conflict base (`prReview.base`) → `project.json` `pullRequestBases[<repo name>]` → repo `defaultBranch` from `gh` → `origin/HEAD`. Never a guessed `main`/`master` |

<a id="reading-and-refresh"></a>
## Reading, cache and Refresh

**No background polling of GitHub**, with two explicit exceptions: an open CI surface with a live run ([CI refresh](#ci-refresh)) and the run bell ([bell](#ci-bell)).

- Reads happen on task or repo selection, window focus, a click (badge, Refresh) and after Brigadir's own actions. Turn events and checkpoints refresh only local git (2 s debounce).
- Main-process cache (see [Forge cache](architecture-and-platform.md)): auth 5 min, repo metadata (`gh repo view`) 10 min stale-while-revalidate (a default-branch change shows within ≤10 min), branch PR / PR details / PR list / PR detail 20 s, CI runs 5 s. `fresh` bypasses the cache.
- PR panel reads use **one GraphQL query per repo list and one per PR** (viewer, review threads, `statusCheckRollup`, files, commits). Limits: 100 open + 30 recently closed PRs per repo, 100 files, 100 threads × 50 comments, 100 commits per PR.
- Main keeps the **last read PR** beyond the 20 s TTL and beyond `forget()` of own actions: PR files, the PR tree and `Viewed` need only node id, head/base SHA and branch names. Only a newer read replaces it; an older read answering later never overwrites it.
- **Refresh** (glyph `refresh`) sits in the PR list header and the PR title row, left of `Open on GitHub`. Click → fresh read of the list (and, inside a PR, the PR and the list). While reading, the glyph spins (0.8 s/turn, finishes its turn; with reduced motion it stays at 55 % opacity), `aria-busy` is set, nothing is disabled. A click during a read queues **exactly one** more pass after the current one (`renderer/refresh-flight.ts`); no parallel second read; a failed pass does not stop the next.
- Shortcut: `View ▸ Refresh pull requests` `⌘R`, enabled only with focus in the PR panel (browser/simulator `⌘R` and the editor's `⌘R` Replace keep their own focus). Tooltip `Refresh · ⌘R`.
- A read error keeps the data on screen; the error has `Retry`.

<a id="create-pr"></a>
## Creating a PR

<a id="create-pr-entries"></a>
### Entries

| Entry | Behavior |
| --- | --- |
| Repo `…` menu (task Changes, main tree) | `Create PR…` when the repo has no open PR; disabled only by repo reasons |
| PR panel header `New PR` (`+` and `pr-branch`, M row) | In both segments (`Pull requests`, `CI`); narrowed by the repo picker. One repo → opens the dialog; several → menu `New PR` (shared `ui/Popover`, Esc): repo name, branch in monospace, tail `N → base`; ready repos first, blocked ones grey with the reason. Tooltip of a ready repo: `New PR` and `repo · branch → base` |
| Ready card above the PR groups | See [Ready card](#ready-card) |
| Project screen `New pull request` | See [Project PR section](#project-pr-section) |

Disabled-state reasons (all shown at once, never only the first): `No origin remote`, `GitHub is unavailable`, `GitHub status could not be read.` keep the dialog shut. Branch reasons (`Detached HEAD`, `Base branch is unavailable`, `No commits ahead of base`, `A pull request is already open`) do not disable entries: the dialog opens and shows the reason in its status line so another pair can be picked; tooltips and menu rows still name them.

<a id="new-pr-dialog"></a>
### The `New pull request` dialog

A sheet under the window strip (like `New task`), footer `data-size="m"`.

1. Repo line, then the `From → Into` row ([pickers](#from-into)).
2. `Title`, `Description` (114 px, resizable) with `Generate` (S row) — one-off call of the `Helper agent`, with an on-the-spot model capsule; prompt in English. Default text follows `From` until edited: the task's own branch → task title + prompt + diff stats; another branch or the main tree → commits of the pair (one commit: its subject and body; several: the branch name in words and the list of subjects). Generation failure: `The description could not be generated. You can edit it and create the PR.`
3. `Branch` (rename) when the branch is auto-generated and not pushed yet (`git branch -m` before the first push is free). Human branch names get no rename step.
4. `Commits to push` — a disclosure (not a toggle) listing exactly what goes to origin, per repo, submodules first.
5. `Uncommitted changes stay local and are not included in this PR.` when the tree is dirty. Uncommitted changes never block a PR of existing commits and are never committed for the user.
6. Submodule warnings ([Submodules](#submodules)).
7. `Create PR` → push (with the push confirmation flow, [Push](git.md)), then `gh pr create --repo --head --base --title --body-file -` (headless). `Open form in browser` (`--web`) is the escape hatch for reviewers, labels and draft.
8. Success: number and URL recorded on the repo of the task (badge), the new PR becomes the selected row of the PR list; the ready card disappears.

Validation: title 1–1000 chars, body ≤100 000; the URL returned by `gh` must be a `/pull/<n>` of that repo.

<a id="from-into"></a>
### `From` and `Into` pickers

- Two `Popup`s with search and groups, the same list as the launch sheet's `Branch` field ([Branch switching](git.md)), `→` between them, M row.
- **`From`**: `Local branches` (current one tailed `current`, ↓↑ from upstream; a branch checked out in another worktree is allowed) and `Remote branches` (only those without a local copy). Default: the repo's current branch; on the base branch — a new automatic branch tailed `New branch`.
- **`Into`**: branches on origin (`refs/remotes/origin/*`, no `HEAD`). Default from the [base order](#pr-per-repo). The choice applies to this PR only and is never remembered; the permanent default is `pullRequestBases`.
- **Pair check** in main right after each choice, no network for git: commits of `From` beyond `origin/<Into>`, what must be pushed, whether a PR of the pair is already open (`gh pr list --head`). Status line: quiet `3 commits ahead of master`, or a reason (`No commits ahead of base`, `A pull request is already open · #12`, `Choose different branches`) that disables `Create PR` and `Open form in browser`.
- **Current branch** in `From`: the full flow — push every repo of the task in submodule-before-parent order, rename, record on the task's repo.
- **Another branch**: no checkout, the tree is untouched. A local branch missing on origin or ahead of `origin/<name>` is pushed with exactly the SHA the check saw (`push origin <sha>:refs/heads/<name>`); a branch only on origin is not pushed. Its PR is not recorded on the task (the PR panel shows it).

<a id="auto-branch"></a>
### Branches

- Worktree task: already has a branch.
- On the base branch (in place): `Create PR` creates a topic branch itself — name from the task title/prompt plus a unique suffix (`A branch will be created automatically.`). The preview shows `head → base`; the branch is created only by the final `Create PR`; Cancel changes nothing; a retry after failure reuses it. HEAD/branch/origin are verified before switching; base branch and staged/unstaged files are never reset or committed. No branch switch during an active turn.
- Push sends only the reviewed SHA and re-verifies HEAD/branch/remote first.

<a id="submodules"></a>
### Submodules

- A gitlink pointer not reachable from any remote branch of the submodule makes the parent PR unmergeable. Check: `git branch -r --contains <pointer>` in the submodule, **without fetch** (refs are fresh after our own push; a foreign merge may leave it stale).
- It is a **warning, not a blocker** (creating the root PR first is a legal order): shown in the dialog (`Submodule commits must be available upstream before merging:`) and as a line in the PR body.
- After push the parent's gitlink equals the submodule's HEAD (push order submodule → parent).
- No cross-repo auto-merge.

<a id="ready-card"></a>
### Ready-for-PR card

- Shown above the list groups when a repo's current branch is **pushed** (`origin/<branch>` exists), is not the base, is ahead of the base and has no forge reasons (`suggestsPR`).
- Content: `pr-branch` · repo (when several repos and the picker is on all) · branch; second line `N commits ahead of <base> · pushed <time>` and primary `Create PR`; `×` (`Hide until the next push`). Several ready repos → one card `Ready for a PR · N` with a row and `Create PR` per repo; `×` hides all.
- "Pushed" time = last move of `origin/<branch>` from its reflog (our push, terminal push or fetch), else the commit date.
- `×` hides until origin has another SHA: `~/.brigadir/pr-suggestions.json` `{schemaVersion, hidden}`, key = GitHub repo URL + branch, value = SHA of `origin/<branch>`, newest 200 kept.
- In the main tree the head is the repo's current branch; the same button, card and `Create PR…` apply. On the base branch with nothing ahead nothing is offered.

<a id="task-pr-badge"></a>
## Task PR badge and the Checks popover

- An open PR of a task repo shows `#N` plus one checks glyph (running arc, check, cross) — state, not a count. Shared 16 px outline PR glyph (`pr-branch`: a line with two nodes on the left, a node and a curved arrow on the right), `currentColor`, 11 px in compact actions.
- Repo `…` menu: `Push commits…` (with count), `Checks…` (`#N`, glyph by state), `Open on GitHub`, `Create PR…`.
- Task-level checks use `gh pr view --json …,mergeable` and `gh pr checks --json name,bucket,link` (buckets `pass`, `fail`, `pending`, `skipping`, `cancel`).
- **Checks popover**: the check name stands right after its glyph; `This pull request has merge conflicts.` when relevant; `No checks` without empty counters or separators. Footer: `Refresh` · `Open on GitHub` · primary `Open PR` (opens this PR in the task's PR panel on `Comments` and closes the popover; restores a hidden right part). Without the PR module only the first two remain.

<a id="pr-panel"></a>
## PR panel

The right part of the task window has tabs `Files · Changes · PR` ([Task window](task-window.md)); `PR` is `View ▸ Pull requests` `⇧⌘P`. Width 200–500 px. Header: 44 px, M controls 8 px from the edges, `--hair` line below. Order: segment `Pull requests · CI`, repo picker, space, `New PR`, search icon (`⌘F`; the open field `Find a PR` takes the space after the segment), `Refresh`, GitHub. Narrow: ≤300 px the first segment reads `PR` (`ui/Segments` prop `short`, container query); ≤230 px the repo picker hides; actions stay inside down to 200 px.

Without an open task, clicking a repo counter opens the main tree of that repo ([Projects](projects-and-board.md)).

<a id="repo-counter"></a>
### Repo PR counter

Each GitHub repo row in Repos shows, without words: PR glyph + open count, merge glyph + closed-in-7-days count, amber dot when a PR waits for your review. Words are in the tooltip (`… open PRs · N closed in 7 days · some wait for you`). Zero/zero or no GitHub remote → no counter. Click → PR panel with that repo picked.

<a id="pr-list"></a>
### List

- Groups: `Waiting for you`, `Yours`, `Others`, `Recently closed` (7 days, muted). Older closed → `Older closed PRs on GitHub`.
- Row: state glyph, title, `#N · author · time` (10.5 px), review glyphs, comment count, checks. Hover `--hover` on the whole row; last opened PR `--sel`.
- State badges everywhere are glyph + color, never words: open, draft, merged, closed; waiting for you, changes requested, approved.
- States: `Loading PRs from GitHub…`, `PRs could not be read: the network is unavailable.`, `No open PRs` / `No open PRs in {repo}` (only on an empty successful read).
- Search matches title, number, author and repo name.

<a id="repo-picker"></a>
### Repos in a monorepo

- With more than one GitHub repo in the window the second line starts with the repo name in `--fg`: `apps/admin · #1031 · author · 9 min`. With one repo, or a repo picked, no name. Names are the Repos section names (the root is the project name).
- **Repo picker** in the header whenever the window has >1 GitHub repo: `All repos ▾` (neutral) or `<repo> ▾` (soft accent). Menu: shared `ui/Popover` with header `Repo` and Esc; `All` with the total open count, separator, repos in Repos order with PR glyph and open count; a repo with no PR is a muted non-selectable `No PRs` row. Check mark on the choice; ↑/↓, Home/End, Enter; Esc returns focus to the picker.
- One filter per task (`prFilter`), set by the picker and by the repo counter. A filter on a repo the task does not have is ignored (all task repos are shown).
- In `CI` the picker shows the repo whose runs are visible (picked or first GitHub repo), without `All repos` and counts; picking sets the same filter.

<a id="pr-detail"></a>
### A PR

- Title row (S row, 28 px; back, `Refresh`, GitHub 24 px): back to the list, glyph, title 12/600, `#N`. Below: author, `head → base`, checks, review state; buttons `Overview`, `Review with an agent…` or `Open the review` ([Review with an agent](#review-with-agent)), `PR task` when the PR came from a task.
- Tabs `Comments · Files · Commits · Checks` with counts, sharing the capsule equally; ≤300 px they become glyphs with counts.
  - `Comments` — line threads and review drafts (yours and the agent's with ✦); filter `Unresolved only`; thread marks: open, draft, from the agent, handed to the agent, resolved. Empty: `No comments on the lines` / `Every thread is resolved`. General comments and reviews with text are in the Overview timeline.
  - `Files` — PR files with `Viewed` and comment counts; `{n} of {total} viewed` strip ([Files](#pr-files)).
  - `Commits` — PR commits; a row expands into files, a file click opens that commit's diff as a tab (like History).
  - `Checks` — jobs; a failed one has `Log on GitHub`. For a merged PR see [CI after merge](#ci-after-merge).
- Footer: draft count and `Start review` / `Continue review` / `New review` ([Review modal](#review-modal)); after sending, `You requested changes · just now` etc.
- Own PR, `Comments`: reviewer threads are selected with checkboxes; footer `Reply in the PR` and `Hand to the agent` ([Feedback to the agent](#hand-to-agent)).
- Panel state (tab, filter, search, handed marks `prHanded`) is per task; drafts and summaries are per PR.

<a id="pr-files"></a>
### Files tab, file diff and `Viewed`

- A PR file opens as a diff tab `rules.ts · #421`. **Base is a snapshot of trees** (same engine and renderer as the task diff, [Diff](diff-and-review.md)): merge-base of `baseRefOid` (from GitHub) and the head vs the head tree. The head is `refs/pull/N/head` fetched into `refs/brigadir-v2/pr/N` (forks too), no checkout.
- **One fetch, only when needed**: if `refs/brigadir-v2/pr/N` already points at the PR head and the base commit is local, no network. Otherwise one `git fetch origin <pull> <base>`; without `refs/pull` fall back to head and base separately. Tree preparation starts as soon as the PR is read, on any tab.
- **The tab answers the click**: it appears at once with a spinning glyph; the diff area shows the file header (no counters) and a status line — `Fetching the PR branch…` when the tree is not ready within 150 ms, then `Reading the file changes…`; an error stays in the tab: `The file could not be read.` + `Retry`. Clicking another file closes a tab that never got its diff, so fast stepping leaves one placeholder and opens only the last file. A diff arriving after the user switched tabs does not steal focus. A second click on the same file does not re-read.
- **`Viewed` is optimistic**: the box and `{n} of {total} viewed` change on click; after 0.4 s without GitHub's answer the box pulses (100↔35 %, 900 ms; reduced motion: 50 %) and the caption gets ` · saving…`. One mutation (`markFileAsViewed` / `unmarkFileAsViewed`), no re-read of the PR; main updates the mark in its cache and keeps list caches. Error → the mark reverts to GitHub's value, a red 1.5 px ring and `GitHub did not save the «Viewed» mark for {file}.` with `Retry` (gh text in the tooltip). A newer click on the same file supersedes the request in flight. The review modal does not wait for it.

<a id="pr-keyboard"></a>
### Keyboard in the PR tabs

- `↑`/`↓` one row, `Home`/`End` first/last, no wrap; the step acts like a click (focus, `scrollIntoView({block:'nearest'})`, open). Same pure step function `listStep` (`renderer/ui/list-keys.ts`) as the Files tree and the review list; handler `stepRow` on `data-pr-step` rows of `Files` and `Comments`.
- The `Viewed` box is not a focus stop; `Enter`/Space open the file; arrows with `⌥⌘⌃⇧` are not steps; fields keep their arrows. Keyboard-focused row: `2px --accent` ring inset `-2px` (shared `[data-focused-row]` style). No menu item: list navigation, not a shortcut.

<a id="pr-threads"></a>
### Threads and comments in the PR diff

- GitHub review threads sit on their lines like local review comments: author, line, replies; `Reply` (`Add to review` or `Reply now`), `Resolve thread` / `Reopen thread` (`resolveReviewThread` / `unresolveReviewThread`).
- New comment: select code (comment card with a quote, [Diff selection](diff-and-review.md)) or `+` in the gutter → `Add to review` (draft) or `Comment now`. Comments only on diff lines.
- Drafts are on disk and survive send failures ([Drafts](#review-drafts)).

<a id="pr-definition"></a>
### ⌘+click in a PR file diff

- ⌘+click on a name on the **new side** of a PR file diff goes to its definition in the **PR head tree** (no checkout, no disk). Old side and commit diffs are not handled.
- Main first verifies the clicked line equals the head blob's line; otherwise toast `The file changed. Refresh the PR.`.
- Search (`main/pr-definition.ts`, IPC `prs:definition`): declaration in the same file nearest above; else `git grep -l -w -F` over the head tree among files of the same language family, declarations parsed by the tree-sitter worker; PR-changed files first, then nearer folders. Limits: ≤200 files read, 2 s, `codeLimits.definitions` results.
- One place opens directly; several → `CodeLocations` modal with `Found by name in the PR branch.`, unchanged files marked `Unchanged in the PR`; none → toast `No definition found.`.
- A changed file opens its PR diff tab scrolled and highlighted; an unchanged file opens a read-only `pr:` tab with the whole file as context lines, `Unchanged in the PR` instead of `+N −M`, always one column, no comments. ⌘+click works from it too.
- A crumb under the file header: `Definition of {name}` and `Back to {file}` (returns and scrolls to the click line). `Viewed` marks are unchanged.

<a id="pr-overview"></a>
## Overview

A full PR page as an editor tab `Overview · #421`.

- Header: title (≥120 px, ellipsis, full in tooltip), GitHub, `Start review`, ✦ `Generate a summary`, the helper model capsule, `Merge PR…` (or the state chip). Author and branches (`wants to merge N from … into …`); summary cards — reviewers with each decision (`Nobody yet`), checks, **Merging** card.
- Narrow header: `ui/fit-row` (`useFitRow`) measures overflow of the title row and switches before paint: `Start review` → primary icon `zoom`, capsule → provider glyph, `Merge PR…` → `pr-merged` icon with the reason in its tooltip. Cards go to a column below 640 px or with the narrow header. All hooks sit above early returns (an Overview opened before the PR is read must not crash).
- PR description, then the timeline with filter `All · Comments · Commits · Checks`. In `All` commits are one row `N commits · <sha> <subject>`; clicking it switches to `Commits` (newest first, rows expand into files, file → commit diff tab).
- Under each comment: `Reply`, `Ask the agent`, `Resolve`. The agent (one-off call with the PR in context) answers under the comment as one of: `Agent · an explanation for you` (not sent; `Turn into a reply`), `Agent · a draft reply` (`Send to the PR`, `Edit`, `Discard`), or on your own PR `Agent · a change for the task` (`Apply` via the PR task's agent, view diff, `Discard`).
- Bottom field with `Addressee` `To the PR | To the agent`: `Comment on this PR…` or `Ask the agent about this PR…`.

<a id="pr-summary"></a>
### Agent summary

- Written by the `Helper agent` (one-off call; prompt in English, answer in the UI language). Sections: what changed and why, risky spots with `file:line` links, what to check, size (`headline`, `done`, `watch`, `check`, `minutes`).
- Cached per head SHA in `summary-<repo>-<N>.json`, shared by the review modal and the Overview (there the button shrinks to ✦). A cache on another head reads as stale: `N new commits` + `Update summary`; `Regenerate` manually. A link click opens the PR file diff scrolled to the lines, highlighted, with crumb `From the summary: … · lines 20–22 · Back to Overview`.
- Auto-generated on the first open of any PR when `agents.prSummary` is on (default; `Settings ▸ Modules ▸ Pull requests ⚙`). No size limit: the file list with `+/−` always goes, patches up to a 96 000-character budget (`fitPatch` trims per file or whole and names what was left out).
- Quota warnings do not stop it (only background conveniences stop on a warning); it runs until the window is exhausted.

<a id="merge-card"></a>
### Merging card

Shows, in words, the same reason that disables `Merge PR…` (`mergeBlock` order):

| State | Card |
| --- | --- |
| `CLEAN` | `✓ Can be merged` |
| Conflict | `✕ Conflicts with <base>` + [Resolve conflicts](#resolve-conflicts), or the reason why not |
| Checks failed | `✕ Checks did not pass` |
| Approval needed | `Without conflicts` + `◷ {n} approvals required` |
| Draft | `Without conflicts` + `The PR is a draft` + `Ready for review` |
| No permission / other | `You cannot merge in this repo` / `GitHub does not allow merging yet` |
| Closed / merged | `The PR is closed` / `The PR is merged` (+ deploy row, [CI](#ci-after-merge)) |

`Ready for review` (`btn s`): GraphQL `markPullRequestReadyForReview`; for the PR author or anyone with write access (`canMerge`); no confirmation; `Working…` while running; success re-reads the PR (draft badge gone everywhere); error → red line with GitHub's reason, button stays.

<a id="merge"></a>
### Merging a PR

- `Merge PR…` lives only in the Overview header and the review modal header — never in the panel or list. Enabled only when GitHub says `mergeStateStatus = CLEAN`; otherwise disabled with the reason in its tooltip.
- Merged PR → a non-interactive chip `Merged` (`pr-merged`, `--purple-soft`/`--purple`); closed → `Closed` (`--red-soft`/`--red`). Takes the header row's `data-size`.
- Dialog `Merge PR #{n} into {base}?`: method among those the repo allows (`Squash` / `Merge commit` / `Rebase`), default `viewerDefaultMergeMethod` (`the repo default`), consequence text per method, commits that will go (`To merge: {n}`), `Delete the branch`, `A merge on GitHub cannot be undone.`. Error stays in the dialog (`GitHub did not merge the PR.`).
- Mechanism: REST `PUT …/pulls/N/merge` with the head `sha`, then `DELETE …/git/refs/heads/<head>` when asked — not `gh pr merge` (it deletes the local branch and may switch the user's tree).
- `Delete the branch` is not offered (and main refuses) for a fork PR, when head is the repo's default branch, or for long-lived `main`, `master`, `stage`, `staging` in any case (`keepsBranch`). Same rule on the phone.
- After merge: toast `PR #{n} merged`, PR moves to `Recently closed`; the PR's task and worktree follow [worktree cleanup](tasks.md).

<a id="resolve-conflicts"></a>
### Resolve conflicts

- Under `✕ Conflicts with <base>`: `ui/SplitButton` `Resolve conflicts… ▾` (narrow card `Resolve`). Main part runs the chosen way; menu: `Resolve in the dialog` (`Merge {base} into the PR branch, then pick per file`, default) and `Ask the agent to resolve` (`The agent resolves; you review, finish the merge and push`). The choice stays the main action until the window reloads. Tooltip `Merge {base} into the PR branch and resolve the conflict`. Also in the PR row menu and the review modal (amber).
- Mechanism (`prs:resolve-conflicts`): fresh fetch of base and head; **merge the base into the PR branch** (`git merge --no-ff origin/<base>`) — no history rewrite, no force push.
- Where: an existing task in a worktree on the PR branch with that repo (the PR's task, a fix task, a previous conflict task); otherwise a new task `Conflict #N · <title>` in a worktree on the PR branch under the **same name** (`prReview.mode = conflicts`) so a normal push updates the PR. A same-named local branch not checked out anywhere and without commits beyond the PR is recreated at the PR head; otherwise refused (`The PR branch is checked out in another tree.`, `The local PR branch has commits that are not in the PR.`).
- The task opens on the `Conflicts` dialog ([Merge and conflicts](git.md)). The agent way sends the resolve prompt (English, with a PR line) as a separate turn. The merge commit is only the user's; push only through the normal confirmation, whose dialog says `This push updates PR #N`. A repeat click while the merge is open re-opens it (agent: hands over remaining places).
- Merge resolved itself → push dialog + toast `The merge went through by itself: push it to update the PR.`; base already in the branch → `The PR branch already has the base. GitHub updates the state shortly.`.
- No button without push access (`You cannot push to the PR branch.`) or for a fork branch (`The PR branch is in a fork: resolve the conflict on GitHub.`). Errors → toast with the reason, button stays.

<a id="review"></a>
## Review

<a id="review-modal"></a>
### Review modal

The only review form; the PR panel has no form of its own. Near-full-window `ui/ModalDialog` over the work area; Esc closes without confirmation (drafts are already saved).

- Header: PR (title, `#N`, author · branch), `Review with an agent…` / `Open the review`, GitHub, `Merge PR…`/resolve, Esc.
- Agent summary on top ([Summary](#pr-summary)): skeleton + `Stop` while writing; collapses to a line from step 2 (`Expand`).
- Steps (clickable in any order, next one outlined; `Back`/`Next`): **Read** (unviewed files, risky spots, open threads) → **Comments** (select code → `Comment`; agent suggestions ✦ `Accept` / `Edit` / `Drop`; your drafts with `Go to the code`, `Edit`, `Remove`; empty → explanation and `Review with an agent`, `Next` still active) → **Verdict** (three decisions in plain words + an agent hint when there are drafts) → **Summary** (the reviewer's own words; `Generate from the drafts`) → **Check** (`What GitHub gets`: decision, summary, every comment as the author will see it; `Send` `⌘↩`).
- Body: files with `Viewed` on the left, diff in the center (same `Unified` / `Side by side` / `Preview` / `Wrap lines` controls as diff tabs, task state `mode`/`wrap`), step column on the right. Narrow modal (<1000 px): files become a dropdown `index.tsx 4/6 ▾`; header without branch and agent button.
- **`Accept all` / `Drop all`** in the `✦ From the agent · N to go through` heading, from two suggestions up (`.headingToggle` look). Accept all: immediate, accepted = ordinary drafts (`accepted`). Drop all: `ConfirmDialog` `Drop all suggestions?` (danger); your drafts stay. Writes go one by one through `acceptPullRequestDraft` / `removePullRequestDraft`, serialized per PR in main; the column is inactive meanwhile; failure → `Could not save the draft.`.
- Own PR: GitHub accepts neither `APPROVE` nor `REQUEST_CHANGES` — step 3 becomes `Comment` (`you cannot approve your own PR`, `you cannot request changes on your own PR`); a saved unavailable decision becomes `Comment`; main refuses before calling GitHub. Step 5 offers `Send as a comment` and `Hand to the agent to fix`.
- **Agent fixes**: under `Send`, `or don’t send — fix it` (any PR). Drafts go to the agent as a prompt (`file:line` + text). Who fixes: own PR → the agent of the PR's task (`The agent of the PR task makes the fixes. Push only after you confirm.`); another's PR → task `Review #N` in a worktree on the PR branch; no push right → a separate PR `<head>-fixes → <head>` (fix task base = `<head>`); from the main tree → quick task `Fixes #N` on the PR branch (switches the tree only if clean). Checkbox `Also send the comments to the PR` (default on). Own PR also hands over other people's open threads. Disabled with a hint when there is nothing or nobody to hand to.
- Sending: one REST review `POST …/pulls/N/reviews` (decision + line comments). Errors show the reasons from the response's `errors` with the HTTP status in brackets; the failing comment is highlighted with `Go to the comment`; drafts stay (`GitHub did not accept the review: {reason} The drafts are saved.`). Disk failure: `Could not save the review.` + `Send again`. Success: modal closes, toast `Review sent to PR #{n}` · `Open on GitHub`.
- Empty states: no files (`No files`, `No changes`, step 2 inactive), no summary (not signed in, auto-summary off, no agents), nothing risky, agent found nothing / not asked, step 4 without drafts.
- Entries: panel footer, Overview header `Start review`, PR row menu `Start review…`/`Continue review…`. Each shows the `zoom` (window ↗) glyph after its name. Merged/closed PRs have no entry. The modal state lives in the task and is rendered by the task window.

<a id="review-drafts"></a>
### Drafts belong to the PR

- Files at project level: `projects/<projectId>/pull-requests/review-<repo>-<N>.json` and `summary-<repo>-<N>.json` (`<repo>` = canonical repo id of the main tree). Every task, the main tree and the host read and write the same file; main serializes writes per PR.
- A worktree repo has a different id; PRs are matched to repos by name, and a review task opens its PR with `prReview.scopeId` (main-tree id) resolved by name.
- Legacy per-task files are merged on read (deduplicated by id, ordered by creation; general comment, decision and flag from the newest) until the first write creates the project file; old files stay untouched.
- An agent draft remembers its `taskId`. The panel re-reads drafts whenever any task of the project finishes a tool or a turn.

<a id="review-with-agent"></a>
### Review with an agent

- Button `Review with an agent…` (glyph `generate`) in the PR header (also on own PRs, and in a review task for a **different** PR; absent only on the PR that task reviews), in the modal header and as `Review with an agent…` in the row menu. Below 300 px it reads `With an agent…`. Each opens the [launch dialog](#review-launch).
- **A live review task**: while a task `Review #N` of this PR (same project, `prReview.mode = review`, same canonical repo and number, or the same repo name, `prReview.repo`, when the PR is shown from a worktree) is not archived, the same places show `Open the review` with the `zoom` glyph instead, led by that task's status glyph (`ui/StatusIcon` 12, the sidebar's colours; tooltip and accessible name = the status in the board card's words, `taskStatusLabel`). A click opens the task with the PR panel on this PR; from the modal the modal closes first. Archiving the task brings `Review with an agent…` back. Several live review tasks of one PR (older data): the most recently updated one.

<a id="review-launch"></a>
- **Launch dialog** (`ui/ModalDialog`, width 520, title `Review with an agent`, note `#N · <title>`, `Esc`):
  - The instructions field on top: `PromptEditor` of the New task sheet (no box, at least 84 px, `@` for files and folders; no `/`, no attachments), placeholder `What should the reviewer look at? (optional)` (`reviewers` for a crew). Focus starts in it. Its text is a draft of this PR (`projectId · repo id · N`) kept in the renderer until the review starts or the window reloads; `Esc`, `Cancel` and a click outside keep it.
  - Under it the [project review notes](#review-notes) row when the project has notes: `Project review notes · N lines` or `· REVIEW.md`, with `Edit…`.
  - A hairline, then a grid of S rows: `Where` — segments `Quickly · In a worktree` with the caption of the chosen one (`In the main tree, the branch stays` / `Branch pr-N-review, dependencies can be installed and run`); `Who` — segments `Agent · Crew` and one `ui/Controls` `Popup`: the models (the Default agent with its tail `Default agent`) or the library crews (`Review crew · Astra · Opus`; none → the popup is disabled with `No crews`). With a crew, the caption `The foreman passes your notes to each reviewer`. Then `Remember for reviews with an agent` (`ui/RememberCheck`).
  - Footer: `Cancel`, `Start review` (primary; `⌘↩` from anywhere in the dialog, also with an empty field). Starting: the button shows a spinner and `Starting…`, the controls are inactive. Success closes the dialog (and the review modal, if it was opened from it), opens the review task with the PR panel on this PR and shows the toast `The task «…» started` (from elsewhere than the modal, with `Open`). Failure keeps the dialog and its text, with `Could not start the review task.` above the footer and `Retry` as the primary button.
  - `Where` and the choice of agent or crew start from the last ones (`agents.reviewWhere` in `settings.json`, default `quick`, missing key = `quick`; the action's agent or crew). Starting saves `Where`. The agent or crew is for this review only unless `Remember for reviews with an agent` is checked.
- **Instructions in the prompt** (English frame, rule 12; the person's text as typed): the review prompt ends with the project notes (`Review notes of this project:` and the text, or for `REVIEW.md`: read it at the merge base with `git -C <repo> show <base>:REVIEW.md` and follow it; a missing file is no error), then `Instructions from the person for this review:` and the text. A crew's foreman gets both in its prompt and passes them word for word into each reviewer's brief. Nothing is added without notes.
- Task `Review #N · <title>`, Reviewer template (writes no code, `readOnlyAgent`), prompt "Review PR #N… leave draft comments on the lines, do not change code" (English).
  - **Quickly**: no isolation in the main tree, no branch switch, no worktree; takes no repo lock (read-only agent). Reads the PR from git: the prompt names repo, `refs/brigadir-v2/pr/N` and the merge-base and how to read (`git diff <base> <ref>`, `git show <ref>:<path>`, `git grep <pattern> <ref>`), and warns that working-tree files are the user's branch. Does not run tests.
  - **In a worktree**: branch `pr-N-review` from `refs/brigadir-v2/pr/N`, only the PR's repo (the project root checks out its own HEAD).
- Agent comments use MCP `pr_comment` (review tasks only, `prReview.mode = review`; in a crew review only the foreman): drafts with ✦ in your review; nothing reaches GitHub without you.
- Started from the modal: success closes the modal and opens the review task with the PR panel on that PR; toast `The task «…» started` without `Open`. Started elsewhere: toast with `Open`. A failure stays in the launch dialog. Return to the review via `Continue review` or `Open the review`.
- The worktree is removed with the task ([Worktree cleanup](tasks.md)).

<a id="agent-draft-thread"></a>
### Thread under an agent draft

- On an agent draft card in the PR diff: `Reply to the agent` → field `Write to the agent…`, `Send to the agent` `⌘↩`, Esc. Under the draft body: thread of your replies and the agent's (✦) in time order; `The agent is thinking…` until it answers the last one. Comments tab shows the reply count.
- A reply goes as an ordinary message (visible in chat) to the review task that wrote the draft (`taskId`; legacy drafts → the current review task), with draft id, file, lines and text (English).
- The agent answers with MCP `pr_comment_reply` (`id`, `body`, optional `text`): `body` becomes its reply; `text` rewrites the draft (header `updated by the agent`). Only own (`fromAgent`) drafts, only from the owning review task. Only the user removes a draft. The thread never goes to GitHub.
- No live review task → `Reply to the agent` disabled: `The review task is gone`.

<a id="review-notes"></a>
### Project review notes

- What every review with an agent in a project gets, written once. Dialog `Review notes` (`ui/ModalDialog` 520, note = project name, `Esc`): caption `Every review with an agent in this project gets these notes.`, segments `In the project · REVIEW.md in the repo`, then either a `TextArea` (at least 96 px) or the row `REVIEW.md` with the caption `The agent reads it at the PR base.`; footer `Cancel`, `Save` (`⌘↩`). An emptied text with `In the project` removes the notes; a failed save keeps the dialog with `Could not save the review notes.`
- Opened by `Edit…` in the launch dialog and by `Review notes…` in the project menu ([Sidebar](sidebar.md#project-menu)). Opened from the launch dialog, it stays over it and returns to it with the row updated.
- Stored as the project's `reviewNotes` in `project.json`: `{source: 'text', text}` (≤ 16 000 characters) or `{source: 'file'}`; absent = none. Nothing is committed to the repo.

<a id="review-crew"></a>
### Review by a crew

- `Agent · Crew` segments in the [launch dialog](#review-launch). `Crew` lists library crews (defaults first): name + composition (`Astra · Opus`); none → `No crews`. One-off choice; `Remember for …` stores it in `actionCrews` (next to `actionAgents`); `Customize per action` shows `Crew · <name>` and `Reset`. Agent and crew exclude each other.
- Default crew `Review crew` (id `review`): Foreman + `Astra` (Codex, `gpt-6-astra`, effort High) + `Opus` (Claude, `opus`, effort High). A model missing from the catalog shows amber.
- The task is still `Review #N` with `prReview`; its agent is the foreman. Both reviewers read the whole PR independently (quick: from `refs/brigadir-v2/pr/N` in their own worktree without setup; worktree: at the PR head), report `path:line` findings, write no code, have no `pr_comment`. The foreman reads reports (`read_report`), deduplicates, settles disagreements and leaves each finding once as a `pr_comment` draft ending with who found it (`— Astra, Opus`). No plan approval: in a review task `create_worker_task` takes reviewers without `propose_plan` ([Crew](crew.md)).
- Default crews can be edited in place (`Edit…` in `Settings ▸ Templates`; `Reset` returns the app's crew), so the Review crew's reviewers and models are the person's to change. They can also be deleted (`−`): hidden in `templates/builtin/hidden-crews.json`; tasks keep their snapshots; `+ ▾` ends with `Restore default crews`. Default agents (Foreman, Developer, Reviewer) can only be duplicated. A launch sheet remembering a hidden crew starts without one ([Templates](crew-templates-and-editor.md)).

<a id="hand-to-agent"></a>
### Reviewer feedback to the agent (own PR)

In `Comments` of an own PR, selected reviewer threads go with `Hand to the agent` as a user message to the PR's task (`task.pullRequests`) with an attachment `N comments · #N` (composer shelf); threads get the "handed to the agent" mark. No such task → drafts into a fix task; in the main tree → a quick task on the PR branch. `Reply in the PR` answers on GitHub.

<a id="pr-row-menu"></a>
## PR row menu

Right click, ContextMenu key or `⇧F10` on a list row → native menu built by `main/pr-menu.ts` (glyphs on macOS; text on Windows/Linux). The row keeps its whole-row hover; selection does not change.

| PR | Items |
| --- | --- |
| Open | `Start review…` / `Continue review…`; `Review with an agent…` (opens the [launch dialog](#review-launch)) or `Open the review` while a review task of this PR is live (neither on the PR this task reviews); `Resolve conflicts…` (only with a conflict and push access); separator; `Open on GitHub`, `Copy link`, `Copy branch name` |
| Merged / closed | `Open on GitHub`, `Copy link`, `Copy branch name` |

Conflict state comes from PR details: known → immediate; otherwise the menu waits ≤0.5 s, then omits `Resolve conflicts…`. Copy goes to the clipboard of the machine showing the menu ([Remote access](remote-access-and-mobile.md)).

<a id="pr-links"></a>
## PR links open in the PR panel

- `pullRequestLink` (core) recognizes `https://github.com/<owner>/<repo>/pull/<N>` (also `www.`), no `user:pass@`, `N` ≤9 digits, with tails `/files` → `Files`, `/commits` (`/commits/<sha>`) → `Commits`, `/checks` → `Checks`, `?…`, `#discussion_r…`, `#issuecomment-…` → `Comments`. Issues, Actions, other `/pull/N/...`, `pulls`, other hosts are ordinary links.
- "This project": `owner/repo` (case-insensitive) equals the `origin` of a git root of the current task (worktree or main tree), from `git remote get-url origin` (https, `git@github.com:`, `ssh://`) without network; non-GitHub remotes ask `gh repo view`.
- A click (chat, plan, Markdown preview via `openTaskLink`) → `prs:resolve-link` → `{scopeId, number}` (also pre-reads the PR detail) → `openTaskPR`: PR panel, repo filter, Overview on the tab from the tail.
- `⌘+click` and `Open in system browser` open the system browser. Chat menu for a PR link: `Open in the PR panel` · `Open in system browser` · `Copy link`. Terminal PR links get the same entry ([Terminal](terminal-and-cli-agents.md)).
- Fallbacks: PR module off → browser, no request; PR unreadable → browser + warning toast `Could not open the PR in the app. Opened in the browser.`; another repo → browser silently. `prs:resolve-link` accepts only URLs `pullRequestLink` accepts and known project/task ids; opening never writes to GitHub.

<a id="project-pr-section"></a>
## Pull requests section of the project screen

(Full screen behaviour: [Projects and board](projects-and-board.md).)

- Entering `Pull requests` (rail, `⌃⌘2`) always opens `All projects`; a project group header in the sidebar narrows the board; `All pull requests` returns. Back to Tasks restores what Tasks showed.
- `New pull request` replaces `New task` in the board header: one GitHub repo → the [dialog](#new-pr-dialog) directly; several → menu `project · repo`. The dialog opens in the project's main tree (`requestForgeAction`). No GitHub → disabled, `GitHub is unavailable`.
- All projects in the sidebar, no separate project filter: a project without open PRs is a collapsed group `0` (expanded: `No pull requests`); with PRs expanded, tail = count waiting for you (accent) or all. Search or `Yours · Waiting for you` leaves only groups with matches. Closed PRs are only in the board's `Closed` column.

<a id="ci"></a>
## CI: runs, steps, deploys

Read over REST via `gh api` (`@brigadir/forge` `ci-runs.ts`, defensive parsing): runs, jobs (`per_page=100`), steps, deployments, annotations. Logs, re-runs, matrices and environment approvals stay on GitHub.

<a id="ci-after-merge"></a>
### After merge (merged PR)

- `Checks` of a merged PR: group `After merge` with workflow runs on the PR's `mergeCommit.oid` (`/actions/runs?head_sha=`); below, collapsed, the PR's own checks `PR · before merge` (`{n}/{total} green`).
- Run header: state glyph, `workflow #number`, duration; second line branch chip (≤150 px, middle-truncated `ui/BranchName`), `merge commit <sha7>`, `started by {who}`. Jobs (`/actions/runs/{id}/jobs`) expand into steps (`steps[]`: number, glyph, name, time); a running or failed job is expanded; a job without steps does not expand, has no chevron and uses full color.
- Overview of a merged PR: the Merging card under `PR #{n} merged · <time>` has a deploy row (glyph, `Deploying to {env}` / `Deployed to {env}` / `Deploy to {env} failed`, `step {n}/{total}`, running step below); click → `Checks`. The timeline has the same event. Panel header and the `Checks` tab glyph show run/deploy state (`deploy {n}/{total}`, `deployed`, `deploy failed`, `run going`, `run passed`, `run failed`) instead of the checks count. Empty: `No runs after the merge`.

<a id="ci-segment"></a>
### `CI` segment

- `CI` in the panel header segment: runs of the picked repo (`/actions/runs`, last 30), groups `Yours` (started by the viewer) and `Others`; row: glyph, commit/PR title, `workflow #number · author`, branch, time, duration; a running run has a step strip; a watched run shows a small filled bell.
- Filters `Branch` and `Workflow` (default `all`): `ui/Popup` with `fit` (trigger S on `tint`, width of the text), ✓ on the chosen value.
- `Older runs are on GitHub` only after runs were read. States: `Loading runs from GitHub…`, `Runs could not be read: the network is unavailable.`, `No runs`.
- Run click → run page (same content as after-merge; title row S: back `Back to the runs` and GitHub 24 px); `The run could not be read.` + `Retry`.

<a id="ci-deploys"></a>
### Deploys

- Only a job with an `environment` is a deploy. State from GitHub Deployments of the same SHA (`/deployments?sha=` → latest status): `queued`/`in_progress` → `Deploying to {env}`; `success` → `Deployed to {env}` with `Open {env}` (`environment_url`, opens in the in-app browser, [Browser](browser-and-simulator.md)); `failure`/`error` → `Deploy to {env} failed`. The deploy job is the one whose id is in the status's `log_url`.
- Without a deployment there is no deploy strip and no word "deploy" — the run is just passed or failed.

<a id="ci-failed-step"></a>
### Failed step

Red row; below it one GitHub annotation (`/check-runs/{job}/annotations`, first `failure`, caption `GitHub annotation · job` in the UI font); actions `Log on GitHub` (job page) and `Agent fixes it`: goes to the PR branch's live task, else a quick task in the main tree on the base branch; the agent gets workflow, job, step and annotation in English and reads the log itself (`gh run view --log-failed`). Later steps show `skipped`.

<a id="ci-refresh"></a>
### Refresh while a run is live

While a surface showing a `queued`/`in_progress` run is open (merged PR `Checks`, `CI` list, run page), it re-reads every 10 s (`Updates while the run is going`); the timer stops when all visible runs end or the surface closes. Otherwise the normal read rules apply. A run finishing while visible gives a toast: `#{n} deployed to {env}.` with `Open {env}`, or `Deploy to {env} failed.` with `Open` — not for a watched run (the bell notifies instead).

<a id="ci-glyphs"></a>
### State glyphs

`ck-pass`, `ck-fail`, `ck-run`, queued (dashed circle), skipped/cancelled (circle with a bar; skipped `--fg3`, cancelled `--fg2`). Run, job, step and PR check rows are one component `ui/RunSteps` (`CheckRow` for PR checks); the Checks dialog uses `CIGlyph`. Hover covers the whole row.

<a id="ci-bell"></a>
### Run bell

- Icon button S right of the workflow name in a run header (merged PR `Checks`, run page). Present only for a queued/running run (or running deploy) and for a run already watched. Tooltip/`aria-label` `Notify when the run finishes` / `Stop notifying`, `aria-pressed`; on = filled glyph in `--accent`.
- Main owns the watches (`main/ci-watch.ts`), persisted in `ci-watch.json` in the data directory: survive closing the panel, switching tasks and restarts. Poll every 15 s while at least one watch exists; no timer otherwise. Max 20 watches; a watch older than 24 h or a run GitHub no longer returns is dropped silently.
- On finish: an OS notification (quiet; requires the macOS permission, ignores the agent "When" rule) **and** an in-app toast (`success`/`error`) with `Open the run`. Title `{run} passed` / `{run} failed` / `{run} cancelled` (`<workflow> #<n>`); second line the deploy (`Deployed to {env}`, `Deploy to {env} failed`) or the commit/PR title. Clicking either opens the task and the run page in the `CI` segment. The watch is removed and the bell turns off. Slack can receive the same event ([Slack](notifications-slack-notes-and-schedules.md)).
- IPC: `prs:ci-watch`, `prs:ci-watches`; events `ci:watches`, `ci:finished`, `ci:open`.

<a id="data-and-ipc"></a>
## Data, settings, IPC and tools

| Kind | Name | Purpose |
| --- | --- | --- |
| Task file | `pullRequests`, `prReview {scopeId, number, mode: review\|fix\|conflicts, base}` | PRs of the task; review/fix/conflict task |
| Project file | `pullRequestBases` | Per-repo default PR base |
| Data dir | `pr-suggestions.json`, `ci-watch.json`, `projects/<id>/pull-requests/{review,summary}-<repo>-<N>.json`, `templates/builtin/hidden-crews.json` | Ready-card hiding, run bell, PR drafts and summaries, hidden default crews |
| Settings | `agents.reviewWhere` (`quick`\|`worktree`), `agents.prSummary`, `actionAgents`, `actionCrews` | Review place, auto-summary, per-action agent/crew |
| Git refs | `refs/brigadir-v2/pr/N` | Fetched PR head |
| MCP | `pr_comment`, `pr_comment_reply` (review tasks, PR module on); `pr_state` ([Agents](agents-and-providers.md)) | Agent drafts and replies |
| IPC (task forge) | `forge:read`, `forge:details`, `forge:prepare-pr`, `forge:check-pr`, `forge:create-pr`, `forge:generate`, `forge:prepare-push`, `forge:push`, `forge:hide-suggestion`, `forge:open`, `forge:url`, `forge:branch`, `forge:discard` | Create PR, push, checks |
| IPC (PR panel) | `prs:list`, `prs:detail`, `prs:files`, `prs:file-diff`, `prs:prepare`, `prs:viewed`, `prs:draft-*`, `prs:comment`, `prs:comment-now`, `prs:resolve`, `prs:review-*`, `prs:submit`, `prs:verdict`, `prs:summary*`, `prs:ask`, `prs:ready`, `prs:merge`, `prs:resolve-conflicts`, `prs:agent-task`, `prs:definition`, `prs:menu`, `prs:resolve-link`, `prs:link*`, `prs:open`, `prs:url`, `prs:ci-run(s)` | PR panel, review, CI |

The PR is Brigadir's own domain model; no agent-protocol type reaches a view.

<a id="later"></a>
## Later

- Arrow-key navigation in the `Commits` tab (arrows move focus, `→`/`←` expand), separate from the click-like stepping of `Files`/`Comments`.
- A preview tab that the next stepped PR file replaces (today each opened PR file stays its own tab).
- An exact (language-server) go-to-definition mode for PR files alongside name search.
- Attachments (files, images) and `/` in the review launch dialog; the instructions field on the phone's review sheet.

<a id="non-goals"></a>
## Non-goals

- Auto-merge (any kind, including cross-repo), merge bypassing branch protection (`--admin`), merging another's PR without permission.
- CI logs inside the app, re-running jobs, matrices, approving environments; a GitHub dashboard.
- Background polling of GitHub beyond the live-run surfaces and the explicit bell.
- The agent calling `gh pr create` itself.
- Rebase/force-push conflict resolution, or GitHub "Update branch" for conflicts.
- Auto-notification for every run of a merged PR.
