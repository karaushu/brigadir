import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hideChat } from './layout';
import { refreshChanges } from './refresh-changes';
const run = promisify(execFile);
const desktop = resolve('apps/desktop');
const executablePath = createRequire(join(desktop, 'package.json'))('electron') as string;

// spec/editor#editor-chrome: the floating find panel over the code and the change map right of it.
test('the find panel floats over the code with its counter, keys, errors and replace; the change map names and jumps to changes @area:editor', async ({}, info) => {
	test.setTimeout(60000);
	const root = await mkdtemp(join(tmpdir(), 'brigadir-editor-find-'));
	const repo = join(root, 'repository'),
		data = join(root, 'data');
	await mkdir(repo);
	const git = (...args: string[]) => run('git', args, { cwd: repo });
	await git('init', '-q');
	await git('config', 'user.name', 'Fixture');
	await git('config', 'user.email', 'fixture@localhost');
	const base = Array.from(
		{ length: 200 },
		(_, i) => `export const value${i + 1} = alert('line ${i + 1}');`
	);
	await writeFile(join(repo, 'sample.ts'), base.join('\n') + '\n');
	await git('add', 'sample.ts');
	await git('commit', '-qm', 'Baseline');
	const next = base.slice();
	next[18] = `export const value19 = alert('changed');`;
	next.splice(106, 0, '// added 1', '// added 2', '// added 3', '// added 4');
	next.splice(150, 1);
	await writeFile(join(repo, 'sample.ts'), next.join('\n') + '\n');
	const key = { projectId: 'project', id: 'task' };
	const taskDir = join(data, 'projects/project/tasks/task');
	await mkdir(taskDir, { recursive: true });
	await writeFile(
		join(data, 'settings.json'),
		JSON.stringify({
			schemaVersion: 1,
			settings: {
				appearance: 'light',
				language: 'en',
				editor: { languageServers: false, diffBase: 'head', lineAuthor: false },
			},
		})
	);
	await writeFile(
		join(taskDir, '../../project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'repository', path: repo } })
	);
	await writeFile(
		join(taskDir, 'task.json'),
		JSON.stringify({
			schemaVersion: 1,
			task: { ...key, title: 'Find fixture', status: 'done', provider: 'claude' },
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
		const page = await app.firstWindow();
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		await page.getByRole('button', { name: /Find fixture/ }).click();
		await hideChat(page);
		await refreshChanges(page);
		await app.evaluate(({ Menu }) =>
			Menu.getApplicationMenu()!
				.items.find((i) => i.label === 'File')!
				.submenu!.items.find((i) => i.label === 'Open Quickly…')!
				.click()
		);
		const quick = page.getByRole('dialog', { name: 'Search files' });
		await quick.getByRole('combobox', { name: 'Search', exact: true }).fill('sample.ts');
		await quick.getByRole('option', { name: /sample\.ts/ }).click();
		const editor = page.getByRole('textbox', { name: 'File content' });
		await expect(editor).toContainText('value1 =');

		// The change map: one mark per change, named on hover; a click puts the caret on the change.
		const map = page.locator('.cm-change-map');
		await expect(map).toBeVisible();
		await expect(map.locator('.cm-map-mark')).toHaveCount(3);
		await expect(map.locator('.cm-map-mark[title="Changed · 19"]')).toHaveCount(1);
		await expect(map.locator('.cm-map-mark[title="Added · 107–110 · +4"]')).toHaveCount(1);
		await expect(map.locator('.cm-map-mark[title="Deleted · after 150 · −1"]')).toHaveCount(1);
		expect((await map.boundingBox())!.width).toBe(12);
		await map.locator('.cm-map-mark[title="Added · 107–110 · +4"]').click();
		await expect(page.locator('.cm-activeLine')).toHaveText('// added 1');
		await expect(editor).toBeFocused();

		// ⌘F: the card floats over the code — the code does not move — and the typed words select the nearest match.
		const top = (await page.locator('.cm-scroller').boundingBox())!.y;
		await editor.press('Meta+f');
		const panel = page.getByRole('search', { name: 'Find in file' });
		const field = panel.getByRole('textbox', { name: 'Find', exact: true });
		await expect(field).toBeFocused();
		expect((await page.locator('.cm-scroller').boundingBox())!.y).toBe(top);
		const box = (await panel.boundingBox())!,
			header = (await page.locator('section[data-font-surface=editor] > header').boundingBox())!;
		expect(Math.round(box.y - (header.y + header.height))).toBe(4);
		expect(Math.round(box.height)).toBe(36);
		await field.pressSequentially('alert');
		const count = panel.locator('[data-find-count]');
		await expect(count).toContainText('107 of 199');
		await expect(map.locator('.cm-map-tick')).toHaveCount(199);
		await expect(map.locator('.cm-map-tick-current')).toHaveCount(1);
		await field.press('Enter');
		await expect(count).toContainText('108 of 199');
		await field.press('Shift+Enter');
		await expect(count).toContainText('107 of 199');
		await field.press('Meta+g');
		await expect(count).toContainText('108 of 199');
		// ⌘G steps from the code too while the panel is open.
		await editor.focus();
		await editor.press('Meta+g');
		await expect(count).toContainText('109 of 199');
		// spec/diff-and-review#diff-selection: a match the panel selected is not the person's selection — no selection panel; extending it with
		// ⇧+→ makes it theirs. Select all matches gives none either.
		const actions = page.locator('[data-selection-actions]');
		await page.waitForTimeout(150);
		await expect(actions).toHaveCount(0);
		await editor.press('Shift+ArrowRight');
		await expect(actions).toHaveCount(1);
		await field.press('Enter');
		await page.waitForTimeout(150);
		await expect(actions).toHaveCount(0);

		// No results, an invalid regular expression.
		await field.fill('nothing like this');
		await expect(count).toContainText('No results');
		await expect(field).toHaveAttribute('aria-invalid', 'true');
		await expect(panel.getByRole('button', { name: 'Next match' })).toBeDisabled();
		await field.fill('alert(');
		await panel.getByRole('button', { name: 'Regular expression' }).click();
		await expect(count).toContainText('Invalid regex');
		await panel.getByRole('button', { name: 'Regular expression' }).click();
		await expect(count).toContainText(/\d+ of 199/);

		// Replace: › opens its row; Replace all edits the buffer as one undoable step.
		await panel.getByRole('button', { name: 'Show replace' }).click();
		const replace = panel.getByRole('textbox', { name: 'Replace', exact: true });
		await expect(replace).toBeFocused();
		await replace.fill('toast(');
		await panel.getByRole('button', { name: 'Replace all' }).click();
		await expect(count).toContainText('No results');
		await expect(editor).toContainText("toast('line 107')");
		// Select all matches is the panel's selection too.
		await field.fill('toast(');
		await panel.getByRole('button', { name: 'Select all matches' }).click();
		await page.waitForTimeout(150);
		await expect(actions).toHaveCount(0);
		await panel.getByRole('button', { name: 'Hide replace' }).click();
		await expect(replace).toHaveCount(0);

		// Esc closes the card and gives the code the focus back.
		await field.press('Escape');
		await expect(panel).toHaveCount(0);
		await expect(editor).toBeFocused();
		await expect(map.locator('.cm-map-tick')).toHaveCount(0);
		await editor.press('Meta+z');
		await expect(editor).toContainText("alert('line 107')");
		expect(errors).toEqual([]);
	} catch (error) {
		await app
			.windows()[0]
			?.screenshot({ path: info.outputPath('failure.png') })
			.catch(() => {});
		throw error;
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
