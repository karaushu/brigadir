import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SessionStore, atomicJson } from '@brigadir/persistence';
import {
	builtinAgentTemplates,
	resolveCrewAgent,
	templateLookup,
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
	const config = join(await store.taskDir(key), 'config.json');
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
	return client;
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
