import { refreshChanges } from './refresh-changes';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openPanelTab } from './layout';
const run = promisify(execFile);
const desktop = resolve('apps/desktop');
const executablePath = createRequire(join(desktop, 'package.json'))('electron') as string;
const env = Object.fromEntries(
	Object.entries(process.env).filter(
		(e): e is [string, string] => typeof e[1] === 'string' && e[0] !== 'ELECTRON_RUN_AS_NODE'
	)
);
const menu = (app: ElectronApplication, group: string, label: string) =>
	app.evaluate(
		({ Menu }, [group, label]) => {
			const item = Menu.getApplicationMenu()!
				.items.find((i) => i.label === group)!
				.submenu!.items.find((i) => i.label === label)!;
			item.click();
		},
		[group, label] as const
	);
// spec/diff-and-review#diff-base and spec/editor#change-marks: the gutter marks the buffer against the base setting; the peek reverts one hunk in the buffer;
// the last-commit base brings a file changed before the task into the panel and the gutter.
// Revert on a buffer that was emptied brings the base back exactly, with no extra line break.
test('change marks follow the diff base, the peek reverts a hunk and Settings switches the base @area:diff', async ({}, info) => {
	test.setTimeout(120000);
	const root = await mkdtemp(join(tmpdir(), 'brigadir-diff-base-'));
	const repo = join(root, 'repository');
	await mkdir(repo);
	const git = (...args: string[]) => run('git', args, { cwd: repo });
	await git('init', '-q');
	await git('config', 'user.name', 'Fixture');
	await git('config', 'user.email', 'fixture@localhost');
	await writeFile(
		join(repo, 'a.ts'),
		['one', 'two', 'three', 'four', 'five', 'six'].join('\n') + '\n'
	);
	await writeFile(join(repo, 'before.txt'), 'committed\n');
	await writeFile(join(repo, 'b.ts'), 'alpha\nbeta\n');
	await git('add', '-A');
	await git('commit', '-qm', 'Baseline');
	// Uncommitted before the task: part of the task's first snapshot, so only the last-commit base shows it.
	await writeFile(join(repo, 'before.txt'), 'edited before the task\n');
	const app = await electron.launch({
		executablePath,
		args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
		env: {
			...env,
			BRIGADIR_DATA_DIR: join(root, 'data'),
			BRIGADIR_TEST_AGENT: resolve('packages/transport/fixtures/agent.mjs'),
		},
	});
	try {
		const page = await app.firstWindow();
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		await app.evaluate(({ dialog }, path) => {
			dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
		}, repo);
		await page.getByRole('button', { name: 'Add a project…' }).click();
		await page.getByRole('button', { name: 'New task · repository' }).click();
		await page.getByRole('textbox', { name: 'Message', exact: true }).fill('hello');
		await page.getByRole('button', { name: 'Start', exact: true }).click();
		await expect(page.getByRole('log')).toContainText('world', { timeout: 20000 });
		const key = await page.evaluate(async () => {
			const task = (await window.brigadir.readWorkspace()).tasks[0]!;
			return { projectId: task.projectId, id: task.id };
		});
		await expect
			.poll(
				async () =>
					(await page.evaluate((key) => window.brigadir.readSession(key), key)).records.findLast(
						(record) => record.event.kind === 'turn.completed'
					)?.event
			)
			.toMatchObject({ reason: 'end_turn' });
		// The task: line 2 changed, a line added after 4, line 6 deleted.
		await writeFile(
			join(repo, 'a.ts'),
			['one', 'TWO', 'three', 'four', 'inserted', 'five'].join('\n') + '\n'
		);
		await refreshChanges(page);
		const files = async () =>
			(await page.evaluate((key) => window.brigadir.readChanges(key), key)).files
				.map((file) => file.path)
				.sort();
		await expect.poll(files).toEqual(['a.ts']);
		const summary = async () =>
			(await page.evaluate(() => window.brigadir.readWorkspace())).tasks[0]!.changeSummary;
		await expect.poll(summary).toEqual({ additions: 2, deletions: 2 });

		// spec/diff-and-review#changes-header: the changes panel header names the base.
		const aside = page.getByRole('complementary', { name: 'Changes', exact: true });
		await openPanelTab(page, 'changes');
		await expect(
			aside
				.getByRole('button', { name: 'Diff base: Task start', exact: true })
				.locator('svg[data-glyph="base-task"]')
		).toBeVisible();
		await aside
			.locator('header')
			.first()
			.screenshot({ animations: 'disabled', path: info.outputPath('chip-task.png') });
		// A narrow panel keeps only the icon, with the same accessible name.
		const taskChip = aside.getByRole('button', { name: 'Diff base: Task start', exact: true });
		await expect(taskChip.getByText('Task start')).toBeVisible();
		const width = await aside.evaluate((node) => {
			const style = (node as HTMLElement).style,
				previous = style.width;
			style.width = '320px';
			return previous;
		});
		await expect(taskChip.getByText('Task start')).toBeHidden();
		await expect(taskChip.locator('svg[data-glyph="base-task"]')).toBeVisible();
		await aside.evaluate((node, width) => {
			(node as HTMLElement).style.width = width;
		}, width);
		await expect(taskChip.getByText('Task start')).toBeVisible();
		await openPanelTab(page, 'files');
		await page
			.getByRole('tree', { name: 'Project files' })
			.getByRole('treeitem', { name: 'a.ts', exact: true })
			.dblclick();
		const editor = page.getByRole('textbox', { name: 'File content' });
		await expect(editor).toContainText('inserted');
		const gutter = page.locator('.cm-changeGutter');
		await expect(gutter.locator('[data-change="mod"]')).toHaveCount(1, { timeout: 15000 });
		await expect(gutter.locator('[data-change="add"]')).toHaveCount(1);
		await expect(gutter.locator('[data-change="del"]')).toHaveCount(1);
		await page.screenshot({ animations: 'disabled', path: info.outputPath('gutter-dark.png') });

		// The live buffer: a typed line is marked before any save.
		await editor.click();
		await page.keyboard.press('Meta+ArrowUp');
		await page.keyboard.press('End');
		await page.keyboard.insertText(' typed');
		await expect(gutter.locator('[data-change="mod"]')).toHaveCount(2);
		await editor.press('Meta+z');
		await expect(gutter.locator('[data-change="mod"]')).toHaveCount(1);

		// A click on the changed line's mark opens the peek with the base text; Revert is one undoable buffer edit.
		await gutter.locator('[data-change="mod"]').click();
		const peek = page.getByRole('region', { name: 'Change 1 of 3' });
		await expect(peek).toContainText('Task base');
		await expect(peek).toContainText('two');
		await page.screenshot({ animations: 'disabled', path: info.outputPath('peek-dark.png') });
		await app.evaluate(({ nativeTheme }) => {
			nativeTheme.themeSource = 'light';
		});
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
		await page.screenshot({ animations: 'disabled', path: info.outputPath('peek-light.png') });
		await app.evaluate(({ nativeTheme }) => {
			nativeTheme.themeSource = 'dark';
		});
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
		await peek.getByRole('button', { name: 'Revert', exact: true }).click();
		await expect(peek).toHaveCount(0);
		await expect(editor).toContainText('two');
		await expect(gutter.locator('[data-change="mod"]')).toHaveCount(0);
		expect(await readFile(join(repo, 'a.ts'), 'utf8')).toContain('TWO');
		await editor.press('Meta+z');
		await expect(editor).toContainText('TWO');
		await expect(gutter.locator('[data-change="mod"]')).toHaveCount(1);

		// Menu: Next change opens the peek on the hunk after the cursor; Esc closes it and keeps editor focus.
		await menu(app, 'Editor', 'Next change');
		await expect(page.getByRole('region', { name: /^Change \d of 3$/ })).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(page.getByRole('region', { name: /^Change \d of 3$/ })).toHaveCount(0);
		await expect(editor).toBeFocused();

		// Settings ▸ Editor ▸ Diff base: the last commit brings the file edited before the task in.
		await app.evaluate(({ Menu }) => {
			Menu.getApplicationMenu()!
				.items.flatMap((item) => item.submenu?.items ?? [])
				.find((item) => item.label === 'Settings…')!
				.click();
		});
		const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
		await dialog.getByRole('tab', { name: 'Editor', exact: true }).click();
		await expect(dialog.getByRole('radio', { name: 'Task start' })).toBeChecked();
		await page.screenshot({ animations: 'disabled', path: info.outputPath('settings-dark.png') });
		await dialog.getByRole('radio', { name: 'Last commit' }).click();
		await expect(dialog.getByRole('radio', { name: 'Last commit' })).toBeChecked();
		await expect
			.poll(
				async () =>
					JSON.parse(await readFile(join(root, 'data/settings.json'), 'utf8')).settings.editor
						.diffBase
			)
			.toBe('head');
		await page.keyboard.press('Escape');
		await expect(dialog).toHaveCount(0);
		await expect.poll(files).toEqual(['a.ts', 'before.txt']);
		// The chip follows the setting and opens Settings on the Editor tab.
		await openPanelTab(page, 'changes');
		const chip = aside.getByRole('button', { name: 'Diff base: Last commit', exact: true });
		await expect(chip.locator('svg[data-glyph="base-head"]')).toBeVisible();
		await aside
			.locator('header')
			.first()
			.screenshot({ animations: 'disabled', path: info.outputPath('chip-head.png') });
		await chip.click();
		await expect(dialog.getByRole('tab', { name: 'Editor', exact: true })).toHaveAttribute(
			'aria-selected',
			'true'
		);
		await expect(dialog.getByRole('radio', { name: 'Last commit' })).toBeChecked();
		await page.keyboard.press('Escape');
		await expect(dialog).toHaveCount(0);
		await expect(chip).toBeFocused();
		await openPanelTab(page, 'files');
		// The sidebar totals follow the base too.
		await expect.poll(summary).toEqual({ additions: 3, deletions: 3 });
		const head = (await git('rev-parse', '--short=7', 'HEAD')).stdout.trim();
		await gutter.locator('[data-change="mod"]').click();
		await expect(page.getByRole('region', { name: 'Change 1 of 3' })).toContainText(
			`HEAD · ${head}`
		);
		await page.keyboard.press('Escape');
		// Open diff: the diff tab of this file, its base side named by the HEAD commit.
		await gutter.locator('[data-change="add"]').click();
		await page
			.getByRole('region', { name: 'Change 2 of 3' })
			.getByRole('button', { name: 'Open diff', exact: true })
			.click();
		const log = page.getByRole('log', { name: 'Diff', exact: true });
		await expect(log).toContainText('inserted');
		await expect(page.getByText(new RegExp(`^HEAD ${head} · `))).toBeVisible();

		// An emptied buffer: Revert brings the base text back exactly.
		await openPanelTab(page, 'files');
		await page
			.getByRole('tree', { name: 'Project files' })
			.getByRole('treeitem', { name: 'b.ts', exact: true })
			.dblclick();
		await expect(editor).toContainText('beta');
		await editor.click();
		await page.keyboard.press('Meta+a');
		await page.keyboard.press('Backspace');
		await expect(gutter.locator('[data-change="del-top"]')).toHaveCount(1, { timeout: 15000 });
		await gutter.locator('[data-change="del-top"]').click();
		const emptied = page.getByRole('region', { name: 'Change 1 of 1' });
		await expect(emptied).toContainText('alpha');
		await emptied.getByRole('button', { name: 'Revert', exact: true }).click();
		await expect(emptied).toHaveCount(0);
		await expect(editor).toContainText('beta');
		expect(await editor.locator('.cm-line').allTextContents()).toEqual(['alpha', 'beta', '']);

		// spec/diff-and-review#diff-base: a commit outside the app moves HEAD but not the tree; the panel rereads without Refresh.
		await openPanelTab(page, 'changes');
		const fileRow = (name: string) =>
			aside
				.getByRole('list', { name: 'Files', exact: true })
				.getByRole('button', { name: new RegExp(name.replace('.', '\\.')) });
		await expect(fileRow('before.txt')).toBeVisible();
		await git('add', 'before.txt');
		await git('commit', '-qm', 'Commit outside the app');
		await expect(fileRow('before.txt')).toHaveCount(0, { timeout: 10000 });
		await expect(fileRow('a.ts')).toBeVisible();
		expect(errors).toEqual([]);
	} finally {
		await app
			.evaluate(({ dialog }) => {
				dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
			})
			.catch(() => {});
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
