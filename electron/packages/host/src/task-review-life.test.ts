import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore, atomicJson } from '@brigadir/persistence';
import {
	builtinAgentTemplates,
	resolveCrewAgent,
	templateLookup,
	type EventRecord,
	type ReviewBatch,
	type ReviewComment,
	type ReviewRun,
	type SessionEvent,
	type TaskKey,
} from '@brigadir/core';
import {
	TaskReviewLife,
	ownReviewCrew,
	ownReviewTool,
	type PresentedPlan,
	type StartReview,
	type TaskReviewDeps,
} from './task-review';
import { staleIntroduced, scopedPath } from './crew';
import { mcpTools } from './mcp';
import { readSourcesForReview, readTaskSources, saveTaskSource } from './task-sources';

/**
 * spec/reviews#loop: the task side of a review with a stand-in for the crew host's check edge — the test plays the reviewer's verdicts
 * (`hooks().round`), the first read's batch (`hooks().submitReview`) and the agent's turns, so every exit of the loop runs in milliseconds.
 */
const run = promisify(execFile);
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn();
});
const tree = (c: string) => c.repeat(40);
const reviewer = resolveCrewAgent(
	{ id: 'reviewer', name: 'Codex', template: 'reviewer', provider: 'codex' },
	{ lookup: templateLookup([...builtinAgentTemplates]), defaultProvider: 'codex' },
	[],
	false
);
const start = (patch: Partial<StartReview> = {}): StartReview => ({
	kind: 'startReview',
	reviewers: [reviewer],
	who: { kind: 'agent' },
	instructions: '',
	guidance: '',
	reviewer: { provider: 'codex', model: null, effort: null, source: 'other' },
	...patch,
});
async function setup(patch: Partial<TaskReviewDeps> = {}) {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-review-life-'));
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	const repo = join(root, 'repo');
	await mkdir(repo);
	await run('git', ['init', '-q', '-b', 'main'], { cwd: repo });
	const store = await SessionStore.at(join(root, 'data'));
	const project = await store.addProject(repo);
	const task = await store.createTask(project.id, 'Client screen', 'claude', 'gui', 'Build it');
	const key: TaskKey = { projectId: task.projectId, id: task.id };
	const records: EventRecord[] = [],
		batches: { text: string; batch: ReviewBatch }[] = [],
		prompts: string[] = [];
	const state = {
		busy: false,
		trees: [{ scopeId: 's1', tree: tree('a') }],
		checks: 0,
		stopped: 0,
		settled: true,
		/** spec/reviews#plan-review: the plan that waits for the person. */
		plan: null as PresentedPlan | null,
	};
	const planBatches: { text: string; batch: ReviewBatch }[] = [];
	const host = {
		checkSelf: async () => {
			state.checks++;
		},
		replySelf: async () => {},
		stopSelf: async () => {
			state.stopped++;
		},
		selfTrees: async () => state.trees,
	};
	const emit = async (event: SessionEvent) => {
		records.push({
			schemaVersion: 1,
			seq: records.length + 1,
			at: new Date().toISOString(),
			event,
		});
	};
	const deps: TaskReviewDeps = {
		store,
		key,
		emit,
		records: () => records,
		busy: () => state.busy,
		crew: async () => host,
		existing: () => host,
		settled: () => state.settled,
		submitReview: async (text, batch) => {
			batches.push({ text, batch });
		},
		resolve: async () => start(),
		changes: async () => 2,
		checkpoint: async () => {},
		prompt: async (text) => {
			prompts.push(text);
		},
		brief: async () => '',
		part: async () => null,
		planWaiting: () => state.plan,
		planFeedback: async (text, batch) => {
			planBatches.push({ text, batch });
			// The waiting plan is answered with its reject option.
			state.plan = null;
		},
		foreman: false,
		...patch,
	};
	const life = new TaskReviewLife(deps);
	await life.load();
	const doc = () => life.document();
	/** The reviewer's verdicts of run `round` came in. */
	const verdict = (round: number, state_: 'reviewing' | 'comments' | 'approved' | 'disputed') =>
		life.hooks().round(
			{
				round,
				scopeSnapshots: [{ scopeId: 's1', base: tree('0'), result: state.trees[0]!.tree }],
				verdicts:
					state_ === 'reviewing'
						? []
						: [
								{
									reviewerNodeId: 'review-1',
									reviewer: 'Codex',
									approved: state_ === 'approved',
									comments: 0,
									at: new Date().toISOString(),
								},
							],
			} as unknown as ReviewRun,
			state_
		);
	/** The crew host's review store: the findings of the current review with their marks. */
	const findings = async (list: Partial<ReviewComment>[]) => {
		const id = doc().review!.id;
		await atomicJson(join(await store.taskDir(key), 'review.json'), {
			schemaVersion: 1,
			notes: [],
			comments: list.map((item, index) => ({
				id: `c${index + 1}`,
				version: 1,
				text: `Finding ${index + 1}`,
				at: new Date().toISOString(),
				anchor: {
					scopeId: 's1',
					path: 'src/a.ts',
					side: 'new',
					blob: tree('b'),
					start: 1,
					end: 1,
					quote: ['x'],
					before: [],
					after: [],
					contextHash: 'h',
					symbolPath: null,
				},
				...item,
				review: { reviewId: id, round: 1, reviewer: 'Codex', ...item.review },
			})),
		});
	};
	const readFindings = async () =>
		JSON.parse(await readFile(join(await store.taskDir(key), 'review.json'), 'utf8'))
			.comments as ReviewComment[];
	/** The first read listed findings: the crew host hands them to the agent as one batch. */
	const firstRead = async (n: number) => {
		await findings(Array.from({ length: n }, () => ({})));
		await verdict(1, 'comments');
		await life.hooks().submitReview(`batch of ${n}`, { id: 'batch-1', comments: [] });
	};
	/** The agent's turn took the last batch and ended. */
	const answer = async () => {
		const batch = doc().review!.batch!;
		await emit({ kind: 'turn.started', text: 'fix', review: { id: batch, comments: [] } });
		await emit({ kind: 'turn.completed', reason: 'end_turn' });
		await life.turnEnded();
	};
	const kinds = () =>
		records.map((record) => record.event.kind).filter((kind) => kind.startsWith('task-review.'));
	return {
		store,
		key,
		life,
		deps,
		doc,
		state,
		records,
		batches,
		prompts,
		verdict,
		findings,
		readFindings,
		firstRead,
		answer,
		kinds,
		emit,
		planBatches,
	};
}

