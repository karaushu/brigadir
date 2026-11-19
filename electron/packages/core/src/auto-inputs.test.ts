import { describe, expect, it } from 'vitest';
import {
	autoSpec,
	budgetLabel,
	builtinAgentTemplates,
	crewPalette,
	crewWorkerRows,
	hireSplitLabel,
	hireTitle,
	hireTotalLabel,
	hiredTitle,
	pendingInputs,
	refusalText,
	staysWithLabel,
	templateLookup,
	waitsForPerson,
	statusAfterTurn,
	type AgentTask,
	type AutoHire,
	type EventRecord,
	type SessionEvent,
} from './index';
const hire: AutoHire = {
	id: 'hire-1',
	summary: '',
	parts: [
		{
			id: 'p1',
			title: 'API endpoints',
			role: 'developer',
			roleName: 'Developer',
			prompt: 'Add the endpoints.',
			zone: ['apps/api/src/clients/**'],
			scopes: [],
			budget: { minutes: 40, tokens: 400_000 },
			estimate: { files: 3, lines: 200 },
		},
	],
};
const records = (...events: SessionEvent[]): EventRecord[] =>
	events.map((event, index) => ({
		schemaVersion: 1,
		seq: index + 1,
		at: '2026-11-13T10:00:00.000Z',
		event,
	}));
