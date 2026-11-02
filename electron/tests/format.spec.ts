import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { cp, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openPanelTab } from './layout';
const run = promisify(execFile);
const desktop = resolve('apps/desktop');
const executablePath = createRequire(join(desktop, 'package.json'))('electron') as string;
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
// spec/editor-code-intelligence#format-on-save: the project's Prettier (a stand-in with the same API) formats on ⌘S; one undo step; failures still save.
test('formats on save with the project Prettier, reports a syntax error, follows Settings ▸ Editor and the menu command @area:editor', async ({}, info) => {
	test.setTimeout(120000);
	const root = await mkdtemp(join(tmpdir(), 'brigadir-format-'));
	const repo = join(root, 'repository');
	await mkdir(repo, { recursive: true });
	const git = (...args: string[]) => run('git', args, { cwd: repo });
	await git('init', '-q');
	await git('config', 'user.name', 'Fixture');
	await git('config', 'user.email', 'fixture@localhost');
	await cp(
		resolve('packages/lsp/src/fixtures/fake-prettier'),
		join(repo, 'node_modules/prettier'),
		{ recursive: true }
	);
	await writeFile(join(repo, '.gitignore'), 'node_modules/\n');
	await writeFile(join(repo, '.prettierrc'), '{"singleQuote":true}\n');
	await writeFile(join(repo, 'a.js'), 'const a = 1;\n');
	await git('add', '.');
	await git('commit', '-qm', 'Baseline');
	const key = { projectId: 'project', id: 'task' };
	const taskDir = join(root, 'data/projects/project/tasks/task');
	await mkdir(taskDir, { recursive: true });
	await writeFile(
		join(taskDir, '../../project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'repository', path: repo } })
	);
	await writeFile(
		join(taskDir, 'task.json'),
		JSON.stringify({
			schemaVersion: 1,
			task: { ...key, title: 'Format fixture', status: 'done', provider: 'claude' },
		})
	);
	const env = Object.fromEntries(
		Object.entries(process.env).filter(
			(e): e is [string, string] => typeof e[1] === 'string' && e[0] !== 'ELECTRON_RUN_AS_NODE'
		)
	);
	const app = await electron.launch({
		executablePath,
		args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
		env: { ...env, BRIGADIR_DATA_DIR: join(root, 'data'), PATH: '/usr/bin:/bin' },
	});
	try {
		const page = await app.firstWindow();
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		await page.getByRole('button', { name: /Format fixture/ }).click();
		await openPanelTab(page, 'files');
		await page
			.getByRole('tree', { name: 'Project files' })
			.getByRole('treeitem', { name: 'a.js', exact: true })
			.dblclick();
		const editor = page.getByRole('textbox', { name: 'File content' });
		await expect(editor).toContainText('const a = 1;');
		const footer = page.locator('section[data-font-surface=editor] > footer');
		await expect(footer).toContainText('· Prettier', { timeout: 15000 });
		// ⌘S formats first, then writes; one ⌘Z brings the typed text back.
		await editor.click();
		await page.keyboard.press('Meta+ArrowDown');
		await page.keyboard.insertText('const  b = "x";');
		await editor.press('Meta+s');
		await expect
			.poll(() => readFile(join(repo, 'a.js'), 'utf8'), { timeout: 15000 })
			.toBe("const a = 1;\nconst b = 'x';");
		// Main answers a save after its own bookkeeping; a ⌘S before that answer is ignored, so wait for the dirty dot to go.
		const clean = () =>
			expect(page.locator('section[data-font-surface=editor] > header strong')).not.toContainText(
				'•',
				{ timeout: 15000 }
			);
		await expect(editor).toContainText("const b = 'x';");
		await clean();
		await page.screenshot({ path: info.outputPath('saved.png') });
		await editor.press('Meta+z');
		await expect(editor).toContainText('const  b = "x";');
		await editor.press('Meta+Shift+z');
		await expect(editor).toContainText("const b = 'x';");
		// A syntax error saves the file as typed and names the line; the next edit clears the strip.
		await page.keyboard.insertText('\nSYNTAX');
		await editor.press('Meta+s');
		const strip = page.locator('[data-format-notice]');
		await expect(strip).toContainText('Not formatted: syntax error on line 2. The file is saved.', {
			timeout: 15000,
		});
		await expect.poll(() => readFile(join(repo, 'a.js'), 'utf8')).toContain('SYNTAX');
		await clean();
		await page.screenshot({ path: info.outputPath('syntax.png') });
		await strip.getByRole('button', { name: 'line 2' }).click();
		await expect(footer).toContainText('2:1');
		await page.keyboard.press('Meta+ArrowDown');
		await page.keyboard.press('Shift+Home');
		await page.keyboard.press('Backspace');
		await page.keyboard.press('Backspace');
		await expect(strip).toHaveCount(0);
		await expect(editor).not.toContainText('SYNTAX');
		// Settings ▸ Editor: the project row shows what its root holds; «Off» stops formatting on save.
		await app.evaluate(({ Menu }) => {
			Menu.getApplicationMenu()!
				.items.flatMap((item) => item.submenu?.items ?? [])
				.find((item) => item.label === 'Settings…')!
				.click();
		});
		const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
		await dialog.getByRole('tab', { name: 'Editor', exact: true }).click();
		await expect(dialog.getByRole('switch', { name: 'On save' })).toBeChecked();
		await expect(dialog).toContainText('Prettier 9.9.9');
		await expect.poll(() => dialog.evaluate((node) => getComputedStyle(node).opacity)).toBe('1');
		await page.screenshot({ path: info.outputPath('settings.png') });
		await dialog.getByRole('button', { name: 'Formatter for repository' }).click();
		await page.getByRole('option', { name: 'Off', exact: true }).click();
		await expect
			.poll(
				async () =>
					JSON.parse(await readFile(join(root, 'data/projects/project/project.json'), 'utf8'))
						.project.formatter
			)
			.toBe('off');
		await page.keyboard.press('Escape');
		await expect(dialog).toHaveCount(0);
		await expect(footer).not.toContainText('Prettier');
		await editor.click();
		await page.keyboard.press('Meta+ArrowDown');
		await page.keyboard.insertText('\nconst  c = "y";');
		await editor.press('Meta+s');
		await expect.poll(() => readFile(join(repo, 'a.js'), 'utf8')).toContain('const  c = "y";');
		// The menu command formats even when saving does not.
		await clean();
		await menu(app, 'Editor', 'Format document');
		await expect(editor).toContainText("const c = 'y';");
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
