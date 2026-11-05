# Notifications, Slack, notes and schedules

How Brigadir tells the person that something happened: system notifications and in-app sound, toasts and the five message classes, notice chips for ongoing states, and the notification center that keeps the history. The same file covers three optional modules built on top of that plumbing: Slack messages from the person's own CI bot, Markdown notes with their own agent chat, and scheduled tasks where every run is a new task.

<a id="system-notifications"></a>
## System notifications and sound

Two independent axes, each with its own «When» picker: OS notifications and in-app sound. Both are delivered from main as a live feed on `Sessions.publish`; the renderer never decides what to notify.

<a id="notification-settings"></a>
### Settings ▸ Notifications

The Settings tab **Notifications** sits between Language and Agents. `settings.json` key `notifications`:

| Field | Values | Default |
| --- | --- | --- |
| `mode` | `off` · `needs-you` · `turn-ended` | `needs-you` |
| `soundMode` | `off` · `needs-you` · `turn-ended` | `needs-you` |
| `sounds.needsYou` / `sounds.turnEnded` / `sounds.failed` | a sound name or `null` | `Ping` / `Tink` / `Basso` |
| `muteVisibleTask` | boolean | `true` |

- UI: section **Notifications** — `When` (`Never` · `When you are needed` · `When a turn ends`, each with a one-line description); section **Sound** — `When` with the same three bare labels, then three slots `Needs you`, `Turn ended`, `Error`, each with `None` first; switch `Mute the task being viewed`.
- Choosing a sound plays it at once; a failed preview shows `The sound could not be played.` under the section.
- `turn-ended` is the wider value: it also covers `needs-you`. "Turn ended" means the agent stopped talking and waits for a prompt; "needs you" means it is blocked on a permission, question, plan or proposal.
- Old documents with `enabled`/`scope` are read as `mode` (`enabled: false` → `off`, else `scope`) without rewriting the file.

<a id="notice-kinds"></a>
### What notifies

`noticeKind()` maps only normalized semantic events; nothing is inferred from prose.

| Notice kind | Source events | Shown when |
| --- | --- | --- |
| `needs-you` | `permission.requested`, `question.requested`, `task.proposal.requested`, `crew.plan.requested` (only if still open after 750 ms), a worker question once the foreman ends its turn without answering or `crew.question.escalated` | `mode` ≠ `off` |
| `turn-ended` | `turn.completed` (not `cancelled`); a finished background command when no new turn starts within 5 s | `mode` = `turn-ended` |
| `failed` | `session.failed`, `background.changed` with `failed` | `mode` ≠ `off` |
| `rate-limited` | `rate-limit.changed` with `rejected`, on the transition into a block | `mode` ≠ `off` |
| `scope-violation` | `scope.violation` (a read-only repo changed) | `mode` ≠ `off` |
| `page` | a page notification from the task's browser ([Browser](browser-and-simulator.md#notifications)) | `mode` ≠ `off` |

