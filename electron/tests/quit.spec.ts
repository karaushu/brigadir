import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
const desktop = resolve('apps/desktop'),
	executablePath = createRequire(join(desktop, 'package.json'))('electron') as string;
async function launch(prefix: string) {
	const root = await mkdtemp(join(tmpdir(), prefix)),
		repo = join(root, 'repo'),
		data = join(root, 'data'),
		dir = join(data, 'projects/project/tasks/task');
	await mkdir(repo);
	await mkdir(dir, { recursive: true });
	await writeFile(
		join(dir, '../../project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'repository', path: repo } })
	);
	await writeFile(
		join(dir, 'task.json'),
		JSON.stringify({
			schemaVersion: 1,
			task: {
				id: 'task',
				projectId: 'project',
				title: 'Quit fixture',
				status: 'done',
				provider: 'claude',
			},
		})
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
			HOME: root,
			ZDOTDIR: root,
			SHELL: '/bin/zsh',
			BRIGADIR_DATA_DIR: data,
			BRIGADIR_TEST_IDLE_MS: '1500',
			BRIGADIR_TEST_AGENT: resolve('packages/transport/fixtures/agent.mjs'),
		},
	});
	const log: string[] = [];
	for (const stream of [app.process().stderr, app.process().stdout])
		stream?.on('data', (chunk) => log.push(String(chunk)));
	return { root, app, log };
}
/** Hosts outlive the app by design; one whose data dir is removed never stops for idleness, so the test stops it first. */
async function cleanup(root: string) {
	try {
		const { pid } = JSON.parse(
			await readFile(join(root, 'data/projects/project/tasks/task/host.json'), 'utf8')
		) as { pid: number };
		process.kill(pid, 'SIGTERM');
		await expect
			.poll(
				() => {
					try {
						process.kill(pid, 0);
						return true;
					} catch {
						return false;
					}
				},
				{ timeout: 15000 }
			)
			.toBe(false);
	} catch (error) {
		if (!(error instanceof Error && /ENOENT|ESRCH/.test(error.message))) throw error;
	}
	await rm(root, { recursive: true, force: true });
}
/** Streams one turn and opens a console, so a host, its client and a PTY exist before the quit. */
async function use(app: ElectronApplication) {
	const page = await app.firstWindow();
	await page.getByRole('button', { name: /Quit fixture/ }).click();
	await page.getByRole('button', { name: 'Start', exact: true }).click();
	const message = page.getByRole('textbox', { name: 'Message', exact: true });
	await expect(message).toHaveAttribute('aria-busy', 'false');
	await message.fill('hello');
	await message.press('Enter');
	await expect(page.getByRole('log', { name: 'Conversation' })).toContainText('world');
	// spec/task-window-workspace#work-area: a terminal tab of the work area, from ⇧⌘Y.
	await app.evaluate(({ Menu }) =>
		Menu.getApplicationMenu()!
			.items.find((item) => item.label === 'View')!
			.submenu!.items.find((item) => item.label === 'Terminal')!
			.click()
	);
	await expect(page.locator('.xterm')).toHaveCount(1);
	await message.fill('draft still being typed');
}
/** Measures until the main process exits; a stalled quit is killed at `limit` so the assertion can report it. */
async function quit(app: ElectronApplication, how: 'SIGTERM' | 'app.quit', limit = 15000) {
	const child = app.process(),
		started = Date.now(),
		exited = new Promise<number>((resolve) =>
			child.once('exit', () => resolve(Date.now() - started))
		);
	if (how === 'SIGTERM') child.kill('SIGTERM');
	else void app.evaluate(({ app }) => app.quit()).catch(() => {});
	const timer = setTimeout(() => child.kill('SIGKILL'), limit);
	try {
		return await exited;
	} finally {
		clearTimeout(timer);
	}
}
for (const how of ['SIGTERM', 'app.quit'] as const) {
	test(`${how} quits after streaming with a console open @area:shell`, async () => {
		test.setTimeout(60000);
		const { root, app, log } = await launch('brigadir-quit-');
		try {
			await use(app);
			const elapsed = await quit(app, how);
			expect(log.join('')).not.toContain('[quit]');
			expect(elapsed, log.join('')).toBeLessThan(5000);
		} finally {
			await cleanup(root);
		}
	});
	// spec/architecture-and-platform#exit: with no live host the reopened window's consoles close within microtasks, still inside the cancelled `close`
	// event, where Electron ignores app.quit(); the process then lived on with its window after SIGTERM.
	test(`${how} quits from a window reopened after its host stopped for idleness @area:shell`, async () => {
		test.setTimeout(60000);
		const { root, app, log } = await launch('brigadir-quit-reopen-');
		try {
			await use(app);
			await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
			await expect
				.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length))
				.toBe(0);
			await new Promise((resolve) => setTimeout(resolve, 3000)); // the unselected host stops after BRIGADIR_TEST_IDLE_MS
			const reopened = app.waitForEvent('window');
			await app.evaluate(({ app }) => app.emit('activate'));
			const page = await reopened;
			await expect(page.getByRole('button', { name: /Quit fixture/ })).toBeVisible();
			const elapsed = await quit(app, how);
			expect(log.join('')).not.toContain('[quit]');
			expect(elapsed, log.join('')).toBeLessThan(5000);
		} finally {
			await cleanup(root);
		}
	});
}
