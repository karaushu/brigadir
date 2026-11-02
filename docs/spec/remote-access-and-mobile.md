# Remote access and mobile

Brigadir can run on one computer (the working machine) and be controlled from Brigadir on another computer (a device) over a mutually authenticated TLS link. Agents, git, terminals, the browser and the simulator stay on the working machine, and nothing the device does opens on the working machine's screen. A phone can also reach the working machine through a cut-down web app (PWA) served by the machine itself over Tailscale, with passkey sign-in.

<a id="terms"></a>
## Terms

| Term | Meaning |
|---|---|
| Working machine | The computer where Brigadir runs the agents, git, terminals, browser and simulator. It acts as the server. |
| Device (`Device`) | A paired computer or phone that controls a working machine. In the UI, simulators and emulators are always called *simulator*, never "device". |
| Machine window | A window on a device that shows another machine. |
| Host | Reserved for the task process (`packages/host`). Never use it for the working machine. |

- Machines are named by their own names in the UI, without the OS name.
- Both full builds (macOS and Linux) can be a working machine and a device. Either one can connect to the other. Windows will come later, also as a full build. The phone web app is the only client that has no working machine of its own. See [Architecture and platform](architecture-and-platform.md).

<a id="architecture"></a>
## Architecture

- **The working machine is the server, and the client is the same renderer.** The main/preload/renderer boundary ([IPC boundary](architecture-and-platform.md)) is the only boundary. Its table `core/ipc-channels.ts` lists each method with its channel, kind (invoke/subscribe) and validator, and the preload is built from that table.
- **Each row has a class.**
  - `remote`: run by the working machine's main. Almost every row is in this class.
  - `client`: run by the main of the computer that shows the window. This covers the clipboard, `openExternal`/`links:open`, notifications, native menus without machine data, the menu bar, theme and accent, and picking local files.
