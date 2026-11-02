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
test('the editor context menu follows the click and runs the editor actions (spec/editor#editor-context-menu) @area:editor @serial', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-editor-menu-')),
		repo = join(root, 'repo'),
		data = join(root, 'data'),
		dir = join(data, 'projects/project/tasks/task');
	await mkdir(repo);
	await mkdir(dir, { recursive: true });
	await promisify(execFile)('git', ['init', '-q'], { cwd: repo });
	await writeFile(
		join(repo, 'sample.ts'),
		Array.from(
			{ length: 20 },
			(_, i) => `export const row${String(i + 1).padStart(3, '0')} = ${i + 1};`
		).join('\n') + '\n'
	);
	// spec/search-menus-and-commands#package-scripts: a package.json whose scripts the menu and the command editor offer; pnpm by its lock file.
	await writeFile(
		join(repo, 'package.json'),
		JSON.stringify(
			{ name: 'fixture', scripts: { web: 'expo start --web', build: 'expo export' } },
			null,
			2
		) + '\n'
	);
	await writeFile(join(repo, 'pnpm-lock.yaml'), '');
	await writeFile(
		join(data, 'settings.json'),
		JSON.stringify({ schemaVersion: 1, settings: { appearance: 'light', language: 'en' } })
	);
	await writeFile(
		join(dir, '../../project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'repo', path: repo } })
	);
	await writeFile(
		join(dir, 'task.json'),
		JSON.stringify({
			schemaVersion: 1,
			task: {
				id: 'task',
				projectId: 'project',
				title: 'Editor menu',
				status: 'done',
				provider: 'claude',
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
	const close = () =>
		app.evaluate(() => {
			const state = globalThis as any;
			state.options?.callback?.();
			state.menu = null;
		});
	const copied = () => app.evaluate(() => (globalThis as any).copied as string | undefined);
	try {
		const page = await app.firstWindow(),
			errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		await page.getByRole('button', { name: /Editor menu/ }).click();
		await refreshChanges(page);
		await expect
			.poll(() =>
				page.evaluate(
					async () =>
						(await window.brigadir.readChanges({ projectId: 'project', id: 'task' })).checkpoint
				)
			)
			.not.toBeNull();
		await openPanelTab(page, 'files');
		await page.getByRole('treeitem', { name: 'sample.ts', exact: true }).dblclick();
		const editor = page.getByRole('textbox', { name: 'File content', exact: true }),
			footer = page.locator('section[data-font-surface="editor"] > footer'),
			actions = page.locator('[data-selection-actions]');
		const line = (n: number) =>
			page.locator('.cm-line').filter({ hasText: `row${String(n).padStart(3, '0')} ` });
		await expect(line(5)).toBeVisible();

		// A right click on a word moves the caret there; nothing is selected, so cut, copy and the hunk items are off.
		// The review loads after the file opens; until then Add a comment waits, as the panel's Comment does.
		await expect
			.poll(async () => {
				await line(5).click({ button: 'right', position: { x: 20, y: 5 } });
				const list = await items();
				await close();
				return list;
			})
			.toEqual([
				'Ask the agent',
				'Add a comment',
				'To composer',
				'-',
				'Go to definition',
				'Find references',
				'-',
				'Open diff (off)',
				'Revert change (off)',
				'-',
				'File history',
				'Commit of this line (off)',
				'-',
				'Cut (off)',
				'Copy (off)',
				'Paste',
				'Toggle comment',
				'Format document',
				'-',
				'Copy path:line',
				'Copy relative path',
				'Open terminal here',
				'Show in file manager',
			]);
		await expect(footer).toContainText('5:');
		await expect(actions).toHaveCount(0);
		await line(5).click({ button: 'right', position: { x: 20, y: 5 } });
		await choose('Copy path:line');
		expect(await copied()).toBe('sample.ts:5');

		// Inside a selection the click keeps it; path:line names the whole range.
		await editor.focus();
		await editor.press('Meta+ArrowUp');
		await editor.press('ArrowDown');
		for (let i = 0; i < 3; i++) await editor.press('Shift+ArrowDown');
		await expect(actions).toContainText('2–4');
		// spec/search-menus-and-commands#menu-glyphs: the glyphs reach main soon after the start; every item then carries its own as a template image.
		await expect
			.poll(() =>
				app.evaluate(({ Menu }) => !!Menu.getApplicationMenu()?.getMenuItemById('settings')?.icon)
			)
			.toBe(true);
		await line(3).click({ button: 'right', position: { x: 20, y: 5 } });
		expect(await items()).toContain('Cut');
		expect(
			await app.evaluate(() =>
				(globalThis as any).menu.items
					.filter((item: any) => item.type !== 'separator' && !item.icon?.isTemplateImage())
					.map((item: any) => item.label)
			)
		).toEqual([]);
		await expect(actions).toContainText('2–4');
		await choose('Copy path:line');
		expect(await copied()).toBe('sample.ts:2-4');
		await line(3).click({ button: 'right', position: { x: 20, y: 5 } });
		await choose('Copy relative path');
		expect(await copied()).toBe('sample.ts');
		// Outside the selection the click collapses it to the new caret.
		await line(10).click({ button: 'right', position: { x: 20, y: 5 } });
		await items();
		await close();
		await expect(actions).toHaveCount(0);
		await expect(footer).toContainText('10:');

		// ⇧F10 opens the same menu at the caret; Add a comment opens a draft on the caret line.
		await editor.press('Shift+F10');
		await items();
		const at = await app.evaluate(() => {
			const options = (globalThis as any).options;
			return { x: options?.x, y: options?.y };
		});
		expect(at.x).toBeGreaterThan(0);
		expect(at.y).toBeGreaterThan(0);
		await choose('Add a comment');
		const draft = page.locator('[data-comment-draft]');
		await expect(draft).toBeVisible();
		await expect(draft).toContainText('1 line selected');
		await draft.getByRole('textbox', { name: 'Comment', exact: true }).press('Escape');
		await expect(draft).toHaveCount(0);

		// Toggle comment edits the caret line; the change it makes turns the hunk items on, and Revert change undoes it.
		await line(7).click({ button: 'right', position: { x: 20, y: 5 } });
		await choose('Toggle comment');
		await expect(page.locator('.cm-line').filter({ hasText: 'row007 ' })).toContainText(
			'// export const row007'
		);
		await expect(page.locator('[data-change]')).not.toHaveCount(0);
		await page
			.locator('.cm-line')
			.filter({ hasText: 'row007 ' })
			.click({ button: 'right', position: { x: 40, y: 5 } });
		const changed = await items();
		expect(changed).toContain('Open diff');
		expect(changed).toContain('Revert change');
		await choose('Revert change');
		await expect(page.locator('.cm-line').filter({ hasText: 'row007 ' })).not.toContainText('//');

		// A right click in the selection panel is not the editor's: the panel keeps its own behavior.
		await editor.focus();
		await editor.press('Shift+ArrowDown');
		await expect(actions).toBeVisible();
		await app.evaluate(() => {
			(globalThis as any).menu = null;
		});
		await actions.getByRole('button', { name: 'Comment', exact: true }).click({ button: 'right' });
		await page.waitForTimeout(200);
		expect(await app.evaluate(() => !!(globalThis as any).menu)).toBe(false);

		// spec/search-menus-and-commands#package-scripts: a package.json leads the menu with its scripts; off a script line the two items are off.
		await page.getByRole('treeitem', { name: 'package.json', exact: true }).dblclick();
		const json = (text: string) => page.locator('.cm-line').filter({ hasText: text });
		await expect(json('"web"')).toBeVisible();
		await json('"name"').click({ button: 'right', position: { x: 12, y: 5 } });
		expect((await items()).slice(0, 4)).toEqual([
			'Run script (off)',
			'Add to commands… (off)',
			'-',
			'Ask the agent',
		]);
		await close();
		await json('"web"').click({ button: 'right', position: { x: 30, y: 5 } });
		expect((await items()).slice(0, 2)).toEqual(['Run script', 'Add to commands…']);
		await choose('Add to commands…');
		const sheet = page.getByRole('dialog', { name: 'New command' });
		await expect(sheet).toBeVisible();
		await expect(sheet.getByLabel('Name')).toHaveValue('web');
		await expect(sheet.getByLabel('Command')).toHaveValue('pnpm run web');
		// The Scripts menu of the editor: a pick fills the line, and the name that came from a script follows it.
		await sheet.getByRole('button', { name: 'Scripts', exact: true }).click();
		const scripts = page.getByRole('dialog', { name: 'Scripts · package.json' });
		await expect(scripts.locator('[data-script-row]')).toHaveCount(2);
		await scripts.locator('[data-script-row="build"] button').click();
		await expect(scripts).toHaveCount(0);
		await expect(sheet.getByLabel('Command')).toHaveValue('pnpm run build');
		await expect(sheet.getByLabel('Name')).toHaveValue('build');
		await sheet.getByRole('button', { name: 'Save', exact: true }).click();
		await expect(sheet).toHaveCount(0);
		await expect
			.poll(async () =>
				(await page.evaluate(() => window.brigadir.readWorkspace())).projects[0]?.commands?.map(
					(command) => [command.name, command.command, command.repo, command.directory]
				)
			)
			.toEqual([['build', 'pnpm run build', '', '']]);
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
