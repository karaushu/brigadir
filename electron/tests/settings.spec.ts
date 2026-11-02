import { defaultTypography } from '../packages/core/src/typography';
import { defaultAppSettings } from '../packages/core/src/settings';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { openPanelTab } from './layout';
const desktop = resolve('apps/desktop'),
	executablePath =
		process.env.BRIGADIR_TEST_EXECUTABLE ??
		(createRequire(join(desktop, 'package.json'))('electron') as string);
const env = Object.fromEntries(
	Object.entries(process.env).filter(
		(e): e is [string, string] => typeof e[1] === 'string' && e[0] !== 'ELECTRON_RUN_AS_NODE'
	)
);
/** One project with one finished task and a file, saved settings from before any newer field. */
async function fixture(prefix: string, title: string) {
	const root = await mkdtemp(join(tmpdir(), `brigadir-${prefix}-`)),
		data = join(root, 'data'),
		taskDir = join(data, 'projects/project/tasks/task'),
		settingsFile = join(data, 'settings.json');
	await mkdir(taskDir, { recursive: true });
	await writeFile(join(root, 'example.ts'), 'export const count = 1;\n');
	await writeFile(
		join(taskDir, '../../project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'repository', path: root } })
	);
	await writeFile(
		join(taskDir, 'task.json'),
		JSON.stringify({
			schemaVersion: 1,
			task: { id: 'task', projectId: 'project', title, status: 'done', provider: 'claude' },
		})
	);
	await writeFile(
		settingsFile,
		JSON.stringify({ schemaVersion: 1, settings: { appearance: 'light', language: 'en' } })
	);
	const launch = (args: string[] = []) =>
		electron.launch({
			executablePath,
			args: [desktop, `--user-data-dir=${join(root, 'profile')}`, ...args],
			env: { ...env, BRIGADIR_DATA_DIR: data },
		});
	return { root, data, settingsFile, launch };
}
async function openSettings(app: ElectronApplication, label = 'Settings…') {
	return app.evaluate(({ Menu }, label) => {
		const item = Menu.getApplicationMenu()!
			.items.flatMap((item) => item.submenu?.items ?? [])
			.find((item) => item.label === label)!;
		item.click();
		return item.accelerator;
	}, label);
}
/** The next settings save fails once; the one after it goes through. */
const failNextSave = (app: ElectronApplication) =>
	app.evaluate(({ ipcMain }) => {
		const handlers = (ipcMain as any)._invokeHandlers,
			original = handlers.get('settings:save');
		handlers.set('settings:save', () => {
			handlers.set('settings:save', original);
			throw new Error('Fixture write failure');
		});
	});
const savedSettings = async (file: string) => JSON.parse(await readFile(file, 'utf8')).settings;
test('settings persist theme and restart language, retain dirty edits and match source icons @area:settings @smoke', async ({}, info) => {
	test.setTimeout(60000);
	const { root, settingsFile, launch } = await fixture('settings-ui', 'Settings fixture');
	let app = await launch();
	try {
		let page = await app.firstWindow();
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		await page.getByRole('button', { name: /Settings fixture/ }).click();
		await openPanelTab(page, 'files');
		await page.getByRole('treeitem', { name: 'example.ts', exact: true }).dblclick();
		const editor = page.getByRole('textbox', { name: 'File content' });
		await editor.click();
		await editor.press('Meta+a');
		await page.keyboard.insertText('keep this edit\n');
		await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
		expect(await openSettings(app)).toBe('CmdOrCtrl+,');
		const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
		await expect(dialog.getByRole('button', { name: 'Theme', exact: true })).toHaveText('Light');
		async function choose(label: string, option: string) {
			await dialog.getByRole('button', { name: label, exact: true }).click();
			await dialog.getByRole('option', { name: option, exact: true }).click();
		}
		for (const [option, theme] of [
			['Dark', 'dark'],
			['Light', 'light'],
		] as const) {
			await choose('Theme', option);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			expect(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe(theme);
			await dialog.screenshot({
				animations: 'disabled',
				path: info.outputPath(`appearance-${theme}.png`),
			});
		}
		await choose('Theme', 'System');
		await expect
			.poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource))
			.toBe('system');
		// Failed writes leave both the visible choice and the applied native theme intact.
		await failNextSave(app);
		await choose('Theme', 'Dark');
		await expect(dialog.getByRole('alert')).toHaveText('The settings could not be saved.');
		await expect(dialog.getByRole('button', { name: 'Theme', exact: true })).toHaveText('System');
		expect(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('system');
		await choose('Theme', 'Dark');
		await expect(dialog.getByRole('alert')).toHaveCount(0);
		// Verify the moving indicator and interrupt it, instead of testing only the final colour.
		await page.emulateMedia({ reducedMotion: 'no-preference' });
		await dialog.getByRole('tablist').evaluate((node) => {
			const indicator = node.querySelector('span[aria-hidden]')!,
				samples: number[] = [];
			(window as any).settingsMotion = samples;
			const until = performance.now() + 1200;
			function sample() {
				samples.push(new DOMMatrixReadOnly(getComputedStyle(indicator).transform).m41);
				if (performance.now() < until) requestAnimationFrame(sample);
			}
			requestAnimationFrame(sample);
		});
		await dialog.getByRole('tab', { name: 'Appearance', exact: true }).focus();
		await dialog.getByRole('tab', { name: 'Appearance', exact: true }).press('ArrowRight');
		await expect(dialog.getByRole('tab', { name: 'Editor', exact: true })).toBeFocused();
		await dialog.getByRole('tab', { name: 'Editor', exact: true }).press('ArrowRight');
		await expect(dialog.getByRole('tab', { name: 'Language', exact: true })).toBeFocused();
		expect(
			await dialog.getByRole('tablist').evaluate((node) => {
				const indicator = node.querySelector('span[aria-hidden]')!;
				return getComputedStyle(indicator).transitionDuration;
			})
		).not.toBe('0s');
		await dialog.getByRole('tab', { name: 'Language', exact: true }).press('Home');
		await expect(dialog.getByRole('tab', { name: 'Appearance', exact: true })).toHaveAttribute(
			'aria-selected',
			'true'
		);
		await dialog.getByRole('tab', { name: 'Appearance', exact: true }).press('End');
		// spec/settings-modules-and-onboarding#module-settings-popup: Modules is the seventh tab, last; remote access settings are the module's popup.
		await expect(dialog.getByRole('tab', { name: 'Modules', exact: true })).toBeFocused();
		await dialog.getByRole('tab', { name: 'Modules', exact: true }).press('ArrowLeft');
		await expect(dialog.getByRole('tab', { name: 'Templates', exact: true })).toBeFocused();
		await dialog.getByRole('tab', { name: 'Templates', exact: true }).press('ArrowLeft');
		await expect(dialog.getByRole('tab', { name: 'Agents', exact: true })).toBeFocused();
		await dialog.getByRole('tab', { name: 'Agents', exact: true }).press('ArrowLeft');
		await expect(dialog.getByRole('tab', { name: 'Notifications', exact: true })).toBeFocused();
		await dialog.getByRole('tab', { name: 'Notifications', exact: true }).press('ArrowLeft');
		await expect(dialog.getByRole('tab', { name: 'Language', exact: true })).toBeFocused();
		await expect
			.poll(() =>
				page.evaluate(() => (window as any).settingsMotion.some((x: number) => x > 0 && x < 80))
			)
			.toBe(true);
		await choose('Interface language', 'Українська');
		await expect(dialog.getByRole('button', { name: 'Restart', exact: true })).toBeVisible();
		await expect(page.locator('html')).toHaveAttribute('lang', 'en');
		for (const theme of ['dark', 'light'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await dialog.screenshot({
				animations: 'disabled',
				path: info.outputPath(`language-${theme}.png`),
			});
		}
		await dialog.getByRole('button', { name: 'Close', exact: true }).click();
		await openSettings(app);
		await dialog.getByRole('tab', { name: 'Language', exact: true }).click();
		await expect(dialog.getByRole('button', { name: 'Restart', exact: true })).toBeVisible();
		await choose('Interface language', 'English');
		await expect(dialog.getByRole('button', { name: 'Restart', exact: true })).toHaveCount(0);
		await choose('Interface language', 'Українська');
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await dialog.getByRole('tab', { name: 'Language', exact: true }).press('Home');
		expect(
			await dialog
				.getByRole('tablist')
				.evaluate((node) =>
					parseFloat(getComputedStyle(node.querySelector('span[aria-hidden]')!).transitionDuration)
				)
		).toBeLessThanOrEqual(0.001);
		await dialog.getByRole('tab', { name: 'Appearance', exact: true }).press('End');
		// spec/settings-modules-and-onboarding#module-settings-popup: Modules is the seventh tab, last; remote access settings are the module's popup.
		await expect(dialog.getByRole('tab', { name: 'Modules', exact: true })).toBeFocused();
		await dialog.getByRole('tab', { name: 'Modules', exact: true }).press('ArrowLeft');
		await expect(dialog.getByRole('tab', { name: 'Templates', exact: true })).toBeFocused();
		await dialog.getByRole('tab', { name: 'Templates', exact: true }).press('ArrowLeft');
		await expect(dialog.getByRole('tab', { name: 'Agents', exact: true })).toBeFocused();
		await dialog.getByRole('tab', { name: 'Agents', exact: true }).press('ArrowLeft');
		await expect(dialog.getByRole('tab', { name: 'Notifications', exact: true })).toBeFocused();
		await dialog.getByRole('tab', { name: 'Notifications', exact: true }).press('ArrowLeft');
		await expect(dialog.getByRole('tab', { name: 'Language', exact: true })).toBeFocused();
		// Intercept native confirmation and relaunch only: all persistence/quit guards remain real.
		// spec/task-window-workspace#restore-window: a restart with an unsaved buffer asks nothing (hot exit) — «Keep editing» here would hold it.
		const relaunchMarker = join(root, 'relaunch.json');
		await app.evaluate(({ app, dialog }, marker) => {
			dialog.showMessageBox = async (...args: any[]) => {
				(globalThis as any).restartWarning = args[1];
				return { response: 0, checkboxChecked: false };
			};
			const fs = (process as any).mainModule.require('node:fs');
			app.relaunch = (options) => {
				fs.writeFileSync(marker, JSON.stringify(options));
			};
		}, relaunchMarker);
		const closed = app.waitForEvent('close');
		await dialog.getByRole('button', { name: 'Restart', exact: true }).click();
		await closed;
		expect(await readFile(join(root, 'example.ts'), 'utf8')).toContain('count = 1');
		await expect
			.poll(() => readFile(relaunchMarker, 'utf8').catch(() => ''))
			.toContain('--brigadir-interactive');
		expect(JSON.parse(await readFile(settingsFile, 'utf8')).settings).toEqual({
			suggestNextPrompt: false,
			helperAgent: null,
			actionAgents: {},
			actionCrews: {},
			modules: defaultAppSettings.modules,
			appearance: 'dark',
			accent: 'system',
			language: 'uk',
			toolbarLabels: 'icons',
			taskColumns: 'three',
			interfaceFont: { family: null, size: 13 },
			chatFont: { size: null },
			typography: defaultTypography,
			agents: defaultAppSettings.agents,
			notifications: defaultAppSettings.notifications,
			editor: defaultAppSettings.editor,
			projects: defaultAppSettings.projects,
			keymap: defaultAppSettings.keymap,
			terminal: defaultAppSettings.terminal,
			onboarding: { completedVersion: 1 },
			remoteAccess: defaultAppSettings.remoteAccess,
			slack: defaultAppSettings.slack,
		});
		app = await launch(['--brigadir-interactive']);
		page = await app.firstWindow();
		page.on('pageerror', (e) => errors.push(e.message));
		await expect(page.locator('html')).toHaveAttribute('lang', 'uk');
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
		expect(
			await app.evaluate(({ BrowserWindow }) => {
				const window = BrowserWindow.getAllWindows()[0]!;
				return { focusable: window.isFocusable(), focused: window.isFocused() };
			})
		).toEqual({ focusable: true, focused: false });
		await openSettings(app, 'Налаштування…');
		const ukrainian = page.getByRole('dialog', { name: 'Налаштування', exact: true });
		await ukrainian.getByRole('tab', { name: 'Мова', exact: true }).click();
		await expect(
			ukrainian.getByRole('button', { name: 'Мова інтерфейсу', exact: true })
		).toHaveText('Українська');
		await expect(ukrainian.getByRole('button', { name: 'Перезапустити', exact: true })).toHaveCount(
			0
		);
		await ukrainian.getByRole('button', { name: 'Закрити', exact: true }).click();
		// The unsaved buffer came back with the restart, still unsaved; Save writes it now.
		const restored = page.getByRole('textbox', { name: 'Вміст файла' });
		await expect(restored).toContainText('keep this edit');
		expect(await readFile(join(root, 'example.ts'), 'utf8')).toContain('count = 1');
		await restored.click();
		await restored.press('Meta+s');
		await expect.poll(() => readFile(join(root, 'example.ts'), 'utf8')).toBe('keep this edit\n');
		await openSettings(app, 'Налаштування…');
		await ukrainian.getByRole('tab', { name: 'Мова', exact: true }).click();
		expect(
			await app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.items.map((item) => item.label))
		).toContain('Правка');
		await ukrainian.screenshot({
			animations: 'disabled',
			path: info.outputPath('language-uk.png'),
		});
		await ukrainian.getByRole('button', { name: 'Закрити', exact: true }).click();
		await app.evaluate(({ Menu }) => {
			Menu.prototype.popup = function (options) {
				(globalThis as any).localizedMenu = this.items.map((item) => item.label);
				options?.callback?.();
			};
		});
		await page.getByRole('button', { name: /Settings fixture/ }).click({ button: 'right' });
		await expect
			.poll(() => app.evaluate(() => (globalThis as any).localizedMenu))
			.toContain('Видалити задачу…');
		const menu = await app.evaluate(({ Menu }) => {
			function read(menu: any): any {
				return menu.items.map((item: any) => ({
					label: item.label,
					role: item.role,
					...(item.submenu ? { items: read(item.submenu) } : {}),
				}));
			}
			return read(Menu.getApplicationMenu());
		});
		await writeFile(info.outputPath('native-menu-uk.json'), JSON.stringify(menu, null, 2));
		// A future schema stays recoverable, with an actionable error rather than invented defaults.
		const future = JSON.stringify({
			schemaVersion: 99,
			settings: { appearance: 'dark', language: 'uk' },
		});
		await writeFile(settingsFile, future);
		await openSettings(app, 'Налаштування…');
		await expect(ukrainian.getByRole('alert')).toBeVisible();
		await expect(
			ukrainian.getByRole('button', { name: 'Спробувати ще', exact: true })
		).toBeVisible();
		expect(await readFile(settingsFile, 'utf8')).toBe(future);
		await writeFile(
			settingsFile,
			JSON.stringify({ schemaVersion: 1, settings: { appearance: 'dark', language: 'uk' } })
		);
		await ukrainian.getByRole('button', { name: 'Спробувати ще', exact: true }).click();
		await expect(ukrainian.getByRole('alert')).toHaveCount(0);
		await expect(ukrainian.getByRole('button', { name: 'Тема', exact: true })).toBeVisible();
		expect(errors).toEqual([]);
	} finally {
		await app
			.evaluate(({ dialog }) => {
				dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
			})
			.catch(() => {});
		await app.close().catch(() => {});
		await rm(root, { recursive: true, force: true });
	}
});
// spec/appearance#accent (was accent.spec.ts): the accent applies live, moves by keyboard and survives a failed save and a restart.
test('accent swatches apply live, move by keyboard, keep the choice on failed saves and survive restart @area:settings', async () => {
	test.setTimeout(90000);
	// Saved before spec/appearance#accent: no accent field, so the app must follow the system.
	const { root, settingsFile, launch } = await fixture('accent', 'Accent fixture task');
	let app = await launch();
	try {
		let page = await app.firstWindow();
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		await page.getByRole('button', { name: /Accent fixture task/ }).click();
		const html = page.locator('html');
		await openSettings(app);
		const dialog = page.getByRole('dialog', { name: 'Settings', exact: true }),
			group = dialog.getByRole('radiogroup', { name: 'Accent', exact: true }),
			swatch = (name: string) => group.getByRole('radio', { name, exact: true });
		await expect(group.getByRole('radio')).toHaveCount(8);
		await expect(swatch('Follow system')).toHaveAttribute('aria-checked', 'true');
		await expect(html).toHaveAttribute('data-accent', 'system');
		await expect(html).toHaveAttribute('data-accent-text', /^(dark|light)$/);
		await swatch('Yellow').click();
		await expect(swatch('Yellow')).toHaveAttribute('aria-checked', 'true');
		await expect(html).toHaveAttribute('data-accent', 'yellow');
		await expect(html).not.toHaveAttribute('data-accent-text', /.*/);
		await expect.poll(async () => (await savedSettings(settingsFile)).accent).toBe('yellow');
		// One Tab stop; arrows, Home and End move the choice and apply it at once.
		await expect(swatch('Yellow')).toHaveAttribute('tabindex', '0');
		expect(
			await group
				.getByRole('radio')
				.evaluateAll(
					(nodes) => nodes.filter((node) => node.getAttribute('tabindex') === '0').length
				)
		).toBe(1);
		await swatch('Yellow').press('ArrowRight');
		await expect(swatch('Graphite')).toBeFocused();
		await expect(html).toHaveAttribute('data-accent', 'graphite');
		await swatch('Graphite').press('ArrowRight');
		await expect(swatch('Follow system')).toBeFocused();
		await expect(html).toHaveAttribute('data-accent', 'system');
		await swatch('Follow system').press('End');
		await expect(html).toHaveAttribute('data-accent', 'graphite');
		await swatch('Graphite').press('Home');
		await expect(html).toHaveAttribute('data-accent', 'system');
		await swatch('Follow system').press('ArrowLeft');
		await expect(html).toHaveAttribute('data-accent', 'graphite');
		await swatch('Graphite').press('ArrowLeft');
		await expect(swatch('Yellow')).toBeFocused();
		await expect(html).toHaveAttribute('data-accent', 'yellow');
		await expect.poll(async () => (await savedSettings(settingsFile)).accent).toBe('yellow');
		// A rejected save keeps both the visible choice and the applied colour.
		await failNextSave(app);
		await swatch('Pink').click();
		await expect(dialog.getByRole('alert')).toBeVisible();
		await expect(swatch('Yellow')).toHaveAttribute('aria-checked', 'true');
		await expect(html).toHaveAttribute('data-accent', 'yellow');
		await dialog.press('Escape');
		expect(errors).toEqual([]);
		await app.close();
		app = await launch();
		page = await app.firstWindow();
		await expect(page.locator('html')).toHaveAttribute('data-accent', 'yellow');
	} finally {
		await app.close().catch(() => {});
		await rm(root, { recursive: true, force: true });
	}
});
// Was toolbar-labels.spec.ts: the labels setting applies live, a narrow window drops the labels without touching it.
test('toolbar labels apply live, keep the preference when a narrow window drops them, and survive restart @area:settings', async () => {
	test.setTimeout(60000);
	const { root, settingsFile, launch } = await fixture(
		'toolbar',
		'A readable task title beside every surface control'
	);
	let app = await launch();
	try {
		let page = await app.firstWindow();
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		// spec/sidebar#section-rail: the sections rail takes 48 px left of the sidebar; the default 1180 leaves the toolbar under its 860 floor.
		await app.evaluate(({ BrowserWindow }) => {
			const window = BrowserWindow.getAllWindows()[0]!;
			window.setSize(1280, window.getSize()[1]!);
		});
		await page.getByRole('button', { name: /A readable task title/ }).click();
		const toolbar = page.locator('header[data-labels]');
		await openSettings(app);
		const dialog = page.getByRole('dialog', { name: 'Settings', exact: true }),
			iconsOnly = dialog.getByRole('radio', { name: 'Icons only', exact: true }),
			labels = dialog.getByRole('radio', { name: 'Icons and names', exact: true });
		await expect(iconsOnly).toBeChecked();
		// Rejected saves must not change the applied toolbar or the radio selection.
		await failNextSave(app);
		await labels.click();
		await expect(dialog.getByRole('alert')).toBeVisible();
		await expect(iconsOnly).toBeChecked();
		await expect(toolbar).toHaveAttribute('data-labels', 'false');
		await labels.click();
		await expect(labels).toBeChecked();
		await expect(toolbar).toHaveAttribute('data-labels', 'true');
		await dialog.press('Escape');
		await expect(dialog).not.toBeVisible();
		// A narrow window gives the labels up; the saved preference stays and they come back on widening.
		const [width, height] = await app.evaluate(({ BrowserWindow }) =>
			BrowserWindow.getAllWindows()[0]!.getSize()
		);
		await app.evaluate(({ BrowserWindow }, height) => {
			BrowserWindow.getAllWindows()[0]!.setSize(700, height);
		}, height!);
		await expect(toolbar).toHaveAttribute('data-labels', 'false');
		expect((await savedSettings(settingsFile)).toolbarLabels).toBe('labels');
		await app.evaluate(
			({ BrowserWindow }, [width, height]) => {
				BrowserWindow.getAllWindows()[0]!.setSize(width!, height!);
			},
			[width, height]
		);
		await expect(toolbar).toHaveAttribute('data-labels', 'true');
		await app.close();
		app = await launch();
		page = await app.firstWindow();
		page.on('pageerror', (error) => errors.push(error.message));
		await page.getByRole('button', { name: /A readable task title/ }).click();
		await expect(page.locator('header[data-labels]')).toHaveAttribute('data-labels', 'true');
		expect(errors).toEqual([]);
	} finally {
		await app.close().catch(() => {});
		await rm(root, { recursive: true, force: true });
	}
});
// Was typography.spec.ts: fonts per surface without remounting the editor or the terminal; the choice survives restart.
test('installed fonts apply per surface, keep editor history and terminal identity, and persist through restart @area:settings', async () => {
	test.setTimeout(60000);
	const { root, data, launch } = await fixture('typography', 'Typography fixture'),
		key = { id: 'task', projectId: 'project' };
	let app = await launch();
	try {
		let page = await app.firstWindow();
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		const settings = async () =>
			(await page.evaluate(() => window.brigadir.readSettings())).settings;
		const menu = (id: string) =>
			app.evaluate(({ Menu }, id) => Menu.getApplicationMenu()!.getMenuItemById(id)!.click(), id);
		await page.getByRole('button', { name: /Typography fixture/ }).click();
		const initial = await page.evaluate(() => window.brigadir.readAppearance());
		expect(initial.fonts?.fonts.map((font) => font.family)).toContain('Menlo');
		await openPanelTab(page, 'files');
		await page.getByRole('treeitem', { name: 'example.ts', exact: true }).dblclick();
		const editor = page.getByRole('textbox', { name: 'File content', exact: true });
		await editor.click();
		await editor.press('Meta+End');
		await page.keyboard.insertText('// preserved edit\n');
		const editorNode = await editor.elementHandle();
		await openSettings(app);
		const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
		await expect(
			dialog.getByRole('spinbutton', { name: 'Terminal · Size', exact: true })
		).toHaveValue('13');
		await expect(
			dialog.getByRole('switch', { name: 'Terminal · Ligatures', exact: true })
		).toHaveCount(0);
		await dialog.getByRole('button', { name: 'Editor · Font', exact: true }).click();
		await dialog.getByRole('option', { name: 'Menlo', exact: true }).click();
		const editorSize = dialog.getByRole('spinbutton', { name: 'Editor · Size', exact: true });
		await editorSize.fill('16');
		await editorSize.press('Enter');
		await expect
			.poll(async () => (await settings()).typography.editor)
			.toMatchObject({ family: 'Menlo', size: 16 });
		// spec/appearance#evolution-redesign p. 2: ligatures are on by default; the switch turns them off.
		const ligatures = dialog.getByRole('switch', { name: 'Editor · Ligatures', exact: true });
		await expect(ligatures).toHaveAttribute('aria-checked', 'true');
		await ligatures.click();
		await expect(ligatures).toHaveAttribute('aria-checked', 'false');
		await expect.poll(async () => (await settings()).typography.editor.ligatures).toBe(false);
		// The editor is restyled in place, not remounted: the unsaved edit is still there.
		expect(await editorNode!.evaluate((node) => node.isConnected)).toBe(true);
		await expect(editor).toContainText('preserved edit');
		// spec/appearance#interface-font: the interface font takes any installed family; an out-of-range size is not saved.
		await dialog.getByRole('button', { name: 'Interface · Font', exact: true }).click();
		await dialog.getByRole('option', { name: 'Menlo', exact: true }).click();
		await expect.poll(async () => (await settings()).interfaceFont.family).toBe('Menlo');
		const interfaceSize = dialog.getByRole('spinbutton', { name: 'Interface · Size', exact: true });
		await interfaceSize.fill('1');
		await expect(interfaceSize).toHaveValue('1');
		expect((await settings()).interfaceFont.size).toBe(13);
		await interfaceSize.fill('16');
		await interfaceSize.press('Enter');
		await expect.poll(async () => (await settings()).interfaceFont.size).toBe(16);
		expect((await settings()).typography.editor.size).toBe(16);
		await interfaceSize.press('ArrowDown');
		await expect
			.poll(async () => (await settings()).interfaceFont)
			.toEqual({ family: 'Menlo', size: 15 });
		// spec/appearance#evolution-redesign p. 2: the OS font is a choice of its own; Geist is the default (null).
		await dialog.getByRole('button', { name: 'Interface · Font', exact: true }).click();
		await dialog.getByRole('option', { name: 'System font', exact: true }).click();
		await expect.poll(async () => (await settings()).interfaceFont.family).toBe('system-ui');
		await dialog.getByRole('button', { name: 'Interface · Font', exact: true }).click();
		await dialog.getByRole('option', { name: 'Geist', exact: true }).click();
		await interfaceSize.fill('13');
		await interfaceSize.press('Enter');
		await expect
			.poll(async () => (await settings()).interfaceFont)
			.toEqual({ family: null, size: 13 });
		const lineHeight = dialog.getByRole('spinbutton', {
			name: 'Editor · Line height',
			exact: true,
		});
		await lineHeight.fill('1.8');
		await lineHeight.press('Enter');
		await expect.poll(async () => (await settings()).typography.editor.lineHeight).toBe(1.8);
		// The zoom shortcut inside a settings field does not change any setting.
		const settingsBeforeKey = await settings();
		await lineHeight.press('Meta+=');
		expect(await settings()).toEqual(settingsBeforeKey);
		await editorSize.focus();
		await editorSize.press('Escape');
		await expect(dialog).not.toBeVisible();
		// Zoom from the editor and the menu changes the editor's size; ⌘0 resets it; history survives.
		await editor.focus();
		await editor.press('Meta+=');
		await expect.poll(async () => (await settings()).typography.editor.size).toBe(17);
		await editor.press('Meta+-');
		await expect.poll(async () => (await settings()).typography.editor.size).toBe(16);
		await menu('font-increase');
		await expect.poll(async () => (await settings()).typography.editor.size).toBe(17);
		await editor.press('Meta+0');
		await expect.poll(async () => (await settings()).typography.editor.size).toBe(12);
		await editor.press('Meta+z');
		await expect(editor).not.toContainText('preserved edit');
		// spec/task-window-workspace#work-area: a terminal tab zooms its own surface and keeps its session.
		await menu('terminal');
		const terminal = page.locator('[data-role=console]');
		await expect(terminal.locator('.xterm-screen')).toBeVisible();
		const screen = await terminal.locator('.xterm-screen').elementHandle(),
			before = await page.evaluate(
				(key) => window.brigadir.terminalCommand(key, { kind: 'list' }),
				key
			);
		await terminal.locator('textarea').focus();
		await terminal.locator('textarea').press('Meta+=');
		await expect.poll(async () => (await settings()).typography.terminal.size).toBe(14);
		expect(await screen!.evaluate((node) => node.isConnected)).toBe(true);
		expect(
			(
				(await page.evaluate(
					(key) => window.brigadir.terminalCommand(key, { kind: 'list' }),
					key
				)) as any[]
			).map((item) => item.id)
		).toEqual((before as any[]).map((item) => item.id));
		// An unavailable family falls back without silently rewriting the choice.
		await page.evaluate(async () => {
			const { settings } = await window.brigadir.readSettings();
			await window.brigadir.saveSettings({
				...settings,
				typography: {
					...settings.typography,
					diff: { ...settings.typography.diff, family: 'Brigadir Missing Font Fixture' },
				},
			});
		});
		const fontToast = page
			.locator('[data-toast-region]')
			.getByRole('alert')
			.filter({ hasText: 'Brigadir Missing Font Fixture' });
		await expect(fontToast).toBeVisible();
		await fontToast.getByRole('button', { name: 'Close', exact: true }).click();
		await expect(fontToast).toHaveCount(0);
		expect(
			(await page.evaluate(() => window.brigadir.readAppearance())).typography.diff.family
		).toBe('ui-monospace');
		expect((await savedSettings(join(data, 'settings.json'))).typography.diff.family).toBe(
			'Brigadir Missing Font Fixture'
		);
		await app.evaluate(({ dialog }) => {
			dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
		});
		await app.close();
		app = await launch();
		page = await app.firstWindow();
		page.on('pageerror', (error) => errors.push(error.message));
		const restarted = await settings();
		expect(restarted.typography.editor.family).toBe('Menlo');
		expect(restarted.typography.terminal.size).toBe(14);
		await expect(
			page
				.locator('[data-toast-region] [data-toast-id]')
				.filter({ hasText: 'Brigadir Missing Font Fixture' })
		).toBeVisible();
		expect(errors).toEqual([]);
	} finally {
		await app
			.evaluate(({ dialog }) => {
				dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
			})
			.catch(() => {});
		await app.close().catch(() => {});
		await rm(root, { recursive: true, force: true });
	}
});
