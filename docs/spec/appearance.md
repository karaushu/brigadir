# Appearance, design system and UI text

This file covers how Brigadir looks and talks: theme, accent, fonts and text sizes, the design tokens in `renderer/tokens.css`, the shared controls in `renderer/ui/`, and the rules for interface text in English and Ukrainian. The design system is one set of tokens and one component per look. Every control takes its size from one scale, its states from one set of rules, and its colors from semantic tokens, so a new surface gets hover, focus, theme and motion without its own CSS.

Related: the Settings window and its tabs in [Settings, modules and onboarding](settings-modules-and-onboarding.md); the terminal's own theme, font weight and scroll speed in [Terminal](terminal-and-cli-agents.md); code themes and syntax font styles in [Editor code intelligence](editor-code-intelligence.md); shortcuts and native menus in [Search, shortcuts, menus and project commands](search-menus-and-commands.md); the platform layer (window frame, `nativeTheme`, data directory) in [Architecture and platform](architecture-and-platform.md).

<a id="theme"></a>
## Theme

| Setting | Values | Default | Applied |
| --- | --- | --- | --- |
| `appearance` | `system`, `light`, `dark` | `system` | at once |

- The row is `Settings ▸ Appearance ▸ Appearance ▸ Theme` (`System` / `Light` / `Dark`, a `Popup`).
- Main sets `nativeTheme.themeSource = settings.appearance`. `system` follows the OS live: `nativeTheme` `updated` republishes the appearance to every window.
- The renderer sets `data-theme="light|dark"` on `<html>` (`useApplyAppearance` in `renderer/apply-appearance.ts`). All tokens switch on that attribute. On Windows and Linux the same hook pushes the strip colour and `--fg` to the OS caption buttons after every theme or accent change.
- `appearance`, `accent` and `editor.codeTheme` are independent fields. A code theme recolours only syntax tokens of the editor and the diff, so adding a code theme never needs a settings migration.
- High contrast: `@media (prefers-contrast: more)` darkens or lightens the filled warning and danger colours and syntax comments. Components do nothing extra.
- Every surface follows the theme: the terminal gets its palette from tokens and repaints on a theme or font change, without restarting the PTY.

<a id="design-tokens"></a>
## Design tokens

Colours exist only as semantic tokens in `renderer/tokens.css` (reference values: [design tokens](../design-tokens.md)). Features never hardcode a colour, radius or shadow. A token block is defined for `:root` (light), `:root[data-theme='dark']`, and for `[data-palette='light'|'dark']`, so the Kit can show both themes side by side.

<a id="core-palette"></a>
### Core palette

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--win` / `--content` | `#ffffff` | `#1e1e1e` | window and content surface |
| `--tb` / `--sb` | `#e9e9eb` / `#f2f2f4` | `#2c2c2e` / `#232323` | toolbar, sidebar |
| `--card` / `--field` | `#ffffff` | `#2a2a2a` / `#1e1e1e` | cards, popovers; focused field |
| `--sep` | `#dcdcde` | `#3a3a3c` | separators, card edges |
| `--hair` | `rgba(0,0,0,.07)` | `rgba(255,255,255,.07)` | hairline inside a surface |
| `--fg` / `--fg2` / `--fg3` | black .85 / .60 / .42 | white .87 / .62 / .40 | text levels |
| `--tint` / `--tint2` | black .045 / .08 | white .06 / .10 | soft fill / pressed, counters |
| `--hover` | black .03 | white .035 | neutral hover overlay |
| `--segment-hover` / `--segment-press` | black .055 / .09 | white .07 / .11 | hover and press layers on controls |
| `--segment-on` | `--card` | `rgba(255,255,255,.12)` | chosen segment (a layer, so it stays lighter than the track on any surface) |
| `--amber` / `--red` / `--green` | `#a35200` / `#d70015` / `#1a7f37` | `#ff9f0a` / `#ff453a` / `#32d74b` | status colours |
| `--code` | black .04 | white .05 | code block surface |
| `--term` | `#f6f6f7` | `#141414` | terminal and image-viewer surface |
| `--tray` | `--win` 70 % | black .22 | lighter tray inside a card |
| `--knob` | `#ffffff` | `#ffffff` | switch knob on any fill |
| `--shadow` | black .18 | black .45 | base of all shadows |

Other tokens:

- Filled warning and danger keep ≥ 4.5 : 1 in both themes and in high contrast:

  | Token | Light | Dark | HC light | HC dark |
  | --- | --- | --- | --- | --- |
  | `--amber-fill` | `#a35200` | `#ff9f0a` | `#8a4600` | `#ffb340` |
  | `--on-amber` | `#ffffff` | `rgba(0,0,0,.85)` | `#ffffff` | `rgba(0,0,0,.85)` |
  | `--red-fill` | `#d70015` | `#d4322a` | `#b3000f` | `#b52a22` |
  | `--on-red` | `#ffffff` | `#ffffff` | `#ffffff` | `#ffffff` |

  Soft warning and danger text is `color-mix(in srgb, var(--amber|--red) 72%, var(--fg))`.
