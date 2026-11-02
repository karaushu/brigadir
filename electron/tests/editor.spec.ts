import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hideChat, hideWorkArea, openPanelTab, showChat, showWorkArea } from './layout';
const run = promisify(execFile);
const desktop = resolve('apps/desktop');
const executablePath = createRequire(join(desktop, 'package.json'))('electron') as string;
test('editor parks undo, saves explicitly, resolves disk conflicts, keeps a dirty buffer over a window close and protects a dirty tab close @area:editor @smoke', async ({}, info) => {
	test.setTimeout(60000);
	const root = await mkdtemp(join(tmpdir(), 'brigadir-editor-ui-'));
	const repo = join(root, 'repository');
	await mkdir(repo);
	const git = (...args: string[]) => run('git', args, { cwd: repo });
	await git('init', '-q');
	await git('config', 'user.name', 'Fixture');
	await git('config', 'user.email', 'fixture@localhost');
	await writeFile(join(repo, 'example.ts'), 'export const count = 1;\n');
	await writeFile(
		join(repo, 'large.txt'),
		Array.from({ length: 60000 }, (_, i) => `line ${i}\n`).join('')
	);
	await git('add', 'example.ts', 'large.txt');
	await git('commit', '-qm', 'Baseline');
	const index = await readFile(join(repo, '.git/index'));
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
			task: { ...key, title: 'Editor fixture', status: 'done', provider: 'claude' },
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
		env: { ...env, BRIGADIR_DATA_DIR: join(root, 'data') },
	});
	try {
		let page = await app.firstWindow();
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		await page.getByRole('button', { name: /Editor fixture/ }).click();
		await openPanelTab(page, 'files');
		await page
			.getByRole('tree', { name: 'Project files' })
			.getByRole('treeitem', { name: 'example.ts', exact: true })
			.dblclick();
		let editor = page.getByRole('textbox', { name: 'File content' });
		await expect(editor).toContainText('count = 1');
		async function type(text: string) {
			await editor.click();
			await page.keyboard.press('Meta+a');
			await page.keyboard.insertText(text);
		}
		// The menu and double Shift use the same file index and existing editor model.
		await app.evaluate(({ Menu }) =>
			Menu.getApplicationMenu()!
				.items.find((i) => i.label === 'File')!
				.submenu!.items.find((i) => i.label === 'Open Quickly…')!
				.click()
		);
		const search = page.getByRole('dialog', { name: 'Search files' });
		await expect(search).toBeVisible();
		await search.getByRole('combobox', { name: 'Search', exact: true }).fill('exmpts');
		await search.getByRole('option', { name: /example.ts/ }).click();
		await expect(search).toHaveCount(0);
		await expect(editor).toBeVisible();
		await editor.press('Shift');
		await editor.press('Shift');
		await expect(page.getByRole('dialog', { name: 'Search Everywhere' })).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(page.getByRole('dialog', { name: 'Search Everywhere' })).toHaveCount(0);
		await expect(editor).toBeFocused();
		await app.evaluate(({ Menu }) =>
			Menu.getApplicationMenu()!
				.items.find((i) => i.label === 'Editor')!
				.submenu!.items.find((i) => i.label === 'Toggle comment')!
				.click()
		);
		await expect(editor).toContainText('// export const');
		await editor.press('Meta+z');
		await expect(editor).not.toContainText('// export const');
		await type('export const count = 2;\n');
		await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
		expect(await readFile(join(repo, 'example.ts'), 'utf8')).toContain('count = 1');
		// spec/task-window-workspace#layout-switch: the work area hides with its buffers kept; it comes back with the draft.
		await hideWorkArea(page);
		await expect(page.getByRole('textbox', { name: 'File content' })).toHaveCount(0);
		await showWorkArea(page);
		await expect(editor).toContainText('count = 2');
		await editor.press('Meta+z');
		await expect(editor).toContainText('count = 1');
		await editor.press('Meta+Shift+z');
		await expect(editor).toContainText('count = 2');
		// Native menu navigation must retain the JS model and destroy only active DOM.
		await app.evaluate(({ Menu }) => {
			const view = Menu.getApplicationMenu()!.items.find((i) => i.label === 'View')!;
			const item = view.submenu!.items.find((i) => i.label === 'Kit')!;
			item.click();
		});
		await expect(page.getByRole('heading', { name: 'Control kit' })).toBeVisible();
		await expect(page.getByRole('textbox', { name: 'File content' })).toHaveCount(0);
		await app.evaluate(({ Menu }) => {
			const item = Menu.getApplicationMenu()!
				.items.find((i) => i.label === 'View')!
				.submenu!.items.find((i) => i.label === 'Workspace')!;
			item.click();
		});
		await expect(editor).toContainText('count = 2');
		await editor.press('Meta+s');
		await expect.poll(() => readFile(join(repo, 'example.ts'), 'utf8')).toContain('count = 2');
		await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
		expect(await readFile(join(repo, '.git/index'))).toEqual(index);
		await expect
			.poll(async () => {
				const session = await page.evaluate((key) => window.brigadir.readSession(key), key);
				return session.records.filter((r) => r.event.kind === 'file.saved').length;
			})
			.toBe(1);
		await expect(page.getByRole('button', { name: 'example.ts •', exact: true })).toHaveCount(0);
		expect((await page.evaluate((key) => window.brigadir.readSession(key), key)).connected).toBe(
			false
		);
		await openPanelTab(page, 'changes');
		await page
			.getByRole('list', { name: 'Files', exact: true })
			.getByRole('button', { name: /example.ts/ })
			.click();
		await page.getByRole('button', { name: 'Open in editor', exact: true }).click();
		await expect(editor).toContainText('count = 2');
		await expect(page.getByRole('textbox', { name: 'File content' })).toHaveCount(1);
		await openPanelTab(page, 'files');
		// Hold the reply after a real save to exercise edits made while Save is pending.
		await app.evaluate(({ ipcMain }) => {
			const handlers = (ipcMain as any)._invokeHandlers;
			const original = handlers.get('files:save');
			(globalThis as any).restoreSave = () => handlers.set('files:save', original);
			handlers.set('files:save', async (...args: any[]) => {
				const result = await original(...args);
				await new Promise<void>((resolve) => {
					(globalThis as any).finishSave = resolve;
				});
				return result;
			});
		});
		await type('submitted text\n');
		await page.getByRole('button', { name: 'Save', exact: true }).click();
		await expect
			.poll(() => app.evaluate(() => typeof (globalThis as any).finishSave))
			.toBe('function');
		await type('typed during save\n');
		await showChat(page);
		await hideChat(page);
		await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
		await app.evaluate(() => {
			(globalThis as any).restoreSave();
			(globalThis as any).finishSave();
		});
		await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
		await expect(editor).toContainText('typed during save');
		expect(await readFile(join(repo, 'example.ts'), 'utf8')).toBe('submitted text\n');
		await type('my edit\n');
		await writeFile(join(repo, 'example.ts'), 'external edit\n');
		await expect(page.getByRole('alert')).toContainText('This file changed on disk.');
		await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
		await page.getByRole('button', { name: 'Show changes', exact: true }).click();
		const comparison = page.getByRole('region', {
			name: 'Disk file and unsaved edits',
			exact: true,
		});
		await expect(comparison).toContainText('my edit');
		await expect(comparison).toContainText('external edit');
		for (const theme of ['light', 'dark'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await comparison.screenshot({
				animations: 'disabled',
				path: info.outputPath(`disk-buffer-${theme}.png`),
			});
		}
		await comparison.getByRole('button', { name: 'Close', exact: true }).click();
		await expect(comparison).toHaveCount(0);
		expect(await readFile(join(repo, 'example.ts'), 'utf8')).toBe('external edit\n');
		await page.getByRole('button', { name: 'Keep mine', exact: true }).click();
		expect(await readFile(join(repo, 'example.ts'), 'utf8')).toBe('external edit\n');
		const accelerator = await app.evaluate(({ Menu }) => {
			const item = Menu.getApplicationMenu()!
				.items.find((i) => i.label === 'File')!
				.submenu!.items.find((i) => i.label === 'Save')!;
			item.click();
			return item.accelerator;
		});
		expect(accelerator).toBe('CmdOrCtrl+S');
		await expect.poll(() => readFile(join(repo, 'example.ts'), 'utf8')).toBe('my edit\n');
		await type('discard this\n');
		await writeFile(join(repo, 'example.ts'), 'reload this\n');
		await expect(page.getByRole('button', { name: 'Reload', exact: true })).toBeVisible();
		await page.getByRole('button', { name: 'Reload', exact: true }).click();
		await expect(editor).toContainText('reload this');
		await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
		await editor.press('Meta+f');
		await page.getByRole('textbox', { name: 'Find', exact: true }).fill('reload');
		// spec/editor#editor-chrome: the floating panel — › opens the replace row, Esc closes the card.
		const findPanel = page.getByRole('search', { name: 'Find in file' });
		await findPanel.getByRole('button', { name: 'Show replace', exact: true }).click();
		await findPanel.getByRole('textbox', { name: 'Replace', exact: true }).fill('replaced');
		await findPanel.getByRole('button', { name: 'Replace all', exact: true }).click();
		await expect(editor).toContainText('replaced this');
		await findPanel.getByRole('button', { name: 'Close', exact: true }).click();
		await expect(findPanel).toHaveCount(0);
		await type('protect this\n');
		await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
		// spec/task-window-workspace#restore-window: closing the window (the app stays) asks nothing — the dirty buffer goes to
		// drafts/ and the reopened window has the same unsaved text, still unsaved.
		await app.evaluate(({ dialog, BrowserWindow }) => {
			dialog.showMessageBox = async (...args: any[]) => {
				(globalThis as any).closeWarning = args[1];
				return { response: 0, checkboxChecked: false };
			};
			BrowserWindow.getAllWindows()[0]!.close();
		});
		await expect
			.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length))
			.toBe(0);
		expect(await app.evaluate(() => (globalThis as any).closeWarning ?? null)).toBeNull();
		expect(await readFile(join(repo, 'example.ts'), 'utf8')).toBe('reload this\n');
		const reopened = app.waitForEvent('window');
		await app.evaluate(({ app }) => app.emit('activate'));
		page = await reopened;
		page.on('pageerror', (e) => errors.push(e.message));
		editor = page.getByRole('textbox', { name: 'File content' });
		await expect(editor).toContainText('protect this');
		await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
		expect(await app.evaluate(() => (globalThis as any).closeWarning ?? null)).toBeNull();
		// Closing the tab still asks.
		await page.getByRole('button', { name: 'Close file · example.ts' }).click();
		await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
		expect(await readFile(join(repo, 'example.ts'), 'utf8')).toBe('reload this\n');
		const start = Date.now();
		await page
			.getByRole('tree', { name: 'Project files' })
			.getByRole('treeitem', { name: 'large.txt', exact: true })
			.dblclick();
		await expect(editor).toContainText('line 0');
		expect(Date.now() - start).toBeLessThan(3000);
		await expect(page.getByText('Large file. Plain text mode.', { exact: true })).toBeVisible();
		expect(await page.locator('.cm-line').count()).toBeLessThan(200);
		await editor.press('Meta+End');
		await page.keyboard.insertText('last edit');
		await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
		for (const theme of ['light', 'dark'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await page.screenshot({
				animations: 'disabled',
				path: info.outputPath(`editor-${theme}.png`),
			});
		}
		await page.getByRole('button', { name: 'Close file · large.txt' }).click();
		await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
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
test('clean buffers past the LRU limit leave memory but keep their tab, place and lease (EDIT-03) @area:editor', async () => {
	test.setTimeout(60000);
	const root = await mkdtemp(join(tmpdir(), 'brigadir-editor-lru-'));
	const repo = join(root, 'repository');
	await mkdir(repo);
	const git = (...args: string[]) => run('git', args, { cwd: repo });
	await git('init', '-q');
	await git('config', 'user.name', 'Fixture');
	await git('config', 'user.email', 'fixture@localhost');
	const names = Array.from({ length: 15 }, (_, i) => `file${String(i).padStart(2, '0')}.ts`);
	for (const [i, name] of names.entries())
		await writeFile(
			join(repo, name),
			Array.from({ length: 200 }, (_, line) => `export const v${i}_${line} = ${line};\n`).join('')
		);
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
			task: { ...key, title: 'LRU fixture', status: 'done', provider: 'claude' },
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
		env: { ...env, BRIGADIR_DATA_DIR: join(root, 'data') },
	});
	try {
		const page = await app.firstWindow();
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 820));
		await page.getByRole('button', { name: /LRU fixture/ }).click();
		await openPanelTab(page, 'files');
		const tree = page.getByRole('tree', { name: 'Project files' }),
			editor = page.getByRole('textbox', { name: 'File content' });
		// spec/task-window#width-rules: the work area that the first file brings fits beside the chat and the panel in 1280 px; nothing scrolls sideways.
		const sideways = () =>
			page.evaluate(() =>
				[document.scrollingElement!, document.querySelector('[data-columns]')!].map((node) => ({
					overflow: node.scrollWidth - node.clientWidth,
					left: node.scrollLeft,
				}))
			);
		for (const [i, name] of names.entries()) {
			await tree.getByRole('treeitem', { name, exact: true }).dblclick();
			await expect(editor).toContainText(`v${i}_0 `);
			if (i < 2)
				expect(await sideways()).toEqual([
					{ overflow: 0, left: 0 },
					{ overflow: 0, left: 0 },
				]);
			if (i === 0) await page.locator('.cm-line', { hasText: 'v0_5 ' }).click();
			if (i === 1) {
				await editor.click();
				await page.keyboard.press('Meta+End');
				await page.keyboard.insertText('dirty edit');
			}
		}
		const tabs = page.getByRole('tablist', { name: 'Documents' });
		await expect(tabs.getByRole('tab')).toHaveCount(15);
		// file00 is the least recently used clean buffer: its tab reads the file again, the changed disk text included.
		await writeFile(
			join(repo, names[0]!),
			Array.from({ length: 200 }, (_, line) => `export const v0_${line} = ${line}; // disk\n`).join(
				''
			)
		);
		await tabs.getByRole('tab', { name: names[0]!, exact: true }).click();
		await expect(editor).toContainText('v0_5 = 5; // disk');
		await expect(page.locator('.cm-activeLine')).toContainText('v0_5 ');
		await expect(tabs.getByRole('tab', { name: names[0]!, exact: true })).toHaveAttribute(
			'aria-selected',
			'true'
		);
		// The dirty buffer is never evicted; an evicted tab closes and releases its lease like any other.
		await tabs.getByRole('tab', { name: names[1]!, exact: true }).click();
		await expect(editor).toContainText('dirty edit');
		await page.getByRole('button', { name: `Close file · ${names[2]}` }).click();
		await expect(tabs.getByRole('tab')).toHaveCount(14);
		await tabs.getByRole('tab', { name: names[3]!, exact: true }).click();
		await expect(editor).toContainText('v3_0 ');
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
// Disk versus buffer (spec/editor#disk-vs-buffer): reload and undo, Keep mine, a conflict that goes away, raw CRs, marks after a reload.
test('a disk reload, undo, Keep mine and a reverting disk keep the dirty marker and the banner honest; CRLF breaks survive a paste; a raw CR is shown @area:editor @serial', async () => {
	test.setTimeout(180000);
	const root = await mkdtemp(join(tmpdir(), 'brigadir-editor-disk-'));
	const repo = join(root, 'repository');
	await mkdir(repo);
	const git = (...args: string[]) => run('git', args, { cwd: repo });
	await git('init', '-q');
	await git('config', 'user.name', 'Fixture');
	await git('config', 'user.email', 'fixture@localhost');
	const base = 'alpha\nbeta\ngamma\n',
		cur = base + 'delta\n';
	await writeFile(join(repo, 'a.txt'), base);
	await writeFile(join(repo, 'mixed.txt'), 'one\r\ntwo\nthree\r\n');
	await writeFile(join(repo, 'windows.txt'), 'one\r\ntwo\r\nthree\r\n');
	await writeFile(join(repo, 'unix.txt'), 'one\ntwo\n');
	const long = Array.from({ length: 400 }, (_, i) => `line ${i + 1}`);
	await writeFile(join(repo, 'long.txt'), long.join('\n') + '\n');
	await git('add', '.');
	await git('commit', '-qm', 'Baseline');
	const env = Object.fromEntries(
		Object.entries(process.env).filter(
			(e): e is [string, string] => typeof e[1] === 'string' && e[0] !== 'ELECTRON_RUN_AS_NODE'
		)
	);
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
		await page.getByRole('textbox', { name: 'Message', exact: true }).fill('hello');
		await page.getByRole('button', { name: 'Start', exact: true }).click();
		await expect(page.getByRole('log')).toContainText('world', { timeout: 20000 });
		await openPanelTab(page, 'files');
		const tree = page.getByRole('tree', { name: 'Project files' });
		const editor = page.getByRole('textbox', { name: 'File content' });
		const mark = page.locator('section[data-font-surface=editor] > header strong');
		const banner = page.getByRole('alert');
		const disk = async (text: string) => {
			await writeFile(join(repo, 'a.txt'), text);
			await page.evaluate(() => window.dispatchEvent(new Event('focus')));
		};
		const text = () =>
			editor
				.locator('.cm-line')
				.allTextContents()
				.then((lines) => lines.join('\n'));
		await tree.getByRole('treeitem', { name: 'a.txt', exact: true }).dblclick();
		await expect(editor).toContainText('gamma');
		await expect(mark).not.toContainText('•');

		// A quiet reload of a clean buffer shows its change marks at once, and ⌘Z after it leaves a dirty buffer, so saving is a choice.
		await disk(base + 'delta\n');
		await expect(editor).toContainText('delta', { timeout: 8000 });
		// The first gutter read of a file is cold (git); the second reload is the one that must show its marks without waiting for a poll.
		const added = page.locator('.cm-changeGutter [data-change="add"]');
		await expect(added).toHaveCount(1, { timeout: 20000 });
		await expect(mark).not.toContainText('•');
		await disk('omega\n' + base + 'delta\n');
		await expect(editor).toContainText('omega', { timeout: 8000 });
		await expect(added).toHaveCount(2, { timeout: 1500 });
		await editor.click();
		await editor.press('Meta+z');
		await expect(editor).not.toContainText('omega');
		await expect(mark).toContainText('•');
		expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('omega\n' + base + 'delta\n');
		await editor.press('Meta+s');
		await expect.poll(() => readFile(join(repo, 'a.txt'), 'utf8')).toBe(cur);
		await expect(mark).not.toContainText('•');

		// After «Keep mine» the base is the disk text, so undo back to the old text is a change to save, not a silent stale buffer.
		await editor.click();
		await page.keyboard.press('Meta+Home');
		await page.keyboard.insertText('mine ');
		await expect(mark).toContainText('•');
		await disk('disk\nbeta\ngamma\ndelta\n');
		await expect(banner).toBeVisible({ timeout: 8000 });
		await page.getByRole('button', { name: 'Keep mine', exact: true }).click();
		await expect(banner).toHaveCount(0);
		await expect(mark).toContainText('•');
		await editor.press('Meta+z');
		await expect(editor).not.toContainText('mine');
		await expect(editor).toContainText('alpha');
		await expect(mark).toContainText('•');
		await editor.press('Meta+s');
		await expect.poll(() => readFile(join(repo, 'a.txt'), 'utf8')).toBe(cur);
		await expect(mark).not.toContainText('•');

		// A conflict goes away by itself when the disk holds the buffer's text again.
		await editor.click();
		await page.keyboard.press('Meta+Home');
		await page.keyboard.insertText('mine ');
		await disk('other\nbeta\ngamma\ndelta\n');
		await expect(banner).toBeVisible({ timeout: 8000 });
		await disk('mine alpha\nbeta\ngamma\ndelta\n');
		await expect(banner).toHaveCount(0, { timeout: 8000 });
		await expect(mark).not.toContainText('•');
		expect(await text()).toBe('mine alpha\nbeta\ngamma\ndelta\n');
		// The disk back at the text the buffer was read from also ends the conflict (the buffer stays dirty against it).
		await editor.click();
		await page.keyboard.press('Meta+End');
		await page.keyboard.insertText('x');
		await expect(mark).toContainText('•');
		await disk('other\nbeta\ngamma\ndelta\n');
		await expect(banner).toBeVisible({ timeout: 8000 });
		await disk('mine alpha\nbeta\ngamma\ndelta\n');
		await expect(banner).toHaveCount(0, { timeout: 8000 });
		await expect(mark).toContainText('•');

		// Line breaks of a CRLF file survive a paste, and a disk reload of a clean buffer keeps the caret and the scroll.
		await tree.getByRole('treeitem', { name: 'windows.txt', exact: true }).dblclick();
		await expect(editor).toContainText('three');
		await editor.click();
		await page.keyboard.press('Meta+ArrowDown');
		await page.evaluate(() => {
			const target = document.querySelector('[data-font-surface=editor] .cm-content')!;
			const data = new DataTransfer();
			data.setData('text/plain', 'pasted a\npasted b\n');
			target.dispatchEvent(
				new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
			);
		});
		await expect(editor).toContainText('pasted b');
		await page.keyboard.press('Meta+s');
		await expect.poll(() => readFile(join(repo, 'windows.txt'), 'utf8')).toContain('pasted b');
		expect(await readFile(join(repo, 'windows.txt'), 'utf8')).toBe(
			'one\r\ntwo\r\nthree\r\npasted a\r\npasted b\r\n'
		);

		// Text copied from a Windows source into an LF file arrives with LF breaks, not with stray CRs.
		await tree.getByRole('treeitem', { name: 'unix.txt', exact: true }).dblclick();
		await expect(editor).toContainText('two');
		await editor.click();
		await page.keyboard.press('Meta+ArrowDown');
		await page.evaluate(() => {
			const target = document.querySelector('[data-font-surface=editor] .cm-content')!;
			const data = new DataTransfer();
			data.setData('text/plain', 'from\r\nwindows\r\n');
			target.dispatchEvent(
				new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
			);
		});
		await expect(editor).toContainText('windows');
		await page.keyboard.press('Meta+s');
		await expect.poll(() => readFile(join(repo, 'unix.txt'), 'utf8')).toContain('windows');
		expect(await readFile(join(repo, 'unix.txt'), 'utf8')).toBe('one\ntwo\nfrom\nwindows\n');

		await tree.getByRole('treeitem', { name: 'long.txt', exact: true }).dblclick();
		await expect(editor).toContainText('line 1');
		// The caret moves by a transaction that asks for it to be scrolled into view (what ArrowUp does), not by 150 key presses: a window
		// in the background does not scroll on keys. The check is the caret line's box against the scroller's box, not a key count.
		await editor.click();
		await page.keyboard.press('Meta+ArrowDown');
		await editor.evaluate((node) => {
			const view = (
				node as unknown as {
					cmTile: {
						root: {
							view: {
								state: { doc: { line(n: number): { from: number } } };
								dispatch(spec: object): void;
							};
						};
					};
				}
			).cmTile.root.view;
			view.dispatch({ selection: { anchor: view.state.doc.line(251).from }, scrollIntoView: true });
		});
		const state = () =>
			page.evaluate(() => {
				const scroller = document.querySelector('[data-font-surface=editor] .cm-scroller')!,
					box = scroller.getBoundingClientRect(),
					caret = document.querySelector('.cm-activeLine')?.getBoundingClientRect();
				return {
					line: document.querySelector('.cm-activeLine')?.textContent ?? '',
					top: scroller.scrollTop,
					visible: Boolean(caret && caret.top >= box.top && caret.bottom <= box.bottom),
				};
			});
		await expect.poll(async () => (await state()).line).toMatch(/^line 251/);
		await expect.poll(async () => (await state()).visible).toBe(true);
		const before = await state();
		expect(before.top).toBeGreaterThan(1000);
		long[253] = 'changed outside';
		await writeFile(join(repo, 'long.txt'), long.join('\n') + '\n');
		await page.evaluate(() => window.dispatchEvent(new Event('focus')));
		await expect(editor.getByText('changed outside')).toHaveCount(1, { timeout: 8000 });
		const after = await state();
		expect(after.line).toMatch(/^line 251/);
		expect(Math.abs(after.top - before.top)).toBeLessThan(40);

		// A disk-versus-buffer comparison belongs to the conflict it was opened for: Reload and Keep mine end it.
		for (const choice of ['Reload', 'Keep mine']) {
			await editor.click();
			await page.keyboard.press('Meta+Home');
			await page.keyboard.insertText('mine ');
			long[0] = `disk ${choice}`;
			await writeFile(join(repo, 'long.txt'), long.join('\n') + '\n');
			await page.evaluate(() => window.dispatchEvent(new Event('focus')));
			await page.getByRole('button', { name: 'Show changes', exact: true }).click();
			const comparison = page.getByRole('region', {
				name: 'Disk file and unsaved edits',
				exact: true,
			});
			await expect(comparison).toBeVisible();
			await page.getByRole('button', { name: choice, exact: true }).click();
			await expect(page.getByRole('alert')).toHaveCount(0);
			await expect(comparison).toHaveCount(0);
			if (choice === 'Keep mine') await editor.press('Meta+s');
			await expect
				.poll(() => readFile(join(repo, 'long.txt'), 'utf8'))
				.toContain(choice === 'Keep mine' ? 'mine disk' : `disk ${choice}`);
			await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
		}

		// A raw CR of a mixed file is a visible, muted sign; a CRLF file has none in its lines.
		await tree.getByRole('treeitem', { name: 'mixed.txt', exact: true }).dblclick();
		await expect(editor).toContainText('three');
		const marks = editor.locator('.cm-raw-cr');
		await expect(marks).toHaveCount(2);
		await tree.getByRole('treeitem', { name: 'windows.txt', exact: true }).dblclick();
		await expect(editor).toContainText('two');
		await expect(editor.locator('.cm-raw-cr')).toHaveCount(0);
	} finally {
		await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
		await rm(root, { recursive: true, force: true });
	}
});
