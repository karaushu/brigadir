import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const desktop = resolve('apps/desktop'),
	executablePath = createRequire(join(desktop, 'package.json'))('electron') as string;
const env = Object.fromEntries(
	Object.entries(process.env).filter(
		(entry): entry is [string, string] =>
			typeof entry[1] === 'string' && entry[0] !== 'ELECTRON_RUN_AS_NODE'
	)
);
/** Native context menus answered in the test: `install` catches the next popup, `choose` clicks an enabled item. */
function nativeMenus(app: () => ElectronApplication) {
	const install = () =>
		app().evaluate(({ Menu }) => {
			const state = globalThis as any;
			state.menu = null;
			Menu.prototype.popup = function (options) {
				state.menu = this;
				state.closed = options?.callback;
			};
		});
	const labels = async () => {
		await expect.poll(() => app().evaluate(() => !!(globalThis as any).menu)).toBe(true);
		return app().evaluate(
			() =>
				(globalThis as any).menu.items.map((item: any) => item.label).filter(Boolean) as string[]
		);
	};
	const choose = async (label: string) => {
		await labels();
		await app().evaluate((_, label) => {
			const state = globalThis as any,
				item = state.menu.items.find((item: any) => item.label === label);
			if (!item?.enabled) throw new Error(`Unavailable: ${label}`);
			item.click();
			state.closed?.();
			state.menu = null;
		}, label);
	};
	return { install, labels, choose };
}
test('sidebar actions duplicate an editable draft, open the clicked diff and continue the same stopped task @area:tasks', async ({}, info) => {
	test.setTimeout(60000);
	const root = await mkdtemp(join(tmpdir(), 'brigadir-sidebar-actions-')),
		repo = join(root, 'repo'),
		data = join(root, 'data');
	await mkdir(repo);
	const git = (...args: string[]) => promisify(execFile)('git', args, { cwd: repo });
	await git('init', '-b', 'main');
	await git('config', 'user.name', 'Fixture');
	await git('config', 'user.email', 'fixture@example.invalid');
	await writeFile(join(repo, 'file.txt'), 'before\n');
	await git('add', '.');
	await git('commit', '-m', 'Initial');
	await mkdir(join(data, 'projects/project'), { recursive: true });
	await writeFile(
		join(data, 'projects/project/project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'repository', path: repo } })
	);
	await writeFile(
		join(data, 'settings.json'),
		JSON.stringify({ schemaVersion: 1, settings: { appearance: 'light', language: 'en' } })
	);
	const launch = () =>
		electron.launch({
			executablePath,
			args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
			env: {
				...env,
				BRIGADIR_DATA_DIR: data,
				BRIGADIR_TEST_AGENT: resolve('packages/transport/fixtures/agent.mjs'),
			},
		});
	let app = await launch();
	const { install: captureMenus, labels, choose } = nativeMenus(() => app);
	try {
		await captureMenus();
		let page = await app.firstWindow();
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		const source = await page.evaluate(async () => {
			const settings = await window.brigadir.readLaunchSettings('project');
			const task = await window.brigadir.createTask(
				'project',
				'Original task prompt',
				'claude',
				'gui',
				false,
				{
					...settings,
					isolation: 'worktree',
					branch: 'brigadir/original-task-prompt',
					baseRef: 'main',
					setupCommand: '',
				}
			);
			await window.brigadir.startSession(task);
			return task;
		});
		const row = () => page.locator(`[data-sidebar-task="${source.id}"]`);
		await expect
			.poll(async () =>
				(await page.evaluate((task) => window.brigadir.readSession(task), source)).records.some(
					(record) => record.event.kind === 'turn.completed'
				)
			)
			.toBe(true);
		const state = JSON.parse(
			await readFile(join(data, 'projects/project/tasks', source.id, 'worktree.json'), 'utf8')
		);
		await writeFile(join(state.root, 'file.txt'), 'after\n');
		await page.evaluate(
			(task) => window.brigadir.sendCommand(task, { kind: 'checkpoint' }),
			source
		);
		await row().click({ button: 'right' });
		expect(await labels()).not.toContain('Continue with a new agent');
		await choose('Stop');
		await expect
			.poll(
				async () =>
					(await page.evaluate((task) => window.brigadir.readSession(task), source)).connected
			)
			.toBe(false);
		const other = await page.evaluate(() =>
			window.brigadir.createTask('project', 'Other task', 'claude', 'gui', false)
		);
		await page.reload();
		await page.locator(`[data-sidebar-task="${other.id}"]`).click();
		await row().click({ button: 'right' });
		const menu = await labels();
		expect(menu.slice(0, 6)).toEqual([
			'Open task',
			'Continue with a new agent',
			'Continue in a new task',
			'Duplicate task…',
			'Repeat…',
			'Show task diff',
		]);
		expect(menu.at(-1)).toBe('Delete task…');
		await writeFile(info.outputPath('menu-en.json'), JSON.stringify(menu, null, 2));
		await choose('Show task diff');
		await expect(row()).toHaveAttribute('aria-pressed', 'true');
		await expect(page.getByRole('list', { name: 'Files', exact: true })).toContainText('file.txt');
		expect(
			(await page.evaluate((task) => window.brigadir.readSession(task), source)).connected
		).toBe(false);
		await row().focus();
		await row().press('Shift+F10');
		await choose('Duplicate task…');
		let sheet = page.getByRole('dialog', { name: 'New task', exact: true });
		await expect(sheet.getByRole('textbox', { name: 'Message', exact: true })).toHaveText(
			'Original task prompt'
		);
		await expect(sheet.getByRole('radio', { name: 'Worktree', exact: true })).toBeChecked();
		await expect(sheet.getByRole('textbox', { name: 'Branch name', exact: true })).not.toHaveValue(
			'brigadir/original-task-prompt'
		);
		await expect(sheet.getByRole('button', { name: 'Base ref', exact: true })).toContainText(
			'main'
		);
		for (const theme of ['light', 'dark'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await sheet.screenshot({
				path: info.outputPath(`duplicate-${theme}.png`),
				animations: 'disabled',
			});
		}
		await sheet.press('Escape');
		await expect(sheet).toHaveCount(0);
		await expect(row()).toBeFocused();
		expect((await page.evaluate(() => window.brigadir.readWorkspace())).tasks).toHaveLength(2);
		await row().click({ button: 'right' });
		await choose('Duplicate task…');
		await expect(sheet.getByRole('textbox', { name: 'Message', exact: true })).toBeFocused();
		await sheet.getByRole('button', { name: 'Add to backlog', exact: true }).click();
		await expect(
			sheet.getByRole('button', { name: 'Add to backlog', exact: true })
		).toHaveAttribute('aria-pressed', 'true');
		await sheet.getByRole('textbox', { name: 'Message', exact: true }).fill('Edited duplicate');
		await sheet.getByRole('button', { name: 'Save', exact: true }).click();
		await expect(sheet).toHaveCount(0);
		const copy = (await page.evaluate(() => window.brigadir.readWorkspace())).tasks.find(
			(task) => task.prompt === 'Edited duplicate'
		)!;
		expect(copy.id).not.toBe(source.id);
		expect(copy.status).toBe('backlog');
		expect(copy.continuesTaskId).toBeUndefined();
		expect(copy.launch?.branch).not.toBe('brigadir/original-task-prompt');
		expect(
			(await page.evaluate((task) => window.brigadir.readSession(task), copy)).records
		).toEqual([]);
		await page.locator(`[data-sidebar-task="${copy.id}"]`).click({ button: 'right' });
		await choose('Duplicate task…');
		await expect(
			sheet.getByRole('button', { name: 'Add to backlog', exact: true })
		).toHaveAttribute('aria-pressed', 'true');
		await sheet.press('Escape');
		await row().click({ button: 'right' });
		await choose('Continue with a new agent');
		await expect
			.poll(
				async () =>
					(await page.evaluate((task) => window.brigadir.readSession(task), source)).records.filter(
						(record) => record.event.kind === 'session.started'
					).length
			)
			.toBe(2);
		const continued = await page.evaluate((task) => window.brigadir.readSession(task), source);
		expect(continued.records.filter((record) => record.event.kind === 'turn.started')).toHaveLength(
			1
		);
		expect(
			(await page.evaluate((task) => window.brigadir.readChanges(task), source)).files
		).toHaveLength(1);
		await expect(row()).toHaveAttribute('aria-pressed', 'true');
		expect((await page.evaluate(() => window.brigadir.readWorkspace())).tasks).toHaveLength(3);
		await page.evaluate((task) => window.brigadir.sendCommand(task, { kind: 'shutdown' }), source);
		await expect
			.poll(
				async () =>
					(await page.evaluate((task) => window.brigadir.readSession(task), source)).connected
			)
			.toBe(false);
		expect(errors).toEqual([]);
		await app.close();
		await writeFile(
			join(data, 'settings.json'),
			JSON.stringify({ schemaVersion: 1, settings: { appearance: 'dark', language: 'uk' } })
		);
		app = await launch();
		await captureMenus();
		page = await app.firstWindow();
		await row().click({ button: 'right' });
		const uk = await labels();
		expect(uk).toContain('Продовжити з новим агентом');
		expect(uk).toContain('Продовжити в новій задачі');
		expect(uk).toContain('Дублювати…');
		expect(uk).toContain('Показати зміни');
		await writeFile(info.outputPath('menu-uk.json'), JSON.stringify(uk, null, 2));
		await choose('Дублювати…');
		sheet = page.getByRole('dialog', { name: 'Нова задача', exact: true });
		await expect(sheet.getByRole('textbox', { name: 'Повідомлення', exact: true })).toHaveText(
			'Original task prompt'
		);
		await sheet.screenshot({
			path: info.outputPath('duplicate-uk-dark.png'),
			animations: 'disabled',
		});
		await sheet.press('Escape');
	} finally {
		try {
			const page = await app.firstWindow();
			await page.evaluate(async () => {
				for (const task of (await window.brigadir.readWorkspace()).tasks)
					await window.brigadir.sendCommand(task, { kind: 'shutdown' }).catch(() => {});
			});
		} catch {}
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
test('manual names and pins persist without changing prompts; native actions, focus and error retry work @area:tasks @serial', async () => {
	test.setTimeout(60000);
	const root = await mkdtemp(join(tmpdir(), 'brigadir-label-ui-')),
		repo = join(root, 'repo'),
		data = join(root, 'data'),
		project = join(data, 'projects/project');
	await mkdir(repo);
	await mkdir(join(project, 'tasks'), { recursive: true });
	await writeFile(
		join(project, 'project.json'),
		JSON.stringify({
			schemaVersion: 1,
			project: { id: 'project', name: 'Labels project', path: repo },
		})
	);
	for (const id of ['one', 'two', 'three']) {
		await mkdir(join(project, 'tasks', id));
		await writeFile(
			join(project, 'tasks', id, 'task.json'),
			JSON.stringify({
				schemaVersion: 1,
				task: {
					id,
					projectId: 'project',
					title: `Task ${id}`,
					prompt: `Original prompt ${id}`,
					provider: 'claude',
					status: id === 'three' ? 'backlog' : 'done',
				},
			})
		);
	}
	await writeFile(
		join(data, 'settings.json'),
		JSON.stringify({ schemaVersion: 1, settings: { language: 'en', appearance: 'light' } })
	);
	const launch = () =>
		electron.launch({
			executablePath,
			args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
			env: { ...env, BRIGADIR_DATA_DIR: data },
		});
	let app = await launch();
	const { install, choose } = nativeMenus(() => app);
	try {
		await install();
		let page = await app.firstWindow();
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		const two = page.locator('[data-sidebar-task="two"]');
		await two.click();
		const before = await readFile(join(project, 'tasks/two/task.json'));
		await two.press('Shift+F10');
		await choose('Rename task…');
		const dialog = page.getByRole('dialog', { name: 'Rename task', exact: true }),
			input = dialog.getByRole('textbox', { name: 'Task title', exact: true });
		// The title opens selected, ready to type over.
		await expect(input).toBeFocused();
		expect(
			await input.evaluate((node) => ({
				start: (node as HTMLInputElement).selectionStart,
				end: (node as HTMLInputElement).selectionEnd,
			}))
		).toEqual({ start: 0, end: 8 });
		await input.fill('  ');
		await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
		await input.fill('Cancelled draft');
		await page.keyboard.press('Escape');
		await expect(dialog).not.toBeVisible();
		await expect(two).toBeFocused();
		await expect(two).toContainText('Task two');
		await two.press('Shift+F10');
		await choose('Rename task…');
		await expect(dialog).toBeVisible();
		await page.waitForTimeout(30);
		await page.keyboard.press('Escape');
		await two.press('Shift+F10');
		await choose('Rename task…');
		await expect(dialog).toBeVisible();
		await expect(input).toBeFocused();
		await input.fill('My manual name');
		await input.press('Enter');
		await expect(dialog).not.toBeVisible();
		await expect(two).toContainText('My manual name');
		await expect(page.getByRole('heading', { name: 'My manual name', exact: true })).toBeVisible();
		await expect(two).toBeFocused();
		// The manual name lives beside the task: task.json and its prompt stay as they were.
		expect(await readFile(join(project, 'tasks/two/task.json'))).toEqual(before);
		await two.press('Shift+F10');
		await choose('Pin task');
		await expect(page.locator('[data-sidebar-task]').first()).toHaveAttribute(
			'data-sidebar-task',
			'two'
		);
		await expect(two).toHaveAttribute('aria-pressed', 'true');
		await expect(two).toHaveAttribute('data-pinned', 'true');
		await two.press('Shift+F10');
		await choose('Copy task title');
		expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe('My manual name');
		// A failed save keeps the dialog and the typed name; Save again succeeds.
		await two.press('Shift+F10');
		await choose('Rename task…');
		await input.fill('Saved after retry');
		const labels = await readFile(join(data, 'task-labels.json'));
		await writeFile(join(data, 'task-labels.json'), '{"schemaVersion":99,"labels":{}}');
		await input.press('Enter');
		await expect(dialog.getByRole('alert')).toBeVisible();
		await expect(input).toHaveValue('Saved after retry');
		await writeFile(join(data, 'task-labels.json'), labels);
		await dialog.getByRole('button', { name: 'Save', exact: true }).click();
		await expect(dialog).not.toBeVisible();
		await expect(two).toContainText('Saved after retry');
		// A backlog task keeps its manual name when its prompt is edited.
		const three = page.locator('[data-sidebar-task="three"]');
		await three.focus();
		await three.press('Shift+F10');
		await choose('Rename task…');
		await input.fill('Manual backlog');
		await input.press('Enter');
		await expect(dialog).not.toBeVisible();
		await three.press('Shift+F10');
		await choose('Edit task…');
		const edit = page.getByRole('dialog', { name: 'Edit task', exact: true });
		await expect(edit).toBeVisible();
		await edit.getByRole('textbox', { name: 'Message', exact: true }).fill('Edited backlog prompt');
		await edit.getByRole('button', { name: 'Save', exact: true }).click();
		await expect(edit).not.toBeVisible();
		await expect(three).toContainText('Manual backlog');
		// After a restart: names and the pin are kept; unpin from the menu.
		await app.close();
		app = await launch();
		await install();
		page = await app.firstWindow();
		page.on('pageerror', (error) => errors.push(error.message));
		const restored = page.locator('[data-sidebar-task="two"]');
		await expect(restored).toContainText('Saved after retry');
		await expect(restored).toHaveAttribute('data-pinned', 'true');
		await expect(page.locator('[data-sidebar-task="three"]')).toContainText('Manual backlog');
		await restored.focus();
		await restored.press('Shift+F10');
		await choose('Rename task…');
		await expect(page.getByRole('dialog', { name: 'Rename task', exact: true })).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(restored).toBeFocused();
		await restored.press('Shift+F10');
		await choose('Unpin task');
		await expect(restored).toHaveAttribute('data-pinned', 'false');
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
