import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SessionStore } from '@brigadir/persistence';
import {
	builtinAgentTemplates,
	crewPalette,
	pendingInputs,
	resolveCrew,
	templateLookup,
	type AgentTask,
	type AutoTask,
	type CrewSpecAgent,
	type CrewTemplate,
	type CrewWorkerRecord,
	type EventRecord,
	type SessionEvent,
} from '@brigadir/core';
import { Snapshots, readChanges } from '@brigadir/git';
import { mcpTools } from './mcp';
import { AutoCrewHost, partUsage, uniqueName } from './auto-crew';
import { readCrewContext, sessionBrief, type CrewContext } from './crew';

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
	}).then((result) => result.stdout.trim());
const roles = () =>
	crewPalette(
		builtinAgentTemplates,
		{ lookup: templateLookup([...builtinAgentTemplates]), defaultProvider: 'claude' },
		[]
	).templates;
/** Workers are tasks in the store here: the launch path (worktrees, hosts) is the named crew's and has its own tests. */
class TestAutoHost extends AutoCrewHost {
	spawned: string[] = [];
	/** Fails the spawn of this many workers from now on (a crash in the middle of a hire). */
	failSpawns = 0;
	failAfter = Infinity;
	commands: unknown[] = [];
	linked = false;
	protected override link(key: Parameters<AutoCrewHost['link']>[0]) {
		if (!this.linked) return Promise.resolve(null);
		void key;
		return Promise.resolve({
			peer: {
				request: async (_method: string, params: unknown) => {
					this.commands.push(params);
					return null;
				},
			},
		} as never);
	}
	protected override async spawnWorkerTask(
		agent: CrewSpecAgent,
		title: string,
		prompt: string,
		_scopes: string[] = [],
		_selfReviewer = false,
		extra: Partial<CrewWorkerRecord> = {}
	): Promise<CrewWorkerRecord> {
		if (this.spawned.length >= this.failAfter) throw new Error('crashed');
		const store = this.deps.store;
		let task = await store.createTask(
			this.deps.key.projectId,
			prompt,
			agent.provider,
			'gui',
			title
		);
		task = await store.updateTask(task, {
			title,
			crewTaskId: this.deps.key.id,
			crewNodeId: agent.id,
			parentTaskId: this.deps.key.id,
		});
		const record: CrewWorkerRecord = {
			taskId: task.id,
			nodeId: agent.id,
			name: agent.name,
			title,
			createdAt: new Date().toISOString(),
			planPartId: null,
			...extra,
		};
		this.workers.push(record);
		await this.saveWorkers();
		this.spawned.push(task.id);
		return record;
	}
}
async function setup(
	options: {
		worktree?: boolean;
		app?: (method: string, params: unknown) => Promise<unknown> | null;
	} = {}
) {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-auto-'));
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	const repo = join(root, 'repo');
	await mkdir(join(repo, 'apps', 'api'), { recursive: true });
	await mkdir(join(repo, 'packages', 'types'), { recursive: true });
	await writeFile(join(repo, 'README.md'), 'hello\n');
	await writeFile(join(repo, 'apps', 'api', 'clients.ts'), 'export const clients = [];\n');
	await git(repo, 'init', '-q', '-b', 'main');
	await git(repo, 'add', '-A');
	await git(repo, 'commit', '-q', '-m', 'init');
	const store = await SessionStore.at(join(root, 'data')),
		project = await store.addProject(repo);
	const auto: AutoTask = { roles: roles(), budget: { minutes: 40, tokens: 400_000 } };
	let task = await store.createTask(project.id, 'Client details', 'claude');
	task = await store.updateTask(task, { auto });
	const snapshots = await Snapshots.open(store, task);
	await snapshots.capture('baseline');
	const events: SessionEvent[] = [],
		prompts: { text: string; marker: unknown }[] = [];
	const records = (): EventRecord[] =>
		events.map((event, seq) => ({ schemaVersion: 1, seq, at: new Date().toISOString(), event }));
	const context = (await readCrewContext(store, task))!;
	context.worktree = options.worktree ?? true;
	const make = () =>
		new TestAutoHost({
			store,
			key: task,
			context: { ...context, spec: structuredClone(context.spec) } as CrewContext,
			services: {
				dataDir: store.root,
				mcpEntry: resolve('apps/desktop/out/services/mcp-relay'),
				runtime: process.execPath,
				// The commit message generator fails at once and the message falls back to the task title.
				adapter: { command: process.execPath, args: ['-e', 'process.exit(1)'] },
			},
			emit: async (event) => {
				events.push(event);
			},
			prompt: async (text, marker) => {
				prompts.push({ text, marker });
			},
			records,
			parent: () => null,
			app: options.app ?? (() => null),
		});
	const host = make();
	cleanup.push(() => host.stop());
	return { root, repo, store, task, project, host, make, events, prompts, records, snapshots };
}
const until = async <T>(read: () => T | undefined, timeout = 5000): Promise<T> => {
	const end = Date.now() + timeout;
	for (;;) {
		const value = read();
		if (value !== undefined) return value;
		if (Date.now() > end) throw new Error('timed out');
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
};
const hireInput = {
	summary: 'Two endpoints, the screen and strings.',
	parts: [
		{
			title: 'API endpoints',
			role: 'Developer',
			zone: ['apps/api/**'],
			lines: 300,
			files: 4,
			prompt: 'Add the endpoints.',
		},
		{
			title: 'Details screen',
			role: 'Developer',
			zone: ['apps/mobile/**'],
			lines: 500,
			files: 6,
			prompt: 'Build the screen.',
			minutes: 50,
			tokens: 500_000,
		},
		{
			title: 'Client types',
			role: 'Developer',
			zone: ['apps/api/types.ts'],
			lines: 120,
			prompt: 'Types.',
		},
		{
			title: 'Strings',
			role: 'Developer',
			zone: ['apps/mobile-i18n/uk.json'],
			lines: 12,
			files: 1,
			prompt: 'Strings.',
		},
	],
};
const pendingHire = (events: SessionEvent[]) =>
	events.findLast(
		(event): event is Extract<SessionEvent, { kind: 'crew.hire.requested' }> =>
			event.kind === 'crew.hire.requested'
	)?.hire;

describe('spec/crew#auto-tools: the tool set of an Auto session', () => {
	const names = (role: Parameters<typeof mcpTools>[0]) =>
		(mcpTools(role).list.tools as { name: string }[]).map((tool) => tool.name);
	it('has the hire tools and the person’s tools from the first session, and no plan tools', () => {
		const auto = names('auto');
		expect(auto).toEqual(
			expect.arrayContaining([
				'hire_workers',
				'dismiss_worker',
				'request_model',
				'prompt_task',
				'accept_task',
				'read_report',
				'ask_user',
				'create_task',
			])
		);
		expect(auto).not.toContain('propose_plan');
		expect(auto).not.toContain('create_worker_task');
		expect(names('foreman')).not.toContain('hire_workers');
	});
	it('the same brief reaches Claude and Codex; Codex also gets the tools line', async () => {
		const { store, task } = await setup();
		const context = (await readCrewContext(store, {
			...task,
			launch: { isolation: 'worktree' } as NonNullable<AgentTask['launch']>,
		}))!;
		expect(context.role).toBe('auto');
		const tools = { browser: true, simulator: false, commands: false };
		const claude = sessionBrief(context, 'claude', { tools }),
			codex = sessionBrief(context, 'codex', { tools });
		for (const brief of [claude, codex]) {
			expect(brief).toContain('You do this task yourself');
			expect(brief).toContain('hire_workers');
			expect(brief).toContain('`Developer`');
			expect(brief).not.toContain('You do not write code yourself');
		}
		expect(claude).toContain('EnterPlanMode');
		expect(codex).toContain('This app gives you');
		const alone = (await readCrewContext(store, task))!;
		expect(sessionBrief(alone, 'claude', { tools })).toContain('you cannot hire workers here');
	});
	it('a CLI task with auto stays one agent', async () => {
		const { store, task } = await setup();
		expect(await readCrewContext(store, { ...task, transport: 'terminal' })).toBeNull();
	});
});

describe('spec/crew#auto-hire', () => {
	it('shows the card with the refused parts and hires the rest after the agent’s edits are committed', async () => {
		const { repo, store, task, host, events, snapshots } = await setup();
		await writeFile(
			join(repo, 'packages', 'types', 'client.ts'),
			'export type Client = { id: string };\n'
		);
		await snapshots.capture('turn');
		const before = await readChanges(store, task);
		const call = host.tool('hire_workers', hireInput, new AbortController().signal);
		const hire = await until(() => pendingHire(events));
		expect(pendingInputs(host['deps'].records()).crewHire?.id).toBe(hire.id);
		expect(hire.parts.map((part) => part.refused?.code ?? null)).toEqual([
			null,
			null,
			'overlap',
			'small',
		]);
		expect(hire.parts[1]!.budget).toEqual({ minutes: 50, tokens: 500_000 });
		expect(host.spawned).toHaveLength(0);
		// The person changes the first part's role and budget.
		const edited = hire.parts.map((part, index) =>
			index === 0
				? {
						...part,
						role: 'senior-developer',
						roleName: 'Senior developer',
						budget: { minutes: 60, tokens: 600_000 },
					}
				: part
		);
		await host.decideHire({ id: hire.id, approved: true, parts: edited });
		const result = (await call) as {
			approved: boolean;
			hired: { worker: string; role: string; title: string }[];
			staysWithYou: { title: string }[];
		};
		expect(result.approved).toBe(true);
		expect(result.hired.map((item) => [item.worker, item.role, item.title])).toEqual([
			['Senior developer', 'Senior developer', 'API endpoints'],
			['Developer', 'Developer', 'Details screen'],
		]);
		expect(result.staysWithYou.map((item) => item.title)).toEqual(['Client types', 'Strings']);
		// spec/crew#auto-commit: the agent's file is in a commit of the task's branch, before the workers started.
		expect(await git(repo, 'status', '--porcelain')).toBe('');
		expect(await git(repo, 'log', '-1', '--format=%s')).toBe('Client details');
		const committed = events.findIndex((event) => event.kind === 'crew.lead.committed'),
			resolved = events.findIndex((event) => event.kind === 'crew.hire.resolved');
		expect(committed).toBeGreaterThan(-1);
		expect(committed).toBeLessThan(resolved);
		// The snapshot engine diffs trees: the task's changes are the same after the commit.
		await snapshots.capture('turn');
		const after = await readChanges(store, task);
		expect(after.files.map((file) => file.path)).toEqual(before.files.map((file) => file.path));
		const saved = await store.task(task);
		expect(saved.crew?.root.agents.map((node) => [node.name, node.zone])).toEqual([
			['Senior developer', ['apps/api/**']],
			['Developer', ['apps/mobile/**']],
		]);
		const head = await git(repo, 'rev-parse', 'HEAD');
		expect(host['workers'].map((worker) => [worker.budget, worker.hiredFrom])).toEqual([
			[{ minutes: 60, tokens: 600_000 }, { '': head }],
			[{ minutes: 50, tokens: 500_000 }, { '': head }],
		]);
		expect(pendingInputs(host['deps'].records()).crewHire).toBeNull();
	});
	it('a declined hire leaves the agent alone: nothing committed, no crew', async () => {
		const { repo, store, task, host, events } = await setup();
		await writeFile(join(repo, 'README.md'), 'changed\n');
		const call = host.tool('hire_workers', hireInput, new AbortController().signal);
		const hire = await until(() => pendingHire(events));
		await host.decideHire({ id: hire.id, approved: false, parts: null });
		expect(await call).toMatchObject({
			approved: false,
			note: expect.stringContaining('yourself'),
		});
		expect(await git(repo, 'status', '--porcelain')).not.toBe('');
		expect((await store.task(task)).crew).toBeUndefined();
		expect(host.spawned).toHaveLength(0);
	});
	it('no card when every part is refused', async () => {
		const { host, events } = await setup();
		const reply = await host.tool(
			'hire_workers',
			{ parts: [{ title: 'Tiny', role: 'Developer', zone: ['a.ts'], lines: 5, prompt: 'x' }] },
			new AbortController().signal
		);
		expect(reply).toMatchObject({ approved: false, refused: [{ title: 'Tiny' }] });
		expect(events.some((event) => event.kind === 'crew.hire.requested')).toBe(false);
	});
	it('the card survives a restart: the decision goes to the agent as a prompt', async () => {
		const { host, make, events, prompts } = await setup();
		void host.tool('hire_workers', hireInput, new AbortController().signal).catch(() => {});
		const hire = await until(() => pendingHire(events));
		await host.stop();
		const restarted = make();
		cleanup.push(() => restarted.stop());
		await restarted.decideHire({ id: hire.id, approved: true, parts: null });
		expect(restarted.spawned).toHaveLength(2);
		expect(prompts.at(-1)?.marker).toEqual({
			kind: 'hire-decision',
			hireId: hire.id,
			approved: true,
		});
		expect(prompts.at(-1)?.text).toContain('Details screen');
		await expect(
			restarted.decideHire({ id: hire.id, approved: true, parts: null })
		).rejects.toThrow('no longer pending');
	});
	it('hiring needs a worktree', async () => {
		const { host } = await setup({ worktree: false });
		await expect(
			host.tool('hire_workers', hireInput, new AbortController().signal)
		).rejects.toThrow('Hiring needs this task to run in a worktree');
	});
	it('refuses an unknown role and names the roles', async () => {
		const { host } = await setup();
		await expect(
			host.tool(
				'hire_workers',
				{ parts: [{ ...hireInput.parts[0], role: 'Astronaut' }] },
				new AbortController().signal
			)
		).rejects.toThrow(/Unknown role Astronaut.*Developer.*request_model/);
	});
});

describe('spec/crew#auto-dismiss, spec/crew#auto-budget, spec/crew#auto-guard', () => {
	async function hired() {
		const fixture = await setup();
		const call = fixture.host.tool('hire_workers', hireInput, new AbortController().signal);
		const hire = await until(() => pendingHire(fixture.events));
		await fixture.host.decideHire({ id: hire.id, approved: true, parts: null });
		await call;
		return fixture;
	}
	it('dismissing a worker keeps its task and refuses further prompts', async () => {
		const { host, store, task, events } = await hired();
		const worker = host['workers'][0]!;
		const reply = await host.tool(
			'dismiss_worker',
			{ taskId: worker.taskId },
			new AbortController().signal
		);
		expect(reply).toMatchObject({ dismissed: true });
		expect(worker).toMatchObject({ dismissReason: 'discarded', dismissedAt: expect.any(String) });
		expect(events.at(-1)).toMatchObject({
			kind: 'crew.worker.dismissed',
			reason: 'discarded',
			title: 'API endpoints',
		});
		expect((await store.task({ projectId: task.projectId, id: worker.taskId })).status).toBe(
			'completed'
		);
		await expect(
			host.tool(
				'prompt_task',
				{ taskId: worker.taskId, text: 'more' },
				new AbortController().signal
			)
		).rejects.toThrow('dismissed');
		await expect(
			host.tool('accept_task', { taskId: worker.taskId }, new AbortController().signal)
		).rejects.toThrow('dismissed');
		// The person's Dismiss on the other worker.
		await host.dismissWorker(host['workers'][1]!.taskId);
		expect(host['workers'][1]).toMatchObject({ dismissReason: 'person' });
		expect(host.settled()).toBe(true);
	});
	it('a part over its budget goes to the person once', async () => {
		const { host, store, task, events } = await hired();
		const worker = host['workers'][0]!,
			key = { projectId: task.projectId, id: worker.taskId };
		const writer = await store.writer(key);
		await writer.append({ kind: 'turn.started', text: 'go' });
		await writer.append({
			kind: 'turn.usage',
			input: 100_000,
			output: 20_000,
			cacheRead: 5_000_000,
			cacheWrite: 0,
		});
		await writer.close();
		await host.checkBudgets(Date.now());
		expect(worker.exceededAt).toBeUndefined();
		await host.checkBudgets(Date.now() + 41 * 60_000);
		expect(worker.exceededAt).toEqual(expect.any(String));
		const exceeded = events.filter((event) => event.kind === 'crew.budget.exceeded');
		expect(exceeded).toHaveLength(1);
		expect(exceeded[0]).toMatchObject({ taskId: worker.taskId, used: { tokens: 120_000 } });
		await host.checkBudgets(Date.now() + 90 * 60_000);
		expect(events.filter((event) => event.kind === 'crew.budget.exceeded')).toHaveLength(1);
	});
	it('names the agent’s own changes inside a hired zone once, and refuses writes through the file layer', async () => {
		const { host, repo, events, prompts } = await hired();
		expect(host.hiredZone('apps/api/clients.ts')).toEqual({
			name: 'Developer',
			title: 'API endpoints',
		});
		expect(host.hiredZone('README.md')).toBeNull();
		await writeFile(join(repo, 'apps', 'api', 'clients.ts'), 'export const clients = [1];\n');
		await writeFile(join(repo, 'README.md'), 'mine\n');
		await host.checkZones();
		expect(events.at(-1)).toMatchObject({
			kind: 'crew.zone.touched',
			paths: ['apps/api/clients.ts'],
		});
		expect(prompts.at(-1)?.marker).toEqual({
			kind: 'zone-touched',
			taskId: host['workers'][0]!.taskId,
			agent: 'Developer',
		});
		await host.checkZones();
		expect(events.filter((event) => event.kind === 'crew.zone.touched')).toHaveLength(1);
	});
	it('counts working minutes inside turns and tokens without cache reads', () => {
		const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();
		const records: EventRecord[] = [
			{ schemaVersion: 1, seq: 1, at: at(0), event: { kind: 'turn.started', text: 'a' } },
			{
				schemaVersion: 1,
				seq: 2,
				at: at(10),
				event: { kind: 'turn.usage', input: 1000, output: 500, cacheRead: 99_999, cacheWrite: 200 },
			},
			{
				schemaVersion: 1,
				seq: 3,
				at: at(10),
				event: { kind: 'turn.completed', reason: 'end_turn' },
			},
			{ schemaVersion: 1, seq: 4, at: at(50), event: { kind: 'turn.started', text: 'b' } },
		];
		expect(partUsage(records, Date.parse(at(55)))).toEqual({ minutes: 15, tokens: 1700 });
		// The running turn counts as the task counter counts it: the growth of its context is an estimate until its turn.usage.
		const usage = (seq: number, used: number): EventRecord => ({
			schemaVersion: 1,
			seq,
			at: at(52),
			event: { kind: 'usage.changed', used, capacity: 200_000, cost: null },
		});
		const running = [...records, usage(5, 10_000), usage(6, 14_000)];
		expect(partUsage(running, Date.parse(at(55)))).toEqual({ minutes: 15, tokens: 15_700 });
	});
});

describe('spec/crew#auto-commit before an accept', () => {
	it('commits the agent’s edits and leaves the task’s diff as it was', async () => {
		const { host, repo, store, task, events, snapshots } = await setup();
		await writeFile(join(repo, 'README.md'), 'lead edit\n');
		await snapshots.capture('turn');
		const before = await readChanges(store, task);
		await host['beforeAccept']({
			taskId: 'w',
			nodeId: 'n',
			name: 'Developer',
			title: 'API',
			createdAt: '',
			planPartId: null,
		});
		expect(await git(repo, 'status', '--porcelain')).toBe('');
		expect(events.at(-1)).toMatchObject({ kind: 'crew.lead.committed', reason: 'accept' });
		await snapshots.capture('turn');
		expect((await readChanges(store, task)).files).toEqual(before.files);
		// Nothing to commit: no commit and no event.
		const count = events.length;
		await host['beforeAccept']({
			taskId: 'w',
			nodeId: 'n',
			name: 'Developer',
			title: 'API',
			createdAt: '',
			planPartId: null,
		});
		expect(events).toHaveLength(count);
	});
});

describe('spec/crew#auto-model', () => {
	it('the person picks a model and saves it as a role; the agent hires with it', async () => {
		const { host, store, task, events } = await setup();
		const call = host.tool(
			'request_model',
			{ reason: 'Works from screenshots.', part: 'Details screen' },
			new AbortController().signal
		);
		const request = await until(
			() =>
				events.findLast(
					(event): event is Extract<SessionEvent, { kind: 'crew.model.requested' }> =>
						event.kind === 'crew.model.requested'
				)?.request
		);
		expect(request).toMatchObject({ role: 'Developer', part: 'Details screen' });
		expect(pendingInputs(host['deps'].records()).crewModels).toHaveLength(1);
		await host.answerModel(request.id, {
			provider: 'codex',
			model: { id: 'model', value: 'gpt-6-astra', name: 'GPT-6 Astra' },
			effort: { id: 'reasoning_effort', value: 'high', name: 'High' },
			saveAs: 'Vision developer',
		});
		expect(await call).toMatchObject({ role: 'Vision developer' });
		const roles = (await store.task(task)).auto!.roles;
		expect(roles.at(-1)).toMatchObject({ name: 'Vision developer', provider: 'codex' });
		expect(events.at(-1)).toMatchObject({
			kind: 'crew.model.resolved',
			by: 'person',
			role: 'Vision developer',
		});
		expect(pendingInputs(host['deps'].records()).crewModels).toHaveLength(0);
	});
	it('keeping the base role adds nothing', async () => {
		const { host, store, task, events } = await setup();
		const count = (await store.task(task)).auto!.roles.length;
		const call = host.tool(
			'request_model',
			{ reason: 'x', role: 'Tester' },
			new AbortController().signal
		);
		const request = await until(
			() =>
				events.findLast(
					(event): event is Extract<SessionEvent, { kind: 'crew.model.requested' }> =>
						event.kind === 'crew.model.requested'
				)?.request
		);
		await host.answerModel(request.id, null);
		expect(await call).toMatchObject({ role: 'Tester' });
		expect((await store.task(task)).auto!.roles).toHaveLength(count);
	});
	it('with Any catalog model the app resolves it and no card shows', async () => {
		const asked: unknown[] = [];
		const { host, events } = await setup({
			app: (method, params) => {
				asked.push([method, params]);
				return Promise.resolve({
					provider: 'codex',
					model: { id: 'model', value: 'gpt-6-luna', name: 'GPT-6 Luna' },
					effort: null,
				});
			},
		});
		const reply = await host.tool(
			'request_model',
			{ reason: 'x', provider: 'codex', model: 'GPT-6 Luna' },
			new AbortController().signal
		);
		expect(reply).toMatchObject({ role: 'Developer · GPT-6 Luna' });
		expect(asked[0]).toEqual([
			'auto_model',
			expect.objectContaining({ provider: 'codex', model: 'GPT-6 Luna' }),
		]);
		expect(events.some((event) => event.kind === 'crew.model.requested')).toBe(false);
		expect(events.at(-1)).toMatchObject({ kind: 'crew.model.resolved', by: 'agent' });
	});
	it('with the setting off the app says to ask, and the card shows', async () => {
		const { host, events } = await setup({ app: () => Promise.resolve({ ask: true }) });
		void host.tool('request_model', { reason: 'x' }, new AbortController().signal).catch(() => {});
		await until(() =>
			events.some((event) => event.kind === 'crew.model.requested') ? true : undefined
		);
	});
});

describe('old tasks still load', () => {
	const crewOf = (template: CrewTemplate) =>
		resolveCrew(template, {
			lookup: templateLookup([...builtinAgentTemplates]),
			defaultProvider: 'claude',
		});
	it('a foreman of a named crew keeps the foreman role and brief', async () => {
		const { store, project } = await setup();
		let task = await store.createTask(project.id, 'Crew', 'claude');
		task = await store.updateTask(task, {
			crew: crewOf({
				schemaVersion: 1,
				id: 'one',
				name: 'One',
				builtin: false,
				root: {
					id: 'root',
					name: 'Foreman',
					template: 'foreman-default',
					agents: [{ id: 'd', name: 'Dev', template: 'developer' }],
				},
			}),
		});
		const context = (await readCrewContext(store, task))!;
		expect(context.role).toBe('foreman');
		expect(sessionBrief(context, 'claude')).toContain('You do not write code yourself');
	});
	it('a crew snapshot with a palette (made before Auto) still composes', async () => {
		const { store, project } = await setup();
		const spec = {
			...crewOf({
				schemaVersion: 1,
				id: 'compose',
				name: 'Crew',
				builtin: true,
				root: { id: 'root', name: 'Foreman', template: 'foreman-default' },
			}),
			templateId: 'compose',
			compose: { templates: roles(), providers: [] },
		};
		let task = await store.createTask(project.id, 'Composed', 'claude');
		task = await store.updateTask(task, { crew: spec });
		const context = (await readCrewContext(store, task))!;
		expect(context.role).toBe('foreman');
		expect(sessionBrief(context, 'claude')).toContain('You compose your crew yourself');
	});
	it('a hire file from a crashed write is not a pending hire', async () => {
		const { host, store, task } = await setup();
		await writeFile(
			join(await store.taskDir(task), 'crew-hire.json'),
			'{"schemaVersion":1,"hire":{"id":"x"},"decision":null}'
		);
		await expect(host.decideHire({ id: 'x', approved: false, parts: null })).rejects.toThrow(
			'no longer pending'
		);
		expect(
			JSON.parse(await readFile(join(await store.taskDir(task), 'crew-hire.json'), 'utf8')).hire.id
		).toBe('x');
	});
});

describe('review fixes', () => {
	const signal = () => new AbortController().signal;
	async function hiredFixture() {
		const fixture = await setup();
		const call = fixture.host.tool('hire_workers', hireInput, signal());
		const hire = await until(() => pendingHire(fixture.events));
		await fixture.host.decideHire({ id: hire.id, approved: true, parts: null });
		await call;
		return fixture;
	}
	it('1: the role chosen on the sheet reaches an Auto agent before its Auto brief', async () => {
		const { store, task } = await setup();
		const context = (await readCrewContext(store, task))!;
		const brief = sessionBrief(context, 'claude', { role: 'You write tests only.' });
		expect(brief.indexOf('You write tests only.')).toBeGreaterThanOrEqual(0);
		expect(brief.indexOf('You write tests only.')).toBeLessThan(
			brief.indexOf('You do this task yourself')
		);
	});
	it('2: a second hire in the same turn is refused before it can replace the first', async () => {
		const { host, events } = await setup();
		const first = host.tool('hire_workers', hireInput, signal());
		await expect(host.tool('hire_workers', hireInput, signal())).rejects.toThrow('already waiting');
		const hire = await until(() => pendingHire(events));
		expect(events.filter((event) => event.kind === 'crew.hire.requested')).toHaveLength(1);
		await host.decideHire({ id: hire.id, approved: false, parts: null });
		expect(await first).toMatchObject({ approved: false });
	});
	it('3: a hire decided again after a crash starts only the parts with no worker, and a double press starts nothing twice', async () => {
		const { host, events, store, task } = await setup();
		void host.tool('hire_workers', hireInput, signal()).catch(() => {});
		const hire = await until(() => pendingHire(events));
		host.failAfter = 1;
		await expect(host.decideHire({ id: hire.id, approved: true, parts: null })).rejects.toThrow(
			'crashed'
		);
		expect(host.spawned).toHaveLength(1);
		expect(pendingInputs(host['deps'].records()).crewHire?.id).toBe(hire.id);
		host.failAfter = Infinity;
		const again = host.decideHire({ id: hire.id, approved: true, parts: null });
		await expect(host.decideHire({ id: hire.id, approved: true, parts: null })).rejects.toThrow(
			'being decided'
		);
		await again;
		expect(host.spawned).toHaveLength(2);
		const resolved = events.findLast((event) => event.kind === 'crew.hire.resolved');
		expect(resolved).toMatchObject({ approved: true });
		expect(
			resolved?.kind === 'crew.hire.resolved' && resolved.hired.map((item) => item.taskId)
		).toEqual(host.spawned);
		expect((await store.task(task)).crew?.root.agents).toHaveLength(2);
	});
	it('4: a dismissed worker does not start from its slot', async () => {
		const { host, store, task } = await hiredFixture();
		const worker = host['workers'][0]!,
			key = { projectId: task.projectId, id: worker.taskId };
		await host.tool('dismiss_worker', { taskId: worker.taskId }, signal());
		await store.setStatus(key, 'queued');
		await host['launchWorker'](worker);
		expect((await store.task(key)).status).toBe('queued');
		expect((await store.task(key)).preparation).toBeUndefined();
	});
	it('5: submit_review does not restart a dismissed worker or one over its budget', async () => {
		const { host } = await hiredFixture();
		const [dismissed, over] = host['workers'];
		await host.tool('dismiss_worker', { taskId: dismissed!.taskId }, signal());
		const review = (taskId: string) =>
			host.tool(
				'submit_review',
				{ taskId, comments: [{ path: 'apps/api/a.ts', start: 1, text: 'x' }] },
				signal()
			);
		await expect(review(dismissed!.taskId)).rejects.toThrow('dismissed');
		over!.exceededAt = new Date().toISOString();
		await expect(review(over!.taskId)).rejects.toThrow('over its budget');
	});
	it('6: a role name at the length limit still gets a unique worker name', async () => {
		expect(uniqueName('L'.repeat(80), new Set(['L'.repeat(80)]))).toBe(`${'L'.repeat(78)} 2`);
		expect(uniqueName('Dev', new Set(['Dev', 'Dev 2']))).toBe('Dev 3');
		const { host, events } = await setup();
		const auto = host['deps'].context.auto!,
			long = {
				...auto.roles.find((role) => role.id === 'developer')!,
				id: 'long-role',
				name: 'L'.repeat(80),
			};
		auto.roles.push(long);
		const call = host.tool(
			'hire_workers',
			{ parts: hireInput.parts.slice(0, 2).map((part) => ({ ...part, role: long.name })) },
			signal()
		);
		const hire = await until(() => pendingHire(events));
		await host.decideHire({ id: hire.id, approved: true, parts: null });
		expect(
			((await call) as { hired: { worker: string }[] }).hired.map((item) => item.worker)
		).toEqual(['L'.repeat(80), `${'L'.repeat(78)} 2`]);
	});
	it('7: a hired reviewer reports like a part; a reviewer of a check edge does not', async () => {
		const { host, events } = await setup();
		const call = host.tool(
			'hire_workers',
			{ parts: [{ ...hireInput.parts[0], role: 'Reviewer', title: 'Check the API' }] },
			signal()
		);
		const hire = await until(() => pendingHire(events));
		await host.decideHire({ id: hire.id, approved: true, parts: null });
		await call;
		const node = host['deps'].context.spec.root.agents.at(-1)!;
		expect(node.role).toBe('reviewer');
		expect(host['isReviewWorker'](node)).toBe(true);
		expect(host['isReviewWorker']({ ...node, id: 'edge-reviewer' })).toBe(false);
	});
	it('8: a task edited to a checker’s role is a solo checker, not Auto', async () => {
		const { store, task } = await setup();
		expect(await readCrewContext(store, { ...task, readOnlyAgent: true })).toBeNull();
	});
	it('9: a budget stop that could not be delivered is sent again until the worker takes it', async () => {
		const { host, store, task, events } = await hiredFixture();
		const worker = host['workers'][0]!,
			key = { projectId: task.projectId, id: worker.taskId };
		const writer = await store.writer(key);
		await writer.append({ kind: 'turn.started', text: 'go' });
		await writer.close();
		const later = Date.now() + 41 * 60_000;
		await host.checkBudgets(later);
		expect(worker.exceededAt).toEqual(expect.any(String));
		expect(worker.budgetStopped).toBeUndefined();
		host.linked = true;
		await host.checkBudgets(later);
		expect(worker.budgetStopped).toEqual(expect.any(String));
		expect(host.commands).toEqual([
			expect.objectContaining({ kind: 'overBudget', title: worker.title }),
		]);
		await host.checkBudgets(later);
		expect(host.commands).toHaveLength(1);
		expect(events.filter((event) => event.kind === 'crew.budget.exceeded')).toHaveLength(1);
	});
	it('10: a cancelled model question closes its card', async () => {
		const { host, events } = await setup();
		const controller = new AbortController();
		const call = host.tool('request_model', { reason: 'x', part: 'Screen' }, controller.signal);
		await until(() =>
			events.some((event) => event.kind === 'crew.model.requested') ? true : undefined
		);
		controller.abort();
		await expect(call).rejects.toThrow('cancelled');
		await until(() =>
			events.some((event) => event.kind === 'crew.model.resolved') ? true : undefined
		);
		expect(events.at(-1)).toMatchObject({
			kind: 'crew.model.resolved',
			answer: null,
			cancelled: true,
			part: 'Screen',
		});
		expect(pendingInputs(host['deps'].records()).crewModels).toHaveLength(0);
	});
});
