# Composer

The composer is the glass "island" at the bottom of a task's chat column: a Markdown text editor with inline mention pills and image thumbnails, an agent row (attach, context ring, agent capsule, Send/Stop) and a full-width environment footer that says where the agent writes. Everything the person adds (files, folders, images, editor selections, task summaries, agent templates, model references) stands in the text where it was placed and reaches the agent as ACP content blocks in the same order. Steering, the prompt queue, ghost suggestions and the quick question are described in [Steering, queue and ghost](composer-steering-queue-and-ghost.md).

<a id="island"></a>
## Island layout

| Part | Content |
| --- | --- |
| Text | CodeMirror editor shared with the New task sheet (`useMentionEditor`, `renderer/mention-editor.tsx`) |
| Agent row (`ComposerBar`) | `+` (Attach files) on the left; stretch; context ring, agent capsule, Send/Stop on the right |
| Environment footer (`ComposerEnvironment`) | Worktree or branch, `+N −M`, base, repo count, class S notice chips |
| Drop zone (`ComposerDropZone`) | Overlay shown only while a file is dragged over the island |

- One look, one component: `ui/ComposerIsland` (`ComposerIsland`, `ComposerText`, `ComposerBar`, `ComposerDropZone`) is used by the task chat and by the intro's sample window. The feature places it (margins, width); the look lives in `ui/`.
- Column: `--conversation-column-width` is 880 px. The island is `calc(100% - 24px)` wide, capped at the column width minus 24, centred, margins `8px 12px 12px`. Transcript and composer share the column width.
- An archived task's island is `inert` at 50 % opacity until restored.
- Attachments of a queued prompt and of a terminal (CLI) task do not use the island; see [queue deck](#queue-deck) and the [CLI context shelf](terminal-and-cli-agents.md).

<a id="glass-overlay"></a>
### Glass, overlay and focus

- The conversation log fills the whole column height. The island, the queue deck and the notices above them form an absolutely positioned dock pinned to the column bottom; the log scrolls under it.
- Island: background `--card` at 68 % (`color-mix`), `backdrop-filter: blur(22px) saturate(1.8)`, 1 px `--sep` border, radius 14, no shadow. Under `prefers-reduced-transparency: reduce` it is solid `--card` without blur.
- A 32 px strip under the island fades into `--content` (`linear-gradient(transparent, var(--content) 70%)`) so bare text never peeks out below.
- Notices (`ui/StateStrip`: agent not running, host disconnected, starting, waiting, archived) stand in the island's column — `calc(100% - 24px)` wide, capped at the column width minus 24, centred — as a card: `--tint` over solid `--content`, 1 px `--hair` border, radius 12. The log shows beside them, not through them.
- The log knows the dock's height (`Rows.bottomInset`, measured with `ResizeObserver`): the last row scrolls clear above the island; follow-to-end, To latest, in-view search and turn navigation count only the visible height; the turn rail ends above the dock.
- The gaps around the island belong to the log: the dock has `pointer-events: none`; only the island, deck and notices take clicks and wheel events.
- Focus: one outer frame — `--accent` border plus a 4 px `--accent-soft` ring on `:focus-within`. The inner editor draws no outline. All app textareas have `resize: none`.

Why the overlay: a fixed strip under the log cut the conversation with a hard line and took height; `padding-bottom` on the scroller is not used because `Rows` virtualisation measures `clientHeight` including padding.

<a id="agent-row"></a>
### Agent row

- All controls are size M (28): `+`, context ring, capsule, Send/Stop. The row has `flex-wrap: nowrap` and never wraps; the capsule [squeezes](#capsule-squeeze) instead.
- `+` is an `IconButton` labelled **Attach files**, title **Up to 10 files, 8 MB total. Images up to 4 MB.**
- Send and Stop are M 28 circles (Send glyph 13, Stop 11). Idle: Send only. While the agent works: Stop is primary while the field is empty; with text, Stop turns neutral (`--tint2`) and Send stands beside it (with steering, Send offers **Send now** / **To the queue**; see [steering](composer-steering-queue-and-ghost.md)).
- Send is disabled while a rate limit is active, the draft is not loaded yet, the agent is not connected and not idle, the text and attachments are empty, a command is being sent, or the session is resuming.

<a id="environment-footer"></a>
### Environment footer

Shows where the agent writes, from task data only (no extra git calls). A task without a git tree has no footer (only its notice chips, if any).

| State | Shows |
| --- | --- |
| Worktree | worktree glyph, branch, `+N −M` of the task, `from <base>` |
| No isolation | branch glyph and branch name in `--amber`, `+N −M`; no fill and no "No isolation" text in the footer |
| Detached HEAD | amber, weight 600 **Detached HEAD** |
| Several repos selected | `N repos`, with an amber dot if any repo stays in place in a worktree task (`external` scope) |

- Geometry: 26 px tall (27 with the line), `--hair` top border, bottom corners follow the island, 11 px `--fg2`, no fill. Branch uses `ui/BranchName` (full name with prefix, shrinks in the middle, full name in the tooltip); `+N −M` via `ui/ChangeCounts` (mono 10.5).
- The whole footer is one button (`aria-label`/`title`: `Worktree · <branch>` or `No isolation · <branch>`). Hover and open state: `--accent` at 10 % over the whole bar.
- Click opens the **Task repos** popover (340 px) above the island from its left edge: one row per selected repo (glyph, name — the project name for the root `.` — branch or Detached HEAD, `+N −M` or **No isolation**), footer note `Worktree · from <base>`. Data comes from `readScopePanel`, the same source as the sidebar's repo section. Esc closes and returns focus.
- Class S chips (repo contention, auth, rate limit and others; see [notice chips](notifications-slack-notes-and-schedules.md)) stand to the right of the footer button as their own targets; the branch shrinks first.
- The footer never folds. A legacy `composerEnvironmentCollapsed` field in `surface-layout.json` is read and dropped; the next save omits it.

<a id="agent-capsule"></a>
## Agent capsule

The capsule shows and changes the agent's session options (`ComposerOptions`). The set of options and their values come from the agent (ACP `configOptions`, legacy `availableModes`); the order, shape and visibility rules are ours. No hidden provider calls, no options the agent did not declare, no model or mode tables. The model and effort catalogs themselves are in [Agents and providers](agents-and-providers.md).

<a id="capsule-segments"></a>
### Order and segments

- Order (`orderAgentOptions`): model · effort · mode · fast · other options in the agent's order. Kind detection (`agentOptionKind`) uses the option's category, else its id: effort is `thought_level`, `effort`, `reasoning_effort`, `thinking_level`; fast is `fast`, `fast-mode`, `fast_mode`.
- Legacy ACP modes (`session/set_mode`) are added as a mode option only when `configOptions` has no mode option.
- Shape: one `--tint` pill at row height (M 28), segments of 24 inside, separated by a `--fg3` `·`, a ▾ button at the end (opens the menu on the first section; its title lists all values). Text 11.5 px `--fg2`. Segment hover `--tint2` under `--fg`; the segment that opened the menu is accent. Segment tooltip: `<option name>: <value>`.
- Glyphs: provider glyph 11 (Claude, OpenAI for Codex, a person otherwise) before the model; effort disk 14 (`ui/OptionIcon`); mode and other options 12; Fast arrows in `--amber`. Unknown effort values get a neutral glyph, not an invented strength.

What is shown as a segment (`capsuleShows`); every option always stays in the menu:

| Option | Segment |
| --- | --- |
| Model | always; label is the model name without a leading `<provider>-` (`claude-opus-5` → `opus-5`, `modelDisplayName`); other names stay as given |
| Effort | always |
| Mode | only when the value is not typical (`typicalChoices`): typical = the choice whose value or name is `default` (else the first listed), plus any choice named `auto` / `Auto mode` |
| Fast | only when on; label `Fast` |
| Other on/off option (boolean, or a select of exactly two choices reading `on`/`off` or `true`/`false`, e.g. Ultracode) | only when on; label `<Name>: on` in accent (`--accent-soft` under `--accent`) |
| Other select | always |

- Labels that come from the agent (option values, mode names, model names) are printed as received, without case normalisation. Labels we synthesise from booleans are lowercase `on`/`off`.
- When the mode changes while its segment is visible (⇧⇥ or the menu), the segment flashes the accent once (1.2 s).
- While the agent works or the session is gone, the capsule is disabled (shared disabled opacity) and the menu cannot open; an open menu closes. A task without a session shows neither capsule nor context ring.

<a id="capsule-squeeze"></a>
### Squeezing and compact view

The squeeze level is measured on the row itself (`ResizeObserver` on `[data-composer-bar]`, first level at which the last item fits), not from window breakpoints, because side panels set the column width.

| Level (`data-squeeze`) | Effect |
| --- | --- |
| 0 | all labels |
| 1 | Fast and other options: glyph only |
| 2 | plus mode: glyph only |
| 3 | every segment except the model: glyph only |
| 4 | compact capsule; the context ring drops its percentage |

- Compact capsule: one button framed in `--sep` (max 240 px): provider glyph, model name (truncated), glyphs of the shown segments, ▾. Tooltip lists all values.
- A segment without its label stays a button named after its option, with the `Name: value` tooltip.
- **Compact | Full** (the menu header's **Capsule view** segments) is global: `composerCapsuleCompact` in `surface-layout.json`, default `false`. Compact forces level 4 at any width; Full restores width-driven squeezing.

<a id="capsule-menu"></a>
### Agent menu

- One menu for the whole capsule (`ui/Popover`, label **Agent options**, 300 px): opens above the capsule at its right edge. Clicking any segment, ▾ or the compact capsule opens it focused on the selected value of that segment's section; clicking another segment while open moves focus to its section.
- Header: **Compact | Full** and the shared `ui/PopupClose` (Esc).
- Sections in capsule order, titled with the agent's option names, no rules between them; title 11/600 `--fg2`.
  - Model and long selects: a radio list; the chosen row is `--sel` with an accent `check-pass` ✓; rows read `group · name` when the agent groups choices; arrow keys, Home and End move.
  - A select with up to 4 choices whose names are all ≤ 10 characters: segments.
  - Boolean: **Off | On** segments.
  - The mode section title shows the **Next agent mode** shortcut from the keymap in a `--sep` frame.
  - Choices carry no glyphs (glyphs live in the capsule).
- A choice applies immediately (`session/set_config_option` or `session/set_mode`) and the menu stays open. Esc or a click outside closes and returns focus to the opening segment (else the compact capsule or first visible segment). It also closes when the agent starts working or the capsule becomes disabled.

<a id="mode-cycle"></a>
### Mode cycling

- **View ▸ Next agent mode** (default ⇧⇥, keymap-driven) cycles the mode option's choices in the agent's order (`nextAgentMode`), or the legacy modes when there is no mode option.
- The composer catches the key in its capture phase while it has focus, so ⇧⇥ does not move focus backwards. It is not taken while the caret is on a Markdown list item (there ⇧⇥ outdents; see [formatting](#formatting)) or while the `@` / `/` menu is open.

<a id="context-ring"></a>
## Context ring

- `ContextMeter`, shown when the agent reports `usage.changed`: a 13 px ring (track `--tint2`) with an 11 px `--fg2` percentage; tone amber above 70 %, red above 90 %. Accessible name `Context: <percent>`. Invalid usage is not shown; the value is clamped to 0–100 %.
- Hover or keyboard focus opens a popover; click pins it; second click, Esc or click outside closes. The popover shows `Context` and `<used> / <capacity> tokens` with short counts (`formatTokenCount`: 1, 10, 100, 1k, 10k, 100k, 1m, 10m), a progress bar and the percentage in its tone.
- Actions under the bar: **Compact** (sends `/compact`) only when the agent announced a `compact` command and is not working; **Continue in a new task** (the relay). The note **No breakdown.** explains that ACP usage carries only totals: no split into prompts, tools or system context is invented.

<a id="text-editor"></a>
## Text editor

- CodeMirror, the same editor as the New task sheet prompt (`useMentionEditor`). Font 13.5 / 21, padding `12px 16px 2px`, one line high when empty (min 35 px), grows to 240 px, then scrolls inside.
- Placeholder teaches the keys: `{send} send · {newline} new line · @ files · / commands`, keys from the keymap helper (`formatAccelerator`): `↩` / `⇧↩` on macOS, `Enter` / `Shift+Enter` on other platforms. While the agent works the placeholder describes steering (see [steering](composer-steering-queue-and-ghost.md)). While a plan waits for approval it reads `Ask about the plan or say what to change` (see [Chat while the plan waits](chat-turns-plans-and-questions.md#plan-chat)).
- A ghost suggestion is the placeholder text with a framed `Tab` key after it; `Tab` takes it only when the menu is closed and the text is empty.

| Key | Action |
| --- | --- |
| `↩` | send (into the running turn when steering applies); picks a menu item instead while the `@` / `/` menu has items |
| `⇧↩` | new line, or [continues a list/quote](#formatting) |
| `⌘↩` (View ▸ Add to queue) | queue while the agent works |
| ⇧⇥ | [next agent mode](#mode-cycle) |
| `⌘L` (View ▸ Focus composer) | focus the composer |
| `⌥⌘↑` / `⌥⌘↓` | previous/next turn, also from the composer |

- IME: no menu or send key fires while `view.composing`.
- Checks that look for a `textarea` also accept `contenteditable`.

<a id="formatting"></a>
## Rich formatted input

The text stays Markdown and the agent receives exactly what was typed. There are no widgets: everything is text commands (`renderer/composer-format.ts`) and decorations of the same editor, so it works identically in the composer and the New task sheet.

**Continuation (`⇧↩`)**

- In a `- ` / `* ` item: the same marker; `1.` → `2.`; `- [ ]` / `- [x]` → `- [ ] `; `> ` → `> `. Indentation is kept; text right of the caret moves into the new item. With the caret in or before the marker it is a plain line break.
- On an empty item: top level removes the marker; a nested item first moves up one level, a second `⇧↩` exits. An empty `> ` exits.
- Inside a fenced code block (and on the fence line): no markers, only the line's indentation up to the caret.
- Renumbering: after an inserted item, the following ordered items of the same level in the same contiguous list block (stopped by a blank line, a non-item or a fence) renumber consecutively. The first item of a level keeps its number (lists may start at 5), except a nested level, whose first item is always `1.`. Same after `Tab`, `⇧Tab` and exit.

**Indent (`Tab` / `⇧Tab` on an item line: `-`, `*`, `1.`, `- [ ]`; a quote is not an item)**

- Deeper goes under the previous item by its marker width (2 spaces under `- `, 3 under `1. `), never deeper than a child of the previous item; the first item of a block does not indent. The item takes its deeper lines and all selected items with it. `⇧Tab` goes to the indentation of the nearest shallower item.
- The key is consumed while the caret is on an item. Elsewhere `Tab` keeps its meaning (ghost, menu, focus) and ⇧⇥ is Next agent mode. An open `@` / `/` menu takes `Tab` / `⇧Tab` first; the ghost takes `Tab` before the list.
- Because the app menu receives ⇧⇥ before the page, the editor sets `data-list-line="true|false"` on its element on every transaction; the menu context (`menu-context.ts`) disables `composer-mode` when the focused element is inside `[data-list-line=true]`. The composer's keydown handler and the workspace action also check `inListLine`.

**Paste**

- Lines starting with `•` `◦` `▪` `▫` `‣` `⁃` `●` `○` `■` `□` and a space become `- ` items; nesting from indentation (tab = 2 spaces), or from the glyph kind when there is none (`•` 0, `◦` 1, `▪` 2).
- An HTML list on the clipboard (`<ul>`/`<ol>`/`<li>`) becomes `- ` / `1. ` with nested indents, only when the plain text has no list markers.
- A single `http(s)://` address pasted over a one-line selection makes `[selection](address)`. Everything else pastes unchanged; images follow [paste rules](#paste).

**Look (decorations)**

- `- ` off the caret's line renders as a bullet in a marker-wide column (14 px; numbers 22 px, +7 px per extra digit; 7.2 px per indent space); wrapped item lines hang under the item text (`padding-left: W; text-indent: -W`); the caret of an empty `2. ` stands where text will begin.
- Numbers and bullets `--fg2`; `>`, `[ ]`, link brackets and address, code fences `--fg3`.
- `**bold**`, `*italic*` / `_italic_`: markers hidden off the caret's line (not `* x`, not half of `**`, not `snake_case`). Links stay typed with dimmed brackets and address.
- Code block lines lie on a `--tint` band (radius 6 at the block ends, mono .89 em). Inline code is 12 px (`--text-12`). On the caret's line everything shows as typed.

**Shortcuts** — **Edit ▸ Formatting ▸ Bold · Italic · Code · Link** (`format-bold|italic|code|link`, defaults `⌘B` `⌘I` `⌘E` `⌘K`, context `composerFormat`: focus in `[data-prompt]`, not in the console, no modal).

- With a selection: wrap and keep the selection; without: an empty pair with the caret inside. Repeating unwraps (wrapped selection, selection inside markers, caret inside a wrapped word, an empty pair). A single `*` never takes half of `**`. Italic inserts `*`.
- `⌘K`: selection → `[text](|)`; no selection → `[|]()`; on an existing link → its text.
- The shortcuts follow the keymap (`commandAccelerator`); CodeMirror bindings rebuild when it changes. Shortcut scope `composer` does not conflict with Go to definition (`⌘B`, editor), Clear terminal (`⌘K`, console); it is exclusive with the global Ask the agent (`⌘I`). The `vscode` preset leaves `format-bold` unbound (`⌘B` toggles the sidebar there).

**Sent messages render Markdown** (`PromptText`): the same `MarkdownBlock` as agent replies with its own `markdown-it` instance (`userMarkdown`, `breaks: true`). Mention tokens are not Markdown: an inline rule leaves an empty `<span data-prompt-token>` and the pill or thumbnail is portalled into it; inside code a token stays text. Blocks 4 px apart, paragraphs 10 px. Copy message, chat search, the turn rail and the queue read the raw text; the agent gets raw Markdown.

<a id="mentions"></a>
## Mentions in the text

Every attachment stands in the text where it was placed; there is no attachment shelf in the composer.

<a id="prompt-tokens"></a>
### Tokens and pills

The draft and the journal keep each mention as a self-delimited token without spaces (`packages/core/src/prompt-tokens.ts`):

| Token | Meaning | Pill |
| --- | --- | --- |
| `@[att:<uuid>]` | an attachment: file or folder reference, text, image, task summary | file/folder/code glyph and name; image as thumbnail |
| `@[task:<id>]` | a task, until the message is sent | task state glyph (helmet for a crew), title |
| `@[agent:<id>]` | an agent template, until the message is sent | person glyph, the template's name |
| `@[model:<provider>:<id>]` | a model reference | provider glyph, model id |

- Pills: `--accent-soft` background, `--accent` text, 10 px glyph; file, folder and model in mono, task and agent template in the normal font. Images: inline thumbnail at line height, 39 × 26 in the composer, 30 × 20 in the sheet, radius 4, centre crop.
- A pill is atomic: the caret walks around it; the first `⌫` right after it selects it, the second removes it. Removing a pill removes its attachment; `⌘Z` restores both. A pill's `title` says what it is and how it goes to the agent.
- Click on a pill or thumbnail opens the attachment preview (file pills open the document).
- Display text (`promptDisplayText`) replaces tokens with names (`@Button.tsx`) for the turn rail, queue deck, chat search and Copy message. The sent message in the log shows the same pills and thumbnails.
- Where attachments land: a pick in the `@` menu replaces the `@query` word; `⌘V` and Finder drops insert at the caret; `+`, Attach from the file tree, editor selections and browser/simulator screenshots insert at the caret, or at the end of the text when the editor has no focus (`composerInserts`). An attachment that has no place (an older draft or queued prompt) gets a token at the end.

<a id="agent-blocks"></a>
### What the agent receives

- The transport builds ACP blocks in text order (`promptBlocks` with `promptSequence`): `[text, attachment, text, image, text]`. The same path serves send, queue, steering and Send now.
- Text attachments become text blocks `<attached_context name="<name>">\n<text>\n</attached_context>`; images become `image` blocks (PNG). Attachments the text does not place follow the text.
- A model pill becomes the text `` `claude-sonnet-5` (Claude) ``. It has no side effect: the task's model does not change and the turn runs on the task model.
- A task pill becomes, at send time, an attachment `Task summary · <title>` built by main without a model (`attachment:task-summary`): title, state, branch, first request, latest agent answer and `git diff --stat`. Failure blocks the send with **The task summary could not be attached.**
- An agent template pill becomes, at send time, an attachment `Agent template · <name>` built by main from the library (`attachment:agent-template`), so the log keeps what the agent read even after the template changes. Its text (English, rule 12) says the template is a role for a subagent: when the person asks to run it, the agent starts a subagent with its own subagent tool and gives it the instructions below, followed by the work and what the subagent has to know, because a subagent does not see the conversation; the agent checks the answer before it passes it on, and does the work itself by the same instructions when it has no subagent tool. The instructions are the template's own without the crew tools (`subagentRole`): a built-in gets its text for work under another agent, an own template its instructions with a sentence that sends its crew words to the agent that started it; a checker is told to write no code and change no files. The mention has no side effect: nothing starts until the agent starts it, the subagent runs inside the task's session with the task's rights, and the task's role, model and rights do not change. A template that left the library blocks the send with **The agent template could not be attached.**
- More than 10 attachments at send time block the send with the attachment-limit error.
- Images require the agent's `promptCapabilities.image`; otherwise the transport refuses the prompt before `turn.started` and the draft stays.
- File and folder references are text, not `resource_link`: `File reference:` / `Directory reference:` with `Project-relative path` and `Absolute path`, ending `Read the current contents from disk when needed.` The agent reads the contents itself, so context is not spent and the reference does not go stale.

Why text and not `_meta`: an adapter may ignore `_meta` and, in practice, non-text fields of `resource_link`. Anything the action cannot work without must travel in a channel verified on a live agent (text blocks); `_meta` only supplements.

<a id="attachments"></a>
### Attachment sources and limits

| Source | Result |
| --- | --- |
| `+` / `/` ▸ Attach files (`attachment:pick`) | native multi-select dialog in main; `.png .jpg .jpeg .webp` → PNG image (≤ 4 MiB, not downscaled); others → File reference with absolute path |
| `⌘V` image (`attachment:paste`) | main reads the clipboard; see [paste](#paste) |
| `⌘V` / drop of Finder files (`attachment:paths`) | same as `+` |
| `@` file or folder, file tree Attach (`files:attach`) | File / Directory reference |
| Editor or diff selection | text attachment `path:start-end` ([below](#selection-to-chat)) |
| Command output, browser node/log, browser or simulator screenshot | text or PNG attachment |

- Limits per prompt: 10 attachments, text ≤ 256 KiB each, image ≤ 4 MiB, 8 MiB total (`attachmentTotalLimit`). Names are capped at 200 characters.
- Main creates immutable UUID assets in the task directory; the renderer reads them only by TaskKey and id (`attachment:read`, `attachment:info`, `attachment:thumbnail`), never by path. Paths come only from a native dialog or the person's own drop/paste gesture, so `attachment:paths` is not a general file-read API.
- The host journal stores attachment metadata, not base64 or scrollback; the GUI host validates assets before the turn starts.
- Cancel in the dialog leaves the draft unchanged; a failing batch is reported and nothing from it is added. Errors: **Could not attach the files. Check attachment limits.** / **Could not attach the image. Check attachment limits.**
- Terminal (CLI) tasks send attachments to the CLI context queue instead; see [Terminal and CLI agents](terminal-and-cli-agents.md).

<a id="paste"></a>
### Paste

- The composer listens to `paste` but takes no image bytes from the event: `pasteAttachment(task, name)` asks main, which reads the system clipboard (`clipboard.read()`): `image/png` (a macOS screenshot's TIFF also arrives as `image/png`); `jpeg`, `webp`, `gif` are re-encoded to PNG. The image header is checked first (`imageSizeRefusal`). An empty clipboard returns `null` without an error.
- Text wins over an image (`pasteKind`): spreadsheets put a picture beside copied cells. Exception: text that is only one `http(s)`, `file`, `data` or `blob` URL without spaces next to an image (a browser's Copy image) attaches the image.
- A pasted image over 4 MiB is scaled down proportionally until the PNG fits (`fittedPng`, up to 6 steps), not rejected.
- Finder copies show `Files` and empty text in the paste event: preload resolves paths (`webUtils.getPathForFile`) and main attaches them like `+`.
- The pasted image is named **Pasted image** (localised by kind). Text and caret stay put; focus does not jump.
- CodeMirror's own paste is bypassed for these cases (`ownPaste`); in a CLI terminal `⌘V` pastes text and the CLI's own `⌃V` pastes images.

<a id="drop"></a>
### Drag and drop

- Dropping Finder files on the island attaches them like `+` and focuses the text. Internal drags from the Files tree (`fileDragType`, same task only) attach a file reference. CodeMirror's own file drop (reading the file as text) is disabled. An image dragged from a browser page has no path and is not attached.
- While a file is over the island (`data-drop-over`): border `1.5px dashed --accent`; the drop zone covers the card (`--card` under `--accent-soft`) with a 14 px `--accent` drop glyph, **Release to attach** (13 px, 600) and **Up to 10 files, 8 MB total. Images up to 4 MB.** (10 px `--fg2`). It fades in and out over `--motion-fast` and never takes events; leaving the island clears the state.

<a id="attachment-chips"></a>
### Attachment chips outside the composer

Queued prompts, attachments without a place under a reply, and the CLI context shelf use compact chips (`ui/AttachmentChips`): 20 px tall, radius 5, accent background, icon, 11 px text and a frameless ×. Inner preview/remove buttons stay transparent on hover (the × changes its icon colour) and are 20 px high so the base 24 px button height does not stick out. Click opens the preview, × removes; both work from the keyboard.

<a id="mention-menu"></a>
## `@` menu

- `@` at the start of a word (line start or after whitespace) opens the menu anywhere in the text; `mail@example` and a query containing a space stay text. Without a pick, `@word` goes to the agent as text; nothing is silently converted.
- Tabs **All · Files · Agents · Tasks · Models** with match counts; opens on **All** (all groups in one list, captions like `Models · Claude`). In **All**, once a query is typed, matching agent templates stand above the files: `@tester` names the template first, and a bare `@` starts with files. Tabs appear only when a menu has two or more groups (`ui/mention-tabs`).

| Tab | Source and rows |
| --- | --- |
| Files | the task's file index (same as Open Quickly ⌘⇧O and Search Everywhere ▸ Files) plus folders; up to 8 rows; `file`/`folder` glyph 12, mono name, path tail |
| Agents | the library's agent templates except foremen ([Templates](crew-templates-and-editor.md#builtin-templates)), in the library's order, matched by the name shown and by the English name; `person` glyph; tail = the line of the template's card ([Agent cards](crew-templates-and-editor.md#agent-cards)) |
| Tasks | project tasks except the current one; crew agents indented under their task, the current task's own crew at the top level; state glyph; tail = current tool activity while working or needing you, else the state |
| Models | both providers' model catalogs, the task's provider first, grouped by provider; mono model id; ✓ and tail **task model** on the task's model |

- Files: the first search runs at once, later letters after a 120 ms pause; previous results stay until new ones arrive. Until the first answer the Files tab (and All, if nothing else matches) shows **Searching…**; models show **Loading…**.
- Ranking (shared `fuzzy` index for `@`, ⌘⇧O and Search Everywhere): exact in name < exact in path < scattered in name < scattered in path; within a tier by position, gaps and path length. Folders rank with files, so a folder stands above its own files.
- Folders: from the same walk as files (no `node_modules` and similar, no gitignored entries, no repos outside the task). A folder pick attaches a Directory reference named `<name>/` with a folder pill; its contents are never read or attached. ⌘⇧O and Search Everywhere stay file-only.
- No match: the menu stays open with **No matches**; Esc closes it.
- Keys while open: `Tab` / `⇧Tab` next/previous tab (cyclic), `↑` / `↓` row (scrolled into view), `↩` pick (does not send), Esc closes for this `@` only (a new `@` reopens). Typing goes into the text and filters all tabs. DOM focus stays in the text (`aria-autocomplete="list"`, `aria-controls`, `aria-activedescendant`). Row hover moves the active row across the full width; tab hover `--tint`.
- Look: shared `ui/MentionMenu` (padding 4, radius 7, 12 px rows, active row on `--accent`, 10 px `--fg2` tail). In the composer it opens above the island from the text's left edge (left 10 px), width `min(360px, island − 20)`, with tabs `min(400px, island − 20)`; appears with `--motion-fade`.
- Height: the list scrolls under fixed tabs, `max-height` = the smaller of 280 px and the room the window leaves on the growing side (above the island: up to 56 px from the window top; below the caret in the sheet: to the window bottom minus 12), never below 96 px; re-measured on list and window changes. Long names truncate only after the description tail has shrunk.
- The New task sheet uses the same menu below the caret with tabs **All · Files · Crew · Agents**, no tasks or models; a folder mention there is the text `@<path>/` with a folder pill. See [Tasks](tasks.md).

<a id="slash-menu"></a>
## `/` menu

- `/` at the start of a word opens the menu anywhere in the text (first character, after whitespace or a newline). `a/b`, a query containing a second `/` (`/usr/`) and `/` inside a word stay text. The trigger is a pure function over text and caret (`slashTrigger` in `core/slash-menu`), shared by the composer and the sheet.
- Tabs (groups, fixed order) **All · Slash commands · Skills · Actions · MCP tools**; a tab exists while its group has at least one item before filtering, so tabs do not jump while typing. Width `min(480px, island − 20)` (480 in the sheet). Keys, placement, height and Esc as in the [`@` menu](#mention-menu). With no matches the menu closes.
- Ranking inside a group (`matchSlash`): match at the start of the name or of its last part (after `:` or `__`: `use` finds `figma:figma-use`, `open` finds `mcp__brigadir__browser_open`), then anywhere in the name, then in the description; agent order within a rank.
- Row: name in mono, description tail; full description and argument hint in `title`.

What a pick inserts — plain text the agent understands, unchanged at send time, so the log shows exactly what the agent got and a hand-typed mention behaves the same:

| Entry | Inserted |
| --- | --- |
| command or skill | `/name ` |
| Codex skill | `$name ` |
| MCP tool | `mcp__server__tool ` |
| MCP server with no known tools | `mcp__server ` (tail **MCP server**) |
| Action | nothing: removes `/word` and runs the action |

What appears mid-text versus only as the first character:

- Anywhere: skills, custom commands (user and project `.claude/commands`, plugin commands — Claude runs them via its `Skill` tool), MCP tools, actions. A Codex `$name` is always a skill.
- First character of the message only: the agent's built-in commands (`compact`, `model`, `review`, …), built-in Claude Code skills and MCP prompts (`mcp:server:prompt`). A built-in is an agent command not found among skills and commands on disk. Mid-text the agent would not run them, and ACP carries no flag that tells which built-in skills work there.

Sources:

- After the agent starts: the latest `commands.changed` (from `available_commands_update`) for commands and skills; disk is used only to tell skills from built-ins (synced claude.ai skills are recognised by their last name part).
- Before the agent starts, from disk via main (`slash:catalog`, `main/slash-catalog.ts`), with the grey note **Preliminary list. Agent not started.** above the list:
  - Claude: `~/.claude/commands/**/*.md`, `<project>/.claude/commands/**/*.md` (name = file name; folders only group), `~/.claude/skills/*/SKILL.md`, `<project>/.claude/skills/*/SKILL.md`, enabled plugins (`settings.json` → `enabledPlugins`, paths from `plugins/installed_plugins.json`: `skills/*/SKILL.md`, `commands/*.md` as `plugin:name`). `CLAUDE_CONFIG_DIR` replaces `~/.claude` and `~/.claude.json`.
  - Codex: `$CODEX_HOME/skills/*/SKILL.md` (with `.system`), `~/.agents/skills`, `<project>/.agents/skills`, `<project>/.codex/skills`, as `$name`.
  - Description from the front matter `description` (else the first non-empty line); argument hint from `argument-hint`.
- MCP tools: our `brigadir` server lists exactly the tools the host gives this task (by crew role, enabled modules and PR review mode), with descriptions. User servers from agent settings (Claude: `~/.claude.json` `mcpServers` and `projects[<path>].mcpServers`, `<project>/.mcp.json`; Codex: `[mcp_servers.<name>]` in `$CODEX_HOME/config.toml`) appear as one `mcp__server` row each; tools of other servers the agent already called in this task appear by exact name.
- Actions (task composer only): **Attach files**; **Browser screenshot** while a browser tab is on screen; **Simulator screenshot** while a simulator tab is on screen (the same actions as the menu bar's `browser-screenshot` / `simulator-screenshot`; only when their module is enabled).
- A bare `/` with nothing to list shows a grey unselectable row: **Searching…** while the disk catalog loads, **Commands appear after the agent starts** when the agent has not announced commands and the disk gave nothing; it is replaced as soon as `commands.changed` arrives.

<a id="slash-highlight"></a>
### Highlighting known commands

- A word equal to what a `/` pick would insert is marked on the text: `--accent-soft` background, `--accent` text, mono `.9em`, padding `1px 3px`, margin `0 -1px`, radius 4. It is text, not a pill: the caret walks inside and `⌫` removes letters one by one. Marks are not interactive and have no hover.
- Known = this task's `/` list only: agent-announced (or disk) commands and skills, MCP tools (`mcp__server__tool`), Codex `$name`. Actions never appear in text. Unlisted names stay plain, even similar ones.
- Built-in commands are marked only as the first word of the message (position 0); skills, custom commands and tools anywhere.
- Word boundaries: up to whitespace; surrounding brackets, quotes and sentence punctuation are excluded (`(/deep-review).` marks `/deep-review`). Paths, `a/b`, inline code and code blocks stay text.
- A list that arrives later marks existing text without rebuilding the editor (the list key is part of `findKey`).
- Tooltip: `<name> · <kind>` (skill, slash command, MCP tool, MCP server) and the description; for a built-in a third line **Only at the start of a message.**
- Applies in the composer, the New task sheet prompt and the person's messages in the log (`userMarkdown.renderer.rules.text`; the first word is the start of the message's first text token). Implementation: `slashIndex` / `slashWords` in `packages/core/src/slash-menu.ts`; CodeMirror `Decoration.mark` with class `.command` (`useSlashWords` in `slash-menu-items.ts`). The agent receives the same text.

<a id="selection-to-chat"></a>
## Editor and diff selection to chat

The selection panel and its actions (Comment, Attach comment, Attach comment and go, Line to chat, the quick question) are specified in [Editor](editor.md) and [Diff and review](diff-and-review.md). On the composer side:

- A selection becomes a text attachment whose name comes from the selection source, never parsed from the prompt: `path/file:start-end`; a diff adds the side (`path:12-20 · new`). Names longer than 200 characters are truncated from the left (`…` + last 199), keeping the lines. Existing attachments keep their names. The pill reads `Button.tsx:14-16`.
- Attachment text for a saved file: `Read file @"<path>", lines <a>-<b>.` plus `Selected text: "<quote>"` when the selection is partial text; for an unsaved buffer: `File "<path>", lines <a>-<b> (unsaved buffer).` with `Selected code: "<code>"`. It goes to the agent as an `<attached_context>` text block in place.
- A comment written with the selection is placed as the token on a new line at the end of the draft, followed by the comment text. An "immediate" send goes straight to the agent as a prompt.
- From the main tree (no task), the selection starts a quick task with the selection as context ([Tasks](tasks.md)). In a terminal task it goes to the CLI context shelf.
- The transcript shows a sent selection as a badge that expands into the fragment.

<a id="draft"></a>
## Draft and focus

- Per-task draft file `composer.json` in the task directory: `{ "schemaVersion": 1, "text": "…" }` written by main (`composer:save`, debounced 500 ms; forced flush after 128 pending saves). Empty text deletes the file. Close and quit flush pending writes. Limits: 1,000,000 characters and 4 MiB of JSON; main checks schema and path before each write.
- Reading (`composer:read`) never overwrites text typed before the reply arrived (revision check). An unreadable or unknown file is left untouched and the composer shows an error with Retry.
- The draft keeps tokens. After a restart pills are restored from the task's attachment records on disk (`attachment:info`); an attachment that no longer exists shows as a dashed pill (**The attachment is no longer available.**) and is not sent. The in-memory attachment list is parked with the task state while switching tasks.
- Text returned from the queue for editing comes back with its tokens; its attachments return to the composer state and pills reappear in place.
- Separate from `task.json` (typing must not rewrite task state) and from `drafts.json` (review comment drafts).
- The CLI context has its own queue and is not part of the draft.

<a id="queue-deck"></a>
## Queue deck placement

The queue deck (and the background commands deck) share `ui/Deck`, which stands on the island's top edge: the island overlaps the deck's last pixel, so the island's own top border is the line between them, and nothing of the deck hides under the glass. Deck rows, editing and pausing are specified in [Steering, queue and ghost](composer-steering-queue-and-ghost.md).

<a id="later"></a>
## Later

- `@` and `/` buttons in the agent row.
- Agent templates in the New task sheet's `@` menu.
- The template's own model for the subagent a mention starts.
- `@` pick of a file open in the editor with a selection attaches it with that line range, shown in the menu before picking.
- `⌫` on a list marker removes the marker; `Tab` inside a code block inserts 2 spaces.

<a id="non-goals"></a>
## Non-goals

- Letting the agent expand `@file` itself, or intercepting its expansion: the attachment boundary would move into provider code.
- Rich-text widgets in the input (clickable checkboxes, code cards, replaced markers) or a formatting toolbar; Markdown stays text.
- Rewriting `/name` mid-text into an English instruction at send time.
- Built-in agent commands or built-in Claude Code skills mid-text; our own lists of built-ins, modes, short model names or provider icons (capabilities come from ACP).
- Connecting to the user's MCP servers to list their tools; MCP servers of Claude plugins; the Codex `~/.codex/prompts` directory.
- Project commands or agent modes in the `/` Actions group.
- A separate Folders or Crew tab in the composer `@` menu; folders in Open Quickly or Search Everywhere; attaching a folder's contents.
- `@task` messaging another task or `@model` switching the task's model; generating task summaries with a model.
- Invisible base64 in prompts, capturing the whole terminal, or renderer reads of arbitrary paths.
- Window-width breakpoints for the capsule; per-segment menus.