- **Row flags.**
  - `forbidden`: never callable from a device.
  - `guarded`: callable, but main keeps some values.
  - `bulk`: the response can be megabytes, so calls run one at a time per connection. See [Outbox](#outbox).
- **The client set.** The working machine's main sends events to a set of clients (`main/clients.ts`): its local window plus the remote connections. Task hosts and their sockets are unchanged and never see the network.
- **One entry point, `main/dispatch`.** Every call runs through these steps in order:
  1. The table's validator checks it.
  2. A machine window forwards `remote`-class rows to its connection. The preload is the same as in a local window.
  3. Calls from a device never reach `client` or `forbidden` rows.
  4. The handler runs. A remote call uses the same validators and handlers as a local one.
- **Client mode is part of the app, not a separate app.** `File ▸ Connect…` opens a window of a remote machine. That window runs the device's own local renderer bundle. Shortcuts and the menu bar come from the device's platform.
- **Versions must match exactly.** The login sends `ipcTableHash()`. The hash covers the validators' source text, so both sides must be the same build. If the hashes differ, the login is refused with `Brigadir on {machine} is another version. **Update Brigadir on {machine}**, then connect.` Nothing partly works.
- **Packages.**
  - `packages/remote` is Node code with no Electron. It depends on `core`, `persistence`, `ws`, `@noble/curves`, `@noble/hashes` and `bonjour-service`. It holds the certificates, CPace, passwords, the `remote/` files, the gateway, the device connection, mDNS, the reachability probe, the web gateway, WebAuthn and Web Push.
  - `desktop/main/remote-access.ts` holds the Electron side: `safeStorage`, the client set and machine windows.
  - `main/client-ui.ts` is the single point through which every native menu or dialog is shown.
- **Build note.** `ws` is bundled into main with its optional native helpers turned off (`WS_NO_BUFFER_UTIL`, `WS_NO_UTF_8_VALIDATE`). When those helpers were bundled as empty modules, they broke frames of 48 bytes or more.

<a id="phases"></a>
### Phases

The phase names appear in code comments and test names.

| Phase | Scope |
|---|---|
| R0 | Channel table with classes, the client set, preload from the table |
| R1 | Gateway, pairing, password, machine window, cover, settings UI |
| R2 | Menus, dialogs, folder browser and file uploads from a device |
| R3 | Browser screencast, page dialogs, simulator, agent sign-in, machine-window close and crash |
| R4 | mDNS, reachability, address ranking, heartbeat, reconnect and network changes, page pickers, IME, Codex sign-in relay |
| R5 | A client-only build. Dropped: only full builds exist |
| W0 | Phone web listener, passkey sign-in, the `web` class, Web Push |
| W1 | Phone home, project, chat, composer, questions and permissions, new task |
| W2 | Phone Changes, PR with merge, files, read-only terminal |
| W3 | Phone project PR list and board |

<a id="module-and-settings"></a>
## Module and settings

- **The `remoteAccess` module.** It appears as the row `Remote access` in `Settings ▸ Modules` and is on by default. Remote access itself is off by default. See [Modules](settings-modules-and-onboarding.md).
  - With the module off, there is no settings ⚙, no `File ▸ Connect…`, no Remote button and no cover. The gateway does not listen, and mDNS neither announces nor browses.
  - Remote-access IPC then answers `Remote access is off in Settings.`
  - Turning the module off drops every connection. The device registry and the log stay on disk and come back with the module.
  - A device cannot turn the module off.
- **Where the settings live.** The ⚙ of the `Remote access` row in `Settings ▸ Modules` opens the shared module settings popup (`Remote access settings`). There is no separate settings tab. Deep links open `Settings ▸ Modules` with this popup at the right part or dialog. These links come from toasts, notice chips, the Remote menu (`Add device…`, `Settings…`, `Unblock…`, the log) and Search Everywhere. The search path is `Settings ▸ Modules ▸ Remote access ▸ <section>`.
- **The popup has two parts**, switched by `ui/Segments` M at the top. The chosen part is remembered until the app quits.

| Part | Contents |
|---|---|
| `To this machine` | The schema and facts (see [Onboarding](settings-modules-and-onboarding.md)). The switch `Allow control from other devices`. A status row: `Listening · {networks}` or `Not listening: …`, then `Port 7420. No port forwarding on the router.` `Machine name`. `Change password…`. The sleep note `While remote access is on, the machine stays awake. A closed laptop lid still puts it to sleep.` The `Phone` section ([Phone setup](#tailscale-guidance)). The `Devices` card: name, last sign-in, address and network, `controls now`, `Revoke`, `Unblock` after 10 wrong passwords. Then `Add device`, `Revoke all` and `Log`. |
| `Connect to another · N` | N is the number of paired machines. The text `Control Brigadir on another computer from this window. A machine is paired once with a code, and you sign in with the password set on it.` The `Machines` card: each row shows reachability, `Connect` (or `Show window` when its window is open) and `Forget` (or `Disconnect`). Both buttons sit over the row with their own hover. `New machine…`. The Tailscale hint with `Download Tailscale`. With no machines: `No paired machines yet`, what to do on the other machine, and `New machine…`. `Forget` asks through `ui/ConfirmDialog` (`Forget {machine}?`). |

- **Turning access on.**
  - The first time, the switch asks for a password and a repeat (at least 10 characters).
  - If a password is already set, the switch turns access on at once.
  - The gateway never listens without a password.
- **Machine name.**
  - Saved on ↩ or blur. Esc restores the old name.
  - Defaults to the system name, stored as `null`.
  - Validated by `isMachineName`: 1–64 characters, trimmed, no control characters, no bidi controls (U+202A–202E, U+2066–2069, U+200E/F, U+061C), no lone surrogates.
  - A new name reaches devices through mDNS and at their next login.
- **Seen from a device**, the popup is read-only and has no segments. The second part belongs to the computer in front of the person. A note says `Remote access changes only on **{machine}** itself…`, and the module switch is disabled.
- **Settings key.** `remoteAccess` holds `{enabled: boolean, machineName: string | null, listen: {lan: boolean, tailscale: boolean}, phone: boolean}`. The defaults are off, `null`, both networks and no phone.
- **`settings:save` from a device** saves everything except `modules.remoteAccess` and the `remoteAccess` block. Those keep the working machine's values (`guardRemoteSettings`). The rest of the save is not refused.

<a id="pairing"></a>
## Pairing

Each device pairs once. After that it connects with one click and the password.

- **On the working machine**, `Add device` opens the `Add a device` dialog. It shows a one-time code of 8 Crockford base32 characters, displayed 4 + 4, with a countdown (`Valid for {time}`, `Waiting for a device…`, `New code`).
  - States: code expired (`The code no longer works`) and attempts used up (`Pairing stopped: 5 wrong codes`).
  - After the right code, the machine asks the person to confirm the device's name and address (`The device entered the right code and wants to control this machine.`), with `Pair` or decline.
  - Five wrong codes close the pairing window.
- **On the device**, `New machine…` lists machines found by mDNS (`On this network`, with `already paired` marks) and offers `Enter an address…`, which takes an IP or name and a port (default 7420).
  - The code goes into 8 cells (4 + 4). A paste is split across the cells.
  - A wrong code shows "the code did not match · N tries left".
  - After the code is accepted, the device shows `Waiting for confirmation on {machine}` via the event `remote:pair-progress`. `Cancel` and `Back` send `remote:pair-cancel`.
- **The pairing listener is separate**, on port 7421. It is open only during the 5-minute window and knows only the `pair-*` methods. The pinned gateway on 7420 cuts unknown certificates during the TLS handshake, so it cannot do pairing.
- **CPace** is CPace-RISTR255-SHA512, implemented to the IRTF draft on `@noble/curves`/`@noble/hashes` (`packages/remote/src/cpace.ts`, draft test vectors in unit tests). Key confirmation is explicit in both directions (draft §10.4: `mac_key = H("CPaceMac" ‖ sid ‖ ISK)`, tag over lv_cat(Y, AD)).
- **The exchange is bound to TLS.** The inputs are:
  - CI = lv_cat(`brigadir-pair-1`, SHA-256 of the machine certificate DER, SHA-256 of the device certificate DER). A man in the middle therefore derives a different key, and no fingerprint exchange is needed after PAKE.
  - sid = 16 random bytes from the machine.
  - ADa = the device name. ADb = the machine name.
  - PRS = the normalised code: case, spaces and dashes are ignored, O becomes 0, and I/L become 1.
- **Message order**: `pair-hello` → `pair-a` → `pair-b` (the machine's Yb and its tag) → the device checks the tag and only then sends `pair-confirm` with its own tag → `pair-wait` while the person confirms → `paired`. The machine then records the certificate and sends its name, addresses and ports.
- **Rules.**
  - Each step before confirmation has 5 s: `pair-a` after `pair-hello`, `pair-confirm` after `pair-b`. Otherwise the machine closes the connection.
  - An attempt counts once the machine has answered with Yb. Dropping the connection after that does not give the attempt back.
  - Only an attempt that has sent `pair-a` holds the window. One pairing runs per address at a time, and a second attempt gets `busy`.
  - Confirmation can take until the end of the 5-minute window.
  - The device accepts `pair-wait` and `paired` only after the machine's tag verified and it sent its own. A `paired` without CPace, or after a bad tag, is treated as a wrong code, and the machine is not recorded.
  - A wrong code is reported as the notice `pairing-failed`, not `failed`, so the wrong-password toast is not shown.
- **The pairing code is visible only on the working machine.** For a device, `remote:status` carries an empty code and `editable: false`.

<a id="password-and-sign-in"></a>
## Password and sign-in

- The password is set on the working machine, at least 10 characters. It is stored only as a scrypt hash in `remote/password.json`. It is never stored on the device and not kept in memory after login. It is checked inside the already mutually authenticated TLS.
- **Connect list.** `File ▸ Connect…` opens a modal list of paired machines, or the Remote popover when the button is shown. Clicking a machine opens the `Password for {machine}` field inside the row.
  - The row shows the name, the network (LAN, Tailscale or unavailable) and the last connection.
  - States: `Connecting…`; a wrong password with its pause (`Wrong password. Next try in {seconds} s.`); unavailable; another version; blocked (`{device} is blocked on {machine} after 10 wrong passwords…`); `Take control?`.
- **Wrong passwords.** The pause doubles from 1, 2, 4 … s up to 5 min. During the pause the password is not checked and the try does not count. After 10 failures in a row the device is blocked until someone presses `Unblock` on the working machine. One device's password is checked one at a time, and a login that arrives during a check gets `wait`.
- **Resume token.** At login the machine issues a random 32-byte token and keeps only its SHA-256.
  - It is valid while the connection lives and for 15 min after the connection drops, only with the same device certificate.
  - The device keeps it in memory and reconnects without the password.
  - Validity is decided by the machine: `expired` makes the window ask for the password again. A machine that slept keeps the token valid for 15 min from when it noticed the drop.
  - A new password, revocation, turning access off or turning the module off erase all tokens.
- **Changing the password drops every current remote connection.** The `Change password` dialog says so. Phones are not affected, because they have no password.

<a id="identity-and-keys"></a>
## Identity, certificates and key storage

- Each installation has one ECDSA P-256 key and a self-signed X.509 certificate, built on `node:crypto`. It serves as the server certificate on a working machine and the client certificate on a device.
- `remote/identity.json` holds the certificate and the key sealed by `safeStorage` (Keychain on macOS, libsecret on Linux). The identity is created the first time access is turned on, a pairing starts or a connection is made. Until then the OS key store is not touched.
- **Key store state** comes from `remote:key-store` (class `client`): `ok`, `plain` or `missing`. `plain` means Linux without a secret service, where Chromium's backend is `basic_text` or `unknown`.
  - On Linux the Connect list shows `No secret service (GNOME Keyring or KWallet): Brigadir cannot keep the key of this computer. Install one and start Brigadir again.`
  - Pairing and login are refused in that state. Brigadir never falls back to a key in a plain file, so it never adds `--password-store=basic`.
  - `getSelectedStorageBackend()` is called only on Linux. On macOS the store is not probed ahead, because probing could prompt before any pairing.
- On Windows and Linux, F10 and a lone Alt open ☰ in machine windows too. The primary modifier in the renderer comes from `ui/primary-key`: ⌘ on macOS, Ctrl elsewhere.

<a id="transport-and-protocol"></a>
## Transport and protocol

- **TLS 1.3 with mutual auth and pinned certificates.** Trust comes only from the fingerprints recorded at pairing, with no certificate authorities. A handshake without a listed certificate is cut before any application data.
  - With no device paired yet, the trust anchor is the machine's own certificate, because an empty `ca` in Node would mean the public CAs.
  - TLS refusals are written to the log at most once per minute per address and at most 20 lines per minute in total. The rest is folded into one line with a counter.
- **WebSocket over TLS**, with `permessage-deflate`.
- **JSON frames `{t: …}`.** `undefined` and `Uint8Array` survive the round trip, tagged under a NUL key. A `__proto__` key is rejected. A frame that fails validation closes the connection.
- **Frame limits.** Up to 16 KB on the pairing listener and before login, up to 16 MB after login. `ws` enforces the limit itself, also after inflate. Login raises the limit for its own connection.
- **Sign-in messages.**
  - The device sends `login {v, table, password | resume, takeOver}`.
  - The machine answers `welcome {machine, resume, control, version}` or `refused {reason, retryAfterMs, attemptsLeft, machine}`.
  - After login the messages are `invoke`/`result`, `event` (only on channels with `subscribe`), `take-control`, `ping`/`pong` and `bye {reason}`.
  - The device rejects an `event` on a channel it did not subscribe to, and any event on a client-class channel.
- **Connection limits**, the same on both listeners:
  - the TLS handshake must finish within 10 s;
  - a connection that has not sent its upgrade request is closed after 10 s;
  - at most 64 connections across all listeners and 8 per address, and any extra TCP connection is closed before TLS;
  - a WebSocket without a session is closed 20 s after it opens;
  - a login that loses a race with revocation or with turning access off gets `refused` (`unknown` or `off`) and is closed.
- **Binary frames (machine → device)**: `[version u8 = 1][header length u32 BE][header: the codec JSON with byte values replaced by chunk references][bytes]`.
  - The device checks the bounds of each chunk, and a frame that does not parse closes the connection.
  - Device → machine frames stay text; uploads are base64. The machine closes the connection on any binary frame from a device.
- **Droppable frames.** Browser screencast and simulator video frames are skipped while more than 1 MB is unsent, and the sender knows each skip.

<a id="gateway-and-listeners"></a>
## Gateway and listeners

- **Off by default.** When on, the gateway listens on port 7420 and only on LAN addresses (RFC 1918 and ULA) and Tailscale addresses. It never listens on 0.0.0.0 or a public address, and it never uses UPnP or router forwarding. Interfaces are re-read every 15 s.
- **How a Tailscale address is recognised.**
  - Any address in fd7a:115c:a1e0::/48 is Tailscale.
  - An address in 100.64.0.0/10 is Tailscale only on a Tailscale interface: one named `tailscale…` (Linux), or one that also has an fd7a:115c:a1e0::/48 address (macOS `utunN`).
  - 100.64.0.0/10 on any other interface is CGNAT (a phone hotspot or the provider), so it counts as LAN and is listened on only when LAN is on.
- **Keep awake.** `prevent-app-suspension` is held while the module and access are both on, whatever `agents.keepAwake` says ([keep-awake](architecture-and-platform.md)). A closed lid still puts the machine to sleep.
- **Local network on macOS.** The Info.plist carries `NSLocalNetworkUsageDescription` and `NSBonjourServices` (`_brigadir._tcp`) via `extendInfo`, and `check-dist` verifies them. The dev bundle (`scripts/desktop-runtime.mjs`) carries them too.
  - macOS asks for local network access the first time the app browses for machines or announces itself.
  - If the person chooses "Don't Allow", the new-machine list stays empty and LAN addresses show `Unavailable`. The fix is in System Settings ▸ Privacy & Security ▸ Local Network.
  - Loopback needs no permission.

<a id="single-active-client"></a>
## One active client, the cover and taking control

- **Only one client is in control.** The gateway tracks who controls. These belong to the active client: main's state (`visibleTask`, `menuContext`, the active browser), the PTY size, and the per-client calls (`notifications:visible`, `menu:context`, `terminal:command` with `resize`, `browser:command` with `mount`). A client without control gets those calls answered with no effect. Everything else keeps working under the cover, so `Take back` shows fresh state.
- **Someone at the machine (`localPresent`).** This means the machine's window is focused and has had input in the last 2 min. Then:
  - A login without `takeOver` is refused with reason `local` after the password check.
  - The device asks `Take control?` through `ui/ConfirmDialog`, explaining that a cover will close the window on that machine, and logs in again with `takeOver`.
  - With nobody present, a login takes control at once.
  - A login by resume token never takes control from a person or from another device. It only restores control the device held before the drop, when the machine still counts it as active or nobody is present.
- **The cover.** While a device controls the machine, the machine's window shows a full-screen modal cover.
  - It shows `Controlled from {device}`, then since when, address and network.
  - Buttons: `Take back`, which always wins, and `Disconnect {device}`.
  - It also lists what is working now.
  - `Disconnect {device}` (`disconnectRemoteDevice`, `remote:drop`, forbidden for devices) drops the link with `bye: dropped` and erases the resume token. The device stays paired.
  - Toasts render over the cover (`ToastHost over`).
- **Handover.**
  - `takeRemoteControl()` from the local window is `Take back`. From a device, the same call is `Take control again`.
  - When the active device drops, control returns to the local window.
  - A window that regains control, or reconnects, re-announces its visible task, menu context, browser screencast and simulator watch under the same `epoch`, because to the machine it is a new client.
- Running several clients at the same time is not supported. See [Later](#later).

<a id="call-boundary"></a>
## What a device may not call

- **Forbidden for a device:** anything that changes access itself. That covers the switch, password, name, devices, pairing, `remote:drop`, `remote:audit-reveal`, `setRemotePhone` and `checkRemotePhone`. App DevTools, `testCrash` and `settings:restart` are forbidden too. Restarting from a device would drop the link, the resume token lives only in the machine's memory, and nobody may be at the machine if the app fails to come back. A machine window therefore has no `Restart` button.
- **Allowed for a device:** reading the status and the log, and taking control.
- **Logged:** a refused call is written to the log as `call-refused` with the channel name.

<a id="audit-and-revocation"></a>
## Visibility, revocation and the log

- **What the working machine shows.**
  - The Remote button's dot.
  - Toasts for every connection and every failed try (`{device} connected · {address}`, `{device}: wrong password · {address}`).
  - The `Devices` list with `Revoke` and `Revoke all`.
  - A device with no sign-in for 30 days is revoked by itself.
- **Turning access off drops every connection at once.**
- **The log.** `Log` opens `Remote access log`, which views `remote/audit.jsonl` with time, device, event and address, and offers `Show in file manager` (`revealRemoteAudit`).
  - The file rotates to `audit.1.jsonl` past 2 MB. Field values are clipped to 512 characters.
  - Events logged:
    - pairing opened, closed, failed, exhausted, expired, declined and paired;
    - sign-ins, wrong passwords and refusals, including those refused at TLS (`tls-rejected`);
    - block and unblock, revoke, revoke all and 30-day expiry;
    - `call-refused`;
    - `settings-changed`, which lists changed keys to the second level (for example `editor.fontSize`) and never values;
    - `dropped`, `took-back`, `took-over` and `version-mismatch`;
    - `module-enabled`, `module-disabled`, `access-enabled` and `access-disabled`. The first application of settings at startup is not logged;
    - for phones: `phone-enabled`, `phone-disabled`, `push-subscribed` and `push-removed`.
  - Events a device can repeat on its own are capped at 20 lines per minute each, with the rest folded into one counted line. These are `call-refused`, `settings-changed`, `took-over`, `version-mismatch`, `login-refused`, `tls-rejected`, `push-subscribed` and `push-removed`.

<a id="remote-button"></a>
## The Remote button

The UI marker is the icon button `remote` (`IconButton` with a state dot at the glyph's bottom right, no label, no ▾). The row it sits in sets its size. It sits:

- in the window bar: S over the sidebar on macOS, M in the toolbar, and after ☰ and the sidebar toggle on Windows and Linux ([window frame](architecture-and-platform.md));
- in the [section rail](sidebar.md), where its menu opens to the side.

The tooltip is the system `title`.

**On this machine's window** the button exists only while the module and access are both on. It is hidden under the cover.

| Dot | Meaning |
|---|---|
| Green | A device is connected |
| Grey | Access is on and nobody is connected |

- **Hint**: `<machine> · <state>` (for example `connected: ThinkPad`, without the port), then `Remote access and other machines · ⌥⌘O`.
- **Popover `Machines`** (`ui/Popover`, Esc).
  - Section `This machine`: the machine name with a check mark and its state (`Listening · …`, `Port {port} · connected: …`, `Not listening`). Clicking it opens the settings popup at `To this machine`. `Add device…` follows.
  - Section `Connect to another`: the paired machines. Each has reachability on its glyph and a second line (`{network} · reachable`, `Unavailable`, `Checking…`, or `Window open · {network} · {latency} ms` when its window is open). `New machine…` follows.
  - Then `Settings…` and `Turn off remote access`.
  - Clicking a machine opens its window if it is open. Otherwise it opens the Connect list with that machine's password field. `New machine…` opens the new-machine step of the same list.
  - Reachability is probed while the popover is open.
- **Shortcut.** `File ▸ Connect…` is the third item in File, after the recent projects. It is `⌥⌘O` on macOS and `Ctrl+Alt+O` on Linux, the pair of `⌘O` `Open a project…`. It opens the popover when the button is shown, and the modal Connect list otherwise.

**In a machine window** the button is the same, showing the link's state.

| State | Look |
|---|---|
| Connected, in control, ping ≤ 300 ms | Green dot |
| Slow (ping > 300 ms) or control taken back | Amber dot |
| No link | Grey dot |
| Reconnecting | Amber spinner (`agent-spinner` on `--amber-soft`); the button is disabled |

- **Hint**: `Remote machine {machine}`, then `Connected via {network} · {latency} ms` or `Reconnecting…`.
- **Menu.**
  - A `Connected via {network}` info row shows the address, latency and `since {time}`.
  - `Choose a folder on {machine}…` opens the folder browser for `Add a project from {machine}`.
  - `Disconnect`.
  - Section `Go to`: this computer (`This machine · task window`), the current machine checked (`This window`), the other paired machines with their reachability, and `New machine…`. Clicking another machine shows its window if it is open. Otherwise it switches to this computer's task window and opens the Connect list with that machine's password field.
- When the sidebar is hidden and the button sits in the window strip, the dot's ring uses `--win`.

<a id="machine-window"></a>
## The machine window

- **Launch.** Main passes `--brigadir-remote-machine` and `--brigadir-remote-name`, and the renderer reads `window.brigadir.remoteMachine`. The OS title is `{machine} — Brigadir`.
- **Session state.** The window's state comes from the device's `RemoteSession`. `RemoteSession.since` gives "since 19:20" in the menu.

| `RemoteSession` state | Window |
|---|---|
| `connecting` / `reconnecting` | Remote button spinner; the content is dimmed |
| `active: false` | Card `Control was taken back on {machine}` with `Take control again` / `Disconnect` |
| `closed` | Card `The connection to {machine} closed` with the reason (`revoked`, `off`, `password-changed`, `expired`, `replaced`, `dropped`) and `Close window` / `Connect again` |

- **Cards.** The cover and the "taken back" card start at `--strip-h` + 1 from the top.
- **Menu bar and actions.**
  - Menu-bar actions (`workspace:action`, `editor:action`) go to the focused window, local or remote.
  - `Connect…` always opens in a window of this computer.
  - The menu bar uses the focused machine window's own `menu:context`. `Recent projects` and page/simulator DevTools are disabled there, and `Workspace` and `Layout` actions go to that window.
  - `menu:run`, `window:reload`, ☰, the frame colours and the field's system menu act on the window that invoked them.
- **Closing with unsaved buffers.** The device sends `remote:closing`, and the machine has that window flush its surfaces and drafts (`surface:flush`, hot exit). Buffers hot exit could not keep show the normal "There are unsaved edits." dialog on the device (`Keep editing` · `Discard edits`).
- **Renderer crash.** It behaves as for a local window: one reload per minute, and a second crash shows `Reload window` · `Close window` on the device.
- **Shared components**: `ui/ModalDialog` (the dialog shell), `MenuInfo` in `ui/Popover`, `TextInput tail` (a count inside the field), `ConfirmDialog error`, `ui/MachineGlyph` (also as `tile` in the Connect list) and `ui/MachineTag`. Dialogs opened from settings render through a portal into `body`.

<a id="client-ui-seam"></a>
## Menus, dialogs, files and links from a device

Goal: no call from a device opens anything on the working machine's screen.

- **One seam: `main/client-ui` (`ClientUi`).**
  - Every native menu, `showMessageBox`, `showOpenDialog` and `showSaveDialog` in main goes through it, together with the calling client.
  - A local window, or a machine window on a device, gets the native UI over its own window.
  - A remote device gets an event on its own connection and answers with `remote:ui-answer`. Handlers stay linear (`await ui.menu(client, …)`).
  - Only that device's answer is accepted, and only a possible one: an item that was in the menu and enabled, an existing button index, or a path re-checked as a folder or a file with the right extension.
  - A request still pending when the connection goes is closed as Cancel. A new request of the same kind closes the previous one.
- **Menus as data (`remote:menu`).**
  - An item is `{id, label, icon, enabled, checked, accelerator, role, copy, reveal}`. The label is already translated into the machine's language, the icon is a name from `menuIconNames`, the accelerator is only displayed, `copy` is text for the clipboard and `reveal` is a path.
  - Items with `reveal` and extra separators are not sent to devices.
  - The device's main validates the template (at most 64 items, known glyphs only, roles only `cut`/`copy`/`paste`/`selectAll`). It shows a native menu over the machine window, writes `copy` items to its own clipboard and returns the `id`.
  - Role items use the device's own words, so Paste is never mislabelled.
  - Menus that read machine data are class `remote`: `task:menu`, `project:menu`, `board:option`, `files:menu`, `editor:menu`, `documents:tab-menu`, `activity:turn-menu`, `commands:menu`. Menus without machine data stay `client`: `chat:menu`, `terminal:menu`, `sheet:attach-menu` and ☰.
- **`showMessageBox` → `ui/ModalDialog`** in the machine window (`remote:dialog {kind: 'box'}`).
  - The message is the title, the details are paragraphs, and the buttons form the footer: Cancel on the left and the first button on the right.
  - The default button is primary, a destructive button is `danger`, focus starts on Cancel and Esc gives `cancelId`.
  - This covers sidebar and board confirmations (delete or archive a task, remove a project, clear and archive a list, a card's trash with uncommitted work) and the file revert dialog.
- **`showOpenDialog` → the folder browser `RemoteFolder`.** Its titles are `Add a project from {machine}`, `Add a folder from {machine}` (to a task or the launch sheet), `Import a template from {machine}` and `Description from a .md file on {machine}`. The dialog is 540 px wide.
  - It reads through `remote:fs-list`, only while that device has a picker open with that `id`. Rows carry names, the folder/file kind, `git` (the folder contains `.git`) and mtime, never content. Files appear only for a file picker and only with its extensions. Up to 2 000 rows.
  - Scope matches the machine's system dialog: the whole filesystem of the process user, starting at home.
  - Hidden names toggle with ⌘⇧. and show dimmed.
  - Navigation: `Folder up`, breadcrumbs, double-click or → opens a folder, ← goes up, ↩ is `Choose`. With no row selected, `Choose` takes the shown folder.
  - `New folder…` adds a field row and calls `remote:fs-mkdir` in the shown folder. The name must be a single segment without `/` or NUL, and not `.` or `..`.
- **Template export** uses `remote:save {name, extensions, text}`. The device shows its own save dialog and writes the file locally, and the answer is `true` or `false`.
- **Files from the device.**
  - Picking attachments (`attachment:pick`) uses the device's native dialog.
  - Picked, dropped and pasted files are read by the device's main and sent as `attachment:upload`: up to 10 files of up to 10 MB each, name only, no path.
  - Images are decoded and shrunk to PNG ≤ 4 MB. The header (PNG, JPEG, WebP or GIF) is read first, and anything over 40 Mpx or 16 384 px per side is refused with "The image is too large: …". The same check applies to local attachments and clipboard images.
  - Other files land in `projects/<project>/uploads/<uuid>/<name>` (file 0600, folder 0700) and become a normal File reference to that machine path. The folder belongs to the project, not the draft owner, so the reference survives the launch-sheet draft moving to a task.
  - Pasting an image reads the device's clipboard.
  - A folder dragged onto the intro in a machine window does not become a project. The zone explains that a folder of this computer cannot be a project on the machine, and `project:add-path` refuses from a machine window.
- **Machine data, shown on the device.** Client rows that need machine data ask the machine through a `remote` row and only display the result locally:

  | Client row | Remote row |
  |---|---|
  | `prs:open` | `prs:url` |
  | `prs:link` | `prs:link-url` |
  | `forge:open` | `forge:url` |
  | `attachment:copy-image` | `attachment:read` |
  | `appearance:read` | `appearance:machine` |

  - URLs are re-checked on the device with `isWebURL`.
- **Appearance of a machine window.**
  - The machine's settings apply: modules, language, typography, keymap and the accent setting.
  - The device's own theme, system accent and font catalogue apply too. Missing fonts are resolved against the device catalogue (`main/appearance.ts`).
  - Updates arrive as `remote:appearance`.
  - The device validates machine appearance (`isMachineAppearance`) and dialogs (`isRemoteDialog`) before showing them. An exception while parsing any machine event is logged and does not stop reading the connection.
- **Notifications** ([Notifications](notifications-slack-notes-and-schedules.md)).
  - While a device controls the machine, the machine's notifications, sounds and badge go to that device as `remote:notify`.
  - The device shows them with its OS, except for the task open in the focused window. A click opens the task in the machine window.
  - `Allow`/`Deny` go back as `remote:notice-act`, accepted only from that device.
  - The device plays the sound. Its badge is its own count plus the machine's.
  - Under device control, the machine does not consider its own window active. The machine still checks the OS notification permission.
- **Hidden in a machine window.**
  - `Open in system browser` is hidden for loopback and private hosts: `localhost`, `127.0.0.0/8`, `::1`, `*.localhost`, `.local`, dotless names, RFC 1918, `100.64.0.0/10`, `169.254/16`, `fc00::/7` and `fe80::/10`. The host is parsed as the browser parses it (`URL`), so `127.1`, `0x7f.1`, `0177.0.0.1`, `[0:0:0:0:0:0:0:1]` and `[::127.0.0.1]` are hidden too. Other URLs open on the device (`links:open`).
  - Page and simulator DevTools are hidden, because the DevTools window would open on the machine.
  - `Show in file manager` is hidden in menus and the log.
  - The machine also refuses `browser:command` `external`/`inspect` and `simulator:command` `devtools` from a device.
  - Links in text use `ui/WebLink` (`openWebLink`, class `client`), so they open on the device.

<a id="browser-from-device"></a>
## Browser from a device

The page's `WebContentsView` stays on the working machine. The session, cookies and the agent tools `browser_ui`/`browser_act` live there ([Browser](browser-and-simulator.md)).

- **Screencast.** The machine window draws a `<canvas>` and requests `browser:screen` `start` with the panel's CSS size and the device's `devicePixelRatio`. It does so only while the panel is on screen (non-zero size, window not minimised). Removing the panel, minimising the window or dropping the link sends `stop`.
- **Machine side.**
  - The view leaves the machine's window, which is under the cover, and can sit anywhere.
  - `Emulation.setDeviceMetricsOverride` is set: Desktop uses the panel size × DPR, and Mobile uses 390 × 844 × DPR. Focus emulation is turned on first, because without it an off-window view gives no frames. A view outside any window has size 0×0 without the override.
  - After `stop`, the tab goes back to the normal background rules (freeze, invisible agent window).
- **A screencast tab counts as "a person sees the page".** It does not freeze after 60 s and is not parked. Agents treat it as visible, and `browser:event`s flow.
- **Flow control.**
  - Chromium holds up to two unacknowledged frames: one in flight and the newest waiting, where a newer frame replaces the waiting one.
  - `Page.screencastFrameAck` is sent only after the device acks that it drew the previous frame, and the next frame goes no sooner than 50 ms later, so at most 20 fps.
  - The format is WebP q50, or JPEG q50 if the client names only JPEG.
  - The frame size is the CSS size × the smaller of the device DPR and the working machine's display scale. Chromium cannot capture more pixels than the machine's screen has, so Retina to Retina gives 2× and a 1× machine gives 1×.
- **Input.**
  - Mouse goes through `Input.dispatchMouseEvent`: moves once per animation frame, presses with `clickCount`, and the wheel.
  - Keys go through `Input.dispatchKeyEvent`: printable keys as `keyDown` with text, the rest as `rawKeyDown`, and releases as `keyUp`.
  - IME composition: `compositionupdate` → `Input.imeSetComposition`, `compositionend` → `Input.insertText`, and a cancel sends an empty composition.
  - The device's primary modifier (Ctrl on Linux) becomes ⌘ on a Mac working machine, including Ctrl+click → ⌘+click (`ctrlPrimary`). A Ctrl+click from a Mac device stays Ctrl+click.
  - ⌘A, ⌘Z, ⇧⌘Z and ⌘/⌥ + arrows go as macOS editing commands.
  - The `<canvas>` shows the page's cursor shape.
- **Clipboard is the device's.**
  - Copy and cut fire the page's `copy`/`cut` events, and the text goes to the device clipboard.
  - Paste sends the device clipboard's text as a `paste` event.
  - `navigator.clipboard.writeText` and `execCommand('copy')` within 1 s of input from the device also go to the device clipboard.
  - The device accepts such writes only within 2.5 s of its own gesture: a click, wheel, key, text, paste or pick, but not pointer movement.
- **Controls.** The address bar, back/forward, reload, tabs, Desktop/Mobile, console and network are the existing `browser:command`. The address bar shows a `ui/MachineTag` with the machine name.
- **Control and screencast.** When a device takes control, views leave the machine's window. A device that loses control loses its screencast. Apart from `stop` and `ack`, `browser:screen` is accepted only from the client in control.
- **Debugging.** `BRIGADIR_REMOTE_DEBUG=1` logs fps and KB/s per screencast every 5 s to the main log. Nothing about this shows in the UI.

<a id="page-windows-from-device"></a>
### Page dialogs and pickers on the device

These apply while the tab is screencast and no agent is acting on it. An agent acting on the tab takes priority.

- **`alert`/`confirm`/`prompt`.**
  - The page script (the same one the browser uses for background tabs) overrides these functions. It blocks the page with a synchronous request to the page's own origin, `/.well-known/brigadir-dialog/<one-time key>`.
  - CDP `Fetch` intercepts the request before it reaches the network. Main asks the device (`remote:dialog` of kind `page` → `ui/ModalDialog`; the title is the site, and `prompt` has a field) and answers with `Fetch.fulfillRequest`.
  - If the request cannot be made (a CSP without `'self'` in `connect-src`, or an opaque origin), the dialog is cancelled: `alert` is closed, `confirm` returns `false` and `prompt` returns `null`. A dropped link or lost control also counts as Cancel.
  - The script is installed in every document before the page's scripts, and its state changes only through main with the tab's secret. Cross-site frames get the same script through CDP auto-attach, and each frame waits at start until the script is in. A frame's dialog is titled with the frame's site.
  - Electron's own dialog is never used for this: for a windowless view it runs a modal `runModal` that blocks main.
- **Dialog spam.** A page dialog within 10 s of the tab's previous dialog closing carries `Don't show more dialogs from this page`. Checking it suppresses the tab's dialogs until the next main-frame navigation: `alert` closes, `confirm` gives `false` and `prompt` gives `null`. `beforeunload` has no such checkbox.
- **`beforeunload`.** Electron's `will-prevent-unload` handles it, and navigation stops while the device asks `Leave this page?` (`Stay` · `Leave`).
  - `Leave` repeats the person's navigation if it came from the address bar, back/forward or reload.
  - For any other navigation (a link on the page), the next try within 30 s passes without asking.
- **File chooser.**
  - `Page.setInterceptFileChooserDialog` and `Page.fileChooserOpened` trigger `remote:files` on the device. The device opens its native picker (filter from `accept`), with up to 10 files of 10 MB each.
  - The files upload via `browser:file` and are answered through `remote:ui-answer`.
  - The machine writes them to `<tmp>/brigadir-page-files/<uuid>/<name>` (0600 in 0700) and calls `DOM.setFileInputFiles`. The files live as long as the tab and never outlive the app.
- **`window.open` and `target=_blank`.** These open a new tab in the same task's browser, in front, `http(s)` only. Locally they are refused.
- **Native pickers.**
  - The page script catches these in the capture phase and cancels them on the machine:
    - a single `<select>` without `size`, opened by mousedown, Space or Alt+↓/↑;
    - `<input type=color>`, opened by click;
    - `date`, `time`, `datetime-local`, `month` and `week`, opened by mousedown on the icon zone, Alt+↓ or F4.
  - The script reports the type, options (text, value, group, disabled), value, `min`/`max`/`step` and the element's rect as `browser:screen` of kind `picker`.
  - The device places an invisible native element of the same type over the `<canvas>` and calls `showPicker()`, so the device's own OS picker opens.
  - The picked value is sent back as `browser:screen` `pick`, and the machine sets the value and fires `input` and `change`. Closing the picker without picking changes nothing, and a new `picker` closes the previous one.
- **Refused on a screencast or hidden page**, as `showPicker()` is: printing, `showOpenFilePicker`/`showSaveFilePicker`/`showDirectoryPicker` and `EyeDropper`.

<a id="simulator-from-device"></a>
## Simulator from a device

- `simulator:frame` (H.264) goes as a droppable binary frame to the device's `VideoDecoder`.
  - After a skipped frame, only keyframes go until one arrives.
  - Main asks the helper for a keyframe at most once per second.
  - On connect, `watch` gives the config and a keyframe, as it does locally.
  - Watches of a device that disappeared are removed.
- Input uses the existing simulator commands.
- ⌘V (Ctrl+V) pastes the device's clipboard: a `paste` command with text. A `paste` without text from a device is refused, so the machine's clipboard is never read.
- The simulator strip shows `ui/MachineTag` with the machine name.

<a id="agent-sign-in-from-device"></a>
## Agent sign-in from a device

- **The browser opens on the device.** `environment:sign-in` from a machine window never opens the machine's browser: the login process gets empty `open` and `xdg-open` in `PATH` and an empty `BROWSER`. The URL opens on the device (`openAgentSignIn`, class `client`), and `Open again` opens on the device too.
- **Claude** has a code flow and needs nothing more.
- **Codex** returns to `localhost:1455` on the working machine. If the sign-in page's `redirect_uri` is `http://localhost|127.0.0.1|[::1]:<port>/…` (port 1024–65535):
  - The device opens a one-off HTTP listener on its own loopback on the same port for this connection, and only then opens the page.
  - Every browser request to that listener is relayed with `relayAgentLogin` (`agent-login:relay`, class `remote`). The machine repeats it on its own loopback, only on the `redirect_uri` port of the current sign-in, only while that sign-in waits, and only from the device that started it.
  - Limits:
    - methods GET and HEAD only, with no body;
    - a path of at most 2 KB;
    - request headers `accept`, `accept-language` and `user-agent` only;
    - a response of at most 1 MB within 10 s;
    - status plus `content-type`, `cache-control` and `location` (relative, or to the same loopback port) are returned;
    - at most 16 requests per sign-in.
  - The listener answers only with `Host` `localhost`, `127.0.0.1` or `[::1]` on its port, and 421 otherwise. Responses carry `Content-Security-Policy: sandbox …` and `nosniff`, so the page is visible but does not run in the device's `localhost` origin.
  - The listener closes when the sign-in stops waiting, with the connection, or after 10 min. If the device's port is busy, the page still opens but the callback fails, and this is logged.
  - `BRIGADIR_TEST_CALLBACK_PORT_OFFSET` shifts the port for tests.

<a id="networking"></a>
## Networking between machines

- **mDNS `_brigadir._tcp`** (`bonjour-service`, `multicast-dns`).
  - TXT records: `id` is the first 16 hex characters of SHA-256(`brigadir-mdns-1` ‖ certificate fingerprint), not the fingerprint itself; `n` is the name; `pp` is the pairing port; `v=2`.
  - The instance name is `<name> (<6 chars of id>)`, so two machines with the same system name do not suppress each other.
  - The announcement repeats when the name or the listened addresses change. Turning access or the module off, or quitting, sends a goodbye (TTL 0), and closing waits up to 1 s for it.
  - Queries go over IPv4 multicast on every IPv4 interface. AAAA records carry ULA IPv6 addresses. IPv6 multicast is not used.
  - Names lose control and bidi characters. A machine or device name containing them is refused outright.
  - An mDNS name is only a hint, because anyone can announce one. Trust comes only from pairing.
- **Discovery on the device.** While the Connect list is open, the device:
  - re-queries every 10 s;
  - drops a machine on its goodbye;
  - hides itself from the list;
  - matches each `id` to its paired machines and adds their LAN addresses from mDNS to `machines.json`, private LAN addresses only. Tailscale and 100.64/10 addresses come only from the machine itself at login.
- **Addresses of a paired machine** are updated at each login. They are the list the machine sends (with each address's network), plus the address that worked, plus remembered Tailscale addresses, which are stable per node. LAN addresses the machine no longer names are dropped. At most 32 are kept.
- **Reachability before a try** (`remote:reach`, class `client`).
  - While the Connect list, the popover or the second settings part is shown, the device's main probes each paired machine: at once, every 10 s, and after a network change.
  - A probe is a TLS 1.3 handshake with the pinned machine certificate and the device's own certificate, 3 s per address. It uses no WebSocket and no login, and it closes after the handshake.
  - The machine does not log these probes.
  - A machine that rejects the device's certificate (the device was revoked) is not probed again while the list stays open.

  | Reach | Row text |
  |---|---|
  | Answered on the LAN | `LAN · <address> · last …` and `Available` |
  | Answered over Tailscale | `Tailscale · <address> · …` and `Available` |
  | No answer and no Tailscale address | `Unavailable`, with `Unavailable outside the LAN without Tailscale` |
  | No answer anywhere | `Unavailable`, with `No answer on the LAN or through Tailscale` |
  | Probing | `Checking…` / `Checking LAN and Tailscale…` |

  A connected machine takes its network from the live connection.
- **Address order (happy eyeballs).**
  - Ranks, best first:
    1. a LAN address in the same subnet as a device interface (and loopback);
    2. Tailscale, if the device has a Tailscale interface;
    3. any other LAN address;
    4. Tailscale without a local Tailscale interface.
  - Within a rank, the last address that worked comes first, then IPv4 before IPv6.
  - The next address starts 250 ms after the previous one, or as soon as it fails. The first connection with the right certificate and a working WebSocket wins, and the others close. One try lasts up to 4 s.
- **Heartbeat.** The device sends `ping` every 10 s.
  - If 25 s pass with no frame from the machine (checked every second, so it is noticed in 25–27 s), the link is dead. The window goes to `reconnecting` with the spinner and dimmed content.
  - The machine side uses WebSocket ping every 20 s and drops an unanswered link in 20–40 s.
- **Reconnect.** The pauses are 0.5, 1, 2, 4, 8 and 15 s, then 30 s, each ±20 %. The device keeps trying while the machine window is open, using the resume token.
- **Network change.**
  - The device's main snapshots its interface addresses every 2 s, only while it has a connection or the list is open. It also watches `powerMonitor` `resume` and `unlock-screen`.
  - After a change:
    - a live link sends a `ping` and waits 3 s; with no answer to that ping, it drops and reconnects at once;
    - a link in `reconnecting` retries at once;
    - reachability is re-probed.
  - If the link uses a worse rank and a better-ranked address answers the probe, the device moves to it. It logs in with the resume token on the new link and closes the old one silently (the machine closes it as `replaced`). The move waits up to 5 s for calls in flight to finish, or else it waits for the next change. No password is asked.
- **Sleep of the working machine.** A closed lid still sleeps the machine. The device shows `Reconnecting…` within 25–27 s and comes back by itself after wake.

<a id="outbox"></a>
## Outbox: backpressure per connection

`packages/remote/src/outbox.ts` (`Outbox`) carries every frame after login (results, events, `pong`), in order, on both the computer gateway and the phone web gateway.

- **Sending.** A frame is passed to the socket only while less than 1 MiB is in write, counted from `send` to its callback. `bufferedAmount` alone misses frames that are still being deflated. Everything else waits in the queue.
- **Size limit.** At most **32 MiB** may be unsent (in write plus queued). A frame over that limit closes the link as `slow` (`bye`, then `terminate`). A single frame with nothing else waiting may be any size.
- **Reading pauses.** While anything waits, the socket is not read, so a client that does not read cannot start new calls.
- **Stall timer.** A queue that has not moved for **60 s** closes the link as `slow`. Each written frame restarts the timer, and while the queue waits this timer, not the heartbeat, decides whether the link is alive.
- **Bulk calls.** Rows marked `bulk` run one at a time per connection, each after the socket has drained. A waiting call whose connection is gone does not run. The bulk rows are `readEditorFile`, `peekFile`, `readCommentFile`, `readEditorSyntax`, `readCodeSyntax`, `readFileDiff`, `readFileSyntax`, `readPullRequestFileDiff`, `readCommitFile`, `readHistoryFile`, `readToolDiff` and `readAttachment`.
- **Droppable frames** (video, screencast) are skipped while more than 1 MiB is unsent.

<a id="data-files"></a>
## Data files

All under `~/.brigadir/remote/`. JSON files are pretty-printed with sorted keys, and logs are JSONL.

| File | Side | Contents |
|---|---|---|
| `identity.json` | both | Certificate and `safeStorage`-sealed P-256 key |
| `password.json` | machine | scrypt hash of the remote access password |
| `devices.json` | machine | Paired devices: name, `kind` (`computer` \| `phone`), certificate fingerprint or `passkey`, last login and address, block state, `push` subscription |
| `machines.json` | device | Paired machines: name, certificate, addresses (≤ 32) with networks |
| `vapid.json` | machine | Sealed VAPID P-256 key for Web Push; created at a phone's first login |
| `audit.jsonl` (+ `audit.1.jsonl`) | machine | The log; rotates past 2 MB |

<a id="test-hooks"></a>
## Test hooks

These work only in an unpackaged app, with `BRIGADIR_DATA_DIR` set. They are not present in a packaged build.

- `BRIGADIR_REMOTE_LISTEN` (loopback addresses only), `BRIGADIR_REMOTE_PORT` and `BRIGADIR_REMOTE_PAIRING_PORT` let two instances run on one machine.
- `BRIGADIR_TEST_REMOTE_VAULT=1` uses a key with no OS store, so background tests do not trigger a Keychain prompt.
- `globalThis.brigadirRemoteTest` (with the vault flag) offers three hooks:
  - `freeze(on)`: the gateway "sleeps"; sockets are not read and new connections hang;
  - `cut(ms)`: drops every link without `bye` and refuses new ones for `ms`;
  - `networkChanged()`.
- `BRIGADIR_REMOTE_WEB_PORT` and `BRIGADIR_REMOTE_WEB_HOST=localhost` (origin `http://localhost:<port>`) are for the phone web gateway. The phone in e2e is a separate Electron with a CDP virtual authenticator (`WebAuthn.addVirtualAuthenticator`).
- e2e specs run two instances on loopback with `remote-fixture.ts`. They record every native thing that would open on the machine (`Menu.popup`, dialogs, `shell`, clipboard) and require that list to be empty.

<a id="phone"></a>
## Phone web version

The phone is a remote control, not a development environment. It is for answering agents and checking state. The machine serves it as a PWA from the same build, so its version always matches. On iOS, adding it to the Home Screen is a required sign-in step, because without it there is no Web Push.

| On the phone | Not on the phone |
|---|---|
| Home (the sidebar), project task list and board, project PR list | Terminal input |
| Chat with every interaction: questions, permissions, plans, crew questions, agent-proposed tasks, steering and queue, stop, retry, photos and files | Embedded browser and simulator |
| New task (project, text, model, effort) | Editor with edits or LSP, crew editor |
| Changes and read-only diffs | Settings other than notifications, theme and sign-out |
| Full PR: overview, checks, comments, Ask the agent, review (approve, request changes), merge, resolve conflicts by agent | Remote access and module management |
| Read-only files (CodeMirror, no LSP) and Markdown preview | Manual conflict resolution, line review drafts, Apply on agent answers, Open in sheet |
| Read-only terminal output | Collapsing crews, editing the plan copy |
| Agent usage (subscription limits) and context % in the composer | |

<a id="phone-network"></a>
### Network: Tailscale only

- `tailscale serve` proxies HTTPS with a valid `<machine>.<tailnet>.ts.net` certificate to a separate web listener on `127.0.0.1:7422`. The command is `tailscale serve --bg --https=443 http://127.0.0.1:7422`.
- LAN without Tailscale is not supported for phones, because it would need a CA profile on the phone.
- The machine's tailnet name appears in public certificate logs. The settings note says `The machine’s name in the tailnet goes into public certificate logs.`
- **When the listener runs.** It runs only when all of these hold: the `remoteAccess` module is on, access is on, `remoteAccess.phone` (`Access from a phone`, off by default) is on, and the machine's tailnet name is known.
  - The name is `Self.DNSName` from `tailscale status --json`.
  - Whether serve is configured comes from `tailscale serve status --json`: the `/` handler on `<name>:443` must point at `127.0.0.1:7422`.
  - The CLI is looked up in `PATH`, `/Applications/Tailscale.app/Contents/MacOS/Tailscale`, `/opt/homebrew/bin` and `/usr/local/bin`.
  - The check runs on settings changes and on `checkRemotePhone` (`Check again`), with up to 5 s per call.
- **When it refuses.**
  - With no CLI, the status says `cli: false` and the reason is `Tailscale is not found on this machine.`
  - If Tailscale Funnel is on for this name (`AllowFunnel`), the listener does not run (`Tailscale Funnel publishes this address on the internet; turn Funnel off for it.`). While running, the machine re-checks Tailscale every minute, so a later Funnel stops the listener.
  - Any request with `Tailscale-Funnel-Request` gets 403 and a closed WebSocket, whatever the state.
  - If another `tailscale serve` handler shares `<name>:443` (another path), the listener does not run (`Another service shares https://{host} through tailscale serve; give it another port.`).
- **Status** is `RemoteAccessStatus.phone`: `{enabled, listening, port, host, tailscale {cli, serving, command}, error}`. `setRemotePhone` (`remote:phone`) and `checkRemotePhone` (`remote:phone-check`) are forbidden for devices.

<a id="phone-request-boundary"></a>
### Request boundary

- **Hosts and origins.** `Host` (and `X-Forwarded-Host`, if present) must be the machine name, or the response is 421. WebSocket requires `Origin: https://<name>`, or the response is 403.
- **Methods and paths.** GET and HEAD are allowed. POST is allowed only for `/session`. The WebSocket paths are `/ws` (sign-in and session) and `/ws/pair` (pairing, only while the pairing window is open).
- **Headers on every response:**
  - CSP `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self' wss://<name>; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
  - `nosniff`;
  - `Referrer-Policy: no-referrer`;
  - COOP and CORP `same-origin`;
  - `Cache-Control: no-store`.
- **Limits.**
  - At most 64 connections in total and 8 WebSockets per tailnet address. The address is the last `X-Forwarded-For` entry, and the log records it with network `tailscale`.
  - A WebSocket that has not signed in closes after 2 min, so the person has time to pass Face ID.
  - Frames are limited to 16 KB before sign-in and 16 MB after.
- **Sign-in races.** Sign-in re-checks revocation, block state, access state and the live socket after its last write, before the session opens. A loser gets `refused`.
- **Resume tokens** are spent at check time, so one token used on two sockets gives a single sign-in.

<a id="phone-bundle"></a>
### Bundle, session cookie and service worker

- **Bundle.** `vite.mobile.config.ts` builds `out/renderer-mobile` with `bundle-manifest.json`. It has two entries:
  - `index.html` is the sign-in page, plain TypeScript without React and kept small;
  - `app.ts` is the app.
  - `core` and `remote` are side-effect free in this build, so the channel table and screens stay in the app chunk.
  - If the bundle is missing, the reason says `The phone bundle is not built (out/renderer-mobile).`
- **What is served before sign-in:** only the sign-in page and what it statically imports, plus `sw.js`, the PWA manifest and the icon.
- **Session cookie.** Everything else needs the cookie `__Host-brigadir` (`Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/`, 1 h).
  - `POST /session` (same `Origin`) issues it in exchange for a one-time ticket (60 s) from the already authenticated WebSocket.
  - The cookie is valid only while that phone is signed in. Revocation or turning access off ends it at once.
- **Handover.** The sign-in page loads the app with `import()` and hands over the same connection.
- **Resume.**
  - A dropped link (phone locked, network change) resumes with a 256-bit token held only in page memory, valid for 15 min after the drop.
  - A page reload needs the passkey again.
- **Service worker cache** `brigadir-shell-<12 hex>`. The suffix is a hash of the build's file names, which already contain content hashes (`sw-version.ts`). A new build gives a new worker, and its `activate` deletes older caches.
  - It is network-first and caches only GET on its own origin: navigation to `/` (and `/index.html`) stored under `/`, plus `/assets/`, icons and the manifest. Other navigations are not cached.
  - No data is cached. Machine data travels only over the WebSocket, `POST /session` is not a GET, and `Set-Cookie` never reaches the Cache API.
  - Because the shell is cached, the installed app can show a "machine asleep" screen when the machine is unreachable.

<a id="phone-pairing"></a>
### Pairing a phone

- The phone uses the same `Add device` code (4 + 4) and the same `PairingWindow`, with the same attempts, the same 5 min and `busy` rules and the same 5 s steps.
- **CPace** comes from the same module, without `node:crypto`: randomness from `@noble/hashes`, constant-time tag comparison. The browser gets the subset `@brigadir/remote/web` (CPace, frame codec, protocol, base64).
- **Binding.** CI = lv_cat(`brigadir-web-pair-1`, origin). TLS ends at Tailscale and there is no client certificate, so CPace is bound to the origin and the passkey registration to the same WebSocket.
- **Steps**: `pair-hello` → `pair-a` → `pair-b` → `pair-confirm` → `pair-register` (passkey creation options) → the person taps `Create a passkey` (Safari needs this gesture) → `pair-credential` (within 2 min; carries an optional `device` name) → verification → name confirmation on the machine (fingerprint = SHA-256 of the credential id) → the device is recorded with `kind: 'phone'` → `paired`.
- **If declined**, the phone keeps a passkey with no record, and the page calls `PublicKeyCredential.signalUnknownCredential` where it exists.
- **Phone UI.**
  - Eight cells sit over one `one-time-code` field, and `Pair` is enabled at the eighth character.
  - A wrong code turns the cells red and shows the tries left.
  - A match turns them green and shows `Phone name` and `Create a passkey`.
  - On iPhone Safari, the next step is `Add Brigadir to the Home Screen`.
  - Sign-in is `Sign in with a passkey`, with the phone name.

<a id="phone-passkey"></a>
### Passkey sign-in (WebAuthn)

- **Creation options.** `rp.id` is the machine name. `user.id` is 16 random bytes. `residentKey` and `userVerification` are `required`, and `attestation` is `'none'`. Algorithms: ES256, EdDSA and RS256.
- **Record** `passkey {credentialId, publicKey (SPKI), algorithm, signCount, aaguid, rpId, userId, backupEligible}`.
- **Sign-in flow.** The phone opens WebSocket `/ws` and gets a `challenge` (32 bytes, one per connection). It calls `navigator.credentials.get` and sends `assert`, and the machine answers `welcome`.
  - The page remembers its credential id in `localStorage` (not a secret) and passes it in `allowCredentials`.
  - Without it, the browser discovers the key. An installed iOS app has its own storage.
- **Verification** is in-house on `node:crypto`, with a strict CBOR decoder.
  - `clientDataJSON`: the type, the `challenge` and the exact `origin`, with no `crossOrigin`.
  - `authenticatorData`: the `rpId` hash, the UP and UV flags required, AT only at registration, and no trailing bytes.
  - The COSE key goes to JWK and then `createPublicKey`. RSA needs an odd, full-length modulus and an odd exponent ≥ 3. Ed25519 rejects small-order points.
  - The signature is checked over `authData ‖ SHA-256(clientDataJSON)`.
  - Attestation is not verified, because trust comes from CPace. The AAGUID is kept for display.
- **Clone detection.** If either the stored or the new counter is non-zero and the new one is not greater, sign-in is refused.
- **Failures.** A bad signature or a counter rollback counts as a wrong password: the same pause and the same block after 10, with `Unblock` on the machine.
- **Renaming.** The key is bound to `rpId`, so renaming the machine or the tailnet requires pairing the phone again.
- **Lifecycle.** The 30-day expiry, `Revoke`, `Revoke all` and the log work as for computers. Changing the password does not affect phones.

<a id="phone-web-class"></a>
### The `web` client class

`core/web-channels.ts` gives every method of the channel table a decision, typed as `Record<IpcMethod, …>`, so a new row does not compile without one. The options are `allow`, `deny`, `guarded` or an argument check. `dispatch` runs it after the table's validator, refuses with `Not available from a phone.` and logs `call-refused`. Only `allow` subscribe rows send events to a phone.

| Row | Phone access |
|---|---|
| `sendCommand` | Only `prompt` (incl. steering), `cancel`, `answerPermission`, `answerQuestion`, `decidePlan`, `answerCrewQuestion`, `steerQueuedPrompt`, `removeQueuedPrompt`, `retryTurn`, `setOption` |
| `terminalCommand` | Only `read`, `text`, `unwatch`. Not `list`, which would start a host; tabs come from `readCommandRuns` |
| `saveSettings` | `guarded`: only `notifications` change (`guardPhoneSettings`) |
| `readEditorFile` | `deny`: it takes the editor lease. The phone reads with `peekFile` (same id and `O_NOFOLLOW` checks, no lease, files of the task tree only) |
| `listFiles`, `searchFiles` | Only with `showIgnored = false` |
| `readFileLinks` | `deny` |
| `startPullRequestAgent` | `fix` with exactly 4 args, or `review` with exactly 5 (`sendComments` false, place `quick` or `worktree`). Main does not save `agents.reviewWhere` for a phone |
| `resolvePullRequestConflicts` | Only `agent` |
| `moveTask` | Any board column (`isBoardColumn`). Main refuses moves outside `boardMove` (`This move is not allowed`) |
| `archiveTask` | `allow`. Main refuses while the agent works (`canArchive`) |
| `createProposedTask`, `declineProposedTask` | Task key plus a non-empty id |
| `openMainTree` | `allow`: the hidden main-tree record for PR writes without a task |
| `onRemoteMenu`, `onRemoteDialog`, `answerRemoteUi` | `allow`: menus and message boxes appear as sheets. Folder, file and page-dialog requests are answered `null` |
| Remote access, slack, schedules, appearance, layout writes, `collapseCrew`, `restartApp` | `deny` |

- A phone never takes control and never puts up the cover. Single-client calls are answered with no effect.
- A phone is a device in `Devices`. Its access is equivalent to a shell through an agent: hiding ignored files is a convenience, not a security boundary.

<a id="phone-push"></a>
### Web Push

- **Implementation.** RFC 8291 (`aes128gcm`) and RFC 8292 (VAPID, ES256) are implemented in-house on `node:crypto`, tested against the RFC 8291 test vector. The VAPID key is in `remote/vapid.json`.
- **Subscription.**
  - It is stored in the device record (`push {endpoint, p256dh, auth}`) and sent as a `push` message over the WebSocket after sign-in.
  - Endpoints must be `https` on `*.push.apple.com`, `fcm.googleapis.com`, `*.push.services.mozilla.com` or `*.notify.windows.com`. Redirects are not followed.
  - Resending the same subscription writes nothing.
- **When a push is sent.** When a main notification would show (`notificationDecision`): `needs-you`, `question`, `permission`, `plan` or `done`.
- **Payload** `{task, type, key}`. `key` is `<project>/<task>`, opaque ids the OS does not display. The lock screen shows only the task title and the type (Question, Permission, Plan, Done), never the question text. Notifications have no actions.
- **Headers.** `TTL` 1 h, `Urgency: high`, and `Topic` = a hash of `key`. The notification `tag` is the same hash, so a newer push for a task replaces the older one.
- **Opening.** The service worker checks both ids with the router's pattern and opens `/#/t/<project>/<task>`.
  - An open app receives the address by message and navigates without reloading, so the sign-in is kept.
  - A closed app opens at that address and shows the task after sign-in.
- **Cleanup.** A 404 or 410 from the push service erases the subscription.
- **When nothing is sent:** with the module, access or phone switch off. Revoking a phone erases its subscription. A sleeping machine sends nothing, and the UI says so.

<a id="phone-app"></a>
### App shell, navigation and touch scale

- **The app.** `renderer-mobile/app.tsx` mounts `MobileApp` on the sign-in connection and sets `window.brigadir = createDesktopBridge(...)` over the WebSocket transport. Shared renderer modules (`session-read`, `session-events`, `markdown`, `ui/`) work unchanged.
- **Navigation is a stack in `history`.**
  - Routes: `#/` (Home), `#/p/<project>` (and `/pr`), `#/p/<project>/pr/<repo>/<number>`, `#/t/<project>/<task>`, and the task tools `…/changes`, `…/changes/<file id>`, `…/pr`, `…/files`, `…/files/<folder id>`, `…/file/<file id>` and `…/terminal`.
  - URLs hold only opaque ids issued by main, never paths. A URL with broken `%`-encoding opens Home.
  - An open sheet is its own history entry.
  - System back (iOS edge swipe, Android button or gesture), the sheet's × (`ui/PopupClose` with `touch`: a 16 × in a 44 target with a 28 `--tint` circle, labelled "Close"), a swipe down on the handle or header (> 25 % of the sheet height or a quick flick) and Esc from a keyboard all call `history.back()`.
  - The back label names where it leads (`under`): `Projects`, or the project name.
- **Touch scale.**
  - `:root[data-touch]` redefines sizes L and XL of the control scale: L = 44 / padding 16 / radius 12 / text 15 / weight 500, and XL = 50 / 18 / 14 / 16 / 600 (`--c-fw`). See [Control sizes](appearance.md).
  - `ui/Button`, `IconButton`, `Switch` and `Segments` are the same components with `data-size="l"`/`"xl"`. A switch in an L row follows the row.
  - There is no hover (`@media (hover: none)`). A pressed state (`--segment-press`) covers the same area.
  - One 16 pt side gutter on every screen.
- **Mobile-only parts** are in `renderer-mobile/ui/`, one component each: nav bar, bottom sheet, sheet row, task card and quiet row, project frame, machine chip, quota pill, banner, phone composer, `FileRow`, `Chip`. Mobile-only tokens (`--scrim`, `--bar`, `--sheet`) are in `renderer-mobile/mobile.css`. Task states use `ui/StatusIcon`. `Avatar`, `PRGlyphs` and `DiffCode` (`wrap`) are shared from `renderer/ui`.
- **iOS keyboard.**
  - The app fills the visual viewport (`visualViewport` → `--vv-top`, `--vv-height`). The header stays put, and the composer and sticky sheet footers sit above the keyboard.
  - While the keyboard is open (`data-keyboard`), the safe-area bottom padding is removed.
  - Pinch-zoom is left alone.
- **Theme and language.** The theme is per phone (`System`/`Light`/`Dark`, `localStorage`). The language is the phone's.
- **Phone settings** are in the machine sheet: `Notifications on this phone`, theme, `Sign out on this phone`, and the version line `Brigadir {version} on {machine}.` (from `welcome.version`).

<a id="phone-home"></a>
### Home and project

- **Home is the sidebar.**
  - Tasks are ordered by `sidebarTasks`, and done tasks are quiet rows under a line.
  - The filter is the same three states (`sidebarMatches`) as a grouped sheet.
  - The first row is `{count} waiting`. It counts `needs-you` tasks across projects, including waiting crew workers. Tapping it opens the task if there is only one, and turns on the needs-you filter otherwise.
  - "+" in the header starts a new task in the last opened project, and "+" on a frame uses that frame's project.
- **Project frames.** The chevron (30 pt, with a 44 pt target) collapses the frame. The rest of the header opens the project.
- **Crews.** The foreman card has worker rows under it (`crewWorkerRows`, 44 pt). A foreman whose worker waits turns amber (`A worker is waiting for you`), stands in the needs-you group and passes that filter. [Crew](crew.md).
- **Quota pill** in the header (`readQuota`/`onQuotaChanged`).
  - It shows one window per provider: `displayWindow` by default, and the window picked in the limits sheet otherwise, stored per phone.
  - Amber below 25 %, red at 0 %.
  - Opening the sheet calls `refreshQuota`.
- **Project screen.**
  - Segments `Tasks N | PR N ●` (`ui/Segments` L with `tail` numbers). The `badge` dot appears when a PR waits for your review.
  - Switching segments replaces the history entry, so back goes Home from either one.
  - The PR count covers open PRs of all the project's repos (`readPullRequests(project, null)`).
  - Tasks are listed by state group.
- **Board.**
  - An icon on the Tasks segment switches between list and board. The view is remembered per phone and per project (`localStorage`) and never changes the machine's `saveProjectView`. [Board](projects-and-board.md).
  - The columns `Backlog · In progress · Completed` are pages with tabs that carry counts, and a sideways swipe turns the page. Card order follows `boardSections`.
  - Backlog cards show a dashed circle and `Not started · model · effort`. Completed cards are quiet rows.
  - Backlog and Completed always show as dashed columns, and an empty column explains what lands there.
- **Moving cards on the board.**
  - A long press (500 ms) lifts a card. Hovering over another column's tab switches the page, and a hint under the finger says what will happen.
  - A forbidden target is dimmed and explained in red. The rules are the same `boardMove` as on desktop.
  - Moving a task whose agent works or waits out of In progress asks for confirmation in a sheet.
- **Card swipe.** A task card or quiet row swiped left reveals one 84 pt action, chosen by `swipeAction`: `Complete` (green; in progress, agent idle) or `Archive` (grey; completed). There is no swipe while the agent works or waits. The action runs when tapped, not at the end of the gesture. The action is not drawn at rest.
- **`Complete task`** in the task menu follows the same rule: it is absent while an agent works in or under the task, or while a turn runs.

<a id="phone-chat"></a>
### Task chat and composer

- **Rows** come from the desktop engines: `activityRows`, `toolRuns` (tool groups), `turnStatus`, `pendingInputs` and `promptQueue`, rendered by `ui/Rows` with mobile rows. See [Chat](chat.md) and [Turns, plans and questions](chat-turns-plans-and-questions.md).
- **Every "needs you" can be answered on the phone.**
  - Questions are answered with `answerQuestion`.
  - Permissions are answered with `answerPermission`.
  - The agent's plan approval is a permission card (`PermissionCard` `body` shows `planApprovalText` as chat Markdown), and `plan.document` shows the document.
  - The foreman's plan is answered with `decidePlan`.
  - A crew worker's question shows "waiting for the foreman" until it escalates. After that it becomes a question card without `Skip` (`skip` prop) answered with `answerCrewQuestion`. `pendingInputs` counts `crew.question.escalated`.
  - A task proposed by an agent shows `Decline` / `Create`.
- **Steering** ([Steering and queue](composer-steering-queue-and-ghost.md)).
  - Tapping Send during a turn sends now.
  - A long press (500 ms) opens `Send now` / `Queue`.
  - A queued row has `Send now` (`steerQueuedPrompt`).
- **Retry.** `Retry` appears on the last `session.failed` (`retryTurn`). A stopped agent starts first.
- **Composer** ([Composer](composer.md)).
  - "+" offers `Take photo`, `Choose photo` and `Choose file` (`<input type=file>` → `uploadAttachment`). A thumbnail shows a spinner while the upload runs and an error under it if it fails. The same file can be picked twice.
  - The model chip opens the model and effort sheet (`setOption`).
  - Context % comes from `usage.changed`.
  - The field grows by `scrollHeight` up to 160.
  - The branch row `⑂ branch +N −M from base` uses normal text in `--fg3` and opens Changes.
  - At the subscription limit, the chip `Limit · 42 min` and the limit sheet use `formatDuration`.
- **Links.** `http(s)` and `mailto` links open a new tab or the system browser. A task file path (`src/app.ts:12` or absolute) opens the code screen through `searchFiles`. Anything else does nothing.
- **New task** is a sheet: project, text, model (the provider's catalogue), effort. `Start` calls `createTask` with the project's last launch parameters (`readLaunchSettings`).

<a id="phone-task-tools"></a>
### Changes, PR, files and terminal

The task menu is a bottom sheet with Changes (`N files · +N −M` from `readChanges`), `Pull request` (`#N · Checks N/M` from the `readForge` cache) and Files (`repo · {count} changed`). The terminal is also reached from the task.

- **Changes.** The phone uses `readChanges` with the same diff base and range as desktop ([Diff and review](diff-and-review.md)).
  - The header reads `N files +N −M · from base · repo`. Rows are `FileRow` with M/A/D and `+N −M`.
- **Diff.**
  - The data comes from `readFileDiff`, then `readFileSyntax`, with rows from `diffRows` in unified mode with 3 context lines. Each collapsed region shows as an `@@ −a,b +c,d @@` band.
  - Each line is `ui/DiffCode`: one number (the new one, or the old one for deletions), the sign and word-diff `spans`.
  - Wrapping is off by default and toggles from the header.
  - Previous and Next replace the history entry, so back returns to the list.
- **Pull request** ([Pull requests](pull-requests-and-ci.md)).
  - **Which PR.** The task's PR comes from `task.pullRequests` (the first scope). If there is none, `readForge` finds it by branch.
  - **Data.** `readPullRequestDetail` is fresh on open and after every write, together with `readPullRequestReview`.
  - **Overview.** Title, `#N`, state and `head → base · repo`. A card shows `Checks N/M` with the running or failed check (`CIGlyph`), the author and reviewers, the `mergeBlock` reason and `Merge PR…`. Merge is disabled with the reason.
  - **A failed check** offers `Log on GitHub` (the phone's browser, `readPullRequestLinkUrl`) and `Ask the agent`. The latter sends an English prompt to the task chat to read `gh run view --log-failed` and fix it, and returns to the chat.
  - **Comments.** Unresolved threads show `file:line` and the code line, followed by general comments.
    - `Reply` turns the bottom field into a reply (`commentPullRequestNow` with `replyTo`).
    - `Ask the agent` calls `askPullRequestAgent`, and the agent's text answer appears under the thread.
    - The bottom field posts a general comment (`commentPullRequest`) and uses the composer look (`chat/CommentBox`).
  - **Review sheet.** Options are `Comment (review)` / Approve / Request changes / `The task agent makes the fixes from the comments`, plus a general comment and the list of line drafts (read-only). Sending calls `setPullRequestReview` (only `body`, `event`, `sendComments`) and then `submitPullRequestReview`.
    - The fix option calls `startPullRequestAgent(…, 'fix', …)`. If the PR's task already exists, the prompt goes to its chat.
    - On your own PR, Approve and Request changes are disabled with the reason.
  - **Merge sheet.**
    - The method comes from the repo's `mergeMethods`, with the default marked `Repo default`. Up to three commits are listed.
    - `Delete branch` is on by default and offered only for same-repo PRs. Main refuses branch deletion for forks or when head is the default branch.
    - The consequence is spelled out (`A merge on GitHub cannot be undone.`), then Cancel / Merge (`mergePullRequest`).
    - A disabled merge does not open the sheet.
  - **🔗** opens the PR page on GitHub (`readPullRequestPageUrl`).
- **Files** ([Editor](editor.md)).
  - The tree comes from `listFiles` folder by folder, with breadcrumbs, M/A marks from the tree `status` and `+N −M` from `readChanges`. The magnifier calls `searchFiles`. Paths are relative to the task tree.
  - Folders replace the history entry, so back goes to the chat. A file is its own entry.
- **Code.**
  - The text comes from `peekFile`, colours from `readEditorSyntax` and the machine's code theme.
  - It is shown in read-only CodeMirror (`EditorState.readOnly`, `editable: false`, no LSP, no keyboard) with wrapping, line numbers and `syntaxDecorations`.
  - Gutter change marks come from this file's diff: green for added lines, blue for changed ones.
  - ⋯ offers `Copy path`.
  - A large file (`large`) shows plain text with no colours and no Markdown preview.
- **Markdown** uses `Code | Preview` segments. The preview is the chat Markdown renderer (no raw HTML, no remote images), and links open the phone's browser.
- **Terminal.**
  - Tabs are the project's command runs (`readCommandRuns`; this starts nothing).
  - Output comes from a `terminalCommand read` snapshot plus `terminal:event`, in xterm.js with `disableStdin` and the WebGL renderer. There is no input field. `To the end` appears when scrolled up.
  - Watches are counted per client: main sends `unwatch` to the host only when no client watches.
  - A reload, crash or close of a machine window releases only that window's watches (`TerminalWatchers.forget`, `sessions.unwatchAll(keep)`).
  - A `read` the host refused does not count as a watcher.
  - The phone reads again after a resume and whenever the app becomes visible. A newer snapshot replaces the screen, and events during a read wait for the snapshot.
- **CSP stays strict.**
  - CodeMirror lives in a shadow root with adopted style sheets, and its `EditorView.theme` uses page tokens.
  - `renderer-mobile/adopted-styles.ts` turns script-created `<style>` elements into adopted `CSSStyleSheet`s and `setAttribute('style', …)` into `style.cssText`. This covers xterm's scrollbar and DOM renderer.
  - Parser-created `<style>` and `style=` stay blocked.
  - e2e requires zero CSP violations.
- **Loading states** exist on Home, chat, Changes, diff, Files and Terminal. The task subtitle is its state.
- **Errors** show translated text, never raw messages.

<a id="phone-pr-list"></a>
### Project PR list

- **Groups** are `prGroups`: Waiting for you / Yours / Others / Recently closed, followed by a link to older closed PRs on GitHub.
- **Search and repo filter.**
  - An L row holds the search `Find PR` (title, branch, author and repo, with matches highlighted) and `All repos ▾`, shown only when the project has several GitHub repos.
  - The repo sheet lists repos in Repos-section order: the root is named after the project, and repos without PRs are dimmed.
  - The chosen repo tints the button, and rows then omit the repo name.
- **Filter chips** `All · Waiting for you · Yours` with counts. The default is Waiting for you when such PRs exist, and All otherwise.
- **Refresh.** Pull to refresh (`Release to refresh` → `Refreshing from GitHub…`). There is no polling.
  - The first load shows a skeleton.
  - An error keeps the list and shows a banner with Retry.
  - An empty list shows no open PRs, `Show closed · N` and a GitHub link.
  - `gh` not signed in shows `GitHub is not connected on {machine}` with Retry, noting that the command runs on the machine.
- **🔗** opens the chosen repo's PR page, or the first repo's when All repos is chosen.
- **Rows.**
  - Line 1: `PRStateGlyph`, the review glyph, the title and a `CIGlyph` for checks.
  - Line 2: the repo (when there are several and none is chosen), avatar, `#N`, author ("you" for your own) and time.
  - Line 3: branch, comments and `+N −M`. `PullRequestSummary` carries `additions`/`deletions` from the same GraphQL query.
  - Recently closed PRs are quiet rows without line 3.
- **PR screen from the list.** It is the same PR screen in the **main tree** context, as the desktop PR panel without a task: reads use `taskId: null`, and writes use the hidden main-tree record created by `openMainTree`.
  - A PR recorded on a project task shows a task row at the top that opens the task's chat.
  - A PR without a task offers `Review with an agent`. A sheet shows the reviewer agent (the machine's default provider and model) and where it works, with Quick as the default and worktree as the other option. It calls `startPullRequestAgent(…, 'review', false, where)` and opens the new task's chat.
  - A conflict with base (`mergeBlock` `conflicts`) offers only resolution by agent (`resolvePullRequestConflicts(…, 'agent')`). A task already on the PR branch gets the prompt, otherwise a new task starts with it.

<a id="phone-connection"></a>
### Connection states

- **The machine chip** pings every 10 s.
  - Over 300 ms it shows `slow`.
  - On a drop it shows `connecting…`, and after 5 s without a link it shows unavailable.
  - When unavailable, cached data is dimmed, actions are disabled and a banner `{machine} is asleep or unreachable` offers Retry. Without a link, a cached task opens read-only (page memory only), with no swipe and no "+".
- **Coming back.** `visibilitychange`, `pageshow` and `online` reconnect at once. A socket that does not answer a ping within 2.5 s is replaced. After the link returns, the chat reads the tail it missed.
- **Sign-in failures.**
  - A rejected resume token shows `The session has ended`.
  - `bye: revoked` shows `This phone was revoked on {machine}`.
  - When the machine is unreachable, the installed app shows the cached shell with checks and the last successful sign-in time (`Last successful sign-in: {time}`).

<a id="tailscale-guidance"></a>
## Tailscale guidance and phone steps

- **No extra software on the LAN.** A computer on the same home network needs nothing more.
- **Tailscale elsewhere.** A computer away from home, and a phone anywhere, need Tailscale on both ends. A phone also needs HTTPS enabled in the tailnet and `tailscale serve`.
- **Facts line** (`RemoteFacts`, intro and settings): `On the same home network nothing else is needed. Away from home and from a phone, Tailscale on both devices.` followed by `Download Tailscale` (`https://tailscale.com/download`). See [Onboarding](settings-modules-and-onboarding.md).
- **Links** use one component, `ui/WebLink`: accent text (`--accent-text`), underline on hover, a 1 px `--accent` focus ring at offset 2. It opens in the system browser through `openWebLink` (class `client`, so on a device it opens on the device). The link goes at the end of the sentence, after a space, with no arrow.
- **Tailscale not found.** If the machine has no CLI, the phone status row shows a grey dot and `Tailscale is not found on this machine.` in amber with the download link. A machine with the CLI but no tailnet name shows `Tailscale is not running here, or this machine has no name in the tailnet.`
- **`Steps`** sits under the phone switch as a numbered list. Each number is an 18 px circle (`--tint`/`--fg2`), or a ✓ (`--green`) when the app can see the step is done; done text is `--fg2`. Steps show whenever access is on. While the phone switch is off, Tailscale is not queried, so no step shows a check.

  | # | Text | Done when |
  |---|---|---|
  | 1 | `Install Tailscale on the phone and sign in to the same tailnet.` + `Download Tailscale` | A phone is paired |
  | 2 | `Turn on HTTPS in the tailnet’s DNS settings.` + `Open the admin console` (`https://login.tailscale.com/admin/dns`) | `tailscale status --json` has `CertDomains`, or serve already works |
  | 3 | `Run once on this machine:` + the command (monospace 10.5 px on `--tint`) and an S copy `IconButton` (copy, then tick) | serve routes the address here |
  | 4 | `Click Add device below to get a code.` | A phone is paired |
  | 5 | `Open {address} on the phone and enter the code.` (before the address is known: `the machine’s tailnet address`) | A phone is paired |

- **Connect list hints.**
  - An expanded machine row that did not answer and has no Tailscale address shows `Outside the LAN, only through Tailscale on both computers.` with the link under the password field.
  - The "does not answer" card ends with the same link.
  - The second settings part shows `Outside home both computers need Tailscale.`
- **Settings rows** whose control spans several lines (`Phone`, `Steps`, `Remote access`) align the label with the control's first line. See [Settings](settings-modules-and-onboarding.md).

<a id="later"></a>
## Later

- Open locally: forward a working-machine port (such as `localhost`) through the gateway to the device.
- Real page and simulator DevTools through the gateway.
- Several clients controlling one machine at the same time, including screencasts to several devices.
- Popups, device clipboard copy and bindings inside cross-site frames of a screencast page. A cross-site frame's `<select>` does not open on the device yet, and its copy stays in the frame.
- Our own relay server, if Brigadir is distributed to other people.
- Windows as a full build: frame and ☰ checks, Snap layouts, notifications with `AppUserModelID`, DPAPI key storage.
- The remaining ⌘-only places in the renderer (simulator keys, ⌥⌘[ / ⌥⌘] in the conversation) through `ui/primary-key`.
- OS-level notifications on the working machine for connections and failed tries. Toasts cover this today.
- Manual checks of Tailscale reachability and the macOS local-network prompt on a packaged build, and of Linux desktops (GNOME/KDE, Wayland/X11: secret service, file pickers, `showPicker()`, `xdg-open`). Machine sounds are silent on Linux.

<a id="non-goals"></a>
## Non-goals

- A desktop web client in a browser. The browser takes `Ctrl/⌘+W/T/N`, has no menu bar and needs a public certificate. The web version is phone-only.
- A separate client-only build. Full builds connect to each other, and the phone is the only client without its own machine.
- Driving agents over SSH from a full Brigadir on the client, or SSH tunnels as the main path. The simulator, Xcode and the agent browser must live next to the agent, and SSH needs manual setup.
- Screen sharing (VNC/RDP) as the mechanism.
- Password-only or key-only sign-in for computers. Both factors are required.
- Storing the password on the device.
- Loading the renderer bundle from the working machine. This would need generic channel forwarding in the preload.
- UPnP, router port forwarding, dynamic DNS, Cloudflare Tunnel, or LAN-only phone access with a custom CA. The supported routes are LAN for computers at home and Tailscale for everything else.
- On the phone: terminal input, the browser, the simulator, code editing and LSP, settings beyond notifications and theme, remote access and module management, manual conflict resolution, line review drafts, and showing the question text in push notifications.