describe('every exit of the loop (spec/reviews#loop)', () => {
	it('a clean pass: the first read finds nothing', async () => {
		const h = await setup();
		await h.life.start(start());
		expect(h.doc().review).toMatchObject({
			state: 'reading',
			point: 'pre-pr',
			startedBy: 'person',
		});
		expect(h.state.checks).toBe(1);
		await h.verdict(1, 'reviewing');
		await h.verdict(1, 'approved');
		expect(h.doc().review!.state).toBe('passed');
		expect(h.kinds()).toEqual([
			'task-review.started',
			'task-review.findings',
			'task-review.finished',
		]);
		expect(h.records.at(-2)!.event).toMatchObject({ findings: 0 });
		expect(h.records.at(-1)!.event).toMatchObject({ state: 'passed' });
	});
	it('fixed: the agent fixes every finding once, the closure check closes them', async () => {
		const h = await setup();
		await h.life.start(start());
		await h.firstRead(2);
		expect(h.doc().review).toMatchObject({ state: 'fixing', passes: 1, batch: 'batch-1' });
		await h.answer();
		expect(h.doc().review!.state).toBe('verifying');
		expect(h.state.checks).toBe(2);
		expect(h.records.find((r) => r.event.kind === 'task-review.answered')!.event).toMatchObject({
			fixed: 2,
			answered: 0,
		});
		await h.findings([{ review: { closed: 2 } as never }, { review: { closed: 2 } as never }]);
		await h.verdict(2, 'approved');
		expect(h.doc().review!.state).toBe('passed');
		expect(h.records.find((r) => r.event.kind === 'task-review.verified')!.event).toMatchObject({
			closed: 2,
			open: 0,
			introduced: 0,
		});
	});
	it('objected: the agent answers a finding with a reason and the reviewer closes it', async () => {
		const h = await setup();
		await h.life.start(start());
		await h.firstRead(1);
		await h.findings([
			{ replies: [{ author: 'Task agent', text: 'Deliberate.', at: '', round: 1, agent: true }] },
		]);
		await h.answer();
		expect(h.records.find((r) => r.event.kind === 'task-review.answered')!.event).toMatchObject({
			fixed: 0,
			answered: 1,
		});
		await h.verdict(2, 'approved');
		expect(h.doc().review!.state).toBe('passed');
	});
	it('a problem the fix introduced goes to the person with the open list; no third round runs', async () => {
		const h = await setup();
		await h.life.start(start());
		await h.firstRead(1);
		await h.answer();
		await h.findings([
			{ review: { closed: 2 } as never },
			{ review: { introduced: 2, round: 2 } as never },
		]);
		await h.verdict(2, 'disputed');
		expect(h.doc().review!.state).toBe('yours');
		expect(h.records.find((r) => r.event.kind === 'task-review.verified')!.event).toMatchObject({
			closed: 1,
			open: 0,
			introduced: 1,
		});
		await h.emit({ kind: 'turn.completed', reason: 'end_turn' });
		await h.life.turnEnded();
		expect(h.state.checks).toBe(2);
	});
	it('`Fix {n}` sends the open findings once more with the reviewer’s reason, then one closure check', async () => {
		const h = await setup();
		await h.life.start(start());
		await h.firstRead(2);
		await h.answer();
		await h.findings([
			{ review: { closed: 2 } as never },
			{
				review: { open: 2 } as never,
				replies: [{ author: 'Codex', text: 'Still refetches.', at: '', round: 2, agent: false }],
			},
		]);
		await h.verdict(2, 'disputed');
		await h.life.decide('fix');
		expect(h.doc().review).toMatchObject({ state: 'fixing', passes: 2 });
		const batch = h.batches.at(-1)!;
		expect(batch.text).toContain(
			'The person asks you to fix 1 finding of the review before the pull request that is still open.'
		);
		expect(batch.text).toContain('Why it is still open: Still refetches.');
		expect(batch.batch.comments).toEqual([{ id: 'c2', version: 1 }]);
		expect(h.records.find((r) => r.event.kind === 'task-review.decided')!.event).toMatchObject({
			decision: 'fix',
			findings: 1,
		});
		await h.answer();
		expect(h.state.checks).toBe(3);
		await h.verdict(3, 'approved');
		expect(h.doc().review!.state).toBe('passed');
	});
	it('`Accept` ends the review with the open findings recorded as accepted', async () => {
		const h = await setup();
		await h.life.start(start({ point: 'mid', startedBy: 'agent' }));
		await h.firstRead(1);
		await h.answer();
		await h.findings([{ review: { open: 2 } as never }]);
		await h.verdict(2, 'disputed');
		await h.life.decide('accept');
		expect(h.doc().review!.state).toBe('accepted');
		expect((await h.readFindings())[0]).toMatchObject({
			review: { accepted: true },
			resolvedVersion: 1,
		});
		expect(h.records.at(-1)!.event).toMatchObject({
			kind: 'task-review.finished',
			state: 'accepted',
		});
		// A mid-task review: the waiting agent goes on with the task.
		expect(h.prompts).toEqual([
			'The person accepted the open findings of the mid-task review as they are. Continue the task.',
		]);
		await expect(h.life.decide('fix')).rejects.toThrow('No review waits for your call.');
	});
	it('stopped: the open round ends and the reviewers stop', async () => {
		const h = await setup();
		await h.life.start(start());
		await h.life.stop();
		expect(h.state.stopped).toBe(1);
		expect(h.doc().review!.state).toBe('stopped');
		expect(h.records.at(-1)!.event).toMatchObject({
			kind: 'task-review.finished',
			state: 'stopped',
		});
		// A new review may start after a stop.
		await h.life.start(start());
		expect(h.doc().past.map((item) => item.state)).toEqual(['stopped']);
	});
	it('a restart in the middle continues from the record: the batch’s answer opens the closure check', async () => {
		const h = await setup();
		await h.life.start(start());
		await h.firstRead(1);
		const again = new TaskReviewLife(h.deps);
		await again.load();
		expect(again.document().review).toMatchObject({ state: 'fixing', batch: 'batch-1', round: 1 });
		await h.emit({ kind: 'turn.started', text: 'fix', review: { id: 'batch-1', comments: [] } });
		await h.emit({ kind: 'turn.completed', reason: 'end_turn' });
		await again.turnEnded();
		expect(again.document().review!.state).toBe('verifying');
		expect(h.state.checks).toBe(2);
	});
	it('a start while the agent works waits for its turn to end', async () => {
		const h = await setup();
		h.state.busy = true;
		await h.life.start(start());
		expect(h.doc().review!.state).toBe('waiting');
		expect(h.state.checks).toBe(0);
		h.state.busy = false;
		await h.life.turnEnded();
		expect(h.doc().review!.state).toBe('reading');
		expect(h.state.checks).toBe(1);
	});
	it('a later change outdates a pass before the PR, not a mid-task pass', async () => {
		const pre = await setup();
		await pre.life.start(start());
		await pre.verdict(1, 'approved');
		pre.state.trees = [{ scopeId: 's1', tree: tree('c') }];
		await pre.life.turnEnded();
		expect(pre.doc().review!.state).toBe('outdated');
		const mid = await setup();
		await mid.life.start(start({ point: 'mid', startedBy: 'agent' }));
		await mid.verdict(1, 'approved');
		mid.state.trees = [{ scopeId: 's1', tree: tree('c') }];
		await mid.life.turnEnded();
		expect(mid.doc().review!.state).toBe('passed');
		// The agent was not in a turn: a clean mid-task pass sends it on.
		expect(mid.prompts).toEqual(['The mid-task review passed. Continue the task.']);
	});
});

