import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { editorState, editorText } from './editor-text';
import { hideWorkArea, hidePanel } from './layout';
const desktop = resolve('apps/desktop'),
	executablePath = createRequire(join(desktop, 'package.json'))('electron') as string;

// spec/composer#mention-menu, spec/composer#mentions: `@` opens the menu with tabs All · Files · Agents · Tasks · Models at once; a pick is a pill in its place in the text
// and reaches the agent there; `/` lists the agent's commands and a pick stays text.
test('composer @ menu has tabs, picks become pills in the text and reach the agent in order; / lists agent commands @area:chat', async () => {
	test.setTimeout(90000);
	const root = await mkdtemp(join(tmpdir(), 'brigadir-mentions-')),
		repo = join(root, 'repo'),
		data = join(root, 'data'),
		project = join(data, 'projects/project'),
		task = join(project, 'tasks/first'),
		agentLog = join(root, 'agent.jsonl');
	await mkdir(join(repo, 'src/components'), { recursive: true });
	await writeFile(join(repo, 'src/App.tsx'), 'export {};\n');
	await writeFile(join(repo, 'src/components/Button.tsx'), 'export {};\n');
	await writeFile(join(repo, 'README.md'), '# repo\n');
	await mkdir(task, { recursive: true });
	await writeFile(
		join(project, 'project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'repo', path: repo } })
	);
	await writeFile(
		join(task, 'task.json'),
		JSON.stringify({
			schemaVersion: 1,
			task: {
				id: 'first',
				projectId: 'project',
				title: 'Mentions',
				status: 'done',
				provider: 'claude',
			},
		})
	);
	await mkdir(join(project, 'tasks/second'), { recursive: true });
	await writeFile(
		join(project, 'tasks/second/task.json'),
		JSON.stringify({
			schemaVersion: 1,
			task: {
				id: 'second',
				projectId: 'project',
				title: 'Fresh task',
				status: 'done',
				provider: 'claude',
			},
		})
	);
	await writeFile(
		join(project, 'tasks/second/events.jsonl'),
		[
			{ kind: 'turn.started', text: 'Split the exports' },
			{
				kind: 'message.delta',
				role: 'assistant',
				messageId: 'm1',
				content: { kind: 'text', text: 'Moved the icons out.' },
			},
			{ kind: 'turn.completed', reason: 'end_turn' },
		]
			.map((event, index) =>
				JSON.stringify({ schemaVersion: 1, seq: index + 1, at: '2026-10-01T10:00:00.000Z', event })
			)
			.join('\n') + '\n'
	);
	await mkdir(join(project, 'tasks/worker'), { recursive: true });
	await writeFile(
		join(project, 'tasks/worker/task.json'),
		JSON.stringify({
			schemaVersion: 1,
			task: {
				id: 'worker',
				projectId: 'project',
				title: 'Developer · src',
				status: 'working',
				provider: 'claude',
				parentTaskId: 'second',
				crewTaskId: 'second',
				crewNodeId: 'developer',
			},
		})
	);
	const commands = [
		{ name: 'review', description: 'Review the pending changes', inputHint: null },
		{
			name: 'compact',
			description: 'Free up context by summarizing the conversation',
			inputHint: '<instructions>',
		},
		{ name: 'figma:figma-use', description: '(figma) Use the Figma plugin API', inputHint: null },
	];
	await writeFile(
		join(task, 'events.jsonl'),
		JSON.stringify({
			schemaVersion: 1,
			seq: 1,
			at: '2026-10-01T10:00:00.000Z',
			event: { kind: 'commands.changed', commands },
		}) + '\n'
	);
	const env = Object.fromEntries(
		Object.entries(process.env).filter(
			(e): e is [string, string] => typeof e[1] === 'string' && e[0] !== 'ELECTRON_RUN_AS_NODE'
		)
	);
	// spec/composer#slash-menu: the `/` list reads the agent's home; an empty one keeps the developer's skills out of the test.
	const home = join(root, 'home');
	await mkdir(home, { recursive: true });
	const app = await electron.launch({
		executablePath,
		args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
		env: {
			...env,
			HOME: home,
			BRIGADIR_DATA_DIR: data,
			BRIGADIR_FIXTURE_LOG: agentLog,
			BRIGADIR_TEST_AGENT: resolve('packages/transport/fixtures/agent.mjs'),
		},
	});
	try {
		const page = await app.firstWindow(),
			errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		// The provider catalogs are the agents' own; here a fixed one, so Models has rows.
		await app.evaluate(({ ipcMain }) => {
			const handlers = (ipcMain as any)._invokeHandlers;
			handlers.set('templates:catalog', async (_event: unknown, provider: string) =>
				provider !== 'claude'
					? null
					: {
							provider,
							modes: [],
							options: [
								{
									id: 'model',
									name: 'Model',
									description: null,
									category: 'model',
									kind: 'select',
									value: 'opus',
									choices: [
										{ value: 'opus', name: 'Opus', description: null, group: null },
										{ value: 'sonnet', name: 'Sonnet', description: null, group: null },
									],
								},
							],
						}
			);
		});
		await page.getByRole('button', { name: /Mentions/ }).click();
		// The chat as wide as it stood alone before the work area (spec/task-window-workspace#layout-switch): the work area and the panel away.
		await hideWorkArea(page);
		await hidePanel(page);
		const message = page.getByRole('textbox', { name: 'Message', exact: true });
		await expect(message).toHaveAttribute('aria-busy', 'false');
		// The index answers late: the menu is already open, Files says it searches.
		await app.evaluate(({ ipcMain }) => {
			const handlers = (ipcMain as any)._invokeHandlers,
				original = handlers.get('files:search');
			handlers.set('files:search', async (...args: any[]) => {
				handlers.set('files:search', original);
				const value = await original(...args);
				await new Promise<void>((resolve) => {
					(globalThis as any).finishSearch = resolve;
				});
				return value;
			});
		});
		await message.click();
		await message.pressSequentially('do a @');
		const mention = page.getByRole('listbox', { name: 'Mention' }),
			tabs = page.getByRole('tablist', { name: 'Mention groups' });
		await expect(tabs.getByRole('tab')).toHaveText([
			'All11',
			'Files0',
			'Agents7',
			'Tasks2',
			'Models2',
		]);
		await expect(tabs.getByRole('tab', { name: /^All/ })).toHaveAttribute('aria-selected', 'true');
		await expect(message).toHaveAttribute('aria-controls', /.+/);
		// All: every group in one list under its caption; the crew agent stands under its task.
		await expect(mention.getByRole('option')).toHaveText([
			/Developer/,
			/Senior developer/,
			/Tester/,
			/Technical writer/,
			/Reviewer/,
			/Designer/,
			/Security reviewer/,
			/Fresh task/,
			/Developer · src/,
			/opus/,
			/sonnet/,
		]);
		await expect(mention.getByText('Models · Claude', { exact: true })).toBeVisible();
		// Tab moves to the next tab and keeps the text; Files still searches.
		await message.press('Tab');
		await expect(tabs.getByRole('tab', { name: /^Files/ })).toHaveAttribute(
			'aria-selected',
			'true'
		);
		// spec/appearance#loading: rows of a skeleton stand for the results; the status keeps its name for screen readers.
		await expect(mention.getByRole('status')).toHaveAccessibleName('Searching…');
		expect(await editorText(message)).toBe('do a @');
		await expect(message).toBeFocused();
		await expect
			.poll(() => app.evaluate(() => typeof (globalThis as any).finishSearch))
			.toBe('function');
		await app.evaluate(() => (globalThis as any).finishSearch());
		await expect(mention.getByRole('option').first()).toBeVisible();
		await expect(mention.getByRole('status')).toHaveCount(0);
		// Typing goes on filtering in the tab.
		await message.pressSequentially('butt');
		await expect(mention.getByRole('option')).toHaveCount(1);
		await expect(mention.getByRole('option')).toContainText('Button.tsx');
		await expect(mention.getByRole('option')).toContainText('src/components/Button.tsx');
		await message.press('Enter');
		const pills = message.locator('[data-mention-pill]');
		await expect(pills).toHaveCount(1);
		await expect(pills.first()).toHaveText('Button.tsx');
		await expect(pills.first()).toHaveAttribute('data-kind', 'file');
		await expect(mention).toHaveCount(0);
		expect(await editorText(message)).toMatch(/^do a @\[att:[0-9a-f-]{36}\] $/);
		await expect(page.locator('form [data-attachments]')).toHaveCount(0);
		expect(
			(
				await page.evaluate(() =>
					window.brigadir.readSession({ projectId: 'project', id: 'first' })
				)
			).records.some((record) => record.event.kind === 'turn.started')
		).toBe(false);
		// spec/composer#mention-menu: a folder is in Files too; it attaches as a reference and its pill has the folder glyph.
		await message.pressSequentially('in @compon');
		await expect(
			mention.getByRole('option').filter({ has: page.locator('[data-glyph="folder"]') })
		).toHaveText([/components/]);
		await mention
			.getByRole('option')
			.filter({ has: page.locator('[data-glyph="folder"]') })
			.click();
		await expect(pills).toHaveCount(2);
		await expect(pills.nth(1)).toHaveText('components');
		await expect(pills.nth(1)).toHaveAttribute('data-kind', 'folder');
		// ⇧Tab goes back round to the last tab; Models ticks nothing before the session names the task's model.
		await message.pressSequentially('with @');
		await message.press('Shift+Tab');
		await expect(tabs.getByRole('tab', { name: /^Models/ })).toHaveAttribute(
			'aria-selected',
			'true'
		);
		await message.press('Shift+Tab');
		await expect(tabs.getByRole('tab', { name: /^Tasks/ })).toHaveAttribute(
			'aria-selected',
			'true'
		);
		await expect(mention.getByRole('option')).toHaveText([/Fresh task/, /Developer · src/]);
		await mention.getByRole('option', { name: /Fresh task/ }).hover();
		await expect(mention.getByRole('option', { name: /Fresh task/ })).toHaveAttribute(
			'aria-selected',
			'true'
		);
		await message.press('Enter');
		await expect(pills).toHaveCount(3);
		await expect(pills.nth(2)).toHaveText('Fresh task');
		await expect(pills.nth(2)).toHaveAttribute('data-kind', 'task');
		await message.pressSequentially('using @sonnet');
		await expect(tabs.getByRole('tab', { name: /^All/ })).toHaveAttribute('aria-selected', 'true');
		await mention.getByRole('option', { name: /sonnet/ }).click();
		await expect(pills).toHaveCount(4);
		await expect(pills.nth(3)).toHaveText('sonnet');
		expect(await editorText(message)).toMatch(
			/^do a @\[att:[0-9a-f-]{36}\] in @\[att:[0-9a-f-]{36}\] with @\[task:second\] using @\[model:claude:sonnet\] $/
		);
		// No match: the menu stays and says the word stays text (spec/composer#mentions); Esc closes it for this word only.
		await message.pressSequentially('@zzzz');
		await expect(mention.getByRole('status')).toHaveText('No matches');
		await expect(tabs.getByRole('tab')).toHaveText([
			'All0',
			'Files0',
			'Agents0',
			'Tasks0',
			'Models0',
		]);
		await message.press('Escape');
		await expect(mention).toHaveCount(0);
		await message.pressSequentially('z');
		await expect(mention).toHaveCount(0);
		for (let i = 0; i < 6; i++) await message.press('Backspace');
		// The first ⌫ after a pill selects it whole, the second takes it and its meaning away.
		await message.press('Backspace');
		await message.press('Backspace');
		await expect(pills).toHaveCount(4);
		expect((await editorState(message)).selected).toBe('@[model:claude:sonnet]');
		await message.press('Backspace');
		await expect(pills).toHaveCount(3);
		await message.press('Meta+z');
		await expect(pills).toHaveCount(4);
		// spec/composer#mention-menu: once a query is typed, a matching agent template stands above the files; its pick is a pill.
		await message.press('End');
		await message.pressSequentially(' then run @test');
		await expect(mention.getByRole('option').first()).toContainText('Tester');
		await message.press('Enter');
		await expect(pills).toHaveCount(5);
		await expect(pills.nth(4)).toHaveText('Tester');
		await expect(pills.nth(4)).toHaveAttribute('data-kind', 'agent');
		expect(await editorText(message)).toMatch(/ then run @\[agent:tester\] $/);
		// Send: the attachment, the task summary and the agent template stand where the text puts them, the model goes as text.
		await page.getByRole('button', { name: 'Resume', exact: true }).click();
		await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
		await message.press('End');
		await message.press('Enter');
		await expect.poll(() => editorText(message)).toBe('');
		await expect
			.poll(
				async () => (await readFile(agentLog, 'utf8').catch(() => '')).includes('"prompt-blocks"'),
				{ timeout: 20000 }
			)
			.toBe(true);
		const blocks = (
			(await readFile(agentLog, 'utf8'))
				.trim()
				.split('\n')
				.map((line) => JSON.parse(line) as { event: string; params: any })
				.filter((entry) => entry.event === 'prompt-blocks')
				.at(-1)!.params as { type: string; text?: string }[]
		).filter(
			(block) =>
				!/^<attached_context name="(Brigadir brief|Workspace repositories)"/.test(block.text ?? '')
		);
		expect(blocks.map((block) => block.text!.split('\n')[0])).toEqual([
			'do a ',
			'<attached_context name="Button.tsx">',
			' in ',
			'<attached_context name="components/">',
			' with ',
			'<attached_context name="Task summary · Fresh task">',
			' using `sonnet` (Claude) then run ',
			'<attached_context name="Agent template · Tester">',
		]);
		// spec/composer#agent-blocks: the template reaches the agent as a role for a subagent.
		expect(blocks[7]!.text).toContain('start a subagent with your own subagent tool');
		expect(blocks[7]!.text).toContain('You work as Tester, a subagent');
		expect(blocks[3]!.text).toContain('Directory reference:');
		expect(blocks[5]!.text).toContain('Original request:\nSplit the exports');
		expect(blocks[5]!.text).toContain('Latest agent answer:\nMoved the icons out.');
		// The log shows the same pills; the rail and copy read names.
		const reply = page
			.getByRole('log', { name: 'Conversation' })
			.locator('[data-chat-message]')
			.filter({ hasText: 'do a' });
		await expect(reply).toContainText('do a Button.tsx in components with Fresh task using sonnet');
		await expect(
			reply.locator('button[data-kind="folder"]', { hasText: 'components' })
		).toBeVisible();
		await expect(reply.locator('button', { hasText: 'Button.tsx' })).toBeVisible();
		await expect(reply.locator('button[data-kind="agent"]', { hasText: 'Tester' })).toBeVisible();
		// spec/composer#slash-menu, spec/composer#mentions: `/` lists the agent's commands, the composer's actions and our MCP tools, its groups as tabs with
		// All first; Tab switches the tab, Enter picks, and the pick stays text the agent reads.
		await message.pressSequentially('/');
		const slash = page.getByRole('listbox', { name: 'Slash commands' });
		// spec/browser-and-simulator#background added browser_show to the MCP tools, spec/editor-code-intelligence#language-server-restart editor_restart_language_servers, spec/notifications-slack-notes-and-schedules#notes note_read / note_edit.
		await expect(slash.getByRole('option')).toHaveCount(25);
		await expect(tabs.getByRole('tab')).toHaveText([
			'All25',
			'Slash commands3',
			'Actions1',
			'MCP tools21',
		]);
		await expect(tabs.getByRole('tab', { name: /^All/ })).toHaveAttribute('aria-selected', 'true');
		await expect(slash.getByRole('option').nth(0)).toContainText('/review');
		await expect(slash.getByRole('option').nth(3)).toContainText('Attach files');
		await expect(slash.getByRole('option').nth(4)).toContainText('mcp__brigadir__ask_user');
		await message.press('Tab');
		await expect(tabs.getByRole('tab', { name: /^Slash commands/ })).toHaveAttribute(
			'aria-selected',
			'true'
		);
		await expect(slash.getByRole('option')).toHaveCount(3);
		await message.pressSequentially('compa');
		await expect(slash.getByRole('option')).toHaveCount(1);
		await expect(slash.getByRole('option')).toContainText('/compact');
		await message.press('Enter');
		expect(await editorText(message)).toBe('/compact ');
		await expect(slash).toHaveCount(0);
		await message.fill('');
		await message.pressSequentially('/');
		await message.press('ArrowDown');
		await expect(slash.getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true');
		await slash.getByRole('option', { name: /figma:figma-use/ }).hover();
		await expect(slash.getByRole('option', { name: /figma:figma-use/ })).toHaveAttribute(
			'aria-selected',
			'true'
		);
		await slash.getByRole('option', { name: /figma:figma-use/ }).click();
		expect(await editorText(message)).toBe('/figma:figma-use ');
		await expect(message).toBeFocused();
		// In the middle of the text the agent's built-in commands are not offered: it does not run them there.
		await message.fill('');
		await message.pressSequentially('run /');
		await expect(slash.getByRole('option').first()).toContainText('Attach files');
		await expect(slash.getByRole('option').nth(1)).toContainText('mcp__brigadir__ask_user');
		await expect(slash.getByRole('option', { name: /compact/ })).toHaveCount(0);
		await message.pressSequentially('rev');
		await expect(slash.getByRole('option', { name: /\/review/ })).toHaveCount(0);
		expect(await editorText(message)).toBe('run /rev');
		await message.press('Escape');
		await message.fill('');
		// Before the agent announced its commands, `/` shows the preliminary list from disk under a grey note (spec/composer#slash-menu).
		await page.locator('[data-sidebar-task="second"]').click();
		await expect(message).toHaveAttribute('aria-busy', 'false');
		await message.click();
		await message.pressSequentially('/');
		await expect(slash.getByText('Preliminary list. Agent not started.')).toBeVisible();
		await expect(slash).toHaveAttribute('aria-description', 'Preliminary list. Agent not started.');
		await expect(slash.getByRole('option').first()).toContainText('Attach files');
		await message.press('Escape');
		await expect(slash).toHaveCount(0);
		expect(await editorText(message)).toBe('/');
		expect(errors).toEqual([]);
	} finally {
		try {
			const page = app.windows()[0];
			if (page)
				await page.evaluate(() =>
					window.brigadir.sendCommand({ projectId: 'project', id: 'first' }, { kind: 'shutdown' })
				);
		} catch {}
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
