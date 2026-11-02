import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { editorState, editorText } from './editor-text';
const desktop = resolve('apps/desktop'),
	executablePath = createRequire(join(desktop, 'package.json'))('electron') as string,
	env = Object.fromEntries(
		Object.entries(process.env).filter(
			(e): e is [string, string] => typeof e[1] === 'string' && e[0] !== 'ELECTRON_RUN_AS_NODE'
		)
	);
test('composer restores on restart, flushes a quick close, preserves typing during load and handles Enter and IME @area:chat @smoke', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-composer-ui-')),
		repo = join(root, 'repo'),
		data = join(root, 'data'),
		project = join(data, 'projects/project');
	await mkdir(repo);
	for (const id of ['first', 'second']) {
		await mkdir(join(project, `tasks/${id}`), { recursive: true });
		await writeFile(
			join(project, `tasks/${id}/task.json`),
			JSON.stringify({
				schemaVersion: 1,
				task: {
					id,
					projectId: 'project',
					title: `Composer ${id}`,
					status: 'done',
					provider: 'claude',
				},
			})
		);
	}
	await writeFile(
		join(project, 'project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'repo', path: repo } })
	);
	const path = join(project, 'tasks/first/composer.json');
	await writeFile(path, JSON.stringify({ schemaVersion: 1, text: 'Saved draft' }));
	await writeFile(
		join(project, 'tasks/second/composer.json'),
		JSON.stringify({ schemaVersion: 1, text: 'Older second draft' })
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
	const key = { projectId: 'project', id: 'first' };
	try {
		let page = await app.firstWindow();
		await page.getByRole('button', { name: /Composer first/ }).click();
		let message = page.getByRole('textbox', { name: 'Message', exact: true });
		await expect(message).toHaveText('Saved draft');
		await app.evaluate(({ Menu }) =>
			Menu.getApplicationMenu()!.getMenuItemById('composer')!.click()
		);
		await expect(message).toBeFocused();
		await message.fill('Typed immediately before closing.');
		await app.close();
		expect(JSON.parse(await readFile(path, 'utf8')).text).toBe('Typed immediately before closing.');
		app = await launch();
		page = await app.firstWindow();
		await page.getByRole('button', { name: /Composer first/ }).click();
		message = page.getByRole('textbox', { name: 'Message', exact: true });
		await expect(message).toHaveText('Typed immediately before closing.');
		await app.evaluate(({ ipcMain }) => {
			const handlers = (ipcMain as any)._invokeHandlers,
				original = handlers.get('composer:read');
			handlers.set('composer:read', async (...args: any[]) => {
				handlers.set('composer:read', original);
				const value = await original(...args);
				await new Promise<void>((resolve) => {
					(globalThis as any).finishDraftRead = resolve;
				});
				return value;
			});
		});
		await page.getByRole('button', { name: /Composer second/ }).click();
		await message.fill('New typing wins.');
		await expect
			.poll(() => app.evaluate(() => typeof (globalThis as any).finishDraftRead))
			.toBe('function');
		await expect
			.poll(
				async () =>
					JSON.parse(await readFile(join(project, 'tasks/second/composer.json'), 'utf8')).text
			)
			.toBe('New typing wins.');
		await app.evaluate(() => (globalThis as any).finishDraftRead());
		await expect(message).toHaveAttribute('aria-busy', 'false');
		await expect(message).toHaveText('New typing wins.');
		await page.getByRole('button', { name: /Composer first/ }).click();
		await page.getByRole('button', { name: 'Start', exact: true }).click();
		await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
		await message.fill('First line');
		await message.press('Shift+Enter');
		await message.press('End');
		await message.type('Second line');
		await expect.poll(() => editorText(message)).toBe('First line\nSecond line');
		await message.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
		expect(
			(await page.evaluate((key) => window.brigadir.readSession(key), key)).records.some(
				(record) => record.event.kind === 'turn.started'
			)
		).toBe(false);
		await message.press('Enter');
		await expect(page.getByRole('log', { name: 'Conversation' })).toContainText('hello world');
		await expect.poll(() => editorText(message)).toBe('');
		await expect
			.poll(async () => {
				try {
					await readFile(path);
					return false;
				} catch (error) {
					return (error as NodeJS.ErrnoException).code === 'ENOENT';
				}
			})
			.toBe(true);
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

// spec/composer#formatting: ⇧↩ continues a list, Tab / ⇧Tab move an item (and ⇧Tab is the agent's mode only outside a list), ⌘B ⌘I ⌘E ⌘K format with
// real keys and from Edit ▸ Formatting, a paste of `•` lines becomes items, and the sent message is Markdown in the log.
test('composer formatting: list keys, ⇧Tab keeps the agent mode off list items, format keys and menu, paste, Markdown in the log @area:chat @serial', async () => {
	test.setTimeout(120000);
	const root = await mkdtemp(join(tmpdir(), 'brigadir-format-')),
		repo = join(root, 'repo'),
		data = join(root, 'data'),
		dir = join(data, 'projects/project/tasks/task'),
		adapter = join(root, 'catalog.mjs');
	await mkdir(repo);
	await mkdir(dir, { recursive: true });
	await writeFile(join(repo, 'example.ts'), 'export const count = 1;\n');
	await writeFile(
		adapter,
		`process.argv[2]='catalog';await import(${JSON.stringify(pathToFileURL(resolve('packages/transport/fixtures/agent.mjs')).href)});`
	);
	await writeFile(
		join(dir, 'task.json'),
		JSON.stringify({
			schemaVersion: 1,
			task: {
				id: 'task',
				projectId: 'project',
				title: 'Format fixture',
				status: 'done',
				provider: 'claude',
			},
		})
	);
	const second = join(data, 'projects/project/tasks/compose');
	await mkdir(second, { recursive: true });
	await writeFile(
		join(second, 'task.json'),
		JSON.stringify({
			schemaVersion: 1,
			task: {
				id: 'compose',
				projectId: 'project',
				title: 'Compose fixture',
				status: 'done',
				provider: 'claude',
			},
		})
	);
	await writeFile(
		join(dir, '../../project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'repo', path: repo } })
	);
	// A message of the log that was typed with Markdown: the log draws it as an answer is drawn.
	const typed =
		'Please do these:\n- remove **the shadow**\n- check `ring`\n  - in the light theme\n\n1. first\n2. second\nok';
	await writeFile(
		join(dir, 'events.jsonl'),
		[
			{ kind: 'turn.started', text: typed },
			{
				kind: 'message.delta',
				role: 'assistant',
				messageId: 'm1',
				content: { kind: 'text', text: 'Done.' },
			},
			{ kind: 'turn.completed', reason: 'end_turn' },
		]
			.map((event, index) =>
				JSON.stringify({
					schemaVersion: 1,
					seq: index + 1,
					at: '2026-10-07T10:00:0' + index + '.000Z',
					event,
				})
			)
			.join('\n') + '\n'
	);
	const app = await electron.launch({
		executablePath,
		args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
		env: { ...env, BRIGADIR_DATA_DIR: data, BRIGADIR_TEST_AGENT: adapter },
	});
	try {
		const page = await app.firstWindow(),
			errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		await page.getByRole('button', { name: /Format fixture/ }).click();
		// The message already in the log: lists, code and bold; a single line break stays a break.
		const logged = page.locator('[data-chat-message]').first();
		await expect(logged.locator('ul > li')).toHaveCount(3);
		await expect(logged.locator('ol > li')).toHaveCount(2);
		await expect(logged.locator('li ul > li')).toHaveCount(1);
		await expect(logged.locator('strong')).toHaveText('the shadow');
		await expect(logged.locator('code')).toHaveText('ring');
		expect(await logged.locator('p').first().textContent()).toBe('Please do these:');
		await page.getByRole('button', { name: /Compose fixture/ }).click();
		await page.getByRole('button', { name: 'Start', exact: true }).click();
		const options = page.getByRole('group', { name: 'Agent options' }),
			mode = options.getByRole('button', { name: 'Mode', exact: true });
		const message = page.getByRole('textbox', { name: 'Message', exact: true });
		await expect(options.getByRole('button', { name: 'Model', exact: true })).toBeEnabled();
		const menuEnabled = (id: string) =>
			app.evaluate(({ Menu }, id) => Menu.getApplicationMenu()!.getMenuItemById(id)!.enabled, id);
		await message.click();
		// Outside a list ⇧Tab is the agent's mode; ⇧↩ is a plain line break.
		await message.pressSequentially('Plan:');
		await message.press('Shift+Enter');
		expect(await editorText(message)).toBe('Plan:\n');
		await message.press('Shift+Tab');
		await expect(mode).toContainText('Accept edits');
		// ⇧↩ in an item continues the list, with ordered numbers counting on; Tab nests, ⇧Tab goes up.
		await message.pressSequentially('1. Tokens');
		await message.press('Shift+Enter');
		expect(await editorText(message)).toBe('Plan:\n1. Tokens\n2. ');
		await expect(message).toHaveAttribute('data-list-line', 'true');
		await expect.poll(() => menuEnabled('composer-mode')).toBe(false);
		await message.pressSequentially('Button');
		await message.press('Shift+Enter');
		await message.press('Tab');
		await message.pressSequentially('use the token');
		expect(await editorText(message)).toBe(
			'Plan:\n1. Tokens\n2. Button\n   3. use the token'.replace('   3. ', '   1. ')
		);
		// ⇧Tab on an item moves it; the agent's mode stays where it was.
		await message.press('Shift+Tab');
		expect(await editorText(message)).toBe('Plan:\n1. Tokens\n2. Button\n3. use the token');
		await expect(mode).toContainText('Accept edits');
		await message.press('Shift+Enter');
		await message.press('Shift+Enter');
		expect(await editorText(message)).toBe('Plan:\n1. Tokens\n2. Button\n3. use the token\n');
		await expect(message).toHaveAttribute('data-list-line', 'false');
		await expect.poll(() => menuEnabled('composer-mode')).toBe(true);
		// Bullets, tasks and quotes; ⇧↩ inside a code block adds no marker.
		await message.pressSequentially('- [ ] a');
		await message.press('Shift+Enter');
		await message.pressSequentially('b');
		expect((await editorText(message)).endsWith('- [ ] a\n- [ ] b')).toBe(true);
		await message.press('Meta+a');
		await message.press('Backspace');
		await message.pressSequentially('```');
		await message.press('Shift+Enter');
		await message.pressSequentially('  - x');
		await message.press('Shift+Enter');
		expect(await editorText(message)).toBe('```\n  - x\n  ');
		await message.press('Meta+a');
		await message.press('Backspace');
		// ⌘B ⌘I ⌘E ⌘K: real keys, and the same from Edit ▸ Formatting.
		await message.pressSequentially('word');
		await message.press('Shift+Home');
		await message.press('Meta+b');
		expect(await editorText(message)).toBe('**word**');
		await message.press('Meta+b');
		expect(await editorText(message)).toBe('word');
		await message.press('Meta+i');
		expect(await editorText(message)).toBe('*word*');
		await message.press('Meta+i');
		await message.press('Meta+e');
		expect(await editorText(message)).toBe('`word`');
		await message.press('Meta+e');
		await message.press('Meta+k');
		expect(await editorText(message)).toBe('[word]()');
		expect((await editorState(message)).caret).toBe(7);
		await message.press('Meta+a');
		await message.press('Backspace');
		for (const id of ['format-bold', 'format-italic', 'format-code', 'format-link'])
			await expect.poll(() => menuEnabled(id)).toBe(true);
		await message.pressSequentially('menu');
		await message.press('Shift+Home');
		await app.evaluate(({ Menu }) =>
			Menu.getApplicationMenu()!.getMenuItemById('format-bold')!.click()
		);
		expect(await editorText(message)).toBe('**menu**');
		await message.press('Meta+a');
		await message.press('Backspace');
		// A paste of `•` lines becomes items.
		await page.evaluate(() => {
			const target = document.querySelector('[aria-label="Message"][data-prompt]')!;
			const data = new DataTransfer();
			data.setData('text/plain', '• one\n◦ two\n• three');
			target.dispatchEvent(
				new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
			);
		});
		expect(await editorText(message)).toBe('- one\n  - two\n- three');
		// Sent with ↩: the agent gets the Markdown as typed, the log draws it as a list.
		await message.press('Meta+a');
		await message.press('Backspace');
		await message.pressSequentially('- x');
		await message.press('Shift+Enter');
		await message.pressSequentially('y');
		await message.press('Enter');
		await expect(page.locator('[data-chat-message] ul > li')).toHaveText(['x', 'y']);
		expect(
			(
				await page.evaluate(() =>
					window.brigadir.readSession({ projectId: 'project', id: 'compose' })
				)
			).records.some(
				(record) => record.event.kind === 'turn.started' && record.event.text === '- x\n- y'
			)
		).toBe(true);
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
