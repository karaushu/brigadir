# Design review

A design review checks a screen against its design source node by node, in the running app. Its result is a
contract: for each design node, the node's image from the design, a screenshot from the device and a table of
properties — expected from the design, found on the device. The host checks the evidence itself: a row counts only
when its node has both images and the device screenshot shows the task's current files. Nothing passes from the code
alone. The [reviews](reviews.md#design) ask for it; its mismatches are findings of the same loop.

<a id="design-source"></a>

## Design source

A task has a design source when a Figma link stands in its prompt (a crew worker's: its part's prompt), in a source
saved with [`save_source`](reviews.md#save-source), or in a plan presented for approval or a foreman's split: an
`https://figma.com/…` or `https://www.figma.com/…` address under `design/`, `file/` or `proto/`. The host finds the
links in the text; no model decides it. A task that filed a design review has one too.

- A saved source counts by its text and its `url`.
- The links (at most 20, each with its `node-id` when it has one) go into the reviewer's prompt ([Reviews](#flow)).
- A mock-up file or a reference screen is a design source for the agents (the [Designer](crew-templates-and-editor.md#builtin-templates)
  names it), not for the host: a review asks for a design review only on a Figma link.

<a id="who"></a>

## Who files it

Any agent of a task that has the simulator or the browser module: the task's own agent (solo, Auto, a hired worker),
a Designer, or a reviewer of the task's review (with its `reviewId`). The design review belongs to the task that
files it: its screenshots, its files and its card in that task's chat.

<a id="shots"></a>

## Screenshots the host keeps

- `simulator_screenshot` and `browser_screenshot` save every image they return in the task's folder (`shots/`) under an
  id, `s1`, `s2`, …, and their answer adds a line: `Saved as s12. Pass it as shot to submit_design_review.`
- Before the image is taken the host takes a checkpoint of the task's files ([Snapshots](diff-and-review.md#snapshot-engine)),
  and the shot keeps that checkpoint's trees. Taken before the image, it errs towards "old": a file written while
  the screenshot is taken makes it old. A shot whose checkpoint failed keeps no trees and is always old.
- The index keeps the last 200 shots; an older shot's file goes unless a design review named it (`kept`), so a card in
  the chat keeps its images. An index that cannot be read fails the screenshot's saving rather than start the numbering
  again over kept files.

<a id="tool"></a>

## `submit_design_review`

MCP `submit_design_review(screen, nodes, verdict, reviewId?)` — a tool of every task agent with the simulator or the
browser module.

| Field         | Limits                                                                                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `screen`      | 1–80 characters: the screen or state checked (`Details screen`, `Details · dark`)                                                                                                                      |
| `nodes`       | 1–24 design nodes                                                                                                                                                                                       |
| `name`        | 1–80: the node (`Header`, `Tab bar`)                                                                                                                                                                    |
| `figma`       | 1–500: the node's link with its `node-id`, or its id (`412:88`)                                                                                                                                         |
| `figmaImage`  | the node's image from the design: an absolute path of a PNG, JPEG or WebP file, or an `http(s)` address the host downloads (10 s); at most 10 MB                                                         |
| `shot`        | the id of a device screenshot of this task (`s12`)                                                                                                                                                     |
| `area`        | optional: where the node is on the screenshot, `{x, y, width, height}` as fractions (0–1) of its width and height (the element's frame from `simulator_ui` or `browser_ui` over the screen's size)      |
| `rows`        | 1–40 per node, 200 in all: `property` 1–80, `expected` 1–200 (from the design), `actual` 1–200 (on the device), `match`, and an optional `area` of the element the row is about                          |
| `verdict`     | `passed` or `mismatch`                                                                                                                                                                                 |
| `reviewId`    | a reviewer's review, when it files the design review as part of a check                                                                                                                                |

- `whenToUse` (English, rule 12): the task has a design source (a Figma node or frame): after the screen is built and
  again after a fix, before you propose a review or the person creates a PR. Every call is the whole screen: all its
  nodes, each with a screenshot taken after the last change.
- The description is the [prompt](#prompt) below.

<a id="verify"></a>

## What the host verifies

The host takes a checkpoint of the task's files (a failed checkpoint fails the call), then checks every node by
itself:

| Node state     | When                                                                                                                                                | Tag of its rows   |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `no-figma`     | the design image cannot be read: no such file, not a PNG, JPEG or WebP whose header gives a size, larger than 10 MB, or the address does not answer with one | `no design image` |
| `no-shot`      | `shot` is not a screenshot this task's own tool took (an id of another task, a made-up id, a deleted file)                                          | `no screenshot`   |
| `old-shot`     | the task's files changed after the shot: its trees differ from the trees now, or either could not be read                                           | `old screenshot`  |
| `ok`           | otherwise: the node's rows are accepted, each `match` or `mismatch` as the agent filled it                                                         | — or `mismatch`   |

- One screenshot per node, so a node that is not `ok` refuses all its rows.
- The design review's state: `passed` when every node is `ok` and every row matches, `mismatch` when every node is
  `ok` and a row does not match, `refused` when a node is not `ok`.
- `verdict: passed` is accepted only in the state `passed`; otherwise the design review is recorded in its own state
  and the answer says the verdict was not accepted. `verdict: mismatch` with every row matching is an error, and
  nothing is recorded: `Every row matches: mark the row that does not, or send verdict passed.`
- The host never judges a row: whether the values match is the agent's reading of the two images and the UI tree.

<a id="answer"></a>

### The answer

`{id, state, accepted, notAccepted, redo, mismatches}`: the rows accepted and not, one `redo` item per node that is
not `ok` and one `mismatches` item per row that does not match. Then one line per node to redo, saying exactly what to
do:

- `Tabs: s39 was taken before the files changed. Take a new screenshot of this node and submit the screen again.`
- `Tabs: s99 is not a screenshot of this task. Take one with simulator_screenshot or browser_screenshot.`
- `Header: the design image could not be read (no such file). Save the node's image from Figma to a file.`
- With mismatches: `Fix the mismatches, take new screenshots of those nodes and submit the screen again.`
- `passed`: `The design review passed.`
- Last, `warnings` about the [area](#area) of accepted nodes, one line each.

<a id="area"></a>

### The area

A node's `area` is its frame on the screenshot, as tight around the node as the design image is around the design node:
the [pair](#card) shows the two at the same scale only then, and the rows read from a wider crop read the wrong
pixels. The tool's description says so. The host checks the shape and warns; it does not refuse:

- No `area`: `{node}: pass its area on the screenshot, tight around the node, so the person sees the node next to its
  design.`
- An area whose width-to-height ratio (in the screenshot's pixels) is more than half again (`designAreaRatio`, 1.5)
  from the design image's: `{node}: its area on the screenshot is {a}:1 (width to height), the design image {d}:1. Fit
  the area tightly around this node (its frame from simulator_ui or browser_ui), not the screen or a section around it,
  and check the rows you read from it. If the app really draws the node that much {wider|taller}, keep the area and say
  so in a row.`
- The node stays accepted with its rows: an app that draws a node much taller or wider than the design is a mismatch
  the agent must be able to file, and the host cannot tell it from a loose crop.

<a id="flow"></a>

## In the flow

- **The author.** An agent whose task has a design source files a design review after the screen is built (the
  tool's `whenToUse` says so). A design review that is not `passed` asks it to fix and submit again; the host does not
  open a loop of its own.
- **The review asks for it.** A [mid-task review or a review before the PR](reviews.md#design) of a task with a
  design source adds the design review to its reviewer's prompt and refuses the reviewer's `approve` unless a `passed`
  design review covers the round: the task's own, or one this reviewer filed with this `reviewId`. A design review
  covers a round when every tree the round reads is among the trees it was filed on. The mismatches and a missing
  design review become the reviewer's findings, so they go to the author, come back to the closure check and reach the
  person with `Fix {n}` / `Accept` as every finding does. `Accept` is the person's answer to a design that does not
  match; nothing else lets a review pass without a `passed` design review.
- **A Designer of a crew** (the crew's own check of a part, [Reviewer agents](crew.md#reviewer)): a reviewer made from
  the built-in Designer template can `approve` only after a `passed` design review it filed with this `reviewId` whose
  screenshots were all taken after the check opened: its own tree is not the worker's, so the time of the check dates
  the evidence.
- **A plan review** has no design check.

<a id="prompt"></a>

## The prompt of the checking agent

In English (rule 12), the tool's description and the reviewer's design paragraph:

> Check the screen against its design node by node, in the running app. A node is a part of the design such as a
> header, a list row, a tab bar or a button, never the whole screen at once. For each node: open it in Figma and save
> its image to a file (your Figma tool's export or download, or the image address it gives); open the screen on the
> device and take simulator_screenshot (browser_screenshot for a web page) after your last change; read the values
> from the design and from the app (sizes and positions from simulator_ui or browser_ui), and fill one row per
> property: size, padding and gaps, corner radius, border, shadow, colour or token, typography, each icon and its
> size, and the states the design draws. Icons, paddings, radii, borders and shadows are rows. A row's on-device value
> comes from the screenshot or the UI tree, never from the code. Then call submit_design_review with every node.

<a id="card"></a>

## The card in the chat

Every design review is a card of the filing task's chat ([`ChatCard`](appearance.md#one-look-one-component)): the
`image` glyph, `Design review` and the hint `<screen> · N Figma nodes`.

- **Per node:** a chip (`link` glyph, the node's name) and the node id (mono, `--fg3`); under it the preview pair —
  two tiles side by side, 86 px tall, `--tint` with a 1 px `--sep` inset frame and a 7 px radius, the image fitted
  (cropped to the node's `area` when it has one) — both images of the pair at one scale: they show the same node, so
  they take one width, as wide as the tile allows while the image with the narrower aspect ratio still fits its
  height, and a device crop of another shape is taller or shorter than its Figma half, never smaller; a pair with
  one image missing fits each tile on its own — and a caption: `Figma` (bold) and the node id; `Device` (bold) and
  the shot id. Then the node's rows.
- **The table:** four columns, `Property` · `Expected` · `On device` · the tag, a 10 px `--fg3` header; rows 28 px with
  a hairline on top, values in mono 11 px. A matching row ends with `check-pass` in `--green`. A mismatch: the
  on-device value in `--amber` and the tag `mismatch` (`--amber-soft`, `--amber`), and the row's `area` outlined in
  `--amber` on the device image.
- **Not accepted:** an old shot outlines the device tile in `--amber` at 60 % and adds `before the last change` in
  amber to its caption, its rows tagged `old screenshot` (`--amber`). With no shot the device tile shows the `image`
  glyph and `No screenshot` in `--amber`, its rows tagged `no screenshot` (`--red` at 12 %, `--red`). With no design
  image the Figma tile does the same with `No design image`.
- **Foot:** the counts in mono: `6 rows · 2 match · 1 mismatch · 3 with an old screenshot`, `3 rows · 3 without a
  screenshot`, `6 rows · 6 match`.
- **Hover** covers the whole row (`--tint`, reaching 6 px past the table on both sides) and the whole tile (`--tint2`
  and a `--fg3` frame). A tile is a button: a click, `Enter` or `Space` opens the viewer.
- **A refused design review** adds a service row under the card: `image` glyph, `design`, the screen, `N rows not
  accepted` (`--amber`) and `<agent> takes new screenshots`.
- **Passed:** the card folds into one row as a decided plan does ([plan row](chat-turns-plans-and-questions.md#plan-row)):
  `agent-idle` glyph, `Design review passed`, `<screen> · N rows · N screenshots`, the time and the chevron, which
  opens the card's body read-only.

<a id="viewer"></a>

### The viewer

A popover over the chat, 500 px wide: the head is the node's name, its id (mono, `--fg3`) and `Esc`
([`PopupClose`](appearance.md#popup-close)); the body has the two images in tiles 170 px tall, at one scale as in the card, captions `Figma · <id>` and
`Device · <shot> · <device> · <time>`, the mismatched rows' areas outlined on the device image, and the node's rows.
`Esc`, a click outside or `PopupClose` closes it, and focus returns to the tile.

<a id="data"></a>

## Data

- `shots/shots.json`, `schemaVersion: 1` (rule 10): `shots` — `id`, `file` (`s12.png`), `tool` ∈ `simulator |
  browser`, `device?`, `at`, `trees` (`scopeId`, `tree`), `kept?` — and `next` (the next number). One image file per shot.
- `design/design-reviews.json`, `schemaVersion: 1`: `reviews`, the last 50 — `id`, `screen`, `at`, `state`,
  `reviewId?`, `trees` (the trees it was filed on) and `nodes` as in the event. A node's design image is copied to
  `design/<id>/figma-<n>.<ext>`; the device image stays in `shots/`.
- Journal event (rule 2) `design.reviewed`: `id`, `screen`, `state` ∈ `passed | mismatch | refused`, `verdict`,
  `reviewId?`, and `nodes` — `name`, `figma`, `figmaFile?` (relative to the task's folder), `shot?` (`id`, `file`,
  `at`, `device?`), `area?`, `state` ∈ `ok | no-figma | no-shot | old-shot`, `reason?`, `rows` (`property`,
  `expected`, `actual`, `match`, `area?`). Images are files, never in the journal.
- The images reach the window through `design:image` (the task and a file under `shots/` or `design/`).
- After a restart nothing is lost: the shots, the design reviews and the review's gate read the files.

<a id="later"></a>

## Later

- Coverage: every node the plan or the ticket links has a node in the design review.
- The design image taken by the host through Figma's API, so an agent without a Figma tool can check a screen.
- The card on the phone.

<a id="non-goals"></a>

## Non-goals

- Comparing pixels: the host checks that the evidence exists and is current, the agent reads it.
- A loop of its own: mismatches are findings of the [review](reviews.md#loop).
