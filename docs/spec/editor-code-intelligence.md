# Editor code intelligence and languages

The editor gets completion, hover, parameter hints, go to definition, references and problems from language servers that main runs, with a tree-sitter "by name" fallback when no server is available. It formats on save with the project's own Prettier or the language server, helps while typing (bracket pairs, closing tags, call parentheses), and highlights code through the shared tree-sitter worker with bold keywords and italic comments. CSS, SCSS (with CSS Modules navigation) and JSON have their own grammars.

Related: shared syntax worker and editor documents in [Editor](editor.md); syntax worker pools in [Architecture](architecture-and-platform.md); ⌘+click from the diff in [Diff and review](diff-and-review.md); ⌘+click in a PR diff in [Pull requests](pull-requests-and-ci.md); `package.json` scripts in [Search, menus and commands](search-menus-and-commands.md).

<a id="architecture"></a>
## Architecture and boundary

Code intelligence has two sources behind one API:

| Source | When | What it gives |
| --- | --- | --- |
| Language server (LSP) | A server exists for the file's language and is running | Completion, resolve (details, auto-import), hover, parameters, definition, references, problems, formatting |
| Fallback (tree-sitter) | No server for the language, start failed, crash budget spent, or `Language servers` is off | Definition and references by name, document-word completion; labelled `By name` |

Rules:

- Main spawns servers as child processes and speaks JSON-RPC itself (`packages/lsp`). LSP types never leave `packages/lsp` and main; the renderer sees only `core/code-intel.ts` types: `CodeCompletion`, `CodeLocation`, `CodeHover`, `CodeSignature`, `CodeProblem` (same seam as ACP, see [Agents and providers](agents-and-providers.md)).
- Files are addressed by opaque IDs; the renderer never sees real paths or URIs.
- Highlighting and `symbol_path` stay with the shared tree-sitter worker. LSP semantic tokens are not used; there is no second highlighting pipeline.
- Server capabilities come only from the `initialize` response. Code holds only launch names (`packages/lsp/src/servers.ts`), never a capability registry.
- The app never downloads servers or formatters (`npx`, network). A server not found on `PATH` means fallback mode.
- UI is CodeMirror 6 (`@codemirror/autocomplete`, `hoverTooltip`, `@codemirror/lint`).

<a id="bridge"></a>
### Bridge methods

Preload exposes named, runtime-checked methods (see [IPC boundary](architecture-and-platform.md)):

