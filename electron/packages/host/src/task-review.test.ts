import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SessionStore, atomicJson } from '@brigadir/persistence';
import {
	builtinAgentTemplates,
	crewPalette,
	planFeedbackPrompt,
	resolveCrewAgent,
	templateLookup,
	type EventRecord,
	type TaskKey,
} from '@brigadir/core';
import { connectHost, readIdentity, type HostClient } from './index';
import { readSnapshots } from '@brigadir/git';

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
async function setup(title: string) {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-task-review-'));
	cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
	// Reviewer hosts are detached children of the task's host: stop them with the fixture tree.
	cleanup.push(async () => {
		await run('pkill', ['-f', root]).catch(() => {});
	});
	const repo = join(root, 'repo');
	await mkdir(repo);
	await git(repo, 'init', '-q', '-b', 'main');
	await writeFile(join(repo, 'README.md'), 'hello\n');
	await git(repo, 'add', '-A');
	await git(repo, 'commit', '-q', '-m', 'seed');
	const store = await SessionStore.at(join(root, 'data'));
	const project = await store.addProject(repo);
	const task = await store.createTask(project.id, title, 'claude', 'gui', title);
	return { repo, store, task };
}
async function launch(store: SessionStore, key: TaskKey) {
	return (await launchHost(store, key)).client;
}
/** The task's host and its client; `child` lets a test kill the host as a crash would. */
async function launchHost(store: SessionStore, key: TaskKey, scenario: string[] = ['crew']) {
	const config = join(await store.taskDir(key), 'config.json');
	await atomicJson(config, {
		schemaVersion: 1,
		dataDir: store.root,
		key,
		mcpEntry: resolve('apps/desktop/out/services/mcp-relay'),
		adapter: {
			command: process.execPath,
			args: [resolve('packages/transport/fixtures/agent.mjs'), ...scenario],
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
		if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
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
	return { client, child };
}
const find = (client: HostClient, test: (record: EventRecord) => boolean, timeout = 60_000) =>
	until(async () => (await client.snapshot()).records.find(test), timeout);
const reviewer = resolveCrewAgent(
	{ id: 'reviewer', name: 'Reviewer', template: 'reviewer', provider: 'claude' },
	{ lookup: templateLookup([...builtinAgentTemplates]), defaultProvider: 'claude' },
	[],
	false
);

it('reviews a task inside it: one read, the agent fixes once, the closure check passes, a later change outdates it (spec/reviews#loop)', async () => {
	const { repo, store, task } = await setup('Write the output');
	const client = await launch(store, task);
	await client.command({ kind: 'prompt', text: '@write out/result.txt done' });
	await find(client, (r) => r.event.kind === 'turn.completed');
	// The agent offers the review: a card, and the call returns at once.
	await client.command({
		kind: 'prompt',
		text: '@call propose_review {"summary":"The output file is written."}',
	});
	const proposed = await find(client, (r) => r.event.kind === 'review.proposed');
	expect(proposed.event).toEqual({
		kind: 'review.proposed',
		summary: 'The output file is written.',
	});
	await find(client, (r) => r.seq > proposed.seq && r.event.kind === 'turn.completed');
	await client.command({
		kind: 'startReview',
		reviewers: [reviewer],
		who: { kind: 'agent' },
		instructions: 'Look at the output.',
		guidance: '\n\nInstructions from the person for this review:\nLook at the output.',
	});
	const started = await find(client, (r) => r.event.kind === 'task-review.started');
	expect(started.event).toMatchObject({
		point: 'pre-pr',
		startedBy: 'person',
		reviewers: ['Reviewer'],
	});
	// The reviewer is a read-only worker of the task: no setup, its own worktree, the task as its crew.
	const created = await find(
		client,
		(r) => r.event.kind === 'crew.worker.created' && r.event.name === 'Reviewer'
	);
	const reviewerTask = await store.task({
		projectId: task.projectId,
		id: (created.event as { taskId: string }).taskId,
	});
	expect(reviewerTask).toMatchObject({
		readOnlyAgent: true,
		crewTaskId: task.id,
		parentTaskId: task.id,
		title: 'reviews the changes',
	});
	expect(reviewerTask.launch).toMatchObject({ isolation: 'worktree', setupCommand: '' });
	// The first read: the finding goes to the task's own agent as one batch, and is a thread of its review.
	const read = await find(client, (r) => r.event.kind === 'task-review.findings', 90_000);
	expect(read.event).toMatchObject({ findings: 1, reviewers: ['Reviewer'] });
	const batch = await find(
		client,
		(r) => r.event.kind === 'turn.started' && !!r.event.review && r.seq > started.seq
	);
	expect(batch.event.kind === 'turn.started' && batch.event.text).toContain(
		'Reviewer left 1 finding in the review before the pull request. Fix each one once, or object to it with review_reply'
	);
	const review = JSON.parse(await readFile(join(await store.taskDir(task), 'review.json'), 'utf8'));
	expect(review.comments[0]).toMatchObject({
		author: 'Reviewer · checks Task agent',
		text: 'Round 1: say hello instead',
		anchor: { path: 'out/result.txt' },
		review: { round: 1, reviewer: 'Reviewer' },
	});
	// The reviewer's files were the round's snapshot: the task's uncommitted file is in its worktree.
	const reviewerPath = (await store.projectForTask(reviewerTask)).path;
	expect(await readFile(join(reviewerPath, 'out/result.txt'), 'utf8')).toBe('done\n');
	// The agent's answer ends its turn; the closure check runs by itself and the reviewer closes the finding.
	await find(client, (r) => r.event.kind === 'task-review.answered', 90_000);
	const finished = await find(client, (r) => r.event.kind === 'task-review.finished', 90_000);
	expect(finished.event).toMatchObject({ state: 'passed', point: 'pre-pr' });
	const doc = JSON.parse(
		await readFile(join(await store.taskDir(task), 'task-review.json'), 'utf8')
	);
	expect(doc).toMatchObject({ schemaVersion: 2, proposal: null });
	expect(doc.review).toMatchObject({
		state: 'passed',
		round: 2,
		passes: 1,
		reviewers: ['Reviewer'],
	});
	const closed = JSON.parse(await readFile(join(await store.taskDir(task), 'review.json'), 'utf8'));
	expect(closed.comments[0].review).toMatchObject({ closed: 2 });
	// A later change makes the pass before the PR outdated.
	await client.command({ kind: 'prompt', text: '@write out/other.txt more' });
	const outdated = await find(
		client,
		(r) => r.event.kind === 'task-review.finished' && r.event.state === 'outdated'
	);
	expect(outdated.seq).toBeGreaterThan(finished.seq);
	expect((await git(repo, 'status', '--porcelain')).stdout).toContain('out/');
}, 240_000);

it('an approval with a remark passes at once and keeps the remark with its verdict (spec/reviews#remark)', async () => {
	const { store, task } = await setup('Clean remark');
	const client = await launch(store, task);
	await client.command({ kind: 'prompt', text: '@write out/result.txt done' });
	await find(client, (r) => r.event.kind === 'turn.completed');
	await client.command({
		kind: 'startReview',
		reviewers: [reviewer],
		who: { kind: 'agent' },
		instructions: '',
		guidance: '',
	});
	const started = await find(client, (r) => r.event.kind === 'task-review.started');
	const finished = await find(client, (r) => r.event.kind === 'task-review.finished', 90_000);
	expect(finished.event).toMatchObject({ state: 'passed', point: 'pre-pr' });
	// No finding, no fixing round: the read lists none, and nothing reached the task's agent.
	const records = (await client.snapshot()).records;
	expect(
		records.find((r) => r.seq > started.seq && r.event.kind === 'task-review.findings')?.event
	).toMatchObject({ findings: 0 });
	expect(
		records.some((r) => r.seq > started.seq && r.event.kind === 'turn.started' && !!r.event.review)
	).toBe(false);
	// The remark is stored with the verdict on disk, where the strip reads it after a restart.
	const saved = JSON.parse(
		await readFile(join(await store.taskDir(task), 'crew-reviews.json'), 'utf8')
	);
	const verdicts = saved.reviews.flatMap((item: { verdicts: unknown[] }) => item.verdicts);
	expect(verdicts).toEqual([
		expect.objectContaining({ approved: true, note: 'Ran the output check: it prints done.' }),
	]);
}, 180_000);

it('stops a review: the open round ends, nothing more reaches the agent (spec/reviews#loop)', async () => {
	const { store, task } = await setup('Write the output');
	const client = await launch(store, task);
	await client.command({ kind: 'prompt', text: '@write out/result.txt done' });
	await find(client, (r) => r.event.kind === 'turn.completed');
	await client.command({
		kind: 'startReview',
		reviewers: [reviewer],
		who: { kind: 'agent' },
		instructions: '',
		guidance: '',
	});
	await find(client, (r) => r.event.kind === 'task-review.started');
	await client.command({ kind: 'stopReview' });
	const stopped = await find(client, (r) => r.event.kind === 'task-review.finished');
	expect(stopped.event).toMatchObject({ state: 'stopped' });
	const doc = JSON.parse(
		await readFile(join(await store.taskDir(task), 'task-review.json'), 'utf8')
	);
	expect(doc.review.state).toBe('stopped');
	// A second review may start once the first one stopped.
	await client.command({
		kind: 'startReview',
		reviewers: [reviewer],
		who: { kind: 'agent' },
		instructions: '',
		guidance: '',
	});
	await until(async () =>
		(await client.snapshot()).records.filter((r) => r.event.kind === 'task-review.started')
			.length === 2
			? true
			: undefined
	);
}, 120_000);

it('a finding the closure check keeps open goes to the person, who accepts it (spec/reviews#loop)', async () => {
	const { store, task } = await setup('dispute the output');
	const client = await launch(store, task);
	await client.command({ kind: 'prompt', text: '@write out/result.txt done' });
	await find(client, (r) => r.event.kind === 'turn.completed');
	await client.command({
		kind: 'startReview',
		reviewers: [reviewer],
		who: { kind: 'agent' },
		instructions: '',
		guidance: '',
	});
	const verified = await find(client, (r) => r.event.kind === 'task-review.verified', 120_000);
	expect(verified.event).toMatchObject({ open: 1, introduced: 0, closed: 0 });
	await until(async () => ((await store.task(task)).status === 'needs-you' ? true : undefined));
	const path = join(await store.taskDir(task), 'review.json');
	const comments = JSON.parse(await readFile(path, 'utf8')).comments as {
		id: string;
		review?: { round: number; open?: number };
		replies?: { author: string; text: string }[];
	}[];
	expect(comments).toHaveLength(1);
	expect(comments[0]!.review).toMatchObject({ round: 1, open: 2 });
	expect(comments[0]!.replies?.at(-1)).toMatchObject({
		author: 'Reviewer',
		text: 'Still says done.',
	});
	await client.command({ kind: 'decideReview', decision: 'accept' });
	const finished = await find(client, (r) => r.event.kind === 'task-review.finished', 30_000);
	expect(finished.event).toMatchObject({ state: 'accepted' });
	const accepted = JSON.parse(await readFile(path, 'utf8')).comments[0];
	expect(accepted.review).toMatchObject({ accepted: true });
}, 240_000);

it('the agent asks for a mid-task review; without the app the task’s own provider reviews (spec/reviews#request-tool)', async () => {
	const { store, task } = await setup('Write the output');
	const client = await launch(store, task);
	await client.command({ kind: 'prompt', text: '@write out/result.txt done' });
	await find(client, (r) => r.event.kind === 'turn.completed');
	await client.command({
		kind: 'prompt',
		text: '@call request_review {"reason":"the data layer"}',
	});
	const started = await find(client, (r) => r.event.kind === 'task-review.started');
	expect(started.event).toMatchObject({
		point: 'mid',
		startedBy: 'agent',
		reason: 'the data layer',
		reviewers: ['Claude'],
	});
	await find(client, (r) => r.event.kind === 'task-review.findings', 90_000);
}, 240_000);

// spec/reviews#design: no approval from the code — the reviewer's approve goes through the gate on the real path.
it('refuses the approval of a task with a Figma link until a passed design review covers the round (spec/reviews#design)', async () => {
	const link = 'https://www.figma.com/design/AbC/Client?node-id=412-88';
	const start = async (title: string, seed?: boolean) => {
		const { store, task } = await setup(title);
		const client = await launch(store, task);
		await client.command({ kind: 'prompt', text: `@write out/screen.txt ${link}` });
		await find(client, (r) => r.event.kind === 'turn.completed');
		if (seed) {
			// The author's passed design review, filed on the files as they are now.
			const snapshots = await readSnapshots(store, task);
			const trees = snapshots!.checkpoints.at(-1)!.trees.map(({ scopeId, tree }) => ({
				scopeId,
				tree,
			}));
			await mkdir(join(await store.taskDir(task), 'design'), { recursive: true });
			await atomicJson(join(await store.taskDir(task), 'design', 'design-reviews.json'), {
				schemaVersion: 1,
				reviews: [
					{
						id: 'd1',
						screen: 'Details screen',
						at: new Date().toISOString(),
						state: 'passed',
						verdict: 'passed',
						trees,
						nodes: [
							{
								name: 'Header',
								figma: '412:88',
								state: 'ok',
								rows: [{ property: 'Avatar', expected: '56 px', actual: '56 px', match: true }],
							},
						],
					},
				],
			});
		}
		await client.command({
			kind: 'startReview',
			reviewers: [reviewer],
			who: { kind: 'agent' },
			instructions: '',
			guidance: '',
		});
		const created = await find(
			client,
			(r) => r.event.kind === 'crew.worker.created' && r.event.name === 'Reviewer',
			90_000
		);
		return {
			store,
			task,
			client,
			reviewerKey: { projectId: task.projectId, id: (created.event as { taskId: string }).taskId },
		};
	};
	// Nothing filed: the scripted reviewer approves «clean» work, and the host refuses it.
	const refused = await start('Clean screen');
	const journal = join(await refused.store.taskDir(refused.reviewerKey), 'events.jsonl');
	const said = await until(async () => {
		const text = await readFile(journal, 'utf8').catch(() => '');
		return text.includes('No approval from the code') ? text : undefined;
	}, 90_000);
	expect(said).toContain('no design review was filed');
	expect(said).toContain('[error]');
	expect(
		(await refused.client.snapshot()).records.some((r) => r.event.kind === 'task-review.finished')
	).toBe(false);
	// A passed design review of the state the round reads: the same approval passes.
	const covered = await start('Clean screen', true);
	const finished = await find(
		covered.client,
		(r) => r.event.kind === 'task-review.finished',
		90_000
	);
	expect(finished.event).toMatchObject({ state: 'passed', point: 'pre-pr' });
}, 300_000);

// From the walkthrough's code audit: a review that waits for the agent's turn started only on `turn.completed`.
it('a review waiting for a turn that fails, or for a turn a restart cut off, reads when that turn is over (spec/reviews#start)', async () => {
	/** A review starts while the agent's turn runs `spend 1 <mode>`; `end` ends that turn and returns the client that sees the rest. */
	const readsAfter = async (
		mode: string,
		end: (host: {
			store: SessionStore;
			task: TaskKey;
			child: ChildProcess;
			client: HostClient;
		}) => Promise<HostClient>
	) => {
		const { store, task } = await setup('Write the output');
		const { client, child } = await launchHost(store, task);
		await client.command({ kind: 'prompt', text: '@write out/result.txt done' });
		await find(client, (r) => r.event.kind === 'turn.completed');
		await client.command({ kind: 'prompt', text: `spend 1 ${mode}` });
		await find(
			client,
			(r) => r.event.kind === 'turn.started' && r.event.text === `spend 1 ${mode}`
		);
		await client.command({
			kind: 'startReview',
			reviewers: [reviewer],
			who: { kind: 'agent' },
			instructions: '',
			guidance: '',
		});
		await find(client, (r) => r.event.kind === 'task-review.started');
		const file = join(await store.taskDir(task), 'task-review.json');
		expect(JSON.parse(await readFile(file, 'utf8')).review.state).toBe('waiting');
		const next = await end({ store, task, child, client });
		const read = await find(next, (r) => r.event.kind === 'task-review.findings', 90_000);
		expect(read.event).toMatchObject({ findings: 1, reviewers: ['Reviewer'] });
	};
	// The turn fails: the journal gets `session.failed`, never `turn.completed`.
	await readsAfter('slow fail', async ({ client }) => {
		await find(client, (r) => r.event.kind === 'session.failed');
		return client;
	});
	// The host dies in the middle of the turn; the next host finds the review still waiting.
	await readsAfter('hold', async ({ store, task, child }) => {
		child.kill('SIGKILL');
		await new Promise((done) => child.once('exit', done));
		return (await launchHost(store, task)).client;
	});
}, 360_000);

// spec/reviews#plan-review, seen in the walkthrough (H): a plan reviewer's task was titled `reviews the changes`.
it('a plan review reads the waiting plan; its reviewer’s task says it reviews the plan (spec/reviews#reviewer-sessions)', async () => {
	const { store, task } = await setup('Keep the focus ring');
	const log = join(store.root, 'agents.log');
	const { client } = await launchHost(store, task, ['normal', log]);
	await client.command({ kind: 'prompt', text: 'plan' });
	await find(client, (r) => r.event.kind === 'permission.requested');
	await client.command({
		kind: 'startReview',
		point: 'plan',
		reviewers: [reviewer],
		who: { kind: 'agent' },
		instructions: '',
		guidance: '',
	});
	const created = await find(client, (r) => r.event.kind === 'crew.worker.created');
	expect(created.event).toMatchObject({ name: 'Reviewer', title: 'reviews the plan' });
	const read = await find(client, (r) => r.event.kind === 'task-review.findings', 90_000);
	expect(read.event).toMatchObject({ point: 'plan', findings: 1, gaps: 1 });
}, 180_000);

/** The prompts the fixture agents got, from the log they share. */
const agentPrompts = async (log: string) =>
	(await readFile(log, 'utf8').catch(() => ''))
		.split('\n')
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { event: string; params: unknown })
		.filter((entry) => entry.event === 'prompt')
		.map((entry) => String(entry.params));
const presented = (client: HostClient, n: number) =>
	until(async () =>
		(await client.snapshot()).records.filter((r) => r.event.kind === 'permission.requested')
			.length >= n
			? true
			: undefined
	);

// Seen in the walkthrough (A): the plan reviewer read only the task's first prompt and filed findings for doing what the person asked later.
it('a plan reviewer reads the person’s answers to the plan after the task’s prompt (spec/reviews#plan-inputs)', async () => {
	const { store, task } = await setup('Keep the focus ring');
	const log = join(store.root, 'agents.log');
	const { client } = await launchHost(store, task, ['normal', log]);
	await client.command({ kind: 'prompt', text: 'plan' });
	await presented(client, 1);
	// Chat while the plan waits, then `Plan further…` on the next plan.
	await client.command({ kind: 'prompt', text: 'Is Safari 16 in scope?', steer: true });
	await find(
		client,
		(r) => r.event.kind === 'turn.started' && r.event.text.endsWith('Is Safari 16 in scope?')
	);
	await client.command({ kind: 'prompt', text: 'plan' });
	await presented(client, 2);
	await client.command({
		kind: 'prompt',
		text: planFeedbackPrompt('Cover Edge too'),
		answersPlan: true,
	});
	await presented(client, 3);
	await client.command({
		kind: 'startReview',
		point: 'plan',
		reviewers: [reviewer],
		who: { kind: 'agent' },
		instructions: '',
		guidance: '',
	});
	await find(client, (r) => r.event.kind === 'task-review.findings', 90_000);
	const check = (await agentPrompts(log)).find((text) =>
		text.startsWith('Check the plan of task')
	)!;
	expect(check).toContain('<task_prompt>\nplan\n</task_prompt>');
	expect(check).toContain("These are the person's own words");
	expect(check).toContain(
		'<person_message kind="chat">\nIs Safari 16 in scope?\n</person_message>'
	);
	expect(check.indexOf('Is Safari 16 in scope?')).toBeLessThan(check.indexOf('Cover Edge too'));
	expect(check).toContain(
		'<person_message kind="plan further">\nCover Edge too\n</person_message>'
	);
}, 180_000);

// Seen in the walkthrough (A, question 2): a plan reviewer asked the author while the plan approval held its turn; nobody could answer.
it('a reviewer’s question to an Auto agent held by its plan answers the plan as plan chat does, and the agent presents it again (spec/crew#ask-foreman)', async () => {
	const { store, task } = await setup('Keep the focus ring');
	const lookup = {
		lookup: templateLookup([...builtinAgentTemplates]),
		defaultProvider: 'claude' as const,
	};
	await store.updateTask(task, {
		auto: {
			roles: crewPalette(builtinAgentTemplates, lookup, []).templates,
			budget: { minutes: 40, tokens: 400_000 },
		},
	});
	const log = join(store.root, 'agents.log');
	const { client } = await launchHost(store, task, ['normal', log]);
	await client.command({ kind: 'prompt', text: 'plan' });
	await presented(client, 1);
	await client.command({
		kind: 'prompt',
		text: planFeedbackPrompt('Safari only; ask the author first'),
		answersPlan: true,
	});
	await presented(client, 2);
	await client.command({
		kind: 'startReview',
		point: 'plan',
		reviewers: [reviewer],
		who: { kind: 'agent' },
		instructions: '',
		guidance: '',
	});
	const asked = await find(client, (r) => r.event.kind === 'crew.question.requested', 90_000);
	// The waiting plan is answered with its reject option, and the question is the agent's next turn.
	const plan = (await client.snapshot()).records
		.filter((r) => r.event.kind === 'permission.requested')
		.at(-1)!;
	const rejected = await find(
		client,
		(r) =>
			r.event.kind === 'permission.resolved' &&
			r.event.id === (plan.event as { request: { id: string } }).request.id
	);
	expect(rejected.event).toMatchObject({ optionId: 'reject' });
	const turn = await find(
		client,
		(r) => r.seq > asked.seq && r.event.kind === 'turn.started' && r.event.crew?.kind === 'question'
	);
	expect(turn.event.kind === 'turn.started' && turn.event.text).toContain(
		'Your plan was sent back so that you can answer'
	);
	const answered = await find(client, (r) => r.event.kind === 'crew.question.resolved', 60_000);
	expect(answered.event).toMatchObject({ answeredBy: 'foreman' });
	// The agent presents the plan again, and the reviewer, answered, gives its verdict.
	await presented(client, 3);
	const read = await find(client, (r) => r.event.kind === 'task-review.findings', 90_000);
	expect(read.event).toMatchObject({ point: 'plan', findings: 1 });
}, 240_000);

/** The fixture agents' MCP calls of one tool, from the log they share. */
const crewCalls = async (log: string, name: string) =>
	(await readFile(log, 'utf8').catch(() => ''))
		.split('\n')
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { event: string; params: Record<string, unknown> })
		.filter((entry) => entry.event === 'crew-call' && entry.params.name === name)
		.map(
			(entry) =>
				entry.params as {
					args: unknown;
					result?: { isError?: boolean; content: { text?: string }[] };
				}
		);

// Seen in review-robustness: a solo task's agent had no prompt_task, so its reviewer's question waited five minutes for the person.
it('a solo task’s agent answers its reviewer’s question with prompt_task, and only that (spec/reviews#reviewer-questions)', async () => {
	const { store, task } = await setup('Write the output, ask the author');
	const log = join(store.root, 'agents.log');
	const { client } = await launchHost(store, task, ['crew', log]);
	// prompt_task is the solo agent's from its first session, and it prompts no other task.
	await client.command({
		kind: 'prompt',
		text: '@call prompt_task {"taskId":"another-task","text":"Do this","questionId":"q1"}',
	});
	await find(client, (r) => r.event.kind === 'turn.completed');
	const [refused] = await crewCalls(log, 'prompt_task');
	expect(refused?.result?.isError).toBe(true);
	expect(refused?.result?.content[0]?.text).toContain(
		"prompt_task answers only a question from a reviewer of this task's review."
	);
	await client.command({ kind: 'prompt', text: '@write out/result.txt done' });
	await until(async () =>
		(await client.snapshot()).records.filter((r) => r.event.kind === 'turn.completed').length >= 2
			? true
			: undefined
	);
	await client.command({
		kind: 'startReview',
		reviewers: [reviewer],
		who: { kind: 'agent' },
		instructions: '',
		guidance: '',
	});
	const asked = await find(client, (r) => r.event.kind === 'crew.question.requested', 90_000);
	const turn = await find(
		client,
		(r) => r.seq > asked.seq && r.event.kind === 'turn.started' && r.event.crew?.kind === 'question'
	);
	expect(turn.event.kind === 'turn.started' && turn.event.text).toContain(
		'Answer with prompt_task'
	);
	const answered = await find(client, (r) => r.event.kind === 'crew.question.resolved', 60_000);
	expect(answered.event).toMatchObject({
		answer: 'Yes, it stays: the person asked for it.',
		answeredBy: 'foreman',
	});
	// The reviewer, answered, goes on with its read.
	const read = await find(client, (r) => r.event.kind === 'task-review.findings', 90_000);
	expect(read.event).toMatchObject({ findings: 1 });
	const reviewerCall = (await crewCalls(log, 'ask_foreman'))[0];
	expect(reviewerCall?.result?.content[0]?.text).toContain('Yes, it stays');
	// With the review live: the real questionId with another task is refused, the reviewer's own answer goes through.
	const [, wrongTask, own] = await crewCalls(log, 'prompt_task');
	expect(wrongTask?.args).toMatchObject({ taskId: 'another-task' });
	expect(wrongTask?.result?.isError).toBe(true);
	expect(wrongTask?.result?.content[0]?.text).toContain('prompt_task answers only');
	expect(own?.result?.isError).toBeFalsy();
	// A question already answered takes no second answer.
	const { question } = asked.event as { question: { id: string; workerTaskId: string } };
	await client.command({
		kind: 'prompt',
		text: `@call prompt_task {"taskId":"${question.workerTaskId}","text":"Again","questionId":"${question.id}"}`,
	});
	const again = await until(async () => (await crewCalls(log, 'prompt_task'))[3]);
	expect(again.result?.isError).toBe(true);
	expect(again.result?.content[0]?.text).toContain('prompt_task answers only');
	expect(
		(await client.snapshot()).records.filter((r) => r.event.kind === 'crew.question.resolved')
	).toHaveLength(1);
}, 240_000);

it('a reviewer’s question to a solo agent held by its plan answers the plan as plan chat does, and the agent presents it again (spec/reviews#reviewer-questions)', async () => {
	const { store, task } = await setup('Keep the focus ring');
	const log = join(store.root, 'agents.log');
	const { client } = await launchHost(store, task, ['normal', log]);
	await client.command({ kind: 'prompt', text: 'plan' });
	await presented(client, 1);
	await client.command({
		kind: 'prompt',
		text: planFeedbackPrompt('Safari only; ask the author first'),
		answersPlan: true,
	});
	await presented(client, 2);
	// Something waits in the queue: the question runs in front of it.
	await client.command({ kind: 'prompt', text: 'Then update the changelog.' });
	await client.command({
		kind: 'startReview',
		point: 'plan',
		reviewers: [reviewer],
		who: { kind: 'agent' },
		instructions: '',
		guidance: '',
	});
	const asked = await find(client, (r) => r.event.kind === 'crew.question.requested', 90_000);
	const plan = (await client.snapshot()).records
		.filter((r) => r.event.kind === 'permission.requested')
		.at(-1)!;
	const rejected = await find(
		client,
		(r) =>
			r.event.kind === 'permission.resolved' &&
			r.event.id === (plan.event as { request: { id: string } }).request.id
	);
	expect(rejected.event).toMatchObject({ optionId: 'reject' });
	const turn = await find(
		client,
		(r) => r.seq > asked.seq && r.event.kind === 'turn.started' && r.event.crew?.kind === 'question'
	);
	expect(turn.event.kind === 'turn.started' && turn.event.text).toContain(
		'Your plan was sent back so that you can answer'
	);
	// No turn of the queued prompt ran between the question and its turn.
	expect(
		(await client.snapshot()).records.some(
			(r) =>
				r.seq > asked.seq &&
				r.seq < turn.seq &&
				r.event.kind === 'turn.started' &&
				r.event.text.includes('Then update the changelog.')
		)
	).toBe(false);
	const answered = await find(client, (r) => r.event.kind === 'crew.question.resolved', 60_000);
	expect(answered.event).toMatchObject({ answeredBy: 'foreman' });
	await presented(client, 3);
	const read = await find(client, (r) => r.event.kind === 'task-review.findings', 90_000);
	expect(read.event).toMatchObject({ point: 'plan', findings: 1 });
}, 240_000);

it('a reviewer’s question the solo agent leaves unanswered goes to the person after the wait (spec/crew#ask-foreman)', async () => {
	const { store, task } = await setup('Write the output, ask the author, unanswered');
	const previous = process.env.BRIGADIR_TEST_QUESTION_ESCALATION_MS;
	process.env.BRIGADIR_TEST_QUESTION_ESCALATION_MS = '3000';
	cleanup.push(async () => {
		if (previous === undefined) delete process.env.BRIGADIR_TEST_QUESTION_ESCALATION_MS;
		else process.env.BRIGADIR_TEST_QUESTION_ESCALATION_MS = previous;
	});
	const { client } = await launchHost(store, task);
	await client.command({ kind: 'prompt', text: '@write out/result.txt done' });
	await find(client, (r) => r.event.kind === 'turn.completed');
	await client.command({
		kind: 'startReview',
		reviewers: [reviewer],
		who: { kind: 'agent' },
		instructions: '',
		guidance: '',
	});
	const asked = await find(client, (r) => r.event.kind === 'crew.question.requested', 90_000);
	// The agent's turn with the question ends without an answer.
	await find(
		client,
		(r) => r.seq > asked.seq && r.event.kind === 'turn.started' && r.event.crew?.kind === 'question'
	);
	const escalated = await find(client, (r) => r.event.kind === 'crew.question.escalated', 60_000);
	expect(
		(await client.snapshot()).records.some(
			(r) => r.seq < escalated.seq && r.event.kind === 'crew.question.resolved'
		)
	).toBe(false);
	const question = asked.event as { question: { workerTaskId: string } };
	await until(async () =>
		(await store.task({ projectId: task.projectId, id: question.question.workerTaskId })).status ===
		'needs-you'
			? true
			: undefined
	);
}, 240_000);

/** The reviewer's task of the review that `client` runs, once the crew created it. */
async function reviewerOf(client: HostClient, task: TaskKey, name = 'Reviewer') {
	const created = await find(
		client,
		(r) => r.event.kind === 'crew.worker.created' && r.event.name === name
	);
	return { projectId: task.projectId, id: (created.event as { taskId: string }).taskId };
}
/** The reviewer's own journal, read from disk. */
const journalOf = async (store: SessionStore, key: TaskKey) =>
	(await readFile(join(await store.taskDir(key), 'events.jsonl'), 'utf8').catch(() => ''))
		.split('\n')
		.filter(Boolean)
		.map((line) => JSON.parse(line) as EventRecord);
/** The fixture reviewer holds its first read of a «hold the verdict» task until its turn is cancelled: it logs `held` once it waits. */
const holding = (log: string, n = 1) =>
	until(async () =>
		(await readFile(log, 'utf8').catch(() => ''))
			.split('\n')
			.filter((line) => line.includes('"event":"held"')).length >= n
			? true
			: undefined
	);

// From the walkthrough's code audit: a check whose reviewer turn was cancelled was never sent again, and the review stood still.
it('a check whose reviewer turn was cancelled goes to the reviewer again (spec/crew#reviewer)', async () => {
	const { store, task } = await setup('hold the verdict');
	const log = join(store.root, 'agents.log');
	const { client } = await launchHost(store, task, ['crew', log]);
	await client.command({ kind: 'prompt', text: '@write out/result.txt done' });
	await find(client, (r) => r.event.kind === 'turn.completed');
	await client.command({
		kind: 'startReview',
		reviewers: [reviewer],
		who: { kind: 'agent' },
		instructions: '',
		guidance: '',
	});
	const key = await reviewerOf(client, task);
	await holding(log);
	// `Stop now` at the budget, or a stop in the reviewer's chat: its turn ends cancelled with no verdict.
	const own = await connectHost((await readIdentity(store, key))!);
	cleanup.push(async () => own.close());
	await own.command({ kind: 'cancel' });
	const read = await find(client, (r) => r.event.kind === 'task-review.findings', 90_000);
	expect(read.event).toMatchObject({ findings: 1, reviewers: ['Reviewer'] });
	const turns = (await journalOf(store, key)).filter(
		(r) => r.event.kind === 'turn.started' && r.event.text.startsWith('Check task')
	);
	expect(turns).toHaveLength(2);

	// The reviewer's host dies in the middle of a check: a new host of the reviewer gets it.
	const dead = await setup('hold the verdict');
	const deadLog = join(dead.store.root, 'agents.log');
	const second = (await launchHost(dead.store, dead.task, ['crew', deadLog])).client;
	await second.command({ kind: 'prompt', text: '@write out/result.txt done' });
	await find(second, (r) => r.event.kind === 'turn.completed');
	await second.command({
		kind: 'startReview',
		reviewers: [reviewer],
		who: { kind: 'agent' },
		instructions: '',
		guidance: '',
	});
	const deadKey = await reviewerOf(second, dead.task);
	await holding(deadLog);
	process.kill((await readIdentity(dead.store, deadKey))!.pid, 'SIGKILL');
	const again = await find(second, (r) => r.event.kind === 'task-review.findings', 90_000);
	expect(again.event).toMatchObject({ findings: 1 });
	expect((await journalOf(dead.store, deadKey)).some((r) => r.event.kind === 'host.stopped')).toBe(
		true
	);
}, 300_000);

// From the walkthrough's code audit: the first verdict of a round with two reviewers waited in memory; a restart before the second lost it.
it('a restart between the verdicts of two reviewers keeps the first one’s findings in the batch (spec/crew#reviewer)', async () => {
	const second = resolveCrewAgent(
		{ id: 'second', name: 'Second', template: 'reviewer', provider: 'claude' },
		{ lookup: templateLookup([...builtinAgentTemplates]), defaultProvider: 'claude' },
		[],
		false
	);
	const { store, task } = await setup('hold the verdict');
	const log = join(store.root, 'agents.log');
	const first = await launchHost(store, task, ['crew', log]);
	await first.client.command({ kind: 'prompt', text: '@write out/result.txt done' });
	await find(first.client, (r) => r.event.kind === 'turn.completed');
	await first.client.command({
		kind: 'startReview',
		reviewers: [reviewer, second],
		who: { kind: 'agent' },
		instructions: '',
		guidance: '',
	});
	const keys = [
		await reviewerOf(first.client, task),
		await reviewerOf(first.client, task, 'Second'),
	];
	// One reviewer holds its read; the other's verdict is in.
	await holding(log);
	const runs = join(await store.taskDir(task), 'crew-reviews.json');
	await until(async () => {
		const doc = JSON.parse(await readFile(runs, 'utf8').catch(() => '{"reviews":[]}'));
		return doc.reviews.some((run: { verdicts: unknown[] }) => run.verdicts.length === 1)
			? true
			: undefined;
	});
	first.child.kill('SIGKILL');
	await new Promise((done) => first.child.once('exit', done));
	const client = (await launchHost(store, task, ['crew', log])).client;
	// The held reviewer's turn is cancelled; its check goes out again and it answers.
	for (const key of keys) {
		const own = await connectHost((await readIdentity(store, key))!);
		cleanup.push(async () => own.close());
		await own.command({ kind: 'cancel' });
	}
	const batch = await find(
		client,
		(r) => r.event.kind === 'turn.started' && !!r.event.review,
		90_000
	);
	expect(batch.event.kind === 'turn.started' && batch.event.text).toMatch(
		/left 2 findings in the review before the pull request/
	);
}, 300_000);

/** Where a reviewer's worktree lives and its branch, read while it has them. */
async function reviewerTree(store: SessionStore, key: TaskKey) {
	const reviewerTask = await until(async () => {
		const value = await store.task(key);
		return value.preparation?.state === 'ready' && value.worktreeBranch ? value : undefined;
	});
	return {
		path: (await store.projectForTask(reviewerTask)).path,
		branch: reviewerTask.worktreeBranch!,
	};
}
const gone = async (repo: string, tree: { path: string; branch: string }) =>
	!(await readFile(join(tree.path, 'README.md'), 'utf8').then(
		() => true,
		() => false
	)) &&
	!(await git(repo, 'worktree', 'list')).stdout.includes(tree.path) &&
	!(await git(repo, 'branch', '--list', tree.branch)).stdout.trim();

// Decision of the walkthrough (I, question 7): every review left a worktree and a branch in the person's repo until the archive.
it('an ended review’s reviewer gives up its worktree and branch, keeping its task and log; leftovers go at the next start (spec/reviews#reviewer-sessions)', async () => {
	const { repo, store, task } = await setup('Clean output');
	const client = await launch(store, task);
	await client.command({ kind: 'prompt', text: '@write out/result.txt done' });
	await find(client, (r) => r.event.kind === 'turn.completed');
	await client.command({
		kind: 'startReview',
		reviewers: [reviewer],
		who: { kind: 'agent' },
		instructions: '',
		guidance: '',
	});
	const key = await reviewerOf(client, task);
	const tree = await reviewerTree(store, key);
	expect(await gone(repo, tree)).toBe(false);
	const finished = await find(client, (r) => r.event.kind === 'task-review.finished', 90_000);
	expect(finished.event).toMatchObject({ state: 'passed' });
	await until(async () => ((await gone(repo, tree)) ? true : undefined), 60_000);
	// The record and the log stay: the reviewer's task, its journal, and the review on disk.
	expect((await store.task(key)).readOnlyAgent).toBe(true);
	expect((await journalOf(store, key)).some((r) => r.event.kind === 'turn.started')).toBe(true);
	expect((await git(repo, 'branch', '--list')).stdout).toContain('main');

	// A review that ended while no host ran (here: marked ended on disk) leaves its reviewer's tree; the next host removes it.
	const leftover = async (touch?: (tree: { path: string; branch: string }) => Promise<unknown>) => {
		const left = await setup('hold the verdict');
		const log = join(left.store.root, 'agents.log');
		const first = await launchHost(left.store, left.task, ['crew', log]);
		await first.client.command({ kind: 'prompt', text: '@write out/result.txt done' });
		await find(first.client, (r) => r.event.kind === 'turn.completed');
		await first.client.command({
			kind: 'startReview',
			reviewers: [reviewer],
			who: { kind: 'agent' },
			instructions: '',
			guidance: '',
		});
		const key = await reviewerOf(first.client, left.task);
		const tree = await reviewerTree(left.store, key);
		await holding(log);
		first.child.kill('SIGKILL');
		await new Promise((done) => first.child.once('exit', done));
		await touch?.(tree);
		const file = join(await left.store.taskDir(left.task), 'task-review.json');
		const doc = JSON.parse(await readFile(file, 'utf8'));
		await atomicJson(file, {
			...doc,
			review: { ...doc.review, state: 'stopped', finishedAt: new Date().toISOString() },
		});
		const client = (await launchHost(left.store, left.task, ['crew', log])).client;
		return { ...left, key, tree, client };
	};
	const plain = await leftover();
	// The reviewer's host, still holding its read, stops first.
	await until(async () => ((await gone(plain.repo, plain.tree)) ? true : undefined), 60_000);
	expect((await plain.store.task(plain.key)).worktreeBranch).toBeUndefined();
	// Someone's edit in the reviewer's worktree keeps the worktree and its branch.
	const edited = await leftover((tree) => writeFile(join(tree.path, 'notes.txt'), 'mine\n'));
	await find(edited.client, (r) => r.event.kind === 'session.started');
	await delay(3000);
	expect(await readFile(join(edited.tree.path, 'notes.txt'), 'utf8')).toBe('mine\n');
	expect((await git(edited.repo, 'branch', '--list', edited.tree.branch)).stdout.trim()).not.toBe(
		''
	);
	// A commit only the reviewer's branch holds keeps the branch; the worktree goes.
	const committed = await leftover((tree) =>
		git(tree.path, 'commit', '-q', '--allow-empty', '-m', 'mine')
	);
	await until(
		async () =>
			(await git(committed.repo, 'worktree', 'list')).stdout.includes(committed.tree.path)
				? undefined
				: true,
		60_000
	);
	await delay(1000);
	expect(
		(await git(committed.repo, 'branch', '--list', committed.tree.branch)).stdout.trim()
	).not.toBe('');
}, 300_000);
