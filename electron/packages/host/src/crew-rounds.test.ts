import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SessionStore, readDocument } from '@brigadir/persistence';
import {
	builtinAgentTemplates,
	resolveCrew,
	templateLookup,
	type CrewTemplate,
	type CrewWorkerRecord,
	type EventRecord,
	type ReviewRun,
	type SessionEvent,
	type TaskKey,
} from '@brigadir/core';
import { CrewHost, crewHiddenTools, crewPlanExists, partBrief, type CrewContext } from './crew';

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
/**
 * A root foreman CrewHost in-process (spec/crew#reviewer): worker hosts are never launched — a worker's turn is written into its journal and its report
 * handed to `handleReport` as the worker host would push it; the link to a worker answers every command and records the prompts.
 */
async function crew(
	prompt = 'Build the client details screen in out/. Prove it with pnpm test out.'
) {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-crew-rounds-'));
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	const repo = join(root, 'repo');
	await mkdir(repo, { recursive: true });
	await git(repo, 'init', '-q', '-b', 'main');
	await writeFile(join(repo, 'a.txt'), 'a\n');
	await git(repo, 'add', '-A');
	await git(repo, 'commit', '-q', '-m', 'init');
	const store = await SessionStore.at(join(root, 'data')),
		project = await store.addProject(repo);
	const spec = resolveCrew(reviewLoop, {
		lookup: templateLookup([...builtinAgentTemplates]),
		defaultProvider: 'claude',
		now: new Date().toISOString(),
	});
	let task = await store.createTask(project.id, 'Split the work', 'claude');
	task = await store.updateTask(task, { crew: spec });
	// The person approved a plan before any worker starts (spec/crew#plan).
	const events: SessionEvent[] = [
		{ kind: 'crew.plan.resolved', id: 'plan', approved: true, parts: [] },
	];
	const prompts: { text: string; kind: string | undefined }[] = [];
	const sent: { taskId: string; text: string }[] = [];
	const context: CrewContext = {
		role: 'foreman',
		crewKey: task,
		spec,
		node: spec.root,
		parent: null,
		parentKey: null,
		isRoot: true,
	};
	const host = new CrewHost({
		store,
		key: task,
		context,
		services: {
			dataDir: store.root,
			mcpEntry: resolve('apps/desktop/out/services/mcp-relay'),
			runtime: process.execPath,
		},
		emit: async (event) => {
			events.push(event);
		},
		prompt: async (text, marker) => {
			prompts.push({ text, kind: marker?.kind });
		},
		records: () => events.map((event, seq) => ({ schemaVersion: 1, seq, at: '', event })),
		parent: () => null,
	});
	host['watchSlots'] = () => {};
	host['spawn'] = (async (key: TaskKey) => ({
		key,
		peer: {
			request: async (_method: string, params: { kind: string; text?: string }) => {
				if (params.kind === 'prompt') sent.push({ taskId: key.id, text: params.text ?? '' });
				return {};
			},
		},
	})) as never;
	await host.start();
	const signal = new AbortController().signal;
	const created = (await host.tool(
		'create_worker_task',
		{
			agent: 'Developer',
			title: 'Client details',
			prompt,
			acceptance: 'The screen shows the name, phone and notes; pnpm test out passes.',
			files: ['out/**'],
		},
		signal
	)) as { taskId: string };
	const workers = () => host['workers'] as CrewWorkerRecord[];
	const developer = () => workers().find((item) => item.taskId === created.taskId)!;
	const reviewer = () => workers().find((item) => item.nodeId === 'reviewer')!;
	const key = { projectId: task.projectId, id: created.taskId };
	const writer = await store.writer(key);
	cleanup.unshift(() => writer.close());
	let files = 1;
	host['partFiles'] = async () => files;
	/**
	 * The developer ends a turn: its task status and turn end as the worker host writes them, then its report is pushed — with the status that turn
	 * left when `pushed` is given, as a current worker host sends it, or without one, as an older outbox holds it.
	 */
	const report = async (
		status: 'done' | 'interrupted' = 'done',
		reason = 'end_turn',
		pushed?: string
	) => {
		await writer.append({ kind: 'turn.started', text: 'work' });
		const ended = await writer.append({ kind: 'turn.completed', reason });
		await store.setStatus(key, status);
		await host['handleReport'](developer(), ended.seq, pushed);
	};
	const runs = () => host['reviews'] as ReviewRun[];
	/** Every reviewer of the open run gives its verdict, as `submit_review` / `approve` record it. */
	const verdict = async (approved: boolean) => {
		const open = runs().find((item) => item.state === 'reviewing')!;
		open.verdicts.push({
			reviewerNodeId: reviewer().nodeId,
			reviewer: reviewer().name,
			approved,
			comments: approved ? 0 : 1,
			at: new Date().toISOString(),
		});
		await host['settleRun'](open);
	};
	return {
		store,
		key,
		host,
		events,
		prompts,
		sent,
		signal,
		created,
		developer,
		reviewer,
		report,
		runs,
		verdict,
		setFiles: (count: number) => {
			files = count;
		},
	};
}