| Method / event | Purpose |
| --- | --- |
| `openCode`, `changeCode`, `closeCode` | Document lifecycle and incremental sync |
| `completeCode`, `resolveCompletion` | Completion list; details, docs and additional edits of the chosen item |
| `hoverCode`, `signatureCode` | Hover and parameter hints |
| `definitionCode`, `referencesCode` | Navigation |
| `onCodeProblems` | Problems of open documents |
| `onCodeRestarted` | Owners whose documents went through a server restart (main broadcasts `code:restarted`) |
| `formatCode`, `formatInfoCode`, `readFormatters`, `setProjectFormatter` | Formatting (see [Format on save](#format-on-save)) |

Responses are capped before they cross the bridge (`codeLimits`):

| Item | Limit |
| --- | --- |
| Completion items | 200 |
| Hover text | 16 KB |
| Definition locations | 20 |
| References | 500 |
| Problems per file | 500 |
| Change batch | 256 changes, 1 MiB |

<a id="server-processes"></a>
## Language server processes

| Rule | Value |
| --- | --- |
| Server identity | One per pair (server definition, root) |
| Root | Nearest folder with the server's marker inside the task's project root; project root without a marker. TypeScript always uses the project root (tsserver handles multiple `tsconfig.json` in a monorepo itself) |
| Start | Lazily, with the first open file of its language |
| Concurrent servers | At most 3. When full, the server idle longest without documents stops first; if all have documents, the new language runs in fallback |
| Idle stop | 10 minutes without open documents |
| Deadlines | Start 20 s, request 5 s, completion 3 s. On deadline main sends `$/cancelRequest` and returns an empty answer |
| Crashes | Restart up to 3 times in 5 minutes; then that language stays in fallback until the app restarts or a [manual restart](#language-server-restart) |
| File size | Only files within the syntax limit (5 MiB / 50 000 lines) are sent to servers; larger files have neither intelligence nor highlighting |
| `PATH` | App `PATH` plus `/opt/homebrew/bin`, `/usr/local/bin`, `~/.cargo/bin`, `~/go/bin`, `~/.local/bin` (Finder-launched apps get a minimal `PATH`) |

TypeScript specifics:

- `typescript-language-server` and `typescript` ship with the app. The project's `node_modules/typescript` is preferred, searched upward from the file to the project root; the bundled one otherwise. The choice is recomputed on every (re)start.
- `maxTsServerMemory` 3072 MB and `disableAutomaticTypingAcquisition` (no network).
- Node is the app's Electron binary via `ELECTRON_RUN_AS_NODE`, as for session hosts.
- Measured cost: about 0.4–0.5 GB per TypeScript project; CPU only at project load (about half a second) and milliseconds per request. Three servers stay around 1.5 GB; the 3072 MB cap is headroom, not a working point.

<a id="document-sync"></a>
### Document sync

- Main keeps a text mirror of each open document. The renderer sends `openCode` with full text once, then batches of changes (`from`, `to`, `insert` in UTF-16 offsets, as in CodeMirror) debounced 60 ms with a version number. The mirror converts to LSP positions and sends incremental `didChange`.
- Version mismatch: main answers `resync` and the renderer resends full text. Before every request the renderer flushes its queue. The buffer is never copied per keystroke.
- One file has one LSP document owner. The same file in another task is read-only (file lock, see [Editor](editor.md)) and runs in fallback.
- After `checkpoint.created`, main sends `workspace/didChangeWatchedFiles` with the task's changes; open documents are reread via `checkDisk` and reopened with `openCode`.
- Explicit ESM files (`.mjs`, `.mts`): auto-import edits that add an extensionless relative import are corrected to the runnable extension (`.js`, `.mjs`, `.cjs`); existing imports and package specifiers are untouched.

<a id="server-table"></a>
### Servers by language

Launch names are tried in order on `PATH` (TypeScript is bundled):

| Language | Server | Root marker |
| --- | --- | --- |
| JavaScript, TypeScript, TSX | bundled `typescript-language-server` | project root |
| Python | `basedpyright-langserver`, `pyright-langserver`, `pylsp` | `pyproject.toml`, `setup.py`, `setup.cfg`, `requirements.txt` |
| Go | `gopls` | `go.work`, `go.mod` |
| Rust | `rust-analyzer` | `Cargo.toml` |
| C/C++ | `clangd` | `compile_commands.json`, `CMakeLists.txt` |
| Ruby | `ruby-lsp`, `solargraph` | `Gemfile` |
| CSS, SCSS | `vscode-css-language-server` (`languageId` `css`/`scss` by extension) | — |
| Bash | `bash-language-server` | — |
| PHP | `intelephense`, `phpactor` | `composer.json` |
| Java, C#, INI, PowerShell, JSON | none (fallback only) | — |

<a id="server-trust"></a>
### Trust

The project's `typescript`, `gopls`, `rust-analyzer`, the project's Prettier and its config/plugins run project code, as agents already do (no sandbox). This adds no new trust boundary. The app never launches servers from outside `PATH` and the project.

<a id="typescript-features"></a>
## Editor actions

| Action | Input | Menu item |
| --- | --- | --- |
| Go to definition | ⌘+click, ⌘B | Editor ▸ `Go to definition` |
| Previous / next location | ⌃− / ⌃⇧− | Navigate ▸ `Previous location` / `Next location` |
| Completion | while typing, ⌃Space | Editor ▸ `Show completions` |
| Hover: type and docs | pointer over a name, 350 ms | — |
| Parameter hints | `(` and `,`, ⌘⇧Space | Editor ▸ `Show parameters` |
| Find references | ⌥F7 | Editor ▸ `Find references` |
| Next / previous problem | F2 / ⇧F2 | Editor ▸ `Next problem` / `Previous problem` |
| Format document | ⇧⌥F | Editor ▸ `Format document` |
| Restart language servers | — | Editor ▸ `Restart language servers` |

- Holding ⌘ over a name underlines it and shows a hand cursor. The underline does not depend on the result (asking the server on each mouse move is too costly).
- Location history belongs to the task: up to 50 steps, survives tab switches. Each jump to a definition or a reference records a step. ⌘[ stays Outdent, so history uses ⌃−.
- Completion: the server ranks; CodeMirror only filters while the word is typed and only until the server says `isIncomplete`. `resolveCompletion` on selection supplies details, documentation and additional edits (TypeScript auto-import). Snippets are not declared (`snippetSupport: false`); plain text is inserted and the editor adds call parentheses (see [Typing help](#typing-help)).
- Hover and parameters render Markdown without HTML (`markdown-it`, `html: false`); code in them uses the editor's monospace font and syntax classes. Surfaces use design tokens (`--card`, `--sep`, popup radius and shadow). Esc closes them; Esc sits above `defaultKeymap` (`Prec.high`) so it also closes a problem tooltip opened by `Next problem`.
- ⌃Space often switches the keyboard layout on macOS; then the menu shortcut does nothing, but completion still opens while typing. No second shortcut without a menu item.
- A file outside the project (for example `lib.dom.d.ts` of the bundled `typescript`) opens read-only: `EditorDocument.readOnly` and the line `This file is outside the project. Read only.` `node_modules` files inside the project open normally.

<a id="definition-and-usages"></a>
## Go to definition and usages

`Go to definition` is one command for ⌘+click, ⌘B, the menu-bar item, the editor context menu item and ⌘+click in the diff.

| Result | Behavior |
| --- | --- |
| One location | File opens as a tab at line and column |
| Several locations | Same grouped list as `Find references` |
| None | Footer shows `No definition found.` for 3 s |
| A found location is the clicked name itself (same file, line, column within the word) | The cursor is already on the declaration: the command runs `Find references` from there and opens the `References` modal |

- With several definitions (overloads, declaration merging, several by-name matches), it is enough that one of them is the click location.
- A single usage does not jump directly: the modal lists it with the declaration, so ⌘+click and ⌥F7 behave the same on a declaration. No usages: the modal's empty state `No references found.` (with a server, the declaration stays in the list).
- Import chain: while tsserver loads the project, `definition` on an imported name returns its own import binding. Main follows the binding (up to 3 hops, the second after 500 ms) until it leaves the import line. Only `import`, re-exports (`export { … }`, `export * from`) and `require(…)` count as import lines, so an `export const` declaration resolves without the pause.
- In fallback, declarations of the current file are found by name, so the same rule works; if the same name is declared elsewhere, fallback goes to that other declaration (by name, it cannot tell which one is real).

<a id="css-modules"></a>
### CSS Modules

In JS/TS/TSX, `Go to definition` on `styles.foo` or `styles['foo-bar']` opens the literal class selector in the imported CSS/SCSS file (source `stylesheet`).

- The binding is resolved through the actual import (`styleReference`), respecting local shadowing; only relative imports of `.css`/`.scss` count.
- The target's unsaved buffer is used when it is open; otherwise the file on disk.
- Only literal selectors in rule headers match (`styleClassOffsets`); comments, strings and declaration values do not. Several matches use the usual locations list (capped at 20).
- Path aliases and Sass-interpolated class names are not resolved. There is no project-wide class search: the same class name belongs to different modules.

<a id="fallback-mode"></a>
## Fallback mode

Serves languages without a server, failed starts, exhausted restarts and `Language servers` off.

- **Definition.** First declarations in the current file with the name under the cursor, then other files of the same language family found by the project file walk. The walk covers all repos of the project, not only the task's repos (navigation is read-only and declarations often live in a sibling repo). Candidates are prefiltered by whole-word search, then the syntax worker confirms the name is declared.
- **Language families.** JS, TS and TSX form one family; CSS and SCSS form another. Each file is parsed with its own grammar.
- **Budget.** 200 files, 1 MiB per file, 2 s of reading. The first tree walk is shared with Open Quickly and is not counted.
- **Footer note.** `Found by name: no language server for {language}.` or `Found by name: language servers are off.` The note lives in the task state and survives switching tabs.
- **Completion** uses document words (`completeAnyWord`), without main.
- **Hover and parameters** are not shown in fallback: types are never invented.
- **Read-only copies** of a file locked by another task always use fallback.

<a id="references-and-problems"></a>
## References and problems

**`References` modal** (⌥F7, or ⌘+click on a declaration):

- Header with the shared `PopupClose` (Esc); see [Appearance](appearance.md).
- Rows grouped by file: path, line number and the line text. Over 500 results: `The list is shortened.`
- Arrows and Enter open the location, record a history step and return focus to the editor.
- In fallback the modal shows whole-word text matches and says so: `Text matches: no language server for {language}.` / `Text matches: language servers are off.`

**Problems:**

- `publishDiagnostics` for an open document is converted to `CodeProblem` against the mirror version and pushed as an event.
- Drawn by `@codemirror/lint`: wavy underline in `--red` / `--amber` / `--fg3` by severity, message on hover.
- Problems of closed files are neither collected nor stored: this is a hint for the open file, not a project linter.

<a id="diff-cmd-click"></a>
## ⌘+click in the diff

⌘+click on a name in the new side of a task diff opens the file in the editor at that line and column and runs `Go to definition` there (so the declaration rule above applies too).

- The renderer passes the diff line text; after opening, the editor compares it with the document line. Mismatch (the file changed after the snapshot): footer `The file changed. Refresh the changes.`, no jump.
- The old side and commit diffs do not handle ⌘+click: they do not match the text on disk.
- The new side of a PR file diff resolves by name in the PR head tree without the editor or disk: see [Pull requests](pull-requests-and-ci.md).

<a id="typing-help"></a>
## Typing help

Four booleans in `settings.editor`, all default `true`. Missing fields read as defaults (`schemaVersion` stays 1). Changes apply to open editors immediately.

| Key | Settings row | Behavior |
| --- | --- | --- |
| `languageServers` | `Language servers` | Off: no server starts, live ones stop, all files use fallback |
| `closeBrackets` | `Bracket pairs` | `(` `[` `{` `'` `"` and `` ` `` (JS/TS, Go, Shell) close; `<` only for a TS generic |
| `closeTags` | `Closing tags` | `>` after an open tag adds the closing tag in HTML, XML, Vue, Svelte and JSX/TSX |
| `callParens` | `Call parentheses` | A function or method completion from a server adds `()` with the cursor inside |

**Bracket pairs** (CodeMirror `closeBrackets`):

- The closing character is inserted only before whitespace, end of line or a closing bracket. Typing the closer steps over the inserted one; Backspace inside an empty pair deletes both; a selection is wrapped.
- A quote does not pair after a letter (`don't`) or inside a string (judged by highlight tokens; there is no second parser).
- `<` pairs as `<>` only in TS/TSX right after a capitalized name or a hook (`Array<`, `Promise<`, `useState<`). `i<n` and `a < b` never pair.

**Closing tags** (a text scanner before the cursor checked against highlight tokens, not a second parser):

- `<div` + `>` → `<div>|</div>`; `<Card.Header title="…"` + `>` → `…>|</Card.Header>`; fragment `<` + `>` → `<>|</>` (JSX only).
- Not closed: self-closing `/>`, `</…`, `<!…`, `<?…`, HTML void elements (`br`, `img`, `input`, `meta`, `link`, `hr`, …), `<` in a comment or string, `<` right after a name, `)` or `]` (comparison, generic), `>` inside `{…}` or attribute quotes (`onClick={() => …}`), and when the same closing tag already follows the cursor. Plain `.ts` (no JSX) never closes tags.
- Enter between `>` and `</` splits the tag onto three lines with indentation, like Enter between brackets.

**Call parentheses:**

- Completion kinds `function` and `method` add `()` with the cursor between. tsserver reports `variable` for imported names and `const f = () => …`, so for `variable`, `constant` and `property` the `detail` from `resolveCompletion` decides: `function …`, `(method) …`, or a type starting with `(` (`(alias) const getPlace: (id: number) => …`).
- The answer arrives tens of milliseconds after insertion; if the user typed meanwhile, no parentheses. A typed `)` steps over the inserted one. Parameter hints open right away.
- No parentheses when `(` already follows, inside `import { … }` / `export { … }`, after `typeof`/`keyof`, for a tag name after `<` or `</`, or for a JSX attribute value right after `={` (`onClick={handleClick}` passes the function).
- Fallback completions never add parentheses (document words have no kind). The cursor stays between the parentheses even when the function takes no parameters.

<a id="language-servers-toggle"></a>
## Turning language servers off

- Off: main starts no servers and stops live ones; problems of open files are cleared. Open editors switch to fallback without reopening the tab (the renderer resends `openCode`).
- `Call parentheses` is disabled while servers are off (completions have no kind).
- Formatting through the language server is unavailable; the project's Prettier still works.
- On: servers come back with the first request of each open file.
- One switch for the whole app, not per language or project: memory counts in total.
- The first-run intro shows the same `Language servers` row with the detail "Code completion, definitions, and diagnostics. About 0.45 GB per project." (see [Onboarding](settings-modules-and-onboarding.md)).

<a id="language-server-restart"></a>
## Restarting language servers

**In place.** A restart keeps the same server entry, so every task whose documents it serves stays with it.

1. The old process stops cleanly (`shutdown` → `exit`); problems of its documents are cleared.
2. The launch command is computed again (TypeScript searches `node_modules/typescript` upward again).
3. The new process receives all open documents. The crash counter resets: a language that fell into fallback after crashes tries the server again. A restart does not count as a crash.
4. Main broadcasts `code:restarted` with the affected owner keys; their editors resend `openCode`, so fallback documents return to the server and problems redraw from the new process.

**Scope.** Servers serving the task's documents, plus servers its fallback documents would go to (same language, file under the server root). Servers of other projects are untouched; other tasks' documents on the same server go through the restart with it. A task without open code documents restarts nothing.

**Command.** Editor ▸ `Restart language servers` (glyph `refresh`, starts its own group in the Editor menu), also reachable through Find Action. No default shortcut. Enabled whenever a task is open, focus anywhere in the task. Result toast:

| Case | Toast |
| --- | --- |
| Restarted | `Language servers restarted: {names}` (comma-separated, e.g. `TypeScript`) |
| Nothing to restart | `No language servers are running` |
| Switch off | `Language servers are off in Settings` |

**Agent tool.** MCP `editor_restart_language_servers`, no parameters, does the same for the agent's task. Returns `restarted` (server names) and a `note` when nothing was restarted or servers are off. No permission card (changes no files, starts only already allowed servers). Available to the task agent and the root foreman, like `editor_state`. Its description says to call it after installing dependencies, editing `tsconfig`/`jsconfig` or replacing `node_modules`, when the editor shows errors that are gone. Chat row: `Restarting the language servers` / `Restarted the language servers` / `Could not restart the language servers`; detail is the server names or `nothing to restart`.

**Auto-restart after install** (TypeScript servers only). Every 2 s main `lstat`s at the server root:

- `node_modules` itself: folder or symlink, inode, link target;
- install-end markers: `node_modules/.package-lock.json` (npm), `node_modules/.modules.yaml` (pnpm), `node_modules/.yarn-state.yml` and `node_modules/.yarn-integrity` (yarn), `.yarn/install-state.gz` (yarn PnP).

The server restarts when the stamp differs from the one recorded at start and held for two polls in a row, `node_modules` exists, and a marker present at start is present again (so `npm ci`, which first deletes the folder, does not wake the server mid-install). The recorded stamp updates after the restart. Nested `node_modules` of workspace packages are not polled: package managers write the marker at the install root. Cost: up to 3 servers × 7 `lstat` every 2 s.

<a id="format-on-save"></a>
## Format on save

**Modes.**

| Key | Values | Default | Where |
| --- | --- | --- | --- |
| `settings.editor.format` | `'auto' \| 'off'` | `'auto'` (missing field reads as `'auto'`) | `settings.json` |
| `project.formatter` | `'default' \| 'auto' \| 'prettier' \| 'language-server' \| 'off'` | `'default'` (takes the global value) | `project.json` |

**Source choice in `auto`, per file:**

1. The project's Prettier, if present and the file suits it.
2. Otherwise the file's language server, if it declared `documentFormattingProvider` in `initialize`.
3. Otherwise nothing, silently.

Explicit `prettier` or `language-server` without that source does not format and shows a note.

**Prettier only from the project.**

- Main searches `node_modules/prettier` upward from the file to the task's project root. No bundled Prettier: a different version or defaults would produce diffs on untouched lines.
- Config comes from Prettier itself: `resolveConfig(file, { editorconfig: true })`, so nested `.prettierrc` files work.
- `getFileInfo` uses the nearest `.prettierignore` within the file's git root (a nested repo keeps its own ignore and Prettier version). An ignored file is formatted by nothing, the language server included.
- `inferredParser: null` means Prettier does not apply, and `auto` falls through to the language server.
- One worker per Prettier module path (`PrettierPool`, `prettier-worker.ts` → `out/services/prettier.cjs`), a child process via `ELECTRON_RUN_AS_NODE`, JSON-RPC with LSP framing. The module loads from its own folder via `createRequire`, so Prettier 2 and 3 both work. Starts on first use, stops after 10 minutes idle. Request 3 s; first request including start 10 s.

**Language server formatting** uses the server already running for the file (`textDocument/formatting`). `tabSize`/`insertSpaces` come from the document's indentation (tabs if more lines are tab-indented, otherwise the smallest space step, default 2). `.editorconfig` is not read for the language server.

**Result is edits, not text.** `formatCode(key, id, version)` returns `CodeEdit[]` (`{ from, to, insert }` in document offsets), or `{ skipped: 'none' | 'ignored' | 'not-found' | 'unsupported' }`, or `{ failed: 'syntax' | 'timeout' | 'crashed', line?: number }`. For Prettier, main computes minimal edits from a line diff of old and new text (`@brigadir/diff`). LSP and Prettier types never reach the renderer.

**⌘S order:**

1. Format.
2. Apply edits in one CodeMirror transaction with `userEvent: 'format'`: one ⌘Z undoes it, cursor and selection map through the changes, review comment decorations on untouched lines stay.
3. Write via the same `saveEditorFile`.

If the document changed during formatting, the edits are dropped and the current text is saved unformatted. A formatter error or timeout never blocks the write.

**`Format document`** (⇧⌥F, Editor menu after `Toggle comment`) uses the same source choice and works even when saving is set to `off`. The menu item stays enabled: the source is known only after asking Prettier.

**Scope.** Only what the user saves in the editor is formatted. Files written by the agent and files in the diff not opened in the editor are not. Formatting edits in review belong to the user, not the agent.

Implementation: `packages/lsp/src/prettier.ts`, `prettier-worker.ts`; `CodeIntel.format` / `canFormat` / `snapshot`; `desktop/main/format.ts` (mode choice, line diff → edits, project choice read/write); `CodeIntelBridge.format` / `formatInfo`; renderer `editor-format.ts`, `EditorSettings.tsx`, footer in `CodeEditor`.

<a id="format-states"></a>
### Formatting states in the editor

The editor footer, after the language name, shows the source that will format on save: `· Prettier` or `· Language server`. No source or `off`: nothing.

Other results show only when something goes wrong, as a footer notice that clears with the next edit:

| Result | On save | On `Format document` |
| --- | --- | --- |
| `failed: 'syntax'` | `Not formatted: syntax error on line N. The file is saved.` (the line number is a link) | `Not formatted: syntax error on line N.` |
| `failed: 'timeout' \| 'crashed'` | `The formatter did not respond. The file is saved without formatting.` | `The formatter did not respond.` |
| explicit `prettier`, `not-found` | `Prettier was not found in the project.` | same |
| explicit `language-server`, `unsupported` | `The language server does not format this file.` | same |
| nothing can format | — | `No formatter for this file.` |

`auto` with `none` or `ignored` shows no note on save.

<a id="editor-settings"></a>
## Settings ▸ Editor

The `Editor` tab of Settings. Sections top to bottom: `Diff base` · `Code` · `Indentation` · `Git` · `Formatting` · `Projects`. Rows have no explanatory captions. The editor font lives in `Appearance`.

| Section | Rows |
| --- | --- |
| `Code` | `Language servers`, `Bracket pairs`, `Closing tags`, `Call parentheses` (switches; see [Typing help](#typing-help)) |
| `Formatting` | `On save` switch (`auto` ↔ `off`) |
| `Projects` | One row per project: name, gray hint `Prettier {version}` or `Prettier not found` (plus the project's indentation note), popup `As default` · `Automatic` · `Prettier` · `Language server` · `Off` |

Choices apply immediately. Save failure: `Could not save the formatter selection.`; load failure: `The formatters could not be loaded.` with `Retry`. `Diff base` is described in [Diff and review](diff-and-review.md), `Indentation` in [Editor](editor.md), `Git` in [Git](git.md).

<a id="syntax-highlighting"></a>
## Syntax highlighting

Highlighting runs in the shared tree-sitter worker (`packages/syntax`, grammars from `@vscode/tree-sitter-wasm` plus vendored ones in `packages/syntax/grammars`, copied to `syntax-assets` by `build:services`; no network).

- Seven token kinds: `keyword`, `string`, `comment`, `number`, `type`, `function`, `property`, drawn as `syntax-*` classes. The cache stores token kinds, never colors: colors apply at paint time from the code theme (`brigadir`, `vscode`, `intellij`), so a theme switch can never show stale colors.
- Positions exchanged with the editor are UTF-16 offsets.
- A file without a grammar (for example `.swift`) is plain text: footer `Plain text`. Files over the syntax limit: `Large file. Plain text mode.`
- Classifier rules (`kind()`):
  - named nodes `this`, `super`, `true`, `false`, `null`, `undefined`, and Python `True`, `False`, `None` → `keyword`;
  - Python `call`: the function name (`f()`) and the called attribute (`obj.f()`) → `function` (in JS/TS `obj.f()` stays `property`);
  - TS/JS class method names (`method_definition`, `method_signature`, `abstract_method_signature`) → `function`.
- Tests compare exact substrings of spans, not `contains`.

<a id="font-styles"></a>
### Font styles

- Keywords (`.syntax-keyword`) are weight 700, comments (`.syntax-comment`) italic; everything else 400 upright. Colors unchanged. Same in every code theme and in High Contrast.
- One rule in `renderer/tokens.css` covers every highlighted surface: editor, both diff sides, code in chat Markdown and Markdown preview, code-intelligence tooltips, the intro code sample.
- `font-synthesis: none`: a font without bold or italic shows code plain, never faux bold or slanted. Monospace glyph widths are equal across styles, so diff and editor columns do not shift.
- Switch `Font styles` in Settings ▸ Appearance, editor section, right under `Code theme`; key `editor.syntaxStyles: boolean`, default `true` (missing field reads as `true`). Off sets `data-syntax-styles="off"` on `<html>` and the rules stop applying. The code theme remains colors only; font styles are a separate term.

<a id="css-scss"></a>
## CSS and SCSS

- **SCSS is its own language `scss`** with grammar `tree-sitter-scss@1.0.0` (MIT). No prebuilt WASM exists, so it is built for runtime 0.25 (ABI 14) and vendored in `packages/syntax/grammars/` with its license, patch and build command (wasi-sdk, not needed at install). Footer: `SCSS`.
- **Grammar patch** (~100 lines of `grammar.js`) adds the module system (`@use … as/with`, `@forward … as/show/hide/with`), `!default`, `!global`, `@extend %placeholder`, lists in `@each`, mixins from a module (`@include module.mixin`), container style queries and a leading combinator in nested selectors (`> .item`). The grammar's own corpus still passes.
- **Token mapping** (CSS and SCSS, existing seven kinds, no new colors):

| Construct | Kind |
| --- | --- |
| at-rules (`@media`, `@use`, `@mixin`, `@include`, `@if`, …), `!important`, tag selectors, `&` | `keyword` |
| `url()`, `var()`, `math.div()`, mixin names | `function` |
| properties, classes, pseudo-classes and pseudo-elements, media features, `$variables`, `%placeholder` | `property` |
| `@keyframes` name | `type` |

  These node names exist in other grammars too (`variable` in PowerShell), so the mapping applies only to CSS and SCSS.
- **Declarations:** `@mixin` and `@function` are symbols (`symbol_path`) and fallback definition targets, together with `$name: …` and custom properties `--name: …` in CSS and SCSS rules. Nested rules give paths like `.card > .title`.
- Toggle comment (⌘/) in SCSS uses `//` and `/* */`.
- Language server: `vscode-css-language-server` for both; Prettier formats both.
- Known gaps: interpolation inside custom property values (`--x: #{$y}`), non-ASCII class names and a few rare forms stay unhighlighted; the rest of the file parses.

<a id="hyphenated-words"></a>
### Hyphenated words

- In CSS and SCSS `-` is part of a word: `--page-content`, `$gap-sm`, `pad-x` are taken whole from any part. `codeWordAt(text, pos, language)` (shared by renderer, main and LSP) applies this everywhere: ⌘ underline and ⌘+click in the editor, ⌘+click in task and PR diffs, context menu items, completion prefix and hover range, word boundaries in reference search.
- A bare `-` (`a - b`) or a number (`-4px`) is not a word. Other languages are unchanged (`a-b` is subtraction).
- CSS and SCSS are one fallback family: a variable from a `.css` file is found from `.scss` and back.

<a id="json"></a>
## JSON

- Language `json` for `.json` and `.jsonc`. Grammar: prebuilt `tree-sitter-json.wasm` from `tree-sitter-json@0.24.8` (MIT, ABI 14), vendored in `packages/syntax/grammars`. It accepts `//` and `/* */`, so commented `tsconfig.json` parses cleanly. Footer: `JSON`.
- Kinds: object key → `property`, string value → `string`, numbers → `number`, `true`/`false`/`null` → `keyword`, comments → `comment`.
- No declarations (no symbol path, no ⌘+click targets): every pair would be one, and `package-lock.json` would hit the symbol limit and drop to plain text.
- No language server (`vscode-json-language-server` is not searched): schemas and validation are not supported.
- `package.json` scripts in the editor context menu: see [Search, menus and commands](search-menus-and-commands.md).

<a id="verification"></a>
## Verification

| Area | Tests |
| --- | --- |
| `packages/lsp` | Framing, mirror and position conversion; fake server for deadline, cancel, crash, `resync`, restart (new pid, document reopened, problems cleared, crash fallback recovers, off / empty answers), auto-restart on `node_modules/.package-lock.json`; live bundled `typescript-language-server` in a temp project (cross-file definition, completion with auto-import, hover, references, problem, `export const` without import pause); fallback by name in Python; `.tsx` finds a `.ts` declaration; servers off; one CSS server for two `languageId`s; SCSS → CSS `--page-content`; references do not confuse `--page` with `--page-content`; CSS Modules (`style-definition.test.ts`); Prettier pool (`prettier.test.ts`) |
| `core` | `code-intel.test.ts` (declaration detection, `codeWordAt`), settings defaults for `syntaxStyles` and typing fields, menu items and glyphs |
| `packages/syntax` | `syntax.test.ts`: keyword literals, Python calls, method names, CSS/SCSS tokens and declarations, JSON tokens |
| `desktop/main` | `format.test.ts`, `format-fuzz.test.ts`: line diff → `CodeEdit[]` gives the same text; timeout returns `failed`; `auto` without sources returns `skipped: 'none'` |
| renderer | `editor-typing.test.ts`: tag scanner, call-paren context, generic `<`, quote in string |
| `packages/host` | MCP tool list golden includes `editor_restart_language_servers` |
| e2e | `code-intel.spec.ts`, `editor-typing.spec.ts`, `syntax-styles.spec.ts` (behavior only, per test tiers) |

Formatting acceptance on a monorepo with several git roots: a nested repo with its own Prettier version formats the same as its CLI `--stdin-filepath`; an ignored file is untouched and shows no footer source; one ⌘Z restores the pre-format text; review comments on untouched lines stay; a syntax error saves the file as is with a line note; `project.formatter: 'off'` stops formatting on ⌘S while ⇧⌥F still formats.

<a id="later"></a>
## Later

- Custom formatter command (stdin → stdout template, `cwd` at the file's git root, e.g. `biome format --stdin-file-path {file}`).
- Closing-tag name completion when typing `</` for tags typed without auto-close.
- Swift grammar.
- LESS and indented `.sass` grammars.
- Install-marker polling for Python, Go and Rust servers.
- Pinned references list (keep the list visible while walking locations).
- Per-language or per-project language server switch, if a single server proves disruptive.

<a id="non-goals"></a>
## Non-goals

- Rename and code actions: refactorings are the agent's job.
- Monaco or `@codemirror/lsp-client` (a second highlighting pipeline; real paths in the renderer).
- LSP semantic tokens.
- Downloading servers, formatters or grammars at runtime.
- Bundled Prettier; formatting only changed lines (Prettier range formatting and LSP `rangeFormatting` are unreliable); formatting agent-written files.
- `.editorconfig` parsing for language-server formatting.
- Autoclosing `<` everywhere; `@codemirror/lang-html` / `lang-javascript` for tag closing (second parser).
- Project-wide CSS class search; path aliases and Sass-generated classes for CSS Modules navigation.
- New syntax colors beyond the seven token kinds; faux bold/italic.
- JSON schemas and validation.
- Watching `node_modules` with `fs.watch`; restarting on lock-file changes; restarting all app servers; a language-server status bar button.
