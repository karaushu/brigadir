import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SessionStore, atomicJson } from '@brigadir/persistence';
import {
	pendingInputs,
	resolveCrew,
	templateLookup,
	crewWorkerRows,
	crewPalette,
	builtinAgentTemplates,
	type AgentTask,
	type CrewTemplate,
	type EventRecord,
	type TaskKey,
} from '@brigadir/core';
import { connectHost, readIdentity, type HostClient } from './index';
const run = promisify(execFile);
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn();
}, 60_000);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(read: () => Promise<T | undefined>, timeout = 30000): Promise<T> {
	const end = Date.now() + timeout;
	while (Date.now() < end) {
		const v = await read();
		if (v !== undefined) return v;
		await delay(50);
	}
	throw new Error('Condition timed out');
}
const git = (cwd: string, ...args: string[]) =>
	run('git', args, {
		cwd,
		env: {
			...process.env,
			GIT_AUTHOR_NAME: 'T',
			GIT_AUTHOR_EMAIL: 't@x',
			GIT_COMMITTER_NAME: 'T',
			GIT_COMMITTER_EMAIL: 't@x',
		},
	});
const oneDeveloper: CrewTemplate = {
	schemaVersion: 1,
	id: 'one-dev',
	name: 'One developer',
	builtin: false,
	root: {
		id: 'root',
		name: 'Foreman',
		template: 'foreman-default',
		agents: [{ id: 'developer', name: 'Developer', template: 'developer' }],
	},
};
const reviewLoop: CrewTemplate = {
	schemaVersion: 1,
	id: 'review-loop',
	name: 'Developer + Reviewer',
	builtin: false,
	root: {
		id: 'root',
		name: 'Foreman',
		template: 'foreman-default',
		agents: [
			{ id: 'developer', name: 'Developer', template: 'developer', checkedBy: ['reviewer'] },
			{ id: 'reviewer', name: 'Reviewer', template: 'reviewer' },
		],
	},
};
async function setup(crewId: 'default' | 'review-loop' = 'default', template?: CrewTemplate) {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-crew-test-'));
	cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
	// Worker hosts are detached children of the foreman host: stop them with the fixture tree.
	cleanup.push(async () => {
		await run('pkill', ['-f', root]).catch(() => {});
	});
	const repo = join(root, 'repo');
	await mkdir(repo);
	await git(repo, 'init', '-q', '-b', 'main');
	await writeFile(join(repo, 'README.md'), 'hello\n');
	await git(repo, 'add', '-A');
	await git(repo, 'commit', '-q', '-m', 'feat: [Couriers] seed');
	const store = await SessionStore.at(join(root, 'data'));
	const project = await store.addProject(repo);
	const spec = resolveCrew(template ?? (crewId === 'review-loop' ? reviewLoop : oneDeveloper), {
		lookup: templateLookup([]),
		defaultProvider: 'claude',
		now: new Date().toISOString(),
	});
	let task = await store.createTask(project.id, 'Split the work', 'claude');
	task = await store.updateTask(task, { crew: spec });
	return { root, repo, store, task, project };
}
async function launch(store: SessionStore, key: TaskKey) {
	const dir = await store.taskDir(key);
	const config = join(dir, 'config.json');
	await atomicJson(config, {
		schemaVersion: 1,
		dataDir: store.root,
		key,
		mcpEntry: resolve('apps/desktop/out/services/mcp-relay'),
		adapter: {
			command: process.execPath,
			args: [resolve('packages/transport/fixtures/agent.mjs'), 'crew'],
		},
	});
	const child = spawn(process.execPath, [resolve('apps/desktop/out/services/host.cjs'), config], {
		stdio: 'pipe',
	});
	let diagnostics = '';
	child.stderr.on('data', (c) => {
		diagnostics += c;
	});
	cleanup.push(async () => {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill('SIGTERM');
			await until(async () =>
				child.exitCode !== null || child.signalCode !== null ? true : undefined
			).catch(() => child.kill('SIGKILL'));
		}
	});
	const identity = await until(async () => {
		if (child.exitCode !== null) throw new Error(diagnostics);
		const id = await readIdentity(store, key);
		return id && id.pid === child.pid ? id : undefined;
	});
	const client = await connectHost(identity);
	cleanup.push(async () => client.close());
	await until(async () => ((await client.snapshot()).connected ? true : undefined));
	await client.startAgent();
	await until(async () =>
		(await client.snapshot()).records.find((r) => r.event.kind === 'session.started')
	);
	return { child, identity, client };
}
async function event<K extends EventRecord['event']['kind']>(
	client: HostClient,
	kind: K,
	after = 0
) {
	return until(async () =>
		(await client.snapshot()).records.find((r) => r.seq > after && r.event.kind === kind)
	) as Promise<EventRecord & { event: Extract<EventRecord['event'], { kind: K }> }>;
}
async function idle(client: HostClient, after: number) {
	return event(client, 'turn.completed', after);
}
/** spec/crew#accept: subjects and parent counts of the checked-out branch, newest first. */
const history = async (cwd: string) =>
	(await git(cwd, 'log', '--format=%P%x09%s')).stdout
		.trim()
		.split('\n')
		.map((line) => {
			const [parents, subject] = line.split('\t');
			return { parents: parents!.split(' ').filter(Boolean).length, subject };
		});
const assistantText = (records: EventRecord[], after: number) =>
	records
		.filter(
			(record) =>
				record.seq > after &&
				record.event.kind === 'message.delta' &&
				record.event.role === 'assistant'
		)
		.map((record) =>
			record.event.kind === 'message.delta' && record.event.content.kind === 'text'
				? record.event.content.text
				: ''
		)
		.join('');
/** Assistant text of the turn that ended at `completedSeq`. */
const turnText = (records: EventRecord[], completedSeq: number) => {
	const start = records.findLast(
		(record) => record.seq < completedSeq && record.event.kind === 'turn.started'
	)!.seq;
	return records
		.filter(
			(record) =>
				record.seq > start && record.seq < completedSeq && record.event.kind === 'message.delta'
		)
		.map((record) =>
			record.event.kind === 'message.delta' && record.event.content.kind === 'text'
				? record.event.content.text
				: ''
		)
		.join('');
};

