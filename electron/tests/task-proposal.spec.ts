import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
const desktop = resolve('apps/desktop');
const executablePath = createRequire(join(desktop, 'package.json'))('electron') as string;
const env = Object.fromEntries(
	Object.entries(process.env).filter(
		(entry): entry is [string, string] =>
			typeof entry[1] === 'string' && entry[0] !== 'ELECTRON_RUN_AS_NODE'
	)
);
const call = (args: unknown) => `@call create_task ${JSON.stringify(args)}`;
async function send(page: Page, text: string) {
	const box = page.getByRole('textbox', { name: 'Message', exact: true }).last();
	await box.fill(text);
	await page.keyboard.press('Enter');
}

/** spec/tasks#agent-created-tasks: the agent proposes a task with context and a folder; the card creates it, opens it in the sheet or declines. */
test('a task the agent proposes waits as a card, and is created, opened in the sheet or declined @area:chat', async ({}, info) => {
	test.setTimeout(150000);
	const root = await mkdtemp(join(tmpdir(), 'brigadir-task-proposal-'));
	const repo = join(root, 'repository'),
		backend = join(root, 'backend'),
		data = join(root, 'data');
	await mkdir(repo);
	await mkdir(backend);
	await writeFile(join(backend, 'README.md'), '# Backend\n');
	const app = await electron.launch({
		executablePath,
		args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
		env: {
			...env,
			BRIGADIR_DATA_DIR: data,
			BRIGADIR_TEST_AGENT: resolve('packages/transport/fixtures/agent.mjs'),
			BRIGADIR_FIXTURE_SCENARIO: 'crew',
		},
	});
	const page = await app.firstWindow();
	const errors: string[] = [];
	page.on('pageerror', (e) => errors.push(e.message));
	try {
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 860));
		await app.evaluate(({ dialog }, path) => {
			dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
		}, repo);
		await page.getByRole('button', { name: 'Add a project…' }).click();
		await page.getByRole('button', { name: 'New task · repository' }).click();
		await page.getByRole('textbox', { name: 'Message' }).fill(
			call({
				title: 'Backend API',
				prompt:
					'Add the /loyalty endpoint the new screen calls.\n\nKeep the response shape of /rewards.\nCover it with a test.',
				context: [{ kind: 'summary' }, { kind: 'text', name: 'Notes', text: 'Use API v2' }],
				folders: [backend],
				start: 'backlog',
			})
		);
		await page.getByRole('button', { name: 'Start', exact: true }).click();

		const card = page.getByRole('region', { name: 'New task' });
		await expect(card).toBeVisible({ timeout: 30000 });
		await expect(card.getByText('Claude proposes a task')).toBeVisible();
		await expect(card.locator('strong').filter({ hasText: 'Backend API' })).toBeVisible();
		await expect(card.locator('[data-context]')).toHaveText(['Task summary', 'Notes']);
		await expect(card.locator('[data-folder]')).toHaveText(['backend']);
		await expect(card).toContainText('Backlog · new branch');
		await expect(page.locator('[data-sidebar-task]').first()).toContainText(
			'New task · Backend API'
		);
		for (const theme of ['light', 'dark'] as const) {
			await app.evaluate(({ nativeTheme }, value) => {
				nativeTheme.themeSource = value;
			}, theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await card.screenshot({
				animations: 'disabled',
				path: info.outputPath(`proposal-card-${theme}.png`),
			});
		}
		// Rule 15 is for interactive things: the context chips are labels (no button, no hover, 24 tall).
		for (const chip of await card.locator('[data-context], [data-folder]').all()) {
			expect(await chip.evaluate((node) => node.tagName)).toBe('SPAN');
			expect((await chip.boundingBox())!.height).toBeGreaterThanOrEqual(24);
			const before = await chip.evaluate(
				(node) => getComputedStyle(node).backgroundImage + getComputedStyle(node).backgroundColor
			);
			await chip.hover();
			expect(
				await chip.evaluate(
					(node) => getComputedStyle(node).backgroundImage + getComputedStyle(node).backgroundColor
				)
			).toBe(before);
		}
		// Rule 15: each footer button has its own hover. spec/chat#layout: Decline is transparent until hovered.
		const look = (node: Element) => {
			const style = getComputedStyle(node);
			return style.filter + style.backgroundImage + style.backgroundColor;
		};
		await expect(card.getByRole('button', { name: 'Decline', exact: true })).toHaveCSS(
			'background-color',
			'rgba(0, 0, 0, 0)'
		);
		for (const name of ['Decline', 'Task options…', 'Create']) {
			const button = card.getByRole('button', { name, exact: true });
			const before = await button.evaluate(look);
			await button.hover();
			await expect.poll(() => button.evaluate(look)).not.toBe(before);
		}
		await page.mouse.move(0, 0);
		for (const theme of ['dark', 'light'] as const) {
			await page.evaluate(async (appearance) => {
				const { settings } = await window.brigadir.readSettings();
				await window.brigadir.saveSettings({ ...settings, appearance });
			}, theme);
			await page.waitForTimeout(300);
			await card.screenshot({ path: info.outputPath(`task-proposal-${theme}.png`) });
		}

		// Create: the task appears in this project with its link, context and folder; the card folds into its row.
		await card.getByRole('button', { name: 'Create', exact: true }).click();
		const created = page.locator('[data-task-proposal-summary="created"]');
		await expect(created).toContainText('Task created');
		await expect(created).toContainText('Backend API');
		await expect(page.locator('[data-task-proposal]')).toHaveCount(0);
		const workspace = await page.evaluate(() => window.brigadir.readWorkspace());
		const source = workspace.tasks.find((task) => task.title !== 'Backend API')!,
			made = workspace.tasks.find((task) => task.title === 'Backend API')!;
		expect(made).toMatchObject({
			projectId: source.projectId,
			originTaskId: source.id,
			status: 'backlog',
		});
		expect(made.attachments?.map((item) => item.name)).toEqual([
			`Task summary · ${source.title}`,
			'Notes',
		]);
		expect(made.launch?.scopes.find((scope) => scope.name === 'backend')).toMatchObject({
			kind: 'folder',
			selected: true,
		});
		const done = page
			.locator('[data-chat-message]')
			.filter({ hasText: 'create_task: {"created":true' });
		await expect(done).toHaveCount(1, { timeout: 20000 });
		for (const theme of ['dark', 'light'] as const) {
			await page.evaluate(async (appearance) => {
				const { settings } = await window.brigadir.readSettings();
				await window.brigadir.saveSettings({ ...settings, appearance });
			}, theme);
			await page.waitForTimeout(300);
			await created.screenshot({ path: info.outputPath(`task-proposal-created-${theme}.png`) });
		}

		// Open in the sheet: the launch sheet starts from the proposal; the task it creates answers the agent.
		await send(
			page,
			call({
				title: 'Docs for the endpoint',
				prompt: 'Write the docs for /loyalty.',
				context: [],
				folders: [backend],
				start: 'backlog',
			})
		);
		await expect(card).toBeVisible({ timeout: 30000 });
		await card.getByRole('button', { name: 'Task options…' }).click();
		const sheet = page.getByRole('dialog', { name: 'New task' });
		await expect(sheet.getByRole('textbox', { name: 'Task name' })).toHaveValue(
			'Docs for the endpoint'
		);
		await expect(sheet.getByRole('textbox', { name: 'Message' })).toContainText(
			'Write the docs for /loyalty.'
		);
		await expect(sheet.locator('[data-proposal-source]')).toContainText(source.title);
		await sheet.screenshot({ path: info.outputPath('task-proposal-sheet.png') });
		// The proposal asked for the backlog, so the sheet starts there; `Save` creates the task.
		await sheet.getByRole('button', { name: 'Save', exact: true }).click();
		await expect(page.locator('[data-task-proposal-summary="created"]')).toHaveCount(2, {
			timeout: 20000,
		});
		const docs = (await page.evaluate(() => window.brigadir.readWorkspace())).tasks.find(
			(task) => task.title === 'Docs for the endpoint'
		)!;
		expect(docs.originTaskId).toBe(source.id);

		// Decline: nothing is created and the agent hears no.
		await page.locator(`[data-sidebar-task="${source.id}"]`).click();
		await send(page, call({ prompt: 'Rename the table.', context: [], folders: [], start: 'now' }));
		await expect(card).toBeVisible({ timeout: 30000 });
		await card.getByRole('button', { name: 'Decline', exact: true }).click();
		await expect(page.locator('[data-task-proposal-summary="declined"]')).toContainText(
			'Task not created'
		);
		expect((await page.evaluate(() => window.brigadir.readWorkspace())).tasks).toHaveLength(3);
		expect(
			JSON.parse(
				await readFile(
					join(data, 'projects', source.projectId, 'tasks', made.id, 'task.json'),
					'utf8'
				)
			).task.originTaskId
		).toBe(source.id);
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
