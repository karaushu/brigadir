import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
const desktop = resolve('apps/desktop'),
	executablePath = createRequire(join(desktop, 'package.json'))('electron') as string;
type Log = {
	shown: {
		notice: {
			id: string;
			groupId: string;
			kind: string;
			title: string;
			body: string;
			actions: { allow: string | null; deny: string | null };
		};
		closed: boolean;
	}[];
	sounds: string[];
	removedGroups: string[];
	badges: number[];
	active: boolean | null;
	permission: string;
	requests: number;
};
test('notifications settings persist and live delivery follows spec/sidebar#layout scope, suppression, actions, badge, spec/notifications-slack-notes-and-schedules#macos-permission permission and restart rules @area:settings', async ({}, info) => {
	test.setTimeout(180000);
	const root = await mkdtemp(join(tmpdir(), 'brigadir-notifications-ui-')),
		repo = join(root, 'repo'),
		data = join(root, 'data'),
		dir = join(data, 'projects/project/tasks/task'),
		settingsFile = join(data, 'settings.json');
	await mkdir(repo);
	await mkdir(dir, { recursive: true });
	await mkdir(join(data, 'projects/project/tasks/other'), { recursive: true });
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
				title: 'Notify fixture',
				status: 'done',
				provider: 'claude',
			},
		})
	);
	await writeFile(
		join(data, 'projects/project/tasks/other/task.json'),
		JSON.stringify({
			schemaVersion: 1,
			task: {
				id: 'other',
				projectId: 'project',
				title: 'Other task',
				status: 'done',
				provider: 'claude',
			},
		})
	);
	await writeFile(
		settingsFile,
		JSON.stringify({ schemaVersion: 1, settings: { appearance: 'light', language: 'en' } })
	);
	const env = Object.fromEntries(
		Object.entries(process.env).filter(
			(entry): entry is [string, string] =>
				typeof entry[1] === 'string' && entry[0] !== 'ELECTRON_RUN_AS_NODE'
		)
	);
	const launch = () =>
		electron.launch({
			executablePath,
			args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
			env: {
				...env,
				BRIGADIR_DATA_DIR: data,
				BRIGADIR_TEST_NOTIFICATIONS: '1',
				BRIGADIR_TEST_NOTIFICATION_PERMISSION: 'not-determined',
				BRIGADIR_TEST_ATTENTION_MS: '600',
				BRIGADIR_TEST_AGENT: resolve('packages/transport/fixtures/agent.mjs'),
			},
		});
	let app = await launch();
	const key = { projectId: 'project', id: 'task' };
	const log = () =>
		app.evaluate(() => {
			const log = (globalThis as any).brigadirNotifications as Log;
			return {
				shown: log.shown.map((entry) => ({ notice: entry.notice, closed: entry.closed })),
				sounds: log.sounds,
				removedGroups: log.removedGroups,
				badges: log.badges,
				active: log.active,
				permission: log.permission,
				requests: log.requests,
			};
		});
	const setPermission = async (value: string) => {
		await app.evaluate(({}, value) => {
			(globalThis as any).brigadirNotifications.permission = value;
		}, value);
		await app.windows()[0]!.evaluate(() => window.brigadir.readNotificationPermission());
	};
	const act = (index: number, action: 'open' | 'allow' | 'deny') =>
		app.evaluate(
			({}, { index, action }) => {
				(globalThis as any).brigadirNotifications.shown[index].handlers[action]();
			},
			{ index, action }
		);
	try {
		let page = await app.firstWindow();
		const errors: string[] = [];
		const card = () => page.locator('[data-sidebar-task="task"]');
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
		await page.getByRole('button', { name: /Notify fixture/ }).click();
		await expect(card()).not.toHaveAttribute('data-attention', /./);
		await expect(
			page
				.locator('[data-toast-region] [data-toast-id]')
				.filter({ hasText: 'Notifications are off in system settings' })
		).toHaveCount(0);
		await action('settings');
		const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
		await dialog.getByRole('tab', { name: 'Appearance', exact: true }).press('ArrowRight');
		await dialog.getByRole('tab', { name: 'Editor', exact: true }).press('ArrowRight');
		await dialog.getByRole('tab', { name: 'Language', exact: true }).press('ArrowRight');
		await expect(dialog.getByRole('tab', { name: 'Notifications', exact: true })).toBeFocused();
		await expect(dialog.getByRole('button', { name: 'When', exact: true })).toHaveText(
			'When you are needed'
		);
		await expect(dialog.locator('[data-notification-permission]')).toHaveText(
			'Not requested yet' + 'Allow'
		);
		await expect(dialog.getByRole('button', { name: 'Needs you', exact: true })).toHaveText('Ping');
		await expect(dialog.getByRole('button', { name: 'Turn ended', exact: true })).toHaveText(
			'Tink'
		);
		await expect(dialog.getByRole('button', { name: 'Error', exact: true })).toHaveText('Basso');
		await expect(
			dialog.getByRole('switch', { name: 'Mute the task being viewed', exact: true })
		).toHaveAttribute('aria-checked', 'true');
		await expect
			.poll(() => dialog.evaluate((node) => node.getBoundingClientRect().height))
			.toBe(560);
		// The catalog comes from the Mac itself; a system sound is always present on macOS.
		await dialog.getByRole('button', { name: 'Error', exact: true }).click();
		const options = dialog.getByRole('option');
		await expect(options.first()).toHaveText('None');
		expect(await options.count()).toBeGreaterThan(2);
		await options.first().click();
		await expect
			.poll(
				async () =>
					JSON.parse(await readFile(settingsFile, 'utf8')).settings.notifications?.sounds?.failed
			)
			.toBe(null);
		await dialog.getByRole('button', { name: 'Error', exact: true }).click();
		await dialog.getByRole('option', { name: 'Basso', exact: true }).click();
		await expect.poll(async () => (await log()).sounds).toEqual(['Basso']);
		// spec/notifications-slack-notes-and-schedules#macos-permission: one picker; Never hides the permission row, and nothing asks macOS until the first need.
		await dialog.getByRole('button', { name: 'When', exact: true }).click();
		await expect(dialog.getByRole('option')).toHaveText([
			'NeverNotifications are off.',
			'When you are neededThe agent asks a question or asks for permission.',
			'When a turn endsWhen the agent finishes each turn.',
		]);
		await expect(
			dialog.getByRole('option', { name: 'Never', exact: true })
		).toHaveAccessibleDescription('Notifications are off.');
		await dialog.getByRole('option', { name: 'Never', exact: true }).click();
		await expect(dialog.locator('[data-notification-permission]')).toHaveCount(0);
		await expect
			.poll(
				async () => JSON.parse(await readFile(settingsFile, 'utf8')).settings.notifications?.mode
			)
			.toBe('off');
		await setPermission('denied');
		await expect(dialog.getByRole('alert')).toHaveCount(0);
		await expect(
			page
				.locator('[data-toast-region] [data-toast-id]')
				.filter({ hasText: 'Notifications are off in system settings' })
		).toHaveCount(0);
		await dialog.getByRole('button', { name: 'When', exact: true }).click();
		await dialog.getByRole('option', { name: 'When you are needed', exact: true }).click();
		await expect(dialog.getByRole('alert')).toHaveText(
			'Brigadir notifications are off in system settings.Open System Settings'
		);
		await expect(
			dialog.getByRole('button', { name: 'Open System Settings', exact: true })
		).toHaveCount(1);
		const banner = page
			.locator('[data-toast-region] [data-toast-id]')
			.filter({ hasText: 'Notifications are off in system settings' });
		await expect(banner).toContainText('Notifications are off in system settings');
		for (const theme of ['light', 'dark'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => (nativeTheme.themeSource = theme), theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await dialog.screenshot({
				animations: 'disabled',
				path: info.outputPath(`notifications-denied-${theme}.png`),
			});
		}
		await setPermission('not-determined');
		await expect(banner).toHaveCount(0);
		await expect(dialog.locator('[data-notification-permission]')).toHaveText(
			'Not requested yet' + 'Allow'
		);
		expect((await log()).requests).toBe(0);
		for (const theme of ['light', 'dark'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => (nativeTheme.themeSource = theme), theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await dialog.screenshot({
				animations: 'disabled',
				path: info.outputPath(`notifications-${theme}.png`),
			});
		}
		await app.evaluate(({ nativeTheme }) => (nativeTheme.themeSource = 'light'));
		await dialog.getByRole('button', { name: 'Close', exact: true }).click();
		await setPermission('denied');
		await expect(banner).toBeVisible();
		await banner.screenshot({
			animations: 'disabled',
			path: info.outputPath('notifications-toast.png'),
		});
		await banner.getByRole('button', { name: 'Close', exact: true }).click();
		await expect(banner).toHaveCount(0);
		await setPermission('not-determined');
		// Live delivery: the fixture agent asks a permission; the visible task is suppressed only while the app is active.
		await page.getByRole('button', { name: 'Start', exact: true }).click();
		const message = page.getByRole('textbox', { name: 'Message', exact: true });
		await expect(page.getByRole('button', { name: 'Start', exact: true })).toHaveCount(0);
		await expect(message).toHaveAttribute('aria-busy', 'false');
		await app.evaluate(() => {
			(globalThis as any).brigadirNotifications.active = true;
		});
		await message.fill('permission');
		await message.press('Enter');
		await expect(page.getByRole('heading', { name: 'Write example' })).toBeVisible({
			timeout: 20000,
		});
		await expect.poll(async () => (await log()).badges.at(-1)).toBe(1);
		expect((await log()).shown).toHaveLength(0);
		expect((await log()).sounds).toEqual(['Basso']);
		await page.getByRole('button', { name: 'Deny', exact: true }).click();
		await expect.poll(async () => (await log()).badges.at(-1)).toBe(0);
		await expect(message).toHaveAttribute('aria-busy', 'false');
		// Inactive app: the notice appears with one-time actions and its sound; Allow answers the live request.
		await app.evaluate(() => {
			(globalThis as any).brigadirNotifications.active = false;
		});
		await message.fill('permission');
		await message.press('Enter');
		await expect(page.getByRole('heading', { name: 'Write example' })).toBeVisible({
			timeout: 20000,
		});
		await expect.poll(async () => (await log()).shown.length).toBe(1);
		await expect(card()).toHaveAttribute('data-attention', 'needs-you');
		// spec/crew#attention: while the person looks elsewhere, the waiting row flashes again on each beat (30 s, here 600 ms).
		await page.getByRole('button', { name: /Other task/ }).click();
		await expect(card()).toHaveAttribute('data-attention-beat', '1');
		await expect(card()).toHaveAttribute('data-attention-beat', '0');
		await card().click();
		await expect(page.getByRole('heading', { name: 'Write example' })).toBeVisible();
		let state = await log();
		expect(state.requests).toBe(1);
		expect(state.permission).toBe('granted');
		expect(state.shown[0]!.notice).toMatchObject({
			groupId: 'project/task',
			kind: 'needs-you',
			title: 'Notify fixture',
			body: 'Write example · The agent is waiting for permission.',
			actions: { allow: 'Allow', deny: 'Deny' },
		});
		expect(state.sounds).toEqual(['Basso', 'Ping']);
		expect(state.badges.at(-1)).toBe(1);
		await act(0, 'allow');
		await expect(page.getByRole('log')).toContainText('world');
		await expect.poll(async () => (await log()).badges.at(-1)).toBe(0);
		expect((await log()).shown[0]!.closed).toBe(true);
		await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
		// Turn end is outside the default scope; widening scope and sound mode notifies once per turn.
		expect((await log()).shown).toHaveLength(1);
		await page.evaluate(async () => {
			const { settings } = await window.brigadir.readSettings();
			await window.brigadir.saveSettings({
				...settings,
				notifications: { ...settings.notifications, mode: 'turn-ended', soundMode: 'turn-ended' },
			});
		});
		await message.fill('hello');
		await message.press('Enter');
		await expect.poll(async () => (await log()).shown.length).toBe(2);
		await expect(card()).toHaveAttribute('data-attention', 'turn-ended');
		state = await log();
		expect(state.requests).toBe(1);
		expect(state.shown[1]!.notice).toMatchObject({
			id: 'project/task/turn-ended',
			body: 'The turn ended.',
			actions: { allow: null, deny: null },
		});
		expect(state.sounds).toEqual(['Basso', 'Ping', 'Tink']);
		await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
		// Open selects the task and clears its group; the badge counts pending tasks.
		await page.getByRole('button', { name: /Other task/ }).click();
		await expect(page.getByRole('button', { name: /Other task/ })).toHaveAttribute(
			'aria-pressed',
			'true'
		);
		await act(1, 'open');
		await expect(page.getByRole('button', { name: /Notify fixture/ })).toHaveAttribute(
			'aria-pressed',
			'true'
		);
		expect((await log()).removedGroups).toEqual(['project/task']);
		// Leave a permission pending across restart: the journal must not re-notify, but the badge is seeded.
		await message.fill('permission');
		await message.press('Enter');
		await expect(page.getByRole('heading', { name: 'Write example' })).toBeVisible({
			timeout: 20000,
		});
		await expect.poll(async () => (await log()).shown.length).toBe(3);
		await page.evaluate(async () => {
			const { settings } = await window.brigadir.readSettings();
			await window.brigadir.saveSettings({ ...settings, language: 'uk' });
		});
		await app.close();
		app = await launch();
		page = await app.firstWindow();
		page.on('pageerror', (error) => errors.push(error.message));
		await page.getByRole('button', { name: /Notify fixture/ }).click();
		await expect(page.getByRole('heading', { name: 'Write example' })).toBeVisible();
		await expect.poll(async () => (await log()).badges.at(-1)).toBe(1);
		expect((await log()).shown).toHaveLength(0);
		expect((await log()).sounds).toEqual([]);
		await expect(card()).not.toHaveAttribute('data-attention', /./);
		await page.getByRole('button', { name: 'Allow', exact: true }).click();
		await expect(page.getByRole('log').last()).toContainText('world');
		await expect.poll(async () => (await log()).badges.at(-1)).toBe(0);
		await action('settings');
		const uk = page.getByRole('dialog', { name: 'Налаштування', exact: true });
		await uk.getByRole('tab', { name: 'Сповіщення', exact: true }).click();
		await expect(uk.getByRole('button', { name: 'Коли', exact: true }).first()).toHaveText(
			'Кінець турну'
		);
		await expect(
			uk.getByRole('switch', { name: 'Без сповіщень у відкритій задачі', exact: true })
		).toBeVisible();
		await uk.screenshot({ animations: 'disabled', path: info.outputPath('notifications-uk.png') });
		expect(JSON.parse(await readFile(settingsFile, 'utf8')).settings.notifications).toEqual({
			mode: 'turn-ended',
			soundMode: 'turn-ended',
			sounds: { needsYou: 'Ping', turnEnded: 'Tink', failed: 'Basso' },
			muteVisibleTask: true,
		});
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
