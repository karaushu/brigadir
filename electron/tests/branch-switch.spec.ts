import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openPanelTab } from './layout';
import { openMainTree } from './repos';
const desktop = resolve('apps/desktop'),
	executablePath = createRequire(join(desktop, 'package.json'))('electron') as string;
const run = promisify(execFile),
	git = (cwd: string, ...args: string[]) =>
		run('git', args, { cwd }).then((result) => result.stdout.trim());

/** origin (bare) with main and staging two commits ahead; the project clone stays on main with a local staging behind. */
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-branch-switch-')),
		seed = join(root, 'seed'),
		origin = join(root, 'origin.git'),
		repo = join(root, 'repo'),
		data = join(root, 'data');
	await mkdir(seed, { recursive: true });
	await git(seed, 'init', '-q', '-b', 'main');
	await git(seed, 'config', 'user.name', 'Fixture');
	await git(seed, 'config', 'user.email', 'fixture@localhost');
	await writeFile(join(seed, 'README.md'), 'hello\n');
	await git(seed, 'add', '-A');
	await git(seed, 'commit', '-qm', 'base');
	await git(seed, 'branch', 'staging');
	await git(root, 'clone', '-q', '--bare', seed, origin);
	await git(root, 'clone', '-q', origin, repo);
	await git(repo, 'config', 'user.name', 'Fixture');
	await git(repo, 'config', 'user.email', 'fixture@localhost');
	await git(repo, 'branch', '-q', '--track', 'staging', 'origin/staging');
	await git(seed, 'remote', 'add', 'origin', origin);
	await git(seed, 'switch', '-q', 'staging');
	for (const n of [1, 2]) {
		await writeFile(join(seed, `s${n}.txt`), `${n}\n`);
		await git(seed, 'add', '-A');
		await git(seed, 'commit', '-qm', `staging ${n}`);
	}
	await git(seed, 'push', '-q', 'origin', 'staging');
	await mkdir(join(data, 'projects/project'), { recursive: true });
	await writeFile(
		join(data, 'settings.json'),
		JSON.stringify({ schemaVersion: 1, settings: { appearance: 'dark', language: 'en' } })
	);
	await writeFile(
		join(data, 'projects/project/project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'repo', path: repo } })
	);
	return { root, repo, data };
}
async function launch(root: string, data: string, extra: Record<string, string> = {}) {
	const env = Object.fromEntries(
		Object.entries(process.env).filter(
			(e): e is [string, string] => typeof e[1] === 'string' && e[0] !== 'ELECTRON_RUN_AS_NODE'
		)
	);
	const app = await electron.launch({
		executablePath,
		args: [desktop, `--user-data-dir=${join(root, 'profile')}`, '--no-proxy-server'],
		env: { ...env, HOME: root, ZDOTDIR: root, BRIGADIR_DATA_DIR: data, ...extra },
	});
	const page = await app.firstWindow();
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1500, 950));
	return { app, page };
}
const picker = (page: Page) => page.locator('[data-branch-picker][data-open=true]');
/** spec/task-window#repo-line: the main tree from the project's menu, its repo a root of the panel's Files. */
async function mainTree(app: Parameters<typeof openMainTree>[0], page: Page) {
	await openMainTree(app, page, 'repo');
	await openPanelTab(page, 'files');
}

