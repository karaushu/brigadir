import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SessionStore, atomicJson } from '@brigadir/persistence';
import { planOwed, type EventRecord, type SessionEvent, type TaskKey } from '@brigadir/core';
import { connectHost, readIdentity, type HostClient } from './index';

/** spec/reviews#plan-mode with the built host and the fake agent: `crew-codex-plan` has codex-acp's `Collaboration mode`, `crew` has no plan mode. */
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
	const root = await mkdtemp(join(tmpdir(), 'brigadir-plan-mode-'));
	cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
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
	await mkdir(store.root, { recursive: true });
	await atomicJson(join(store.root, 'settings.json'), {
		schemaVersion: 1,
		settings: { reviews: { smallTask: { files: 2, lines: 1000 } } },
	});
	const project = await store.addProject(repo);
	// The fixture's MCP client speaks stdio, which the host gives a `claude` task; the plan mode comes from the catalog alone (rule 7).
	const task = await store.createTask(project.id, title, 'claude', 'gui', title);
	return { repo, store, task };
}
async function launch(store: SessionStore, key: TaskKey, scenario: string) {
	const config = join(await store.taskDir(key), 'config.json');
	await atomicJson(config, {
		schemaVersion: 1,
		dataDir: store.root,
		key,
		mcpEntry: resolve('apps/desktop/out/services/mcp-relay'),
		adapter: {
			command: process.execPath,
			args: [resolve('packages/transport/fixtures/agent.mjs'), scenario],
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
	const at = (await client.snapshot()).records.at(-1)?.seq ?? 0;
	await until(async () =>
		(await client.snapshot()).records.find((r) => r.seq >= at && r.event.kind === 'session.started')
	);
	return { client, child };
}
const records = async (client: HostClient) => (await client.snapshot()).records;
const ofKind = <K extends SessionEvent['kind']>(list: readonly EventRecord[], kind: K) =>
	list.flatMap((r) =>
		r.event.kind === kind ? [r.event as Extract<SessionEvent, { kind: K }>] : []
	);
const last = async (client: HostClient) => (await records(client)).at(-1)?.seq ?? 0;
/** The first record of `kind` after `seq` that passes `test`. */
const next = <K extends SessionEvent['kind']>(
	client: HostClient,
	seq: number,
	kind: K,
	test: (event: Extract<SessionEvent, { kind: K }>) => boolean = () => true,
	timeout?: number
) =>
	until(async () => {
		const found = (await records(client)).find(
			(r) =>
				r.seq > seq && r.event.kind === kind && test(r.event as Extract<SessionEvent, { kind: K }>)
		);
		return found as (EventRecord & { event: Extract<SessionEvent, { kind: K }> }) | undefined;
	}, timeout);
const turn = async (client: HostClient, text: string) => {
	const before = await last(client);
	await client.command({ kind: 'prompt', text });
	return next(client, before, 'turn.completed');
};
const collaboration = (list: readonly EventRecord[]) => {
	const latest = list.findLast(
		(r) => r.event.kind === 'session.started' || r.event.kind === 'options.changed'
	)?.event;
	const option =
		latest && 'options' in latest
			? latest.options.find((item) => item.id === 'collaboration_mode')
			: undefined;
	return option?.value;
};
const said = (list: readonly EventRecord[], after: number) =>
	list
		.filter(
			(r) => r.seq > after && r.event.kind === 'message.delta' && r.event.role === 'assistant'
		)
		.map((r) =>
			r.event.kind === 'message.delta' && r.event.content.kind === 'text'
				? r.event.content.text
				: ''
		)
		.join('');

it('Medium on a Codex-shaped session: switched into plan mode between turns, asked for the plan, back to writing at approval, again after a restart (spec/reviews#plan-mode)', async () => {
	const { repo, store, task } = await setup('Plan mode');
	let { client, child } = await launch(store, task, 'crew-codex-plan');
	const start = await last(client);
	const ended = await turn(
		client,
		'@call set_task_class {"class":"medium","reason":"touches the API"}'
	);
	// The class's answer tells the agent to end its turn; the session is not switched during it.
	const answered = await records(client);
	expect(said(answered, start)).toContain('Brigadir switches the session into plan mode');
	expect(
		ofKind(
			answered.filter((r) => r.seq > start && r.seq < ended.seq),
			'plan.mode'
		)
	).toEqual([]);
	// At the turn's end: the switch, then the ask runs in plan mode and the plan comes as a plan for approval.
	const switched = await next(client, start, 'plan.mode');
	expect(switched.event).toEqual({
		kind: 'plan.mode',
		on: true,
		by: 'host',
		class: 'medium',
		option: 'collaboration_mode',
		name: 'Collaboration mode',
		value: 'plan',
		valueName: 'Plan',
		previous: 'default',
		previousName: 'Default',
	});
	const ask = await next(client, switched.seq, 'turn.started', (e) => e.crew?.kind === 'plan-ask');
	expect(ask.event.text).toContain('This task is Medium: present a plan for approval');
	expect(collaboration((await records(client)).filter((r) => r.seq < ask.seq))).toBe('plan');
	const first = await next(client, ask.seq, 'permission.requested');
	expect(first.event.request.tool.category).toBe('switch_mode');
	expect(
		ofKind(
			(await records(client)).filter((r) => r.seq < first.seq),
			'plan.document'
		)
	).toHaveLength(1);
	// A restart while the plan waits: the fixture's new process opens the session in `default`, and no turn starts by itself.
	await client.command({ kind: 'shutdown' });
	await until(async () => (child.exitCode !== null ? true : undefined));
	({ client, child } = await launch(store, task, 'crew-codex-plan'));
	const reopened = await last(client);
	expect(collaboration(await records(client))).toBe('default');
	await delay(500);
	expect(
		ofKind(
			(await records(client)).filter((r) => r.seq > reopened),
			'turn.started'
		)
	).toEqual([]);
	// The person's next message is switched into plan mode again and brings the plan again.
	await client.command({ kind: 'prompt', text: '@write a.txt one' });
	const again = await next(client, reopened, 'plan.mode');
	expect(again.event).toMatchObject({ on: true, by: 'host', value: 'plan' });
	const second = await next(client, again.seq, 'permission.requested');
	await expect(readFile(join(repo, 'a.txt'), 'utf8')).rejects.toThrow();
	// Approval: the agent switches back to Default itself and writes in the same turn.
	await client.command({
		kind: 'answerPermission',
		id: second.event.request.id,
		optionId: 'implement_plan',
	});
	const done = await next(client, second.seq, 'turn.completed');
	expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('one\n');
	const after = await records(client);
	expect(collaboration(after)).toBe('default');
	expect(planOwed(after)).toBeNull();
	// The agent left the plan itself: no switch back by the host, and no more switches or asks.
	await turn(client, '@write b.txt two');
	const end = await records(client);
	expect(
		ofKind(
			end.filter((r) => r.seq > done.seq),
			'plan.mode'
		)
	).toEqual([]);
	expect(
		ofKind(
			end.filter((r) => r.seq > done.seq),
			'permission.requested'
		)
	).toEqual([]);
	expect(await readFile(join(repo, 'b.txt'), 'utf8')).toBe('two\n');
}, 240_000);

it('the person moves the plan mode off after the host’s switch: kept, no switch again (spec/reviews#plan-mode)', async () => {
	const { repo, store, task } = await setup('Plan mode off');
	const { client } = await launch(store, task, 'crew-codex-plan');
	const start = await last(client);
	await turn(client, '@call set_task_class {"class":"large","reason":"two layers"}');
	const switched = await next(client, start, 'plan.mode');
	expect(switched.event).toMatchObject({ class: 'large' });
	await next(client, switched.seq, 'permission.requested');
	// The person stops the turn, then picks Default.
	await client.command({ kind: 'cancel' });
	const stopped = await next(client, switched.seq, 'turn.completed');
	// Options change only between turns; the host lets go of the turn just after its end.
	await until(() =>
		client
			.command({ kind: 'setOption', id: 'collaboration_mode', value: 'default' })
			.then(() => true)
			.catch(() => undefined)
	);
	const off = await next(client, stopped.seq, 'plan.mode');
	expect(off.event).toMatchObject({
		on: false,
		by: 'person',
		value: 'default',
		valueName: 'Default',
	});
	// Its next turn runs as the person set it: no switch, the file is written.
	await turn(client, '@write c.txt three');
	const list = await records(client);
	expect(
		ofKind(
			list.filter((r) => r.seq > off.seq),
			'plan.mode'
		)
	).toEqual([]);
	expect(await readFile(join(repo, 'c.txt'), 'utf8')).toBe('three\n');
}, 180_000);

it('no plan mode in the catalog keeps the instruction; the tripwire’s raise switches nothing (spec/reviews#plan-mode)', async () => {
	// `crew` advertises no plan choice: the class asks for the plan in the reply, the host neither switches nor asks.
	const plain = await setup('No plan mode');
	const a = await launch(plain.store, plain.task, 'crew');
	const start = await last(a.client);
	await turn(a.client, '@call set_task_class {"class":"medium","reason":"touches the API"}');
	await delay(500);
	const list = await records(a.client);
	expect(said(list, start)).toContain('write the plan in your reply');
	expect(ofKind(list, 'plan.mode')).toEqual([]);
	expect(ofKind(list, 'turn.started').filter((e) => e.crew?.kind === 'plan-ask')).toEqual([]);
	// With a plan mode in the catalog, the tripwire raises Small to Medium with a review, but owes no plan.
	const grown = await setup('Tripwire');
	const b = await launch(grown.store, grown.task, 'crew-codex-plan');
	await turn(b.client, '@call set_task_class {"class":"small","reason":"one file"}');
	await turn(b.client, '@write a.txt one\n@write b.txt two\n@write c.txt three');
	const raised = await next(b.client, 0, 'task.class', (e) => e.by === 'host');
	expect(raised.event).toMatchObject({ class: 'medium', cause: 'threshold' });
	await turn(b.client, '@write d.txt four');
	const after = await records(b.client);
	expect(ofKind(after, 'plan.mode')).toEqual([]);
	expect(ofKind(after, 'permission.requested')).toEqual([]);
	expect(collaboration(after)).toBe('default');
}, 240_000);

it('the agent stays in plan mode after the approval: the host sets the mode back before the next turn; a refused switch lets the turn run (spec/reviews#plan-mode)', async () => {
	const { repo, store, task } = await setup('Plan mode back');
	const { client } = await launch(store, task, 'crew-codex-plan');
	const start = await last(client);
	await turn(
		client,
		'@stay-in-plan\n@call set_task_class {"class":"medium","reason":"touches the API"}'
	);
	const switched = await next(client, start, 'plan.mode');
	const plan = await next(client, switched.seq, 'permission.requested');
	// The person queues a message while the plan waits; it runs after the approval's turn.
	await client.command({ kind: 'prompt', text: '@write q.txt queued' });
	await next(client, plan.seq, 'prompt.queued');
	await client.command({
		kind: 'answerPermission',
		id: plan.event.request.id,
		optionId: 'implement_plan',
	});
	const back = await next(client, plan.seq, 'plan.mode');
	expect(back.event).toEqual({
		kind: 'plan.mode',
		on: false,
		by: 'host',
		class: 'medium',
		option: 'collaboration_mode',
		name: 'Collaboration mode',
		value: 'default',
		valueName: 'Default',
	});
	const queued = await next(
		client,
		plan.seq,
		'turn.started',
		(e) => e.text === '@write q.txt queued'
	);
	expect(back.seq).toBeLessThan(queued.seq);
	await next(client, queued.seq, 'turn.completed');
	expect(await readFile(join(repo, 'q.txt'), 'utf8')).toBe('queued\n');
	expect(
		ofKind(
			(await records(client)).filter((r) => r.seq > back.seq),
			'plan.mode'
		)
	).toEqual([]);

	// An agent that refuses the switch: no `plan.mode`, the ask still runs, once.
	const refused = await setup('Plan mode refused');
	const b = await launch(refused.store, refused.task, 'crew-codex-plan');
	const from = await last(b.client);
	await turn(
		b.client,
		'@refuse-plan\n@call set_task_class {"class":"large","reason":"two layers"}'
	);
	const ask = await next(b.client, from, 'turn.started', (e) => e.crew?.kind === 'plan-ask');
	await next(b.client, ask.seq, 'turn.completed');
	await turn(b.client, '@write r.txt runs');
	const list = await records(b.client);
	expect(ofKind(list, 'plan.mode')).toEqual([]);
	expect(ofKind(list, 'turn.started').filter((e) => e.crew?.kind === 'plan-ask')).toHaveLength(1);
	expect(await readFile(join(refused.repo, 'r.txt'), 'utf8')).toBe('runs\n');
}, 240_000);
