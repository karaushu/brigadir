import { expect, test } from 'vitest';
import {
	knowledgeTokens,
	knowledgeMatch,
	knowledgeClusters,
	mineKnowledge,
	knowledgePrompt,
	type KnowledgeExchange,
} from './knowledge';
const pair = (
	taskId: string,
	question = 'How should we run the tests?',
	questionId = 'q'
): KnowledgeExchange => ({ taskId, questionId, turn: 1, seq: 2, question, answer: 'pnpm test' });
test('normalizes questions, needs two shared tokens and two distinct tasks', () => {
	expect(knowledgeTokens('running tests')).toEqual(['run', 'test']);
	expect(knowledgeMatch(['run', 'test'], ['test', 'command'])).toBe(false);
	expect(knowledgeClusters([pair('a'), pair('a', undefined, 'q2')])).toEqual([]);
	expect(knowledgeClusters([pair('a'), pair('b', 'Which command runs tests?')])).toHaveLength(1);
});
test('daily discovery cap, permanent rejection, and explicit restoration bypass', () => {
	const exchanges = [
			pair('a'),
			pair('b'),
			pair('a', 'Where is payment config?', 'p'),
			pair('b', 'Which payment config?', 'p'),
		],
		date = new Date('2026-09-21T10:00:00Z');
	let result = mineKnowledge({ exchanges, proposals: [], restored: [], lastDay: null }, date);
	expect(result.proposals).toHaveLength(1);
	const rejected = { ...result.proposals[0]!, state: 'rejected' as const };
	result = mineKnowledge(
		{ exchanges, proposals: [rejected], restored: [], lastDay: result.lastDay },
		date
	);
	expect(result.proposals).toEqual([rejected]);
	result = mineKnowledge(
		{ exchanges, proposals: [], restored: [rejected.signature], lastDay: result.lastDay },
		date
	);
	expect(result.proposals[0]?.state).toBe('proposed');
	expect(result.proposals).toHaveLength(1);
	result = mineKnowledge({ exchanges, ...result }, new Date('2026-09-22T00:00:00Z'));
	expect(result.proposals).toHaveLength(2);
	expect(knowledgePrompt(exchanges, 'x'.repeat(50000)).length).toBeLessThan(18000);
});