- Shadows have three levels: `--shadow-menu` (`0 10px 30px`, menus and popovers), `--shadow-modal` (`0 16px 48px`, modals and sheets), `--shadow-float` (`0 8px 24px`, toasts and floating panels). `--lift` is a floating card's hairline and soft shadow.
- `--modal-scrim` is `rgba(0,0,0,.42)` in both themes.
- `--ring-soft` is a 2 px ring of `--accent` at 55 %. It is the keyboard focus of a pill, or of a row that lights up whole.
- `--strip-h: 48px` is the window's top strip (sidebar header, task toolbar, project header, caption-button overlay). There is no other literal for it.
- Project dots (`--project-0…8`), project icon colours (`--icon-*`), avatars, file-type colours and diff colours are fixed palettes. They never follow the accent and never use the status red, amber or the selection blue.

<a id="accent"></a>
## Accent

`Settings ▸ Appearance ▸ Appearance ▸ Accent` sits right under `Theme`.

- `settings.accent`: `'system' | 'blue' | 'indigo' | 'purple' | 'pink' | 'teal' | 'yellow' | 'graphite'`. The default is `'system'`. A file without the field reads as `'system'`. Red, orange and green are not offered: they already mean "needs you", `+N` / Approve and failure / delete.
- Picker (`ui/AccentPicker`): eight swatches in a `radiogroup`, with one Tab stop. Arrows and Home/End change the choice. Each swatch is a 24 × 24 button with a 20 px dot. The chosen swatch has a 2 px ring in its own colour behind a 2 px gap of `--card`. `system` is a conic gradient with an `--fg2` ring. There is no caption: the colour name is the tooltip and the accessible name. A choice applies at once. Fast arrow presses queue behind the current `settings.json` write, and a failed write restores the saved colour and shows the error.
- Main sends `Appearance.accentColor` next to the OS accent `Appearance.accent` (8-hex). The renderer sets `data-accent` on `<html>`. Named accents come from `tokens.css`. Only `system` sets `--accent` inline from the OS colour.

Accent tokens:

| Token | Meaning |
| --- | --- |
| `--accent` | text, lines, borders, small marks on a surface (links, spinner, unread dot, selected border, focus ring) |
| `--accent-fill` | fills that carry `--selfg`: primary button, switch on, checked radio/checkbox, active menu item, keyboard-chosen row |
| `--selfg` | text and marks on `--accent-fill` |
| `--accent-soft` | `--accent-fill` mixed at 14 % light / 20 % dark (18 % / 20 % for yellow); always computed, never a static value |
| `--sel` | `--accent` at 12 % / 22 %: a selected row or card in a list, under `--fg` |
| `--accent-text` | small accent text on `--card`, 22 % lighter in dark |

| Accent | Light `--accent` / fill | Dark | `--selfg` |
| --- | --- | --- | --- |
| blue | `#0064e1` | `#0a84ff` | white |
| indigo | `#5856d6` | `#7d7aff` | white |
| purple | `#9a3fc8` | `#bf5af2` | white |
| pink | `#d0357a` | `#ee4f94` | white |
| teal | `#0a7d93` | `#40c8e0` | white light, `rgba(0,0,0,.85)` dark |
| yellow | `#946d00` / fill `#f5bd00` | `#f8c500` | `rgba(0,0,0,.85)` |
| graphite | `#6e6e73` | `#8a8a8f` | white |

- Yellow is the helmet colour of the app icon. In light it has two values, because yellow text on white is unreadable (1.9 : 1) while a yellow fill under dark text reads at 11 : 1.
- `system`: `--selfg` is white while white keeps ≥ 3 : 1 on the OS colour, otherwise dark (`accentFillNeedsDarkText`, `data-accent-text="dark"`).
- The switch knob stays `--knob` white on any fill. The checkbox tick and the radio dot use `--selfg`.
- A yellow selected card is told apart from the amber "needs you" card by its border and lighter fill. Light theme gives the smallest difference.

<a id="fonts"></a>
## Fonts

<a id="bundled-fonts"></a>
### Bundled Geist

- The app ships Geist and Geist Mono (variable woff2 from the `geist` npm package ≥ 1.8, SIL OFL 1.1; the licence sits next to the files in `renderer/fonts/`). It is the same font on every OS. `font-display: block`.
- The window waits for both faces before the first render (`loadBundledFonts`, 1.5 s ceiling), because the terminal and diff measure their cell on a canvas once.
- `family: null` in `interfaceFont` and in `typography.*` means Geist / Geist Mono. The OS font is its own picker entry, `System font` / `System mono`, stored as `system-ui` / `ui-monospace`. A family chosen earlier stays chosen. An installed copy of Geist is not listed twice.
- `--ui-family` is the interface font (Geist, then the system stack). `--mono-family` (Geist Mono, then `ui-monospace`) is the interface's own mono: paths, branches, hashes, counters, code in the chat. The code surfaces have their own `--terminal-family`, `--diff-family` and `--editor-family`.

<a id="font-catalog"></a>
### Installed font catalog

- macOS: a small Objective-C helper (`native/fonts.m`, CoreText/AppKit) runs with `--watch`. It lists every family with `mono` and `boxDrawing` flags and reports changes to the font registry.
- Linux: `fc-list` (spacing 100 or 90 marks mono; emoji fonts excluded), plus a box-drawing charset query.
- Windows: no catalog. The pickers offer the bundled and system fonts.
- Code surfaces list only `mono` families. The interface lists all of them. Font popups have search (`Search fonts`, `No fonts match`).
- Nothing else is bundled. Nerd Fonts and others come from the installed list.
- A family that is missing at startup falls back to the system font. The choice on disk stays, and a one-time notice names it: `Unavailable fonts: {fonts}. Using the system font.` The row also shows `This font is unavailable. Using the system font.` / `… Using system mono.`
- A mono family without full box-drawing coverage shows `This font does not include every box-drawing character.` under its card. This is a warning, not a block.

