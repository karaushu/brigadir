import {
	_electron as electron,
	expect,
	test,
	type ElectronApplication,
	type Page,
} from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hidePanel, hideWorkArea, openPanelTab, showPanel, showWorkArea } from './layout';
const run = promisify(execFile);
const desktop = resolve('apps/desktop'),
	executablePath = createRequire(join(desktop, 'package.json'))('electron') as string;
const env = Object.fromEntries(
	Object.entries(process.env).filter(
		(e): e is [string, string] => typeof e[1] === 'string' && e[0] !== 'ELECTRON_RUN_AS_NODE'
	)
);
/** Two tasks of one project on a small git repo; `a.ts` changed so Changes has a file. */
async function fixture(prefix: string) {
	const root = await mkdtemp(join(tmpdir(), prefix)),
		repo = join(root, 'repo');
	await mkdir(repo);
	const git = (...args: string[]) => run('git', args, { cwd: repo });
	await git('init', '-q');
	await git('config', 'user.name', 'Fixture');
	await git('config', 'user.email', 'fixture@localhost');
	await writeFile(join(repo, 'a.ts'), 'export const a = 1;\n');
	await git('add', '.');
	await git('commit', '-qm', 'Baseline');
	for (const [id, title] of [
		['task', 'Work area fixture'],
		['other', 'Other fixture'],
	]) {
		const dir = join(root, 'data/projects/project/tasks', id!);
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
	}
	await writeFile(
		join(root, 'data/projects/project/project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'repo', path: repo } })
	);
	return { root, repo, app: await launch(root) };
}
const launch = (root: string) =>
	electron.launch({
		executablePath,
		args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
		env: { ...env, BRIGADIR_DATA_DIR: join(root, 'data') },
	});
/** A menu-bar item by its path from the top menu (`File`, `View`, …). */
const appMenu = (app: ElectronApplication, path: string[]) =>
	app.evaluate(({ Menu }, path) => {
		let items = Menu.getApplicationMenu()!.items;
		for (const label of path.slice(0, -1))
			items = items.find((item) => item.label === label)!.submenu!.items;
		const item = items.find((entry) => entry.label === path.at(-1))!;
		item.click();
		return { accelerator: item.accelerator ?? null };
	}, path);
const viewMenu = (app: ElectronApplication, path: string[]) =>
	app.evaluate(({ Menu }, path) => {
		let items = Menu.getApplicationMenu()!.items.find((item) => item.label === 'View')!.submenu!
			.items;
		for (const label of path.slice(0, -1))
			items = items.find((item) => item.label === label)!.submenu!.items;
		const item = items.find((entry) => entry.label === path.at(-1))!;
		item.click();
		return { accelerator: item.accelerator ?? null, checked: item.checked };
	}, path);
const switchOf = (page: Page, column: string) => page.locator(`[data-switch="${column}"]`);

test('Layout: three switches, ⌘1–⌘3 in View ▸ Layout, all may go, the panel tabs and ⇧⌘D @area:shell', async ({}, info) => {
	test.setTimeout(90000);
	const { app } = await fixture('brigadir-layout-');
	try {
		const page = await app.firstWindow();
		await app.evaluate(({ BrowserWindow }) =>
			BrowserWindow.getAllWindows()[0]!.setContentSize(1600, 900)
		);
		await page.getByRole('button', { name: /Work area fixture/ }).click();
		// A new task shows the chat; the panel is one switch away (spec/task-window-workspace#layout-switch) and the work area comes with its first tab
		// (spec/task-window-workspace#empty-work-area).
		await expect(switchOf(page, 'chat')).toHaveAttribute('aria-checked', 'true');
		for (const column of ['work', 'panel'])
			await expect(switchOf(page, column)).toHaveAttribute('aria-checked', 'false');
		await openPanelTab(page, 'files');
		await page
			.getByRole('tree', { name: 'Project files' })
			.getByRole('treeitem', { name: 'a.ts', exact: true })
			.dblclick();
		await expect(switchOf(page, 'work')).toHaveAttribute('aria-checked', 'true');
		await expect(page.locator('[data-task-chat]')).toBeVisible();
		await expect(page.locator('[data-work-area]')).toBeVisible();
		await expect(page.getByRole('complementary', { name: 'Changes', exact: true })).toBeVisible();
		// The routes sit on ⇧⌘1 / ⇧⌘2; View ▸ Layout holds ⌘1–⌘3, Show all and Reset column widths.
		const routes = await app.evaluate(({ Menu }) =>
			Menu.getApplicationMenu()!
				.items.find((item) => item.label === 'View')!
				.submenu!.items.filter((item) => ['Workspace', 'Kit'].includes(item.label))
				.map((item) => item.accelerator)
		);
		expect(routes).toEqual(['CmdOrCtrl+Shift+1', 'CmdOrCtrl+Shift+2']);
		const layoutItems = await app.evaluate(({ Menu }) =>
			Menu.getApplicationMenu()!
				.items.find((item) => item.label === 'View')!
				.submenu!.items.find((item) => item.label === 'Layout')!
				.submenu!.items.map(
					(item) => `${item.label || '-'}${item.accelerator ? ` ${item.accelerator}` : ''}`
				)
		);
		// spec/search-menus-and-commands#menu-structure: the two / three columns radio opens the submenu, as in the toolbar's Layout ▾.
		expect(layoutItems).toEqual([
			'Two columns',
			'Three columns',
			'-',
			'Chat CmdOrCtrl+1',
			'Work area CmdOrCtrl+2',
			'Panel CmdOrCtrl+3',
			'-',
			'Show all',
			'Reset column widths',
		]);
		// ⌘1 hides the chat; the menu ticks follow.
		await viewMenu(app, ['Layout', 'Chat']);
		await expect(page.locator('[data-task-chat]')).toHaveCount(0);
		await expect(switchOf(page, 'chat')).toHaveAttribute('aria-checked', 'false');
		await expect.poll(async () => (await viewMenu(app, ['Layout', 'Panel'])).checked).toBe(false);
		await expect(page.getByRole('complementary', { name: 'Changes', exact: true })).toHaveCount(0);
		// The work area goes too: nothing is on, the task shows its empty state; ⌘2 brings the work area back
		// with its tab.
		await switchOf(page, 'work').click();
		await expect(page.locator('[data-work-area]')).toHaveCount(0);
		await expect(page.locator('[data-empty-place="task"]')).toBeVisible();
		await viewMenu(app, ['Layout', 'Work area']);
		await expect(page.locator('[data-work-area]')).toBeVisible();
		await expect(page.getByRole('tab', { name: 'a.ts', exact: true })).toBeVisible();
		await expect(page.locator('[data-empty-place]')).toHaveCount(0);
		// Show all brings every column back.
		await viewMenu(app, ['Layout', 'Show all']);
		for (const column of ['chat', 'work', 'panel'])
			await expect(switchOf(page, column)).toHaveAttribute('aria-checked', 'true');
		// A hidden work area carries the count of its tabs.
		await openPanelTab(page, 'files');
		await page
			.getByRole('tree', { name: 'Project files' })
			.getByRole('treeitem', { name: 'a.ts', exact: true })
			.dblclick();
		await expect(page.getByRole('tab', { name: 'a.ts', exact: true })).toBeVisible();
		await switchOf(page, 'work').click();
		await expect(page.locator('[data-work-area]')).toHaveCount(0);
		await expect(switchOf(page, 'work').locator('[data-layout-count]')).toHaveText('1');
		// ▾: the three with ticks, Show all, Reset column widths.
		await page.locator('[data-switches] [data-menu]').click();
		const menu = page.getByRole('menu', { name: 'Layout', exact: true });
		await expect(menu.getByRole('menuitemcheckbox')).toHaveText([/Chat/, /Work area/, /Panel/]);
		await expect(menu.getByRole('menuitemcheckbox', { name: /Work area/ })).toHaveAttribute(
			'aria-checked',
			'false'
		);
		await expect(menu.getByRole('menuitemcheckbox', { name: /Chat/ })).toHaveAttribute(
			'aria-checked',
			'true'
		);
		await menu.getByRole('menuitemcheckbox', { name: /Work area/ }).click();
		await expect(page.locator('[data-work-area]')).toBeVisible();
		// ⇧⌘D opens the panel on Changes; again — hides it.
		await switchOf(page, 'panel').click();
		await expect(page.getByRole('complementary', { name: 'Changes', exact: true })).toHaveCount(0);
		await viewMenu(app, ['Show changes']);
		await expect(page.locator('[data-panel-tab=changes]')).toHaveAttribute('aria-selected', 'true');
		await viewMenu(app, ['Show changes']);
		await expect(page.getByRole('complementary', { name: 'Changes', exact: true })).toHaveCount(0);
		await viewMenu(app, ['Show files']);
		await expect(page.locator('[data-panel-tab=files]')).toHaveAttribute('aria-selected', 'true');
		// The layout belongs to the task: another task opens with its own, the first comes back as it was.
		await switchOf(page, 'chat').click();
		await page.getByRole('button', { name: /Other fixture/ }).click();
		await expect(switchOf(page, 'chat')).toHaveAttribute('aria-checked', 'true');
		await page.getByRole('button', { name: /Work area fixture/ }).click();
		await expect(switchOf(page, 'chat')).toHaveAttribute('aria-checked', 'false');
		await viewMenu(app, ['Layout', 'Show all']);
		// Rule 16: the toolbar is one row of M.
		const heights = await page
			.locator(
				'header[aria-label=View] [data-switches], header[aria-label=View] [data-tools-button]'
			)
			.evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().height)));
		expect(new Set(heights)).toEqual(new Set([28]));
		for (const theme of ['dark', 'light'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await page.screenshot({ path: info.outputPath(`layout-${theme}.png`) });
		}
	} finally {
		await app.close();
	}
});

