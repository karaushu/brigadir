import {
	_electron as electron,
	expect,
	test,
	type ElectronApplication,
	type Page,
} from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hideChat, openPanelTab, showChat } from './layout';
const desktop = resolve('apps/desktop'),
	executablePath = createRequire(join(desktop, 'package.json'))('electron') as string;
const env = Object.fromEntries(
	Object.entries(process.env).filter(
		(entry): entry is [string, string] =>
			typeof entry[1] === 'string' && entry[0] !== 'ELECTRON_RUN_AS_NODE'
	)
);
const day = 86_400_000;
type Fixture = { id: string; title: string; status: string; extra?: Record<string, unknown> };
async function fixture(
	name: string,
	tasks: Fixture[],
	settings: Record<string, unknown> = { appearance: 'light', language: 'en' }
) {
	const root = await mkdtemp(join(tmpdir(), `brigadir-${name}-`)),
		repo = join(root, 'repo'),
		data = join(root, 'data'),
		dir = join(data, 'projects/project');
	await mkdir(repo);
	const git = (...args: string[]) => promisify(execFile)('git', args, { cwd: repo });
	await git('init', '-b', 'main');
	await git('config', 'user.name', 'Fixture');
	await git('config', 'user.email', 'fixture@example.invalid');
	await writeFile(join(repo, 'file.txt'), 'before\n');
	await git('add', '.');
	await git('commit', '-m', 'Initial');
	await mkdir(dir, { recursive: true });
	await writeFile(
		join(dir, 'project.json'),
		JSON.stringify({
			schemaVersion: 1,
			project: { id: 'project', name: 'Archive project', path: repo },
		})
	);
	for (const task of tasks) {
		await mkdir(join(dir, 'tasks', task.id), { recursive: true });
		await writeFile(
			join(dir, 'tasks', task.id, 'task.json'),
			JSON.stringify({
				schemaVersion: 1,
				task: {
					id: task.id,
					projectId: 'project',
					title: task.title,
					provider: 'claude',
					status: task.status,
					...task.extra,
				},
			})
		);
	}
	await writeFile(join(data, 'settings.json'), JSON.stringify({ schemaVersion: 1, settings }));
	const app = await electron.launch({
		executablePath,
		args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
		env: {
			...env,
			BRIGADIR_DATA_DIR: data,
			BRIGADIR_TEST_AGENT: resolve('packages/transport/fixtures/agent.mjs'),
		},
	});
	await app.evaluate(({ Menu, dialog, shell }, root) => {
		const state = globalThis as any;
		state.menu = null;
		state.response = 0;
		state.confirmations = [];
		Menu.prototype.popup = function (options) {
			state.menu = this;
			state.closed = options?.callback;
		};
		dialog.showMessageBox = async (_window: any, options?: any) => {
			state.confirmations.push(options);
			return { response: state.response, checkboxChecked: false };
		};
		shell.trashItem = async (path) => {
			const fs = (process as any).mainModule.require('node:fs/promises');
			await fs.rename(path, `${root}/trash-${Date.now()}-${Math.random()}`);
		};
	}, root);
	const page = await app.firstWindow();
	return {
		root,
		repo,
		data,
		dir,
		app,
		page,
		git,
		task: async (id: string) =>
			JSON.parse(await readFile(join(dir, 'tasks', id, 'task.json'), 'utf8')).task,
	};
}
async function menu(app: ElectronApplication) {
	await expect.poll(() => app.evaluate(() => !!(globalThis as any).menu)).toBe(true);
	return app.evaluate(() =>
		(globalThis as any).menu.items
			.filter((item: any) => item.label)
			.map((item: any) => ({
				label: item.label as string,
				enabled: item.enabled as boolean,
				accelerator: item.accelerator as string | undefined,
			}))
	);
}
async function choose(app: ElectronApplication, label: string) {
	await menu(app);
	await app.evaluate((_, label) => {
		const state = globalThis as any,
			item = state.menu.items.find((item: any) => item.label === label);
		if (!item?.enabled) throw new Error(`Unavailable: ${label}`);
		item.click();
		state.closed?.();
		state.menu = null;
	}, label);
}
async function closeMenu(app: ElectronApplication) {
	await app.evaluate(() => {
		const state = globalThis as any;
		state.closed?.();
		state.menu = null;
	});
}
const clickMenuItem = (app: ElectronApplication, id: string) =>
	app.evaluate(({ Menu }, id) => {
		const item = Menu.getApplicationMenu()!.getMenuItemById(id)!;
		if (!item.enabled) throw new Error(`Disabled: ${id}`);
		item.click();
	}, id);
