import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SessionEvent } from '../packages/core/src/session';
import { hidePanel } from './layout';
const desktop = resolve('apps/desktop'),
	executablePath = createRequire(join(desktop, 'package.json'))('electron') as string,
	env = Object.fromEntries(
		Object.entries(process.env).filter(
			(e): e is [string, string] => typeof e[1] === 'string' && e[0] !== 'ELECTRON_RUN_AS_NODE'
		)
	);
const launchApp = (root: string, data: string) =>
	electron.launch({
		executablePath,
		args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
		env: { ...env, BRIGADIR_DATA_DIR: data },
	});
// Clicks an application-menu item by its label, wherever it sits.
const menuAction = (app: ElectronApplication) => async (label: string) => {
	await app.evaluate(({ Menu }, label) => {
		function find(items: Electron.MenuItem[]): Electron.MenuItem | undefined {
			for (const item of items) {
				if (item.label === label) return item;
				const child = item.submenu && find(item.submenu.items);
				if (child) return child;
			}
		}
		find(Menu.getApplicationMenu()!.items)!.click();
	}, label);
};
const WT = '/Users/dev/.brigadir/worktrees/7f3a91c2-kit-focus-ring';
// 21 calls: 14 Bash · 5 Read · 2 Grep, 7.5 s together.
const RUN: [string, string, number][] = [
	['Bash', 'grep -rn "focus-visible" kit/src | grep -v test', 614],
	['Bash', `cd ${WT} && git log --oneline -5 -- kit/src/Button`, 686],
	['Read', 'kit/src/Button/Button.module.css', 12],
	['Bash', 'sed -n 30,80p kit/src/Button/Button.module.css', 299],
	['Bash', 'cat kit/src/tokens/focus.ts kit/src/tokens/index.ts', 370],
	['Grep', 'outline: none', 41],
	['Bash', `cd ${WT} && grep -rn ":focus" kit/src/Button`, 648],
	['Read', 'kit/src/Button/Button.tsx', 9],
	[
		'Bash',
		'sed -n 1,120p kit/src/Button/Button.tsx; sed -n 85,130p kit/src/Button/Button.tsx',
		428,
	],
	['Bash', 'grep -rn "useFocusRing\\|focusRing" kit/src', 983],
	['Read', 'kit/src/hooks/useFocusRing.ts', 8],
	['Bash', `cd ${WT} && git diff master -- kit/src/Button`, 449],
	['Bash', 'grep -n "outline" kit/src/**/*.module.css', 523],
	['Read', 'kit/src/Input/Input.module.css', 7],
	['Bash', 'sed -n 215,260p kit/src/theme/global.css', 633],
	['Grep', '-webkit-focus-ring-color', 38],
	['Bash', 'cat kit/package.json | head -40', 506],
	['Bash', 'ls kit/src/Button/; grep -rln "Button" kit/stories', 504],
	['Read', 'kit/stories/Button.stories.tsx', 6],
	['Bash', 'grep -n "safari\\|webkit" kit/playwright.config.ts', 458],
	['Bash', 'sed -n 1,40p kit/tests/focus.spec.ts', 242],
];
const category = (name: string) =>
	name === 'Bash' ? 'execute' : name === 'Grep' ? 'search' : name === 'Edit' ? 'edit' : 'read';

