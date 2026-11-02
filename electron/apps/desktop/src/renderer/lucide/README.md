# Lucide (spec/appearance)

The project icon set: every icon of `lucide-static@1.60.0` from npm (github:lucide-icons/lucide, ISC licence; part of
the icons comes from Feather under MIT — both texts are in `LICENSE-lucide.txt`). The geometry is unchanged; only the
format is:

- `icons.json` — `icon-nodes.json` of the package, keys sorted, minified: `{ name: [[tag, attributes], …] }`.
  The renderer builds the SVG from these nodes (no markup strings) on the 24 × 24 grid.
- `tags.json` — `tags.json` of the package, keys sorted, minified: the search words of each icon.

The renderer loads both lazily (`project-icons.ts`); main reads the names from `tags.json` to check the agent's pick.
Renderer builds copy `LICENSE-lucide.txt` next to the hashed assets (`vite-font-licence.ts`).

```sh
npm pack lucide-static@1.60.0 && tar xzf lucide-static-1.60.0.tgz
python3 -c "import json; n=json.load(open('package/icon-nodes.json')); json.dump({k:n[k] for k in sorted(n)}, open('icons.json','w'), separators=(',',':'))"
python3 -c "import json; t=json.load(open('package/tags.json')); json.dump({k:t[k] for k in sorted(t)}, open('tags.json','w'), separators=(',',':'))"
cp package/LICENSE LICENSE-lucide.txt
```
