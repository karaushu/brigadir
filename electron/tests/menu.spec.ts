import {
	_electron as electron,
	expect,
	test,
	type ElectronApplication,
	type Page,
} from '@playwright/test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { showChat, hideChat } from './layout';
const desktop = resolve('apps/desktop'),
	executablePath = createRequire(join(desktop, 'package.json'))('electron') as string;
const env = Object.fromEntries(
	Object.entries(process.env).filter(
		(entry): entry is [string, string] =>
			typeof entry[1] === 'string' &&
			entry[0] !== 'ELECTRON_RUN_AS_NODE' &&
			entry[0] !== 'BRIGADIR_CHROME_PLATFORM'
	)
);
const accelerator = (app: ElectronApplication, id: string) =>
	app.evaluate(({ Menu }, id) => Menu.getApplicationMenu()!.getMenuItemById(id)?.accelerator, id);
test('menu availability follows focus, sidebar commands work and document shortcuts preserve buffers @area:shell @smoke', async ({}, info) => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-menu-')),
		repo = join(root, 'repo'),
		data = join(root, 'data'),
		project = join(data, 'projects/project');
	await mkdir(repo);
	await mkdir(project, { recursive: true });
	await writeFile(
		join(project, 'project.json'),
		JSON.stringify({
			schemaVersion: 1,
			project: { id: 'project', name: 'Menu project', path: repo },
		})
	);
	for (const [id, title, status] of [
		['one', 'First waiting task', 'needs-you'],
		['two', 'Second waiting task', 'needs-you'],
		['done', 'Completed task', 'done'],
	]) {
		const dir = join(project, 'tasks', id!);
		await mkdir(dir, { recursive: true });
		await writeFile(
			join(dir, 'task.json'),
			JSON.stringify({ schemaVersion: 1, task: { id, projectId: 'project', title, status } })
		);
	}
	for (const name of ['first.ts', 'second.ts'])
		await writeFile(join(repo, name), `export const name = '${name}';\n`);
	const app = await electron.launch({
		executablePath,
		args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
		env: { ...env, BRIGADIR_DATA_DIR: data },
	});
	try {
		const page = await app.firstWindow(),
			errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		const enabled = (id: string) =>
			app.evaluate(({ Menu }, id) => Menu.getApplicationMenu()!.getMenuItemById(id)!.enabled, id);
		const action = async (id: string) => {
			await expect.poll(() => enabled(id)).toBe(true);
			await app.evaluate(
				({ Menu }, id) => Menu.getApplicationMenu()!.getMenuItemById(id)!.click(),
				id
			);
		};
		await app.evaluate(({ dialog }) => {
			dialog.showOpenDialog = async () => {
				(globalThis as any).menuPickedProject = true;
				return { canceled: true, filePaths: [] };
			};
		});
		// macOS keeps its app-named menu and no ☰ (spec/architecture-and-platform#window-frame; the Windows/Linux frame is below).
		await expect(page.locator('html')).toHaveAttribute('data-platform', 'darwin');
		await expect(page.getByRole('button', { name: 'Application menu', exact: true })).toHaveCount(
			0
		);
		expect(await app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.items[0]!.label)).toBe(
			'Brigadir'
		);
		expect(await accelerator(app, 'sidebar-toggle')).toBe('Ctrl+Command+S');
		await action('open-project');
		await expect.poll(() => app.evaluate(() => (globalThis as any).menuPickedProject)).toBe(true);
		await expect.poll(() => enabled('new-task')).toBe(true);
		expect(await enabled('editor-save')).toBe(false);
		expect(await enabled('terminal-new')).toBe(false);
		await action('new-task');
		const newTask = page.getByRole('dialog', { name: 'New task', exact: true });
		await expect(newTask).toBeVisible();
		await expect.poll(() => enabled('new-task')).toBe(false);
		await newTask.getByRole('button', { name: 'Cancel', exact: true }).click();
		await page.getByRole('button', { name: /First waiting task/ }).click();
		await action('needs-next');
		await expect(
			page.getByRole('heading', { name: 'Second waiting task', exact: true })
		).toBeVisible();
		await action('needs-previous');
		await expect(
			page.getByRole('heading', { name: 'First waiting task', exact: true })
		).toBeVisible();
		await action('sidebar-filter');
		const filter = page.getByRole('searchbox', { name: 'Filter tasks', exact: true });
		await expect(filter).toBeFocused();
		await filter.fill('Second');
		await expect(
			page
				.getByRole('complementary', { name: 'Projects' })
				.getByRole('button', { name: /First waiting task/ })
		).toHaveCount(0);
		await expect(
			page
				.getByRole('complementary', { name: 'Projects' })
				.getByRole('button', { name: /Second waiting task/ })
		).toBeVisible();
		for (const theme of ['light', 'dark']) {
			await app.evaluate(
				({ nativeTheme }, theme) => (nativeTheme.themeSource = theme as 'light' | 'dark'),
				theme
			);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await page.screenshot({
				animations: 'disabled',
				path: info.outputPath(`menu-filter-${theme}.png`),
			});
		}
		await filter.press('Escape');
		await expect(filter).toHaveValue('');
		// spec/sidebar#project-groups: the field stays; Esc on an empty field hands focus back to the work area.
		await filter.press('Escape');
		await expect(filter).toBeVisible();
		await expect(filter).not.toBeFocused();
		await action('sidebar-toggle');
		const sidebar = page.locator('[data-app-sidebar]');
		const midway = await sidebar.evaluate(
			(node) =>
				new Promise<number>((resolve) =>
					requestAnimationFrame(() =>
						requestAnimationFrame(() => resolve(Number(getComputedStyle(node).opacity)))
					)
				)
		);
		expect(midway).toBeGreaterThan(0);
		expect(midway).toBeLessThan(1);
		await expect(page.getByRole('complementary', { name: 'Projects' })).toHaveCount(0);
		await expect.poll(() => sidebar.evaluate((node) => node.getBoundingClientRect().width)).toBe(0);
		await page.screenshot({ animations: 'disabled', path: info.outputPath('sidebar-hidden.png') });
		await action('sidebar-toggle');
		await expect(page.getByRole('complementary', { name: 'Projects' })).toBeVisible();
		// The on-screen toggle (spec/sidebar#layout) sits on the sidebar's top edge and, once the sidebar is gone, after the window buttons.
		const hide = page.getByRole('button', { name: 'Hide sidebar', exact: true });
		await expect(hide).toBeVisible();
		const edge = (await page.locator('[data-app-sidebar]').boundingBox())!,
			open = (await hide.boundingBox())!;
		expect(open.x + open.width).toBeLessThanOrEqual(edge.x + edge.width);
		expect(open.y + open.height).toBeLessThanOrEqual(48);
		const dragOver = (button: typeof hide) =>
			button.evaluate((node) => {
				const box = node.getBoundingClientRect(),
					overlaps = (other: Element) => {
						const rect = other.getBoundingClientRect();
						return (
							rect.left < box.right &&
							rect.right > box.left &&
							rect.top < box.bottom &&
							rect.bottom > box.top
						);
					};
				return [...document.querySelectorAll('*')]
					.filter(
						(other) =>
							other !== node &&
							!node.contains(other) &&
							node.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING &&
							getComputedStyle(other).getPropertyValue('-webkit-app-region') === 'drag' &&
							overlaps(other)
					)
					.map((other) => other.className);
			});
		// Electron resolves app-region in document order: a later drag region over the button swallows real clicks, which Playwright's synthetic input does not show.
		expect(await dragOver(hide)).toEqual([]);
		await hide.click();
		await expect.poll(() => sidebar.evaluate((node) => node.getBoundingClientRect().width)).toBe(0);
		const show = page.getByRole('button', { name: 'Show sidebar', exact: true });
		await expect(show).toBeVisible();
		const closed = (await show.boundingBox())!;
		expect(await dragOver(show)).toEqual([]);
		expect(closed.x).toBeGreaterThanOrEqual(72);
		const heading = (await page
			.getByRole('heading', { name: 'First waiting task', exact: true })
			.boundingBox())!;
		expect(heading.x).toBeGreaterThanOrEqual(closed.x + closed.width);
		await page.screenshot({
			animations: 'disabled',
			path: info.outputPath('sidebar-toggle-hidden.png'),
		});
		await show.click();
		await expect(page.getByRole('complementary', { name: 'Projects' })).toBeVisible();
		await action('files');
		await page.getByRole('treeitem', { name: 'first.ts', exact: true }).dblclick();
		let editor = page.getByRole('textbox', { name: 'File content', exact: true });
		await editor.focus();
		await editor.press('Meta+End');
		await page.keyboard.insertText('// retained draft\n');
		await expect.poll(() => enabled('editor-save')).toBe(true);
		await app.evaluate(({ Menu }) =>
			Menu.getApplicationMenu()!.getMenuItemById('history-undo')!.click()
		);
		await expect(editor).not.toContainText('retained draft');
		await editor.press('Meta+Shift+z');
		await expect(editor).toContainText('retained draft');
		await page.getByRole('treeitem', { name: 'second.ts', exact: true }).dblclick();
		await editor.focus();
		await action('document-previous');
		await expect(editor).toContainText('retained draft');
		await editor.focus();
		await action('document-next');
		await expect(editor).toContainText('second.ts');
		await showChat(page);
		const composer = page.getByRole('textbox', { name: 'Message', exact: true });
		await composer.focus();
		await expect.poll(() => enabled('editor-save')).toBe(false);
		// spec/task-window-workspace#work-area: ⌃⇧` opens a terminal tab wherever the task is open.
		expect(await enabled('terminal-new')).toBe(true);
		expect(await enabled('document-next')).toBe(false);
		await action('settings');
		await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible();
		await expect.poll(() => enabled('files')).toBe(false);
		expect(await enabled('sidebar-toggle')).toBe(false);
		await page.keyboard.press('Escape');
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await action('sidebar-toggle');
		await expect.poll(() => sidebar.evaluate((node) => node.getBoundingClientRect().width)).toBe(0);
		await action('sidebar-toggle');
		await page.emulateMedia({ reducedMotion: 'no-preference' });
		await action('close-task');
		await expect(page.locator('[data-project-screen]')).toBeVisible();
		expect(await readFile(join(repo, 'first.ts'), 'utf8')).not.toContain('retained draft');
		await page.getByRole('button', { name: /First waiting task/ }).click();
		await hideChat(page);
		await editor.focus();
		await action('document-previous');
		await expect(editor).toContainText('retained draft');
		// spec/search-menus-and-commands#menu-glyphs: every item of every menu-bar menu carries its glyph as a template image; the menu titles have none.
		await expect
			.poll(() =>
				app.evaluate(({ Menu }) => !!Menu.getApplicationMenu()?.getMenuItemById('settings')?.icon)
			)
			.toBe(true);
		expect(
			await app.evaluate(({ Menu }) => {
				const bare = (items: Electron.MenuItem[]): string[] =>
					items.flatMap((item) => [
						...(item.type === 'separator' ||
						(item.icon as Electron.NativeImage | undefined)?.isTemplateImage()
							? []
							: [item.label || item.role || '?']),
						...(item.submenu ? bare(item.submenu.items) : []),
					]);
				return Menu.getApplicationMenu()!.items.flatMap((menu) => bare(menu.submenu?.items ?? []));
			})
		).toEqual([]);
		const menu = await app.evaluate(({ Menu }) => {
			const read = (items: Electron.MenuItem[]): unknown[] =>
				items.map((item) => ({
					id: item.id,
					label: item.label,
					enabled: item.enabled,
					accelerator: item.accelerator,
					children: item.submenu ? read(item.submenu.items) : [],
				}));
			return read(Menu.getApplicationMenu()!.items);
		});
		await writeFile(info.outputPath('menu.json'), JSON.stringify(menu, null, 2));
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
/** spec/architecture-and-platform#window-frame: the window frame on Windows and Linux, previewed on a Mac with BRIGADIR_CHROME_PLATFORM. */
async function openFramed(chrome: string) {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-window-bar-')),
		repo = join(root, 'repo'),
		data = join(root, 'data'),
		project = join(data, 'projects/project');
	await mkdir(repo);
	await mkdir(join(project, 'tasks/one'), { recursive: true });
	await writeFile(
		join(project, 'project.json'),
		JSON.stringify({
			schemaVersion: 1,
			project: { id: 'project', name: 'Window project', path: repo },
		})
	);
	await writeFile(
		join(project, 'tasks/one/task.json'),
		JSON.stringify({
			schemaVersion: 1,
			task: {
				id: 'one',
				projectId: 'project',
				title: 'Fix kit Button focus ring',
				status: 'needs-you',
			},
		})
	);
	const app = await electron.launch({
		executablePath,
		args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
		env: { ...env, BRIGADIR_DATA_DIR: data, BRIGADIR_CHROME_PLATFORM: chrome },
	});
	const page = await app.firstWindow();
	await app.evaluate(({ BrowserWindow }) =>
		BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 800)
	);
	return {
		app,
		page,
		close: async () => {
			await app.close();
			await rm(root, { recursive: true, force: true });
		},
	};
}
type MenuNode = { id: string; label: string; accelerator: string | null; children: MenuNode[] };
const readMenu = (app: ElectronApplication) =>
	app.evaluate(({ Menu }) => {
		const read = (items: Electron.MenuItem[]): MenuNode[] =>
			items.map((item) => ({
				id: item.id,
				label: item.label,
				accelerator: item.accelerator ?? null,
				children: item.submenu ? read(item.submenu.items) : [],
			}));
		return read(Menu.getApplicationMenu()!.items);
	});