it('runs a crew: plan card, worker task in a worktree, pushed report, question, notes and acceptance by merge', async () => {
	const { store, task, repo } = await setup();
	const { client } = await launch(store, task);
	// Workers start only after the human's decision (spec/crew#task-type rule 2).
	await client.command({
		kind: 'prompt',
		text: '@call create_worker_task {"agent":"Developer","title":"Too early","prompt":"x"}',
	});
	let done = await idle(client, 0);
	let text = turnText((await client.snapshot()).records, done.seq);
	expect(text).toMatch(/create_worker_task.*propose_plan first/s);
	// The brief travels as a context block of the first prompt, never as journal text.
	await client.command({
		kind: 'prompt',
		text: '@call propose_plan {"summary":"one part","parts":[{"title":"Write output","agent":"Developer","prompt":"@write out/result.txt done","files":["out/**"]}]}',
	});
	const requested = await event(client, 'crew.plan.requested');
	expect(requested.event.plan.parts[0]).toMatchObject({
		title: 'Write output',
		agent: 'Developer',
		files: ['out/**'],
	});
	expect(pendingInputs((await client.snapshot()).records).crewPlan?.id).toBe(
		requested.event.plan.id
	);
	// The plan waits for the person: the sidebar shows the task as needing you until the decision.
	expect((await store.task(task)).status).toBe('needs-you');
	const journal = await readFile(join(await store.taskDir(task), 'events.jsonl'), 'utf8');
	expect(journal).not.toContain('You are the foreman');
	await client.command({
		kind: 'decidePlan',
		decision: { id: requested.event.plan.id, approved: true, parts: null },
	});
	const resolved = await event(client, 'crew.plan.resolved');
	expect(resolved.event.approved).toBe(true);
	done = await idle(client, requested.seq);
	text = turnText((await client.snapshot()).records, done.seq);
	expect(text).toContain('"approved":true');
	await client.command({
		kind: 'prompt',
		text: '@call create_worker_task {"agent":"Developer","title":"Write output","prompt":"@write out/result.txt done\\n@call post_note {\\"text\\":\\"result.txt is written\\"}\\n@call read_notes {}","files":["out/**"]}',
	});
	const created = await event(client, 'crew.worker.created');
	expect(created.event.name).toBe('Developer');
	const workerKey = { projectId: task.projectId, id: created.event.taskId };
	const worker = await store.task(workerKey);
	expect(worker).toMatchObject({
		crewTaskId: task.id,
		crewNodeId: 'developer',
		parentTaskId: task.id,
		title: 'Write output',
		provider: 'claude',
	});
	expect(worker.launch?.isolation).toBe('worktree');
	expect(worker.launch?.baseRef).toBe('HEAD');
	// The worker runs in its own host and reports by push (spec/crew#task-type): the foreman gets a service prompt.
	const report = await event(client, 'crew.report', created.seq);
	expect(report.event.report).toMatchObject({
		taskId: workerKey.id,
		name: 'Developer',
		files: 1,
		outside: 0,
		additions: 1,
	});
	const reportTurn = await until(async () =>
		(await client.snapshot()).records.find(
			(r) =>
				r.seq > created.seq && r.event.kind === 'turn.started' && r.event.crew?.kind === 'report'
		)
	);
	expect(reportTurn.event.kind === 'turn.started' && reportTurn.event.text).toContain(
		'out/result.txt'
	);
	const note = await event(client, 'crew.note');
	expect(note.event.note).toMatchObject({
		author: 'Developer',
		text: 'result.txt is written',
		seq: 1,
	});
	const workerJournal = await store.journal(workerKey);
	expect(
		workerJournal.records.filter((r) => r.event.kind === 'turn.completed').length
	).toBeGreaterThanOrEqual(1);
	const workerText = workerJournal.records
		.filter((r) => r.event.kind === 'message.delta')
		.map((r) =>
			r.event.kind === 'message.delta' && r.event.content.kind === 'text'
				? r.event.content.text
				: ''
		)
		.join('');
	expect(workerText).toContain('"hasMore":false');
	expect(workerText).toContain('result.txt is written');
	await idle(client, reportTurn.seq);
	// Foreman reads, reviews with anchored comments, and the worker gets them as review comments.
	let before = (await client.snapshot()).records.at(-1)!.seq;
	await client.command({
		kind: 'prompt',
		text: `@call read_report {"taskId":"${workerKey.id}"}\n@call read_diff {"taskId":"${workerKey.id}","path":"out/result.txt"}\n@call read_notes {}\n@call task_status {"taskId":"${workerKey.id}"}`,
	});
	done = await idle(client, before);
	text = turnText((await client.snapshot()).records, done.seq);
	expect(text).toContain('Changed files: 1, +1');
	expect(text).toContain('+done');
	expect(text).toContain('"nextCursor":1');
	expect(text).toContain('"busy":false');
	before = done.seq;
	await client.command({
		kind: 'prompt',
		text: `@call submit_review {"taskId":"${workerKey.id}","comments":[{"path":"out/result.txt","start":1,"end":1,"text":"Say hello instead"}]}`,
	});
	done = await idle(client, before);
	text = turnText((await client.snapshot()).records, done.seq);
	expect(text).toContain('"sent":1');
	const review = JSON.parse(
		await readFile(join(await store.taskDir(workerKey), 'review.json'), 'utf8')
	);
	expect(review.comments[0]).toMatchObject({
		author: 'Foreman',
		text: 'Say hello instead',
		anchor: { path: 'out/result.txt', start: 1, end: 1, quote: ['done'] },
	});
	await until(async () =>
		(await store.journal(workerKey)).records.find(
			(r) => r.event.kind === 'turn.started' && r.event.review
		)
	);
	await until(async () => {
		const records = (await store.journal(workerKey)).records;
		const last = records.findLast((r) => ['turn.started', 'turn.completed'].includes(r.event.kind));
		return last?.event.kind === 'turn.completed' ? true : undefined;
	});
	// ask_foreman blocks the worker until prompt_task answers with the questionId (spec/crew#ask-foreman).
	before = (await client.snapshot()).records.at(-1)!.seq;
	await client.command({
		kind: 'prompt',
		text: `@call prompt_task {"taskId":"${workerKey.id}","text":"@call ask_foreman {\\"question\\":\\"Keep the alias?\\",\\"options\\":[\\"yes\\",\\"no\\"]}"}`,
	});
	const question = await event(client, 'crew.question.requested', before);
	expect(question.event.question).toMatchObject({
		agent: 'Developer',
		question: 'Keep the alias?',
		options: ['yes', 'no'],
		state: 'pending',
	});
	await expect(
		client.command({
			kind: 'answerCrewQuestion',
			id: question.event.question.id,
			answer: 'human too early',
		})
	).rejects.toThrow('five minutes');
	const asked = await until(async () =>
		(await client.snapshot()).records.find(
			(r) => r.seq > before && r.event.kind === 'turn.started' && r.event.crew?.kind === 'question'
		)
	);
	await idle(client, asked.seq);
	before = (await client.snapshot()).records.at(-1)!.seq;
	// spec/crew#attention: the foreman ended its turn with the worker's question open, so it waits for the person.
	await until(async () => ((await store.task(task)).status === 'needs-you' ? true : undefined));
	await client.command({
		kind: 'prompt',
		text: `@call prompt_task {"taskId":"${workerKey.id}","text":"yes, keep it","questionId":"${question.event.question.id}"}`,
	});
	const answered = await event(client, 'crew.question.resolved', before);
	expect(answered.event).toMatchObject({
		id: question.event.question.id,
		answer: 'yes, keep it',
		answeredBy: 'foreman',
	});
	await until(async () => {
		const records = (await store.journal(workerKey)).records;
		const turn = records.findLast((r) => r.event.kind === 'turn.started');
		const text = records
			.filter((r) => turn && r.seq > turn.seq && r.event.kind === 'message.delta')
			.map((r) =>
				r.event.kind === 'message.delta' && r.event.content.kind === 'text'
					? r.event.content.text
					: ''
			)
			.join('');
		return text.includes('"answer":"yes, keep it"') ? true : undefined;
	});
	// The answered turn's report (the third) prompts the foreman; accept only after that turn, or the accept prompt queues behind it.
	const answeredReport = await until(
		async () => (await client.snapshot()).records.filter((r) => r.event.kind === 'crew.report')[2]
	);
	await until(async () => {
		const records = (await client.snapshot()).records;
		const started = records.find(
			(r) => r.seq > answeredReport.seq && r.event.kind === 'turn.started'
		);
		return started && records.some((r) => r.seq > started.seq && r.event.kind === 'turn.completed')
			? true
			: undefined;
	});
	await until(async () => {
		const records = (await client.snapshot()).records;
		const last = records.findLast((r) => ['turn.started', 'turn.completed'].includes(r.event.kind));
		return last?.event.kind === 'turn.completed' ? true : undefined;
	});
	// Acceptance commits the worker branch and squashes it into the foreman's tree as one commit (spec/crew#task-type, spec/crew#accept).
	before = (await client.snapshot()).records.at(-1)!.seq;
	await client.command({ kind: 'prompt', text: `@call accept_task {"taskId":"${workerKey.id}"}` });
	const accepted = await event(client, 'crew.accepted', before);
	expect(accepted.event.conflicts).toEqual([]);
	done = await idle(client, before);
	text = turnText((await client.snapshot()).records, done.seq);
	expect(text).toContain('"accepted":true');
	expect(await readFile(join(repo, 'out', 'result.txt'), 'utf8')).toBe('done\n');
	// The generator wrote the message in the style of the repo's log; no merge commit, no worker-branch commit in the history.
	expect(await history(repo)).toEqual([
		{ parents: 1, subject: 'feat: [Couriers] Write output' },
		{ parents: 0, subject: 'feat: [Couriers] seed' },
	]);
	expect((await git(repo, 'log', '-1', '--format=%b')).stdout).toContain('Files: out/result.txt');
	expect((await git(repo, 'branch', '--format=%(refname:short)')).stdout).toContain(
		worker.launch!.branch
	);
	await until(async () =>
		(await store.task(workerKey)).status === 'completed' ? true : undefined
	);
	await client.command({ kind: 'shutdown' });
	await until(async () =>
		(await client.snapshot().catch(() => null)) === null ? true : undefined
	);
}, 240_000);

