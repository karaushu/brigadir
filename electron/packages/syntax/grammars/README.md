# Grammars not shipped by `@vscode/tree-sitter-wasm`

## `tree-sitter-scss.wasm` (spec/editor-code-intelligence)

`tree-sitter-scss@1.0.0` from npm (github:tree-sitter-grammars/tree-sitter-scss, MIT, `LICENSE-tree-sitter-scss`) with
`tree-sitter-scss.patch`, ABI 14 for the 0.25 runtime of `@vscode/tree-sitter-wasm`. Upstream's rules are unchanged
since 1.0.0; the patch adds what real Sass needs: `@use … as/with`, `@forward … as/show/hide/with`, `!default` and
`!global`, `@extend %placeholder`, `@each … in a, b`, `@include module.mixin`, `@container style(--x: y)` and nested
selectors starting with `>`, `~` or `+`. Upstream's corpus passes unchanged (56/56).

```sh
npm pack tree-sitter-scss@1.0.0 tree-sitter-css@0.20.0
tar xzf tree-sitter-scss-1.0.0.tgz && mkdir -p package/node_modules
tar xzf tree-sitter-css-0.20.0.tgz -C package/node_modules && mv package/node_modules/package package/node_modules/tree-sitter-css
cd package && patch -p1 < tree-sitter-scss.patch
npx tree-sitter-cli@0.25.10 generate --abi 14
npx tree-sitter-cli@0.26.13 build --wasm -o tree-sitter-scss.wasm .   # 0.26 builds with wasi-sdk, no emscripten
```

## `tree-sitter-json.wasm`

The prebuilt `tree-sitter-json.wasm` of `tree-sitter-json@0.24.8` from npm (github:tree-sitter/tree-sitter-json, MIT,
`LICENSE-tree-sitter-json`), ABI 14, unchanged. The grammar takes `//` and `/* */` comments, so `.jsonc` and
`tsconfig.json` use it too.

```sh
npm pack tree-sitter-json@0.24.8 && tar xzf tree-sitter-json-0.24.8.tgz && cp package/tree-sitter-json.wasm .
```
