import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SessionStore, atomicJson } from '@brigadir/persistence';
import type { EventRecord, SessionEvent, TaskKey } from '@brigadir/core';
import { connectHost, readIdentity, type HostClient } from './index';
import { TaskClassLife, classBrief, classNext, type ClassReviewStart } from './task-class';

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

describe('TaskClassLife (spec/reviews#classes)', () => {
	function life(
		options: {
			size?: { files: number; lines: number };
			start?: (input: ClassReviewStart) => boolean;
			auto?: boolean;
			eligible?: boolean;
			readOnly?: boolean;
			planMode?: 'on' | 'available' | 'none';
		} = {}
	) {
		const records: EventRecord[] = [],
			starts: ClassReviewStart[] = [];
		const emit = async (event: SessionEvent) => {
			records.push({
				schemaVersion: 1,
				seq: records.length + 1,
				at: new Date().toISOString(),
				event,
			});
		};
		const value = new TaskClassLife({
			records: () => records,
			emit,
			eligible: options.eligible ?? true,
			readOnly: options.readOnly ?? false,
			auto: options.auto ?? false,
			planMode: () => options.planMode ?? 'available',
			limit: async () => ({ files: 3, lines: 100 }),
			size: async () => options.size ?? { files: 1, lines: 5 },
			start: async (input) => {
				starts.push(input);
				const recorded = options.start ? options.start(input) : true;
				if (recorded)
					await emit({
						kind: 'task-review.started',
						id: `r${starts.length}`,
						point: 'mid',
						startedBy: 'host',
						reviewers: ['Codex'],
						...(input.threshold ? { threshold: input.threshold } : {}),
						...(input.hired ? { hired: true } : {}),
					});
				return recorded;
			},
			stopping: () => false,
		});
		return { value, records, starts, emit };
	}
	const classes = (records: EventRecord[]) =>
		records.flatMap((record) => (record.event.kind === 'task.class' ? [record.event] : []));

	it('the agent states a class; the same class again journals nothing; another class names the previous one', async () => {
		const { value, records } = life();
		const first = await value.set({ class: 'small', reason: ' one file ' });
		expect(first).toMatchObject({ class: 'small' });
		expect(first.next).toContain('past 3 files or 100 changed lines');
		await value.set({ class: 'small', reason: 'still one file' });
		const changed = await value.set({ class: 'large', reason: 'two endpoints' });
		expect(changed).toMatchObject({ class: 'large', previous: 'small' });
		expect(classes(records)).toEqual([
			{ kind: 'task.class', class: 'small', reason: 'one file', by: 'agent' },
			{
				kind: 'task.class',
				class: 'large',
				reason: 'two endpoints',
				by: 'agent',
				previous: 'small',
			},
		]);
	});
	it('a class that owes no plan never tells the agent to wait for the host (spec/reviews#plan-mode)', async () => {
		const { value, emit } = life();
		const first = await value.set({ class: 'medium', reason: 'touches the API' });
		expect(first.next).toContain('Brigadir switches the session into plan mode');
		await emit({
			kind: 'permission.requested',
			request: {
				id: 'p1',
				tool: {
					id: 'plan',
					title: 'Implement this plan?',
					category: 'switch_mode',
					status: 'pending',
				},
				options: [{ id: 'implement_plan', name: 'Yes', kind: 'allow_once' }],
			} as never,
		});
		await emit({ kind: 'permission.resolved', id: 'p1', optionId: 'implement_plan' });
		const raised = await value.set({ class: 'large', reason: 'two layers' });
		expect(raised.next).toContain('no new plan for approval is asked now');
		expect(raised.next).not.toContain('Brigadir switches');
	});
	it('refuses a bad call, a task that writes no code and a class below Large while workers run', async () => {
		const { value, emit } = life({ auto: true });
		await expect(value.set({ class: 'huge', reason: 'x' })).rejects.toThrow('small, medium, large');
		await expect(value.set({ class: 'small', reason: '' })).rejects.toThrow('reason');
		await expect(
			life({ readOnly: true, eligible: false }).value.set({ class: 'small', reason: 'x' })
		).rejects.toThrow('This task changes no code.');
		await emit({
			kind: 'crew.hire.resolved',
			id: 'h1',
			approved: true,
			parts: null,
			hired: [{ partId: 'p1', taskId: 'w1', name: 'Developer', role: 'Developer' }],
		});
		await expect(value.set({ class: 'medium', reason: 'smaller' })).rejects.toThrow(
			'Workers run in this task: it stays Large until they are dismissed.'
		);
	});
	it('the next step names the plan by the session plan mode (spec/reviews#plan-mode) and, in an Auto task, the hire', () => {
		const limit = { files: 15, lines: 300 };
		const available = classNext('medium', { planMode: 'available', auto: false, limit });
		expect(available).toContain('EnterPlanMode, for example');
		expect(available).toContain('Brigadir switches the session into plan mode');
		expect(classNext('medium', { planMode: 'on', auto: false, limit })).toContain(
			'you are in plan mode'
		);
		expect(classNext('medium', { planMode: 'none', auto: false, limit })).toContain(
			'write the plan in your reply'
		);
		const large = classNext('large', { planMode: 'available', auto: true, limit });
		expect(large).toContain('request_review');
		expect(large).toContain('hire_workers');
		expect(classNext('large', { planMode: 'available', auto: false, limit })).not.toContain(
			'hire_workers'
		);
		expect(classBrief(true)).toContain('hire workers');
		expect(classBrief(false)).not.toContain('hire workers');
	});
	it('the tripwire fires once past the limit, raises the class to Medium and starts the review with the size (spec/reviews#tripwire)', async () => {
		const size = { files: 1, lines: 5 };
		const { value, records, starts } = life({ size });
		await value.start();
		await value.set({ class: 'small', reason: 'one file' });
		await value.checkpoint();
		expect(starts).toEqual([]);
		size.files = 4;
		size.lines = 40;
		await value.checkpoint();
		await value.checkpoint();
		expect(starts).toEqual([
			{ point: 'mid', startedBy: 'host', reason: '', threshold: { files: 4, lines: 40 } },
		]);
		expect(classes(records).at(-1)).toEqual({
			kind: 'task.class',
			class: 'medium',
			reason: '',
			by: 'host',
			previous: 'small',
			cause: 'threshold',
			files: 4,
			lines: 40,
		});
		// The agent lowering it again does not re-arm the tripwire.
		await value.set({ class: 'small', reason: 'one file after all' });
		size.files = 9;
		await value.checkpoint();
		expect(starts).toHaveLength(1);
	});
	it('a refused start leaves the tripwire armed; a Medium task and a task with no class are told apart', async () => {
		let accept = false;
		const { value, records, starts } = life({
			size: { files: 9, lines: 9 },
			start: () => accept,
		});
		// The first check runs once the host loaded the review's record.
		await value.checkpoint();
		expect(starts).toEqual([]);
		await value.start();
		expect(starts).toHaveLength(1);
		expect(classes(records)).toEqual([]);
		accept = true;
		await value.checkpoint();
		expect(starts).toHaveLength(2);
		// No class was stated: the raise has no previous one.
		expect(classes(records)).toEqual([
			{
				kind: 'task.class',
				class: 'medium',
				reason: '',
				by: 'host',
				cause: 'threshold',
				files: 9,
				lines: 9,
			},
		]);
		const medium = life({ size: { files: 9, lines: 9 } });
		await medium.value.set({ class: 'medium', reason: 'an API' });
		await medium.value.start();
		expect(medium.starts).toEqual([]);
	});
	it('no class and no tripwire for a task that has none (a foreman, a worker, a reviewer)', async () => {
		const { value, starts } = life({ eligible: false, size: { files: 9, lines: 900 } });
		await value.start();
		await value.checkpoint();
		expect(starts).toEqual([]);
		await expect(value.set({ class: 'small', reason: 'x' })).rejects.toThrow('not available');
	});
	it('a hire makes an Auto task Large; when its parts are back the host starts a mid-task review once (spec/reviews#large-review)', async () => {
		const { value, records, starts, emit } = life({ auto: true });
		await value.start();
		await value.set({ class: 'small', reason: 'one screen' });
		await emit({
			kind: 'crew.hire.resolved',
			id: 'h1',
			approved: true,
			parts: null,
			hired: [
				{ partId: 'p1', taskId: 'w1', name: 'Developer', role: 'Developer' },
				{ partId: 'p2', taskId: 'w2', name: 'Developer 2', role: 'Developer' },
			],
		});
		await value.hired();
		expect(classes(records).at(-1)).toEqual({
			kind: 'task.class',
			class: 'large',
			reason: '',
			by: 'host',
			previous: 'small',
			cause: 'hire',
		});
		const dismissed = (taskId: string) =>
			emit({
				kind: 'crew.worker.dismissed',
				taskId,
				nodeId: taskId,
				name: 'Developer',
				title: 'Part',
				reason: 'accepted',
			});
		await dismissed('w1');
		await value.dismissed();
		expect(starts).toEqual([]);
		await dismissed('w2');
		await value.dismissed();
		await value.dismissed();
		expect(starts).toEqual([{ point: 'mid', startedBy: 'host', reason: '', hired: true }]);
		// A second hire raises nothing: the task is Large already.
		await value.hired();
		expect(classes(records).filter((event) => event.cause === 'hire')).toHaveLength(1);
	});
	it('a refused hired-parts start is not tried again for that hire', async () => {
		const { value, starts, emit } = life({ auto: true, start: () => false });
		await value.start();
		await emit({
			kind: 'crew.hire.resolved',
			id: 'h1',
			approved: true,
			parts: null,
			hired: [{ partId: 'p1', taskId: 'w1', name: 'Developer', role: 'Developer' }],
		});
		await value.hired();
		await emit({
			kind: 'crew.worker.dismissed',
			taskId: 'w1',
			nodeId: 'w1',
			name: 'Developer',
			title: 'Part',
			reason: 'accepted',
		});
		await Promise.all([value.dismissed(), value.dismissed()]);
		expect(starts).toHaveLength(1);
	});
	it('a host that stopped mid-way pays what it owes at its start: the tripwire raise, the hire raise, the hired-parts review', async () => {
		// The tripwire's review started, the host stopped before the raise.
		const tripped = life();
		await tripped.emit({ kind: 'task.class', class: 'small', reason: 'one file', by: 'agent' });
		await tripped.emit({
			kind: 'task-review.started',
			id: 'r0',
			point: 'mid',
			startedBy: 'host',
			reviewers: ['Codex'],
			threshold: { files: 16, lines: 40 },
		});
		await tripped.value.start();
		await tripped.value.start();
		expect(classes(tripped.records).filter((event) => event.by === 'host')).toEqual([
			{
				kind: 'task.class',
				class: 'medium',
				reason: '',
				by: 'host',
				previous: 'small',
				cause: 'threshold',
				files: 16,
				lines: 40,
			},
		]);
		expect(tripped.starts).toEqual([]);
		// A hire was approved and its only worker accepted while the host was down.
		const hired = life({ auto: true });
		await hired.emit({
			kind: 'crew.hire.resolved',
			id: 'h1',
			approved: true,
			parts: null,
			hired: [{ partId: 'p1', taskId: 'w1', name: 'Developer', role: 'Developer' }],
		});
		await hired.emit({
			kind: 'crew.worker.dismissed',
			taskId: 'w1',
			nodeId: 'w1',
			name: 'Developer',
			title: 'Part',
			reason: 'accepted',
		});
		await hired.value.start();
		expect(classes(hired.records)).toEqual([
			{ kind: 'task.class', class: 'large', reason: '', by: 'host', cause: 'hire' },
		]);
		expect(hired.starts).toEqual([{ point: 'mid', startedBy: 'host', reason: '', hired: true }]);
	});
});

