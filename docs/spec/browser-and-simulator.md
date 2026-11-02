# Browser and simulator

Each task has its own browser and simulator, which open as tabs of the task's work area. The person shows the agent part of a page or screen (node picking, screenshots, console and network entries). The agent reads and drives the same page or device itself through `brigadir` MCP tools. The principle that shapes everything here: the agent works on the same page or device that the person can see. There is no hidden second browser, and actions are not taken on the person's own browser.

<a id="placement"></a>
## Placement and availability

- The browser and the simulator are **work area tabs** of the task window ([Task window workspace](task-window-workspace.md)). A task can hold any number of browser tabs. **Tools ▸ Browser** `⌘⇧B` and **Tools ▸ Simulator** `⌘⇧M` go to the last tab of that kind, or open one. **New browser** adds another.
- They exist only inside a task. The project screen has no browser, because nothing there could receive an attachment.
- Each one can be switched off as a module ([Modules](settings-modules-and-onboarding.md#modules)). A switched-off module removes its tabs, menu items, shortcuts and MCP tools. A call to a tool of a switched-off module returns a sentence saying so.
- Each MCP tool needs the app window. When the window is closed, the tool answers with a sentence such as `The browser needs an open application window` or `The Brigadir window is closed, so the browser is not available.`. Calls are never queued.
- Opening the browser or simulator from a device on another machine is covered in [Remote access](remote-access-and-mobile.md).

<a id="browser"></a>
## Browser

<a id="browser-engine"></a>
### Engine and isolation

| Aspect | Rule |
| --- | --- |
| View | Each tab is its own Electron `WebContentsView`, with `sandbox`, `contextIsolation`, no Node, no preload and no app IPC. This is a separate Chromium renderer, not a React surface. |
| Session | One persistent Chromium session per project, `persist:brigadir-browser-<projectId>`. Cookies, `localStorage` and logins are shared by every tab and by both modes. |
| Schemes | Only HTTP(S). In the address field, an entry without a scheme gets `http://`. Other main-frame schemes are blocked. |
| Denied | All site permission requests and checks (the notifications case is handled by the page script, see [Page notifications](#notifications)), downloads, and new windows. |
| User agent | Chromium's own UA without the `Electron/…` token. It does not pretend to be WebKit. |
| CDP | Main uses a fixed set of narrow CDP operations: read, screenshot, console, Fetch/XHR/stream metadata, the node inspector, mobile emulation, input and the accessibility tree. The renderer cannot run arbitrary `evaluate` or `sendCommand`. |
| Page scripts | The reading and describing scripts are source files (`main/browser-scripts.ts`, `main/browser-page.ts`), not text generated at runtime, so a script that breaks on some page can be read. |
| Native view vs DOM | The page is drawn above the DOM. When a popover, dialog, toast, dragged tab or border drag overlaps it, main briefly puts a still image of the page (`capturePage`) in its place, and the page stays live underneath. |

<a id="browser-toolbar"></a>
### Toolbar

Row 1 (address, size M): **Back**, **Forward**, **Reload**, a monospace **Address** field (Enter opens it, so there is no Go button), and an icon that opens the current HTTP(S) page in the system browser.

Row 2 (actions, size M):

| Control | Behavior |
| --- | --- |
| **Select element** (`⌘⇧C`) | Node picking, see below. Shows as pressed while active. |
| **Desktop / Mobile** segment | Icon-only. Two options, and no more will be added. |
| **Page console** / **Network** | Always visible, even on a clean page, because they are the way into the log. An error count appears only when errors exist, and the button then turns into the danger style. A click opens the drawer on that button's tab. |
| **Screenshot to chat** (`⌥⌘B`, camera glyph) | A PNG of the viewport goes into the composer as an image attachment. |
| **…** | The shared `ToolbarMore` popup (header «More» with Esc, width 280). It contains **DevTools** `⌥⌘I`, **Open in default browser** (only for `http(s)` pages), and the **Site notifications** radio section. Only actions that already exist elsewhere go here. |

If the page fails to load, an error line (`role=alert`) appears under the toolbar.

<a id="browser-modes"></a>
### Desktop and Mobile

| | Desktop | Mobile |
| --- | --- | --- |
| Viewport | Width of the tab | **390 × 844** CSS px (`Emulation.setDeviceMetricsOverride`, `mobile: true`, DPR 1) |
| User agent | Chromium | Chromium with `(Linux; Android 13; Mobile)` and a ` Mobile` suffix |
| Touch | Off | `Emulation.setTouchEmulationEnabled` + `setEmitTouchEventsForMouse` (`mobile`) |

- Mobile mode is a real width, not a scaled-down page, so media queries fire. If the tab is narrower than 390, the page scrolls horizontally rather than shrinking.
- The 390-wide viewport is centred in the tab, with equal margins on both sides.
- Changing the mode reloads the page, because the UA is read at load.
- The mode belongs to the tab. It is saved with the tab in the task's surface state and restored after a restart, before the tab mounts.

<a id="node-picking"></a>
### Select element: the person shows the agent

- Uses Chromium's inspector overlay (`Overlay.setInspectMode searchForNode`). The node under the cursor gets a 1 px outline in the app accent (theme-aware) plus a label.
- One click picks **one** node, attaches it to the composer and turns the mode off. Esc cancels. A mode that has to be left separately would be a trap, because the next click on the page would be a real click.
- The chip is embedded text, `Selected browser node: {json}`, with:

| Field | Value |
| --- | --- |
| `url` | Page address |
| `selector` | The first stable one of: `[data-testid=…]` → `#id` → a short CSS path (up to 5 levels) |
| `html` | The node's `outerHTML`, cut to 400 characters. The agent can read the full subtree with a tool. |
| `width`, `height` | Rounded box size |
| `mode` | `Desktop` or `Mobile` |

- Click coordinates are never sent, because a re-render would break them.
- While the chip stays in the composer, the node stays outlined on the page. Removing the chip removes the outline. Up to 10 picked nodes are tracked per tab.
- Focus moves to the composer, since the next step is to say what to do with the node.

<a id="console-network"></a>
### Page console and Network drawer

- One drawer with two tabs. **Page console** shows what the page *said*: `console.*`, uncaught exceptions and `unhandledrejection`. **Network** shows what it *requested*: Fetch and XHR only. The full name «Page console» is used because «Console» already means the task terminal ([Terminal](terminal-and-cli-agents.md)).
- Network row columns: method · status · path · type · time · size, with fixed widths and the path taking the rest. Each row has **Details**.
- **Request details** dialog: response headers and body, with a **Show the agent** footer.
- **Show the agent** in the drawer attaches the visible list (up to the last 16,000 characters) as a text attachment.
- **Failure strip**: shown only while the drawer is closed. It appears for an exception or a failed request, and names the source (`Page console: …` / `Network: …`). **Show the agent** opens the drawer and attaches the entry. It is never sent to the agent automatically. `×` dismisses it, and it also clears on navigation.
- **Buffer**: up to 500 entries per tab, in memory only, cleared on every main-frame navigation. Logs and URLs can contain tokens, which is why nothing is saved to disk.

**Network data rules:**

| Rule | Value |
| --- | --- |
| Requests kept | 500 per tab. When eviction is needed, finished requests go first. |
| Response headers | `Authorization`, `Proxy-Authorization`, `Cookie`, `Set-Cookie` are dropped without reading their values. At most 16 KiB in total. |
| Request headers / post data | Not collected |
| Body | Read only on **Details** or `browser_network(requestId)`, up to 16 KiB. A body Chromium no longer has (evicted or unavailable) shows a visible error. |
| Not seen | Requests from before the page script was injected, `sendBeacon`, service worker traffic. DevTools covers these. |

**DevTools** (`⌥⌘I`, **…** menu, **Browser ▸ DevTools**) opens Chromium's own DevTools for the page in a separate window (`Could not open DevTools.` on failure). The drawer is a thin surface for attaching things to the chat, not a second inspector. Elements, Sources, breakpoints, waterfall and profiler are left to DevTools.

<a id="browser-shortcuts"></a>
### Menu and shortcuts

The **Browser** menu (each item also has a menu-bar entry, see [Search, menus and commands](search-menus-and-commands.md)):

| Item | Shortcut | Note |
| --- | --- | --- |
| Focus address | `⌘⇧L` | `⌘L` stays **Focus composer** everywhere. |
| Select element | `⌘⇧C` | |
| Screenshot to chat | `⌥⌘B` | |
| DevTools | `⌥⌘I` | |
| Reload · Back · Forward | `⌘R` · `⌘[` · `⌘]` | Only while the page has focus |

Opening a browser tab gives focus to the page. A new tab that has no page yet gives focus to the address field.

<a id="agent-tools"></a>
## Browser MCP tools

The tools are served by the existing `brigadir` MCP server (`mcp__brigadir__browser_*`), not by a second translator. The host forwards calls to the app over its authenticated socket. Every task has them, not only crew tasks. Read-only tools carry `readOnlyHint`, so Claude can call them in plan mode.

| Tool | Does | Permission |
| --- | --- | --- |
| `browser_open` | Opens a URL in the agent's own tab. The first call creates the tab, later calls navigate it, and `tab: "new"` creates another. HTTP(S) only. | Per domain (open) |
| `browser_state` | Address, title, loading, mode, `notifications`. Also lists `tabs`: every browser tab of the task, with `yours` and `onScreen`. | — |
| `browser_read` | `innerText` (≤ 32,000 chars) and `outerHTML` (≤ 16,000) of the body or of a `selector` | — |
| `browser_console` | The newest console entries since load, up to 100 within 32 KiB | — |
| `browser_network` | Requests, or details for one `requestId` (`network-N`). See [Streams](#network-streams). | — |
| `browser_screenshot` | PNG of the viewport, or of a `selector` clipped to the visible viewport, scaled to width ≤ 900, returned as an MCP `image` block. An element that is not visible is refused (`Element is not visible`) rather than returning an empty or wrong image. | — |
| `browser_ui` | The accessibility tree, see below | — |
| `browser_act` | One action, see below | Per domain (act) |
| `browser_show` | Asks the person to put the page on screen | Card in «Needs you» |

- Every tool except `browser_show` takes an optional `tab` (`b…`). Without it the call goes to the agent's own tab, otherwise to the task's tab currently on screen.
- The screenshot is taken from the live view itself, so the agent sees exactly what the person would see. Width is limited to save context tokens, not disk space.
- Each tool call appears in chat as a tool row (`Opening the page`, `Acting on the page`, …), and these rows double as the action log.

<a id="opening-tabs"></a>
### Agent calls open the tab themselves

- Any browser call opens the agent's tab in its own task if it isn't open yet (main sends `browser:show`, the renderer sets the tab). The selected task, the window and the OS focus never change.
- If the task is on screen, a new tab opens in front of the person, and the call waits up to 3 s for it to mount.
- In every other case the call runs on a parked view (see [Background operation](#background)). The person sees the tab when they open the task.

<a id="open-permission"></a>
### Domain permission to open

- `browser_open` to a non-local address shows the shared permission card (the same broker as other tools, [Agents and providers](agents-and-providers.md)), titled `Open <host>`, with **Allow once** · **Allow for domain** · **Deny**. Deny returns `Browser navigation was denied`.
- Local addresses never ask: `localhost`, `127.0.0.1`, `[::1]`, `*.localhost` (one shared definition, `localBrowserUrl`). It is the person's own machine, where the agent already has a terminal.
- The permission covers the **domain** (hostname), not the URL. The port is not part of it, so `staging:3000` and `staging:8080` count as one trust decision.
- Allowed domains are saved **per project** in `~/.brigadir/projects/<id>/browser-domains.json` (`{ schemaVersion: 1, domains: [...] }`, at most 1000).
- **Redirect containment**: after an agent navigation, main-frame navigations of that page, redirects included, may only go to local addresses, the domain just approved, or the project's saved domains. Any other domain is blocked with `Browser navigation needs permission: <url>`, and the agent can then ask `browser_open` for it. When the person navigates from the strip, this restriction is lifted.

<a id="browser-ui-act"></a>
### `browser_ui` and `browser_act`: the agent clicks and types

**`browser_ui`** returns a compact accessibility tree (CDP `Accessibility`), one element per line:
`button "Save" @e42 120,340 80×32 focused`. The head line gives the viewport size, the scroll position, the page size and the element count.

- Only meaningful nodes are listed: controls, links, headings and images that have a name, dialogs, alerts and status regions, plus any focusable named node (as `clickable`). Names are cut to 120 characters, values to 200.
- States: `focused`, `disabled`, `checked`/`mixed`, `pressed`, `expanded`, `selected`, `required`, `invalid`, plus `offscreen` or `hidden` derived from the box.
- Results are paged with `offset`, ≤ 32 KiB per page, and end with a `… N more: call again with offset M` line. A ref `@e<backendNodeId>` lasts until navigation.

**`browser_act`** performs one action:

| Action | Arguments |
| --- | --- |
| `click` | `count: 2` for a double click |
| `hover` | |
| `type` | `text` into the target or the focused field. `clear` empties the field first, `submit` presses Enter. A color input takes `#rrggbb`. |
| `key` | `Enter`, `Escape`, `Tab`, arrows, a single character, or a combination such as `Meta+A`, `Shift+Tab`. `Meta+A/C/V/X/Z` are sent as editor commands. |
| `scroll` | `dx`/`dy` in px, at the target or at the centre of the page |
| `select` | An option of a `<select>` by `value` or text |
| `back` · `forward` · `reload` | |
| `dialog` | `accept` (and `text` for a prompt): the answer to the page's *next* dialog |
| `clipboard` | Reads the task clipboard |
| `paste` | `text`: puts it into the task clipboard and pastes into the focus, like ⌘V |
| `notifications` | `permission`: `granted` · `denied` · `default` (see [Page notifications](#notifications)) |

- **Target**: a `ref` from `browser_ui` (the preferred, most exact option), a CSS `selector`, a `label` (exact accessible name first, then partial, with controls ranked before headings and images), or a point `x,y` in viewport CSS px. The target is scrolled into view and the click lands at the centre of its box.
- **Real input**: CDP `Input.*`. The page sees the same `pointerdown → mousedown → focus → mouseup → click` sequence a person produces, and in Mobile mode the mouse becomes touch. Text uses `Input.insertText`, keys use `Input.dispatchKeyEvent`. `element.click()` is never used, because it would skip pointer events, focus and the hit test.
- **Hit test**: if another element covers the centre of the target (a modal, a banner), nothing happens, and the agent is told what covers it.
- **Reply**: main waits 300 ms, or until a navigation that has started finishes (≤ 10 s). It then returns one sentence: what was done and on what, the address and title if they changed, up to three new console errors, and page notes (see below). The agent calls `browser_ui` again to see the new tree.
- **Never filled**: `type=password` fields, and fields with `autocomplete` `current-password`, `new-password`, `one-time-code` or `cc-*`. For these, `type`, `key` and `select` refuse and tell the agent to ask the person. File uploads are not supported.
- **Visible action**: an accent ring about 600 ms long marks the point of the action, with a label such as `click · Save` (the same look as an agent tap in the simulator). It is drawn inside the page in a closed shadow root (`brigadir-agent-act`), with `pointer-events: none`, and removes itself. It respects `prefers-reduced-motion`.
- **Person first**: while the person is typing in the tab or holding a mouse button down, the agent's next action waits for 1.5 s without such input. Scrolling and hovering don't count. If the person's input continues without a pause for 10 s, the agent goes ahead.

<a id="act-permission"></a>
### Permission to act

- Acting is a **separate** permission from opening. Having permission to open a page (`browser-domains.json`) does not allow acting on it.
- Local pages never ask. On any other domain the card is `Act on <host>` (input `<action> · <url>`), with **Allow once** (one action) · **Allow in this task** (kept in the task host's memory) · **Allow for domain** (saved to `projects/<id>/browser-act-domains.json`) · **Deny**.
- `clipboard` reads the task clipboard and does not touch the page, so it needs no permission.
- Setting `agents.browserActAnywhere` (**Settings ▸ Modules ▸ Browser settings**: «Agents can act on any site without confirmation», off by default) skips the card on every site.

<a id="network-streams"></a>
### Streams in `browser_network`

- In addition to Fetch/XHR, main tracks `EventSource`, `WebSocket` (handshake → frames → close or error) and a document of type `text/event-stream`. These are **agent-only**. The drawer still shows only Fetch/XHR, and stream messages and live counters never reach the renderer, so a heartbeat doesn't cause the drawer to redraw.
- Request `state`: `pending` (no response yet), `streaming` (headers have arrived, body still coming), `done`, `failed`. For an open request the reply is computed at call time: `elapsed` ms, bytes `received`, and time since the last data. A `: ping` comment counts as data, which is how the agent can tell the stream is alive.
- Messages come from three places. EventSource uses `Network.eventSourceMessageReceived` (event, id, data). A `fetch` that reads an event stream, and a page that is itself a stream, are parsed from `Network.streamResourceContent` according to the event-stream format. WebSocket text frames are recorded as `in`/`out`, a binary frame becomes `[binary N B]`, and control frames are not kept.

| Limit | Value |
| --- | --- |
| One message | 2 KiB, then marked `truncated` |
| Per stream | The newest 50 messages within 16 KiB. `messageCount` gives the total. |
| Streams that keep messages | The 20 newest. Older finished ones keep only a count. |
| List reply | The newest 100 within 32 KiB, plus up to 20 open requests that are always included however old they are |

- `browser_open` on a stream URL answers as soon as the document's `text/event-stream` headers arrive. The reply gives the page state and says that its events are available in `browser_network`. Loading continues in the tab.

<a id="background"></a>
### Background operation

An agent can use the browser of any of its tabs whether or not the person is looking at it.

| Rule | Value |
| --- | --- |
| Parking | A view in use by the agent but not seen by the person moves into its own invisible `BaseWindow`: frameless, opacity 0, ignores the mouse, not focusable, `skipTaskbar`, level `screen-saver`, hidden from Mission Control and the Windows menu. It sits on the main window's display, as wide as the tab and as tall as the window. Each live view gets its own window. Moving the view between windows doesn't reload it. |
| Why always on top | macOS treats a covered window as hidden. CDP mouse input then waits about 5 s and gets lost, and screenshots come back empty. |
| Linux | A window can't be made invisible, so the parking window is never shown. Focus emulation keeps the page painting and accepting input. |
| Focus | `Emulation.setFocusEmulationEnabled` the whole time the view is parked: `document.hasFocus()` is true and fields accept the caret. The OS focus never moves. |
| Agent interval | 60 s after each agent call (`browserFreezeMs`). During it a hidden view stays fully live (network, HMR, timers). |
| Freeze | When the interval ends, a hidden view gets `Page.setWebLifecycleState: frozen` and is detached. The next call re-parks it → `active` → waits for network quiet (500 ms without requests, at most 3 s) → acts. Server-sent streams survive freezing. A view the person can see is never frozen. |
| Cache | At most 10 views per app (`browserCacheLimit`). Only frozen views are closed, oldest first. Live views never count against the limit. A tab that was closed this way keeps its address, and the next call reopens it. |

**What the page does while the agent works with it.** This applies all the time the view is hidden, and for 60 s after the agent's last call on a visible page. Each of these becomes one sentence in the reply to the agent's next call:

| Page event | Handling |
| --- | --- |
| `alert` / `confirm` / `prompt` | Replaced inside the page. `alert` closes, `confirm` gets Cancel, `prompt` gets `null`, unless the agent has set `browser_act dialog`. Outside the interval, a visible page shows the native dialog to the person. |
| `beforeunload` | Doesn't hold the navigation (`will-prevent-unload`) |
| `<select>`, `input type=color` | A click on a hidden page isn't sent, because it would open a native window on the screen. The reply points to `select` or `type`. `showPicker()` is refused. |
| `input type=file` | Always intercepted while the agent acts (`Page.setInterceptFileChooserDialog`). Uploading isn't supported, and the reply suggests `browser_show`. |
| HTTP authentication | `login` is cancelled. The agent is told to ask the person to sign in. |
| Person's input | «The person used this page since your last browser call» |

**Task clipboard.** The system clipboard is never available to a background page, because that page could read the person's copied passwords or overwrite what they copied. During agent actions and while the view is hidden, the page script replaces `navigator.clipboard.*`, `execCommand('copy'|'cut'|'paste')` and the copy/cut/paste events with a per-task in-memory buffer (≤ 100,000 chars). It lives as long as the task host, and is never written to the transcript or disk. Text the page copies is shown to the agent (≤ 2,000 chars). The person's own ⌘C/⌘V on a visible page use the system clipboard.

**`browser_show`.** Some things don't work in the background: file upload, OAuth windows, passkeys, CAPTCHA. For these, the agent raises a «Needs you» card: **The agent needs the page on screen** · **Show** · **Decline**. **Show** opens the task and the agent's tab, and the agent carries on with the visible page. **Decline** tells the agent to continue in the background or hand the step over.

**Visibility for the person:**

- While a task's hidden page is live, its sidebar card and the Tools list show a browser marker («Agent in the browser»).
- While the agent stays with a visible page, the page gets an accent frame and an agent bar: «Agent in the browser · <step>», or «The agent is waiting until you finish · next: <step>». The bar also shows the action count and an **In chat** button that jumps to the actions in the chat. Step texts include `clicks {target}`, `types into {target}`, `allows notifications` and similar. The workspace tab behavior itself is described in [Task window workspace](task-window-workspace.md).

<a id="notifications"></a>
### Page notifications

Chromium's own permission handler always says no. The page script replaces `Notification` (permission, `requestPermission`, constructor, `close`, the `show`/`click`/`close`/`error` events), `navigator.permissions.query({name:'notifications'})` and `ServiceWorkerRegistration.showNotification`/`getNotifications`, so the page sees the real state.

- **State per domain** (hostname): `default`, `granted` or `denied`. A cross-site frame always gets `denied`.
- **Request strip**: `requestPermission()` while the state is `default` shows an S-class strip between the toolbar and the page, reading «{host} wants to show notifications», with **Block** · **Allow** · `×`. The page's promise waits for the answer. `×` keeps the state `default` and silences further requests from that tab until the next navigation, and a navigation removes the strip. A hidden page waits, and the strip appears once the tab is shown.
- **Saved** per project in `projects/<id>/browser-notifications.json`: `{ schemaVersion, sites: { <host>: "granted" | "denied" } }`, at most 1000 entries. This is separate from the open/act lists, and allowing notifications doesn't let the agent open or act on that domain. A decision applies to every tab of the project at once.
- **Menu**: **…** ▸ **Site notifications** with **Ask** · **Allow** · **Block** for the open page's domain. **Ask** removes the domain from the file.
- **Display** (only when `granted`): if the tab is on screen and the window has focus, an `info` toast with title · body · host and an **Open** button. Otherwise, a quiet OS notification in the task's group ([Notifications](notifications-slack-notes-and-schedules.md)). This respects the **When** = **Never** setting. Clicking it opens the task and tab and fires `click` in the page. Limits: one per second per tab, a matching `tag` replaces the previous one, title ≤ 200 characters, body ≤ 1000.
- **Agent**: page requests and shown notifications reach the agent as sentences in its next browser reply. The internal `state` request the host makes before every call doesn't use up these notes. `browser_state.notifications` gives host, state and whether the page is asking now. The agent can decide with `browser_act notifications`, which has the same effect as the person's strip or menu: it answers a waiting request and saves the decision for the domain. It goes through the same act permission (local pages need none). The agent bar shows `allows notifications` / `blocks notifications` / `resets notifications`.
- No Web Push: `PushManager.subscribe` doesn't work in Electron, and notifications that a service worker shows on its own don't arrive.

<a id="tab-sound"></a>
### Tab sound

- A browser tab in the work area strip that is playing audio, or that the person muted, shows a speaker button before `×`: `speaker` or `speaker-muted`, with the tooltip **Mute tab** / **Unmute tab**. It is always visible, unlike `×`, which appears on hover, and otherwise looks and hovers like `×`.
- Main mutes the view itself (`webContents.setAudioMuted`). `BrowserTabInfo` carries `audible` and `muted`, updated on `audio-state-changed`, so the button also works for tabs that aren't on screen.
- The mute lasts as long as the tab, survives navigation, and isn't saved. Only the person can mute. The agent has no `mute` command.

<a id="simulator"></a>
## Simulator

«Simulator» is the single UI word for both iOS Simulator and Android Emulator. A **device** is one specific simulator, e.g. `iPhone 17 Pro · iOS 27` or `Pixel 9 Pro · Android 16`. The main use case is debugging React Native (0.85+). Metro and the build are started by the agent or by [project commands](search-menus-and-commands.md#project-commands). The simulator tab only shows and drives the device.

<a id="sim-device"></a>
### Device belongs to the project

- The chosen device is saved in `projects/<id>/project.json` as `simulator: { "platform": "ios" | "android", "device": "<udid | avd name>" }`. Every task of the project shows the same device and the same frame stream. A device takes 1–3 GB of RAM and seconds to tens of seconds to boot, and the app on it connects to one Metro.
- If nothing is chosen, the person's tab falls back to the first iPhone of the newest runtime. **The agent never guesses**: for the agent, the project device is only the chosen one or a running iPhone.
  - `simulator_open` without `device`, when nothing is chosen and nothing is running, starts nothing and refuses with: `No device is chosen for this project and none is running. Pass device: the one the app is built and installed on (simulator_state lists them).`
  - `simulator_state` then starts with `No device is chosen for this project.`. A running iPhone that wasn't chosen shows as `<device> · booted · not chosen, simulator_open uses it` (or `running` once streaming).
  - A device passed to `simulator_open`, or a running device it uses, becomes the project device.
  - `simulator_state` and `simulator_open` re-read the device list, so `booted` is current. The toolchain is read once per launch.
- Crew workers queue for the single device. A worker's first `simulator_*` call takes it, and it is released at the end of that worker's turn or after 60 s without a call. The foreman and solo agents go ahead of waiting workers. A waiting call gives up after 60 s with `The simulator is busy: another agent of the crew is using it. Do other work and retry later.`. Waiting tasks show «Waiting for the simulator».

<a id="sim-toolchain"></a>
### Toolchain and lifecycle

- **Discovery** uses tools the person already has, and the app installs nothing. iOS uses `xcrun simctl list -j devices available`, with Xcode found via `xcode-select -p`; macOS only. Android uses `emulator -list-avds` and `adb devices`. The SDK is looked up in `ANDROID_HOME`, `ANDROID_SDK_ROOT`, `~/Library/Android/sdk`, `~/Android/Sdk`, and counts only if it contains `emulator/emulator`. The device name and OS come from the AVD's `config.ini`.
- **Missing toolchain** gives one sentence: «Install Xcode from the App Store to run iOS simulators.», or on Linux «Install Android Studio to run Android simulators. iOS simulators need macOS.». With no devices: «No simulators» and «Create a simulator in Xcode or Android Studio, then check again.» with a **Check** button.
- **Boot without a window**: iOS uses `simctl boot`. Android uses `emulator -avd <name> -no-window -no-audio -gpu host -no-boot-anim` and waits for `sys.boot_completed`. Without `-gpu host`, a windowless emulator renders in software at 1–5 fps. Simulator.app and Device Hub are never opened, and the emulator process never takes focus.
- **Shutdown**: devices the app booted itself are shut down (`simctl shutdown`, `adb emu kill`) when the app quits or the module is turned off. Devices started by someone else are left running. The picker can also shut down any running device («Shut down {device}»).

<a id="sim-stream"></a>
### Frames and input

| | iOS: `sim-helper` | Android: `android.cjs` + scrcpy-server |
| --- | --- | --- |
| Process | A native Objective-C binary (`apps/desktop/native/sim-helper.m`) that `dlopen`s `SimulatorKit`/`CoreSimulator` from the active Xcode | A Node process on Electron's runtime (`ELECTRON_RUN_AS_NODE`). It pushes scrcpy-server v4.1 (bundled jar, Apache-2.0, hash checked at build) via `adb` and uses `adb forward`. |
| Frames | Framebuffer via `SimScreen` on `com.apple.framebuffer.display`, with the IOSurface cached until `surfacesChanged`. Encoded to H.264 by VideoToolbox in low-latency mode (`ReferenceBufferCount=1`, no reordering). | MediaCodec H.264. Annex-B is converted to AVCC, and the decoder config is built from SPS/PPS. |
| Input | XPC to `dtuhidd` (`com.apple.coredevice.feature.remote.hid.digitizer`): touches at 0..1 and keys as USB HID usages. Indigo HID is used for Xcode ≤ 26. | scrcpy control messages: touch, keys (HID usage → Android keycode), text (ASCII via INJECT_TEXT; other text, including Cyrillic, via SET_CLIPBOARD + paste), Home, Back, power |
| Tree / screenshot | `AXPTranslator` in the helper / JPEG | `uiautomator dump` in dp / `screencap` PNG |

- **Shared protocol**: frames on stdout as `[type u8][length u32 BE]`. Type 1 is a JSON event, 2 is the `VideoDecoder` config (avcC in base64), 3 is an AVCC frame with a key flag and capture time in µs. Commands go to stdin as JSON lines. Main treats both helpers the same way. It forwards frames to the renderer over a `MessagePort`, and the renderer decodes them with WebCodecs `VideoDecoder` onto a canvas. Frames flow only while at least one tab of the project is watching. Static screens produce no frames.
- **The person drives the device**: click and drag become touch and gesture, trackpad scroll becomes a swipe, and keys go to the device while the tab has focus. `⌘V` types the Mac clipboard into the device. On iOS, a device clipboard paste would hit a paste-permission prompt that a windowless simulator can't show. Main reads the Mac clipboard; the renderer never does.
- **Rotation** turns right, like `⌘→` in Simulator.app. On iOS this is `xcrun devicectl device orientation rotate right` followed by `get`: the frame stays portrait with the content turned, touches use portrait device coordinates, and the accessibility tree uses interface coordinates. On Android it is `adb emu rotate`, and the stream turns by itself. State carries `orientation`. The tab rotates the canvas by −90°/90°/180° and maps touches back through one shared core function (`devicePoint`), which the tab and `simulator_act` both use. If the app doesn't rotate (for example the iOS home screen), the interface stays portrait on a sideways device. Screenshots are always returned upright.

<a id="sim-tab"></a>
### Simulator tab

- **Strip 1**: device picker (platform glyph, `name · OS`, with iOS and Android groups, a running dot, ✓ on the chosen device, and **Shut down {device}** for running ones). On the right is the Metro chip: `Metro :8081`, with a tooltip giving app id · address · root. If Metro isn't found the chip reads **No Metro** in amber.
- **Strip 2**: **Home**, **Back** (Android only), **Rotate**, a divider, **Reload app** and **DevTools** (both need Metro; DevTools opens React Native DevTools through Metro `/open-debugger`), and **Screenshot to chat** on the right (a JPEG re-encoded to PNG for the chat).
- The screen sits inside a device frame on a tinted background and is scaled to fit the tab.
- **States**: «{device} is off» + **Start**; «{device} is starting…» with a spinner; running; missing toolchain; no simulators; landscape. Without Metro, a warning row reads «Metro is not running in this task», with **Commands…** (opens project commands in search, when that module is on).
- An agent tap is marked by an accent ring of about 600 ms with a label like `tap · <testID>`.
- No app console, network panel or DevTools of our own is built for the person. React Native DevTools covers these, in the same way the browser defers to Chromium DevTools.

**Simulator menu** (shortcuts act only while the simulator screen has focus, so elsewhere `⌘→` still moves to the end of the line):

| Item | Shortcut |
| --- | --- |
| Home | `⇧⌘H` |
| Rotate | `⌘→` |
| Reload app | `⌘R` |
| Screenshot to chat | `⌥⌘M` |
| React Native DevTools | — |
| Shut down simulator | — |

<a id="sim-tools"></a>
### Simulator MCP tools

These are served by the same `brigadir` server (`mcp__brigadir__simulator_*`). The tools work even when no simulator tab is open, because the device and stream live in main. `simulator_open` opens the tab in the agent's task.

| Tool | Does |
| --- | --- |
| `simulator_state` | The chosen device, platform, OS, running state, the app on screen, screen size in points, the Metro link (every Metro found, with its root and an «attached» mark), and the available devices |
| `simulator_open` | Boots the chosen or given `device` and waits until it runs. Optionally launches `app` (bundle id or package) or opens `url` (deep link). |
| `simulator_ui` | Accessibility tree, one element per line: role, label, `#testID`, frame in points. Paged with `offset`. `grid: true` adds a 32 pt hit-test sweep that finds children hidden by containers (iOS, slower). |
| `simulator_act` | One action: `tap`, `longpress`, `swipe` (to `x2,y2`) at `x,y` points or at an element by `id` (testID) or `label`; `type`; `key` (a KeyboardEvent code); `button` (`home`, `lock`, `back` on Android); `rotate` |
| `simulator_screenshot` | The latest frame of the stream the person sees, longer side ≤ 1000 px, returned as an `image` block (JPEG on iOS, PNG on Android) |
| `simulator_logs` | `source: js` (default): `console.*` and JS errors with stacks through Metro. `source: native`: the app process. Filtered by lowest `level` and `grep`. |
| `simulator_network` | App requests through Metro CDP `Network.*`: id, method, status, time, size, URL. `filter` by URL text. With `requestId`: headers and body. |

- Replies are bounded like the browser's: the newest 100 entries within 32 KiB, bodies ≤ 16 KiB of text, and binary bodies and images described by type and size.
- The tree is the first way to look at the screen, and a screenshot is only taken on request. The tree costs fewer tokens and gives exact `testID` targets.
- **No permission card**: the simulator is a developer sandbox running a debug build, and every action is visible in the tab. This is the difference from browser actions on non-local domains.

<a id="metro"></a>
### Metro and React Native data

- **Discovery**: main polls `/status` on ports 8081–8090 and 19000–19002. Each Metro's `X-React-Native-Project-Root` is matched first against the agent's task tree (worktree), then against the project roots.
- **Several Metros**: the project and each worktree can run their own. The client takes the Metro whose `/json/list` has a target for **this device** (`deviceName`). If several match, or none, the tree of the task whose agent last used the simulator wins, then the project root. When the app moves to another Metro, the old target disappears and the client searches again.
- **CDP client** runs in main, not the renderer. It connects over the WebSocket `/inspector/debug` with `Origin: http://127.0.0.1:<port>`, because Expo's Metro drops `localhost` origins. It enables `Runtime`, `Log` and `Network`. Ring buffers per target: 1000 log entries, 500 requests. Several debuggers can be attached at once, so React Native DevTools keeps working alongside it. Replayed old console entries after a reconnect are dropped by timestamp.
- **Observed RN/Expo behavior the client depends on**:
  - Exceptions and unhandled rejections arrive as `console.error` with an Error object (there is no `Runtime.exceptionThrown`). They are shown as level `error` with the stack.
  - There are two network sources. Expo's interceptor (fetch, XHR, images) sends events without needing `Network.enable`. RN's own domain covers XHR only. Duplicates are merged on method + URL + start time, preferring Expo's record. A request with no response after 30 s is shown as `no response`.
  - Text bodies up to 64 KiB are fetched right after `loadingFinished`. Larger ones are fetched on demand, and if Metro doesn't return them the reply says so.
- **Native logs**: on iOS, a steady `simctl spawn <udid> log stream --style compact` filtered to the app process (the executable comes from `simctl appinfo` for the Metro target's `appId`), kept in a 2000-line ring. It restarts when `appId` changes and stops with the device, the module or app quit. Until Metro names the app, `log show --last 2m` is used. On Android, `adb logcat -d --pid`.
- **Dev client launch**: `simctl launch <udid> <bundle> --initialUrl http://127.0.0.1:<port>`. The `exp+…://expo-development-client` deep link opens a system «Open in …?» dialog that someone has to confirm.

<a id="later"></a>
## Later

- Creating simulator devices from the app (`simctl create`, `avdmanager`).
- Physical Android devices in the picker.
- EventSource, WebSocket and stream pages shown in the person's Network drawer.
- Page-notification request strip on a remote device (the request stays `default` until answered on the working machine).
- A deep network mode for native (non-JS) app traffic.
- A CDP proxy for React Native below 0.85.
- React component tree and `eval` in the app (would need a separate permission model).

<a id="non-goals"></a>
## Non-goals

- Driving the person's own Chrome or Safari, or a separate headless browser for agents. Either way the person couldn't see what the agent sees.
- A homemade inspector (Elements, Sources, breakpoints, profiler). Chromium DevTools and React Native DevTools already cover this.
- Saving screenshots to disk: they go into the prompt and the task transcript.
- An agent filling passwords, one-time codes or payment cards, or uploading files.
- Web Push for pages in the task browser.
- Muting a tab from the agent, or muting a domain permanently.
- A «Build and run» button in the simulator: the agent or project commands build the app.
- Installing Xcode, the Android SDK or devices from the app.
- Embedding Simulator.app or Device Hub windows.
