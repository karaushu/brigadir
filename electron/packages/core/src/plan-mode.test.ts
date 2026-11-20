import { describe, expect, it } from 'vitest';
import type { AgentOption, PermissionRequest } from './agent';
import type { EventRecord, SessionEvent } from './session';
import {
	planAskDue,
	planModeChoice,
	planModeDeclined,
	planModeDue,
	planModeReturn,
	planOwed,
} from './plan-mode';

const journal = (events: SessionEvent[]): EventRecord[] =>
	events.map((event, index) => ({ schemaVersion: 1, seq: index + 1, at: '', event }));
const select = (
	id: string,
	category: string | null,
	value: string,
	choices: [string, string][]
): AgentOption => ({
	id,
	name: id === 'collaboration_mode' ? 'Collaboration mode' : 'Mode',
	description: null,
	category,
	kind: 'select',
	value,
	choices: choices.map(([v, name]) => ({ value: v, name, description: null, group: null })),
});
// codex-acp: the session mode has no plan; `Collaboration mode` has.
const codex = (collaboration = 'default') => [
	select('mode', 'mode', 'agent', [
		['read-only', 'Ask for approval'],
		['agent', 'Approve for me'],
	]),
	select('collaboration_mode', 'collaboration_mode', collaboration, [
		['default', 'Default'],
		['plan', 'Plan'],
	]),
];
// claude-agent-acp: plan is a value of the `mode` option.
const claude = (mode = 'auto') => [
	select('mode', 'mode', mode, [
		['default', 'Manual'],
		['plan', 'Plan'],
		['auto', 'Auto'],
	]),
];
const started = (options: AgentOption[]): SessionEvent => ({
	kind: 'session.started',
	sessionId: 's',
	modes: [],
	modeId: null,
	options,
});
const classed = (
	value: 'small' | 'medium' | 'large',
	by: 'agent' | 'host' = 'agent'
): SessionEvent => ({
	kind: 'task.class',
	class: value,
	reason: by === 'agent' ? 'why' : '',
	by,
	...(by === 'host' ? { cause: 'threshold' as const } : {}),
});
const plan: PermissionRequest = {
	id: 'p1',
	tool: {
		id: 'plan-review:plan-1',
		title: 'Implement this plan?',
		category: 'switch_mode',
		status: 'pending',
	} as PermissionRequest['tool'],
	options: [
		{ id: 'implement_plan', name: 'Yes, implement this plan', kind: 'allow_once' },
		{ id: 'revise_plan', name: 'No', kind: 'reject_once' },
	],
};
const presented: SessionEvent = { kind: 'permission.requested', request: plan };
const approved: SessionEvent = {
	kind: 'permission.resolved',
	id: 'p1',
	optionId: 'implement_plan',
};
const revised: SessionEvent = { kind: 'permission.resolved', id: 'p1', optionId: 'revise_plan' };
const hostOn = (previous = 'default'): SessionEvent => ({
	kind: 'plan.mode',
	on: true,
	by: 'host',
	class: 'medium',
	option: 'collaboration_mode',
	name: 'Collaboration mode',
	value: 'plan',
	valueName: 'Plan',
	previous,
	previousName: 'Default',
});

