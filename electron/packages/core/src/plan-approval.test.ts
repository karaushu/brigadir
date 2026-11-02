import { expect, it } from 'vitest';
import type { PermissionRequest } from './agent';
import type { EventRecord } from './session';
import {
	checklistPlan,
	planApproveChoice,
	planApprovedMode,
	planPriorMode,
	sessionModeName,
	planPromptFeedback,
	isPlanApproval,
	planAllowOptions,
	planApprovalText,
	planApproveOption,
	planEditsPrompt,
	planFeedbackPrompt,
	planLineCount,
	planRejectOption,
	planSlug,
	planTitle,
	samePlanText,
} from './plan-approval';

const claude: PermissionRequest = {
	id: 'r1',
	tool: {
		id: 't1',
		title: 'Approve Plan',
		category: 'switch_mode',
		content: [{ kind: 'text', text: '# Keep the ring\n\n1. Fix it' }],
	},
	options: [
		{ id: 'exit-plan-default', name: 'Yes, manually approve edits', kind: 'allow_once' },
		{ id: 'exit-plan-auto', name: 'Yes, and use auto mode', kind: 'allow_always' },
		{ id: 'reject', name: 'No, keep planning', kind: 'reject_once' },
	],
};
const codex: PermissionRequest = {
	id: 'r2',
	tool: { id: 'plan-review:i1', title: 'Implement this plan?', category: 'switch_mode' },
	options: [
		{ id: 'implement', name: 'Yes, implement this plan', kind: 'allow_once' },
		{ id: 'revise', name: 'No, and tell Codex what to do differently', kind: 'reject_once' },
	],
};
const at = '2026-10-01T10:00:00.000Z';
const records: EventRecord[] = [
	{ seq: 1, at, event: { kind: 'plan.document', planId: 'old', text: '# Old' } },
	{ seq: 2, at, event: { kind: 'plan.document', planId: 'i1', text: '# Draft' } },
	{ seq: 3, at, event: { kind: 'plan.document', planId: 'i1', text: '# Codex plan\n\n- step' } },
	{ seq: 5, at, event: { kind: 'plan.document', planId: 'late', text: '# After' } },
] as EventRecord[];

it('recognises a switch_mode permission as the plan for approval (spec/chat-turns-plans-and-questions#plan-approval)', () => {
	expect(isPlanApproval(claude)).toBe(true);
	expect(isPlanApproval(codex)).toBe(true);
	expect(isPlanApproval({ ...claude, tool: { id: 't', title: 'Write', category: 'edit' } })).toBe(
		false
	);
});
it('takes the plan from the tool content, else the last plan document before the request', () => {
	expect(planApprovalText(claude, records, 4)).toBe('# Keep the ring\n\n1. Fix it');
	expect(planApprovalText(codex, records, 4)).toBe('# Codex plan\n\n- step');
	expect(
		planApprovalText(
			codex,
			[
				...records.slice(0, 3),
				{ seq: 4, at, event: { kind: 'plan.removed', planId: 'i1' } } as EventRecord,
			],
			5
		)
	).toBe('# Old');
	expect(planApprovalText(codex, [], 4)).toBeNull();
});
it('approves with allow_once, lists every allow option and rejects with reject_*', () => {
	expect(planApproveOption(claude)?.id).toBe('exit-plan-default');
	expect(planAllowOptions(claude).map((option) => option.id)).toEqual([
		'exit-plan-default',
		'exit-plan-auto',
	]);
	expect(planRejectOption(claude)?.id).toBe('reject');
	expect(planRejectOption(codex)?.id).toBe('revise');
	expect(
		planApproveOption({ ...claude, options: [{ id: 'a', name: 'A', kind: 'allow_always' }] })?.id
	).toBe('a');
});
it('writes English prompts with the person’s text', () => {
	expect(planFeedbackPrompt('  Keep Firefox as is. ')).toBe(
		'I did not approve the plan. Change it as follows, then present the revised plan for approval again:\n\nKeep Firefox as is.'
	);
	expect(planEditsPrompt('# Plan\n')).toContain('I edited your plan.');
	expect(planEditsPrompt('# Plan\n').endsWith('# Plan')).toBe(true);
});
it('names the plan by its first heading and counts lines; whitespace at the end is not an edit', () => {
	expect(planTitle('Intro\n\n## Keep the **ring** in Safari\n')).toBe('Keep the ring in Safari');
	expect(planSlug('# Keep the ring in Safari!')).toBe('keep-the-ring-in-safari');
	expect(planSlug('# План українською')).toBe('plan');
	expect(planLineCount('a\nb\n\n')).toBe(2);
	expect(samePlanText('a\r\nb\n', 'a\nb')).toBe(true);
	expect(samePlanText('a', 'b')).toBe(false);
});
it('reads the person’s words back from a feedback prompt only', () => {
	expect(planPromptFeedback(planFeedbackPrompt('Keep Firefox.'))).toBe('Keep Firefox.');
	expect(planPromptFeedback(planEditsPrompt('# Plan'))).toBeNull();
	expect(planPromptFeedback('hello')).toBeNull();
});