test('the chat widens until the work area is at its 400 px, no 900 ceiling, and the panel keeps its width (spec/task-window#width-rules) @area:shell', async () => {
	test.setTimeout(60000);
	const { app } = await fixture('brigadir-chat-ceiling-');
	try {
		const page = await app.firstWindow();
		await app.evaluate(({ BrowserWindow }) =>
			BrowserWindow.getAllWindows()[0]!.setContentSize(2400, 900)
		);
		await page.getByRole('button', { name: /Work area fixture/ }).click();
		await openPanelTab(page, 'files');
		await page
			.getByRole('tree', { name: 'Project files' })
			.getByRole('treeitem', { name: 'a.ts', exact: true })
			.dblclick();
		await expect(page.locator('[data-work-area]')).toBeVisible();
		const panel = page.getByRole('complementary', { name: 'Changes', exact: true });
		const width = (locator: ReturnType<Page['locator']>) =>
			locator.evaluate((node) => Math.round(node.getBoundingClientRect().width));
		const panelBefore = await width(panel);
		const handle = page.getByRole('separator', { name: 'Resize chat' });
		await handle.focus();
		await handle.press('End');
		// The work area at its minimum and its left border (±1 px of rounding); the chat took the rest.
		await expect
			.poll(async () => Math.abs((await width(page.locator('[data-work-area]'))) - 401))
			.toBeLessThanOrEqual(1);
		expect(await width(panel)).toBe(panelBefore);
		const body = await page.locator('[data-task-chat]').evaluate((node) => ({
			width: node.parentElement!.clientWidth,
			overflow: node.parentElement!.scrollWidth - node.parentElement!.clientWidth,
		}));
		expect(body.overflow).toBe(0);
		// No width ceiling: the chat has every pixel the work area and the panel leave (the test display may be narrower
		// than the window asked for).
		const rest = body.width - (await width(page.locator('[data-work-area]'))) - panelBefore;
		expect(Math.abs((await width(page.locator('[data-task-chat]'))) - rest)).toBeLessThanOrEqual(1);
		// Without the panel End brings the work area to its minimum again.
		await hidePanel(page);
		await handle.press('End');
		await expect
			.poll(async () => Math.abs((await width(page.locator('[data-work-area]'))) - 401))
			.toBeLessThanOrEqual(1);
		expect(await width(page.locator('[data-task-chat]'))).toBeGreaterThan(900);
		// Arrows start from the chat as drawn: one step left gives the work area room at once.
		await handle.press('ArrowLeft');
		await expect.poll(() => width(page.locator('[data-work-area]'))).toBeGreaterThan(410);
	} finally {
		await app.close();
	}
});

