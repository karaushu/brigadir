import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
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
// spec/editor-code-intelligence#architecture: bundled TypeScript server, name-based fallback for Python, and ⌘+click from the diff.
test('goes to definitions, completes, hovers, lists references, shows problems and follows ⌘+click from the diff @area:editor', async ({}, info) => {
	test.setTimeout(120000);
	const root = await mkdtemp(join(tmpdir(), 'brigadir-code-intel-'));
	const repo = join(root, 'repository');
	await mkdir(join(repo, 'lib'), { recursive: true });
	const git = (...args: string[]) => run('git', args, { cwd: repo });
	await git('init', '-q');
	await git('config', 'user.name', 'Fixture');
	await git('config', 'user.email', 'fixture@localhost');
	await writeFile(
		join(repo, 'tsconfig.json'),
		'{"compilerOptions":{"strict":true,"module":"esnext","moduleResolution":"bundler","noEmit":true}}\n'
	);
	await writeFile(
		join(repo, 'a.ts'),
		'export const answer = 42;\n/** Says hello. */\nexport function greet(name: string): string { return name; }\n'
	);
	await writeFile(
		join(repo, 'b.ts'),
		'import { greet } from "./a";\nexport const text = greet("x");\n'
	);
	await writeFile(join(repo, 'lib/tool.py'), 'def helper():\n    return 1\n');
	await writeFile(join(repo, 'main.py'), 'from lib.tool import helper\nhelper()\n');
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
			task: { ...key, title: 'Code intel fixture', status: 'done', provider: 'claude' },
		})
	);
	// Visual review runs set the theme through the app's own setting (rule 5: nativeTheme only).
	if (process.env.CODE_INTEL_THEME)
		await writeFile(
			join(root, 'data/settings.json'),
			JSON.stringify({
				schemaVersion: 1,
				settings: { appearance: process.env.CODE_INTEL_THEME, language: 'system' },
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
		const shot = (name: string) =>
			page.screenshot({
				path: info.outputPath(`${name}-${process.env.CODE_INTEL_THEME ?? 'system'}.png`),
			});
		const page = await app.firstWindow();
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		await page.getByRole('button', { name: /Code intel fixture/ }).click();
		await openPanelTab(page, 'files');
		const tree = page.getByRole('tree', { name: 'Project files' });
		await tree.getByRole('treeitem', { name: 'b.ts', exact: true }).dblclick();
		const editor = page.getByRole('textbox', { name: 'File content' });
		await expect(editor).toContainText('greet("x")');
		const footer = page.locator('section[data-font-surface=editor] > footer');
		// ⌘+click on the call opens a.ts on the declaration; Previous location comes back.
		const call = page
			.locator('.cm-line', { hasText: 'export const text' })
			.locator('.syntax-function', { hasText: 'greet' });
		await expect(call).toBeVisible();
		await call.click({ modifiers: ['Meta'] });
		await expect(editor).toContainText('export function greet', { timeout: 30000 });
		await expect(footer).toContainText('3:17');
		await menu(app, 'Navigate', 'Previous location');
		await expect(editor).toContainText('greet("x")');
		await expect(footer).toContainText('2:');
		// Hover shows the type and the documentation.
		await call.hover();
		const hover = page.locator('.cm-code-hover');
		await expect(hover).toContainText('greet(name: string): string', { timeout: 15000 });
		await expect(hover).toContainText('Says hello.');
		await shot('hover');
		await footer.hover();
		// Completion with an auto-import of `answer` into the existing import.
		await editor.click();
		await page.keyboard.press('Meta+ArrowDown');
		await page.keyboard.press('End');
		await page.keyboard.insertText('\nconst value = answ');
		const list = page.locator('.cm-tooltip-autocomplete');
		await expect(list.getByRole('option', { name: /^answer/ })).toBeVisible({ timeout: 15000 });
		await shot('completion');
		await page.keyboard.press('Enter');
		await expect(editor).toContainText('const value = answer');
		await expect(editor).toContainText(/import \{ (answer, greet|greet, answer) \} from "\.\/a"/, {
			timeout: 10000,
		});
		// Parameters on `(`, closed by Escape.
		await page.keyboard.insertText(';\ngreet(');
		const signature = page.locator('.cm-code-signature');
		await expect(signature).toContainText('name: string', { timeout: 10000 });
		await shot('signature');
		await page.keyboard.press('Escape');
		await expect(signature).toHaveCount(0);
		await page.keyboard.insertText('1);');
		// A type error becomes a problem; Next problem moves to it.
		await expect(page.locator('.cm-lintRange-error')).toHaveCount(1, { timeout: 15000 });
		await page.keyboard.press('Meta+ArrowUp');
		await menu(app, 'Editor', 'Next problem');
		await expect(page.locator('.cm-tooltip-lint, .cm-panel-lint').first()).toBeAttached();
		// References of greet: a modal with Esc, grouped by file, focus back in the editor.
		await page.keyboard.press('Escape');
		await expect(page.locator('.cm-tooltip-hover')).toHaveCount(0);
		await call.click();
		await menu(app, 'Editor', 'Find references');
		const references = page.getByRole('dialog', { name: 'References' });
		await expect(references).toBeVisible();
		await expect(references.getByRole('group', { name: 'a.ts' })).toBeVisible();
		await expect(references.getByRole('button', { name: 'Close' })).toHaveText('Esc');
		await shot('references');
		await page.keyboard.press('Escape');
		await expect(references).toHaveCount(0);
		await expect(editor).toBeFocused();
		await shot('editor');
		// Save so the diff has b.ts; ⌘+click in the new side of the diff opens the definition.
		await page.keyboard.press('Meta+s');
		await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled({
			timeout: 15000,
		});
		await openPanelTab(page, 'changes');
		await page
			.getByRole('list', { name: 'Files', exact: true })
			.getByRole('button', { name: /b\.ts/ })
			.click();
		const diffCall = page
			.locator('[data-side=new]', { hasText: 'greet(1)' })
			.locator('.syntax-function', { hasText: 'greet' })
			.first();
		await expect(diffCall).toBeVisible();
		await diffCall.click({ modifiers: ['Meta'] });
		await expect(editor).toContainText('export function greet', { timeout: 20000 });
		await expect(footer).toContainText('3:17');
		// spec/editor-code-intelligence#definition-and-usages: ⌘+click on the declaration itself opens the same References modal instead of going nowhere.
		const declaration = page
			.locator('.cm-line', { hasText: 'export function greet' })
			.locator('.syntax-function', { hasText: 'greet' });
		await declaration.click({ modifiers: ['Meta'] });
		const own = page.getByRole('dialog', { name: 'References' });
		await expect(own).toBeVisible({ timeout: 20000 });
		await expect(own.getByRole('group', { name: 'b.ts' })).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(own).toHaveCount(0);
		await expect(editor).toBeFocused();
		await expect(footer).toContainText('3:');
		// Python has no server on this PATH: the name-based fallback finds the declaration in lib/tool.py.
		await openPanelTab(page, 'files');
		await tree.getByRole('treeitem', { name: 'main.py', exact: true }).dblclick();
		await expect(editor).toContainText('helper()');
		const helper = page.locator('.cm-line', { hasText: /^helper\(\)$/ });
		await helper.click();
		await page.keyboard.press('Home');
		await menu(app, 'Editor', 'Go to definition');
		await expect(editor).toContainText('def helper', { timeout: 20000 });
		await expect(footer).toContainText('Found by name');
		await shot('fallback');
		// spec/editor-code-intelligence#definition-and-usages in the fallback: ⌘+click on `def helper` lists the text matches of the name.
		await page
			.locator('.cm-line', { hasText: 'def helper' })
			.getByText('helper', { exact: true })
			.click({ modifiers: ['Meta'] });
		const matches = page.getByRole('dialog', { name: 'References' });
		await expect(matches).toBeVisible({ timeout: 20000 });
		await expect(matches).toContainText('Text matches');
		await expect(matches.getByRole('group', { name: 'main.py' })).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(matches).toHaveCount(0);
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