// spec/chat-turns-plans-and-questions#plan-approval: the modes and ExitPlanMode options of claude-agent-acp 0.86.0, the collaboration plan of Codex.
const claudeModes = [
	{ id: 'default', name: 'Manual', description: null },
	{ id: 'acceptEdits', name: 'Accept edits', description: null },
	{ id: 'plan', name: 'Plan', description: null },
	{ id: 'auto', name: 'Auto', description: null },
	{ id: 'bypassPermissions', name: 'Bypass permissions', description: null },
];
const modeOption = (value: string) => ({
	id: 'mode',
	name: 'Mode',
	description: null,
	category: 'mode',
	kind: 'select' as const,
	value,
	choices: claudeModes.map((mode) => ({
		value: mode.id,
		name: mode.name,
		description: null,
		group: null,
	})),
});
const exitPlan = (options: [string, string, string][]): PermissionRequest => ({
	id: 'r3',
	tool: {
		id: 't3',
		title: 'Approve Plan',
		category: 'switch_mode',
		content: [{ kind: 'text', text: '# Plan' }],
	},
	options: [
		...options.map(([id, name, kind]) => ({ id, name, kind })),
		{ id: 'reject', name: 'No, keep planning', kind: 'reject_once' },
	],
});
const withAuto = exitPlan([
	['exit-plan-clear-auto', 'Yes, clear context (12% used) and use auto mode', 'allow_always'],
	['exit-plan-auto', 'Yes, and use auto mode', 'allow_always'],
	['exit-plan-bypass', 'Yes, and bypass permissions', 'allow_always'],
	['exit-plan-default', 'Yes, manually approve edits', 'allow_once'],
]);
const withoutAuto = exitPlan([
	['exit-plan-clear-accept-edits', 'Yes, clear context and auto-accept edits', 'allow_always'],
	['exit-plan-accept-edits', 'Yes, auto-accept edits', 'allow_always'],
	['exit-plan-default', 'Yes, manually approve edits', 'allow_once'],
]);
const journal = (...events: unknown[]) =>
	events.map((event, index) => ({ seq: index + 1, at, event })) as EventRecord[];
const started = (modeId: string) => ({
	kind: 'session.started',
	sessionId: 's',
	modes: claudeModes,
	modeId,
	options: [modeOption(modeId)],
});

