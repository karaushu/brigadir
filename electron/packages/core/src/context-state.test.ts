import { describe, expect, it } from 'vitest';
import {
	clipText,
	contextClosed,
	contextTextLimit,
	editorStateAnswer,
	fileRepo,
	isContextReport,
	prStateAnswer,
	type ContextOptions,
	type ContextReport,
} from './context-state';
import type { PRReviewDraft, PullRequestDetail } from './pull-requests';

const report = (patch: Partial<ContextReport> = {}): ContextReport => ({
	visible: true,
	documentsShown: true,
	tabs: [
		{ kind: 'file', path: 'src/order.ts', active: true, dirty: true },
		{ kind: 'diff', scopeId: 's1', path: 'api/x.go', active: false, source: 'changes' },
	],
	editor: {
		path: 'src/order.ts',
		view: 'editor',
		lineCount: 160,
		dirty: true,
		readOnly: false,
		cursor: { line: 13, column: 1 },
		selections: [{ from: { line: 10, column: 1 }, to: { line: 13, column: 1 }, text: 'a\nb\nc\n' }],
		visibleLines: { start: 1, end: 40 },
	},
	diff: null,
	panel: { shown: true, tab: 'changes', changesView: 'diff' },
	pr: null,
	...patch,
});
const options: ContextOptions = {
	visible: true,
	diffBase: 'task',
	repo: (id) => (id === 's1' ? { name: 'api', path: 'services/api' } : null),
};