// ── with the built host and the fake agent ──────────────────────────────────

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
	const root = await mkdtemp(join(tmpdir(), 'brigadir-task-class-'));
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
	// spec/reviews#tripwire: a limit of two files, read by the host from settings.json.
	await mkdir(store.root, { recursive: true });
	await atomicJson(join(store.root, 'settings.json'), {
		schemaVersion: 1,
		settings: { reviews: { smallTask: { files: 2, lines: 1000 } } },
	});
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
	const child: ChildProcess = spawn(
		process.execPath,
		[resolve('apps/desktop/out/services/host.cjs'), config],
		{ stdio: 'pipe' }
	);
	let diagnostics = '';
	child.stderr!.on('data', (c) => {
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
const records = async (client: HostClient) => (await client.snapshot()).records;
const turn = async (client: HostClient, text: string) => {
	const before = (await records(client)).at(-1)?.seq ?? 0;
	await client.command({ kind: 'prompt', text });
	return until(async () =>
		(await records(client)).find((r) => r.seq > before && r.event.kind === 'turn.completed')
	);
};
const ofKind = <K extends SessionEvent['kind']>(list: readonly EventRecord[], kind: K) =>
	list.flatMap((r) =>
		r.event.kind === kind ? [r.event as Extract<SessionEvent, { kind: K }>] : []
	);

it('a class stated and changed, the tripwire fired once with its review, across restarts (spec/reviews#classes)', async () => {
	const { store, task } = await setup('Write the files');
	let { client, child } = await launch(store, task);
	await turn(
		client,
		'@call set_task_class {"class":"small","reason":"one file, no contract change"}'
	);
	await turn(client, '@call set_task_class {"class":"small","reason":"still one file"}');
	expect(ofKind(await records(client), 'task.class')).toEqual([
		{ kind: 'task.class', class: 'small', reason: 'one file, no contract change', by: 'agent' },
	]);
	// Two files are within the limit.
	await turn(client, '@write a.txt one\n@write b.txt two');
	expect(ofKind(await records(client), 'task-review.started')).toEqual([]);
	// A restart mid-way: the class comes back from the journal and the tripwire is still armed.
	await client.command({ kind: 'shutdown' });
	await until(async () => (child.exitCode !== null ? true : undefined));
	({ client, child } = await launch(store, task));
	await turn(client, '@write c.txt three');
	const started = await until(async () => ofKind(await records(client), 'task-review.started')[0]);
	expect(started).toMatchObject({
		point: 'mid',
		startedBy: 'host',
		reviewers: ['Claude'],
		threshold: { files: 3, lines: 3 },
	});
	const raised = await until(async () =>
		ofKind(await records(client), 'task.class').find((e) => e.by === 'host')
	);
	expect(raised).toEqual({
		kind: 'task.class',
		class: 'medium',
		reason: '',
		by: 'host',
		previous: 'small',
		cause: 'threshold',
		files: 3,
		lines: 3,
	});
	// The review runs its loop: the reviewer reads the change and leaves its finding.
	await until(async () => ofKind(await records(client), 'task-review.findings')[0], 90_000);
	await until(async () => ofKind(await records(client), 'task-review.finished')[0], 120_000);
	// Fired once: the agent lowers the class, writes more, and a restart changes nothing.
	await turn(client, '@call set_task_class {"class":"small","reason":"small after all"}');
	await turn(client, '@write d.txt four');
	await client.command({ kind: 'shutdown' });
	await until(async () => (child.exitCode !== null ? true : undefined));
	({ client, child } = await launch(store, task));
	await turn(client, '@write e.txt five');
	await turn(client, '@call set_task_class {"class":"large","reason":"two layers"}');
	const list = await records(client);
	expect(ofKind(list, 'task-review.started').filter((e) => e.threshold)).toHaveLength(1);
	expect(ofKind(list, 'task.class').map((e) => [e.class, e.by, e.previous ?? null])).toEqual([
		['small', 'agent', null],
		['medium', 'host', 'small'],
		['small', 'agent', 'medium'],
		['large', 'agent', 'small'],
	]);
}, 300_000);