test('calls in a row fold into one group: count · tools · file chip · errors · time; failures and the live call stay under it (spec/chat#tool-groups) @area:chat', async ({}, info) => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-tool-groups-')),
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
				title: 'Fix kit Button focus ring',
				status: 'working',
				provider: 'claude',
			},
		})
	);
	await writeFile(
		join(dir, '../../project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'choice', path: repo } })
	);
	// Times end just before now: the running call ticks from its own start, the rest keep their measured durations.
	let at = Date.now() - 120_000;
	const records: { at: number; event: unknown }[] = [];
	const push = (event: unknown, step = 200) => {
		records.push({ at, event });
		at += step;
	};
	const call = (
		id: string,
		name: string,
		title: string,
		ms: number,
		status = 'completed',
		patch: object = {}
	) => {
		push(
			{
				kind: 'tool.changed',
				patch: { id, name, title, category: category(name), status: 'in_progress' },
			},
			ms
		);
		if (status !== 'running') push({ kind: 'tool.changed', patch: { id, status, ...patch } }, 300);
	};
	push({
		kind: 'turn.started',
		text: 'Fix the focus ring on kit Button, it disappears when you Tab into it in Safari.',
	});
	push({
		kind: 'message.delta',
		role: 'assistant',
		messageId: 'intro',
		content: {
			kind: 'text',
			text: 'I will look at how the ring is implemented now and where Safari loses it.',
		},
	});
	RUN.forEach(([name, title, ms], index) => call(`r${index}`, name, title, ms));
	push({
		kind: 'message.delta',
		role: 'assistant',
		messageId: 'found',
		content: {
			kind: 'text',
			text: 'Found it: `Button.module.css` sets `outline: none` on `:focus`. I will move the ring to `:focus` and run the Safari test.',
		},
	});
	call('edit', 'Edit', 'Edit kit/src/Button/Button.module.css', 12, 'completed', {
		content: [
			{
				kind: 'diff',
				path: 'kit/src/Button/Button.module.css',
				before: '.button:focus {\n  outline: none;\n}\n',
				after:
					'.button:focus {\n  outline: 2px solid var(--focus-ring);\n  outline-offset: 2px;\n}\n',
			},
		],
	});
	call('test', 'Bash', 'pnpm --filter kit test', 8400, 'failed', {
		exitCode: 1,
		output: 'FAIL  src/Button/Button.test.tsx\n  ● Button › keeps the ring on Tab',
	});
	call('spec', 'Read', 'kit/tests/focus.spec.ts', 6);
	call('sed', 'Bash', 'sed -n 40,80p kit/tests/focus.spec.ts', 312);
	at = Date.now() - 6000;
	call('safari', 'Bash', 'pnpm --filter kit test:safari', 0, 'running');
	await writeFile(
		join(dir, 'events.jsonl'),
		records
			.map((record, index) =>
				JSON.stringify({
					schemaVersion: 1,
					seq: index + 1,
					at: new Date(record.at).toISOString(),
					event: record.event,
				})
			)
			.join('\n') + '\n'
	);
	const app = await launchApp(root, data);
	try {
		const page = await app.firstWindow(),
			errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 800));
		await page.getByRole('button', { name: /Fix kit Button focus ring/ }).click();
		const log = page.getByRole('log', { name: 'Conversation' }),
			groups = log.locator('[data-tool-group]');
		await expect(groups).toHaveCount(2);
		const [first, second] = [groups.nth(0), groups.nth(1)],
			head = (group: typeof first) => group.locator('[data-tool-group-head]');
		await expect(head(first)).toContainText('21 tool calls');
		await expect(head(first)).toContainText('14 Bash · 5 Read · 2 Grep');
		await expect(head(first)).toContainText('7.5s');
		await expect(head(second)).toContainText('5 tool calls');
		await expect(head(second)).toContainText('3 Bash · 1 Edit · 1 Read');
		await expect(head(second)).toContainText('1 error');
		await expect(
			head(second).getByRole('button', { name: /kit\/src\/Button\/Button\.module\.css/ })
		).toHaveText('kit/…/Button.module.css+2−1');
		await expect(head(second).getByRole('img', { name: 'Working' })).toBeVisible();
		// Collapsed: only the failed call and the one still running stay under the header, in log order.
		const pins = second.locator(':scope > div > details > summary');
		await expect(pins).toHaveCount(2);
		await expect(pins.nth(0)).toContainText('pnpm --filter kit test');
		await expect(pins.nth(0)).toContainText('exit 1');
		await expect(pins.nth(1)).toContainText('pnpm --filter kit test:safari');
		await expect(first.locator('[data-tool-target]').first()).toBeHidden();
		const action = menuAction(app);
		const firstHead = head(first);
		for (const theme of ['light', 'dark'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await page.mouse.move(5, 400);
			await page.screenshot({
				animations: 'disabled',
				path: info.outputPath(`tool-groups-${theme}.png`),
			});
		}
		// ⌥⌘↓ to a call inside a collapsed group opens the group and focuses the call.
		await log.focus();
		await action('Next tool or hunk');
		await expect(page.locator('[data-tool-target="1/tool/r0"]')).toBeFocused();
		await action('Collapse conversation');
		// Open: every call in order, each with its own navigation target; the pins give way to the calls themselves.
		await firstHead.click();
		await expect(first.locator('[data-tool-target]').nth(20)).toBeVisible();
		await expect(first.locator('details[open] details')).toHaveCount(21);
		await page.screenshot({
			animations: 'disabled',
			path: info.outputPath('tool-groups-open-dark.png'),
		});
		await head(second).locator(':scope > strong').click();
		await expect(second.locator('[data-tool-target]').nth(4)).toBeVisible();
		await expect(second.locator(':scope > div > details > summary')).toHaveCount(0);
		await head(second).locator(':scope > strong').click();
		await firstHead.click();
		await expect(first.locator('[data-tool-target]').first()).toBeHidden();
		// The menu's Expand / Collapse conversation covers the groups too.
		await log.focus();
		await action('Expand conversation');
		await expect(first.locator('[data-tool-target]').nth(20)).toBeVisible();
		await action('Collapse conversation');
		await expect(first.locator('[data-tool-target]').first()).toBeHidden();
		// A chip opens the file's changes, the group stays as it was.
		await head(second)
			.getByRole('button', { name: /Button\.module\.css/ })
			.click();
		await expect(page.getByRole('complementary', { name: 'Changes', exact: true })).toBeVisible();
		await expect(second.locator('details').first()).not.toHaveAttribute('open', '');
		// Narrow column: the errors stay in the header.
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(980, 800));
		// spec/task-window-workspace#layout-switch: the panel goes away with its Layout switch.
		await hidePanel(page);
		await expect(head(second).getByText('1 error')).toBeVisible();
		for (const theme of ['light', 'dark'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await page.screenshot({
				animations: 'disabled',
				path: info.outputPath(`tool-groups-narrow-${theme}.png`),
			});
		}
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});