it('counts review rounds per part, never restarted by a return: after a dispute and a return the next report opens no new round (spec/crew#review-limit)', async () => {
	const { host, prompts, signal, created, developer, report, runs, verdict } = await crew();
	await report();
	expect(runs().map((item) => [item.round, item.state])).toEqual([[1, 'reviewing']]);
	await verdict(false);
	// The fix report is round 2; the reviewer still disagrees, so the part is disputed and goes up.
	await report();
	await verdict(false);
	expect(runs().map((item) => [item.round, item.state])).toEqual([
		[1, 'comments'],
		[2, 'disputed'],
	]);
	const dispute = prompts.at(-1)!;
	expect(dispute.text).toContain('did not agree after two rounds');
	expect(dispute.text).toContain('reached its review limit');
	expect(dispute.text).toContain(
		'Accept it with accept_task, or put the decision to the human with ask_user'
	);
	expect(developer()).toMatchObject({ rounds: 2, limitTold: true });
	// The foreman returns the work anyway: the return spends nothing and restarts nothing.
	await host.tool('prompt_task', { taskId: created.taskId, text: 'Fix the phone format.' }, signal);
	expect(developer().rounds).toBe(2);
	const before = prompts.length;
	await report();
	// No third run: the run left in `comments` no longer makes the next report «round 2» again.
	expect(runs()).toHaveLength(2);
	expect(prompts).toHaveLength(before + 1);
	expect(prompts.at(-1)!.kind).toBe('report');
	expect(prompts.at(-1)!.text).not.toContain('review limit');
	// And again: every later report of the part goes straight up, never to the reviewer.
	await host.tool('prompt_task', { taskId: created.taskId, text: 'One more thing.' }, signal);
	await report();
	expect(runs()).toHaveLength(2);
});

it('reviews the fix after a return that followed an approval, and tells the foreman once when both checks are spent (spec/crew#review-limit)', async () => {
	const { host, prompts, signal, created, developer, report, runs, verdict } = await crew();
	// A clarification before the first report spends nothing.
	await host.tool(
		'prompt_task',
		{ taskId: created.taskId, text: 'Use the shared phone field.' },
		signal
	);
	expect(developer().rounds ?? 0).toBe(0);
	await report();
	await verdict(true);
	expect(prompts.at(-1)!.text).toContain('Reviewer approved');
	await host.tool('prompt_task', { taskId: created.taskId, text: 'Rename the field.' }, signal);
	await report();
	expect(runs().map((item) => [item.round, item.state])).toEqual([
		[1, 'approved'],
		[2, 'reviewing'],
	]);
	await verdict(true);
	await host.tool('prompt_task', { taskId: created.taskId, text: 'And the label.' }, signal);
	await report();
	expect(runs()).toHaveLength(2);
	expect(prompts.at(-1)!.text).toContain('This part reached its review limit: 2 checks.');
	expect(prompts.at(-1)!.text).not.toContain('comments stay open');
	await host.tool('prompt_task', { taskId: created.taskId, text: 'And the icon.' }, signal);
	await report();
	expect(prompts.at(-1)!.text).not.toContain('review limit');
});

it('opens a review only for a done report with changed files; other reports go up without spending a round (spec/crew#reports)', async () => {
	const { prompts, developer, report, runs, setFiles } = await crew();
	await report('interrupted', 'cancelled');
	await report('done', 'max_tokens');
	expect(runs()).toEqual([]);
	expect(prompts.map((item) => item.kind)).toEqual(['report', 'report']);
	setFiles(0);
	await report();
	expect(runs()).toEqual([]);
	expect(developer().rounds ?? 0).toBe(0);
	setFiles(3);
	await report();
	expect(runs().map((item) => [item.round, item.state, item.part])).toEqual([[1, 'reviewing', 1]]);
	expect(developer().rounds).toBe(1);
});

it('judges a report by the status its own turn left, not by the task status when it arrives (spec/crew#reports)', async () => {
	const { developer, report, runs } = await crew();
	// A rate-limited end_turn whose report waited in the outbox while the retry finished: the task is done now, the report was not.
	await report('done', 'end_turn', 'rate-limited');
	expect(runs()).toEqual([]);
	expect(developer().rounds ?? 0).toBe(0);
	// The retry's own report opens the one check.
	await report('done', 'end_turn', 'done');
	expect(runs().map((item) => item.round)).toEqual([1]);
	expect(developer().rounds).toBe(1);
	// An interrupted turn whose task is done again by the time its report arrives is still not done.
	await report('done', 'cancelled', 'interrupted');
	expect(runs().filter((item) => item.state === 'reviewing')).toEqual([]);
	expect(developer().rounds).toBe(1);
});