test('Tools: terminals and browsers are tabs of the groups; where they open; ⇧⌘B; a terminal tab dragged beside a file @area:shell', async ({}, info) => {
	test.setTimeout(90000);
	const { app } = await fixture('brigadir-tools-');
	try {
		const page = await app.firstWindow();
		await app.evaluate(({ BrowserWindow }) =>
			BrowserWindow.getAllWindows()[0]!.setContentSize(1600, 900)
		);
		await page.getByRole('button', { name: /Work area fixture/ }).click();
		await showPanel(page);
		await openPanelTab(page, 'files');
		await page
			.getByRole('tree', { name: 'Project files' })
			.getByRole('treeitem', { name: 'a.ts', exact: true })
			.dblclick();
		const groups = page.locator('[data-work-area] [data-editor-group]');
		await expect(groups).toHaveCount(1);
		// New terminal in the focused group (the default place).
		await page.locator('[data-tools-button]').click();
		const tools = page.getByRole('menu', { name: 'Task tools', exact: true });
		await expect(
			tools.getByRole('menuitemradio', { name: 'In the focused group' })
		).toHaveAttribute('aria-checked', 'true');
		await tools.getByRole('menuitem', { name: /New terminal/ }).click();
		await expect(groups).toHaveCount(1);
		await expect(groups.first().locator('[data-tool=terminal]')).toHaveCount(1);
		await expect(page.locator('[data-tools-button]')).toContainText('1');
		// In the bottom group: the group is made under the whole area.
		await page.locator('[data-tools-button]').click();
		await tools.getByRole('menuitemradio', { name: 'In the bottom group' }).click();
		await page.locator('[data-tools-button]').click();
		await tools.getByRole('menuitem', { name: /New terminal/ }).click();
		await expect(groups).toHaveCount(2);
		const [top, bottom] = await groups.evaluateAll((nodes) =>
			nodes.map((node) => node.getBoundingClientRect().y)
		);
		expect(bottom!).toBeGreaterThan(top! + 200);
		await expect(groups.nth(1).locator('[data-tool=terminal]')).toHaveCount(1);
		// The Tools list shows every tool tab and reveals one.
		await page.locator('[data-tools-button]').click();
		await expect(tools.getByText('Open · 2')).toBeVisible();
		await tools.locator('[data-tool-tab]').first().click();
		await expect(groups.first().locator('[data-tool=terminal] [role=tab]')).toHaveAttribute(
			'aria-selected',
			'true'
		);
		// A terminal tab dragged into the file's group: it moves there, beside a.ts.
		await groups
			.nth(1)
			.locator('[data-tool=terminal] [role=tab]')
			.dragTo(groups.first().getByRole('tablist'));
		await expect(groups).toHaveCount(1);
		await expect(groups.first().locator('[data-tool=terminal]')).toHaveCount(2);
		await expect(groups.first().getByRole('tab', { name: 'a.ts', exact: true })).toBeVisible();
		// ⇧⌘Y goes to the last terminal tab, it does not open another.
		await viewMenu(app, ['Terminal']);
		await expect(page.locator('[data-tool=terminal]')).toHaveCount(2);
		// ⌃⇧` always opens a new one.
		await app.evaluate(({ Menu }) =>
			Menu.getApplicationMenu()!
				.items.find((item) => item.label === 'Console')!
				.submenu!.items.find((item) => item.label === 'New terminal')!
				.click()
		);
		await expect(page.locator('[data-tool=terminal]')).toHaveCount(3);
		await page.screenshot({ path: info.outputPath('tools.png') });
	} finally {
		await app.close();
	}
});

