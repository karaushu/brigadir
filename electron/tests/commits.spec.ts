import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openPanelTab } from './layout';
const desktop = resolve('apps/desktop'),
	executablePath = createRequire(join(desktop, 'package.json'))('electron') as string,
	fixture = resolve('packages/transport/fixtures/agent.mjs');
// A git repo with one commit of `files` (then `dirty` edits before the task), a project on it and a started fixture task.
const start = async (
	prefix: string,
	files: Record<string, string>,
	title: string,
	dirty: Record<string, string> = {}
) => {
	const root = await mkdtemp(join(tmpdir(), prefix)),
		repo = join(root, 'repo'),
		data = join(root, 'data');
	await mkdir(repo);
	const git = async (...args: string[]) =>
		(await promisify(execFile)('git', args, { cwd: repo })).stdout.trim();
	await git('init', '-b', 'main');
	await git('config', 'user.name', 'Fixture');
	await git('config', 'user.email', 'fixture@example.invalid');
	for (const [name, text] of Object.entries(files)) await writeFile(join(repo, name), text);
	await git('add', '.');
	await git('commit', '-m', 'Initial');
	for (const [name, text] of Object.entries(dirty)) await writeFile(join(repo, name), text);
	await mkdir(join(data, 'projects/project'), { recursive: true });
	await writeFile(
		join(data, 'projects/project/project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'repo', path: repo } })
	);
	await writeFile(
		join(data, 'settings.json'),
		JSON.stringify({ schemaVersion: 1, settings: { appearance: 'light', language: 'en' } })
	);
	const env = Object.fromEntries(
		Object.entries(process.env).filter(
			(entry): entry is [string, string] =>
				typeof entry[1] === 'string' && entry[0] !== 'ELECTRON_RUN_AS_NODE'
		)
	);
	const app = await electron.launch({
		executablePath,
		args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
		env: { ...env, BRIGADIR_DATA_DIR: data, BRIGADIR_TEST_AGENT: fixture },
	});
	const page = await app.firstWindow(),
		errors: string[] = [];
	page.on('pageerror', (error) => errors.push(error.message));
	const task = await page.evaluate(async (title) => {
		const task = await window.brigadir.createTask('project', title, 'claude', 'gui', false);
		await window.brigadir.startSession(task);
		return task;
	}, title);
	await expect
		.poll(async () =>
			(await page.evaluate((task) => window.brigadir.readSession(task), task)).records.some(
				(record) => record.event.kind === 'turn.completed'
			)
		)
		.toBe(true);
	// Records the edits made since, then opens the task's Changes panel.
	const review = async () => {
		await page.evaluate((task) => window.brigadir.sendCommand(task, { kind: 'checkpoint' }), task);
		await page
			.locator('aside')
			.getByRole('button', { name: new RegExp(title) })
			.filter({ has: page.locator('[class*=taskCopy]') })
			.click();
		await openPanelTab(page, 'changes');
	};
	return { root, repo, app, page, errors, git, review };
};
const stop = async (app: ElectronApplication, root: string) => {
	try {
		const page = await app.firstWindow();
		await page.evaluate(async () => {
			for (const task of (await window.brigadir.readWorkspace()).tasks)
				await window.brigadir.sendCommand(task, { kind: 'shutdown' }).catch(() => {});
		});
	} catch {}
	await app.close();
	await rm(root, { recursive: true, force: true });
};
// spec/git#commit-dialog: the strip is one row — «Commit +N −M» and a solid «Commit»; the dialog generates and commits.
test('commit strip is one row that opens the dialog, which generates explicitly, refuses a stale review and records a real local commit @area:diff @smoke', async ({}, info) => {
	test.setTimeout(90000);
	const { root, repo, app, page, errors, git, review } = await start(
		'brigadir-commit-ui-',
		{ 'before.txt': 'original\n', 'task.txt': 'baseline\n' },
		'Review the changes',
		{ 'before.txt': 'before task change\n' }
	);
	try {
		await writeFile(join(repo, 'task.txt'), 'baseline\ntask change\n');
		await review();
		const strip = page.getByRole('region', { name: 'Commit', exact: true }); // The strip is the footer of the changes panel's Diff tab, not of the document.
		await expect(
			page
				.getByRole('complementary', { name: 'Changes', exact: true })
				.getByRole('region', { name: 'Commit', exact: true })
		).toBeVisible();
		// One row (spec/git#commit-dialog): the snapshot picker, the total of every file (before.txt +1 −1, task.txt +1) and
		// «Commit»; no field, list, fold, Commit all or second snapshot footer.
		await expect(strip).toContainText('+2');
		await expect(strip).toContainText('−1');
		const open = strip.getByRole('button', { name: 'Commit', exact: true }),
			snapshot = strip.getByRole('button', { name: 'Compare snapshots', exact: true });
		await expect(open).toBeEnabled();
		await expect(strip.getByRole('textbox')).toHaveCount(0);
		// spec/diff-and-review#agent-review-surfaces: `Review…` stands beside Commit.
		await expect(strip.getByRole('button')).toHaveCount(3);
		await expect(strip.locator('[data-review-button]')).toHaveCount(1);
		await expect(strip.locator('[aria-expanded]')).toHaveCount(1);
		// The picker opens the funnel's «Compare snapshots» popover; Esc closes it and gives the focus back.
		const compare = page.getByRole('dialog', { name: 'Diff options', exact: true });
		for (const theme of ['light', 'dark'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await page.mouse.move(0, 0);
			await page.screenshot({ path: info.outputPath(`commit-${theme}.png`) });
			await snapshot.click();
			await expect(compare).toBeVisible();
			await page.screenshot({ path: info.outputPath(`commit-snapshots-${theme}.png`) });
			await page.keyboard.press('Escape');
			await expect(compare).toHaveCount(0);
			await expect(snapshot).toBeFocused();
		}
		await app.evaluate(({ nativeTheme }) => {
			nativeTheme.themeSource = 'light';
		});
		// The dialog lists the pre-task file too; reading the preview leaves the real index alone.
		const index = await readFile(join(repo, '.git/index'));
		await open.click();
		const dialog = page.getByRole('dialog', { name: 'Commit' }),
			basket = dialog.locator('[data-basket="C1"]'),
			message = basket.getByRole('textbox'),
			alerts = page.locator('[data-toast-region]').getByRole('alert');
		await expect(dialog).toBeVisible();
		await expect(basket.getByRole('listitem')).toHaveCount(2);
		await expect(basket).toContainText('before.txt');
		await expect(message).toHaveValue('Review the changes');
		expect(await readFile(join(repo, '.git/index'))).toEqual(index);
		// The generator runs only on a click; a failure keeps the person's text and says so.
		await app.evaluate(() => {
			process.env.BRIGADIR_TEST_AGENT = '/missing/fixture.mjs';
		});
		await basket.getByRole('button', { name: 'Generate message', exact: true }).click();
		await expect(alerts).toHaveCount(1);
		await expect(message).toHaveValue('Review the changes');
		await app.evaluate((_, fixture) => {
			process.env.BRIGADIR_TEST_AGENT = fixture;
		}, fixture);
		await basket.getByRole('button', { name: 'Generate message', exact: true }).click();
		await expect(message).toHaveValue('hello world');
		await message.fill('Commit: reviewed text\n\nIncludes the earlier change.');
		// A stale review fails before any commit; the dialog reads the list again and the next Commit takes it.
		await writeFile(join(repo, 'task.txt'), 'baseline\ntask change\nnew edit\n');
		const failures = await alerts.count();
		await dialog.getByRole('button', { name: 'Commit 1' }).click();
		await expect.poll(() => alerts.count()).toBeGreaterThan(failures);
		expect(await git('log', '-1', '--format=%s')).toBe('Initial');
		await expect(message).toHaveValue('Commit: reviewed text\n\nIncludes the earlier change.');
		await expect(basket).toContainText('+3');
		await dialog.getByRole('button', { name: 'Commit 1' }).click();
		await expect(dialog).toHaveCount(0);
		await expect
			.poll(() => git('log', '-1', '--format=%B'))
			.toBe('Commit: reviewed text\n\nIncludes the earlier change.');
		expect(await git('status', '--porcelain')).toBe('');
		// Nothing left to commit: «✓ sha» takes the button's place in the same row, the picker stays — also after a reload
		// (commits.json).
		const sha = (await git('rev-parse', 'HEAD')).slice(0, 7);
		await expect(strip).toContainText(sha);
		await expect(strip.getByRole('button', { name: 'Commit', exact: true })).toHaveCount(0);
		await expect(snapshot).toBeVisible();
		await expect(strip.locator('[data-size="s"]')).toHaveCount(1);
		await expect(strip.locator('[data-size="s"]')).toContainText(sha);
		await strip.screenshot({ path: info.outputPath('commit-row-committed.png') });
		await page.reload();
		await page
			.locator('aside')
			.getByRole('button', { name: /Review the changes/ })
			.filter({ has: page.locator('[class*=taskCopy]') })
			.click();
		await openPanelTab(page, 'changes');
		await expect(page.getByRole('region', { name: 'Commit', exact: true })).toContainText(sha);
		expect(errors).toEqual([]);
	} finally {
		await stop(app, root);
	}
});

// spec/appearance#evolution-redesign, spec/git#commit-dialog: the commit dialog with baskets — the strip's «Commit» opens it, the agent splits only on a click
// (Undo with ⌘Z), a file moves by «Move N to», an empty basket is skipped and the rest become real commits in order.
test('commit dialog splits with the agent, moves a file and commits the baskets in order @area:diff', async ({}, info) => {
	test.setTimeout(90000);
	const { root, repo, app, page, errors, git, review } = await start(
		'brigadir-commit-modal-',
		{ 'file.txt': 'baseline\n' },
		'Printer labels'
	);
	try {
		await writeFile(join(repo, 'a.txt'), 'a\n');
		await writeFile(join(repo, 'b.txt'), 'b\n');
		await writeFile(join(repo, 'file.txt'), 'baseline\nchanged\n');
		await review();
		const strip = page.getByRole('region', { name: 'Commit', exact: true });
		// spec/git#commit-dialog: the strip's one button opens the dialog: one basket with every file, the task's title.
		await expect(strip.getByRole('button', { name: 'Commit all', exact: true })).toHaveCount(0);
		await strip.getByRole('button', { name: 'Commit', exact: true }).click();
		const dialog = page.getByRole('dialog', { name: 'Commit' });
		await expect(dialog).toBeVisible();
		const basket = (label: string) => dialog.locator(`[data-basket="${label}"]`);
		await expect(dialog.locator('[data-basket]')).toHaveCount(1);
		await expect(basket('C1').getByRole('textbox')).toHaveValue('Printer labels');
		await expect(basket('C1').getByRole('listitem')).toHaveCount(3);
		await expect(dialog.getByRole('button', { name: 'Commit 1' })).toBeEnabled();
		await page.screenshot({ path: info.outputPath('commit-dialog-first.png') });
		// The agent proposes one commit per file (the fixture); Undo (⌘Z) brings the person's basket back.
		await dialog.getByRole('button', { name: 'Split with the agent' }).click();
		await expect(dialog.locator('[data-basket]')).toHaveCount(3);
		await expect(basket('C2').getByRole('textbox')).toHaveValue('Update b.txt');
		await expect(basket('C2')).toContainText('Only b.txt changes here.');
		await page.screenshot({ path: info.outputPath('commit-dialog-proposed.png') });
		await dialog.getByRole('button', { name: 'Commit 3' }).focus();
		await page.keyboard.press('ControlOrMeta+z');
		await expect(dialog.locator('[data-basket]')).toHaveCount(1);
		await expect(basket('C1').getByRole('textbox')).toHaveValue('Printer labels');
		await dialog.getByRole('button', { name: 'Split with the agent' }).click();
		await expect(dialog.locator('[data-basket]')).toHaveCount(3);
		// b.txt joins C1 through «Move 1 to»; C2 is left empty and is skipped.
		await dialog.getByRole('checkbox', { name: 'Select b.txt' }).check();
		await dialog.getByRole('button', { name: 'Move 1 to' }).click();
		await page.getByRole('menuitem', { name: /^C1 · Update a\.txt/ }).click();
		await expect(basket('C1').getByRole('listitem')).toHaveCount(2);
		await expect(basket('C2').getByRole('listitem')).toHaveCount(0);
		await dialog.getByRole('button', { name: 'Commit 2' }).click();
		await expect(dialog).toHaveCount(0);
		await expect
			.poll(() => git('log', '--format=%s', '-3'))
			.toBe('Update file.txt\nUpdate a.txt\nInitial');
		expect((await git('show', '--name-only', '--format=', 'HEAD~1')).split('\n').sort()).toEqual([
			'a.txt',
			'b.txt',
		]);
		expect(await git('status', '--porcelain')).toBe('');
		// spec/git#commit-dialog: nothing left — «✓ 2 commits» in the Commit button's place, the snapshot picker stays.
		await expect(strip).toContainText('2 commits');
		await expect(strip.getByRole('button', { name: 'Commit', exact: true })).toHaveCount(0);
		await expect(
			strip.getByRole('button', { name: 'Compare snapshots', exact: true })
		).toBeVisible();
		expect(errors).toEqual([]);
	} finally {
		await stop(app, root);
	}
});
