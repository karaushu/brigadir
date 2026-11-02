import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import type { SessionEvent } from '../packages/core/src/session';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
	hideChat,
	hidePanel,
	hideWorkArea,
	openPanelTab,
	showChat,
	showPanel,
	showWorkArea,
} from './layout';
import { openReview } from './open-review';
import { refreshChanges } from './refresh-changes';
const run = promisify(execFile);
const desktop = resolve('apps/desktop'),
	executablePath = createRequire(join(desktop, 'package.json'))('electron') as string;
const env = Object.fromEntries(
	Object.entries(process.env).filter(
		(e): e is [string, string] => typeof e[1] === 'string' && e[0] !== 'ELECTRON_RUN_AS_NODE'
	)
);
/** The browser tabs `surface.json` keeps: address → Desktop / Mobile and the tab's name. */
async function storedBrowsers(taskDir: string) {
	const found: Record<string, { tab: string; mobile: boolean }> = {};
	const walk = (node: any) => {
		if (node.kind === 'split') {
			walk(node.first);
			walk(node.second);
		} else
			for (const tab of node.tabs)
				if (tab.kind === 'browser') found[tab.url] = { tab: tab.tab, mobile: tab.mobile };
	};
	walk(JSON.parse(await readFile(join(taskDir, 'surface.json'), 'utf8')).surface.groups.root);
	return found;
}
/** The addresses of the pages main holds as live views (on screen or parked). */
const liveViews = (app: ElectronApplication) =>
	app.evaluate(({ webContents }) =>
		webContents
			.getAllWebContents()
			.map((web) => web.getURL())
			.filter((url) => url.startsWith('http://127.0.0.1'))
	);