describe('the agent asks for a review (spec/reviews#request-tool)', () => {
	it('the host starts it at once while the agent works, and refuses a second one or one with nothing new', async () => {
		let checkpoints = 0;
		const h = await setup({
			checkpoint: async () => {
				checkpoints++;
			},
		});
		h.state.busy = true;
		expect(
			await h.life.request({ point: 'mid', startedBy: 'agent', reason: 'the data layer' })
		).toEqual({ started: true, reviewer: 'Codex' });
		expect(checkpoints).toBe(1);
		expect(h.doc().review).toMatchObject({
			point: 'mid',
			startedBy: 'agent',
			reason: 'the data layer',
			state: 'reading',
			reviewer: { provider: 'codex', source: 'other' },
		});
		expect(h.records[0]!.event).toMatchObject({
			kind: 'task-review.started',
			point: 'mid',
			reason: 'the data layer',
		});
		expect(await h.life.request({ point: 'mid', startedBy: 'agent', reason: 'again' })).toEqual({
			started: false,
			reason: 'A review of this task is already running.',
		});
		await h.verdict(1, 'approved');
		expect(await h.life.request({ point: 'mid', startedBy: 'agent', reason: 'again' })).toEqual({
			started: false,
			reason: 'Nothing changed since the last review.',
		});
	});
	it('a task without changes gets no review', async () => {
		const h = await setup({ changes: async () => 0 });
		expect(await h.life.request({ point: 'mid', startedBy: 'agent', reason: 'x' })).toEqual({
			started: false,
			reason: 'Nothing changed since the last review.',
		});
		expect(h.doc().review).toBeNull();
	});
	it('no reviewer available: the review is recorded as one that could not start', async () => {
		const h = await setup({
			resolve: async () => ({ failure: 'No reviewer is available: no agent is signed in.' }),
		});
		expect(await h.life.request({ point: 'mid', startedBy: 'agent', reason: 'x' })).toEqual({
			started: false,
			reason: 'No reviewer is available: no agent is signed in.',
		});
		expect(h.doc().review).toMatchObject({
			state: 'failed',
			failure: 'No reviewer is available: no agent is signed in.',
		});
		expect(h.kinds()).toEqual(['task-review.started', 'task-review.finished']);
		expect(h.state.checks).toBe(0);
	});
});

