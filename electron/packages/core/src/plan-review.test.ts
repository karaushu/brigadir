import { describe, expect, it } from 'vitest';
import { isSessionEvent } from './event-validation';
import {
	isTaskReviewDocument,
	openPlanFindings,
	parsePlanVerdict,
	planFindingList,
	planFindingState,
	readTaskReviewDocument,
	reviewLoop,
	splitPlanMarkdown,
	type PlanFinding,
} from './task-review';
import { checkSource, sourceSlug, type TaskSourceEntry } from './task-sources';
import { isAppSettings, defaultAppSettings } from './settings';
import type { CrewSpecAgent } from './crew';

const finding = (patch: Partial<PlanFinding> = {}): PlanFinding => ({
	id: 'p1',
	kind: 'missed',
	text: 'Edit is missing',
	reviewer: 'Codex',
	round: 1,
	...patch,
});

describe('the verdict of a plan review (spec/reviews#plan-verdict)', () => {
	it('takes findings and gaps in a first read, at most 12 in all, and sorts them into three lists', () => {
		const verdict = parsePlanVerdict(
			{
				findings: [
					{
						kind: 'contradicts',
						text: 'The plan caches, the contract says no-store',
						where: 'api-contract.yaml:88',
					},
					{ kind: 'unverifiable', text: '"Works offline" has no check' },
				],
				gaps: [{ text: 'No empty state', where: 'CRM-412 · Orders' }],
			},
			false
		);
		expect(verdict.items.map((item) => [item.kind, planFindingList(item.kind)])).toEqual([
			['contradicts', 'ticket'],
			['unverifiable', 'code'],
			['gap', 'gap'],
		]);
		const many = Array.from({ length: 13 }, () => ({ kind: 'missed', text: 'x' }));
		expect(() => parsePlanVerdict({ findings: many }, false)).toThrow('At most 12 items in all');
		expect(() => parsePlanVerdict({}, false)).toThrow('or call approve');
		expect(() => parsePlanVerdict({ findings: [{ kind: 'gap', text: 'x' }] }, false)).toThrow(
			'a gap in the ticket goes into gaps'
		);
		expect(() => parsePlanVerdict({ findings: [{ replyTo: 'p1', text: 'x' }] }, false)).toThrow(
			'replyTo is for a closure check'
		);
		expect(() =>
			parsePlanVerdict({ findings: [{ kind: 'missed', text: 'x'.repeat(2001) }] }, false)
		).toThrow('at most 2000 characters');
	});

	it('takes only replyTo of its own findings and introduced problems in a closure check', () => {
		const own = [finding()];
		expect(
			parsePlanVerdict(
				{
					findings: [
						{ replyTo: 'p1', text: 'Still read only' },
						{ kind: 'left-open', text: 'The new delete has no undo', introduced: true },
					],
				},
				true,
				own
			)
		).toEqual({
			items: [{ kind: 'left-open', text: 'The new delete has no undo' }],
			replies: [{ id: 'p1', text: 'Still read only' }],
		});
		expect(() => parsePlanVerdict({ findings: [{ replyTo: 'p9', text: 'x' }] }, true, own)).toThrow(
			'replyTo p9 is not one of your findings in this review. Your findings: p1.'
		);
		expect(() =>
			parsePlanVerdict({ findings: [{ kind: 'missed', text: 'x' }] }, true, own)
		).toThrow('In a closure check only replyTo');
		expect(() => parsePlanVerdict({ gaps: [{ text: 'x' }], findings: [] }, true, own)).toThrow(
			'Gaps are not asked again'
		);
	});

	it('reads a finding’s state from its marks, as a code finding', () => {
		expect(planFindingState(finding())).toBe('sent');
		expect(planFindingState(finding({ closed: 2 }))).toBe('fixed');
		expect(planFindingState(finding({ closed: 2, answer: 'not needed' }))).toBe('answered');
		expect(planFindingState(finding({ open: 2, reason: 'still' }))).toBe('open');
		expect(planFindingState(finding({ round: 2, introduced: 2 }))).toBe('new');
		expect(planFindingState(finding({ open: 2, accepted: true }))).toBe('accepted');
		expect(
			openPlanFindings([
				finding({ open: 2 }),
				finding({ id: 'g1', kind: 'gap' }),
				finding({ id: 'p2', closed: 2 }),
			])
		).toHaveLength(1);
	});

	it('a revision while the person decides opens the closure check; nothing else takes it', () => {
		expect(reviewLoop('yours', { kind: 'revised' })).toEqual({
			state: 'verifying',
			action: 'verify',
		});
		expect(reviewLoop('passed', { kind: 'revised' })).toBeNull();
		expect(reviewLoop('fixing', { kind: 'revised' })).toBeNull();
	});

	it("renders the foreman's split with each part's executor and the crew (spec/reviews#plan-inputs)", () => {
		const agent = (name: string, model: string): CrewSpecAgent => ({
			id: name,
			name,
			role: 'developer',
			provider: 'codex',
			requestedChoices: {},
			choiceNames: { model },
			instructions: '',
			extraInstructions: '',
			zone: ['src/**'],
			checkedBy: [],
			agents: [],
		});
		const text = splitPlanMarkdown(
			{
				summary: 'Notes and details',
				parts: [
					{
						title: 'Notes',
						agent: 'NOTES',
						prompt: 'Build notes',
						files: ['src/notes/**'],
						scopes: [],
					},
					{ title: 'Details', agent: 'GONE', prompt: 'Build details', files: [], scopes: ['api'] },
				],
			},
			[agent('NOTES', 'GPT-6 Luna')]
		);
		expect(text).toContain('## Part 1: Notes\nExecutor: NOTES (developer, codex, GPT-6 Luna)');
		expect(text).toContain('Executor: GONE (not in the crew)');
		expect(text).toContain("Files: the executor's whole zone\nScopes: api");
		expect(text).toContain('## Crew\n- NOTES: developer, codex, GPT-6 Luna; zone src/**');
	});
});

