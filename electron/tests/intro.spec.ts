import { settle } from './settle';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const desktop = resolve('apps/desktop'),
	executablePath =
		process.env.BRIGADIR_TEST_EXECUTABLE ??
		(createRequire(join(desktop, 'package.json'))('electron') as string);
const env = Object.fromEntries(
	Object.entries(process.env).filter(
		(e): e is [string, string] =>
			typeof e[1] === 'string' &&
			e[0] !== 'ELECTRON_RUN_AS_NODE' &&
			e[0] !== 'BRIGADIR_CHROME_PLATFORM'
	)
);
const launchIn = (root: string, extra: Record<string, string>) =>
	electron.launch({
		executablePath,
		args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
		env: { ...env, BRIGADIR_DATA_DIR: join(root, 'data'), ...extra },
	});
const clickMenu = async (app: ElectronApplication, id: string) => {
	await expect
		.poll(() =>
			app.evaluate(({ Menu }, id) => Menu.getApplicationMenu()!.getMenuItemById(id)!.enabled, id)
		)
		.toBe(true);
	await app.evaluate(({ Menu }, id) => Menu.getApplicationMenu()!.getMenuItemById(id)!.click(), id);
};
const environment = (claude: boolean) =>
	JSON.stringify({
		agents: [
			{
				provider: 'claude',
				found: claude,
				via: claude ? 'cache' : null,
				version: claude ? '2.1.0' : null,
				signIn: claude ? 'signed-in' : 'unknown',
			},
			{
				provider: 'codex',
				found: claude,
				via: claude ? 'npx' : null,
				version: null,
				signIn: claude ? 'signed-in' : 'unknown',
			},
		],
		git: { found: true, version: '2.50.1' },
		gh: { auth: 'missing', version: null },
	});
