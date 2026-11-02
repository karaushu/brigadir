import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hideChat, openPanelTab } from './layout';
const run = promisify(execFile);
const desktop = resolve('apps/desktop');
const executablePath = createRequire(join(desktop, 'package.json'))('electron') as string;
const env = Object.fromEntries(
	Object.entries(process.env).filter(
		(e): e is [string, string] => typeof e[1] === 'string' && e[0] !== 'ELECTRON_RUN_AS_NODE'
	)
);
// A committed repo with `files` and one done task titled `title`, opened in a fresh app.
const fixture = async (title: string, files: Record<string, string>) => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-tabs-'));
	const repo = join(root, 'repository');
	await mkdir(repo);
	const git = (...args: string[]) => run('git', args, { cwd: repo });
	await git('init', '-q');
	await git('config', 'user.name', 'Fixture');
	await git('config', 'user.email', 'fixture@localhost');
	for (const [name, text] of Object.entries(files)) await writeFile(join(repo, name), text);
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
			task: { ...key, title, status: 'done', provider: 'claude' },
		})
	);
	const app = await electron.launch({
		executablePath,
		args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
		env: { ...env, BRIGADIR_DATA_DIR: join(root, 'data') },
	});
	return { root, repo, app };
};
const sources = (names: string[]) =>
	Object.fromEntries(names.map((name) => [name, `export const ${name[0]} = 1;\n`]));
const menuItem = (app: ElectronApplication, id: string) =>
	app.evaluate(({ Menu }, id) => {
		const item = Menu.getApplicationMenu()!.getMenuItemById(id);
		return item ? { enabled: item.enabled, accelerator: item.accelerator ?? null } : null;
	}, id);
