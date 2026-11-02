import { refreshChanges } from './refresh-changes';
import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openPanelTab } from './layout';
const desktop = resolve('apps/desktop'),
	executablePath = createRequire(join(desktop, 'package.json'))('electron') as string;
const env = Object.fromEntries(
	Object.entries(process.env).filter(
		(e): e is [string, string] => typeof e[1] === 'string' && e[0] !== 'ELECTRON_RUN_AS_NODE'
	)
);
const git = (cwd: string, ...args: string[]) => promisify(execFile)('git', args, { cwd });
// Two done tasks («<prefix> first», «<prefix> second») of one project at `repo`, with 150 files in bulk/.
const fixture = async (prefix: string, name: string) => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-tree-ui-')),
		repo = join(root, 'repo'),
		data = join(root, 'data'),
		project = join(data, 'projects/project');
	await mkdir(join(repo, 'bulk'), { recursive: true });
	await Promise.all(
		Array.from({ length: 150 }, (_, i) =>
			writeFile(join(repo, `bulk/zzz${String(i).padStart(3, '0')}.txt`), `file ${i}\n`)
		)
	);
	for (const id of ['first', 'second']) {
		await mkdir(join(project, `tasks/${id}`), { recursive: true });
		await writeFile(
			join(project, `tasks/${id}/task.json`),
			JSON.stringify({
				schemaVersion: 1,
				task: {
					id,
					projectId: 'project',
					title: `${prefix} ${id}`,
					status: 'done',
					provider: 'claude',
				},
			})
		);
	}
	await writeFile(
		join(project, 'project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name, path: repo } })
	);
	const launch = () =>
		electron.launch({
			executablePath,
			args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
			env: { ...env, HOME: root, ZDOTDIR: root, SHELL: '/bin/zsh', BRIGADIR_DATA_DIR: data },
		});
	return { root, repo, launch };
};
test('Files keeps ignored scopes visible and supports selection, keyboard opening, filtering and task parking @area:editor @smoke', async ({}, info) => {
	const { root, repo, launch } = await fixture('Files', 'choice');
	await mkdir(join(repo, 'src'), { recursive: true });
	await mkdir(join(repo, 'apps/admin'), { recursive: true });
	await git(repo, 'init', '-q');
	await git(join(repo, 'apps/admin'), 'init', '-q');
	await writeFile(join(repo, '.gitignore'), 'apps/\nsecret.txt\n');
	await writeFile(join(repo, 'secret.txt'), 'ignored file\n');
	await writeFile(join(repo, 'src/a.ts'), 'export const value = 1;\n');
	await writeFile(join(repo, 'apps/admin/index.ts'), 'nested repository\n');
	const app = await launch();
	try {
		const page = await app.firstWindow(),
			errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		await page.getByRole('button', { name: /Files first/ }).click();
		await refreshChanges(page);
		await expect
			.poll(() =>
				page.evaluate(
					async () =>
						(await window.brigadir.readChanges({ projectId: 'project', id: 'first' })).scopes.length
				)
			)
			.toBe(2);
		await openPanelTab(page, 'files');
		const tree = page.getByRole('tree', { name: 'Project files' }),
			src = tree.getByRole('treeitem', { name: 'src', exact: true });
		await expect(tree.getByRole('treeitem', { name: 'apps', exact: true })).toBeVisible();
		await expect(tree.getByRole('treeitem', { name: 'secret.txt', exact: true })).toHaveCount(0);
		// spec/task-window#files-look, spec/appearance#evolution-redesign: the repo is a root row of the tree (level 1).
		const scope = page
			.locator('[data-menu-tree]')
			.getByRole('button', { name: 'Collapse folder · choice', exact: true });
		await expect(scope).toHaveAttribute('aria-expanded', 'true');
		await expect(tree.getByRole('treeitem', { name: 'choice', exact: true })).toHaveAttribute(
			'aria-level',
			'1'
		);
		await expect(src).toHaveAttribute('aria-level', '2');
		await expect(src.locator('[data-glyph="ft-folder"]')).toHaveCount(1);
		await scope.click();
		await expect(src).toHaveCount(0);
		await page
			.locator('[data-menu-tree]')
			.getByRole('button', { name: 'Expand folder · choice', exact: true })
			.click();
		await expect(src).toBeVisible();
		await src.click();
		await expect(page.getByRole('textbox', { name: 'File content' })).toHaveCount(0);
		await src.press('ArrowRight');
		const a = tree.getByRole('treeitem', { name: 'a.ts', exact: true });
		await expect(a).toBeVisible();
		await src.press('ArrowRight');
		await expect(a).toBeFocused();
		await a.press('Enter');
		await expect(page.getByRole('textbox', { name: 'File content' })).toContainText('value = 1');
		await expect(a.getByText('TS', { exact: true })).toBeVisible();
		await a.focus();
		await a.press('ArrowLeft');
		await expect(src).toBeFocused();
		await src.press('ArrowLeft');
		await expect(a).toHaveCount(0);
		await src.press('Home');
		await tree.getByRole('treeitem').first().press('s');
		await expect(src).toBeFocused();
		await app.evaluate(({ Menu }) =>
			Menu.getApplicationMenu()!
				.items.find((item) => item.label === 'Editor')!
				.submenu!.items.find((item) => item.label === 'Find')!
				.click()
		);
		const filter = page.getByRole('textbox', { name: 'Filter files', exact: true });
		await expect(filter).toBeFocused();
		await expect(page.locator('[data-find-panel]')).toHaveCount(0);
		await filter.fill('index.ts');
		await expect(tree.getByRole('treeitem', { name: 'index.ts', exact: true })).toBeVisible();
		await page.getByRole('button', { name: /Files second/ }).click();
		await page.getByRole('button', { name: /Files first/ }).click();
		await expect(filter).toHaveValue('index.ts');
		// spec/appearance#clear-field: the × clears the field, keeps the caret in it and gives the place back to ⌘F.
		const clear = page.getByRole('button', { name: 'Clear the field', exact: true });
		await clear.click();
		await expect(filter).toHaveValue('');
		await expect(filter).toBeFocused();
		await expect(clear).toHaveCount(0);
		await filter.fill('secret.txt');
		await expect(tree.getByRole('treeitem')).toHaveCount(0);
		await expect(page.getByRole('status').filter({ hasText: 'No results' })).toBeVisible();
		await page.getByRole('button', { name: 'Show ignored files' }).click();
		const secret = tree.getByRole('treeitem', { name: 'secret.txt', exact: true });
		await expect(secret).toHaveAttribute('data-ignored', 'true');
		await secret.dblclick();
		await expect(page.getByRole('textbox', { name: 'File content' })).toContainText('ignored file');
		await filter.focus();
		await filter.press('Escape');
		await expect(filter).toHaveValue('');
		await expect(tree).toBeVisible();
		// The nested repo is a root of its own, not a folder inside apps/.
		await expect(tree.locator('[data-repo-root="apps/admin"]')).toBeVisible();
		await tree.getByRole('treeitem', { name: 'apps', exact: true }).press('ArrowRight');
		await expect(tree.getByRole('treeitem', { name: 'admin', exact: true })).toHaveCount(0);
		await expect(page.getByRole('heading', { name: 'Files', exact: true })).toHaveCount(0);
		const visibility = page.getByRole('button', { name: 'Hide ignored files', exact: true });
		await expect(visibility).toHaveAttribute('aria-pressed', 'true');
		await page.getByRole('button', { name: 'Hide', exact: true }).click();
		await expect(tree.getByRole('treeitem', { name: 'secret.txt', exact: true })).toHaveCount(0);
		await page.getByRole('button', { name: 'Show', exact: true }).click();
		await expect(tree.getByRole('treeitem', { name: 'secret.txt', exact: true })).toBeVisible();
		for (const theme of ['light', 'dark'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await page.screenshot({
				animations: 'disabled',
				path: info.outputPath(`files-${theme}.png`),
			});
		}
		// Native menu callbacks exercise production actions without an OS menu/focus change.
		const menu = async (label: string) =>
			app.evaluate(({ Menu }, label) => {
				const original = Menu.prototype.popup;
				Menu.prototype.popup = function () {
					Menu.prototype.popup = original;
					const item = this.items.find((item) => item.label === label);
					if (!item) throw new Error(`Missing menu ${label}`);
					item.click();
				};
			}, label);
		await menu('To composer');
		await src.dispatchEvent('contextmenu');
		const message = page.getByRole('textbox', { name: 'Message', exact: true }),
			pills = message.locator('[data-mention-pill]');
		await expect(pills).toHaveCount(1);
		await expect(pills.first()).toHaveText('src');
		await expect(pills.first()).toHaveAttribute('data-attachment-id', /.+/);
		await pills.first().click();
		const preview = page.getByRole('dialog', { name: 'src/', exact: true });
		await expect(preview).toContainText('Directory reference:');
		await preview.getByRole('button', { name: 'Close', exact: true }).click();
		await message.fill('');
		await expect(pills).toHaveCount(0);
		await menu('Open terminal here');
		await src.dispatchEvent('contextmenu');
		await expect(page.locator('.xterm')).toHaveCount(1);
		const input = page.locator('.xterm-helper-textarea');
		await input.focus();
		await input.fill('printf \'CWD=%s\\n\' "$PWD"');
		await input.press('Enter');
		const key = { projectId: 'project', id: 'first' };
		await expect
			.poll(() =>
				page.evaluate(async (key) => {
					const items = (await window.brigadir.terminalCommand(key, { kind: 'list' })) as {
						id: string;
					}[];
					return window.brigadir.terminalCommand(key, { kind: 'text', id: items[0]!.id });
				}, key)
			)
			.toContain('/repo/src');
		expect(
			await page.evaluate(async (key) => {
				try {
					await window.brigadir.terminalCommand(key, {
						kind: 'create',
						role: 'console',
						directory: 'src',
					});
					return false;
				} catch {
					return true;
				}
			}, key)
		).toBe(true);
		await menu('Open terminal here');
		await src.dispatchEvent('contextmenu');
		// spec/task-window-workspace#work-area: each terminal is a tab of the work area's bottom group (its name follows the shell's title, so it is not
		// checked here: the shell may rename it any moment).
		await expect(page.locator('[data-tool=terminal]')).toHaveCount(2);
		await src.press('ArrowRight');
		await expect(a).toBeVisible();
		const transfer = await page.evaluateHandle(() => new DataTransfer());
		await a.dispatchEvent('dragstart', { dataTransfer: transfer });
		await page.locator('form').dispatchEvent('drop', { dataTransfer: transfer });
		await expect(pills).toHaveCount(1);
		await expect(pills.first()).toHaveText('a.ts');
		await pills.first().click();
		const filePreview = page.getByRole('dialog', { name: 'a.ts', exact: true });
		await expect(filePreview).toContainText('Project-relative path: "src/a.ts"');
		await filePreview.getByRole('button', { name: 'Close', exact: true }).click();
		await filter.fill('zzz');
		const first = tree.getByRole('treeitem', { name: 'zzz000.txt', exact: true });
		await expect(first).toBeVisible();
		await first.focus();
		await first.press('End');
		const last = tree.getByRole('treeitem', { name: 'zzz099.txt', exact: true });
		await expect(last).toBeFocused();
		await last.press('Home');
		await expect(first).toBeFocused();
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
test('Files preserves pointer selection and parked scroll; keyboard reveals only offscreen rows @area:editor', async () => {
	const { root, repo, launch } = await fixture('Scroll', 'Scroll fixture');
	await git(repo, 'init', '-q');
	const app = await launch();
	try {
		const page = await app.firstWindow(),
			errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		await page.getByRole('button', { name: /Scroll first/ }).click();
		await openPanelTab(page, 'files');
		const tree = page.getByRole('tree', { name: 'Project files' }),
			item = (name: string) => tree.getByRole('treeitem', { name, exact: true });
		await item('bulk').press('ArrowRight');
		await expect(item('zzz000.txt')).toBeVisible();
		const scroll = () => tree.evaluate((node) => node.scrollTop);
		const settle = () =>
			page.evaluate(
				() =>
					new Promise<void>((resolve) =>
						requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
					)
			);
		await tree.evaluate((node) => {
			node.scrollTop = 700;
		});
		await settle();
		const before = await scroll();
		expect(before).toBeGreaterThan(0);
		await item('zzz040.txt').click();
		await expect(item('zzz040.txt')).toHaveAttribute('aria-selected', 'true');
		await settle();
		expect(await scroll()).toBe(before);
		await item('zzz041.txt').dblclick();
		await expect(page.getByRole('textbox', { name: 'File content' })).toContainText('file 41');
		await settle();
		expect(await scroll()).toBe(before);
		// Dismiss the production context menu without opening an OS menu or taking focus.
		await app.evaluate(({ Menu }) => {
			const original = Menu.prototype.popup;
			Menu.prototype.popup = function (options) {
				Menu.prototype.popup = original;
				options?.callback?.();
			};
		});
		await item('zzz042.txt').click({ button: 'right' });
		await expect(item('zzz042.txt')).toHaveAttribute('aria-selected', 'true');
		await settle();
		expect(await scroll()).toBe(before);
		await item('zzz042.txt').press('ArrowDown');
		await expect(item('zzz043.txt')).toBeFocused();
		await settle();
		expect(await scroll()).toBe(before);
		await item('zzz043.txt').press('End');
		await expect(item('zzz149.txt')).toBeFocused();
		const visible = () =>
			tree.evaluate((node) => {
				const row = node.querySelector('[aria-selected="true"]')!.getBoundingClientRect(),
					view = node.getBoundingClientRect();
				return row.top >= view.top && row.bottom <= view.bottom;
			});
		expect(await visible()).toBe(true);
		// spec/task-window#repo-line: the repo root is the list's first row, so Home lands on it; End above skips «Add folder…».
		await item('zzz149.txt').press('Home');
		await expect(item('Scroll fixture')).toBeFocused();
		expect(await scroll()).toBe(0);
		// A selected row outside the viewport must not pull the list back on remount.
		await tree.evaluate((node) => {
			node.scrollTop = 700;
		});
		await settle();
		await page.getByRole('button', { name: /Scroll second/ }).click();
		await page.getByRole('button', { name: /Scroll first/ }).click();
		await expect(tree).toBeVisible();
		await settle();
		expect(await scroll()).toBe(before);
		const filter = page.getByRole('textbox', { name: 'Filter files', exact: true });
		await filter.fill('zzz');
		await expect(item('zzz000.txt')).toBeVisible();
		await tree.evaluate((node) => {
			node.scrollTop = 700;
		});
		await settle();
		const filtered = await scroll();
		await item('zzz040.txt').click();
		await settle();
		expect(await scroll()).toBe(filtered);
		await item('zzz040.txt').press('End');
		await expect(item('zzz099.txt')).toBeFocused();
		expect(await visible()).toBe(true);
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