describe('sources (spec/reviews#save-source)', () => {
	const entry = (patch: Partial<TaskSourceEntry> = {}): TaskSourceEntry => ({
		id: 's1',
		title: 'Ticket',
		file: 'ticket-12345678.md',
		chars: 10,
		savedAt: '2026-11-13T10:00:00.000Z',
		...patch,
	});
	it('checks title, url and text against their limits and the task’s', () => {
		expect(
			checkSource({ title: ' CRM-412 ', url: 'https://x.notion.so/a?b=1', text: 'Body' }, [])
		).toEqual({
			title: 'CRM-412',
			url: 'https://x.notion.so/a?b=1',
			text: 'Body',
			replaces: null,
		});
		expect(() => checkSource({ title: '', text: 'x' }, [])).toThrow('title is required');
		expect(() => checkSource({ title: 'x'.repeat(201), text: 'x' }, [])).toThrow(
			'title is at most 200'
		);
		expect(() => checkSource({ title: 'T', url: 'javascript:alert(1)', text: 'x' }, [])).toThrow(
			'url is an http(s)'
		);
		expect(() => checkSource({ title: 'T', text: '  ' }, [])).toThrow('text is required');
		expect(() => checkSource({ title: 'T', text: 'x'.repeat(200_001) }, [])).toThrow(
			'text is at most 200000'
		);
		const twenty = Array.from({ length: 20 }, (_, i) => entry({ id: `s${i}`, title: `T${i}` }));
		expect(() => checkSource({ title: 'New', text: 'x' }, twenty)).toThrow('at most 20 sources');
		// The same title replaces its source, so a full task can still update one.
		expect(checkSource({ title: 't3', text: 'x' }, twenty).replaces?.id).toBe('s3');
		const heavy = Array.from({ length: 5 }, (_, i) =>
			entry({ id: `h${i}`, title: `H${i}`, chars: 200_000 })
		);
		expect(() => checkSource({ title: 'More', text: 'x' }, heavy)).toThrow(
			'1000000 characters in all'
		);
		expect(sourceSlug('CRM-412: Client notes')).toBe('crm-412-client-notes');
		expect(sourceSlug('Тикет')).toBe('source');
	});
});

