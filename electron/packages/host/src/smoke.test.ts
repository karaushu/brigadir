import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SessionStore, atomicJson } from '@brigadir/persistence';
import type { EventRecord, SessionEvent, TaskKey } from '@brigadir/core';
import { connectHost, readIdentity, type HostClient } from './index';
import { SmokeLife, smokeReportDue } from './smoke';

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
const ofKind = <K extends SessionEvent['kind']>(list: readonly EventRecord[], kind: K) =>
	list.flatMap((r) =>
		r.event.kind === kind ? [r.event as Extract<SessionEvent, { kind: K }>] : []
	);

describe('SmokeLife (spec/smoke-run)', () => {
	function life(
		options: {
			busy?: boolean;
			steer?: boolean;
			hired?: boolean;
			workers?: boolean;
			asks?: boolean;
		} = {}
	) {
		const records: EventRecord[] = [],
			prompts: string[] = [],
			steers: string[] = [];
		let dropped = 0;
		let now = Date.parse('2026-11-20T10:00:00Z');
		const emit = async (event: SessionEvent) => {
			records.push({
				schemaVersion: 1,
				seq: records.length + 1,
				at: new Date(now).toISOString(),
				event,
			});
		};
		const value = new SmokeLife({
			records: () => records,
			emit,
			eligible: true,
			modules: () => ({ browser: true, simulator: true }),
			minutes: async () => 10,
			hiredWorker: async () => options.hired ?? false,
			workersRun: () => options.workers ?? false,
			busy: () => options.busy ?? false,
			steer: async (text) => {
				steers.push(text);
				return options.steer ?? false;
			},
			prompt: async (text) => {
				prompts.push(text);
			},
			dropAsks: async () => {
				dropped++;
			},
			asks: options.asks ?? true,
			page: async () => ({ tab: 'b1', url: 'http://localhost:3000/details' }),
			stopping: () => false,
			now: () => now,
		});
		cleanup.push(async () => value.dispose());
		return {
			value,
			records,
			prompts,
			steers,
			emit,
			dropped: () => dropped,
			last: () => records.at(-1)?.seq ?? 0,
			tick: (ms: number) => {
				now += ms;
			},
		};
	}
	const start = { steps: ['Clients list', 'Client card'] };
	it('starts once, refuses a second run, a hired worker and an Auto agent whose workers run', async () => {
		const { value, records } = life();
		const started = await value.start(start);
		expect(started).toMatchObject({ started: true, limitMinutes: 10 });
		expect(ofKind(records, 'smoke.started')[0]).toMatchObject({
			steps: start.steps,
			limitMs: 600_000,
		});
		await expect(value.start(start)).rejects.toThrow('A smoke run is already open');
		await expect(life({ hired: true }).value.start(start)).rejects.toThrow(
			'the agent that hired you runs it'
		);
		await expect(life({ workers: true }).value.start(start)).rejects.toThrow(
			'Workers of this task still run'
		);
		await expect(value.start({ steps: [] })).rejects.toThrow('steps');
	});
	it('the person extends and stops a running run; the stop refuses the browser and the simulator until the report', async () => {
		const { value, records, prompts } = life();
		await value.start(start);
		const id = ofKind(records, 'smoke.started')[0]!.id;
		await value.extend(id);
		expect(ofKind(records, 'smoke.extended')[0]).toMatchObject({ limitMs: 900_000, by: 'person' });
		expect(() => value.gate('browser_act')).not.toThrow();
		await value.stop(id);
		expect(ofKind(records, 'smoke.stopped')).toEqual([
			{ kind: 'smoke.stopped', id, cause: 'person' },
		]);
		expect(() => value.gate('simulator_act')).toThrow('The person stopped the smoke run.');
		expect(() => value.gate('commands_run')).not.toThrow();
		// Idle: the host asks for the report as a prompt.
		expect(prompts).toEqual([smokeReportDue(value.run()!)]);
		// No `+5 min` after the stop.
		await value.extend(id);
		expect(ofKind(records, 'smoke.extended')).toHaveLength(1);
		await expect(
			value.report({ steps: [{ step: 'Client card', result: 'failed' }], summary: 'x' })
		).rejects.toThrow('needs a note');
		const answer = await value.report({
			steps: [{ step: 'Client card', result: 'failed', note: 'no avatar' }],
			summary: 'The card misses its avatar.',
		});
		expect(answer).toMatchObject({ reported: true, failed: 1, unchecked: 1 });
		expect(ofKind(records, 'smoke.reported')[0]).toMatchObject({
			stopped: 'person',
			steps: [
				{ step: 'Clients list', result: 'unchecked', missing: true },
				{ step: 'Client card', result: 'failed', note: 'no avatar' },
			],
		});
		expect(() => value.gate('browser_act')).not.toThrow();
	});
	it('at the limit a busy turn is asked through steering; a load after the limit stops the run', async () => {
		const busy = life({ busy: true, steer: true });
		await busy.value.start(start);
		busy.tick(10 * 60_000);
		await busy.value.load();
		expect(ofKind(busy.records, 'smoke.stopped')[0]).toMatchObject({ cause: 'limit' });
		expect(busy.steers[0]).toContain('reached its limit of 10 minutes');
		expect(busy.prompts).toEqual([]);
	});
	it('a turn that ends with the run open is asked once; the ask turn ending without a report drops it; a stopped turn drops it', async () => {
		const { value, records, prompts, emit, last, dropped } = life();
		await value.start(start);
		await emit({ kind: 'turn.completed', reason: 'end_turn' });
		await value.turnEnded(false, last());
		await value.turnEnded(false, last());
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain('Your smoke run is still open');
		await emit({ kind: 'turn.started', text: prompts[0]!, crew: { kind: 'smoke-report' } });
		await emit({ kind: 'turn.completed', reason: 'end_turn' });
		await value.turnEnded(false, last());
		expect(ofKind(records, 'smoke.dropped')[0]).toMatchObject({ reason: 'no-report' });
		expect(dropped()).toBe(1);
		const cancelled = life();
		await cancelled.value.start(start);
		await cancelled.value.turnEnded(true, cancelled.last());
		expect(ofKind(cancelled.records, 'smoke.dropped')[0]).toMatchObject({ reason: 'cancelled' });
		expect(cancelled.prompts).toEqual([]);
	});
	it('an ask the agent adopts as a new turn is not taken for an ended ask by the old turn ending after it (codex steering)', async () => {
		const { value, records, emit, last } = life({ busy: true, steer: true });
		await value.start(start);
		await emit({ kind: 'turn.completed', reason: 'end_turn' });
		const old = last();
		// The adopted turn began after the old one's end was journaled; that end reaches the host later.
		await emit({
			kind: 'turn.started',
			text: '',
			origin: 'agent',
			crew: { kind: 'smoke-report' },
		} as SessionEvent);
		await value.turnEnded(false, old);
		expect(ofKind(records, 'smoke.dropped')).toEqual([]);
		await value.report({ steps: [{ step: 'Clients list', result: 'passed' }], summary: 'ok' });
		expect(ofKind(records, 'smoke.reported')).toHaveLength(1);
	});
	it('a restarted host asks again for a stopped run; a removed ask is asked again; an ask in the queue is not doubled', async () => {
		const first = life();
		await first.value.start(start);
		const id = ofKind(first.records, 'smoke.started')[0]!.id;
		await first.emit({ kind: 'smoke.stopped', id, cause: 'limit' });
		await first.value.load();
		expect(first.prompts).toHaveLength(1);
		expect(first.prompts[0]).toContain('reached its limit of 10 minutes');
		// The ask waits in the queue: a turn that ends meanwhile asks nothing more.
		const second = life();
		await second.value.start(start);
		const run = ofKind(second.records, 'smoke.started')[0]!.id;
		await second.emit({ kind: 'smoke.stopped', id: run, cause: 'person' });
		await second.emit({
			kind: 'prompt.queued',
			prompt: {
				id: 'q1',
				command: { kind: 'prompt', text: 'x', crew: { kind: 'smoke-report' } },
				attachments: [],
			},
		} as SessionEvent);
		await second.emit({ kind: 'turn.completed', reason: 'end_turn' });
		await second.value.turnEnded(false, second.last());
		expect(second.prompts).toEqual([]);
		// The person removed it: the next turn end asks again.
		await second.emit({ kind: 'prompt.removed', id: 'q1' });
		await second.emit({ kind: 'turn.completed', reason: 'end_turn' });
		await second.value.turnEnded(false, second.last());
		expect(second.prompts).toHaveLength(1);
	});
	it('an old timer does not stop a run the person extended', async () => {
		const { value, records, tick } = life();
		await value.start(start);
		const id = ofKind(records, 'smoke.started')[0]!.id;
		tick(9 * 60_000);
		await value.extend(id);
		tick(60_000);
		await value.load();
		expect(ofKind(records, 'smoke.stopped')).toEqual([]);
		tick(5 * 60_000);
		await value.load();
		expect(ofKind(records, 'smoke.stopped')).toHaveLength(1);
	});
	it('a terminal session runs no smoke', async () => {
		await expect(life({ asks: false }).value.start(start)).rejects.toThrow('A terminal session');
	});
	it('Ready to look journals a screen once and needs the device or the page', async () => {
		const { value, records, emit } = life();
		await expect(value.ready({ screen: 'Details', where: 'simulator' })).rejects.toThrow(
			'simulator_open'
		);
		await emit({
			kind: 'simulator.device',
			device: 'iPhone 17 Pro',
			metroPort: 8081,
			lowMemory: false,
		});
		expect(await value.ready({ screen: 'Details', where: 'simulator' })).toEqual({
			notified: true,
		});
		expect(await value.ready({ screen: ' details ', where: 'browser' })).toMatchObject({
			notified: false,
		});
		expect(await value.ready({ screen: 'List', where: 'browser' })).toEqual({ notified: true });
		expect(
			ofKind(records, 'task.ready').map((e) => [e.screen, e.where, e.device ?? e.url])
		).toEqual([
			['Details', 'simulator', 'iPhone 17 Pro'],
			['List', 'browser', 'http://localhost:3000/details'],
		]);
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
async function setup(minutes: number) {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-smoke-'));
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
		settings: {
			modules: { browser: true },
			reviews: { smallTask: { files: 15, lines: 300 }, smokeMinutes: minutes },
		},
	});
	const project = await store.addProject(repo);
	const task = await store.createTask(project.id, 'Details screen', 'claude');
	return { store, key: { projectId: task.projectId, id: task.id } };
}
/** The built host with the scripted agent; a minute of the limit lasts `minuteMs`; the app side answers the browser's state. */
async function launch(store: SessionStore, key: TaskKey, minuteMs: number) {
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
		env: { ...process.env, BRIGADIR_SMOKE_MINUTE_MS: String(minuteMs) },
	});
	let diagnostics = '';
	child.stderr.on('data', (chunk) => {
		diagnostics += chunk;
	});
	cleanup.push(async () => {
		if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
	});
	const identity = await until(async () => {
		if (child.exitCode !== null) throw new Error(diagnostics);
		const id = await readIdentity(store, key);
		return id && id.pid === child.pid ? id : undefined;
	});
	const client = await connectHost(
		identity,
		() => {},
		() => {},
		() => {},
		async (method) => {
			if (method === 'browser')
				return { url: 'http://localhost:3000/clients/7', title: 'Client', tab: 'b1' };
			throw new Error('Unavailable in the test');
		}
	);
	cleanup.push(async () => client.close());
	await until(async () => ((await client.snapshot()).connected ? true : undefined));
	await client.startAgent();
	await until(async () =>
		(await client.snapshot()).records.find((r) => r.event.kind === 'session.started')
	);
	return { client, child };
}
const records = async (client: HostClient) => (await client.snapshot()).records;
async function turn(client: HostClient, text: string) {
	const before = (await records(client)).at(-1)?.seq ?? 0;
	await client.command({ kind: 'prompt', text });
	await until(async () =>
		(await records(client)).find((r) => r.seq > before && r.event.kind === 'turn.completed')
	);
	return (await records(client)).filter((r) => r.seq > before);
}
const agentText = (list: EventRecord[]) =>
	list
		.map((r) =>
			r.event.kind === 'message.delta' && r.event.content.kind === 'text'
				? r.event.content.text
				: ''
		)
		.join('');