it('routes reports through the reviewer: round 1 comments, round 2 approval, or a dispute after two rounds (spec/crew#reviewer)', async () => {
	const { store, task } = await setup('review-loop');
	const { client } = await launch(store, task);
	await client.command({
		kind: 'prompt',
		text: '@call propose_plan {"parts":[{"title":"Write output","agent":"Developer","prompt":"@write out/result.txt done","files":["out/**"]}]}',
	});
	const requested = await event(client, 'crew.plan.requested');
	await client.command({
		kind: 'decidePlan',
		decision: { id: requested.event.plan.id, approved: true, parts: null },
	});
	await idle(client, requested.seq);
	await client.command({
		kind: 'prompt',
		text: '@call create_worker_task {"agent":"Developer","title":"Write output","prompt":"@write out/result.txt done","files":["out/**"]}',
	});
	const created = await event(client, 'crew.worker.created');
	// The reviewer starts with the developer as a worker without writable files.
	const reviewerCreated = await until(async () =>
		(await client.snapshot()).records.find(
			(r) => r.event.kind === 'crew.worker.created' && r.event.name === 'Reviewer'
		)
	);
	const reviewerTask = await store.task({
		projectId: task.projectId,
		id: (reviewerCreated.event as { taskId: string }).taskId,
	});
	expect(reviewerTask.readOnlyAgent).toBe(true);
	expect(reviewerTask.launch?.scopes.some((scope) => scope.selected)).toBe(true);
	expect(reviewerTask.title).toBe('checks Developer');
	// Round 1: the reviewer comments; the developer receives the batch with the reviewer as author; no report reaches the foreman yet.
	const round1 = await until(
		async () =>
			(await client.snapshot()).records.find(
				(r) => r.event.kind === 'crew.review' && r.event.state === 'comments'
			),
		60_000
	);
	expect(round1.event).toMatchObject({
		name: 'Developer',
		reviewer: 'Reviewer',
		round: 1,
		approved: false,
		comments: 1,
	});
	const workerKey = { projectId: task.projectId, id: created.event.taskId };
	const review = JSON.parse(
		await readFile(join(await store.taskDir(workerKey), 'review.json'), 'utf8')
	);
	expect(review.comments[0]).toMatchObject({
		author: 'Reviewer · checks Developer',
		text: 'Round 1: say hello instead',
		anchor: { path: 'out/result.txt' },
	});
	expect(
		(await client.snapshot()).records.some(
			(r) => r.event.kind === 'turn.started' && r.event.crew?.kind === 'report'
		)
	).toBe(false);
	// Round 2: the developer's next report is checked again and approved; the foreman gets one report with the verdict.
	const approved = await until(
		async () =>
			(await client.snapshot()).records.find(
				(r) => r.event.kind === 'crew.review' && r.event.state === 'approved'
			),
		60_000
	);
	expect(approved.event).toMatchObject({ round: 2, approved: true });
	const reportTurn = await until(async () =>
		(await client.snapshot()).records.find(
			(r) => r.event.kind === 'turn.started' && r.event.crew?.kind === 'report'
		)
	);
	expect(
		reportTurn.event.kind === 'turn.started' &&
			reportTurn.event.crew?.kind === 'report' &&
			reportTurn.event.crew.report
	).toMatchObject({ verdict: 'approved', round: 2, name: 'Developer' });
	expect(reportTurn.event.kind === 'turn.started' && reportTurn.event.text).toContain(
		'Reviewer approved'
	);
	const runs = JSON.parse(
		await readFile(join(await store.taskDir(task), 'crew-reviews.json'), 'utf8')
	).reviews as { state: string; round: number; reviewerNodeIds: string[] }[];
	expect(runs.map((run) => [run.round, run.state])).toEqual([
		[1, 'comments'],
		[2, 'approved'],
	]);
	await until(async () => {
		const records = (await client.snapshot()).records;
		const last = records.findLast((r) => ['turn.started', 'turn.completed'].includes(r.event.kind));
		return last?.event.kind === 'turn.completed' ? true : undefined;
	});
	// A second part titled «dispute»: the fixture reviewer comments twice, so the dispute goes to the foreman after round 2.
	let before = (await client.snapshot()).records.at(-1)!.seq;
	await client.command({ kind: 'prompt', text: `@call accept_task {"taskId":"${workerKey.id}"}` });
	await event(client, 'crew.accepted', before);
	await idle(client, before);
	// spec/architecture-and-platform#host-lifecycle: every part the reviewer checks is accepted and its checks are over — its host stops; status and worktree stay.
	const reviewerKey = { projectId: task.projectId, id: reviewerTask.id },
		reviewerStopped = async () => (await store.journal(reviewerKey)).records.at(-1)?.event;
	await until(
		async () => ((await reviewerStopped())?.kind === 'host.stopped' ? true : undefined),
		30_000
	);
	expect(await reviewerStopped()).toEqual({ kind: 'host.stopped', reason: 'shutdown' });
	expect((await store.task(reviewerKey)).status).toBe('done');
	expect((await stat((await store.projectForTask(reviewerKey)).path)).isDirectory()).toBe(true);
	const reviewerStarts = (await store.journal(reviewerKey)).records.filter(
		(r) => r.event.kind === 'session.started'
	).length;
	before = (await client.snapshot()).records.at(-1)!.seq;
	await client.command({
		kind: 'prompt',
		text: '@call create_worker_task {"agent":"Developer","title":"dispute this","prompt":"@write out/other.txt done","files":["out/**"]}',
	});
	const disputed = await until(
		async () =>
			(await client.snapshot()).records.find(
				(r) => r.seq > before && r.event.kind === 'crew.review' && r.event.state === 'disputed'
			),
		90_000
	);
	expect(disputed.event).toMatchObject({ round: 2, approved: false });
	const disputeTurn = await until(async () =>
		(await client.snapshot()).records.find(
			(r) =>
				r.seq > before &&
				r.event.kind === 'turn.started' &&
				r.event.crew?.kind === 'report' &&
				r.event.crew.report.verdict === 'disputed'
		)
	);
	expect(disputeTurn.event.kind === 'turn.started' && disputeTurn.event.text).toContain(
		'did not agree after two rounds'
	);
	// The new part's rounds started the same reviewer task again through the launch path, resuming its session.
	const restarts = (await store.journal(reviewerKey)).records.filter(
		(r) => r.event.kind === 'session.started'
	);
	expect(restarts.length).toBe(reviewerStarts + 1);
	expect(
		new Set(restarts.map((r) => r.event.kind === 'session.started' && r.event.sessionId)).size
	).toBe(1);
	await client.command({ kind: 'shutdown' });
	await until(async () =>
		(await client.snapshot().catch(() => null)) === null ? true : undefined
	);
}, 300_000);

