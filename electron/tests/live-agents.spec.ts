import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const desktop = resolve('apps/desktop'),
	executablePath = createRequire(join(desktop, 'package.json'))('electron') as string;
test('global live agents include idle hosts and other projects, pause queued work on stop and confirm process termination @area:tasks', async ({}, info) => {
	test.setTimeout(90000);
	const root = await mkdtemp(join(tmpdir(), 'brigadir-live-ui-')),
		data = join(root, 'data');
	for (const id of ['first', 'second', 'idle']) {
		const repo = join(root, id);
		await mkdir(repo);
		await promisify(execFile)('git', ['init', '-b', 'main'], { cwd: repo });
		await writeFile(join(repo, 'file'), 'baseline');
		await mkdir(join(data, 'projects', id), { recursive: true });
		await writeFile(
			join(data, 'projects', id, 'project.json'),
			JSON.stringify({ schemaVersion: 1, project: { id, name: id, path: repo } })
		);
	}
	await writeFile(
		join(data, 'settings.json'),
		JSON.stringify({ schemaVersion: 1, settings: { language: 'en', appearance: 'light' } })
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
				BRIGADIR_TEST_AGENT: resolve('packages/transport/fixtures/agent.mjs'),
			},
		});
	let app = await launch();
	try {
		let page = await app.firstWindow();
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		const start = async (project: string, title: string) => {
			const task = await page.evaluate(
				async ({ project, title }) => {
					const task = await window.brigadir.createTask(project, title, 'claude', 'gui', false);
					await window.brigadir.startSession(task);
					return task;
				},
				{ project, title }
			);
			await expect
				.poll(async () =>
					(await page.evaluate((task) => window.brigadir.readSession(task), task)).records.some(
						(record) => record.event.kind === 'turn.completed'
					)
				)
				.toBe(true);
			if (title === 'hold' || title === 'question')
				await page.evaluate(
					({ task, title }) => window.brigadir.sendCommand(task, { kind: 'prompt', text: title }),
					{ task, title }
				);
			return task;
		};
		const idle = await start('idle', 'Idle fixture');
		await expect
			.poll(
				async () =>
					(await page.evaluate(() => window.brigadir.readLiveAgents())).agents.find(
						(agent) => agent.key.id === idle.id
					)?.status
			)
			.toBe('done');
		const hold = await start('first', 'hold'),
			question = await start('second', 'question');
		await expect
			.poll(
				async () =>
					(await page.evaluate(() => window.brigadir.readLiveAgents())).agents.find(
						(agent) => agent.key.id === question.id
					)?.status
			)
			.toBe('needs-you');
		await page.evaluate(
			(task) =>
				window.brigadir.sendCommand(task, { kind: 'prompt', text: 'Do not run after Stop' }),
			hold
		);
		const original = (await page.evaluate(() => window.brigadir.readLiveAgents())).agents.find(
			(agent) => agent.key.id === hold.id
		)!;
		const trigger = page.locator('[data-agent-button]'),
			popup = page.getByRole('dialog', { name: 'Active agents', exact: true });
		await expect(trigger).toHaveAttribute('aria-label', 'Active agents · 3');
		const opacities = await trigger.evaluate(async (button) => {
			(button as HTMLButtonElement).click();
			const values: number[] = [];
			for (let i = 0; i < 16; i++) {
				await new Promise(requestAnimationFrame);
				const dialog = document.querySelector('dialog[open]');
				if (dialog) values.push(Number(getComputedStyle(dialog).opacity));
			}
			return values;
		});
		expect(opacities.some((value) => value > 0 && value < 1)).toBe(true);
		await expect(popup.locator('[data-live-agent]')).toHaveCount(3);
		await expect(popup.getByRole('region', { name: 'second', exact: true })).toBeVisible();
		await expect(popup.getByText('Waiting for a prompt', { exact: true })).toBeVisible();
		await expect(popup.getByText('Which color?', { exact: true })).toBeVisible();
		for (const theme of ['light', 'dark'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await page.screenshot({
				path: info.outputPath(`agents-${theme}.png`),
				animations: 'disabled',
			});
		}
		await page.keyboard.press('Escape');
		await expect(popup).not.toBeVisible();
		await expect(trigger).toBeFocused();
		await trigger.press('Enter');
		await page.waitForTimeout(30);
		await page.keyboard.press('Escape');
		await page.waitForTimeout(30);
		await trigger.press('Enter');
		await expect(popup).toBeVisible();
		const holdRow = popup.locator(`[data-live-agent="${hold.id}"]`);
		const width = await holdRow.evaluate((node) => node.getBoundingClientRect().width);
		await holdRow.getByRole('button', { name: 'Stop', exact: true }).focus();
		expect(await holdRow.evaluate((node) => node.getBoundingClientRect().width)).toBe(width);
		await page.keyboard.press('Enter');
		await expect
			.poll(
				async () =>
					(await page.evaluate(() => window.brigadir.readLiveAgents())).agents.find(
						(agent) => agent.key.id === hold.id
					)?.status
			)
			.toBe('interrupted');
		expect(
			(await page.evaluate(() => window.brigadir.readLiveAgents())).agents.find(
				(agent) => agent.key.id === hold.id
			)?.instance
		).toBe(original.instance);
		const stopped = await page.evaluate((task) => window.brigadir.readSession(task), hold);
		expect(stopped.records.some((record) => record.event.kind === 'queue.paused')).toBe(true);
		expect(stopped.records.filter((record) => record.event.kind === 'turn.started')).toHaveLength(
			2
		);
		await popup.getByRole('button', { name: 'Stop all', exact: true }).click();
		await expect
			.poll(
				async () =>
					(await page.evaluate(() => window.brigadir.readLiveAgents())).agents.filter((agent) =>
						['working', 'needs-you'].includes(agent.status)
					).length
			)
			.toBe(0);
		await expect(popup.locator('[data-live-agent]')).toHaveCount(3);
		const idleRow = popup.locator(`[data-live-agent="${idle.id}"]`);
		await idleRow
			.getByRole('button', { name: 'Agent actions · Idle fixture', exact: true })
			.focus();
		await page.keyboard.press('Enter');
		await popup
			.getByRole('menu', { name: 'Agent actions', exact: true })
			.getByRole('menuitem', { name: 'Force quit process…', exact: true })
			.click();
		await expect(
			idleRow.getByRole('group', { name: 'End this session?', exact: true })
		).toBeVisible();
		await expect(
			idleRow
				.getByRole('group', { name: 'End this session?', exact: true })
				.getByRole('button', { name: 'Cancel', exact: true })
		).toBeFocused();
		await page.screenshot({
			path: info.outputPath('agents-confirm-dark.png'),
			animations: 'disabled',
		});
		await page.keyboard.press('Escape');
		await expect(idleRow.getByRole('group')).toHaveCount(0);
		await idleRow
			.getByRole('button', { name: 'Agent actions · Idle fixture', exact: true })
			.focus();
		await page.keyboard.press('Shift+F10');
		await popup
			.getByRole('menu', { name: 'Agent actions', exact: true })
			.getByRole('menuitem', { name: 'Force quit process…', exact: true })
			.click();
		await idleRow.getByRole('button', { name: 'Force quit process', exact: true }).click();
		await expect(popup.locator('[data-live-agent]')).toHaveCount(2);
		await page.keyboard.press('Escape');
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await trigger.press('Enter');
		expect(
			await popup.evaluate((node) =>
				getComputedStyle(node)
					.transitionDuration.split(',')
					.every((value) => value.trim() === '0s')
			)
		).toBe(true);
		await popup
			.locator(`[data-live-agent="${question.id}"]`)
			.getByRole('button', { name: /question/ })
			.first()
			.click();
		await expect(page.getByRole('heading', { name: 'question', exact: true })).toBeVisible();
		await expect(trigger).toBeFocused();
		await trigger.press('Enter');
		await expect(popup.locator('[data-live-agent]')).toHaveCount(2);
		await page.keyboard.press('Escape');
		await app.close();
		await writeFile(
			join(data, 'settings.json'),
			JSON.stringify({ schemaVersion: 1, settings: { language: 'uk', appearance: 'light' } })
		);
		app = await launch();
		page = await app.firstWindow();
		page.on('pageerror', (error) => errors.push(error.message));
		const ukTrigger = page.locator('[data-agent-button]');
		await expect(ukTrigger).toHaveAttribute('aria-label', 'Активні агенти · 2');
		await ukTrigger.click();
		const ukPopup = page.getByRole('dialog', { name: 'Активні агенти', exact: true });
		await expect(ukPopup.locator('[data-live-agent]')).toHaveCount(2);
		for (const theme of ['light', 'dark'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await page.screenshot({
				path: info.outputPath(`agents-uk-${theme}.png`),
				animations: 'disabled',
			});
		}
		const badLock = join(data, 'projects', 'idle', 'tasks', idle.id, 'host.lock');
		await writeFile(badLock, '{"schemaVersion":99}');
		await expect(ukPopup.getByRole('alert')).toBeVisible();
		await page.screenshot({
			path: info.outputPath('agents-read-error-dark.png'),
			animations: 'disabled',
		});
		await rm(badLock);
		await ukPopup.getByRole('button', { name: 'Спробувати ще', exact: true }).click();
		await expect(ukPopup.getByRole('alert')).toHaveCount(0);
		expect(errors).toEqual([]);
	} finally {
		try {
			const page = await app.firstWindow();
			await page.evaluate(async () => {
				const conflict = await window.brigadir.readLaunchConflict();
				if (conflict) await window.brigadir.resolveLaunchConflict(conflict.id, 'cancel');
				for (const agent of (await window.brigadir.readLiveAgents()).agents)
					await window.brigadir.controlLiveAgent(agent, 'terminate').catch(() => {});
			});
		} catch {}
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
