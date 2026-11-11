import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
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
test('agent defaults persist, load before launch choices and never rewrite existing tasks @area:settings', async ({}, info) => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-agents-ui-')),
		data = join(root, 'data'),
		dir = join(data, 'projects/project/tasks/existing'),
		settingsFile = join(data, 'settings.json');
	await mkdir(dir, { recursive: true });
	await writeFile(
		join(dir, '../../project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'repository', path: root } })
	);
	const existing = JSON.stringify({
		schemaVersion: 1,
		task: {
			id: 'existing',
			projectId: 'project',
			title: 'Existing GUI task',
			status: 'done',
			provider: 'claude',
			transport: 'gui',
		},
	});
	await writeFile(join(dir, 'task.json'), existing);
	await writeFile(
		settingsFile,
		JSON.stringify({ schemaVersion: 1, settings: { appearance: 'light', language: 'en' } })
	);
	const launch = () => launchIn(root);
	let app = await launch();
	try {
		let page = await app.firstWindow();
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		const action = async (id: string) => {
			await expect
				.poll(() =>
					app.evaluate(
						({ Menu }, id) => Menu.getApplicationMenu()!.getMenuItemById(id)!.enabled,
						id
					)
				)
				.toBe(true);
			await app.evaluate(
				({ Menu }, id) => Menu.getApplicationMenu()!.getMenuItemById(id)!.click(),
				id
			);
		};
		await page.getByRole('button', { name: /Existing GUI task/ }).click();
		await action('settings');
		let dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
		await dialog.evaluate((node) => {
			(window as any).settingsHeights = [];
			const until = performance.now() + 1800;
			const tick = () => {
				(window as any).settingsHeights.push(node.getBoundingClientRect().height);
				if (performance.now() < until) requestAnimationFrame(tick);
			};
			requestAnimationFrame(tick);
		});
		await dialog.getByRole('tab', { name: 'Appearance', exact: true }).press('End');
		// spec/settings-modules-and-onboarding#module-settings-popup: Modules is the seventh tab, last; remote access settings are the module's popup.
		await expect(dialog.getByRole('tab', { name: 'Modules', exact: true })).toBeFocused();
		await dialog.getByRole('tab', { name: 'Modules', exact: true }).press('ArrowLeft');
		await expect(dialog.getByRole('tab', { name: 'Templates', exact: true })).toBeFocused();
		await dialog.getByRole('tab', { name: 'Templates', exact: true }).press('ArrowLeft');
		await expect(dialog.getByRole('tab', { name: 'Agents', exact: true })).toBeFocused();
		await expect(dialog.getByRole('radio', { name: 'Claude', exact: true })).toBeChecked();
		await expect(dialog.getByRole('radio', { name: 'GUI', exact: true })).toBeChecked();
		await expect
			.poll(() => dialog.evaluate((node) => node.getBoundingClientRect().height))
			.toBe(500);
		expect(
			await page.evaluate(() =>
				(window as any).settingsHeights.some((height: number) => height > 471 && height < 720)
			)
		).toBe(true);
		// Sample the actual shared segment transition, including an interrupted reversal.
		await dialog
			.getByRole('radiogroup', { name: 'Default agent', exact: true })
			.evaluate((node) => {
				const indicator = node.querySelector('span[aria-hidden]')!;
				(window as any).agentMotion = [];
				const until = performance.now() + 1800;
				const tick = () => {
					(window as any).agentMotion.push(
						new DOMMatrixReadOnly(getComputedStyle(indicator).transform).m41
					);
					if (performance.now() < until) requestAnimationFrame(tick);
				};
				requestAnimationFrame(tick);
			});
		await dialog.getByRole('radio', { name: 'Codex', exact: true }).click();
		await expect(dialog.getByRole('radio', { name: 'Codex', exact: true })).toBeEnabled();
		await dialog.getByRole('radio', { name: 'Claude', exact: true }).click();
		await expect(dialog.getByRole('radio', { name: 'Claude', exact: true })).toBeEnabled();
		await dialog.getByRole('radio', { name: 'Codex', exact: true }).click();
		await expect
			.poll(() =>
				page.evaluate(() => (window as any).agentMotion.some((x: number) => x > 4 && x < 50))
			)
			.toBe(true);
		await dialog.getByRole('radio', { name: 'Terminal', exact: true }).click();
		await expect
			.poll(async () => JSON.parse(await readFile(settingsFile, 'utf8')).settings.agents)
			.toEqual({
				enabled: { claude: true, codex: true },
				isolation: 'in-place',
				provider: 'codex',
				transport: 'terminal',
				maxConcurrent: null,
				reviewWhere: 'quick',
				updateClis: true,
				keepAwake: true,
				copyEnvFiles: true,
				archiveAfterDays: 3,
				browserActAnywhere: false,
				prSummary: true,
			});
		for (const theme of ['light', 'dark'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => (nativeTheme.themeSource = theme), theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await dialog.screenshot({
				animations: 'disabled',
				path: info.outputPath(`agents-${theme}.png`),
			});
		}
		await app.evaluate(({ ipcMain }) => {
			const handlers = (ipcMain as any)._invokeHandlers,
				original = handlers.get('settings:save');
			handlers.set('settings:save', () => {
				handlers.set('settings:save', original);
				throw new Error('Fixture write failure');
			});
		});
		await dialog.getByRole('radio', { name: 'GUI', exact: true }).click();
		await expect(dialog.getByRole('alert')).toHaveText('The settings could not be saved.');
		await expect(dialog.getByRole('radio', { name: 'Terminal', exact: true })).toBeChecked();
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await dialog.getByRole('radio', { name: 'Terminal', exact: true }).press('ArrowLeft');
		await expect(dialog.getByRole('radio', { name: 'GUI', exact: true })).toBeChecked();
		expect(
			await dialog
				.getByRole('radiogroup', { name: 'Launch in', exact: true })
				.evaluate((node) =>
					parseFloat(getComputedStyle(node.querySelector('span[aria-hidden]')!).transitionDuration)
				)
		).toBeLessThanOrEqual(0.001);
		await dialog.getByRole('radio', { name: 'Terminal', exact: true }).click();
		await expect(dialog.getByRole('radio', { name: 'Terminal', exact: true })).toBeEnabled();
		await page.emulateMedia({ reducedMotion: 'no-preference' });
		await dialog.getByRole('button', { name: 'Close', exact: true }).click();
		await action('new-task');
		let form = page.getByRole('dialog', { name: 'New task', exact: true });
		await expect(form.getByRole('textbox', { name: 'Message', exact: true })).toBeFocused();
		await expect(form.getByRole('button', { name: 'Agent', exact: true })).toHaveText('Codex');
		await expect(form.getByRole('radio', { name: 'CLI', exact: true })).toBeChecked();
		// Use real task persistence, then prevent the launch handoff so no provider runs.
		await app.evaluate(({ ipcMain }) => {
			const handlers = (ipcMain as any)._invokeHandlers,
				original = handlers.get('task:create');
			handlers.set('task:create', async (...args: any[]) => {
				(globalThis as any).createdDefaultsTask = await original(...args);
				throw new Error('Fixture stops after task persistence');
			});
		});
		await form.getByRole('button', { name: 'Agent', exact: true }).click();
		await form.getByRole('option', { name: 'Claude', exact: true }).click();
		await form.getByRole('radio', { name: 'GUI', exact: true }).click();
		await form.getByRole('textbox', { name: 'Message', exact: true }).fill('Per-task override');
		await form.getByRole('textbox', { name: 'Task name', exact: true }).fill('Cart flow rework');
		await form.getByRole('button', { name: 'Start', exact: true }).click();
		await expect(form.getByRole('alert')).toContainText('Fixture stops after task persistence');
		const created = await app.evaluate(() => (globalThis as any).createdDefaultsTask);
		expect(created).toMatchObject({
			provider: 'claude',
			transport: 'gui',
			title: 'Cart flow rework',
			prompt: 'Per-task override',
		});
		expect(
			JSON.parse(
				await readFile(join(data, 'projects/project/tasks', created.id, 'task.json'), 'utf8')
			).task
		).toMatchObject({
			provider: 'claude',
			transport: 'gui',
			title: 'Cart flow rework',
			prompt: 'Per-task override',
		});
		expect(JSON.parse(await readFile(settingsFile, 'utf8')).settings.agents).toEqual({
			enabled: { claude: true, codex: true },
			isolation: 'in-place',
			provider: 'codex',
			transport: 'terminal',
			maxConcurrent: null,
			reviewWhere: 'quick',
			updateClis: true,
			keepAwake: true,
			copyEnvFiles: true,
			archiveAfterDays: 3,
			browserActAnywhere: false,
			prSummary: true,
		});
		expect(await readFile(join(dir, 'task.json'), 'utf8')).toBe(existing);
		await form.getByRole('button', { name: 'Cancel', exact: true }).click();
		const saved = await readFile(settingsFile, 'utf8');
		await writeFile(settingsFile, '{invalid');
		await action('new-task');
		await expect(form.getByRole('alert')).toHaveText('The settings could not be loaded.');
		await expect(form.getByRole('button', { name: 'Start', exact: true })).toBeDisabled();
		await form.screenshot({ animations: 'disabled', path: info.outputPath('launch-error.png') });
		await writeFile(settingsFile, saved);
		await form.getByRole('button', { name: 'Retry', exact: true }).click();
		await expect(form.getByRole('button', { name: 'Agent', exact: true })).toHaveText('Codex');
		await expect(form.getByRole('radio', { name: 'CLI', exact: true })).toBeChecked();
		await form.getByRole('button', { name: 'Cancel', exact: true }).click();
		await page.evaluate(async () => {
			const { settings } = await window.brigadir.readSettings();
			await window.brigadir.saveSettings({ ...settings, language: 'uk' });
		});
		await app.close();
		app = await launch();
		page = await app.firstWindow();
		page.on('pageerror', (error) => errors.push(error.message));
		await action('settings');
		dialog = page.getByRole('dialog', { name: 'Налаштування', exact: true });
		await dialog.getByRole('tab', { name: 'Агенти', exact: true }).click();
		await expect(dialog.getByRole('radio', { name: 'Codex', exact: true })).toBeChecked();
		await expect(dialog.getByRole('radio', { name: 'Термінал', exact: true })).toBeChecked();
		await dialog.screenshot({ animations: 'disabled', path: info.outputPath('agents-uk.png') });
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
// spec/agents-and-providers#cli-updates (was cli-updates.spec.ts): one script stands in for both CLIs; its versions live in a JSON file the test edits between runs.
const cliFixture = `import {readFileSync,writeFileSync} from 'node:fs';
const [provider,...args]=process.argv.slice(2),file=process.env.CLI_FIXTURE,state=JSON.parse(readFileSync(file,'utf8')),cli=state[provider];
if(!cli)process.exit(127);
if(args[0]==='--version'){console.log(cli.version+' ('+provider+')');process.exit(0);}
if(args[0]==='update'){if(cli.fail){console.error('network');process.exit(1);}if(cli.next){cli.version=cli.next;delete cli.next;writeFileSync(file,JSON.stringify(state));}process.exit(0);}
process.exit(2);`;
test('Settings ▸ Agents: «CLI updates» checks now, records what changed and a failure, and keeps the switch @area:settings', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-cli-updates-')),
		data = join(root, 'data'),
		state = join(root, 'clis.json'),
		script = join(root, 'cli.mjs');
	await mkdir(data, { recursive: true });
	await writeFile(script, cliFixture);
	await writeFile(
		state,
		JSON.stringify({
			claude: { version: '2.1.285' },
			codex: { version: '0.156.1', next: '0.160.0' },
		})
	);
	await writeFile(
		join(data, 'settings.json'),
		JSON.stringify({ schemaVersion: 1, settings: { appearance: 'dark', language: 'en' } })
	);
	const app = await launchIn(root, {
		BRIGADIR_TEST_ENVIRONMENT: JSON.stringify({
			agents: [
				{ provider: 'claude', found: true, via: 'path', version: '2.1.285', signIn: 'signed-in' },
				{ provider: 'codex', found: true, via: 'path', version: '0.156.1', signIn: 'signed-in' },
			],
			git: { found: true, version: '2.50.1' },
			gh: { auth: 'missing', version: null },
		}),
		BRIGADIR_TEST_CLI_UPDATE: script,
		CLI_FIXTURE: state,
	});
	try {
		const page = await app.firstWindow(),
			errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		await app.evaluate(({ Menu }) =>
			Menu.getApplicationMenu()!.getMenuItemById('settings')!.click()
		);
		const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
		await dialog.getByRole('tab', { name: 'Agents', exact: true }).click();
		const row = dialog.locator('[data-cli-updates]'),
			status = dialog.locator('[data-cli-update-status]'),
			check = row.getByRole('button', { name: 'Check now', exact: true }),
			outcomes = async () => {
				const saved = await readFile(join(data, 'cli-updates.json'), 'utf8').catch(() => null);
				return saved
					? JSON.parse(saved).status.results.map(
							(result: { provider: string; outcome: string }) =>
								`${result.provider}:${result.outcome}`
						)
					: [];
			};
		await expect(row.getByRole('switch', { name: 'Update in the background' })).toBeChecked();
		await check.click();
		await expect.poll(outcomes).toEqual(['claude:current', 'codex:updated']);
		await expect(status).toContainText('0.160.0');
		await expect(check).toBeEnabled();
		await check.click();
		await expect.poll(outcomes).toEqual(['claude:current', 'codex:current']);
		const saved = JSON.parse(await readFile(state, 'utf8'));
		saved.claude.fail = true;
		await writeFile(state, JSON.stringify(saved));
		await check.click();
		await expect.poll(outcomes).toEqual(['claude:failed', 'codex:current']);
		await expect(check).toBeEnabled();
		// The switch is saved.
		await row.getByRole('switch', { name: 'Update in the background' }).click();
		await expect
			.poll(
				async () =>
					JSON.parse(await readFile(join(data, 'settings.json'), 'utf8')).settings.agents
						?.updateClis
			)
			.toBe(false);
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
/** spec/agents-and-providers#catalog (was model-effort.spec.ts): the sheet's model list is the provider catalog with its first entry chosen, effort
 *  follows the chosen model, and a built-in role keeps the person's model and effort. The fixture answers other effort levels per model. */
test("sheet picks the first catalog model, offers the model's effort levels and built-in roles keep a model and effort @area:settings", async () => {
	test.setTimeout(150_000);
	const root = await mkdtemp(join(tmpdir(), 'brigadir-model-effort-')),
		repo = join(root, 'repo'),
		data = join(root, 'data');
	await mkdir(repo);
	await mkdir(join(data, 'projects/project'), { recursive: true });
	await writeFile(
		join(data, 'projects/project/project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'repo', path: repo } })
	);
	await writeFile(
		join(data, 'settings.json'),
		JSON.stringify({ schemaVersion: 1, settings: { appearance: 'light', language: 'en' } })
	);
	const app = await launchIn(root, {
		BRIGADIR_TEST_AGENT: resolve('packages/transport/fixtures/agent.mjs'),
		BRIGADIR_FIXTURE_SCENARIO: 'model-effort',
	});
	try {
		const page = await app.firstWindow(),
			errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		await page.getByRole('button', { name: 'New task · repo', exact: true }).click();
		const sheet = page.getByRole('dialog', { name: 'New task', exact: true });
		// p. 1: no «Default model» of ours; the first catalog entry is chosen.
		const model = sheet.getByRole('button', { name: 'Model', exact: true }),
			effort = sheet.getByRole('button', { name: 'Effort', exact: true });
		await expect(model).toContainText('Fixture', { timeout: 30000 });
		await model.click();
		await expect(page.getByRole('listbox', { name: 'Model' }).getByRole('option')).toHaveText([
			'Fixture',
			'Other',
			'Lite',
		]);
		await page.keyboard.press('Escape');
		// p. 2: effort shows the provider's value for the model and only that model's levels.
		await expect(effort).toContainText('High');
		await model.click();
		await page.getByRole('option', { name: 'Lite', exact: true }).click();
		await expect(effort).toHaveCount(0);
		await model.click();
		await page.getByRole('option', { name: 'Other', exact: true }).click();
		await expect(effort).toContainText('Medium');
		await effort.click();
		await expect(page.getByRole('listbox', { name: 'Effort' }).getByRole('option')).toHaveText([
			'Low',
			'Medium',
		]);
		await page.getByRole('option', { name: 'Low', exact: true }).click();
		await expect(effort).toContainText('Low');
		// The mode and the other model options are popups of the same kind; Fast mode is an On | Off switch.
		const mode = sheet.getByRole('button', { name: 'Mode', exact: true });
		await mode.click();
		await expect(page.getByRole('listbox', { name: 'Mode' }).getByRole('option')).toHaveCount(5);
		await page.getByRole('option', { name: 'Plan', exact: true }).click();
		await expect(mode).toContainText('Plan');
		const fast = sheet.getByRole('radiogroup', { name: 'Fast mode', exact: true });
		await expect(fast.getByRole('radio', { name: 'Off', exact: true })).toHaveAttribute(
			'aria-checked',
			'true'
		);
		await fast.getByRole('radio', { name: 'On', exact: true }).click();
		await expect(fast.getByRole('radio', { name: 'On', exact: true })).toHaveAttribute(
			'aria-checked',
			'true'
		);
		// spec/tasks#isolation: the worktree fields exist only for Worktree.
		const branchField = sheet.getByRole('textbox', { name: 'Branch name', exact: true });
		await expect(sheet.getByRole('radio', { name: 'No isolation', exact: true })).toHaveAttribute(
			'aria-checked',
			'true'
		);
		await expect(branchField).toBeHidden();
		await expect(sheet.getByRole('button', { name: 'Base ref', exact: true })).toBeHidden();
		await sheet.getByRole('radio', { name: 'Worktree', exact: true }).click();
		await expect(branchField).toBeVisible();
		await expect(sheet.getByRole('button', { name: 'Base ref', exact: true })).toBeVisible();
		await sheet.getByRole('radio', { name: 'No isolation', exact: true }).click();
		await expect(branchField).toBeHidden();
		await sheet
			.getByRole('textbox', { name: 'Message', exact: true })
			.fill('Use the chosen effort');
		await sheet.getByRole('button', { name: 'Start', exact: true }).click();
		await expect(sheet).toHaveCount(0);
		const task = await page.evaluate(async () => (await window.brigadir.readWorkspace()).tasks[0]!);
		await expect
			.poll(
				async () =>
					(await page.evaluate((task) => window.brigadir.readSession(task), task)).records.filter(
						(record) => record.event.kind === 'turn.completed'
					).length,
				{ timeout: 30000 }
			)
			.toBe(1);
		// The session got the model first, then the effort that model has (spec/agents-and-providers#catalog p. 4).
		const changed = (await page.evaluate((task) => window.brigadir.readSession(task), task)).records
			.map((record) => record.event)
			.filter((event) => event.kind === 'options.changed')
			.at(-1) as { options: { id: string; value: unknown }[] } | undefined;
		expect(changed?.options.find((option) => option.id === 'model')?.value).toBe('other');
		expect(changed?.options.find((option) => option.id === 'effort')?.value).toBe('low');
		expect(changed?.options.find((option) => option.id === 'mode')?.value).toBe('plan');
		expect(changed?.options.find((option) => option.id === 'collaboration_mode')?.value).toBe(
			'default'
		);
		expect(changed?.options.find((option) => option.id === 'fast-mode')?.value).toBe('on');
		// p. 5: a built-in role takes a model and effort; name and instructions stay the app's.
		await app.evaluate(({ BrowserWindow }) => {
			BrowserWindow.getAllWindows()[0]!.webContents.send('workspace:action', 'settings-templates');
		});
		const settings = page.getByRole('dialog', { name: 'Settings' }),
			list = settings.getByRole('listbox', { name: 'Templates' });
		await list.getByRole('option', { name: /^Reviewer/ }).click();
		await expect(settings.getByRole('textbox', { name: 'Name' })).toBeDisabled();
		// spec/settings-modules-and-onboarding#agents-tab: a built-in's role is read-only (readable and copyable), not a disabled field.
		await expect(settings.getByRole('textbox', { name: 'Instructions' })).not.toBeEditable();
		await expect(settings.getByRole('button', { name: 'Reset', exact: true })).toHaveCount(0);
		const templateModel = settings.getByRole('button', { name: 'Model', exact: true });
		await expect(templateModel).toBeEnabled();
		await templateModel.click();
		await page.getByRole('option', { name: 'Other', exact: true }).click();
		await settings.getByRole('button', { name: 'Effort', exact: true }).click();
		await expect(page.getByRole('listbox', { name: 'Effort' }).getByRole('option')).toHaveText([
			'Low',
			'Medium',
		]);
		await page.getByRole('option', { name: 'Medium', exact: true }).click();
		const stored = () =>
			readFile(join(data, 'templates', 'builtin', 'reviewer.json'), 'utf8').then(
				(text) => JSON.parse(text).template,
				() => null
			);
		await expect.poll(stored).toEqual({
			id: 'reviewer',
			choices: { configOptions: { model: 'other', effort: 'medium' } },
			choiceNames: { model: 'Other', effort: 'Medium' },
		});
		// p. 6: a model without effort drops it.
		await templateModel.click();
		await page.getByRole('option', { name: 'Lite', exact: true }).click();
		await expect(settings.getByRole('button', { name: 'Effort', exact: true })).toHaveCount(0);
		await expect.poll(stored).toEqual({
			id: 'reviewer',
			choices: { configOptions: { model: 'lite' } },
			choiceNames: { model: 'Lite' },
		});
		// The built-in crew resolves through the overlaid role: its reviewer shows the chosen model on the sheet.
		await settings.getByRole('button', { name: 'Close', exact: true }).click();
		await expect(settings).toHaveCount(0);
		await page.getByRole('button', { name: 'New task · repo', exact: true }).click();
		await sheet.getByRole('radio', { name: 'Brigadir' }).click();
		await sheet.getByRole('button', { name: 'Crew', exact: true }).click();
		await sheet
			.getByRole('listbox', { name: 'Crew' })
			.getByRole('option', { name: /^Crew \d/ })
			.click();
		await expect(sheet.locator('[data-crew-roster] [title="Reviewer · Lite"]')).toHaveCount(1);
		await sheet.getByRole('button', { name: 'Cancel' }).click();
		await expect(sheet).toHaveCount(0);
		// Reset returns the provider defaults and removes the file.
		await app.evaluate(({ BrowserWindow }) => {
			BrowserWindow.getAllWindows()[0]!.webContents.send('workspace:action', 'settings-templates');
		});
		await list.getByRole('option', { name: /^Reviewer/ }).click();
		await settings.getByRole('button', { name: 'Reset', exact: true }).click();
		await expect.poll(stored).toBeNull();
		await expect(settings.getByRole('button', { name: 'Reset', exact: true })).toHaveCount(0);
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