describe('older journals and documents (spec/reviews#data, rule 2)', () => {
	it('loads a version-2 review document without plan fields, and one with them', () => {
		const review = {
			id: 'r1',
			point: 'pre-pr',
			target: { taskId: 't1' },
			startedBy: 'person',
			who: { kind: 'agent' },
			instructions: '',
			guidance: '',
			startedAt: '2026-11-13T10:00:00.000Z',
			state: 'passed',
			round: 1,
			passes: 0,
			reviewers: ['Codex'],
			trees: [],
		};
		const doc = { schemaVersion: 2, proposal: null, review, past: [] };
		expect(isTaskReviewDocument(doc)).toBe(true);
		expect(readTaskReviewDocument(doc, 't1')).toBe(doc);
		const plan = {
			...review,
			point: 'plan',
			plan: {
				kind: 'approval',
				id: 'q1',
				revision: 2,
				text: '# Plan',
				read: 1,
				seen: 2,
				base: 1,
				baseText: '# Old',
			},
			findings: [finding({ open: 2, reason: 'still' }), finding({ id: 'p2', kind: 'gap' })],
		};
		expect(isTaskReviewDocument({ ...doc, review: plan })).toBe(true);
		expect(isTaskReviewDocument({ ...doc, review: { ...plan, findings: [{ id: 'x' }] } })).toBe(
			false
		);
	});

	it('validates the events of older journals as they were, and the new ones', () => {
		const base = { id: 'r1', point: 'mid' };
		expect(
			isSessionEvent({ kind: 'task-review.findings', ...base, findings: 2, reviewers: ['Codex'] })
		).toBe(true);
		expect(
			isSessionEvent({
				kind: 'task-review.findings',
				...base,
				point: 'plan',
				findings: 0,
				reviewers: ['Codex'],
				gaps: 2,
			})
		).toBe(true);
		expect(isSessionEvent({ kind: 'task-review.finished', ...base, state: 'passed' })).toBe(true);
		expect(
			isSessionEvent({
				kind: 'task-review.finished',
				...base,
				point: 'plan',
				state: 'accepted',
				approval: true,
				open: 1,
			})
		).toBe(true);
		expect(isSessionEvent({ kind: 'source.saved', id: 's1', title: 'Ticket', chars: 10 })).toBe(
			true
		);
		expect(
			isSessionEvent({
				kind: 'source.saved',
				id: 's1',
				title: 'Ticket',
				url: 'https://x',
				chars: 10,
			})
		).toBe(true);
		expect(isSessionEvent({ kind: 'source.saved', id: 's1', chars: 10 })).toBe(false);
	});

	it('settings carry Plan review Off; an older file without it is migrated by main', () => {
		expect(defaultAppSettings.planReviewOff).toBe(false);
		expect(isAppSettings(defaultAppSettings)).toBe(true);
		const { planReviewOff: _, ...older } = defaultAppSettings;
		expect(isAppSettings(older)).toBe(false);
	});
});

describe('a plan review of a composing foreman (spec/reviews#reviewer-sessions, spec/crew#compose)', () => {
	it('the reviewers below the root keep the foreman composing and stay when the crew is merged in', async () => {
		const { isComposing, composedSpec, withoutTaskReviewers } = await import('./crew-compose');
		const node = (id: string, role: CrewSpecAgent['role']): CrewSpecAgent => ({
			id,
			name: id,
			role,
			provider: 'codex',
			requestedChoices: {},
			choiceNames: {},
			instructions: '',
			extraInstructions: '',
			zone: [],
			checkedBy: [],
			agents: [],
		});
		const reviewer = node('review-abc-1', 'reviewer');
		const spec = {
			schemaVersion: 1 as const,
			templateId: null,
			name: 'Auto',
			resolvedAt: '2026-11-13T10:00:00.000Z',
			root: { ...node('root', 'foreman'), checkedBy: [reviewer.id], agents: [reviewer] },
			compose: { templates: [], providers: [] } as never,
		};
		expect(isComposing(spec)).toBe(true);
		const composed = composedSpec(spec, [node('API', 'developer')]);
		expect(composed.root.agents.map((agent) => agent.id)).toEqual(['API', 'review-abc-1']);
		expect(isComposing(composed)).toBe(false);
		expect(withoutTaskReviewers(composed).root.agents.map((agent) => agent.id)).toEqual(['API']);
	});
});