const report = (steps: unknown[], summary: string) =>
	`@call smoke_report ${JSON.stringify({ steps, summary })}`;

describe('smoke run and Ready to look through the host', () => {
	it('a run in time files its report; Ready to look notifies once', async () => {
		const { store, key } = await setup(10);
		const { client } = await launch(store, key, 60_000);
		const out = await turn(
			client,
			[
				'@call ready_to_look {"screen":"Client card","where":"browser"}',
				'@call smoke_start {"steps":["Clients list","Client card"]}',
				'@call browser_state {}',
				report(
					[
						{ step: 'Clients list', result: 'passed' },
						{ step: 'Client card', result: 'passed' },
					],
					'Both flows work.'
				),
				'@call ready_to_look {"screen":"client card","where":"browser"}',
			].join('\n')
		);
		const text = agentText(out);
		expect(text).toContain('"limitMinutes":10');
		expect(text).toContain('"notified":false');
		expect(text).not.toContain('[error]');
		const list = await records(client);
		expect(ofKind(list, 'task.ready')).toEqual([
			expect.objectContaining({
				screen: 'Client card',
				where: 'browser',
				tab: 'b1',
				url: 'http://localhost:3000/clients/7',
			}),
		]);
		const reported = ofKind(list, 'smoke.reported')[0]!;
		expect(reported).toMatchObject({ summary: 'Both flows work.' });
		expect(reported.stopped).toBeUndefined();
		expect(ofKind(list, 'smoke.stopped')).toEqual([]);
		// The run is closed: no ask for the report, and a second report is refused.
		expect(
			list.some((r) => r.event.kind === 'turn.started' && r.event.crew?.kind === 'smoke-report')
		).toBe(false);
		expect(
			agentText(await turn(client, report([{ step: 'x', result: 'passed' }], 'again')))
		).toContain('No smoke run is open');
	}, 120_000);
	it('at the limit the browser is refused with the ask for the report, which keeps what was found', async () => {
		const { store, key } = await setup(1);
		const { client } = await launch(store, key, 1500);
		const out = await turn(
			client,
			[
				'@call smoke_start {"steps":["Clients list","Client card","Notes"]}',
				'@call browser_state {}',
				'@sleep 2500',
				'@call browser_state {}',
				report(
					[
						{ step: 'Clients list', result: 'passed' },
						{ step: 'Client card', result: 'failed', note: 'The avatar is missing.' },
					],
					'The list works; the card misses its avatar; notes not reached.'
				),
				'@call browser_state {}',
			].join('\n')
		);
		const text = agentText(out);
		expect(text).toContain(
			'browser_state: The smoke run reached its limit of 1 minute. Stop checking and file the report now with smoke_report'
		);
		const list = await records(client);
		expect(ofKind(list, 'smoke.stopped')).toEqual([expect.objectContaining({ cause: 'limit' })]);
		expect(ofKind(list, 'smoke.reported')[0]).toMatchObject({
			stopped: 'limit',
			steps: [
				{ step: 'Clients list', result: 'passed' },
				{ step: 'Client card', result: 'failed', note: 'The avatar is missing.' },
				{ step: 'Notes', result: 'unchecked', missing: true },
			],
		});
		// After the report the browser answers again: the last call is not refused.
		expect(text.trim().split('\n').at(-1)).not.toContain('[error]');
		// The run was reported in the turn: the host asks for nothing more.
		expect(
			list.some((r) => r.event.kind === 'turn.started' && r.event.crew?.kind === 'smoke-report')
		).toBe(false);
	}, 120_000);
	it('a host restarted mid-run keeps the run, stops it at the limit and asks for the report', async () => {
		const { store, key } = await setup(2);
		let { client, child } = await launch(store, key, 2000);
		const before = (await records(client)).at(-1)?.seq ?? 0;
		await client.command({
			kind: 'prompt',
			text: '@call smoke_start {"steps":["Clients list"]}\n@sleep 20000',
		});
		await until(async () => ofKind(await records(client), 'smoke.started')[0]);
		await client.command({ kind: 'shutdown' });
		await until(async () => (child.exitCode !== null ? true : undefined));
		({ client, child } = await launch(store, key, 2000));
		// The limit passes in the new host: it stops the run, the agent is idle, so it asks with a prompt.
		const reported = await until(
			async () => ofKind(await records(client), 'smoke.reported')[0],
			30_000
		);
		const list = (await records(client)).filter((r) => r.seq > before);
		expect(ofKind(list, 'smoke.stopped')).toEqual([expect.objectContaining({ cause: 'limit' })]);
		expect(
			list.some((r) => r.event.kind === 'turn.started' && r.event.crew?.kind === 'smoke-report')
		).toBe(true);
		expect(reported).toMatchObject({
			stopped: 'limit',
			steps: [{ step: 'Clients list', result: 'unchecked', note: 'the run stopped first' }],
		});
		expect(ofKind(list, 'smoke.dropped')).toEqual([]);
	}, 120_000);
});