test('the repo root switches the main tree: dirty step, stash and restore, the Git menu (spec/git#main-tree-branches) @area:tasks', async () => {
	test.setTimeout(120000);
	const { root, repo, data } = await fixture(),
		{ app, page } = await launch(root, data),
		errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	try {
		await mainTree(app, page);
		const button = page.locator('[data-repo-root] [data-branch-button]');
		await expect(button).toHaveText('main');
		await button.click();
		await expect(picker(page)).toHaveAttribute('data-branch-picker', 'list');
		await expect(picker(page).locator('[data-branch=staging]')).toContainText('↓2');
		await expect(picker(page).getByRole('menuitemradio', { name: 'main' })).toHaveAttribute(
			'aria-checked',
			'true'
		);
		// Dirty tree: the step instead of a refusal; Esc goes back to the list, then closes.
		await writeFile(join(repo, 'README.md'), 'edited\n');
		await writeFile(join(repo, 'new.txt'), 'new\n');
		await page.keyboard.press('Escape');
		await expect(picker(page)).toHaveCount(0);
		await button.click();
		await expect(picker(page).locator('[data-branch=staging]')).toBeVisible();
		await picker(page).locator('input').fill('stag');
		await page.keyboard.press('Enter');
		await expect(picker(page)).toHaveAttribute('data-branch-picker', 'dirty');
		await expect(picker(page)).toContainText('2 uncommitted changes');
		await expect(picker(page)).toContainText('new.txt');
		await page.keyboard.press('Escape');
		await expect(picker(page)).toHaveAttribute('data-branch-picker', 'list');
		await picker(page).locator('[data-branch=staging]').click();
		await picker(page)
			.getByRole('button', { name: /Stash and switch/ })
			.click();
		await expect(page.getByRole('status').filter({ hasText: 'repo → staging' })).toContainText(
			'pulled 2 commits'
		);
		await expect.poll(() => git(repo, 'symbolic-ref', '--short', 'HEAD')).toBe('staging');
		await expect(button).toHaveText('staging');
		expect(await readFile(join(repo, 's2.txt'), 'utf8')).toBe('2\n');
		expect(await git(repo, 'status', '--porcelain')).toBe('');
		// The Git menu: stash count, Restore from stash… lists our entry; Restore brings the changes back.
		await page.locator('[data-repo-root] [aria-haspopup=menu]').first().click();
		const menu = page.getByRole('menu');
		await expect(menu.getByRole('menuitem', { name: /Stash changes/ })).toBeDisabled();
		await menu.getByRole('menuitem', { name: /Restore from stash/ }).click();
		const stash = page.locator('[data-stash-popover]');
		await expect(stash).toContainText('before switching to staging');
		await stash.locator('[data-stash]').first().hover();
		await stash.getByRole('button', { name: 'Restore', exact: true }).click();
		await expect.poll(() => readFile(join(repo, 'README.md'), 'utf8')).toBe('edited\n');
		await expect.poll(() => git(repo, 'stash', 'list')).toBe('');
		// Undo last commit: a local commit goes back to the tree; a pushed one is off with the reason.
		await git(repo, 'add', '-A');
		await git(repo, 'commit', '-qm', 'Local work');
		await page.locator('[data-repo-root] [aria-haspopup=menu]').first().click();
		await page
			.getByRole('menu')
			.getByRole('menuitem', { name: /Undo last commit/ })
			.click();
		await page
			.getByRole('dialog', { name: 'Undo the last commit?' })
			.getByRole('button', { name: 'Undo commit' })
			.click();
		await expect.poll(() => git(repo, 'log', '-1', '--format=%s')).toBe('staging 2');
		await page.locator('[data-repo-root] [aria-haspopup=menu]').first().click();
		await expect(page.getByRole('menu')).toContainText('The commit is already on origin.');
		await page.keyboard.press('Escape');
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	}
});

