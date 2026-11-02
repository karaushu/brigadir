# Geist and Geist Mono (spec/appearance#fonts)

The app's own interface and code fonts on every OS. The variable `woff2` files of `geist@1.8.1` from npm
(github:vercel/geist-font, SIL Open Font License 1.1, `LICENSE-geist.txt`), unchanged; only the italic files are renamed
from `*-Italic[wght].woff2` to `*-Italic-Variable.woff2`. `tokens.css` declares them with `@font-face`; the renderer
builds copy `LICENSE-geist.txt` next to the hashed fonts (`fontLicence` in `vite-font-licence.ts`).

Code ligatures are Stylistic Set 11 (`font-feature-settings: "ss11"`), behind the Ligatures switch of each code surface.
The version stays at 1.8 or newer: up to 1.7.1 the ligatures came on by themselves with `liga`.

```sh
npm pack geist@1.8.1 && tar xzf geist-1.8.1.tgz
cp package/dist/fonts/geist-sans/Geist-Variable.woff2 .
cp 'package/dist/fonts/geist-sans/Geist-Italic[wght].woff2' Geist-Italic-Variable.woff2
cp package/dist/fonts/geist-mono/GeistMono-Variable.woff2 .
cp 'package/dist/fonts/geist-mono/GeistMono-Italic[wght].woff2' GeistMono-Italic-Variable.woff2
cp package/LICENSE.txt LICENSE-geist.txt
```
