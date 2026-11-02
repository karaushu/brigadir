import { refreshChanges } from './refresh-changes';
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
const env = Object.fromEntries(
	Object.entries(process.env).filter(
		(e): e is [string, string] => typeof e[1] === 'string' && e[0] !== 'ELECTRON_RUN_AS_NODE'
	)
);
const menuItem = (app: ElectronApplication, id: string) =>
	app.evaluate(({ Menu }, id) => {
		const item = Menu.getApplicationMenu()!.getMenuItemById(id);
		return item ? { enabled: item.enabled, accelerator: item.accelerator ?? null } : null;
	}, id);
// spec/diff-and-review#open-in-editor: ⌘+click on a diff line number opens the file in the editor at that line; a removed line lands where its block
// stood; a plain click still selects the line for a comment. spec/editor#reopen-closed-tab: Changes ▸ Jump to source (F4) lands the same way,
// at the line of the selection, else of the focused line number.
test('⌘+click or F4 on a diff line opens the editor at that line @area:diff', async ({}, info) => {
	test.setTimeout(90000);
	const root = await mkdtemp(join(tmpdir(), 'brigadir-diff-line-open-'));
	const repo = join(root, 'repository');
	await mkdir(repo);
	const git = (...args: string[]) => run('git', args, { cwd: repo });
	await git('init', '-q');
	await git('config', 'user.name', 'Fixture');
	await git('config', 'user.email', 'fixture@localhost');
	const before = Array.from({ length: 200 }, (_, i) => `line_${i + 1}`);
	await writeFile(join(repo, 'a.ts'), before.join('\n') + '\n');
	await git('add', '-A');
	await git('commit', '-qm', 'Baseline');
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
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		await app.evaluate(({ dialog }, path) => {
			dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
		}, repo);
		await page.getByRole('button', { name: 'Add a project…' }).click();
		await page.getByRole('button', { name: 'New task · repository' }).click();
		await page.getByRole('textbox', { name: 'Message', exact: true }).fill('hello');
		await page.getByRole('button', { name: 'Start', exact: true }).click();
		await expect(page.getByRole('log')).toContainText('world', { timeout: 20000 });
		const key = await page.evaluate(async () => {
			const task = (await window.brigadir.readWorkspace()).tasks[0]!;
			return { projectId: task.projectId, id: task.id };
		});
		await expect
			.poll(
				async () =>
					(await page.evaluate((key) => window.brigadir.readSession(key), key)).records.findLast(
						(record) => record.event.kind === 'turn.completed'
					)?.event
			)
			.toMatchObject({ reason: 'end_turn' });
		// Lines 20, 100 and 160 changed; old lines 25–26 deleted, so new line 24 is old line 27 and the rest move up by two.
		const after = before
			.map((line, i) => ([19, 99, 159].includes(i) ? `CHANGED_${i + 1}` : line))
			.filter((_, i) => i !== 24 && i !== 25);
		await writeFile(join(repo, 'a.ts'), after.join('\n') + '\n');
		await refreshChanges(page);
		await expect
			.poll(async () =>
				(await page.evaluate((key) => window.brigadir.readChanges(key), key)).files.map(
					(file) => file.path
				)
			)
			.toEqual(['a.ts']);
		await openPanelTab(page, 'changes');
		await page
			.getByRole('list', { name: 'Files', exact: true })
			.getByRole('button', { name: /a\.ts/ })
			.click();
		const log = page.getByRole('log', { name: 'Diff', exact: true });
		await expect(log).toContainText('CHANGED_20');
		const editor = page.getByRole('textbox', { name: 'File content' });

		// spec/appearance#evolution-redesign: a plain click on the number selects nothing and stays in the diff.
		const changed = page.getByRole('button', { name: 'Open in editor · new:20', exact: true });
		await changed.click();
		await expect(page.locator('[data-selection-actions]')).toHaveCount(0);
		await expect(editor).toHaveCount(0);

		// ⌘+click opens the editor with the cursor on that line.
		await changed.click({ modifiers: ['Meta'] });
		await expect(editor).toBeVisible();
		await expect(page.locator('.cm-activeLine')).toHaveText('CHANGED_20');

		// A removed line lands on the line that now stands where its block was.
		await page.getByRole('tab', { name: 'Diff · a.ts', exact: true }).click();
		await expect(log).toContainText('line_25');
		await page
			.getByRole('button', { name: 'Open in editor · old:26', exact: true })
			.click({ modifiers: ['Meta'] });
		await expect(editor).toBeVisible();
		await expect(page.locator('.cm-activeLine')).toHaveText('line_27');
		await page.screenshot({ animations: 'disabled', path: info.outputPath('editor-at-line.png') });

		// spec/diff-and-review#diff-selection: Esc on the selection panel drops it.
		await editor.click();
		await page.keyboard.press('Home');
		await page.keyboard.press('Shift+ArrowDown');
		await page.keyboard.press('Shift+ArrowDown');
		const panel = page.locator('[data-selection-actions]');
		await expect(panel).toBeVisible();
		await panel.getByRole('button', { name: 'To composer', exact: true }).focus();
		await page.keyboard.press('Escape');
		await expect(panel).toHaveCount(0);
		await editor.click();
		await page.keyboard.press('Shift+ArrowDown');
		await expect(panel).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(panel).toHaveCount(0);

		// spec/diff-and-review#open-in-editor: the line lands in the middle of the editor with the caret on it, also when the tab was
		// open and scrolled elsewhere, and in a split group.
		const centred = (scope: ReturnType<typeof page.locator>, text: string) =>
			expect
				.poll(() =>
					scope.locator('.cm-activeLine').evaluate((line) => {
						const scroller = line.closest('.cm-scroller')!,
							a = line.getBoundingClientRect(),
							b = scroller.getBoundingClientRect();
						return {
							text: line.textContent,
							centred: Math.abs((a.top + a.bottom) / 2 - (b.top + b.bottom) / 2) <= a.height * 1.5,
						};
					})
				)
				.toEqual({ text, centred: true });
		await editor.evaluate((node) => (node.closest('.cm-scroller')!.scrollTop = 0));
		const diffTab = page.getByRole('tab', { name: 'Diff · a.ts', exact: true }),
			jump = () =>
				app.evaluate(({ Menu }) =>
					Menu.getApplicationMenu()!.getMenuItemById('diff-jump-to-source')!.click()
				),
			focusedGroup = page.locator('[data-editor-group][data-focused=true]');

		// F4 with a word selected on the new side lands on its line.
		await diffTab.click();
		await expect(log).toContainText('CHANGED_100');
		await log.locator('[data-code-line="98"][data-side="new"]').dblclick();
		await expect(page.locator('[data-selection-actions]')).toBeVisible();
		await expect
			.poll(() => menuItem(app, 'diff-jump-to-source'))
			.toEqual({ enabled: true, accelerator: 'F4' });
		await jump();
		await centred(focusedGroup, 'CHANGED_100');
		await expect(editor).toBeFocused();
		// Outside the diff the item is off.
		await editor.click();
		await expect
			.poll(() => menuItem(app, 'diff-jump-to-source').then((item) => item?.enabled))
			.toBe(false);
		// Without a selection, F4 takes the focused line number; a removed line lands where its block stands.
		await diffTab.click();
		await expect(log).toContainText('line_25');
		await page.evaluate(() => window.getSelection()?.removeAllRanges());
		await page.getByRole('button', { name: 'Open in editor · old:26', exact: true }).focus();
		await jump();
		await centred(focusedGroup, 'line_27');

		await diffTab.click();
		await expect(log).toContainText('CHANGED_160');
		await page
			.getByRole('button', { name: 'Open in editor · new:158', exact: true })
			.click({ modifiers: ['Meta'] });
		await centred(focusedGroup, 'CHANGED_160');
		await expect(editor).toBeFocused();
		await app.evaluate(({ Menu }) => {
			const groups = Menu.getApplicationMenu()!
				.items.find((entry) => entry.label === 'View')!
				.submenu!.items.find((entry) => entry.label === 'Editor groups')!;
			groups.submenu!.items.find((entry) => entry.label === 'Split right')!.click();
		});
		const groups = page.locator('[data-editor-group]');
		await expect(groups).toHaveCount(2);
		await groups.first().getByRole('tab', { name: 'Diff · a.ts', exact: true }).click();
		await expect(groups.first()).toHaveAttribute('data-focused', 'true');
		await expect(log).toContainText('CHANGED_100');
		await page.getByRole('button', { name: 'Open in editor · new:98', exact: true }).focus();
		await page.keyboard.press('Enter');
		await centred(groups.first(), 'CHANGED_100');

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
