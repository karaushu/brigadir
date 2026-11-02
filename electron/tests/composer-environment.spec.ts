import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const desktop = resolve('apps/desktop'),
	executablePath = createRequire(join(desktop, 'package.json'))('electron') as string,
	env = Object.fromEntries(
		Object.entries(process.env).filter(
			(entry): entry is [string, string] =>
				typeof entry[1] === 'string' && entry[0] !== 'ELECTRON_RUN_AS_NODE'
		)
	);
const launchApp = (root: string, data: string) =>
	electron.launch({
		executablePath,
		args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
		env: {
			...env,
			BRIGADIR_DATA_DIR: data,
			BRIGADIR_TEST_AGENT: resolve('packages/transport/fixtures/agent.mjs'),
		},
	});
// spec/composer#island, spec/composer#capsule-squeeze: the composer's environment is the island's footer — no isolation or worktree, branch, `+N −M`, base, and the task's repos on click.
test('composer shows where the agent writes: isolation, branch, changes and the task repos @area:chat', async ({}, info) => {
	test.setTimeout(90000);
	const root = await mkdtemp(join(tmpdir(), 'brigadir-composer-environment-')),
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
					name: id === 'project' ? 'In-place project' : 'Worktree project',
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
				title: 'In-place task',
				provider: 'claude',
				status: 'done',
			},
		})
	);
	await writeFile(
		join(data, 'settings.json'),
		JSON.stringify({ schemaVersion: 1, settings: { language: 'en', appearance: 'light' } })
	);
	const app = await launchApp(root, data);
	try {
		const page = await app.firstWindow(),
			errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		const key = { projectId: 'project', id: 'active' };
		await page.getByRole('button', { name: /In-place task/ }).click();
		await page.evaluate(async (key) => {
			await window.brigadir.startSession(key);
		}, key);
		const composer = page.locator('form:has([aria-label=Message][role=textbox])'),
			pill = composer.getByRole('button', { name: 'No isolation · main', exact: true });
		await expect(pill).toBeVisible();
		const capsule = composer.locator('[data-composer-environment]');
		await expect(capsule).toHaveAttribute('data-isolation', 'in-place');
		await expect(pill.locator('[data-glyph=sidebar-branch]')).toHaveCount(1);
		await expect(pill.locator('[data-composer-counts]')).toHaveCount(0);
		await writeFile(join(root, 'project/file.txt'), 'after\nnew\n');
		await page.evaluate((key) => window.brigadir.sendCommand(key, { kind: 'checkpoint' }), key);
		await expect(pill.locator('[data-composer-counts]')).toHaveText('+2 −1');
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
						branch: 'brigadir/composer-branch',
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
		await page.locator(`[data-sidebar-task="${worktree.id}"]`).click();
		const isolated = composer.getByRole('button', {
			name: 'Worktree · brigadir/composer-branch',
			exact: true,
		});
		await expect(capsule).toHaveAttribute('data-isolation', 'worktree');
		await expect(isolated).toContainText('from main');
		await expect(isolated.locator('[data-glyph=sidebar-worktree]')).toHaveCount(1);
		await isolated.click();
		const repos = page.getByRole('dialog', { name: 'Task repos', exact: true });
		await expect(repos).toBeVisible();
		await expect(repos.getByRole('listitem')).toHaveCount(1);
		await expect(repos.getByRole('listitem')).toContainText('brigadir/composer-branch');
		await expect(repos.getByRole('listitem')).toContainText('Worktree project');
		for (const theme of ['light', 'dark'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await page.screenshot({
				path: info.outputPath(`composer-environment-${theme}.png`),
				animations: 'disabled',
			});
		}
		await page.keyboard.press('Escape');
		await expect(repos).toHaveCount(0);
		await expect(isolated).toBeFocused();
		await isolated.click();
		await expect(repos).toBeVisible();
		await repos.getByRole('button', { name: 'Close', exact: true }).click();
		await expect(repos).toHaveCount(0);
		await expect(isolated).toBeFocused();
		// spec/composer#capsule-squeeze: no chevron — the footer does not fold, and switching tasks keeps it whole.
		await expect(composer.getByRole('button', { name: /environment/i })).toHaveCount(0);
		await expect(isolated).toContainText('from main');
		await page.locator('[data-sidebar-task="active"]').click();
		await expect(pill).toBeVisible();
		await expect(pill.locator('[data-composer-counts]')).toHaveText('+2 −1');
		expect(
			await page.evaluate(async () => Object.keys(await window.brigadir.readSurfaceLayout()))
		).not.toContain('composerEnvironmentCollapsed');
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
// spec/notifications-slack-notes-and-schedules#notice-chips: a repo of the task that left the disk is a chip in the composer (its popover opens by itself once), not a hint
// under the Changes list.
test('an unavailable repo is a composer chip whose popover opens once; no hint under the Changes list @area:chat', async ({}, info) => {
	test.setTimeout(60000);
	const root = await mkdtemp(join(tmpdir(), 'brigadir-notice-chips-')),
		repo = join(root, 'repository'),
		data = join(root, 'data'),
		kit = join(repo, 'kit');
	const git = (path: string, ...args: string[]) => promisify(execFile)('git', args, { cwd: path });
	for (const path of [repo, kit]) {
		await mkdir(path, { recursive: true });
		await git(path, 'init', '-b', 'main');
		await git(path, 'config', 'user.name', 'Fixture');
		await git(path, 'config', 'user.email', 'fixture@example.invalid');
		await writeFile(join(path, 'read.txt'), 'baseline\n');
		await writeFile(join(path, '.gitignore'), 'kit/\n');
		await git(path, 'add', '.');
		await git(path, 'commit', '-m', 'Initial');
	}
	await mkdir(join(data, 'projects/project'), { recursive: true });
	await writeFile(
		join(data, 'projects/project/project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'repository', path: repo } })
	);
	await writeFile(
		join(data, 'settings.json'),
		JSON.stringify({ schemaVersion: 1, settings: { appearance: 'dark', language: 'en' } })
	);
	const app = await launchApp(root, data);
	try {
		const page = await app.firstWindow(),
			errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		const task = await page.evaluate(async () => {
			const launch = {
				...(await window.brigadir.readLaunchSettings('project')),
				branch: '',
				isolation: 'in-place' as const,
			};
			launch.scopes = launch.scopes.map((scope) => ({ ...scope, selected: true }));
			const task = await window.brigadir.createTask(
				'project',
				'Unavailable repo',
				'claude',
				'gui',
				false,
				launch
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
		await page
			.locator('aside')
			.getByRole('button', { name: /Unavailable repo/ })
			.filter({ has: page.locator('[class*=taskCopy]') })
			.click();
		const chip = page.locator('[data-unavailable-chip="composer"]'),
			popover = page.getByRole('dialog', { name: 'Unavailable repos', exact: true });
		await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
		await expect(chip).toHaveCount(0);
		await rm(kit, { recursive: true, force: true });
		await page.evaluate((task) => window.brigadir.sendCommand(task, { kind: 'checkpoint' }), task);
		await expect(chip).toContainText('kit', { timeout: 15000 });
		await expect(popover).toHaveAttribute('data-notice-popover', 'auto');
		await expect(popover.locator('[data-unavailable-scope="kit"]')).toBeVisible();
		for (const theme of ['dark', 'light'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await page.screenshot({ path: info.outputPath(`unavailable-${theme}.png`) });
		}
		await popover.getByRole('button', { name: 'Got it', exact: true }).click();
		await expect(popover).toHaveCount(0);
		// The same fact does not open it again; a click does, Esc gives the focus back to the chip.
		await page.evaluate((task) => window.brigadir.sendCommand(task, { kind: 'checkpoint' }), task);
		await page.waitForTimeout(500);
		await expect(popover).toHaveCount(0);
		await chip.click();
		await expect(popover).toHaveAttribute('data-notice-popover', 'click');
		await page.keyboard.press('Escape');
		await expect(chip).toBeFocused();
		expect(errors).toEqual([]);
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
