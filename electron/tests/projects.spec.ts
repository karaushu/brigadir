import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
const desktop = resolve('apps/desktop'),
	executablePath = createRequire(join(desktop, 'package.json'))('electron') as string;
test('Open Recent reuses canonical projects, reports missing paths and survives closing every window @area:tasks @smoke', async ({}, info) => {
	test.setTimeout(90000);
	const root = await realpath(await mkdtemp(join(tmpdir(), 'brigadir-projects-ui-'))),
		data = join(root, 'data'),
		repo = join(root, 'repository'),
		other = join(root, 'second'),
		alias = join(root, 'alias');
	await mkdir(repo);
	await mkdir(other);
	await symlink(repo, alias);
	await mkdir(join(data, 'projects', 'saved'), { recursive: true });
	await writeFile(
		join(data, 'projects', 'saved', 'project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'saved', name: 'repository', path: repo } })
	);
	await writeFile(
		join(data, 'settings.json'),
		JSON.stringify({ schemaVersion: 1, settings: { language: 'en', appearance: 'light' } })
	);
	const env = Object.fromEntries(
		Object.entries(process.env).filter(
			(entry): entry is [string, string] =>
				typeof entry[1] === 'string' && entry[0] !== 'ELECTRON_RUN_AS_NODE'
		)
	);
	const launch = () =>
		electron.launch({
			executablePath,
			args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
			env: { ...env, BRIGADIR_DATA_DIR: data },
		});
	let app = await launch();
	try {
		let page = await app.firstWindow();
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		app.on('window', (page) => page.on('pageerror', (error) => errors.push(error.message)));
		const enabled = (id: string) =>
				app.evaluate(
					({ Menu }, id) => Menu.getApplicationMenu()!.getMenuItemById(id)?.enabled ?? false,
					id
				),
			click = async (id: string) => {
				await expect.poll(() => enabled(id)).toBe(true);
				await app.evaluate(
					({ Menu }, id) => Menu.getApplicationMenu()!.getMenuItemById(id)!.click(),
					id
				);
			};
		await expect(page.locator('[data-project-screen=saved]')).toBeVisible();
		expect(
			await app.evaluate(
				({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('recent-project-0')!.label
			)
		).toBe(repo);
		await app.evaluate(({ dialog }, path) => {
			dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
		}, alias);
		const addProject = page.getByRole('button', { name: 'Add a project…', exact: true });
		await page.getByRole('button', { name: 'All projects', exact: true }).focus();
		await page.keyboard.press('Tab');
		await expect(addProject).toBeFocused();
		await page.keyboard.press('Enter');
		await expect
			.poll(
				async () =>
					JSON.parse(await readFile(join(data, 'recent-projects.json'), 'utf8').catch(() => '{}'))
						.paths
			)
			.toEqual([repo]);
		expect((await page.evaluate(() => window.brigadir.readWorkspace())).projects).toHaveLength(1);
		await expect(page.locator('[data-project-screen=saved]')).toBeVisible();
		await app.evaluate(({ dialog }, path) => {
			dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
		}, other);
		await click('open-project');
		await expect
			.poll(
				async () => (await page.evaluate(() => window.brigadir.readWorkspace())).projects.length
			)
			.toBe(2);
		await click('recent-project-1');
		await expect(page.locator('[data-project-screen=saved]')).toBeVisible();
		expect(JSON.parse(await readFile(join(data, 'recent-projects.json'), 'utf8')).paths).toEqual([
			repo,
			other,
		]);
		const closeWindow = async () => {
			await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
			await expect
				.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length))
				.toBe(0);
			expect(await enabled('new-task')).toBe(false);
			expect(await enabled('editor-save')).toBe(false);
			expect(await enabled('open-project')).toBe(true);
			expect(await enabled('settings')).toBe(true);
		};
		await closeWindow();
		let next = app.waitForEvent('window');
		await click('settings');
		page = await next;
		await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(page.getByRole('dialog')).toHaveCount(0);
		await closeWindow();
		next = app.waitForEvent('window');
		await click('recent-project-0');
		page = await next;
		await expect(page.locator('[data-project-screen=saved]')).toBeVisible();
		await closeWindow();
		next = app.waitForEvent('window');
		await click('search');
		page = await next;
		await expect(page.getByRole('dialog')).toBeVisible();
		await page.keyboard.press('Escape');
		await closeWindow();
		next = app.waitForEvent('window');
		await click('kit-route');
		page = await next;
		await expect.poll(() => page.evaluate(() => location.hash)).toBe('#kit');
		await click('workspace-route');
		await expect(page.locator('[data-app-sidebar]')).toBeVisible();
		await closeWindow();
		await app.evaluate(({ dialog }, path) => {
			dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
		}, repo);
		next = app.waitForEvent('window');
		await click('open-project');
		page = await next;
		await expect(page.locator('[data-project-screen=saved]')).toBeVisible();
		expect((await page.evaluate(() => window.brigadir.readWorkspace())).projects).toHaveLength(2);
		// Missing recent paths keep their entry and offer the native picker. Cancelling changes no metadata.
		await rm(other, { recursive: true });
		await app.evaluate(({ dialog }) => {
			dialog.showMessageBox = async (...args: any[]) => {
				(globalThis as any).recentFailure = args.at(-1);
				return { response: 0, checkboxChecked: false };
			};
		});
		await click('recent-project-1');
		await expect
			.poll(() => app.evaluate(() => (globalThis as any).recentFailure?.message))
			.toBe('The project could not be opened.');
		expect(JSON.parse(await readFile(join(data, 'recent-projects.json'), 'utf8')).paths).toEqual([
			repo,
			other,
		]);
		await page.getByRole('button', { name: 'All projects', exact: true }).click();
		for (const theme of ['light', 'dark'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await page.screenshot({
				path: info.outputPath(`projects-${theme}.png`),
				animations: 'disabled',
			});
		}
		const menu = await app.evaluate(({ Menu }) => {
			const read = (items: Electron.MenuItem[]): unknown[] =>
				items.map((item) => ({
					id: item.id,
					label: item.label,
					enabled: item.enabled,
					children: item.submenu ? read(item.submenu.items) : [],
				}));
			return read(Menu.getApplicationMenu()!.items);
		});
		await writeFile(info.outputPath('recent-menu.json'), JSON.stringify(menu, null, 2));
		await click('recent-clear');
		await expect
			.poll(
				async () => JSON.parse(await readFile(join(data, 'recent-projects.json'), 'utf8')).paths
			)
			.toEqual([]);
		await app.close();
		await writeFile(
			join(data, 'settings.json'),
			JSON.stringify({ schemaVersion: 1, settings: { language: 'uk', appearance: 'light' } })
		);
		app = await launch();
		page = await app.firstWindow();
		await expect(page.locator('[data-app-sidebar]')).toBeVisible();
		expect(
			await app.evaluate(({ Menu }) =>
				Menu.getApplicationMenu()!
					.getMenuItemById('open-recent')!
					.submenu!.items.map((item) => item.label)
			)
		).toEqual(['Немає недавніх проєктів']);
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
