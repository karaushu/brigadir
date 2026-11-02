import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openPanelTab, showChat } from './layout';
const desktop = resolve('apps/desktop'),
	executablePath = createRequire(join(desktop, 'package.json'))('electron') as string;
test('conflict choices guard real hosts, queue past live owners, mark both diffs contended, isolate and recover after owner death @area:tasks', async ({}, info) => {
	test.setTimeout(120000);
	const root = await mkdtemp(join(tmpdir(), 'brigadir-locks-ui-')),
		repo = join(root, 'repository'),
		data = join(root, 'data');
	await mkdir(repo);
	const git = (...args: string[]) => promisify(execFile)('git', args, { cwd: repo });
	await git('init', '-b', 'main');
	await git('config', 'user.name', 'Fixture');
	await git('config', 'user.email', 'fixture@example.invalid');
	await writeFile(join(repo, 'file.txt'), 'baseline\n');
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
	const env = Object.fromEntries(
		Object.entries(process.env).filter(
			(entry): entry is [string, string] =>
				typeof entry[1] === 'string' && entry[0] !== 'ELECTRON_RUN_AS_NODE'
		)
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
	const choose = async (application: ElectronApplication, label: string) =>
		application.evaluate(({ Menu }, label) => {
			const original = Menu.buildFromTemplate;
			Menu.buildFromTemplate = (items: any[]) => {
				Menu.buildFromTemplate = original;
				const item = items.find((item) => item.label === label);
				if (!item || item.enabled === false) throw new Error(`No enabled menu item ${label}`);
				return {
					popup: ({ callback }: any) => {
						item.click();
						callback?.();
					},
				} as any;
			};
		}, label);
	try {
		const page = await app.firstWindow(),
			errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		const tasks = await page.evaluate(async () => {
			const defaults = {
				...(await window.brigadir.readLaunchSettings('project')),
				branch: '',
				baseRef: 'main',
			};
			const tasks = [];
			for (const name of ['First owner', 'Second owner', 'Waiting task', 'Isolated task'])
				tasks.push(
					await window.brigadir.createTask('project', name, 'claude', 'gui', false, defaults)
				);
			return tasks;
		});
		const [a, b, c, d] = tasks;
		const start = async (task: typeof a) =>
			page.evaluate((task) => {
				void window.brigadir
					.startSession(task!)
					.then(() => {
						const state = globalThis as any;
						state.finished ??= {};
						state.finished[task!.id] = (state.finished[task!.id] ?? 0) + 1;
					})
					.catch((error) => {
						(globalThis as any).launchError = String(error);
					});
			}, task);
		const completed = async (task: NonNullable<typeof a>) =>
			expect
				.poll(async () =>
					(await page.evaluate((task) => window.brigadir.readSession(task), task)).records.some(
						(record) => record.event.kind === 'turn.completed'
					)
				)
				.toBe(true);
		await start(a);
		await completed(a!);
		await start(b);
		const conflict = page.getByRole('dialog', { name: 'Repo is busy', exact: true });
		await expect(conflict).toBeVisible();
		await expect(conflict.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
		await expect(conflict).toContainText('First owner');
		expect((await page.evaluate((task) => window.brigadir.readSession(task!), b)).records).toEqual(
			[]
		);
		for (const theme of ['light', 'dark'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await conflict.screenshot({ path: info.outputPath(`conflict-${theme}.png`) });
		}
		await conflict.press('Escape');
		await expect(conflict).toHaveCount(0);
		await expect
			.poll(() => page.evaluate((id) => (globalThis as any).finished?.[id!], b?.id))
			.toBe(1);
		await start(b);
		await expect(conflict).toBeVisible();
		await conflict.getByRole('button', { name: /^Work despite the lock/ }).click();
		await completed(b!);
		await expect(conflict).toHaveCount(0);
		const row = (title: string) =>
			page
				.locator('aside')
				.getByRole('button', { name: new RegExp(title) })
				.filter({ has: page.locator('[class*=taskCopy]') });
		await writeFile(join(repo, 'file.txt'), 'shared changes\n');
		for (const task of [a!, b!])
			await page.evaluate(
				(task) => window.brigadir.sendCommand(task, { kind: 'checkpoint' }),
				task
			);
		// spec/notifications-slack-notes-and-schedules#repo-contention: no banner; the composer chip opens its popover by itself once per owner set, Esc closes it, a click reopens it.
		const mixed = page.getByRole('dialog', { name: 'Mixed changes', exact: true }),
			chip = page.locator('[data-contention-chip=composer]');
		for (const task of [a!, b!]) {
			await expect(row(task.title)).toHaveAttribute('data-status', 'done');
			await row(task.title).click();
			await expect(mixed).toBeVisible();
			await expect(mixed.locator('[data-contended-scope]')).toHaveCount(1);
			await expect(mixed).toContainText('First owner');
			await expect(mixed).toContainText('Second owner');
			await expect(mixed).toContainText('this task');
			await expect(page.getByRole('region', { name: 'Repo warnings' })).toHaveCount(0);
			await expect(chip).toHaveText('repository · mixed changes');
			await expect(mixed.getByRole('button', { name: 'Got it' })).toBeVisible();
			await page.screenshot({
				path: info.outputPath(`contention-auto-${task.title.replace(' ', '-')}.png`),
			});
			await page.keyboard.press('Escape');
			await expect(mixed).toHaveCount(0);
		}
		await chip.click();
		await expect(mixed).toBeVisible();
		await expect(mixed.getByRole('button', { name: 'Got it' })).toHaveCount(0);
		for (const theme of ['light', 'dark'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await page.waitForTimeout(400);
			await page.screenshot({ path: info.outputPath(`contention-popover-${theme}.png`) });
		}
		await page.keyboard.press('Escape');
		await expect(mixed).toHaveCount(0);
		await expect(chip).toBeFocused();
		await row('First owner').click();
		await expect(mixed).toHaveCount(0);
		await row('Second owner').click();
		await expect(mixed).toHaveCount(0);
		await openPanelTab(page, 'changes');
		await expect(page.locator('[data-contention-chip=repo]')).toHaveText('2 tasks');
		for (const theme of ['light', 'dark'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await page.waitForTimeout(400);
			await page.screenshot({ path: info.outputPath(`contention-repo-${theme}.png`) });
		}
		await page
			.getByRole('list', { name: 'Files', exact: true })
			.getByRole('button', { name: /file.txt/ })
			.click();
		await expect(page.getByRole('log', { name: 'Diff', exact: true })).toContainText(
			'shared changes'
		);
		await page.screenshot({ path: info.outputPath('contended-dark.png') });
		await start(c);
		await expect(conflict).toBeVisible();
		await conflict.getByRole('button', { name: /^Wait in queue/ }).click();
		await expect(conflict).toHaveCount(0);
		await expect(row('Waiting task')).toContainText('Waiting for the repo');
		expect((await page.evaluate((task) => window.brigadir.readSession(task!), c)).records).toEqual(
			[]
		);
		await start(d);
		await expect(conflict).toBeVisible();
		await conflict.getByRole('button', { name: /^Isolate in a worktree/ }).click();
		await completed(d!);
		const isolated = (await page.evaluate(() => window.brigadir.readWorkspace())).tasks.find(
			(task) => task.id === d!.id
		)!;
		expect(isolated.launch?.isolation).toBe('worktree');
		expect(await page.evaluate((task) => window.brigadir.readScopeLocks(task!), d)).toEqual([]);
		// A task queued for a lock must not block an independent isolated task behind it.
		expect((await page.evaluate((task) => window.brigadir.readSession(task!), c)).records).toEqual(
			[]
		);
		await page.evaluate(async (task) => {
			await window.brigadir.sendCommand(task!, { kind: 'prompt', text: 'hold' });
			await window.brigadir.sendCommand(task!, { kind: 'prompt', text: 'pending after Stop' });
		}, a);
		await choose(app, 'Stop');
		await row('First owner').click({ button: 'right' });
		await expect
			.poll(
				async () =>
					(await page.evaluate((task) => window.brigadir.readScopeLocks(task!), b))[0]?.owners
						.length
			)
			.toBe(1);
		expect(
			(await page.evaluate((task) => window.brigadir.readSession(task!), a)).records.some(
				(record) => record.event.kind === 'queue.paused'
			)
		).toBe(true);
		expect(
			(await page.evaluate((task) => window.brigadir.readSession(task!), a)).records.some(
				(record) =>
					record.event.kind === 'turn.started' && record.event.text === 'pending after Stop'
			)
		).toBe(false);
		await row('Second owner').click();
		await expect(page.locator('[data-contention-chip]')).toHaveCount(0);
		expect((await page.evaluate((task) => window.brigadir.readSession(task!), c)).records).toEqual(
			[]
		);
		// Only a fixture-owned process is killed; generation-aware pruning releases the queue.
		await page.evaluate(async (task) => {
			await window.brigadir.sendCommand(task!, { kind: 'prompt', text: 'hold' });
			await window.brigadir.sendCommand(task!, {
				kind: 'prompt',
				text: 'wait for explicit recovery',
			});
		}, b);
		const identity = JSON.parse(
			await readFile(join(data, 'projects/project/tasks', b!.id, 'host.json'), 'utf8')
		);
		expect(identity.key.id).toBe(b!.id);
		process.kill(identity.pid, 'SIGKILL');
		await completed(c!);
		await expect(row('Waiting task')).not.toContainText('Waiting for the repo');
		expect(
			(await page.evaluate((task) => window.brigadir.readSession(task!), c)).records.filter(
				(record) => record.event.kind === 'turn.started'
			)
		).toHaveLength(1);
		await start(b);
		await expect(conflict).toBeVisible();
		await conflict.getByRole('button', { name: /^Work despite the lock/ }).click();
		await expect
			.poll(
				async () =>
					(await page.evaluate((task) => window.brigadir.readSession(task!), b)).records.filter(
						(record) => record.event.kind === 'session.started'
					).length
			)
			.toBe(2);
		await row('Second owner').click();
		await showChat(page);
		await expect(page.getByRole('button', { name: 'Resume queue', exact: true })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
		expect(
			(await page.evaluate((task) => window.brigadir.readSession(task!), b)).records.some(
				(record) =>
					record.event.kind === 'turn.started' && record.event.text === 'wait for explicit recovery'
			)
		).toBe(false);
		expect(await page.evaluate(() => (globalThis as any).launchError)).toBeUndefined();
		expect(errors).toEqual([]);
	} finally {
		try {
			const page = await app.firstWindow();
			await page.evaluate(async () => {
				const conflict = await window.brigadir.readLaunchConflict();
				if (conflict) await window.brigadir.resolveLaunchConflict(conflict.id, 'cancel');
				for (const task of (await window.brigadir.readWorkspace()).tasks) {
					await window.brigadir.sendCommand(task, { kind: 'cancel' }).catch(() => {});
					await window.brigadir.sendCommand(task, { kind: 'shutdown' }).catch(() => {});
				}
			});
		} catch {}
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
