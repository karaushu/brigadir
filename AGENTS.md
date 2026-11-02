# Brigadir

Brigadir is a cross-platform Electron app for orchestrating coding agents: a sidebar of projects and tasks, an
activity view of each conversation, a full Git diff panel with comment-based review, and monorepos made of several
git roots. The app lives in `electron/`; its own how-tos (commands, running the app, test scripts) are in
[electron/AGENTS.md](electron/AGENTS.md).

## Where things are

| What | Where |
| --- | --- |
| Specification, one file per area | [docs/spec/](docs/spec/README.md) — read the relevant area before any work |
| Modules, layers and build order | [docs/architecture.md](docs/architecture.md) — dependencies point downward only; a feature never depends on another feature |
| Interface terms | [docs/glossary.md](docs/glossary.md) — read before writing any text the user sees |
| UI text style, English and Ukrainian | [docs/ui-copy.md](docs/ui-copy.md) — short names, direct explanations, matching `en`/`uk`, platform-neutral wording |
| Design token reference values | [docs/design-tokens.md](docs/design-tokens.md) |
| Adding a module | [docs/guides/modules.md](docs/guides/modules.md) |
| Testing | [docs/guides/testing.md](docs/guides/testing.md) |
| Versions and packages | [docs/guides/releasing.md](docs/guides/releasing.md) |

## Document rule

- The spec describes the current product. It is not a changelog or a design diary.
- A change in behavior updates the spec first, then the code, in the same change. If the code and the spec disagree,
  fix the spec before the code.
- History lives in git, never in docs or code comments: no dates, decision logs, superseded variants or names.
- Code references the spec as `spec/<file>#<anchor>`, where `<file>` is a file in `docs/spec/` without `.md` and
  `<anchor>` is an `<a id="…"></a>` in it. Anchors are stable; renaming one means updating every reference. There are
  no section numbers.
- Planned work sits in each spec file's **Later** list, not in the body.

## Implementation rules

Code comments refer to these as "rule N"; keep the numbering. Code paths are relative to `electron/`; `renderer/` is
`electron/apps/desktop/src/renderer/`.

