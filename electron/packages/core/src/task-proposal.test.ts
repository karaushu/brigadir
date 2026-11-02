import { expect, it } from 'vitest';
import {
	isTaskProposal,
	isTaskProposalResult,
	isTaskAgentRequest,
	resolveTaskAgent,
	type AgentOption,
	pendingInputs,
	waitsForPerson,
	isSessionEvent,
	isSessionCommand,
	taskActivity,
	mcpRow,
	type EventRecord,
	type TaskProposal,
	type ToolPatch,
} from './index';
const proposal: TaskProposal = {
	id: 'p1',
	title: 'Backend API',
	prompt: 'Add the endpoint',
	context: [
		{ kind: 'summary' },
		{ kind: 'diff', full: true },
		{ kind: 'file', path: '/tmp/spec.md' },
		{ kind: 'text', name: 'Notes', text: 'Use v2' },
	],
	folders: ['/Users/a/backend'],
	start: 'now',
};
const record = (seq: number, event: EventRecord['event']): EventRecord => ({
	schemaVersion: 1,
	seq,
	at: '2026-10-07T12:00:00.000Z',
	event,
});
it('validates a proposal: same-project fields only, absolute paths, one summary and one diff (spec/tasks#agent-created-tasks)', () => {
	expect(isTaskProposal(proposal)).toBe(true);
	expect(isTaskProposal({ ...proposal, folders: ['backend'] })).toBe(false);
	expect(isTaskProposal({ ...proposal, context: [{ kind: 'summary' }, { kind: 'summary' }] })).toBe(
		false
	);
	expect(isTaskProposal({ ...proposal, prompt: '  ' })).toBe(false);
	expect(isTaskProposal({ ...proposal, title: 'x'.repeat(81) })).toBe(false);
	expect(
		isTaskProposal({
			...proposal,
			context: [{ kind: 'text', name: 'Big', text: 'я'.repeat(140_000) }],
		})
	).toBe(false);
	expect(isTaskProposalResult(null)).toBe(true);
	expect(isTaskProposalResult({ projectId: 'p', id: 't', title: 'x', extra: 1 })).toBe(false);
	expect(isSessionCommand({ kind: 'resolveTaskProposal', id: 'p1', task: null })).toBe(true);
	expect(isSessionEvent({ kind: 'task.proposal.requested', proposal })).toBe(true);
	expect(
		isSessionEvent({
			kind: 'task.proposal.resolved',
			id: 'p1',
			task: { projectId: 'a', id: 'b', title: 'c' },
		})
	).toBe(true);
});
it('keeps a proposal pending until it is resolved or the host stops, and the task waits for the person', () => {
	const requested = [record(1, { kind: 'task.proposal.requested', proposal })];
	expect(pendingInputs(requested).proposals).toEqual([proposal]);
	expect(waitsForPerson(pendingInputs(requested))).toBe(true);
	expect(
		pendingInputs([
			...requested,
			record(2, { kind: 'task.proposal.resolved', id: 'p1', task: null }),
		]).proposals
	).toEqual([]);
	expect(
		pendingInputs([...requested, record(2, { kind: 'host.stopped', reason: 'x' })]).proposals
	).toEqual([]);
	expect(taskActivity(requested)).toEqual({ kind: 'proposal', title: 'Backend API', path: null });
});
it('names the create_task row by the proposal and says how it ended', () => {
	const row = (state: 'running' | 'done', result?: unknown) =>
		mcpRow(
			'uk',
			{
				id: 'c',
				name: 'mcp__brigadir__create_task',
				title: 'mcp__brigadir__create_task',
				category: 'other',
				status: state === 'running' ? 'in_progress' : 'completed',
				input: JSON.stringify(proposal),
				...(result ? { content: [{ kind: 'text', text: JSON.stringify(result) }] } : {}),
			} as ToolPatch,
			state
		);
	expect(JSON.stringify(row('running'))).toContain('Backend API');
	expect(JSON.stringify(row('done', { created: false }))).toContain('Задачу не створено');
});

// spec/tasks#agent-created-tasks: the agent create_task names — checked against the provider's catalog, an unknown one fails with the list.
it('resolves the named agent by the catalog and fails with what is available (spec/tasks#agent-created-tasks)', () => {
	const select = (
		id: string,
		category: string,
		choices: [string, string][],
		value = choices[0]![0]
	): AgentOption => ({
		id,
		name: id,
		description: null,
		category,
		kind: 'select',
		value,
		choices: choices.map(([value, name]) => ({ value, name, description: null, group: null })),
	});
	const catalog = {
		options: [
			select('model', 'model', [
				['gpt-6', 'GPT-6'],
				['gpt-6-astra', '6 Astra'],
			]),
			select('reasoning_effort', 'thought_level', [
				['low', 'Low'],
				['medium', 'Medium'],
			]),
		],
		byModel: {
			'gpt-6-astra': [
				select(
					'model',
					'model',
					[
						['gpt-6', 'GPT-6'],
						['gpt-6-astra', '6 Astra'],
					],
					'gpt-6-astra'
				),
				select('reasoning_effort', 'thought_level', [
					['medium', 'Medium'],
					['high', 'High'],
				]),
			],
		},
	};
	expect(isTaskAgentRequest({ provider: 'codex', model: 'gpt-6-astra' })).toBe(true);
	expect(isTaskAgentRequest({ provider: 'gemini' })).toBe(false);
	expect(isTaskAgentRequest({ provider: 'codex', transport: 'terminal' })).toBe(false);
	expect(
		resolveTaskAgent({ provider: 'codex', model: '6 astra', effort: 'High' }, catalog)
	).toEqual({
		provider: 'codex',
		options: [
			{ id: 'model', value: 'gpt-6-astra' },
			{ id: 'reasoning_effort', value: 'high' },
		],
		modelName: '6 Astra',
		effortName: 'High',
	});
	// Only the provider: its defaults, no catalog needed.
	expect(resolveTaskAgent({ provider: 'claude' }, null)).toEqual({
		provider: 'claude',
		options: [],
		modelName: null,
		effortName: null,
	});
	expect(() => resolveTaskAgent({ provider: 'codex', model: 'gpt-5' }, catalog)).toThrow(
		'Available: gpt-6 (GPT-6), gpt-6-astra (6 Astra).'
	);
	// Effort levels are the chosen model's (spec/agents-and-providers#catalog): `high` exists only for Astra.
	expect(() =>
		resolveTaskAgent({ provider: 'codex', model: 'gpt-6', effort: 'high' }, catalog)
	).toThrow('for the model gpt-6');
	expect(() => resolveTaskAgent({ provider: 'codex', model: 'gpt-6' }, null)).toThrow(
		'not known yet'
	);
	const agent = resolveTaskAgent({ provider: 'codex', model: 'gpt-6-astra' }, catalog);
	expect(isTaskProposal({ ...proposal, agent })).toBe(true);
	expect(isTaskProposal({ ...proposal, agent: { ...agent, provider: 'gemini' } })).toBe(false);
	expect(isTaskProposal({ ...proposal, agent: { provider: 'codex', model: 'gpt-6-astra' } })).toBe(
		false
	);
});
