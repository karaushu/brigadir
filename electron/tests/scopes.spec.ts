import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openPanelTab } from './layout';
import { openRepos, reposPopover } from './repos';
const desktop = resolve('apps/desktop'),
	executablePath = createRequire(join(desktop, 'package.json'))('electron') as string;
const env = Object.fromEntries(
	Object.entries(process.env).filter(
		(entry): entry is [string, string] =>
			typeof entry[1] === 'string' && entry[0] !== 'ELECTRON_RUN_AS_NODE'
	)
);
const fixtureAgent = resolve('packages/transport/fixtures/agent.mjs');
/** The project «repository» at `repo`, light English settings. */
async function writeProject(data: string, repo: string) {
	await mkdir(join(data, 'projects/project'), { recursive: true });
	await writeFile(
		join(data, 'projects/project/project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'repository', path: repo } })
	);
	await writeFile(
		join(data, 'settings.json'),
		JSON.stringify({ schemaVersion: 1, settings: { appearance: 'light', language: 'en' } })
	);
}
const launch = (root: string, data: string, extra: Record<string, string> = {}) =>
	electron.launch({
		executablePath,
		args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
		env: { ...env, BRIGADIR_DATA_DIR: data, ...extra },
	});
/** Stops every task host before the app closes. */
async function shutdownAll(app: ElectronApplication) {
	try {
		const page = await app.firstWindow();
		await page.evaluate(async () => {
			for (const task of (await window.brigadir.readWorkspace()).tasks)
				await window.brigadir.sendCommand(task, { kind: 'shutdown' }).catch(() => {});
		});
	} catch {}
}
/**
 * spec/appearance#evolution-redesign, spec/task-window#repo-line: the task's repos are the header's chip and «Repos k/n» popover and the roots of Files and
 * Changes; the sidebar has none. Live rights stay honest: a running task cannot change its repos.
 */
test('task repos live in the header and as panel roots, with honest live rights @area:tasks', async ({}, info) => {
	test.setTimeout(90000);
	const root = await mkdtemp(join(tmpdir(), 'brigadir-scopes-ui-')),
		repo = join(root, 'repository'),
		data = join(root, 'data');
	const git = (path: string, ...args: string[]) => promisify(execFile)('git', args, { cwd: path });
	for (const path of [repo, join(repo, 'context')]) {
		await mkdir(path, { recursive: true });
		await git(path, 'init', '-b', 'main');
		await git(path, 'config', 'user.name', 'Fixture');
		await git(path, 'config', 'user.email', 'fixture@example.invalid');
		await writeFile(join(path, 'read.txt'), 'baseline\n');
		await writeFile(join(path, '.gitignore'), 'context/\n');
		await git(path, 'add', '.');
		await git(path, 'commit', '-m', 'Initial');
	}
	await writeProject(data, repo);
	const app = await launch(root, data, { BRIGADIR_TEST_AGENT: fixtureAgent });
	try {
		const page = await app.firstWindow(),
			errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 820));
		// The sidebar is tasks and quota only.
		await expect(page.getByRole('region', { name: 'Repos', exact: true })).toHaveCount(0);
		const task = await page.evaluate(async () => {
			const options = await window.brigadir.readLaunchSettings('project');
			const task = await window.brigadir.createTask(
				'project',
				'Scope navigation',
				'claude',
				'gui',
				false,
				{
					...options,
					branch: '',
					isolation: 'in-place' as const,
					scopes: options.scopes.map((scope) =>
						scope.name === 'context' ? { ...scope, selected: false } : scope
					),
				}
			);
			await window.brigadir.startSession(task);
			return task;
		});
		await expect
			.poll(async () =>
				(await page.evaluate((task) => window.brigadir.readSession(task), task)).records.some(
					(record) => record.event.kind === 'turn.completed'
				)
			)
			.toBe(true);
		await page.locator(`[data-sidebar-task="${task.id}"]`).click();
		// The header's second line: the main repo's chip (the task works in place, so it opens the branch picker).
		const chip = page.locator('[data-repo-chip]');
		await expect(chip).toContainText('repository');
		await expect(chip.locator('[data-branch-name]')).toHaveText('main');
		await expect(chip).toHaveAccessibleName('Switch branch · repository');
		const others = page.locator('[data-repos-button]');
		await expect(others).toHaveText('+1');
		await expect(others).toHaveAccessibleName('Repos · 1/2');
		// The popover: the repo in the task with its «…», the one outside grey with «+»; a running task keeps its repos.
		const popover = await openRepos(page);
		await expect(popover.getByRole('heading')).toHaveText('Repos 1/2');
		const outside = popover.getByRole('button', { name: 'Add to the task · context', exact: true });
		await expect(outside).toBeDisabled();
		const entry = (label: string) =>
			page.getByRole('menuitemcheckbox', { name: label, exact: true });
		await popover.getByRole('button', { name: 'Repo actions · repository', exact: true }).click();
		await expect(entry('Remove from the task…')).toBeDisabled();
		await expect(entry('Remove from the task…')).toHaveAttribute('aria-checked', 'true');
		await page.keyboard.press('Escape');
		await expect(page.getByRole('menu')).toHaveCount(0);
		await expect(popover).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(reposPopover(page)).toHaveCount(0);
		// Changes: the repo is a root with its changes, the file under it; the root folds what is under it.
		await writeFile(join(repo, 'read.txt'), 'baseline\nnew line\n');
		await writeFile(join(repo, 'context/read.txt'), 'baseline\ncontext change\n');
		await page.evaluate((task) => window.brigadir.sendCommand(task, { kind: 'checkpoint' }), task);
		await openPanelTab(page, 'changes');
		const changesRoot = page.locator('[data-repo-root="repository"]');
		await expect(changesRoot).toContainText('+1');
		const file = page.locator('[data-row-id]').filter({ hasText: 'read.txt' });
		await expect(file.first()).toBeVisible();
		await changesRoot.getByRole('button', { name: 'Collapse folder · repository' }).click();
		await expect(file).toHaveCount(0);
		await changesRoot.getByRole('button', { name: 'Expand folder · repository' }).click();
		await expect(file.first()).toBeVisible();
		await expect(page.locator('[data-repo-root="context"]')).toHaveAttribute(
			'data-outside',
			'true'
		);
		// Files: the nested repo is its own root, not a folder inside the project's root.
		await openPanelTab(page, 'files');
		const tree = page.getByRole('tree', { name: 'Project files' });
		await expect(tree.getByRole('treeitem', { name: 'context', exact: true })).toHaveAttribute(
			'data-repo-root',
			'context'
		);
		await expect(tree.locator('[data-repo-root]')).toHaveCount(2);
		await expect(tree.locator('[data-repo-root="repository"]')).toHaveAttribute('aria-level', '1');
		await expect(tree.getByRole('treeitem', { name: 'read.txt', exact: true })).toHaveAttribute(
			'aria-level',
			'2'
		);
		await expect(tree.locator('[data-add-folder]')).toBeVisible();
		// Another task in the same tree: the lock shows in the header with who holds the repo.
		const other = await page.evaluate(async () =>
			window.brigadir.createTask('project', 'Another writer', 'claude', 'gui', false)
		);
		const starting = page.evaluate((task) => window.brigadir.startSession(task), other);
		await expect(page.getByRole('dialog')).toContainText('Repo is busy');
		await page.getByRole('button', { name: /Work despite the lock/ }).click();
		await starting;
		await expect(chip.locator('[data-repo-lock]')).toHaveAttribute('title', /Another writer/);
		for (const theme of ['light', 'dark'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await openRepos(page);
			await page.screenshot({ path: info.outputPath(`scopes-${theme}.png`) });
			await page.keyboard.press('Escape');
		}
		// Stopped, the task changes its repos from the same rows.
		await page.evaluate(async (task) => {
			await window.brigadir.sendCommand(task, { kind: 'shutdown' });
		}, task);
		await expect
			.poll(
				async () =>
					(await page.evaluate((task) => window.brigadir.readSession(task), task)).connected
			)
			.toBe(false);
		await (
			await openRepos(page)
		)
			.getByRole('button', { name: 'Add to the task · context', exact: true })
			.click();
		await expect
			.poll(
				async () =>
					(
						await page.evaluate(
							(task) => window.brigadir.readScopePanel(task.projectId, task.id),
							task
						)
					).scopes.find((scope) => scope.name === 'context')?.selected
			)
			.toBe(true);
		expect(errors).toEqual([]);
	} finally {
		await shutdownAll(app);
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
test('read-only changes remain visible with hidden diffs, coalesce by scope and survive reconnect @area:tasks', async () => {
	test.setTimeout(60000);
	const root = await mkdtemp(join(tmpdir(), 'brigadir-policy-ui-')),
		repo = join(root, 'repository'),
		data = join(root, 'data');
	await mkdir(repo);
	const git = (...args: string[]) => promisify(execFile)('git', args, { cwd: repo });
	await git('init', '-b', 'main');
	await git('config', 'user.name', 'Fixture');
	await git('config', 'user.email', 'fixture@example.invalid');
	await writeFile(join(repo, 'read.txt'), 'baseline\n');
	await git('add', '.');
	await git('commit', '-m', 'Initial');
	await writeProject(data, repo);
	const history = join(data, 'projects/project/tasks/history');
	await mkdir(history, { recursive: true });
	await writeFile(
		join(history, 'task.json'),
		JSON.stringify({
			schemaVersion: 1,
			task: {
				id: 'history',
				projectId: 'project',
				title: 'Many scope warnings',
				provider: 'claude',
				status: 'done',
			},
		})
	);
	await writeFile(
		join(history, 'events.jsonl'),
		Array.from({ length: 15 }, (_, i) =>
			JSON.stringify({
				schemaVersion: 1,
				seq: i + 1,
				at: '2026-09-18T12:00:00Z',
				event: {
					kind: 'scope.violation',
					scopeId: i.toString(16).padStart(16, '0'),
					name: `scope-${i}`,
					paths: ['read.txt'],
					checkpoint: i,
				},
			})
		).join('\n') + '\n'
	);
	const app = await launch(root, data, { BRIGADIR_TEST_AGENT: fixtureAgent });
	try {
		const page = await app.firstWindow(),
			errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		const task = await page.evaluate(async () => {
			const launch = { ...(await window.brigadir.readLaunchSettings('project')), branch: '' };
			launch.scopes = launch.scopes.map((scope) => ({ ...scope, selected: false }));
			const task = await window.brigadir.createTask(
				'project',
				'Read-only review',
				'claude',
				'gui',
				false,
				launch
			);
			await window.brigadir.startSession(task);
			return task;
		});
		await expect
			.poll(async () =>
				(await page.evaluate((task) => window.brigadir.readSession(task), task)).records.some(
					(record) => record.event.kind === 'turn.completed'
				)
			)
			.toBe(true);
		await page
			.locator('aside')
			.getByRole('button', { name: /Read-only review/ })
			.filter({ has: page.locator('[class*=taskCopy]') })
			.click();
		await page.evaluate(
			(task) => window.brigadir.sendCommand(task, { kind: 'prompt', text: 'hold' }),
			task
		);
		await expect
			.poll(async () =>
				(await page.evaluate((task) => window.brigadir.readSession(task), task)).records.some(
					(record) => record.event.kind === 'turn.started' && record.event.text === 'hold'
				)
			)
			.toBe(true);
		const longParts = Array.from({ length: 4 }, (_, index) => `${index}-${'long'.repeat(15)}`),
			longPath = [...longParts, 'context.txt'].join('/');
		await mkdir(join(repo, ...longParts), { recursive: true });
		await writeFile(join(repo, longPath), 'new external file');
		await writeFile(join(repo, 'read.txt'), 'changed outside the agent\n');
		// spec/notifications-slack-notes-and-schedules#notice-chips: no banner — the chip in the composer footer; its popover opened by itself on the new fact.
		await page.evaluate((task) => window.brigadir.sendCommand(task, { kind: 'checkpoint' }), task);
		const warning = page.locator('[data-readonly-chip="composer"]'),
			popover = page.getByRole('dialog', { name: 'A read-only repo changed', exact: true });
		await expect(warning).toHaveCount(1);
		await expect(popover).toHaveAttribute('data-notice-popover', 'auto');
		await expect(popover).toContainText('read.txt');
		await expect(popover).toContainText(longPath);
		await expect(page.getByRole('region', { name: 'Repo warnings' })).toHaveCount(0);
		// The read-only repo's changes are not the task's diff.
		expect((await page.evaluate((task) => window.brigadir.readChanges(task), task)).files).toEqual(
			[]
		);
		await popover.getByRole('button', { name: 'Got it', exact: true }).click();
		await expect(popover).toHaveCount(0);
		await writeFile(join(repo, 'read.txt'), 'another change\n');
		await writeFile(join(repo, 'other.txt'), 'one more file\n');
		await page.evaluate((task) => window.brigadir.sendCommand(task, { kind: 'checkpoint' }), task);
		await expect
			.poll(
				async () =>
					(await page.evaluate((task) => window.brigadir.readSession(task), task)).records.filter(
						(record) => record.event.kind === 'scope.violation'
					).length
			)
			.toBe(2);
		await expect(warning).toHaveCount(1);
		// Another set of files is a new fact: the popover opens by itself once more.
		await expect(popover).toHaveAttribute('data-notice-popover', 'auto');
		await expect(popover.locator('li').filter({ hasText: 'other.txt' })).toBeVisible();
		await page.keyboard.press('Escape');
		await page.evaluate((task) => window.brigadir.sendCommand(task, { kind: 'cancel' }), task);
		await page
			.locator('aside')
			.getByLabel('repository', { exact: true })
			.getByRole('button', { name: 'repository', exact: true })
			.click();
		await page
			.locator('aside')
			.getByRole('button', { name: /Read-only review/ })
			.filter({ has: page.locator('[class*=taskCopy]') })
			.click();
		await expect(warning).toHaveCount(1);
		// A journal of 15 violations coalesces into one chip with one row per repo, and the list scrolls.
		await page
			.locator('aside')
			.getByRole('button', { name: /Many scope warnings/ })
			.filter({ has: page.locator('[class*=taskCopy]') })
			.click();
		const notices = page.getByRole('dialog', { name: 'A read-only repo changed', exact: true });
		await expect(page.locator('[data-readonly-chip="composer"]')).toHaveCount(1);
		await expect(notices.locator('[data-readonly-scope]')).toHaveCount(15);
		await notices.evaluate((node) => {
			const body = node.querySelector<HTMLElement>('[class*=body]')!;
			body.scrollTop = body.scrollHeight;
		});
		await expect
			.poll(() =>
				notices.evaluate((node) => node.querySelector<HTMLElement>('[class*=body]')!.scrollTop)
			)
			.toBeGreaterThan(0);
		await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
		expect(errors).toEqual([]);
	} finally {
		await shutdownAll(app);
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});

/** spec/projects-and-board#folders-mid-task, spec/appearance#evolution-redesign: a folder joins a task that already runs — «Add folder…» under the panel's roots and add_folder. */
test('a folder joins a running task from the panel roots and through add_folder @area:tasks', async () => {
	test.setTimeout(90000);
	const root = await mkdtemp(join(tmpdir(), 'brigadir-add-folder-')),
		repo = join(root, 'repository'),
		docs = join(root, 'docs'),
		backend = join(root, 'backend'),
		data = join(root, 'data');
	const git = (path: string, ...args: string[]) => promisify(execFile)('git', args, { cwd: path });
	for (const path of [repo, docs, backend]) await mkdir(path, { recursive: true });
	for (const path of [repo, backend]) {
		await git(path, 'init', '-q', '-b', 'main');
		await writeFile(join(path, 'a.txt'), 'a\n');
	}
	await writeProject(data, repo);
	const app = await launch(root, data, {
		BRIGADIR_TEST_AGENT: fixtureAgent,
		BRIGADIR_FIXTURE_SCENARIO: 'crew',
	});
	try {
		const page = await app.firstWindow(),
			errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 860));
		const task = await page.evaluate(async () => {
			const task = await window.brigadir.createTask(
				'project',
				'Loyalty screen',
				'claude',
				'gui',
				false
			);
			await window.brigadir.startSession(task);
			return task;
		});
		await expect
			.poll(async () =>
				(await page.evaluate((task) => window.brigadir.readSession(task), task)).records.some(
					(record) => record.event.kind === 'turn.completed'
				)
			)
			.toBe(true);
		await page.locator('[data-sidebar-task]').first().click();
		await openPanelTab(page, 'files');
		const panel = page.locator('[data-menu-tree]'),
			add = panel.locator('[data-add-folder]');
		await expect(add).toBeVisible();
		// The person: the agent's host is up, and the folder still joins the task.
		expect((await page.evaluate((task) => window.brigadir.readSession(task), task)).connected).toBe(
			true
		);
		await app.evaluate(({ dialog }, path) => {
			dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
		}, docs);
		await add.click();
		const docsRow = panel.locator('[data-scope="docs"]');
		await expect(docsRow).toBeVisible();
		await expect(docsRow).not.toHaveAttribute('data-outside', 'true');
		// Two repos now: the header's «+1 ▾» lists both, «Add folder…» ends that list too.
		const popover = await openRepos(page);
		await expect(popover.locator('[data-scope]')).toHaveCount(2);
		await expect(popover.locator('[data-add-folder]')).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(popover).toHaveCount(0);
		await expect
			.poll(async () =>
				(
					await page.evaluate((task) => window.brigadir.readWorkspace(), task)
				).tasks[0]!.launch?.scopes.find((scope) => scope.name === 'docs')
			)
			.toMatchObject({ kind: 'folder', selected: true });
		// The agent: a git repo asks the person first.
		const box = page.getByRole('textbox', { name: 'Message', exact: true }).last();
		await box.fill(`@call add_folder ${JSON.stringify({ path: backend })}`);
		await page.keyboard.press('Enter');
		const card = page
			.locator('[data-permission-id]')
			.filter({ hasText: 'Add backend to the task' });
		await expect(card).toBeVisible({ timeout: 20000 });
		await card.getByRole('button', { name: 'Allow', exact: true }).click();
		await expect(
			page.locator('[data-chat-message]').filter({ hasText: 'add_folder: {"added":true' })
		).toHaveCount(1, { timeout: 20000 });
		await expect(panel.locator('[data-scope="backend"]')).toBeVisible();
		// spec/projects-and-board#external-folders: both folders belong to this task only; a new task's defaults are the project's own repos.
		expect(
			(await page.evaluate(() => window.brigadir.readLaunchSettings('project'))).scopes.map(
				(scope) => scope.name
			)
		).toEqual(['.']);
		// The next turn runs on the reconnected adapter.
		await box.fill('next');
		await page.keyboard.press('Enter');
		await expect
			.poll(
				async () =>
					(await page.evaluate((task) => window.brigadir.readSession(task), task)).records.filter(
						(record) => record.event.kind === 'turn.completed'
					).length
			)
			.toBe(3);
		expect(errors).toEqual([]);
	} finally {
		await shutdownAll(app);
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});

/** spec/notifications-slack-notes-and-schedules#message-classes (class T): in the New task sheet a failed «Add folder…» is a line under the chips, not swallowed. */
test('a failed Add folder in the New task sheet says so under the chips @area:tasks', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-sheet-folder-')),
		repo = join(root, 'repository'),
		data = join(root, 'data');
	await mkdir(repo, { recursive: true });
	await promisify(execFile)('git', ['init', '-q', '-b', 'main'], { cwd: repo });
	await writeProject(data, repo);
	const app = await launch(root, data);
	try {
		const page = await app.firstWindow(),
			errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		await expect
			.poll(() =>
				app.evaluate(
					({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('new-task')?.enabled ?? false
				)
			)
			.toBe(true);
		await app.evaluate(({ Menu }) =>
			Menu.getApplicationMenu()!.getMenuItemById('new-task')!.click()
		);
		const sheet = page.getByRole('dialog', { name: 'New task', exact: true });
		const add = sheet.getByRole('button', { name: 'Add folder…', exact: true });
		await expect(add).toBeVisible();
		await app.evaluate(({ dialog }) => {
			dialog.showOpenDialog = async () => {
				throw new Error('The picker failed');
			};
		});
		await add.click();
		const line = sheet.getByRole('alert');
		await expect(line).toBeVisible();
		// The next try clears it: a cancelled pick adds nothing and says nothing.
		await app.evaluate(({ dialog }) => {
			dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
		});
		await add.click();
		await expect(line).toHaveCount(0);
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
