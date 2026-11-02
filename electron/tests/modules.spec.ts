import {
	_electron as electron,
	expect,
	test,
	type ElectronApplication,
	type Page,
} from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { openRepos, repoPRs, repoRow } from './repos';
import { launchPRFixture } from './pr-fixture';
const desktop = resolve('apps/desktop'),
	executablePath = createRequire(join(desktop, 'package.json'))('electron') as string;
const env = Object.fromEntries(
	Object.entries(process.env).filter(
		(entry): entry is [string, string] =>
			typeof entry[1] === 'string' && entry[0] !== 'ELECTRON_RUN_AS_NODE'
	)
);
const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
const menuItem = (app: ElectronApplication, id: string) =>
	app.evaluate(({ Menu }, id) => Boolean(Menu.getApplicationMenu()!.getMenuItemById(id)), id);
async function toggleModule(app: ElectronApplication, page: Page, name: string, on: boolean) {
	await expect
		.poll(() =>
			app.evaluate(
				({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('settings')?.enabled ?? false
			)
		)
		.toBe(true);
	await app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('settings')!.click());
	const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
	await dialog.getByRole('tab', { name: 'Modules', exact: true }).click();
	const toggle = dialog
		.getByRole('group', { name: 'Modules', exact: true })
		.getByRole('switch', { name, exact: true });
	if ((await toggle.isChecked()) !== on) await toggle.click();
	if (on) await expect(toggle).toBeChecked();
	else await expect(toggle).not.toBeChecked();
	await page.keyboard.press('Escape');
	await expect(dialog).toBeHidden();
}
// spec/task-window-workspace#work-area: the browser is a tab of the work area, under the toolbar; spec/settings-modules-and-onboarding#modules: a module switched off in Settings ▸ Modules
// takes its Tools item, tabs, menu and shortcut with it, and a switch back returns them.
test('the browser tab sits in the work area and the browser module switches off whole @area:settings', async ({}, info) => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-modules-')),
		repo = join(root, 'repo'),
		data = join(root, 'data');
	await mkdir(repo);
	const taskDir = join(data, 'projects/project/tasks/task');
	await mkdir(taskDir, { recursive: true });
	await writeFile(
		join(taskDir, '../../project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'repo', path: repo } })
	);
	await writeFile(
		join(taskDir, 'task.json'),
		JSON.stringify({
			schemaVersion: 1,
			task: {
				id: 'task',
				projectId: 'project',
				title: 'Modules fixture',
				status: 'done',
				provider: 'claude',
				transport: 'gui',
			},
		})
	);
	await writeFile(
		join(data, 'settings.json'),
		JSON.stringify({ schemaVersion: 1, settings: { appearance: 'light', language: 'en' } })
	);
	const app = await electron.launch({
		executablePath,
		args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
		env: { ...env, BRIGADIR_DATA_DIR: data },
	});
	try {
		const page = await app.firstWindow();
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1440, 900));
		const action = async (id: string) => {
			await expect
				.poll(() =>
					app.evaluate(
						({ Menu }, id) => Menu.getApplicationMenu()!.getMenuItemById(id)?.enabled ?? false,
						id
					)
				)
				.toBe(true);
			await app.evaluate(
				({ Menu }, id) => Menu.getApplicationMenu()!.getMenuItemById(id)!.click(),
				id
			);
		};
		const menuLabels = () =>
			app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.items.map((item) => item.label));
		await page.getByRole('button', { name: /Modules fixture/ }).click();
		const toolbar = page.locator('header[aria-label="View"]');
		const newBrowser = async () => {
			await toolbar.locator('[data-tools-button]').click();
			const item = page.getByRole('menuitem', { name: /New browser/ });
			const present = (await item.count()) > 0;
			await page.keyboard.press('Escape');
			return present;
		};
		await action('browser');
		const panel = page.getByRole('region', { name: 'Browser', exact: true });
		await expect(panel).toBeVisible();
		expect(await newBrowser()).toBe(true);
		await page.screenshot({
			animations: 'disabled',
			path: info.outputPath('browser-tab.png'),
		});
		expect(await menuLabels()).toContain('Browser');
		await action('settings');
		const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
		await dialog.getByRole('tab', { name: 'Modules', exact: true }).click();
		const modules = dialog.getByRole('group', { name: 'Modules', exact: true });
		const browserSwitch = modules.getByRole('switch', { name: 'Browser', exact: true }),
			simulatorSwitch = modules.getByRole('switch', { name: 'Simulator', exact: true });
		await expect(browserSwitch).toBeChecked();
		await expect(simulatorSwitch).not.toBeChecked();
		await modules.scrollIntoViewIfNeeded();
		await expect(modules.getByText(/Xcode|Android SDK/)).toBeVisible();
		await dialog.screenshot({
			animations: 'disabled',
			path: info.outputPath('settings-modules.png'),
		});
		await browserSwitch.click();
		await expect(browserSwitch).not.toBeChecked();
		await expect
			.poll(
				async () => JSON.parse(await readFile(join(data, 'settings.json'), 'utf8')).settings.modules
			)
			.toEqual({
				browser: false,
				simulator: false,
				pullRequests: true,
				commands: true,
				remoteAccess: true,
				notes: true,
				schedules: true,
			});
		await page.keyboard.press('Escape');
		await expect(dialog).toBeHidden();
		await expect(panel).toHaveCount(0);
		await expect(page.locator('[data-tool=browser]')).toHaveCount(0);
		expect(await newBrowser()).toBe(false);
		expect(
			await app.evaluate(
				({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.contentView.children.length
			)
		).toBe(0);
		await expect.poll(menuLabels).not.toContain('Browser');
		expect(
			await app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('browser'))
		).toBeNull();
		await action('settings');
		await dialog.getByRole('tab', { name: 'Modules', exact: true }).click();
		await browserSwitch.click();
		await expect(browserSwitch).toBeChecked();
		await page.keyboard.press('Escape');
		expect(await newBrowser()).toBe(true);
		await expect(page.locator('[data-tool=browser]')).toHaveCount(1);
		await page.locator('[data-tool=browser] [role=tab]').click();
		await expect(panel).toBeVisible();
		await expect.poll(menuLabels).toContain('Browser');
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
// spec/settings-modules-and-onboarding#module-off: Pull requests switch off whole — repo counters, the PR segment, the View item, the Overview tab and GitHub reads.
test('the pull requests module switches off whole and comes back (spec/settings-modules-and-onboarding#module-off) @area:settings', async ({}, info) => {
	test.setTimeout(120000);
	const { app, page, errors } = await launchPRFixture();
	try {
		// spec/appearance#evolution-redesign: the repo counters are in the header's «Repos k/n» popover.
		const segment = page.locator('[data-panel-tab=prs]');
		await repoPRs(page, 'apps/admin');
		await page.locator('[data-pr-row="421"]').click();
		await page.getByRole('button', { name: 'Overview', exact: true }).click();
		const overview = page.getByRole('tab', { name: 'Overview · #421', exact: true });
		await expect(overview).toBeVisible();
		expect(await menuItem(app, 'pull-requests')).toBe(true);
		await toggleModule(app, page, 'Pull requests', false);
		await expect((await openRepos(page)).locator('[data-repo-prs]')).toHaveCount(0);
		await page.keyboard.press('Escape');
		await expect(segment).toHaveCount(0);
		await expect(overview).toHaveCount(0);
		await expect(page.locator('[data-panel-tab=changes]')).toHaveAttribute('aria-selected', 'true');
		await expect.poll(() => menuItem(app, 'pull-requests')).toBe(false);
		await expect(
			page.evaluate(() => window.brigadir.readPullRequests('project', null, true))
		).rejects.toThrow();
		await page.screenshot({
			animations: 'disabled',
			path: info.outputPath('pull-requests-off.png'),
		});
		await toggleModule(app, page, 'Pull requests', true);
		await expect((await repoRow(page, 'apps/admin')).locator('[data-repo-prs]')).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(segment).toHaveAttribute('aria-selected', 'true');
		await expect.poll(() => menuItem(app, 'pull-requests')).toBe(true);
		expect(errors).toEqual([]);
	} finally {
		await app.close();
	}
});
// spec/settings-modules-and-onboarding#module-off: Commands switch off whole — toolbar button, Search Everywhere tab, File items; live commands stop, tabs keep the output.
test('the commands module switches off whole and stops live commands (spec/settings-modules-and-onboarding#module-off) @area:settings', async ({}, info) => {
	test.setTimeout(120000);
	const root = await mkdtemp(join(tmpdir(), 'brigadir-commands-module-'));
	const repo = join(root, 'repo');
	await mkdir(repo, { recursive: true });
	const server = join(root, 'server.cjs');
	await writeFile(
		server,
		"process.stdout.write('  Local: http://localhost:5174/\\r\\n');setInterval(()=>{},1000);"
	);
	const taskDir = join(root, 'data/projects/project/tasks/task');
	await mkdir(taskDir, { recursive: true });
	await writeFile(
		join(taskDir, '../../project.json'),
		JSON.stringify({
			schemaVersion: 1,
			project: {
				id: 'project',
				name: 'repo',
				path: repo,
				commands: [
					{
						id: 'admin',
						name: 'Admin dev',
						command: `${quote(process.execPath)} ${quote(server)}`,
						repo: '',
						directory: '',
					},
				],
			},
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
	const data = join(root, 'data');
	await writeFile(
		join(data, 'settings.json'),
		JSON.stringify({
			schemaVersion: 1,
			settings: {
				appearance: 'light',
				language: 'en',
				modules: { browser: true, simulator: false },
			},
		})
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
			BRIGADIR_TEST_AGENT: resolve('packages/transport/fixtures/agent.mjs'),
		},
	});
	const key = { projectId: 'project', id: 'task' };
	try {
		const page = await app.firstWindow();
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		await page.getByRole('button', { name: /Commands fixture/ }).click();
		const toolbar = page.locator('header[aria-label="View"]'),
			current = toolbar.getByRole('button', { name: /^Project commands · Admin dev/ });
		await expect(current).toBeVisible();
		await toolbar.getByRole('button', { name: 'Run Admin dev', exact: true }).click();
		await expect
			.poll(
				async () =>
					(await page.evaluate((key) => window.brigadir.readCommandRuns(key), key))[0]?.run?.port
			)
			.toBe(5174);
		// A settings file from before spec/settings-modules-and-onboarding#module-off reads with both new modules on.
		await toggleModule(app, page, 'Commands', false);
		await expect
			.poll(
				async () => JSON.parse(await readFile(join(data, 'settings.json'), 'utf8')).settings.modules
			)
			.toEqual({
				browser: true,
				simulator: false,
				pullRequests: true,
				commands: false,
				remoteAccess: true,
				notes: true,
				schedules: true,
			});
		await expect(current).toHaveCount(0);
		for (const id of ['commands', 'command-run', 'command-stop', 'command-new'])
			await expect.poll(() => menuItem(app, id)).toBe(false);
		// The live command stopped as Stop does; its tab keeps the output and has no Run again.
		await expect
			.poll(
				async () =>
					(await page.evaluate((key) => window.brigadir.readCommandRuns(key), key))[0]?.exited
			)
			.toBe(true);
		await expect(
			page.evaluate((key) => window.brigadir.runProjectCommand(key, { commandId: 'admin' }), key)
		).rejects.toThrow();
		await app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('search')!.click());
		const search = page.getByRole('dialog', { name: 'Search Everywhere' });
		await expect(search).toBeVisible();
		await expect(search.getByRole('tab', { name: 'Files', exact: true })).toBeVisible();
		await expect(search.getByRole('tab', { name: 'Commands', exact: true })).toHaveCount(0);
		await page.keyboard.press('Escape');
		await page.screenshot({ animations: 'disabled', path: info.outputPath('commands-off.png') });
		await toggleModule(app, page, 'Commands', true);
		await expect(current).toBeVisible();
		await expect.poll(() => menuItem(app, 'commands')).toBe(true);
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
