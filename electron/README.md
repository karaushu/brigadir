# Brigadir desktop app

The Electron app and its packages: a pnpm workspace. Project rules are in the root [AGENTS.md](../AGENTS.md),
workspace how-tos in [AGENTS.md](AGENTS.md), and the product itself in [docs/spec](../docs/spec/README.md).

## Commands

Run from this folder:

```sh
pnpm install          # dependencies and the pre-commit hook
pnpm dev              # build the services, start the app with the Vite dev server
pnpm dev:secondary    # the same, in the background on a secondary display without taking focus
pnpm start            # full production build, run from a frozen copy of apps/desktop/out
pnpm build            # desktop app and the Node services
pnpm typecheck        # strict types
pnpm test             # unit tests (vitest); builds the services first
pnpm test:smoke       # the @smoke end-to-end specs (Playwright) against the current build
pnpm test:area <name> # one area of the end-to-end specs
pnpm check            # typecheck, unit tests and build
pnpm dist:mac         # dist/Brigadir-<version>-<arch>.dmg (--x64, --all)
pnpm dist:linux       # AppImage, .deb and .rpm
```

Which tests to run and when: [docs/guides/testing.md](../docs/guides/testing.md). Packages, signing, releases and
auto-update: [docs/guides/releasing.md](../docs/guides/releasing.md).

## Data

The app keeps its data in `~/.brigadir/` (dev and packaged builds alike). Give a development copy its own folder with
an absolute path, and never run two copies on the same folder:

```sh
BRIGADIR_DATA_DIR=/absolute/temporary/path pnpm dev
```

A missing folder starts as an empty workspace. To try the UI without a paid provider, add the synthetic agent:

```sh
BRIGADIR_DATA_DIR=/absolute/temporary/path \
BRIGADIR_TEST_AGENT="$PWD/packages/transport/fixtures/agent.mjs" pnpm dev
```

## Formatting

Prettier is pinned in the workspace and configured in `.prettierrc.json` (tabs, width 2, single quotes, semicolons,
100 columns); generated output, vendored resources and fixtures are excluded by `.prettierignore`.

```sh
pnpm format           # format the workspace
pnpm format:check     # check only
```

The pre-commit hook (Husky + lint-staged, installed by `pnpm install`) formats staged files and adds the result to the
commit; a formatting error blocks it.

## Guides

| Guide                                                          |                                                                               |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [Running and testing](../docs/guides/testing.md)               | Running without stealing focus, test levels, synthetic providers, live checks |
| [Building a module](../docs/guides/modules.md)                 | The files a new module touches, in order                                      |
| [Versions, packages and releases](../docs/guides/releasing.md) | Version policy, signing, local releases, auto-update                          |
| [Architecture](../docs/architecture.md)                        | Modules, layers and build order                                               |