1. **The UI depends on Brigadir's own domain model, never on ACP types.** Transport normalizes ACP into
   `AgentEvent` / `AgentCommand`; the UI sees `SessionEvent` / `SessionCommand` from `packages/core`. A raw
   `session/update` payload never reaches a view or the preload. This seam keeps a second transport cheap
   ([agents-and-providers#seam-rules](docs/spec/agents-and-providers.md#seam-rules)).
2. **Persist normalized domain events, never raw ACP messages.** The task journal `events.jsonl` holds validated
   events; new facts are new event kinds, not new required fields
   ([architecture-and-platform#journal](docs/spec/architecture-and-platform.md#journal)).
3. **The diff engine diffs snapshots of git trees, not `git diff HEAD`.** ACP edit records are only attribution labels
   on top of snapshots, never the source of truth ([diff-and-review#snapshot-engine](docs/spec/diff-and-review.md#snapshot-engine)).
4. **Colors are semantic tokens only.** Components use `var(--token)` from `renderer/tokens.css`, which defines light
   and dark values and a high-contrast variant (`prefers-contrast: more`). No hex, radius or shadow literals in
   features; the accent comes from Settings or the system accent
   ([appearance#design-tokens](docs/spec/appearance.md#design-tokens)).
5. **The theme comes from one place: the app's appearance setting.** Main sets `nativeTheme.themeSource`, the renderer
   sets `data-theme` on `<html>`, and every token follows it. No theme switches inside components
   ([appearance#theme](docs/spec/appearance.md#theme)).
6. **One row engine for the diff and the activity view.** `renderer/ui/Rows.tsx` virtualizes heterogeneous,
   variable-height rows for both; scrolling, following, find and keyboard targets are written once
   ([chat#row-engine](docs/spec/chat.md#row-engine)).
7. **Providers are exactly what ACP gives.** No registry of knowledge about agents; capabilities come from
   `initialize` and the provider's option catalog ([agents-and-providers#providers](docs/spec/agents-and-providers.md#providers)).
8. **All visible text goes through the message catalog** in `packages/core/src/messages.ts`: `t(locale, key)`, shared
   by main and renderer, with the English text as the key. Native menus and dialogs included
   ([appearance#i18n](docs/spec/appearance.md#i18n)).
9. **Ukrainian plurals always have four forms** (`one`, `few`, `many`, `other`) through `Intl.PluralRules('uk')`,
   never two.
10. **State on disk is JSON, written with sorted keys and 2-space indent** (`jsonText` in `packages/persistence`, atomic writes, a schema
    version in every document); append streams are JSONL. No TOML, no YAML
    ([architecture-and-platform#formats](docs/spec/architecture-and-platform.md#formats)).
11. **Every shortcut has a menu-bar item.** Exceptions: keys that work only inside a modal and are labeled in that
    modal, and double Shift ([search-menus-and-commands#menu-bar-rule](docs/spec/search-menus-and-commands.md#menu-bar-rule)).
12. **Prompts to agents are in English,** whatever the UI language. Text the person types is sent as is.
13. **No App Sandbox for the app process.** Main and the task hosts launch agents and read project folders; a sandbox
    would be inherited by child processes and cut them off from the keychain and folders. The renderer runs with
    `contextIsolation`, no `nodeIntegration` and `sandbox: true`
    ([architecture-and-platform#stack-rules](docs/spec/architecture-and-platform.md#stack-rules)).
14. **Every modal surface we own closes with `Esc` in its header** — popover, sheet, confirmation dialog, settings,
    search. Use the shared `renderer/ui/PopupClose.tsx`: the text `Esc` on a transparent background, no border or
    shadow at rest, a localized accessible name. Keep its hover, keyboard focus ring, Escape dismissal and focus
    return. Do not add an outlined Close, an X or a local style. Meaningful footer actions and OS-owned dialogs keep
    their own buttons ([appearance#popup-close](docs/spec/appearance.md#popup-close)).
15. **Hover covers the whole target, and every interactive element has a hover state** (and pressed or selected where
    it has one). Hover covers the same area as the active or selected state: a row that highlights as a whole hovers
    as a whole — name, second line and empty space — usually by stretching its primary button over the row
    (`::after { inset: 0 }`) with nested controls raised above it with their own hover. No empty padding under a
    section's last row: the row fill reaches the separator ([appearance#hover](docs/spec/appearance.md#hover)).
16. **One row, one height.** Controls side by side in a row (button, `PopupClose`, field, dropdown, segments) take the
    row's size from the control scale: the row declares `data-size`, the controls set none. When the row grows, all
    of them follow. A deliberate mixed row carries `data-row-mixed` and its reason in the spec. The vitest
    `renderer/ui/Controls.test.tsx` holds the scale invariant
    ([appearance#one-row-one-height](docs/spec/appearance.md#one-row-one-height)).
17. **One look, one component.** Anything that looks the same (button, split button, menu with a header and `Esc`,
    card, chip, row, counter, empty and loading states) is one component in `renderer/ui/`. Search `ui/` before
    writing a control and extend the existing one with a prop; never copy it into a feature. A feature's CSS only
    places a control (margins, slot in the row), it does not restyle it. A second copy of a look moves into `ui/` in
    the same change ([appearance#one-look-one-component](docs/spec/appearance.md#one-look-one-component)).
18. **The version always grows.** Every build handed to people gets a new version: a new feature → minor, fixes only →
    patch. Whoever builds the packages bumps `apps/desktop/package.json` in a `chore(release): X.Y.Z` commit and tags
    `vX.Y.Z`; agents in branches never touch the version ([docs/guides/releasing.md](docs/guides/releasing.md)).

## UI quality

- Motion is part of the implementation. Animate segment selection, disclosures, menus, panels, dialogs and comment
  composers with the shared motion tokens; actions run at once and stay interruptible. Do not animate streamed text,
  virtualized row mounts, code during pointer selection or native browser bounds. Respect `prefers-reduced-motion` and
  keyboard focus ([appearance#motion](docs/spec/appearance.md#motion)).
- Reuse the original icons in `renderer/ui/Glyph.tsx`; say so when a new drawing is needed.
- Check a UI change in the running app in both themes, with keyboard, loading, error and interrupted states. Green
  functional tests do not prove the layout is right.

## Tests

Tests run in levels; details and scripts are in [docs/guides/testing.md](docs/guides/testing.md).

- **A change on a branch:** vitest of the touched code and `pnpm typecheck`. No e2e on a branch, and no reruns to turn
  something green.
- **Each merge** that touches `apps/desktop/src/main` or `packages/host`, `packages/transport` or `packages/git`:
  the smoke set (`pnpm test:smoke`) once. A pure UI or CSS merge runs no e2e.
- **The full e2e suite or an area** only when asked.
- **A new e2e test checks behavior** that vitest cannot reach — a real process, PTY, git on disk, main↔renderer IPC, a
  native menu, the clipboard, drag — never CSS, pixels or exact UI text. Find elements by role or `data-testid`. A
  spec that breaks on a design or copy change is deleted, not tuned to new numbers.

## Reference case

Features are checked against a monorepo with five independent git roots: the root repo, two submodules, a gitignored
nested repo and a worktree ([overview#reference-case](docs/spec/overview.md#reference-case)).