test('a new task opens without the panel; the bottom group dragged under the chat and back @area:shell', async ({}, info) => {
	test.setTimeout(90000);
	const { app } = await fixture('brigadir-under-chat-');
	try {
		const page = await app.firstWindow();
		await app.evaluate(({ BrowserWindow }) =>
			BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 800)
		);
		await page.getByRole('button', { name: /Work area fixture/ }).click();
		// spec/task-window-workspace#layout-switch: no panel — a 1280 window does not scroll sideways; no tabs, no work area (spec/task-window-workspace#empty-work-area).
		await expect(switchOf(page, 'chat')).toHaveAttribute('aria-checked', 'true');
		await expect(switchOf(page, 'work')).toHaveAttribute('aria-checked', 'false');
		await expect(switchOf(page, 'panel')).toHaveAttribute('aria-checked', 'false');
		await expect(page.getByRole('complementary', { name: 'Changes', exact: true })).toHaveCount(0);
		const columns = page.locator('[data-columns]');
		expect(
			await columns.evaluate((node) => node.scrollWidth - node.clientWidth)
		).toBeLessThanOrEqual(0);
		// A file, and a terminal in the bottom group under it.
		await showPanel(page);
		await openPanelTab(page, 'files');
		await page
			.getByRole('tree', { name: 'Project files' })
			.getByRole('treeitem', { name: 'a.ts', exact: true })
			.dblclick();
		await hidePanel(page);
		const tools = page.getByRole('menu', { name: 'Task tools', exact: true });
		await page.locator('[data-tools-button]').click();
		await tools.getByRole('menuitemradio', { name: 'In the bottom group' }).click();
		await page.locator('[data-tools-button]').click();
		await tools.getByRole('menuitem', { name: /New terminal/ }).click();
		const groups = page.locator('[data-work-area] [data-editor-group]'),
			underChat = page.locator('[data-task-chat] [data-under-chat]'),
			terminal = page.locator('[data-tool=terminal] [role=tab]');
		await expect(groups).toHaveCount(2);
		// The terminal tab dragged over the chat: the tab dims, the chat's lower half is the zone «Under the chat».
		const chat = (await page.locator('[data-task-chat]').boundingBox())!;
		await terminal.hover();
		await page.mouse.down();
		await page.mouse.move(chat.x + chat.width / 2, chat.y + chat.height * 0.4, { steps: 8 });
		await page.mouse.move(chat.x + chat.width / 2, chat.y + chat.height * 0.45, { steps: 2 });
		const chatZone = page.locator('[data-column-drop=chat] [data-zone=down]');
		await expect(chatZone).toBeVisible();
		await expect(chatZone).toHaveText('Under the chat');
		await expect(page.locator('[data-document-tab][data-dragging=true]')).toHaveCount(1);
		const zoneBox = (await chatZone.boundingBox())!;
		expect(zoneBox.y).toBeGreaterThanOrEqual(chat.y + chat.height / 2 - 1);
		await page.screenshot({ path: info.outputPath('drag-under-chat.png') });
		await page.mouse.up();
		// Dropped: the whole group stands under the chat, the work area keeps the file; the tab is not dim any more.
		await expect(underChat.locator('[data-tool=terminal]')).toHaveCount(1);
		await expect(groups).toHaveCount(1);
		await expect(groups.first().getByRole('tab', { name: 'a.ts', exact: true })).toBeVisible();
		await expect(page.locator('[data-document-tab][data-dragging]')).toHaveCount(0);
		await expect(page.locator('[data-column-drop]')).toHaveCount(0);
		// It stays there with the work area hidden, as the menu item made it (spec/task-window-workspace#work-area).
		await hideWorkArea(page);
		await expect(underChat.locator('[data-tool=terminal]')).toHaveCount(1);
		await showWorkArea(page);
		// spec/task-window-workspace#empty-work-area: the last file closed — the work area goes, the group stays under the chat; a file from the tree
		// brings the work area back beside it.
		await page.getByRole('button', { name: 'Close file · a.ts', exact: true }).click();
		await expect(page.locator('[data-work-area]')).toHaveCount(0);
		await expect(switchOf(page, 'work')).toHaveAttribute('aria-checked', 'false');
		await expect(underChat.locator('[data-tool=terminal]')).toHaveCount(1);
		await openPanelTab(page, 'files');
		await page
			.getByRole('tree', { name: 'Project files' })
			.getByRole('treeitem', { name: 'a.ts', exact: true })
			.dblclick();
		await hidePanel(page);
		await expect(groups).toHaveCount(1);
		await expect(groups.first().getByRole('tab', { name: 'a.ts', exact: true })).toBeVisible();
		await expect(underChat.locator('[data-tool=terminal]')).toHaveCount(1);
		// Dragged back over the work area: its lower half is the zone «Work area»; the group returns under the file.
		const work = (await page.locator('[data-work-area]').boundingBox())!;
		await underChat.locator('[data-tool=terminal] [role=tab]').hover();
		await page.mouse.down();
		await page.mouse.move(work.x + work.width / 2, work.y + work.height * 0.6, { steps: 8 });
		await page.mouse.move(work.x + work.width / 2, work.y + work.height * 0.65, { steps: 2 });
		const workZone = page.locator('[data-column-drop=work] [data-zone=down]');
		await expect(workZone).toBeVisible();
		await expect(workZone).toHaveText('Work area');
		await page.mouse.up();
		await expect(underChat).toHaveCount(0);
		await expect(groups).toHaveCount(2);
		await expect(groups.nth(1).locator('[data-tool=terminal]')).toHaveCount(1);
	} finally {
		await app.close();
	}
});