it('makes an open check stale on any newer report, interrupted or empty (spec/crew#reviewer)', async () => {
	const { host, reviewer, created, report, runs, setFiles } = await crew();
	const approve = (reviewId: string) =>
		host['reviewerTool'](reviewer(), 'approve', { taskId: created.taskId, reviewId });
	await report();
	const first = runs()[0]!;
	await report('interrupted', 'cancelled');
	expect(first.state).toBe('superseded');
	await expect(approve(first.reviewId)).rejects.toThrow(/stale_review/);
	await report();
	const second = runs().at(-1)!;
	expect([second.round, second.state]).toEqual([2, 'reviewing']);
	setFiles(0);
	await report();
	expect(second.state).toBe('superseded');
	await expect(approve(second.reviewId)).rejects.toThrow(/stale_review/);
});

it("gives the reviewer the part's prompt and acceptance criteria with the report (spec/crew#reviewer)", async () => {
	const { store, host, sent, key, reviewer, report } = await crew();
	expect(await readDocument(join(await store.taskDir(key), 'crew-part.json'))).toEqual({
		schemaVersion: 1,
		part: 1,
		prompt: 'Build the client details screen in out/. Prove it with pnpm test out.',
		acceptance: 'The screen shows the name, phone and notes; pnpm test out passes.',
	});
	// The reviewer's task has started and waits for a report.
	await store.setStatus({ projectId: key.projectId, id: reviewer().taskId }, 'done');
	await report();
	await host['dispatchReviews']();
	const check = sent.find((item) => item.taskId === reviewer().taskId)!;
	expect(check.text).toMatch(
		/^Check task \S+ of `Developer` \(reviewId \S+, round 1 of 2\)\.\nReport from `Developer` · Client details/
	);
	expect(check.text).toContain(
		'<part_prompt>\nBuild the client details screen in out/. Prove it with pnpm test out.\n</part_prompt>'
	);
	expect(check.text).toContain(
		'<acceptance>\nThe screen shows the name, phone and notes; pnpm test out passes.\n</acceptance>'
	);
	expect(check.text).toContain('ask the foreman only what they leave open');
});

it("keeps a long part prompt out of crew-workers.json: the reviewer copy is clipped in the member's own file, and both reload within their limits (spec/crew#workers)", async () => {
	// 150 000 two-byte characters: 300 KB of prompt for one member; six such members used to push crew-workers.json past its 1 MiB read limit.
	const { store, host, sent, key, reviewer, report } = await crew('я'.repeat(150_000));
	const part = await readDocument(join(await store.taskDir(key), 'crew-part.json'));
	expect(part).toMatchObject({ part: 1, clipped: true });
	expect((part.prompt as string).length).toBe(100_000);
	const workersFile = join(await store.taskDir(host['deps'].key as TaskKey), 'crew-workers.json');
	expect((await stat(workersFile)).size).toBeLessThan(8 * 1024);
	expect((await readDocument(workersFile)).workers).toHaveLength(2);
	await store.setStatus({ projectId: key.projectId, id: reviewer().taskId }, 'done');
	await report();
	await host['dispatchReviews']();
	expect(sent.find((item) => item.taskId === reviewer().taskId)!.text).toContain(
		'[The prompt is longer; the rest is left out.]'
	);
});

it('clips a long part prompt for the reviewer and leaves out what the foreman did not give (spec/crew#reviewer)', () => {
	expect(partBrief('A', null)).toBe('');
	expect(partBrief('A', { prompt: 'Do it.' })).toBe(
		'\nThe part as the foreman gave it to `A`:\n<part_prompt>\nDo it.\n</part_prompt>'
	);
	const long = partBrief('A', { prompt: 'x'.repeat(10), acceptance: 'Tests pass.', clipped: true });
	expect(long).toContain('xxxxxxxxxx\n[The prompt is longer; the rest is left out.]');
	expect(long).toContain('<acceptance>\nTests pass.\n</acceptance>');
});

it('hides create_task from the root foreman while its plan waits or was approved, not after a rejection, never from a solo task (spec/crew#roles)', () => {
	const record = (seq: number, event: SessionEvent): EventRecord => ({
		schemaVersion: 1,
		seq,
		at: '',
		event,
	});
	const plan = { id: 'p1', summary: '', parts: [] };
	const requested = record(1, { kind: 'crew.plan.requested', plan } as SessionEvent);
	const foreman = { role: 'foreman' } as CrewContext;
	expect(crewPlanExists([])).toBe(false);
	expect(crewPlanExists([requested])).toBe(true);
	expect(
		crewPlanExists([
			requested,
			record(2, { kind: 'crew.plan.resolved', id: 'p1', approved: true, parts: null }),
		])
	).toBe(true);
	const rejected = [
		requested,
		record(2, { kind: 'crew.plan.resolved', id: 'p1', approved: false, parts: null }),
	];
	expect(crewPlanExists(rejected)).toBe(false);
	expect([...crewHiddenTools(foreman, [requested])]).toEqual(['create_task']);
	expect([...crewHiddenTools(foreman, rejected)]).toEqual([]);
	expect([...crewHiddenTools(null, [requested])]).toEqual([]);
	expect([...crewHiddenTools({ role: 'lead' } as CrewContext, [requested])]).toEqual([]);
});