it('finds the mode before the plan through mode.changed or the mode option, and none without a change (spec/chat-turns-plans-and-questions#plan-approval)', () => {
	expect(
		planPriorMode(
			journal(
				started('auto'),
				{ kind: 'mode.changed', modeId: 'plan' },
				{ kind: 'options.changed', options: [modeOption('plan')] }
			),
			10
		)
	).toBe('auto');
	expect(
		planPriorMode(
			journal(
				started('default'),
				{ kind: 'options.changed', options: [modeOption('acceptEdits')] },
				{ kind: 'options.changed', options: [modeOption('plan')] }
			),
			10
		)
	).toBe('acceptEdits');
	expect(planPriorMode(journal(started('plan')), 10)).toBeNull();
	expect(
		planPriorMode(
			journal(
				started('auto'),
				{ kind: 'mode.changed', modeId: 'plan' },
				{ kind: 'mode.changed', modeId: 'auto' }
			),
			3
		)
	).toBe('auto');
	expect(sessionModeName(journal(started('auto')), 'acceptEdits')).toBe('Accept edits');
	expect(
		sessionModeName(
			journal({ kind: 'options.changed', options: [modeOption('auto')] }),
			'bypassPermissions'
		)
	).toBe('Bypass permissions');
});
it('approves with the agent option of the mode before the plan, the smallest one (spec/chat-turns-plans-and-questions#plan-approval)', () => {
	const from = (mode: string) => journal(started(mode), { kind: 'mode.changed', modeId: 'plan' });
	expect(planApproveChoice(withAuto, from('auto'), 10)).toEqual({
		option: withAuto.options[1],
		returnMode: null,
	});
	expect(planApproveChoice(withAuto, from('default'), 10)).toEqual({
		option: withAuto.options[3],
		returnMode: null,
	});
	expect(planApproveChoice(withAuto, from('bypassPermissions'), 10)).toEqual({
		option: withAuto.options[2],
		returnMode: null,
	});
	expect(planApproveChoice(withoutAuto, from('acceptEdits'), 10)).toEqual({
		option: withoutAuto.options[1],
		returnMode: null,
	});
});
it('falls back to allow_once with returnMode when no single option fits, and keeps allow_once without a prior mode (spec/chat-turns-plans-and-questions#plan-approval)', () => {
	const from = (mode: string) => journal(started(mode), { kind: 'mode.changed', modeId: 'plan' });
	expect(planApproveChoice(withAuto, from('acceptEdits'), 10)).toEqual({
		option: withAuto.options[3],
		returnMode: 'acceptEdits',
	});
	const twins = exitPlan([
		['auto-a', 'Yes, auto', 'allow_always'],
		['auto-b', 'Yes, auto', 'allow_always'],
		['once', 'Yes', 'allow_once'],
	]);
	expect(planApproveChoice(twins, from('auto'), 10)).toEqual({
		option: twins.options[2],
		returnMode: 'auto',
	});
	expect(planApproveChoice(withAuto, journal(started('plan')), 10)).toEqual({
		option: withAuto.options[3],
		returnMode: null,
	});
	expect(planApproveChoice(claude, [], 10)).toEqual({
		option: claude.options[0],
		returnMode: null,
	});
	const codexModes = [
		{ id: 'read-only', name: 'Read-only', description: null },
		{ id: 'agent', name: 'Auto review', description: null },
	];
	const codexJournal = journal(
		{
			kind: 'session.started',
			sessionId: 's',
			modes: codexModes,
			modeId: 'read-only',
			options: [],
		},
		{ kind: 'mode.changed', modeId: 'agent' }
	);
	expect(planApproveChoice(codex, codexJournal, 10)).toEqual({
		option: codex.options[0],
		returnMode: 'read-only',
	});
	expect(
		planApproveChoice(
			codex,
			journal({
				kind: 'session.started',
				sessionId: 's',
				modes: codexModes,
				modeId: 'agent',
				options: [],
			}),
			10
		)
	).toEqual({ option: codex.options[0], returnMode: null });
});
it('names the mode after the approval: returnMode once reached, else the first after the plan, within the turn (spec/chat-turns-plans-and-questions#plan-approval)', () => {
	const base = [
		started('auto'),
		{ kind: 'mode.changed', modeId: 'plan' },
		{ kind: 'permission.requested', request: withAuto },
	];
	expect(
		planApprovedMode(
			journal(
				...base,
				{ kind: 'permission.resolved', id: 'r3', optionId: 'exit-plan-auto' },
				{ kind: 'mode.changed', modeId: 'auto' },
				{ kind: 'options.changed', options: [modeOption('auto')] }
			),
			3
		)
	).toBe('auto');
	expect(
		planApprovedMode(
			journal(
				...base,
				{
					kind: 'permission.resolved',
					id: 'r3',
					optionId: 'exit-plan-default',
					returnMode: 'acceptEdits',
				},
				{ kind: 'mode.changed', modeId: 'default' },
				{ kind: 'mode.changed', modeId: 'acceptEdits' }
			),
			3
		)
	).toBe('acceptEdits');
	expect(
		planApprovedMode(
			journal(
				...base,
				{
					kind: 'permission.resolved',
					id: 'r3',
					optionId: 'exit-plan-default',
					returnMode: 'acceptEdits',
				},
				{ kind: 'mode.changed', modeId: 'default' }
			),
			3
		)
	).toBe('default');
	expect(
		planApprovedMode(
			journal(
				...base,
				{ kind: 'permission.resolved', id: 'r3', optionId: 'exit-plan-auto' },
				{ kind: 'turn.completed', reason: 'end_turn' },
				{ kind: 'mode.changed', modeId: 'default' }
			),
			3
		)
	).toBeNull();
	expect(
		planApprovedMode(
			journal(
				...base,
				{ kind: 'permission.resolved', id: 'r3', optionId: 'exit-plan-auto' },
				{ kind: 'mode.changed', modeId: 'auto' },
				{ kind: 'mode.changed', modeId: 'plan' }
			),
			3
		)
	).toBe('auto');
});
it('finds the plan behind the checklist: the last plan for approval, else the last plan document (spec/chat-turns-plans-and-questions#plan-row)', () => {
	const steps = {
		seq: 9,
		at,
		event: { kind: 'plan.changed', entries: [] },
	} as unknown as EventRecord;
	const withClaude = [
		...records,
		{ seq: 6, at, event: { kind: 'permission.requested', request: claude } },
		steps,
	] as EventRecord[];
	expect(checklistPlan(withClaude, 9)).toBe('# Keep the ring\n\n1. Fix it');
	expect(checklistPlan([...records, steps], 9)).toBe('# After');
	expect(checklistPlan([steps], 9)).toBeNull();
});
