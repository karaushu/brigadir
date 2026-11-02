import { describe, expect, it } from 'vitest';
import {
	chipDirectory,
	lineChangeCount,
	toolGroupName,
	toolGroupDuration,
	toolGroupSummary,
	toolMixText,
	toolRuns,
	type ToolGroupCall,
} from './tool-groups';
import { moreFileCount, toolCallCount, toolErrorCount } from './messages';

const call = (
	id: string,
	name: string | undefined,
	status = 'completed',
	extra: Partial<ToolGroupCall['tool']> = {},
	startedAt = 0,
	finishedAt: number | null = status === 'completed' || status === 'failed' ? 100 : null
): ToolGroupCall => ({
	id,
	tool: { id, ...(name ? { name } : {}), status, ...extra },
	startedAt,
	finishedAt,
});

describe('toolRuns (spec/chat#tool-groups)', () => {
	const role = (row: string) =>
		row.startsWith('t') ? 'tool' : row.startsWith('h') ? 'thought' : 'break';
	it('folds two calls or more in a row; one call stays a plain row', () => {
		expect(toolRuns(['m', 't1', 'm', 't2', 't3', 'm'], role)).toEqual([
			{ kind: 'row', row: 'm' },
			{ kind: 'row', row: 't1' },
			{ kind: 'row', row: 'm' },
			{ kind: 'group', items: ['t2', 't3'], tools: ['t2', 't3'] },
			{ kind: 'row', row: 'm' },
		]);
	});
	it('takes a thought between calls into the group, leaves one at the edge outside', () => {
		expect(toolRuns(['h0', 't1', 'h1', 't2', 'h2', 'm'], role)).toEqual([
			{ kind: 'row', row: 'h0' },
			{ kind: 'group', items: ['t1', 'h1', 't2'], tools: ['t1', 't2'] },
			{ kind: 'row', row: 'h2' },
			{ kind: 'row', row: 'm' },
		]);
	});
	it('a message, a card or any other row closes the group', () => {
		expect(
			toolRuns(['t1', 't2', 'm', 't3', 't4'], role).map((run) =>
				run.kind === 'group' ? run.tools : run.row
			)
		).toEqual([['t1', 't2'], 'm', ['t3', 't4']]);
	});
	it('a thought alone between two single calls makes them a group', () => {
		expect(toolRuns(['t1', 'h1', 't2'], role)).toEqual([
			{ kind: 'group', items: ['t1', 'h1', 't2'], tools: ['t1', 't2'] },
		]);
	});
});

describe('toolGroupSummary (spec/chat#tool-groups)', () => {
	it('counts the calls, names the tools by use, pins the failed and the running ones', () => {
		const calls = [
			call('a', 'Bash'),
			call('b', 'Read'),
			call('c', 'Bash', 'failed', { exitCode: 1 }),
			call('d', 'Grep'),
			call('e', 'Bash', 'in_progress'),
		];
		expect(toolGroupSummary(calls)).toEqual({
			calls: 5,
			mix: [
				{ name: 'Bash', count: 3 },
				{ name: 'Read', count: 1 },
				{ name: 'Grep', count: 1 },
			],
			errors: 1,
			running: true,
			files: [],
			pinned: ['c', 'e'],
		});
	});
	it('an interrupted call (closed by the turn) is neither running nor an error', () => {
		expect(
			toolGroupSummary([call('a', 'Bash', 'in_progress', {}, 0, 50), call('b', 'Read')])
		).toMatchObject({ running: false, errors: 0, pinned: [] });
	});
	it('Codex calls without a name are counted but not named', () => {
		expect(toolGroupSummary([call('a', undefined), call('b', undefined)])).toMatchObject({
			calls: 2,
			mix: [],
		});
	});
	it('Edit and Write give one chip per file with +N −M; the chip opens the latest edit', () => {
		const edit = (id: string, before: string, after: string, path = 'kit/Button.module.css') =>
			call(id, 'Edit', 'completed', {
				category: 'edit',
				content: [{ kind: 'diff', path, before, after }],
			});
		const summary = toolGroupSummary([
			edit('a', 'a\nb\n', 'a\nB\nc\n'),
			call('x', 'Bash'),
			edit('b', 'x\n', 'y\n'),
			edit('c', null as unknown as string, 'new\nfile\n', 'kit/new.ts'),
		]);
		expect(summary.files).toEqual([
			{ path: 'kit/Button.module.css', additions: 3, deletions: 2, callId: 'b', index: 0 },
			{ path: 'kit/new.ts', additions: 2, deletions: 0, callId: 'c', index: 0 },
		]);
	});
});