// spec/task-window-workspace#restore-window: two groups with a file, a diff, a terminal and two browsers; widths and the panel tab changed;
// restart — everything is back, a browser loads when its tab is shown, the dirty buffer returns with the same text.
test('the task window opens as it was closed: groups, tabs, widths, panel, hot exit, lazy pages, ended terminal @area:shell', async ({}, info) => {
	test.setTimeout(150000);
	const root = await mkdtemp(join(tmpdir(), 'brigadir-surface-')),
		repo = join(root, 'repo'),
		data = join(root, 'data');
	await mkdir(repo);
	const git = (...args: string[]) => run('git', args, { cwd: repo });
	await git('init', '-q');
	await git('config', 'user.name', 'Fixture');
	await git('config', 'user.email', 'fixture@localhost');
	await writeFile(join(repo, 'a.ts'), 'export const a = 1;\n');
	await writeFile(join(repo, 'b.ts'), 'export const b = 1;\n');
	await git('add', '.');
	await git('commit', '-qm', 'Baseline');
	const taskDir = join(data, 'projects/project/tasks/task');
	await mkdir(taskDir, { recursive: true });
	await writeFile(
		join(data, 'projects/project/project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'repo', path: repo } })
	);
	await writeFile(
		join(taskDir, 'task.json'),
		JSON.stringify({
			schemaVersion: 1,
			task: {
				id: 'task',
				projectId: 'project',
				title: 'Surface fixture',
				status: 'done',
				provider: 'claude',
				transport: 'gui',
			},
		})
	);
	const server = createServer((req, res) => {
		res.setHeader('Content-Type', 'text/html; charset=utf-8');
		res.end(
			`<title>${req.url?.includes('one') ? 'Page one' : 'Page two'}</title><p>${req.url}</p>`
		);
	});
	await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
	const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	const launch = () =>
		electron.launch({
			executablePath,
			args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
			env: { ...env, BRIGADIR_DATA_DIR: data },
		});
	let app = await launch();
	try {
		let page = await app.firstWindow();
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		await app.evaluate(({ BrowserWindow }) =>
			BrowserWindow.getAllWindows()[0]!.setContentSize(1600, 900)
		);
		await page.getByRole('button', { name: /Surface fixture/ }).click();
		// A diff to keep: b.ts changed after the first snapshot.
		await refreshChanges(page);
		await expect
			.poll(() =>
				page.evaluate(
					async () =>
						(await window.brigadir.readChanges({ projectId: 'project', id: 'task' })).checkpoint
				)
			)
			.not.toBeNull();
		await writeFile(join(repo, 'b.ts'), 'export const b = 2;\n');
		await refreshChanges(page);
		// The file tab, with unsaved text.
		await openPanelTab(page, 'files');
		await page
			.getByRole('tree', { name: 'Project files' })
			.getByRole('treeitem', { name: 'a.ts', exact: true })
			.dblclick();
		const editor = () => page.getByRole('textbox', { name: 'File content' });
		await editor().click();
		await editor().press('Meta+End');
		await page.keyboard.insertText('// unsaved line');
		await expect(editor()).toContainText('// unsaved line');
		// The diff tab beside it.
		await openPanelTab(page, 'changes');
		await page
			.getByRole('list', { name: 'Files', exact: true })
			.getByRole('button', { name: /b.ts/ })
			.click();
		await expect(page.getByRole('log', { name: 'Diff', exact: true })).toContainText('b = 2');
		const groups = () => page.locator('[data-work-area] [data-editor-group]');
		await expect(groups()).toHaveCount(1);
		// A terminal and two pages in the bottom group.
		const tools = page.getByRole('menu', { name: 'Task tools', exact: true });
		await page.locator('[data-tools-button]').click();
		await tools.getByRole('menuitemradio', { name: 'In the bottom group' }).click();
		await page.locator('[data-tools-button]').click();
		await tools.getByRole('menuitem', { name: /New terminal/ }).click();
		await expect(groups()).toHaveCount(2);
		const bottom = groups().nth(1);
		await expect(bottom.locator('[data-tool=terminal]')).toHaveCount(1);
		for (const name of ['one', 'two']) {
			await page.locator('[data-tools-button]').click();
			await tools.getByRole('menuitem', { name: /New browser/ }).click();
			const address = page.getByRole('textbox', { name: 'Address' });
			await expect(address).toBeFocused();
			await address.fill(`${base}/${name}`);
			await address.press('Enter');
			await expect.poll(() => liveViews(app)).toContain(`${base}/${name}`);
		}
		await expect(bottom.locator('[data-tool=browser]')).toHaveCount(2);
		// spec/task-window-workspace#restore-window: the segment changes the active tab only — page two is Mobile, page one stays Desktop.
		const mobileRadio = () => groups().nth(1).getByRole('radio', { name: 'Mobile', exact: true });
		await mobileRadio().click();
		await expect(mobileRadio()).toHaveAttribute('aria-checked', 'true');
		await groups().nth(1).getByRole('tab').nth(1).click();
		await expect(mobileRadio()).toHaveAttribute('aria-checked', 'false');
		await groups().nth(1).getByRole('tab').nth(2).click();
		await expect(mobileRadio()).toHaveAttribute('aria-checked', 'true');
		// Widths and the panel tab.
		const chatWidth = () =>
			page
				.locator('[data-task-chat]')
				.evaluate((node) => Math.round(node.getBoundingClientRect().width));
		const before = await chatWidth();
		const chatHandle = page.getByRole('separator', { name: 'Resize chat' });
		await chatHandle.focus();
		await chatHandle.press('ArrowRight');
		await chatHandle.press('ArrowRight');
		await expect.poll(chatWidth).toBe(before + 40);
		await openPanelTab(page, 'files');
		const tabsOf = (index: number) =>
			groups()
				.nth(index)
				.getByRole('tab')
				.evaluateAll((list) =>
					list.map(
						(item) =>
							// spec/editor#document-tabs: an unsaved tab shows a dot named «Unsaved» in the ×'s place.
							`${(item.textContent ?? '').replace(/\s+/g, ' ').trim()}${item.querySelector('[aria-label=Unsaved]') ? ' •' : ''}${item.getAttribute('aria-selected') === 'true' ? '*' : ''}`
					)
				);
		const topTabs = await tabsOf(0),
			bottomTabs = await tabsOf(1);
		expect(topTabs).toHaveLength(2);
		expect(topTabs[0]).toContain('•');
		expect(bottomTabs).toHaveLength(3);
		expect(bottomTabs[2]).toMatch(/\*$/);
		// The file follows the change within 500 ms.
		await expect
			.poll(
				async () => {
					const text = await readFile(join(taskDir, 'surface.json'), 'utf8').catch(() => null);
					return text && JSON.parse(text).surface.panel.tab;
				},
				{
					timeout: 5000,
				}
			)
			.toBe('files');
		await page.screenshot({ path: info.outputPath('before.png') });

		// Quit: no question about the unsaved buffer (hot exit) — «Keep editing» here would hold the quit and the close
		// would time out; the window remembers its size.
		await app.evaluate(({ dialog }) => {
			dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
		});
		await app.close();
		const stored = JSON.parse(await readFile(join(taskDir, 'surface.json'), 'utf8'));
		expect(stored.schemaVersion).toBe(1);
		expect(JSON.stringify(stored)).toContain(`${base}/one`);
		expect(JSON.stringify(stored)).not.toMatch(/[a-f0-9]{64}/);
		const pages = await storedBrowsers(taskDir);
		expect(pages[`${base}/one`]?.mobile).toBe(false);
		expect(pages[`${base}/two`]?.mobile).toBe(true);
		const pageState = (tab: string) =>
			page.evaluate(
				(tab) =>
					window.brigadir.browserCommand(
						{ projectId: 'project', id: 'task' },
						{ kind: 'state', tab }
					),
				tab
			) as Promise<{ mobile: boolean }>;

		app = await launch();
		page = await app.firstWindow();
		page.on('pageerror', (e) => errors.push(e.message));
		// spec/sidebar#open-last: the app opens on the task; spec/task-window-workspace#restore-window: the task as it was.
		await expect(groups()).toHaveCount(2, { timeout: 15000 });
		await expect.poll(() => tabsOf(0)).toEqual(topTabs);
		await expect.poll(() => tabsOf(1)).toEqual(bottomTabs);
		await expect(page.locator('[data-panel-tab=files]')).toHaveAttribute('aria-selected', 'true');
		await expect.poll(chatWidth).toBe(before + 40);
		expect(
			await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getContentSize())
		).toEqual([1600, 900]);
		// Only the page on screen loaded; the other one waits for its tab.
		await expect.poll(() => liveViews(app)).toEqual([`${base}/two`]);
		await page.waitForTimeout(500);
		expect(await liveViews(app)).toEqual([`${base}/two`]);
		// Each page came back in its own mode.
		await expect(mobileRadio()).toHaveAttribute('aria-checked', 'true');
		expect((await pageState(pages[`${base}/two`]!.tab)).mobile).toBe(true);
		await groups().nth(1).getByRole('tab').nth(1).click();
		await expect.poll(() => liveViews(app)).toContain(`${base}/one`);
		await expect(mobileRadio()).toHaveAttribute('aria-checked', 'false');
		expect((await pageState(pages[`${base}/one`]!.tab)).mobile).toBe(false);
		// The console's session ended with the app (spec/terminal-and-cli-agents#console): the tab stays and opens a shell again.
		await groups().nth(1).getByRole('tab').nth(0).click();
		const ended = groups().nth(1).locator('[data-session-ended]');
		await expect(ended).toContainText('Session ended');
		await ended.getByRole('button', { name: 'Open again', exact: true }).click();
		await expect(ended).toHaveCount(0);
		await expect(groups().nth(1).locator('[data-tool=terminal]')).toHaveCount(1);
		await expect(groups().nth(1).locator('[data-role=console]')).toBeVisible();
		// The unsaved buffer: the same text, still dirty, and undo takes the edit back.
		await groups().nth(0).getByRole('tab').nth(0).click();
		await expect(editor()).toContainText('// unsaved line');
		await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
		await page.screenshot({ path: info.outputPath('after.png') });
		expect(errors).toEqual([]);
	} finally {
		await app
			.evaluate(({ dialog }) => {
				dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
			})
			.catch(() => {});
		await app.close().catch(() => {});
		server.close();
		await rm(root, { recursive: true, force: true });
	}
});