// spec/settings-modules-and-onboarding#intro: the intro opens on the first start, writes every choice to the settings, adds the first project and does not come back.
test('the intro runs on the first start, saves its choices, adds the first project and reopens from the menu @area:settings', async ({}, info) => {
	test.setTimeout(120000);
	const root = await mkdtemp(join(tmpdir(), 'brigadir-intro-')),
		data = join(root, 'data'),
		repo = join(root, 'choice'),
		settingsFile = join(data, 'settings.json');
	await mkdir(repo);
	const git = (...args: string[]) => promisify(execFile)('git', args, { cwd: repo });
	await git('init', '-q', '-b', 'main');
	await git('config', 'user.name', 'F');
	await git('config', 'user.email', 'f@localhost');
	await writeFile(join(repo, 'a.ts'), 'x\n');
	await git('add', '.');
	await git('commit', '-qm', 'Base');
	const launch = (claude = true) =>
		launchIn(root, { BRIGADIR_SKIP_INTRO: '0', BRIGADIR_TEST_ENVIRONMENT: environment(claude) });
	let app = await launch(false);
	try {
		let page = await app.firstWindow();
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		const intro = page.getByRole('dialog', { name: 'Initial setup', exact: true });
		await expect(intro).toBeVisible();
		await expect(intro.getByRole('heading', { name: 'Brigadir' })).toBeVisible();
		await settle(page);
		await page.screenshot({ path: info.outputPath('hello.png') });
		// The language switches the intro at once.
		await intro.getByRole('radio', { name: 'Українська', exact: true }).click();
		const introUk = page.getByRole('dialog', { name: 'Початкові налаштування', exact: true });
		await expect(introUk.getByRole('heading', { name: 'Бригадир' })).toBeVisible();
		await expect(introUk.getByRole('button', { name: 'Почати', exact: true })).toBeVisible();
		await settle(page);
		await page.screenshot({ path: info.outputPath('hello-uk.png') });
		await introUk.getByRole('radio', { name: 'English', exact: true }).click();
		await expect(intro.getByRole('heading', { name: 'Brigadir' })).toBeVisible();
		// spec/appearance#control-scale: the intro is built from the system controls: «Get started» is XL (40), the step buttons L (32), a segment and a swatch are 24 × 24 or more.
		expect(
			(await intro.getByRole('button', { name: 'Get started', exact: true }).boundingBox())!.height
		).toBe(40);
		await intro.getByRole('button', { name: 'Get started', exact: true }).click();
		await intro.getByRole('button', { name: 'Dark', exact: true }).click();
		expect(
			(await intro.getByRole('button', { name: 'Next', exact: true }).boundingBox())!.height
		).toBe(32);
		for (const box of await intro
			.getByRole('radio', {
				name: /^(Blue|Indigo|Purple|Pink|Teal|Yellow|Graphite|Follow system)$/,
			})
			.evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().toJSON())))
			expect([box.width, box.height]).toEqual([24, 24]);
		await expect
			.poll(() => page.evaluate(() => document.documentElement.dataset.theme))
			.toBe('dark');
		// spec/settings-modules-and-onboarding#intro: sizes are a «− N +» stepper.
		await intro
			.getByRole('group', { name: 'Text size', exact: true })
			.getByRole('button', { name: 'Larger', exact: true })
			.click();
		await expect
			.poll(
				async () => JSON.parse(await readFile(settingsFile, 'utf8')).settings.interfaceFont.size
			)
			.toBe(14);
		await page.screenshot({ path: info.outputPath('look.png') });
		// spec/task-window-workspace#two-columns: Two columns / Three columns are back on Appearance; a choice is saved at once.
		const taskColumns = async () =>
			JSON.parse(await readFile(settingsFile, 'utf8')).settings.taskColumns;
		await intro.getByRole('button', { name: /^Two columns/ }).click();
		await expect.poll(taskColumns).toBe('two');
		await intro.getByRole('button', { name: /^Three columns/ }).click();
		await expect.poll(taskColumns).toBe('three');
		await intro.getByRole('button', { name: 'Next', exact: true }).click();
		// No agent on this Mac: the intro cannot go on, and Skip brings it back here.
		await expect(intro.getByRole('alert')).toContainText(
			'Install Claude Code or Codex, then check again.'
		);
		await expect(intro.getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
		await intro.getByRole('button', { name: /^Skip/ }).first().click();
		await expect(intro.getByRole('alert')).toContainText(
			'Install Claude Code or Codex, then check again.'
		);
		await settle(page);
		await page.screenshot({ path: info.outputPath('agents-none.png') });
	} finally {
		await app.close();
	}
	app = await launch(true);
	try {
		const page = await app.firstWindow();
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		const intro = page.getByRole('dialog', { name: 'Initial setup', exact: true });
		await expect(intro).toBeVisible();
		// The first run was left unfinished: the intro opens again, with the choices already saved.
		expect(JSON.parse(await readFile(settingsFile, 'utf8')).settings).toMatchObject({
			appearance: 'dark',
			onboarding: { completedVersion: null },
		});
		await intro.getByRole('button', { name: 'Get started', exact: true }).click();
		await intro.getByRole('button', { name: 'Next', exact: true }).click();
		await expect(intro.locator('[data-agent-status=ready]').first()).toContainText(
			'Ready · signed in with Claude Code'
		);
		await intro.getByRole('radio', { name: 'Terminal', exact: true }).click();
		await settle(page);
		await page.screenshot({ path: info.outputPath('agents.png') });
		await intro.getByRole('button', { name: 'Next', exact: true }).click();
		// spec/settings-modules-and-onboarding#intro-crew: the crew step; a role's provider is the built-in template's, as in Settings ▸ Templates.
		await expect(intro.getByRole('heading', { name: 'Crew', exact: true })).toBeVisible();
		await settle(page);
		await page.screenshot({ path: info.outputPath('crew-card.png') });
		await intro
			.getByRole('radiogroup', { name: 'Select a provider · Developers' })
			.getByRole('radio', { name: 'Codex', exact: true })
			.click();
		await expect
			.poll(
				async () =>
					JSON.parse(
						await readFile(join(data, 'templates/builtin/developer.json'), 'utf8').catch(() => '{}')
					).template?.provider
			)
			.toBe('codex');
		await expect(
			intro
				.getByRole('radiogroup', { name: 'Select a provider · Developers' })
				.getByRole('radio', { name: 'Codex', exact: true })
		).toBeChecked();
		await page.waitForTimeout(3400);
		await page.screenshot({ path: info.outputPath('crew.png') });
		await intro.getByRole('button', { name: 'Next', exact: true }).click();
		await intro.getByRole('radio', { name: 'Worktree', exact: true }).click();
		await intro.getByRole('button', { name: 'Next', exact: true }).click();
		await intro.getByRole('button', { name: 'VS Code' }).click();
		await expect
			.poll(() => page.evaluate(() => document.documentElement.dataset.codeTheme))
			.toBe('vscode');
		await settle(page);
		await page.screenshot({ path: info.outputPath('editor.png') });
		await intro.getByRole('button', { name: 'Next', exact: true }).click();
		await intro.getByRole('button', { name: 'List' }).click();
		await settle(page);
		await page.screenshot({ path: info.outputPath('tasks.png') });
		await intro.getByRole('button', { name: 'Next', exact: true }).click();
		// spec/settings-modules-and-onboarding#intro-remote: the Modules step — the same rows as Settings ▸ Modules; a click anywhere on a row toggles it.
		await expect(intro.getByRole('heading', { name: 'Modules', exact: true })).toBeVisible();
		// spec/notifications-slack-notes-and-schedules#notes: Notes is the sixth module.
		await expect(intro.locator('[data-module]')).toHaveCount(7);
		const dots = intro.locator('header > div > i');
		await expect(dots).toHaveCount(11);
		await intro.locator('[data-module=simulator]').click();
		await expect(intro.getByRole('switch', { name: 'Simulator', exact: true })).toBeChecked();
		// spec/sidebar#section-rail: the sample window has the app's sections rail; a module turned off takes its section away.
		const railNotes = intro.locator('[data-rail] [data-rail-section=notes]');
		await expect(railNotes).toHaveCount(1);
		await intro.getByRole('switch', { name: 'Notes', exact: true }).click();
		await expect(railNotes).toHaveCount(0);
		await intro.getByRole('switch', { name: 'Notes', exact: true }).click();
		await expect(railNotes).toHaveCount(1);
		// Remote access off: its step leaves the intro.
		await intro.getByRole('switch', { name: 'Remote access', exact: true }).click();
		await expect(dots).toHaveCount(10);
		await expect
			.poll(async () => JSON.parse(await readFile(settingsFile, 'utf8')).settings.modules)
			.toMatchObject({ simulator: true, remoteAccess: false });
		await settle(page);
		await page.screenshot({ path: info.outputPath('modules.png') });
		await intro.getByRole('switch', { name: 'Remote access', exact: true }).click();
		await expect(dots).toHaveCount(11);
		await intro.getByRole('button', { name: 'Next', exact: true }).click();
		await intro.getByRole('button', { name: /When a turn ends/ }).click();
		await settle(page);
		await page.screenshot({ path: info.outputPath('notify.png') });
		await intro.getByRole('button', { name: 'Next', exact: true }).click();
		await expect(intro.locator('[data-keymap-editor]')).toBeVisible();
		await settle(page);
		await page.screenshot({ path: info.outputPath('keys.png') });
		await intro.getByRole('button', { name: 'Next', exact: true }).click();
		// spec/settings-modules-and-onboarding#intro-remote: the Remote access step — off by default; a short or different password does not turn it on.
		await expect(intro.getByRole('heading', { name: 'Remote access', exact: true })).toBeVisible();
		await expect(intro.locator('[data-remote-scheme]')).toBeVisible();
		// spec/remote-access-and-mobile#tailscale-guidance: the network fact says Tailscale is installed away from home, with its download.
		await expect(intro.locator('[data-remote-fact="network"]')).toContainText(
			'Tailscale on both devices'
		);
		await expect(intro.locator('[data-tailscale-link]')).toHaveAttribute(
			'href',
			'https://tailscale.com/download'
		);
		const allow = intro.getByRole('switch', {
			name: 'Allow control from other devices',
			exact: true,
		});
		await expect(allow).not.toBeChecked();
		await allow.click();
		await intro.getByLabel('Password', { exact: true }).fill('short');
		await expect(intro.getByRole('button', { name: 'Turn on', exact: true })).toBeDisabled();
		await intro.getByLabel('Password', { exact: true }).fill('long enough 1');
		await intro.getByLabel('Repeat the password').fill('long enough 2');
		await expect(intro).toContainText('The passwords do not match.');
		await expect(intro.getByRole('button', { name: 'Turn on', exact: true })).toBeDisabled();
		await settle(page);
		await page.screenshot({ path: info.outputPath('remote.png') });
		await allow.click();
		await expect(intro.getByLabel('Password', { exact: true })).toHaveCount(0);
		await intro.getByRole('button', { name: 'Next', exact: true }).click();
		await app.evaluate(({ dialog }, repo) => {
			dialog.showOpenDialog = (async () => ({
				canceled: false,
				filePaths: [repo],
			})) as typeof dialog.showOpenDialog;
		}, repo);
		await intro.getByRole('button', { name: 'Choose a folder…', exact: true }).click();
		await expect(intro.getByText('choice', { exact: true }).first()).toBeVisible();
		await settle(page);
		await page.screenshot({ path: info.outputPath('project.png') });
		await intro.getByRole('button', { name: 'Done', exact: true }).click();
		await settle(page);
		await page.screenshot({ path: info.outputPath('done.png') });
		// «New task ⌘N» closes the intro and opens the new task sheet for the first project.
		await intro.getByRole('button', { name: /^New task/ }).click();
		await expect(intro).toHaveCount(0);
		await expect(page.getByRole('dialog', { name: 'New task' })).toBeVisible();
		await page.keyboard.press('Escape');
		const saved = JSON.parse(await readFile(settingsFile, 'utf8')).settings;
		expect(saved).toMatchObject({
			onboarding: { completedVersion: 1 },
			agents: { transport: 'terminal', isolation: 'worktree' },
			editor: { codeTheme: 'vscode' },
			projects: { defaultView: 'list' },
			notifications: { mode: 'turn-ended' },
		});
		await expect(page.locator('aside').getByText('choice', { exact: true }).first()).toBeVisible();
		await app.evaluate(({ Menu }) => {
			Menu.getApplicationMenu()!.getMenuItemById('intro')!.click();
		});
		await expect(intro).toBeVisible();
		await page.keyboard.press('Escape');
		expect(errors).toEqual([]);
	} finally {
		await app.close();
	}
	app = await launch(true);
	try {
		const page = await app.firstWindow();
		await settle(page);
		await expect(page.getByRole('dialog', { name: 'Initial setup', exact: true })).toHaveCount(0);
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
const accelerator = (app: ElectronApplication, id: string) =>
	app.evaluate(({ Menu }, id) => {
		const item = Menu.getApplicationMenu()!.getMenuItemById(id);
		return item ? (item.accelerator ?? null) : undefined;
	}, id);
// spec/settings-modules-and-onboarding#settings-keys, spec/settings-modules-and-onboarding#intro (was intro-settings.spec.ts): the settings the intro introduces, in Settings; the keymap drives the menu bar.
test('Settings carry the intro choices: keymap with conflicts drives the menu, agents turn off, projects default to a view @area:settings', async () => {
	test.setTimeout(90000);
	const root = await mkdtemp(join(tmpdir(), 'brigadir-intro-settings-')),
		data = join(root, 'data'),
		taskDir = join(data, 'projects/project/tasks/task'),
		settingsFile = join(data, 'settings.json');
	await mkdir(taskDir, { recursive: true });
	await writeFile(
		join(taskDir, '../../project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'repository', path: root } })
	);
	await writeFile(
		join(taskDir, 'task.json'),
		JSON.stringify({
			schemaVersion: 1,
			task: {
				id: 'task',
				projectId: 'project',
				title: 'Intro fixture',
				status: 'done',
				provider: 'claude',
			},
		})
	);
	await writeFile(
		settingsFile,
		JSON.stringify({ schemaVersion: 1, settings: { appearance: 'dark', language: 'en' } })
	);
	const app = await launchIn(root, {
		BRIGADIR_TEST_ENVIRONMENT: JSON.stringify({
			agents: [
				{ provider: 'claude', found: true, via: 'cache', version: '2.1.0', signIn: 'signed-in' },
				{ provider: 'codex', found: true, via: 'npx', version: null, signIn: 'signed-out' },
			],
			git: { found: true, version: '2.50.1' },
			gh: { auth: 'missing', version: null },
		}),
	});
	try {
		const page = await app.firstWindow();
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		await expect(page.getByRole('button', { name: /Intro fixture/ })).toBeVisible();
		// A settings file from before the intro means the app was used: the intro counts as seen.
		expect(JSON.parse(await readFile(settingsFile, 'utf8')).settings.onboarding).toBeUndefined();
		await expect(page.getByRole('dialog', { name: 'Initial setup', exact: true })).toHaveCount(0);
		expect(await accelerator(app, 'intro')).toBeNull();
		expect(await accelerator(app, 'new-task')).toBe('CmdOrCtrl+N');
		await clickMenu(app, 'settings');
		const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
		await expect(dialog.getByRole('radio', { name: 'Board', exact: true })).toBeVisible();
		await dialog.getByRole('radio', { name: 'List', exact: true }).click();
		await expect
			.poll(async () => JSON.parse(await readFile(settingsFile, 'utf8')).settings.projects)
			.toEqual({ defaultView: 'list' });
		await dialog.getByRole('button', { name: 'Code theme', exact: true }).click();
		await dialog.getByRole('option', { name: 'VS Code', exact: true }).click();
		await expect
			.poll(() => page.evaluate(() => document.documentElement.dataset.codeTheme))
			.toBe('vscode');
		await dialog.getByRole('button', { name: 'Customize…', exact: true }).click();
		const keys = page.getByRole('dialog', { name: 'Keyboard', exact: true });
		await expect(keys).toBeVisible();
		// A free shortcut goes straight to the command and to its menu item.
		await keys.getByRole('button', { name: /^New task · / }).click();
		await expect.poll(() => accelerator(app, 'new-task')).toBeNull();
		await page.keyboard.press('Meta+Shift+H');
		await expect.poll(() => accelerator(app, 'new-task')).toBe('Shift+CmdOrCtrl+H');
		// ⌘J belongs to a global command: a conflict, shown until Replace moves it.
		await keys.getByRole('button', { name: /^Search Everywhere… · / }).click();
		await page.keyboard.press('Meta+J');
		await expect(keys.getByRole('alert')).toBeVisible();
		await keys.getByRole('button', { name: 'Replace', exact: true }).click();
		await expect.poll(() => accelerator(app, 'search')).toBe('CmdOrCtrl+J');
		await expect.poll(() => accelerator(app, 'needs-next')).toBeNull();
		// macOS keeps ⌘Space: only Cancel.
		await keys.getByRole('button', { name: /^Stop · / }).click();
		await page.keyboard.press('Meta+Space');
		await expect(keys.getByRole('alert')).toBeVisible();
		await expect(keys.getByRole('button', { name: 'Replace', exact: true })).toHaveCount(0);
		await keys.getByRole('button', { name: 'Cancel', exact: true }).click();
		expect(JSON.parse(await readFile(settingsFile, 'utf8')).settings.keymap).toEqual({
			preset: 'brigadir',
			overrides: { 'new-task': 'Shift+CmdOrCtrl+H', search: 'CmdOrCtrl+J', 'needs-next': null },
		});
		await keys.getByRole('radio', { name: 'VS Code', exact: true }).click();
		await expect.poll(() => accelerator(app, 'editor-definition')).toBe('F12');
		await page.keyboard.press('Escape');
		await expect(keys).toHaveCount(0);
		await expect(dialog).toBeVisible();
		await expect(dialog.getByRole('button', { name: 'Customize…', exact: true })).toBeFocused();
		// Agents: the environment check beside each switch (spec/settings-modules-and-onboarding#settings-keys p. 7); the last provider on cannot be turned off.
		await dialog.getByRole('tab', { name: 'Agents' }).click();
		await expect(dialog.locator('[data-agent-status=ready]')).toBeVisible();
		await expect(
			dialog
				.locator('[data-agent-status=login]')
				.getByRole('button', { name: 'Sign in…', exact: true })
		).toBeVisible();
		await dialog.getByRole('switch', { name: 'Claude Code', exact: true }).click();
		await expect
			.poll(async () => JSON.parse(await readFile(settingsFile, 'utf8')).settings.agents)
			.toMatchObject({ enabled: { claude: false, codex: true }, provider: 'codex' });
		await expect(dialog.getByRole('switch', { name: 'Codex', exact: true })).toBeDisabled();
		await dialog.getByRole('radio', { name: 'Worktree', exact: true }).click();
		await expect
			.poll(async () => JSON.parse(await readFile(settingsFile, 'utf8')).settings.agents.isolation)
			.toBe('worktree');
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
// Was intro-states.spec.ts: the intro on a fresh data dir, with one environment per test.
async function launchFresh(extra: Record<string, string>) {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-intro-states-'));
	const app = await launchIn(root, { BRIGADIR_SKIP_INTRO: '0', ...extra });
	const page = await app.firstWindow();
	await app.evaluate(({ BrowserWindow }) =>
		BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 800)
	);
	return { app, page, root };
}
const signedOut = JSON.stringify({
	agents: [
		{ provider: 'claude', found: true, via: 'cache', version: '2.1.0', signIn: 'signed-out' },
		{ provider: 'codex', found: false, via: null, version: null, signIn: 'unknown' },
	],
	git: { found: true, version: '2.50.1' },
	gh: { auth: 'missing', version: null },
});
// The environment check itself fails: the intro and Settings ▸ Agents say so and offer Check, instead of searching forever.
test('a failed environment check is «Not checked» with Check in the intro and in Settings ▸ Agents @area:settings', async () => {
	test.setTimeout(90000);
	const { app, page, root } = await launchFresh({ BRIGADIR_TEST_ENVIRONMENT: '{}' });
	try {
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		const intro = page.getByRole('dialog', { name: 'Initial setup', exact: true });
		await intro.getByRole('button', { name: 'Get started', exact: true }).click();
		await intro.getByRole('button', { name: 'Next', exact: true }).click();
		await expect(intro.locator('[data-agent-status="failed"]')).toHaveCount(2);
		const alert = intro.locator('[data-env-failed]');
		await expect(alert).toBeVisible();
		await expect(intro.getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
		// Check runs the check again; it fails again and the state stays.
		await alert.getByRole('button', { name: 'Check', exact: true }).click();
		await expect(alert).toBeVisible();
		// Skip leaves the intro; Settings ▸ Agents shows the same state per agent.
		await intro.getByRole('button', { name: /^Skip/ }).click();
		await expect(intro.getByRole('button', { name: /^New task/ })).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(intro).toBeHidden();
		await clickMenu(app, 'settings');
		const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
		await dialog.getByRole('tab', { name: 'Agents', exact: true }).click();
		const failed = dialog.locator('[data-agent-status="failed"]');
		await expect(failed).toHaveCount(2);
		await expect(failed.first().getByRole('button', { name: 'Check', exact: true })).toBeEnabled();
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
// spec/agents-and-providers#sign-in-recovery p. 4: the intro follows the in-app sign-in as Settings does: waiting with Cancel, and back on Cancel.
test('the intro shows the sign-in in the browser as waiting with Cancel @area:settings', async () => {
	test.setTimeout(90000);
	const script = join(tmpdir(), `brigadir-intro-login-${process.pid}.mjs`);
	// Never finishes by itself: it waits for a code that does not come.
	await writeFile(script, `console.log('Opening browser to sign in…');process.stdin.resume();`);
	const { app, page, root } = await launchFresh({
		BRIGADIR_TEST_ENVIRONMENT: signedOut,
		BRIGADIR_TEST_LOGIN: script,
	});
	try {
		const intro = page.getByRole('dialog', { name: 'Initial setup', exact: true });
		await intro.getByRole('button', { name: 'Get started', exact: true }).click();
		await intro.getByRole('button', { name: 'Next', exact: true }).click();
		const claude = intro.locator('[data-agent-status="login"]'),
			signIn = intro.getByRole('button', { name: 'Sign in…', exact: true }),
			cancel = intro.getByRole('button', { name: 'Cancel', exact: true });
		await expect(claude).toBeVisible();
		await signIn.click();
		await expect(cancel).toBeVisible();
		await expect(signIn).toHaveCount(0);
		await cancel.click();
		await expect(claude).toBeVisible();
		await expect(signIn).toBeVisible();
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
		await rm(script, { force: true });
	}
});
// spec/architecture-and-platform#linux-package p. 7 on Linux (previewed on a Mac): no «Open System Settings» in Notifications.
test('on Linux the intro skips through and Notifications has no Open System Settings @area:settings', async () => {
	test.setTimeout(90000);
	const { app, page, root } = await launchFresh({
		BRIGADIR_TEST_ENVIRONMENT: signedOut,
		BRIGADIR_CHROME_PLATFORM: 'linux',
	});
	try {
		const intro = page.getByRole('dialog', { name: 'Initial setup', exact: true });
		await expect(page.locator('html')).toHaveAttribute('data-platform', 'linux');
		await intro.getByRole('button', { name: /^Skip/ }).click();
		await expect(intro.getByRole('button', { name: /^New task/ })).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(intro).toBeHidden();
		await clickMenu(app, 'settings');
		const dialog = page.getByRole('dialog', { name: 'Settings', exact: true }),
			tab = dialog.getByRole('tab', { name: 'Notifications', exact: true });
		await tab.click();
		await expect(tab).toHaveAttribute('aria-selected', 'true');
		await expect(
			dialog.getByRole('button', { name: 'Open System Settings', exact: true })
		).toHaveCount(0);
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
