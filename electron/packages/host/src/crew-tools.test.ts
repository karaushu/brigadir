import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SessionStore, atomicJson } from '@brigadir/persistence';
import {
	resolveCrew,
	suggestedBranch,
	templateLookup,
	type CrewTemplate,
	type EventRecord,
	type SessionEvent,
	type TaskKey,
} from '@brigadir/core';
import { Snapshots, discoverScopes } from '@brigadir/git';
import { createConnection } from 'node:net';
import { CrewHost } from './crew';
import { startHost } from './server';
import { connectHost } from './client';
import { Peer } from './peer';
// Counts blob reads, crew-side git commands and discoveries while keeping the real git behind them.
const blobReads = vi.hoisted(() => ({ count: 0, discoveries: 0, git: [] as string[] }));
vi.mock('@brigadir/git', async (original) => {
	const git = await original<typeof import('@brigadir/git')>();
	return {
		...git,
		readBlobs: (...args: Parameters<typeof git.readBlobs>) => {
			blobReads.count++;
			return git.readBlobs(...args);
		},
		discoverScopes: (...args: Parameters<typeof git.discoverScopes>) => {
			blobReads.discoveries++;
			return git.discoverScopes(...args);
		},
		gitText: (...args: Parameters<typeof git.gitText>) => {
			blobReads.git.push(args[1][0]!);
			return git.gitText(...args);
		},
	};
});
const run = promisify(execFile);
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn();
});
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
/** A foreman CrewHost over a real store and repo, with one worker task whose snapshots and journal the test writes. */
async function crew() {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-crew-tools-'));
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	const repo = join(root, 'repo');
	await mkdir(join(repo, 'src'), { recursive: true });
	await git(repo, 'init', '-q', '-b', 'main');
	for (const name of ['a', 'b', 'c'])
		await writeFile(
			join(repo, 'src', `${name}.txt`),
			Array.from({ length: 300 }, (_, i) => `${name} line ${i + 1}`).join('\n') + '\n'
		);
	await git(repo, 'add', '-A');
	await git(repo, 'commit', '-q', '-m', 'init');
	const store = await SessionStore.at(join(root, 'data')),
		project = await store.addProject(repo);
	const spec = resolveCrew(oneDeveloper, {
		lookup: templateLookup([]),
		defaultProvider: 'claude',
		now: new Date().toISOString(),
	});
	let task = await store.createTask(project.id, 'Split the work', 'claude');
	task = await store.updateTask(task, { crew: spec });
	let worker = await store.createTask(project.id, 'Write output', 'claude');
	worker = await store.updateTask(worker, {
		crewTaskId: task.id,
		crewNodeId: 'developer',
		parentTaskId: task.id,
	});
	const events: SessionEvent[] = [],
		prompts: string[] = [];
	const host = new CrewHost({
		store,
		key: task,
		context: {
			role: 'foreman',
			crewKey: task,
			spec,
			node: spec.root,
			parent: null,
			parentKey: null,
			isRoot: true,
		},
		services: {
			dataDir: store.root,
			mcpEntry: resolve('apps/desktop/out/services/mcp-relay'),
			runtime: process.execPath,
		},
		emit: async (event) => {
			events.push(event);
		},
		prompt: async (text) => {
			prompts.push(text);
		},
		records: () => events.map((event, seq) => ({ schemaVersion: 1, seq, at: '', event })),
		parent: () => null,
	});
	host['workers'] = [
		{
			taskId: worker.id,
			nodeId: 'developer',
			name: 'Developer',
			title: 'Write output',
			createdAt: new Date().toISOString(),
			planPartId: null,
		},
	];
	return {
		root,
		repo,
		store,
		task,
		worker: worker as TaskKey,
		host,
		events,
		prompts,
		signal: new AbortController().signal,
	};
}
it('bounds read_transcript lines and the whole reply (MCP-05)', async () => {
	const { store, worker, host, signal } = await crew();
	const writer = await store.writer(worker);
	for (let turn = 0; turn < 30; turn++) {
		await writer.append({ kind: 'turn.started', text: `Prompt ${turn} ` + 'p'.repeat(5000) });
		for (let i = 0; i < 50; i++)
			await writer.append({
				kind: 'message.delta',
				role: 'assistant',
				messageId: 'm',
				content: { kind: 'text', text: 'ї'.repeat(2000) },
			});
		await writer.append({ kind: 'turn.completed', reason: 'end_turn' });
	}
	await writer.close();
	const reply = (await host.tool('read_transcript', { taskId: worker.id, limit: 200 }, signal)) as {
		lines: string[];
		total: number;
		omitted?: number;
	};
	// Unbounded, 30 assistant lines of 100k characters each would be ~6 MB for the model.
	expect(reply.total).toBe(60);
	expect(reply.lines.every((line) => line.length <= 2012)).toBe(true);
	expect(Buffer.byteLength(JSON.stringify(reply))).toBeLessThanOrEqual(64 * 1024 + 256);
	expect(reply.lines.at(-1)).toMatch(/^assistant: ї+…$/);
	expect(reply.omitted).toBe(60 - reply.lines.length);
	const short = (await host.tool('read_transcript', { taskId: worker.id, limit: 2 }, signal)) as {
		lines: string[];
		omitted?: number;
	};
	expect(short.lines).toHaveLength(2);
	expect(short.omitted).toBeUndefined();
});
it('reads each blob once per review, keeping the comment error order (MCP-06)', async () => {
	const { repo, store, worker, host } = await crew();
	const snapshots = await Snapshots.open(store, worker);
	await snapshots.capture('baseline');
	for (const name of ['a', 'b', 'c'])
		await writeFile(
			join(repo, 'src', `${name}.txt`),
			Array.from({ length: 300 }, (_, i) => `${name} changed ${i + 1}`).join('\n') + '\n'
		);
	await snapshots.capture('turn');
	const record = host['workers'][0]!;
	const items = Array.from({ length: 60 }, (_, i) => ({
		path: `src/${'abc'[i % 3]}.txt`,
		start: i + 1,
		end: i + 2,
		text: `Comment ${i + 1}`,
	}));
	blobReads.count = 0;
	const comments = await host['anchorComments'](record, items, 'Foreman', null);
	// One readBlobs for all comments, not one (two git processes) per comment, 60 here.
	expect(comments).toHaveLength(60);
	expect(blobReads.count).toBe(1);
	expect(comments[4]!.anchor).toMatchObject({ path: 'src/b.txt', start: 5, end: 6, side: 'new' });
	expect(comments[4]!.anchor.quote[0]).toBe('b changed 5');
	await expect(
		host['anchorComments'](
			record,
			[
				{ path: 'src/a.txt', text: 'ok' },
				{ path: 'src/none.txt', text: 'x' },
				{ path: 'src/a.txt', text: '' },
			],
			'Foreman',
			null
		)
	).rejects.toThrow('Comment 2: no changed file src/none.txt');
	await expect(
		host['anchorComments'](
			record,
			[
				{ path: 'src/a.txt', text: 'ok' },
				{ path: 'src/a.txt', text: ' ' },
			],
			'Foreman',
			null
		)
	).rejects.toThrow('Comment 2 needs text');
});
it.each([
	{ approved: true, nextTurn: false },
	{ approved: false, nextTurn: false },
	{ approved: true, nextTurn: true },
])(
	'delivers a plan decision after the proposing turn ended ($approved, nextTurn=$nextTurn)',
	async ({ approved, nextTurn }) => {
		const { host, events, prompts, signal } = await crew();
		events.push({ kind: 'turn.started', text: 'Research' });
		const proposed = host.tool(
			'propose_plan',
			{
				parts: [
					{
						title: 'Research',
						agent: 'Developer',
						prompt: 'Read the code',
						files: [],
					},
				],
			},
			signal
		);
		await expect
			.poll(() => events.some((event) => event.kind === 'crew.plan.requested'))
			.toBe(true);
		const request = events.find((event) => event.kind === 'crew.plan.requested');
		if (request?.kind !== 'crew.plan.requested') throw new Error('No plan');
		// Codex can end a turn while its MCP call remains alive. A later turn does not own that call either.
		events.push({ kind: 'turn.completed', reason: 'end_turn' });
		if (nextTurn) events.push({ kind: 'turn.started', text: 'Status?' });
		const edited = [{ ...request.plan.parts[0]!, prompt: 'Read the edited scope' }];
		await host.decidePlan({ id: request.plan.id, approved, parts: approved ? edited : null });
		expect(await proposed).toMatchObject({ approved });
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain(approved ? 'Read the edited scope' : 'rejected your plan');
		await expect(host.decidePlan({ id: request.plan.id, approved, parts: null })).rejects.toThrow(
			'no longer pending'
		);
		expect(prompts).toHaveLength(1);
	}
);
it('returns plan parts only when the human edited them and pages notes by bytes (MCP-08)', async () => {
	const { host, events, prompts, signal } = await crew();
	events.push({ kind: 'turn.completed', reason: 'end_turn' });
	events.push({ kind: 'turn.started', text: 'Plan' });
	const part = {
		title: 'Write output',
		agent: 'Developer',
		prompt: 'x'.repeat(50_000),
		files: ['out/**'],
	};
	const proposed = host.tool('propose_plan', { parts: [part] }, signal) as Promise<
		Record<string, unknown>
	>;
	await expect.poll(() => events.some((event) => event.kind === 'crew.plan.requested')).toBe(true);
	const plan = events.find((event) => event.kind === 'crew.plan.requested');
	if (plan?.kind !== 'crew.plan.requested') throw new Error('No plan');
	await host.decidePlan({ id: plan.plan.id, approved: true, parts: null });
	const reply = await proposed;
	expect(prompts).toEqual([]);
	// The 50k prompt does not come back to the model it came from.
	expect(JSON.stringify(reply).length).toBeLessThan(1000);
	expect(reply).toMatchObject({
		approved: true,
		edited: false,
		parts: [{ title: 'Write output', agent: 'Developer' }],
	});
	const second = host.tool('propose_plan', { parts: [part] }, signal) as Promise<
		Record<string, unknown>
	>;
	await expect
		.poll(() => events.filter((event) => event.kind === 'crew.plan.requested').length)
		.toBe(2);
	const next = events.filter((event) => event.kind === 'crew.plan.requested').at(-1);
	if (next?.kind !== 'crew.plan.requested') throw new Error('No plan');
	const edited = [{ ...next.plan.parts[0]!, prompt: 'shorter' }];
	await host.decidePlan({ id: next.plan.id, approved: true, parts: edited });
	expect(await second).toMatchObject({ approved: true, edited: true, parts: edited });
	for (let i = 0; i < 30; i++)
		await host.tool('post_note', { text: `${i} ` + 'n'.repeat(8000), callId: `c${i}` }, signal);
	const page = (await host.tool('read_notes', { since: 0 }, signal)) as {
		notes: { seq: number }[];
		nextCursor: number;
		hasMore: boolean;
	};
	// A page is capped by bytes, not by a note count: all 30 notes (~240 KB) would not fit in one reply.
	expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(64 * 1024);
	expect(page.hasMore).toBe(true);
	expect(page.nextCursor).toBe(page.notes.at(-1)!.seq);
	let since = 0,
		seen = 0;
	for (let guard = 0; guard < 10; guard++) {
		const next = (await host.tool('read_notes', { since }, signal)) as typeof page;
		seen += next.notes.length;
		since = next.nextCursor;
		if (!next.hasMore) break;
	}
	expect(seen).toBe(30);
});
it('counts the global agent limit without re-reading unchanged tasks (MCP-07)', async () => {
	const { store, host, worker } = await crew();
	for (let p = 0; p < 4; p++) {
		const project = await store.addProject(await mkdtemp(join(tmpdir(), 'brigadir-crew-tools-p-')));
		for (let t = 0; t < 60; t++) {
			const task = await store.createTask(project.id, `T${t}`, 'claude');
			if (t % 20 === 0) await store.setStatus(task, 'working');
		}
	}
	await atomicJson(join(store.root, 'settings.json'), {
		schemaVersion: 1,
		settings: { agents: { maxConcurrent: 13 } },
	});
	expect(await host['hasSlot']()).toBe(true);
	const started = performance.now();
	for (let i = 0; i < 20; i++) await host['hasSlot']();
	const perCall = (performance.now() - started) / 20;
	process.stderr.write(`hasSlot with 242 tasks: ${perCall.toFixed(2)} ms per call\n`);
	await store.setStatus(worker, 'working');
	expect(await host['hasSlot']()).toBe(false);
	await atomicJson(join(store.root, 'settings.json'), {
		schemaVersion: 1,
		settings: { agents: { maxConcurrent: 14 } },
	});
	expect(await host['hasSlot']()).toBe(true);
	await store.setStatus(worker, 'done');
	await atomicJson(join(store.root, 'settings.json'), {
		schemaVersion: 1,
		settings: { agents: { maxConcurrent: null } },
	});
	expect(await host['hasSlot']()).toBe(true);
}, 30_000);
it('launches a worker beside notes and stop, and a stop aborts its setup (BG-05)', async () => {
	const { repo, store, worker, host, signal } = await crew();
	const scopes = (await discoverScopes(repo)).map(({ id, name, kind }) => ({
		id,
		name,
		kind,
		selected: true,
	}));
	await store.updateTask(worker, {
		launch: {
			isolation: 'worktree',
			branch: 'split-developer',
			baseRef: 'HEAD',
			setupCommand: 'sleep 30',
			scopes,
		},
	});
	host['waiting'].push(worker.id);
	host['watchSlots']();
	await expect
		.poll(async () => (await store.task(worker)).preparation?.step, { timeout: 10_000 })
		.toBe('setup');
	// The launch runs outside the serial queue, so this note does not wait for the whole setup command (30 s here).
	const noted = performance.now();
	await host.tool('post_note', { text: 'Shared type changed', callId: 'n1' }, signal);
	expect(performance.now() - noted).toBeLessThan(2000);
	// A launching worker holds exactly one slot, whatever its task status says meanwhile.
	await atomicJson(join(store.root, 'settings.json'), {
		schemaVersion: 1,
		settings: { agents: { maxConcurrent: 1 } },
	});
	expect(await host['hasSlot']()).toBe(false);
	await atomicJson(join(store.root, 'settings.json'), {
		schemaVersion: 1,
		settings: { agents: { maxConcurrent: 2 } },
	});
	expect(await host['hasSlot']()).toBe(true);
	const stopped = performance.now();
	await host.stop();
	expect(performance.now() - stopped).toBeLessThan(5000);
	// The interrupted worker is queued again for the next start instead of failed.
	expect((await store.task(worker)).status).toBe('queued');
}, 60_000);
it('sends a crew peer only the records its parent acts on (BG-14)', async () => {
	const { store, worker } = await crew();
	const host = await startHost({
		dataDir: store.root,
		key: worker,
		mcpEntry: resolve('apps/desktop/out/services/mcp-relay'),
		adapter: {
			command: process.execPath,
			args: [resolve('packages/transport/fixtures/agent.mjs'), 'normal'],
		},
	});
	cleanup.push(() => host.stop());
	const parent = new Peer(createConnection(host.identity.socket), async () => {
			throw new Error('Unknown method');
		}),
		seen: EventRecord[] = [];
	parent.onNotification = (method, params) => {
		if (method === 'event') seen.push(params as EventRecord);
	};
	cleanup.push(async () => parent.close());
	await parent.request('handshake', {
		protocolVersion: 1,
		key: worker,
		instance: host.identity.instance,
		role: 'crew',
		token: host.identity.crewToken,
	});
	await expect
		.poll(async () => ((await parent.request('status', {})) as { connected: boolean }).connected, {
			timeout: 10_000,
		})
		.toBe(true);
	await parent.request('command', { kind: 'prompt', text: 'hi' });
	await expect
		.poll(() => seen.some((record) => record.event.kind === 'turn.completed'), { timeout: 10_000 })
		.toBe(true);
	// Not every record of the turn reaches the parent, deltas and checkpoints included (it uses four kinds).
	expect(
		host.records.filter((record) => record.event.kind === 'message.delta').length
	).toBeGreaterThan(0);
	expect(seen.map((record) => record.event.kind)).toEqual(['turn.completed']);
}, 30_000);
it('names worker branches with one ref listing per repo and one discovery per burst (BG-15)', async () => {
	const { repo, store, task, host } = await crew();
	host['watchSlots'] = () => {};
	const base = `${suggestedBranch('', (await store.task(task)).title, task.id)}-developer`;
	for (const name of [base, `${base}-2`, `${base}-3`]) await git(repo, 'branch', name);
	const agent = host['node'].agents[0]!;
	blobReads.discoveries = 0;
	blobReads.git = [];
	const created = [];
	for (let i = 0; i < 3; i++)
		created.push(await host['spawnWorkerTask'](agent, `Part ${i}`, 'prompt', []));
	const branches = await Promise.all(
		created.map(
			async (record) =>
				(await store.task({ projectId: task.projectId, id: record.taskId })).launch!.branch
		)
	);
	expect(branches).toEqual([`${base}-4`, `${base}-4`, `${base}-4`]);
	// One discovery and no `show-ref` per taken name, rather than both for every worker (3 discoveries and 12 show-ref here).
	expect(blobReads.discoveries).toBe(1);
	expect(blobReads.git.filter((command) => command === 'show-ref')).toEqual([]);
	expect(blobReads.git.filter((command) => command === 'for-each-ref')).toHaveLength(3);
});
it('relinks a worker host that restarted on its own, so its outbox reaches the foreman (BG-18)', async () => {
	const { store, worker, host, prompts } = await crew();
	cleanup.push(() => host.stop());
	const config = {
		dataDir: store.root,
		key: worker,
		mcpEntry: resolve('apps/desktop/out/services/mcp-relay'),
		adapter: {
			command: process.execPath,
			args: [resolve('packages/transport/fixtures/agent.mjs'), 'normal'],
		},
	};
	const first = await startHost(config);
	const link = await host['link'](worker);
	expect(link).not.toBeNull();
	await first.stop();
	await link!.closed;
	// The user reopens the worker from the app: a new host, and the foreman is not told.
	const second = await startHost(config);
	cleanup.push(() => second.stop());
	const ui = await connectHost(second.identity);
	cleanup.push(async () => ui.close());
	await expect.poll(async () => (await ui.status()).connected, { timeout: 10_000 }).toBe(true);
	await ui.command({ kind: 'prompt', text: 'hi' });
	// The report does not wait in crew-outbox.json until the foreman calls a tool for this worker or restarts.
	await expect
		.poll(() => prompts.some((text) => text.includes(worker.id)), { timeout: 10_000 })
		.toBe(true);
}, 30_000);