- While a task is rate-limited, `failed` and `turn-ended` notices are suppressed.
- Never notified: progress, individual tool calls.
- **Mute rule** (`muteVisibleTask`): no sound and no banner when the app window is focused and this task is the one visible (renderer reports it via `notifications:visible`; focus comes from the `BrowserWindow`).
- The CI run bell notifies whatever `mode` is, including `Never` ([CI bell](pull-requests-and-ci.md#ci-bell)).
- When `decision.show` is true, `needs-you` and `turn-ended` also go as Web Push to paired phones ([Remote access](remote-access-and-mobile.md)).

<a id="delivery"></a>
### Delivery rules

- **No replay.** The first snapshot after attach seeds a per-task `seq` watermark; events are buffered (up to 2000) until then. Replaying a journal or reattaching never notifies. A host detach clears pending requests until the next seed.
- **Silent banners.** Notifications are always `silent`; sound is played by the app, so there is never a double signal.
- **Ids and grouping.** `groupId` = `<projectId>/<taskId>`; `id` = `<group>/needs-you/<requestId>` or `<group>/<kind>`. Repeats of one kind replace the earlier banner.
- **Auto-close.** `permission.resolved`, `question.resolved`, proposal/plan/crew-question resolution, `host.stopped` and a new `turn.started` close stale banners; the end of a rate limit closes the `rate-limited` one.
- **Actions.** `Allow` / `Deny` map only to the request's `allow_once` / `reject_once` options (never `allow_always`). Before answering, main checks the request is still pending and the option exists; otherwise it opens the task. On macOS the buttons appear only in the alert style of a properly signed build; a click on the banner always opens the task.
- **Window focus.** Only `Open` / a click on the banner shows and focuses the window; an arriving event never raises it.
- **After restart** a click on an old banner only activates the app.
- **Dock badge** = number of tasks with an open permission, question, proposal, plan or waiting worker question, across all projects (seeded from snapshots), plus the counts connected machines ask this device to show. Updated only when the number changes.
- No modal alerts outside the app; no sound by default in the `turn-ended` mode.

<a id="sounds"></a>
### Sounds

- Only sounds already installed; nothing is bundled and the list is never hardcoded. Settings store only a safe name (`isSoundName`: file stem, no path); main resolves the file.
- macOS: `.aiff` from `/System/Library/Sounds`, `/Library/Sounds`, `~/Library/Sounds` (later folders override earlier), played with `/usr/bin/afplay`.
- Linux: freedesktop sound theme (`.oga`, `.ogg`, `.wav`) from `/usr/share/sounds/freedesktop/stereo`, `/usr/local/share/sounds/freedesktop/stereo`, `$XDG_DATA_HOME/sounds`; the macOS default names alias to `message-new-instant`, `complete`, `dialog-warning`; player is the first of `pw-play`, `paplay`, `canberra-gtk-play -f` on `PATH`.
- Other platforms: no sounds.
- Sound never depends on notification permission. Do Not Disturb / Focus does not silence it (no public API for Focus state); the mute rule covers the common case.
- IPC: `sounds:read`, `sounds:preview`. The renderer never asks main to run a command — only names a sound from the catalog.

<a id="macos-permission"></a>
### macOS permission

- A native N-API addon on `UNUserNotificationCenter` exposes `status()` and `request()` → `granted` | `denied` | `not-determined` | `unknown`. `Provisional` counts as `granted`. A process without a bundle identifier and any non-macOS platform give `unknown`: then there is no state row and no warning.
- State is re-read on start, on app activation and on window focus (returning from System Settings) and broadcast as `notifications:permission`.
- **Request on first need**: the first notice that would show while `not-determined` calls `request()` first and shows only after `granted`. The only other request point is the `Allow` button in Settings (`notifications:request`). Nothing is asked on start or when the picker changes.
- Settings, when `When` ≠ `Never`: row `System permission` — `Allowed` with a check, or `Not requested yet` with `Allow`. When `denied`, the row is replaced by a warning in the card, `Brigadir notifications are off in system settings.`, with `Open System Settings` (`notifications:system-settings`, macOS only). Otherwise `Open System Settings` stands under the sections.
- App level: while `When` ≠ `Never` and the state is `denied`, one warning toast `Notifications are off in system settings` with `Open System Settings` (action on macOS only); it resolves itself when macOS allows them or `When` becomes `Never`.

<a id="sidebar-attention"></a>
### Sidebar attention flash

Independent of «When»: it is sidebar state, not a notification. Runs only on a live state transition of a mounted card — never on first render, reload or opening a project. Details of the sidebar are in [Sidebar](sidebar.md#state-icons).

| Transition | Animation |
| --- | --- |
| to `done` (turn ended) | one `--accent-soft` wave with an `--accent` ring over the card, 1100 ms to transparent; the state glyph pops 0.4 → 1 (420 ms, overshoot); the unread dot pops 260 ms later |
| to `needs-you` | fill `--tint` → `--amber-soft` in 500 ms; an amber ring expands from the glyph twice (900 ms ×2, 150 ms delay) |
| collapsed project | its `needs-you` counter pops when it grows |
| worker rows in a foreman card | glyph and dot only, no wave |

`prefers-reduced-motion: reduce` changes the state without animation.

<a id="message-classes"></a>
## Message classes

Every message the app shows outside regular content belongs to one class; the class decides where it appears and how long it lives. New messages must pick a class.

| Class | What | How it is shown |
| --- | --- | --- |
| **T** — transient failure | A person's action or a background read failed (open a file, send, discard changes, read locks) | [Toast](#toasts) |
| **T\*** — failure in a modal | The same inside a dialog or sheet, where a toast is hidden | A line in the dialog where the person acts; cleared by the next attempt or closing |
| **S** — ongoing state | Mixed changes in a repo, read-only repo changed, agent sign-in expired, subscription limit, unavailable repos | [Notice chip](#notice-chips) with popover; never a banner |
| **B** — instead of content | Nothing to show: data not read, PR not loaded, empty list, agent not running | Stays in place of the content, with `Retry` where a retry makes sense |
| **F** — next to a field | Validation of input (name, branch, path) | Under the field until it is fixed |

Classified as B, not S: the sign-in card in the chat log, browser page errors, `Metro is not running` in the simulator, editor file-state rows, the merge panel with conflicts, `gh` state in the PR panel, corrupt data files, "notifications off" in Settings, unanswered foreman, relay summary problems. App-level states (notifications denied, GitHub CLI state, missing fonts) are toasts, because a chip lives only in a task window.

<a id="toasts"></a>
## Toasts (class T)

`renderer/ui/Toast.tsx`: `notify(kind, text, {action, bold, key, log})`, `toastError`, `toastWarning`, `showToast`, `resolveToast`, `dismissToast`.

| Aspect | Rule |
| --- | --- |
| Place | Centered over the task's main area, zero layout pixels; 10 px above the highest `[data-toast-avoid]` of its column (composer dock with queue and status rows, review footer, quick task strip, the terminal of a CLI task); without them 30 px from the bottom. Outside a task (board, empty screen) the host in `App` `<main>` shows toasts at the bottom center, only while no task is visible. |
| Look | Height ≥ 36, padding `6 6 6 12`, radius 9, `--card`, `1px --sep` ring, `--shadow`; glyph 14; text 12/16, up to two lines, max width 540; file names bold (`bold`). |
| Kinds | success (`check-pass`, `--green`), info (`--accent`), warning (`--amber`), error (`--red`); glyphs `toast-success/info/warning/error`. Text is always `--fg`. Success/info `role="status"`, warning/error `role="alert"`; one region labelled `Notifications`. |
| Close | Shared `ui/PopupClose` (Esc) on every toast. Esc closes the focused toast and returns focus to where it was. A toast never takes focus. |
| Action | At most one (`Retry`, `Open`, …), shared `Button` size S, text `--accent-text` (lighter accent for contrast on dark). The toast leaves after its action runs. |
| Stack | Store keeps the last 20; region shows the newest 3 (newest at the bottom); older ones under a pill `{n} more`, which expands to 5 and then reads `Show less` and folds back. Same `key` (default kind + text) → one toast with `×N` (accessible name via `timesCount`, four Ukrainian forms), timer restarted. |
| Time | success 4 s, info 6 s, warning 8 s, error 10 s. Paused while hovered or focused, while the window is unfocused or hidden, and under a modal (`dialog:modal`). No visible timer. |
| Motion | Enters with `--motion-enter`; none under `prefers-reduced-motion`. |

Rules:

- Text names the action and the object (`Could not open {file}.`), never a generic "The request failed." and never raw `err.message`. Without a known path the text says "file", never a hash.
- There is no shared error line in the task window or under the diff tabs: each failure is its own toast.
- Background reads with auto-retry (locks, repos, preparation log, history) warn once per failure series and `resolveToast` the warning when the read succeeds again or the view that read it is gone.
- A modal dialog that needs a confirmation uses `ui/ConfirmDialog` (Esc in the header, red solid action, initial focus on `Cancel`), never a hand-made modal.
- A refusal by the person is not a failure: e.g. `add_folder` not applied shows `Did not add the folder` with the reason on a second line.
- Every toast is also written to the [notification center](#notification-center) unless `log: false` (a CI run that main records itself).

App-level toasts: notifications denied (above); GitHub (`ForgeToast`): `Install GitHub CLI (gh) to create pull requests.` / `Sign in with gh auth login to use GitHub.` / `GitHub status could not be read.` with `Retry`, resolved when the state is `ready` again; `Unavailable fonts: {fonts}. Using the system font.` once per set of missing fonts.

<a id="notice-chips"></a>
## Notice chips (class S)

`renderer/ui/NoticeChip.tsx` is the one component for every ongoing state. Props: `placement` (`composer` | `repo` | `shelf`), glyph, chip text, accessible name, popover title, `facts` (keys of "what is new"), footer lines for auto-open and click, popover body. Shared popover sections (intro, repo rows, counter) live in the same module.

- **Look.** Amber only (no other tone): height 24, radius 12 (S class of the control scale), `--amber-soft`, hover `--amber-hover`, pressed `--amber-press`, text `--amber-text`. Popover text 12/17, separators `--sep`.
- **Place.** Right side of the composer's environment footer, as a separate button next to the environment button (the footer's hover comes only from the environment button). In a CLI task (no composer) the chips stand on the right of the shelf above the terminal and the popover opens under them. States about a repo may also appear in the repo heading of the Changes panel. Several states → several chips in a row, each with its own popover.
- **Popover.** Portalled with fixed position (Changes rows clip, the composer island is a containing block). Header with `PopupClose` (Esc); Esc and a click outside close it; a popover opened by click returns focus to the chip. Long popovers scroll; long paths are truncated from the left.
- **Auto-open once per fact.** A `composer`/`shelf` chip whose fact key has not been shown opens its popover by itself without taking focus from the input; the footer then has `Got it` (`Button` M soft) and the auto note. Shown keys are kept in window memory until the app restarts (a restart reminds once more). `repo` chips never auto-open.
- **End.** When the state ends, chips and popover disappear.

| State | Chip (composer / repo heading) | Fact key | Popover |
| --- | --- | --- | --- |
| Mixed changes (two tasks write one repo without isolation) | `{repo} · mixed changes`, `{N} repos · mixed changes` / `{N} tasks` | task + repo + sorted owner set | `Mixed changes`; intro "Tasks share one repo without isolation. Each diff includes all tasks’ changes."; per repo: name, task count, rows of tasks — the current one marked `this task`, others are buttons that open the task (whole-row hover) |
| Read-only repo changed (`scope.violation`) | `{repo} · changed`, `{N} repos · changed` / — | task + repo + sorted file list of the latest warning | per repo the paths (up to 6, then `+N`), files new since last time marked `new` |
| Unavailable repos (`available: false`) | `{repo} · unavailable`, `{N} repos · unavailable` / `unavailable` | task + sorted unavailable repos | explanation and the repo list |
| Subscription limit (`rateLimited`) | `Limit · {time}` (`—` when unknown) / — | task + reset time | `Subscription limit reached.`, time to reset, queued messages resume after the reset |
| Agent sign-in expired (`failure: 'auth'`) | `{agent} · sign-in needed` / — | none — never auto-opens | the same sign-in card as in the log (`AuthCard embedded`, same `useAgentLogin`) with `Sign in to {agent}…` and `Try again` |

- Sign-in is first shown as the card in the log in place of the failed reply; the chip stays until sign-in succeeds so the action is reachable after the card scrolls away.
- Counts use `taskCount` with four Ukrainian plural forms.
- Code: `renderer/ContentionChip.tsx` (`contentionKey`), `renderer/TaskNotices.tsx` (`ReadOnlyChip`, `UnavailableChip`, `RateLimitChip`, `AuthChip`; keys `readOnlyKey`, `unavailableKey`, `rateLimitKey`). `TaskView` passes repo chips to `Conversation` → `ComposerEnvironment notices` and to `CliAttachments notices`; `Conversation` adds limit and sign-in.

<a id="repo-contention"></a>
### Repo contention

Contention arises when a task is launched with "Work despite the lock" ([Locks](tasks.md)). Diff attribution is genuinely imprecise while it lasts ([Diff](diff-and-review.md)), so the warning is permanent but small — a chip, not a full-width banner. When a repo is merely held by another task with no mixed changes, the repo heading of the Changes panel shows an amber lock (weight 500) instead of a chip.

<a id="notification-center"></a>
## Notification center

One place that shows what happened while the person was not looking and who waits now. The center only remembers and offers actions; toasts, banners, sidebar attention, chips and the Dock badge work on their own.

<a id="center-entry"></a>
### Entry and shortcut

- Bell (`bell` glyph, `IconButton` with a dot) at the foot of the section rail ([Sidebar](sidebar.md#rail-foot)); its popover opens beside the rail. Dot: amber when something waits (`Needs you`), accent when there is unread history, none otherwise. Name and hint `Notifications · ⇧⌘N`, with the state appended (`Notifications · Needs you` / `· Unread`). Open popover = pressed state.
- Shortcut `CmdOrCtrl+Shift+N`, menu item `Navigate ▸ Notifications` next to `Next agent awaiting input`; pressing again closes.

<a id="center-popover"></a>
### Popover

- Shared `ui/Popover`, 380 px wide, header size S: title `Notifications`, tabs `All · Unread`, `PopupClose`. Footer: `Mark all as read`, `Clear`, gear → `Notification settings`.
- **Needs you · N** section first (amber background): live requests built from pending inputs, newest first — question, permission, foreman plan, task proposal, waiting worker, and a schedule's missed slots with «If missed: Ask». Actions from the row: `Answer` / `Open`, `Allow` / `Deny` (same one-time options and pending check as the banner), `Run once` / `Skip` for a schedule (its `Open` goes to the Schedules section). No ×: the row leaves when the request is resolved.
- **History** below, grouped `Today`, `Yesterday`, `Earlier` by local day.
- **Row**: two 16 px lines like a system banner — line 1 the task title (or a run title like `CI #413 failed`), line 2 the same body as the banner or toast; state glyph on the left, time and unread dot on the right (`just now`, `{n} m`, `{n} h`, then clock, then date). Unread rows are weight 600. Whole-row hover hides the time and shows the action and `Dismiss` (S 24).
- **Read**: opening the task, clicking the row, clicking the system banner, `Mark all as read`. Events of the task visible in the focused window are written already read. `Clear` empties history; live requests stay.
- **Keyboard**: ⇧⌘N opens with focus on the first row; ↑↓ move, ↩ opens the task or run, ⌫/Delete dismisses a history row (not a live one), Esc closes and returns focus to the bell.

<a id="center-history"></a>
### What enters history

Everything the app says to the person:

- every system-notification decision (`notificationDecision`), whatever «When» and the OS permission are: turn ended, background command, session failure, limit, read-only repo, every needs-you request, browser page notifications;
- CI runs that finished and deploys (written by main; the matching toast uses `log: false`);
- every toast of any kind, with its action label (the action itself only works while the live toast exists); the same toast within a minute for the same task coalesces into one row `×N`;
- schedule events and Slack refusals (`Slack did not take a message: <code>`).

Entry kinds (`NoticeEntryKind`): `turn-ended`, `background`, `failed`, `rate-limited`, `scope-violation`, `ci-pass`, `ci-fail`, `ci-cancelled`, `question`, `permission`, `plan`, `proposal`, `worker`, `page`, `error`, `warning`, `info`, `success`. Targets: `{kind: 'task', task}`, `{kind: 'run', watch}` or none.

<a id="center-storage"></a>
### Storage and IPC

- `~/.brigadir/notifications.jsonl`, one `NoticeEntry` per line (`id`, `at`, `kind`, `title`, `body`, `target`, `action`, `count`, `read`); the last 200 entries no older than 7 days. Small enough to rewrite atomically 300 ms after the last change; quit flushes. A torn last line is skipped.
- Live requests are never written: they are rebuilt from `pendingInputs`, like the Dock badge.
- IPC: `notices:read`, `notices:changed`, `notices:toast` (renderer toasts to main), `notices:action` (`read`, `read-all`, `dismiss`, `clear`, `open`, `answer`).

<a id="slack"></a>
## Slack module

Posts Brigadir's events to Slack through the person's own CI bot (the same bot a team's CI watcher uses), without any Brigadir server; with `@ mentions in Slack` on, the same bot also takes tasks, state questions and notes from mentions, sends thread replies to the agent and answers Needs you from buttons. Module `slack` in Settings ▸ Modules (with a settings popup, see [Modules](settings-modules-and-onboarding.md#module-settings-popup)) and in the intro's Modules step; **off by default**, highlights no part of the window. Off — no ⚙, no connection, nothing reaches Slack; the sealed token stays.

<a id="slack-bot"></a>
### Bot and token

- Slack app created by the person at api.slack.com with bot scope `chat:write`, installed to the workspace; token `xoxb-…`.
- Lookup order, in main only: sealed `~/.brigadir/slack/token.json` (OS key store via `KeyVault`) → `SLACK_CI_BOT_TOKEN` env → `SLACK_CI_BOT_TOKEN` in a project's `.env.local`, then `.env`. The token never reaches the renderer, a log or an agent; agents post through [`slack_post`](#slack-agent-post).
- `Connect` / `Replace token…` seal a token only after `auth.test` accepts it; `Move to Keychain` seals a token found in env or a file (the file is not changed); `Disconnect` deletes the sealed token (an env/file token still connects).
- `Your member ID` (`U…`/`W…`, validated: `A member ID starts with U.`) — the DM target.
- Section **Bot** states (`SlackState`): `off` (no token anywhere) · `checking` · `on` (bot and team from `auth.test`) · `token` (`invalid_auth`, `not_authed`, `token_revoked`, `token_expired`, `account_inactive`, `missing_scope` → `The bot token is no longer valid`, `Replace token…`; queue dropped) · `down` (`Slack is unreachable`, `Retrying in 30 s · {count} waiting`, `Retry now`). Source shown as `Token in Keychain` / `From SLACK_CI_BOT_TOKEN` / the file name.
- IPC: `slack:read`, `slack:changed`, `slack:retry`, `slack:connect`, `slack:keychain`, `slack:disconnect`.

<a id="slack-events"></a>
### Events and routing

`settings.json` key `slack`: `{memberId, events: {ci, prMerged, needsYou, taskDone, taskCompleted, scheduleFailed}, projects: {<projectId>: {channel, mention}}}`; every event is on by default except `taskDone`; missing event keys take defaults.

| Event (UI) | Trigger |
| --- | --- |
| `CI finished` | a run watched with the CI bell finished: passed / failed / cancelled; repo from the run link, environment from the deploy or branch, error from the first annotation |
| `PR merged` | a merge done in the app (`prs:merge`) |
| `Needs you` | a needs-you entry of the center (permission, question, plan, proposal, worker), with a short reason |
| `Turn ended` (`taskDone`, off by default) | a turn ended — at most once per task in 10 min, and not while the person is looking at that task in the app; `🏁 *Turn ended*` |
| `Task completed` (`taskCompleted`) | the task moved to Completed (`Boards.move`, stop and complete); a quiet scheduled run that closes itself posts nothing; `✅ *Task completed*` |
| `Scheduled run failed` | a run that could not start, or a run task that failed |

- **Where**: per project a channel (empty → DM to the member ID) and a mention group (`S…` or `<!subteam^S…>`), the mention only in the first message of a thread.
- **One task — one thread**: the first event posts a message, the rest reply in its thread (`slack/threads.json`, last 500); a changed channel starts a new thread. `PR merged` in a project channel is also broadcast to the channel (`reply_broadcast`).
- **Format** (mrkdwn text, no code or diff; blocks only to carry buttons): `<emoji> *<event>* — <repo> (<branch>)` (a task without its own branch: just `<repo>`); `🌐 Environment` (staging → Staging, main/master → Production, else the branch); `📋 Task` — the Brigadir task title; `⏱️ Duration`; `🔗 View run` and 1–3 error lines in a code block only when the run did not pass. PR merged adds `#N on GitHub`; Needs you adds `💬 <reason> · answer in Brigadir` when Slack cannot answer it (see [Thread replies and answers](#slack-replies)).
- Web API via `fetch` (`chat.postMessage`, 15 s timeout, links not unfurled). Messages carry only GitHub links: the app registers no `brigadir://` scheme.
- **Offline**: messages wait in memory, at most 50, are not resent after a restart; a message refused for a non-token reason (e.g. the bot is not in the channel) is dropped and recorded in the center.
- Works only while the app runs (here or on a remote-access host); mentions and replies sent while it is closed are lost. OS notifications are unaffected.

<a id="slack-mentions"></a>
### Mentions and tasks from Slack

- **Setup** (section `@ mentions in Slack` of the popup; steps shown until listening): Socket Mode on with an App-Level Token `xapp-…` (`connections:write`); bot scopes `app_mentions:read`, `channels:history`, `groups:history`, `im:history`; bot events `app_mention`, `message.channels`, `message.groups`, `message.im`; Interactivity on; Reinstall to Workspace.
- **Connection**: Socket Mode over an outgoing WebSocket (`apps.connections.open`), no server; every envelope is acked at once, a repeated envelope is handled once; `disconnect` or a closed socket reconnects with backoff up to 60 s. Runs only while the module, the `Create tasks from Slack` switch, the bot token and the app token are all there. The app token is sealed in `~/.brigadir/slack/app-token.json` only after `apps.connections.open` accepts it, and is never read back.
- Row `@ mentions` states (`SlackListen`): `off` · `no-token` (`No app-level token`) · `connecting` · `on` (`Listening for mentions`) · `token` (`Slack refused the app-level token · <code>`; no retry until replaced) · `down` (`Slack is unreachable`); without a bot token — `Needs the bot token above.` Row `App-level token`: field + `Connect`, or `Token in Keychain` + `Disconnect`.
- **Direct messages**: Slack sends no `app_mention` in a DM, so a message to the bot in a DM that is not a reply in a task's thread is handled as a mention.
- **Who**: `These people · Anyone in the channel`; the list holds member IDs (`Add person`, `Remove`, ≤ 200); the person's own member ID is always allowed (`Your member ID is always on the list.`). Anyone else gets an ephemeral refusal: `Only the people in Brigadir’s Slack settings can create tasks.`
<a id="slack-agent"></a>
- **The bot only carries messages; an agent decides.** A mention (or a message in the bot's DM, or a plain reply in a thread whose agent session still waits) goes as is to the Slack agent: there is no classifier, no keyword rules and no «Which project?» question. The agent is a session of `Slack: code questions` of Customize per action (else the Default agent) in a project's main tree (`QuickAsks` mode `aboutCode`) with every project's folder added. It starts in the project of an `in <project>: …` prefix (name or id), else the channel's (`Where`), else a project named in the text as a whole word, else the thread task's, else the first project; it sees every project either way and works out from the message and the thread which one is meant (`по админке` → admin).
- **What the agent gets**: the message, the thread above it (untrusted, ≤ 4000 characters), every project (name — folder), today's date and time, and Brigadir's tasks — the thread's task first, then the newest of every project (≤ 40): id, title, project, state, column, branch, plan N of M and step (15 newest active), PR, CI, last update. The prompt is in English; the answer is in the request's language (Cyrillic → Ukrainian, otherwise English), Slack mrkdwn, at most 12 lines of words, no code (fenced code becomes `_(code omitted)_`, `@channel`/`@here` are stripped).
- **How it answers**: from the tasks when they tell enough; otherwise it looks it up itself — reads the code and runs [commands that read](#slack-side-commands) (`git log`, `gh pr list --state merged`, `gh run list`, `gh api` reads of deployments). It never tells the person to check what it can check, and asks back in one line only when the request itself is unclear.
- **First «going to look», then the answer**: before it looks something up or acts, the agent writes one line `ACK: <what it is about to do>` (`Пішов дивитись, що зарелізили сьогодні`). The bot posts it at once as `⏳ <text>`, then the answer as its own message when the turn ends. A quick answer from the tasks has no ACK line.
- **Actions**: what only Brigadir can do, the agent asks for with one line each at the end of its answer, `ACTION <name> <json>`; the bot runs them in order and says so in the thread, and drops a line that does not parse:
  - `send_to_task {"task", "text"}` — a change to work a task already covers goes to that task's agent, as a [thread reply](#slack-replies) does; the bot replies `📨 *Passed to the agent of* «<task>»` or the reply refusal (gone, archived, waiting for approval, terminal, busy);
  - `create_task {"projects", "title", "prompt"}` — new work: the task in the first project (by name, id or folder; unknown → `🤔 *No project <name> in Brigadir*` with the list), the other projects join it as folders from outside ([Folders mid-task](projects-and-board.md#folders-mid-task)) and the reply names them all (`admin + choice`); the title (≤ 80) and a prompt complete on its own, else the message;
  - `ask_task {"task", "question"}` — why something was done or what was decided: a [quick question](composer-steering-queue-and-ghost.md#quick-question) to that task's agent in its own side session, forked from the task's session; `⏳ Asking the agent of «…»…`, then its answer;
  - `note {"kind": "thread" | "summary"}` — a [note](#slack-note) of the thread;
  - `watch {"kinds": ["ci", "merged", "done"]}` and `unwatch {}` — [watch and post here](#slack-watch).
- **One session per thread**: it lives 10 minutes after its last answer; a follow-up in the thread, a mention or a plain reply, continues the same conversation («перевір» included). Each answer has 5 minutes; with nothing said the bot replies `🤷 The agent did not answer — ask in Brigadir.`
- **Task**: a task made from Slack is created through the `create_task` path ([Agent-created tasks](tasks.md#agent-created-tasks)), always the chat transport, with its own worktree and auto-named branch; the thread above the message is attached as a text attachment `Slack thread` (≤ 8 KB: the topic plus the latest messages). `New task: Start` (default) starts it at once and replies `🆕 *Task created*`; `Ask in Brigadir` leaves it in the backlog with a center entry `New task from Slack` and replies `⏳ *Waiting for approval in Brigadir*`. The thread becomes the task's thread for its later events. The task keeps `slackThread` (`channel`, `ts`, `permalink`); its header and card link `From Slack` opens the thread.
- **Agent for tasks** (popup section `@ mentions in Slack`): provider · model · effort for tasks created from Slack, default `Same as Default agent`.

<a id="slack-side-commands"></a>
- **What a Slack side agent may run** (the Slack agent and a task's agent asked from Slack): nobody is at the window to answer its permissions, so main answers them. Reads, searches and web fetches are allowed; edits, deletions and moves of files, and any other tool (MCP tools included), are declined. A command is allowed unless it changes state: git `push`, `commit`, `merge`, `rebase`, `reset`, `checkout`, `switch`, `restore`, `clean`, `stash`, `rm`, `mv`, `cherry-pick`, `revert`, `pull`, `am`, `apply`, `worktree`, `branch` or `tag` that delete, rename or create; `gh` subcommands that create, edit, merge, close, comment, review, run, rerun, cancel, delete, upload or set, and `gh api` with a method other than `GET` or with fields; `rm`, `mv`, `cp`, `mkdir`, `touch`, `chmod`, `chown`, `ln`, `dd`, in-place `sed`/`perl`, a redirect into a file; package installs and publishes; `curl`/`wget` that send data or save a file; `sudo`, `kill`, `docker`, `kubectl`. The prompt says the same, so the agent does not try. Push, merge and deploys stay in the app.

<a id="slack-watch"></a>
- **Watch and post here** (the `watch` action): a request like "tell me when CI of PR #N passes", "…when the PR is merged" or "…when the task finishes" creates a watch: `ci` — the CI bell on the PR's newest run; `pr-merged` — GitHub is polled once a minute; `task-done` — the task reaches Done or Completed. The bot replies `👀 Watching…` in the request's language; the result is posted in the same thread, mentioning the person who asked. Watches live in `slack/watches.json` (≤ 50, 7 days); `unwatch` cancels; the same allow-list applies. A PR is found only when it is linked to a Brigadir task; with several workflows the newest run counts.

<a id="slack-note"></a>
- **Note** (the `note` action; module Notes on, else ephemeral `Notes are off in Brigadir.`): `Thread` — the thread verbatim (author · time, text, files as links); `Summary` — one Helper agent request, English, sections `Decision` · `Open questions` · `Next steps`; with no helper agent the bot replies `⛔ *Could not do it* — the helper agent is off in Brigadir`. Title from the thread's topic or the mention's first line; project — the channel's project or `No project`; under the `# <title>` heading, a plain line `From Slack: [#<channel> thread](<permalink>)`. Reply `📝 *Note saved* — <title>`; center entry `Note from Slack`.
- `settings.json` `slack.mentions`: `{on: false, who: 'people' | 'anyone', people: [], start: 'start' | 'ask'}`. IPC: `slack:app-connect`, `slack:app-disconnect`; `SlackState` carries `listen` and `appToken` (a flag, never the token).

<a id="slack-replies"></a>
### Thread replies and answers in Slack

- **Reply → agent**: a person's new message in a task's thread (also a file share or `Also send to #channel`; not edits, bots or messages that mention the bot) from an allowed person goes to the task's agent as a steering prompt ([Steering](composer-steering-queue-and-ghost.md#steering)): into the running turn, else a new turn; a stopped agent starts first through the launch queue. The agent reads `A reply from @<member ID> in this task's Slack thread:` followed by the text. The bot replies `✅ *Sent to the agent*`.
- Refusals (ephemeral): not allowed — `Only the people in Brigadir’s Slack settings can talk to the agent here.`; `The task is gone.`; `The task is in the archive in Brigadir.`; a backlog task — `The task waits for approval in Brigadir.`; a CLI task — `This task runs in a terminal. Answer in Brigadir.`; no free agent slot — `The agent could not start now. Try again later.`
- **Needs you buttons**: a permission gets `Allow` · `Deny` (the one-time options the OS notification offers) under `🔐 <reason>: <tool>`; a question with 1–5 single choices gets one button per choice under `❓ <question>`. Multiple-choice or free-text questions, plans, proposals and workers keep `answer in Brigadir`.
- **Schedule «Ask»**: missed runs post `🙋 *Needs you* — <project>`, `🗓️ Schedule`, `💬 N runs missed · run once now or skip?` with `Run now` · `Skip`, under the `Needs you` event.
- **A click** answers the same way as the OS notification and the center: the request is checked live and answered once. Answered → the buttons give way to `✅ Allowed by @…` / `🚫 Denied by @…` / `✅ <choice> — chosen by @…` / `▶️ Run now by @…` / `⏭️ Skipped by @…`; already answered in Brigadir → the buttons go and the bot replies `🙅 *Answered in Brigadir already*`; gone → `The task is gone.` / `The schedule is gone.` The button value carries the request, so a click works after a restart. Same allow-list as mentions. Push and merge stay in the app.

<a id="slack-agent-post"></a>
### Agents post as the bot

- MCP tool `slack_post` (module Slack; foreman and solo agents): `text` (mrkdwn, ≤ 12 000 characters), `channel` (`#name`, a name, or an ID `C…`/`G…`/`D…`; default: this task's Slack thread), `thread` (a message `ts` or permalink to answer in; with no channel it is the task's thread). The message goes from Brigadir's bot through main: the agent never gets the token. Its description tells the agent to use it when the person asks for a message from Brigadir or the bot, and never to read a Slack token from env files.
- **Bot name**: `<bot>` below is the name Slack shows for the bot — its display or real name from `users.info` (`users:read`), else the username of `auth.test`.
- **Consent**: every call asks with a permission card `Post to Slack as <bot> · <channel>` showing the text, `Allow` · `Deny`; Deny → `posted: false` with the reason.
- **Channel**: an ID is used as is; a name goes through the learned name → ID map, then `conversations.list` (public and private channels the bot can see), else Slack gets the name.
- **Answer**: `posted: true` with `channel`, `ts` and `permalink`; or `posted: false` with the reason. `channel_not_found` / `not_in_channel` → `The bot @<bot> is not in <channel>. Ask the person to run /invite @<bot> in that channel, then call slack_post again.`; module off → `Slack is off in Settings.`; no bot token → `Brigadir has no Slack bot token.`
- A message the bot cannot post is not queued: the agent gets the reason now.

<a id="notes"></a>
## Notes module

A note is a plain Markdown file with an optional project and one persistent agent chat. Module `notes`, on by default, no own settings. Off: removes the rail section, menu items and the note chat; files in `~/.brigadir/notes/` stay and return when it is switched on.

<a id="notes-entry"></a>
### Entry, list and screen

- **Notes** section in the section rail, `View ▸ Notes` `Ctrl+Command+3` (Windows/Linux `Alt+3`); see [Sidebar](sidebar.md#rail-sections). `File ▸ New note` has no shortcut.
- The section's sidebar: filter field (`Filter notes`, searches titles and text) and `New note`, then notes grouped like tasks — `No project` first, then each project with notes. Row: note glyph, title (`Untitled note` when empty), second line "edited … · N tasks"; whole-row hover and selection, `…` menu; ↑↓/↩.
- The Notes screen in the main area: title bar `Notes`, then the open note and its chat (`Select a note` / `No notes yet` when empty). There is no Notes tab on the project screen.

<a id="note-file"></a>
### Note file and header

- Files (`NotesStore`, writes serialized): `notes/<id>.md` (text), `notes/<id>.json` (`{schemaVersion: 1, project: <id>|null, createdAt, tasks: [{taskId, projectId}]}`), `notes/<id>.chat.jsonl` (chat), `notes/<id>/` (chat files). Id `note-<base36>` never changes; the title is the first Markdown heading, else the first non-empty line, plain, ≤ 120 chars. Max 512 KiB.
- Editor: the shared `CodeEditor` with `Code | Side by side | Preview` ([Editor](editor.md#markdown-views)); saves 500 ms after an edit, header shows `Saving…` → `Saved`; failure → `Could not save the note. Changes are kept.` with `Retry`.
- Header (row S 24): title, project picker (`No project` or any project, changeable any time), view switch, `Create task`, chat toggle, `…`. With the chat open, `Create task` shrinks to its glyph and `Saved` hides.
- Delete: `ui/ConfirmDialog` `Delete the note?` — "The note and its chat will be deleted. Tasks from it stay." Tasks lose the link.
- IPC: `notes:list`, `notes:read`, `notes:write`, `notes:create`, `notes:delete`, `notes:set-project`, `notes:link-task`, `notes:changed`, `notes:menu`, `notes:project-menu`, `notes:task-project-menu`, `notes:attach`, `notes:chat-*`.

<a id="note-markdown"></a>
### Writing Markdown in a note

Note-only helpers (`note-markdown.ts`); the file stays ordinary GitHub-style Markdown.

- Highlight: headings `--syntaxKeyword` bold, list markers `--syntaxKeyword`, inline code `--syntaxString`, bold/italic, links `--syntaxFunction`, quotes `--syntaxComment`, fenced code lines on `--tint`.
- Checkbox `[ ]`/`[x]` and radio `( )`/`(x)` (also `[]`, `()`) at the start of a list item or a bare line are drawn as 14 px controls (square r4 / circle, checked `--accent`); click or ⌘↩ on the line toggles. Radios: adjacent radio lines of the same indent form a group — choosing one clears the rest. Done items are `--fg3` struck through.
- Enter continues the list with the same marker (`- ` → `- `, `9. ` → `10. `, `[x]` → `[ ]`, `(x)` → `( )`); Enter on an empty item ends the list. Tab / ⇧Tab nest and outdent.
- Preview: line breaks as typed (`breaks`); leading marks render as checkbox/radio and toggle the line in the text.

<a id="note-chat"></a>
### Note chat

- One chat per note, kept across restarts and split by days; `Layout ▸ Chat` (⌘1) hides and shows it, as in a task. Panel header `Chat · about this note`, `Hide chat`; composer placeholder `Ask about this note`; the capsule chooses the model only (no effort), like the quick question. The input grows to 8 lines; the draft belongs to the note.
- `main/note-chats.ts`: a separate ACP session per note; `cwd` = the project's main tree, or the notes folder without a project; the notes folder is an `additionalDirectories` entry. The session resumes after restart from `session.started` in the journal.
- The current note text goes with every message (English wrapper prompt, rule: prompts to agents in English); above the input a chip `<file>.md · the note, always`, or amber `changed since the last message` after the person edited it (logged as `You edited the note +N −M`).
- **Permissions**: the agent may write only the note's file (with its real path); any other write and any command are rejected. With a project it reads the project's files; without one it sees only the note.
- **Agent edits**: the agent uses its own edit tool; after the answer main compares the text and writes an `edit` row with text before and after. The card `Edited the note` shows the diff with `Show in note` and `Undo`; Undo is disabled once the person changed those lines (`You edited the note after the answer. Undo is off.`).
- Lines referenced as `L5` / `L5-7` render as buttons: a click scrolls the editor and flashes the lines (Preview switches to Side by side first).
- Empty chat: glyph and title only. The agent can propose a task with `create_task` ([Agent-created tasks](tasks.md#agent-created-tasks)).
- Journal rows (`NoteChatEntry`): `prompt` (text + note snapshot + choice), `event` (normalized `AgentEvent`), `edit`, `undo`, `person-edit`, `done`, `failed`. Message limit 20 000 chars.

<a id="note-tasks"></a>
### Tasks from a note

- `Create task` in the header takes the whole note; a selection shows the shared selection panel with `Create task` and `To composer` ([Selection panel](diff-and-review.md#selection-panel)). `To composer` opens the note's chat and puts the selected lines as a Markdown quote (`> …`) before the typed text, focus at the end.
- The New task sheet gets the `note` prop: title from the first line, text = the selection verbatim or the whole note, the whole note attached as removable context, banner `From the note <title> · <lines>`. A note without a project first asks for the task's project with a native project menu.
- Link back: under the selection (or at the end) the note gets a plain line `→ [<task title>](brigadir://task/<projectId>/<taskId>)`; editor and Preview draw it as a chip with the task's live state (`Backlog`, `Working`, `Needs you`, `Turn completed`, `Completed`, `Task deleted`); a click opens the task. The task shows `From the note <title>` in its header and card; a click opens the note.

<a id="schedules"></a>
## Scheduled tasks

A schedule is a project object that starts tasks: a launch **blank** plus a **rule** in a time zone. Every run is a new task through the same creation path and launch queue as the sheet; there is no "scheduled" task status. Module `schedules`, on by default: off removes the rail section, the sheet's `When` group and `Repeat…`, and stops the timer; files stay.

<a id="schedule-model"></a>
### Model and files

`~/.brigadir/projects/<projectId>/schedules/<id>/schedule.json` — `{schemaVersion: 1, schedule}` written with `atomicJson`; beside it `runs.jsonl`.

| Field | Meaning |
| --- | --- |
| `id`, `projectId`, `name` (≤ 120), `createdAt`, `paused` | identity and state |
| `timeZone` | IANA zone, default the computer's |
| `rule` | `once {at}` · `hourly {minute}` · `interval {hours 1–12, between?: {from, to}}` · `weekly {days 1–7 (Mon=1), times HH:MM ≤ 12}` (daily = 7 days, weekdays = 1–5) · `cron {expr}` (5 fields, ≤ 120 chars) |
| `missed` | `catch-up` (default) · `skip` · `ask` |
| `inTasks` | `needs-you` (default) · `always` |
| `task` | blank: `prompt`, `provider`, `transport`, `launch?`, `crew?`, `options?` (model and options) |
| `checkedUntil` | cursor: slots up to this instant are handled |
| `lastRun?` | last `ScheduleRun` |
| `pendingMissed?` | `{count, latest}` while «Ask» waits |

`runs.jsonl` lines: `{due, at, status, taskId?, reason?}`; `status` `started | skipped | missed | failed-to-start`; `reason` `previous-run-active | missed | asked-skip | start-failed | run-now`.

IPC: `schedules:list`, `schedules:create`, `schedules:edit`, `schedules:delete`, `schedules:pause`, `schedules:run-now`, `schedules:resolve-missed`, `schedules:runs`, `schedules:changed`.

<a id="schedule-runs"></a>
### Runs

- A run task is created from the blank with title `<schedule name> · <weekday time>` (≤ 80), its own auto-named branch (`branch: ''`), fresh context, and `scheduleRun: {scheduleId, due, quiet}`. A Foreman blank snapshots the crew template on every run. Sheet attachments, proposal context and folders do not carry into the blank.
- The run's header and board card show `Run of <name>`; the card tail has the `schedule` glyph. Schedules themselves are never board cards.
- Agent limit reached → the task waits as `queued` like any other.
- A previous run of the same schedule still `queued`, `preparing`, `working`, `needs-you` or `rate-limited` → the slot is `skipped` with `Previous run still active` (except `Run now`).
- **Quiet runs** (`inTasks: needs-you`): the task is not listed in Tasks or on the board until it needs the person — `needs-you`, `failed`, `interrupted`, a non-empty diff against its base, or a PR (`runNeedsPerson`). Then `quiet` is cleared for good and the task appears like any task. A quiet run that ends `done` with nothing to look at is moved to `completed` by main (the one case main sets `completed`), its clean worktree is removed and auto-archive follows. `Always` lists every run.
- The Tasks status filter gets `Quiet scheduled runs · N` to show quiet runs as pale rows (`No changes · only in Schedules`). History marks runs `In Tasks` / `Only here`.

<a id="schedule-timer"></a>
### Timer and missed slots

- Module `schedules` in main (`Scheduler`): one `setTimeout` to the nearest slot of all schedules (capped at 1 h, ≥ 1 s); a pass runs on start, on `powerMonitor` `resume` and `unlock-screen`, on any schedule change and when the module is switched on. Passes never overlap.
- The next time follows from the rule, the IANA zone and `checkedUntil`, never from the timer; DST follows the rule. The Mac is never woken; a closed app runs nothing. Keep-awake holds the Mac while a run works, as for any task ([Keep-awake](architecture-and-platform.md#keep-awake)).
- A slot is on time within 2 min; older slots are missed and follow `missed`:

| `If missed` | Behaviour |
| --- | --- |
| `Catch up` | one run for all missed slots if the latest is ≤ 24 h old; the rest recorded as missed |
| `Skip` | only recorded in history |
| `Ask` | a live `Needs you` row in the notification center with `Run once` · `Skip`; the schedule waits (`pendingMissed`) |

- Pause keeps the rule; resume starts from now, so a paused stretch is not "missed". `Run now` works while paused and does not move the cursor.

<a id="schedule-ui"></a>
### Schedules section and editor

- Rail section **Schedules**, `View ▸ Schedules` `Ctrl+Command+4` ([Sidebar](sidebar.md#rail-sections)). Sidebar: filter (`All · Active · Paused`, `Filter schedules`), `New schedule` next to it, row `All schedules · N`, project groups; a schedule row is a task row — state glyph, name, second line "rule · state", whole-row hover with `Run now · Pause · ⋯` on top.
- Row states (`scheduleState`): scheduled `schedule` (`in 25 min`), running `agent-run` (accent), ask `check-skipped` (amber, `Missed · needs your answer`), failed `agent-failed` (red, `Last run failed`), paused `pause` (fg3, name fg2), one-off waiting `clock`. Rail dot: red — last run failed, amber — a missed run waits for an answer, accent — a run is going; no counter.
- Main area, one schedule: header (glyph, name, rule; `Run now`, `Pause` / `Resume`, `Edit`, `⋯` with `Edit schedule…`, `Delete schedule…` — "Its tasks stay; the run history is deleted."), facts (state, project, agent, isolation), prompt, `Runs · N` grouped by day: glyph, time, summary; the whole row opens the task (`Open task`), a failed one has `Retry` (= Run now) on hover. `All schedules`: table Name · Repeat · Next run · Last run · On (switch = pause). Empty section: glyph, `No schedules`, `New schedule`.
- `Edit` opens a 320 px column with the editor; edits save 600 ms after the last change with a toast `Schedule saved` + `Undo` (back to the start of that series of edits).
- `ui/ScheduleEditor` — one editor for the column and the sheet popover: `Once | Repeat`. Once: `In 30 min · In 1 h · In 3 h · Tonight 22:00 · Tomorrow 09:00`, date and time. Repeat: `Every hour` (`At minute`), `Every few hours` (1–12, optional `Between`), `Daily`, `Weekdays`, `Weekly` (day buttons with `aria-pressed`, `--accent-soft` fill), `Cron` (hint `minute · hour · day · month · weekday`). `At` with `Add time` for several times a day; `Time zone` with search. Under the fields: a human description and the next three runs (`Next: {list}`). `If missed`, `In Tasks: When they need you · Always`. Errors in red under the field (`Choose at least one day.`, cron errors, `This time has passed.`); `Done` disabled while invalid. Rows M 28, Esc in the popover header.

<a id="schedule-entry-points"></a>
### Where a schedule is made

- New task sheet: group `When` first in the rail — `Now · Later · Repeat`; the rule field opens the editor in a popover; the main button becomes `Schedule`; caption `Each run starts a new task.` (Repeat) or `Starts once at this time.` (Later). Not offered when editing a task or relaying.
- Task menu `Repeat…` (after `Duplicate task…`) — a copy of the task in the sheet with `When = Repeat`.
- `File ▸ New schedule…` and `New schedule` in the section open the sheet with `When = Repeat`.
- Agent: `create_task` with `start: 'schedule'` and `schedule: {rule, timeZone, missed}`. The card `New task` shows the rule description and `Each run starts a new task.`, buttons `Decline` and `Schedule` (no sheet option); the schedule exists only after the click, and the card folds into `Schedule created` with `Open schedule`. The blank takes only prompt, agent, repos and isolation.
- The quick task has no schedule: `More options…` opens the sheet.

<a id="schedule-notices"></a>
### Notifications from schedules

| Event | Center entry |
| --- | --- |
| run started | info `Started a run` on the run task (written read for quiet schedules) |
| quiet run finished without changes | success `Run finished without changes` |
| run could not start | error row titled with the schedule: `The scheduled run could not start. <error>`; also Slack `Scheduled run failed` |
| slots missed | warning row with the missed count; with `Ask` — `Waiting for your answer: run once or skip.` plus the live `Needs you` row |

A run task that fails notifies like any task (`session.failed`).

<a id="later"></a>
## Later

- Slack buttons that go away as soon as a request is answered in the app; now they stay until someone clicks them.
- Answering plans, proposals and workers from Slack; they are answered only in Brigadir.
- Files attached to a thread reply reaching the agent; now only the reply's text is sent.
- `brigadir://` URL scheme registration, so Slack messages can carry `Open in Brigadir` and note links.
- Notion task reference in `📋 Task` once the task model has one.
- `schedule_*` MCP tools for agents.
- `Open at login` so schedules run without the app opened by hand.

<a id="non-goals"></a>
## Non-goals

- `UNNotificationSound` or `<audio>` in the renderer for sounds; bundled sounds.
- Raising the window on an event; modal alerts outside the app.
- Banners for ongoing states; a separate "×" on toasts.
- Waking the Mac (`pmset` needs root); a run per missed slot; a `scheduled` task status.
- Slack OAuth distribution (needs a server) and posting through a person-scoped Slack connector (no push for DMs to oneself).
- Notes inside project repos (they would end up in commits and agent worktrees); several chats or version history per note; a WYSIWYG note editor.
