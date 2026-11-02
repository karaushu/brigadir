import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { editorText } from './editor-text';
const desktop = resolve('apps/desktop'),
	executablePath = createRequire(join(desktop, 'package.json'))('electron') as string;
test('concurrency limit queues starts beyond the limit, survives restart, promotes with the stored prompt and the composer offers ghost suggestions @area:chat', async ({}, info) => {
	test.setTimeout(180000);
	const root = await mkdtemp(join(tmpdir(), 'brigadir-agent-limit-ui-')),
		repo = join(root, 'repo'),
		data = join(root, 'data'),
		dir = join(data, 'projects/project/tasks/task'),
		settingsFile = join(data, 'settings.json');
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
				title: 'Holder task',
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
				BRIGADIR_TEST_AGENT: resolve('packages/transport/fixtures/agent.mjs'),
			},
		});
	let app = await launch();
	const holder = { projectId: 'project', id: 'task' };
	let created: { projectId: string; id: string } | null = null;
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
		await page.getByRole('button', { name: /Holder task/ }).click();
		await action('settings');
		const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
		await dialog.getByRole('tab', { name: 'Agents', exact: true }).click();
		const stepper = dialog.getByRole('spinbutton', { name: 'Concurrent agents', exact: true });
		await expect(stepper).toHaveValue('Unlimited');
		await stepper.press('ArrowUp');
		await expect(stepper).toHaveValue('1');
		await expect
			.poll(
				async () => JSON.parse(await readFile(settingsFile, 'utf8')).settings.agents?.maxConcurrent
			)
			.toBe(1);
		await dialog.screenshot({ animations: 'disabled', path: info.outputPath('agents-limit.png') });
		await dialog.getByRole('button', { name: 'Close', exact: true }).click();
		// The holder occupies the only slot with a never-ending turn.
		await page.getByRole('button', { name: 'Start', exact: true }).click();
		const message = page.getByRole('textbox', { name: 'Message', exact: true });
		await expect(page.getByRole('button', { name: 'Start', exact: true })).toHaveCount(0);
		await expect(message).toHaveAttribute('aria-busy', 'false');
		await message.fill('hold');
		await message.press('Enter');
		await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
		await page.getByRole('button', { name: 'New task · repository', exact: true }).click();
		const form = page.getByRole('dialog', { name: 'New task', exact: true });
		await form.getByRole('textbox', { name: 'Message', exact: true }).fill('Second prompt');
		await form.getByRole('button', { name: 'Start', exact: true }).click();
		const second = page.getByRole('button', { name: /Second prompt/ });
		await expect(second).toHaveAttribute('aria-pressed', 'true');
		await expect(
			page.getByRole('status').filter({ hasText: 'Waiting for a free slot.' })
		).toBeVisible();
		created = await page.evaluate(async () => {
			const task = (await window.brigadir.readWorkspace()).tasks.find(
				(task) => task.title === 'Second prompt'
			)!;
			return { projectId: task.projectId, id: task.id };
		});
		expect(
			JSON.parse(
				await readFile(join(data, 'projects/project/tasks', created.id, 'task.json'), 'utf8')
			).task.status
		).toBe('queued');
		expect(JSON.parse(await readFile(join(data, 'launch-queue.json'), 'utf8')).queue).toEqual([
			created,
		]);
		await expect(page.getByRole('button', { name: 'Start', exact: true })).toHaveCount(0);
		await page
			.locator('main')
			.screenshot({ animations: 'disabled', path: info.outputPath('queued-task.png') });
		// Restart: the queue is restored and the holder still blocks it.
		await app.close();
		app = await launch();
		page = await app.firstWindow();
		page.on('pageerror', (error) => errors.push(error.message));
		await page.getByRole('button', { name: /Second prompt/ }).click();
		await expect(
			page.getByRole('status').filter({ hasText: 'Waiting for a free slot.' })
		).toBeVisible();
		await page.getByRole('button', { name: /Holder task/ }).click();
		await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
		await page.getByRole('button', { name: 'Stop', exact: true }).click();
		// The freed slot promotes the queued task, which receives its stored first prompt.
		await page.getByRole('button', { name: /Second prompt/ }).click();
		await expect(page.getByRole('log')).toContainText('world', { timeout: 30000 });
		await expect(page.getByRole('log')).toContainText('Second prompt');
		expect(JSON.parse(await readFile(join(data, 'launch-queue.json'), 'utf8')).queue).toEqual([]);
		// Ghost suggestion: unsent review comments after the turn, Esc dismisses for this turn only, Tab sends the review.
		const composer = page.getByRole('textbox', { name: 'Message', exact: true });
		await expect(composer).toHaveAttribute(
			'aria-placeholder',
			'↩ send · ⇧↩ new line · @ files · / commands'
		);
		// Review state reloads with the turn, exactly as comments added from the diff do.
		await page.evaluate(
			(key) => window.brigadir.addReviewNote(key, 'Please also update the docs.'),
			created
		);
		await composer.fill('again');
		await composer.press('Enter');
		await expect(page.getByRole('log')).toContainText('again');
		await expect(composer).toHaveAttribute('aria-placeholder', 'Submit review (1 comment)', {
			timeout: 15000,
		});
		await expect(composer).toHaveAttribute('data-ghost', 'review');
		await expect.poll(() => editorText(composer)).toBe('');
		await page
			.locator('form')
			.screenshot({ animations: 'disabled', path: info.outputPath('ghost-review.png') });
		await composer.focus();
		await composer.press('Escape');
		await expect(composer).toHaveAttribute(
			'aria-placeholder',
			'↩ send · ⇧↩ new line · @ files · / commands'
		);
		await composer.fill('once more');
		await composer.press('Enter');
		await expect(page.getByRole('log')).toContainText('once more');
		await expect(composer).toHaveAttribute('aria-placeholder', 'Submit review (1 comment)', {
			timeout: 15000,
		});
		await composer.fill('typing');
		await expect(composer).toHaveAttribute(
			'aria-placeholder',
			'↩ send · ⇧↩ new line · @ files · / commands'
		);
		await composer.fill('');
		await expect(composer).toHaveAttribute('aria-placeholder', 'Submit review (1 comment)');
		await composer.press('Tab');
		await expect(page.getByRole('log')).toContainText('Please also update the docs.', {
			timeout: 15000,
		});
		await expect(composer).toHaveAttribute(
			'aria-placeholder',
			'↩ send · ⇧↩ new line · @ files · / commands'
		);
		expect(errors).toEqual([]);
	} finally {
		try {
			const page = app.windows()[0];
			if (page) {
				for (const key of [holder, created])
					if (key)
						await page.evaluate(
							(key) => window.brigadir.sendCommand(key, { kind: 'shutdown' }).catch(() => {}),
							key
						);
			}
		} catch {}
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
