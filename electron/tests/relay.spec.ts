import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const desktop = resolve('apps/desktop'),
	executablePath = createRequire(join(desktop, 'package.json'))('electron') as string;
test('relay sheet previews/removes context, starts in a new worktree, links tasks and tolerates summary failure @area:tasks', async ({}, info) => {
	test.setTimeout(90000);
	const root = await mkdtemp(join(tmpdir(), 'brigadir-relay-ui-')),
		repo = join(root, 'repository'),
		data = join(root, 'data'),
		fixture = resolve('packages/transport/fixtures/agent.mjs');
	await mkdir(repo);
	const git = (...args: string[]) => promisify(execFile)('git', args, { cwd: repo });
	await git('init', '-b', 'main');
	await git('config', 'user.name', 'Fixture');
	await git('config', 'user.email', 'fixture@example.invalid');
	await writeFile(join(repo, 'read.txt'), 'baseline\n');
	await git('add', '.');
	await git('commit', '-m', 'Initial');
	await mkdir(join(data, 'projects/project'), { recursive: true });
	await writeFile(
		join(data, 'projects/project/project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'repository', path: repo } })
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
		env: { ...env, BRIGADIR_DATA_DIR: data, BRIGADIR_TEST_AGENT: fixture },
	});
	try {
		const page = await app.firstWindow(),
			errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		const source = await page.evaluate(async () => {
			const launch = {
				...(await window.brigadir.readLaunchSettings('project')),
				branch: '',
				baseRef: 'main',
			};
			const task = await window.brigadir.createTask(
				'project',
				'Original task',
				'claude',
				'gui',
				false,
				launch
			);
			await window.brigadir.startSession(task);
			return task;
		});
		await expect
			.poll(async () =>
				(await page.evaluate((task) => window.brigadir.readSession(task), source)).records.some(
					(record) => record.event.kind === 'turn.completed'
				)
			)
			.toBe(true);
		await writeFile(join(repo, 'read.txt'), 'baseline\nchanged\n');
		await writeFile(join(repo, 'new.txt'), 'a new file\n');
		await page.evaluate(
			(task) => window.brigadir.sendCommand(task, { kind: 'checkpoint' }),
			source
		);
		const openSource = async () => {
			await page
				.locator('aside')
				.getByRole('button', { name: /Original task/ })
				.filter({ has: page.locator('[class*=taskCopy]') })
				.click();
		};
		await openSource();
		const relay = async () => {
			await expect
				.poll(() =>
					app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('relay')!.enabled)
				)
				.toBe(true);
			await app.evaluate(({ Menu }) =>
				Menu.getApplicationMenu()!.getMenuItemById('relay')!.click()
			);
		};
		await relay();
		const sheet = page.getByRole('dialog', { name: 'New task', exact: true });
		await expect(sheet.getByText('Continuation of', { exact: false })).toContainText(
			'Original task'
		);
		await expect(sheet.getByRole('button', { name: 'Start', exact: true })).toBeEnabled();
		const summaryChip = sheet.getByRole('button', { name: /Task summary/ });
		await summaryChip.focus();
		await page.keyboard.press('Enter');
		await expect(sheet.locator('pre')).toContainText('hello world');
		await expect(summaryChip).toBeFocused();
		await summaryChip.click();
		await expect
			.poll(() =>
				sheet.locator('[class*=preview]').evaluate((node) => node.getBoundingClientRect().height)
			)
			.toBeLessThan(1);
		const heights = await summaryChip.evaluate(async (button) => {
			const preview = button.closest('form')!.querySelector('[class*=preview]')!,
				values = [preview.getBoundingClientRect().height];
			(button as HTMLButtonElement).click();
			for (let i = 0; i < 24; i++) {
				await new Promise(requestAnimationFrame);
				values.push(preview.getBoundingClientRect().height);
			}
			return values;
		});
		expect(heights.some((height) => height > 1 && height < heights.at(-1)! - 1)).toBe(true);
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await summaryChip.click();
		await expect(sheet.locator('[class*=preview]')).toHaveCSS('transition-duration', '0s');
		await page.emulateMedia({ reducedMotion: 'no-preference' });
		await sheet.getByRole('button', { name: /Task diff/ }).click();
		await expect(sheet.locator('pre')).toContainText('new.txt');
		await expect(sheet.locator('pre')).not.toContainText('+a new file');
		await sheet.getByRole('checkbox', { name: 'Full patch', exact: true }).check();
		await expect(sheet.locator('pre')).toContainText('+a new file');
		await sheet.getByRole('button', { name: /Task diff/ }).click();
		await sheet.getByRole('textbox', { name: 'Message', exact: true }).fill('Continue the UI work');
		await sheet.getByRole('radio', { name: 'Worktree', exact: true }).click();
		await expect(sheet.getByText('As in Original task', { exact: true })).toBeVisible();
		const branch = await sheet
			.getByRole('textbox', { name: 'Branch name', exact: true })
			.inputValue();
		expect(branch).not.toBe(source.launch?.branch);
		for (const theme of ['light', 'dark'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await page.screenshot({ path: info.outputPath(`relay-sheet-${theme}.png`) });
		}
		await sheet.getByRole('button', { name: 'Start', exact: true }).click();
		await expect(sheet).toHaveCount(0);
		await expect
			.poll(
				async () =>
					(await page.evaluate(() => window.brigadir.readWorkspace())).tasks.find(
						(task) => task.continuesTaskId === source.id
					)?.status
			)
			.toBe('done');
		const next = (await page.evaluate(() => window.brigadir.readWorkspace())).tasks.find(
			(task) => task.continuesTaskId === source.id
		)!;
		/* spec/git#agent-branch-names: the empty field is an auto name, given by the agent at preparation. */ expect(
			branch
		).toBe('');
		expect(next.launch?.branch).toBe('brigadir/agent-named-branch');
		const turn = (
			await page.evaluate((task) => window.brigadir.readSession(task), next)
		).records.find((record) => record.event.kind === 'turn.started')!.event;
		expect(turn).toMatchObject({ text: 'Continue the UI work', attachments: expect.any(Array) });
		if (turn.kind === 'turn.started') expect(turn.attachments).toHaveLength(2);
		// spec/appearance#evolution-redesign: the relation is a chip in the second line of the task header, no strip over the chat.
		const header = page.locator('[data-task-repo-line]');
		await expect(page.locator('[data-task-main] > [data-relay-links]')).toHaveCount(0);
		await expect(
			header.getByRole('button', { name: /Continuation of.*Original task/ })
		).toBeVisible();
		await header.getByRole('button', { name: /Continuation of.*Original task/ }).click();
		await expect(
			header.getByRole('button', { name: /Continued in.*Continue the UI work/ })
		).toBeVisible();
		await expect(header.locator('[data-repo-chip]')).toBeVisible();
		await page.screenshot({ path: info.outputPath('relay-links-dark.png') });
		// A generation error is visible and is not retried silently; removable chips stay removed.
		await app.evaluate(() => {
			process.env.BRIGADIR_TEST_AGENT = '/missing/fixture-agent.mjs';
		});
		await relay();
		await expect(
			sheet.getByText('The summary could not be generated. You can start without it.')
		).toBeVisible();
		await expect(sheet.getByRole('button', { name: 'Start', exact: true })).toBeEnabled();
		await app.evaluate((_, fixture) => {
			process.env.BRIGADIR_TEST_AGENT = fixture;
		}, fixture);
		await sheet.getByRole('button', { name: 'Remove summary', exact: true }).click();
		await sheet.getByRole('button', { name: 'Remove diff', exact: true }).click();
		await expect(sheet.getByRole('textbox', { name: 'Message', exact: true })).toBeFocused();
		await sheet
			.getByRole('textbox', { name: 'Message', exact: true })
			.fill('Continuation without stale context');
		await sheet.getByRole('button', { name: 'Add to backlog', exact: true }).click();
		await sheet.getByRole('button', { name: 'Save', exact: true }).click();
		await expect(sheet).toHaveCount(0);
		const backlog = (await page.evaluate(() => window.brigadir.readWorkspace())).tasks.find(
			(task) => task.prompt === 'Continuation without stale context'
		)!;
		expect(backlog).toMatchObject({
			status: 'backlog',
			continuesTaskId: source.id,
			relaySelection: { summary: false, diff: false },
		});
		await expect(
			readFile(join(data, 'projects/project/tasks', backlog.id, 'relay.json'))
		).rejects.toThrow();
		await expect(
			page.locator(`[data-board-task="${backlog.id}"] [data-relay-links]`)
		).toContainText('Original task');
		// Two continuations: the first is the chip, the other is behind «+1» with the «Related tasks» menu of both.
		await openSource();
		const more = header.locator('[data-relay-more]');
		await expect(more).toHaveText('+1');
		await more.hover();
		const related = page.getByRole('menu', { name: 'Related tasks' });
		await expect(related.getByRole('menuitem', { name: /Continued in/ })).toHaveCount(2);
		await expect(
			related.getByRole('menuitem', { name: /Continuation without stale context/ })
		).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(related).toBeHidden();
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