<a id="code-typography"></a>
### Code surfaces

`settings.typography`: `{terminal, diff, editor}`, each `{family: string | null, size, lineHeight, ligatures}`.

| Surface | Size | Line height | Ligatures |
| --- | --- | --- | --- |
| terminal | 13 | 1.0 (fixed) | none, no switch |
| diff | 11 | 1.6 (18 px) | on |
| editor | 12 | 1.6 (19 px) | on |

- Range: size 8–24 px (integers), line height 1.0–2.0 in steps of 0.1. Line height in px is `round(size × lineHeight)`. The terminal is validated to stay 1.0 without ligatures, because xterm draws cell by cell and its WebGL renderer cannot draw ligatures.
- Ligatures are Geist Mono's Stylistic Set 11 (`font-feature-settings: "ss11"`, `--*-features`). Other fonts ignore the set. Code blocks in the chat follow the editor's switch.
- The diff is one point smaller than the editor on purpose: side-by-side doubles the content per line.
- `View ▸ Increase font size` / `Decrease font size` / `Reset font size` (⌘+ / ⌘− / ⌘0) change only the focused surface.
- Changes apply live, without losing editor history or restarting the PTY. Old settings get the defaults on read.

<a id="interface-font"></a>
### Interface font and size

`Settings ▸ Appearance ▸ Interface`: `Font` (any family, with search; `System font` entry) and `Size` (stepper 8–24, default 13).

- `settings.interfaceFont`: `{family: string | null, size: 8…24}`, default `{family: null, size: 13}`.
- Only text scales. Every CSS font size is a token `--text-N` = `N px × --ui-scale`, with `--ui-scale` = size / 13. Icons, paddings, control and row heights do not change. A module never writes a raw `font-size` in px.
- Fixed-height rows get tight at large sizes. At 24 the task title touches the 48 px toolbar. This is a known limit.
- Window zoom (`setZoomFactor`) is not used: it would scale icons and code surfaces and break native browser bounds.

<a id="chat-text-size"></a>
### Chat text size

`Settings ▸ Appearance ▸ Chat ▸ Size` (after `Interface`, findable in Search Everywhere): a stepper with a 0.5 step and a range of 8–24.

- `settings.chatFont`: `{size: number | null}`. `null` (the default) follows the interface: 13.5 × interface size / 13. The stepper then shows that value. Changing it stores an own value, and a ghost button `Match interface` puts back `null`.
- N is the reply body size (`--text-chat`, 13.5 at design size). `--chat-scale` = N / 13.5 is set on `:root`. Under `[data-chat-text]` (the conversation in the column and in the Chat tab, Quick ask), `--ui-scale` becomes `--chat-scale`, so every `--text-*` and control font in the transcript, composer and rows above it scales. Body line heights scale with it.
- Popovers opened from the chat, the sidebar, toolbar, tabs, panel and modals keep the interface size.
- The intro's `Text size` sets the interface size and resets `chatFont.size` to `null`.

<a id="settings-form"></a>
## Settings form look

Every Settings tab except `Templates` uses the same parts (`SettingsSection`, `SettingsRow` in `renderer/SettingsForm.tsx`):

- a grey section title, then a card of rows split by thin separators, then an optional line under the card;
- labels in one right-aligned 132 px column, with the control starting at 154 px; radio options (`Task layout`, `Toolbar labels`) are rows of the same card;
- popups 200 px wide (long ones 240 px); numbers use the one `Stepper` at the row size;
- no static explanations. Under a control or a card there are only statuses, errors and warnings, and warnings are amber.

`ui/Controls` `Stepper` is the only number field. Typed digits stay a draft until Enter or blur, so a partial "1" of "16" is never clamped or saved. Arrow keys and the ▲▼ buttons act at once. Esc cancels the draft without closing the dialog.

<a id="i18n"></a>
## Languages

- Two UI languages: `en` and `uk`. `settings.language`: `'system' | 'en' | 'uk'`, default `system` (`settingsLocale` picks from the OS locale).
- `Settings ▸ Language ▸ Interface language` is a dropdown: `Follow system` / `Українська` / `English`. A dropdown, not radios, because more languages will come.
- The language applies after a restart, because native menus, context menus and message boxes are built in main once. After a change the tab shows `The language will change after restart.` and `Restart`. A remote device does not get the button. Restart waits for pending writes and goes through the unsaved-files guard, and a cancelled close cancels the restart. Restart is cheap: task hosts are detached and agents keep running.
- All visible text goes through the catalog in `packages/core/src/messages.ts`: `t(locale, key)`. The `uk` table is keyed by English text. The `english` table holds visible English where it differs from the key (for example `'Retry (turn)'` → `Retry`), so keys and stored fields never change for a new label.
- Ukrainian plurals always have four forms (`one`, `few`, `many`, `other`) through `Intl.PluralRules('uk')`, for example `draftCount`, `commitsAhead`. Numbers and dates go through `Intl` formatters.
- Not translated: terminal output, diff content, branch names, paths, logs. Git and CLI terms stay as they are or in their usual transliteration (`commit`/«коміт», `diff`, `hunk`, `branch`, `submodule`, `worktree`, `push`, `rebase`, `PR`, `repo`). The UI frame is localised, not the terms.
- The UI language and the agent protocol language are independent. Prompts and review framing that the app writes are always English. Text the person types is sent as is.
- Ukrainian strings run 15–30 % longer: no fixed widths on buttons, sidebar labels or segments.

