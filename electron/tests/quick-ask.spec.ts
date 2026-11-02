import { refreshChanges } from './refresh-changes';
import { selectCode } from './select-code';
import {
	_electron as electron,
	expect,
	test,
	type ElectronApplication,
	type Page,
} from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { editorText } from './editor-text';
import { hideChat, openPanelTab, showChat } from './layout';

// spec/composer-steering-queue-and-ghost#quick-question: «Спитати агента» from a selection — a separate session of the task's provider answers in a popover under the lines.
const desktop = resolve('apps/desktop'),
	executablePath = createRequire(join(desktop, 'package.json'))('electron') as string;
const source = Array.from(
	{ length: 40 },
	(_, i) => `export const row${String(i + 1).padStart(2, '0')} = ${i + 1};`
).join('\n');
async function setup(prefix: string, stopped = false) {
	const root = await mkdtemp(join(tmpdir(), prefix)),
		repo = join(root, 'repo'),
		data = join(root, 'data'),
		log = join(root, 'agent.jsonl');
	await mkdir(repo);
	const git = (...args: string[]) => promisify(execFile)('git', args, { cwd: repo });
	await git('init', '-q', '-b', 'main');
	await git('config', 'user.name', 'Fixture');
	await git('config', 'user.email', 'fixture@example.invalid');
	await writeFile(join(repo, 'sample.ts'), source);
	await git('add', '.');
	await git('commit', '-q', '-m', 'Baseline');
	await mkdir(join(data, 'projects/project'), { recursive: true });
	await writeFile(
		join(data, 'projects/project/project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'repo', path: repo } })
	);
	// A finished task that never ran an agent: no host, no session to fork.
	if (stopped) {
		await mkdir(join(data, 'projects/project/tasks/task'), { recursive: true });
		await writeFile(
			join(data, 'projects/project/tasks/task/task.json'),
			JSON.stringify({
				schemaVersion: 1,
				task: {
					id: 'task',
					projectId: 'project',
					title: 'Make the rows constant',
					status: 'done',
					provider: 'claude',
					prompt: 'Make the rows constant',
				},
			})
		);
	}
	const env = Object.fromEntries(
		Object.entries(process.env).filter(
			(e): e is [string, string] => typeof e[1] === 'string' && e[0] !== 'ELECTRON_RUN_AS_NODE'
		)
	);
	const app = await electron.launch({
		executablePath,
		args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
		env: {
			...env,
			BRIGADIR_DATA_DIR: data,
			BRIGADIR_TEST_AGENT: resolve('packages/transport/fixtures/agent.mjs'),
			BRIGADIR_FIXTURE_LOG: log,
		},
	});
	const records = async () => {
		try {
			return (await readFile(log, 'utf8'))
				.trim()
				.split('\n')
				.filter(Boolean)
				.map((line) => JSON.parse(line) as { event: string; params: Record<string, unknown> });
		} catch {
			return [];
		}
	};
	return { root, repo, data, app, records };
}
async function openFile(page: Page) {
	await openPanelTab(page, 'files');
	await page.getByRole('treeitem', { name: 'sample.ts', exact: true }).dblclick();
	const editor = page.getByRole('textbox', { name: 'File content', exact: true });
	await expect(editor).toBeVisible();
	return editor;
}
async function selectLines(editor: ReturnType<Page['getByRole']>, first: number, count: number) {
	await editor.focus();
	await editor.press('Meta+ArrowUp');
	for (let i = 1; i < first; i++) await editor.press('ArrowDown');
	for (let i = 0; i < count; i++) await editor.press('Shift+ArrowDown');
}
const popover = (page: Page) => page.locator('[data-quick-ask]');
async function ask(page: Page, question: string) {
	const field = popover(page).getByRole('textbox', { name: 'Question to the agent', exact: true });
	await expect(field).toBeFocused();
	await field.fill(question);
	await field.press('Meta+Enter');
}
const menuItem = (app: ElectronApplication, label: string) =>
	app.evaluate(({ Menu }, label) => {
		const item = Menu.getApplicationMenu()!
			.items.find((item) => item.label === 'Editor')!
			.submenu!.items.find((item) => item.label === label)!;
		return { enabled: item.enabled, accelerator: item.accelerator ?? null };
	}, label);

test('the popover asks a stopped task: stream, Esc and ⌘I again, Apply with ⌘Z, Hand to the agent, the agent’s own edit and Revert, a permission @area:chat', async () => {
	test.setTimeout(120000);
	const { root, repo, app, records } = await setup('brigadir-quick-', true);
	try {
		const page = await app.firstWindow(),
			errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		const task = { projectId: 'project', id: 'task' };
		await page
			.getByRole('button', { name: /Make the rows constant/ })
			.first()
			.click();
		await refreshChanges(page);
		await expect
			.poll(() =>
				page.evaluate(async (key) => (await window.brigadir.readChanges(key)).checkpoint, task)
			)
			.not.toBeNull();
		const editor = await openFile(page),
			actions = page.locator('[data-selection-actions]');
		await selectLines(editor, 10, 3);
		await expect(actions).toContainText('sample.ts · 10–12');
		// The bar: «Ask the agent» first and primary, Comment beside it; the menu item and its ⌘I.
		const askButton = actions.getByRole('button', { name: 'Ask the agent', exact: true });
		await expect(actions.locator('button').first()).toHaveText('Ask the agent');
		await expect(askButton).toHaveAttribute('data-appearance', 'primary');
		await expect(actions.getByRole('button', { name: 'Comment', exact: true })).not.toHaveAttribute(
			'data-appearance',
			'primary'
		);
		expect(await menuItem(app, 'Ask the agent')).toEqual({
			enabled: true,
			accelerator: 'CmdOrCtrl+I',
		});
		await askButton.click();
		await expect(popover(page)).toBeVisible();
		await expect(actions).toHaveCount(0);
		await expect(popover(page)).toContainText('Ask the agent');
		await expect(popover(page)).toContainText('sample.ts · 10–12');
		await expect(popover(page)).toContainText('outside the task chat');
		// spec/diff-and-review#diff-selection: the selected code is quoted under the header, above the question.
		const quoted = popover(page).locator('[data-code-quote]');
		await expect(quoted).toContainText('row10');
		await expect(quoted).toContainText('row12');
		{
			const [head, quote, field] = await Promise.all([
				popover(page).locator('header').boundingBox(),
				quoted.boundingBox(),
				popover(page)
					.getByRole('textbox', { name: 'Question to the agent', exact: true })
					.boundingBox(),
			]);
			expect(quote!.y).toBeGreaterThanOrEqual(head!.y + head!.height);
			expect(field!.y).toBeGreaterThanOrEqual(quote!.y + quote!.height);
		}
		// It lies over the code under line 12 and does not push line 13 down.
		const line12 = page.locator('[data-font-surface=editor] .cm-line').filter({ hasText: 'row12' }),
			line13 = page.locator('[data-font-surface=editor] .cm-line').filter({ hasText: 'row13' });
		const [box, row12, row13] = await Promise.all([
			popover(page).boundingBox(),
			line12.boundingBox(),
			line13.boundingBox(),
		]);
		expect(box!.y).toBeGreaterThanOrEqual(row12!.y + row12!.height);
		expect(Math.abs(row13!.y - (row12!.y + row12!.height))).toBeLessThan(2);
		await ask(page, 'What is this?');
		await expect(popover(page).locator('[data-quick-answer="writing"]')).toContainText('Quick');
		await expect(popover(page).locator('[data-quick-answer="done"]')).toContainText(
			'Quick answer about sample.ts:10.'
		);
		await expect(popover(page)).toContainText(/Claude · \d/);
		const quick = (await records()).filter((record) => record.event === 'quick');
		expect(quick.at(-1)!.params).toMatchObject({
			question: 'What is this?',
			path: 'sample.ts',
			start: 10,
			readOnly: false,
			context: true,
		});
		expect((await records()).some((record) => record.event === 'fork')).toBe(false);
		// Nothing reached the task chat.
		expect(
			(await page.evaluate((key) => window.brigadir.readSession(key), task)).records.filter(
				(record) => record.event.kind === 'turn.started'
			)
		).toEqual([]);
		// Esc closes and returns the focus to the code; ⌘I on the same lines shows the last answer with «New question».
		await popover(page)
			.getByRole('textbox', { name: 'Question to the agent', exact: true })
			.press('Escape');
		await expect(popover(page)).toHaveCount(0);
		await expect(editor).toBeFocused();
		await expect(actions).toContainText('10–12');
		await editor.press('Meta+i');
		await expect(popover(page)).toContainText('Quick answer about sample.ts:10.');
		await popover(page).getByRole('button', { name: 'New question', exact: true }).click();
		// «Apply» puts the suggestion into the buffer as one edit; ⌘Z takes it back.
		await ask(page, 'suggest a shorter line');
		const suggestion = popover(page).locator('[data-quick-suggestion]');
		await expect(suggestion).toContainText('const quick = true;');
		await expect(suggestion).toContainText('export const row10 = 10;');
		await suggestion.getByRole('button', { name: 'Apply', exact: true }).click();
		await expect(suggestion).toContainText('Applied to sample.ts');
		await expect(page.locator('[data-font-surface=editor] .cm-line').nth(9)).toHaveText(
			'const quick = true;'
		);
		expect(await readFile(join(repo, 'sample.ts'), 'utf8')).toBe(source);
		await popover(page)
			.getByRole('textbox', { name: 'Question to the agent', exact: true })
			.press('Escape');
		await expect(editor).toBeFocused();
		await app.evaluate(({ Menu }) =>
			Menu.getApplicationMenu()!
				.items.find((item) => item.label === 'Edit')!
				.submenu!.items.find((item) => item.label === 'Undo')!
				.click()
		);
		await expect(page.locator('[data-font-surface=editor] .cm-line').nth(9)).toHaveText(
			'export const row10 = 10;'
		);
		// «Hand to the agent» (spec/composer#mentions): a pill of the lines in the composer text, then the question and the answer after it.
		await selectLines(editor, 10, 3);
		await editor.press('Meta+i');
		await popover(page).getByRole('button', { name: 'New question', exact: true }).click();
		await ask(page, 'Explain it');
		await expect(popover(page).locator('[data-quick-answer="done"]')).toContainText(
			'Quick answer about sample.ts:10.'
		);
		await popover(page).getByRole('button', { name: 'Hand to the agent', exact: true }).click();
		const message = page.getByRole('textbox', { name: 'Message', exact: true }),
			pill = message.locator('[data-mention-pill]', { hasText: 'sample.ts:10-12' });
		await expect(message).toBeFocused();
		await expect(pill).toHaveCount(1);
		await expect(pill).toHaveAttribute('data-kind', 'file');
		await expect(pill).toHaveAttribute('title', /^sample\.ts:10-12\n/);
		const handed = await editorText(message);
		// The draft the composer held (the task's unsent prompt) stays in front.
		expect(handed).toMatch(
			/^Make the rows constant\n@\[att:[^\]]+\]\nQuick question about these lines \(a separate agent session answered it; the files may already have its change\)\.\nQuestion: Explain it\nAnswer:\nQuick answer about sample\.ts:10\.$/
		);
		expect(
			await page.evaluate(() => document.querySelectorAll('[aria-label="Attachments"]').length)
		).toBe(0);
		// The agent changes the file itself: the change card, the log row, and Revert.
		await hideChat(page);
		await selectLines(editor, 10, 3);
		await editor.press('Meta+i');
		await popover(page).getByRole('button', { name: 'New question', exact: true }).click();
		await ask(page, 'edit it please');
		const change = popover(page).locator('[data-quick-change]');
		await expect(change).toContainText('Changed sample.ts');
		await expect(change).toContainText('+1');
		await expect(change).toContainText('−1');
		await expect
			.poll(() => readFile(join(repo, 'sample.ts'), 'utf8'))
			.toContain('export const row10 = 10; // quick');
		const journal = (
			await page.evaluate((key) => window.brigadir.readSession(key), task)
		).records.map((record) => record.event);
		expect(journal.find((event) => event.kind === 'quick-ask.changed')).toMatchObject({
			question: 'edit it please',
			files: ['sample.ts'],
		});
		expect(journal.filter((event) => event.kind === 'turn.started')).toEqual([]);
		await change.getByRole('button', { name: 'Revert', exact: true }).click();
		await expect(popover(page).locator('[data-quick-change="reverted"]')).toContainText(
			'Reverted: sample.ts'
		);
		await expect.poll(() => readFile(join(repo, 'sample.ts'), 'utf8')).toBe(source);
		// A permission in the manual mode is asked in the popover.
		await popover(page)
			.getByRole('textbox', { name: 'Question to the agent', exact: true })
			.fill('permission to edit');
		await popover(page)
			.getByRole('textbox', { name: 'Question to the agent', exact: true })
			.press('Meta+Enter');
		const permission = popover(page).locator('[data-quick-permission]');
		await expect(permission).toContainText('Edit sample.ts');
		await permission.getByRole('button', { name: 'Deny', exact: true }).click();
		await expect(permission).toHaveCount(0);
		await expect(popover(page).locator('[data-quick-answer="done"]').last()).toContainText(
			'Not changed.'
		);
		expect(await readFile(join(repo, 'sample.ts'), 'utf8')).toBe(source);
		await popover(page)
			.getByRole('textbox', { name: 'Question to the agent', exact: true })
			.press('Escape');
		// The log row of the edit: in the chat, one service row; it opens the diff.
		await showChat(page);
		await expect(page.locator('[data-quick-ask-row]')).toContainText(
			'The quick question changed 1 file · sample.ts'
		);
		// The handed text goes out with the pill where it stands: the lines' context first, then the question and the answer.
		await expect.poll(() => editorText(message)).toBe(handed);
		await expect(pill).toHaveCount(1);
		// The task has a journal now (the quick question's trace) but no host: Resume starts it, then the message goes.
		await page.getByRole('button', { name: 'Resume', exact: true }).click();
		await expect(page.getByText('The host is disconnected.')).toHaveCount(0, { timeout: 30000 });
		// Resume sends the task's own first prompt; the handed draft waits in the composer and goes after that turn.
		await expect
			.poll(
				async () =>
					(await page.evaluate((key) => window.brigadir.readSession(key), task)).records.some(
						(record) => record.event.kind === 'turn.completed'
					),
				{ timeout: 30000 }
			)
			.toBe(true);
		await expect.poll(() => editorText(message)).toBe(handed);
		await message.click();
		await message.press('Enter');
		await expect.poll(() => editorText(message)).toBe('');
		await expect
			.poll(
				async () =>
					(await records()).some(
						(record) =>
							record.event === 'prompt-blocks' &&
							JSON.stringify(record.params).includes('Question: Explain it')
					),
				{ timeout: 30000 }
			)
			.toBe(true);
		const blocks = (await records()).filter((record) => record.event === 'prompt-blocks').at(-1)!
			.params as unknown as { type: string; text?: string }[];
		const own = blocks.filter(
			(block) =>
				block.type !== 'text' || !block.text!.startsWith('<attached_context name="Brigadir brief"')
		);
		const pillAt = own.findIndex(
			(block) =>
				block.text?.includes('<attached_context name="sample.ts:10-12">') &&
				block.text.includes('Read file @\"sample.ts\", lines 10-12.')
		);
		const askedAt = own.findIndex((block) =>
			block.text?.includes('Question: Explain it\nAnswer:\nQuick answer about sample.ts:10.')
		);
		expect(pillAt).toBeGreaterThanOrEqual(0);
		expect(askedAt).toBeGreaterThan(pillAt);
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});

test('a running turn does not hold the quick question: a fork of the task session answers; the diff asks too @area:chat', async () => {
	test.setTimeout(120000);
	const { root, repo, app, records } = await setup('brigadir-quick-busy-');
	try {
		const page = await app.firstWindow(),
			errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		const task = await page.evaluate(async () => {
			const task = await window.brigadir.createTask(
				'project',
				'Count the rows',
				'claude',
				'gui',
				false
			);
			await window.brigadir.startSession(task);
			return task;
		});
		const kinds = async () =>
			(await page.evaluate((key) => window.brigadir.readSession(key), task)).records.map(
				(record) => record.event.kind
			);
		await expect.poll(async () => (await kinds()).includes('turn.completed')).toBe(true);
		// The task's second turn holds until Stop: the quick question runs beside it.
		await page.evaluate(
			(key) => window.brigadir.sendCommand(key, { kind: 'prompt', text: 'hold' }),
			task
		);
		await expect
			.poll(async () => (await kinds()).filter((kind) => kind === 'turn.started').length)
			.toBe(2);
		await page
			.locator('aside')
			.getByRole('button', { name: /Count the rows/ })
			.first()
			.click();
		await writeFile(
			join(repo, 'sample.ts'),
			source.replace('export const row05 = 5;', 'export const row05 = 50;')
		);
		await refreshChanges(page);
		const editor = await openFile(page);
		await selectLines(editor, 5, 2);
		await page
			.locator('[data-selection-actions]')
			.getByRole('button', { name: 'Ask the agent', exact: true })
			.click();
		await ask(page, 'Why 50?');
		await expect(popover(page).locator('[data-quick-answer="done"]')).toContainText(
			'Quick answer about sample.ts:5.'
		);
		const log = await records();
		expect(log.some((record) => record.event === 'fork')).toBe(true);
		expect(log.some((record) => record.event === 'resume')).toBe(true);
		expect(log.filter((record) => record.event === 'quick').at(-1)!.params).toMatchObject({
			context: false,
			path: 'sample.ts',
			start: 5,
		});
		// The task turn still runs.
		const session = await page.evaluate((key) => window.brigadir.readSession(key), task);
		expect(
			session.records.findLast((record) =>
				['turn.started', 'turn.completed'].includes(record.event.kind)
			)!.event.kind
		).toBe('turn.started');
		await popover(page)
			.getByRole('textbox', { name: 'Question to the agent', exact: true })
			.press('Escape');
		// The diff: select a line's text, ask with ⌘I.
		await openPanelTab(page, 'changes');
		await page
			.getByRole('list', { name: 'Files', exact: true })
			.getByRole('button', { name: /sample.ts/ })
			.click();
		const diff = page.getByRole('log', { name: 'Diff', exact: true });
		await expect(diff).toBeVisible();
		await selectCode(diff, 'new', 5);
		const bar = diff.locator('[data-selection-actions]');
		await expect(bar.getByRole('button', { name: 'Ask the agent', exact: true })).toBeVisible();
		await expect
			.poll(() => menuItem(app, 'Ask the agent'))
			.toEqual({ enabled: true, accelerator: 'CmdOrCtrl+I' });
		await app.evaluate(({ Menu }) =>
			Menu.getApplicationMenu()!
				.items.find((item) => item.label === 'Editor')!
				.submenu!.items.find((item) => item.label === 'Ask the agent')!
				.click()
		);
		await expect(popover(page)).toContainText('sample.ts · 5');
		await ask(page, 'What changed?');
		await expect(popover(page).locator('[data-quick-answer="done"]')).toContainText(
			'Quick answer about sample.ts:5.'
		);
		await page.evaluate((key) => window.brigadir.sendCommand(key, { kind: 'cancel' }), task);
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});

test('quick question model capsule: the menu by provider, a limit, another session with a divider @area:chat', async () => {
	const { root, app, records } = await setup('brigadir-quick-choice-', true);
	try {
		const page = await app.firstWindow();
		await page
			.getByRole('button', { name: /Make the rows constant/ })
			.first()
			.click();
		const editor = await openFile(page);
		await selectLines(editor, 10, 3);
		await page
			.locator('[data-selection-actions]')
			.getByRole('button', { name: 'Ask the agent', exact: true })
			.click();
		const panel = popover(page);
		// spec/composer-steering-queue-and-ghost#quick-question: one composer capsule with the model only, at the left of the footer before the first question.
		const capsule = panel.getByRole('group', { name: 'Agent options', exact: true });
		const model = capsule.getByRole('button', { name: 'Model', exact: true });
		await expect(model).toHaveText('Fixture');
		await expect(capsule.locator('[data-option-kind]')).toHaveCount(1);
		await panel.getByRole('textbox').fill('quota retry');
		await panel.getByRole('button', { name: 'Ask', exact: true }).click();
		await expect(panel.locator('[data-quick-answer="failed"]')).toBeVisible();
		await expect(panel.locator('[data-quick-limit]')).toContainText(/^Claude limit · \d+/);
		await expect(panel.getByRole('button', { name: 'Try again', exact: true })).toBeDisabled();
		await expect(panel).toContainText('Pick another model below.');
		await model.click();
		const menu = page.getByRole('dialog', { name: 'Model', exact: true });
		await expect(menu.getByRole('radiogroup', { name: 'Model · Claude' })).toContainText('task');
		await expect(menu).toContainText('Limit ·');
		await expect(menu.getByRole('radiogroup', { name: 'Model · Codex' })).toBeVisible();
		await menu.press('Escape');
		await expect(menu).toBeHidden();
		await expect(panel).toBeVisible();
		await expect(model).toBeFocused();
		await model.click();
		await menu
			.getByRole('radiogroup', { name: 'Model · Codex' })
			.getByRole('radio', { name: 'Other' })
			.click();
		await expect(model).toHaveText('Other');
		await expect(panel.getByRole('textbox')).toHaveAttribute('placeholder', 'Ask Codex…');
		await expect(panel.locator('[data-quick-new-session]')).toBeVisible();
		await panel.getByRole('button', { name: 'Ask again with Codex', exact: true }).click();
		await expect(panel.locator('[data-quick-answer="done"]')).toBeVisible();
		await expect(panel.locator('[data-quick-session]')).toHaveText('New session · Codex · Other');
		await expect(panel.locator('[data-quick-answer]')).toHaveCount(2);
		await expect(panel).toContainText(/Codex ·/);
		const log = await records();
		expect(
			log.some(
				(r) => r.event === 'option' && r.params.configId === 'model' && r.params.value === 'other'
			)
		).toBe(true);
		expect(log.some((r) => r.event === 'fork')).toBe(false);
		await model.click();
		await menu
			.getByRole('radiogroup', { name: 'Model · Claude' })
			.getByRole('radio', { name: 'Fixture' })
			.click();
		await expect(panel.getByRole('textbox')).toHaveAttribute('placeholder', 'Ask Claude…');
		await panel.getByRole('textbox').fill('What is this again?');
		await panel.getByRole('textbox').press('Meta+Enter');
		await expect(panel.locator('[data-quick-answer]')).toHaveCount(3);
		await expect(panel.locator('[data-quick-answer]').last()).toHaveAttribute(
			'data-quick-answer',
			'done'
		);
		await expect(panel.locator('[data-quick-session]').last()).toHaveText(
			'New session · Claude · Fixture'
		);
		await expect(panel.getByRole('textbox')).toHaveAttribute('placeholder', 'Ask more…');
		await page.evaluate(async () => {
			const { settings } = await window.brigadir.readSettings();
			await window.brigadir.saveSettings({ ...settings, appearance: 'dark' });
		});
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await model.click();
		await expect(menu).toBeVisible();
		await menu.press('Escape');
		await expect(panel).toBeVisible();
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
