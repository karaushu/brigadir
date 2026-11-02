import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
const desktop = resolve('apps/desktop'),
	executablePath = createRequire(join(desktop, 'package.json'))('electron') as string,
	env = Object.fromEntries(
		Object.entries(process.env).filter(
			(entry): entry is [string, string] =>
				typeof entry[1] === 'string' && entry[0] !== 'ELECTRON_RUN_AS_NODE'
		)
	);
test('structured quota blocks composer, preserves draft and FIFO, resets once and survives reattach without inventing a deadline @area:chat', async ({}, info) => {
	test.setTimeout(60000);
	const root = await mkdtemp(join(tmpdir(), 'brigadir-quota-ui-')),
		repo = join(root, 'repo'),
		data = join(root, 'data'),
		dir = join(data, 'projects/project/tasks/task'),
		key = { projectId: 'project', id: 'task' };
	await mkdir(repo);
	await mkdir(dir, { recursive: true });
	await writeFile(
		join(dir, 'task.json'),
		JSON.stringify({
			schemaVersion: 1,
			task: { ...key, title: 'Quota fixture', status: 'done', provider: 'claude' },
		})
	);
	await writeFile(
		join(dir, '../../project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'repo', path: repo } })
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
				BRIGADIR_FIXTURE_RESET_MS: '8000',
			},
		});
	let app = await launch();
	try {
		let page = await app.firstWindow();
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		await page.getByRole('button', { name: /Quota fixture/ }).click();
		await page.getByRole('button', { name: 'Start', exact: true }).click();
		let message = page.getByRole('textbox', { name: 'Message', exact: true });
		await expect(message).toHaveAttribute('aria-busy', 'false');
		await expect(page.getByRole('button', { name: 'Start', exact: true })).toHaveCount(0);
		const begin = async (text: string) => {
			const seq = await page.evaluate(
				async (key) => (await window.brigadir.readSession(key)).records.at(-1)?.seq ?? 0,
				key
			);
			await message.fill(text);
			await message.press('Enter');
			await expect
				.poll(async () =>
					page.evaluate(
						async ({ key, seq }) =>
							(await window.brigadir.readSession(key)).records.some(
								(record) =>
									record.seq > seq &&
									record.event.kind === 'message.delta' &&
									record.event.content.kind === 'text' &&
									record.event.content.text === 'Quota fixture ready'
							),
						{ key, seq }
					)
				)
				.toBe(true);
		};
		await begin('limit-known');
		await message.fill('explicit queued message');
		await message.press('Enter');
		await expect(
			page.getByRole('region', { name: 'Queued messages' }).getByRole('listitem')
		).toHaveCount(1);
		await message.fill('Keep my unsent draft');
		await page.evaluate((key) => window.brigadir.sendCommand(key, { kind: 'cancel' }), key);
		// spec/notifications-slack-notes-and-schedules#notice-chips: no banner — the chip in the composer footer, its popover opens by itself once on the new limit.
		let banner = page.locator('[data-rate-chip]');
		const popover = page.locator('[data-notice-popover="auto"]');
		await expect(banner).toHaveText('Limit · 1 min');
		await expect(popover).toContainText('Resets in 1 min');
		await expect(popover).toContainText('Queued messages resume after the limit resets.');
		await expect(popover.getByRole('button', { name: 'Got it', exact: true })).toBeVisible();
		await expect(page.locator('[data-rate-banner]')).toHaveCount(0);
		await expect(message).toBeDisabled();
		await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
		await expect(message).toHaveText('Keep my unsent draft');
		for (const theme of ['light', 'dark'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await page.screenshot({
				path: info.outputPath(`quota-${theme}.png`),
				animations: 'disabled',
			});
		}
		await expect(banner).toHaveCount(0, { timeout: 15000 });
		await expect(message).toBeEnabled();
		await expect(message).toHaveText('Keep my unsent draft');
		await expect(page.getByRole('region', { name: 'Queued messages' })).toHaveCount(0);
		await app.evaluate(({ Menu }) =>
			Menu.getApplicationMenu()!.getMenuItemById('composer')!.click()
		);
		await expect(message).toBeFocused();
		const turns = await page.evaluate(
			async (key) =>
				(await window.brigadir.readSession(key)).records.flatMap((record) =>
					record.event.kind === 'turn.started' ? [record.event.text] : []
				),
			key
		);
		expect(turns).toEqual(['limit-known', 'explicit queued message']);
		await begin('limit-warning');
		await message.fill('after warning');
		await message.press('Enter');
		await page.evaluate((key) => window.brigadir.sendCommand(key, { kind: 'cancel' }), key);
		await expect(page.getByRole('region', { name: 'Queued messages' })).toHaveCount(0);
		await expect(message).toBeEnabled();
		await expect(banner).toHaveCount(0);
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await begin('limit-unknown');
		await page.evaluate((key) => window.brigadir.sendCommand(key, { kind: 'cancel' }), key);
		await expect(banner).toHaveText('Limit · —');
		await expect(popover).toContainText('Reset time is unavailable. Waiting for the provider.');
		await page.screenshot({
			path: info.outputPath('quota-unknown-dark.png'),
			animations: 'disabled',
		});
		await app.close();
		await writeFile(
			join(data, 'settings.json'),
			JSON.stringify({ schemaVersion: 1, settings: { language: 'uk', appearance: 'light' } })
		);
		app = await launch();
		page = await app.firstWindow();
		page.on('pageerror', (error) => errors.push(error.message));
		await page.getByRole('button', { name: /Quota fixture/ }).click();
		message = page.getByRole('textbox', { name: 'Повідомлення', exact: true });
		await expect(message).toBeDisabled();
		banner = page.locator('[data-rate-chip]');
		await expect(banner).toHaveText(/^Ліміт · /);
		for (const theme of ['light', 'dark'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await page.screenshot({
				path: info.outputPath(`quota-uk-${theme}.png`),
				animations: 'disabled',
			});
		}
		await page.evaluate(
			(key) => window.brigadir.sendCommand(key, { kind: 'setMode', modeId: 'manual' }),
			key
		);
		await expect(message).toBeEnabled();
		await expect(banner).toHaveCount(0);
		expect(errors).toEqual([]);
	} finally {
		try {
			const page = app.windows()[0];
			if (page)
				await page.evaluate((key) => window.brigadir.sendCommand(key, { kind: 'shutdown' }), key);
		} catch {}
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
const quotaWindow = (
	id: string,
	kind: string,
	remaining: number,
	resetsAt: number,
	observedAt: number,
	extra: Record<string, unknown> = {}
) => ({
	id,
	kind,
	model: null,
	minutes: kind === 'five-hour' ? 300 : 10080,
	remaining,
	resetsAt,
	exhausted: false,
	observedAt,
	...extra,
});
// spec/agents-and-providers#usage.
test('subscription limits show in the sidebar footer and the launch rail with one popover @area:chat', async ({}, info) => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-quota-')),
		data = join(root, 'data'),
		project = join(data, 'projects/project'),
		now = Date.now(),
		seconds = Math.round(now / 1000);
	await mkdir(join(project, 'tasks', 'task'), { recursive: true });
	await writeFile(
		join(project, 'project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'repository', path: root } })
	);
	await writeFile(
		join(project, 'tasks', 'task', 'task.json'),
		JSON.stringify({
			schemaVersion: 1,
			task: {
				id: 'task',
				projectId: 'project',
				title: 'Limits fixture',
				status: 'done',
				provider: 'claude',
			},
		})
	);
	const quota = {
		providers: [
			{
				provider: 'claude',
				plan: 'Team',
				access: 'subscription',
				windows: [
					quotaWindow('five_hour', 'five-hour', 0.38, seconds + (2 * 60 + 21) * 60, now - 120_000),
					quotaWindow('seven_day', 'weekly', 0.74, seconds + 5 * 86400, now - 120_000),
					quotaWindow('model:Fable', 'weekly-model', 0.18, seconds + 5 * 86400, now - 120_000, {
						model: 'Fable',
					}),
					quotaWindow('model:Opus', 'weekly-model', 0.02, seconds - 60, now - 120_000, {
						model: 'Opus',
					}),
				],
			},
			{
				provider: 'codex',
				plan: 'Business',
				access: 'subscription',
				windows: [quotaWindow('codex:10080', 'weekly', 0.07, seconds + 4 * 86400, now - 5_000)],
			},
		],
	};
	const app = await electron.launch({
		executablePath,
		args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
		env: { ...env, BRIGADIR_DATA_DIR: data, BRIGADIR_TEST_QUOTA: JSON.stringify(quota) },
	});
	try {
		const page = await app.firstWindow(),
			errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		await page.emulateMedia({ reducedMotion: 'no-preference' });
		// The tightest window per provider: Fable 18% (low) beats 5-hour 38%; the rolled-over Opus window is gone.
		const button = page.getByRole('button', {
			name: 'Subscription limits: Claude 18%, Codex 7% left',
			exact: true,
		});
		await expect(button).toBeVisible();
		const gauges = button.locator('[data-tone]');
		await expect(gauges).toHaveCount(2);
		await expect(gauges.nth(0)).toHaveAttribute('data-tone', 'low');
		await expect(gauges.nth(1)).toHaveAttribute('data-tone', 'critical');
		// spec/appearance#evolution-redesign: rings — Claude two (5 hours outside, the week inside), Codex one; the footer holds only them.
		await expect(button.locator('[data-provider=claude] [data-ring-tone]')).toHaveCount(2);
		await expect(button.locator('[data-provider=codex] [data-ring-tone]')).toHaveCount(1);
		await expect(button.locator('[data-provider=claude] [data-ring-tone]').first()).toHaveAttribute(
			'data-remaining',
			'38'
		);
		await expect(button.locator('[data-provider=claude] [data-ring-tone]').last()).toHaveAttribute(
			'data-remaining',
			'74'
		);
		const popup = page.getByRole('dialog', { name: 'Subscription limits', exact: true });
		await button.hover();
		await expect(popup).toBeVisible();
		await expect(popup).toContainText('Team');
		await expect(popup).toContainText('Fable');
		await expect(popup).not.toContainText('Opus');
		await expect(popup).toContainText('Business');
		await expect(popup.getByRole('progressbar', { name: 'Weekly · Fable' })).toHaveAttribute(
			'aria-valuenow',
			'18'
		);
		// Tone reaches the row itself, not only the footer gauge.
		const fable = popup.locator('[data-tone=low]').filter({ hasText: 'Weekly · Fable' });
		await expect(fable).toHaveCount(1);
		await page.mouse.move(700, 100);
		await expect(popup).toHaveCount(0);
		await button.click();
		await page.mouse.move(700, 100);
		await expect(popup).toBeVisible();
		await popup.getByRole('button', { name: 'Close', exact: true }).click();
		await expect(popup).toHaveCount(0);
		await expect(button).toBeFocused();
		await button.press('Enter');
		await expect(popup).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(popup).toHaveCount(0);
		await expect(button).toBeFocused();
		// spec/agents-and-providers#usage: the eye picks the window the indicator shows, per provider; the chosen one is accent and survives in quota-view.json.
		await button.click();
		await expect(popup).toBeVisible();
		const weeklyEye = popup.getByRole('button', {
				name: 'Show «Weekly · all models» in the indicator',
				exact: true,
			}),
			fiveEye = popup.getByRole('button', {
				name: 'Show «5-hour limit» in the indicator',
				exact: true,
			});
		await expect(weeklyEye).toHaveAttribute('aria-pressed', 'false');
		await weeklyEye.click();
		await expect(
			page.getByRole('button', {
				name: 'Subscription limits: Claude 74%, Codex 7% left',
				exact: true,
			})
		).toBeVisible();
		await expect(weeklyEye).toHaveAttribute('aria-pressed', 'true');
		await expect(popup).toBeVisible();
		await fiveEye.click();
		await expect(
			page.getByRole('button', {
				name: 'Subscription limits: Claude 38%, Codex 7% left',
				exact: true,
			})
		).toBeVisible();
		await expect(weeklyEye).toHaveAttribute('aria-pressed', 'false');
		await expect
			.poll(async () => JSON.parse(await readFile(join(data, 'quota-view.json'), 'utf8')).watch)
			.toEqual({ claude: 'five_hour', codex: null });
		await fiveEye.click();
		await expect(button).toBeVisible();
		await expect(fiveEye).toHaveAttribute('aria-pressed', 'false');
		await weeklyEye.click();
		await page.keyboard.press('Escape');
		await expect(popup).toHaveCount(0);
		const chosen = page.getByRole('button', {
			name: 'Subscription limits: Claude 74%, Codex 7% left',
			exact: true,
		});
		await expect(chosen).toBeFocused();
		await chosen.click();
		await popup
			.getByRole('button', { name: 'Show «Weekly · all models» in the indicator', exact: true })
			.click();
		await page.keyboard.press('Escape');
		await expect(button).toBeVisible();
		// The same component in the launch rail opens the same popover.
		// A retained popover exit ends by unmounting, which aborts its transition: wait for settled, not fulfilled.
		await page.getByRole('button', { name: 'New task · repository', exact: true }).click();
		const sheet = page.getByRole('dialog', { name: 'New task', exact: true });
		await expect(sheet).toBeVisible();
		await sheet.evaluate((node) =>
			Promise.allSettled(document.getAnimations().map((a) => a.finished))
		);
		const railButton = sheet.getByRole('button', {
			name: 'Subscription limits: Claude 18%, Codex 7% left',
			exact: true,
		});
		await expect(railButton).toBeVisible();
		await railButton.click();
		await expect(popup).toBeVisible();
		await popup.evaluate((node) => {
			for (const a of node.getAnimations()) a.finish();
		});
		await page.keyboard.press('Escape');
		await expect(popup).toHaveCount(0);
		await expect(sheet).toBeVisible();
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