const menuItemEnabled = (app: ElectronApplication, id: string) =>
	app.evaluate(({ Menu }, id) => Menu.getApplicationMenu()!.getMenuItemById(id)?.enabled, id);
const sidebar = (page: Page) => page.getByRole('complementary', { name: 'Projects', exact: true });

test('archive by menu, ⌃⌘A, swipe and the delete sheet; the section, the toast and Restore; the window with search, filters and delete (spec/tasks#archive) @area:tasks', async () => {
	test.setTimeout(120000);
	const old = (days: number) => new Date(Date.now() - days * day).toISOString();
	const { root, app, page, task } = await fixture('archive', [
		{ id: 'one', title: 'Task one', status: 'done' },
		{ id: 'two', title: 'Task two', status: 'completed', extra: { completedAt: old(1) } },
		{ id: 'wait', title: 'Waiting task', status: 'queued' },
		{ id: 'swipe', title: 'Swipe task', status: 'completed', extra: { completedAt: old(1) } },
		...['Archived alpha', 'Archived beta', 'Archived gamma', 'Archived delta'].map(
			(title, index) => ({
				id: `a${index}`,
				title,
				status: 'completed',
				extra: {
					completedAt: old(20),
					archived: {
						at: old(index + 2),
						by: index % 2 ? 'auto' : 'manual',
						status: 'completed',
						worktree: 'none',
					},
					prompt: `Prompt of ${title}`,
				},
			})
		),
	]);
	try {
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		const bar = sidebar(page);
		const card = (title: string) => bar.locator('[data-sidebar-task]', { hasText: title });
		await expect(card('Task one')).toBeVisible();
		await expect(card('Archived alpha')).toHaveCount(0);
		// No archive section in the task list: the count sits on mini buttons (all projects, the project row) and on the project screen.
		await expect(bar.locator('[data-archive-section]')).toHaveCount(0);
		await expect(bar.locator('[data-archive-scope=all]')).toHaveAttribute(
			'aria-label',
			'Archive · 4'
		);
		await expect(bar.locator('[data-archive-scope=project]')).toHaveAttribute(
			'aria-label',
			'Archive · 4'
		);
		// Card menu: Archive ⌃⌘A before Delete task…, off for a task that waits to launch.
		await card('Waiting task').click({ button: 'right' });
		const waiting = await menu(app);
		const index = waiting.findIndex((item: { label: string }) => item.label === 'Archive');
		// The key of Archive task in the keymap, the one the menu bar has (spec/architecture-and-platform#window-frame), not a fixed literal.
		expect(waiting[index]).toMatchObject({ enabled: false, accelerator: 'Ctrl+CmdOrCtrl+A' });
		expect(waiting[index + 1]?.label).toBe('Delete task…');
		await closeMenu(app);
		await card('Task one').click({ button: 'right' });
		await choose(app, 'Archive');
		await expect(card('Task one')).toHaveCount(0);
		await expect(bar.locator('[data-archive-toast]')).toContainText('«Task one» is in the archive');
		expect((await task('one')).archived).toMatchObject({
			by: 'manual',
			status: 'done',
			worktree: 'none',
		});
		await bar.locator('[data-archive-toast]').getByRole('button', { name: 'Restore' }).click();
		await expect(card('Task one')).toBeVisible();
		expect((await task('one')).archived).toBeUndefined();
		// ⌃⌘A from the menu bar acts on the open task and only while it can be archived.
		await card('Task one').click();
		await expect.poll(() => menuItemEnabled(app, 'archive-task')).toBe(true);
		await clickMenuItem(app, 'archive-task');
		await expect(card('Task one')).toHaveCount(0);
		await expect.poll(async () => (await task('one')).archived?.by).toBe('manual');
		// The open archived task reads as before: the strip and a composer that waits for Restore.
		await expect(page.locator('[data-archived-strip]')).toContainText(
			'The task is in the archive. The transcript is read-only.'
		);
		await expect(page.locator('form[data-archived=true]')).toHaveAttribute('inert', '');
		expect(await menuItemEnabled(app, 'archive-task')).toBe(false);
		await page
			.locator('[data-archived-strip]')
			.getByRole('button', { name: 'Restore from archive' })
			.click();
		await expect(card('Task one')).toBeVisible();
		await expect(page.locator('[data-archived-strip]')).toHaveCount(0);
		// The delete sheet offers Archive first and by default.
		await card('Task two').click({ button: 'right' });
		await choose(app, 'Delete task…');
		await expect.poll(() => app.evaluate(() => (globalThis as any).confirmations.length)).toBe(1);
		const sheet = await app.evaluate(() => (globalThis as any).confirmations[0]);
		expect(sheet.buttons).toEqual(['Archive', 'Delete task', 'Cancel']);
		expect(sheet).toMatchObject({ defaultId: 0, cancelId: 2 });
		expect(sheet.detail).toContain(
			'Keeps the task and history. Removes its clean worktree; preserves uncommitted changes.'
		);
		await expect(card('Task two')).toHaveCount(0);
		expect((await task('two')).archived).toMatchObject({ status: 'completed' });
		// Two fingers left over a card: a short swipe springs back, a full one archives a completed task (spec/tasks#archive-actions: a task in progress is completed instead).
		const swipe = card('Swipe task');
		await swipe.hover();
		await page.mouse.wheel(40, 0);
		await expect(bar.locator('[data-swipe][data-swiping=true]')).toHaveCount(1);
		await expect(bar.locator('[data-swipe][data-swiping=true]')).toHaveCount(0);
		await expect(swipe).toBeVisible();
		await swipe.hover();
		for (let step = 0; step < 4; step++) await page.mouse.wheel(40, 0);
		await expect(swipe).toHaveCount(0);
		await expect.poll(async () => (await task('swipe')).archived?.status).toBe('completed');
		// The window from the project row's mini button: this project, search, Manual/Auto, preview, multi-select, delete.
		await bar.locator('[data-archive-scope=project]').click();
		const win = page.locator('[data-archive-window]');
		await expect(win).toBeVisible();
		await expect(win.locator('[data-archive-item]')).toHaveCount(6);
		await expect(win.getByRole('searchbox').or(win.locator('input'))).toBeFocused();
		await win.locator('input').fill('beta');
		await expect(win.locator('[data-archive-item]')).toHaveCount(1);
		await expect(win.locator('[data-archive-preview]')).toContainText('Prompt of Archived beta');
		await win.locator('input').fill('nothing like it');
		await expect(win).toContainText('The archive has no «nothing like it».');
		await win.locator('input').fill('');
		await win.getByRole('radio', { name: 'Auto', exact: true }).click();
		await expect(win.locator('[data-archive-item]')).toHaveCount(2);
		await win.getByRole('radio', { name: 'Manually' }).click();
		await expect(win.locator('[data-archive-item]')).toHaveCount(4);
		await win.getByRole('radio', { name: 'All', exact: true }).click();
		await win
			.locator('[data-archive-item]')
			.filter({ hasText: 'Archived alpha' })
			.locator('button')
			.first()
			.click();
		await win.locator('[data-archive-preview] [data-archive-restore]').click();
		await expect(card('Archived alpha')).toBeVisible();
		await expect(win.locator('[data-archive-item]')).toHaveCount(5);
		await win
			.locator('[data-archive-item]')
			.filter({ hasText: 'Archived gamma' })
			.locator('button')
			.first()
			.click();
		await win
			.locator('[data-archive-item]')
			.filter({ hasText: 'Archived delta' })
			.locator('button')
			.first()
			.click({ modifiers: ['Meta'] });
		await expect(win.locator('[data-archive-preview]')).toContainText('Selected 2');
		await win.getByRole('button', { name: 'Delete…' }).click();
		const confirm = page.locator('[data-archive-delete]');
		await expect(confirm).toContainText('Delete 2 tasks from the archive?');
		await confirm.getByRole('button', { name: 'Delete', exact: true }).click();
		await expect(win.locator('[data-archive-item]')).toHaveCount(3);
		await expect(access(join(root, 'data/projects/project/tasks/a2'))).rejects.toThrow();
		await page.keyboard.press('Escape');
		await expect(win).toHaveCount(0);
		// ⌥⌘A from the menu bar and the header button open the window on every project.
		await clickMenuItem(app, 'archive');
		await expect(win).toBeVisible();
		await page.keyboard.press('Escape');
		await bar.locator('[data-archive-scope=all]').click();
		await expect(win).toBeVisible();
		await win.getByRole('button', { name: 'Close' }).click();
		await expect(win).toHaveCount(0);
		// The labelled button on the project screen, then the right-click menu of a row: Open, Restore, Delete in red.
		await bar.locator('[class*=projectSelect]').first().click();
		const screen = page.locator('[data-archive-scope=screen]');
		await expect(screen).toContainText('Archive');
		await screen.click();
		await expect(win).toBeVisible();
		await win.locator('[data-archive-item]').first().click({ button: 'right' });
		expect((await menu(app)).map((item: { label: string }) => item.label)).toEqual([
			'Open task',
			'Restore from archive',
			'Show task diff',
			'Copy task title',
			'Delete task…',
		]);
		await closeMenu(app);
		await win.locator('[data-archive-item]').first().click({ button: 'right' });
		await choose(app, 'Delete task…');
		await expect
			.poll(() => app.evaluate(() => (globalThis as any).confirmations.length))
			.toBeGreaterThan(0);
		await app.evaluate(() => {
			(globalThis as any).confirmations.length = 0;
		});
		const del = win.locator('[data-archive-preview]').getByRole('button', { name: 'Delete' });
		await expect(del).toBeVisible();
		// spec/tasks#archive-window: a red edge and red text at rest, the red fill on hover (ui Button variant outline).
		await expect(del).toHaveAttribute('data-variant', 'outline');
		await expect(del).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
		expect(await del.evaluate((el) => getComputedStyle(el).boxShadow)).toContain('inset');
		const red = await del.evaluate((el) => {
			const probe = document.createElement('i');
			probe.style.color = 'var(--red-fill)';
			el.append(probe);
			const value = getComputedStyle(probe).color;
			probe.remove();
			return value;
		});
		await del.hover();
		await expect(del).toHaveCSS('background-color', red);
		await expect(del).toHaveCSS('box-shadow', 'none');
		await win.getByRole('button', { name: 'Close' }).click();
		await expect(win).toHaveCount(0);
		// Search Everywhere: archived matches as their own group; ⌘↩ restores.
		await clickMenuItem(app, 'search');
		const search = page.getByRole('dialog', { name: 'Search Everywhere' });
		await search.getByRole('combobox').fill('beta');
		await expect(search.locator('[data-search-group=archive]')).toContainText('In the archive');
		const hit = search.locator('button[data-archived=true]');
		await expect(hit).toContainText('Archived beta');
		await hit.hover();
		await expect(hit).toHaveAttribute('aria-selected', 'true');
		await search.getByRole('combobox').press('Meta+Enter');
		await expect.poll(async () => (await task('a1')).archived).toBeUndefined();
		await page.keyboard.press('Escape');
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});

test('the swipe completes a task in progress with Restore in the toast, archives a completed one and does nothing over a queued one (spec/tasks#archive-actions) @area:tasks', async () => {
	test.setTimeout(90000);
	const { root, app, page, task } = await fixture('swipe-complete', [
		{ id: 'done', title: 'Done task', status: 'done' },
		{ id: 'stopped', title: 'Stopped task', status: 'interrupted' },
		{
			id: 'finished',
			title: 'Finished task',
			status: 'completed',
			extra: { completedAt: new Date(Date.now() - day).toISOString() },
		},
		{ id: 'busy', title: 'Busy task', status: 'queued' },
	]);
	try {
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		const bar = sidebar(page),
			toast = bar.locator('[data-archive-toast]');
		const card = (title: string) => bar.locator('[data-sidebar-task]', { hasText: title });
		const swipe = async (title: string) => {
			await card(title).hover();
			for (let step = 0; step < 4; step++) await page.mouse.wheel(40, 0);
		};
		await expect(card('Busy task')).toBeVisible();
		// A task in progress with no agent at work: the green Complete action, then the task moves to Completed.
		await card('Done task').hover();
		await page.mouse.wheel(40, 0);
		const action = bar.locator('[data-swipe][data-swiping=true] [data-swipe-action]');
		await expect(action).toHaveAttribute('data-swipe-action', 'complete');
		await expect(action).toContainText('Complete');
		await expect(action.locator('[data-glyph=agent-idle]')).toHaveCount(1);
		await expect(action).toHaveCSS('background-color', 'rgb(26, 127, 55)');
		await expect(bar.locator('[data-swipe][data-swiping=true]')).toHaveCount(0);
		expect((await task('done')).status).toBe('done');
		await swipe('Done task');
		await expect.poll(async () => (await task('done')).status).toBe('completed');
		expect((await task('done')).archived).toBeUndefined();
		await expect(toast).toContainText('“Done task” completed');
		await expect(toast).toHaveAttribute('data-archive-toast', 'complete');
		// Restore puts it back into progress as Done, like dragging it out of Completed on the board.
		await toast.getByRole('button', { name: 'Restore' }).click();
		await expect.poll(async () => (await task('done')).status).toBe('done');
		await expect(toast).toHaveCount(0);
		await expect(card('Done task')).toBeVisible();
		// Stopped is in progress too.
		await swipe('Stopped task');
		await expect.poll(async () => (await task('stopped')).status).toBe('completed');
		// A completed task still goes to the archive.
		await swipe('Finished task');
		await expect(card('Finished task')).toHaveCount(0);
		await expect.poll(async () => (await task('finished')).archived?.status).toBe('completed');
		await expect(toast).toContainText('«Finished task» is in the archive');
		await expect(toast).toHaveAttribute('data-archive-toast', 'archive');
		// No action while the task waits for a launch (a working agent is covered by the unit test: the app reconciles a stale working status on disk at start).
		await card('Busy task').hover();
		for (let step = 0; step < 4; step++) await page.mouse.wheel(40, 0);
		await expect(bar.locator('[data-swipe][data-swiping=true]')).toHaveCount(0);
		await expect(card('Busy task')).toBeVisible();
		expect((await task('busy')).status).toBe('queued');
		expect((await task('busy')).archived).toBeUndefined();
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});

test('auto-archive after the configured days, and a dirty worktree stays while a clean one goes (spec/tasks#archive) @area:tasks', async () => {
	test.setTimeout(120000);
	const { root, data, app, page, task } = await fixture('auto-archive', [
		{
			id: 'old',
			title: 'Old completed',
			status: 'completed',
			extra: { completedAt: new Date(Date.now() - 8 * day).toISOString() },
		},
		{
			id: 'fresh',
			title: 'Fresh completed',
			status: 'completed',
			extra: { completedAt: new Date(Date.now() - 2 * day).toISOString() },
		},
		{
			id: 'pinned',
			title: 'Pinned completed',
			status: 'completed',
			extra: { completedAt: new Date(Date.now() - 40 * day).toISOString(), pinned: true },
		},
	]);
	try {
		const bar = sidebar(page),
			card = (title: string) => bar.locator('[data-sidebar-task]', { hasText: title });
		await expect.poll(async () => (await task('old')).archived?.by).toBe('auto');
		await expect(card('Old completed')).toHaveCount(0);
		await expect(card('Fresh completed')).toBeVisible();
		expect((await task('pinned')).archived).toBeUndefined();
		// Settings ▸ Agents ▸ Tasks: «After 1 day» archives the two-day-old task right away.
		await page.evaluate(async () => {
			const { settings } = await window.brigadir.readSettings();
			await window.brigadir.saveSettings({
				...settings,
				agents: { ...settings.agents, archiveAfterDays: 1 },
			});
		});
		await expect.poll(async () => (await task('fresh')).archived?.by).toBe('auto');
		await expect(card('Fresh completed')).toHaveCount(0);
		expect(
			JSON.parse(await readFile(join(data, 'settings.json'), 'utf8')).settings.agents
				.archiveAfterDays
		).toBe(1);
		// Two worktree tasks run a turn; one leaves an uncommitted file behind.
		const started = await page.evaluate(async () => {
			const settings = await window.brigadir.readLaunchSettings('project');
			const out = [];
			for (const name of ['clean', 'dirty']) {
				const task = await window.brigadir.createTask(
					'project',
					`Worktree ${name}`,
					'claude',
					'gui',
					false,
					{
						...settings,
						isolation: 'worktree',
						branch: `brigadir/archive-${name}`,
						baseRef: 'main',
						setupCommand: '',
					}
				);
				await window.brigadir.startSession(task);
				out.push(task);
			}
			return out;
		});
		for (const item of started)
			await expect
				.poll(
					async () =>
						(await page.evaluate((task) => window.brigadir.readSession(task), item)).records.some(
							(record) => record.event.kind === 'turn.completed'
						),
					{ timeout: 30000 }
				)
				.toBe(true);
		const [clean, dirty] = started as unknown as [
			{ id: string; projectId: string },
			{ id: string; projectId: string },
		];
		const tree = async (id: string) =>
			JSON.parse(await readFile(join(data, 'projects/project/tasks', id, 'worktree.json'), 'utf8'))
				.root as string;
		const cleanRoot = await tree(clean.id),
			dirtyRoot = await tree(dirty.id);
		await writeFile(join(dirtyRoot, 'notes.txt'), 'work in progress\n');
		await expect
			.poll(async () => (await task(clean.id)).status, { timeout: 15000 })
			.toMatch(/done|interrupted/);
		await page.evaluate(
			async (keys) => {
				for (const key of keys) await window.brigadir.archiveTask(key);
			},
			[clean, dirty]
		);
		expect((await task(clean.id)).archived).toMatchObject({ worktree: 'removed' });
		await expect(access(cleanRoot)).rejects.toThrow();
		expect(
			JSON.parse(
				await readFile(
					join(data, 'projects/project/tasks', clean.id, 'worktree-released.json'),
					'utf8'
				)
			).branch
		).toBe('brigadir/archive-clean');
		expect((await task(dirty.id)).archived).toMatchObject({ worktree: 'kept', uncommitted: 1 });
		expect(await readFile(join(dirtyRoot, 'notes.txt'), 'utf8')).toBe('work in progress\n');
		await bar.locator('[data-archive-scope=project]').click();
		const win = page.locator('[data-archive-window]');
		await win
			.locator('[data-archive-item]')
			.filter({ hasText: 'Worktree dirty' })
			.locator('button')
			.first()
			.click();
		await expect(win.locator('[data-archive-worktree=kept]')).toContainText(
			'The worktree stays: 1 uncommitted file.'
		);
		await expect(win).toContainText('Completed tasks archive after 1 day');
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});

test('the project filter of the Archive window opens under its button, whole and on top; keys, check mark and Esc that closes only the list (spec/tasks#archive) @area:tasks', async () => {
	test.setTimeout(120000);
	const old = (days: number) => new Date(Date.now() - days * day).toISOString();
	const archived = { at: old(2), by: 'manual', status: 'completed', worktree: 'none' };
	const { root, data, app, page } = await fixture('archive-filter', [
		{
			id: 'a0',
			title: 'Archived alpha',
			status: 'completed',
			extra: { completedAt: old(20), archived },
		},
	]);
	try {
		const other = join(data, 'projects/second');
		await mkdir(join(other, 'tasks/b0'), { recursive: true });
		await writeFile(
			join(other, 'project.json'),
			JSON.stringify({
				schemaVersion: 1,
				project: { id: 'second', name: 'Second project', path: join(root, 'repo') },
			})
		);
		await writeFile(
			join(other, 'tasks/b0/task.json'),
			JSON.stringify({
				schemaVersion: 1,
				task: {
					id: 'b0',
					projectId: 'second',
					title: 'Archived beta',
					status: 'completed',
					createdAt: old(30),
					updatedAt: old(20),
					completedAt: old(20),
					archived,
					provider: 'claude',
				},
			})
		);
		await app.evaluate(({ ipcMain }) => {
			const handlers = (ipcMain as any)._invokeHandlers,
				read = handlers.get('workspace:read');
			handlers.set('workspace:read', async (...args: unknown[]) => {
				const snapshot = await read(...args);
				for (const task of snapshot.tasks) task.changeSummary = { additions: 82, deletions: 50 };
				return snapshot;
			});
		});
		await page.reload();
		await expect.poll(() => menuItemEnabled(app, 'archive')).toBe(true);
		await clickMenuItem(app, 'archive');
		const win = page.locator('[data-archive-window]');
		await expect(win).toBeVisible();
		await expect(win.locator('[data-archive-item]')).toHaveCount(2);
		// The counter in the preview card: +N green, −M red (the same tokens as the sidebar card).
		await win
			.locator('[data-archive-item]')
			.filter({ hasText: 'Archived alpha' })
			.locator('button')
			.first()
			.click();
		const tone = (selector: string) =>
			win.locator(selector).evaluate((node) => {
				const probe = document.createElement('i');
				probe.style.color = node.dataset.change === 'add' ? 'var(--green)' : 'var(--red)';
				document.body.append(probe);
				const want = getComputedStyle(probe).color;
				probe.remove();
				return [getComputedStyle(node).color, want];
			});
		for (const selector of [
			'[data-archive-counts] [data-change=add]',
			'[data-archive-counts] [data-change=remove]',
		]) {
			const [got, want] = await tone(selector);
			expect(got).toBe(want);
		}
		expect((await tone('[data-archive-counts] [data-change=add]'))[0]).not.toBe(
			(await tone('[data-archive-counts] [data-change=remove]'))[0]
		);
		const trigger = win.getByRole('button', { name: 'All projects', exact: true }),
			list = win.getByRole('listbox', { name: 'All projects' });
		await trigger.click();
		await expect(list).toBeVisible();
		const frame = (await win.boundingBox())!,
			tb = (await trigger.boundingBox())!,
			options = list.getByRole('option');
		await expect(options).toHaveCount(3);
		const lb = (await list.boundingBox())!;
		expect(lb.y).toBeGreaterThanOrEqual(tb.y + tb.height);
		expect(lb.y + lb.height).toBeLessThanOrEqual(frame.y + frame.height);
		for (let i = 0; i < 3; i++) {
			const box = (await options.nth(i).boundingBox())!;
			expect(box.y).toBeGreaterThanOrEqual(frame.y);
			expect(box.x + box.width).toBeLessThanOrEqual(frame.x + frame.width + 1);
			expect(
				await options.nth(i).evaluate(
					(node, point) => {
						const hit = document.elementFromPoint(point.x, point.y);
						return !!hit && node.contains(hit);
					},
					{ x: box.x + box.width / 2, y: box.y + box.height / 2 }
				)
			).toBe(true);
		}
		await expect(options.first()).toHaveAttribute('aria-selected', 'true');
		await page.keyboard.press('ArrowDown');
		await expect(options.nth(1)).toHaveAttribute('data-active', 'true');
		await page.keyboard.press('Escape');
		await expect(list).toBeHidden();
		await expect(win).toBeVisible();
		await expect(trigger).toBeFocused();
		await trigger.click();
		await page.keyboard.press('ArrowDown');
		await page.keyboard.press('ArrowDown');
		await page.keyboard.press('Enter');
		await expect(win.locator('[data-archive-item]')).toHaveCount(1);
		await expect(win.locator('[data-archive-item]')).toContainText('Archived beta');
		await win.getByRole('button', { name: 'All projects', exact: true }).click();
		await options.first().click();
		await expect(win.locator('[data-archive-item]')).toHaveCount(2);
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});

test('the Completed column archives one card or the whole list after a question, and the window deletes everything after one (spec/tasks#archive-window) @area:tasks', async () => {
	test.setTimeout(90000);
	const { root, app, page, task } = await fixture('archive-all', [
		{ id: 'c1', title: 'Done one', status: 'completed' },
		{ id: 'c2', title: 'Done two', status: 'completed' },
		{ id: 'c3', title: 'Done three', status: 'completed' },
		{ id: 'run', title: 'Still waiting', status: 'queued' },
	]);
	try {
		await sidebar(page).locator('[class*=projectSelect]').first().click();
		const card = (id: string) => page.locator(`[data-board-task="${id}"]`);
		await card('c1').hover();
		await card('c1').locator('[data-archive-card]').click();
		await expect(card('c1')).toHaveCount(0);
		expect((await task('c1')).archived).toMatchObject({ by: 'manual' });
		// The header button asks first; Cancel keeps everything.
		await app.evaluate(() => {
			(globalThis as any).response = 0;
			(globalThis as any).confirmations.length = 0;
		});
		await page.locator('[data-archive-completed]').click();
		await expect.poll(() => app.evaluate(() => (globalThis as any).confirmations.length)).toBe(1);
		expect((await app.evaluate(() => (globalThis as any).confirmations[0])).buttons).toEqual([
			'Cancel',
			'Archive',
		]);
		await expect(card('c2')).toBeVisible();
		await app.evaluate(() => {
			(globalThis as any).response = 1;
		});
		await page.locator('[data-archive-completed]').click();
		await expect(card('c2')).toHaveCount(0);
		await expect(card('c3')).toHaveCount(0);
		await expect(card('run')).toBeVisible();
		expect((await task('c3')).archived).toBeTruthy();
		// The window: Delete all… asks once, names the count, then empties the archive.
		await page.locator('[data-archive-scope=screen]').click();
		const win = page.locator('[data-archive-window]');
		await expect(win.locator('[data-archive-item]')).toHaveCount(3);
		await win.locator('[data-archive-delete-all]').click();
		const confirm = page.locator('[data-archive-delete]');
		await expect(confirm).toContainText('Delete 3 tasks from the archive?');
		await confirm.getByRole('button', { name: 'Delete', exact: true }).click();
		await expect(win.locator('[data-archive-item]')).toHaveCount(0);
		await expect(win.locator('[data-archive-delete-all]')).toBeDisabled();
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});

test('an archived task with a removed worktree reads without the «Some data could not be read» banner and keeps +N −M (spec/tasks#released-worktree) @area:tasks', async () => {
	test.setTimeout(120000);
	const { root, data, app, page, task } = await fixture('released-diffs', []);
	try {
		const started = await page.evaluate(async () => {
			const settings = await window.brigadir.readLaunchSettings('project');
			const created = await window.brigadir.createTask(
				'project',
				'Released worktree',
				'claude',
				'gui',
				false,
				{
					...settings,
					isolation: 'worktree',
					branch: 'brigadir/released-diffs',
					baseRef: 'main',
					setupCommand: '',
				}
			);
			await window.brigadir.startSession(created);
			return created;
		});
		const key = started as unknown as { id: string; projectId: string },
			turns = () =>
				page.evaluate(
					(task) =>
						window.brigadir
							.readSession(task)
							.then(
								(session) =>
									session.records.filter((record) => record.event.kind === 'turn.completed').length
							),
					started
				);
		await expect.poll(turns, { timeout: 30000 }).toBeGreaterThan(0);
		const before = await turns();
		const tree = JSON.parse(
			await readFile(join(data, 'projects/project/tasks', key.id, 'worktree.json'), 'utf8')
		).root as string;
		await writeFile(join(tree, 'added.txt'), 'one\ntwo\n');
		await page.evaluate(
			(task) => window.brigadir.sendCommand(task, { kind: 'prompt', text: 'second turn' }),
			started
		);
		await expect.poll(turns, { timeout: 30000 }).toBeGreaterThan(before);
		await expect
			.poll(
				async () =>
					(await page.evaluate(() => window.brigadir.readWorkspace())).tasks.find(
						(item) => item.id === key.id
					)?.changeSummary?.additions,
				{ timeout: 15000 }
			)
			.toBe(2);
		await expect
			.poll(async () => (await task(key.id)).status, { timeout: 15000 })
			.toMatch(/done|interrupted/);
		// Committed, so the worktree is clean and the archive removes it; the snapshots keep the two added lines.
		const inTree = (...args: string[]) =>
			promisify(execFile)(
				'git',
				['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args],
				{ cwd: tree }
			);
		await inTree('add', '.');
		await inTree('commit', '-m', 'Add file');
		await page.evaluate(async (item) => {
			await window.brigadir.archiveTask(item);
		}, key);
		expect((await task(key.id)).archived).toMatchObject({ worktree: 'removed' });
		await access(join(data, 'projects/project/tasks', key.id, 'worktree-released.json'));
		await page.reload();
		await expect(
			page.getByText(/Some data could not be read\.|Could not read the task changes\./)
		).toHaveCount(0);
		const read = await page.evaluate(() => window.brigadir.readWorkspace());
		expect(read.issues).toEqual([]);
		expect(read.tasks.find((item) => item.id === key.id)?.changeSummary).toEqual({
			additions: 2,
			deletions: 0,
		});
		await sidebar(page).locator('[data-archive-scope=project]').click();
		const win = page.locator('[data-archive-window]');
		await win
			.locator('[data-archive-item]')
			.filter({ hasText: 'Released worktree' })
			.locator('button')
			.first()
			.click();
		await expect(win.locator('[data-archive-counts] [data-change=add]')).toContainText('+2');
		await expect(
			page.getByText(/Some data could not be read\.|Could not read the task changes\./)
		).toHaveCount(0);
		// spec/tasks#released-worktree: «Open» shows the task read-only; Chat, Diff, Files and Editor all answer without errors, in the page or in main.
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		page.on('console', (m) => {
			if (m.type() === 'error') errors.push(m.text());
		});
		const mainErrors: string[] = [];
		await app.evaluate(({ app }) => {
			const state = globalThis as any;
			state.mainErrors = [];
			process.on('unhandledRejection', (e) => state.mainErrors.push(String(e)));
		}, null);
		await win.getByRole('button', { name: 'Open', exact: true }).click();
		await expect(page.locator('[data-archived-strip]')).toBeVisible();
		await openPanelTab(page, 'changes');
		await expect(page.getByText('added.txt').first()).toBeVisible();
		await expect(
			page.getByText(/Some data could not be read\.|Could not read the task changes\./)
		).toHaveCount(0);
		await openPanelTab(page, 'files');
		await expect(page.getByText('Worktree removed')).toBeVisible();
		await expect(page.getByText('Not all files are shown.')).toHaveCount(0);
		await expect(
			page.locator('[data-toast-region]').getByText('Could not read the folder.')
		).toHaveCount(0);
		await page.waitForTimeout(3500);
		await expect(page.getByText('Worktree removed')).toBeVisible();
		await hideChat(page);
		await page.waitForTimeout(500);
		await showChat(page);
		await expect(
			page.getByText(/Some data could not be read\.|Could not read the task changes\./)
		).toHaveCount(0);
		expect(errors).toEqual([]);
		expect(await app.evaluate(() => (globalThis as any).mainErrors)).toEqual([]);
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
