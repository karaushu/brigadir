import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { editorText } from './editor-text';
const desktop = resolve('apps/desktop'),
	executablePath = createRequire(join(desktop, 'package.json'))('electron') as string;
const put = async (path: string, text: string) => {
	await mkdir(join(path, '..'), { recursive: true });
	await writeFile(path, text);
};

// spec/composer#slash-menu: `/` anywhere in the text — the list from disk before the agent starts, skills, MCP tools and actions.
test('/ opens anywhere in the text, lists skills and MCP tools before the agent starts, and runs an action @area:chat @smoke', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-slash-')),
		repo = join(root, 'repo'),
		data = join(root, 'data'),
		home = join(root, 'home'),
		project = join(data, 'projects/project');
	await put(join(repo, 'README.md'), '# repo\n');
	await put(join(repo, 'notes.txt'), 'notes\n');
	await put(
		join(home, '.claude/skills/probe-skill/SKILL.md'),
		'---\nname: probe-skill\ndescription: Answers with a marker\n---\nAnswer SKILL-OK.'
	);
	await put(
		join(repo, '.claude/commands/deploy.md'),
		'---\ndescription: Deploy the app\nargument-hint: <env>\n---\nDeploy.'
	);
	await put(
		join(home, '.claude.json'),
		JSON.stringify({ mcpServers: { webstorm: { command: 'webstorm' } } })
	);
	await put(
		join(project, 'project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'repo', path: repo } })
	);
	await put(
		join(project, 'tasks/fresh/task.json'),
		JSON.stringify({
			schemaVersion: 1,
			task: {
				id: 'fresh',
				projectId: 'project',
				title: 'Fresh slash',
				status: 'done',
				provider: 'claude',
			},
		})
	);
	await put(
		join(project, 'tasks/started/task.json'),
		JSON.stringify({
			schemaVersion: 1,
			task: {
				id: 'started',
				projectId: 'project',
				title: 'Started slash',
				status: 'done',
				provider: 'claude',
			},
		})
	);
	const commands = [
		{ name: 'compact', description: 'Free up context', inputHint: null },
		{ name: 'probe-skill', description: 'Answers with a marker', inputHint: null },
		{ name: 'deploy', description: 'Deploy the app', inputHint: '<env>' },
		{ name: 'verify', description: 'Verify a change', inputHint: null },
	];
	await writeFile(
		join(project, 'tasks/started/events.jsonl'),
		JSON.stringify({
			schemaVersion: 1,
			seq: 1,
			at: '2026-10-06T10:00:00.000Z',
			event: { kind: 'commands.changed', commands },
		}) + '\n'
	);
	const env = Object.fromEntries(
		Object.entries(process.env).filter(
			(e): e is [string, string] =>
				typeof e[1] === 'string' &&
				e[0] !== 'ELECTRON_RUN_AS_NODE' &&
				e[0] !== 'CLAUDE_CONFIG_DIR' &&
				e[0] !== 'CODEX_HOME'
		)
	);
	const app = await electron.launch({
		executablePath,
		args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
		env: {
			...env,
			HOME: home,
			BRIGADIR_DATA_DIR: data,
			BRIGADIR_TEST_AGENT: resolve('packages/transport/fixtures/agent.mjs'),
		},
	});
	try {
		const page = await app.firstWindow();
		await page.getByRole('button', { name: /Fresh slash/ }).click();
		const message = page.getByRole('textbox', { name: 'Message', exact: true });
		await expect(message).toHaveAttribute('aria-busy', 'false');
		const slash = page.getByRole('listbox', { name: 'Slash commands' }),
			note = 'Preliminary list. Agent not started.';
		// Before the start: the disk's command and skill, our tools and the person's server, under the grey note.
		await message.click();
		await message.pressSequentially('please use /');
		await expect(slash).toHaveAttribute('aria-description', note);
		await expect(slash.getByText(note)).toBeVisible();
		await expect(slash.getByRole('option').nth(0)).toContainText('/deploy');
		await expect(slash.getByRole('option').nth(1)).toContainText('/probe-skill');
		const captions = await slash.locator('[aria-hidden="true"]').allTextContents();
		expect(
			captions.filter((text) => ['Slash commands', 'Skills', 'MCP tools', 'Actions'].includes(text))
		).toEqual(['Slash commands', 'Skills', 'Actions', 'MCP tools']);
		await expect(slash.getByRole('option').nth(2)).toContainText('Attach files');
		await expect(slash.getByRole('option').nth(3)).toContainText('mcp__brigadir__ask_user');
		await expect(slash.getByRole('option', { name: /mcp__webstorm/ })).toContainText('MCP server');
		await message.pressSequentially('probe');
		await expect(slash.getByRole('option')).toHaveCount(1);
		await message.press('Enter');
		expect(await editorText(message)).toBe('please use /probe-skill ');
		await expect(slash).toHaveCount(0);
		// An MCP tool by the last part of its name; the pick is the name the agent calls it by.
		await message.pressSequentially('and check with /ask');
		await expect(slash.getByRole('option').first()).toContainText('mcp__brigadir__ask_user');
		await message.press('Enter');
		expect(await editorText(message)).toBe(
			'please use /probe-skill and check with mcp__brigadir__ask_user '
		);
		// In the middle of a word or in a path `/` stays text.
		await message.pressSequentially('a/b /usr/');
		await expect(slash).toHaveCount(0);
		// An action removes `/word` and runs: Attach files puts the picked file in the text as a pill (spec/composer#mentions).
		await app.evaluate(
			({ dialog }, path) => {
				dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
			},
			join(repo, 'notes.txt')
		);
		await message.fill('');
		await message.pressSequentially('see /att');
		await expect(slash.getByRole('option')).toHaveCount(1);
		await expect(slash.getByRole('option')).toContainText('Attach files');
		await message.press('Enter');
		await expect(message.locator('[data-mention-pill]', { hasText: 'notes.txt' })).toBeVisible();
		expect(await editorText(message)).toMatch(/^see @\[att:[0-9a-f-]{36}\] $/);
		expect(
			(
				await page.evaluate(() =>
					window.brigadir.readSession({ projectId: 'project', id: 'fresh' })
				)
			).records.some((record) => record.event.kind === 'turn.started')
		).toBe(false);
		// After `commands.changed` the agent's list replaces the disk's and the note goes; its built-in commands only start a message.
		await page.getByRole('button', { name: /Started slash/ }).click();
		await expect(message).toHaveAttribute('aria-busy', 'false');
		await message.click();
		await message.pressSequentially('then /');
		await expect(slash.getByRole('option').first()).toContainText('/deploy');
		await expect(slash.getByText(note)).toHaveCount(0);
		await expect(slash).not.toHaveAttribute('aria-description', /.+/);
		// Tab goes round every tab: an empty one keeps the menu open with its own row, it does not close it.
		await message.pressSequentially('probe');
		await expect(page.getByRole('tab', { name: /^Slash commands/ })).toHaveText('Slash commands0');
		await message.press('Tab');
		await expect(page.getByRole('tab', { name: /^Slash commands/ })).toHaveAttribute(
			'aria-selected',
			'true'
		);
		await expect(slash).toContainText('No matches');
		await message.press('Tab');
		await expect(page.getByRole('tab', { name: /^Skills/ })).toHaveAttribute(
			'aria-selected',
			'true'
		);
		await expect(slash.getByRole('option')).toContainText('/probe-skill');
		await message.press('Shift+Tab');
		await message.press('Shift+Tab');
		await expect(page.getByRole('tab', { name: /^All/ })).toHaveAttribute('aria-selected', 'true');
		for (let i = 0; i < 4; i++) await message.press('Backspace');
		await expect(slash.getByRole('option', { name: /\/compact/ })).toHaveCount(0);
		await expect(slash.getByRole('option', { name: /\/verify/ })).toHaveCount(0);
		await message.fill('');
		await message.pressSequentially('/');
		await expect(slash.getByRole('option').nth(0)).toContainText('/compact');
		await expect(slash.getByRole('option', { name: /\/verify/ })).toHaveCount(1);
		await message.press('Escape');
		await message.fill('');
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});

// spec/composer#slash-menu: the prompt editor of the New task sheet has the same `/` menu, from the same disk list.
test('/ in the New task sheet lists the skills of the chosen agent @area:chat', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-slash-sheet-')),
		repo = join(root, 'repo'),
		data = join(root, 'data'),
		home = join(root, 'home'),
		project = join(data, 'projects/project');
	await put(join(repo, 'README.md'), '# repo\n');
	await put(
		join(home, '.claude/skills/probe-skill/SKILL.md'),
		'---\nname: probe-skill\ndescription: Answers with a marker\n---\n'
	);
	await put(
		join(home, '.codex/skills/random-landos/SKILL.md'),
		'---\nname: random-landos\ndescription: Landing prompts\n---\n'
	);
	await put(
		join(project, 'project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'repo', path: repo } })
	);
	await put(
		join(project, 'tasks/first/task.json'),
		JSON.stringify({
			schemaVersion: 1,
			task: {
				id: 'first',
				projectId: 'project',
				title: 'Sheet slash',
				status: 'done',
				provider: 'claude',
			},
		})
	);
	const env = Object.fromEntries(
		Object.entries(process.env).filter(
			(e): e is [string, string] =>
				typeof e[1] === 'string' &&
				e[0] !== 'ELECTRON_RUN_AS_NODE' &&
				e[0] !== 'CLAUDE_CONFIG_DIR' &&
				e[0] !== 'CODEX_HOME'
		)
	);
	const app = await electron.launch({
		executablePath,
		args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
		env: {
			...env,
			HOME: home,
			BRIGADIR_DATA_DIR: data,
			BRIGADIR_TEST_AGENT: resolve('packages/transport/fixtures/agent.mjs'),
		},
	});
	try {
		const page = await app.firstWindow();
		await page.getByRole('button', { name: /Sheet slash/ }).click();
		await expect
			.poll(() =>
				app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('new-task')!.enabled)
			)
			.toBe(true);
		await app.evaluate(({ Menu }) =>
			Menu.getApplicationMenu()!.getMenuItemById('new-task')!.click()
		);
		const sheet = page.getByRole('dialog', { name: 'New task', exact: true }),
			editor = sheet.getByRole('textbox', { name: 'Message', exact: true });
		await expect(editor).toBeFocused();
		await page.keyboard.type('Fix it with /probe');
		const slash = page.getByRole('listbox', { name: 'Slash commands' });
		await expect(slash.getByRole('option')).toHaveCount(1);
		await expect(slash.getByRole('option')).toContainText('/probe-skill');
		await expect(slash.getByText('Preliminary list. Agent not started.')).toBeVisible();
		await page.keyboard.press('Enter');
		await expect(editor).toHaveText('Fix it with /probe-skill');
		await expect(slash).toHaveCount(0);
		// spec/composer#slash-highlight: the picked skill is marked in the sheet too.
		await expect(editor.locator('[data-slash-command]')).toHaveText(['/probe-skill']);
		await page.keyboard.type('/ask');
		await expect(slash.getByRole('option').first()).toContainText('mcp__brigadir__ask_user');
		await page.keyboard.press('Escape');
		await expect(slash).toHaveCount(0);
		// `@` keeps its own menu next to `/`.
		await page.keyboard.type(' @Cla');
		await expect(
			page.getByRole('listbox', { name: 'Mention' }).getByRole('option', { name: /Claude/ })
		).toBeVisible();
		await page.keyboard.press('Escape');
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});

// spec/composer#mention-menu: a very long `/` list stays inside the window, scrolls inside, and the keys keep the active row in view.
test('a long / list fits the window, scrolls inside and follows the arrow keys @area:chat', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-slash-long-')),
		repo = join(root, 'repo'),
		data = join(root, 'data'),
		home = join(root, 'home'),
		project = join(data, 'projects/project');
	await put(join(repo, 'README.md'), '# repo\n');
	for (let index = 0; index < 90; index++)
		await put(
			join(
				home,
				`.claude/skills/openai-templates-skill-${String(index).padStart(2, '0')}/SKILL.md`
			),
			`---\nname: openai-templates-skill-${String(index).padStart(2, '0')}\ndescription: Skill number ${index} with a long description that cannot fit\n---\n`
		);
	await put(
		join(project, 'project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'repo', path: repo } })
	);
	await put(
		join(project, 'tasks/fresh/task.json'),
		JSON.stringify({
			schemaVersion: 1,
			task: {
				id: 'fresh',
				projectId: 'project',
				title: 'Fresh slash',
				status: 'done',
				provider: 'claude',
			},
		})
	);
	const env = Object.fromEntries(
		Object.entries(process.env).filter(
			(e): e is [string, string] =>
				typeof e[1] === 'string' &&
				e[0] !== 'ELECTRON_RUN_AS_NODE' &&
				e[0] !== 'CLAUDE_CONFIG_DIR' &&
				e[0] !== 'CODEX_HOME'
		)
	);
	const app = await electron.launch({
		executablePath,
		args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
		env: {
			...env,
			HOME: home,
			BRIGADIR_DATA_DIR: data,
			BRIGADIR_TEST_AGENT: resolve('packages/transport/fixtures/agent.mjs'),
		},
	});
	try {
		const page = await app.firstWindow();
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1100, 600));
		await page.getByRole('button', { name: /Fresh slash/ }).click();
		const message = page.getByRole('textbox', { name: 'Message', exact: true });
		await expect(message).toHaveAttribute('aria-busy', 'false');
		await message.click();
		await message.pressSequentially('/');
		const slash = page.getByRole('listbox', { name: 'Slash commands' });
		await expect(slash.getByRole('option').first()).toBeVisible();
		const menu = page.locator('[data-mention-tabs]');
		const inside = async () => {
			const box = (await menu.boundingBox())!,
				height = page.viewportSize()?.height ?? (await page.evaluate(() => window.innerHeight));
			expect(box.y).toBeGreaterThanOrEqual(0);
			expect(box.y + box.height).toBeLessThanOrEqual(height);
		};
		await inside();
		expect(
			await slash.evaluate(
				(el) => el.scrollHeight > el.clientHeight && getComputedStyle(el).overflowY === 'auto'
			)
		).toBe(true);
		const visible = async (index: number) => {
			const row = await slash.getByRole('option').nth(index).boundingBox(),
				box = (await slash.boundingBox())!;
			expect(row!.y).toBeGreaterThanOrEqual(box.y - 1);
			expect(row!.y + row!.height).toBeLessThanOrEqual(box.y + box.height + 1);
		};
		const count = await slash.getByRole('option').count();
		expect(count).toBeGreaterThan(80);
		for (let step = 0; step < count - 1; step++) await message.press('ArrowDown');
		await expect(slash.getByRole('option').nth(count - 1)).toHaveAttribute('aria-selected', 'true');
		await visible(count - 1);
		await inside();
		for (let step = 0; step < count - 1; step++) await message.press('ArrowUp');
		await expect(slash.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
		await visible(0);
		await inside();
		await message.press('Escape');
		await expect(slash).toHaveCount(0);
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});

// spec/composer#slash-highlight: a name the `/` list knows is marked where it stands, as text on the pill's tint — in the composer and in the log.
test('known commands and skills are marked in the composer text and in the log, where they run @area:chat', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-slash-marks-')),
		repo = join(root, 'repo'),
		data = join(root, 'data'),
		home = join(root, 'home'),
		project = join(data, 'projects/project');
	await put(join(repo, 'README.md'), '# repo\n');
	await put(
		join(home, '.claude/skills/probe-skill/SKILL.md'),
		'---\nname: probe-skill\ndescription: Answers with a marker\n---\n'
	);
	await put(
		join(project, 'project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'repo', path: repo } })
	);
	await put(
		join(project, 'tasks/started/task.json'),
		JSON.stringify({
			schemaVersion: 1,
			task: {
				id: 'started',
				projectId: 'project',
				title: 'Marked slash',
				status: 'done',
				provider: 'claude',
			},
		})
	);
	const commands = [
		{ name: 'compact', description: 'Free up context', inputHint: null },
		{ name: 'probe-skill', description: 'Answers with a marker', inputHint: null },
	];
	await writeFile(
		join(project, 'tasks/started/events.jsonl'),
		[
			{
				schemaVersion: 1,
				seq: 1,
				at: '2026-10-07T10:00:00.000Z',
				event: { kind: 'commands.changed', commands },
			},
			{
				schemaVersion: 1,
				seq: 2,
				at: '2026-10-07T10:00:01.000Z',
				event: {
					kind: 'turn.started',
					text: 'Also run /probe-skill, not `/probe-skill` and not /compact',
				},
			},
		]
			.map((line) => JSON.stringify(line))
			.join('\n') + '\n'
	);
	const env = Object.fromEntries(
		Object.entries(process.env).filter(
			(e): e is [string, string] =>
				typeof e[1] === 'string' &&
				e[0] !== 'ELECTRON_RUN_AS_NODE' &&
				e[0] !== 'CLAUDE_CONFIG_DIR' &&
				e[0] !== 'CODEX_HOME'
		)
	);
	const app = await electron.launch({
		executablePath,
		args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
		env: {
			...env,
			HOME: home,
			BRIGADIR_DATA_DIR: data,
			BRIGADIR_TEST_AGENT: resolve('packages/transport/fixtures/agent.mjs'),
		},
	});
	try {
		const page = await app.firstWindow();
		await page.getByRole('button', { name: /Marked slash/ }).click();
		const message = page.getByRole('textbox', { name: 'Message', exact: true });
		await expect(message).toHaveAttribute('aria-busy', 'false');
		const marks = message.locator('[data-slash-command]');
		// The skill anywhere, the built-in only as the first word; a path, a longer name and code stay text.
		await message.click();
		await message.pressSequentially(
			'/compact then /probe-skill, check /usr/bin, /probe-skillx and `/probe-skill`'
		);
		await message.press('Escape');
		await expect(marks).toHaveText(['/compact', '/probe-skill']);
		await expect(marks.nth(1)).toHaveAttribute(
			'title',
			'/probe-skill · skill\nAnswers with a marker'
		);
		await expect(marks.nth(0)).toHaveAttribute(
			'title',
			'/compact · slash command\nFree up context\nOnly at the start of a message.'
		);
		// The mark is the pill's tint on monospace text, and the caret walks through it letter by letter.
		const style = await marks.nth(1).evaluate((node) => {
			const css = getComputedStyle(node);
			return { font: css.fontFamily, background: css.backgroundColor };
		});
		expect(style.font).toMatch(/monospace|Menlo/);
		expect(style.background).not.toBe('rgba(0, 0, 0, 0)');
		await message.fill('');
		await message.pressSequentially('then /compact and /probe-skill');
		await message.press('Escape');
		await expect(marks).toHaveText(['/probe-skill']);
		for (let i = 0; i < 5; i++) await message.press('Backspace');
		await expect(marks).toHaveCount(0);
		expect(await editorText(message)).toBe('then /compact and /probe-');
		// The log marks the person's message the same way; a code span stays code.
		const log = page.locator('[data-prompt-text]').filter({ hasText: 'Also run' });
		await expect(log.locator('[data-slash-command]')).toHaveText(['/probe-skill']);
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