test('browser tabs: two live pages, the agent works in its own tab, the bar and marks, it yields to the person, a snapshot under a menu @area:browser', async ({}, info) => {
	test.setTimeout(120000);
	const { root, app } = await fixture('brigadir-agent-tab-');
	const server = createServer((req, res) => {
		res.setHeader('Content-Type', 'text/html; charset=utf-8');
		res.end(
			`<title>${req.url?.includes('agent') ? 'Agent page' : 'Person page'}</title><label>Name <input id="name"></label> <button id="save" onclick="document.title='Saved'">Save</button>`
		);
	});
	await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
	const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
	const taskDir = join(root, 'data/projects/project/tasks/task');
	let mcp: any;
	try {
		const page = await app.firstWindow();
		await app.evaluate(({ BrowserWindow }) =>
			BrowserWindow.getAllWindows()[0]!.setContentSize(1600, 900)
		);
		await page.getByRole('button', { name: /Work area fixture/ }).click();
		const groups = page.locator('[data-work-area] [data-editor-group]');
		// The person's browser: ⇧⌘B opens a tab (none yet), the address takes the focus.
		await viewMenu(app, ['Browser']);
		await expect(page.locator('[data-tool=browser]')).toHaveCount(1);
		const address = page.getByRole('textbox', { name: 'Address' });
		await expect(address).toBeFocused();
		await address.fill(url);
		await address.press('Enter');
		await expect(page.locator('[data-tool=browser] [role=tab]')).toHaveAttribute(
			'aria-label',
			/127\.0\.0\.1/
		);
		// ⇧⌘B again goes to that tab.
		await viewMenu(app, ['Browser']);
		await expect(page.locator('[data-tool=browser]')).toHaveCount(1);
		// The agent: its browser_open makes its own tab.
		await page.evaluate(() =>
			window.brigadir.terminalCommand({ projectId: 'project', id: 'task' }, { kind: 'list' })
		);
		await expect
			.poll(async () =>
				readFile(join(taskDir, 'host.json')).then(
					() => true,
					() => false
				)
			)
			.toBe(true);
		const host = JSON.parse(await readFile(join(taskDir, 'host.json'), 'utf8')),
			requireMcp = createRequire(resolve('packages/transport/package.json'));
		const { Client } = requireMcp('@modelcontextprotocol/sdk/client/index.js');
		const { StdioClientTransport } = requireMcp('@modelcontextprotocol/sdk/client/stdio.js');
		mcp = new Client({ name: 'work-area-fixture', version: '1.0.0' });
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
		expect((await call('browser_open', { url: `${url}?agent` })).error).toBe(false);
		await expect(page.locator('[data-tool=browser]')).toHaveCount(2);
		const state = JSON.parse((await call('browser_state')).text);
		expect(state.tabs).toHaveLength(2);
		expect(state.tabs.filter((tab: { yours: boolean }) => tab.yours)).toHaveLength(1);
		const mine = state.tabs.find((tab: { yours: boolean }) => tab.yours).tab as string;
		// The agent's tab: the dot after its step, the bar over its page with the count and «In chat».
		const agentTab = page.locator('[data-tool=browser][data-agent]');
		await expect(agentTab).toHaveAttribute('data-agent', 'recent');
		const bar = page.locator(`[data-browser-tab="${mine}"] [data-agent-bar]`);
		await expect(bar).toContainText('Agent in the browser');
		await expect(bar).toContainText('1 action');
		await expect(bar.getByRole('button', { name: 'In chat' })).toBeVisible();
		await page.screenshot({ path: info.outputPath('agent-tab.png') });
		// Two pages live at once: the person's tab and the agent's, each its own view in main.
		const views = () =>
			app.evaluate(({ BrowserWindow }) =>
				BrowserWindow.getAllWindows()[0]!.contentView.children.map((child) =>
					(child as Electron.WebContentsView).webContents.getURL()
				)
			);
		// A call names the tab; the agent's other calls go to its own one.
		expect((await call('browser_read', { tab: mine })).error).toBe(false);
		// spec/task-window-workspace#work-area.1: the person types in the agent's tab — its next action waits for 1.5 s of quiet.
		const typing = (ms: number, every = 200) =>
			app.evaluate(
				async ({ BrowserWindow }, { ms, every }) => {
					const view = BrowserWindow.getAllWindows()[0]!
						.contentView.children.map((child) => (child as Electron.WebContentsView).webContents)
						.find((web) => web.getURL().includes('agent'))!;
					const end = Date.now() + ms;
					while (Date.now() < end) {
						view.sendInputEvent({ type: 'keyDown', keyCode: 'a' });
						view.sendInputEvent({ type: 'char', keyCode: 'a' });
						view.sendInputEvent({ type: 'keyUp', keyCode: 'a' });
						await new Promise((done) => setTimeout(done, every));
					}
				},
				{ ms, every }
			);
		await expect
			.poll(async () => (await views()).some((value) => value.includes('agent')))
			.toBe(true);
		const busy = typing(1500);
		await new Promise((done) => setTimeout(done, 300));
		const started = Date.now();
		const waited = call('browser_act', { action: 'click', selector: '#save' });
		await expect(bar).toHaveAttribute('data-agent-bar', 'waiting');
		await expect(bar).toContainText('The agent is waiting until you finish');
		await busy;
		const result = await waited;
		expect(result.error).toBe(false);
		expect(result.text).toMatch(/^The person was working on this page/);
		expect(Date.now() - started).toBeGreaterThan(1500);
		// Scrolling does not hold the agent.
		const scrolled = Date.now();
		const scrolling = app.evaluate(async ({ BrowserWindow }) => {
			const view = BrowserWindow.getAllWindows()[0]!
				.contentView.children.map((child) => (child as Electron.WebContentsView).webContents)
				.find((web) => web.getURL().includes('agent'))!;
			for (let i = 0; i < 6; i++) {
				view.sendInputEvent({ type: 'mouseWheel', x: 50, y: 50, deltaX: 0, deltaY: -20 });
				await new Promise((done) => setTimeout(done, 100));
			}
		});
		expect((await call('browser_act', { action: 'hover', selector: '#save' })).text).not.toMatch(
			/person was working/
		);
		await scrolling;
		expect(Date.now() - scrolled).toBeLessThan(1500);
		// Over 10 s of input: the action goes back to the agent undone.
		const long = typing(11_500, 300);
		await new Promise((done) => setTimeout(done, 300));
		const refused = await call('browser_act', { action: 'click', selector: '#save' });
		expect(refused.error).toBe(true);
		expect(refused.text).toMatch(/The person is working on this page/);
		await long;
		// spec/task-window-workspace#work-area: a menu over the page — the page's picture stands in place of the native view.
		const agentGroup = page.locator('[data-editor-group]:has([data-browser-tab])').first();
		const shownBefore = (await views()).length;
		await agentGroup.locator('[data-strip-tools]').click();
		await expect(page.getByRole('menu', { name: 'Task tools', exact: true })).toBeVisible();
		await expect(agentGroup.locator('img[alt="Page snapshot"]')).toHaveAttribute(
			'src',
			/^data:image\/png/
		);
		await expect.poll(async () => (await views()).length).toBeLessThan(shownBefore);
		await page.screenshot({ path: info.outputPath('snapshot.png') });
		await page.keyboard.press('Escape');
		await expect(agentGroup.locator('img[alt="Page snapshot"]')).toHaveCount(0);
		await expect.poll(async () => (await views()).length).toBe(shownBefore);
	} finally {
		await mcp?.close().catch(() => {});
		await app.close();
		server.close();
	}
});