describe('editor_state and pr_state (spec/agents-and-providers#context-tools)', () => {
	it('checks the window report before it reaches a host', () => {
		expect(isContextReport(report())).toBe(true);
		expect(
			isContextReport({ ...report(), tabs: [{ kind: 'file', path: 'a', active: true }] })
		).toBe(false);
		expect(
			isContextReport(report({ editor: { ...report().editor!, cursor: { line: 0, column: 1 } } }))
		).toBe(false);
		expect(
			isContextReport(
				report({
					editor: {
						...report().editor!,
						selections: [
							{
								from: { line: 1, column: 1 },
								to: { line: 1, column: 2 },
								text: 'x'.repeat(contextTextLimit + 1),
							},
						],
					},
				})
			)
		).toBe(false);
		expect(
			isContextReport(
				report({ tabs: [{ kind: 'pr-overview', scopeId: 's1', number: 7, active: true }] })
			)
		).toBe(true);
		expect(isContextReport(report({ pr: { scopeId: 's1', number: 7, tab: 'files' } }))).toBe(true);
		expect(isContextReport(report({ pr: { scopeId: 's1', number: 0, tab: 'files' } }))).toBe(false);
		expect(isContextReport(null)).toBe(false);
	});
	it('clips a long selection and keeps its full length', () => {
		expect(clipText('abc')).toEqual({ text: 'abc' });
		expect(clipText('x'.repeat(contextTextLimit + 5))).toEqual({
			text: 'x'.repeat(contextTextLimit),
			truncated: true,
			length: contextTextLimit + 5,
		});
	});
	it('gives the active file with the cursor, the selected lines and the text', () => {
		const answer = editorStateAnswer(report(), options) as any;
		expect(answer).toMatchObject({
			window: 'open',
			visible: true,
			documentsShown: true,
			panel: { shown: true, tab: 'changes' },
		});
		expect(answer.tabs).toEqual([
			{ kind: 'file', path: 'src/order.ts', active: true, unsaved: true },
			{
				kind: 'diff',
				path: 'services/api/api/x.go',
				repo: 'api',
				source: 'changes',
				active: false,
			},
		]);
		// A selection that ends at the start of line 13 covers lines 10–12, as the editor's selection bar counts them.
		expect(answer.active).toEqual({
			kind: 'file',
			path: 'src/order.ts',
			view: 'editor',
			lineCount: 160,
			unsaved: true,
			cursor: { line: 13, column: 1 },
			selections: [
				{
					lines: [10, 12],
					from: { line: 10, column: 1 },
					to: { line: 13, column: 1 },
					text: 'a\nb\nc\n',
				},
			],
			visibleLines: [1, 40],
		});
		expect(answer.note).toBeUndefined();
	});
	it('gives a diff with its repo path, base and selected diff lines', () => {
		const diff = {
			scopeId: 's1',
			path: 'x.go',
			oldPath: 'x.go',
			status: 'M',
			source: 'changes' as const,
			baseLabel: null,
			afterLabel: null,
			range: null,
			layout: 'split' as const,
			preview: false,
			selection: { side: 'new' as const, start: 4, end: 6, text: 'four\nfive\nsix' },
			visibleLines: { old: { start: 1, end: 30 }, new: null },
			pr: null,
		};
		const answer = editorStateAnswer(report({ editor: null, diff }), options) as any;
		expect(answer.active).toEqual({
			kind: 'diff',
			path: 'services/api/x.go',
			repo: 'api',
			status: 'M',
			source: 'changes',
			base: 'start of the task',
			view: 'diff',
			layout: 'split',
			selection: { side: 'new', lines: [4, 6], text: 'four\nfive\nsix' },
			visibleLines: { old: [1, 30], new: null },
		});
		expect(
			(editorStateAnswer(report({ editor: null, diff }), { ...options, diffBase: 'head' }) as any)
				.active.base
		).toBe('last commit (HEAD of the repo)');
		expect(
			(
				editorStateAnswer(
					report({ editor: null, diff: { ...diff, range: { base: 2, current: 3 } } }),
					options
				) as any
			).active.base
		).toBe('turns: checkpoint 2 to 3');
	});
	it('answers nothing open, another task shown, the chat side and a closed window with a sentence, not an error', () => {
		expect(editorStateAnswer(report({ tabs: [], editor: null }), options)).toMatchObject({
			tabs: [],
			active: null,
			note: 'No file or diff is open in this task.',
		});
		expect(
			editorStateAnswer(report({ visible: false }), { ...options, visible: false })
		).toMatchObject({ visible: false, note: expect.stringContaining('another task') });
		expect(editorStateAnswer(report({ documentsShown: false }), options)).toMatchObject({
			note: expect.stringContaining('chat'),
		});
		expect(editorStateAnswer(null, options)).toMatchObject({
			visible: false,
			tabs: [],
			note: expect.stringContaining('not opened this task'),
		});
		expect(contextClosed('editor')).toMatchObject({ window: 'closed' });
		expect(contextClosed('pr')).toMatchObject({ window: 'closed', open: false });
	});
	it("gives the open PR, its threads, comments and the person's unsent drafts with the agent's replies", () => {
		const detail = {
			summary: {
				number: 7,
				title: 'Loyalty rules',
				url: 'https://github.com/o/r/pull/7',
				state: 'OPEN',
				author: 'ann',
				head: 'feature/loyalty',
				base: 'main',
				reviewDecision: null,
			},
			threads: [
				{
					id: 'T1',
					path: 'src/rule.ts',
					line: 12,
					startLine: 10,
					side: 'RIGHT',
					resolved: false,
					outdated: false,
					hunk: null,
					comments: [
						{
							id: 'c1',
							databaseId: 1,
							author: 'bob',
							body: 'Why here?',
							createdAt: '2026-10-06T10:00:00Z',
							url: 'u',
						},
					],
				},
			],
			comments: [
				{ id: 'i1', author: 'ann', body: 'Ready', createdAt: '2026-10-06T09:00:00Z', url: 'u' },
			],
			reviews: [
				{
					id: 'r1',
					author: 'bob',
					state: 'COMMENTED',
					body: '',
					submittedAt: '2026-10-06T10:00:00Z',
				},
			],
			files: [],
		} as unknown as PullRequestDetail;
		const review: PRReviewDraft = {
			body: '',
			event: 'COMMENT',
			sendComments: true,
			last: null,
			drafts: [
				{
					id: 'd1',
					path: 'src/rule.ts',
					side: 'RIGHT',
					line: 20,
					startLine: null,
					body: 'Rename this',
					createdAt: 't',
					replyTo: null,
				},
				{
					id: 'd2',
					path: 'src/rule.ts',
					side: 'RIGHT',
					line: 30,
					startLine: 28,
					body: 'Missing check',
					createdAt: 't',
					replyTo: null,
					fromAgent: true,
					discussion: [
						{ from: 'person', body: 'Sure?', at: 't1' },
						{ from: 'agent', body: 'Yes, null input.', at: 't2' },
					],
				},
			],
		};
		const file = {
			scopeId: 's1',
			path: 'src/rule.ts',
			oldPath: 'src/rule.ts',
			status: 'M',
			source: 'pr' as const,
			baseLabel: null,
			afterLabel: null,
			range: null,
			layout: 'unified' as const,
			preview: false,
			selection: { side: 'new' as const, start: 10, end: 12, text: 'x' },
			visibleLines: { old: null, new: { start: 1, end: 50 } },
			pr: { scopeId: 's1', number: 7 },
		};
		const value = prStateAnswer(
			report({
				editor: null,
				diff: file,
				pr: { scopeId: 's1', number: 7, tab: 'files' },
				tabs: [{ kind: 'diff', scopeId: 's1', path: 'src/rule.ts', active: true, source: 'pr' }],
			}),
			detail,
			review,
			options
		) as any;
		expect(value).toMatchObject({
			window: 'open',
			open: true,
			number: 7,
			title: 'Loyalty rules',
			head: 'feature/loyalty',
			base: 'main',
			tab: 'files',
			repo: 'api',
			openFile: {
				path: 'src/rule.ts',
				selection: { side: 'new', lines: [10, 12], text: 'x' },
				visibleLines: { old: null, new: [1, 50] },
			},
			openTabs: [{ path: 'src/rule.ts', active: true }],
		});
		expect(value.threads).toEqual([
			{
				id: 'T1',
				path: 'src/rule.ts',
				lines: [10, 12],
				side: 'RIGHT',
				resolved: false,
				outdated: false,
				comments: [{ author: 'bob', at: '2026-10-06T10:00:00Z', body: 'Why here?', url: 'u' }],
			},
		]);
		expect(value.reviews).toEqual([]);
		expect(value.comments).toEqual([{ author: 'ann', at: '2026-10-06T09:00:00Z', body: 'Ready' }]);
		expect(value.drafts).toEqual([
			{
				id: 'd1',
				path: 'src/rule.ts',
				lines: [20],
				side: 'RIGHT',
				body: 'Rename this',
				from: 'person',
			},
			{
				id: 'd2',
				path: 'src/rule.ts',
				lines: [28, 30],
				side: 'RIGHT',
				body: 'Missing check',
				from: 'agent',
				discussion: [
					{ from: 'person', body: 'Sure?', at: 't1' },
					{ from: 'agent', body: 'Yes, null input.', at: 't2' },
				],
			},
		]);
		expect(prStateAnswer(report(), null, null, options)).toEqual({
			window: 'open',
			open: false,
			note: expect.stringContaining('No pull request is open'),
		});
		expect(
			prStateAnswer(
				report({ pr: { scopeId: 's1', number: 7, tab: 'comments' } }),
				null,
				null,
				options,
				'GitHub is unavailable'
			)
		).toMatchObject({ open: true, number: 7, error: 'GitHub is unavailable' });
	});
});

