import {
	_electron as electron,
	expect,
	test,
	type ElectronApplication,
	type Page,
} from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { launchPRFixture } from './pr-fixture';
import { openPanelTab } from './layout';
const desktop = resolve('apps/desktop'),
	executablePath = createRequire(join(desktop, 'package.json'))('electron') as string;
const env = Object.fromEntries(
	Object.entries(process.env).filter(
		(entry): entry is [string, string] =>
			typeof entry[1] === 'string' && entry[0] !== 'ELECTRON_RUN_AS_NODE'
	)
);

const click = (app: ElectronApplication, id: string) =>
	app.evaluate(({ Menu }, id) => Menu.getApplicationMenu()!.getMenuItemById(id)!.click(), id);
const accelerator = (app: ElectronApplication, id: string) =>
	app.evaluate(
		({ Menu }, id) => Menu.getApplicationMenu()!.getMenuItemById(id)?.accelerator ?? null,
		id
	);
const enabled = (app: ElectronApplication, id: string) =>
	app.evaluate(
		({ Menu }, id) => Menu.getApplicationMenu()!.getMenuItemById(id)?.enabled ?? false,
		id
	);

// spec/search-menus-and-commands#search-tabs: All with groups and «More N», Text with the preview and its options, PR, Actions with shortcuts and a switch,
// ⇧⌘F / ⇧⌘A / ⌥⇧⌘F in the menu, the empty state and the PR module switched off.
test('Search Everywhere: All, Text, PR, Actions (spec/search-menus-and-commands#search-tabs) @area:settings', async ({}, info) => {
	test.setTimeout(180000);
	const fixture = await launchPRFixture({ theme: 'dark' });
	const { app, page, repo, errors } = fixture;
	try {
		// Five files in the gitignored kit repo and one in the root: both roots of the monorepo are searched.
		await mkdir(join(repo, 'kit/src/focus'), { recursive: true });
		for (let i = 1; i <= 5; i++)
			await writeFile(
				join(repo, `kit/src/focus/focus${i}.ts`),
				`// focus ${i}\nexport const focusRing${i} = '2px solid var(--accent)';\nexport const FocusRing${i}Wide = 3;\n`
			);
		await writeFile(join(repo, 'focus-root.ts'), 'export const focusRingRoot = 1;\n');
		await page
			.evaluate(
				(task) => window.brigadir.sendCommand(task as never, { kind: 'checkpoint' } as never),
				fixture.task
			)
			.catch(() => {});

		// Menu: the File items and the task filter on ⌥⇧⌘F.
		expect(await accelerator(app, 'find-in-files')).toBe('CmdOrCtrl+Shift+F');
		expect(await accelerator(app, 'find-action')).toBe('CmdOrCtrl+Shift+A');
		expect(await accelerator(app, 'sidebar-filter')).toBe('CmdOrCtrl+Alt+Shift+F');
		await expect.poll(() => enabled(app, 'search')).toBe(true);

		// «All»: groups in order, at most three rows, «More N» opens the group's tab with the same query.
		await click(app, 'search');
		const search = page.getByRole('dialog', { name: 'Search Everywhere', exact: true }),
			query = search.getByRole('combobox', { name: 'Search', exact: true });
		await expect(search.getByRole('tab', { name: 'All', exact: true })).toHaveAttribute(
			'aria-selected',
			'true'
		);
		await expect(search.getByRole('tablist')).toHaveText(
			/All.*Agents.*Files.*Text.*PR.*Commands.*Actions/
		);
		await query.fill('focus');
		const groups = search.locator('[role=listbox] > [role=presentation]');
		await expect(groups.filter({ hasText: 'Files' })).toBeVisible();
		await expect(groups.filter({ hasText: 'Text' })).toBeVisible({ timeout: 20000 });
		await expect(search.locator('[role=listbox] > button[data-kind=file]')).toHaveCount(3);
		await expect(search.locator('[role=listbox] > button[data-kind=text]')).toHaveCount(3, {
			timeout: 20000,
		});
		await expect
			.poll(async () => (await groups.allTextContents()).map((text) => text.split(/\d/)[0]!.trim()))
			.toEqual(['Files', 'Actions', 'PR', 'Text']);
		await expect(search.locator('[role=listbox] > button[data-kind=pr]')).toContainText(
			'Kit Button: focus ring token'
		);
		await page.screenshot({ animations: 'disabled', path: info.outputPath('all-dark.png') });
		await groups
			.filter({ hasText: 'Files' })
			.getByRole('button', { name: /^More 3/ })
			.click();
		await expect(search.getByRole('tab', { name: 'Files', exact: true })).toHaveAttribute(
			'aria-selected',
			'true'
		);
		await expect(query).toHaveValue('focus');
		await expect(search.locator('[role=listbox] > button[data-kind=file]')).toHaveCount(6);
		// ⇥ and ⇧⇥ walk the tabs; hover is the selection.
		await query.press('Tab');
		await expect(search.getByRole('tab', { name: 'Text', exact: true })).toHaveAttribute(
			'aria-selected',
			'true'
		);
		await query.press('Shift+Tab');
		await expect(search.getByRole('tab', { name: 'Files', exact: true })).toHaveAttribute(
			'aria-selected',
			'true'
		);
		const second = search.locator('[role=listbox] > button[data-kind=file]').nth(1);
		await second.hover();
		await expect(second).toHaveAttribute('aria-selected', 'true');
		// The empty state names where it looked.
		await search.getByRole('tab', { name: 'All', exact: true }).click();
		await query.fill('zzqxwv');
		await expect(search.getByText('Nothing found for «zzqxwv»', { exact: true })).toBeVisible({
			timeout: 20000,
		});
		await page.keyboard.press('Escape');
		await expect(search).toBeHidden();

		// Text (⇧⌘F): files grouped, the preview on the right, Aa / W / .* and Enter opens the editor on the line.
		await click(app, 'find-in-files');
		await expect(search.getByRole('tab', { name: 'Text', exact: true })).toHaveAttribute(
			'aria-selected',
			'true'
		);
		await query.fill('focusRing');
		const lines = search.locator('[role=listbox] > button[data-kind=text]');
		await expect(lines).toHaveCount(11, { timeout: 20000 });
		await expect(search.locator('[role=listbox] > [role=presentation]').first()).toContainText(
			'focus-root.ts'
		);
		await expect(search.getByText('line 1 · 1 match in the file', { exact: true })).toBeVisible();
		await expect(search.locator('[class*=source] > div[data-hit=true]')).toHaveCount(1);
		await expect(search.locator('footer')).toContainText('11 matches in 6 files');
		await page.screenshot({ animations: 'disabled', path: info.outputPath('text-dark.png') });
		await query.press('Alt+ArrowDown');
		await expect(lines.nth(1)).toHaveAttribute('aria-selected', 'true');
		await expect(search.getByText('line 2 · 2 matches in the file', { exact: true })).toBeVisible();
		await expect(search.locator('[class*=source] > div[data-hit=true]')).toHaveCount(2);
		const matchCase = search.getByRole('button', { name: 'Match case', exact: true });
		await matchCase.click();
		await expect(matchCase).toHaveAttribute('aria-pressed', 'true');
		await expect(lines).toHaveCount(6, { timeout: 20000 });
		await query.press('Alt+KeyC');
		await expect(matchCase).toHaveAttribute('aria-pressed', 'false');
		await expect(lines).toHaveCount(11, { timeout: 20000 });
		await search.getByRole('button', { name: 'Whole word', exact: true }).click();
		await expect(lines).toHaveCount(0, { timeout: 20000 });
		await search.getByRole('button', { name: 'Whole word', exact: true }).click();
		await search.getByRole('button', { name: 'Regular expression', exact: true }).click();
		await query.fill('focusRing[0-9]+ =');
		await expect(lines).toHaveCount(5, { timeout: 20000 });
		await search.getByRole('button', { name: 'Regular expression', exact: true }).click();
		await query.fill('focusRing3 =');
		await expect(lines).toHaveCount(1, { timeout: 20000 });
		await query.press('Enter');
		await expect(search).toBeHidden();
		await expect(page.getByRole('tab', { name: /focus3\.ts/ })).toBeVisible();
		await expect(page.locator('.cm-activeLine')).toContainText('focusRing3');

		// PR: number, title, author; the panel's groups; Enter opens the Overview.
		await click(app, 'search');
		await search.getByRole('tab', { name: 'PR', exact: true }).click();
		await query.fill('41');
		const prs = search.locator('[role=listbox] > button[data-kind=pr]');
		await expect(prs).toHaveCount(3);
		await expect(search.locator('[role=listbox] > [role=presentation]')).toHaveText([
			/^Yours/,
			/^Others/,
			/^Recently closed/,
		]);
		await query.fill('Loyalty');
		await expect(prs).toHaveCount(1);
		await expect(prs).toContainText('#421');
		await expect(prs).toContainText('Open');
		await expect(search.locator('[role=listbox] > [role=presentation]')).toHaveText([
			/^Waiting for you/,
		]);
		await page.screenshot({ animations: 'disabled', path: info.outputPath('pr-dark.png') });
		await query.press('Enter');
		await expect(search).toBeHidden();
		await expect(page.locator('[data-pr-panel]')).toContainText('Loyalty 1+1 in admin');

		// Actions (⇧⌘A): menu items with shortcuts; Enter runs one; a switch toggles in place.
		await click(app, 'find-action');
		await expect(search.getByRole('tab', { name: 'Actions', exact: true })).toHaveAttribute(
			'aria-selected',
			'true'
		);
		await query.fill('show changes');
		const action = search.locator('[role=listbox] > button[data-kind=action]').first();
		await expect(action).toContainText('Show changes');
		await expect(action.locator('kbd')).toHaveText('⇧⌘D');
		await expect(action.locator('small')).toHaveText('View');
		await query.press('Enter');
		await expect(search).toBeHidden();
		await expect(page.locator('[data-panel-tab=changes]')).toHaveAttribute('aria-selected', 'true');
		await click(app, 'find-action');
		await query.fill('line author');
		const setting = search.locator('[role=listbox] > button[data-kind=setting]').first();
		await expect(setting).toContainText('Line author');
		await expect(setting.locator('small')).toHaveText('Settings ▸ Editor ▸ Git');
		await expect(setting.locator('[data-on]')).toHaveAttribute('data-on', 'true');
		await page.screenshot({ animations: 'disabled', path: info.outputPath('actions-dark.png') });
		await query.press('Enter');
		await expect(setting.locator('[data-on]')).toHaveAttribute('data-on', 'false');
		await expect(search).toBeVisible();
		await expect
			.poll(
				async () =>
					(await page.evaluate(() => window.brigadir.readSettings())).settings.editor.lineAuthor
			)
			.toBe(false);
		// A setting that is not a switch opens its Settings tab.
		await query.fill('diff base');
		await query.press('Enter');
		await expect(search).toBeHidden();
		const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
		await expect(settings.getByRole('tab', { name: 'Editor', exact: true })).toHaveAttribute(
			'aria-selected',
			'true'
		);
		await page.keyboard.press('Escape');
		await expect(settings).toBeHidden();

		// The PR module off: no PR tab, ⇥ skips it.
		await page.evaluate(async () => {
			const { settings } = await window.brigadir.readSettings();
			await window.brigadir.saveSettings({
				...settings,
				modules: { ...settings.modules, pullRequests: false },
			});
		});
		await click(app, 'search');
		await expect(search.getByRole('tab', { name: 'PR', exact: true })).toHaveCount(0);
		await expect(search.getByRole('tablist')).toHaveText(
			/All.*Agents.*Files.*Text.*Commands.*Actions/
		);
		await page.keyboard.press('Escape');

		// ⌥⇧⌘F is the task filter.
		await click(app, 'sidebar-filter');
		await expect(page.getByRole('searchbox', { name: 'Filter tasks', exact: true })).toBeFocused();
		expect(errors).toEqual([]);
	} finally {
		await fixture.close();
	}
});

