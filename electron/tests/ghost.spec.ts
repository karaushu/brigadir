import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { editorText } from './editor-text';
import { defaultAppSettings } from '../packages/core/src/settings';
const desktop = resolve('apps/desktop'),
	executablePath = createRequire(join(desktop, 'package.json'))('electron') as string,
	env = Object.fromEntries(
		Object.entries(process.env).filter(
			(entry): entry is [string, string] =>
				typeof entry[1] === 'string' && entry[0] !== 'ELECTRON_RUN_AS_NODE'
		)
	);
test('opt-in next-prompt hints consume one disposable call, cancel the process on typing and never send without Tab @area:chat', async ({}, info) => {
	test.setTimeout(90000);
	const root = await mkdtemp(join(tmpdir(), 'brigadir-ghost-ui-')),
		repo = join(root, 'repo'),
		data = join(root, 'data'),
		stateFile = join(root, 'ghost.json');
	await mkdir(repo);
	const git = async (...args: string[]) => promisify(execFile)('git', args, { cwd: repo });
	await git('init', '-b', 'main');
	await git('config', 'user.name', 'Fixture');
	await git('config', 'user.email', 'fixture@example.invalid');
	await writeFile(join(repo, 'file'), 'base');
	await git('add', '.');
	await git('commit', '-m', 'Baseline');
	await mkdir(join(data, 'projects/project'), { recursive: true });
	await writeFile(
		join(data, 'projects/project/project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'repo', path: repo } })
	);
	// spec/composer-steering-queue-and-ghost#ghost-headless: the default helper is Codex Luna; with Codex off it is Claude Haiku, whose quota
	// warnings this test drives.
	await writeFile(
		join(data, 'settings.json'),
		JSON.stringify({
			schemaVersion: 1,
			settings: {
				appearance: 'light',
				language: 'en',
				agents: { ...defaultAppSettings.agents, enabled: { claude: true, codex: false } },
			},
		})
	);
	await writeFile(stateFile, JSON.stringify({ mode: 'reply' }));
	const events = async () => {
		try {
			return (await readFile(`${stateFile}.log`, 'utf8'))
				.trim()
				.split('\n')
				.map((line) => JSON.parse(line));
		} catch {
			return [];
		}
	};
	const app = await electron.launch({
		executablePath,
		args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
		env: {
			...env,
			BRIGADIR_DATA_DIR: data,
			BRIGADIR_TEST_AGENT: resolve('packages/transport/fixtures/agent.mjs'),
			BRIGADIR_TEST_GHOST: resolve('packages/transport/fixtures/ghost.mjs'),
			BRIGADIR_TEST_GHOST_STATE: stateFile,
			// Settings ▸ Agents probes the Claude catalog; once known, the default is its Haiku entry by exact value
			// (spec/composer-steering-queue-and-ghost#ghost-headless), so the task fixture lists the same entry as the hint fixture.
			BRIGADIR_FIXTURE_SCENARIO: 'ghost-model',
		},
	});
	try {
		const page = await app.firstWindow(),
			errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		const task = await page.evaluate(async () => {
			const task = await window.brigadir.createTask(
				'project',
				'Поясни ці зміни',
				'claude',
				'gui',
				false
			);
			await window.brigadir.startSession(task);
			return task;
		});
		const completed = async () =>
			(await page.evaluate((task) => window.brigadir.readSession(task), task)).records.filter(
				(record) => record.event.kind === 'turn.completed'
			).length;
		await expect.poll(completed).toBe(1);
		const row = page
			.locator('aside')
			.getByRole('button', { name: /Поясни ці зміни/ })
			.filter({ has: page.locator('[class*=taskCopy]') });
		await row.click();
		const composer = page.getByRole('textbox', { name: 'Message', exact: true });
		await expect.poll(() => editorText(composer)).toBe('');
		await page.waitForTimeout(700);
		expect(await events()).toEqual([]);
		await app.evaluate(({ Menu }) => {
			Menu.getApplicationMenu()!
				.items.flatMap((item) => item.submenu?.items ?? [])
				.find((item) => item.label === 'Settings…')!
				.click();
		});
		const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
		await expect(settings).toBeVisible();
		await settings.getByRole('tab', { name: 'Agents', exact: true }).click();
		const toggle = settings.getByRole('switch', { name: 'Suggest the next prompt', exact: true });
		await expect(toggle).toHaveAttribute('aria-checked', 'false');
		await toggle.click();
		await expect(toggle).toHaveAttribute('aria-checked', 'true');
		await toggle.click();
		await expect(toggle).toHaveAttribute('aria-checked', 'false');
		await toggle.focus();
		await page.keyboard.press('Space');
		await expect(toggle).toHaveAttribute('aria-checked', 'true');
		for (const theme of ['light', 'dark'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await page.screenshot({
				animations: 'disabled',
				path: info.outputPath(`ghost-settings-${theme}.png`),
			});
		}
		await page.keyboard.press('Escape');
		await expect(composer).toHaveAttribute('data-ghost', 'generated');
		await expect(composer).toHaveAttribute('aria-placeholder', 'Перевір зміни тестами.');
		expect((await events()).filter((event) => event.event === 'prompt')).toHaveLength(1);
		expect((await events()).find((event) => event.event === 'option').params.value).toBe(
			'advertised-haiku'
		);
		expect((await events()).find((event) => event.event === 'new').params.mcpServers).toEqual([]);
		for (const theme of ['light', 'dark'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await page.screenshot({
				animations: 'disabled',
				path: info.outputPath(`ghost-hint-${theme}.png`),
			});
		}
		await composer.focus();
		await page.keyboard.press('Enter');
		expect(await completed()).toBe(1);
		await expect.poll(() => editorText(composer)).toBe('');
		await page.keyboard.press('Tab');
		await expect(composer).toHaveText('Перевір зміни тестами.');
		await expect(composer).toBeFocused();
		await page.screenshot({
			animations: 'disabled',
			path: info.outputPath('ghost-accepted-dark.png'),
		});
		await writeFile(stateFile, JSON.stringify({ mode: 'hold' }));
		await page.keyboard.press('Enter');
		await expect.poll(completed).toBe(2);
		await expect
			.poll(async () => (await events()).filter((event) => event.event === 'prompt').length)
			.toBe(2);
		const second = (await events()).filter((event) => event.event === 'prompt').at(-1)!.pid;
		await composer.fill('Я ще пишу');
		await expect
			.poll(async () =>
				(await events()).some((event) => event.event === 'terminated' && event.pid === second)
			)
			.toBe(true);
		await composer.fill('');
		await page.waitForTimeout(700);
		expect((await events()).filter((event) => event.event === 'prompt')).toHaveLength(2);
		await writeFile(stateFile, JSON.stringify({ mode: 'reply' }));
		await composer.fill('Наступний крок');
		await page.keyboard.press('Enter');
		await expect.poll(completed).toBe(3);
		await expect(composer).toHaveAttribute('data-ghost', 'generated');
		await composer.focus();
		await page.keyboard.press('Escape');
		await expect(composer).not.toHaveAttribute('data-ghost', 'generated');
		await page.locator('aside').getByRole('button', { name: 'All projects', exact: true }).click();
		await row.click();
		await page.waitForTimeout(700);
		await expect(composer).not.toHaveAttribute('data-ghost', 'generated');
		expect((await events()).filter((event) => event.event === 'prompt')).toHaveLength(3);
		await writeFile(stateFile, JSON.stringify({ mode: 'hold' }));
		await composer.fill('Зміна задачі');
		await page.keyboard.press('Enter');
		await expect.poll(completed).toBe(4);
		await expect
			.poll(async () => (await events()).filter((event) => event.event === 'prompt').length)
			.toBe(4);
		const switching = (await events()).filter((event) => event.event === 'prompt').at(-1)!.pid;
		await page.locator('aside').getByRole('button', { name: 'All projects', exact: true }).click();
		await expect
			.poll(async () =>
				(await events()).some((event) => event.event === 'terminated' && event.pid === switching)
			)
			.toBe(true);
		await row.click();
		await page.waitForTimeout(700);
		expect((await events()).filter((event) => event.event === 'prompt')).toHaveLength(4);
		await writeFile(stateFile, JSON.stringify({ mode: 'warning' }));
		await composer.fill('Ще один крок');
		await page.keyboard.press('Enter');
		await expect.poll(completed).toBe(5);
		await expect
			.poll(async () => (await events()).filter((event) => event.event === 'prompt').length)
			.toBe(5);
		const warned = (await events()).filter((event) => event.event === 'prompt').at(-1)!.pid;
		await expect
			.poll(async () =>
				(await events()).some((event) => event.event === 'terminated' && event.pid === warned)
			)
			.toBe(true);
		await expect(composer).not.toHaveAttribute('data-ghost', 'generated');
		await composer.fill('Працюй далі');
		await page.keyboard.press('Enter');
		await expect.poll(completed).toBe(6);
		await page.waitForTimeout(700);
		expect((await events()).filter((event) => event.event === 'prompt')).toHaveLength(5);
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
// spec/composer-steering-queue-and-ghost#ghost-headless: the hint model is chosen from the adapters' catalogs, grouped by provider; an off provider falls back to the default.
test('the hint model menu lists both catalogs by provider, marks the choice, saves it and keeps it when the provider is off @area:chat', async () => {
	test.setTimeout(90000);
	const root = await mkdtemp(join(tmpdir(), 'brigadir-ghost-model-')),
		data = join(root, 'data'),
		settingsFile = join(data, 'settings.json');
	await mkdir(data, { recursive: true });
	await writeFile(
		settingsFile,
		JSON.stringify({ schemaVersion: 1, settings: { appearance: 'light', language: 'en' } })
	);
	const app = await electron.launch({
		executablePath,
		args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
		env: {
			...env,
			BRIGADIR_DATA_DIR: data,
			BRIGADIR_TEST_AGENT: resolve('packages/transport/fixtures/agent.mjs'),
			BRIGADIR_FIXTURE_SCENARIO: 'ghost-model',
		},
	});
	try {
		const page = await app.firstWindow(),
			errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		await app.evaluate(({ Menu }) => {
			Menu.getApplicationMenu()!.getMenuItemById('settings')!.click();
		});
		const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
		await dialog.getByRole('tab', { name: 'Agents', exact: true }).click();
		// spec/appearance#evolution-redesign: the Helper agent stays active with the prompt hint off — it writes every
		// one-off text; the default is the Codex entry that says Luna, and this fixture has none, so it is the one that
		// says Haiku (spec/composer-steering-queue-and-ghost#ghost-headless).
		// spec/settings-modules-and-onboarding#module-settings-popup: the same model · effort capsule and menu as the rows of Customize per action.
		const capsule = dialog.locator('[data-helper-agent] [data-option-kind="model"] > button');
		await expect(capsule).toBeEnabled();
		await expect(capsule).toContainText('Claude Haiku');
		await capsule.click();
		const menu = page.getByRole('dialog', { name: 'Helper agent', exact: true });
		await expect(menu).toBeVisible();
		await expect(
			menu.getByRole('radiogroup', { name: 'Model · Claude' }).getByRole('radio', { checked: true })
		).toContainText('Claude Haiku');
		await menu
			.getByRole('radiogroup', { name: 'Model · Codex' })
			.getByRole('radio', { name: 'Other' })
			.click();
		await expect(capsule).toContainText('Other');
		await expect
			.poll(async () => JSON.parse(await readFile(settingsFile, 'utf8')).settings.helperAgent)
			.toEqual({ provider: 'codex', model: 'other', name: 'Other', effort: null });
		await page.keyboard.press('Escape');
		// Codex off: the choice stays shown, its provider leaves the menu and the line under it names who writes instead.
		await dialog.getByRole('switch', { name: 'Codex', exact: true }).click();
		await expect(capsule).toContainText('Other');
		await capsule.click();
		await expect(menu.getByRole('radiogroup', { name: 'Model · Codex' })).toHaveCount(0);
		await page.keyboard.press('Escape');
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