/** No ⌘ ⌥ ⌃ ⇧ in a PC window's text or hints: every shortcut comes from the keymap in PC words (spec/architecture-and-platform#window-frame). */
const macGlyphs = (page: Page, selector = 'body') =>
	page
		.locator(selector)
		.evaluate((root) =>
			[root, ...root.querySelectorAll('*')].flatMap((node) =>
				[
					node === root ? ((root as HTMLElement).innerText ?? '') : '',
					node.getAttribute('title') ?? '',
					node.getAttribute('aria-label') ?? '',
					node.getAttribute('aria-placeholder') ?? '',
					node.getAttribute('placeholder') ?? '',
				].filter((text) => /[⌘⌥⌃⇧]/.test(text))
			)
		);
test('Windows: ☰, F10 and a lone Alt open the app menu; no app-named menu; PC shortcuts @area:shell', async () => {
	const { app, page, close } = await openFramed('win32');
	try {
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		await expect(page.locator('html')).toHaveAttribute('data-platform', 'win32');
		const button = page.getByRole('button', { name: 'Application menu', exact: true });
		await expect(button).toBeVisible();
		// spec/architecture-and-platform#window-frame: no menu named after the app; Settings and Exit in File, the intro and About in Help.
		const items = await readMenu(app);
		expect(items.map((item) => item.label)).not.toContain('Brigadir');
		expect(items.at(-1)!.id).toBe('help');
		expect(items.at(-1)!.children.map((item) => item.id)).toContain('intro');
		const file = items.find((item) => item.children.some((child) => child.id === 'settings'))!;
		expect(file.children.find((item) => item.id === 'settings')?.accelerator).toBe('CmdOrCtrl+,');
		expect(file.children.at(-1)).toMatchObject({ id: 'quit', accelerator: 'Ctrl+Q' });
		// spec/architecture-and-platform#window-frame: the PC table — no ⌃⌘, no AltGr chord.
		expect(await accelerator(app, 'sidebar-toggle')).toBe('Ctrl+Shift+S');
		expect(await accelerator(app, 'document-next')).toBe('Ctrl+PageDown');
		expect(await accelerator(app, 'search')).toBe('Ctrl+Shift+K');
		// A native menu would show over the user's screen: record the popup instead and close it from the test.
		await app.evaluate(({ Menu }) => {
			const state = globalThis as any;
			state.popups = [];
			Menu.prototype.popup = function (this: Electron.Menu, options?: Electron.PopupOptions) {
				state.popups.push({ application: this === Menu.getApplicationMenu() });
				state.closeMenu = () => options?.callback?.();
			};
		});
		const popups = () =>
			app.evaluate(() => (globalThis as any).popups as { application: boolean }[]);
		await button.click();
		await expect.poll(popups).toEqual([{ application: true }]);
		await expect(button).toHaveAttribute('aria-expanded', 'true');
		await app.evaluate(() => (globalThis as any).closeMenu());
		await expect(button).toHaveAttribute('aria-expanded', 'false');
		// F10 and a lone Alt open the same menu; Alt as part of a chord does not.
		// Playwright's keys do not pass main's before-input-event in a background window; main's own input path does.
		const keys = (events: { type: 'keyDown' | 'keyUp'; keyCode: string; modifiers?: 'alt'[] }[]) =>
			app.evaluate(({ BrowserWindow }, events) => {
				for (const event of events)
					BrowserWindow.getAllWindows()[0]!.webContents.sendInputEvent(event);
			}, events);
		await keys([
			{ type: 'keyDown', keyCode: 'F10' },
			{ type: 'keyUp', keyCode: 'F10' },
		]);
		await expect.poll(async () => (await popups()).length).toBe(2);
		await app.evaluate(() => (globalThis as any).closeMenu());
		await keys([
			{ type: 'keyDown', keyCode: 'Alt', modifiers: ['alt'] },
			{ type: 'keyUp', keyCode: 'Alt' },
		]);
		await expect.poll(async () => (await popups()).length).toBe(3);
		await app.evaluate(() => (globalThis as any).closeMenu());
		await keys([
			{ type: 'keyDown', keyCode: 'Alt', modifiers: ['alt'] },
			{ type: 'keyDown', keyCode: 'Down', modifiers: ['alt'] },
			{ type: 'keyUp', keyCode: 'Down', modifiers: ['alt'] },
			{ type: 'keyUp', keyCode: 'Alt' },
		]);
		await page.waitForTimeout(300);
		expect((await popups()).length).toBe(3);
		// The task window: the sidebar toggle hints the PC shortcut and still hides the sidebar.
		await page.getByRole('button', { name: /Fix kit Button focus ring/ }).click();
		const hide = page.getByRole('button', { name: 'Hide sidebar', exact: true });
		await expect(hide).toHaveAttribute('title', /Ctrl\+Shift\+S/);
		await hide.click();
		await expect(page.getByRole('button', { name: 'Show sidebar', exact: true })).toBeVisible();
		// spec/appearance#evolution-redesign: the module is on but access is off — no Remote button.
		await expect(page.locator('[data-remote-chip]')).toHaveCount(0);
		// ☰ stays clickable above every drag region (Electron resolves app-region in document order).
		expect(
			await button.evaluate((node) => {
				const r = node.getBoundingClientRect(),
					all = [...document.querySelectorAll('*')];
				return (
					all.indexOf(node) >
					all.findLastIndex(
						(other) =>
							other !== node &&
							getComputedStyle(other).getPropertyValue('-webkit-app-region') === 'drag' &&
							(() => {
								const o = other.getBoundingClientRect();
								return o.left < r.right && o.right > r.left && o.top < r.bottom && o.bottom > r.top;
							})()
					)
				);
			})
		).toBe(true);
		expect(errors).toEqual([]);
	} finally {
		await close();
	}
});
test('Linux wears the Windows frame and spells every shortcut in PC words: task window, Search Everywhere, Archive @area:shell', async () => {
	const { app, page, close } = await openFramed('linux');
	try {
		await expect(page.locator('html')).toHaveAttribute('data-platform', 'linux');
		await expect(page.getByRole('button', { name: 'Application menu', exact: true })).toBeVisible();
		expect((await readMenu(app)).at(-1)!.id).toBe('help');
		expect(await accelerator(app, 'turns')).toBe('Alt+Shift+U');
		// spec/editor#reopen-closed-tab: Ctrl+Shift+T reopens a closed tab, as in browsers and VS Code.
		expect(await accelerator(app, 'reopen-tab')).toBe('Ctrl+Shift+T');
		await page.getByRole('button', { name: /Fix kit Button focus ring/ }).click();
		await expect.poll(() => macGlyphs(page)).toEqual([]);
		const commands = page.locator('[data-quick-commands] > button').first();
		await expect(commands).toHaveAttribute('title', /Ctrl\+Shift\+R$/);
		await app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('search')!.click());
		const search = page.getByRole('dialog', { name: 'Search Everywhere' });
		await expect(search).toBeVisible();
		await page.keyboard.type('Fix kit');
		await expect(search.locator('footer')).toBeVisible();
		await expect(search.locator('footer')).not.toContainText(/[⌘⌥⌃⇧↩⇥⎋⌫]/);
		await page.keyboard.press('Escape');
		await expect(search).toBeHidden();
		await app.evaluate(({ Menu }) =>
			Menu.getApplicationMenu()!.getMenuItemById('archive')!.click()
		);
		const archive = page.locator('dialog[data-archive-window]');
		await expect(archive).toBeVisible();
		await expect(archive.locator('footer').first()).toBeVisible();
		await expect(archive.locator('footer').first()).not.toContainText(/[⌘⌥⌃⇧↩⇥⎋⌫]/);
	} finally {
		await close();
	}
});