// spec/chat#mcp-calls: an MCP call reads as an action by its state, with the crew agent and the outcome; shapes from real crew journals.
test('mcp calls read as actions with the agent and the outcome, grouped like any calls @area:chat', async ({}, info) => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-mcp-log-')),
		repo = join(root, 'repo'),
		data = join(root, 'data'),
		dir = join(data, 'projects/project/tasks/foreman');
	await mkdir(repo);
	await mkdir(dir, { recursive: true });
	await promisify(execFile)('git', ['init', '-q'], { cwd: repo });
	await writeFile(
		join(data, 'projects/project/project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'choice', path: repo } })
	);
	await writeFile(
		join(dir, 'task.json'),
		JSON.stringify({
			schemaVersion: 1,
			task: {
				id: 'foreman',
				projectId: 'project',
				title: 'Split kit exports',
				status: 'done',
				provider: 'claude',
			},
		})
	);
	const claude = (
		id: string,
		tool: string,
		input: unknown,
		output: unknown,
		status = 'completed'
	): SessionEvent[] => [
		{
			kind: 'tool.changed',
			patch: {
				id,
				name: `mcp__brigadir__${tool}`,
				title: `mcp__brigadir__${tool}`,
				category: 'other',
				status: 'pending',
				input: JSON.stringify(input),
			},
		},
		{
			kind: 'tool.changed',
			patch: {
				id,
				status,
				content: [
					{ kind: 'text', text: typeof output === 'string' ? output : JSON.stringify(output) },
				],
			},
		},
	];
	const events: SessionEvent[] = [
		{ kind: 'turn.started', text: 'Split the kit exports.' },
		...claude(
			'part',
			'create_worker_task',
			{
				agent: 'Developer 2',
				title: 'Move hook exports',
				prompt: 'Move the hooks.',
				files: ['kit/src/hooks/**'],
			},
			{ taskId: 'w2', agent: 'Developer 2', title: 'Move hook exports', status: 'queued' }
		),
		{
			kind: 'crew.worker.created',
			taskId: 'w2',
			nodeId: 'developer-2',
			name: 'Developer 2',
			title: 'Move hook exports',
		},
		{
			kind: 'crew.worker.created',
			taskId: 'rv',
			nodeId: 'reviewer',
			name: 'Reviewer',
			title: 'checks Developer 2',
		},
		...claude(
			'status',
			'task_status',
			{ taskId: 'w2' },
			{
				taskId: 'w2',
				agent: 'Developer 2',
				title: 'Move hook exports',
				status: 'working',
				busy: true,
				turns: 6,
				changedFiles: 3,
				accepted: false,
				part: 2,
			}
		),
		...claude(
			'accept',
			'accept_task',
			{ taskId: 'w2' },
			{ accepted: true, merged: ['.'], committed: [{ name: '.', sha: '3f9c2a1e57b04f1d' }] }
		),
		{
			kind: 'crew.accepted',
			taskId: 'w2',
			nodeId: 'developer-2',
			name: 'Developer 2',
			conflicts: [],
		},
		...claude(
			'prompt',
			'prompt_task',
			{ taskId: 'w2', text: 'Check it again' },
			'```\nAgent is starting\n```',
			'failed'
		),
		{
			kind: 'tool.changed',
			patch: {
				id: 'codex',
				title: 'mcp.brigadir.read_diff',
				category: 'execute',
				status: 'completed',
				input: JSON.stringify({
					server: 'brigadir',
					tool: 'read_diff',
					arguments: { taskId: 'w2', path: 'kit/src/hooks/index.ts' },
				}),
			},
		},
		{
			kind: 'tool.changed',
			patch: {
				id: 'foreign',
				name: 'mcp__playwright__browser_navigate',
				title: 'mcp__playwright__browser_navigate',
				category: 'other',
				status: 'completed',
				input: '{"url":"http://localhost:3000/admin"}',
				content: [{ kind: 'text', text: 'Page URL: http://localhost:3000/admin' }],
			},
		},
		{ kind: 'turn.completed', reason: 'end_turn' },
		{ kind: 'host.stopped', reason: 'Fixture offline' },
	];
	await writeFile(
		join(dir, 'events.jsonl'),
		events
			.map((event, index) =>
				JSON.stringify({
					schemaVersion: 1,
					seq: index + 1,
					at: new Date(Date.UTC(2026, 9, 2, 10, 0, index)).toISOString(),
					event,
				})
			)
			.join('\n') + '\n'
	);
	const app = await launchApp(root, data);
	try {
		const page = await app.firstWindow();
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 800));
		await page.locator('[data-sidebar-task="foreman"]').click();
		// spec/chat#tool-groups: MCP calls in a row fold into a group; its tools name them by action, never `mcp__…`. Opened, every call shows once.
		const heads = page.locator('[data-tool-group-head]');
		await expect(heads).toHaveCount(2);
		await expect(heads.nth(1)).toContainText('1 error');
		for (const head of await heads.all()) await expect(head).not.toContainText('mcp__');
		await expect(
			page.locator('[data-tool-group]').nth(1).locator(':scope > div [data-mcp-row]')
		).toHaveCount(1);
		for (const head of await heads.all()) await head.locator(':scope > strong').click();
		const rows = page.locator('[data-mcp-row]');
		await expect(rows).toHaveCount(6);
		for (const [index, value] of [
			[0, 'Move hook exports'],
			[1, 'Developer 2'],
			[2, '3f9c2a1'],
			[3, 'Agent is starting'],
			[4, 'kit/src/hooks/index.ts'],
			[5, 'http://localhost:3000/admin'],
		] as const) {
			await expect(rows.nth(index).locator('summary')).toContainText(value);
			await expect(rows.nth(index).locator('summary')).not.toContainText('mcp__');
		}
		// The part and the acceptance are told by their calls; the reviewer the host started keeps its service row.
		await expect(page.locator('[data-crew-row="worker"]')).toHaveCount(1);
		await expect(page.locator('[data-crew-row="worker"]')).toContainText('checks Developer 2');
		await expect(page.locator('[data-crew-row="accepted"]')).toHaveCount(0);
		// Codex calls do not open a terminal; the failed call opens by itself.
		await expect(rows.nth(4).locator('[aria-label*="Terminal"],.xterm')).toHaveCount(0);
		await expect(rows.nth(3)).toHaveAttribute('open', '');
		const status = rows.nth(1).locator('summary');
		await status.click();
		await expect(rows.nth(1).locator('dl')).toBeVisible();
		await expect(rows.nth(1).locator('pre')).toHaveCount(0);
		await rows.nth(1).getByRole('button', { name: 'Show JSON' }).click();
		await expect(rows.nth(1).locator('pre').first()).toContainText('"taskId": "w2"');
		for (const theme of ['light', 'dark'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await page.screenshot({
				animations: 'disabled',
				path: info.outputPath(`mcp-log-${theme}.png`),
			});
		}
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});

