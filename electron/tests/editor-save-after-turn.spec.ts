import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
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
// spec/editor#save-during-turn: Save during a turn is held by the host and written when the turn ends.
test('Save during a turn waits for the turn to end and writes the text at ⌘S @area:editor', async () => {
	test.setTimeout(90000);
	const root = await mkdtemp(join(tmpdir(), 'brigadir-save-after-turn-'));
	const repo = join(root, 'repository');
	await mkdir(repo);
	const git = (...args: string[]) => run('git', args, { cwd: repo });
	await git('init', '-q');
	await git('config', 'user.name', 'Fixture');
	await git('config', 'user.email', 'fixture@localhost');
	await writeFile(join(repo, 'a.ts'), 'alpha\n');
	await git('add', '-A');
	await git('commit', '-qm', 'Baseline');
	/** The file in whichever tree the task works in: the repository itself or its worktree. */
	const disk = async () => {
		const { stdout } = await git('worktree', 'list', '--porcelain');
		const trees = stdout
			.split('\n')
			.filter((line) => line.startsWith('worktree '))
			.map((line) => line.slice('worktree '.length));
		return Promise.all(trees.map((tree) => readFile(join(tree, 'a.ts'), 'utf8').catch(() => '')));
	};
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
		await app.evaluate(({ dialog }, path) => {
			dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
		}, repo);
		await page.getByRole('button', { name: 'Add a project…' }).click();
		await page.getByRole('button', { name: 'New task · repository' }).click();
		const message = page.getByRole('textbox', { name: 'Message', exact: true });
		await message.fill('hello');
		await page.getByRole('button', { name: 'Start', exact: true }).click();
		await expect(page.getByRole('log')).toContainText('world', { timeout: 20000 });
		await openPanelTab(page, 'files');
		await page
			.getByRole('tree', { name: 'Project files' })
			.getByRole('treeitem', { name: 'a.ts', exact: true })
			.dblclick();
		const editor = page.getByRole('textbox', { name: 'File content' });
		await expect(editor).toContainText('alpha');
		await message.fill('hold');
		await message.press('Enter');
		const save = page.getByRole('button', { name: 'Save after the turn', exact: true });
		await expect(save).toBeVisible({ timeout: 15000 });
		await editor.click();
		await page.keyboard.press('Meta+a');
		await page.keyboard.insertText('saved in the turn\n');
		await expect(save).toBeEnabled();
		await editor.press('Meta+s');
		const notice = page.getByText('The save waits for the turn to end.', { exact: true });
		await expect(notice).toBeVisible();
		await expect(save).toBeDisabled();
		// Edits after ⌘S stay in the buffer; the held save writes the text it was asked with.
		await page.keyboard.insertText('typed after');
		await expect(save).toBeEnabled();
		expect(await disk()).not.toContain('saved in the turn\n');
		await page.getByRole('button', { name: 'Stop', exact: true }).click();
		await expect(notice).toHaveCount(0, { timeout: 15000 });
		await expect.poll(disk).toContain('saved in the turn\n');
		await expect(editor).toContainText('typed after');
		await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
	} finally {
		await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
	}
});