/** Rule 14: the shared `Esc` (ui/PopupClose) closes the surface, not a text «Close» or a footer-only Cancel. */
async function expectEsc(scope: ReturnType<Page['locator']>) {
	const close = scope.getByRole('button', { name: 'Close', exact: true });
	await expect(close).toHaveAttribute('aria-keyshortcuts', 'Escape');
	return close;
}

/**
 * Rule 14 on the chat search bar and the Remove worktree confirm, which is the shared ConfirmDialog
 * (320, Esc in the header, solid red action). A file outside the task repos names that
 * instead of the unsaved-file hint for Comment.
 */
test('chat search and Remove worktree close with Esc; a file outside the task repos takes no Comment @area:settings', async ({}, info) => {
	test.setTimeout(90000);
	const root = await mkdtemp(join(tmpdir(), 'brigadir-modal-esc-')),
		repo = join(root, 'repo'),
		folder = join(root, 'folder'),
		data = join(root, 'data');
	const git = (cwd: string, ...args: string[]) => promisify(execFile)('git', args, { cwd });
	// `repo` is a Git project (worktree task); `folder` holds a repo and a file in none (the outside file).
	for (const path of [repo, join(folder, 'app')]) {
		await mkdir(path, { recursive: true });
		await git(path, 'init', '-q', '-b', 'main');
		await git(path, 'config', 'user.name', 'Fixture');
		await git(path, 'config', 'user.email', 'fixture@example.invalid');
		await writeFile(join(path, 'a.ts'), 'export const a = 1;\n');
		await git(path, 'add', '.');
		await git(path, 'commit', '-qm', 'Initial');
	}
	await writeFile(join(folder, 'notes.txt'), 'one\ntwo\nthree\nfour\n');
	for (const [id, path] of [
		['project', repo],
		['folder', folder],
	] as const) {
		await mkdir(join(data, 'projects', id), { recursive: true });
		await writeFile(
			join(data, 'projects', id, 'project.json'),
			JSON.stringify({ schemaVersion: 1, project: { id, name: id, path } })
		);
	}
	await writeFile(
		join(data, 'settings.json'),
		JSON.stringify({ schemaVersion: 1, settings: { appearance: 'light', language: 'en' } })
	);
	const app = await electron.launch({
		executablePath,
		args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
		env: {
			...env,
			BRIGADIR_DATA_DIR: data,
			BRIGADIR_TEST_AGENT: resolve('packages/transport/fixtures/agent.mjs'),
		},
	});
	try {
		const page = await app.firstWindow(),
			errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 860));
		const task = await page.evaluate(async () => {
			const settings = await window.brigadir.readLaunchSettings('project');
			const task = await window.brigadir.createTask(
				'project',
				'Check notes',
				'claude',
				'gui',
				false,
				{
					...settings,
					isolation: 'worktree',
					branch: 'brigadir/check-notes',
					baseRef: 'main',
					setupCommand: '',
				}
			);
			await window.brigadir.startSession(task);
			return task;
		});
		await expect
			.poll(
				async () =>
					(await page.evaluate((task) => window.brigadir.readSession(task), task)).records.some(
						(record) => record.event.kind === 'turn.completed'
					),
				{ timeout: 30000 }
			)
			.toBe(true);
		await page.locator(`[data-sidebar-task="${task.id}"]`).click();

		// The chat log's search: Esc in place of the text «Close».
		const log = page.getByRole('log').first();
		await log.click();
		await app.evaluate(({ BrowserWindow }) =>
			BrowserWindow.getAllWindows()[0]!.webContents.send('editor:action', 'find')
		);
		const field = page.getByRole('textbox', { name: 'Find in current panel', exact: true });
		await expect(field).toBeFocused();
		const search = page.locator('form').filter({ has: field });
		await expect(search.getByRole('button', { name: 'Close', exact: true })).toHaveCount(1);
		for (const theme of ['light', 'dark'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await search.screenshot({
				animations: 'disabled',
				path: info.outputPath(`chat-search-${theme}.png`),
			});
		}
		await app.evaluate(({ nativeTheme }) => {
			nativeTheme.themeSource = 'light';
		});
		await (await expectEsc(search)).click();
		await expect(field).toHaveCount(0);

		// Remove worktree: the shared confirm, enabled once the task stops.
		await page.evaluate((task) => window.brigadir.sendCommand(task, { kind: 'shutdown' }), task);
		await expect
			.poll(
				async () =>
					(await page.evaluate((task) => window.brigadir.readSession(task), task)).connected
			)
			.toBe(false);
		await page.reload();
		await page.locator(`[data-sidebar-task="${task.id}"]`).click();
		// spec/appearance#evolution-redesign: one repo — «Remove worktree…» is the last item of its actions, here from the header's repo chip.
		const actions = page.locator('[data-repo-chip]');
		await expect
			.poll(async () => {
				await actions.click();
				const item = page.getByRole('menuitem', { name: 'Remove worktree…' });
				const enabled = await item.isEnabled().catch(() => false);
				if (!enabled) await page.keyboard.press('Escape');
				return enabled;
			})
			.toBe(true);
		await page.getByRole('menuitem', { name: 'Remove worktree…' }).click();
		const confirm = page.getByRole('dialog', { name: 'Remove the worktree?', exact: true });
		await expect(confirm).toBeVisible();
		await expect(confirm.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
		await expect(confirm.getByRole('button', { name: 'Remove', exact: true })).toBeEnabled();
		for (const theme of ['light', 'dark'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await confirm.screenshot({
				animations: 'disabled',
				path: info.outputPath(`remove-worktree-${theme}.png`),
			});
		}
		await app.evaluate(({ nativeTheme }) => {
			nativeTheme.themeSource = 'light';
		});
		await (await expectEsc(confirm)).click();
		await expect(confirm).toHaveCount(0);
		await expect(actions).toBeFocused();

		// A file outside the task repos (a task in the project folder itself): Comment is off.
		const inPlace = await page.evaluate(async () => {
			const task = await window.brigadir.createTask('folder', 'Read notes', 'claude', 'gui', false);
			await window.brigadir.startSession(task);
			return task;
		});
		await expect
			.poll(
				async () =>
					(await page.evaluate((task) => window.brigadir.readSession(task), inPlace)).records.some(
						(record) => record.event.kind === 'turn.completed'
					),
				{ timeout: 30000 }
			)
			.toBe(true);
		await page.locator(`[data-sidebar-task="${inPlace.id}"]`).click();
		await openPanelTab(page, 'files');
		await page
			.getByRole('tree', { name: 'Project files' })
			.getByRole('treeitem', { name: 'notes.txt', exact: true })
			.dblclick();
		const editor = page.getByRole('textbox', { name: 'File content', exact: true });
		await expect(editor).toContainText('three');
		await editor.focus();
		await editor.press('Meta+ArrowUp');
		await editor.press('Shift+ArrowDown');
		const panel = page.locator('[data-selection-actions]');
		await expect(panel).toBeVisible();
		await expect(panel.getByRole('button', { name: 'Comment', exact: true })).toBeDisabled();
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
