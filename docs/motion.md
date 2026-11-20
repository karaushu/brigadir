# Motion

Brigadir's interface moves where motion explains a change: segment indicators slide between options, menus,
dialogs, toasts and review cards appear smoothly, disclosures expand, and buttons give way when pressed. What is
used all day from the keyboard does not move. Motion belongs to the shared UI system, not to features. The spec
summary is [Motion](spec/appearance.md#motion).

## Tokens

Defined in `electron/apps/desktop/src/renderer/tokens.css`:

| Token | Value | Use |
| --- | --- | --- |
| `--motion-fast` | `120ms` | colour, background, border, shadow and opacity on hover and state |
| `--motion-nudge` | `120ms` | small movement: press scale, chevron turn, a card following the pointer |
| `--motion-enter-time` | `180ms` | fades of menus, popovers, cards, dialogs and toasts; retained exits |
| `--motion-travel` | `240ms` | rises, segment travel, disclosures, height changes, sidebar reorder |
| `--motion-flash` | `900ms` | a highlight that fades out: a line jumped to, a changed mode, the background deck |
| `--motion-hold` | `2s` | hold to confirm |
| `--motion-spin` | `0.9s` | one spinner turn |
| `--motion-ease` | `cubic-bezier(0.23, 1, 0.32, 1)` | enter, exit, reveal: fast start, soft landing |
| `--motion-ease-move` | `cubic-bezier(0.77, 0, 0.175, 1)` | something already on screen moves: segment indicator, switch knob, sidebar reorder |
| `--motion-enter` | `brigadir-rise` | fade in and rise 6 px |
| `--motion-reveal` | `brigadir-reveal` | fade in and clip-reveal from the top, radius 7 |
| `--motion-fade` | `brigadir-fade` | fade in only |
| `--motion-spinner` / `--motion-spinner-ticks` | `brigadir-spin` | a spinner, smooth or in 8 ticks; a CSS module cannot name the global keyframe, so it takes the shorthand |

The three entrance tokens run for `--motion-enter-time` with `--motion-ease` and `both` fill.

## Rules

- **Frequency decides.** What starts from the keyboard or happens many times an hour does not animate: Search Everywhere,
  the find panel, the `@` / `/` menu, segment changes by arrow keys (`Segments` skips the slide), file tree selection
  and chevrons, hiding the sidebar, panels that remount on a task or project switch, and selection fills
  (`button:where([aria-pressed], [aria-selected])` has no transition).
- Use the tokens. No `transition: all`, no `ease-in`, no curves outside the tokens; script reads them through
  `ui/motion.ts`. The intro, seen once, may take longer beats, an overshoot and a stagger.
- Travel is short (4–8 px) with no decorative bounce. Entrances start at scale 0.9–0.97 with opacity 0, never at
  scale 0. Motion never changes the final layout, colours or icon geometry.
- Actions run at once and never wait for an animation. Anything that can repeat quickly uses transitions or a
  cancelled-and-restarted Web Animation, not CSS keyframes, so a repeat continues from the current state.
- Animate `transform`, `translate`, `scale`, `opacity` and `clip-path`. Height only in disclosures. No animated
  `width`, `top`, `left`, `inset` or margins: progress fills grow by `clip-path`, the turn card follows by
  `transform`, the editor drop zone snaps.
- Animate controls and cards, not code geometry. Code, native text selection, scrolling, focus, virtualised rows on
  scroll and streamed text are not animated; animate the enclosing disclosure or control once instead.
- Panels can fade. The native browser view must not be transformed: its `WebContents` bounds are separate from the
  DOM and would not follow.

## Where motion lives

| Part | Implementation |
| --- | --- |
| Buttons | `tokens.css`: colours over `--motion-fast`, `scale` over `--motion-nudge`; `ui/Controls.module.css`: `Button` / `IconButton` press to 0.97, a split button presses as one capsule |
| Hold to confirm | `Button onHold`: `data-holding` sweeps a `::before` fill by `clip-path` over `--motion-hold`, a timer of the same token runs the action; release snaps back |
| Disclosures | `tokens.css`: one `:where(details)::details-content` rule, height and opacity with `interpolate-size`; grid-row reveals use the same timing; chevrons turn over `--motion-nudge` |
| Dialogs | `tokens.css`: `dialog` fades over `--motion-enter-time` and rises 8 px over `--motion-travel`; `@starting-style` for entry, `display` / `overlay` with `allow-discrete` for exit; the backdrop fades. `ModalDialog` adds nothing; Search Everywhere opts out |
| Popovers and menus | `ui/Popover.module.css`, `.menu` in `ui/Controls.module.css`: opacity, a move toward the anchor's side and scale from 0.97 over `--motion-enter-time` (enter from 6 px, exit to 4 px); `transform-origin` at the anchor (`--arrow-left` / `--arrow-top`, or the menu's corner) |
| Retained exits | `ui/use-presence.ts`: `usePresence(open)` keeps a closing surface mounted for `--motion-enter-time` so its exit can play; the caller makes it `inert` at once |
| Toasts | `ui/Toast.tsx`: a leaving toast stays `inert` for one travel; each `.slot` opens and closes its grid row over `--motion-travel`, the toast fades and moves 6 px, `@starting-style` for entry |
| Segments | `ui/Controls.tsx` measures the chosen button and sets `--segment-x`, `--segment-width`, `--segment-height` on the indicator itself; `Controls.module.css` slides it over `--motion-travel` with `--motion-ease-move` |
| Review cards | `ui/ReviewControls.module.css`: actions and drafts use `--motion-reveal` (opacity and clip, the card stays in place); the general note animates `height` over `--motion-travel` with `interpolate-size` |
| Sidebar reorder | `use-sidebar-order.ts`: rows slide to their new place with the Web Animations API over `--motion-travel` and `--motion-ease-move` |
| Sidebar attention | `App.module.css`: a 400 ms `ease` wave, the glyph and dot from scale 0.95, the needs-you amber and rings |
| Archive swipe | `Archive.tsx`: the action label is dimmed until armed; a flick (> 0.11 px/ms, ≥ 24 px) completes; past 140 px the card follows at a quarter |
| Turn rail | `TurnRail.tsx` reads `--motion-fast`; the hover card moves by `transform`, the thumb widens by `clip-path` |
| Spinners | `brigadir-spin` in `tokens.css` through `--motion-spinner` / `--motion-spinner-ticks`; skeleton pulse 1.4 s in `ui/Loading.module.css` |