describe('plan mode by the host (spec/reviews#plan-mode)', () => {
	it('finds the plan mode in the catalog: the mode option, another option, a legacy mode, or none', () => {
		expect(planModeChoice(journal([started(claude())]))).toMatchObject({
			option: 'mode',
			value: 'plan',
			current: 'auto',
			currentName: 'Auto',
		});
		expect(planModeChoice(journal([started(codex())]))).toMatchObject({
			option: 'collaboration_mode',
			name: 'Collaboration mode',
			value: 'plan',
			valueName: 'Plan',
			current: 'default',
		});
		expect(
			planModeChoice(
				journal([
					{
						kind: 'session.started',
						sessionId: 's',
						modes: [
							{ id: 'ask', name: 'Ask', description: null },
							{ id: 'architect', name: 'Plan', description: null },
						],
						modeId: 'ask',
						options: [],
					},
					{ kind: 'mode.changed', modeId: 'architect' },
				])
			)
		).toMatchObject({ option: null, value: 'architect', current: 'architect' });
		// No plan choice: no switch, the class asks for the plan in the reply.
		expect(
			planModeChoice(journal([started([select('model', 'model', 'a', [['a', 'plan']])])]))
		).toBeNull();
		// The newest catalog decides.
		expect(
			planModeChoice(
				journal([started(codex()), { kind: 'options.changed', options: codex('plan') }])
			)?.current
		).toBe('plan');
	});
	it('a plan is owed from the agent’s Medium or Large until a plan is approved; host raises and Small owe none', () => {
		expect(planOwed(journal([started(codex()), classed('medium')]))).toEqual({
			since: 2,
			class: 'medium',
		});
		// Raised to Large later: the same plan, now for a Large task.
		expect(planOwed(journal([started(codex()), classed('medium'), classed('large')]))).toEqual({
			since: 2,
			class: 'large',
		});
		// The tripwire's raise and a hire's raise owe no plan.
		expect(
			planOwed(journal([started(codex()), classed('small'), classed('medium', 'host')]))
		).toBeNull();
		expect(
			planOwed(
				journal([
					started(codex()),
					{ kind: 'task.class', class: 'large', reason: '', by: 'host', cause: 'hire' },
				])
			)
		).toBeNull();
		// An approval settles it, a rejection does not; Small clears it.
		expect(
			planOwed(journal([started(codex()), classed('medium'), presented, revised]))
		).not.toBeNull();
		expect(
			planOwed(journal([started(codex()), classed('medium'), presented, approved]))
		).toBeNull();
		expect(
			planOwed(
				journal([started(codex()), classed('medium'), presented, approved, classed('large')])
			)
		).toBeNull();
		expect(planOwed(journal([started(codex()), classed('medium'), classed('small')]))).toBeNull();
		// A plan approved before the class settles it; after Small a new Medium owes a new one.
		expect(
			planOwed(journal([started(codex()), presented, approved, classed('medium')]))
		).toBeNull();
		expect(
			planOwed(
				journal([started(codex()), presented, approved, classed('small'), classed('medium')])
			)
		).toEqual({ since: 5, class: 'medium' });
	});
	it('switches before a turn while the plan is owed, unless the session is in it or the person moved it off', () => {
		const owed = [started(codex()), classed('medium')];
		expect(planModeDue(journal(owed))).toMatchObject({
			option: 'collaboration_mode',
			value: 'plan',
			current: 'default',
			class: 'medium',
		});
		expect(
			planModeDue(journal([...owed, { kind: 'options.changed', options: codex('plan') }]))
		).toBeNull();
		// The person's own change after the host's switch is kept…
		const switched = [
			...owed,
			hostOn(),
			{ kind: 'options.changed', options: codex('plan') } as SessionEvent,
		];
		const off = planModeDeclined(journal(switched), {
			kind: 'setOption',
			id: 'collaboration_mode',
			value: 'default',
		});
		expect(off).toEqual({
			kind: 'plan.mode',
			on: false,
			by: 'person',
			class: 'medium',
			option: 'collaboration_mode',
			name: 'Collaboration mode',
			value: 'default',
			valueName: 'Default',
		});
		expect(
			planModeDue(journal([...switched, off!, { kind: 'options.changed', options: codex() }]))
		).toBeNull();
		// …another option, or a change before any switch of the host, is not a refusal.
		expect(
			planModeDeclined(journal(switched), { kind: 'setOption', id: 'mode', value: 'read-only' })
		).toBeNull();
		expect(
			planModeDeclined(journal(owed), {
				kind: 'setOption',
				id: 'collaboration_mode',
				value: 'default',
			})
		).toBeNull();
		// A restart that opened the session without its plan mode: switched again.
		expect(planModeDue(journal([...switched, presented, started(codex())]))).toMatchObject({
			value: 'plan',
		});
		// No plan mode in the catalog: nothing.
		expect(planModeDue(journal([started([]), classed('medium')]))).toBeNull();
	});
	it('asks once at a turn end, while no plan was presented since the plan became owed', () => {
		const owed = [started(codex()), classed('large')];
		expect(planAskDue(journal(owed))).toEqual({ since: 2, class: 'large' });
		expect(planAskDue(journal([...owed, presented]))).toBeNull();
		expect(
			planAskDue(
				journal([
					...owed,
					{
						kind: 'prompt.queued',
						prompt: {
							id: 'q',
							command: { kind: 'prompt', text: 'ask', crew: { kind: 'plan-ask' } },
							attachments: [],
						},
					},
				])
			)
		).toBeNull();
		expect(planAskDue(journal([started([]), classed('medium')]))).toBeNull();
	});
	it('brings back the mode from before the switch when the approval turn ends in the plan choice', () => {
		const base = [
			started(codex()),
			classed('medium'),
			hostOn(),
			{ kind: 'options.changed', options: codex('plan') } as SessionEvent,
			{ kind: 'turn.started', text: 'ask', crew: { kind: 'plan-ask' } } as SessionEvent,
			presented,
		];
		// The agent stayed in plan mode after the approval: back to Default.
		expect(planModeReturn(journal([...base, approved]))).toMatchObject({
			option: 'collaboration_mode',
			previous: 'default',
			previousName: 'Default',
			class: 'medium',
		});
		// codex-acp leaves the plan itself on `implement_plan`.
		expect(
			planModeReturn(journal([...base, approved, { kind: 'options.changed', options: codex() }]))
		).toBeNull();
		// No approval in this turn, or a rejection: it stays.
		expect(planModeReturn(journal([...base, revised]))).toBeNull();
		expect(
			planModeReturn(
				journal([...base, approved, { kind: 'turn.started', text: 'next' } as SessionEvent])
			)
		).toBeNull();
	});
});
