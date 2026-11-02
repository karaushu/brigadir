import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { hideChat, showWorkArea } from './layout';
const desktop = resolve('apps/desktop'),
	executablePath = createRequire(join(desktop, 'package.json'))('electron') as string;
/** A page with what opens native windows: dialogs, a <select>, a color and a file input; and a «Copy» button. */
const fixture = `<title>Background fixture</title>
<style>body{font:16px system-ui;padding:24px}</style>
<h1>Background fixture</h1>
<label>Name <input id="name"></label> <button id="save">Save</button> <output id="out"></output>
<button id="alert">Alert</button> <button id="confirm">Confirm</button> <output id="answer"></output>
<button id="copy">Copy</button>
<label>Language <select id="lang"><option value="uk">Українська</option><option value="en">English</option></select></label>
<label>Color <input id="color" type="color"></label>
<label>File <input id="file" type="file"></label>
<script>
window.loads=(window.loads||0)+1;window.hasFocusAtClick=null;
document.querySelector('#save').addEventListener('click',()=>{hasFocusAtClick=document.hasFocus();out.textContent='Saved '+document.querySelector('#name').value;});
document.querySelector('#alert').addEventListener('click',()=>{alert('Hello from the page');window.afterAlert=1;});
document.querySelector('#confirm').addEventListener('click',()=>{answer.textContent=confirm('Delete the draft?')?'confirmed':'kept';});
document.querySelector('#copy').addEventListener('click',()=>{navigator.clipboard.writeText('copied by the page').then(()=>{window.copied='ok';},e=>{window.copied=e.name;});});
</script>`;
const writeTask = async (root: string, id: string, title: string) => {
	const dir = join(root, `data/projects/project/tasks/${id}`);
	await mkdir(dir, { recursive: true });
	await writeFile(
		join(dir, 'task.json'),
		JSON.stringify({
			schemaVersion: 1,
			task: {
				id,
				projectId: 'project',
				title,
				status: 'done',
				provider: 'claude',
				transport: 'gui',
			},
		})
	);
	return dir;
};
test('spec/browser-and-simulator#background the agent works with the browser of a task that is not on screen @area:browser', async ({}, info) => {
	test.setTimeout(120_000);
	const root = await mkdtemp(join(tmpdir(), 'brigadir-browser-background-')),
		repo = join(root, 'repo');
	await mkdir(repo);
	await mkdir(join(root, 'data/projects/project'), { recursive: true });
	await writeFile(
		join(root, 'data/projects/project/project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'repo', path: repo } })
	);
	await writeTask(root, 'front', 'Front task');
	const backDir = await writeTask(root, 'back', 'Background agent');
	const server = createServer((_req, res) => {
		res.setHeader('Content-Type', 'text/html; charset=utf-8');
		res.end(fixture);
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const port = (server.address() as { port: number }).port,
		url = `http://127.0.0.1:${port}/`;
	const env = Object.fromEntries(
		Object.entries(process.env).filter(
			(e): e is [string, string] => typeof e[1] === 'string' && e[0] !== 'ELECTRON_RUN_AS_NODE'
		)
	);
	const app = await electron.launch({
		executablePath,
		args: [
			desktop,
			`--user-data-dir=${join(root, 'profile')}`,
			'--host-resolver-rules=MAP preview.test 127.0.0.1',
			'--no-proxy-server',
		],
		env: {
			...env,
			BRIGADIR_DATA_DIR: join(root, 'data'),
			BRIGADIR_TEST_BROWSER_FREEZE_MS: '5000',
		},
	});
	let mcp: any;
	/** The page of the background task, wherever its view is: in the invisible window or in the column. */
	const inPage = (script: string) =>
		app.evaluate(
			async ({ webContents }, { script, url }) =>
				webContents
					.getAllWebContents()
					.find((web) => web.getURL().startsWith(url))!
					.executeJavaScript(script),
			{ script, url }
		);
	/** The invisible window: the window that is not the main one. */
	const parked = () =>
		app.evaluate(({ BaseWindow, BrowserWindow, screen }) => {
			const main = BrowserWindow.getAllWindows()[0]!,
				park = BaseWindow.getAllWindows().find((window) => window.id !== main.id);
			if (!park) return null;
			const display = screen.getDisplayMatching(main.getBounds());
			return {
				focusable: park.isFocusable(),
				focused: park.isFocused(),
				opacity: park.getOpacity(),
				onTop: park.isAlwaysOnTop(),
				sameDisplay: screen.getDisplayMatching(park.getBounds()).id === display.id,
				scale: display.scaleFactor,
				width: park.getContentBounds().width,
				views: park.contentView.children.length,
			};
		});
	const focus = () =>
		app.evaluate(({ BrowserWindow, webContents }) => ({
			window: BrowserWindow.getFocusedWindow()?.id ?? null,
			contents: webContents.getFocusedWebContents()?.id ?? null,
		}));
	try {
		const page = await app.firstWindow();
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1600, 950));
		const front = page.getByRole('button', { name: /Front task/ }),
			back = page.getByRole('button', { name: /Background agent/ });
		await front.click();
		await expect(front).toHaveAttribute('aria-pressed', 'true');
		// The host of the background task starts on the first command to it.
		await page.evaluate(() =>
			window.brigadir.terminalCommand({ projectId: 'project', id: 'back' }, { kind: 'list' })
		);
		await expect
			.poll(async () => {
				try {
					await readFile(join(backDir, 'host.json'));
					return true;
				} catch {
					return false;
				}
			})
			.toBe(true);
		const host = JSON.parse(await readFile(join(backDir, 'host.json'), 'utf8')),
			requireMcp = createRequire(resolve('packages/transport/package.json'));
		const { Client } = requireMcp('@modelcontextprotocol/sdk/client/index.js');
		const { StdioClientTransport } = requireMcp('@modelcontextprotocol/sdk/client/stdio.js');
		mcp = new Client({ name: 'browser-background-fixture', version: '1.0.0' });
		await mcp.connect(
			new StdioClientTransport({
				command: resolve('apps/desktop/out/services/mcp-relay'),
				args: [],
				env: {
					...env,
					BRIGADIR_HOST_SOCKET: host.socket,
					BRIGADIR_HOST_INSTANCE: host.instance,
					BRIGADIR_PROJECT_ID: 'project',
					BRIGADIR_TASK_ID: 'back',
					BRIGADIR_MCP_TOKEN: host.mcpToken,
				},
			})
		);
		const call = async (name: string, args: Record<string, unknown> = {}) => {
			const result = await mcp.callTool({ name, arguments: args });
			return {
				error: result.isError === true,
				text: String(result.content[0]?.text ?? ''),
				type: String(result.content[0]?.type ?? ''),
			};
		};
		const before = await focus();
		// The task is not on screen; the page opens in the invisible window and the tools work.
		const opened = await call('browser_open', { url });
		expect(opened.error, opened.text).toBe(false);
		expect(await parked()).toMatchObject({
			focusable: false,
			focused: false,
			opacity: 0,
			onTop: true,
			sameDisplay: true,
			views: 1,
		});
		const tree = await call('browser_ui');
		expect(tree.error, tree.text).toBe(false);
		expect(tree.text).toMatch(/textbox "Name" @e\d+/);
		const typed = await call('browser_act', { action: 'type', label: 'Name', text: 'Ada' });
		expect(typed.error, typed.text).toBe(false);
		const started = Date.now(),
			clicked = await call('browser_act', { action: 'click', label: 'Save' });
		expect(clicked.error, clicked.text).toBe(false);
		// A click in the hidden page does not wait for a frame (5 s when a view is detached).
		expect(Date.now() - started).toBeLessThan(3000);
		expect(await inPage('document.querySelector("#out").textContent')).toBe('Saved Ada');
		// The page treats itself as focused.
		expect(await inPage('hasFocusAtClick')).toBe(true);
		const shot = await call('browser_screenshot');
		expect(shot.error).toBe(false);
		expect(shot.type).toBe('image');
		// The capture has the scale of the main window's display.
		const capture = await app.evaluate(async ({ webContents }, url) => {
			const image = await webContents
				.getAllWebContents()
				.find((web) => web.getURL().startsWith(url))!
				.capturePage();
			return image.getSize().width;
		}, url);
		const park = (await parked())!;
		expect(capture).toBe(Math.round(park.width * park.scale));
		// The person's selection and focus did not move.
		await expect(front).toHaveAttribute('aria-pressed', 'true');
		await expect(back).toHaveAttribute('aria-pressed', 'false');
		expect(await focus()).toEqual(before);
		// The card of the background task marks its live page.
		await expect(page.locator('[data-sidebar-task="back"] [data-browser-live]')).toBeVisible();
		await page
			.locator('[data-sidebar-task="back"]')
			.screenshot({ animations: 'disabled', path: info.outputPath('sidebar-live.png') });
		// An alert closes at once and the reply says what it asked; the page goes on.
		const alerted = await call('browser_act', { action: 'click', label: 'Alert' });
		expect(alerted.error, alerted.text).toBe(false);
		expect(alerted.text).toContain(
			'The page showed an alert "Hello from the page"; it was closed.'
		);
		expect(await inPage('window.afterAlert')).toBe(1);
		const kept = await call('browser_act', { action: 'click', label: 'Confirm' });
		expect(kept.text).toContain('(confirm); answered Cancel.');
		expect(await inPage('document.querySelector("#answer").textContent')).toBe('kept');
		expect((await call('browser_act', { action: 'dialog', accept: true })).text).toContain(
			'gets OK'
		);
		const confirmed = await call('browser_act', { action: 'click', label: 'Confirm' });
		expect(confirmed.text).toContain('answered OK.');
		expect(await inPage('document.querySelector("#answer").textContent')).toBe('confirmed');
		// A <select> and a color input in a hidden page are not clicked; the answer says what to use.
		const select = await call('browser_act', { action: 'click', label: 'Language' });
		expect(select).toMatchObject({ error: true });
		expect(select.text).toContain('Use browser_act select');
		expect(
			(await call('browser_act', { action: 'select', label: 'Language', value: 'English' })).error
		).toBe(false);
		const color = await call('browser_act', { action: 'click', selector: '#color' });
		expect(color.text).toContain('Use browser_act type with a color');
		expect(
			(await call('browser_act', { action: 'type', selector: '#color', text: '#3366ff' })).text
		).toContain('Set the color #3366ff');
		// The file chooser is intercepted.
		const file = await call('browser_act', { action: 'click', selector: '#file' });
		expect(file.error, file.text).toBe(false);
		expect(file.text).toContain('uploading files is not supported');
		// The page copies to the task clipboard; paste puts text into the focused field.
		const copied = await call('browser_act', { action: 'click', label: 'Copy' });
		expect(copied.text).toContain('The page copied to the task clipboard: "copied by the page".');
		expect(await inPage('window.copied')).toBe('ok');
		expect((await call('browser_act', { action: 'clipboard' })).text).toBe(
			'The task clipboard holds "copied by the page".'
		);
		await inPage('document.querySelector("#name").value=""');
		const pasted = await call('browser_act', { action: 'paste', label: 'Name', text: ' pasted' });
		expect(pasted.error, pasted.text).toBe(false);
		expect(await inPage('document.querySelector("#name").value')).toBe(' pasted');
		await inPage('document.querySelector("#name").value="Ada"');
		const origin = await inPage('performance.timeOrigin');
		// After the freeze interval the view freezes and leaves its window; the next call works again.
		await expect.poll(parked, { timeout: 15_000 }).toBeNull();
		await expect(page.locator('[data-sidebar-task="back"] [data-browser-live]')).toHaveCount(0);
		const thawed = await call('browser_ui');
		expect(thawed.error, thawed.text).toBe(false);
		expect(thawed.text).toMatch(/textbox "Name" = "Ada"/);
		expect(await parked()).toMatchObject({ views: 1 });
		// The person opens the task: the same page, in the same state, without a reload. The agent's tab did not
		// show the hidden work area (spec/task-window-workspace#empty-work-area): its switch counts the tab, and the person turns it on.
		await back.click();
		await expect(page.locator('[data-switch="work"] [data-layout-count]')).toHaveText('1');
		await showWorkArea(page);
		await expect
			.poll(() =>
				app.evaluate(
					({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.contentView.children.length
				)
			)
			.toBe(1);
		await expect.poll(parked).toBeNull();
		expect(await inPage('performance.timeOrigin')).toBe(origin);
		expect(await inPage('document.querySelector("#name").value')).toBe('Ada');
		expect(await inPage('window.loads')).toBe(1);
		// spec/task-window-workspace#work-area: the visible page while the agent works with it: the agent bar and the accent frame.
		await expect(page.locator('[data-agent-bar]')).toBeVisible();
		await expect(page.locator('[data-agent-frame]')).toBeVisible();
		await page.screenshot({
			animations: 'disabled',
			path: info.outputPath('agent-in-browser.png'),
		});
		// Another domain — `Act on` has four options, and `Allow once` lets one action through.
		await hideChat(page);
		const external = `http://preview.test:${port}/`,
			openExternal = call('browser_open', { url: external });
		await page.getByRole('button', { name: 'Allow for domain', exact: true }).click();
		expect((await openExternal).error).toBe(false);
		const once = call('browser_act', { action: 'click', label: 'Save' });
		const card = page.locator('[data-permission-id]').filter({ hasText: 'Act on preview.test' });
		await expect(card).toBeVisible();
		expect(await card.getByRole('button').allTextContents()).toEqual([
			'Allow once',
			'Allow in this task',
			'Allow for domain',
			'Deny',
		]);
		await card.screenshot({ animations: 'disabled', path: info.outputPath('act-on-card.png') });
		await card.getByRole('button', { name: 'Allow once', exact: true }).click();
		expect((await once).error).toBe(false);
		const again = call('browser_act', { action: 'click', label: 'Save' });
		await expect(card).toBeVisible();
		await card.getByRole('button', { name: 'Deny', exact: true }).click();
		expect(await again).toMatchObject({
			error: true,
			text: expect.stringContaining('did not allow'),
		});
		// `browser_show` asks the person; «Show» opens the task with its browser.
		await front.click();
		await expect(front).toHaveAttribute('aria-pressed', 'true');
		const shown = call('browser_show');
		await expect(back).toHaveAttribute('data-status', 'needs-you');
		await back.click();
		const request = page
			.locator('[data-permission-id]')
			.filter({ hasText: 'The agent needs the page on screen' });
		await expect(request).toBeVisible();
		expect(await request.getByRole('button').allTextContents()).toEqual(['Show', 'Decline']);
		await request.screenshot({ animations: 'disabled', path: info.outputPath('show-request.png') });
		await request.getByRole('button', { name: 'Show', exact: true }).click();
		expect(await shown).toMatchObject({
			error: false,
			text: expect.stringContaining('The page is on screen'),
		});
	} finally {
		await mcp?.close();
		try {
			await app
				.windows()[0]
				?.evaluate(() =>
					window.brigadir.sendCommand({ projectId: 'project', id: 'back' }, { kind: 'shutdown' })
				);
		} catch {}
		await app.close();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(root, { recursive: true, force: true });
	}
});
