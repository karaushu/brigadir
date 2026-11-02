# Motion

Brigadir's interface moves: segment indicators slide between options, menus, dialogs and review cards appear
smoothly, disclosures expand, and buttons react. Motion belongs to the shared UI system, not to features. The spec
summary is [Motion](spec/appearance.md#motion).

## Tokens

Defined in `electron/apps/desktop/src/renderer/tokens.css`:

| Token | Value | Use |
| --- | --- | --- |
| `--motion-fast` | `120ms` | feedback: colour, background, border and shadow transitions on buttons |
| `--motion-enter-time` | `180ms` | menus, popovers, cards, dialogs appearing; retained exits |
| `--motion-travel` | `240ms` | segment travel, disclosures, height changes, sidebar reorder |
| `--motion-ease` | `cubic-bezier(0.2, 0.8, 0.2, 1)` | fast departure, soft landing |
| `--motion-enter` | `brigadir-rise` | fade in and rise 6 px |
| `--motion-reveal` | `brigadir-reveal` | fade in and clip-reveal from the top, radius 7 |
| `--motion-fade` | `brigadir-fade` | fade in only |

The three animation tokens run for `--motion-enter-time` with `--motion-ease` and `both` fill.

## Rules

- Use the tokens. No `transition: all` in shared UI and no ad-hoc easing curves. The intro's spotlight (0.75 s) and
  step dots (0.4 s) are the only longer timings; they still use `--motion-ease`.
- Travel is short (4–8 px) with no decorative bounce. Motion never changes the final layout, colours or icon
  geometry.
- Actions run at once and never wait for an animation. A quick repeat interrupts a transition from its current
  state. Focus and actions stay available during a transition.
- Animate controls and cards, not code geometry. Code, native text selection, scrolling, focus, virtualised rows on
  scroll and streamed text are not animated; animate the enclosing disclosure or control once instead.
- Panels can fade. The native browser view must not be transformed: its `WebContents` bounds are separate from the
  DOM and would not follow.

## Where motion lives

| Part | Implementation |
| --- | --- |
| Buttons | `tokens.css`: `background-color`, `color`, `border-color` and `box-shadow` over `--motion-fast` |
| Dialogs | `tokens.css`: `dialog` fades over `--motion-enter-time` and rises 8 px over `--motion-travel`; `@starting-style` for entry, `display` / `overlay` with `allow-discrete` for exit; the backdrop fades |
| Popovers and menus | `ui/Popover.module.css`: opacity and a move toward the anchor's side over `--motion-enter-time` (enter from 6 px, exit to 4 px) |
| Retained exits | `ui/use-presence.ts`: `usePresence(open)` keeps a closing popover mounted for `--motion-enter-time` so its exit can play; the caller makes it `inert` at once, so it takes no input while it fades |
| Segments | `ui/Controls.tsx` measures the chosen button and sets `--segment-x`, `--segment-width`, `--segment-height` on the group; `Controls.module.css` slides the indicator over `--motion-travel` |
| Review cards | `ui/ReviewControls.module.css`: actions and drafts use `--motion-reveal` (opacity and clip, the card stays in place); the general note animates `height` over `--motion-travel` with `interpolate-size` |
| Sidebar reorder | `use-sidebar-order.ts`: rows slide to their new place with the Web Animations API over `--motion-travel` |
| Turn rail | `TurnRail.tsx`: reads `--motion-fast` |
| Agent tab spinner | `tokens.css`: `svg[data-spin='true']` turns once per 0.9 s |
| Loading | `ui/Loading.module.css`: spinner 900 ms per turn, skeleton pulse 1.4 s |

### Segments

At rest the chosen segment paints itself with `--segment-on` and `--segment-on-shadow`. The indicator is visible only
while it slides to another segment (`data-moving` for one travel), then the chosen button takes over again. The
indicator follows the real button geometry, including labels, localisation, resize, horizontal scroll and a group
with no selection. Edges are snapped to whole pixels.

The whole `Segments` subtree, including the indicator and its SVG children, is `-webkit-app-region: no-drag`.
`pointer-events: none` does not remove an element from Electron's native drag regions, so a visual layer inside the
toolbar still needs `no-drag`. Synthetic DOM clicks cannot show this; `tests/menu.spec.ts` checks drag regions over
buttons by computed style.

### Reading timings in script

Script code reads timings only through `ui/motion.ts`: `motionTime('--motion-…')` returns milliseconds, and 0 under
reduced motion. The minified renderer build serialises `180ms` as `.18s`, so `cssTime` accepts both units; a bare
`parseFloat` would read `.18s` as 0.18 ms and cut every retained exit short.

## Reduced motion

`prefers-reduced-motion: reduce`:

- sets `--motion-fast`, `--motion-enter-time` and `--motion-travel` to `0ms`, and `--motion-enter`,
  `--motion-reveal` and `--motion-fade` to `none`;
- removes the move of dialogs and popovers, so they only appear;
- makes `usePresence` drop a closing surface at once and `use-sidebar-order` skip the move;
- stops the `ui/Loading` spinner and skeleton pulse, and slows the agent tab spinner to 2.4 s per turn;
- shortens every intro animation and transition to 1 ms.

## Checking motion

- Check by hand with normal and reduced motion. Check stable visuals only after animations settle.
- Normal-motion checks cover interrupted travel, keyboard navigation, menu dismissal and live diff selection.
  `tests/diff-selection.spec.ts` turns motion on (`reducedMotion: 'no-preference'`) and still checks that code stays
  in place while dragging a selection.
- Editor selection and review geometry must not change because of motion.