it('keeps review state across a foreman restart, refuses stale reviewIds and never treats silence as approval', async () => {
	const { store, task, repo } = await setup('review-loop');
	let { client, child } = await launch(store, task);
	await client.command({
		kind: 'prompt',
		text: '@call propose_plan {"parts":[{"title":"Write output","agent":"Developer","prompt":"@write out/result.txt done","files":["out/**"]}]}',
	});
	const requested = await event(client, 'crew.plan.requested');
	await client.command({
		kind: 'decidePlan',
		decision: { id: requested.event.plan.id, approved: true, parts: null },
	});
	await idle(client, requested.seq);
	// The developer part is titled «hold»: the fixture reviewer never answers, so the run stays `reviewing`.
	// «no message» makes the fixture's commit message generator fail: acceptance falls back to «agent: title» (spec/crew#accept).
	await client.command({
		kind: 'prompt',
		text: '@call create_worker_task {"agent":"Developer","title":"hold the verdict, no message","prompt":"@write out/result.txt done","files":["out/**"]}',
	});
	const created = await event(client, 'crew.worker.created');
	const workerKey = { projectId: task.projectId, id: created.event.taskId };
	await until(async () => {
		const runs = JSON.parse(
			await readFile(join(await store.taskDir(task), 'crew-reviews.json'), 'utf8').catch(
				() => '{"reviews":[]}'
			)
		).reviews as { state: string; dispatched: string[] }[];
		return runs.some((run) => run.state === 'reviewing' && run.dispatched.length === 1)
			? true
			: undefined;
	}, 60_000);
	expect(
		(await client.snapshot()).records.some(
			(r) => r.event.kind === 'turn.started' && r.event.crew?.kind === 'report'
		)
	).toBe(false);
	// Restart the foreman host: the run and its dispatch survive; no verdict is invented.
	child.kill('SIGTERM');
	await until(async () =>
		child.exitCode !== null || child.signalCode !== null ? true : undefined
	);
	({ client, child } = await launch(store, task));
	const runs = JSON.parse(
		await readFile(join(await store.taskDir(task), 'crew-reviews.json'), 'utf8')
	).reviews as { reviewId: string; state: string; verdicts: unknown[] }[];
	expect(runs).toHaveLength(1);
	expect(runs[0]!.state).toBe('reviewing');
	expect(runs[0]!.verdicts).toEqual([]);
	expect((await client.snapshot()).records.some((r) => r.event.kind === 'crew.review')).toBe(false);
	// Accepting a work under review cancels the run instead of passing it as approved.
	await until(async () => {
		const records = (await store.journal(workerKey)).records;
		const last = records.findLast((r) => ['turn.started', 'turn.completed'].includes(r.event.kind));
		return last?.event.kind === 'turn.completed' ? true : undefined;
	});
	let before = (await client.snapshot()).records.at(-1)!.seq;
	await client.command({ kind: 'prompt', text: `@call accept_task {"taskId":"${workerKey.id}"}` });
	await event(client, 'crew.accepted', before);
	await idle(client, before);
	const after = JSON.parse(
		await readFile(join(await store.taskDir(task), 'crew-reviews.json'), 'utf8')
	).reviews as { state: string }[];
	expect(after[0]!.state).toBe('cancelled');
	expect(await history(repo)).toEqual([
		{ parents: 1, subject: 'Developer: hold the verdict, no message' },
		{ parents: 0, subject: 'feat: [Couriers] seed' },
	]);
	await client.command({ kind: 'shutdown' });
	await until(async () =>
		(await client.snapshot().catch(() => null)) === null ? true : undefined
	);
}, 240_000);

const leadCrew = (shared: boolean): CrewTemplate => ({
	schemaVersion: 1,
	id: 'lead-crew',
	name: 'Lead crew',
	builtin: false,
	root: {
		id: 'root',
		name: 'Foreman',
		template: 'foreman-default',
		agents: [
			{
				id: 'ui',
				name: 'UI lead',
				template: 'foreman-default',
				zone: ['out/**'],
				agents: [
					{ id: 'a', name: 'A', template: 'developer', zone: shared ? ['out/**'] : ['out/a/**'] },
					{ id: 'b', name: 'B', template: 'developer', zone: shared ? ['out/**'] : ['out/b/**'] },
				],
			},
		],
	},
});
const leadPrompt = (a: string, b: string) =>
	[
		'@on-report accept',
		`@call propose_plan {"parts":[{"title":"A part","agent":"A","prompt":"@write ${a} a","files":["${a}"]},{"title":"B part","agent":"B","prompt":"@write ${b} b","files":["${b}"]}]}`,
		`@call create_worker_task {"agent":"A","title":"A part","prompt":"@write ${a} a","files":["${a}"]}`,
		`@call create_worker_task {"agent":"B","title":"B part","prompt":"@write ${b} b","files":["${b}"]}`,
	].join('\n');
