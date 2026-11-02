import { expect, it } from 'vitest';
import {
	conflictProgress,
	conflictRowState,
	historyCommitMatches,
	historyQuery,
	isHistoryQuery,
} from './git-history';

it('derives each Conflicts row and counts an agent result as resolved only after Accept (spec/appearance#evolution-redesign)', () => {
	const file = { path: 'a.ts', places: 2, resolved: false, byAgent: false };
	expect(conflictRowState(file)).toBe('open');
	expect(conflictRowState({ ...file, deleted: 'theirs' })).toBe('deleted');
	expect(conflictRowState({ ...file, byAgent: true, agent: 'running' })).toBe('running');
	expect(conflictRowState({ ...file, byAgent: true, agent: 'failed' })).toBe('failed');
	expect(conflictRowState({ ...file, places: 0, byAgent: true })).toBe('review');
	expect(conflictRowState({ ...file, places: 0, resolved: true, resolution: 'yours' })).toBe(
		'resolved'
	);
	const conflicts = [
		{ ...file, places: 0, resolved: true, resolution: 'yours' as const },
		{ ...file, places: 0, byAgent: true, agent: 'review' as const },
		{ ...file, places: 0, resolved: true, resolution: 'kept' as const, deleted: 'theirs' as const },
	];
	expect(conflictProgress({ agentRunning: false, conflicts })).toEqual({
		total: 3,
		resolved: 2,
		review: 1,
		running: 0,
		canContinue: false,
	});
	// Accept: the agent's file is resolved and Continue opens; a running agent keeps it closed.
	const accepted = conflicts.map((item, index) =>
		index === 1 ? { ...item, resolved: true, resolution: 'merged' as const } : item
	);
	expect(conflictProgress({ agentRunning: false, conflicts: accepted }).canContinue).toBe(true);
	expect(conflictProgress({ agentRunning: true, conflicts: accepted }).canContinue).toBe(false);
});

it('sends the History search as one trimmed line that main accepts (spec/git#history-search)', () => {
	expect(historyQuery('  fix\tparser\n ')).toBe('fix parser');
	expect(historyQuery('   ')).toBe('');
	expect(historyQuery(`${'a'.repeat(199)} b`)).toBe('a'.repeat(199));
	for (const text of ['fix parser', '[a.*', '-x', 'a'.repeat(200)])
		expect(isHistoryQuery(historyQuery(text))).toBe(true);
	for (const value of ['', ' a', 'a ', 'a\nb', 'a'.repeat(201), 1, null])
		expect(isHistoryQuery(value)).toBe(false);
});

it('narrows the rows on screen by subject, author or SHA prefix while git searches (spec/git#history-search)', () => {
	const commit = { sha: 'abc1234'.padEnd(40, '0'), subject: 'Fix the Parser', author: 'Olena' };
	expect(historyCommitMatches(commit, 'parser')).toBe(true);
	expect(historyCommitMatches(commit, 'OLENA')).toBe(true);
	expect(historyCommitMatches(commit, 'abc12')).toBe(true);
	expect(historyCommitMatches(commit, '1234')).toBe(false);
	expect(historyCommitMatches(commit, '')).toBe(true);
});