const longNames = Array.from(
	{ length: 12 },
	(_, i) => `module-${String(i + 1).padStart(2, '0')}-long-name.ts`
);
// spec/editor#tab-menu: a document tab's menu closes it, the others, those to the right, the unmodified ones or all; dirty buffers ask together.
test('the document tab menu closes tabs in groups and copies the path @area:editor @serial', async () => {
	test.setTimeout(60000);
	const names = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'];
	const { root, repo, app } = await fixture('Tab menu fixture', sources(names));
	// The menu is captured instead of shown, and the copy items write here instead of the system clipboard.
	await app.evaluate(({ Menu, clipboard }) => {
		const state = globalThis as any;
		Menu.prototype.popup = function (options) {
			state.menu = this;
			state.options = options;
		};
		clipboard.writeText = ((text: string) => {
			state.copied = text;
		}) as never;
	});
	const items = async () => {
		await expect.poll(() => app.evaluate(() => !!(globalThis as any).menu)).toBe(true);
		return app.evaluate(
			() =>
				(globalThis as any).menu.items.map((item: any) =>
					item.type === 'separator' ? '-' : `${item.label}${item.enabled ? '' : ' (off)'}`
				) as string[]
		);
	};
	const choose = async (label: string) => {
		await items();
		await app.evaluate((_, label) => {
			const state = globalThis as any,
				item = state.menu.items.find((item: any) => item.label === label);
			if (!item?.enabled) throw new Error(`Unavailable: ${label}`);
			item.click();
			state.options?.callback?.();
			state.menu = null;
		}, label);
	};
	try {
		const page = await app.firstWindow();
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		await page.getByRole('button', { name: /Tab menu fixture/ }).click();
		await openPanelTab(page, 'files');
		const tree = page.getByRole('tree', { name: 'Project files' }),
			editor = page.getByRole('textbox', { name: 'File content' }),
			tabs = page.getByRole('tablist', { name: 'Documents' });
		const tab = (name: string) => tabs.getByRole('tab', { name, exact: true }),
			open = () =>
				tabs
					.getByRole('tab')
					.evaluateAll((list) => list.map((item) => item.getAttribute('aria-label')));
		for (const name of names) {
			await tree.getByRole('treeitem', { name, exact: true }).dblclick();
			await expect(editor).toContainText(`${name[0]} = 1`);
		}

		// The composition is fixed; the last tab has nothing to its right. The path items copy the file's paths.
		await tab('e.ts').click({ button: 'right' });
		expect(await items()).toEqual([
			'Close',
			'Close other tabs',
			'Close all tabs',
			'Close unmodified tabs',
			'Close tabs to the right (off)',
			// spec/editor#reopen-closed-tab: nothing closed yet.
			'Reopen closed tab (off)',
			'-',
			'Copy relative path',
			'Copy absolute path',
			'Show in file manager',
			'-',
			'Split right',
			'Split down',
			'Split and move right',
			'Split and move down',
			'Move to the other group (off)',
			'Unsplit (off)',
			'Unsplit all (off)',
		]);
		// spec/editor#editor-groups: every item carries its glyph as a template image, tinted by macOS for the theme.
		expect(
			await app.evaluate(() =>
				(globalThis as any).menu.items
					.filter((item: any) => item.type !== 'separator')
					.every((item: any) => item.icon && !item.icon.isEmpty() && item.icon.isTemplateImage())
			)
		).toBe(true);
		await choose('Copy relative path');
		expect(await app.evaluate(() => (globalThis as any).copied)).toBe('e.ts');

		// Close tabs to the right of c.ts; the active e.ts goes, so c.ts comes to the front.
		await tab('c.ts').click({ button: 'right' });
		await choose('Close tabs to the right');
		await expect.poll(open).toEqual(['a.ts', 'b.ts', 'c.ts']);
		await expect(tab('c.ts')).toHaveAttribute('aria-selected', 'true');
		await expect(editor).toContainText('c = 1');

		// A dirty b.ts survives Close unmodified tabs; ⇧F10 opens the same menu from the keyboard.
		await tab('b.ts').click();
		await editor.click();
		await page.keyboard.press('Meta+a');
		await page.keyboard.insertText('dirty\n');
		// spec/editor#document-tabs: the unsaved dot in the ×'s place.
		await expect(tab('b.ts').getByRole('img', { name: 'Unsaved' })).toHaveCount(1);
		await tab('a.ts').focus();
		await page.keyboard.press('Shift+F10');
		await choose('Close unmodified tabs');
		await expect.poll(open).toEqual(['b.ts']);
		await expect(
			page.getByRole('alert').filter({ hasText: 'There are unsaved changes.' })
		).toHaveCount(0);

		// Close all tabs asks once for the dirty buffer; Keep editing keeps it, Discard closes it without writing.
		for (const name of ['a.ts', 'c.ts'])
			await tree.getByRole('treeitem', { name, exact: true }).dblclick();
		await expect.poll(open).toEqual(['b.ts', 'a.ts', 'c.ts']);
		await tab('a.ts').click({ button: 'right' });
		await choose('Close all tabs');
		const notice = page.getByRole('alert').filter({ hasText: 'There are unsaved changes.' });
		await expect(notice).toContainText('b.ts');
		await expect.poll(open).toEqual(['b.ts']);
		await notice.getByRole('button', { name: 'Keep editing', exact: true }).click();
		await expect(notice).toHaveCount(0);
		await expect(tab('b.ts')).toBeVisible();

		// Close other tabs from the dirty tab keeps it and closes the rest.
		for (const name of ['d.ts', 'e.ts'])
			await tree.getByRole('treeitem', { name, exact: true }).dblclick();
		await tab('b.ts').click({ button: 'right' });
		await choose('Close other tabs');
		await expect.poll(open).toEqual(['b.ts']);
		await tab('b.ts').click({ button: 'right' });
		expect(await items()).toEqual([
			'Close',
			'Close other tabs (off)',
			'Close all tabs',
			'Close unmodified tabs (off)',
			'Close tabs to the right (off)',
			'Reopen closed tab',
			'-',
			'Copy relative path',
			'Copy absolute path',
			'Show in file manager',
			'-',
			'Split right',
			'Split down',
			'Split and move right (off)',
			'Split and move down (off)',
			'Move to the other group (off)',
			'Unsplit (off)',
			'Unsplit all (off)',
		]);
		await choose('Close');
		await notice.getByRole('button', { name: 'Discard changes', exact: true }).click();
		await expect(tabs.getByRole('tab')).toHaveCount(0);
		expect(await readFile(join(repo, 'b.ts'), 'utf8')).toBe('export const b = 1;\n');
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});

// spec/editor#closing-tabs: a middle click on a document tab closes it exactly like its ×.
test('middle click closes a file or diff tab like ×; a dirty buffer still asks @area:editor @serial', async () => {
	test.setTimeout(60000);
	const { root, repo, app } = await fixture(
		'Tabs fixture',
		sources(['a.ts', 'b.ts', 'c.ts', 'd.ts'])
	);
	try {
		const page = await app.firstWindow();
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		await page.getByRole('button', { name: /Tabs fixture/ }).click();
		await openPanelTab(page, 'files');
		const tree = page.getByRole('tree', { name: 'Project files' }),
			editor = page.getByRole('textbox', { name: 'File content' }),
			tabs = page.getByRole('tablist', { name: 'Documents' });
		for (const name of ['a.ts', 'b.ts', 'c.ts', 'd.ts']) {
			await tree.getByRole('treeitem', { name, exact: true }).dblclick();
			await expect(editor).toContainText(`${name[0]} = 1`);
		}
		// Save an edit to d.ts so the Diff list has a file to open as a diff tab.
		await editor.click();
		await page.keyboard.press('Meta+a');
		await page.keyboard.insertText('export const d = 2;\n');
		await page.keyboard.press('Meta+s');
		await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled({
			timeout: 15000,
		});
		await openPanelTab(page, 'changes');
		await page
			.getByRole('list', { name: 'Files', exact: true })
			.getByRole('button', { name: /d\.ts/ })
			.click();
		const diffTab = tabs.getByRole('tab', { name: 'Diff · d.ts', exact: true });
		await expect(diffTab).toBeVisible();
		await expect(tabs.getByRole('tab')).toHaveCount(5);
		// spec/editor#tab-menu: a local diff tab's menu copies the file's project-relative path, like the Changes list.
		await app.evaluate(({ Menu, clipboard }) => {
			const state = globalThis as any;
			Menu.prototype.popup = function (options) {
				state.menu = this;
				state.options = options;
			};
			clipboard.writeText = ((text: string) => {
				state.copied = text;
			}) as never;
		});
		await diffTab.click({ button: 'right' });
		await expect.poll(() => app.evaluate(() => !!(globalThis as any).menu)).toBe(true);
		await app.evaluate(() => {
			const state = globalThis as any;
			state.menu.items.find((item: any) => item.label === 'Copy relative path').click();
			state.options?.callback?.();
			state.menu = null;
		});
		expect(await app.evaluate(() => (globalThis as any).copied)).toBe('d.ts');
		// A middle click on a clean file tab closes it; the next tab becomes active as after ×.
		await tabs.getByRole('tab', { name: 'c.ts', exact: true }).click();
		await expect(editor).toContainText('c = 1');
		await tabs.getByRole('tab', { name: 'c.ts', exact: true }).click({ button: 'middle' });
		await expect(tabs.getByRole('tab', { name: 'c.ts', exact: true })).toHaveCount(0);
		await expect(tabs.getByRole('tab')).toHaveCount(4);
		// The diff tab shares the strip and closes the same way.
		await diffTab.click({ button: 'middle' });
		await expect(diffTab).toHaveCount(0);
		await expect(tabs.getByRole('tab')).toHaveCount(3);
		// A right click is not a close: it opens the tab menu (spec/editor#tab-menu), dismissed here without a choice.
		await app.evaluate(({ Menu }) => {
			const state = globalThis as any;
			Menu.prototype.popup = function (options) {
				state.menu = this;
				options?.callback?.();
			};
		});
		await tabs.getByRole('tab', { name: 'a.ts', exact: true }).click({ button: 'right' });
		await expect.poll(() => app.evaluate(() => !!(globalThis as any).menu)).toBe(true);
		await expect(tabs.getByRole('tab')).toHaveCount(3);
		// A dirty buffer asks first, exactly as × does: Keep editing keeps the tab, Discard closes it.
		await tabs.getByRole('tab', { name: 'b.ts', exact: true }).click();
		await editor.click();
		await page.keyboard.press('Meta+a');
		await page.keyboard.insertText('dirty\n');
		const dirtyTab = tabs.getByRole('tab', { name: 'b.ts', exact: true });
		// spec/editor#document-tabs: the unsaved dot in the ×'s place.
		await expect(dirtyTab.getByRole('img', { name: 'Unsaved' })).toHaveCount(1);
		await dirtyTab.click({ button: 'middle' });
		const notice = page.getByRole('alert').filter({ hasText: 'There are unsaved changes.' });
		await expect(notice).toContainText('b.ts');
		await notice.getByRole('button', { name: 'Keep editing', exact: true }).click();
		await expect(notice).toHaveCount(0);
		await expect(dirtyTab).toBeVisible();
		await expect(editor).toContainText('dirty');
		await dirtyTab.click({ button: 'middle' });
		await notice.getByRole('button', { name: 'Discard changes', exact: true }).click();
		await expect(dirtyTab).toHaveCount(0);
		await expect(tabs.getByRole('tab')).toHaveCount(2);
		expect(await readFile(join(repo, 'b.ts'), 'utf8')).toBe('export const b = 1;\n');
		// × keeps working unchanged.
		await page.getByRole('button', { name: 'Close file · a.ts', exact: true }).click();
		await expect(tabs.getByRole('tab')).toHaveCount(1);
		await expect(tabs.getByRole('tab', { name: 'd.ts', exact: true })).toBeVisible();
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

// spec/task-window#tab-strips: an overflowing tab strip has no scrollbar over the × of its tabs; it scrolls by wheel and to the active tab.
test('an overflowing document strip keeps every × clickable, scrolls by wheel and follows the active tab @area:editor', async () => {
	test.setTimeout(90000);
	const names = longNames;
	const { root, app } = await fixture(
		'Overflow fixture',
		Object.fromEntries(names.map((name) => [name, `export const value = '${name}';\n`]))
	);
	try {
		const page = await app.firstWindow();
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await page.getByRole('button', { name: /Overflow fixture/ }).click();
		// The strip wider, as the old two-column documents were: the chat away (spec/task-window-workspace#layout-switch).
		await openPanelTab(page, 'files');
		const tree = page.getByRole('tree', { name: 'Project files' }),
			editor = page.getByRole('textbox', { name: 'File content' }),
			strip = page.getByRole('tablist', { name: 'Documents' });
		for (const name of names) {
			await tree.getByRole('treeitem', { name, exact: true }).dblclick();
			await expect(editor).toContainText(name);
			// The chat goes once the work area has a tab to show (spec/task-window-workspace#empty-work-area: an empty one is not shown).
			if (name === names[0]) await hideChat(page);
		}
		await expect(strip.getByRole('tab')).toHaveCount(names.length);
		const metrics = () =>
			strip.evaluate((node) => ({
				scrollLeft: node.scrollLeft,
				overflow: node.scrollWidth - node.clientWidth,
			}));
		const start = await metrics();
		expect(start.overflow).toBeGreaterThan(0);
		const inView = (name: string) =>
			strip.evaluate((node, name) => {
				const tab = [...node.querySelectorAll('[role=tab]')].find(
					(item) => item.getAttribute('aria-label') === name
				)!.parentElement!;
				const a = node.getBoundingClientRect(),
					b = tab.getBoundingClientRect();
				return b.left >= a.left - 0.5 && b.right <= a.right + 0.5;
			}, name);
		// The last opened tab is the active one and was brought into view.
		await expect.poll(() => inView(names.at(-1)!)).toBe(true);
		expect(await inView(names[0]!)).toBe(false);
		// A vertical wheel over the strip scrolls it sideways.
		const box = (await strip.boundingBox())!;
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
		await page.mouse.wheel(0, -240);
		await expect.poll(async () => (await metrics()).scrollLeft).toBeLessThan(start.scrollLeft);
		// Home in the strip activates the first tab, and it slides into view.
		await strip.getByRole('tab', { name: names.at(-1)!, exact: true }).focus();
		await page.keyboard.press('Home');
		await expect(strip.getByRole('tab', { name: names[0]!, exact: true })).toHaveAttribute(
			'aria-selected',
			'true'
		);
		await expect.poll(() => inView(names[0]!)).toBe(true);
		// The bottom edge of a × is the × itself — nothing lies over it — and a click there closes the tab.
		const target = names[1]!,
			close = page.getByRole('button', { name: `Close file · ${target}`, exact: true });
		await expect.poll(() => inView(target)).toBe(true);
		const rect = (await close.boundingBox())!;
		const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height - 2 };
		expect(
			await page.evaluate(
				({ x, y, label }) => !!document.elementFromPoint(x, y)?.closest(`[aria-label="${label}"]`),
				{ ...point, label: `Close file · ${target}` }
			)
		).toBe(true);
		await page.mouse.click(point.x, point.y);
		await expect(strip.getByRole('tab', { name: target, exact: true })).toHaveCount(0);
		await expect(strip.getByRole('tab')).toHaveCount(names.length - 1);
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

// spec/editor#reopen-closed-tab: File ▸ Reopen closed tab (⇧⌘T) brings back the focused group's last closed tab — a file at its caret,
// a diff at its target — at its place in the strip; the tab menu has the same item.
test('Reopen closed tab brings back a file at its caret and a diff tab @area:editor', async () => {
	test.setTimeout(60000);
	const { root, app } = await fixture('Reopen fixture', {
		'a.ts': Array.from({ length: 60 }, (_, i) => `line_${i + 1}`).join('\n') + '\n',
		...sources(['b.ts', 'd.ts']),
	});
	try {
		const page = await app.firstWindow();
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		await page.getByRole('button', { name: /Reopen fixture/ }).click();
		await openPanelTab(page, 'files');
		const tree = page.getByRole('tree', { name: 'Project files' }),
			editor = page.getByRole('textbox', { name: 'File content' }),
			tabs = page.getByRole('tablist', { name: 'Documents' });
		const tab = (name: string) => tabs.getByRole('tab', { name, exact: true }),
			open = () =>
				tabs
					.getByRole('tab')
					.evaluateAll((list) => list.map((item) => item.getAttribute('aria-label')));
		const reopen = () =>
			app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('reopen-tab')!.click());

		for (const name of ['a.ts', 'b.ts', 'd.ts'])
			await tree.getByRole('treeitem', { name, exact: true }).dblclick();
		await expect.poll(open).toEqual(['a.ts', 'b.ts', 'd.ts']);
		// Nothing closed yet: the File item is there with its key, off.
		await tab('b.ts').click();
		await expect
			.poll(() => menuItem(app, 'reopen-tab'))
			.toEqual({
				enabled: false,
				accelerator: 'CmdOrCtrl+Shift+T',
			});

		// a.ts with the caret on its last line goes and comes back at its place, caret and all.
		await tab('a.ts').click();
		await editor.click();
		await page.keyboard.press('Meta+ArrowDown');
		await page.keyboard.press('ArrowUp');
		await expect(page.locator('.cm-activeLine')).toHaveText('line_60');
		await tab('a.ts').click({ button: 'middle' });
		await expect.poll(open).toEqual(['b.ts', 'd.ts']);
		await expect.poll(() => menuItem(app, 'reopen-tab').then((item) => item?.enabled)).toBe(true);
		await reopen();
		await expect.poll(open).toEqual(['a.ts', 'b.ts', 'd.ts']);
		await expect(tab('a.ts')).toHaveAttribute('aria-selected', 'true');
		await expect(page.locator('.cm-activeLine')).toHaveText('line_60');
		await expect.poll(() => menuItem(app, 'reopen-tab').then((item) => item?.enabled)).toBe(false);

		// A diff tab comes back as the diff of the same file.
		await tab('d.ts').click();
		await editor.click();
		await page.keyboard.press('Meta+a');
		await page.keyboard.insertText('export const d = 2;\n');
		await page.keyboard.press('Meta+s');
		await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled({
			timeout: 15000,
		});
		await openPanelTab(page, 'changes');
		await page
			.getByRole('list', { name: 'Files', exact: true })
			.getByRole('button', { name: /d\.ts/ })
			.click();
		const diffTab = tab('Diff · d.ts'),
			log = page.getByRole('log', { name: 'Diff', exact: true });
		await expect(log).toContainText('d = 2');
		await diffTab.click({ button: 'middle' });
		await expect(diffTab).toHaveCount(0);
		await tab('b.ts').click();
		await reopen();
		await expect(diffTab).toHaveAttribute('aria-selected', 'true');
		await expect(log).toContainText('d = 2');

		// The tab menu has the item after the close group, with the key, on the clicked tab's group.
		await app.evaluate(({ Menu }) => {
			const state = globalThis as any;
			Menu.prototype.popup = function (options) {
				state.menu = this;
				state.options = options;
			};
		});
		const tabMenu = async () => {
			await expect.poll(() => app.evaluate(() => !!(globalThis as any).menu)).toBe(true);
			return app.evaluate(() =>
				(globalThis as any).menu.items
					.slice(0, 6)
					.map((item: any) => `${item.label}${item.enabled ? '' : ' (off)'}`)
			);
		};
		await tab('b.ts').click({ button: 'right' });
		expect((await tabMenu())[5]).toBe('Reopen closed tab (off)');
		await app.evaluate(() => {
			const state = globalThis as any;
			state.options?.callback?.();
			state.menu = null;
		});
		await tab('b.ts').click({ button: 'middle' });
		await expect(tab('b.ts')).toHaveCount(0);
		await tab('a.ts').click({ button: 'right' });
		expect((await tabMenu())[5]).toBe('Reopen closed tab');
		expect(await app.evaluate(() => (globalThis as any).menu.items[5].accelerator as string)).toBe(
			'Shift+CmdOrCtrl+T'
		);
		await app.evaluate(() => {
			const state = globalThis as any;
			state.menu.items[5].click();
			state.options?.callback?.();
			state.menu = null;
		});
		await expect.poll(open).toEqual(['a.ts', 'b.ts', 'd.ts', 'Diff · d.ts']);
		await expect(tab('b.ts')).toHaveAttribute('aria-selected', 'true');
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
