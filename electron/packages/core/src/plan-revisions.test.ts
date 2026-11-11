import { expect, it } from 'vitest';
import type { PermissionRequest } from './agent';
import type { EventRecord, SessionEvent } from './session';
import { planEditsPrompt, planFeedbackPrompt } from './plan-approval';
import {
	planPromptEdits,
	planRevisionBase,
	planSectionsLabel,
	planUnchangedLabel,
} from './plan-revisions';

const at = '2026-11-11T10:00:00.000Z';
const plan = (id: string, text: string): PermissionRequest => ({
	id,
	tool: {
		id: `t-${id}`,
		title: 'Approve Plan',
		category: 'switch_mode',
		content: [{ kind: 'text', text }],
	},
	options: [
		{ id: 'yes', name: 'Yes', kind: 'allow_once' },
		{ id: 'no', name: 'No, keep planning', kind: 'reject_once' },
	],
});
const journal = (events: SessionEvent[]) =>
	events.map((event, index) => ({ seq: index + 1, at, event })) as EventRecord[];

it('numbers revisions and compares each with the one before (spec/chat-turns-plans-and-questions#plan-revisions)', () => {
	const records = journal([
		{ kind: 'permission.requested', request: plan('a', '# Plan\n\n1. One') },
		{ kind: 'permission.resolved', id: 'a', optionId: 'no' },
		{ kind: 'turn.started', text: planFeedbackPrompt('Add a step') },
		{ kind: 'permission.requested', request: plan('b', '# Plan\n\n1. One\n2. Two') },
	] as SessionEvent[]);
	expect(planRevisionBase(records, 1)).toEqual({ revision: 1, base: null });
	expect(planRevisionBase(records, 4)).toEqual({
		revision: 2,
		base: { text: '# Plan\n\n1. One', revision: 1, edited: false },
	});
});

it('takes the person’s edits as the base when they sent edits', () => {
	const records = journal([
		{ kind: 'permission.requested', request: plan('a', '# Plan\n\n1. One') },
		{ kind: 'permission.resolved', id: 'a', optionId: 'no' },
		{ kind: 'turn.started', text: planEditsPrompt('# Plan\n\n1. One, edited\n') },
		{ kind: 'permission.requested', request: plan('b', '# Plan\n\n1. One, edited\n2. Two') },
	] as SessionEvent[]);
	expect(planRevisionBase(records, 4).base).toEqual({
		text: '# Plan\n\n1. One, edited',
		revision: 1,
		edited: true,
	});
	expect(planPromptEdits(planFeedbackPrompt('x'))).toBeNull();
});

it('skips a switch_mode request without text', () => {
	const empty: PermissionRequest = {
		...plan('e', ''),
		tool: { id: 'x', title: 'Mode', category: 'switch_mode' },
	};
	const records = journal([
		{ kind: 'permission.requested', request: empty },
		{ kind: 'permission.requested', request: plan('a', '# Plan') },
	] as SessionEvent[]);
	expect(planRevisionBase(records, 2)).toEqual({ revision: 1, base: null });
});

it('has four Ukrainian forms for sections and unchanged lines (rule 9)', () => {
	expect([1, 3, 5, 1.5].map((n) => planSectionsLabel('uk', n))).toEqual([
		'1 розділ',
		'3 розділи',
		'5 розділів',
		'1,5 розділу',
	]);
	expect([1, 2, 11].map((n) => planUnchangedLabel('uk', n))).toEqual([
		'1 незмінений рядок',
		'2 незмінені рядки',
		'11 незмінених рядків',
	]);
	expect(planSectionsLabel('en', 1)).toBe('1 section');
	expect(planUnchangedLabel('en', 4)).toBe('4 unchanged lines');
});