describe('pending inputs of an Auto task (spec/crew#auto-hire, spec/crew#auto-model)', () => {
	it('keeps the hire card across a host restart and drops it once decided', () => {
		const waiting = pendingInputs(
			records({ kind: 'crew.hire.requested', hire }, { kind: 'host.stopped', reason: 'shutdown' })
		);
		expect(waiting.crewHire?.id).toBe('hire-1');
		expect(waitsForPerson(waiting)).toBe(true);
		const decided = pendingInputs(
			records(
				{ kind: 'crew.hire.requested', hire },
				{ kind: 'crew.hire.resolved', id: 'hire-1', approved: false, parts: null, hired: [] }
			)
		);
		expect(decided.crewHire).toBeNull();
		expect(waitsForPerson(decided)).toBe(false);
	});
	it('a hire card that outlives the agent’s turn keeps the task needs-you', () => {
		// A message sent into the turn moved hire_workers to the background and the turn ended: the card still waits.
		const waiting = pendingInputs(
			records(
				{ kind: 'turn.started', text: 'Hire two workers.' },
				{ kind: 'crew.hire.requested', hire },
				{ kind: 'turn.completed', reason: 'end_turn' }
			)
		);
		expect(statusAfterTurn('end_turn', waiting, false)).toBe('needs-you');
		// The person's own Stop reads as interrupted, as for every other card.
		expect(statusAfterTurn('cancelled', waiting, false)).toBe('interrupted');
		const decided = pendingInputs(
			records(
				{ kind: 'crew.hire.requested', hire },
				{ kind: 'crew.hire.resolved', id: 'hire-1', approved: true, parts: null, hired: [] },
				{ kind: 'turn.completed', reason: 'end_turn' }
			)
		);
		expect(statusAfterTurn('end_turn', decided, false)).toBe('done');
		expect(statusAfterTurn('end_turn', decided, true)).toBe('needs-you');
	});
	it('drops a model question with the host: the agent asks again in its new session', () => {
		const request = { id: 'm1', reason: 'No role fits.', role: 'Developer' };
		expect(
			pendingInputs(records({ kind: 'crew.model.requested', request })).crewModels
		).toHaveLength(1);
		expect(
			pendingInputs(
				records({ kind: 'crew.model.requested', request }, { kind: 'host.stopped', reason: 'x' })
			).crewModels
		).toHaveLength(0);
		expect(
			pendingInputs(
				records(
					{ kind: 'crew.model.requested', request },
					{ kind: 'crew.model.resolved', id: 'm1', answer: null, by: 'person', role: 'Developer' }
				)
			).crewModels
		).toHaveLength(0);
	});
});
describe('hire card words (spec/chat-turns-plans-and-questions#hire-card)', () => {
	it('agrees the worker count with the noun in four Ukrainian forms (rule 9)', () => {
		expect(hireTitle('en', 'Claude', 1)).toBe('Claude wants to hire 1 worker');
		expect(hireTitle('en', 'Claude', 3)).toBe('Claude wants to hire 3 workers');
		expect(hireTitle('uk', 'Claude', 1)).toBe('Claude хоче найняти 1 воркера');
		expect(hireTitle('uk', 'Claude', 3)).toBe('Claude хоче найняти 3 воркерів');
		expect(hireTitle('uk', 'Claude', 5)).toBe('Claude хоче найняти 5 воркерів');
		expect(hiredTitle('uk', 2)).toBe('Найнято 2 воркерів');
		expect(hiredTitle('en', 1)).toBe('Hired 1 worker');
		expect(hireSplitLabel('en', 3, 3)).toBe('3 parts for 3 workers');
		expect(hireSplitLabel('uk', 4, 2)).toBe('4 частини для 2 воркерів');
	});
	it('words budgets with durations and the token counter', () => {
		expect(budgetLabel('en', { minutes: 40, tokens: 400_000 })).toBe('40 min · 400k');
		expect(budgetLabel('uk', { minutes: 40, tokens: 400_000 })).toBe('40 хв · 400k');
		expect(hireTotalLabel('en', { minutes: 110, tokens: 1_100_000 })).toBe('1h 50m · 1.1m tokens');
	});
	it('words the host’s refusals from their codes', () => {
		expect(
			refusalText('en', {
				code: 'overlap',
				message: '',
				path: 'packages/types/src/client.ts',
				part: 1,
			})
		).toBe('Not independent: part 1 writes packages/types/src/client.ts too.');
		expect(
			refusalText('uk', {
				code: 'overlap',
				message: '',
				path: 'src/a.ts',
				part: null,
				worker: 'Developer',
			})
		).toBe('Не незалежна: Developer уже пише в src/a.ts.');
		expect(refusalText('en', { code: 'small', message: '', lines: 12, files: 1 })).toBe(
			'Too small for a worker: about 12 lines in one file.'
		);
		expect(refusalText('uk', { code: 'small', message: '', lines: 12, files: 1 })).toBe(
			'Замала для воркера: близько 12 рядків в одному файлі.'
		);
		expect(refusalText('en', { code: 'small', message: '', lines: 30, files: 2 })).toBe(
			'Too small for a worker: about 30 lines in 2 files.'
		);
	});
	it('names the parts that stay with the agent', () => {
		expect(staysWithLabel('en', [3], 'Claude')).toBe('Part 3 stays with Claude.');
		expect(staysWithLabel('en', [3, 4], 'Claude')).toBe('Parts 3 and 4 stay with Claude.');
		expect(staysWithLabel('uk', [2, 3, 4], 'Codex')).toBe('Частини 2, 3 і 4 лишаються за Codex.');
	});
});
describe('worker rows of an Auto task (spec/sidebar#crew-card)', () => {
	const roles = crewPalette(
		builtinAgentTemplates,
		{ lookup: templateLookup(builtinAgentTemplates), defaultProvider: 'claude' },
		[]
	).templates;
	const developer = roles.find((role) => role.id === 'developer')!;
	const spec = autoSpec({ provider: 'claude' });
	spec.root.agents = [
		{ ...developer, id: 'w-1', name: 'Developer', template: 'developer', zone: ['a'] },
		{ ...developer, id: 'w-2', name: 'Developer 2', template: 'developer', zone: ['b'] },
	];
	const lead: AgentTask = {
		id: 'lead',
		projectId: 'p',
		title: 'Client details',
		status: 'working',
		provider: 'claude',
		crew: spec,
		auto: { roles, budget: { minutes: 40, tokens: 400_000 } },
	};
	const worker = (id: string, node: string, patch: Partial<AgentTask>): AgentTask => ({
		id,
		projectId: 'p',
		title: id,
		status: 'working',
		crewTaskId: 'lead',
		crewNodeId: node,
		parentTaskId: 'lead',
		...patch,
	});
	it('starts each row with the role and keeps a dismissed worker as a quiet row', () => {
		const rows = crewWorkerRows(lead, [
			lead,
			worker('API endpoints', 'w-1', {
				status: 'completed',
				changeSummary: { additions: 148, deletions: 6 },
			}),
			worker('Details screen', 'w-2', { overBudget: true, status: 'needs-you' }),
		]);
		expect(rows.map((row) => [row.name, row.task.title, row.dismissed])).toEqual([
			['Developer', 'API endpoints', true],
			['Developer', 'Details screen', false],
		]);
	});
	it('leaves a named crew’s accepted worker as it was', () => {
		const { auto: _auto, ...named } = lead;
		const rows = crewWorkerRows(named, [
			named,
			worker('API endpoints', 'w-1', { status: 'completed' }),
		]);
		expect(rows[0]).toMatchObject({ name: 'Developer', dismissed: false });
	});
});
