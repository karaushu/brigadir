# Third-party assets

Icons, fonts, grammars, binaries and other files from outside projects that Brigadir ships, with their licences and
where they live. Paths are relative to `electron/`. Each vendored folder has a README with the exact commands that
reproduce its files; this page is the index.

| Asset | Version | Licence | Location | Licence file |
| --- | --- | --- | --- | --- |
| Lucide icons | `lucide-static@1.60.0` | ISC; icons derived from Feather under MIT | `apps/desktop/src/renderer/lucide/` | `LICENSE-lucide.txt` |
| Geist, Geist Mono | `geist@1.8.1` | SIL Open Font License 1.1 | `apps/desktop/src/renderer/fonts/` | `LICENSE-geist.txt` |
| tree-sitter-scss grammar | `tree-sitter-scss@1.0.0`, patched | MIT | `packages/syntax/grammars/` | `LICENSE-tree-sitter-scss` |
| tree-sitter-json grammar | `tree-sitter-json@0.24.8` | MIT | `packages/syntax/grammars/` | `LICENSE-tree-sitter-json` |
| tree-sitter runtime and grammars | `@vscode/tree-sitter-wasm@0.3.1` | MIT | npm dependency of `packages/syntax` | `LICENSE`, `cgmanifest.json` from the package |
| scrcpy server | v4.1 | Apache License 2.0 | `apps/desktop/native/scrcpy-server-v4.1` | `apps/desktop/native/scrcpy-LICENSE` |
| TypeScript | `typescript@~5.9.3` | Apache License 2.0 | npm dependency of `packages/lsp` | `LICENSE.txt`, `ThirdPartyNoticeText.txt` from the package |
| TypeScript language server | `typescript-language-server@^5.3.0` | Apache License 2.0 | npm dependency of `packages/lsp` | `LICENSE` from the package |
| node-pty | `node-pty@^1.1.0` | MIT | npm dependency of `packages/host` | `LICENSE` from the package |

## Icons

### Lucide

`apps/desktop/src/renderer/lucide/` holds every icon of `lucide-static@1.60.0` from npm
(github:lucide-icons/lucide). The Lucide licence is ISC, copyright Lucide Icons and Contributors. Part of the icons
are derived from Feather under MIT; both texts are in `LICENSE-lucide.txt`. See
`lucide/README.md`.

- `icons.json` is the package's `icon-nodes.json` with sorted keys, minified: `{ name: [[tag, attributes], …] }`.
  The renderer builds each SVG from these nodes on the 24 × 24 grid. The geometry is unchanged.