// spec/chat#subagents: the journal our AgentTransport wrote from the real claude-agent-acp 0.85.1 with the `subagents` capability:
// two foreground subagents at once, then one in the background. Paths of the throwaway repo are renamed.
async function live(): Promise<{ at: string; event: unknown }[]> {
	return (await readFile(resolve('tests/fixtures/subagents-live.jsonl'), 'utf8'))
		.trim()
		.split('\n')
		.map((line) => JSON.parse(line));
}

test('a subagent is its own block on its launch place: header, live call or answer line, prompt, calls, answer (spec/chat#subagents) @area:chat', async ({}, info) => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-subagents-')),
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
				title: 'Map the demo repo',
				status: 'working',
				provider: 'claude',
			},
		})
	);
	await writeFile(
		join(dir, '../../project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'demo', path: repo } })
	);
	// The live turn keeps its own spacing and ends two minutes ago; a second turn still runs: a subagent with a live call,
	// and an older `think` call (a subagent before subagent sessions) with its raw input.
	const recorded = await live(),
		first = Date.parse(recorded[0]!.at),
		shift = Date.now() - 180_000 - first;
	const records = recorded.map((record) => ({
		at: Date.parse(record.at) + shift,
		event: record.event,
	}));
	let at = Date.now() - 40_000;
	const push = (event: unknown, step = 500) => {
		records.push({ at, event });
		at += step;
	};
	push({ kind: 'turn.started', text: 'Check the tests too.' });
	push({
		kind: 'tool.changed',
		patch: {
			id: 'old',
			name: 'Agent',
			title: 'Research backend SSE implementation',
			category: 'think',
			status: 'completed',
			input: JSON.stringify({
				description: 'Research backend SSE implementation',
				subagent_type: 'general-purpose',
				prompt: 'Read-only research using the gh CLI.',
			}),
			content: [{ kind: 'text', text: 'Async agent launched successfully.' }],
		},
	});
	push({
		kind: 'subagent.started',
		id: 'run',
		parentId: null,
		name: 'Run the tests',
		prompt: 'Run `pnpm test` and answer with the failures.',
	});
	push({
		kind: 'subagent.changed',
		id: 'run',
		toolId: 'launch-run',
		type: 'general-purpose',
		model: 'claude-opus-5-5',
	});
	push({
		kind: 'tool.changed',
		subagentId: 'run',
		patch: {
			id: 'run-read',
			name: 'Read',
			title: 'Read package.json',
			category: 'read',
			status: 'pending',
			parentId: 'launch-run',
		},
	});
	push(
		{
			kind: 'tool.changed',
			subagentId: 'run',
			patch: { id: 'run-read', status: 'completed', parentId: 'launch-run' },
		},
		2000
	);
	at = Date.now() - 6000;
	push({
		kind: 'tool.changed',
		subagentId: 'run',
		patch: {
			id: 'run-test',
			name: 'Bash',
			title: 'pnpm test',
			category: 'execute',
			status: 'pending',
			parentId: 'launch-run',
		},
	});
	await writeFile(
		join(dir, 'events.jsonl'),
		records
			.map((record, index) =>
				JSON.stringify({
					schemaVersion: 1,
					seq: index + 1,
					at: new Date(record.at).toISOString(),
					event: record.event,
				})
			)
			.join('\n') + '\n'
	);
	const app = await launchApp(root, data);
	try {
		const page = await app.firstWindow(),
			errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1280, 800));
		await page.getByRole('button', { name: /Map the demo repo/ }).click();
		const log = page.getByRole('log', { name: 'Conversation' }),
			blocks = log.locator('[data-subagent]');
		await expect(blocks).toHaveCount(4);
		const head = (index: number) => blocks.nth(index).locator('[data-subagent-head]');
		// The launch call is the block itself: no `Agent` row, no raw toolResponse.
		await expect(log.getByText('Agent', { exact: true })).toHaveCount(1);
		await expect(head(0)).toContainText('Explore');
		await expect(head(0)).toContainText('Map the source files');
		await expect(head(0)).toContainText('1 tool call');
		await expect(head(0)).toContainText('11s');
		await expect(head(1)).toContainText('general-purpose');
		await expect(head(1)).toContainText('Check the README');
		await expect(head(1)).toContainText('2 tool calls');
		// A background subagent: the adapter sent no type, tokens or run time, so none are shown; the time is its own span.
		await expect(head(2)).toContainText('Count lines');
		await expect(head(2)).not.toContainText('general-purpose');
		// Collapsed and done: the answer's first line under the header; it opens the block.
		const line = blocks.nth(1).locator(':scope > div > button');
		await expect(line).toContainText('The README is titled');
		await line.click();
		await expect(blocks.nth(1).locator(':scope > details')).toHaveAttribute('open', '');
		await expect(blocks.nth(1).getByText(/read README\.md, then run/)).toBeVisible();
		await expect(blocks.nth(1).locator('[data-tool-group-head]')).toContainText('2 tool calls');
		await expect(blocks.nth(1).getByText('claude-opus-5-5 · 34.6k tokens')).toBeVisible();
		// Running: the live call is pinned under the collapsed header, the turn row names the subagent.
		await expect(head(3).getByRole('img', { name: 'Working' })).toBeVisible();
		await expect(blocks.nth(3).locator(':scope > div [data-tool-target]')).toContainText(
			'pnpm test'
		);
		await expect(page.locator('[data-turn-status]')).toContainText('Run the tests');
		// An older log: the think call shows its prompt, never its raw JSON input.
		const old = log
			.locator('details', { has: page.getByText('Research backend SSE implementation') })
			.first();
		await old.locator('summary').click();
		await expect(old).toContainText('Read-only research using the gh CLI.');
		await expect(old).not.toContainText('"subagent_type"');
		await head(0).scrollIntoViewIfNeeded();
		for (const theme of ['light', 'dark'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await page.mouse.move(5, 400);
			await page.screenshot({
				animations: 'disabled',
				path: info.outputPath(`subagents-${theme}.png`),
			});
		}
		// Expand / Collapse conversation covers the blocks.
		const action = menuAction(app);
		await log.focus();
		await action('Expand conversation');
		await expect(blocks.nth(0).locator(':scope > details')).toHaveAttribute('open', '');
		await action('Collapse conversation');
		await expect(blocks.nth(0).locator(':scope > details')).not.toHaveAttribute('open', '');
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