describe('an older task (spec/reviews#data, rule 2)', () => {
	it('replays a journal with the review.* kinds and reads its version-1 review document', async () => {
		const h = await setup();
		const dir = await h.store.taskDir(h.key);
		const old: SessionEvent[] = [
			{ kind: 'review.proposed', summary: 'Done.' },
			{ kind: 'review.started', id: 'r0', reviewers: ['Reviewer'], who: { kind: 'agent' } },
			{
				kind: 'crew.review',
				reviewId: 'run1',
				taskId: h.key.id,
				name: 'Task agent',
				reviewer: 'Reviewer',
				round: 1,
				approved: false,
				comments: 1,
				state: 'comments',
			},
			{ kind: 'review.replied', commentId: 'c1' },
			{ kind: 'review.finished', id: 'r0', state: 'disputed' },
		];
		await writeFile(
			join(dir, 'events.jsonl'),
			old
				.map((event, index) =>
					JSON.stringify({
						schemaVersion: 1,
						seq: index + 1,
						at: '2026-01-01T00:00:00.000Z',
						event,
					})
				)
				.join('\n') + '\n'
		);
		const journal = await h.store.journal(h.key);
		expect(journal.issue).toBeNull();
		expect(journal.records.map((record) => record.event.kind)).toEqual(old.map((e) => e.kind));
		await atomicJson(join(dir, 'task-review.json'), {
			schemaVersion: 1,
			proposal: null,
			review: {
				id: 'r0',
				who: { kind: 'agent' },
				instructions: '',
				guidance: '',
				startedAt: '2026-01-01T00:00:00.000Z',
				state: 'disputed',
				round: 2,
				reviewers: ['Reviewer'],
				trees: [],
			},
		});
		const life = new TaskReviewLife(h.deps);
		await life.load();
		expect(life.document().review).toMatchObject({ id: 'r0', point: 'pre-pr', state: 'yours' });
		// The person can still close it; the record is written back as version 2.
		await life.decide('accept');
		const saved = JSON.parse(await readFile(join(dir, 'task-review.json'), 'utf8'));
		expect(saved).toMatchObject({ schemaVersion: 2, review: { state: 'accepted' } });
	});
});

