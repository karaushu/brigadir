# Design tokens

Reference of the CSS custom properties that style Brigadir's renderer. The source of truth is
`electron/apps/desktop/src/renderer/tokens.css`; the phone client adds touch overrides in
`electron/apps/desktop/src/renderer-mobile/mobile.css`, and a few values are set at run time by
`renderer/apply-appearance.ts`. This file lists names and values; the rules for using them are in
[Appearance](spec/appearance.md#design-tokens).

Code uses token **names**, never their values. Feature CSS does not hardcode a colour or shadow, and a control takes
its size from the [control scale](#control-scale), never from a local `height`, `padding` or `font-size`.

## How tokens switch

| Attribute or condition | Set by | Effect |
| --- | --- | --- |
| `:root` | — | light values, the default |
| `:root[data-theme='dark']` | `useApplyAppearance` from `settings.appearance` | dark values |
| `[data-palette='light' \| 'dark']` | the Kit (`View ▸ Kit`) | one theme inside a subtree, so both themes show side by side |
| `:root[data-accent='…']` | `useApplyAppearance` from `settings.accent` | accent values ([Accent](#accent)) |
| `:root[data-accent-text='dark']` | `useApplyAppearance` for the `system` accent | dark `--selfg` on a light OS accent |
| `:root[data-code-theme='brigadir' \| 'vscode' \| 'intellij']` | `useApplyAppearance` from `editor.codeTheme` | syntax colours ([Syntax](#syntax)) |
| `:root[data-syntax-styles='off']` | `useApplyAppearance` | no bold keywords or italic comments |
| `:root[data-platform='win32' \| 'linux']` | main | OS caption-button overlay tokens |
| `:root[data-touch]` | the phone client | touch sizes ([Phone](#phone)) |
| `[data-size='s' \| 'm' \| 'l' \| 'xl']` | a control or a row | the working control set `--c-*` |
| `[data-appearance='…']` | a control | the appearance set `--ap-*` |
| `@media (prefers-contrast: more)` | the OS | stronger filled warning and danger, darker or lighter comments |
| `@media (prefers-reduced-motion: reduce)` | the OS | motion durations 0 ([motion.md](motion.md)) |

## Surfaces and text

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--win` | `#ffffff` | `#1e1e1e` | window background |
| `--content` | `#ffffff` | `#1e1e1e` | content area |
| `--tb` | `#e9e9eb` | `#2c2c2e` | grey toolbar tone (the top strip itself uses `--strip-bg`) |
| `--sb` | `#f2f2f4` | `#232323` | sidebar |
| `--card` | `#ffffff` | `#2a2a2a` | cards, popovers, menus |
| `--field` | `#ffffff` | `#1e1e1e` | a focused or open field |
| `--strip-bg` | `var(--win)` | `var(--win)` | the window's top strip; the OS caption buttons follow it |
| `--sep` | `#dcdcde` | `#3a3a3c` | separators, default borders |
| `--hair` | `rgba(0,0,0,.07)` | `rgba(255,255,255,.07)` | hairline inside a surface |
| `--fg` | `rgba(0,0,0,.85)` | `rgba(255,255,255,.87)` | primary text |
| `--fg2` | `rgba(0,0,0,.6)` | `rgba(255,255,255,.62)` | secondary text |
| `--fg3` | `rgba(0,0,0,.42)` | `rgba(255,255,255,.4)` | tertiary text, placeholders |
| `--tint` | `rgba(0,0,0,.045)` | `rgba(255,255,255,.06)` | soft fill, field background |
| `--tint2` | `rgba(0,0,0,.08)` | `rgba(255,255,255,.1)` | pressed fill, counters |
| `--tint-ink` / `--tint-a` | `#000000` / `4.5%` | `#ffffff` / `6%` | `--tint` as ink and strength, to mix an opaque colour |
| `--hover` | `rgba(0,0,0,.03)` | `rgba(255,255,255,.035)` | neutral row hover |
| `--tray` | `--win` at 70 % | `rgba(0,0,0,.22)` | lighter tray inside a card |
| `--code` | `rgba(0,0,0,.04)` | `rgba(255,255,255,.05)` | code block surface |
| `--term` | `#f6f6f7` | `#141414` | terminal and image viewer surface |
| `--knob` | `#ffffff` | `#ffffff` | switch knob on any fill |
| `--modal-scrim` | `rgba(0,0,0,.42)` | `rgba(0,0,0,.42)` | modal backdrop |

`:root` also sets `color-scheme` to `light` or `dark`, `font-family: var(--ui-family)`, `font-size: var(--text-13)`,
`color: var(--fg)` and `background: var(--win)`.

## Status colours

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--amber` | `#a35200` | `#ff9f0a` | warning, "needs you" |
| `--amber-text` | `#a35200` | `#ff9f0a` | amber text and outline edge |
| `--amber-soft` | `rgba(163,82,0,.1)` | `rgba(255,159,10,.13)` | soft warning fill |
| `--amber-soft-a` | `10%` | `13%` | `--amber-soft` strength, for opaque mixes |
| `--amber-hover` / `--amber-press` | `rgba(163,82,0,.17)` / `.25` | `rgba(255,159,10,.22)` / `.3` | hover and press on amber |
| `--red` | `#d70015` | `#ff453a` | danger, destructive actions |
| `--red-soft` | `rgba(215,0,21,.08)` | `rgba(255,69,58,.14)` | soft danger fill |
| `--green` | `#1a7f37` | `#32d74b` | success, added, approve |
| `--green-soft` | `rgba(26,127,55,.1)` | `rgba(50,215,75,.14)` | soft success fill |
| `--purple` | `#8250df` | `#bf5af2` | merged state |
| `--purple-soft` | `rgba(130,80,223,.12)` | `rgba(191,90,242,.16)` | soft purple fill |

Filled warning and danger keep at least 4.5 : 1 with their text, also with high contrast on:

| Token | Light | Dark | High contrast light | High contrast dark |
| --- | --- | --- | --- | --- |
| `--amber-fill` | `#a35200` | `#ff9f0a` | `#8a4600` | `#ffb340` |
| `--on-amber` | `#ffffff` | `rgba(0,0,0,.85)` | `#ffffff` | `rgba(0,0,0,.85)` |
| `--red-fill` | `#d70015` | `#d4322a` | `#b3000f` | `#b52a22` |
| `--on-red` | `#ffffff` | `#ffffff` | `#ffffff` | `#ffffff` |

## Accent

The accent comes from `settings.accent` ([Accent](spec/appearance.md#accent)). Named accents are set in
`tokens.css`; only `system` sets `--accent` inline from the OS colour.

| Token | Value | Use |
| --- | --- | --- |
| `--accent` | per accent | text, lines, borders and small marks on a surface |
| `--accent-fill` | `var(--accent)` unless the accent sets it | fills under `--selfg`: primary button, switch on, checked box, active menu item |
| `--selfg` | per accent | text and marks on `--accent-fill` |
| `--accent-opacity` | `14%` light, `20%` dark (yellow `18%` light) | strength of `--accent-soft` |
| `--accent-soft` | `--accent-fill` mixed at `--accent-opacity` | soft selected and pressed fill |
| `--sel-opacity` | `12%` light, `22%` dark | strength of `--sel` |
| `--sel` | `--accent` mixed at `--sel-opacity` | a selected row or card in a list, under `--fg` |
| `--accent-text` | `--accent` light; `--accent` 78 % with white in dark | small accent text on `--card` |
| `--ring-soft` | `0 0 0 2px` `--accent` at 55 % | keyboard focus of a pill or a whole row |

| `data-accent` | Light `--accent` | Light `--accent-fill` | Dark `--accent` / fill | `--selfg` |
| --- | --- | --- | --- | --- |
| `system` | OS colour, default `#0064e1` | = accent | OS colour, default `#0a84ff` | `#ffffff`, or `rgba(0,0,0,.85)` with `data-accent-text='dark'` |
| `blue` | `#0064e1` | `#0064e1` | `#0a84ff` | `#ffffff` |
| `indigo` | `#5856d6` | `#5856d6` | `#7d7aff` | `#ffffff` |
| `purple` | `#9a3fc8` | `#9a3fc8` | `#bf5af2` | `#ffffff` |
| `pink` | `#d0357a` | `#d0357a` | `#ee4f94` | `#ffffff` |
| `teal` | `#0a7d93` | `#0a7d93` | `#40c8e0` | `#ffffff` light, `rgba(0,0,0,.85)` dark |
| `yellow` | `#946d00` | `#f5bd00` | `#f8c500` | `rgba(0,0,0,.85)` |
| `graphite` | `#6e6e73` | `#6e6e73` | `#8a8a8f` | `#ffffff` |

`--swatch-blue`, `--swatch-indigo`, `--swatch-purple`, `--swatch-pink`, `--swatch-teal`, `--swatch-yellow` and
`--swatch-graphite` hold each accent's fill in the current theme for the accent picker.

## Controls

### Control scale

One size sets every dimension of a control ([Control size scale](spec/appearance.md#control-scale)).

| Size | `--control-h-*` | `--control-px-*` | `--control-r-*` | `--control-fs-*` | `--control-icon-*` | `--control-gap-*` | `--control-box-*` | `--control-sw-w-*` × `--control-sw-h-*` | `--control-seg-r-*` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `s` | 24px | 10px | 6px | `--text-12` | 14px | 5px | 14px | 28 × 16px | 4px |
| `m` | 28px | 12px | 7px | `--text-13` | 16px | 6px | 16px | 34 × 20px | 5px |
| `l` | 32px | 14px | 8px | `--text-13` | 16px | 6px | 18px | 40 × 24px | 6px |
| `xl` | 40px | 18px | 10px | `--text-14` | 18px | 8px | 20px | 48 × 28px | 8px |

- `data-size` publishes the working set `--c-h`, `--c-px`, `--c-r`, `--c-fs`, `--c-ic`, `--c-gap`, `--c-box`,
  `--c-sw-w`, `--c-sw-h`, `--c-seg-r`. Without `data-size` the set is `m`.
- `--control-disabled: 0.4` is the opacity of a disabled control.
- `--control-min-target: 24px` is the smallest clickable target.
- `--strip-h: 48px` is the height of the window's top strip (sidebar header, task toolbar, project header, caption
  buttons).

### Appearance

`data-appearance` publishes `--ap` (fill), `--ap-fg` (text on the fill), `--ap-text` (text without a fill),
`--ap-soft` (soft fill) and `--ap-line` (outline text and edge).

| `data-appearance` | `--ap` | `--ap-fg` | `--ap-text` | `--ap-soft` | `--ap-line` |
| --- | --- | --- | --- | --- | --- |
| `primary` | `--accent-fill` | `--selfg` | `--accent` | `--accent-soft` | `--accent` |
| `neutral` | `--fg` | `--win` | `--fg` | `--tint` | `--fg2` |
| `warning` | `--amber-fill` | `--on-amber` | `--amber` 72 % with `--fg` | `--amber-soft` | `--amber-text` |
| `danger` | `--red-fill` | `--on-red` | `--red` 72 % with `--fg` | `--red-soft` | `--red` |

### States and segments

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--segment-hover` | `rgba(0,0,0,.055)` | `rgba(255,255,255,.07)` | hover layer on any button or field |
| `--segment-press` | `rgba(0,0,0,.09)` | `rgba(255,255,255,.11)` | pressed layer |
| `--segment-on` | `var(--card)` | `rgba(255,255,255,.12)` | the chosen segment |
| `--segment-on-shadow` | `0 1px 2px var(--shadow)` | the same plus `inset 0 0 0 0.5px rgba(255,255,255,.07)` | the chosen segment's lift |

The global `button:hover` and `button:active` rules draw these as a `background-image` layer over the button's own
fill ([Hover](spec/appearance.md#hover)). `Segments` sets `--segment-x`, `--segment-width` and `--segment-height`
on its group to place the sliding indicator.

## Shadows

| Token | Light | Dark |
| --- | --- | --- |
| `--shadow` | `rgba(0,0,0,.18)` | `rgba(0,0,0,.45)` |
| `--shadow-menu` | `0 10px 30px var(--shadow)` | same |
| `--shadow-modal` | `0 16px 48px var(--shadow)` | same |
| `--shadow-float` | `0 8px 24px var(--shadow)` | same |
| `--lift` | `0 0 0 0.5px rgba(0,0,0,.12), 0 4px 18px rgba(0,0,0,.08)` | `0 0 0 0.5px rgba(255,255,255,.12), 0 6px 22px rgba(0,0,0,.45)` |

`--shadow-menu` is for menus and popovers, `--shadow-modal` for modals and sheets, `--shadow-float` for toasts and
floating panels, `--lift` for a floating card.

## Typography

### Families

| Token | Value |
| --- | --- |
| `--ui-family` | `'Geist', -apple-system, 'SF Pro Text', system-ui, sans-serif`; a family chosen in Settings goes first |
| `--mono-family` | `'Geist Mono', ui-monospace, 'SF Mono', Menlo, monospace` |

Geist and Geist Mono are bundled ([Bundled Geist](spec/appearance.md#bundled-fonts),
[third-party assets](third-party-assets.md#fonts)).

### Interface text sizes

Every interface font size is a `--text-N` token: `calc(N px × --ui-scale)`. `--ui-scale` is the interface size
divided by 13 ([Interface font](spec/appearance.md#interface-font)).

| Token | Size at scale 1 |
| --- | --- |
| `--text-7` … `--text-10` | 7, 8, 9, 10 px |
| `--text-10-5` | 10.5 px |
| `--text-11` | 11 px |
| `--text-11-5` | 11.5 px |
| `--text-12` | 12 px |
| `--text-12-5` | 12.5 px |
| `--text-13` | 13 px, the body size |
| `--text-chat` | 13.5 px, the chat's body |
| `--text-14`, `--text-15`, `--text-19`, `--text-20` | 14, 15, 19, 20 px |

- `--chat-scale` is the chat size divided by 13.5 ([Chat text size](spec/appearance.md#chat-text-size)). Under
  `[data-chat-text]`, `--ui-scale` becomes `--chat-scale`; a popover inside it goes back to `--interface-scale`.
- The text tokens are declared again on every root that scales differently, because a custom property with `var()`
  is computed where it is declared.

### Code surfaces

`useApplyAppearance` sets these for each of `terminal`, `diff` and `editor` from `settings.typography`
([Code surfaces](spec/appearance.md#code-typography)):

| Token | Value |
| --- | --- |
| `--{surface}-family` | the chosen family, or Geist Mono |
| `--{surface}-size` | size in px (defaults: terminal 13, diff 11, editor 12) |
| `--{surface}-line` | `round(size × lineHeight)` px (defaults: terminal 13, diff 18, editor 19) |
| `--{surface}-ligatures` | `normal` or `none` |
| `--{surface}-features` | `"ss11" 1` with ligatures on, otherwise `normal` |
| `--terminal-weight` | the terminal font weight, default 400 |

## Syntax

The code theme recolours only syntax tokens of the editor and the diff. Seven token kinds are drawn by the
`.syntax-*` classes ([Syntax highlighting](spec/editor-code-intelligence.md#syntax-highlighting)).

| Token | Brigadir light | Brigadir dark | VS Code light | VS Code dark | IntelliJ light | IntelliJ dark |
| --- | --- | --- | --- | --- | --- | --- |
| `--syntaxKeyword` | `#a626a4` | `#d9a0df` | `#0000ff` | `#569cd6` | `#0033b3` | `#cf8e6d` |
| `--syntaxString` | `#27702d` | `#a9d38c` | `#a31515` | `#ce9178` | `#067d17` | `#6aab73` |
| `--syntaxComment` | `#727272` | `#929292` | `#008000` | `#6a9955` | `#8c8c8c` | `#7a7e85` |
| `--syntaxNumber` | `#965800` | `#eab776` | `#098658` | `#b5cea8` | `#1750eb` | `#2aacb8` |
| `--syntaxType` | `#006b80` | `#75d3db` | `#267f99` | `#4ec9b0` | `#000000` | `#bcbec4` |
| `--syntaxFunction` | `#005cc5` | `#85bfff` | `#795e26` | `#dcdcaa` | `#00627a` | `#56a8f5` |
| `--syntaxProperty` | `#874411` | `#e1b38a` | `#001080` | `#9cdcfe` | `#871094` | `#c77dbb` |

- With high contrast on, `--syntaxComment` is `#555555` light and `#b0b0b0` dark in every code theme.
- Unless `data-syntax-styles='off'`, keywords are bold and comments italic, with `font-synthesis: none`
  ([Font styles](spec/editor-code-intelligence.md#font-styles)).
- `--codeSwatch-{theme}-{1…5}` (themes `brigadir`, `vscode`, `intellij`) hold five sample colours per theme and theme
  mode for the code theme picker: keyword, string, function, type, comment.

## Diff

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--diffAddedBg` | `#e6f7ea` | `#16351f` | added line background |
| `--diffRemovedBg` | `#fdeaec` | `#3a1a1d` | removed line background |
| `--diffAddedFg` | `#1a7f37` | `#3fb950` | `+` sign and `+N` counts |
| `--diffRemovedFg` | `#cf222e` | `#f85149` | `−` sign and `−N` counts |
| `--diffGutter` | `#fafafa` | `#181818` | gutter background |

## Fixed palettes

These palettes never follow the accent and avoid the status red, amber and the selection blue where they mark
identity.

| Group | Tokens | Notes |
| --- | --- | --- |
| Project dots | `--project-0` … `--project-8` | light `#8e44ad #0f8f88 #7c8f1a #c2337f #2e8b45 #a68a00 #5f7a92 #8c6444 #6b6fc2`; dark `#bf5af2 #3ad4cb #c8dc46 #f26cad #4fcf7a #e6c23a #9cb0bd #c99a76 #a8abf0` |
| Project icon colours | `--icon-red` `#ef4444`, `--icon-orange` `#f59e0b`, `--icon-yellow` `#eab308`, `--icon-green` `#22c55e`, `--icon-teal` `#14b8a6`, `--icon-blue` `#3b82f6`, `--icon-purple` `#8b5cf6`, `--icon-pink` `#ec4899`, `--icon-gray` `#71717a` | one palette in both themes; the tile is the colour at 16 % ([Project icon](spec/projects-and-board.md#project-icon)) |
| Avatars | `--avatar-0` … `--avatar-5` (`#2f9e44 #d9480f #9c36b5 #1971c2 #c2255c #0c8599`), `--avatar-fg` `#ffffff` | PR author avatars, both themes |
| Files tree | `--tree-guide`, `--tree-guide-on`, `--tree-ignored` | light `rgba(0,0,0,.07)`, `.42`, `.42`; dark `rgba(255,255,255,.07)`, `.4`, `.4` |
| File types | `--ft-ts`, `--ft-tsfill`, `--ft-react`, `--ft-js`, `--ft-jsfill`, `--ft-json`, `--ft-md`, `--ft-docker`, `--ft-git`, `--ft-env`, `--ft-rc`, `--ft-yml`, `--ft-img`, `--ft-sh`, `--ft-lock`, `--ft-lib`, `--ft-tstext`, `--ft-jstext` | `ui/FileIcon` colours, each with a light and a dark value (`--ft-tstext` and `--ft-jstext` are light-only) |

## Other tokens

| Token | Value | Use |
| --- | --- | --- |
| `--find-hit` | `rgba(255,200,61,.45)` | a find match in the log, both themes |
| `--find-current` / `--on-find` | `#ffc83d` / `#1b1b1f` | the current find match and its text |
| `--introGlint` | `rgba(255,255,255,.7)` | the light over the helmet in the intro |
| `--providerClaude` | `#d97757` | the Claude provider mark |
| `--deck-fade` | `1` light, `0.6` dark | the second stripe of a collapsed crew deck |
| `--column-ink` / `--column-rest` / `--column-hover` | `#000000` / `0.5` / `0.85` light; `#ffffff` / `0.55` / `0.87` dark | Layout glyphs: one opaque colour with the glyph's opacity |
| `--os-controls-right`, `--os-strip` | from the Window Controls Overlay; `--strip-h` | Windows and Linux only: room for the OS caption buttons |

## Motion

`--motion-fast`, `--motion-enter-time`, `--motion-travel`, `--motion-ease`, `--motion-enter`, `--motion-reveal` and
`--motion-fade`. Values and rules are in [motion.md](motion.md).

## Radii

Radii are literal px values, not tokens, except for controls, which use `--c-r` and `--c-seg-r` from the
[control scale](#control-scale). The Kit shows the scale in use: 3, 4, 5, 6, 7, 8, 9, 10, 11 px. Shared components
fix their own radius, for example `ui/Popover` and `ui/ListCard` 9 px, `ui/ModalDialog` 11 px, `ui/NoticeChip` 12 px.

## Phone

`mobile.css` imports `tokens.css` and adds, under `:root[data-touch]`:

- touch sizes for `l` (44 px high, 16 px padding, radius 12, `--control-fs-l: 15px`, icon 20, switch 51 × 31) and
  `xl` (50 px high, radius 14, `--control-fs-xl: 16px`), and `--control-min-target: 44px`;
- `--safe-top`, `--safe-bottom` from the safe-area insets, and `--gutter: 16px`;
- the diff text at phone scale: `--diff-family: var(--mono-family)`, `--diff-size: 12.5px`, `--diff-line: 19px`,
  `--diff-ligatures: none`;
- phone-only surfaces: `--swipe-archive` `#8e8e93`, `--scrim` (`rgba(0,0,0,.32)` / `.5`), `--sheet` (`#ffffff` /
  `#2a2a2a`), `--bar` (`rgba(247,247,248,.95)` / `rgba(34,34,34,.94)`), and a darker `--shadow` (`.5`) in dark;
- `--c-fw` and `--c-fw-solid` (500 for `l`, 600 for `xl`).