describe('toolGroupDuration', () => {
	it('adds the calls’ own times; a running call counts to now', () => {
		expect(
			toolGroupDuration(
				[
					call('a', 'Bash', 'completed', {}, 0, 614),
					call('b', 'Read', 'completed', {}, 1000, 1012),
					call('c', 'Bash', 'in_progress', {}, 2000),
				],
				8000
			)
		).toBe(614 + 12 + 6000);
	});
});

describe('toolMixText', () => {
	it('shows four tools, then the rest as +N', () => {
		expect(
			toolMixText([
				{ name: 'Bash', count: 14 },
				{ name: 'Read', count: 5 },
				{ name: 'Grep', count: 2 },
			])
		).toBe('14 Bash · 5 Read · 2 Grep');
		expect(
			toolMixText([
				{ name: 'Bash', count: 4 },
				{ name: 'Read', count: 3 },
				{ name: 'Grep', count: 2 },
				{ name: 'Edit', count: 1 },
				{ name: 'Write', count: 1 },
				{ name: 'WebFetch', count: 1 },
			])
		).toBe('4 Bash · 3 Read · 2 Grep · 1 Edit · +2');
	});
});

describe('lineChangeCount', () => {
	it('counts added and removed lines as a diff does', () => {
		expect(
			lineChangeCount(
				'.button:focus-visible {\n  outline: none;\n}\n',
				'.button:focus-visible {\n  outline: 2px solid var(--focus-ring);\n  outline-offset: 2px;\n}\n'
			)
		).toEqual({ additions: 2, deletions: 1 });
		expect(lineChangeCount(null, 'a\nb\n')).toEqual({ additions: 2, deletions: 0 });
		expect(lineChangeCount('a\nb\nc\n', 'a\nc\n')).toEqual({ additions: 0, deletions: 1 });
		expect(lineChangeCount('same\n', 'same\n')).toEqual({ additions: 0, deletions: 0 });
	});
});

describe('labels: four uk forms (rule 9)', () => {
	it('tool calls', () => {
		expect([1, 3, 5, 11, 21, 22, 25, 112].map((n) => toolCallCount('uk', n))).toEqual([
			'1 виклик',
			'3 виклики',
			'5 викликів',
			'11 викликів',
			'21 виклик',
			'22 виклики',
			'25 викликів',
			'112 викликів',
		]);
		expect(toolCallCount('uk', 1.5)).toBe('1,5 виклику');
		expect([1, 2].map((n) => toolCallCount('en', n))).toEqual(['1 tool call', '2 tool calls']);
	});
	it('errors and more files', () => {
		expect([1, 2, 5, 21].map((n) => toolErrorCount('uk', n))).toEqual([
			'1 помилка',
			'2 помилки',
			'5 помилок',
			'21 помилка',
		]);
		expect([1, 23, 5].map((n) => moreFileCount('uk', n))).toEqual([
			'ще 1 файл',
			'ще 23 файли',
			'ще 5 файлів',
		]);
		expect([1, 2].map((n) => toolErrorCount('en', n))).toEqual(['1 error', '2 errors']);
		expect(moreFileCount('en', 3)).toBe('3 more files');
	});
});

describe('chipDirectory', () => {
	it('shortens the directory as the turn footer chip does', () => {
		expect(
			['kit/src/Button/Button.module.css', 'kit/index.ts', 'README.md'].map(chipDirectory)
		).toEqual(['kit/…/', 'kit/', '']);
	});
});

describe('MCP calls in the tools (spec/chat#mcp-calls)', () => {
	it('count under their action, not the raw mcp__ name', () => {
		const accept = call('a', 'mcp__brigadir__accept_part'),
			browser = call('b', 'mcp__brigadir__browser_snapshot'),
			foreign = call('c', 'mcp__linear__get_issue');
		const names = (locale: 'uk' | 'en') =>
			toolGroupSummary([accept, call('d', 'Bash'), accept, foreign], (tool) =>
				toolGroupName(locale, tool)
			).mix.map((item) => item.name);
		expect(names('en').some((name) => name.startsWith('mcp__'))).toBe(false);
		expect(names('en')).toContain('linear · Get issue');
		expect(toolGroupName('en', browser.tool)).not.toContain('mcp__');
		expect(toolGroupName('en', call('e', 'Bash').tool)).toBe('Bash');
	});
});

describe('a call a steer cut off (spec/chat#tool-states)', () => {
	it('is interrupted: neither an error of the group nor still running', () => {
		const summary = toolGroupSummary([
			call('a', 'Bash'),
			call('b', 'Bash', 'interrupted', {}, 0, 100),
		]);
		expect(summary.errors).toBe(0);
		expect(summary.running).toBe(false);
		expect(summary.pinned).toEqual([]);
	});
});