describe('fixes of an independent review of the loop', () => {
	it('a foreman’s closure check waits until the fixes it handed to workers are accepted, though later turns carry no batch', async () => {
		const h = await setup({ foreman: true });
		await h.life.start(start());
		await h.firstRead(1);
		h.state.settled = false;
		await h.answer();
		expect(h.doc().review!.state).toBe('fixing');
		// A worker's report turn: no batch id, the crew is done.
		h.state.settled = true;
		await h.emit({ kind: 'turn.started', text: 'report' });
		await h.emit({ kind: 'turn.completed', reason: 'end_turn' });
		await h.life.turnEnded();
		expect(h.doc().review!.state).toBe('verifying');
		expect(h.state.checks).toBe(2);
	});
	it('a foreman that only objects, without edits, gets its closure check at once', async () => {
		const h = await setup({ foreman: true });
		await h.life.start(start());
		await h.firstRead(1);
		await h.answer();
		expect(h.doc().review!.state).toBe('verifying');
	});
	it('a version-1 review read while the agent fixed finds its batch in the journal and goes on', async () => {
		const h = await setup();
		const dir = await h.store.taskDir(h.key);
		await h.emit({
			kind: 'prompt.queued',
			prompt: {
				id: 'q1',
				command: {
					kind: 'submitReview',
					text: 'batch',
					review: { id: 'old-batch', comments: [] },
					crew: { kind: 'review-comments', round: 1, comments: 1 },
				},
				attachments: [],
			},
		});
		await atomicJson(join(dir, 'task-review.json'), {
			schemaVersion: 1,
			proposal: null,
			review: {
				id: 'r0',
				who: { kind: 'agent' },
				instructions: '',
				guidance: '',
				startedAt: '2026-01-01T00:00:00.000Z',
				state: 'comments',
				round: 1,
				reviewers: ['Reviewer'],
				trees: [{ scopeId: 's1', tree: tree('a') }],
			},
		});
		const life = new TaskReviewLife(h.deps);
		await life.load();
		expect(life.document().review).toMatchObject({ state: 'fixing', batch: 'old-batch' });
		await h.emit({ kind: 'turn.started', text: 'fix', review: { id: 'old-batch', comments: [] } });
		await h.emit({ kind: 'turn.completed', reason: 'end_turn' });
		await life.turnEnded();
		expect(life.document().review!.state).toBe('verifying');
	});
	it('a request looks at the files after a checkpoint: shell edits since the last one count', async () => {
		let files = 0;
		const h = await setup({
			changes: async () => files,
			checkpoint: async () => {
				files = 1;
			},
		});
		expect(
			await h.life.request({ point: 'mid', startedBy: 'agent', reason: 'the data layer' })
		).toEqual({ started: true, reviewer: 'Codex' });
	});
	it('a crew developer has review tools and restores its own review crew; a reviewer and a lead do not', () => {
		for (const role of [null, 'foreman', 'developer'])
			expect(ownReviewTool(role, 'request_review') && ownReviewTool(role, 'review_reply')).toBe(
				true
			);
		for (const role of ['reviewer', 'lead'])
			expect(ownReviewTool(role, 'request_review')).toBe(false);
		expect(ownReviewTool('developer', 'ask_user')).toBe(false);
		const spec = { name: 'Review' } as never;
		expect(ownReviewCrew({ reviewCrew: spec }, 'developer')).toBe(spec);
		expect(ownReviewCrew({ reviewCrew: spec }, null)).toBe(spec);
		expect(ownReviewCrew({ reviewCrew: spec }, 'foreman')).toBeNull();
		expect(ownReviewCrew({}, 'developer')).toBeNull();
	});
	it('an introduced finding is matched by repo and path across the reference case’s git roots (spec/overview#reference-case)', () => {
		// Root repo, two submodules, a gitignored nested repo, a worktree: the fix changed `src/db.ts` of the nested repo only.
		const changed = new Set([scopedPath('nested', 'src/db.ts'), scopedPath('root', 'README.md')]);
		const at = (scopeId: string, path: string) => ({ anchor: { scopeId, path } as never });
		expect(staleIntroduced([at('nested', 'src/db.ts')], changed)).toBeNull();
		// The same repo-relative path in another root did not change.
		expect(staleIntroduced([at('submodule-a', 'src/db.ts')], changed)).toBe('src/db.ts');
		expect(staleIntroduced([at('worktree', 'README.md')], changed)).toBe('README.md');
		expect(staleIntroduced([at('root', 'README.md'), at('submodule-b', 'x.ts')], changed)).toBe(
			'x.ts'
		);
	});
});

