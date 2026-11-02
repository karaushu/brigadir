import { openReview } from './open-review';
import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { editorText } from './editor-text';
import { showChat } from './layout';
const desktop = resolve('apps/desktop'),
	executablePath = createRequire(join(desktop, 'package.json'))('electron') as string;
test('composer edits a durable queue, parks it across restart, pauses failures and rejects editing a dispatched prompt @area:chat', async ({}, info) => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-prompt-queue-ui-')),
		repo = join(root, 'repo'),
		data = join(root, 'data'),
		dir = join(data, 'projects/project/tasks/task');
	await mkdir(repo);
	await mkdir(dir, { recursive: true });
	await writeFile(
		join(dir, 'task.json'),
		JSON.stringify({
			schemaVersion: 1,
			task: {
				id: 'task',
				projectId: 'project',
				title: 'Prompt queue fixture',
				status: 'done',
				provider: 'claude',
			},
		})
	);
	await writeFile(
		join(dir, '../../project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'repo', path: repo } })
	);
	const env = Object.fromEntries(
			Object.entries(process.env).filter(
				(e): e is [string, string] => typeof e[1] === 'string' && e[0] !== 'ELECTRON_RUN_AS_NODE'
			)
		),
		launch = () =>
			electron.launch({
				executablePath,
				args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
				env: {
					...env,
					BRIGADIR_DATA_DIR: data,
					BRIGADIR_TEST_AGENT: resolve('packages/transport/fixtures/agent.mjs'),
				},
			}),
		key = { projectId: 'project', id: 'task' };
	let app = await launch();
	try {
		let page = await app.firstWindow();
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		await page.getByRole('button', { name: /Prompt queue fixture/ }).click();
		await page.getByRole('button', { name: 'Start', exact: true }).click();
		let message = page.getByRole('textbox', { name: 'Message', exact: true });
		await expect(page.getByRole('button', { name: 'Start', exact: true })).toHaveCount(0);
		await expect(message).toHaveAttribute('aria-busy', 'false');
		async function submit(text: string) {
			await message.fill(text);
			await message.press('Enter');
			await expect.poll(() => editorText(message)).toBe('');
		}
		await submit('hold');
		await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
		await submit('first queued');
		await submit('to edit');
		await submit('to remove');
		let queue = page.getByRole('region', { name: 'Queued messages' });
		await expect(queue.getByRole('listitem')).toHaveCount(3);
		await message.fill('Already typing');
		await queue.getByRole('button', { name: 'Edit queued message' }).nth(1).click();
		await expect.poll(() => editorText(message)).toBe('Already typing\n\nto edit');
		await queue.getByRole('button', { name: 'Remove queued message' }).nth(1).click();
		await expect(queue.getByRole('listitem')).toHaveCount(1);
		await message.press('Enter');
		await expect(queue.getByRole('listitem')).toHaveCount(2);
		await page.evaluate(async (key) => {
			const asset = await window.brigadir.createAttachment(key, {
				kind: 'text',
				name: 'Queue context',
				text: 'Preserve this attachment.',
			});
			await window.brigadir.sendCommand(key, {
				kind: 'prompt',
				text: 'With context',
				attachmentIds: [asset.id],
			});
		}, key);
		await expect(queue.getByRole('listitem')).toHaveCount(3);
		await queue.getByRole('button', { name: 'Edit queued message' }).nth(2).click();
		await expect.poll(() => editorText(message)).toMatch(/^With context @\[att:[0-9a-f-]{36}\] $/);
		await expect(
			message.locator('[data-mention-pill]', { hasText: 'Queue context' })
		).toBeVisible();
		await message.press('Enter');
		await expect(queue.getByRole('button', { name: 'Queue context', exact: true })).toBeVisible();
		await page.evaluate(
			(key) => window.brigadir.addReviewNote(key, 'Review the queued result.'),
			key
		);
		await openReview(page);
		const review = page.getByRole('dialog', { name: 'Review', exact: true });
		await expect(review).toContainText('Review the queued result.');
		await review.getByRole('button', { name: 'Close', exact: true }).click();
		await page
			.locator('[data-review-footer]')
			.getByRole('button', { name: 'Send review', exact: true })
			.click();
		await showChat(page);
		await expect(queue.getByRole('listitem')).toHaveCount(4);
		await queue.getByRole('button', { name: 'Edit queued review' }).click();
		await expect(review).toContainText('Review the queued result.');
		await review.getByRole('button', { name: 'Close', exact: true }).click();
		await expect(queue.getByRole('listitem')).toHaveCount(3);
		for (const theme of ['light', 'dark'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await page.screenshot({
				animations: 'disabled',
				path: info.outputPath(`queue-${theme}.png`),
			});
		}
		await app.close();
		app = await launch();
		page = await app.firstWindow();
		page.on('pageerror', (error) => errors.push(error.message));
		await page.getByRole('button', { name: /Prompt queue fixture/ }).click();
		message = page.getByRole('textbox', { name: 'Message', exact: true });
		queue = page.getByRole('region', { name: 'Queued messages' });
		await expect(queue.getByRole('listitem')).toHaveCount(3);
		await expect(queue).toContainText('Already typing');
		await page.getByRole('button', { name: 'Stop', exact: true }).click();
		await expect(queue).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
		await submit('hold');
		await submit('fail');
		await submit('after failure');
		await page.getByRole('button', { name: 'Stop', exact: true }).click();
		await expect(queue).toContainText('The queue is paused.');
		await expect(queue.getByRole('listitem')).toHaveCount(1);
		await queue.getByRole('button', { name: 'Resume queue', exact: true }).click();
		await expect(queue).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
		await submit('hold');
		await submit('race');
		await message.fill('Keep this new draft');
		await app.evaluate(({ ipcMain }) => {
			const handlers = (ipcMain as any)._invokeHandlers,
				original = handlers.get('session:command');
			handlers.set('session:command', async (...args: any[]) => {
				if (args[2]?.kind === 'removeQueuedPrompt') {
					handlers.set('session:command', original);
					await new Promise<void>((resolve) => {
						(globalThis as any).releaseQueueRemove = resolve;
					});
				}
				return original(...args);
			});
		});
		await queue.getByRole('button', { name: 'Edit queued message' }).click();
		await expect
			.poll(() => app.evaluate(() => typeof (globalThis as any).releaseQueueRemove))
			.toBe('function');
		await page.evaluate((key) => window.brigadir.sendCommand(key, { kind: 'cancel' }), key);
		await expect(queue).toHaveCount(0);
		await app.evaluate(() => (globalThis as any).releaseQueueRemove());
		await expect(page.locator('[data-toast-region]').getByRole('status')).toContainText(
			'The message is no longer queued.'
		);
		await expect(message).toHaveText('Keep this new draft');
		const started = await page.evaluate(
			async (key) =>
				(await window.brigadir.readSession(key)).records.flatMap((record) =>
					record.event.kind === 'turn.started' ? [record.event.text] : []
				),
			key
		); // spec/composer#mentions: the queued attachment came back as a pill at the end of the text and went in its place.
		expect(started[3]).toMatch(/^With context @\[att:[0-9a-f-]{36}\] $/);
		expect([...started.slice(0, 3), ...started.slice(4)]).toEqual([
			'hold',
			'first queued',
			'Already typing\n\nto edit',
			'hold',
			'fail',
			'after failure',
			'hold',
			'race',
		]);
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
