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
// spec/editor-code-intelligence#typing-help: call parentheses, bracket and quote pairs, closing tags, and the switches of Settings ▸ Editor ▸ Code.
test('completes a function with parentheses, pairs brackets, closes tags and follows the Code switches @area:editor', async ({}, info) => {
	test.setTimeout(120000);
	const root = await mkdtemp(join(tmpdir(), 'brigadir-editor-typing-'));
	const repo = join(root, 'repository');
	await mkdir(repo, { recursive: true });
	const git = (...args: string[]) => run('git', args, { cwd: repo });
	await git('init', '-q');
	await git('config', 'user.name', 'Fixture');
	await git('config', 'user.email', 'fixture@localhost');
	await writeFile(
		join(repo, 'tsconfig.json'),
		'{"compilerOptions":{"strict":true,"jsx":"preserve","module":"esnext","moduleResolution":"bundler","noEmit":true}}\n'
	);
	await writeFile(
		join(repo, 'a.ts'),
		'export function greet(name: string): string { return name; }\n'
	);
	await writeFile(join(repo, 'c.tsx'), 'import { greet } from "./a";\n');
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
			task: { ...key, title: 'Typing fixture', status: 'done', provider: 'claude' },
		})
	);
	// The saved file is compared as typed: the language server does not format it on save.
	await writeFile(
		join(root, 'data/settings.json'),
		JSON.stringify({
			schemaVersion: 1,
			settings: {
				appearance: process.env.CODE_INTEL_THEME ?? 'system',
				language: 'system',
				editor: { format: 'off', diffBase: 'task' },
			},
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
		await page.getByRole('button', { name: /Typing fixture/ }).click();
		await openPanelTab(page, 'files');
		await page
			.getByRole('tree', { name: 'Project files' })
			.getByRole('treeitem', { name: 'c.tsx', exact: true })
			.dblclick();
		const editor = page.getByRole('textbox', { name: 'File content' });
		await expect(editor).toContainText('import { greet }');
		const footer = page.locator('section[data-font-surface=editor] > footer');
		const line = (start: string) => page.locator('.cm-line', { hasText: start });
		await editor.click();
		await page.keyboard.press('Meta+ArrowDown');
		// A completed function gets `()` with the cursor inside; the typed `"` and `)` step over the pair.
		await page.keyboard.type('const g = gre');
		await expect(
			page.locator('.cm-tooltip-autocomplete').getByRole('option', { name: /^greet/ })
		).toBeVisible({ timeout: 20000 });
		// The list ignores Enter for its interaction delay (75 ms) after it opens.
		await page.waitForTimeout(200);
		await page.keyboard.press('Enter');
		await expect(line('const g')).toHaveText('const g = greet()');
		await expect(page.locator('.cm-code-signature')).toContainText('name: string', {
			timeout: 10000,
		});
		await page.screenshot({ path: info.outputPath('call-parens.png') });
		await page.keyboard.type('"x");');
		await expect(line('const g')).toHaveText('const g = greet("x");');
		const next = async () => {
			await page.keyboard.press('Escape');
			await page.keyboard.press('End');
			await page.keyboard.press('Enter');
		};
		// `>` closes the tag, for an element and a component; Enter between the tags opens a block.
		await next();
		await page.keyboard.type('const el = <div>');
		await expect(line('const el')).toHaveText('const el = <div></div>');
		await page.keyboard.type('hi');
		await page.keyboard.press('End');
		await page.keyboard.type(';');
		await next();
		await page.keyboard.type('const card = <Card title="a">');
		await expect(line('const card')).toHaveText('const card = <Card title="a"></Card>');
		await page.keyboard.press('End');
		await page.keyboard.type(';');
		await next();
		await page.keyboard.type('const box = (<section>');
		await page.keyboard.press('Enter');
		await page.keyboard.type('ok');
		await page.keyboard.press('Meta+ArrowDown');
		await page.keyboard.type(';');
		// `<` pairs only in a generic.
		await next();
		await page.keyboard.type('let list: Array<string> = [];');
		await next();
		await page.keyboard.type('const less = 1 < 2;');
		await page.screenshot({ path: info.outputPath('typed.png') });
		// Settings ▸ Editor ▸ Code: closing tags off.
		await app.evaluate(({ Menu }) => {
			Menu.getApplicationMenu()!
				.items.flatMap((item) => item.submenu?.items ?? [])
				.find((item) => item.label === 'Settings…')!
				.click();
		});
		const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
		await dialog.getByRole('tab', { name: 'Editor', exact: true }).click();
		for (const name of ['Language servers', 'Bracket pairs', 'Closing tags', 'Call parentheses'])
			await expect(dialog.getByRole('switch', { name, exact: true })).toBeChecked();
		await expect.poll(() => dialog.evaluate((node) => getComputedStyle(node).opacity)).toBe('1');
		await page.screenshot({ path: info.outputPath('settings.png') });
		await dialog.getByRole('switch', { name: 'Closing tags', exact: true }).click();
		await expect
			.poll(
				async () =>
					JSON.parse(await readFile(join(root, 'data/settings.json'), 'utf8')).settings.editor
						.closeTags
			)
			.toBe(false);
		await page.keyboard.press('Escape');
		await expect(dialog).toHaveCount(0);
		await editor.click();
		await page.keyboard.press('Meta+ArrowDown');
		await page.keyboard.press('Enter');
		await page.keyboard.type('const off = <span>');
		await expect(line('const off')).toHaveText('const off = <span>');
		await page.keyboard.press('Meta+s');
		await expect
			.poll(() => readFile(join(repo, 'c.tsx'), 'utf8'), { timeout: 15000 })
			.toBe(
				[
					'import { greet } from "./a";',
					'const g = greet("x");',
					'const el = <div>hi</div>;',
					'const card = <Card title="a"></Card>;',
					'const box = (<section>',
					'  ok',
					'</section>);',
					'let list: Array<string> = [];',
					'const less = 1 < 2;',
					'const off = <span>',
				].join('\n')
			);
		// Language servers off: call parentheses are unavailable and definitions are found by name.
		await app.evaluate(({ Menu }) => {
			Menu.getApplicationMenu()!
				.items.flatMap((item) => item.submenu?.items ?? [])
				.find((item) => item.label === 'Settings…')!
				.click();
		});
		await dialog.getByRole('tab', { name: 'Editor', exact: true }).click();
		await dialog.getByRole('switch', { name: 'Language servers', exact: true }).click();
		await expect(
			dialog.getByRole('switch', { name: 'Call parentheses', exact: true })
		).toBeDisabled();
		await expect
			.poll(
				async () =>
					JSON.parse(await readFile(join(root, 'data/settings.json'), 'utf8')).settings.editor
						.languageServers
			)
			.toBe(false);
		await page.keyboard.press('Escape');
		await expect(dialog).toHaveCount(0);
		await line('const g').locator('.syntax-function', { hasText: 'greet' }).click();
		await menu(app, 'Editor', 'Go to definition');
		// By name the declaration is found in a.ts too: JS, TS and TSX are one family for the fallback.
		await expect(editor).toContainText('export function greet', { timeout: 20000 });
		await expect(footer).toContainText('Found by name: language servers are off.');
		await page.screenshot({ path: info.outputPath('servers-off.png') });
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
