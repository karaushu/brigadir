import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
const desktop = resolve('apps/desktop'),
	executablePath = createRequire(join(desktop, 'package.json'))('electron') as string;
test('sidebar native menus target the clicked row and safely remove task/project data @area:tasks @serial', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-sidebar-')),
		repo = join(root, 'repo'),
		data = join(root, 'data'),
		projectDir = join(data, 'projects/project');
	await mkdir(repo);
	await writeFile(join(repo, 'keep.txt'), 'Keep repository files');
	await mkdir(join(projectDir, 'tasks/one'), { recursive: true });
	await mkdir(join(projectDir, 'tasks/two'));
	await writeFile(
		join(projectDir, 'project.json'),
		JSON.stringify({
			schemaVersion: 1,
			project: { id: 'project', name: 'Sidebar project', path: repo },
		})
	);
	for (const id of ['one', 'two'])
		await writeFile(
			join(projectDir, 'tasks', id, 'task.json'),
			JSON.stringify({
				schemaVersion: 1,
				task: {
					id,
					projectId: 'project',
					title: `Task ${id}`,
					provider: 'claude',
					status: 'queued',
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
		env: { ...env, BRIGADIR_DATA_DIR: data },
	});
	try {
		await app.evaluate(({ Menu, dialog, shell }, root) => {
			const state = globalThis as any;
			state.menu = null;
			state.response = 0;
			state.confirmations = [];
			state.trashed = [];
			Menu.prototype.popup = function (options) {
				state.menu = this;
				state.menuClosed = options?.callback;
			};
			dialog.showMessageBox = async (_window: any, options?: any) => {
				state.confirmations.push(options);
				return { response: state.response, checkboxChecked: false };
			};
			shell.trashItem = async (path) => {
				if (state.failTrash) throw new Error('Trash unavailable');
				const fs = (process as any).mainModule.require('node:fs/promises');
				await fs.rename(path, `${root}/trash-${state.trashed.length}`);
				state.trashed.push(path);
			};
			shell.showItemInFolder = (path) => {
				state.revealed = path;
			};
		}, root);
		const page = await app.firstWindow(),
			errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		const sidebar = page.getByRole('complementary', { name: 'Projects', exact: true }),
			one = sidebar.getByRole('button', { name: /Task one/ }),
			two = sidebar.getByRole('button', { name: /Task two/ }),
			project = sidebar.locator('[aria-label="Sidebar project"]');
		async function choose(label: string) {
			await expect.poll(() => app.evaluate(() => Boolean((globalThis as any).menu))).toBe(true);
			await app.evaluate((_, label) => {
				const state = globalThis as any,
					item = state.menu.items.find((item: any) => item.label === label);
				if (!item || !item.enabled) throw new Error(`Missing menu action: ${label}`);
				item.click();
				state.menuClosed?.();
				state.menu = null;
			}, label);
		}
		await one.click();
		await two.click({ button: 'right' });
		await expect.poll(() => app.evaluate(() => Boolean((globalThis as any).menu))).toBe(true);
		expect(
			await app.evaluate(() => (globalThis as any).menu.items.map((item: any) => item.label))
		).toContain('Delete task…');
		// spec/search-menus-and-commands#menu-glyphs: the menu built after the glyphs arrived carries one on every item.
		await expect
			.poll(() =>
				app.evaluate(({ Menu }) => !!Menu.getApplicationMenu()?.getMenuItemById('settings')?.icon)
			)
			.toBe(true);
		await app.evaluate(() => {
			(globalThis as any).menuClosed?.();
			(globalThis as any).menu = null;
		});
		await two.click({ button: 'right' });
		await expect.poll(() => app.evaluate(() => Boolean((globalThis as any).menu))).toBe(true);
		expect(
			await app.evaluate(() =>
				(globalThis as any).menu.items
					.filter((item: any) => item.type !== 'separator' && !item.icon?.isTemplateImage())
					.map((item: any) => item.label)
			)
		).toEqual([]);
		await choose('Copy task title');
		expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe('Task two');
		await expect(one).toHaveAttribute('aria-pressed', 'true');
		await two.focus();
		await two.press('Shift+F10');
		await choose('Open task');
		await expect(two).toHaveAttribute('aria-pressed', 'true');
		await two.click({ button: 'right' });
		await choose('Delete task…');
		await expect.poll(() => app.evaluate(() => (globalThis as any).confirmations.length)).toBe(1);
		await expect(two).toBeVisible();
		expect(await app.evaluate(() => (globalThis as any).trashed)).toEqual([]);
		const key = { projectId: 'project', id: 'two' };
		await app.evaluate(({ Menu }) =>
			Menu.getApplicationMenu()!.getMenuItemById('terminal')!.click()
		);
		await expect(page.locator('.xterm')).toBeVisible();
		await expect
			.poll(() =>
				page.evaluate(
					async (key) =>
						((await window.brigadir.terminalCommand(key, { kind: 'list' })) as any[]).length,
					key
				)
			)
			.toBe(1);
		await page.evaluate(async (key) => {
			const file = (await window.brigadir.listFiles(key, null)).entries.find(
				(file) => file.name === 'keep.txt'
			)!;
			await window.brigadir.readEditorFile(key, file.id);
			await window.brigadir.setEditorDirty(key, file.id, true);
		}, key);
		await app.evaluate(() => {
			(globalThis as any).response = 1;
			(globalThis as any).failTrash = true;
		});
		await two.click({ button: 'right' });
		await choose('Delete task…');
		const failed = page
			.locator('[data-toast-region]')
			.getByRole('alert')
			.filter({ hasText: 'The task menu action failed.' });
		await expect(failed).toHaveCount(1);
		await failed.getByRole('button', { name: 'Close', exact: true }).click();
		await expect(failed).toHaveCount(0);
		await expect(two).toBeVisible();
		expect(await app.evaluate(() => (globalThis as any).confirmations.at(-1).detail)).toContain(
			'keep.txt'
		);
		expect(await readFile(join(repo, 'keep.txt'), 'utf8')).toBe('Keep repository files');
		await app.evaluate(() => ((globalThis as any).failTrash = false));
		await app.evaluate(() => ((globalThis as any).response = 1));
		await two.click({ button: 'right' });
		await choose('Delete task…');
		await expect(two).toHaveCount(0);
		await expect(one).toBeVisible();
		await expect(page.locator('.xterm')).toHaveCount(0);
		expect(await readFile(join(repo, 'keep.txt'), 'utf8')).toBe('Keep repository files');
		expect(await readFile(join(root, 'trash-0/task.json'), 'utf8')).toContain('Task two');
		await expect(page.getByRole('alert')).toHaveCount(0);
		await project.click({ button: 'right' });
		await choose('New task');
		await expect(page.getByRole('dialog', { name: 'New task', exact: true })).toBeVisible();
		await page
			.getByRole('dialog', { name: 'New task', exact: true })
			.getByRole('button', { name: 'Cancel', exact: true })
			.click();
		await project.focus();
		await project.press('Shift+F10');
		await choose('Show in file manager');
		expect(await app.evaluate(() => (globalThis as any).revealed)).toBe(repo);
		await app.evaluate(() => ((globalThis as any).response = 0));
		await project.click({ button: 'right' });
		await choose('Remove project…');
		await expect(project).toBeVisible();
		await one.click();
		await expect
			.poll(() =>
				app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('terminal')!.enabled)
			)
			.toBe(true);
		await app.evaluate(({ Menu }) =>
			Menu.getApplicationMenu()!.getMenuItemById('terminal')!.click()
		);
		await expect(page.locator('.xterm')).toBeVisible();
		await app.evaluate(() => ((globalThis as any).response = 1));
		await project.click({ button: 'right' });
		await choose('Remove project…');
		await expect(project).toHaveCount(0);
		await expect(one).toHaveCount(0);
		await expect(page.locator('.xterm')).toHaveCount(0);
		await expect(page.getByRole('heading', { name: 'No projects', exact: true })).toBeVisible();
		expect(await readFile(join(repo, 'keep.txt'), 'utf8')).toBe('Keep repository files');
		expect(await readFile(join(root, 'trash-1/tasks/one/task.json'), 'utf8')).toContain('Task one');
		await expect(page.evaluate(() => window.brigadir.projectMenu('../outside'))).rejects.toThrow(
			'Invalid IPC'
		);
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