### Segments

At rest the chosen segment paints itself with `--segment-on` and `--segment-on-shadow`. The indicator is visible only
while it slides to another segment (`data-moving` for one travel), then the chosen button takes over again. A change
from arrow keys, Home or End does not set `data-moving`: the chosen button paints itself at once. The indicator
follows the real button geometry, including labels, localisation, resize, horizontal scroll and a group with no
selection. Edges are snapped to whole pixels.

The whole `Segments` subtree, including the indicator and its SVG children, is `-webkit-app-region: no-drag`.
`pointer-events: none` does not remove an element from Electron's native drag regions, so a visual layer inside the
toolbar still needs `no-drag`. Synthetic DOM clicks cannot show this; `tests/menu.spec.ts` checks drag regions over
buttons by computed style.

### Reading timings in script

Script code reads timings only through `ui/motion.ts`: `motionTime('--motion-…')` returns milliseconds, and
`motionEase('--motion-ease…')` the curve. The minified renderer build serialises `180ms` as `.18s`, so `cssTime`
accepts both units; a bare `parseFloat` would read `.18s` as 0.18 ms and cut every retained exit short.

## Reduced motion

`prefers-reduced-motion: reduce` removes movement and keeps fades and colour:

- `--motion-nudge` and `--motion-travel` are `0ms`; `--motion-fast` and `--motion-enter-time` keep their time;
- `--motion-enter`, `--motion-reveal` and `--motion-fade` become a plain fade;
- dialogs, popovers, menus and toasts lose their move and scale (also in `@starting-style`), press scale is off;
- `usePresence` keeps the fade-out, `use-sidebar-order` skips the move;
- spinners turn at 2.4 s (`--motion-spin`) and never stop; the skeleton pulse stops; hold to confirm keeps its time;
- the sidebar attention signal changes state without animation; every intro animation and transition is 1 ms.

## Checking motion

- Check by hand with normal and reduced motion. Check stable visuals only after animations settle.
- Normal-motion checks cover interrupted travel, keyboard navigation, menu dismissal and live diff selection.
  `tests/diff-selection.spec.ts` turns motion on (`reducedMotion: 'no-preference'`) and still checks that code stays
  in place while dragging a selection.
- Editor selection and review geometry must not change because of motion.
