import { _electron as electron, expect, test } from '@playwright/test';
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
// spec/editor#editor-groups: editor groups. Split copies the tab into a new group, Move takes it there; the group without the focus shows its
// document passively and follows the edits; a click focuses it; a dragged tab splits or moves; the last tab closes the group.
test('editor groups split, follow edits, take the focus, move tabs and close @area:editor', async () => {
	test.setTimeout(90000);
	const root = await mkdtemp(join(tmpdir(), 'brigadir-split-'));
	const repo = join(root, 'repository');
	await mkdir(repo);
	const git = (...args: string[]) => run('git', args, { cwd: repo });
	await git('init', '-q');
	await git('config', 'user.name', 'Fixture');
	await git('config', 'user.email', 'fixture@localhost');
	for (const name of ['a.ts', 'b.ts', 'c.ts'])
		await writeFile(join(repo, name), `export const ${name[0]} = 1;\n`);
	// b.ts indents with tabs two wide by the project's .editorconfig, in every group.
	await writeFile(join(repo, 'b.ts'), 'export function b() {\n\treturn 1;\n}\n');
	await writeFile(
		join(repo, '.editorconfig'),
		'root = true\n\n[b.ts]\nindent_style = tab\ntab_width = 2\n'
	);
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
			task: { ...key, title: 'Split fixture', status: 'done', provider: 'claude' },
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
		env: { ...env, BRIGADIR_DATA_DIR: join(root, 'data') },
	});
	await app.evaluate(({ Menu }) => {
		const state = globalThis as any;
		Menu.prototype.popup = function (options) {
			state.menu = this;
			state.options = options;
		};
	});
	const choose = async (label: string) => {
		await expect.poll(() => app.evaluate(() => !!(globalThis as any).menu)).toBe(true);
		await app.evaluate((_, label) => {
			const state = globalThis as any,
				item = state.menu.items.find((item: any) => item.label === label);
			if (!item?.enabled) throw new Error(`Unavailable: ${label}`);
			item.click();
			state.options?.callback?.();
			state.menu = null;
		}, label);
	};
	// The group items are a View submenu right under Layout (spec/task-window-workspace#layout-switch).
	const view = (label: string) =>
		app.evaluate(({ Menu }, label) => {
			const items = Menu.getApplicationMenu()!.items.find((entry) => entry.label === 'View')!
					.submenu!.items,
				at = items.findIndex((entry) => entry.label === 'Layout');
			if (items[at + 1]?.label !== 'Editor groups')
				throw new Error('Editor groups is not under Layout');
			const item = items[at + 1]!.submenu!.items.find((entry) => entry.label === label)!;
			item.click();
			return { accelerator: item.accelerator ?? null, enabled: item.enabled };
		}, label);
	try {
		const page = await app.firstWindow();
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		await page.getByRole('button', { name: /Split fixture/ }).click();
		await openPanelTab(page, 'files');
		const tree = page.getByRole('tree', { name: 'Project files' });
		const groups = page.locator('[data-editor-group]'),
			focused = page.locator('[data-editor-group][data-focused=true]'),
			passive = page.locator('[data-editor-group][data-focused=false]');
		const tabsOf = (group: typeof groups) =>
			group
				.getByRole('tab')
				.evaluateAll((list) =>
					list.map(
						(item) =>
							`${item.getAttribute('aria-label')}${item.getAttribute('aria-selected') === 'true' ? '*' : ''}`
					)
				);
		for (const name of ['a.ts', 'b.ts'])
			await tree.getByRole('treeitem', { name, exact: true }).dblclick();
		await expect(groups).toHaveCount(1);

		// Split right from the tab menu: b.ts stays in the first group and opens in a new focused group on the right.
		await focused.getByRole('tab', { name: 'b.ts', exact: true }).click({ button: 'right' });
		await choose('Split right');
		await expect(groups).toHaveCount(2);
		await expect.poll(() => tabsOf(focused)).toEqual(['b.ts*']);
		await expect.poll(() => tabsOf(passive)).toEqual(['a.ts', 'b.ts*']);
		const boxes = await groups.evaluateAll((list) =>
			list
				.map((item) => item.getBoundingClientRect())
				.map((box) => ({ x: Math.round(box.x), y: Math.round(box.y) }))
		);
		expect(boxes[1]!.x).toBeGreaterThan(boxes[0]!.x);
		expect(boxes[1]!.y).toBe(boxes[0]!.y);
		// The active tab of the passive group carries the grey line, the focused one the accent.
		const line = (group: typeof groups) =>
			group.locator('[data-active=true]').evaluate((node) => getComputedStyle(node).boxShadow);
		expect(await line(focused)).not.toBe(await line(passive));
		// spec/editor#indentation: the passive group shows b.ts with the same tab width as the focused one.
		const tabSize = (group: typeof groups) =>
			group.locator('.cm-content').evaluate((node) => getComputedStyle(node).tabSize);
		await expect.poll(() => tabSize(focused)).toBe('2');
		await expect.poll(() => tabSize(passive)).toBe('2');

		// One buffer behind both: an edit in the focused group shows in the passive one at once.
		const live = focused.getByRole('textbox', { name: 'File content' });
		await live.click();
		await page.keyboard.press('Meta+End');
		await page.keyboard.insertText('export const shared = 2;\n');
		await expect(passive.locator('[data-passive-editor]')).toContainText(
			'export const shared = 2;'
		);

		// A click into the passive group focuses it; the live editor moves there; ⌥⇥ (Next group) walks back.
		await passive.locator('[data-passive-editor] .cm-content').click();
		await expect(groups.first()).toHaveAttribute('data-focused', 'true');
		await expect(groups.first().getByRole('textbox', { name: 'File content' })).toBeVisible();
		expect(await view('Next group')).toEqual({ accelerator: 'Alt+Tab', enabled: true });
		await expect(groups.nth(1)).toHaveAttribute('data-focused', 'true');

		// Split and move down from the menu bar: a.ts leaves the first group for a new one below it.
		await groups.first().getByRole('tab', { name: 'a.ts', exact: true }).click();
		await view('Split and move down');
		await expect(groups).toHaveCount(3);
		await expect.poll(() => tabsOf(focused)).toEqual(['a.ts*']);
		await expect.poll(() => tabsOf(groups.first())).toEqual(['b.ts*']);
		const down = await focused.evaluate((node) => node.getBoundingClientRect().y),
			top = await groups.first().evaluate((node) => node.getBoundingClientRect().y);
		expect(down).toBeGreaterThan(top);

		// A tab dragged into another group's strip moves there.
		await tree.getByRole('treeitem', { name: 'c.ts', exact: true }).dblclick();
		await expect.poll(() => tabsOf(focused)).toEqual(['a.ts', 'c.ts*']);
		await focused
			.getByRole('tab', { name: 'c.ts', exact: true })
			.dragTo(groups.nth(2).getByRole('tablist'));
		await expect.poll(() => tabsOf(groups.nth(2))).toEqual(['b.ts', 'c.ts*']);
		await expect(groups.nth(2)).toHaveAttribute('data-focused', 'true');

		// Closing the last tab of a group removes the group; closing b.ts in one group keeps its buffer for the other, with no question.
		await groups.nth(1).getByRole('tab', { name: 'a.ts', exact: true }).click();
		await groups.nth(1).getByRole('button', { name: 'Close file · a.ts' }).click();
		await expect(groups).toHaveCount(2);
		await groups.nth(1).getByRole('button', { name: 'Close file · b.ts' }).click();
		await expect(
			page.getByRole('alert').filter({ hasText: 'There are unsaved changes.' })
		).toHaveCount(0);
		await expect.poll(() => tabsOf(groups.nth(1))).toEqual(['c.ts*']);
		await expect.poll(() => tabsOf(groups.first())).toEqual(['b.ts*']);
		await expect(groups.first().locator('[data-passive-editor]')).toContainText(
			'export const shared = 2;'
		);

		// Unsplit all gathers every tab into one group.
		await view('Unsplit all');
		await expect(groups).toHaveCount(1);
		await expect.poll(() => tabsOf(groups.first())).toEqual(['b.ts', 'c.ts*']);
		// The shared buffer saves once for both views; nothing is left to ask about on quit.
		await groups.first().getByRole('tab', { name: 'b.ts', exact: true }).click();
		await groups.first().getByRole('textbox', { name: 'File content' }).click();
		await page.keyboard.press('Meta+s');
		// spec/editor#document-tabs: no unsaved dot in the tab once it is saved.
		await expect(
			groups
				.first()
				.getByRole('tab', { name: 'b.ts', exact: true })
				.getByRole('img', { name: 'Unsaved' })
		).toHaveCount(0);
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
