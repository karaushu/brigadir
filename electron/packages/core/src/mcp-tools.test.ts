import { describe, expect, it } from 'vitest';
import {
	skipsAgentPermission,
	brigadirTools,
	crewWorkersFromLog,
	foldedCrewEvents,
	mcpActivityTitle,
	mcpCall,
	mcpRow,
	mcpVerb,
	turnCount,
	entryCount,
} from './mcp-tools';
import { t } from './messages';
import type { ToolPatch } from './agent';
const text = (value: unknown): NonNullable<ToolPatch['content']> => [
	{ kind: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) },
];
// Shapes from real crew journals: Claude names the call, Codex only titles it.
const claude = (tool: string, input: unknown, output?: unknown): ToolPatch => ({
	id: 'c',
	name: `mcp__brigadir__${tool}`,
	title: `mcp__brigadir__${tool}`,
	category: 'other',
	status: 'completed',
	input: JSON.stringify(input),
	...(output === undefined ? {} : { content: text(output) }),
});
const codex = (tool: string, args: unknown): ToolPatch => ({
	id: 'x',
	title: `mcp.brigadir.${tool}`,
	category: 'execute',
	status: 'completed',
	input: JSON.stringify({ server: 'brigadir', tool, arguments: args }),
});
const workers = {
	fb8d: { name: 'Developer 1', title: 'Live updates wave 0: shared contract' },
} as Record<string, { name: string; title: string }>;
const worker = (id: string) => workers[id] ?? null;
describe('mcp calls (spec/chat#mcp-calls)', () => {
	it('lets every tool of our server skip the agent permission card (spec/agents-and-providers#tool-permissions)', () => {
		for (const tool of ['ask_user', 'add_folder', 'browser_act', 'commands_run', 'accept_task'])
			expect(skipsAgentPermission(claude(tool, {}))).toBe(true);
		expect(skipsAgentPermission(codex('create_task', { title: 'T' }))).toBe(true);
		expect(
			skipsAgentPermission({ id: 'f', name: 'mcp__other__ask_user', title: 'mcp__other__ask_user' })
		).toBe(false);
		expect(skipsAgentPermission(claude('invented_tool', {}))).toBe(false);
		expect(skipsAgentPermission({ id: 'b', name: 'Bash', title: 'rm -rf x' })).toBe(false);
	});
	it('reads both spellings and keeps foreign servers as they are', () => {
		expect(mcpCall(claude('task_status', { taskId: 'fb8d' }))).toEqual({
			server: 'brigadir',
			tool: 'task_status',
			args: { taskId: 'fb8d' },
		});
		expect(mcpCall(codex('read_report', { taskId: 'fb8d', reviewId: 'r' }))).toEqual({
			server: 'brigadir',
			tool: 'read_report',
			args: { taskId: 'fb8d', reviewId: 'r' },
		});
		expect(
			mcpCall({
				id: 'p',
				name: 'mcp__claude_ai_Linear__list_issues',
				title: 'mcp__claude_ai_Linear__list_issues',
			})
		).toMatchObject({ server: 'claude_ai_Linear', tool: 'list_issues' });
		expect(mcpCall({ id: 'b', name: 'Bash', title: 'pnpm test' })).toBeNull();
		expect(
			mcpVerb('uk', { server: 'playwright', tool: 'browser_navigate', args: {} }, 'done')
		).toBe('playwright · Browser navigate');
	});
	it('names every tool of our server in three states, in both languages', () => {
		for (const tool of brigadirTools)
			for (const state of ['running', 'done', 'failed'] as const) {
				const call = { server: 'brigadir', tool, args: {} };
				// Product names stay in Latin (docs/glossary.md); anything else in Latin is an untranslated key.
				expect(mcpVerb('uk', call, state).replace(/Slack/g, '')).not.toMatch(/[a-z_]{4}/);
				expect(mcpVerb('en', call, state)).toMatch(/^[A-Z]/);
			}
		expect(
			mcpVerb('uk', { server: 'brigadir', tool: 'prompt_task', args: { questionId: 'q' } }, 'done')
		).toBe('Відповів воркеру');
		expect(
			mcpVerb(
				'uk',
				{ server: 'brigadir', tool: 'simulator_act', args: { action: 'swipe' } },
				'running'
			)
		).toBe('Свайпає');
		expect(mcpActivityTitle('uk', 'mcp.brigadir.read_diff')).toBe('Переглядає зміни');
	});
	it('shows the crew agent and the outcome, not raw JSON', () => {
		const status = mcpRow(
			'uk',
			claude(
				'task_status',
				{ taskId: '987' },
				{
					taskId: '987',
					agent: 'Reviewer',
					title: 'checks Developer 1',
					status: 'done',
					busy: false,
					turns: 15,
					changedFiles: 0,
					accepted: false,
					part: 2,
				}
			),
			'done',
			worker
		)!;
		expect(status).toMatchObject({ module: 'crew', title: 'Перевірив стан', who: 'Ревʼюер' });
		expect(status.detail.map((s) => s.text).join('')).toBe(
			'завершено · частина 2 · 15 турнів · 0 файлів'
		);
		expect(status.fields.find((f) => f.label === 'Працює зараз')?.value).toBe('ні');
		const accept = mcpRow(
			'uk',
			claude(
				'accept_task',
				{ taskId: 'fb8d' },
				{ accepted: true, merged: ['.'], committed: [{ name: '.', sha: 'd8ae73d1e539f' }] }
			),
			'done',
			worker
		)!;
		expect(accept).toMatchObject({ title: 'Прийняв частину', who: 'Розробник 1' });
		expect(accept.detail.map((s) => s.text).join('')).toBe(
			'Live updates wave 0: shared contract · коміт d8ae73d'
		);
		const part = mcpRow(
			'uk',
			claude(
				'create_worker_task',
				{ agent: 'Developer 2', title: 'Zustand handlers', prompt: 'Do it', files: ['src/a.ts'] },
				{ taskId: '2', agent: 'Developer 2', title: 'Zustand handlers', status: 'queued' }
			),
			'done',
			worker
		)!;
		expect(part).toMatchObject({ title: 'Доручив частину', who: 'Розробник 2', text: 'Do it' });
		expect(part.detail.map((s) => s.text).join('')).toBe('Zustand handlers · у черзі');
		const text =
			"Report from `Developer 1` · Wave 1 (task 2314)\nStatus: done. Changed files: 2, +41 −1.\nFiles:\n- docs/a.md M +1 −1\n- src/b.ts A +40 −0\n\nWorker's last message:\nDone.";
		expect(
			mcpRow('uk', claude('read_report', { taskId: '2314' }, { report: text }), 'done', worker)
		).toMatchObject({
			who: 'Розробник 1',
			files: [
				{ path: 'docs/a.md', status: 'M', added: 1, removed: 1 },
				{ path: 'src/b.ts', status: 'A', added: 40, removed: 0 },
			],
			message: 'Done.',
			text: null,
		});
		const report = mcpRow('en', codex('read_report', { taskId: 'fb8d' }), 'done', worker)!;
		expect(report).toMatchObject({ title: 'Read the report', who: 'Developer 1' });
	});
	it('names the project command, its address and how it ended (spec/search-menus-and-commands#agent-command-tools)', () => {
		const list = mcpRow(
			'uk',
			claude(
				'commands_list',
				{},
				{
					commands: [
						{
							id: 'dev',
							name: 'dev',
							command: 'pnpm dev',
							state: 'running',
							url: 'http://localhost:3000',
						},
						{ id: 'seed', name: 'Seed', command: 'pnpm seed', state: 'not run' },
					],
				}
			),
			'done'
		)!;
		expect(list).toMatchObject({
			module: 'commands',
			title: 'Переглянув команди',
			text: 'dev · pnpm dev · running · http://localhost:3000\nSeed · pnpm seed · not run',
		});
		expect(list.detail.map((s) => s.text).join('')).toBe('2 команди');
		const run = mcpRow(
			'uk',
			claude(
				'commands_run',
				{ id: 'dev' },
				{ id: 'dev', name: 'dev', state: 'running', url: 'http://localhost:3000', output: 'ready' }
			),
			'done'
		)!;
		expect(run).toMatchObject({ title: 'Запустив команду', text: 'ready' });
		expect(run.detail.map((s) => s.text).join('')).toBe('dev · http://localhost:3000 · працює');
		expect(
			mcpRow('uk', claude('commands_run', { id: 'dev' }), 'running')!
				.detail.map((s) => s.text)
				.join('')
		).toBe('dev');
		expect(
			mcpRow(
				'en',
				claude(
					'commands_output',
					{ id: 'seed' },
					{ id: 'seed', name: 'Seed', state: 'failed', exitCode: 1 }
				),
				'done'
			)!
				.detail.map((s) => s.text)
				.join('')
		).toBe(`Seed · ${t('en', 'crashed')} · exit 1`);
	});
	it('counts the console sessions and names the tab it read (spec/terminal-and-cli-agents#agent-console-tools)', () => {
		const list = mcpRow(
			'uk',
			claude(
				'console_list',
				{},
				{
					consoles: [
						{ id: 'a', title: 'business', folder: '.', state: 'running' },
						{ id: 'b', title: 'zsh', folder: 'example', state: 'exited', exitCode: 1 },
					],
				}
			),
			'done'
		)!;
		expect(list).toMatchObject({
			module: 'console',
			title: 'Переглянув консоль',
			text: 'business · . · running\nzsh · example · exited',
		});
		expect(list.detail.map((s) => s.text).join('')).toBe('2 сеанси');
		expect(
			mcpRow('uk', claude('console_list', {}, { consoles: [], note: 'No console' }), 'done')!
				.detail.map((s) => s.text)
				.join('')
		).toBe('консоль не відкрита');
		const read = mcpRow(
			'en',
			claude(
				'console_read',
				{ lines: 80 },
				{ id: 'a', title: 'business', state: 'running', output: ' LOG  found\n LOG  connected' }
			),
			'done'
		)!;
		expect(read).toMatchObject({ title: 'Read the console', text: ' LOG  found\n LOG  connected' });
		expect(read.detail.map((s) => s.text).join('')).toBe('business · 2 lines');
	});
	it('says what did not happen and why', () => {
		const failed = mcpRow(
			'uk',
			{
				...claude('prompt_task', { taskId: 'fb8d', text: 'Check it' }),
				status: 'failed',
				content: text('```\nAgent is starting\n```'),
			},
			'failed',
			worker
		)!;
		expect(failed).toMatchObject({ title: 'Промпт не надіслано', who: 'Розробник 1' });
		expect(failed.detail).toEqual([{ kind: 'text', text: 'Agent is starting' }]);
		expect(
			mcpRow('uk', claude('read_diff', { taskId: 'fb8d' }), 'interrupted', worker)!.detail
		).toEqual([{ kind: 'text', text: t('uk', 'interrupted') }]);
	});
	it('does not say a refused folder was added (spec/projects-and-board#folders-mid-task)', () => {
		const refused = (locale: 'uk' | 'en', reason: string) =>
			mcpRow(
				locale,
				claude(
					'add_folder',
					{ path: '/Users/a/backend' },
					{ added: false, reason, name: 'backend', path: '/Users/a/backend' }
				),
				'done'
			)!;
		expect(refused('en', 'The person declined adding the folder.')).toMatchObject({
			title: 'Did not add the folder',
			detail: [
				{ kind: 'code', text: '/Users/a/backend' },
				{ kind: 'text', text: ' · ' },
				{ kind: 'text', text: 'declined' },
			],
		});
		expect(refused('uk', 'The folder is already in the task.')).toMatchObject({
			title: 'Не додав теку',
			detail: [
				{ kind: 'code', text: '/Users/a/backend' },
				{ kind: 'text', text: ' · ' },
				{ kind: 'text', text: 'вже в задачі' },
			],
		});
		// A reason that is not ours stays as the host wrote it.
		expect(refused('uk', 'Disk is full.').detail.at(-1)).toEqual({
			kind: 'text',
			text: 'Disk is full.',
		});
	});
	it('says what the person has open: the file and line, the selection, the PR, or why nothing is seen (spec/agents-and-providers#context-tools)', () => {
		const editor = mcpRow(
			'uk',
			claude(
				'editor_state',
				{},
				{
					window: 'open',
					visible: true,
					tabs: [],
					active: {
						kind: 'file',
						path: 'src/order.ts',
						cursor: { line: 13, column: 1 },
						selections: [{ lines: [10, 12], text: 'const a = 1;' }],
					},
				}
			),
			'done'
		)!;
		expect(editor).toMatchObject({
			module: 'editor',
			title: 'Прочитав редактор',
			text: 'const a = 1;',
		});
		expect(editor.detail).toEqual([
			{ kind: 'code', text: 'src/order.ts:13' },
			{ kind: 'text', text: ' · ' },
			{ kind: 'text', text: '3 рядки виділено' },
		]);
		expect(
			mcpRow(
				'en',
				claude(
					'editor_state',
					{},
					{
						window: 'open',
						active: {
							kind: 'diff',
							path: 'api/x.go',
							selection: { side: 'new', lines: [4, 4], text: 'x' },
						},
					}
				),
				'done'
			)!.detail
		).toEqual([
			{ kind: 'code', text: 'api/x.go' },
			{ kind: 'text', text: ' · ' },
			{ kind: 'text', text: '1 line selected' },
		]);
		expect(
			mcpRow('uk', claude('editor_state', {}, { window: 'open', tabs: [], active: null }), 'done')!
				.detail
		).toEqual([{ kind: 'text', text: 'нічого не відкрито' }]);
		// spec/agents-and-providers#editor-state: a console or browser tab has a title, not a path; the PR overview — its number.
		const shown = (active: Record<string, unknown>) =>
			mcpRow('uk', claude('editor_state', {}, { window: 'open', active }), 'done')!.detail;
		expect(shown({ kind: 'terminal', title: 'pnpm dev' })).toEqual([
			{ kind: 'code', text: 'pnpm dev' },
		]);
		expect(shown({ kind: 'pr-overview', pullRequest: 7 })).toEqual([{ kind: 'code', text: '#7' }]);
		expect(mcpRow('uk', claude('editor_state', {}, { window: 'closed' }), 'done')!.detail).toEqual([
			{ kind: 'text', text: 'вікно закрите' },
		]);
		expect(mcpRow('uk', claude('editor_state', {}), 'running')!).toMatchObject({
			title: 'Читає редактор',
			detail: [],
		});
		const pr = mcpRow(
			'uk',
			claude(
				'pr_state',
				{},
				{ window: 'open', open: true, number: 421, title: 'Loyalty rules', threads: [{}, {}, {}] }
			),
			'done'
		)!;
		expect(pr).toMatchObject({ module: 'pr', title: 'Переглянув PR' });
		expect(pr.detail.map((part) => part.text).join('')).toBe('#421 · Loyalty rules · 3 треди');
		expect(
			mcpRow('uk', claude('pr_state', {}, { window: 'open', open: false }), 'done')!.detail
		).toEqual([{ kind: 'text', text: 'PR не відкрито' }]);
		expect(
			mcpRow('uk', claude('pr_state', {}, 'Pull requests are off in Settings.'), 'failed')!
		).toMatchObject({
			title: 'PR не прочитано',
			detail: [{ kind: 'text', text: 'Pull requests are off in Settings.' }],
		});
	});
	it('has four Ukrainian plural forms', () => {
		expect([1, 3, 5, 1.5].map((n) => turnCount('uk', n))).toEqual([
			'1 турн',
			'3 турни',
			'5 турнів',
			'1,5 турну',
		]);
		expect([1, 2, 11].map((n) => entryCount('uk', n))).toEqual([
			'1 запис',
			'2 записи',
			'11 записів',
		]);
	});
	it('folds the service row of a part and an acceptance the call already shows', () => {
		const at = '2026-10-01T12:00:00Z';
		let seq = 0;
		const r = (event: any) => ({ schemaVersion: 1 as const, seq: ++seq, at, event });
		const records = [
			r({ kind: 'turn.started', text: 'go' }),
			r({
				kind: 'tool.changed',
				patch: {
					id: 'a',
					name: 'mcp__brigadir__create_worker_task',
					input: '{"agent":"Developer 1","ti',
				},
			}),
			r({
				kind: 'tool.changed',
				patch: {
					id: 'a',
					name: 'mcp__brigadir__create_worker_task',
					input: '{"agent":"Developer 1","title":"Wave 0"}',
				},
			}),
			r({
				kind: 'crew.worker.created',
				taskId: 't1',
				nodeId: 'developer-1',
				name: 'Developer 1',
				title: 'Wave 0',
			}),
			r({
				kind: 'crew.worker.created',
				taskId: 't2',
				nodeId: 'reviewer',
				name: 'Reviewer',
				title: 'checks Developer 1',
			}),
			r({
				kind: 'tool.changed',
				patch: { id: 'b', name: 'mcp__brigadir__accept_task', input: '{"taskId":"t1"}' },
			}),
			r({
				kind: 'crew.accepted',
				taskId: 't1',
				nodeId: 'developer-1',
				name: 'Developer 1',
				conflicts: [],
			}),
			r({
				kind: 'crew.accepted',
				taskId: 't3',
				nodeId: 'developer-2',
				name: 'Developer 2',
				conflicts: [],
			}),
		];
		expect([...foldedCrewEvents(records as never)]).toEqual([4, 7]);
		expect(crewWorkersFromLog(records as never).get('t1')).toEqual({
			name: 'Developer 1',
			title: 'Wave 0',
		});
	});
});