<a id="ui-text-style"></a>
## UI text style

The rules live in [the UI copy guide](../ui-copy.md) (style) and [the glossary](../glossary.md) (terms in both languages). Read both before writing visible text.

- Short names and direct descriptions of what a function does, with the same meaning in UK and EN. Shared UI never ties a function to the Mac. Platform names appear only in platform actions.
- English follows applicable ASD-STE100: one word per meaning, active voice, present tense, imperative for actions, one action per sentence, no idioms, noun chains of 3 words or fewer, warnings before instructions. Git terms count as STE Technical Names. Natural short button phrases without articles are fine (`Open file`).
- Ukrainian uses a plain spoken register: no officialese, no verbal nouns, no passive. Buttons are infinitives («Надіслати» for `Send`), headings are nouns («Налаштування» for `Settings`). No exclamation marks or diminutives. One term per concept.
- Consequences, conditions and warnings are never shortened until their meaning is lost.

<a id="no-newbie-explanations"></a>
### No explanations of the obvious

- Empty states, tooltips and captions do not retell the obvious: what the agent "sees" or "can do", that Undo exists, how a visible button works, where an attachment goes. When such text goes, its markup (`<p>`, `<small>`, `title`, `footnote`, `note`) goes too, with no leftover gap.
- What stays: consequences (lost edits, GitHub, limits, rights), errors, and a next step the person really needs, cut to the point («Зміни зникнуть.» for `Changes will be lost.`, «Модель задачі не змінюється.» for `The task's model does not change.`). Setup steps for the phone stay.
- Identical texts share one key (`No matches`, `Optional`, `View only`, `Select a branch`, `Could not write the summary.`). Unused keys are deleted. `ChoiceButton` takes an optional `description`, and the intro `Section` an optional `sub`.

<a id="generate-actions"></a>
### Generate actions

- Every button that runs a one-shot agent call and puts the text into a field for editing is `ui/GenerateButton`: the `generate` glyph (a four-point spark, 12 px, `currentColor`) and the verb `Generate`. While busy, a `Spinner` replaces the glyph. A pencil means "I edit it myself" and is not used for these buttons.
- Labels: `Generate message`, `Generate the title and description` (visible EN `Generate title and description`), `Generating…`, `Generate again`, `Generate a summary`, `Generate from the drafts`, `Generate missing`. Every new agent-written text uses the same glyph and verb. A plain `Try again` / `Retry` stays for retries where the agent writes nothing (network, `gh`).
- The glyph is not accented. The helmet glyph means foreman and crew, not any agent call.

<a id="evolution-redesign"></a>
## Visual direction "Evolution"

The look builds on one system: the layout, `tokens.css`, `ui/` components and `ui/Glyph.tsx` glyphs. The direction sets details and token values on top of it. Some blocks keep their own established look: the Files tree with `ui/FileIcon`, the layout `Switches`, the diff with word marks and two number columns.

Where each part of the direction is specified:

| Part | File |
| --- | --- |
| Geist fonts, token values, `sel`, Kit | this file |
| Project icon (Lucide, picked by the agent) | [Projects](projects-and-board.md) |
| Quota rings, crew card, branch names, sidebar remote button | [Sidebar](sidebar.md) |
| Composer glass island, capsule, placeholder hints | [Composer](composer.md) |
| Chat spacing, quiet tool rows, code blocks, diff blocks in replies | [Chat](chat.md) |
| Editor tabs, change map, floating find | [Editor](editor.md) |
| Code selection, review footer | [Diff and review](diff-and-review.md) |
| Toolbar, Repos in the task header | [Task window](task-window.md) |
| Commit and conflicts dialogs | [Git](git.md) |
| PR review modal, New PR, PR row menu | [Pull requests and CI](pull-requests-and-ci.md) |
| Helper agent, per-action agents | [Agents and providers](agents-and-providers.md) |

