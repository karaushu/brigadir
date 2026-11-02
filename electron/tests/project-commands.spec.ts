import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
const desktop = resolve('apps/desktop'),
	executablePath = createRequire(join(desktop, 'package.json'))('electron') as string;
const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
// spec/search-menus-and-commands#project-commands: the toolbar button, its menu, the console tab of a command, the editor and the Commands tab of Search Everywhere.
test('project commands run from the toolbar and Search Everywhere as console tabs @area:browser', async ({}, info) => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-commands-ui-'));
	const repo = join(root, 'repo');
	await mkdir(join(repo, 'apps', 'admin'), { recursive: true });
	const server = join(root, 'server.cjs');
	await writeFile(
		server,
		"process.stdout.write('  VITE ready\\r\\n  Local: http://localhost:5173/\\r\\n');process.stdout.write('cwd='+process.cwd()+'\\r\\n');setInterval(()=>{},1000);"
	);
	const taskDir = join(root, 'data/projects/project/tasks/task');
	await mkdir(taskDir, { recursive: true });
	const commands = [
		{
			id: 'admin',
			name: 'Admin dev',
			command: `${quote(process.execPath)} ${quote(server)}`,
			repo: 'apps/admin',
			directory: '',
		},
		{
			id: 'check',
			name: 'Typecheck',
			command: 'echo "error TS2322"; exit 2',
			repo: '',
			directory: '',
		},
	];
	await writeFile(
		join(taskDir, '../../project.json'),
		JSON.stringify({
			schemaVersion: 1,
			project: { id: 'project', name: 'repo', path: repo, commands },
		})
	);
	await writeFile(
		join(taskDir, 'task.json'),
		JSON.stringify({
			schemaVersion: 1,
			task: {
				id: 'task',
				projectId: 'project',
				title: 'Commands fixture',
				status: 'done',
				provider: 'claude',
			},
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
		env: {
			...env,
			HOME: root,
			ZDOTDIR: root,
			SHELL: '/bin/zsh',
			BRIGADIR_DATA_DIR: join(root, 'data'),
			BRIGADIR_TEST_AGENT: resolve('packages/transport/fixtures/agent.mjs'),
		},
	});
	const key = { projectId: 'project', id: 'task' };
	try {
		const page = await app.firstWindow();
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		await page.getByRole('button', { name: /Commands fixture/ }).click();
		const toolbar = page
			.getByRole('banner', { name: 'View' })
			.or(page.locator('header[aria-label="View"]'));
		const current = toolbar.getByRole('button', { name: /^Project commands · Admin dev/ });
		await expect(current).toBeVisible();
		// Reading the command tabs never starts a host for the task.
		expect(await page.evaluate((key) => window.brigadir.readCommandRuns(key), key)).toEqual([]);
		await page.screenshot({ animations: 'disabled', path: info.outputPath('toolbar-idle.png') });
		await current.click();
		const menu = page.getByRole('dialog', { name: 'Project commands' });
		await expect(menu).toBeVisible();
		await expect(menu.locator('[data-command-row]')).toHaveCount(2);
		await page.screenshot({ animations: 'disabled', path: info.outputPath('menu.png') });
		await menu.getByRole('button', { name: 'Run Admin dev', exact: true }).click();
		await expect
			.poll(
				async () =>
					(await page.evaluate((key) => window.brigadir.readCommandRuns(key), key))[0]?.run?.port
			)
			.toBe(5173);
		await expect(menu.locator('[data-command-row="admin"]')).toHaveAttribute(
			'data-state',
			'running'
		);
		await expect(menu.getByRole('button', { name: ':5173', exact: true })).toBeVisible();
		await menu.getByRole('button', { name: 'Close', exact: true }).click();
		await expect(menu).toHaveCount(0);
		await expect(
			toolbar.getByRole('button', { name: 'Stop Admin dev', exact: true })
		).toBeVisible();
		// The row opens its tab: cwd is the repo of the command inside the task tree.
		await current.click();
		await menu.locator('[data-command-row="admin"] button').first().click();
		await expect(menu).toHaveCount(0);
		const consoleTab = page.getByRole('tab', { name: 'Admin dev', exact: true });
		await expect(consoleTab).toBeVisible();
		const runs = await page.evaluate((key) => window.brigadir.readCommandRuns(key), key);
		await expect
			.poll(() =>
				page.evaluate(({ key, id }) => window.brigadir.terminalCommand(key, { kind: 'text', id }), {
					key,
					id: runs[0]!.id,
				})
			)
			.toContain('/repo/apps/admin');
		await page.screenshot({ animations: 'disabled', path: info.outputPath('console-running.png') });
		// Stop from the toolbar leaves the output and offers Run again.
		await toolbar.getByRole('button', { name: 'Stop Admin dev', exact: true }).click();
		await expect(page.getByRole('status').filter({ hasText: 'Stopped manually' })).toBeVisible();
		await expect(toolbar.getByRole('button', { name: 'Run Admin dev', exact: true })).toBeVisible();
		// Search Everywhere, Commands tab: a failing command gets the failure strip.
		await expect
			.poll(() =>
				app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('commands')!.enabled)
			)
			.toBe(true);
		await app.evaluate(({ Menu }) =>
			Menu.getApplicationMenu()!.getMenuItemById('commands')!.click()
		);
		const search = page.getByRole('dialog', { name: 'Search Everywhere' });
		await expect(search).toBeVisible();
		await expect(search.getByRole('listbox', { name: 'Commands' })).toBeVisible();
		await search.getByRole('combobox').fill('type');
		await expect(search.getByRole('option', { name: /Typecheck/ })).toBeVisible();
		await expect(search.getByRole('option', { name: /Run once/ })).toBeVisible();
		await page.screenshot({ animations: 'disabled', path: info.outputPath('search-commands.png') });
		await search.getByRole('combobox').press('Enter');
		await expect(search).toHaveCount(0);
		await expect(page.getByRole('status').filter({ hasText: 'Exit 2 · Typecheck' })).toBeVisible();
		await expect(
			toolbar.getByRole('button', { name: /^Project commands · Typecheck · failed/ })
		).toBeVisible();
		// spec/task-window-workspace#work-area: the command tabs are tabs of the bottom group, beside a shell from Tools.
		await page.locator('[data-tools-button]').click();
		await page.getByRole('menuitem', { name: /New terminal/ }).click();
		await page.getByRole('tab', { name: 'Typecheck', exact: true }).click();
		await toolbar.getByRole('button', { name: /^Project commands/ }).click();
		await menu.getByRole('button', { name: 'Run Admin dev', exact: true }).click();
		await menu.getByRole('button', { name: 'Close', exact: true }).click();
		await expect
			.poll(
				async () =>
					(await page.evaluate((key) => window.brigadir.readCommandRuns(key), key)).find(
						(run) => run.run?.commandId === 'admin'
					)?.run?.port
			)
			.toBe(5173);
		await page.getByRole('tab', { name: 'Admin dev', exact: true }).click();
		await page
			.locator('[data-editor-group]:has([data-tool=terminal]) [role=tablist]')
			.first()
			.screenshot({ animations: 'disabled', path: info.outputPath('console-strip.png') });
		await page.screenshot({ animations: 'disabled', path: info.outputPath('console-failed.png') });
		// New command through the editor, saved to project.json with sorted keys.
		await toolbar.getByRole('button', { name: /^Project commands/ }).click();
		await menu.getByRole('button', { name: 'New command…' }).click();
		const editor = page.getByRole('dialog', { name: 'New command' });
		await expect(editor).toBeVisible();
		await editor.getByLabel('Name').fill('Seed DB');
		await editor.getByLabel('Command').fill('echo seeded');
		// spec/search-menus-and-commands#agent-command-tools: the agents' mark is set where the command is made.
		const agents = editor.getByRole('checkbox', { name: 'Agents can run it without confirmation' });
		await expect(agents).not.toBeChecked();
		await agents.check();
		await page.screenshot({ animations: 'disabled', path: info.outputPath('editor.png') });
		await editor.getByRole('button', { name: 'Save', exact: true }).click();
		await expect(editor).toHaveCount(0);
		const saved = JSON.parse(
			await readFile(join(root, 'data/projects/project/project.json'), 'utf8')
		);
		expect(saved.project.commands.map((command: { name: string }) => command.name)).toEqual([
			'Admin dev',
			'Typecheck',
			'Seed DB',
		]);
		expect(
			saved.project.commands.map((command: { agentRuns?: boolean }) => command.agentRuns)
		).toEqual([undefined, undefined, true]);
		expect(errors).toEqual([]);
	} finally {
		try {
			await (
				await app.firstWindow()
			).evaluate((key) => window.brigadir.sendCommand(key, { kind: 'shutdown' }), key);
		} catch {}
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