test('a task without isolation switches its branch before the agent starts (spec/git#main-tree-branches Б) @area:tasks', async () => {
	test.setTimeout(120000);
	const { root, repo, data } = await fixture(),
		{ app, page } = await launch(root, data);
	try {
		await page.getByRole('button', { name: 'New task · repo', exact: true }).click();
		const sheet = page.getByRole('dialog', { name: 'New task', exact: true });
		await expect(sheet).toBeVisible();
		await sheet.getByRole('radio', { name: 'No isolation' }).click();
		const row = sheet.locator('[data-sheet-branch]').first();
		await expect(row.getByRole('button', { name: /Branch of repo/ })).toContainText('main');
		await row.getByRole('button', { name: /Branch of repo/ }).click();
		await page.getByRole('option', { name: 'staging' }).click();
		await expect(row.locator('[data-switch-line]')).toContainText(
			'switches from main to staging and pulls 2 commits from origin'
		);
		// A launch with this switch: the task's launch carries it, the preparation switches the tree.
		const launchSwitches = await page.evaluate(async () => {
			const settings = await window.brigadir.readLaunchSettings('project');
			return settings.scopes.length;
		});
		expect(launchSwitches).toBeGreaterThan(0);
		await sheet.getByRole('button', { name: 'Add to backlog' }).click();
		await sheet.getByRole('button', { name: 'Save' }).click();
		await expect(sheet).toHaveCount(0);
		const task = await page.evaluate(async () => {
			const tasks = (await window.brigadir.readWorkspace()).tasks;
			return tasks.find((item) => item.launch?.switches?.length) ?? null;
		});
		expect(task?.launch?.switches).toEqual([expect.objectContaining({ branch: 'staging' })]);
		// The project's launch settings do not remember the switch.
		expect(
			JSON.stringify(await page.evaluate(() => window.brigadir.readLaunchSettings('project')))
		).not.toContain('switches');
		expect(await git(repo, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	}
});

test('the background fetch shows ↓N beside ↑N; ↓N pulls, the sheet pulls before the start (spec/git#pull) @area:tasks', async () => {
	test.setTimeout(120000);
	const { root, repo, data } = await fixture(),
		seed = join(root, 'seed');
	// origin/main moves by one commit after the clone; the local main also has one commit of its own work on another file.
	await git(seed, 'switch', '-q', 'main');
	await writeFile(join(seed, 'remote.txt'), 'r\n');
	await git(seed, 'add', '-A');
	await git(seed, 'commit', '-qm', 'On origin');
	await git(seed, 'push', '-q', 'origin', 'main');
	const { app, page } = await launch(root, data, { BRIGADIR_REMOTE_WATCH: '1' });
	try {
		await mainTree(app, page);
		const pull = page.locator('[data-repo-root] [data-pull]');
		await expect(pull).toHaveText('↓1');
		await expect(pull).toHaveAttribute('title', /1 commit/);
		await writeFile(join(repo, 'mine.txt'), 'm\n');
		await git(repo, 'add', '-A');
		await git(repo, 'commit', '-qm', 'Mine');
		// The sheet: staying on a branch behind origin pulls before the start, unless turned off.
		await page.getByRole('button', { name: 'New task · repo', exact: true }).click();
		const sheet = page.getByRole('dialog', { name: 'New task', exact: true });
		await sheet.getByRole('radio', { name: 'No isolation' }).click();
		const line = sheet.locator('[data-pull-line]');
		await expect(line).toContainText('Before the start, repo pulls 1 commit from origin.');
		await expect(line.getByRole('switch', { name: 'Pull before the start' })).toBeChecked();
		await sheet.getByRole('button', { name: 'Add to backlog' }).click();
		await sheet.getByRole('button', { name: 'Save' }).click();
		await expect(sheet).toHaveCount(0);
		const saved = await page.evaluate(
			async () =>
				(await window.brigadir.readWorkspace()).tasks.find((task) => task.launch?.pull?.length)
					?.launch?.pull ?? null
		);
		expect(saved).toHaveLength(1);
		// Diverged with a conflict (both sides add remote.txt): the rebase is aborted, the toast hands it to an agent (spec/git#pull-agent).
		await writeFile(join(repo, 'remote.txt'), 'mine\n');
		await git(repo, 'add', '-A');
		await git(repo, 'commit', '-qm', 'Conflicting');
		const head = await git(repo, 'rev-parse', 'HEAD');
		// Saving the sheet selected the new task; back to the main tree.
		await mainTree(app, page);
		await expect(page.locator('[data-repo-root] [data-push]')).toHaveText('↑2');
		await pull.click();
		const stopped = page
			.getByRole('alert')
			.filter({ hasText: 'the pull stopped on a conflict in remote.txt' });
		await expect(stopped).toBeVisible();
		expect(await git(repo, 'rev-parse', 'HEAD')).toBe(head);
		expect(await git(repo, 'status', '--porcelain')).toBe('');
		await stopped.getByRole('button', { name: 'Resolve with agent' }).click();
		const quick = page.getByRole('dialog', { name: 'New quick task', exact: true });
		await expect(quick.getByRole('textbox', { name: 'Task name' })).toHaveValue('Pull · repo');
		await expect(quick).toContainText(
			'Rebasing it onto origin/main stops on a conflict in: remote.txt'
		);
		await page.keyboard.press('Escape');
		await expect(quick).toHaveCount(0);
		// Without the conflict the diverged branch rebases: origin's commit below, the local one on top, ↑1 stays to push.
		await git(repo, 'reset', '-q', '--hard', 'HEAD~1');
		await page.evaluate(() => window.dispatchEvent(new Event('focus')));
		await expect(page.locator('[data-repo-root] [data-push]')).toHaveText('↑1');
		await pull.click();
		await expect(
			page.getByRole('status').filter({ hasText: 'repo · pulled 1 commit, 1 commit on top' })
		).toBeVisible();
		await expect.poll(() => readFile(join(repo, 'remote.txt'), 'utf8')).toBe('r\n');
		expect(await git(repo, 'log', '-1', '--format=%s')).toBe('Mine');
		await expect(pull).toHaveCount(0);
		await expect(page.locator('[data-repo-root] [data-push]')).toHaveText('↑1');
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	}
});
