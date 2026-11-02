import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { hideChat, showWorkArea } from './layout';
const desktop = resolve('apps/desktop'),
	executablePath = createRequire(join(desktop, 'package.json'))('electron') as string;
/** A small app: a form that saves, a search that navigates, a select, a password field and an overlay that covers Save. */
const fixture = (path: string) =>
	path.startsWith('/search')
		? `<title>Results</title><h1>Results for ${new URL(path, 'http://x').searchParams.get('q')}</h1>`
		: `<title>Fixture form</title>
<style>body{font:16px system-ui;padding:24px}#cover{position:fixed;inset:0;background:rgba(0,0,0,.4);display:none}#cover.on{display:block}</style>
<h1>Act fixture</h1>
<label>Name <input id="name"></label> <button id="save">Save</button> <output id="out"></output>
<form action="/search"><label>Search <input name="q" id="q"></label></form>
<label>Language <select id="lang"><option value="uk">Українська</option><option value="en">English</option></select></label>
<label>Password <input id="pw" type="password"></label>
<div id="cover" role="dialog" aria-label="Promo banner"></div>
<script>
window.events=[];window.rings=0;
for(const type of ['pointerdown','mousedown','focus','mouseup','click'])document.querySelector('#save').addEventListener(type,()=>events.push(type));
document.querySelector('#save').addEventListener('click',()=>{out.textContent='Saved '+document.querySelector('#name').value;});
document.querySelector('#lang').addEventListener('change',e=>history.replaceState(null,'','?lang='+e.target.value));
new MutationObserver(list=>{for(const m of list)for(const n of m.addedNodes)if(n.nodeName==='BRIGADIR-AGENT-ACT')window.rings++;}).observe(document.documentElement,{childList:true});
</script>`;
test('browser_act: the agent clicks, types, submits, selects and goes back; passwords, overlays and other domains are guarded @area:browser', async ({}, info) => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-browser-act-')),
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
				title: 'Act fixture',
				status: 'done',
				provider: 'claude',
				transport: 'gui',
			},
		})
	);
	const server = createServer((req, res) => {
		res.setHeader('Content-Type', 'text/html; charset=utf-8');
		res.end(fixture(req.url ?? '/'));
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
		env: { ...env, BRIGADIR_DATA_DIR: join(root, 'data') },
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
		await page.getByRole('button', { name: /Act fixture/ }).click();
		// The task host starts on the first command to it.
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
		mcp = new Client({ name: 'browser-act-fixture', version: '1.0.0' });
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
			return { error: result.isError === true, text: String(result.content[0]?.text ?? '') };
		};
		// spec/browser-and-simulator#opening-tabs: the first call opens the agent's tab; the local page needs no card. spec/task-window-workspace#empty-work-area: the task has no other
		// tab, so its work area is hidden and the agent does not show it — the person does, and sees the page.
		expect((await call('browser_open', { url })).error).toBe(false);
		await showWorkArea(page);
		await expect
			.poll(() =>
				app.evaluate(
					({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.contentView.children.length
				)
			)
			.toBe(1);
		const tree = await call('browser_ui');
		expect(tree.error).toBe(false);
		expect(tree.text).toMatch(/^Viewport \d+×\d+ px/);
		expect(tree.text).toMatch(/textbox "Name" @e\d+/);
		expect(tree.text).toMatch(/combobox "Language"/);
		const save = /button "Save" (@e\d+)/.exec(tree.text)![1]!;
		// Typing by name, a click by ref: real input events in the order the person's would come.
		expect(await call('browser_act', { action: 'type', label: 'Name', text: 'Ada' })).toMatchObject(
			{ error: false, text: expect.stringMatching(/^Typed 3 characters into/) }
		);
		const clicked = await call('browser_act', { action: 'click', ref: save });
		expect(clicked.error).toBe(false);
		expect(clicked.text).toMatch(/^Clicked button#save "Save"\./);
		expect(await inPage('document.querySelector("#out").textContent')).toBe('Saved Ada');
		expect(await inPage('events')).toEqual([
			'pointerdown',
			'mousedown',
			'focus',
			'mouseup',
			'click',
		]);
		expect(await inPage('rings')).toBeGreaterThanOrEqual(2);
		// The ring for design review: capture it while it is still on the page.
		await call('browser_act', { action: 'hover', ref: save });
		const shot = await app.evaluate(async ({ BrowserWindow }) =>
			(
				await (
					BrowserWindow.getAllWindows()[0]!.contentView.children[0] as Electron.WebContentsView
				).webContents.capturePage()
			)
				.toPNG()
				.toString('base64')
		);
		await writeFile(info.outputPath('ring.png'), Buffer.from(shot, 'base64'));
		// A select changes the address like the language switch of a preview.
		expect(
			await call('browser_act', { action: 'select', label: 'Language', value: 'English' })
		).toMatchObject({ error: false, text: expect.stringContaining('Selected "English"') });
		expect(await inPage('location.search')).toBe('?lang=en');
		// A password is never typed; a covered button is not clicked.
		const secret = await call('browser_act', { action: 'type', selector: '#pw', text: 'hunter2' });
		expect(secret.error).toBe(true);
		expect(secret.text).toContain('password');
		expect(await inPage('document.querySelector("#pw").value')).toBe('');
		await inPage('document.querySelector("#cover").classList.add("on")');
		const covered = await call('browser_act', { action: 'click', ref: save });
		expect(covered.error).toBe(true);
		expect(covered.text).toContain('covers');
		expect(await inPage('events.length')).toBe(5);
		expect((await call('browser_act', { action: 'key', key: 'Escape' })).error).toBe(false);
		await inPage('document.querySelector("#cover").classList.remove("on")');
		// Enter in the search form navigates; back returns to the form.
		const searched = await call('browser_act', {
			action: 'type',
			label: 'Search',
			text: 'pizza',
			submit: true,
		});
		expect(searched.error).toBe(false);
		expect(searched.text).toContain('Now at');
		expect(searched.text).toContain('/search?q=pizza');
		expect(await inPage('document.querySelector("h1").textContent')).toBe('Results for pizza');
		const back = await call('browser_act', { action: 'back' });
		expect(back.error).toBe(false);
		expect(back.text).toContain('Went back');
		await expect.poll(() => inPage('location.search')).toBe('?lang=en');
		const stale = await call('browser_act', { action: 'click', label: 'Nothing like this' });
		expect(stale.error).toBe(true);
		expect(stale.text).toContain('browser_ui');
		// spec/browser-and-simulator#browser-ui-act: another domain — opening it is allowed for the domain, acting asks its own card.
		await hideChat(page);
		const external = `http://preview.test:${port}/`,
			opened = call('browser_open', { url: external });
		await page.getByRole('button', { name: 'Allow for domain', exact: true }).click();
		expect((await opened).error).toBe(false);
		const denied = call('browser_act', { action: 'click', label: 'Save' });
		await expect(page.getByText('Act on preview.test')).toBeVisible();
		await page.getByRole('button', { name: 'Deny', exact: true }).click();
		expect(await denied).toMatchObject({
			error: true,
			text: expect.stringContaining('did not allow'),
		});
		const allowed = call('browser_act', { action: 'click', label: 'Save' });
		await page.getByRole('button', { name: 'Allow in this task', exact: true }).click();
		expect((await allowed).error).toBe(false);
		expect((await call('browser_act', { action: 'click', label: 'Save' })).error).toBe(false);
		await expect(page.getByText('Act on preview.test')).toHaveCount(0);
		await expect(
			readFile(join(taskDir, '../../browser-act-domains.json'), 'utf8')
		).rejects.toThrow();
	} finally {
		await mcp?.close();
		try {
			await app
				.windows()[0]
				?.evaluate(() =>
					window.brigadir.sendCommand({ projectId: 'project', id: 'task' }, { kind: 'shutdown' })
				);
		} catch {}
		await app.close();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(root, { recursive: true, force: true });
	}
});
