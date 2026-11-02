import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
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
const launchApp = (root: string, data: string, extra: Record<string, string> = {}) =>
	electron.launch({
		executablePath,
		args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
		env: {
			...env,
			BRIGADIR_DATA_DIR: data,
			BRIGADIR_TEST_AGENT: resolve('packages/transport/fixtures/agent.mjs'),
			...extra,
		},
	});
// Picks one item of the next native context menu instead of showing it.
const choose = async (application: ElectronApplication, label: string) =>
	application.evaluate(({ Menu }, label) => {
		const original = Menu.buildFromTemplate;
		Menu.buildFromTemplate = (items: any[]) => {
			Menu.buildFromTemplate = original;
			const item = items.find((item) => item.label === label);
			if (!item) throw new Error(`No menu item ${label}`);
			return {
				popup: ({ callback }: any) => {
					item.click();
					callback?.();
				},
			} as any;
		};
	}, label);
test('project board and list persist, edit backlog without an agent, move tasks without navigation, and share accessible actions @area:tasks @smoke', async ({}, info) => {
	test.setTimeout(180000);
	const root = await mkdtemp(join(tmpdir(), 'brigadir-board-ui-')),
		repo = join(root, 'repo'),
		data = join(root, 'data');
	await mkdir(repo);
	await mkdir(data);
	const option = {
		id: 'model',
		name: 'Model',
		description: null,
		category: null,
		kind: 'select',
		value: 'fixture',
		choices: [
			{ value: 'fixture', name: 'Fixture', description: null, group: null },
			{ value: 'other', name: 'Other', description: null, group: null },
		],
	};
	for (const id of ['project', 'second', 'empty']) {
		const dir = join(data, 'projects', id);
		await mkdir(dir, { recursive: true });
		await writeFile(
			join(dir, 'project.json'),
			JSON.stringify({
				schemaVersion: 1,
				project: {
					id,
					name: id === 'project' ? 'repository' : id === 'second' ? 'another' : 'empty',
					path: repo,
				},
			})
		);
	}
	const seeds = [
		{
			id: 'backlog',
			projectId: 'project',
			title: 'Plan the board',
			prompt: 'First board prompt',
			status: 'backlog',
			provider: 'claude',
			transport: 'gui',
			modelName: 'Fixture',
			agentOptions: [option],
		},
		{
			id: 'done',
			projectId: 'project',
			title: 'Review the change',
			prompt: 'Review the whole change and check the acceptance criteria before shipping.',
			status: 'done',
			modelName: 'Fixture',
			effortName: 'high',
		},
		{ id: 'completed', projectId: 'project', title: 'Already accepted', status: 'completed' },
		{
			id: 'other',
			projectId: 'second',
			title: 'Another project task',
			prompt: 'Another project task',
			status: 'done',
			worktreeBranch: 'codex/board-parity',
		},
	];
	for (const task of seeds) {
		const dir = join(data, 'projects', task.projectId, 'tasks', task.id);
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, 'task.json'), JSON.stringify({ schemaVersion: 1, task }));
	}
	await writeFile(
		join(data, 'settings.json'),
		JSON.stringify({ schemaVersion: 1, settings: { appearance: 'light', language: 'en' } })
	);
	const launch = () => launchApp(root, data);
	let app = await launch();
	try {
		let page = await app.firstWindow();
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		await page.locator('aside').getByRole('button', { name: 'repository', exact: true }).click();
		const board = () => page.locator('[data-project-screen]'),
			column = (name: string) => page.locator(`[data-board-column=${name}]`),
			card = (id: string) => page.locator(`[data-board-task="${id}"]`);
		await expect(board()).toBeVisible();
		await expect(page.locator('[data-board-column]')).toHaveCount(3);
		await board().getByRole('radio', { name: 'List', exact: true }).click();
		await expect(board().locator('[data-view]')).toHaveAttribute('data-view', 'list');
		await expect
			.poll(
				async () =>
					JSON.parse(await readFile(join(data, 'project-views.json'), 'utf8').catch(() => '{}'))
						.views?.project
			)
			.toBe('list');
		await board().getByRole('radio', { name: 'Board', exact: true }).click();
		// The view switch also moves by keyboard.
		await board().getByRole('radio', { name: 'Board', exact: true }).press('ArrowRight');
		await expect(board().getByRole('radio', { name: 'List', exact: true })).toBeChecked();
		await board().screenshot({ path: info.outputPath('list-light.png') });
		await board().getByRole('radio', { name: 'Board', exact: true }).click();
		await page.waitForTimeout(270);
		await card('backlog').hover();
		await board().screenshot({ path: info.outputPath('board-light.png') });
		// The backlog sheet saves without creating a host, journal, or baseline.
		await column('backlog')
			.getByRole('button', { name: 'New task in backlog', exact: true })
			.click();
		let sheet = page.getByRole('dialog', { name: 'New task', exact: true });
		await expect(sheet.getByRole('button', { name: 'Add to backlog' })).toHaveAttribute(
			'aria-pressed',
			'true'
		);
		await sheet.getByRole('textbox', { name: 'Message', exact: true }).fill('A saved intention');
		await sheet.getByRole('button', { name: 'Save', exact: true }).click();
		await expect(sheet).toHaveCount(0);
		const saved = await page.evaluate(async () =>
			(await window.brigadir.readWorkspace()).tasks.find(
				(task) => task.title === 'A saved intention'
			)!
		);
		expect(await readdir(join(data, 'projects/project/tasks', saved.id))).toEqual(['task.json']);
		await card(saved.id).focus();
		await card(saved.id).press('Enter');
		sheet = page.getByRole('dialog', { name: 'Edit task', exact: true });
		await expect(sheet.getByRole('textbox', { name: 'Message', exact: true })).toHaveText(
			'A saved intention'
		);
		await sheet.getByRole('textbox', { name: 'Message', exact: true }).fill('A revised intention');
		await sheet.getByRole('button', { name: 'Save', exact: true }).click();
		await expect(card(saved.id)).toContainText('A revised intention');
		expect(await readdir(join(data, 'projects/project/tasks', saved.id))).toEqual(['task.json']);
		// A card's model menu uses the provider catalog and stores an override without launching.
		await choose(app, 'Other');
		await card('backlog').getByRole('button', { name: 'Model', exact: true }).click();
		await expect(card('backlog')).toContainText('Other');
		expect(await readdir(join(data, 'projects/project/tasks/backlog'))).toEqual(['task.json']);
		// Invalid drops are rejected without moving a card or opening a task.
		await card('backlog').dragTo(column('completed'));
		await expect(column('backlog').locator('[data-board-task=backlog]')).toBeVisible();
		// Valid drag starts the real fixture host and sends the initial prompt only once.
		await card('backlog').dragTo(column('progress'));
		await expect(column('progress').locator('[data-board-task=backlog]')).toBeVisible({
			timeout: 30000,
		});
		await expect(board()).toBeVisible();
		await expect
			.poll(async () => {
				const session = await page.evaluate(() =>
					window.brigadir.readSession({ projectId: 'project', id: 'backlog' })
				);
				return session.records.filter((record) => record.event.kind === 'turn.completed').length;
			})
			.toBe(1);
		const session = await page.evaluate(() =>
			window.brigadir.readSession({ projectId: 'project', id: 'backlog' })
		);
		expect(session.records.filter((record) => record.event.kind === 'turn.started')).toHaveLength(
			1
		);
		expect(
			session.records.find((record) => record.event.kind === 'turn.started')?.event
		).toMatchObject({ text: 'First board prompt' });
		expect(
			JSON.parse(await readFile(join(data, 'projects/project/tasks/backlog/task.json'), 'utf8'))
				.task.modelName
		).toBe('Other');
		await expect(card('backlog').getByLabel('Unread', { exact: true })).toBeVisible();
		// Opening the task clears the durable watermark; returning to the board stays read.
		await card('backlog').click();
		await expect(page.getByRole('log')).toContainText('First board prompt');
		await page.locator('aside').getByRole('button', { name: 'repository', exact: true }).click();
		await expect(card('backlog').getByLabel('Unread', { exact: true })).toHaveCount(0);
		// Parking a live task cancels it and preserves queued prompts without running them.
		await page.evaluate(async () => {
			const key = { projectId: 'project', id: 'backlog' };
			await window.brigadir.sendCommand(key, { kind: 'prompt', text: 'hold' });
			await window.brigadir.sendCommand(key, { kind: 'prompt', text: 'Do this later' });
		});
		await expect(card('backlog')).toHaveAttribute('data-status', 'working');
		// Native context actions are the keyboard equivalent of every permitted drop.
		await choose(app, 'Mark completed');
		await card('backlog').focus();
		await card('backlog').press('Shift+F10');
		await expect(column('completed').locator('[data-board-task=backlog]')).toBeVisible();
		await expect(card('backlog')).toHaveAttribute('data-status', 'completed');
		await expect(card('backlog')).toBeFocused();
		await board().getByRole('radio', { name: 'List', exact: true }).click();
		await card('backlog').dragTo(column('progress'));
		await expect(column('progress').locator('[data-board-task=backlog]')).toBeVisible();
		expect(
			(
				await page.evaluate(() =>
					window.brigadir.readSession({ projectId: 'project', id: 'backlog' })
				)
			).records.filter((record) => record.event.kind === 'turn.started')
		).toHaveLength(2);
		expect(
			(
				await page.evaluate(() =>
					window.brigadir.readSession({ projectId: 'project', id: 'backlog' })
				)
			).records.some((record) => record.event.kind === 'queue.paused')
		).toBe(true);
		await choose(app, 'Add to backlog');
		await card('backlog').focus();
		await card('backlog').press('Shift+F10');
		await expect(column('backlog').locator('[data-board-task=backlog]')).toBeVisible();
		expect(
			(
				await page.evaluate(() =>
					window.brigadir.readSession({ projectId: 'project', id: 'backlog' })
				)
			).connected
		).toBe(false);
		// Completed cards archive a single visible item; bulk archive asks once and obeys Cancel.
		await card('completed').hover();
		await card('completed').getByRole('button', { name: 'Archive', exact: true }).click();
		await expect(card('completed')).toHaveCount(0);
		await page.locator('aside').getByRole('button', { name: 'All projects', exact: true }).click();
		await expect(board()).toHaveAttribute('data-project-screen', '*');
		await expect(card('other')).toBeVisible();
		await expect(board().getByRole('button', { name: 'New task', exact: true })).toHaveCount(0);
		await expect(board().locator('[class*=dot]')).toHaveCount(4);
		await board().getByRole('radio', { name: 'Board', exact: true }).click();
		await page.waitForTimeout(270);
		await expect(card('other').locator('p')).toHaveCount(0);
		await expect(card('other').locator('[data-glyph=board-branch]')).toBeVisible();
		await page.mouse.move(0, 0);
		await board().screenshot({ path: info.outputPath('all-projects-light.png') });
		await page.evaluate(async () => {
			const { settings } = await window.brigadir.readSettings();
			await window.brigadir.saveSettings({ ...settings, appearance: 'dark' });
		});
		await board().getByRole('radio', { name: 'Board', exact: true }).click();
		await page.waitForTimeout(270);
		await board().screenshot({ path: info.outputPath('all-projects-dark.png') });
		await board().getByRole('radio', { name: 'List', exact: true }).click();
		await page.waitForTimeout(270);
		await board().screenshot({ path: info.outputPath('all-projects-list-dark.png') });
		await app.close();
		app = await launch();
		page = await app.firstWindow();
		await page.locator('aside').getByRole('button', { name: 'repository', exact: true }).click();
		await expect(board().getByRole('radio', { name: 'List', exact: true })).toBeChecked();
		await expect(card(saved.id)).toContainText('A revised intention');
		// Bulk archive asks once, respects cancellation, and names the completed task count.
		await choose(app, 'Mark completed');
		await card('done').focus();
		await card('done').press('Shift+F10');
		await expect(column('completed').locator('[data-board-task=done]')).toBeVisible();
		await app.evaluate(({ dialog }) => {
			(globalThis as any).clearPrompts = [];
			dialog.showMessageBox = async (...args: any[]) => {
				(globalThis as any).clearPrompts.push(args[1]);
				return { response: 0, checkboxChecked: false };
			};
		});
		await column('completed')
			.getByRole('button', { name: 'Archive the list', exact: true })
			.click();
		await expect(card('done')).toBeVisible();
		await expect
			.poll(() => app.evaluate(() => (globalThis as any).clearPrompts[0]?.message ?? ''))
			.toContain('1 task');
		await expect(
			column('completed').getByRole('button', { name: 'Archive the list', exact: true })
		).toBeEnabled();
		await app.evaluate(({ dialog }) => {
			dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
		});
		await column('completed')
			.getByRole('button', { name: 'Archive the list', exact: true })
			.click();
		await expect(card('done')).toHaveCount(0);
		await page.locator('aside').getByRole('button', { name: 'empty', exact: true }).click();
		await expect(board().getByRole('heading', { name: 'No tasks yet' })).toBeVisible();
		await board().screenshot({ path: info.outputPath('empty-dark.png') });
		await page.evaluate(async () => {
			const { settings } = await window.brigadir.readSettings();
			await window.brigadir.saveSettings({ ...settings, language: 'uk' });
		});
		await app.close();
		app = await launch();
		page = await app.firstWindow();
		await page.locator('aside').getByRole('button', { name: 'repository', exact: true }).click();
		await expect(board().getByRole('radio', { name: 'Список', exact: true })).toBeChecked();
		// A failed view write rolls back selection and its toast offers Retry, without overwriting saved preferences (spec/notifications-slack-notes-and-schedules#message-classes).
		await app.evaluate(({ ipcMain }) => {
			const handlers = (ipcMain as any)._invokeHandlers,
				original = handlers.get('project-views:save');
			handlers.set('project-views:save', (...args: any[]) => {
				handlers.set('project-views:save', original);
				throw new Error('Fixture write failure');
			});
		});
		const toasts = page.locator('[data-toast-region]');
		await board().getByRole('radio', { name: 'Дошка', exact: true }).click();
		await expect(toasts.getByRole('alert')).toBeVisible();
		await expect(board().getByRole('alert')).toHaveCount(0);
		await expect(board().getByRole('radio', { name: 'Список', exact: true })).toBeChecked();
		await page.screenshot({ path: info.outputPath('write-error-uk.png') });
		await toasts.getByRole('button', { name: 'Спробувати ще', exact: true }).click();
		await expect(toasts.getByRole('alert')).toHaveCount(0);
		await expect(board().getByRole('radio', { name: 'Дошка', exact: true })).toBeChecked();
		await board().getByRole('radio', { name: 'Дошка', exact: true }).click();
		await page.waitForTimeout(270);
		await board().screenshot({ path: info.outputPath('board-uk-dark.png') });
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

// spec/tasks#backlog-edit: the backlog task's sheet is the new task sheet — name, model, attachments (⌘V), the .md description import — and
// Start task saves and starts it; the image reaches the agent with the first prompt, and the card shows the clip.
test('edits a backlog task with a model and a pasted image, imports a .md description and starts it with the attachment @area:tasks @serial', async ({}, info) => {
	test.setTimeout(120000);
	const root = await mkdtemp(join(tmpdir(), 'brigadir-backlog-edit-')),
		repo = join(root, 'repo'),
		data = join(root, 'data'),
		agentLog = join(root, 'agent.jsonl'),
		notes = join(root, 'notes.md');
	await mkdir(repo);
	const dir = join(data, 'projects/project/tasks/backlog');
	await mkdir(dir, { recursive: true });
	await writeFile(
		join(data, 'projects/project/project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'repository', path: repo } })
	);
	await writeFile(
		join(dir, 'task.json'),
		JSON.stringify({
			schemaVersion: 1,
			task: {
				id: 'backlog',
				projectId: 'project',
				title: 'Drop the legacy checkout',
				prompt: 'Drop the legacy checkout',
				status: 'backlog',
				provider: 'claude',
				transport: 'gui',
			},
		})
	);
	await writeFile(
		join(data, 'settings.json'),
		JSON.stringify({ schemaVersion: 1, settings: { appearance: 'light', language: 'en' } })
	);
	await writeFile(notes, 'Routes and owners are in the notes.\n');
	const app = await launchApp(root, data, { BRIGADIR_FIXTURE_LOG: agentLog });
	const key = { projectId: 'project', id: 'backlog' };
	try {
		const page = await app.firstWindow(),
			errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		// The system clipboard and file dialogs stay untouched: main reads a stand-in screenshot and a picked notes.md.
		const png = await app.evaluate(({ clipboard, nativeImage, dialog }, notes) => {
			const width = 64,
				height = 48,
				bitmap = Buffer.alloc(width * height * 4);
			for (let i = 0; i < bitmap.length; i += 4) {
				bitmap[i] = 0x20;
				bitmap[i + 1] = 0x60;
				bitmap[i + 2] = 0xd0;
				bitmap[i + 3] = 0xff;
			}
			const bytes = nativeImage.createFromBitmap(bitmap, { width, height }).toPNG();
			(clipboard as any).read = async () => [
				{
					types: ['image/png'],
					getType: async () => new Blob([new Uint8Array(bytes)], { type: 'image/png' }),
				},
			];
			dialog.showOpenDialog = (async () => ({
				canceled: false,
				filePaths: [notes],
			})) as typeof dialog.showOpenDialog;
			return bytes.toString('base64');
		}, notes);
		await page.locator('aside').getByRole('button', { name: 'repository', exact: true }).click();
		const card = page.locator('[data-board-task="backlog"]');
		await expect(card).toBeVisible();
		await card.click();
		let sheet = page.getByRole('dialog', { name: 'Edit task', exact: true });
		await expect(sheet).toBeVisible();
		const message = sheet.getByRole('textbox', { name: 'Message', exact: true });
		await expect(message).toHaveText('Drop the legacy checkout');
		// The name and the model are there in the edit sheet too.
		await sheet.getByRole('textbox', { name: 'Task name', exact: true }).fill('Legacy checkout');
		const model = sheet.getByRole('button', { name: 'Model', exact: true });
		await expect(model).toBeEnabled({ timeout: 20000 });
		await model.click();
		await page.getByRole('option', { name: 'Other', exact: true }).click();
		await expect(model).toContainText('Other');
		// ⌘V with an image attaches it; spec/composer#mentions: it stands in the text as a thumbnail at the caret, the words stay.
		await message.click();
		await message.press('End');
		const pasted = await message.evaluate((node) => {
			const transfer = new DataTransfer();
			transfer.items.add(
				new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], 'image.png', {
					type: 'image/png',
				})
			);
			const event = new ClipboardEvent('paste', {
				clipboardData: transfer,
				bubbles: true,
				cancelable: true,
			});
			node.dispatchEvent(event);
			return event.defaultPrevented;
		});
		expect(pasted).toBe(true);
		const inline = message.locator('[data-mention-image]');
		await expect(inline).toHaveCount(1);
		await expect(inline.locator('img')).toHaveCount(1);
		await expect(sheet.locator('[data-attachments]')).toHaveCount(0);
		await expect(message).toHaveText('Drop the legacy checkout');
		// «+» ▸ the .md description item puts the file's text in at the caret, once; the file is not attached.
		await message.press('End');
		await message.press('Enter');
		await choose(app, 'Description from a .md file…');
		await sheet.getByRole('button', { name: 'Attach files', exact: true }).click();
		await expect(message).toContainText('Routes and owners are in the notes.');
		await expect(inline).toHaveCount(1);
		await sheet.getByRole('button', { name: 'Save', exact: true }).click();
		await expect(sheet).toHaveCount(0);
		const saved = JSON.parse(await readFile(join(dir, 'task.json'), 'utf8')).task;
		expect(saved).toMatchObject({
			title: 'Legacy checkout',
			status: 'backlog',
			modelName: 'Other',
			launchOptions: [{ id: 'model', value: 'other' }],
		});
		expect(saved.prompt).toContain('Routes and owners are in the notes.');
		expect(saved.attachments).toHaveLength(1);
		expect(saved.attachments[0]).toMatchObject({ kind: 'image', name: 'Pasted image' });
		expect((await readdir(join(dir, 'attachments', saved.attachments[0].id))).sort()).toEqual([
			'attachment.json',
			'image.png',
			'thumb.png',
		]);
		// The card shows the clip with the count, before the age.
		const clip = card.locator('[data-attachment-count]');
		await expect(clip).toHaveText('1');
		await card.hover();
		await page
			.locator('[data-project-screen]')
			.screenshot({ path: info.outputPath('backlog-card-light.png') });
		// The sheet opens again with the name, the model and the tile; Start task stands where the backlog toggle is.
		await card.click();
		sheet = page.getByRole('dialog', { name: 'Edit task', exact: true });
		await expect(sheet.getByRole('textbox', { name: 'Task name', exact: true })).toHaveValue(
			'Legacy checkout'
		);
		await expect(sheet.getByRole('button', { name: 'Model', exact: true })).toContainText('Other', {
			timeout: 20000,
		});
		await expect(sheet.locator('[data-mention-image] img')).toHaveCount(1);
		await expect(sheet.getByRole('button', { name: 'Add to backlog' })).toHaveCount(0);
		const start = sheet.getByRole('button', { name: 'Start task', exact: true });
		await expect(start).toBeVisible();
		await sheet.screenshot({
			animations: 'disabled',
			path: info.outputPath('backlog-edit-sheet-light.png'),
		});
		// It saves and starts; the image goes with the first prompt.
		await start.click();
		await expect(sheet).toHaveCount(0);
		await expect
			.poll(
				async () => (await readFile(agentLog, 'utf8').catch(() => '')).includes('"prompt-blocks"'),
				{ timeout: 30000 }
			)
			.toBe(true);
		const agent = (await readFile(agentLog, 'utf8'))
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line) as { event: string; params: any });
		const blocks = agent.filter((entry) => entry.event === 'prompt-blocks')[0]!.params as {
			type: string;
			text?: string;
			data?: string;
			mimeType?: string;
		}[];
		const own = blocks.filter(
			(block) => block.type !== 'text' || !block.text!.startsWith('<attached_context name=')
		);
		expect(own[0]).toMatchObject({ type: 'text' });
		expect(own[0]!.text).toContain('Drop the legacy checkout');
		expect(own.filter((block) => block.type === 'image')).toEqual([
			{ type: 'image', mimeType: 'image/png', data: png },
		]);
		const started = JSON.parse(await readFile(join(dir, 'task.json'), 'utf8')).task;
		expect(started.status).not.toBe('backlog');
		await expect(card.locator('[data-attachment-count]')).toHaveCount(0);
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

// spec/tasks#backlog-edit: a new task's sheet keeps pasted images in a draft; Save moves them into the task, Cancel drops the draft.
test('a new backlog task takes its pasted image from the sheet draft; a cancelled sheet leaves no draft @area:tasks @serial', async () => {
	test.setTimeout(90000);
	const root = await mkdtemp(join(tmpdir(), 'brigadir-backlog-new-')),
		repo = join(root, 'repo'),
		data = join(root, 'data');
	await mkdir(repo);
	await mkdir(join(data, 'projects/project/tasks/done'), { recursive: true });
	// A finished task keeps the board on screen (an empty project shows its empty state instead).
	await writeFile(
		join(data, 'projects/project/tasks/done/task.json'),
		JSON.stringify({
			schemaVersion: 1,
			task: { id: 'done', projectId: 'project', title: 'Already accepted', status: 'completed' },
		})
	);
	await writeFile(
		join(data, 'projects/project/project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'repository', path: repo } })
	);
	await writeFile(
		join(data, 'settings.json'),
		JSON.stringify({ schemaVersion: 1, settings: { appearance: 'light', language: 'en' } })
	);
	const app = await launchApp(root, data);
	try {
		const page = await app.firstWindow(),
			errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		await app.evaluate(({ clipboard, nativeImage }) => {
			const bitmap = Buffer.alloc(16 * 16 * 4, 0xff);
			const bytes = nativeImage.createFromBitmap(bitmap, { width: 16, height: 16 }).toPNG();
			(clipboard as any).read = async () => [
				{
					types: ['image/png'],
					getType: async () => new Blob([new Uint8Array(bytes)], { type: 'image/png' }),
				},
			];
		});
		await page.locator('aside').getByRole('button', { name: 'repository', exact: true }).click();
		const paste = (sheet: ReturnType<typeof page.getByRole>) =>
			sheet.getByRole('textbox', { name: 'Message', exact: true }).evaluate((node) => {
				const transfer = new DataTransfer();
				transfer.items.add(new File([new Uint8Array([1])], 'image.png', { type: 'image/png' }));
				node.dispatchEvent(
					new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true })
				);
			});
		const open = async () => {
			await page
				.locator('[data-board-column=backlog]')
				.getByRole('button', { name: 'New task in backlog', exact: true })
				.click();
			const sheet = page.getByRole('dialog', { name: 'New task', exact: true });
			await expect(sheet.getByRole('textbox', { name: 'Message', exact: true })).toBeEditable();
			return sheet;
		};
		let sheet = await open();
		await paste(sheet);
		await expect(sheet.locator('[data-mention-image] img')).toHaveCount(1);
		expect((await readdir(join(data, 'drafts/project'))).length).toBe(1);
		await sheet.getByRole('button', { name: 'Cancel', exact: true }).click();
		await expect(sheet).toHaveCount(0);
		await expect
			.poll(async () => (await readdir(join(data, 'drafts/project')).catch(() => [])).length)
			.toBe(0);
		sheet = await open();
		await sheet.getByRole('textbox', { name: 'Message', exact: true }).fill('Later with a picture');
		await paste(sheet);
		await expect(sheet.locator('[data-mention-image] img')).toHaveCount(1);
		await sheet.getByRole('button', { name: 'Save', exact: true }).click();
		await expect(sheet).toHaveCount(0);
		const task = await page.evaluate(async () =>
			(await window.brigadir.readWorkspace()).tasks.find((item) =>
				item.prompt?.startsWith('Later with a picture')
			)!
		);
		// spec/composer#mentions: the picture stands in the prompt where it was pasted, as a token the agent gets as a block in its place.
		expect(task.prompt).toMatch(/^Later with a picture @\[att:[0-9a-f-]{36}\] $/);
		expect(task.attachments).toHaveLength(1);
		expect(await readdir(join(data, 'projects/project/tasks', task.id, 'attachments'))).toEqual([
			task.attachments![0]!.id,
		]);
		expect(await readdir(join(data, 'drafts/project')).catch(() => [])).toEqual([]);
		await expect(page.locator(`[data-board-task="${task.id}"] [data-attachment-count]`)).toHaveText(
			'1'
		);
		await expect(
			page.locator(`[data-sidebar-task="${task.id}"] [data-attachment-count]`)
		).toHaveText('1');
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