it('a lead plans without a human card, accepts its parts into its tree and hands one branch report up (spec/crew#subordinates, G5)', async () => {
	const { store, task, repo } = await setup('default', leadCrew(false));
	const { client } = await launch(store, task);
	await client.command({
		kind: 'prompt',
		text: '@call propose_plan {"parts":[{"title":"UI branch","agent":"UI lead","prompt":"lead prompt","files":["out/**"]}]}',
	});
	const requested = await event(client, 'crew.plan.requested');
	await client.command({
		kind: 'decidePlan',
		decision: { id: requested.event.plan.id, approved: true, parts: null },
	});
	await idle(client, requested.seq);
	await client.command({
		kind: 'prompt',
		text: `@call create_worker_task ${JSON.stringify({ agent: 'UI lead', title: 'UI branch', prompt: leadPrompt('out/a/a.txt', 'out/b/b.txt'), files: ['out/**'] })}`,
	});
	const created = await event(client, 'crew.worker.created');
	const leadKey = { projectId: task.projectId, id: created.event.taskId };
	// The lead's plan resolves itself; its children point at the lead as parent and at the root crew task.
	// A task directory being created may not have its task.json yet: read it on the next poll.
	await until(
		async () =>
			(await store.journal(leadKey)).records.find((r) => r.event.kind === 'crew.plan.resolved'),
		60_000
	);
	const children = await until(async () => {
		const tasks = (
			await Promise.all(
				(
					await (
						await import('node:fs/promises')
					).readdir(join(store.root, 'projects', task.projectId, 'tasks'))
				).map((id) => store.task({ projectId: task.projectId, id }).catch(() => null))
			)
		)
			.filter((item) => item?.parentTaskId === leadKey.id)
			.map((item) => item!);
		return tasks.length === 2 ? tasks : undefined;
	}, 60_000);
	expect(children.map((child) => child.crewTaskId)).toEqual([task.id, task.id]);
	expect(children.map((child) => child.crewNodeId).sort()).toEqual(['a', 'b']);
	expect(
		crewWorkerRows({ ...task, crew: (await store.task(task)).crew! }, [
			await store.task(leadKey),
			...children,
		]).map((row) => [row.name, row.depth, row.role])
	).toEqual([
		['UI lead', 0, 'foreman'],
		['A', 1, 'developer'],
		['B', 1, 'developer'],
	]);
	// One branch report reaches the root after both parts were accepted; the lead's tree holds both files.
	const branch = await until(
		async () =>
			(await client.snapshot()).records.find(
				(r) => r.event.kind === 'turn.started' && r.event.crew?.kind === 'branch-report'
			),
		120_000
	);
	expect(
		branch.event.kind === 'turn.started' &&
			branch.event.crew?.kind === 'branch-report' &&
			branch.event.crew.report
	).toMatchObject({ name: 'UI lead', files: 2 });
	const leadProject = await store.projectForTask(leadKey);
	expect(await readFile(join(leadProject.path, 'out/a/a.txt'), 'utf8')).toBe('a\n');
	expect(await readFile(join(leadProject.path, 'out/b/b.txt'), 'utf8')).toBe('b\n');
	expect(
		(await store.journal(leadKey)).records.filter((r) => r.event.kind === 'crew.accepted').length
	).toBe(2);
	await until(async () => {
		const records = (await client.snapshot()).records;
		const last = records.findLast((r) => ['turn.started', 'turn.completed'].includes(r.event.kind));
		return last?.event.kind === 'turn.completed' ? true : undefined;
	});
	expect(
		(await client.snapshot()).records.filter(
			(r) => r.event.kind === 'turn.started' && r.event.crew?.kind === 'branch-report'
		).length
	).toBe(1);
	// spec/crew#accept: the lead's branch holds one commit per accepted part, in acceptance order, no merge commits.
	const leadHistory = await history(leadProject.path);
	expect(
		leadHistory
			.slice(0, 2)
			.map((item) => item.subject)
			.sort()
	).toEqual(['feat: [Couriers] A part', 'feat: [Couriers] B part']);
	expect(leadHistory.slice(2)).toEqual([{ parents: 0, subject: 'feat: [Couriers] seed' }]);
	expect(leadHistory.every((item) => item.parents <= 1)).toBe(true);
	// The root accepts the branch: the lead's work lands in the project as one commit.
	const before = (await client.snapshot()).records.at(-1)!.seq;
	await client.command({ kind: 'prompt', text: `@call accept_task {"taskId":"${leadKey.id}"}` });
	const accepted = await event(client, 'crew.accepted', before);
	expect(accepted.event.conflicts).toEqual([]);
	await idle(client, before);
	expect(await readFile(join(repo, 'out/b/b.txt'), 'utf8')).toBe('b\n');
	expect(await history(repo)).toEqual([
		{ parents: 1, subject: 'feat: [Couriers] UI branch' },
		{ parents: 0, subject: 'feat: [Couriers] seed' },
	]);
	await client.command({ kind: 'shutdown' });
	await until(async () =>
		(await client.snapshot().catch(() => null)) === null ? true : undefined
	);
}, 300_000);
it('a merge conflict inside the branch stops at the lead: needs-you, no branch report to the root', async () => {
	const { store, task } = await setup('default', leadCrew(true));
	const { client } = await launch(store, task);
	await client.command({
		kind: 'prompt',
		text: '@call propose_plan {"parts":[{"title":"UI branch","agent":"UI lead","prompt":"lead prompt","files":["out/**"]}]}',
	});
	const requested = await event(client, 'crew.plan.requested');
	await client.command({
		kind: 'decidePlan',
		decision: { id: requested.event.plan.id, approved: true, parts: null },
	});
	await idle(client, requested.seq);
	await client.command({
		kind: 'prompt',
		text: `@call create_worker_task ${JSON.stringify({ agent: 'UI lead', title: 'UI branch', prompt: leadPrompt('out/shared.txt', 'out/shared.txt'), files: ['out/**'] })}`,
	});
	const created = await event(client, 'crew.worker.created');
	const leadKey = { projectId: task.projectId, id: created.event.taskId };
	const conflict = await until(
		async () =>
			(await store.journal(leadKey)).records.find(
				(r) => r.event.kind === 'crew.accepted' && r.event.conflicts.length > 0
			),
		120_000
	);
	expect(conflict.event.kind === 'crew.accepted' && conflict.event.conflicts).toEqual([
		'out/shared.txt',
	]);
	await until(async () => ((await store.task(leadKey)).status === 'needs-you' ? true : undefined));
	// spec/crew#accept: a squash leaves no MERGE_HEAD; the generated message waits in SQUASH_MSG and git-merge.json names the worker's branch.
	const leadPath = (await store.projectForTask(leadKey)).path,
		gitFile = async (name: string) =>
			(
				await git(leadPath, 'rev-parse', '--path-format=absolute', '--git-path', name)
			).stdout.trim();
	await expect(stat(await gitFile('MERGE_HEAD'))).rejects.toThrow();
	expect(await readFile(await gitFile('SQUASH_MSG'), 'utf8')).toMatch(
		/^feat: \[Couriers\] [AB] part\n/
	);
	const records = Object.values(
		JSON.parse(await readFile(join(await store.taskDir(leadKey), 'git-merge.json'), 'utf8'))
			.merges as Record<
			string,
			{ from: string; into: string; conflicts: string[]; agent: string[] }
		>
	);
	const branches = (
		await Promise.all(
			(
				await (
					await import('node:fs/promises')
				).readdir(join(store.root, 'projects', task.projectId, 'tasks'))
			).map((id) => store.task({ projectId: task.projectId, id }).catch(() => null))
		)
	)
		.filter((item) => item?.parentTaskId === leadKey.id)
		.map((item) => item!.launch?.branch);
	expect(records).toHaveLength(1);
	expect(branches).toContain(records[0]!.from);
	expect(records[0]).toMatchObject({
		into: (await git(leadPath, 'branch', '--show-current')).stdout.trim(),
		conflicts: ['out/shared.txt'],
		agent: [],
	});
	await delay(3000);
	expect(
		(await client.snapshot()).records.some(
			(r) => r.event.kind === 'turn.started' && r.event.crew?.kind === 'branch-report'
		)
	).toBe(false);
	await client.command({ kind: 'shutdown' });
	await until(async () =>
		(await client.snapshot().catch(() => null)) === null ? true : undefined
	);
}, 300_000);

