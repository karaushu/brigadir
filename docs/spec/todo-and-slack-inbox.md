# Todo and the Slack inbox

Two sections of the rail for the person's own work outside tasks. **Todo** holds to-do lists, by project or without
one, in the spirit of notes. **Slack** shows where people mentioned the person in Slack, what each mention wants, and a
summary of each day and week; anything there goes to Todo with one button.

<a id="todo"></a>
## Todo

Module `todo` (`Todo` · `To-do lists, by project or without one.`), on by default, no own settings. Off: removes the
rail tile, the menu items, `Add to Todo` in the Slack section and the chat tools; files in `~/.brigadir/todo/` stay and
return when it is switched on.

<a id="todo-entry"></a>
### Entry, list and screen

- **Rail tile** `Todo` under `Brigadir`, glyph `todo` (a checkbox with a tick beside two lines), `⌃⌘6` · `Alt+6`,
  `View ▸ Todo` (`section-todo`); see [Sidebar](sidebar.md#rail-sections). No count pill.
- **Its list** (the shared list look): filter row `Filter to-dos` (list names and item text) with `New list` (`+`), then
  lists grouped like notes — `No project` first, then each project with lists, each group folding by its name. Row: the
  `todo` glyph, the list name (`Untitled list` when empty), second line `3 of 8 done` (`Empty` with no items, `All done`
  when every item is done). Context menu: `Rename…`, `Move to project…`, `Delete…` (`Delete the list?`, «The list and
  its items are deleted.»). ↑↓/↩.
- **Its screen** (the main area): the open list — header with the list's name (click to rename), the project chip and
  `…`; the add field `Add a to-do` on top (a new item goes to the top of the open items); the open items in the person's
  order; `Done · N` under them, folded, the most recently done first. `Select a list` / `No lists yet` · `New list` when none is open.

<a id="todo-item"></a>
### An item

- **Row**: a checkbox, the title, and — when the item has a description — a chevron right after the title. The title
  (with its chevron) folds and unfolds the description; the chevron turns 90° with the disclosure motion. A new item
  with a description starts unfolded; the fold state is kept per item.
- **Description**: optional Markdown under the title, indented to the title. Click (or `↩` on a selected item) edits the
  title and description in place; `Esc` or a click elsewhere saves; an empty title deletes a new item.
- **Source chip** for an item that came from Slack: the Slack glyph, `#channel · <person>` and the time of the message;
  a click opens the message in Slack (its permalink).
- **Done**: the checkbox strikes the title, the row moves to `Done · N` after 1 s (unchecking within that second keeps
  it in place). Done items keep their descriptions.
- **Context menu** (and `…` on hover): `Edit`, `Make a task` (the launch sheet with the title as the task title, the
  description as the prompt and the list's project; a list without a project asks which project, as a note does),
  `Move to list…` (to the top of that list), `Delete`.
- **Order and keys**: drag by the row (the handle appears on hover) or `⌥⌘↑` / `⌥⌘↓`; ↑↓ select, `Space` toggles done,
  `→` / `←` unfold and fold, `↩` edits, `⌫` deletes (undo with `⌘Z` while the list is open), `⌘N` focuses `Add a to-do`.
  These are `Edit` and `View` menu items while Todo is open ([rule 11](../../AGENTS.md)).

<a id="todo-file"></a>
### Files

`~/.brigadir/todo/<id>.json`, one per list ([rule 10](../../AGENTS.md)): `{schemaVersion: 1, list: {id, name, project:
<id>|null, createdAt, updatedAt, items: [{id, title, description, done, doneAt, open, createdAt, source}]}}`, `source`
being `null` or `{kind: "slack", permalink, channel, author, ts, mention}`. Id `todo-<base36>`. Writes are serialized
per list; a change from the Slack section or the chat while the list is open shows at once (`todo:changed`).

<a id="todo-chat-tools"></a>
### Brigadir chat tools

The [Brigadir chat](settings-modules-and-onboarding.md#brigadir-chat-tools) gets `todo_add {title, description?, project?,
list?}` (the list by name; a missing list in that project is made) and `todo_lists {project?}` (names, counts, open
items). `todo_add` leaves a card with the item and `Open list`.

<a id="slack-inbox"></a>
## Slack section

A rail section of the [Slack module](notifications-slack-notes-and-schedules.md#slack): the person's mentions in
Slack, each with what it wants from them, a summary of every day and a short one of every week, kept for a month and
then archived. It reads Slack as the person, so it needs the person's own token besides the bot's.

<a id="slack-inbox-source"></a>
### What it reads

- **User token** (`xoxp-…`) of the person's own Slack app (the one from the [Slack setup](settings-modules-and-onboarding.md#slack-setup)),
  with the user scopes `channels:history`, `groups:history`, `im:history`, `mpim:history`, `users:read`,
  `usergroups:read`, `search:read`. The app subscribes to the user events `message.channels`, `message.groups`,
  `message.im`, `message.mpim` over the same Socket Mode connection. The manifest the setup builds carries them; an app
  made before needs `Reinstall to Workspace`. The token is sealed like the bot's (`~/.brigadir/slack/user-token.json`,
  `KeyVault`) only after `auth.test` accepts it, and never reaches the renderer, a log or an agent; the user scopes its
  `x-oauth-scopes` lacks are named.
- **Your account**: section of the [Slack settings popup](notifications-slack-notes-and-schedules.md#slack-bot) —
  `User token` (field, `Connect`); connected: the person's name · team, `Disconnect`, `Replace token…`, the missing
  scopes or `Slack refused the token · <code>`; and the switch `Count @here and @channel` (`settings.json`
  `slack.countHere`, off). The Brigadir chat asks for the token with `secret_request {kind: "slackUserToken"}`.
  IPC: `slack:user-connect`, `slack:user-disconnect`; `SlackState.account` carries the state, never the token.
- **Socket Mode** runs while the module, the user token and the app-level token are there, also with `Create tasks from
  Slack` off; a mention of the bot is handled only with that switch on. A DM counts for the section only when Slack
  authorized the event for the person; the bot's own DM stays the bot's, and a DM of the person never reaches the bot.
- **A mention** is a message from someone else that has the person's member ID, one of the person's user groups
  (`usergroups.users.list`), any message in a DM or a group DM with them, or a reply in a thread the person wrote in.
  `@here` and `@channel` count only with `Count @here and @channel` on (off by default). The bot's own posts never count.
- **While the app was closed**: on start, `search.messages` with `<@member> after:<last seen day>` and `to:me` fills the
  gap, then events take over. `from:me` for the same days feeds `You did` in the day summary.
- **Answered**: the person wrote in the mention's thread (a DM: in that DM) after it, or marked it `Done`. A mention the
  agent found an ask in is `Waiting` until then; before the agent's verdict, a mention the person did not answer for
  24 h is `Waiting`. One with no ask (and `@here`) is `FYI` and needs no answer.

<a id="slack-inbox-entry"></a>
### Entry, list and screen

- **Rail tile** `Slack` under `Todo`, glyph `slack`, `⌃⌘7` · `Alt+7`, `View ▸ Slack` (`section-slack`). Amber count
  pill: mentions `Waiting`. Present while the Slack module is on.
- **Its list**: filter row `Filter mentions` with `Refresh`; group `Mentions` — the last 7 days, newest first: the
  author's avatar with a status badge on its corner (amber dot `Waiting`, green tick `Answered`, none for `FYI`), the
  author and `#channel` (`Direct message`), the summary line, the time; group `Days` — `Today`, `Yesterday`, then
  weekdays and dates, second line `5 mentions · 2 waiting`; group `Weeks` — `This week`, `Last week`, then `Nov 10–16`;
  group `In the archive` — one row per month older than 30 days, folded.
- **Its screen**: the open mention, day, week or archive month (its mentions, read-only). Opening the section shows
  `Today`. IPC: `slack-inbox:read`, `slack-inbox:changed`, `slack-inbox:opened`, `slack-inbox:refresh`,
  `slack-inbox:thread`, `slack-inbox:month`, `slack-inbox:done`, `slack-inbox:dismiss`, `slack-inbox:todo`,
  `slack-inbox:untodo`; with the module off they answer `Slack is off in Settings.`
- **No user token**: the screen shows the Slack glyph, `Connect your Slack account`, `Set up with Brigadir` (a new
  Brigadir chat with `Connect my Slack account for mentions`) and `Open Slack settings`.

<a id="slack-inbox-mention"></a>
### A mention

- Header: the author's avatar and name, `#channel` or `Direct message`, the time, the status chip; `Open in Slack`,
  `Done` (marks it answered without a reply) and `Add to Todo`.
- `What they want` — one or two lines from the agent, or `Nothing — for your information`; a date the message names is
  shown as `By Friday, Nov 21`.
- The thread: the messages around the mention (up to 20), the person's own in the accent bubble, the mention lit.
- **Suggestion**: for a mention with an ask, the agent proposes a to-do — `Suggested to-do`, its title, the target
  `b2c › Release 1.15` — with `Add to Todo` and `Dismiss`. A dismissed suggestion does not come back.

<a id="slack-inbox-day"></a>
### Day and week summaries

- **Day** (`Today`, `Tuesday, Nov 18`): `Asked of you` — each ask with the person's avatar and badge, the line, the
  channel and `Add to Todo`; `You did` — what the person wrote that day, grouped by thread (`Answered Olena in #b2c`,
  `Posted in #release`); `People` — a row of avatars, each with a badge: green tick — answered, amber dot — still
  waiting, the count of their mentions on hover; `Worth knowing` — 3–6 lines on decisions, releases, incidents and
  questions in the threads the person was in. Summaries are built when the day has a new mention and the section is open
  (a minute after it), on the first opening of the next day (every day since the last opening, at most a week back, that
  grew after its summary), and on `Refresh`.
- **Week** (`This week`, `Nov 10–16`): five to eight short lines, the counts (`32 mentions · 3 waiting`), the asks still
  waiting with `Add to Todo`. Built on the first opening of a new week (the week before) and on `Refresh`.
- A summary is written in the interface language. Its header says when it was made (`Made at 18:40`).

<a id="slack-inbox-agent"></a>
### The agent

- Customize per action `slackSummaries` — `Slack: summaries` (group `Slack`; inherits the Helper agent). One-shot calls
  with English prompts ([rule 12](../../AGENTS.md)): per mention — the thread in, `{ask, due, fyi, summary, todo: {title,
  description} | null}` out; per day — the day's mentions, asks and the person's own messages in, the four parts out;
  per week — the seven day summaries in.
- The message text goes to the agent's provider; it is kept only in `~/.brigadir/slack-inbox/`.
- The quota check of Helper calls applies; with no quota the list keeps working and the summary shows
  `Summary not made: the agent is out of quota.` with `Retry` (a call that gave nothing usable: `Could not make the
  summary.`). While one is made: `Making the summary…`. `Refresh` also calls again for mentions the agent missed.

<a id="slack-inbox-to-todo"></a>
### Add to Todo

- `Add to Todo` (on a mention, on an ask in a day or week summary, on a suggestion) makes a to-do from the agent's
  `todo` (else the summary line) with the message as its [source](#todo-item).
- **Where it goes**: the project whose Slack channel is the mention's channel, else a project the text names, else
  `No project`; in that project the list the agent picks by name from the project's lists (a list for the release or
  the area the message is about), else the project's most recently changed list, else a new list `Inbox`.
- The toast `Added to b2c › Release 1.15` has `Open` and `Undo`; the mention shows `In Todo` with the target.
- With the Todo module off, the button is not shown. The section reaches Todo only through what the Todo module gives it
  (add an item to a list by name, remove it for `Undo`, the lists with their projects and times); `Open` asks the Todo
  section to show the list.

<a id="slack-inbox-files"></a>
### Files and the archive

- `~/.brigadir/slack-inbox/`: `mentions.jsonl` (normalized mentions: ts, channel, author, text, thread, kind, whether and
  how it was answered, the agent's result, the suggestion, the to-do made, the messages around it; appended, a change
  appends the new state; rewritten whole when old states are most of it), `days/<yyyy-mm-dd>.json` (the person's own
  messages of the day and its summary), `weeks/<yyyy>-W<ww>.json`, `people.json` (names, 24 h; avatars are initials on
  the palette), `state.json` (the last event, the last searched and opened days, the threads the person wrote in, their
  user groups).
- **A month, then the archive**: mentions, days and weeks older than 30 days leave `Mentions`, `Days` and `Weeks` and go
  to `In the archive`, one row per month, read-only; they do not count in the pill. To-dos made from them stay.

<a id="later"></a>
## Later

- Due dates and reminders on to-dos; an archive of lists.
- Mentions from other sources (GitHub reviews, Linear).
