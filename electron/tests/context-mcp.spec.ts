import { refreshChanges } from './refresh-changes';
import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SessionEvent } from '../packages/core/src/session';
import { openPanelTab } from './layout';
const desktop = resolve('apps/desktop'),
	executablePath = createRequire(join(desktop, 'package.json'))('electron') as string;
// spec/agents-and-providers#context-tools: the task's agent asks what the person has open — the file, the cursor, the selected lines, the diff — over MCP.
test('editor_state and pr_state tell the agent what the person is looking at @area:chat', async ({}, info) => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-context-mcp-')),
		repo = join(root, 'repo'),
		data = join(root, 'data'),
		dir = join(data, 'projects/project/tasks/task'),
		look = join(data, 'projects/project/tasks/look');
	await mkdir(repo);
	await mkdir(dir, { recursive: true });
	await mkdir(look, { recursive: true });
	await promisify(execFile)('git', ['init', '-q'], { cwd: repo });
	await writeFile(
		join(repo, 'sample.ts'),
		Array.from(
			{ length: 160 },
			(_, i) => `export const row${String(i + 1).padStart(3, '0')} = ${i + 1};`
		).join('\n')
	);
	const other = (prefix: string) =>
		Array.from({ length: 12 }, (_, i) => `export const ${prefix}${i + 1} = ${i + 1};`).join('\n');
	await writeFile(join(repo, 'other.ts'), other('before'));
	await writeFile(
		join(data, 'projects/project/project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'repo', path: repo } })
	);
	await writeFile(
		join(dir, 'task.json'),
		JSON.stringify({
			schemaVersion: 1,
			task: {
				id: 'task',
				projectId: 'project',
				title: 'Context fixture',
				status: 'done',
				provider: 'claude',
			},
		})
	);
	// A second task holds a log with the calls as an agent made them, for the rows (spec/chat#mcp-calls).
	await writeFile(
		join(look, 'task.json'),
		JSON.stringify({
			schemaVersion: 1,
			task: {
				id: 'look',
				projectId: 'project',
				title: 'Context log',
				status: 'done',
				provider: 'claude',
			},
		})
	);
	const call = (
		id: string,
		tool: string,
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
				input: '{}',
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
		{ kind: 'turn.started', text: 'Fix this.' },
		...call('e1', 'editor_state', {
			window: 'open',
			visible: true,
			tabs: [{ kind: 'file', path: 'src/order/rules.ts', active: true, unsaved: false }],
			active: {
				kind: 'file',
				path: 'src/order/rules.ts',
				view: 'editor',
				cursor: { line: 42, column: 1 },
				selections: [{ lines: [38, 41], text: 'if (total > limit) {\n  return null;\n}\n' }],
			},
		}),
		{
			kind: 'message.delta',
			role: 'assistant',
			messageId: 'm1',
			content: { kind: 'text', text: 'The early return skips the discount.' },
		},
		...call('p1', 'pr_state', {
			window: 'open',
			open: true,
			number: 421,
			title: 'Loyalty rules',
			threads: [{}, {}, {}],
		}),
		{
			kind: 'message.delta',
			role: 'assistant',
			messageId: 'm2',
			content: { kind: 'text', text: 'Three threads are open.' },
		},
		{ kind: 'turn.completed', reason: 'end_turn' },
		{ kind: 'host.stopped', reason: 'Fixture offline' },
	];
	await writeFile(
		join(look, 'events.jsonl'),
		events
			.map((event, index) =>
				JSON.stringify({
					schemaVersion: 1,
					seq: index + 1,
					at: new Date(Date.UTC(2026, 9, 6, 10, 0, index)).toISOString(),
					event,
				})
			)
			.join('\n') + '\n'
	);
	const env = Object.fromEntries(
		Object.entries(process.env).filter(
			(e): e is [string, string] => typeof e[1] === 'string' && e[0] !== 'ELECTRON_RUN_AS_NODE'
		)
	);
	const app = await electron.launch({
		executablePath,
		args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
		env: { ...env, BRIGADIR_DATA_DIR: data },
	});
	let mcp: any;
	try {
		const page = await app.firstWindow(),
			errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1440, 900));
		const key = { projectId: 'project', id: 'task' };
		await page.getByRole('button', { name: /Context fixture/ }).click();
		await refreshChanges(page);
		await expect
			.poll(() =>
				page.evaluate(async (key) => (await window.brigadir.readChanges(key)).checkpoint, key)
			)
			.not.toBeNull();
		await writeFile(join(repo, 'other.ts'), other('after'));
		await refreshChanges(page);
		// A console-only host serves MCP without an agent process; the snapshot may hold the task a moment longer.
		await expect
			.poll(() =>
				page.evaluate(
					(key) =>
						window.brigadir.terminalCommand(key, { kind: 'list' }).then(
							() => true,
							() => false
						),
					key
				)
			)
			.toBe(true);
		await expect
			.poll(() =>
				readFile(join(dir, 'host.json'), 'utf8').then(
					() => true,
					() => false
				)
			)
			.toBe(true);
		const identity = JSON.parse(await readFile(join(dir, 'host.json'), 'utf8'));
		const requireMcp = createRequire(resolve('packages/transport/package.json'));
		const { Client } = requireMcp('@modelcontextprotocol/sdk/client/index.js');
		const { StdioClientTransport } = requireMcp('@modelcontextprotocol/sdk/client/stdio.js');
		mcp = new Client({ name: 'context-fixture', version: '1.0.0' });
		await mcp.connect(
			new StdioClientTransport({
				command: resolve('apps/desktop/out/services/mcp-relay'),
				args: [],
				env: {
					...env,
					BRIGADIR_HOST_SOCKET: identity.socket,
					BRIGADIR_HOST_INSTANCE: identity.instance,
					BRIGADIR_PROJECT_ID: key.projectId,
					BRIGADIR_TASK_ID: key.id,
					BRIGADIR_MCP_TOKEN: identity.mcpToken,
				},
			})
		);
		const names = (await mcp.listTools()).tools.map((tool: { name: string }) => tool.name);
		expect(names).toContain('editor_state');
		expect(names).toContain('pr_state');
		const state = async (name: string) => {
			const result = await mcp.callTool({ name, arguments: {} });
			expect(result.isError, result.content[0].text).not.toBe(true);
			return JSON.parse(result.content[0].text);
		};
		// Nothing open yet: an answer, not an error.
		expect(await state('editor_state')).toMatchObject({
			window: 'open',
			visible: true,
			tabs: [],
			active: null,
			note: 'No file or diff is open in this task.',
		});
		expect(await state('pr_state')).toMatchObject({ window: 'open', open: false });
		// A file with lines 10–12 selected.
		await openPanelTab(page, 'files');
		await page.getByRole('treeitem', { name: 'sample.ts', exact: true }).dblclick();
		const editor = page.getByRole('textbox', { name: 'File content', exact: true });
		await editor.focus();
		await editor.press('Meta+a');
		await editor.press('ArrowLeft');
		for (let i = 0; i < 9; i++) await editor.press('ArrowDown');
		for (let i = 0; i < 3; i++) await editor.press('Shift+ArrowDown');
		await expect(page.locator('[data-selection-actions]')).toContainText('sample.ts · 10–12');
		const file = await state('editor_state');
		expect(file).toMatchObject({
			window: 'open',
			visible: true,
			documentsShown: true,
			tabs: [{ kind: 'file', path: 'sample.ts', active: true, unsaved: false }],
			active: {
				kind: 'file',
				path: 'sample.ts',
				view: 'editor',
				lineCount: 160,
				unsaved: false,
				cursor: { line: 13, column: 1 },
				selections: [
					{ lines: [10, 12], from: { line: 10, column: 1 }, to: { line: 13, column: 1 } },
				],
			},
		});
		expect(file.active.selections[0].text).toBe(
			'export const row010 = 10;\nexport const row011 = 11;\nexport const row012 = 12;\n'
		);
		expect(file.active.visibleLines[0]).toBe(1);
		expect(file.active.visibleLines[1]).toBeGreaterThan(12);
		// The changed file's diff with new lines 3–5 dragged.
		await openPanelTab(page, 'changes');
		await page
			.getByRole('list', { name: 'Files', exact: true })
			.getByRole('button', { name: /other.ts/ })
			.click();
		const diff = page.getByRole('log', { name: 'Diff', exact: true }),
			line = (n: number) => diff.locator(`[data-code-line="${n}"][data-side="new"]`);
		await expect(line(5)).toBeVisible();
		await page.evaluate(() => window.getSelection()?.removeAllRanges());
		const a = (await line(3).boundingBox())!,
			b = (await line(5).boundingBox())!;
		await page.mouse.move(a.x + 8, a.y + a.height / 2);
		await page.mouse.down();
		await page.mouse.move(b.x + 80, b.y + b.height / 2, { steps: 6 });
		await page.mouse.up();
		await expect(diff.locator('[data-selection-actions]')).toContainText('other.ts · 3–5');
		const changes = await state('editor_state');
		// spec/agents-and-providers#editor-state: every file and diff names its repo, the root one too.
		expect(changes.tabs).toEqual([
			{ kind: 'file', path: 'sample.ts', repo: expect.any(String), active: false, unsaved: false },
			{ kind: 'diff', path: 'other.ts', repo: expect.any(String), source: 'changes', active: true },
		]);
		expect(changes.active).toMatchObject({
			kind: 'diff',
			path: 'other.ts',
			source: 'changes',
			base: 'start of the task',
			view: 'diff',
			layout: 'unified',
			selection: { side: 'new', lines: [3, 5] },
		});
		expect(changes.active.selection.text).toBe(
			'export const after3 = 3;\nexport const after4 = 4;\nexport const after5 = 5;'
		);
		expect(changes.active.visibleLines.new[0]).toBe(1);
		// spec/agents-and-providers#editor-state: going to the chat clears the page's selection, the agent still gets the diff lines.
		await page.getByRole('textbox', { name: 'Message', exact: true }).click();
		await expect(diff.locator('[data-selection-actions]')).toHaveCount(0);
		expect((await state('editor_state')).active.selection).toMatchObject({
			side: 'new',
			lines: [3, 5],
		});
		// Closing every tab leaves an answer with no tabs.
		const closers = page.getByRole('button', { name: /^Close (diff|file)/ });
		while (await closers.count()) await closers.first().click();
		await expect.poll(async () => (await state('editor_state')).tabs.length).toBe(0);
		// The rows of an agent's calls (spec/chat#mcp-calls): the verb, the file and line, the selection; the PR and its threads.
		await mcp.close();
		mcp = null;
		await page.locator('[data-sidebar-task="look"]').click();
		const heads = page.locator('[data-tool-group-head]');
		if (await heads.count())
			for (const head of await heads.all()) await head.locator(':scope > strong').click();
		const rows = page.locator('[data-mcp-row]');
		await expect(rows).toHaveCount(2);
		expect(
			(await rows.locator('summary').allInnerTexts()).map((item) =>
				item
					.replace(/\s+/g, ' ')
					.replace(/ \d[\d.,]*(s|ms)\b/, '')
					.trim()
			)
		).toEqual([
			'Read the editor src/order/rules.ts:42 · 4 lines selected',
			'Read the PR #421 · Loyalty rules · 3 threads',
		]);
		await expect(rows.nth(0).locator('svg[data-glyph="editor"]')).toHaveCount(1);
		await expect(rows.nth(1).locator('svg[data-glyph="pr-branch"]')).toHaveCount(1);
		await rows.nth(0).locator('summary').click();
		await expect(rows.nth(0).locator('pre')).toContainText('return null;');
		for (const theme of ['light', 'dark'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await rows.nth(1).locator('summary').hover();
			await page
				.locator('[data-activity]')
				.first()
				.screenshot({ animations: 'disabled', path: info.outputPath(`context-log-${theme}.png`) });
		}
		expect(errors).toEqual([]);
	} finally {
		await mcp?.close();
		try {
			await page0(app)?.evaluate((key) => window.brigadir.sendCommand(key, { kind: 'shutdown' }), {
				projectId: 'project',
				id: 'task',
			});
		} catch {}
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
const page0 = (app: Awaited<ReturnType<typeof electron.launch>>) => app.windows()[0];