// spec/crew#parts: one task per crew member; its next part goes into the same task and session after the crew tree is merged in.
const twoDevelopers: CrewTemplate = {
	schemaVersion: 1,
	id: 'two-dev',
	name: 'Two developers',
	builtin: false,
	root: {
		id: 'root',
		name: 'Foreman',
		template: 'foreman-default',
		agents: [
			{ id: 'a', name: 'A', template: 'developer' },
			{ id: 'b', name: 'B', template: 'developer' },
		],
	},
};
/** One scripted foreman turn: waits for the foreman to be idle, sends `text`, returns the assistant text of that very turn. */
async function call(client: HostClient, text: string) {
	await until(async () => {
		const records = (await client.snapshot()).records;
		const last = records.findLast((r) => ['turn.started', 'turn.completed'].includes(r.event.kind));
		return !last || last.event.kind === 'turn.completed' ? true : undefined;
	}, 60_000);
	const before = (await client.snapshot()).records.at(-1)!.seq;
	await client.command({ kind: 'prompt', text });
	const started = await until(
		async () =>
			(await client.snapshot()).records.find(
				(r) => r.seq > before && r.event.kind === 'turn.started' && r.event.text === text
			),
		60_000
	);
	const done = await until(
		async () =>
			(await client.snapshot()).records.find(
				(r) => r.seq > started.seq && r.event.kind === 'turn.completed'
			),
		120_000
	);
	return turnText((await client.snapshot()).records, done.seq);
}
const reportOf = (client: HostClient, title: string) =>
	until(
		async () =>
			(await client.snapshot()).records.find(
				(r) => r.event.kind === 'crew.report' && r.event.report.title === title
			) as
				| (EventRecord & {
						event: {
							kind: 'crew.report';
							report: { taskId: string; files: number; additions: number };
						};
				  })
				| undefined,
		120_000
	);
const memberTasks = async (store: SessionStore, task: AgentTask, nodeId: string) =>
	(
		await Promise.all(
			(
				await (
					await import('node:fs/promises')
				).readdir(join(store.root, 'projects', task.projectId, 'tasks'))
			).map((id) => store.task({ projectId: task.projectId, id }).catch(() => null))
		)
	).filter((item) => item?.crewNodeId === nodeId);
