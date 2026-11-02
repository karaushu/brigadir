# Working in electron/

Project rules, the document rule and the test policy are in the root [AGENTS.md](../AGENTS.md). This file holds only
the how-tos for this workspace. Paths below are relative to `electron/`.

## Commands

```sh
pnpm install        # dependencies and the pre-commit hook
pnpm typecheck      # strict types for the workspace and packages/core
pnpm build          # desktop app and the Node services
pnpm check          # typecheck, unit tests and build
pnpm format         # Prettier over the workspace (pnpm format:check to check only)
```

- Formatting uses the pinned Prettier and `.prettierrc.json` (tabs, width 2, single quotes, semicolons, 100 columns).
  The pre-commit hook formats staged files; a formatting error blocks the commit.
- Use `BRIGADIR_DATA_DIR=/absolute/temporary/path` for fixture data. Without it the app uses `~/.brigadir/`.

## Running the app

- Run it without taking focus from the person at the keyboard: `pnpm start:secondary` (builds, then launches in the
  background on the secondary display) or `pnpm dev:secondary` for the dev server.
- `pnpm start` launches from a snapshot of `apps/desktop/out`, so a later rebuild never reaches an app that is already
  running. Rebuild and relaunch to see a change.
- Quit a running app the normal way (its Quit menu item or a regular quit request), never with a forced kill. Task
  hosts are detached and keep their agents running across a relaunch.

## Tests

- Unit tests for the touched code: `npx vitest run <paths> --reporter=dot --silent`.
- Smoke set (the `@smoke` specs): `pnpm test:smoke`. An area: `pnpm test:area <name>`. Full suite: `pnpm test:full`.
  Which level to run and when is in the root [AGENTS.md](../AGENTS.md#tests).
- In a new e2e step, tag the spec `@area:<name>` (and `@serial` when it uses the clipboard), prefer a step in the
  existing spec of that flow, and wait for events (`expect.poll`, `settle(page)`), not `waitForTimeout`. Allow at most
  one "nothing overflows its container" check per screen.
- Keep reporters quiet (`dot`); report "N passed / M failed" with the failing names and keep full output in a file.
- Opt-in live transport smoke, with temporary fixture data only:

```sh
BRIGADIR_LIVE_TRANSPORT=codex pnpm exec vitest run packages/transport/src/live.test.ts
BRIGADIR_LIVE_TRANSPORT=claude pnpm exec vitest run packages/transport/src/live.test.ts
```

## Packages

`pnpm dist:mac` (`--x64`, `--all`) writes `dist/Brigadir-<version>-<arch>.dmg`; `pnpm dist:linux` builds the Linux
packages. Signing, notarization and versions are in [docs/guides/releasing.md](../docs/guides/releasing.md).
