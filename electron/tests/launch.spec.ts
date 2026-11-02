import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
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
const launchIn = (root: string, extra: Record<string, string> = {}) =>
	electron.launch({
		executablePath,
		args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
		env: { ...env, BRIGADIR_DATA_DIR: join(root, 'data'), ...extra },
	});
test('launch options preserve project defaults, animate with keyboard parity, and cancel/retry an isolated workspace before starting its agent @area:tasks @smoke', async ({}, info) => {
	test.setTimeout(120000);
	const root = await mkdtemp(join(tmpdir(), 'brigadir-launch-ui-')),
		repo = join(root, 'repository'),
		data = join(root, 'data');
	await mkdir(repo);
	const git = (...args: string[]) => promisify(execFile)('git', args, { cwd: repo });
	await git('init', '-b', 'main');
	await git('config', 'user.name', 'Fixture');
	await git('config', 'user.email', 'fixture@example.invalid');
	await writeFile(join(repo, 'source.txt'), 'committed\n');
	await writeFile(join(repo, '.gitignore'), '.env\n');
	await git('add', '.');
	await git('commit', '-m', 'Initial');
	await writeFile(join(repo, '.env'), 'TOKEN=local\n');
	await writeFile(join(repo, 'source.txt'), 'author edits\n');
	const before = (await git('status', '--porcelain')).stdout;
	await mkdir(join(data, 'projects/project'), { recursive: true });
	await writeFile(
		join(data, 'projects/project/project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'repository', path: repo } })
	);
	await writeFile(
		join(data, 'settings.json'),
		JSON.stringify({ schemaVersion: 1, settings: { appearance: 'light', language: 'en' } })
	);
	const app = await launchIn(root, {
		BRIGADIR_TEST_AGENT: resolve('packages/transport/fixtures/agent.mjs'),
	});
	try {
		const page = await app.firstWindow();
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		await page.getByRole('button', { name: 'New task · repository', exact: true }).click();
		const sheet = page.getByRole('dialog', { name: 'New task', exact: true });
		// spec/tasks#sheet-model: a fresh workspace has no task to learn from, so the models come from the agent probe.
		await expect(sheet.getByRole('button', { name: 'Model', exact: true })).toBeVisible({
			timeout: 30000,
		});
		await expect(sheet.getByRole('textbox', { name: 'Task name', exact: true })).toHaveAttribute(
			'placeholder',
			'Task name (optional)'
		);
		await expect(sheet.locator('.cm-placeholder')).toHaveText('Write a message… (optional)');
		await expect(sheet.getByRole('textbox', { name: 'Message', exact: true })).toBeFocused();
		await sheet
			.getByRole('textbox', { name: 'Message', exact: true })
			.fill('Inspect the isolated workspace');
		await expect(
			sheet.getByRole('complementary', { name: 'Launch options', exact: true })
		).toBeVisible();
		await sheet.getByRole('radio', { name: 'Worktree', exact: true }).click();
		await sheet.getByRole('button', { name: 'Base ref', exact: true }).click();
		await page.getByRole('option', { name: 'main', exact: true }).click();
		const branch = sheet.getByRole('textbox', { name: 'Branch name', exact: true });
		/* spec/git#agent-branch-names: the empty field is an auto name; the task name does not fill it. */ await expect(
			branch
		).toHaveValue('');
		await expect(branch).toHaveAttribute('placeholder', 'brigadir/auto');
		const taskName = sheet.getByRole('textbox', { name: 'Task name', exact: true });
		await taskName.fill('Create custom route for VibePreview');
		await expect(branch).toHaveValue('');
		await taskName.fill('');
		await branch.fill('кирилиця');
		await expect(sheet.getByRole('button', { name: 'Start', exact: true })).toBeDisabled();
		await branch.fill('brigadir/ui-worktree');
		await sheet
			.getByRole('textbox', { name: 'Setup command', exact: true })
			.fill(
				'echo setup-started; if test ! -f attempt; then touch attempt; sleep 30; fi; echo setup-finished'
			);
		/* spec/git#worktree-env: «Copy .env» starts on, from Settings ▸ Editor ▸ Git. */ await expect(
			sheet.getByRole('switch', { name: 'Copy .env', exact: true })
		).toHaveAttribute('aria-checked', 'true');
		for (const theme of ['light', 'dark'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await page.waitForTimeout(270);
			await sheet.screenshot({ path: info.outputPath(`launch-${theme}.png`) });
		}
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await sheet.getByRole('button', { name: 'Start', exact: true }).click();
		await expect(sheet).toHaveCount(0);
		const preparation = page.getByRole('region', { name: 'Preparing workspace', exact: true });
		await expect(preparation).toBeVisible();
		await preparation.getByRole('button', { name: 'Setup log', exact: true }).click();
		await expect(preparation.getByLabel('Setup log', { exact: true })).toContainText(
			'setup-started'
		);
		await preparation.screenshot({ path: info.outputPath('preparing-dark.png') });
		await preparation.getByRole('button', { name: 'Cancel preparation', exact: true }).click();
		await expect(
			preparation.getByRole('heading', { name: 'Preparation failed', exact: true })
		).toBeVisible();
		await expect(preparation.getByRole('button', { name: 'Retry', exact: true })).toBeEnabled();
		await preparation.screenshot({ path: info.outputPath('cancelled-dark.png') });
		const task = await page.evaluate(async () => (await window.brigadir.readWorkspace()).tasks[0]!);
		expect(
			(await page.evaluate((task) => window.brigadir.readSession(task), task)).records
		).toEqual([]);
		await preparation.getByRole('button', { name: 'Retry', exact: true }).click();
		await expect(preparation).toHaveCount(0);
		await expect
			.poll(
				async () =>
					(await page.evaluate((task) => window.brigadir.readSession(task), task)).records.filter(
						(record) => record.event.kind === 'turn.completed'
					).length
			)
			.toBe(1);
		const current = await page.evaluate(
			async () => (await window.brigadir.readWorkspace()).tasks[0]!
		);
		expect(current.launch?.branch).toBe('brigadir/ui-worktree');
		expect(current.preparation?.state).toBe('ready');
		expect(current.worktreeBranch).toBe('brigadir/ui-worktree');
		const state = JSON.parse(
			await readFile(join(data, 'projects/project/tasks', task.id, 'worktree.json'), 'utf8')
		);
		expect(await readFile(join(state.root, 'source.txt'), 'utf8')).toBe('committed\n');
		expect(await readFile(join(state.root, '.env'), 'utf8')).toBe('TOKEN=local\n');
		expect((await git('status', '--porcelain')).stdout).toBe(before);
		const files = await page.evaluate((task) => window.brigadir.listFiles(task, null, false), task);
		expect(JSON.stringify(files)).toContain('source.txt');
		const log = await page.evaluate((task) => window.brigadir.readPreparationLog(task), task);
		expect(log).toContain('setup-finished');
		await page.evaluate((task) => window.brigadir.startSession(task), task);
		expect(
			(await page.evaluate(async () => (await window.brigadir.readWorkspace()).tasks[0]!)).status
		).toBe('done');
		expect(
			(await page.evaluate((task) => window.brigadir.readSession(task), task)).records.filter(
				(record) => record.event.kind === 'turn.started'
			)
		).toHaveLength(1);
		expect(await page.evaluate((task) => window.brigadir.readPreparationLog(task), task)).toBe(log);
		await page.getByRole('button', { name: 'New task · repository', exact: true }).click();
		await expect(sheet.getByRole('textbox', { name: 'Message', exact: true })).toBeFocused();
		/* spec/settings-modules-and-onboarding#settings-keys: a new task starts with the isolation from Settings ▸ Agents, not the last choice. */ await expect(
			sheet.getByRole('radio', { name: 'No isolation', exact: true })
		).toBeChecked();
		await sheet.getByRole('radio', { name: 'Worktree', exact: true }).click();
		await expect(sheet.getByRole('button', { name: 'Base ref', exact: true })).toContainText(
			'main'
		);
		await expect(branch).not.toHaveValue('brigadir/ui-worktree');
		const copyEnv = sheet.getByRole('switch', { name: 'Copy .env', exact: true });
		await expect(copyEnv).toHaveAttribute('aria-checked', 'true');
		await sheet.locator('[data-copy-env] > span').click();
		await expect(copyEnv).toHaveAttribute('aria-checked', 'false');
		/* spec/git#agent-branch-names: Start with the empty field — the agent names the branch at preparation. */ await expect(
			branch
		).toHaveValue('');
		await sheet.getByRole('textbox', { name: 'Setup command', exact: true }).fill('');
		await sheet.getByRole('textbox', { name: 'Message', exact: true }).fill('Name the route');
		await sheet.getByRole('button', { name: 'Start', exact: true }).click();
		await expect(sheet).toHaveCount(0);
		await expect
			.poll(
				async () =>
					page.evaluate(
						async () =>
							(await window.brigadir.readWorkspace()).tasks.find(
								(task) => task.prompt === 'Name the route'
							)?.worktreeBranch
					),
				{ timeout: 30000 }
			)
			.toBe('brigadir/agent-named-branch');
		expect(errors).toEqual([]);
	} finally {
		try {
			const page = await app.firstWindow();
			await page.evaluate(async () => {
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
// Was agent-launch.spec.ts: a CLI task's agent terminal starts from the task window — pending, error, retry, success.
async function cliProject(
	prefix: string,
	tasks: { id: string; provider: string; status: string }[]
) {
	const root = await mkdtemp(join(tmpdir(), `brigadir-${prefix}-`)),
		project = join(root, 'data/projects/project');
	await mkdir(project, { recursive: true });
	await writeFile(
		join(project, 'project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'repo', path: root } })
	);
	for (const { id, provider, status } of tasks) {
		await mkdir(join(project, 'tasks', id), { recursive: true });
		await writeFile(
			join(project, 'tasks', id, 'task.json'),
			JSON.stringify({
				schemaVersion: 1,
				task: {
					id,
					projectId: 'project',
					title: `CLI ${id}`,
					status,
					provider,
					transport: 'terminal',
				},
			})
		);
	}
	return { root, project };
}
test('CLI launch names the provider, restores Resume, and handles pending/error/success @area:tasks', async () => {
	const { root, project } = await cliProject('launch', [
		{ id: 'fresh', provider: 'codex', status: 'done' },
		{ id: 'saved', provider: 'claude', status: 'done' },
	]);
	await writeFile(
		join(project, 'tasks/saved/events.jsonl'),
		JSON.stringify({
			schemaVersion: 1,
			seq: 1,
			at: '2026-09-15T10:00:00Z',
			event: {
				kind: 'session.started',
				sessionId: 'fixture-session',
				modes: [],
				modeId: null,
				options: [],
			},
		}) + '\n'
	);
	const app = await launchIn(root);
	try {
		const page = await app.firstWindow(),
			errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		// Control only session startup. Its successful result creates a real shell PTY,
		// labelled as the agent terminal for the renderer; no paid provider is launched.
		await app.evaluate(({ ipcMain }) => {
			const handlers = (ipcMain as any)._invokeHandlers,
				terminal = handlers.get('terminal:command');
			let agentId: string | undefined,
				firstList = true;
			handlers.set('terminal:command', async (...args: any[]) => {
				if (args[2].kind === 'list' && firstList) {
					firstList = false;
					await new Promise<void>((_resolve, reject) => {
						(globalThis as any).failInitialLoad = () => reject(new Error('fixture list failed'));
					});
				}
				const result = await terminal(...args);
				return args[2].kind === 'list'
					? result.map((item: any) => (item.id === agentId ? { ...item, role: 'agent' } : item))
					: result;
			});
			(globalThis as any).launchCalls = 0;
			handlers.set('session:start', async (event: any, key: any) => {
				(globalThis as any).launchCalls++;
				await new Promise<void>((resolve, reject) => {
					(globalThis as any).finishLaunch = (success: boolean) =>
						success ? resolve() : reject(new Error('fixture launch failed'));
				});
				const item = await terminal(event, key, { kind: 'create', role: 'console' });
				agentId = item.id;
				return {};
			});
		});
		await page.getByRole('button', { name: /CLI fresh/ }).click();
		const stage = page.locator('[data-agent-launch]');
		// Pending: no action until the terminal list answers.
		await expect(stage).toBeVisible();
		await expect(stage.getByRole('button')).toHaveCount(0);
		await expect
			.poll(() => app.evaluate(() => typeof (globalThis as any).failInitialLoad))
			.toBe('function');
		await app.evaluate(() => (globalThis as any).failInitialLoad());
		await expect(stage.getByRole('alert')).toBeVisible();
		await stage.getByRole('button', { name: 'Retry', exact: true }).click();
		await expect(stage.getByRole('button', { name: 'Start Codex', exact: true })).toBeVisible();
		await page.getByRole('button', { name: /CLI saved/ }).click();
		// A saved session offers Resume with the task's provider.
		const resume = stage.getByRole('button', { name: 'Resume Claude Code', exact: true });
		await expect(resume).toBeVisible();
		await resume.click();
		await expect(stage.getByRole('button')).toHaveCount(0);
		expect(await app.evaluate(() => (globalThis as any).launchCalls)).toBe(1);
		await app.evaluate(() => (globalThis as any).finishLaunch(false));
		await expect(stage.getByRole('alert')).toBeVisible();
		await expect(resume).toBeVisible();
		await resume.focus();
		await resume.press('Enter');
		await expect(stage.getByRole('button')).toHaveCount(0);
		expect(await app.evaluate(() => (globalThis as any).launchCalls)).toBe(2);
		await app.evaluate(() => (globalThis as any).finishLaunch(true));
		await expect(stage).toHaveCount(0);
		const input = page.locator('.xterm-helper-textarea');
		await expect(input).toBeVisible();
		await input.focus();
		await input.fill("printf 'LAUNCH_READY\\n'");
		await input.press('Enter');
		await expect
			.poll(() =>
				page.evaluate(async () => {
					const key = { projectId: 'project', id: 'saved' },
						items = (await window.brigadir.terminalCommand(key, { kind: 'list' })) as {
							id: string;
						}[];
					return window.brigadir.terminalCommand(key, { kind: 'text', id: items[0]!.id });
				})
			)
			.toContain('LAUNCH_READY');
		// The agent exits: the stage comes back with the exit code and Resume.
		await input.fill('exit 7');
		await input.press('Enter');
		await expect(stage.getByRole('alert')).toContainText('7');
		await expect(resume).toBeVisible();
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
test('a new CLI task that main is starting shows Starting, then its agent terminal once main says it changed @area:tasks', async () => {
	const { root } = await cliProject('launch-queued', [
		{ id: 'new', provider: 'codex', status: 'queued' },
	]);
	const app = await launchIn(root);
	try {
		const page = await app.firstWindow(),
			errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		// spec/terminal-and-cli-agents#cli-start: the panel lists terminals before main's start has created the agent PTY; a shell stands in for it.
		await app.evaluate(({ ipcMain }) => {
			const handlers = (ipcMain as any)._invokeHandlers,
				terminal = handlers.get('terminal:command');
			let agentId: string | undefined;
			let lastEvent: any;
			handlers.set('terminal:command', async (...args: any[]) => {
				lastEvent = args[0];
				const result = await terminal(...args);
				return args[2].kind === 'list'
					? result.map((item: any) => (item.id === agentId ? { ...item, role: 'agent' } : item))
					: result;
			});
			(globalThis as any).createAgent = async () => {
				const item = await terminal(
					lastEvent,
					{ projectId: 'project', id: 'new' },
					{ kind: 'create', role: 'console' }
				);
				agentId = item.id;
			};
		});
		await page.getByRole('button', { name: /CLI new/ }).click();
		const stage = page.locator('[data-agent-launch]');
		await expect(stage).toBeVisible();
		await expect(stage.getByRole('button')).toHaveCount(0);
		await app.evaluate(async ({ BrowserWindow }) => {
			const window = BrowserWindow.getAllWindows()[0]!;
			await (globalThis as any).createAgent();
			window.webContents.send('session:event', {
				key: { projectId: 'project', id: 'new' },
				record: null,
			});
		});
		await expect(stage).toHaveCount(0);
		await expect(page.locator('.xterm-helper-textarea')).toBeVisible();
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