async function twoDeveloperCrew() {
	const fixture = await setup('default', twoDevelopers);
	const { client } = await launch(fixture.store, fixture.task);
	await client.command({
		kind: 'prompt',
		text: '@call propose_plan {"parts":[{"title":"A first","agent":"A","prompt":"@write shared.txt one","files":[]},{"title":"B part","agent":"B","prompt":"@write shared.txt two","files":[]}]}',
	});
	const requested = await event(client, 'crew.plan.requested');
	await client.command({
		kind: 'decidePlan',
		decision: { id: requested.event.plan.id, approved: true, parts: null },
	});
	await idle(client, requested.seq);
	// Part 1 of A, then B rewrites the same line on top of it: both squashed into the foreman's tree.
	let text = await call(
		client,
		'@call create_worker_task {"agent":"A","title":"A first","prompt":"@write shared.txt one"}'
	);
	expect(text).toContain('"status":"queued"');
	const first = await reportOf(client, 'A first'),
		aKey = { projectId: fixture.task.projectId, id: first.event.report.taskId };
	text = await call(client, `@call accept_task {"taskId":"${aKey.id}"}`);
	expect(text).toContain('"accepted":true');
	await call(
		client,
		'@call create_worker_task {"agent":"B","title":"B part","prompt":"@write shared.txt two"}'
	);
	const b = await reportOf(client, 'B part');
	text = await call(client, `@call accept_task {"taskId":"${b.event.report.taskId}"}`);
	expect(text).toContain('"accepted":true');
	expect(await readFile(join(fixture.repo, 'shared.txt'), 'utf8')).toBe('two\n');
	return { ...fixture, client, aKey };
}
it('gives a member its next part in the same task and session: crew tree merged in, the part alone in its diff and its commit (spec/crew#parts)', async () => {
	const { store, task, repo, client, aKey } = await twoDeveloperCrew();
	const aPath = (await store.projectForTask(aKey)).path;
	// Between parts the member's task is completed; a prompt to it names the way to the next part.
	expect((await store.task(aKey)).status).toBe('completed');
	let text = await call(client, `@call prompt_task {"taskId":"${aKey.id}","text":"more"}`);
	expect(text).toMatch(/was accepted.*create_worker_task/s);
	// A plain merge of the crew tree would meet A's accepted line under B's edit; the sync fast-forwards it instead.
	text = await call(
		client,
		'@call create_worker_task {"agent":"A","title":"A second","prompt":"@write a2.txt second"}'
	);
	expect(text).toContain(`"taskId":"${aKey.id}"`);
	expect(text).toContain('"part":2');
	expect(text).toContain('"continued":true');
	expect(
		(await client.snapshot()).records.find((r) => r.event.kind === 'crew.part.started')?.event
	).toMatchObject({ taskId: aKey.id, name: 'A', title: 'A second', part: 2 });
	const second = await reportOf(client, 'A second');
	// The part's report and diff hold only its own file: neither part 1 nor B's line that came in with the crew tree.
	expect(second.event.report).toMatchObject({ taskId: aKey.id, files: 1, additions: 1 });
	expect(await readFile(join(aPath, 'shared.txt'), 'utf8')).toBe('two\n');
	text = await call(
		client,
		`@call read_diff {"taskId":"${aKey.id}"}\n@call task_status {"taskId":"${aKey.id}"}`
	);
	expect(text).toContain('"path":"a2.txt"');
	expect(text).not.toContain('"path":"shared.txt"');
	expect(text).toContain('"part":2');
	const worker = await store.task(aKey);
	expect(worker.title).toBe('A second');
	expect(worker.changeBase).toBeGreaterThan(0);
	// A second part while this one is open is refused with the way to change it.
	text = await call(
		client,
		'@call create_worker_task {"agent":"A","title":"A third","prompt":"x"}'
	);
	expect(text).toMatch(/works on part «A second».*prompt_task/s);
	text = await call(client, `@call accept_task {"taskId":"${aKey.id}"}`);
	expect(text).toContain('"accepted":true');
	// One task and one session for A; one commit per accepted part, the second without the first's changes.
	expect((await memberTasks(store, task, 'a')).length).toBe(1);
	const starts = (await store.journal(aKey)).records.filter(
		(r) => r.event.kind === 'session.started'
	);
	expect(
		new Set(starts.map((r) => r.event.kind === 'session.started' && r.event.sessionId)).size
	).toBe(1);
	expect((await history(repo)).map((item) => [item.parents, item.subject])).toEqual([
		[1, 'feat: [Couriers] A second'],
		[1, 'feat: [Couriers] B part'],
		[1, 'feat: [Couriers] A first'],
		[0, 'feat: [Couriers] seed'],
	]);
	expect((await git(repo, 'show', '--format=', '--name-only', 'HEAD')).stdout.trim()).toBe(
		'a2.txt'
	);
	expect(await readFile(join(repo, 'shared.txt'), 'utf8')).toBe('two\n');
	await client.command({ kind: 'shutdown' });
	await until(async () =>
		(await client.snapshot().catch(() => null)) === null ? true : undefined
	);
}, 400_000);
it('a conflict bringing the crew tree into a member waits for the human; the part starts after «Finish merge» (spec/crew#parts)', async () => {
	const { store, repo, client, aKey } = await twoDeveloperCrew();
	const aPath = (await store.projectForTask(aKey)).path;
	// The human worked with A after acceptance, on the line B rewrote: a real conflict, not the accepted part against itself.
	await writeFile(join(aPath, 'shared.txt'), 'mine\n');
	await git(aPath, 'commit', '-q', '-am', 'by hand');
	let text = await call(
		client,
		'@call create_worker_task {"agent":"A","title":"A second","prompt":"@write a2.txt second"}'
	);
	expect(text).toContain('"status":"needs-you"');
	expect(text).toContain('"conflicts":["shared.txt"]');
	expect((await store.task(aKey)).status).toBe('needs-you');
	const gitFile = async (name: string) =>
		(await git(aPath, 'rev-parse', '--path-format=absolute', '--git-path', name)).stdout.trim();
	expect((await stat(await gitFile('MERGE_HEAD'))).isFile()).toBe(true);
	const records = Object.values(
		JSON.parse(await readFile(join(await store.taskDir(aKey), 'git-merge.json'), 'utf8'))
			.merges as Record<string, { from: string; into: string; conflicts: string[] }>
	);
	expect(records).toEqual([
		{
			from: (await git(repo, 'branch', '--show-current')).stdout.trim(),
			into: (await store.task(aKey)).launch!.branch,
			conflicts: ['shared.txt'],
			agent: [],
		},
	]);
	text = await call(
		client,
		'@call create_worker_task {"agent":"A","title":"A again","prompt":"x"}'
	);
	expect(text).toMatch(/waits for the human/);
	// «Finish merge»: the resolved file committed with the merge message; the held part starts by itself.
	await writeFile(join(aPath, 'shared.txt'), 'mine and two\n');
	await git(aPath, 'add', 'shared.txt');
	await git(aPath, 'commit', '-q', '--no-edit');
	const second = await reportOf(client, 'A second');
	expect(second.event.report).toMatchObject({ taskId: aKey.id, files: 1 });
	expect(await readFile(join(aPath, 'shared.txt'), 'utf8')).toBe('mine and two\n');
	expect(
		JSON.parse(await readFile(join(await store.taskDir(aKey), 'git-merge.json'), 'utf8')).merges
	).toEqual({});
	await client.command({ kind: 'shutdown' });
	await until(async () =>
		(await client.snapshot().catch(() => null)) === null ? true : undefined
	);
}, 400_000);
it('an aborted merge of the crew tree withdraws the part: a service row and a marked prompt to the foreman (spec/crew#parts)', async () => {
	const { store, client, aKey } = await twoDeveloperCrew();
	const aPath = (await store.projectForTask(aKey)).path;
	await writeFile(join(aPath, 'shared.txt'), 'mine\n');
	await git(aPath, 'commit', '-q', '-am', 'by hand');
	const text = await call(
		client,
		'@call create_worker_task {"agent":"A","title":"A second","prompt":"@write a2.txt second"}'
	);
	expect(text).toContain('"status":"needs-you"');
	// «Abort merge»: the part is withdrawn, A is back at its accepted part.
	await git(aPath, 'merge', '--abort');
	const dropped = await event(client, 'crew.part.dropped');
	expect(dropped.event).toMatchObject({ taskId: aKey.id, name: 'A', title: 'A second', part: 2 });
	const marked = await until(async () =>
		(await client.snapshot()).records.find(
			(r) => r.event.kind === 'turn.started' && r.event.crew?.kind === 'part-dropped'
		)
	);
	expect(marked.event.kind === 'turn.started' && marked.event.crew).toEqual({
		kind: 'part-dropped',
		taskId: aKey.id,
		agent: 'A',
		part: 2,
	});
	expect(marked.event.kind === 'turn.started' && marked.event.text).toContain('did not start');
	await until(async () => ((await store.task(aKey)).status === 'completed' ? true : undefined));
	expect((await store.task(aKey)).title).toBe('A first');
	const workers = JSON.parse(
		await readFile(
			join(await store.taskDir((await client.snapshot()).key), 'crew-workers.json'),
			'utf8'
		)
	).workers as { taskId: string; part?: number; acceptedAt?: string; next?: unknown }[];
	expect(workers.find((item) => item.taskId === aKey.id)).toMatchObject({
		part: 1,
		acceptedAt: expect.any(String),
	});
	expect(workers.find((item) => item.taskId === aKey.id)?.next).toBeUndefined();
	await client.command({ kind: 'shutdown' });
	await until(async () =>
		(await client.snapshot().catch(() => null)) === null ? true : undefined
	);
}, 400_000);
it("a lead's next part reports its branch at once when it assigns nothing, and after acceptance when it does (spec/crew#parts)", async () => {
	const { store, task } = await setup('default', leadCrew(false));
	const { client } = await launch(store, task);
	await client.command({
		kind: 'prompt',
		text: '@call propose_plan {"parts":[{"title":"UI branch","agent":"UI lead","prompt":"lead prompt","files":["out/**"]}]}',
	});
	const requested = await event(client, 'crew.plan.requested');
	await client.command({
		kind: 'decidePlan',
		decision: { id: requested.event.plan.id, approved: true, parts: null },
	});
	await idle(client, requested.seq);
	await call(
		client,
		`@call create_worker_task ${JSON.stringify({ agent: 'UI lead', title: 'UI branch', prompt: leadPrompt('out/a/a.txt', 'out/b/b.txt'), files: ['out/**'] })}`
	);
	const branchReports = async () =>
		(await client.snapshot()).records
			.filter((r) => r.event.kind === 'turn.started' && r.event.crew?.kind === 'branch-report')
			.map((r) =>
				r.event.kind === 'turn.started' && r.event.crew?.kind === 'branch-report'
					? r.event.crew.report
					: null
			)!;
	await until(async () => ((await branchReports()).length === 1 ? true : undefined), 120_000);
	const leadKey = { projectId: task.projectId, id: (await branchReports())[0]!.taskId };
	let text = await call(client, `@call accept_task {"taskId":"${leadKey.id}"}`);
	expect(text).toContain('"accepted":true');
	// Part 2 assigns nothing: its one turn ends and the branch report goes up at once, with no changes of its own.
	text = await call(
		client,
		'@call create_worker_task {"agent":"UI lead","title":"UI check","prompt":"Nothing to change this time."}'
	);
	expect(text).toContain('"continued":true');
	await until(async () => ((await branchReports()).length === 2 ? true : undefined), 120_000);
	expect((await branchReports())[1]).toMatchObject({
		taskId: leadKey.id,
		title: 'UI check',
		files: 0,
	});
	text = await call(client, `@call accept_task {"taskId":"${leadKey.id}"}`);
	expect(text).toContain('"accepted":true');
	// Part 3 gives A its next part: the first turn ends with A open, so the report waits for A's acceptance and carries its file.
	const lead = (await store.journal(leadKey)).records.length;
	await call(
		client,
		`@call create_worker_task ${JSON.stringify({ agent: 'UI lead', title: 'UI more', prompt: ['@on-report accept', '@call create_worker_task {"agent":"A","title":"A second","prompt":"@write out/a/a2.txt a2","files":["out/a/**"]}'].join('\n'), files: ['out/**'] })}`
	);
	await until(async () => ((await branchReports()).length === 3 ? true : undefined), 120_000);
	const accepted = (await store.journal(leadKey)).records.filter(
		(r) => r.seq > lead && r.event.kind === 'crew.accepted'
	);
	expect(accepted.length).toBe(1);
	expect((await branchReports())[2]).toMatchObject({
		taskId: leadKey.id,
		title: 'UI more',
		files: 1,
	});
	const third = (await client.snapshot()).records.filter(
		(r) => r.event.kind === 'turn.started' && r.event.crew?.kind === 'branch-report'
	)[2]!;
	expect(Date.parse(third.at)).toBeGreaterThanOrEqual(Date.parse(accepted[0]!.at));
	await client.command({ kind: 'shutdown' });
	await until(async () =>
		(await client.snapshot().catch(() => null)) === null ? true : undefined
	);
}, 400_000);