test('an empty work area is never shown: the last tab hides it, the task shows its empty state, ⌘2 opens Tools, all off survives a restart @area:shell', async ({}, info) => {
	test.setTimeout(120000);
	const { root, app: first } = await fixture('brigadir-empty-work-');
	let app = first;
	try {
		let page = await app.firstWindow();
		await app.evaluate(({ BrowserWindow }) =>
			BrowserWindow.getAllWindows()[0]!.setContentSize(1600, 900)
		);
		await page.getByRole('button', { name: /Work area fixture/ }).click();
		const chat = page.locator('[data-task-chat]'),
			body = page.locator('[data-columns]'),
			work = page.locator('[data-work-area]');
		const fullWidth = async () => {
			const [column, all] = await Promise.all([chat.boundingBox(), body.boundingBox()]);
			return Math.abs(column!.width - all!.width) <= 1;
		};
		// A new task has no tabs: no work area, the chat on the whole width.
		await expect(switchOf(page, 'work')).toHaveAttribute('aria-checked', 'false');
		await expect(work).toHaveCount(0);
		await expect.poll(fullWidth).toBe(true);
		// A file from the tree shows it.
		await openPanelTab(page, 'files');
		await page
			.getByRole('tree', { name: 'Project files' })
			.getByRole('treeitem', { name: 'a.ts', exact: true })
			.dblclick();
		await expect(work).toBeVisible();
		await expect(switchOf(page, 'work')).toHaveAttribute('aria-checked', 'true');
		await hidePanel(page);
		// The chat hidden and the last tab closed: the work area goes and nothing comes back — the task shows
		// its empty state: the helmet with Show the chat, New file…, Open Quickly.
		await viewMenu(app, ['Layout', 'Chat']);
		await expect(chat).toHaveCount(0);
		await page.getByRole('button', { name: 'Close file · a.ts' }).click();
		await expect(work).toHaveCount(0);
		const empty = page.locator('[data-empty-place="task"]'),
			actions = empty.locator('[data-empty-action]');
		await expect(empty).toBeVisible();
		for (const column of ['chat', 'work', 'panel'])
			await expect(switchOf(page, column)).toHaveAttribute('aria-checked', 'false');
		await expect(actions).toHaveText([
			/^Show the chat\s*⌘1$/,
			/^New file…\s*⌥⌘N$/,
			/^Open Quickly…\s*⌘P$/,
		]);
		// Design fidelity: the helmet 44, rows 28 high in a 248 column, the whole hovered row lit (rule 15).
		const fidelity = await empty.evaluate((node) => {
			const helmet = node.querySelector('[data-glyph="helmet"]')!,
				rows = [...node.querySelectorAll('[data-empty-action]')];
			return {
				helmet: helmet.getBoundingClientRect().width,
				opacity: getComputedStyle(helmet.parentElement!).opacity,
				column: rows[0]!.getBoundingClientRect().width,
				heights: rows.map((row) => row.getBoundingClientRect().height),
			};
		});
		expect(fidelity).toEqual({ helmet: 44, opacity: '0.6', column: 248, heights: [28, 28, 28] });
		await actions.first().hover();
		await expect
			.poll(() => actions.first().evaluate((row) => getComputedStyle(row).backgroundColor))
			.not.toBe('rgba(0, 0, 0, 0)');
		for (const appearance of ['dark', 'light'] as const) {
			await page.evaluate(async (appearance) => {
				const { settings } = await window.brigadir.readSettings();
				await window.brigadir.saveSettings({ ...settings, appearance });
			}, appearance);
			await expect(page.locator('html')).toHaveAttribute('data-theme', appearance);
			await page.screenshot({ path: info.outputPath(`task-all-hidden-${appearance}.png`) });
		}
		// Show the chat runs ⌘1: the chat comes back on the whole width.
		await actions.first().click();
		await expect(chat).toBeVisible();
		await expect(empty).toHaveCount(0);
		await expect(switchOf(page, 'chat')).toHaveAttribute('aria-checked', 'true');
		await expect.poll(fullWidth).toBe(true);
		// ⌘2 with no tabs opens Tools under its toolbar button; Esc leaves the work area hidden.
		const tools = page.getByRole('menu', { name: 'Task tools', exact: true });
		await viewMenu(app, ['Layout', 'Work area']);
		await expect(tools).toBeVisible();
		await expect(work).toHaveCount(0);
		const [menuBox, buttonBox] = await Promise.all([
			tools.boundingBox(),
			page.locator('[data-tools-button]').boundingBox(),
		]);
		expect(menuBox!.y).toBeGreaterThan(buttonBox!.y + buttonBox!.height - 1);
		await page.screenshot({ path: info.outputPath('empty-work-tools.png') });
		await page.keyboard.press('Escape');
		await expect(tools).toHaveCount(0);
		await expect(work).toHaveCount(0);
		await expect(switchOf(page, 'work')).toHaveAttribute('aria-checked', 'false');
		// ⌘1 off with no tabs: all off, the empty state; a restart keeps it (surface.json stores it as is).
		await viewMenu(app, ['Layout', 'Chat']);
		await expect(empty).toBeVisible();
		await page.waitForTimeout(800);
		await app.close();
		app = await launch(root);
		page = await app.firstWindow();
		for (const column of ['chat', 'work', 'panel'])
			await expect(switchOf(page, column)).toHaveAttribute('aria-checked', 'false');
		await expect(page.locator('[data-work-area]')).toHaveCount(0);
		const restored = page.locator('[data-empty-place="task"]');
		await expect(restored).toBeVisible();
		// ⌘3 brings the panel beside the empty state at its own width; ⌘3 again leaves the empty state alone.
		await viewMenu(app, ['Layout', 'Panel']);
		await expect(page.getByRole('complementary', { name: 'Changes', exact: true })).toBeVisible();
		await expect(restored).toBeVisible();
		await viewMenu(app, ['Layout', 'Panel']);
		await expect(page.getByRole('complementary', { name: 'Changes', exact: true })).toHaveCount(0);
		await restored.locator('[data-empty-action="show-chat"]').click();
		await expect(page.locator('[data-task-chat]')).toBeVisible();
		await expect(restored).toHaveCount(0);
		// The switch clicked: Tools again; New terminal shows the work area with the terminal.
		await page.locator('[data-switch="work"]').click();
		const reopened = page.getByRole('menu', { name: 'Task tools', exact: true });
		await expect(reopened).toBeVisible();
		await reopened.getByRole('menuitem', { name: /New terminal/ }).click();
		await expect(page.locator('[data-work-area] [data-tool=terminal]')).toHaveCount(1);
		await expect(page.locator('[data-switch="work"]')).toHaveAttribute('aria-checked', 'true');
	} finally {
		await app.close();
	}
});