// spec/task-window-workspace#restore-window: the window paints the task as it was closed from its first frame — no default
// layout first and the restored one a few ms later. Every animation frame from the start of the renderer is sampled.
test('the first frame of the task is already the restored layout @area:shell', async () => {
	test.setTimeout(90000);
	const root = await mkdtemp(join(tmpdir(), 'brigadir-surface-paint-')),
		repo = join(root, 'repo'),
		data = join(root, 'data');
	await mkdir(repo);
	const git = (...args: string[]) => run('git', args, { cwd: repo });
	await git('init', '-q');
	await git('config', 'user.name', 'Fixture');
	await git('config', 'user.email', 'fixture@localhost');
	await writeFile(join(repo, 'a.ts'), 'export const a = 1;\n');
	await git('add', '.');
	await git('commit', '-qm', 'Baseline');
	const taskDir = join(data, 'projects/project/tasks/task');
	await mkdir(taskDir, { recursive: true });
	await writeFile(
		join(data, 'projects/project/project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'repo', path: repo } })
	);
	await writeFile(
		join(taskDir, 'task.json'),
		JSON.stringify({
			schemaVersion: 1,
			task: {
				id: 'task',
				projectId: 'project',
				title: 'Paint fixture',
				status: 'done',
				provider: 'claude',
				transport: 'gui',
			},
		})
	);
	const app = await electron.launch({
		executablePath,
		args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
		env: { ...env, BRIGADIR_DATA_DIR: data },
	});
	try {
		const page = await app.firstWindow();
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		await app.evaluate(({ BrowserWindow }) =>
			BrowserWindow.getAllWindows()[0]!.setContentSize(1600, 900)
		);
		await page.getByRole('button', { name: /Paint fixture/ }).click();
		// Not the default: a new task opens without the panel (spec/task-window-workspace#layout-switch) and with the shared chat width.
		await openPanelTab(page, 'files');
		// The chat has a width (and its handle) beside the work area, which comes with its first tab (spec/task-window-workspace#empty-work-area).
		await page
			.getByRole('tree', { name: 'Project files' })
			.getByRole('treeitem', { name: 'a.ts', exact: true })
			.dblclick();
		const chatWidth = () =>
			page
				.locator('[data-task-chat]')
				.evaluate((node) => Math.round(node.getBoundingClientRect().width));
		const before = await chatWidth();
		const chatHandle = page.getByRole('separator', { name: 'Resize chat' });
		await chatHandle.focus();
		for (let step = 0; step < 3; step++) await chatHandle.press('ArrowRight');
		await expect.poll(chatWidth).toBe(before + 60);
		const restored = {
			chat: 'true',
			work: await page.locator('[data-switch="work"]').getAttribute('aria-checked'),
			panel: 'true',
			tab: 'files',
			chatWidth: before + 60,
		};
		await expect
			.poll(
				async () => {
					const text = await readFile(join(taskDir, 'surface.json'), 'utf8').catch(() => null);
					if (!text) return null;
					const surface = JSON.parse(text).surface;
					return [surface.columns.panel, surface.panel.tab, surface.widths.chat];
				},
				{ timeout: 5000 }
			)
			.toEqual([true, 'files', restored.chatWidth]);
		// The renderer starts again from nothing, as at a launch: the selection, the workspace and the surface are read anew.
		await page.addInitScript(() => {
			const frames: unknown[] = [];
			(window as any).__taskFrames = frames;
			const sample = () => {
				const on = (name: string) =>
					document.querySelector(`[data-switch="${name}"]`)?.getAttribute('aria-checked') ?? null;
				if (document.querySelector('[data-switch="chat"]')) {
					const chat = document.querySelector('[data-task-chat]');
					frames.push({
						chat: on('chat'),
						work: on('work'),
						panel: on('panel'),
						tab:
							document
								.querySelector('[data-panel-tab][aria-selected="true"]')
								?.getAttribute('data-panel-tab') ?? null,
						chatWidth: chat ? Math.round(chat.getBoundingClientRect().width) : null,
					});
				}
				if (frames.length < 20) requestAnimationFrame(sample);
			};
			requestAnimationFrame(sample);
		});
		await page.reload();
		await expect
			.poll(() => page.evaluate(() => ((window as any).__taskFrames as unknown[]).length), {
				timeout: 15000,
			})
			.toBe(20);
		const frames = (await page.evaluate(() => (window as any).__taskFrames)) as (typeof restored)[];
		// The first frame with the task on screen and every one after it are the restored layout.
		expect(frames[0]).toEqual(restored);
		expect(frames.filter((frame) => JSON.stringify(frame) !== JSON.stringify(restored))).toEqual(
			[]
		);
		expect(errors).toEqual([]);
	} finally {
		await app.close().catch(() => {});
		await rm(root, { recursive: true, force: true });
	}
});

// Mixed documents (spec/task-window-workspace#layout-switch, spec/task-window-workspace#empty-work-area): drafts of the chat, the editor and the review and the keyboard of the tabs survive
// task switches, closing the last tab and a restart.
test('mixed documents keep drafts and keyboard navigation across task switches @area:shell', async () => {
	test.setTimeout(60000);
	const root = await mkdtemp(join(tmpdir(), 'brigadir-documents-')),
		repo = join(root, 'repo'),
		data = join(root, 'data');
	await mkdir(repo);
	const git = (...args: string[]) => run('git', args, { cwd: repo });
	await git('init', '-q');
	await git('config', 'user.name', 'Fixture');
	await git('config', 'user.email', 'fixture@localhost');
	await writeFile(join(repo, 'a.ts'), 'export const a = 1;\n');
	await writeFile(join(repo, 'b.ts'), 'export const b = 1;\n');
	await git('add', '.');
	await git('commit', '-qm', 'Baseline');
	const dir = join(data, 'projects/project');
	await mkdir(join(dir, 'tasks/first'), { recursive: true });
	await mkdir(join(dir, 'tasks/second'));
	await writeFile(
		join(dir, 'project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'repo', path: repo } })
	);
	for (const id of ['first', 'second'])
		await writeFile(
			join(dir, `tasks/${id}/task.json`),
			JSON.stringify({
				schemaVersion: 1,
				task: {
					id,
					projectId: 'project',
					title: `Documents ${id}`,
					status: 'done',
					provider: 'claude',
				},
			})
		);
	let app = await electron.launch({
		executablePath,
		args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
		env: { ...env, BRIGADIR_DATA_DIR: data },
	});
	try {
		const page = await app.firstWindow(),
			errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		await page.getByRole('button', { name: /Documents first/ }).click();
		await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Keep the chat draft.');
		await refreshChanges(page);
		await expect
			.poll(() =>
				page.evaluate(
					async () =>
						(await window.brigadir.readChanges({ projectId: 'project', id: 'first' })).checkpoint
				)
			)
			.not.toBeNull();
		await writeFile(join(repo, 'a.ts'), 'export const a = 2;\n');
		await refreshChanges(page);
		await openPanelTab(page, 'changes');
		const files = page.getByRole('list', { name: 'Files', exact: true });
		await files.getByRole('button', { name: /a.ts/ }).click();
		const diff = page.getByRole('log', { name: 'Diff', exact: true });
		await expect(diff).toContainText('a = 2');
		await page.getByRole('button', { name: 'Open in editor', exact: true }).click();
		const editor = page.getByRole('textbox', { name: 'File content' });
		await expect(editor).toContainText('a = 2');
		const tabs = page.getByRole('tablist', { name: 'Documents' });
		await expect(tabs.getByRole('tab')).toHaveCount(2);
		await page.getByRole('tab', { name: 'a.ts', exact: true }).press('ArrowLeft');
		await expect(page.getByRole('tab', { name: 'Diff · a.ts', exact: true })).toBeFocused();
		await expect(diff).toBeVisible();
		await files.getByRole('button', { name: /a.ts/ }).click();
		await expect(tabs.getByRole('tab')).toHaveCount(2);
		await page.getByRole('tab', { name: 'Diff · a.ts', exact: true }).press('End');
		await expect(editor).toBeVisible();
		await editor.click();
		await editor.press('Meta+a');
		await page.keyboard.insertText('unsaved document');
		await page.getByRole('button', { name: 'Close diff · a.ts', exact: true }).click();
		await expect(editor).toContainText('unsaved document');
		await expect(tabs.getByRole('tab')).toHaveCount(1);
		await files.getByRole('button', { name: /a.ts/ }).click();
		await expect(tabs.getByRole('tab')).toHaveCount(2);
		await page.evaluate(() =>
			window.brigadir.addReviewNote({ projectId: 'project', id: 'first' }, 'Seed note.')
		);
		await page.getByRole('textbox', { name: 'General note' }).fill('Keep the review draft.');
		await openReview(page);
		const review = page.getByRole('dialog', { name: 'Review', exact: true });
		await expect(review.locator('[data-review-footer]')).toHaveCount(0);
		await review.press('Escape');
		await expect(diff).toBeVisible();
		const footer = page.locator('[data-review-footer]'),
			compact = page.getByRole('button', { name: /^(Expand|Collapse) review panel$/ }),
			note = page.getByRole('textbox', { name: 'General note', exact: true });
		await compact.focus();
		await compact.press('Space');
		await expect(compact).toHaveAttribute('aria-expanded', 'false');
		await expect(note).toBeHidden();
		await expect(page.getByRole('button', { name: 'Add note', exact: true })).toBeHidden();
		await page.getByRole('button', { name: /Documents second/ }).click();
		// spec/task-window-workspace#layout-switch: the second task's work area is on screen too, with no tabs of its own.
		await expect(tabs.getByRole('tab')).toHaveCount(0);
		await page.getByRole('button', { name: /Documents first/ }).click();
		await expect(tabs.getByRole('tab')).toHaveCount(2);
		await expect(diff).toBeVisible();
		await expect(compact).toHaveAttribute('aria-expanded', 'false');
		await expect(note).toBeHidden();
		await compact.click();
		await expect(note).toHaveValue('Keep the review draft.');
		await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveText(
			'Keep the chat draft.'
		);
		await page.getByRole('tab', { name: 'a.ts', exact: true }).click();
		await expect(editor).toContainText('unsaved document');
		await editor.press('Meta+z');
		await expect(editor).toContainText('a = 2');
		await editor.press('Meta+Shift+z');
		await page.getByRole('textbox', { name: 'Message', exact: true }).focus();
		await app.evaluate(({ Menu }) =>
			Menu.getApplicationMenu()!
				.items.find((item) => item.label === 'Editor')!
				.submenu!.items.find((item) => item.label === 'Toggle comment')!
				.click()
		);
		await expect(editor).toContainText('unsaved document');
		await expect(editor).not.toContainText('//');
		await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveText(
			'Keep the chat draft.'
		);
		await compact.click();
		await expect(note).toBeHidden();
		await openReview(page);
		await expect(review.locator('[data-review-footer]')).toHaveCount(0);
		await review.press('Escape');
		await expect(compact).toHaveAttribute('aria-expanded', 'false');
		await compact.click();
		await expect(note).toHaveValue('Keep the review draft.');
		await page.getByRole('button', { name: 'Close file · a.ts', exact: true }).click();
		await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
		await expect(editor).toContainText('unsaved document');
		await page.getByRole('button', { name: 'Close file · a.ts', exact: true }).click();
		await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
		await expect(diff).toBeVisible();
		expect(await readFile(join(repo, 'a.ts'), 'utf8')).toContain('a = 2');
		await page.getByRole('button', { name: 'Close diff · a.ts', exact: true }).click();
		await expect(tabs.getByRole('tab')).toHaveCount(0);
		// spec/task-window-workspace#empty-work-area: the work area goes with its last tab; the review with its comments stands under the chat (spec/diff-and-review#footer).
		await expect(page.locator('[data-work-area]')).toHaveCount(0);
		await expect(page.locator('[data-task-chat] [data-review-footer]')).toHaveCount(1);
		await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveText(
			'Keep the chat draft.'
		);
		// Another task opens with its own layout: a new one has no panel (spec/task-window-workspace#layout-switch).
		await page.getByRole('button', { name: /Documents second/ }).click();
		await expect(page.locator('[data-task-chat]')).toBeVisible();
		await expect(page.getByRole('complementary', { name: 'Changes', exact: true })).toHaveCount(0);
		expect(errors).toEqual([]);
		await app.close();
		app = await electron.launch({
			executablePath,
			args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
			env: { ...env, BRIGADIR_DATA_DIR: data },
		});
		const reopened = await app.firstWindow();
		await reopened.getByRole('button', { name: /Documents first/ }).click();
		await expect(reopened.locator('[data-columns="3"]')).toBeVisible();
		await expect(reopened.getByRole('radio', { name: 'Chat', exact: true })).toHaveCount(0);
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});

// Task chrome: the composer and review drafts and the panel Layout are per task; Search Everywhere tabs and files.
test('task chrome preserves drafts and panel state per task; Search Everywhere tabs through its lists @area:shell', async ({}, info) => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-task-design-'));
	const taskDir = join(root, 'data/projects/project/tasks/task');
	await mkdir(taskDir, { recursive: true });
	await writeFile(
		join(taskDir, '../../project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'choice', path: root } })
	);
	const title = 'Fix the Button focus ring';
	await writeFile(
		join(taskDir, 'task.json'),
		JSON.stringify({
			schemaVersion: 1,
			task: { id: 'task', projectId: 'project', title, status: 'done', provider: 'claude' },
		})
	);
	const second = join(taskDir, '../second');
	await mkdir(second);
	await writeFile(
		join(second, 'task.json'),
		JSON.stringify({
			schemaVersion: 1,
			task: {
				id: 'second',
				projectId: 'project',
				title: 'Review the API changes',
				status: 'queued',
				provider: 'codex',
			},
		})
	);
	await mkdir(join(root, 'src'));
	await writeFile(join(root, 'src/Button.module.css'), '.button { color: red; }\n');
	// A saved synthetic journal. No live provider, task start or repository write.
	const events: SessionEvent[] = [
		{
			kind: 'session.started',
			sessionId: 'fixture',
			modes: [],
			modeId: null,
			options: [
				{
					id: 'model',
					name: 'Model',
					description: null,
					category: 'model',
					kind: 'select',
					value: 'fixture-model',
					choices: [
						{ value: 'fixture-model', name: 'Fixture model', description: null, group: null },
					],
				},
			],
		},
		{
			kind: 'turn.started',
			text: 'Fix the focus ring on the Button. It disappears when you Tab into it in Safari.',
		},
		{
			kind: 'message.delta',
			role: 'assistant',
			messageId: 'intro',
			content: {
				kind: 'text',
				text: 'I checked `Button.module.css`. The focus rule removes the outline. I will keep the ring visible when you use the keyboard.',
			},
		},
		{
			kind: 'tool.changed',
			patch: {
				id: 'read',
				category: 'read',
				title: 'Read Button.module.css',
				status: 'completed',
				output: '.button:focus { outline: none; }',
			},
		},
		{
			kind: 'tool.changed',
			patch: {
				id: 'test',
				category: 'execute',
				title: 'pnpm test Button',
				status: 'failed',
				output: 'FAIL Button keeps the ring on Tab\nExpected a visible outline; received none.',
			},
		},
		{
			kind: 'plan.changed',
			entries: [{ text: 'Find the cause', priority: 'medium', status: 'pending' }],
		},
		{
			kind: 'plan.changed',
			entries: [
				{ text: 'Find the cause', priority: 'medium', status: 'completed' },
				{ text: 'Fix the ring', priority: 'medium', status: 'in_progress' },
				{ text: 'Check Safari', priority: 'medium', status: 'pending' },
			],
		},
		{
			kind: 'message.delta',
			role: 'assistant',
			messageId: 'result',
			content: {
				kind: 'text',
				text: 'The keyboard focus rule now sets `outline: 2px solid var(--focus-ring)` and `outline-offset: 2px`.\n\nPlease check the result in Safari before merging.',
			},
		},
		{ kind: 'turn.completed', reason: 'end_turn' },
		{ kind: 'host.stopped', reason: 'Fixture is offline' },
	];
	const journal =
		events
			.map((event, i) =>
				JSON.stringify({ schemaVersion: 1, seq: i + 1, at: '2026-09-10T10:00:00Z', event })
			)
			.join('\n') + '\n';
	await writeFile(join(taskDir, 'events.jsonl'), journal);
	const app = await electron.launch({
		executablePath,
		args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
		env: { ...env, BRIGADIR_DATA_DIR: join(root, 'data') },
	});
	try {
		const page = await app.firstWindow();
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 800));
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		await page.getByRole('button', { name: new RegExp(title) }).click();
		await expect(page.getByRole('heading', { name: title, exact: true })).toHaveCount(1);
		await expect(page.getByRole('log')).toContainText('Please check the result in Safari');
		// spec/chat-turns-plans-and-questions#plan-row: one plan row per turn, folded like a tool call; the chevron lists the steps.
		const planRow = page.locator('[data-plan-row]');
		await expect(planRow).toHaveCount(1);
		await expect(planRow.locator('summary')).toContainText('1/3');
		await expect(planRow.locator('summary')).toContainText('Fix the ring');
		await expect(planRow.locator('li', { hasText: 'Find the cause' })).toHaveAttribute(
			'data-state',
			'done'
		);
		await expect(planRow.locator('li')).toHaveCount(3);
		await expect(planRow.locator('li').first()).toBeHidden();
		await planRow.locator('summary').click();
		await expect(planRow.locator('li').first()).toBeVisible();
		await expect(planRow.locator('li', { hasText: 'Fix the ring' })).toHaveAttribute(
			'data-state',
			'working'
		);
		await expect(planRow.locator('li', { hasText: 'Check Safari' })).toHaveAttribute(
			'data-state',
			'queued'
		);
		await planRow.locator('summary').click();
		await expect(planRow.locator('li').first()).toBeHidden();
		await expect(page.getByRole('textbox', { name: 'General note' })).toHaveCount(0);
		const toggle = page.locator('[data-panel-tab=changes]');
		await showPanel(page);
		await toggle.click();
		await expect(toggle).toHaveAttribute('aria-selected', 'true');
		// spec/task-window-workspace#layout-switch: the panel hides with its Layout switch, not by its selected tab.
		await hidePanel(page);
		await expect(page.getByRole('complementary', { name: 'Changes', exact: true })).toHaveCount(0);
		const composer = page.getByRole('textbox', { name: 'Message', exact: true });
		await composer.fill('Also check the disabled Button.');
		// spec/task-window-workspace#layout-switch: each task keeps its own Layout; another task opens without the panel and gets it, this one comes back without.
		await page.getByRole('button', { name: /Review the API changes/ }).click();
		await expect(page.getByRole('complementary', { name: 'Changes', exact: true })).toHaveCount(0);
		await showPanel(page);
		await expect(page.getByRole('complementary', { name: 'Changes', exact: true })).toHaveCount(1);
		await page.getByRole('button', { name: new RegExp(title) }).click();
		await expect(page.getByRole('complementary', { name: 'Changes', exact: true })).toHaveCount(0);
		await expect(composer).toHaveText('Also check the disabled Button.');
		await app.evaluate(({ Menu }) =>
			Menu.getApplicationMenu()!
				.items.find((item) => item.label === 'View')!
				.submenu!.items.find((item) => item.label === 'Show files')!
				.click()
		);
		await expect(page.getByRole('radiogroup', { name: 'Panels (closed)' })).toHaveCount(0);
		await expect(page.locator('[data-panel-tab=files]')).toHaveAttribute('aria-selected', 'true');
		await hideChat(page);
		// An empty review has no footer; it appears with the first note.
		await expect(page.locator('[data-review-footer]')).toHaveCount(0);
		await page.evaluate(() =>
			window.brigadir.addReviewNote({ projectId: 'project', id: 'task' }, 'Seed note.')
		);
		await openReview(page);
		await page.getByRole('dialog', { name: 'Review', exact: true }).press('Escape');
		await page.getByRole('textbox', { name: 'General note' }).fill('Keep this review note.');
		await openReview(page);
		await page
			.getByRole('dialog', { name: 'Review', exact: true })
			.getByRole('button', { name: 'Close', exact: true })
			.click();
		// spec/task-window-workspace#empty-work-area: without the work area the review footer stands under the chat and keeps its draft.
		await showChat(page);
		await hideWorkArea(page);
		await expect(page.locator('[data-task-chat] [data-review-footer]')).toHaveCount(1);
		await showWorkArea(page);
		await expect(page.getByRole('textbox', { name: 'General note' })).toHaveValue(
			'Keep this review note.'
		);
		await showChat(page);
		await expect(composer).toHaveText('Also check the disabled Button.');
		await page.getByRole('button', { name: 'Search Everywhere', exact: true }).click();
		const search = page.getByRole('dialog', { name: 'Search Everywhere', exact: true }),
			query = search.getByRole('combobox', { name: 'Search', exact: true });
		const tab = (name: string) => search.getByRole('tab', { name, exact: true });
		await expect(tab('All')).toHaveAttribute('aria-selected', 'true');
		await tab('Agents').click();
		await query.fill('API');
		await expect(search.getByRole('option')).toHaveCount(1);
		await expect(query).toHaveAttribute('aria-activedescendant', /./);
		await search.getByRole('button', { name: 'Close', exact: true }).focus();
		await search.getByRole('button', { name: 'Close', exact: true }).press('Enter');
		await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
		await page.getByRole('button', { name: 'Search Everywhere', exact: true }).click();
		await tab('Agents').click();
		await query.fill('Button');
		await expect(search.getByRole('option')).toHaveCount(1);
		for (const theme of ['light', 'dark'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await page.screenshot({
				animations: 'disabled',
				path: info.outputPath(`search-${theme}.png`),
			});
		}
		await app.evaluate(({ ipcMain }) => {
			const handlers = (ipcMain as any)._invokeHandlers,
				original = handlers.get('files:search');
			(globalThis as any).restoreSearch = () => handlers.set('files:search', original);
			handlers.set('files:search', async (...args: any[]) => {
				await new Promise<void>((resolve) => {
					(globalThis as any).releaseSearch = resolve;
				});
				return original(...args);
			});
		});
		await query.press('Tab');
		await expect(tab('Files')).toHaveAttribute('aria-selected', 'true');
		await expect(query).toBeFocused();
		await expect(search.getByRole('status')).toBeVisible();
		await expect
			.poll(() => app.evaluate(() => typeof (globalThis as any).releaseSearch))
			.toBe('function');
		// spec/search-menus-and-commands#search-tabs: Tab goes All → Agents → Files → Text → PR → Commands → Actions → All.
		for (const name of ['Text', 'PR', 'Commands', 'Actions', 'All']) {
			await query.press('Tab');
			await expect(tab(name)).toHaveAttribute('aria-selected', 'true');
		}
		await query.press('Tab');
		await expect(tab('Agents')).toHaveAttribute('aria-selected', 'true');
		await expect(search.getByRole('option')).toHaveCount(1);
		await expect(search.getByRole('status')).toHaveCount(0);
		await app.evaluate(() => {
			(globalThis as any).restoreSearch();
			(globalThis as any).releaseSearch();
		});
		await query.fill('no-such-task');
		await expect(search.getByRole('option')).toHaveCount(0);
		await query.press('Tab');
		await query.fill('btnmod');
		const file = search.getByRole('option');
		await expect(file).toHaveCount(1);
		await query.press('Enter');
		await expect(search).toHaveCount(0);
		await expect(page.getByRole('textbox', { name: 'File content', exact: true })).toContainText(
			'.button'
		);
		expect(errors).toEqual([]);
		expect(await readFile(join(taskDir, 'events.jsonl'), 'utf8')).toBe(journal);
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