it('lets the foreman compose its crew in the plan: the person edits it, approval writes it into the task, the worker starts from it (spec/crew#compose)', async () => {
	const foremanOnly: CrewTemplate = {
		schemaVersion: 1,
		id: 'compose',
		name: 'Crew',
		builtin: true,
		root: { id: 'root', name: 'Foreman', template: 'foreman-default' },
	};
	const { store, task: created } = await setup('default', foremanOnly);
	const task = await store.updateTask(created, {
		crew: {
			...created.crew!,
			// No reviewer template in the library, so one developer is a whole crew (spec/crew#compose).
			compose: crewPalette(
				builtinAgentTemplates.filter((template) => template.role !== 'reviewer'),
				{ lookup: templateLookup([]), defaultProvider: 'claude' },
				[]
			),
		},
	});
	const { client } = await launch(store, task);
	const part =
		'{"title":"Write output","agent":"API","prompt":"@write out/result.txt done","files":["out/**"]}';
	await client.command({ kind: 'prompt', text: `@call propose_plan {"parts":[${part}]}` });
	let done = await idle(client, 0);
	expect(turnText((await client.snapshot()).records, done.seq)).toMatch(
		/pass crew with at least one agent/
	);
	await client.command({
		kind: 'prompt',
		text: `@call propose_plan {"crew":[{"name":"API","template":"Developer","summary":"Writes the output","zone":["out/**"]}],"parts":[${part}]}`,
	});
	const requested = await event(client, 'crew.plan.requested');
	const proposed = requested.event.plan.crew!;
	expect(proposed.map((agent) => [agent.name, agent.role, agent.template, agent.zone])).toEqual([
		['API', 'developer', 'developer', ['out/**']],
	]);
	expect((await store.task(task)).crew!.root.agents).toEqual([]);
	// The person renames the agent in the editor; the part follows the new name.
	const crew = [{ ...proposed[0]!, name: 'Backend' }],
		parts = [{ ...requested.event.plan.parts[0]!, agent: 'Backend' }];
	await client.command({
		kind: 'decidePlan',
		decision: { id: requested.event.plan.id, approved: true, parts, crew },
	});
	const resolved = await event(client, 'crew.plan.resolved', requested.seq);
	expect(resolved.event.crew?.[0]?.name).toBe('Backend');
	done = await idle(client, requested.seq);
	expect(turnText((await client.snapshot()).records, done.seq)).toContain(
		'The human edited your crew. Your agents: `Backend`'
	);
	const saved = (await store.task(task)).crew!;
	expect(saved.compose).toBeUndefined();
	expect(saved.root.agents.map((agent) => agent.name)).toEqual(['Backend']);
	await client.command({
		kind: 'prompt',
		text: `@call propose_plan {"crew":[{"name":"X","template":"Developer"}],"parts":[${part}]}`,
	});
	done = await idle(client, done.seq);
	expect(turnText((await client.snapshot()).records, done.seq)).toMatch(/already set/);
	await client.command({
		kind: 'prompt',
		text: '@call create_worker_task {"agent":"Backend","title":"Write output","prompt":"@write out/result.txt done","files":["out/**"]}',
	});
	const worker = await event(client, 'crew.worker.created');
	expect(worker.event).toMatchObject({ name: 'Backend', nodeId: saved.root.agents[0]!.id });
	expect(
		(await store.task({ projectId: task.projectId, id: worker.event.taskId })).crewNodeId
	).toBe(saved.root.agents[0]!.id);
	await client.command({ kind: 'shutdown' });
	await until(async () =>
		(await client.snapshot().catch(() => null)) === null ? true : undefined
	);
}, 240_000);