test('New file…: ⌥⌘N, a path with new folders, the file opens in the work area; the same path again offers Open @area:shell', async ({}, info) => {
	test.setTimeout(90000);
	const { app, repo } = await fixture('brigadir-new-file-');
	try {
		const page = await app.firstWindow();
		await app.evaluate(({ BrowserWindow }) =>
			BrowserWindow.getAllWindows()[0]!.setContentSize(1600, 900)
		);
		await page.getByRole('button', { name: /Work area fixture/ }).click();
		await expect(page.locator('[data-switch="work"]')).toHaveAttribute('aria-checked', 'false');
		// File ▸ New file… is ⌥⌘N; Tools has it first.
		expect((await appMenu(app, ['File', 'New file…'])).accelerator).toBe('CmdOrCtrl+Alt+N');
		const popover = page.getByRole('dialog', { name: 'New file', exact: true }),
			field = popover.getByRole('textbox', { name: 'File path' });
		await expect(field).toBeFocused();
		await expect(field).toHaveValue('');
		// Outside the task: Enter does nothing, the reason is under the field.
		await field.fill('../outside.ts');
		await expect(popover.getByRole('alert')).toHaveText('The path is outside the task');
		await field.press('Enter');
		await expect(popover).toBeVisible();
		await field.fill('src/new/Thing.ts');
		await expect(popover.getByRole('alert')).toHaveCount(0);
		await page.screenshot({ path: info.outputPath('new-file.png') });
		await field.press('Enter');
		await expect(popover).toHaveCount(0);
		await expect.poll(() => readFile(join(repo, 'src/new/Thing.ts'), 'utf8')).toBe('');
		await expect(page.getByRole('tab', { name: 'src/new/Thing.ts', exact: true })).toHaveAttribute(
			'aria-selected',
			'true'
		);
		await expect(page.locator('[data-switch="work"]')).toHaveAttribute('aria-checked', 'true');
		await expect(page.locator('[data-work-area] .cm-content')).toBeFocused();
		// The same path from Tools: prefilled with the active file's folder; it is there — Open.
		await page.getByRole('button', { name: 'Close file · src/new/Thing.ts' }).click();
		await expect(page.locator('[data-work-area]')).toHaveCount(0);
		await page.locator('[data-tools-button]').click();
		const tools = page.getByRole('menu', { name: 'Task tools', exact: true });
		await expect(tools.getByRole('menuitem').first()).toHaveText(/New file…/);
		await tools.getByRole('menuitem', { name: /New file…/ }).click();
		await expect(field).toBeFocused();
		await field.fill('src/new/Thing.ts');
		await field.press('Enter');
		await expect(popover.getByRole('status')).toContainText('File already exists');
		await popover.getByRole('button', { name: 'Open', exact: true }).click();
		await expect(popover).toHaveCount(0);
		await expect(page.getByRole('tab', { name: 'src/new/Thing.ts', exact: true })).toHaveAttribute(
			'aria-selected',
			'true'
		);
		await expect(page.locator('[data-work-area]')).toBeVisible();
		// The next one is prefilled with the active file's folder.
		await appMenu(app, ['File', 'New file…']);
		await expect(field).toHaveValue('src/new/');
		await page.keyboard.press('Escape');
		await expect(popover).toHaveCount(0);
	} finally {
		await app.close();
	}
});
