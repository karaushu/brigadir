import { editorText } from './editor-text';
import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { showChat, hideChat, hideWorkArea, showWorkArea } from './layout';
const desktop = resolve('apps/desktop'),
	executablePath = createRequire(join(desktop, 'package.json'))('electron') as string;
const env = Object.fromEntries(
	Object.entries(process.env).filter(
		(e): e is [string, string] => typeof e[1] === 'string' && e[0] !== 'ELECTRON_RUN_AS_NODE'
	)
);
// A project on an empty repo with one finished task `title` (data in root/data); returns the task's folder.
const seedTask = async (root: string, title: string, transport: 'gui' | 'terminal') => {
	const repo = join(root, 'repo');
	await mkdir(repo);
	const taskDir = join(root, 'data/projects/project/tasks/task');
	await mkdir(taskDir, { recursive: true });
	await writeFile(
		join(taskDir, '../../project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'repo', path: repo } })
	);
	await writeFile(
		join(taskDir, 'task.json'),
		JSON.stringify({
			schemaVersion: 1,
			task: {
				id: 'task',
				projectId: 'project',
				title,
				status: 'done',
				provider: 'claude',
				transport,
			},
		})
	);
	return taskDir;
};
for (const transport of ['gui', 'terminal'] as const)
	test(`browser ${transport}: isolated view, CDP, MCP permissions and task parking @area:browser`, async ({}, info) => {
		const root = await mkdtemp(join(tmpdir(), 'brigadir-browser-ui-'));
		const taskDir = await seedTask(root, 'Browser fixture', transport);
		const server = createServer((req, res) => {
			if (req.url === '/redirect') {
				res.writeHead(302, {
					Location: `http://preview.test:${(server.address() as { port: number }).port}/`,
				});
				res.end();
				return;
			}
			res.setHeader('X-Fixture', 'visible-header');
			res.setHeader('Set-Cookie', 'PRIVATE_COOKIE=must-not-attach');
			res.setHeader('Content-Type', req.url === '/api' ? 'application/json' : 'text/html');
			res.end(
				req.url === '/api'
					? '{"ok":true}'
					: '<meta name="viewport" content="width=device-width,initial-scale=1"><title>Local preview</title><style>body{font:18px system-ui;padding:24px;background:#f3f6fa}button{padding:12px;border-radius:8px;background:#157aff;color:white;border:0}</style><h1>Browser fixture page</h1><input id="draft" placeholder="Keep this draft"><button id="test">Preview</button><script>console.log("BROWSER_LOG");fetch("/api");</script>'
			);
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
		let mcp: any;
		const launch = () =>
			electron.launch({
				executablePath,
				args: [
					desktop,
					`--user-data-dir=${join(root, 'profile')}`,
					'--host-resolver-rules=MAP preview.test 127.0.0.1',
					'--no-proxy-server',
				],
				env: { ...env, BRIGADIR_DATA_DIR: join(root, 'data') },
			});
		let app = await launch();
		const key = { projectId: 'project', id: 'task' };
		try {
			const page = await app.firstWindow();
			/* spec/composer#mentions: a GUI composer holds attachments as pills and thumbnails in the text; the CLI shelf keeps its tiles (spec/terminal-and-cli-agents#cli-context). */ const message =
					page.getByRole('textbox', { name: 'Message', exact: true }),
				dropToken = async () =>
					message.fill((await editorText(message)).replace(/@\[att:[0-9a-f-]{36}\] ?$/, '')),
				removeShown = async (name: string) => {
					if (transport === 'gui') await dropToken();
					else
						await page
							.getByLabel('Attachments', { exact: true })
							.getByRole('button', { name: `Remove attachment: ${name}`, exact: true })
							.click();
				};
			const errors: string[] = [];
			page.on('pageerror', (e) => errors.push(e.message));
			const viewItem = (label: string) =>
				app.evaluate(
					({ Menu }, label) =>
						Menu.getApplicationMenu()!
							.items.find((item) => item.label === 'View')!
							.submenu!.items.find((item) => item.label === label)!
							.click(),
					label
				);
			await app.evaluate(({ BrowserWindow }) =>
				BrowserWindow.getAllWindows()[0]!.setSize(1600, 950)
			);
			await page.getByRole('button', { name: /Browser fixture/ }).click();
			// spec/task-window-workspace#work-area: the browser is a tab of the work area; ⇧⌘B opens one when the task has none.
			await viewItem('Browser');
			const panel = page.getByRole('region', { name: 'Browser', exact: true });
			// spec/task-window-workspace#tool-tab-look: a tab without a page is «New page» with an empty address, not about:blank.
			await expect(page.getByRole('tab', { name: 'New page', exact: true })).toBeVisible();
			await expect(panel.getByRole('textbox', { name: 'Address' })).toHaveValue('');
			await panel.getByRole('textbox', { name: 'Address' }).fill(url);
			await panel.getByRole('textbox', { name: 'Address' }).press('Enter');
			await expect
				.poll(() =>
					page.evaluate((key) => window.brigadir.browserCommand(key, { kind: 'state' }), key)
				)
				.toMatchObject({ title: 'Local preview', loading: false });
			// The window remains non-focusable. Simulate only its WebContents focus report to test native menu routing.
			await app.evaluate(({ BrowserWindow }) => {
				const web = (
						BrowserWindow.getAllWindows()[0]!.contentView.children[0] as Electron.WebContentsView
					).webContents,
					original = web.isFocused;
				(globalThis as any).restoreBrowserFocus = () => {
					web.isFocused = original;
					web.emit('blur');
				};
				web.isFocused = () => true;
				web.emit('focus');
			});
			await expect
				.poll(() =>
					app.evaluate(({ Menu }) => ({
						browser: Menu.getApplicationMenu()!.getMenuItemById('browser-back')!.enabled,
						editor: Menu.getApplicationMenu()!.getMenuItemById('editor-outdent')!.enabled,
					}))
				)
				.toEqual({ browser: true, editor: false });
			await app.evaluate(() => (globalThis as any).restoreBrowserFocus());
			expect(
				await page.evaluate((key) => window.brigadir.browserCommand(key, { kind: 'read' }), key)
			).toMatchObject({
				title: 'Local preview',
				text: expect.stringContaining('Browser fixture page'),
			});
			expect(
				await app.evaluate(async ({ BrowserWindow }) => {
					const view = BrowserWindow.getAllWindows()[0]!.contentView
						.children[0] as Electron.WebContentsView;
					return view.webContents.executeJavaScript(
						'({require:typeof require,bridge:typeof window.brigadir})'
					);
				})
			).toEqual({ require: 'undefined', bridge: 'undefined' });
			await expect(
				page.evaluate(
					(key) => window.brigadir.browserCommand(key, { kind: 'open', url: 'file:///etc/passwd' }),
					key
				)
			).rejects.toThrow('Only HTTP');
			await panel.getByRole('button', { name: 'Page console', exact: true }).click();
			await expect(panel.getByRole('log', { name: 'Page console' })).toContainText('BROWSER_LOG');
			await panel.getByRole('button', { name: 'Network', exact: true }).click();
			await expect(panel.getByRole('log', { name: 'Network' })).toContainText('/api');
			await panel.getByRole('button', { name: 'Details', exact: true }).click();
			const details = page.getByRole('dialog', { name: 'Request details' });
			await expect(details).toContainText('visible-header');
			await expect(details).toContainText('"ok":true');
			await expect(details).not.toContainText('PRIVATE_COOKIE');
			for (const theme of ['light', 'dark'] as const) {
				await app.evaluate(({ nativeTheme }, theme) => {
					nativeTheme.themeSource = theme;
				}, theme);
				await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
				await details.screenshot({
					animations: 'disabled',
					path: info.outputPath(`request-details-${theme}.png`),
				});
			}
			await details.getByRole('button', { name: 'Show the agent', exact: true }).click();
			await removeShown('Request details');
			// The details dialog parks the native view while it is open; wait for it to come back before touching the page.
			await expect
				.poll(() =>
					app.evaluate(
						({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.contentView.children.length
					)
				)
				.toBe(1);
			await app.evaluate(async ({ BrowserWindow }) => {
				const view = BrowserWindow.getAllWindows()[0]!.contentView
					.children[0] as Electron.WebContentsView;
				await view.webContents.executeJavaScript(
					'document.querySelector("#draft").value="parked draft"'
				);
			});
			await panel.getByRole('button', { name: 'Network', exact: true }).click();
			await page.screenshot({ animations: 'disabled', path: info.outputPath('browser-light.png') });
			// spec/task-window-workspace#layout-switch: the work area hides with its tabs; the page parks and comes back with its draft.
			await hideWorkArea(page);
			await expect
				.poll(() =>
					app.evaluate(
						({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.contentView.children.length
					)
				)
				.toBe(0);
			await showWorkArea(page);
			await expect
				.poll(() =>
					app.evaluate(
						({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.contentView.children.length
					)
				)
				.toBe(1);
			expect(
				await app.evaluate(async ({ BrowserWindow }) =>
					(
						BrowserWindow.getAllWindows()[0]!.contentView.children[0] as Electron.WebContentsView
					).webContents.executeJavaScript('document.querySelector("#draft").value')
				)
			).toBe('parked draft');
			await panel.getByRole('radio', { name: 'Mobile', exact: true }).click();
			await expect
				.poll(() =>
					app.evaluate(async ({ BrowserWindow }) =>
						(
							BrowserWindow.getAllWindows()[0]!.contentView.children[0] as Electron.WebContentsView
						).webContents.executeJavaScript('innerWidth')
					)
				)
				.toBe(390);
			// spec/browser-and-simulator#browser, spec/task-window-workspace#tool-tab-look: the phone viewport stands in the middle of the tab, the margins either side equal.
			const area = (await panel.locator('[data-mobile]').boundingBox())!;
			const viewBounds = () =>
				app.evaluate(({ BrowserWindow }) =>
					BrowserWindow.getAllWindows()[0]!.contentView.children[0]!.getBounds()
				);
			await expect.poll(viewBounds).toMatchObject({ width: 390 });
			const view = await viewBounds();
			expect(Math.abs(view.x + view.width / 2 - (area.x + area.width / 2))).toBeLessThanOrEqual(2);
			await expect
				.poll(() =>
					page.evaluate((key) => window.brigadir.browserCommand(key, { kind: 'state' }), key)
				)
				.toMatchObject({ loading: false });
			await app.evaluate(({ Menu }) => {
				const pick = Menu.getApplicationMenu()!
					.items.find((item) => item.label === 'Browser')!
					.submenu!.items.find((item) => item.label === 'Select element')!;
				if (pick.accelerator !== 'CmdOrCtrl+Shift+C') throw new Error('Missing picker shortcut');
				pick.click();
			});
			await expect(
				panel.getByRole('button', { name: 'Select element', exact: true })
			).toHaveAttribute('aria-pressed', 'true');
			await expect
				.poll(() =>
					panel
						.getByRole('button', { name: 'Select element', exact: true })
						.evaluate((element) => getComputedStyle(element).color)
				)
				.toBe(
					await page.locator('html').evaluate((element) => {
						const probe = document.createElement('span');
						probe.style.color = 'var(--accent)';
						element.append(probe);
						const color = getComputedStyle(probe).color;
						probe.remove();
						return color;
					})
				);
			await app.evaluate(({ BrowserWindow }) => {
				const web = (
					BrowserWindow.getAllWindows()[0]!.contentView.children[0] as Electron.WebContentsView
				).webContents;
				const send = web.debugger.sendCommand.bind(web.debugger);
				(globalThis as any).highlights = [];
				(globalThis as any).outlines = [];
				web.debugger.sendCommand = (method, ...args) => {
					if (['Overlay.highlightNode', 'Overlay.hideHighlight'].includes(method))
						(globalThis as any).highlights.push(method);
					const border = (args[0] as any)?.highlightConfig?.borderColor;
					if (border) (globalThis as any).outlines.push(border);
					return send(method, ...args);
				};
			});
			// Drive Chromium's actual inspect-mode input path; do not synthesize its result event.
			await app.evaluate(async ({ BrowserWindow }) => {
				const web = (
					BrowserWindow.getAllWindows()[0]!.contentView.children[0] as Electron.WebContentsView
				).webContents;
				const { x, y } = await web.executeJavaScript(
					'(()=>{const r=document.querySelector("#test").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()'
				);
				web.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y) });
				web.sendInputEvent({
					type: 'mouseDown',
					x: Math.round(x),
					y: Math.round(y),
					button: 'left',
					clickCount: 1,
				});
				web.sendInputEvent({
					type: 'mouseUp',
					x: Math.round(x),
					y: Math.round(y),
					button: 'left',
					clickCount: 1,
				});
			});
			await expect
				.poll(async () => {
					const state = (await page.evaluate(
						(key) => window.brigadir.browserCommand(key, { kind: 'state' }),
						key
					)) as { picking: boolean; error: string | null };
					if (state.error) throw new Error(state.error);
					return state.picking;
				})
				.toBe(false);
			const nodeChips = page.getByLabel('Attachments', { exact: true });
			const nodeItem =
				transport === 'gui'
					? message.locator('[data-mention-pill]').filter({ hasText: 'Select element' })
					: nodeChips.getByRole('button', { name: 'Select element', exact: true });
			await nodeItem.click({ timeout: 5000 });
			const nodePreview = page.getByRole('dialog', { name: 'Select element', exact: true });
			await expect(nodePreview).toContainText('#test');
			await nodePreview.getByRole('button', { name: 'Close', exact: true }).click();
			await expect
				.poll(() => app.evaluate(() => (globalThis as any).highlights.at(-1)))
				.toBe('Overlay.highlightNode');
			// The inspector outline is the app's --accent (rule 4), not a colour of its own.
			const accent = await page.locator('html').evaluate((element) => {
				const probe = document.createElement('span');
				probe.style.color = 'var(--accent)';
				element.append(probe);
				const [r, g, b] = getComputedStyle(probe)
					.color.match(/[\d.]+/g)!
					.map(Number);
				probe.remove();
				return { r, g, b, a: 1 };
			});
			expect(await app.evaluate(() => (globalThis as any).outlines.at(-1))).toEqual(accent);
			await removeShown('Select element');
			await expect
				.poll(() => app.evaluate(() => (globalThis as any).highlights.at(-1)))
				.toBe('Overlay.hideHighlight');
			await panel.getByRole('button', { name: 'Select element', exact: true }).click();
			await app.evaluate(async ({ BrowserWindow }) => {
				const web = (
					BrowserWindow.getAllWindows()[0]!.contentView.children[0] as Electron.WebContentsView
				).webContents;
				await web.debugger.sendCommand('Overlay.setInspectMode', {
					mode: 'none',
					highlightConfig: {},
				});
				web.debugger.emit('message', {}, 'Overlay.inspectModeCanceled', {});
			});
			await expect(
				panel.getByRole('button', { name: 'Select element', exact: true })
			).toHaveAttribute('aria-pressed', 'false');
			await expect(page.getByLabel('Attachments', { exact: true })).toHaveCount(0);
			await app.evaluate(async ({ BrowserWindow }) => {
				const web = (
					BrowserWindow.getAllWindows()[0]!.contentView.children[0] as Electron.WebContentsView
				).webContents;
				await web.executeJavaScript(
					'(()=>{const n=document.createElement("div");n.id="clipped";n.style="position:fixed;left:-20px;top:10px;width:40px;height:30px;background:red";document.body.append(n);const hidden=n.cloneNode();hidden.id="outside";hidden.style.left="-200px";document.body.append(hidden);})()'
				);
			});
			const clipped = (await page.evaluate(
				(key) => window.brigadir.browserCommand(key, { kind: 'screenshot', selector: '#clipped' }),
				key
			)) as { image: string };
			expect(Buffer.from(clipped.image, 'base64').readUInt32BE(16)).toBe(20);
			await expect(
				page.evaluate(
					(key) =>
						window.brigadir.browserCommand(key, { kind: 'screenshot', selector: '#outside' }),
					key
				)
			).rejects.toThrow('not visible');
			// spec/task-window-workspace#work-area: while a column border moves, the page's picture stands in place of the native view.
			const chatHandle = page.getByRole('separator', { name: 'Resize chat' });
			const handleBounds = await chatHandle.boundingBox();
			await page.mouse.move(handleBounds!.x + 2, handleBounds!.y + 20);
			await page.mouse.down();
			await page.mouse.move(handleBounds!.x + 12, handleBounds!.y + 20);
			await expect
				.poll(() =>
					app.evaluate(
						({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.contentView.children.length
					)
				)
				.toBe(0);
			await expect(panel.locator('img[alt="Page snapshot"]')).toHaveAttribute(
				'src',
				/^data:image\/png/
			);
			await page.mouse.up();
			await expect
				.poll(() =>
					app.evaluate(
						({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.contentView.children.length
					)
				)
				.toBe(1);
			const capture = (await page.evaluate(
				(key) => window.brigadir.browserCommand(key, { kind: 'screenshot' }),
				key
			)) as { image: string };
			expect(Buffer.from(capture.image, 'base64').subarray(1, 4).toString()).toBe('PNG');
			await writeFile(
				info.outputPath('browser-viewport.png'),
				Buffer.from(capture.image, 'base64')
			);
			await expect(panel.getByRole('button', { name: 'Go', exact: true })).toHaveCount(0);
			await expect(panel.getByRole('button', { name: 'Web Inspector', exact: true })).toHaveCount(
				0
			);
			// spec/browser-and-simulator#browser-toolbar: DevTools live in the «…» menu of the actions strip; the shortcut and the menu item reach the same command.
			await app.evaluate(({ BrowserWindow }) => {
				const web = (
					BrowserWindow.getAllWindows()[0]!.contentView.children[0] as Electron.WebContentsView
				).webContents;
				(globalThis as any).devtoolsOpened = 0;
				(web as any).openDevTools = () => {
					(globalThis as any).devtoolsOpened++;
				};
			});
			await panel.getByRole('button', { name: 'More', exact: true }).click();
			const more = page.getByRole('menu', { name: 'More', exact: true });
			await expect(more.getByRole('menuitem', { name: /^DevTools/ })).toBeVisible();
			await expect(more.getByRole('menuitem', { name: /^Open in default browser/ })).toBeVisible();
			// The native page paints above the top layer: it steps aside while the menu is open, or the menu opens under it.
			const pageViews = () =>
				app.evaluate(
					({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.contentView.children.length
				);
			await expect.poll(pageViews).toBe(0);
			await more.getByRole('menuitem', { name: /^DevTools/ }).click();
			await expect.poll(() => app.evaluate(() => (globalThis as any).devtoolsOpened)).toBe(1);
			await expect(more).toHaveCount(0);
			await expect(panel.getByRole('button', { name: 'More', exact: true })).toBeFocused();
			await expect.poll(pageViews).toBe(1);
			await expect(page.locator('svg[data-glyph="review"]')).toHaveCount(0);
			await app.evaluate(({ shell }) => {
				(globalThis as any).openedExternal = [];
				(globalThis as any).restoreExternal = shell.openExternal;
				shell.openExternal = async (url) => {
					(globalThis as any).openedExternal.push(url);
				};
			});
			await panel.getByRole('button', { name: 'Open in default browser', exact: true }).click();
			expect(await app.evaluate(() => (globalThis as any).openedExternal)).toEqual([
				new URL(url).href,
			]);
			await app.evaluate(({ shell }) => {
				shell.openExternal = (globalThis as any).restoreExternal;
			});
			await panel.getByRole('button', { name: 'Screenshot to chat', exact: true }).click();
			const chips = page.getByLabel('Attachments', { exact: true }),
				shot =
					transport === 'gui'
						? message.locator('[data-mention-image][title="Screenshot"]')
						: chips.getByRole('button', { name: 'Screenshot', exact: true });
			await expect(shot).toBeVisible();
			await shot.click();
			const imagePreview = page.getByRole('dialog', { name: 'Screenshot', exact: true });
			await expect(imagePreview.getByRole('img')).toBeVisible();
			// spec/task-window-workspace#work-area: the page leaves its picture first (≈15 ms), then steps aside under the dialog.
			await expect
				.poll(() =>
					app.evaluate(
						({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.contentView.children.length
					)
				)
				.toBe(0);
			for (const theme of ['light', 'dark'] as const) {
				await app.evaluate(({ nativeTheme }, theme) => {
					nativeTheme.themeSource = theme;
				}, theme);
				await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
				await imagePreview.screenshot({
					animations: 'disabled',
					path: info.outputPath(`attachment-preview-${theme}.png`),
				});
			}
			await imagePreview.getByRole('button', { name: 'Close', exact: true }).click();
			if (transport === 'terminal')
				expect(
					(await page.evaluate((key) => window.brigadir.readSession(key), key)).pendingAttachments
				).toHaveLength(1);
			await removeShown('Screenshot');
			await expect(shot).toHaveCount(0);
			if (transport === 'terminal')
				expect(
					(await page.evaluate((key) => window.brigadir.readSession(key), key)).pendingAttachments
				).toEqual([]);
			await expect
				.poll(() =>
					app.evaluate(
						({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.contentView.children.length
					)
				)
				.toBe(1);
			await app.evaluate(({ nativeTheme }) => {
				nativeTheme.themeSource = 'dark';
			});
			await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
			await page.screenshot({ animations: 'disabled', path: info.outputPath('browser-dark.png') });
			expect(errors).toEqual([]);
			await page.evaluate((key) => window.brigadir.terminalCommand(key, { kind: 'list' }), key);
			await app.evaluate(async ({ BrowserWindow }) => {
				await (
					BrowserWindow.getAllWindows()[0]!.contentView.children[0] as Electron.WebContentsView
				).webContents.executeJavaScript('console.error("BROWSER_FAILURE")');
			});
			const failure = page.getByRole('status').filter({ hasText: 'BROWSER_FAILURE' });
			await expect(failure).toBeVisible();
			await expect(
				panel.getByRole('button', { name: 'Page console', exact: true })
			).toHaveAttribute('data-errors', 'true');
			await expect(panel.getByRole('button', { name: 'Page console', exact: true })).toContainText(
				'1'
			);
			await page.screenshot({
				animations: 'disabled',
				path: info.outputPath('browser-error-dark.png'),
			});
			await failure.getByRole('button', { name: 'Show the agent', exact: true }).click();
			await removeShown('Page console');
			await panel.getByRole('button', { name: 'Page console', exact: true }).click();
			await failure.getByRole('button', { name: 'Dismiss', exact: true }).click();
			await expect(failure).toHaveCount(0);
			await app.evaluate(async ({ BrowserWindow }) =>
				(
					BrowserWindow.getAllWindows()[0]!.contentView.children[0] as Electron.WebContentsView
				).webContents.executeJavaScript('document.querySelector("#draft").value="parked draft"')
			);
			await app.evaluate(({ Menu }) => {
				const item = Menu.getApplicationMenu()!
					.items.find((item) => item.label === 'Browser')!
					.submenu!.items.find((item) => item.label === 'Focus address')!;
				if (item.accelerator !== 'CmdOrCtrl+Shift+L') throw new Error('Missing address shortcut');
				item.click();
			});
			await expect(panel.getByRole('textbox', { name: 'Address' })).toBeFocused();
			await expect
				.poll(() =>
					app.evaluate(({ Menu }) => ({
						browser: Menu.getApplicationMenu()!.getMenuItemById('browser-back')!.enabled,
						editor: Menu.getApplicationMenu()!.getMenuItemById('editor-outdent')!.enabled,
					}))
				)
				.toEqual({ browser: false, editor: false });
			await app.evaluate(({ Menu }) =>
				Menu.getApplicationMenu()!
					.items.find((item) => item.label === 'Browser')!
					.submenu!.items.find((item) => item.label === 'Reload')!
					.click()
			);
			expect(
				await app.evaluate(async ({ BrowserWindow }) =>
					(
						BrowserWindow.getAllWindows()[0]!.contentView.children[0] as Electron.WebContentsView
					).webContents.executeJavaScript('document.querySelector("#draft").value')
				)
			).toBe('parked draft');
			const identity = JSON.parse(await readFile(join(taskDir, 'host.json'), 'utf8'));
			const requireMcp = createRequire(resolve('packages/transport/package.json'));
			const { Client } = requireMcp('@modelcontextprotocol/sdk/client/index.js');
			const { StdioClientTransport } = requireMcp('@modelcontextprotocol/sdk/client/stdio.js');
			mcp = new Client({ name: 'browser-fixture', version: '1.0.0' });
			await mcp.connect(
				new StdioClientTransport({
					command: resolve('apps/desktop/out/services/mcp-relay'),
					args: [],
					env: {
						...env,
						BRIGADIR_HOST_SOCKET: identity.socket,
						BRIGADIR_HOST_INSTANCE: identity.instance,
						BRIGADIR_PROJECT_ID: key.projectId,
						BRIGADIR_TASK_ID: key.id,
						BRIGADIR_MCP_TOKEN: identity.mcpToken,
					},
				})
			);
			const call = (name: string, args = {}) => mcp.callTool({ name, arguments: args });
			expect((await call('browser_read')).content[0].text).toContain('Browser fixture page');
			const requests = JSON.parse((await call('browser_network')).content[0].text);
			const api = requests.find((entry: any) => entry.request?.url.endsWith('/api'));
			expect(api.request).toMatchObject({ method: 'GET', status: 200, type: 'Fetch' });
			const response = JSON.parse(
				(await call('browser_network', { requestId: api.id })).content[0].text
			);
			expect(response.body).toBe('{"ok":true}');
			expect(response.headers['x-fixture']).toBe('visible-header');
			expect(JSON.stringify(response)).not.toContain('PRIVATE_COOKIE');
			expect((await call('browser_screenshot')).content[0]).toMatchObject({
				type: 'image',
				mimeType: 'image/png',
			});
			const blocked = await call('browser_open', { url: `${url}/redirect` });
			expect(blocked.isError).toBe(true);
			expect(blocked.content[0].text).toContain('needs permission');
			const external = `http://preview.test:${(server.address() as { port: number }).port}/`;
			if (transport === 'gui') await hideChat(page);
			const denied = call('browser_open', { url: external });
			await expect(page.getByRole('button', { name: 'Deny', exact: true })).toBeVisible();
			await page.getByRole('button', { name: 'Deny', exact: true }).click();
			expect((await denied).isError).toBe(true);
			const approved = call('browser_open', { url: external });
			await expect(
				page.getByRole('button', { name: 'Allow for domain', exact: true })
			).toBeVisible();
			await page.getByRole('button', { name: 'Allow for domain', exact: true }).click();
			expect((await approved).isError).not.toBe(true);
			expect(
				JSON.parse(await readFile(join(taskDir, '../../browser-domains.json'), 'utf8')).domains
			).toEqual(['preview.test']);
			expect((await call('browser_open', { url: `${url}/redirect` })).isError).not.toBe(true);
			// spec/browser-and-simulator#background, spec/task-window-workspace#work-area: with the work area hidden the agent's call runs on its tab off screen; the person's
			// layout stays, and the tab shows the same page when the work area comes back.
			await showChat(page);
			await hideWorkArea(page);
			await expect(panel).toHaveCount(0);
			const reopenedRead = await call('browser_read');
			expect(reopenedRead.isError).not.toBe(true);
			expect(reopenedRead.content[0].text).toContain('Browser fixture');
			await expect(panel).toHaveCount(0);
			await showWorkArea(page);
			await expect(panel).toBeVisible();
			if (transport === 'terminal') {
				await expect(page.locator('[data-review-footer]')).toHaveCount(0);
				await hideChat(page);
				await expect(page.locator('[data-review-footer]')).toHaveCount(0);
				await page.evaluate((key) => window.brigadir.addReviewNote(key, 'CLI review fixture'), key);
				await expect(page.locator('[data-review-footer]')).toBeVisible();
				await page.getByRole('button', { name: 'Attach review', exact: true }).click();
				await expect(
					page.getByRole('status').filter({ hasText: 'Review attached to your next CLI prompt.' })
				).toBeVisible();
				expect(
					(await page.evaluate((key) => window.brigadir.readReview(key, null), key)).notes?.[0]
						?.sent
				).toBe(false);
				await page.getByRole('button', { name: 'Remove queued review', exact: true }).click();
				await expect(
					page.getByRole('button', { name: 'Remove queued review', exact: true })
				).toHaveCount(0);
				expect(
					(await page.evaluate((key) => window.brigadir.readSession(key), key)).pendingReview
				).toBeUndefined();
				await page
					.getByRole('textbox', { name: 'General note', exact: true })
					.fill('Keep CLI review draft');
				await showChat(page);
				await hideWorkArea(page);
				// spec/task-window-workspace#empty-work-area: without the work area the review stands under the chat (spec/diff-and-review#footer).
				await expect(page.locator('[data-task-chat] [data-review-footer]')).toHaveCount(1);
				await showWorkArea(page);
				await expect(page.getByRole('textbox', { name: 'General note', exact: true })).toHaveValue(
					'Keep CLI review draft'
				);
				await showChat(page);
			}
			await mcp.close();
			mcp = null;
			await page.evaluate((key) => window.brigadir.sendCommand(key, { kind: 'shutdown' }), key);
			// Electron's renderer pageerror does not observe main-process exceptions.
			// Capture them explicitly and close the real window with its browser attached.
			await app.evaluate(() => {
				(globalThis as any).closeErrors = [];
				process.on('uncaughtException', (error) =>
					(globalThis as any).closeErrors.push(String(error))
				);
			});
			await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
			await expect
				.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length))
				.toBe(0);
			expect(await app.evaluate(() => (globalThis as any).closeErrors)).toEqual([]);
			await app.evaluate(({ app }) => {
				app.emit('activate');
			});
			const reopened = await app.firstWindow();
			await reopened.getByRole('button', { name: /Browser fixture/ }).click();
			await viewItem('Browser');
			await expect
				.poll(() =>
					app.evaluate(
						({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.contentView.children.length
					)
				)
				.toBe(1);
			if (transport === 'terminal')
				await reopened.evaluate(
					(key) => window.brigadir.terminalCommand(key, { kind: 'list' }),
					key
				);
			await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.destroy());
			expect(await app.evaluate(() => (globalThis as any).closeErrors)).toEqual([]);
			// spec/task-window-workspace#restore-window: the mode is the tab's own, kept in surface.json; no app-wide file.
			await expect(readFile(join(root, 'data/browser-preferences.json'), 'utf8')).rejects.toThrow();
			await app.close();
			// The person's tab went Mobile; the agent's own tab (preview.test) was never switched and stays Desktop.
			const kept = (
				JSON.parse(await readFile(join(taskDir, 'surface.json'), 'utf8')).surface.groups.root
					.tabs as { kind: string; tab: string; url: string; mobile: boolean }[]
			).filter((tab) => tab.kind === 'browser');
			const own = kept.find((tab) => tab.url.startsWith(url))!,
				agents = kept.find((tab) => tab.url.startsWith('http://preview.test'))!;
			expect([own.mobile, agents.mobile]).toEqual([true, false]);
			app = await launch();
			const restored = await app.firstWindow();
			await restored.getByRole('button', { name: /Browser fixture/ }).click();
			await viewItem('Browser');
			const stateOf = (tab: string) =>
				restored.evaluate(
					({ key, tab }) => window.brigadir.browserCommand(key, { kind: 'state', tab }),
					{ key, tab }
				);
			// Each tab comes back in its own mode.
			await expect.poll(() => stateOf(agents.tab)).toMatchObject({ mobile: false });
			await expect.poll(() => stateOf(own.tab)).toMatchObject({ mobile: true });
			// An old app-wide file of another schemaVersion is neither read nor rewritten by a change of mode.
			const preferencePath = join(root, 'data/browser-preferences.json'),
				futurePreference = JSON.stringify({ schemaVersion: 99, mobile: true });
			await writeFile(preferencePath, futurePreference);
			await restored.evaluate(
				({ key, tab }) => window.brigadir.browserCommand(key, { kind: 'mode', mobile: false, tab }),
				{ key, tab: own.tab }
			);
			await expect.poll(() => stateOf(own.tab)).toMatchObject({ mobile: false });
			expect(await readFile(preferencePath, 'utf8')).toBe(futurePreference);
		} finally {
			await mcp?.close();
			try {
				const remaining = app.windows()[0];
				if (remaining)
					await remaining.evaluate(
						(key) => window.brigadir.sendCommand(key, { kind: 'shutdown' }),
						key
					);
			} catch {}
			await app.close();
			await expect
				.poll(async () => {
					try {
						await readFile(join(taskDir, 'host.lock'));
						return true;
					} catch {
						return false;
					}
				})
				.toBe(false);
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(root, { recursive: true, force: true });
		}
	});

type Row = {
	id: string;
	text: string;
	request: {
		url: string;
		type: string;
		state: string;
		status: number | null;
		elapsed?: number;
		received?: number;
		messages?: number;
	};
};
// spec/browser-and-simulator#network-streams: a page holding an event stream, a WebSocket and an event stream read by fetch; browser_network sees all three open.
test('browser streams: open EventSource, WebSocket and fetch stream with their messages, a page that is a stream @area:browser', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-browser-streams-'));
	await seedTask(root, 'Stream fixture', 'gui');
	const timers: ReturnType<typeof setInterval>[] = [],
		sockets: import('node:stream').Duplex[] = [];
	const stream = (res: import('node:http').ServerResponse) => {
		res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
		res.write(': ping\n\n');
		let n = 0;
		timers.push(
			setInterval(() => {
				n++;
				res.write(n % 2 ? ': ping\n\n' : `event: update\nid: ${n}\ndata: {"n":${n}}\n\n`);
			}, 150)
		);
	};
	const server = createServer((req, res) => {
		if (req.url === '/events' || req.url === '/fetch-stream') {
			stream(res);
			return;
		}
		res.setHeader('Content-Type', 'text/html');
		res.end(
			'<title>Streams</title><h1>Streams</h1><script>new EventSource("/events");const ws=new WebSocket(`ws://${location.host}/live`);ws.onopen=()=>ws.send("hi");fetch("/fetch-stream").then(r=>{const reader=r.body.getReader();const pump=()=>reader.read().then(({done})=>{if(!done)pump();});pump();});</script>'
		);
	});
	server.on('upgrade', (req, socket) => {
		sockets.push(socket);
		const accept = createHash('sha1')
			.update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
			.digest('base64');
		socket.write(
			`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
		);
		socket.write(Buffer.concat([Buffer.from([0x81, 5]), Buffer.from('hello')]));
		socket.on('data', () => {});
		socket.on('error', () => {});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	const app = await electron.launch({
		executablePath,
		args: [desktop, `--user-data-dir=${join(root, 'profile')}`, '--no-proxy-server'],
		env: { ...env, BRIGADIR_DATA_DIR: join(root, 'data') },
	});
	const key = { projectId: 'project', id: 'task' };
	try {
		const page = await app.firstWindow();
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1600, 950));
		await page.getByRole('button', { name: /Stream fixture/ }).click();
		// spec/task-window-workspace#work-area: ⇧⌘B opens a browser tab in the work area.
		await app.evaluate(({ Menu }) =>
			Menu.getApplicationMenu()!
				.items.find((item) => item.label === 'View')!
				.submenu!.items.find((item) => item.label === 'Browser')!
				.click()
		);
		const panel = page.getByRole('region', { name: 'Browser', exact: true });
		await panel.getByRole('textbox', { name: 'Address' }).fill(url);
		await panel.getByRole('textbox', { name: 'Address' }).press('Enter');
		await expect
			.poll(() =>
				page.evaluate((key) => window.brigadir.browserCommand(key, { kind: 'state' }), key)
			)
			.toMatchObject({ title: 'Streams' });
		const network = () =>
			page.evaluate(
				(key) => window.brigadir.browserCommand(key, { kind: 'network' }),
				key
			) as Promise<Row[]>;
		const find = (rows: Row[], path: string) =>
			rows.find((row) => new URL(row.request.url).pathname === path);
		await expect
			.poll(
				async () => {
					const rows = await network();
					return [
						find(rows, '/events')?.request.messages ?? 0,
						find(rows, '/live')?.request.messages ?? 0,
						find(rows, '/fetch-stream')?.request.messages ?? 0,
					].every((count) => count >= 2);
				},
				{ timeout: 10_000 }
			)
			.toBe(true);
		const rows = await network();
		expect(find(rows, '/events')!.request).toMatchObject({
			type: 'EventSource',
			status: 200,
			state: 'streaming',
		});
		expect(find(rows, '/events')!.request.elapsed).toBeGreaterThan(0);
		expect(find(rows, '/events')!.request.received).toBeGreaterThan(0);
		expect(find(rows, '/events')!.text).toMatch(
			/EventSource · streaming [0-9.]+ s · [0-9]+ B received · last data/
		);
		expect(find(rows, '/live')!.request).toMatchObject({
			type: 'WebSocket',
			status: 101,
			state: 'streaming',
		});
		expect(find(rows, '/fetch-stream')!.request).toMatchObject({
			type: 'Fetch',
			state: 'streaming',
		});
		const details = (id: string) =>
			page.evaluate(
				([key, id]) => window.brigadir.browserCommand(key, { kind: 'network', requestId: id }),
				[key, id] as const
			) as Promise<{
				messages: { direction: string; event?: string; id?: string; data: string }[];
				messageCount: number;
			}>;
		const events = await details(find(rows, '/events')!.id);
		expect(events.messages[0]).toMatchObject({
			direction: 'in',
			event: 'update',
			id: '2',
			data: '{"n":2}',
		});
		expect(events.messages.every((message) => !message.data.includes('ping'))).toBe(true);
		expect(
			(await details(find(rows, '/live')!.id)).messages
				.slice(0, 2)
				.map(({ direction, data }) => [direction, data])
				.sort()
		).toEqual([
			['in', 'hello'],
			['out', 'hi'],
		]);
		expect((await details(find(rows, '/fetch-stream')!.id)).messages[0]).toMatchObject({
			event: 'update',
			id: '2',
			data: '{"n":2}',
		});
		// The drawer keeps Fetch and XHR rows (spec/browser-and-simulator#console-network): streams of the page reach only the agent until the drawer has a design for them.
		await panel.getByRole('button', { name: 'Network', exact: true }).click();
		const drawer = panel.getByRole('log', { name: 'Network' });
		await expect(drawer).toContainText('/fetch-stream');
		await expect(drawer).not.toContainText('/events');
		await expect(drawer).not.toContainText('/live');
		// Opening the stream itself answers once its headers arrive instead of waiting for the end of the stream.
		const started = Date.now();
		const opened = (await page.evaluate(
			([key, url]) => window.brigadir.browserCommand(key, { kind: 'open', url }),
			[key, `${url}/events`] as const
		)) as { note?: string; loading: boolean };
		expect(Date.now() - started).toBeLessThan(5000);
		expect(opened.note).toContain('event stream');
		await expect
			.poll(
				async () => {
					const row = find(await network(), '/events');
					return row?.request.type === 'Document' && (row.request.messages ?? 0) >= 1;
				},
				{ timeout: 10_000 }
			)
			.toBe(true);
	} finally {
		for (const timer of timers) clearInterval(timer);
		for (const socket of sockets) socket.destroy();
		server.closeAllConnections();
		await app.close();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(root, { recursive: true, force: true });
	}
});