describe('editor_state and pr_state: groups, repos, changes, Viewed (spec/agents-and-providers#editor-state)', () => {
	const repos = [
		{ name: 'choice', path: '' },
		{ name: 'api', path: 'services/api' },
		{ name: 'outside', path: '/elsewhere/x' },
	];
	const withRepos: ContextOptions = { ...options, repos };
	const diff = {
		scopeId: 's1',
		path: 'x.go',
		oldPath: 'x.go',
		status: 'M',
		source: 'changes' as const,
		baseLabel: null,
		afterLabel: null,
		range: null,
		layout: 'unified' as const,
		preview: false,
		selection: {
			side: 'new' as const,
			start: 4,
			end: 8,
			text: 'x',
			changed: [
				{ start: 5, end: 6 },
				{ start: 8, end: 8 },
			],
		},
		visibleLines: null,
		pr: null,
	};
	it('tells the repo of a file by the deepest repo folder that holds it', () => {
		expect(fileRepo('src/a.ts', repos)).toEqual({ repo: 'choice' });
		expect(fileRepo('services/api/x.go', repos)).toEqual({ repo: 'api', repoPath: 'x.go' });
		expect(fileRepo('services/apiary/x.go', repos)).toEqual({ repo: 'choice' });
		expect(fileRepo('a.ts', [])).toBeNull();
	});
	it('gives every editor group, tool tabs and all carets', () => {
		const value = report({
			tabs: [
				{ kind: 'file', path: 'services/api/main.go', active: true, dirty: false, group: 1 },
				{ kind: 'terminal', title: 'pnpm dev', active: false, group: 1 },
				{ kind: 'diff', scopeId: 's1', path: 'x.go', active: false, source: 'changes', group: 2 },
			],
			editor: {
				...report().editor!,
				path: 'services/api/main.go',
				cursor: { line: 3, column: 1 },
				cursors: [
					{ line: 3, column: 1 },
					{ line: 9, column: 4 },
				],
			},
			groups: [
				{ group: 1, focused: true, tab: 0, editor: report().editor, diff: null },
				{ group: 2, focused: false, tab: 2, editor: null, diff },
			],
		});
		expect(isContextReport(value)).toBe(true);
		const answer = editorStateAnswer(value, withRepos) as any;
		expect(answer.tabs).toEqual([
			{
				kind: 'file',
				path: 'services/api/main.go',
				repo: 'api',
				repoPath: 'main.go',
				group: 1,
				active: true,
				unsaved: false,
			},
			{ kind: 'terminal', title: 'pnpm dev', group: 1, active: false },
			{
				kind: 'diff',
				path: 'services/api/x.go',
				repo: 'api',
				source: 'changes',
				group: 2,
				active: false,
			},
		]);
		expect(answer.active).toMatchObject({
			group: 1,
			kind: 'file',
			repo: 'api',
			repoPath: 'main.go',
			cursors: [
				{ line: 3, column: 1 },
				{ line: 9, column: 4 },
			],
		});
		expect(answer.groups).toHaveLength(2);
		expect(answer.groups[1]).toMatchObject({
			group: 2,
			focused: false,
			active: {
				kind: 'diff',
				selection: {
					side: 'new',
					lines: [4, 8],
					kind: 'mixed',
					changed: [
						[5, 6],
						[8, 8],
					],
				},
			},
		});
		// One group: no `groups`, no group numbers.
		expect(editorStateAnswer(report(), withRepos)).not.toHaveProperty('groups');
		// A console tab in focus is a console, not a diff of Changes.
		expect(
			(
				editorStateAnswer(
					report({
						editor: null,
						tabs: [{ kind: 'browser', title: 'localhost:3000', active: true }],
					}),
					withRepos
				) as any
			).active
		).toEqual({
			kind: 'browser',
			title: 'localhost:3000',
			note: 'A browser tab; the browser_* tools read it.',
		});
	});
	it('says whether the selected diff lines are added, removed or context', () => {
		const kind = (changed: { start: number; end: number }[], side: 'old' | 'new' = 'new') =>
			(
				editorStateAnswer(
					report({
						editor: null,
						diff: { ...diff, selection: { ...diff.selection, side, changed } },
					}),
					options
				) as any
			).active.selection;
		expect(kind([{ start: 4, end: 8 }])).toEqual({
			side: 'new',
			lines: [4, 8],
			kind: 'added',
			text: 'x',
		});
		expect(kind([{ start: 4, end: 8 }], 'old').kind).toBe('removed');
		expect(kind([]).kind).toBe('context');
	});
	it('checks the new fields of the report', () => {
		expect(isContextReport(report({ tabs: [{ kind: 'terminal', active: true } as never] }))).toBe(
			false
		);
		expect(
			isContextReport(
				report({
					editor: {
						...report().editor!,
						selections: [0, 1].map((n) => ({
							from: { line: n + 1, column: 1 },
							to: { line: n + 1, column: 2 },
							text: 'x'.repeat(contextTextLimit / 2 + 1),
						})),
					},
				})
			)
		).toBe(false);
		expect(
			isContextReport(
				report({ groups: [{ group: 0, focused: true, tab: null, editor: null, diff: null }] })
			)
		).toBe(false);
		expect(
			isContextReport(report({ pr: { scopeId: 's1', number: 7, tab: 'files', panel: false } }))
		).toBe(true);
	});
	it("gives the PR files with Viewed and the open ones, the person's comments marked, the PR of a tab", () => {
		const detail = {
			summary: { number: 7, title: 'T', head: 'f', base: 'main' },
			threads: [
				{
					id: 'T1',
					path: 'a.ts',
					line: 3,
					startLine: null,
					side: 'RIGHT',
					resolved: false,
					outdated: false,
					hunk: null,
					comments: [
						{ id: 'c', databaseId: 1, author: 'me', body: 'Fix', createdAt: 't', url: 'u' },
					],
				},
			],
			comments: [],
			reviews: [{ id: 'r', author: 'me', state: 'APPROVED', body: '', submittedAt: 't' }],
			files: [
				{ path: 'a.ts', additions: 3, deletions: 1, change: 'MODIFIED', viewed: true },
				{ path: 'b.ts', additions: 1, deletions: 0, change: 'ADDED', viewed: false },
				{ path: 'c.ts', additions: 0, deletions: 9, change: 'DELETED', viewed: false },
			],
		} as unknown as PullRequestDetail;
		const pr = { scopeId: 's1', number: 7 };
		const value = prStateAnswer(
			report({
				editor: null,
				diff: null,
				tabs: [
					{ kind: 'file', path: 'x.ts', active: true, dirty: false, group: 1 },
					{ kind: 'diff', scopeId: 's1', path: 'b.ts', active: false, source: 'pr', pr, group: 2 },
					{
						kind: 'diff',
						scopeId: 's1',
						path: 'c.ts',
						active: false,
						source: 'pr',
						pr: { scopeId: 's1', number: 8 },
						group: 2,
					},
				],
				groups: [
					{ group: 1, focused: true, tab: 0, editor: report().editor, diff: null },
					{
						group: 2,
						focused: false,
						tab: 1,
						editor: null,
						diff: { ...diff, path: 'b.ts', source: 'pr', pr, selection: null },
					},
				],
				pr: { ...pr, tab: 'comments', panel: false },
			}),
			detail,
			null,
			options,
			undefined,
			'me'
		) as any;
		expect(value).toMatchObject({
			open: true,
			panel: false,
			viewer: 'me',
			viewed: { n: 1, of: 3 },
		});
		expect(value).not.toHaveProperty('tab');
		expect(value.files).toEqual([
			{ path: 'a.ts', change: 'MODIFIED', additions: 3, deletions: 1, viewed: true },
			{
				path: 'b.ts',
				change: 'ADDED',
				additions: 1,
				deletions: 0,
				viewed: false,
				open: true,
				active: true,
			},
			{ path: 'c.ts', change: 'DELETED', additions: 0, deletions: 9, viewed: false },
		]);
		expect(value.openTabs).toEqual([{ path: 'b.ts', active: false, group: 2 }]);
		expect(value.openFile).toMatchObject({ path: 'b.ts' });
		expect(value.threads[0].comments[0]).toMatchObject({ author: 'me', mine: true });
		expect(value.reviews).toEqual([
			{ author: 'me', mine: true, state: 'APPROVED', at: 't', body: '' },
		]);
	});
});