describe('the plan review (spec/reviews#plan-review)', () => {
	const plan = (
		revision: number,
		text = `# Client notes\n\n- read notes\n- step ${revision}`,
		kind: PresentedPlan['kind'] = 'approval'
	): PresentedPlan => ({ kind, id: `plan-${revision}`, revision, text });
	/** The plan waits for the person, and the host hears it presented. */
	const present = async (s: Awaited<ReturnType<typeof setup>>, value: PresentedPlan) => {
		s.state.plan = value;
		await s.life.planPresented(value);
	};
	/** The first read listed two findings for the author and one gap; the author's batch went out. */
	const readWithFindings = async (s: Awaited<ReturnType<typeof setup>>) => {
		await present(s, plan(1));
		await s.life.hooks().planVerdict('Codex', 1, {
			findings: [
				{ kind: 'missed', text: 'Edit and delete are missing', where: 'CRM-412 · Notes' },
				{ kind: 'left-open', text: 'Two saves at once overwrite each other' },
			],
			gaps: [{ text: 'No empty state for a client without orders', where: 'CRM-412 · Orders' }],
		});
		await s.verdict(1, 'comments');
	};
	/** The author's turn took the batch (a solo task: the batch runs as its own turn). */
	const takeBatch = (s: Awaited<ReturnType<typeof setup>>) =>
		s.emit({
			kind: 'turn.started',
			text: 'revise',
			review: { id: s.doc().review!.batch!, comments: [] },
		});

	it('starts by itself when the plan is presented and reads at once while the turn waits; Off starts nothing', async () => {
		const s = await setup();
		s.state.busy = true;
		await present(s, plan(1));
		expect(s.doc().review).toMatchObject({
			point: 'plan',
			startedBy: 'host',
			state: 'reading',
			plan: { kind: 'approval', id: 'plan-1', revision: 1, read: 1, seen: 1 },
			findings: [],
		});
		expect(s.state.checks).toBe(1);
		expect(s.kinds()).toEqual(['task-review.started']);

		const off = await setup({ resolve: async () => ({ off: true }) });
		await present(off, plan(1));
		expect(off.doc().review).toBeNull();
		expect(off.state.checks).toBe(0);
	});

	it('one full read per plan: a later revision gets none, the next plan after an approval gets its own', async () => {
		const s = await setup();
		await present(s, plan(1));
		// Gaps alone pass the review: they are the person's questions, not the author's.
		await s.life.hooks().planVerdict('Codex', 1, {
			gaps: [{ text: 'No phone format for non-UA numbers', where: 'CRM-412 · Header' }],
		});
		await s.verdict(1, 'comments');
		const first = s.doc().review!;
		expect(first.state).toBe('passed');
		expect(first.findings).toMatchObject([{ kind: 'gap', reviewer: 'Codex', round: 1 }]);
		expect(s.records.find((r) => r.event.kind === 'task-review.findings')?.event).toMatchObject({
			findings: 0,
			gaps: 1,
		});
		expect(s.planBatches).toHaveLength(0);

		await present(s, plan(2));
		expect(s.doc().review!.id).toBe(first.id);
		expect(s.state.checks).toBe(1);

		await s.life.planDecided(true);
		expect(s.doc().review!.plan!.approved).toBe(true);
		await present(s, plan(3));
		expect(s.doc().review!.id).not.toBe(first.id);
		expect(s.doc().review!.state).toBe('reading');
		expect(s.state.checks).toBe(2);
	});

	it('the author revises once or objects; the revision gets the closure check against the revision diff; the rest goes to the person', async () => {
		const s = await setup();
		await readWithFindings(s);
		expect(s.doc().review!.state).toBe('fixing');
		expect(s.planBatches).toHaveLength(1);
		const batch = s.planBatches[0]!;
		expect(batch.text).toContain('Codex left 2 findings in the plan review. Revise the plan once');
		expect(batch.text).toContain('- id p1 [missed] (CRM-412 · Notes): Edit and delete are missing');
		// Gaps never go to the author.
		expect(batch.text).not.toContain('empty state');
		expect(batch.batch.comments.map((item) => item.id)).toEqual(['p1', 'p2']);

		await takeBatch(s);
		await s.life.reply('p2', 'The store already serializes saves');
		await present(s, plan(2, '# Client notes\n\n- read notes\n- edit and delete notes'));
		expect(s.doc().review!.state).toBe('verifying');
		expect(s.state.checks).toBe(2);
		const read = await s.life.hooks().planRead(2);
		expect(read).toMatchObject({ revision: 2, previous: 1, read: 1 });
		expect(read.diff).toContain('+- edit and delete notes');
		const prompt = await s.life.hooks().planPrompt('t1', 'r2', 2, 'Codex');
		expect(prompt).toContain('closure check');
		expect(prompt).toContain("Author's objection: The store already serializes saves");

		await s.life.hooks().planVerdict('Codex', 2, {
			findings: [{ replyTo: 'p2', text: 'A retry after a failed save still races' }],
		});
		await s.verdict(2, 'disputed');
		const review = s.doc().review!;
		expect(review.state).toBe('yours');
		expect(review.findings!.find((f) => f.id === 'p1')).toMatchObject({ closed: 2 });
		expect(review.findings!.find((f) => f.id === 'p2')).toMatchObject({
			open: 2,
			reason: 'A retry after a failed save still races',
		});
		expect(s.records.find((r) => r.event.kind === 'task-review.verified')?.event).toMatchObject({
			closed: 1,
			open: 1,
			introduced: 0,
		});

		// `Fix {n}` answers the plan again with the open finding and its reason.
		await s.life.decide('fix');
		expect(s.doc().review!.state).toBe('fixing');
		expect(s.planBatches.at(-1)!.text).toContain('The person asks you to fix 1 finding');
		expect(s.planBatches.at(-1)!.text).toContain(
			'Still open: A retry after a failed save still races'
		);
	});

	it('a revision presented while the person decides gets a closure check of the open findings', async () => {
		const s = await setup();
		await readWithFindings(s);
		await takeBatch(s);
		await present(s, plan(2));
		await s.life.hooks().planVerdict('Codex', 2, {
			findings: [{ replyTo: 'p1', text: 'Delete is still missing' }],
		});
		await s.verdict(2, 'disputed');
		expect(s.doc().review!.state).toBe('yours');
		await present(s, plan(3));
		expect(s.doc().review!.state).toBe('verifying');
		expect(s.state.checks).toBe(3);
		expect((await s.life.hooks().planRead(3)).previous).toBe(2);
	});

	it('Approve plan stays available: approving with open findings records them as accepted and ends the review', async () => {
		const s = await setup();
		await readWithFindings(s);
		await takeBatch(s);
		await present(s, plan(2));
		await s.life.hooks().planVerdict('Codex', 2, {
			findings: [{ replyTo: 'p2', text: 'Still races' }],
		});
		await s.verdict(2, 'disputed');
		await s.life.planDecided(true);
		const review = s.doc().review!;
		expect(review.state).toBe('accepted');
		expect(review.plan!.approved).toBe(true);
		expect(review.findings!.find((f) => f.id === 'p2')!.accepted).toBe(true);
		expect(review.findings!.find((f) => f.id === 'p1')!.accepted).toBeUndefined();
		expect(s.state.stopped).toBe(1);
		expect(s.records.at(-1)!.event).toMatchObject({
			kind: 'task-review.finished',
			state: 'accepted',
			approval: true,
			open: 1,
		});

		// An approval before the read ends stops the review; a rejection by the person changes nothing.
		const early = await setup();
		await present(early, plan(1));
		await early.life.planDecided(false);
		expect(early.doc().review!.state).toBe('reading');
		await early.life.planDecided(true);
		expect(early.doc().review!.state).toBe('stopped');
		expect(early.records.at(-1)!.event).toMatchObject({ approval: true, open: 0 });
	});

	it('the batch waits behind a plan presented before the author took it: the plan is answered again', async () => {
		const s = await setup();
		await readWithFindings(s);
		await present(s, plan(2));
		expect(s.doc().review!.state).toBe('fixing');
		expect(s.planBatches).toHaveLength(2);
		expect(s.planBatches[1]!.batch.id).toBe(s.planBatches[0]!.batch.id);
		// The author's turn ends without presenting the plan again: the closure check reads the plan as it was.
		await takeBatch(s);
		await s.emit({ kind: 'turn.completed', reason: 'end_turn' });
		await s.life.turnEnded();
		expect(s.doc().review!.state).toBe('verifying');
	});

	it("the foreman's split: the reviewer checks the split too, and the next proposal is the closure check", async () => {
		const s = await setup({ foreman: true });
		const split = (revision: number) =>
			plan(
				revision,
				`# Split proposed by the foreman\n\n## Part 1: Notes\n\n## Part ${revision + 1}: Details`,
				'split'
			);
		await present(s, split(1));
		const prompt = await s.life.hooks().planPrompt('t1', 'r1', 1, 'Codex');
		expect(prompt).toContain("Check the foreman's split of task t1");
		expect(prompt).toContain(
			'a part that depends on files of another part while both run in parallel'
		);
		await s.life.hooks().planVerdict('Codex', 1, {
			findings: [
				{
					kind: 'split',
					text: 'Details reuses the notes components while both run in parallel',
					where: 'Part 2',
				},
			],
		});
		await s.verdict(1, 'comments');
		expect(s.doc().review!.state).toBe('fixing');
		expect(s.planBatches[0]!.text).toContain('call propose_plan again');
		// The split's rejection carried the batch: the next proposal is the answer, with no batch turn of its own.
		await present(s, split(2));
		expect(s.doc().review!.state).toBe('verifying');
	});

	it('a reviewer on another provider reads the plan and the saved sources through the host', async () => {
		const s = await setup();
		await saveTaskSource(
			s.store,
			s.key,
			{
				title: 'CRM-412 Client notes',
				url: 'https://notion.so/crm-412',
				text: 'Notes can be edited and deleted.',
			},
			s.emit
		);
		await present(s, plan(1));
		expect(s.doc().review!.reviewer).toMatchObject({ provider: 'codex', source: 'other' });
		expect(await s.life.hooks().planRead(1)).toMatchObject({
			revision: 1,
			text: plan(1).text,
		});
		const sources = await s.life.hooks().sources(undefined);
		expect(sources.sources).toMatchObject([
			{
				title: 'CRM-412 Client notes',
				url: 'https://notion.so/crm-412',
				text: 'Notes can be edited and deleted.',
			},
		]);
		const listed = mcpTools('reviewer').list.tools.map((tool) => (tool as { name: string }).name);
		expect(listed).toEqual(
			expect.arrayContaining(['read_plan', 'read_sources', 'submit_plan_review'])
		);
		expect(mcpTools(null).list.tools.map((tool) => (tool as { name: string }).name)).toContain(
			'save_source'
		);
	});
});

