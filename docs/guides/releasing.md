# Versions, packages and releases

This guide is for whoever builds Brigadir packages for people: the version policy, building and signing locally,
releasing, and how auto-update works and is tested. The product rules behind it are in
[Packaging and identity](../spec/architecture-and-platform.md#packaging) and
[Auto-update](../spec/architecture-and-platform.md#auto-update).

Commands run in `electron/`; paths are relative to it unless they start with `docs/` or `.github/`.

---

## 1. Version policy

- The version is `version` in `apps/desktop/package.json`. It is the app version people see in About Brigadir and the
  version auto-update compares.
- **Every build handed to people gets a new semver version.** Any new feature → minor (`X.Y+1.0`); fixes only → patch
  (`X.Y.Z+1`). Decide from `git log v<previous>..HEAD`: any `feat` commit makes it a minor release.
- Whoever builds the packages bumps it on the main branch in one commit, `chore(release): X.Y.Z`, and tags that commit
  `vX.Y.Z`. CI refuses a tag that differs from the version in `apps/desktop/package.json`.
- Agents and branches never touch the version.
- The build number (`CFBundleVersion`, the Linux package release) is the commit count; it needs no bump.

## 2. One-time setup

Auto-update reads the GitHub Releases of this public repository, so the app needs no token; releases are
published from a local machine with `GH_TOKEN=$(gh auth token)`.

1. The `releases` field in `apps/desktop/package.json` names the repository (`karaushu/brigadir`). It is the only place
   that does: electron-builder publishes there and writes it into the package's `app-update.yml`, and the app links
   release pages from it. A fork that publishes its own builds sets its own `owner/repo`; the placeholder
   `OWNER/brigadir-releases` makes publishing fail and packaged apps never check for updates.
2. For signed macOS builds, add secrets (Settings ▸ Secrets and variables ▸ Actions):

| Secret | What |
| --- | --- |
| `MAC_CSC_LINK` | the Developer ID Application certificate, a base64 `.p12` |
| `MAC_CSC_KEY_PASSWORD` | the password of that `.p12` |
| `APPLE_API_KEY_PATH` | the App Store Connect API key (`.p8`) for notarization: its contents or a path the runner can read |
| `APPLE_API_KEY_ID` | the key's ID |
| `APPLE_API_ISSUER` | the key's issuer ID |

Without the Apple secrets the macOS build is ad-hoc: it runs, but installs no updates (Squirrel.Mac requires a Developer
ID app) and Gatekeeper blocks a downloaded copy on other Macs.

## 3. Building locally

```sh
pnpm install
pnpm dist:mac            # DMG and update zip for this Mac's architecture
pnpm dist:mac --x64      # Intel; Electron x64 is downloaded once into the cache
pnpm dist:mac --all      # both architectures in one run
pnpm dist:mac --skip-build   # repackage an existing out/
pnpm dist:linux                  # x64: AppImage, .deb, .rpm
pnpm dist:linux --x64 --arm64    # both architectures
pnpm dist:linux --skip-build
```

Output goes to `dist/` (ignored by git): `Brigadir-<version>-<arch>.dmg` and `.zip`, `latest-mac.yml`, the unpacked
`dist/mac-arm64/Brigadir.app` (x64: `dist/mac/`), and for Linux `Brigadir-<version>-<arch>.AppImage`, `.deb`, `.rpm`,
`latest-linux.yml` and `latest-linux-arm64.yml`. Never commit packages.

`--publish` (both commands) uploads the packages and `latest*.yml` into a release of the releases repository; it needs
`GH_TOKEN` with write access there and refuses the placeholder `releases`. See [section 4](#4-releasing).

### macOS

What `scripts/dist.mjs` does:

1. `pnpm build` with `BRIGADIR_MAC_ARCHS=arm64,x86_64`: the native helpers (`fonts`, `sim-helper`,
   `notification-auth.node`, `process-owner`, `mcp-relay`, `cli-relay`) compile fat, so one services folder serves both
   architectures.
2. Stage `dist/stage`: `app/` holds only `out/main`, `out/preload`, `out/renderer`, `out/renderer-mobile` and a
   `package.json` without dependencies (main bundles everything but `electron`); `services/` is a copy of `out/services`.
3. One electron-builder run (`packaging/electron-builder.config.mjs`) for every architecture asked: `app.asar` with UI and
   main, `services` outside the archive in `Contents/Resources/services`, `node-pty` of the target architecture only,
   no `.map` files. Targets are the DMG people download and the zip Squirrel.Mac installs; one run writes one
   `latest-mac.yml` listing both zips. The icon is compiled from `apps/desktop/resources/brigadir.icon` by `actool`
   (Xcode 26).
4. `scripts/check-dist.mjs` mounts each DMG read-only (`hdiutil attach -nobrowse -readonly`) and checks, without
   launching the app:
   - `Info.plist`: bundle id, name, icon, local network usage keys;
   - `app-update.yml`: provider `github`, owner and repo of `releases`, a cache directory name;
   - `app.asar` holds main, preload and both renderers and no `node_modules`; Electron's `default_app.asar` is gone;
   - every required service, and `node-pty` prebuilds only for that architecture;
   - each Mach-O's architectures (fat helpers) and signature, `codesign --verify --deep --strict`, hardened runtime,
     entitlements, no App Sandbox; with Developer ID, the Developer ID signature and `spctl` acceptance;
   - then `latest-mac.yml`: this version, with the zip of every architecture built, and the zips exist.

   Run it alone with `pnpm dist:check dist/Brigadir-<version>-arm64.dmg [--x64]`.

**Signing and notarization.** Without environment variables the build is signed ad-hoc (`codesign -s -`) with hardened
runtime and the same entitlements. It runs on the Mac that built it; on another Mac Gatekeeper blocks the downloaded
DMG. A trusted person can open it anyway from System Settings ▸ Privacy & Security, or with
`xattr -dr com.apple.quarantine /Applications/Brigadir.app`.

| What | Environment |
| --- | --- |
| Developer ID Application certificate | `CSC_LINK` (path or base64 `.p12`) + `CSC_KEY_PASSWORD`, or `CSC_NAME` (a certificate in the keychain) |
| Notarization (preferred) | `APPLE_API_KEY` (path to `.p8`), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` |
| Notarization (alternatives) | `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`; or `APPLE_KEYCHAIN_PROFILE` |

Notarization without a certificate is a script error, never a silent ad-hoc build. After notarization electron-builder
staples the ticket.

**Entitlements** (`packaging/entitlements.mac.plist`, the same for the app and its helpers): `allow-jit` and
`allow-unsigned-executable-memory` (V8 and Node under `ELECTRON_RUN_AS_NODE`), `disable-library-validation` (`.node`
add-ons). There is no App Sandbox, and the `RunAsNode` fuse stays on: task hosts, language servers, Prettier and the
Android helper run on it.

**Identity and data.** The release bundle id is `com.karaushu.brigadir`; the local dev copy (`pnpm start`) is
`com.karaushu.brigadir.dev`, so notification permission and keychain entries never mix. Both use `~/.brigadir/`:
do not run a release and the dev copy on the same data at once, since both attach to task hosts. Try a release with
`BRIGADIR_DATA_DIR=/absolute/temporary/path`.

**Test the packaged app** without taking focus (Playwright keeps it in the background with temporary data):

```sh
pnpm dist:mac
BRIGADIR_PACKAGED_APP="$PWD/dist/mac-arm64/Brigadir.app" pnpm exec playwright test tests/packaged.spec.ts
```

It launches the bundle with a Finder-like `PATH` and checks main from the archive, the login shell's `PATH`, the font
helper and a task host from `Contents/Resources/services`, and an agent fixture through the package's
`ELECTRON_RUN_AS_NODE`. Only the bundle of this Mac's architecture runs live; an x64 bundle on Apple Silicon would go
through Rosetta, so `check-dist` covers it statically.

### Linux

Needed on `PATH`: `zig` 0.17 and `nfpm`; `rpm` to read the `.rpm` back; 7-Zip for the AppImage contents
(electron-builder caches one). Builds run on a Mac or on Linux.

What `scripts/dist-linux.mjs` does:

1. `pnpm build`, the same `out/` as for macOS.
2. Per architecture, stage `dist/stage-linux-<arch>`: the app (main, preload, both renderers, a `package.json` without
   dependencies, `desktopName: brigadir.desktop`) and a copy of `out/services` in which `scripts/linux-natives.mjs`
   replaces the natives: `zig cc` for `process-owner`, `mcp-relay` and `cli-relay`, `zig c++` for `node-pty`'s
   `pty.node` (Node-API, static libc++, glibc ≥ 2.28), and drops the macOS-only helpers.
3. electron-builder (`linuxBuilderConfig`): AppImage and `.deb`, package and executable `brigadir`, `services` in
   `resources/services` outside the archive, `latest-linux.yml` / `latest-linux-arm64.yml`.
4. `scripts/rpm.mjs` writes the `.rpm` with nfpm from the same unpacked folder: `/opt/Brigadir`, `/usr/bin/brigadir`,
   the `.desktop` file and icon; the release is the commit count.
5. `scripts/check-linux.mjs`, without running anything: every binary under `services` is an ELF of the right
   architecture with its exec bit and from the expected list, links only glibc ≤ 2.28, `pty.node` exports only Node-API
   entry points; no Mach-O or macOS helper; all services present; `app.asar` without `node_modules`; `app-update.yml`
   of the releases repository; `latest-linux*.yml` of this version listing an AppImage; the `.deb` (`ar`/`tar`:
   services, modes, `Depends`), the `.rpm` (`rpm -qplv`: services, modes, `Requires`) and the AppImage (type 2, runtime
   architecture, contents through 7-Zip).

What people install:

- **Fedora, RHEL, openSUSE:** `sudo dnf install ./Brigadir-<version>-x86_64.rpm` (ARM: `aarch64`).
- **Ubuntu, Debian, Mint:** `sudo apt install ./Brigadir-<version>-amd64.deb`.
- **Other distributions:** the AppImage (`chmod +x`); it needs FUSE 2 and libsecret. Its task hosts run from the
  AppImage's mount, so they stop when the app quits and tasks recover on the next start; agents that keep working with
  no window need the `.deb` or `.rpm`. Auto-update replaces a versioned AppImage file with the new version's name; keep
  it under a name without a version (e.g. `Brigadir.AppImage`) to have it replaced in place.
- A secret service (GNOME Keyring or KWallet) holds the remote access key; without it the gateway does not listen.

Windows is a later full build: `dist.mjs --win` refuses and lists what is missing.

## 4. Releasing

Releases are built and published **locally only**; there is no CI build. `node scripts/release-target.mjs vX.Y.Z` (in
`electron/`) checks the tag against the version and the `releases` field before publishing.

```sh
# on main, with every change in
# bump "version" in electron/apps/desktop/package.json to X.Y.Z
git commit -am "chore(release): X.Y.Z"
git tag vX.Y.Z
git push origin main vX.Y.Z
cd electron
GH_TOKEN=$(gh auth token) pnpm dist:mac --all --publish
GH_TOKEN=$(gh auth token) pnpm dist:linux --x64 --arm64 --publish
gh release upload vX.Y.Z dist/*.rpm --repo karaushu/brigadir
# electron-builder uploads both architectures at once and can lose a file; upload whatever the draft lacks
gh release view vX.Y.Z --repo karaushu/brigadir --json assets --jq '.assets[].name'
gh release upload vX.Y.Z <missing files from dist/> --repo karaushu/brigadir --clobber
gh release edit vX.Y.Z --repo karaushu/brigadir --draft=false --latest
```

- `--publish` uploads the DMGs, zips, blockmaps, AppImages, `.deb` files and `latest-mac.yml` / `latest-linux.yml` /
  `latest-linux-arm64.yml` into a **draft** release; the `.rpm` files (made by nfpm) are uploaded with
  `gh release upload`. Apps see the version only after `--draft=false`, so they never meet a release with half its files.
- Push the tag before publishing. A draft release has no tag of its own: if the tag is missing on GitHub,
  `--draft=false` creates it on the remote `main` as it is then, which may be the previous release's commit.
- The Linux packages build on a Mac with `zig`, `nfpm` and `rpm` (`brew install zig nfpm rpm`).
- Without the Apple secrets in the environment the macOS packages are ad-hoc (section 2).

## 5. How auto-update works

The full behavior is in [Auto-update](../spec/architecture-and-platform.md#auto-update). In short:

- Packaged apps check a minute after start, every 6 hours, and on **Check for Updates…** (Brigadir menu on macOS, Help
  on Windows and Linux). Development builds never check.
- A Developer ID macOS app and an AppImage download a newer version in the background (Settings ▸ Language ▸ Updates
  ▸ `Download in the background`) and show `Brigadir X.Y.Z is ready` with `Restart to update`; the update also installs
  on quit. An ad-hoc macOS app, a `.deb` and an `.rpm` only announce the version and open its release page.
- Nothing installs while an agent turn runs: a restart waits for the turns, a quit leaves the update for the next one.
- Task hosts outlive the app and run from the old bundle. The new app finds them by the `appVersion` in `host.json` and
  replaces each at its next moment with nothing running; the next message starts a host of the new version.

## 6. Testing auto-update

**With a local update server** (no GitHub, packaged builds only):

1. Build version A as usual (`pnpm dist:mac` or `pnpm dist:linux`) and install it.
2. Bump `version` locally to B (do not commit) and build again. `dist/` now holds B's packages and `latest*.yml`.
3. Serve `dist/`: `python3 -m http.server 8080 -d dist`.
4. Start A with the test feed and temporary data:

   ```sh
   BRIGADIR_UPDATE_URL=http://127.0.0.1:8080/ BRIGADIR_DATA_DIR=/tmp/brigadir-update-test \
     /Applications/Brigadir.app/Contents/MacOS/Brigadir
   ```

   `BRIGADIR_DATA_DIR` skips the scheduled checks; use **Check for Updates…**.
5. Expect `Brigadir B is ready` (an ad-hoc macOS build or a `.deb`/`.rpm`: `Brigadir B is available`), then
   `Restart to update`. Start a turn first to see the restart wait and `Cancel restart`.

On macOS the install step needs both A and B signed with the same Developer ID certificate: Squirrel.Mac refuses an
update whose signature does not match the running app. An ad-hoc build exercises everything up to the announcement.

**With a test releases repository:** create a second public repository, point `releases` at it in a local change, and
publish A and then B there with `pnpm dist:mac --publish` (`GH_TOKEN` with write access). Releases made this way start
as drafts; publish each with `gh release edit vX.Y.Z --repo <owner>/<repo> --draft=false`. Install A and check.

**Host replacement:** with A running a GUI task, install B. After B starts, the task's host keeps its turn; when the turn
ends, `host.json` of the task changes to a host whose `appVersion` is B after the next message, and the journal shows
`host.stopped` with reason `update` in between.