Token values of this direction (already in the [palette](#core-palette)): light `--fg2` .60, `--fg3` .42, `--amber` `#a35200`, `--hover` .03; dark `--fg2` .62, `--fg3` .40; `--sel` soft accent; `--tint2` for press and counters.

<a id="selection-tones"></a>
### Selection tones

- `--sel` (soft accent under `--fg`): a selected row or card in a list, such as the sidebar task or a Search Everywhere result.
- `--accent-fill` under `--selfg` (solid): the selected file in the Files tree, the selected template in `Settings ▸ Templates`, a menu item under the pointer, a row chosen by keyboard. A solid fill means "list focus / keyboard choice".

<a id="kit"></a>
### Kit

`View ▸ Kit` (⇧⌘2; `Workspace` is ⇧⌘1) opens the `#kit` route (`renderer/Kit.tsx`). It shows the real components in light and dark columns side by side (`[data-palette]`):

- hover, press and focus states are drawn by the components' own styles: in `#kit`, `:hover`, `:active`, `:focus-visible` and `:focus-within` selectors also match `[data-kit-state]`;
- menus and popovers are the real `ui/Popover` and `MenuItem` in static form (`PopoverFrame`);
- containers such as `ModalDialog` (`divided`, large), `ListCard`, `OptionCard`, `Toast`, `Banner`, `NoticeChip` and `ConfirmDialog` with a hash chip;
- every token, the radii 4/12/14, the text sizes, `--chat-scale` and the three shadows.

The Kit holds no copies of components.

<a id="control-scale"></a>
## Control size scale

One size sets the height, padding, radius, font, icon, gap, box and switch of every control: `Button`, `IconButton`, `Popup`, `select`, `TextInput`, `TextArea`, `Stepper`, `Segments`, `Switch`, `Choice`, `Chip`, `Field`.

| Size | Height | Pad X | Radius | Font | Icon | Gap | Checkbox/radio | Switch | Segment radius |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S | 24 | 10 | 6 | `--text-12` | 14 | 5 | 14 | 28×16 | 4 |
| M (default) | 28 | 12 | 7 | `--text-13` | 16 | 6 | 16 | 34×20 | 5 |
| L | 32 | 14 | 8 | `--text-13` | 16 | 6 | 18 | 40×24 | 6 |
| XL | 40 | 18 | 10 | `--text-14` | 18 | 8 | 20 | 48×28 | 8 |

- Tokens: `--control-h-*`, `--control-px-*`, `--control-r-*`, `--control-fs-*`, `--control-icon-*`, `--control-gap-*`, `--control-box-*`, `--control-sw-w-*` / `-h-*`, `--control-seg-r-*`. `data-size="s|m|l|xl"` on a control or on a group publishes the working set `--c-h`, `--c-px`, `--c-r`, `--c-fs`, `--c-ic`, `--c-gap`, `--c-box`, `--c-sw-w`, `--c-sw-h`, `--c-seg-r`. No size means M.
- No control has a local `height`, `min-height`, `padding`, `border-radius` or `font-size` outside these tokens. There is no global `button { min-height }`.
- Where sizes go: S for actions in list rows (Files tree, tabs, sidebar, terminal, PR rows), counters and clickable chips. M for window, Diff and browser toolbars, the composer footer and its Send, Settings rows, dialogs, panel headers and sheet footers. L for text fields outside a button row (Search Everywhere, task name, commit message). XL for big intro buttons and `ChoiceButton`.
- API: `Button` `size?: 's'|'m'|'l'|'xl'`, `appearance?`, `variant?`, `disclosure?`, `opensPopover?`. `IconButton` adds `shape?: 'square'|'auto'` (square `h × h` by default; `auto` only for a chevron with caption or a glyph with counter), `hint`, `dot`, `dotAt`, `lost`. There is no `small` prop.

<a id="touch-targets"></a>
### Minimum target

- Every clickable control, hover area included, is at least 24 × 24 (`--control-min-target`). A glyph may be 14–16 px, but the button around it is not. If a row is shorter than the target, the row grows. There is no invisible hit zone.
- Exceptions: inline links inside running text (`FileLinks`, Markdown links, `ui/WebLink`) keep the text line height and carry `data-allow-small`. The turn rail marks are a scrubber, not separate targets.
- `Controls.test.tsx` checks that each size gives its token height, that the default is M, that no height is under 24, and that `small` does not exist.

<a id="appearance-variants"></a>
### Appearance and variant

`appearance`: `primary`, `neutral` (default), `warning`, `danger`, published as `--ap`, `--ap-fg`, `--ap-text`, `--ap-soft`, `--ap-line`. `variant` defaults to `solid` for primary and `soft` for the rest.

| Variant | Rest | Hover / press |
| --- | --- | --- |
| `solid` | fill `--ap` (neutral: `--fg` on `--win`), text `--ap-fg` (`--selfg`, `--on-amber`, `--on-red`) | `--segment-hover` / `--segment-press` layer |
| `soft` | soft fill (`--accent-soft`, `--amber-soft`, `--red-soft`, `--tint`), text in the appearance colour | same layers |
| `ghost` | no fill, text in the appearance colour (neutral `--fg2`) | soft fill; press adds `--segment-hover` |
| `outline` | no fill, 1 px inset edge and text in `--ap-line` at 45 % | becomes solid (`--ap` under `--ap-fg`); press adds `--segment-press` |

`outline` is for a destructive action that must not shout at rest (Archive's `Delete`).

<a id="control-states"></a>
### States

| State | Rule |
| --- | --- |
| Hover | a layer over the control's own fill (`background-image`), never a replacement; the fill never disappears |
| Pressed | the next step: `--segment-press` layer; no `scale` |
| Focus-visible | 2 px `--accent` outline, offset 2 (fields: 2 px `--accent` inset) |
| Disabled | `opacity: .4` (`--control-disabled`) and `pointer-events: none`; no own colours |
| Selected (`aria-pressed`, `aria-checked`, `aria-selected`, `data-selected`) | `--accent-soft` fill, `--accent` text |
| Opens a popover (`opensPopover`) | open stays neutral (`--tint`), not selected |
| Disclosure (`disclosure`) | open keeps the rest look; only the chevron turns |

<a id="fields"></a>
### Fields

- `Popup`, `select`, `TextInput`, `TextArea`, `Stepper` and `Field`: a `--tint` fill without a border, and a `--segment-hover` hover layer. Focus and the open state are a 2 px `--accent` inset ring on `--field`. `data-invalid` / `aria-invalid` is a 1 px `--red` inset ring, and the error text stays text. Focus never changes the field size.
- A composite field (composer, comment draft) lights its outer container. The inner input adds no second ring. `textarea` resize is off.
- The xterm hidden textarea, code text and web page fields in the built-in browser are not styled.

<a id="clear-field"></a>
### Clear button in search fields

`ui/ClearField`: every search or filter field shows a `×` (`Clear the field`) at its end while it has text. Clicking it clears the text and keeps focus in the field (a panel search that closes on blur stays open). Escape keeps its own meaning. An empty field has no button, and its hint (`⌘F` in the Files filter) comes back.

- Look: a 16 px circle in `--fg3` with an `×` in the field colour; hover and focus `--fg2`, press `--fg`. It sits inside the field, after the text and before any counter.
- Used in: sidebar task filter, Files filter, `ui/PanelSearch` (Changes and PR panels), Search Everywhere, text-search mask, Archive, keymap search, branch searches (branch picker, merge, searchable `Popup`), font pickers, and the in-view `⌘F` search.
- The native `::-webkit-search-cancel-button` is not used: it exists only for `type="search"` and does not follow tokens.

<a id="segments"></a>
### Segments

- `Segments`: the container has the size height and an inner padding of 2. The track is `--tint`. The chosen segment, and its sliding indicator, is `--segment-on` with `--segment-on-shadow`. In dark, `--segment-on` is a white 12 % layer with a 0.5 px light rim, so the choice reads on any surface. Hover of an unchosen segment is `--segment-hover`.
- Tab-style segments (`data-tabs`, accent) and underlined tabs (`data-underline`) keep their own selected look.
- Labelled panel segments in the toolbar (Files / Changes / PR) use normal segment padding, not `iconOnly`.
- The whole `Segments`, indicator and SVG children included, is `-webkit-app-region: no-drag`. `pointer-events: none` does not remove an element from Electron's native drag regions.

<a id="one-row-one-height"></a>
## One row, one height

- Controls side by side in one row (button, icon button, `Esc`, field, dropdown, segments, stepper) have one height: the row's size on the [scale](#control-scale).
- The row declares the size (`data-size` on the header, toolbar or footer). Controls in it set none. When a row grows (text became a field, a button appeared), all its controls follow.
- `PopupClose` has no size of its own. In a row with `data-size` it takes the row's size (sheet header and Search Everywhere L 32, Archive and crew editor M 28). In a header with only a title it is S 24. The composer options menu header declares M.
- The composer action row is M with Send M 28. A deliberate mixed row is marked `data-row-mixed` and its reason written in the spec.
- Text fields measure by their wrapper, not the inner `input`.

<a id="one-look-one-component"></a>
## One look, one component

- An element that looks the same everywhere (button, split button, menu with header and Esc, card, chip, list row, counter, empty state, loading state) is one component in `renderer/ui/`.
- Before writing a new control, look for an existing one in `ui/` and extend a similar one with a prop. Feature CSS sets placement only (margins, place in a row), never the control's look.
- A second copy of the same look is moved into `ui/` in the same change.
- Examples of shared components: `Controls` (`Button`, `IconButton`, `SplitButton`, `ChoiceButton`, `Popup`, `Segments`, `Switch`, `Stepper`, `Chip`, `Field`), `Input`, `Popover`, `PopupClose`, `ModalDialog`, `ConfirmDialog`, `DocumentDialog`, `ClearField`, `GenerateButton`, `Loading`, `ChangeCounts` (`+N −M` with tooltip, used everywhere), `NoticeChip`, `Banner`, `Toast`, `ListCard`, `OptionCard`, `SpotBadges`.
- `Popup` menus use `ui/Popover` metrics (padding 5, item 0 8), so all menus look the same. `Chip` with `warning` uses the `NoticeChip` look, so there is one amber pill.

<a id="split-button"></a>
### Split button

`ui/SplitButton` (`Controls.tsx`) is one capsule with the size radius. The main action and the second part are split by a 1 px line (`--sep`; on a fill, the text colour at 28 %). The second part is a 24 px chevron with `aria-haspopup="menu"`, or a square glyph for a variant of the same action. Hover and press light the whole capsule, and the focus ring goes round the capsule. An open menu keeps the chevron pressed. Without a second part it is a plain button. The menu comes in the `menu` prop, anchored to the capsule.

<a id="popover"></a>
## Popover, menus and Esc

<a id="popover-shell"></a>
### `ui/Popover`

`Popover` is the shell of every popover that hangs on a button:

- It sits in the top layer (`popover`), placed from the anchor and flipping to the side with room, 8 px from the window edge. It animates in and out (`usePresence`). In the DOM it sits where its button is, so it resets inherited text (`white-space`, weight, size).
- Look: `--card`, 1 px `--sep`, radius 9, padding 5, `--shadow-menu`. Content sits 13 px from the edge (5 + 8), like the title and menu rows. Sizes `s`, `m`, `l`.
- Header (`PopupHeader`): title 12/600 `--fg` and `Esc`. Props: `title`, `note` (grey caption after the title, for example `Worktree · from main`), `heading` + `headerSize` (controls instead of the title, at the row size), `headerExtra`.
- Body: scrolls under a fixed header. `overflow="visible"` is for a body that holds its own dropdown (a `Popup`), where Esc closes only that list.
- Focus props: `initialFocus`, `focusOnOpen={false}` (a notice that opens by itself), and `returnFocus` (when the popover is placed by a wider block than its trigger).
- `closeOnScroll`: a scroll under it closes a menu, while a dialog popover follows its anchor.
- `arrow`, `closeOnFocusOut`: for hover popovers.
- `role`: `dialog` or `menu`.

`useDismiss` is the one close logic:

- Esc on `document` in the capture phase closes only the topmost open popover, before any dialog under it.
- A press outside the anchor and the popover closes it, and so does a scroll under it (see above). Reasons: `escape`, `outside`, `select`, `tab`, `scroll`, `close`.
- Focus returns to the anchor after Esc, after a choice or after the Esc button, unless the choice moved focus itself (a field, a confirm row). A click elsewhere does not take focus.

<a id="menus"></a>
### Menus

`MenuPopover`, `MenuList`, `MenuItem`, `MenuSection`, `MenuSeparator`, `MenuInfo` build menus on the shell:

- `role=menu`. ↑/↓ wrap around, Home/End jump, Tab closes. On open, focus goes to the first item, or to the chosen one in a choice menu.
- Item kinds: action, `menuitemradio` / check (an 11 px tick on the left; the column exists only when the menu has a choice), icon in `--fg2`, second line (row XL 40), shortcut, counter, disabled with its reason under it, danger in `--red`.
- Rows are M 28. Hover and keyboard focus are one fill, `--accent-fill` under `--selfg`, never two at once. Items have no focus ring.
- A popup of rows with their own buttons (project commands) uses `Popover`, not a menu.
- Context menus on list rows stay native (`Menu.popup`); see [Menus](search-menus-and-commands.md).

<a id="hover-popovers"></a>
### Hover popovers

`useHoverPopover` (context meter, subscription limits):

- Hovering, or focusing by keyboard, opens a preview, and a click pins it.
- The pointer has 120 ms to cross to the popover, which closes 120 ms after the pointer leaves unless pinned. Focus coming back after Esc does not reopen it.
- These popovers have an `arrow` on the edge facing the button, centred on it, and close when focus moves outside (`closeOnFocusOut`). They still have a header with Esc.

<a id="popup-close"></a>
### Esc in every modal header

- Every modal surface (popover, launch sheet, confirmation dialog, settings, search) has `ui/PopupClose` in its header. It is the text `Esc` on a transparent background, with no border or shadow at rest, the shared hover (`--segment-hover`) and motion, and the keyboard focus ring.
- Its accessible name is the localised `Close`, with the tooltip `Close (Esc)` and `aria-keyshortcuts="Escape"`. A click and Escape both close the surface and return focus.
- On the phone (`touch`) it is a × in a 44 px target with a 28 px tint circle.
- Footer actions with meaning (Cancel, Delete, Save) stay as they are. OS dialogs stay native.
- Every open `dialog` and `:popover-open` element is `-webkit-app-region: no-drag`, so macOS does not take clicks on an `Esc` that overlaps the toolbar's drag region.

<a id="focus-ring"></a>
## Focus ring

- The `:focus-visible` ring is drawn only on controls: buttons, `a[href]`, inputs, `textarea`, `select`, `summary`, editable regions, and roles `button`, `link`, `tab`, `option`, `radio`, `checkbox`, `switch`, `menuitem*`, `treeitem`, `row`, `gridcell`, `slider`, `separator`, `combobox`, `spinbutton`.
- Containers (scrollers, the log, lists, a popup `listbox`, panel roots) still take focus for keyboard scrolling and focus return, but draw no ring.
- The rule is global in `tokens.css` under `:where(...)` (zero specificity), so a module's own `:focus-visible` (simulator screen, project cards) wins.
- Why: Chromium makes every scroller without focusable children focusable, and a programmatic `focus()` after a key press also turns on `:focus-visible`.
- A row that lights up whole and pills use `--ring-soft`. `[data-focused-row]` is a 2 px inset accent outline on `--accent-soft`.

<a id="hover"></a>
## Hover

- Every interactive element has a hover state (and pressed and selected, where it has them). The hover covers the same area as the active or selected state: if the whole row is selected, the whole row is hovered (name, second line, empty space). Nested buttons sit on top with their own hover.
- Sections leave no empty padding under their last row: the row fill reaches the separator.
- The default button hover is `background-image: linear-gradient(var(--segment-hover), …)` on top of the button's own fill (`button:hover` in `tokens.css`), and press uses `--segment-press`. A module's own `.x:hover { background: … }` (specificity 0,2,0) replaces it whole. A plain `background` in the global rule would beat a module's single class and make filled buttons see-through, which is why the layer is a `background-image`.
- `tests/button-hover.spec.ts` checks that a visible, enabled, filled button keeps its fill under the pointer.

<a id="motion"></a>
## Motion

The UI moves: segment indicators slide between options, menus, dialogs and comments appear smoothly, expanding has a transition, and buttons react.

| Token | Value |
| --- | --- |
| `--motion-fast` | 120 ms (colour transitions on buttons) |
| `--motion-enter-time` | 180 ms |
| `--motion-travel` | 240 ms |
| `--motion-ease` | `cubic-bezier(0.2, 0.8, 0.2, 1)` |
| `--motion-enter` / `--motion-reveal` / `--motion-fade` | rise 6 px / clip reveal / fade |

- Durations and easing belong to the shared tokens (`ui/motion.ts` reads them in JS). Features use no `transition: all` and no ad-hoc easings.
- Actions run at once and never wait for an animation. A quick repeat interrupts a transition from its current state.
- `dialog` fades and rises 8 px in, with `@starting-style` and `allow-discrete` for exit.
- `prefers-reduced-motion: reduce` sets all durations to 0 and removes spatial animation. Spinners slow to 2.4 s.
- Not animated: code, native selection, scrolling, focus, native browser bounds, virtualised rows on scroll, and streamed tokens.

<a id="dialogs"></a>
## Dialogs

- `ui/ModalDialog` is the one modal shell: a header (optional Back, title, `headerExtra`, `Esc`), a body, and a footer of actions on `--tint`. It defaults to 460 wide, 96 from the top, and puts focus on `initialFocus` and back on close. Options: `large`, `note`, `icon`, `radius`, and `divided` (a line under the header, title 13/600, header padding 12/16). `RenameTask` and `ui/DocumentDialog` use the divided form. No feature ships its own `<dialog>` with copied styles.
- Footer buttons are `Button` M soft. The scrim is `--modal-scrim`, and the shadow is `--shadow-modal`.
- `ui/ConfirmDialog` is for confirmations. While a save or action runs, Esc does not close and Cancel is disabled (Rename behaves the same while `Saving…`). A commit hash in its text is a chip (`.body code`: `--tint`, padding 1/4, radius 4). `ConflictsDialog`'s `.sha` uses the same look. File names in confirmation text are `<strong>`.
- Native message boxes all go through `main/client-ui.ts` with `noLink: true`, so on Windows custom buttons (`Delete task`, `Discard changes`, Ukrainian labels) stay buttons and do not become command links.
- Surfaces without their own design (attachment preview, network request detail) use the shared sheet geometry: header, scrolling body, footer, scrim. Dialogs never show options that do not work yet.
- A stale answer to an earlier request (for example a range pick) never overwrites a newer choice. Renderer and main both drop completions of superseded requests.
- Content previews: the image viewer centres its counter, has a 16 px header on the right and pixel sizes at 10 px, uses `--term` for the tile background and reserves 46 px OS buttons on Windows. Tiles that are still loading are a static placeholder, without flicker. `Response body was truncated.` is muted `--fg2` text.

<a id="loading"></a>
## Loading states

- Content that is loading never shows bare text such as "Loading…" in its place. A skeleton of the same shape stands there instead (`ui/Loading`):
  - lists, sidebar sections and data menus: `SkeletonRows` at the real row height;
  - boards (Tasks, Pull requests): `SkeletonBoard`, columns with headers and 2–3 `SkeletonCard`s at real card height;
  - cards, panels, PR Overview, diffs: `Skeleton` / `SkeletonText` bars in the layout of the real block.
- Text appears only where a long wait needs a reason (GitHub, a first index): a small `Spinner` plus a short label under the skeleton (`LoadingPlaceholder`, `LoadingStatus`), not instead of it. Inline actions show a `Spinner` in the control itself (`GenerateButton busy`).
- No flashing: a skeleton appears only after `LOADING_DELAY` = 150 ms (`useDelayed`, `Delayed`), and cached data shows at once. The pulse is quiet and stops with reduced motion.
- New shapes go into `ui/Loading`, not into a feature.

<a id="tooltips"></a>
## Tooltips

Tooltips are the OS tooltip (`title`). There is no custom tooltip component. `IconButton` uses `hint` (for example a name with its shortcut) as the tooltip and keeps `label` as the accessible name.

<a id="component-details"></a>
## Shared details

- Quota button in the sidebar footer: the row's size (M 28), with no `size` of its own. It is ghost, and its hover and open state are both `--tint` (`opensPopover`). Its popover has an `arrow` (see [Sidebar](sidebar.md)).
- The countdown in a limit card is 11 px `--fg2` with tabular figures and does not shrink.
- `Details` in the sign-in card is a disclosure: only the chevron changes. `Sign in…` in Settings, in the intro and in the chat card share one handler and one error toast, `The sign-in could not start.`
- Agent state text is built by one function in core. An install command shows on `--code` with a `--hair` inset edge, mono 11.

<a id="later"></a>
## Later

- Code ligatures in the terminal (needs an xterm ligatures addon; the WebGL renderer ignores `font-feature-settings`).

<a id="non-goals"></a>
## Non-goals

- Whole-window zoom (`setZoomFactor`) instead of the interface text size.
- A separate font family for the chat or for headings, and percentage scales. Every size is set in px.
- Bundling fonts other than Geist and Geist Mono (Nerd Fonts and others come from the installed list). SF Pro / SF Mono cannot be bundled and do not exist off macOS.
- Red, orange or green accents. The project dots do not follow the accent.
- Live language switching without a restart. A half-translated window (native menus and dialogs left in the old language) is worse than none.
- A custom tooltip component.
- A font preview line in Settings.
- Extra hit zones around small glyphs. The row grows instead.