describe('sources (spec/reviews#save-source)', () => {
	it('saves the text next to the plans, replaces a source by title and reads within the bound', async () => {
		const s = await setup();
		const first = await saveTaskSource(
			s.store,
			s.key,
			{ title: 'Ticket', text: 'a'.repeat(150_000) },
			s.emit
		);
		await saveTaskSource(s.store, s.key, { title: 'Contract', text: 'b'.repeat(120_000) }, s.emit);
		const index = await readTaskSources(s.store, s.key);
		expect(index.sources.map((item) => item.title)).toEqual(['Ticket', 'Contract']);
		expect(index.sources[0]!.file).toMatch(/^ticket-[0-9a-f]{8}\.md$/);
		expect(s.records.filter((r) => r.event.kind === 'source.saved')).toHaveLength(2);
		// One call stays under 200 000 characters; sourceId reads one whole.
		const all = await readSourcesForReview(s.store, s.key);
		const text = all.sources.map((item) => ('text' in item ? item.text : '')).join('');
		expect(text.length).toBe(200_000);
		expect(all.note).toContain('pass sourceId');
		const one = await readSourcesForReview(s.store, s.key, index.sources[1]!.id);
		expect(one.sources).toMatchObject([{ title: 'Contract', text: 'b'.repeat(120_000) }]);
		// The same title replaces the source under its id.
		const again = await saveTaskSource(
			s.store,
			s.key,
			{ title: 'ticket', text: 'new text' },
			s.emit
		);
		expect(again.id).toBe(first.id);
		expect((await readTaskSources(s.store, s.key)).sources).toHaveLength(2);
		await expect(
			saveTaskSource(s.store, s.key, { title: 'Big', text: 'x'.repeat(200_001) }, s.emit)
		).rejects.toThrow('text is at most 200000 characters');
		await expect(
			saveTaskSource(
				s.store,
				s.key,
				{ title: 'Bad url', url: 'file:///etc/passwd', text: 'x' },
				s.emit
			)
		).rejects.toThrow('url is an http(s) address');
	});
});