- `tags.json` is the package's `tags.json` with sorted keys, minified: the search words of each icon.
- The renderer loads both lazily (`renderer/project-icons.ts`) for the project icon picker
  ([Project icon](spec/projects-and-board.md#project-icon)). Main reads the names from `tags.json`
  (`main/project-icons.ts`) to check the icon an agent picks.

Some glyphs in `renderer/ui/Glyph.tsx` copy Lucide geometry on its 24 grid with a 1.8 stroke:

| Glyph | Lucide icon |
| --- | --- |
| `activity` | `activity` |
| `settings` | `settings` |
| `find-case` | `case-sensitive` |
| `find-word` | `whole-word` |
| `find-regex` | `regex` |
| `find-previous` / `find-next` | `arrow-up` / `arrow-down` |
| `replace-all` | `replace-all` |
| `find-replace-show` / `find-replace-hide` | `chevron-right` / `chevron-down` |

All other glyphs in `ui/Glyph.tsx` and `ui/FileIcon.tsx` are drawn for Brigadir.

### Service and platform marks

`ui/Glyph.tsx` draws single-colour marks that identify outside services and platforms: `claude`, `openai`, `github`,
`git`, `slack`, `platform-apple`, `platform-android`. `ui/FileIcon.tsx` uses simplified marks for some file types
(React, Docker, Git). These names and logos are trademarks of their owners. They are used only to identify the
service, provider or file type, and Brigadir's licence does not grant rights to them.

## Fonts

`apps/desktop/src/renderer/fonts/` holds the variable `woff2` files of `geist@1.8.1` from npm
(github:vercel/geist-font), copyright Vercel in collaboration with basement.studio, under the SIL Open Font License
1.1 (`LICENSE-geist.txt`). See `fonts/README.md`.

| File | Face |
| --- | --- |
| `Geist-Variable.woff2` | Geist, upright |
| `Geist-Italic-Variable.woff2` | Geist, italic |
| `GeistMono-Variable.woff2` | Geist Mono, upright |
| `GeistMono-Italic-Variable.woff2` | Geist Mono, italic |

- The files are unchanged. The italic files are renamed from `*-Italic[wght].woff2` to `*-Italic-Variable.woff2`.
- `renderer/tokens.css` declares them with `@font-face` (weights 100–900, `font-display: block`).
- Code ligatures are Stylistic Set 11 (`font-feature-settings: "ss11"`), behind each code surface's Ligatures switch.
  The version must stay at 1.8 or newer: earlier versions turn the ligatures on with `liga`.
- These are the only bundled fonts ([Bundled Geist](spec/appearance.md#bundled-fonts)). Other families come from
  the fonts installed on the computer.

## Grammars

`packages/syntax/grammars/` holds grammars that `@vscode/tree-sitter-wasm` does not ship, built for its 0.25
runtime (ABI 14). See `grammars/README.md`.

- `tree-sitter-scss.wasm`: `tree-sitter-scss@1.0.0` from npm (github:tree-sitter-grammars/tree-sitter-scss),
  MIT. `tree-sitter-scss.patch` adds Sass syntax the upstream grammar does not parse:
  `@use … as/with`, `@forward … as/show/hide/with`, `!default` and `!global`, `@extend %placeholder`,
  `@each … in a, b`, `@include module.mixin`, `@container style(--x: y)`, and nested selectors that start with `>`,
  `~` or `+`. The upstream corpus passes unchanged
  ([CSS and SCSS](spec/editor-code-intelligence.md#css-scss)).
- `tree-sitter-json.wasm`: the prebuilt file of `tree-sitter-json@0.24.8` from npm
  (github:tree-sitter/tree-sitter-json), MIT, unchanged. It accepts `//` and `/* */`
  comments, so `.jsonc` and `tsconfig.json` use it too ([JSON](spec/editor-code-intelligence.md#json)).

The other grammars and the `tree-sitter.wasm` runtime come from the `@vscode/tree-sitter-wasm` npm package
(copyright Microsoft Corporation, MIT).

## Simulator: scrcpy server

`apps/desktop/native/scrcpy-server-v4.1` is the server of scrcpy v4.1 (github:Genymobile/scrcpy),
Apache License 2.0, with the licence text in `apps/desktop/native/scrcpy-LICENSE`. Brigadir pushes it to a booted
Android device at run time to mirror the screen and send input ([Simulator](spec/browser-and-simulator.md#simulator)).
`scripts/build-services.mjs` checks its SHA-256 against the vendored release before it copies the file.

## Where the licences go in a build

| Build step | Copies |
| --- | --- |
| Desktop renderer (`electron.vite.config.ts`) | `assets/LICENSE-geist.txt` and `assets/LICENSE-lucide.txt` next to the hashed assets (`vite-font-licence.ts`) |
| Phone renderer (`vite.mobile.config.ts`) | `assets/LICENSE-geist.txt` (the phone ships the fonts, not the Lucide data) |
| `scripts/build-services.mjs` → `out/services/syntax-assets/` | `tree-sitter.wasm` and its grammars, `LICENSE` and `cgmanifest.json` of `@vscode/tree-sitter-wasm`, both vendored grammars with `LICENSE-tree-sitter-scss` and `LICENSE-tree-sitter-json` |
| `scripts/build-services.mjs` → `out/services/` | `scrcpy-server` and `scrcpy-LICENSE` |
| `scripts/build-services.mjs` → `out/services/lsp/node_modules/` | `typescript` (`lib`, `LICENSE.txt`, `ThirdPartyNoticeText.txt`) and `typescript-language-server` (`lib`, `LICENSE`) |
| `scripts/build-services.mjs` → `out/services/node_modules/node-pty/` | `lib`, `prebuilds`, `LICENSE` |

The release build keeps `out/services` outside `app.asar`, and `scripts/check-dist.mjs` checks that the scrcpy
server, its licence and the syntax assets are in the package
([Packaging](spec/architecture-and-platform.md#packaging)).

npm packages that are bundled into the JavaScript (React, CodeMirror, xterm.js and others) are listed in the
`package.json` files of the workspace and are not covered by this page.

## Brigadir's own artwork

Not third-party, listed so it is not mistaken for vendored files:

- `apps/desktop/resources/brigadir.icon/` is the app icon as an Icon Composer document. Keep its layers, placement,
  background and effects; the PNG in `Assets` is one layer, not the whole icon. `scripts/desktop-runtime.mjs`
  compiles it with Xcode `actool` for the macOS dev app, and the release build passes it to electron-builder. See
  `resources/README.md`.
- `packaging/icons/icon.png` is the 512 px Linux icon, drawn from the same document by `scripts/render-icon.mjs`
  ([Linux package](spec/architecture-and-platform.md#linux-package)).
- `apps/desktop/src/renderer-mobile/public/icon.svg`, `icon-180.png`, `icon-192.png` and `icon-512.png` are the
  phone client's icons, and `apps/desktop/src/renderer/assets/intro-helmet.png` is the helmet of the intro.

## Adding an asset

- Copy files unchanged where possible, record the package, version and source in the folder's README, and put the
  licence text next to the files.
- Make sure the build copies the licence next to the asset in every output that ships it.
- Add a row to the table at the top of this page.
- A glyph that copies an outside icon set records the set and the icon name here.
