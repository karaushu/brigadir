import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
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
test('sidebar filters use global snapshot counts and project disclosures persist without hiding filtered work @area:tasks @smoke', async ({}, info) => {
	test.setTimeout(90000);
	const root = await mkdtemp(join(tmpdir(), 'brigadir-sidebar-state-ui-')),
		repo = join(root, 'repo'),
		data = join(root, 'data');
	await mkdir(repo);
	const git = async (...args: string[]) => promisify(execFile)('git', args, { cwd: repo });
	await git('init', '-b', 'main');
	await git('config', 'user.name', 'Fixture');
	await git('config', 'user.email', 'fixture@example.invalid');
	await writeFile(join(repo, 'file'), 'base\n');
	await git('add', '.');
	await git('commit', '-m', 'Baseline');
	for (const id of ['project', 'second']) {
		const dir = join(data, 'projects', id);
		await mkdir(dir, { recursive: true });
		await writeFile(
			join(dir, 'project.json'),
			JSON.stringify({
				schemaVersion: 1,
				project: { id, name: id === 'project' ? 'repository' : 'another', path: repo },
			})
		);
	}
	for (const task of [
		{ id: 'question', projectId: 'project', title: 'Waiting for an answer', status: 'needs-you' },
		{ id: 'working', projectId: 'second', title: 'Working elsewhere', status: 'working' },
		{ id: 'done', projectId: 'project', title: 'No changes', status: 'done' },
	]) {
		const dir = join(data, 'projects', task.projectId, 'tasks', task.id);
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, 'task.json'), JSON.stringify({ schemaVersion: 1, task }));
	}
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
	try {
		let page = await app.firstWindow();
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		const task = await page.evaluate(async () => {
			const task = await window.brigadir.createTask(
				'project',
				'Review actual changes',
				'claude',
				'gui',
				false
			);
			await window.brigadir.startSession(task);
			return task;
		});
		await expect
			.poll(async () =>
				(await page.evaluate((task) => window.brigadir.readSession(task), task)).records.some(
					(record) => record.event.kind === 'turn.completed'
				)
			)
			.toBe(true);
		await writeFile(join(repo, 'file'), 'changed\n');
		await page.evaluate((task) => window.brigadir.sendCommand(task, { kind: 'checkpoint' }), task);
		const sidebar = () => page.locator('aside'),
			filter = () => sidebar().getByRole('button', { name: /^Filter by status/ }),
			menu = () => page.getByRole('menu', { name: 'Filter by status', exact: true }),
			option = (name: string) =>
				menu().getByRole('menuitemradio', { name: new RegExp(`^${name}`) }),
			pick = async (name: string) => {
				await filter().click();
				await option(name).click();
				await expect(menu()).toHaveCount(0);
			},
			counts = async (name: string, count: string) => {
				await filter().click();
				await expect(option(name)).toContainText(count);
				await page.keyboard.press('Escape');
				await expect(menu()).toHaveCount(0);
			},
			project = () => sidebar().getByRole('button', { name: 'repository', exact: true });
		await counts('Unreviewed', '1');
		await sidebar()
			.getByRole('button', { name: /Review actual changes/ })
			.filter({ has: page.locator('[class*=taskCopy]') })
			.click();
		await expect
			.poll(
				async () =>
					(await page.evaluate(() => window.brigadir.readWorkspace())).tasks.find(
						(item) => item.id === task.id
					)?.hasUnread
			)
			.toBe(false);
		await counts('Unreviewed', '1');
		await sidebar().getByRole('button', { name: 'All projects', exact: true }).click();
		await expect(page.locator('[data-board-task]')).toHaveCount(4);
		await filter().focus();
		await page.keyboard.press('Enter');
		await expect(option('All tasks')).toBeFocused();
		await page.keyboard.press('ArrowDown');
		await expect(option('Needs you')).toBeFocused();
		await page.keyboard.press('Space');
		await expect(page.locator('[data-board-task]')).toHaveCount(1);
		await expect(filter()).toBeFocused();
		await expect(filter()).toHaveAccessibleName('Filter by status · Needs you');
		await expect(filter()).toHaveAttribute('data-dot', 'true');
		await expect
			.poll(() =>
				filter()
					.locator('[class*=dot]')
					.evaluate((node) => getComputedStyle(node).backgroundColor)
			)
			.toBe(
				await page.evaluate(() => {
					const probe = document.createElement('span');
					probe.style.color = 'var(--amber)';
					document.body.append(probe);
					const color = getComputedStyle(probe).color;
					probe.remove();
					return color;
				})
			);
		await expect(sidebar().locator('[class*=taskCopy]')).toHaveCount(1);
		await pick('Running');
		await expect(page.locator('[data-board-task=working]')).toBeVisible();
		await pick('Unreviewed');
		await expect(page.locator(`[data-board-task="${task.id}"]`)).toBeVisible();
		await expect(sidebar().locator('[class*=taskCopy]')).toHaveCount(1);
		await pick('Unreviewed');
		await expect(page.locator('[data-board-task]')).toHaveCount(4);
		await expect(filter()).toHaveAttribute('data-dot', 'false');
		await expect(filter()).toHaveAccessibleName('Filter by status');
		const disclosure = () => sidebar().locator('[data-project-disclosure=project]'),
			collapse = () =>
				sidebar().getByRole('button', { name: 'Collapse project · repository', exact: true }),
			expand = () =>
				sidebar().getByRole('button', { name: 'Expand project · repository', exact: true });
		const full = await disclosure().evaluate((node) => node.getBoundingClientRect().height);
		const heights = await collapse().evaluate(async (button) => {
			const node = document.querySelector('[data-project-disclosure=project]')!;
			(button as HTMLButtonElement).click();
			const heights: number[] = [];
			for (let i = 0; i < 20; i++) {
				await new Promise(requestAnimationFrame);
				heights.push(node.getBoundingClientRect().height);
			}
			return heights;
		});
		expect(heights.some((height) => height > 0 && height < full)).toBe(true);
		await expect(disclosure()).toHaveAttribute('aria-hidden', 'true');
		await expect
			.poll(async () => JSON.parse(await readFile(join(data, 'sidebar.json'), 'utf8')).collapsed)
			.toEqual(['project']);
		await expect(sidebar().locator('[class*=projectAttention]')).toContainText('1');
		for (const theme of ['light', 'dark'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await page.screenshot({
				path: info.outputPath(`sidebar-collapsed-${theme}.png`),
				animations: 'disabled',
			});
		}
		await expand().click();
		await page.waitForTimeout(35);
		await collapse().click();
		await expect(disclosure()).toHaveAttribute('aria-hidden', 'true');
		await pick('Needs you');
		await expect(disclosure()).toHaveAttribute('aria-hidden', 'false');
		await expect(sidebar().locator('[class*=taskCopy]')).toHaveCount(1);
		expect(JSON.parse(await readFile(join(data, 'sidebar.json'), 'utf8')).collapsed).toEqual([
			'project',
		]);
		await collapse().click();
		await expect(disclosure()).toHaveAttribute('aria-hidden', 'true');
		await pick('Needs you');
		await expect(disclosure()).toHaveAttribute('aria-hidden', 'true');
		await page.emulateMedia({ reducedMotion: 'reduce' });
		expect(
			await disclosure().evaluate((node) =>
				getComputedStyle(node)
					.transitionDuration.split(',')
					.every((value) => value.trim() === '0s')
			)
		).toBe(true);
		await expand().press('Enter');
		await expect(disclosure()).toHaveAttribute('aria-hidden', 'false');
		await collapse().press('Enter');
		await expect(disclosure()).toHaveAttribute('aria-hidden', 'true');
		await page.emulateMedia({ reducedMotion: 'no-preference' });
		// Text filtering temporarily reveals matching cards without overwriting disclosure preferences.
		await expect
			.poll(() =>
				app.evaluate(
					({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('sidebar-filter')!.enabled
				)
			)
			.toBe(true);
		await app.evaluate(({ Menu }) =>
			Menu.getApplicationMenu()!.getMenuItemById('sidebar-filter')!.click()
		);
		await sidebar()
			.getByRole('searchbox', { name: 'Filter tasks', exact: true })
			.fill('No changes');
		await expect(disclosure()).toHaveAttribute('aria-hidden', 'false');
		await expect(sidebar().locator('[class*=taskCopy]')).toHaveCount(1);
		await sidebar().getByRole('searchbox', { name: 'Filter tasks', exact: true }).press('Escape');
		await expect(disclosure()).toHaveAttribute('aria-hidden', 'true');
		await project().click();
		await expect(page.locator('[data-project-screen=project]')).toBeVisible();
		expect(errors).toEqual([]);
		await page.evaluate((task) => window.brigadir.sendCommand(task, { kind: 'shutdown' }), task);
		await app.close();
		await writeFile(
			join(data, 'settings.json'),
			JSON.stringify({ schemaVersion: 1, settings: { appearance: 'light', language: 'uk' } })
		);
		app = await launch();
		page = await app.firstWindow();
		await expect(disclosure()).toHaveAttribute('aria-hidden', 'true');
		await expect(
			sidebar().getByRole('button', { name: 'Розгорнути проєкт · repository', exact: true })
		).toBeVisible();
		await expect(
			sidebar().getByRole('button', { name: 'Фільтр за станом', exact: true })
		).toHaveAttribute('data-dot', 'false');
		for (const theme of ['light', 'dark'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await page.screenshot({
				path: info.outputPath(`sidebar-uk-${theme}.png`),
				animations: 'disabled',
			});
		}
	} finally {
		try {
			const page = await app.firstWindow();
			await page.evaluate(async () => {
				for (const task of (await window.brigadir.readWorkspace()).tasks)
					if (task.provider)
						await window.brigadir.sendCommand(task, { kind: 'shutdown' }).catch(() => {});
			});
		} catch {}
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
// spec/sidebar#state-icons: a finished task's status mark is green wherever the task's state is shown; its title keeps its own colour.
test('done tasks show the green status mark, completed ones the quiet tick, in the sidebar and on the board (spec/sidebar#state-icons, spec/sidebar#done-rows) @area:tasks', async () => {
	test.setTimeout(60000);
	const root = await mkdtemp(join(tmpdir(), 'brigadir-done-green-')),
		repo = join(root, 'repo'),
		data = join(root, 'data');
	await mkdir(repo);
	const run = async (...args: string[]) => promisify(execFile)('git', args, { cwd: repo });
	await run('init', '-b', 'main');
	await run('config', 'user.name', 'Fixture');
	await run('config', 'user.email', 'fixture@example.invalid');
	await writeFile(join(repo, 'file'), 'base\n');
	await run('add', '.');
	await run('commit', '-m', 'Baseline');
	await mkdir(join(data, 'projects', 'project'), { recursive: true });
	await writeFile(
		join(data, 'projects', 'project', 'project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'repository', path: repo } })
	);
	for (const task of [
		{ id: 'done', projectId: 'project', title: 'Turn finished', status: 'done' },
		{ id: 'completed', projectId: 'project', title: 'Already accepted', status: 'completed' },
		{ id: 'backlog', projectId: 'project', title: 'Not started yet', status: 'backlog' },
	]) {
		const dir = join(data, 'projects', 'project', 'tasks', task.id);
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, 'task.json'), JSON.stringify({ schemaVersion: 1, task }));
	}
	const app = await electron.launch({
		executablePath,
		args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
		env: { ...env, BRIGADIR_DATA_DIR: data },
	});
	try {
		const page = await app.firstWindow();
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		const token = (name: string) =>
			page.evaluate((name) => {
				const probe = document.createElement('span');
				probe.style.color = `var(${name})`;
				document.body.append(probe);
				const value = getComputedStyle(probe).color;
				probe.remove();
				return value;
			}, name);
		const color = (selector: string) =>
			page
				.locator(selector)
				.first()
				.evaluate((node) => getComputedStyle(node).color);
		for (const theme of ['dark', 'light'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			const green = await token('--green');
			await expect.poll(() => color('aside [data-sidebar-task=done] [role=img]')).toBe(green);
			// spec/sidebar#done-rows: `completed` is a tick without a circle in --fg3, not the green check.
			const quiet = await token('--fg3');
			await expect.poll(() => color('aside [data-sidebar-task=completed] [role=img]')).toBe(quiet);
			await expect(
				page.locator('aside [data-sidebar-task=completed] [role=img] [data-glyph=agent-completed]')
			).toHaveCount(1);
			await expect(
				page.locator('aside [data-sidebar-task=done] [role=img] [data-glyph=agent-idle]')
			).toHaveCount(1);
			// The title is not green (spec/sidebar#state-icons); a task not finished keeps a neutral mark.
			expect(await color('aside [data-sidebar-task=done] [class*=taskHead] > span')).not.toBe(
				green
			);
			expect(await color('aside [data-sidebar-task=backlog] [role=img]')).not.toBe(green);
		}
		await page
			.locator('aside')
			.getByRole('heading', { name: 'repository', exact: true })
			.getByRole('button')
			.click();
		await expect(page.locator('[data-project-screen]')).toBeVisible();
		const green = await token('--green');
		expect(await color('[data-board-task="done"] [role=img]')).toBe(green);
		expect(await color('[data-board-task="completed"] [role=img]')).toBe(await token('--fg3'));
		await expect(
			page.locator('[data-board-task="completed"] [role=img] [data-glyph=agent-completed]')
		).toHaveCount(1);
		expect(await color('[data-board-task="backlog"] [role=img]')).not.toBe(green);
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});

test('completed tasks are quiet rows under a fold row, the quiet tick, hover and archive (spec/sidebar#done-rows, spec/sidebar#completed-fold)', async () => {
	test.setTimeout(90000);
	const root = await mkdtemp(join(tmpdir(), 'brigadir-done-rows-')),
		data = join(root, 'data'),
		repo = join(root, 'admin');
	await mkdir(repo, { recursive: true });
	await mkdir(join(data, 'projects', 'admin'), { recursive: true });
	await writeFile(
		join(data, 'projects', 'admin', 'project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'admin', name: 'admin', path: repo } })
	);
	const now = Date.now(),
		ago = (ms: number) => new Date(now - ms).toISOString(),
		hr = 3_600_000;
	// Two turns waiting for the person, four completed (one pinned; the `updatedAt` fallback is a unit test, main stamps a missing `completedAt` at start, spec/tasks#archive); updatedAt is the opposite of the completion order.
	const tasks = [
		{ id: 'turn-a', status: 'done', updatedAt: ago(2 * 60_000) },
		{ id: 'turn-b', status: 'done', updatedAt: ago(21 * hr) },
		{ id: 'c-old', status: 'completed', updatedAt: ago(1 * hr), completedAt: ago(17 * hr) },
		{ id: 'c-new', status: 'completed', updatedAt: ago(30 * hr), completedAt: ago(60_000) },
		{ id: 'c-mid', status: 'completed', updatedAt: ago(30 * hr), completedAt: ago(14 * hr) },
		{
			id: 'c-pinned',
			status: 'completed',
			pinned: true,
			updatedAt: ago(40 * hr),
			completedAt: ago(40 * hr),
		},
	];
	for (const task of tasks) {
		const dir = join(data, 'projects', 'admin', 'tasks', task.id);
		await mkdir(dir, { recursive: true });
		await writeFile(
			join(dir, 'task.json'),
			JSON.stringify({
				schemaVersion: 1,
				task: {
					...task,
					projectId: 'admin',
					title: `Title of ${task.id}`,
					provider: 'claude',
					transport: 'gui',
					prompt: task.id,
					hasStarted: true,
				},
			})
		);
	}
	const app = await electron.launch({
		executablePath,
		args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
		env: { ...env, BRIGADIR_DATA_DIR: data },
	});
	try {
		const page = await app.firstWindow();
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		await page.waitForSelector('aside [data-sidebar-task]');
		const token = (name: string, property: 'color' | 'backgroundColor' = 'color') =>
			page.evaluate(
				([name, property]) => {
					const probe = document.createElement('span');
					probe.style[property as 'color'] = `var(${name})`;
					document.body.append(probe);
					const value = getComputedStyle(probe)[property as 'color'];
					probe.remove();
					return value;
				},
				[name, property] as const
			);
		const style = (selector: string, property: string) =>
			page
				.locator(selector)
				.first()
				.evaluate((node, property) => getComputedStyle(node).getPropertyValue(property), property);
		// Order: not completed first (by the usual order), then the completed: pinned, then the newest completedAt (updatedAt when absent, unit-tested).
		const order = () =>
			page
				.locator('aside [data-sidebar-order]')
				.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-sidebar-task')));
		await expect
			.poll(async () => (await order()).map((id) => (id?.startsWith('turn') ? 'turn' : id)))
			.toEqual(['turn', 'turn', 'c-pinned', 'c-new', 'c-mid', 'c-old']);
		// One fold row before the completed; it folds and unfolds them (spec/sidebar#completed-fold).
		const fold = page.locator('aside [data-done-fold]');
		await expect(fold).toHaveCount(1);
		await expect(fold).toHaveAttribute('aria-expanded', 'true');
		await expect(fold).toContainText('Completed · 4');
		await expect(page.locator('aside [data-done-row]')).toHaveCount(4);
		await fold.click();
		await expect(fold).toHaveAttribute('aria-expanded', 'false');
		await expect(page.locator('aside [data-done-row]')).toHaveCount(0);
		await fold.click();
		await expect(fold).toHaveAttribute('aria-expanded', 'true');
		await expect(page.locator('aside [data-done-row]')).toHaveCount(4);
		const box = async (selector: string) => (await page.locator(selector).first().boundingBox())!;
		// The swipe action of a row takes the row's radius (spec/sidebar#done-rows).
		await expect(page.locator('aside [data-swipe=c-mid]')).toHaveAttribute('data-row', 'true');
		await expect(page.locator('aside [data-swipe=turn-a]')).not.toHaveAttribute('data-row');
		// The tick lines up with the card's mark.
		expect(Math.round((await box('aside [data-done-row] [role=img]')).x)).toBe(
			Math.round((await box('aside [data-sidebar-task=turn-a] [role=img]')).x)
		);
		for (const theme of ['dark', 'light'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await page.mouse.move(600, 500);
			const green = await token('--green'),
				fg = await token('--fg'),
				fg2 = await token('--fg2'),
				fg3 = await token('--fg3');
			// `done`: the green check in a circle, title --fg (weight 400, spec/sidebar#project-groups); completed: the tick in --fg3, title --fg2, weight 400.
			await expect
				.poll(() => style('aside [data-sidebar-task=turn-a] [role=img]', 'color'))
				.toBe(green);
			await expect
				.poll(() => style('aside [data-sidebar-task=turn-a] [class*=taskHead] > span', 'color'))
				.toBe(fg);
			await expect
				.poll(() =>
					style('aside [data-sidebar-task=turn-a] [class*=taskHead] > span', 'font-weight')
				)
				.toBe('400');
			await expect.poll(() => style('aside [data-sidebar-task=turn-a]', 'color')).toBe(fg);
			await expect
				.poll(() => style('aside [data-sidebar-task=c-new] [role=img]', 'color'))
				.toBe(fg3);
			await expect
				.poll(() => style('aside [data-sidebar-task=c-new] [class*=doneTitle]', 'color'))
				.toBe(fg2);
			await expect
				.poll(() => style('aside [data-sidebar-task=c-new] [class*=doneTitle]', 'font-weight'))
				.toBe('400');
			await expect
				.poll(() => style('aside [data-sidebar-task=c-new] [class*=doneAge]', 'color'))
				.toBe(fg3);
			// Hover: the whole row (also empty space right of the title) gets --hover, the age gives way to the Archive button.
			const row = page
					.locator('aside [data-done-row]')
					.filter({ has: page.locator('[data-sidebar-task=c-mid]') }),
				age = row.locator('[class*=doneAge]'),
				button = row.locator('[data-done-archive]');
			await expect(button).toBeHidden();
			await expect(age).toBeVisible();
			expect(await row.evaluate((node) => getComputedStyle(node).backgroundColor)).toBe(
				'rgba(0, 0, 0, 0)'
			);
			const rb = (await row.boundingBox())!;
			await page.mouse.move(rb.x + rb.width - 60, rb.y + rb.height / 2);
			await expect(button).toBeVisible();
			await expect(age).toBeHidden();
			await expect
				.poll(() => row.evaluate((node) => getComputedStyle(node).backgroundColor))
				.toBe(await token('--hover', 'backgroundColor'));
			const bb = (await button.boundingBox())!;
			expect(await button.getAttribute('title')).toMatch(/⌃⌘A$/);
			expect(Math.round(bb.y + bb.height / 2)).toBe(Math.round(rb.y + rb.height / 2));
			// The button has its own hover.
			await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
			await expect
				.poll(() => button.evaluate((node) => getComputedStyle(node).backgroundColor))
				.not.toBe('rgba(0, 0, 0, 0)');
			await page.mouse.move(600, 500);
			await expect(button).toBeHidden();
		}
		// Selected: the soft --sel (spec/appearance#evolution-redesign), no accent border, title --fg; the task opens.
		await page.locator('aside [data-sidebar-task=c-mid]').click();
		await page.mouse.move(600, 500);
		const picked = page.locator('aside [data-sidebar-task=c-mid]'),
			pickedRow = page
				.locator('aside [data-done-row]')
				.filter({ has: page.locator('[data-sidebar-task=c-mid]') });
		await expect(picked).toHaveAttribute('aria-pressed', 'true');
		expect(
			await pickedRow.evaluate((node) => {
				const c = getComputedStyle(node);
				return [c.backgroundColor, c.borderTopWidth];
			})
		).toEqual([await token('--sel', 'backgroundColor'), '0px']); // spec/sidebar#selection, spec/sidebar#project-groups: fill only, no border
		expect(
			await pickedRow.locator('[class*=doneTitle]').evaluate((node) => getComputedStyle(node).color)
		).toBe(await token('--fg'));
		// The button archives without opening the task; the toast follows.
		await page.locator('aside [data-sidebar-task=turn-a]').click();
		await expect(page.locator('aside [data-sidebar-task=turn-a]')).toHaveAttribute(
			'aria-pressed',
			'true'
		);
		const victim = page
				.locator('aside [data-done-row]')
				.filter({ has: page.locator('[data-sidebar-task=c-new]') }),
			vb = (await victim.boundingBox())!;
		await page.mouse.move(vb.x + 70, vb.y + vb.height / 2);
		await victim.locator('[data-done-archive]').click();
		await expect(page.locator('aside [data-sidebar-task=c-new]')).toHaveCount(0);
		await expect(page.locator('[data-archive-toast=archive]')).toBeVisible();
		await expect(page.locator('aside [data-sidebar-task=turn-a]')).toHaveAttribute(
			'aria-pressed',
			'true'
		);
		await expect(page.locator('aside [data-sidebar-task][aria-pressed=true]')).toHaveCount(1);
		expect(
			await page
				.locator('aside [data-sidebar-order]')
				.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-sidebar-task')))
		).toEqual([...(await order()).slice(0, 2), 'c-pinned', 'c-mid', 'c-old']);
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
// spec/sidebar#open-last: the app opens on the project and task open when it last ran; a task gone from the workspace falls back to its project.
test('the last open project and task reopen on launch (spec/sidebar#open-last) @area:tasks', async () => {
	test.setTimeout(90000);
	const root = await mkdtemp(join(tmpdir(), 'brigadir-restore-')),
		data = join(root, 'data'),
		repo = join(root, 'repo');
	await mkdir(repo);
	for (const id of ['first', 'second']) {
		const dir = join(data, 'projects', id);
		await mkdir(dir, { recursive: true });
		await writeFile(
			join(dir, 'project.json'),
			JSON.stringify({ schemaVersion: 1, project: { id, name: `${id} project`, path: repo } })
		);
	}
	for (const task of [
		{ id: 'one', projectId: 'first', title: 'First task' },
		{ id: 'two', projectId: 'second', title: 'Second task' },
		{ id: 'three', projectId: 'second', title: 'Third task' },
	]) {
		const dir = join(data, 'projects', task.projectId, 'tasks', task.id);
		await mkdir(dir, { recursive: true });
		await writeFile(
			join(dir, 'task.json'),
			JSON.stringify({
				schemaVersion: 1,
				task: {
					...task,
					status: 'done',
					provider: 'claude',
					transport: 'gui',
					prompt: task.title,
					hasStarted: true,
				},
			})
		);
	}
	await writeFile(
		join(data, 'settings.json'),
		JSON.stringify({ schemaVersion: 1, settings: { language: 'en' } })
	);
	const launch = () =>
		electron.launch({
			executablePath,
			args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
			env: { ...env, BRIGADIR_DATA_DIR: data },
		});
	const selected = () => JSON.parse(readFileSync(join(data, 'sidebar.json'), 'utf8')).selected;
	let app = await launch();
	try {
		let page = await app.firstWindow();
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		// A fresh profile opens on the first project.
		await page.locator('aside [data-sidebar-task=two]').click();
		await expect(page.locator('aside [data-sidebar-task=two]')).toHaveAttribute(
			'aria-pressed',
			'true'
		);
		await expect.poll(selected).toEqual({ project: 'second', task: 'two' });
		expect(errors).toEqual([]);
		await app.close();
		app = await launch();
		page = await app.firstWindow();
		await expect(page.locator('aside [data-sidebar-task=two]')).toHaveAttribute(
			'aria-pressed',
			'true'
		);
		// All projects reopens as All projects.
		await page.locator('aside').getByRole('button', { name: 'All projects', exact: true }).click();
		await expect.poll(selected).toEqual({ project: '*' });
		await app.close();
		app = await launch();
		page = await app.firstWindow();
		await expect(
			page.locator('aside').getByRole('button', { name: 'All projects', exact: true })
		).toHaveAttribute('aria-pressed', 'true');
		// A task that is gone falls back to its project's board.
		await page.locator('aside [data-sidebar-task=three]').click();
		await expect.poll(selected).toEqual({ project: 'second', task: 'three' });
		await app.close();
		await rm(join(data, 'projects', 'second', 'tasks', 'three'), { recursive: true, force: true });
		app = await launch();
		page = await app.firstWindow();
		await expect(page.locator('[data-project-screen=second]')).toBeVisible();
		await expect(page.locator('aside [data-sidebar-task][aria-pressed=true]')).toHaveCount(0);
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
test('sidebar shows live tool and question, source branch/worktree glyphs and cached immutable snapshot totals @area:tasks', async () => {
	test.setTimeout(90000);
	const root = await mkdtemp(join(tmpdir(), 'brigadir-sidebar-activity-')),
		data = join(root, 'data');
	for (const id of ['project', 'isolated']) {
		const repo = join(root, id);
		await mkdir(repo);
		const git = (...args: string[]) => promisify(execFile)('git', args, { cwd: repo });
		await git('init', '-b', 'main');
		await git('config', 'user.name', 'Fixture');
		await git('config', 'user.email', 'fixture@example.invalid');
		await writeFile(join(repo, 'file.txt'), 'before\n');
		await git('add', '.');
		await git('commit', '-m', 'Baseline');
		await mkdir(join(data, 'projects', id), { recursive: true });
		await writeFile(
			join(data, 'projects', id, 'project.json'),
			JSON.stringify({
				schemaVersion: 1,
				project: {
					id,
					name: id === 'project' ? 'Sidebar project' : 'Worktree project',
					path: repo,
				},
			})
		);
	}
	const dir = join(data, 'projects/project/tasks/active');
	await mkdir(dir, { recursive: true });
	await writeFile(
		join(dir, 'task.json'),
		JSON.stringify({
			schemaVersion: 1,
			task: {
				id: 'active',
				projectId: 'project',
				title: 'Live task',
				provider: 'claude',
				status: 'done',
			},
		})
	);
	await writeFile(
		join(data, 'settings.json'),
		JSON.stringify({ schemaVersion: 1, settings: { language: 'en', appearance: 'light' } })
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
	try {
		let page = await app.firstWindow();
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		const key = { projectId: 'project', id: 'active' };
		await page.evaluate(async (key) => {
			await window.brigadir.startSession(key);
			await window.brigadir.sendCommand(key, { kind: 'prompt', text: 'tool-hold' });
		}, key);
		let active = page.locator('[data-sidebar-task=active]');
		// The live tool and its target stand in the row while the turn runs.
		await expect(active.locator('[data-task-activity]')).toContainText('file.txt');
		await expect(active.locator('[data-task-tree]')).toContainText('main');
		await expect(active.locator('[data-glyph=sidebar-branch]')).toHaveCount(1);
		await expect(active.locator('[data-task-counts]')).toHaveCount(0);
		await writeFile(join(root, 'project/file.txt'), 'after\nnew\n');
		await page.evaluate((key) => window.brigadir.sendCommand(key, { kind: 'checkpoint' }), key);
		await expect(active.locator('[data-task-counts]')).toHaveText('+2 −1');
		await expect(active.getByLabel('Unreviewed', { exact: true })).toBeVisible();
		// Opening the task reads it, but its changes stay unreviewed.
		await active.click();
		await expect
			.poll(async () =>
				page.evaluate(
					async (key) =>
						(await window.brigadir.readWorkspace()).tasks.find((task) => task.id === key.id)
							?.hasUnread,
					key
				)
			)
			.toBe(false);
		await expect(active.getByLabel('Unreviewed', { exact: true })).toBeVisible();
		const worktree = await page.evaluate(async () => {
			const options = await window.brigadir.readLaunchSettings('isolated'),
				task = await window.brigadir.createTask(
					'isolated',
					'Isolated task',
					'claude',
					'gui',
					false,
					{
						...options,
						isolation: 'worktree',
						branch: 'brigadir/sidebar-long-branch-for-ellipsis',
						baseRef: 'main',
						setupCommand: '',
					}
				);
			await window.brigadir.startSession(task);
			return task;
		});
		await expect
			.poll(async () =>
				page.evaluate(
					async (task) =>
						(await window.brigadir.readSession(task)).records.some(
							(record) => record.event.kind === 'turn.completed'
						),
					worktree
				)
			)
			.toBe(true);
		let isolated = page.locator(`[data-sidebar-task="${worktree.id}"]`);
		await expect(isolated.locator('[data-glyph=sidebar-worktree]')).toHaveCount(1);
		await page.evaluate(
			(task) => window.brigadir.sendCommand(task, { kind: 'prompt', text: 'permission' }),
			worktree
		);
		await expect(isolated.locator('[data-task-activity]')).toContainText('Write example');
		await expect(isolated.locator('[data-glyph=agent-permission]')).toHaveCount(1);
		await page.evaluate(async (task) => {
			const snapshot = await window.brigadir.readSession(task),
				request = snapshot.records.findLast(
					(record) => record.event.kind === 'permission.requested'
				)!.event;
			if (request.kind === 'permission.requested')
				await window.brigadir.sendCommand(task, {
					kind: 'answerPermission',
					id: request.request.id,
					optionId: 'deny',
				});
		}, worktree);
		await expect(isolated.locator('[data-task-activity]')).toHaveCount(0);
		await page.evaluate(
			(task) => window.brigadir.sendCommand(task, { kind: 'prompt', text: 'question' }),
			worktree
		);
		await expect(isolated.locator('[data-task-activity]')).toContainText('Which color?');
		await expect(isolated.locator('[data-glyph=agent-question]')).toHaveCount(1);
		await page.evaluate((key) => window.brigadir.sendCommand(key, { kind: 'cancel' }), key);
		await expect(active.locator('[data-task-activity]')).toHaveCount(0);
		await expect(active.locator('[data-task-counts]')).toHaveText('+2 −1');
		// After a restart the open question and the cached totals are still there.
		await app.close();
		app = await launch();
		page = await app.firstWindow();
		page.on('pageerror', (error) => errors.push(error.message));
		isolated = page.locator(`[data-sidebar-task="${worktree.id}"]`);
		active = page.locator('[data-sidebar-task=active]');
		await expect(isolated.locator('[data-task-activity]')).toContainText('Which color?');
		await expect(active.locator('[data-task-counts]')).toHaveText('+2 −1');
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await isolated.focus();
		await page.keyboard.press('Enter');
		await expect(isolated).toHaveAttribute('aria-pressed', 'true');
		expect(errors).toEqual([]);
	} finally {
		try {
			const page = await app.firstWindow();
			await page.evaluate(async () => {
				for (const agent of (await window.brigadir.readLiveAgents()).agents)
					await window.brigadir.controlLiveAgent(agent, 'terminate').catch(() => {});
			});
		} catch {}
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});

// spec/sidebar#width: the drag itself and its persistence; the 220–480 clamp is vitest (renderer/surface-layout.test.ts).
test('the sidebar edge drags its width within 220–480, keeps it by keyboard and in the saved layout (spec/sidebar#width) @area:tasks', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-sidebar-resize-')),
		repo = join(root, 'repo'),
		data = join(root, 'data'),
		project = join(data, 'projects/project');
	await mkdir(repo);
	await mkdir(join(project, 'tasks', 'one'), { recursive: true });
	await writeFile(
		join(project, 'project.json'),
		JSON.stringify({
			schemaVersion: 1,
			project: { id: 'project', name: 'Resize project', path: repo },
		})
	);
	await writeFile(
		join(project, 'tasks', 'one', 'task.json'),
		JSON.stringify({
			schemaVersion: 1,
			task: {
				id: 'one',
				projectId: 'project',
				title: 'Fix kit Button focus ring',
				status: 'needs-you',
			},
		})
	);
	const app = await electron.launch({
		executablePath,
		args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
		env: { ...env, BRIGADIR_DATA_DIR: data },
	});
	try {
		const page = await app.firstWindow();
		await app.evaluate(({ BrowserWindow }) =>
			BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 800)
		);
		const handle = page.getByRole('separator', { name: 'Resize sidebar', exact: true });
		await expect(handle).toHaveAttribute('aria-valuenow', '280');
		const box = (await handle.boundingBox())!;
		await page.mouse.move(box.x, 300);
		await page.mouse.down();
		await page.mouse.move(box.x + 40, 300, { steps: 4 });
		await page.mouse.move(box.x + 80, 300, { steps: 4 });
		await page.mouse.up();
		await expect(handle).toHaveAttribute('aria-valuenow', '360');
		await expect
			.poll(
				async () =>
					JSON.parse(await readFile(join(data, 'surface-layout.json'), 'utf8').catch(() => '{}'))
						.layout?.sidebarWidth
			)
			.toBe(360);
		// The keyboard: End and Home reach the bounds, ← and → step by 20 (the edge is on the right).
		await handle.focus();
		await page.keyboard.press('End');
		await expect(handle).toHaveAttribute('aria-valuenow', '480');
		await page.keyboard.press('ArrowLeft');
		await expect(handle).toHaveAttribute('aria-valuenow', '460');
		await page.keyboard.press('Home');
		await expect(handle).toHaveAttribute('aria-valuenow', '220');
		// A drag past the bound stops at it.
		const edge = (await handle.boundingBox())!;
		await page.mouse.move(edge.x, 300);
		await page.mouse.down();
		await page.mouse.move(edge.x + 600, 300, { steps: 6 });
		await page.mouse.up();
		await expect(handle).toHaveAttribute('aria-valuenow', '480');
		// A narrow window does not overwrite the saved width.
		await app.evaluate(({ BrowserWindow }) =>
			BrowserWindow.getAllWindows()[0]!.setContentSize(820, 800)
		);
		await expect(handle).toHaveAttribute('aria-valuenow', '480');
		await app.evaluate(({ BrowserWindow }) =>
			BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 800)
		);
		// A hidden sidebar has no edge to drag.
		await page.getByRole('button', { name: 'Hide sidebar', exact: true }).click();
		await expect(handle).toHaveCount(0);
		await page.getByRole('button', { name: 'Show sidebar', exact: true }).click();
		await expect(handle).toHaveCount(1);
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
