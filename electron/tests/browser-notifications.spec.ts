import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { showWorkArea } from './layout';
const desktop = resolve('apps/desktop'),
	executablePath = createRequire(join(desktop, 'package.json'))('electron') as string;
/** A page that asks for notifications on load, as the Choice terminal does, and can play a tone. */
const fixture = `<title>Notify fixture</title>
<h1>Notify fixture</h1>
<script>
window.asked = Notification.requestPermission();
window.tone = () => { const audio = new AudioContext(), osc = audio.createOscillator(), gain = audio.createGain();
  gain.gain.value = 0.05; osc.connect(gain).connect(audio.destination); osc.start(); window.audio = audio; };
</script>`;
test('spec/browser-and-simulator#notifications: the page asks in the strip, the person allows, the agent decides too and hears its notification; a playing tab mutes @area:browser', async ({}, info) => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-browser-notifications-')),
		repo = join(root, 'repo');
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
				title: 'Notify fixture',
				status: 'done',
				provider: 'claude',
				transport: 'gui',
			},
		})
	);
	const server = createServer((_req, res) => {
		res.setHeader('Content-Type', 'text/html; charset=utf-8');
		res.end(fixture);
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
	const env = Object.fromEntries(
		Object.entries(process.env).filter(
			(e): e is [string, string] => typeof e[1] === 'string' && e[0] !== 'ELECTRON_RUN_AS_NODE'
		)
	);
	const app = await electron.launch({
		executablePath,
		args: [desktop, `--user-data-dir=${join(root, 'profile')}`, '--no-proxy-server'],
		// The OS notices go to the test log, not to this Mac's Notification Center.
		env: { ...env, BRIGADIR_DATA_DIR: join(root, 'data'), BRIGADIR_TEST_NOTIFICATIONS: '1' },
	});
	let mcp: any;
	const inPage = (script: string) =>
		app.evaluate(
			async ({ BrowserWindow }, script) =>
				(
					BrowserWindow.getAllWindows()[0]!.contentView.children[0] as Electron.WebContentsView
				).webContents.executeJavaScript(script),
			script
		);
	try {
		const page = await app.firstWindow();
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1600, 950));
		await page.getByRole('button', { name: /Notify fixture/ }).click();
		await page.evaluate(() =>
			window.brigadir.terminalCommand({ projectId: 'project', id: 'task' }, { kind: 'list' })
		);
		await expect
			.poll(async () => {
				try {
					await readFile(join(taskDir, 'host.json'));
					return true;
				} catch {
					return false;
				}
			})
			.toBe(true);
		const host = JSON.parse(await readFile(join(taskDir, 'host.json'), 'utf8')),
			requireMcp = createRequire(resolve('packages/transport/package.json'));
		const { Client } = requireMcp('@modelcontextprotocol/sdk/client/index.js');
		const { StdioClientTransport } = requireMcp('@modelcontextprotocol/sdk/client/stdio.js');
		mcp = new Client({ name: 'browser-notifications-fixture', version: '1.0.0' });
		await mcp.connect(
			new StdioClientTransport({
				command: resolve('apps/desktop/out/services/mcp-relay'),
				args: [],
				env: {
					...env,
					BRIGADIR_HOST_SOCKET: host.socket,
					BRIGADIR_HOST_INSTANCE: host.instance,
					BRIGADIR_PROJECT_ID: 'project',
					BRIGADIR_TASK_ID: 'task',
					BRIGADIR_MCP_TOKEN: host.mcpToken,
				},
			})
		);
		const call = async (name: string, args: Record<string, unknown> = {}) => {
			const result = await mcp.callTool({ name, arguments: args });
			return String(result.content[0]?.text ?? '');
		};
		// The page asks on load, while the agent's call still runs: its reply carries the sentence.
		const opened = (await call('browser_open', { url })) + (await call('browser_ui'));
		await showWorkArea(page);
		// The page asked on load: the strip over it names the domain; the agent only hears about it.
		const strip = page.locator('[data-page-ask]');
		await expect(strip).toContainText('127.0.0.1');
		expect(await inPage('Notification.permission')).toBe('default');
		expect(opened).toContain('The page asks to show notifications for 127.0.0.1');
		await page.screenshot({ path: info.outputPath('ask.png') });
		await strip.getByRole('button', { name: 'Allow', exact: true }).click();
		await expect(strip).toHaveCount(0);
		expect(await inPage('window.asked')).toBe('granted');
		expect(
			JSON.parse(
				await readFile(join(root, 'data/projects/project/browser-notifications.json'), 'utf8')
			)
		).toEqual({ schemaVersion: 1, sites: { '127.0.0.1': 'granted' } });
		// spec/browser-and-simulator#notifications: the agent decides by itself — it forgets the domain, the page asks again, the agent's answer settles it.
		const domain = () =>
			readFile(join(root, 'data/projects/project/browser-notifications.json'), 'utf8').then(
				(text) => JSON.parse(text).sites['127.0.0.1']
			);
		expect(await call('browser_act', { action: 'notifications', permission: 'default' })).toContain(
			'Notifications for 127.0.0.1 are undecided again'
		);
		await expect.poll(() => inPage('Notification.permission')).toBe('default');
		expect(await domain()).toBeUndefined();
		await inPage('window.again = Notification.requestPermission(); true');
		await expect(strip).toContainText('127.0.0.1');
		expect(await call('browser_act', { action: 'notifications', permission: 'granted' })).toContain(
			'Notifications for 127.0.0.1 are allowed'
		);
		await expect(strip).toHaveCount(0);
		expect(await inPage('window.again')).toBe('granted');
		expect(await domain()).toBe('granted');
		await inPage(
			`window.clicks = 0; const note = new Notification('New order', { body: '#12 · table 4' });
			 note.onclick = () => window.clicks++; true`
		);
		await expect
			.poll(() => call('browser_ui'))
			.toContain('The page showed a notification "New order": "#12 · table 4".');
		// The window is in the background: a silent notice of the OS names the page; its click reaches the page.
		const notice = await app.evaluate(() => {
			const shown = (globalThis as any).brigadirNotifications.shown;
			const entry = shown.findLast((item: any) => item.notice.kind === 'page');
			entry?.handlers.open();
			return entry?.notice;
		});
		expect(notice).toMatchObject({ title: 'New order', body: '127.0.0.1 · #12 · table 4' });
		await expect.poll(() => inPage('window.clicks')).toBe(1);
		// spec/browser-and-simulator#tab-sound: the playing tab shows the speaker; a click mutes the view itself.
		await inPage('window.tone(); true');
		const mute = page.getByRole('button', { name: 'Mute tab' });
		await expect(mute).toBeVisible({ timeout: 10_000 });
		await page.screenshot({ path: info.outputPath('sound.png') });
		await mute.click();
		await expect(page.getByRole('button', { name: 'Unmute tab' })).toBeVisible();
		expect(
			await app.evaluate(({ BrowserWindow }) =>
				(
					BrowserWindow.getAllWindows()[0]!.contentView.children[0] as Electron.WebContentsView
				).webContents.isAudioMuted()
			)
		).toBe(true);
		await page.screenshot({ path: info.outputPath('muted.png') });
	} finally {
		await mcp?.close().catch(() => {});
		await app.close();
		server.close();
		await rm(root, { recursive: true, force: true });
	}
});
