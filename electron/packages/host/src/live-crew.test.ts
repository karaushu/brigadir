import { expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SessionStore, atomicJson } from '@brigadir/persistence';
import {
	pendingInputs,
	resolveCrew,
	templateLookup,
	type AgentProvider,
	type CrewTemplate,
	type EventRecord,
	type TaskKey,
} from '@brigadir/core';
import { connectHost, readIdentity, type HostClient } from './index';
/**
 * G3–G5 (spec/crew#later): real providers through the crew host. Opt-in with
 * BRIGADIR_LIVE_CREW=g3|g4|g5|all; the runs spend paid turns.
 * These runs prove host invariants and ground truth (files, runs, reports), never a model's choice.
 */
const gate = process.env.BRIGADIR_LIVE_CREW ?? '';
const enabled = (name: string) => gate === 'all' || gate.split(',').includes(name);
const run = promisify(execFile);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(
	read: () => Promise<T | undefined>,
	timeout: number,
	label: string
): Promise<T> {
	const end = Date.now() + timeout;
	while (Date.now() < end) {
		const v = await read();
		if (v !== undefined) return v;
		await delay(500);
	}
	throw new Error(`Timed out: ${label}`);
}
const git = (cwd: string, ...args: string[]) =>
	run('git', args, {
		cwd,
		env: {
			...process.env,
			GIT_AUTHOR_NAME: 'Fixture',
			GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
			GIT_COMMITTER_NAME: 'Fixture',
			GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
		},
	});
const sanitize = (value: unknown, root: string) =>
	JSON.parse(
		JSON.stringify(value)
			.replaceAll(root, '<fixture>')
			.replace(/\/Users\/[^/"\s]+/g, '/fixture/home')
	);
type Harness = Awaited<ReturnType<typeof harness>>;
async function harness(name: string, template: CrewTemplate, foremanProvider: AgentProvider) {
	const root = await mkdtemp(join(tmpdir(), `brigadir-live-crew-${name}-`)),
		repo = join(root, 'repo');
	await mkdir(repo);
	await git(repo, 'init', '-q', '-b', 'main');
	await writeFile(join(repo, 'README.md'), 'fixture\n');
	await git(repo, 'add', '-A');
	await git(repo, 'commit', '-q', '-m', 'init');
	const store = await SessionStore.at(join(root, 'data')),
		project = await store.addProject(repo);
	const spec = resolveCrew(template, {
		lookup: templateLookup([]),
		defaultProvider: foremanProvider,
		now: new Date().toISOString(),
	});
	let task = await store.createTask(project.id, 'Live crew gate', foremanProvider);
	task = await store.updateTask(task, { crew: spec });
	const report: Record<string, unknown> = {
		gate: name,
		startedAt: new Date().toISOString(),
		sdk: { acp: '1.4.0', mcp: '1.30.0' },
		command: `BRIGADIR_LIVE_CREW=${name} pnpm exec vitest run packages/host/src/live-crew.test.ts`,
		status: 'failed',
		exitCode: 1,
		providers: {
			foreman: foremanProvider,
			agents: Object.fromEntries(
				spec.root.agents.flatMap((agent) => [
					[agent.name, agent.provider],
					...agent.agents.map((child) => [child.name, child.provider]),
				])
			),
		},
	};
	const output = resolve(`test-results/live/${name}.json`);
	await mkdir(resolve('test-results/live'), { recursive: true });
	const children: ChildProcess[] = [];
	const clients = new Map<string, HostClient>();
	let stopApprovals = false;
	async function launch(key: TaskKey) {
		const dir = await store.taskDir(key),
			config = join(dir, 'config.json');
		await atomicJson(config, {
			schemaVersion: 1,
			dataDir: store.root,
			key,
			mcpEntry: resolve('apps/desktop/out/services/mcp-relay'),
		});
		const child = spawn(process.execPath, [resolve('apps/desktop/out/services/host.cjs'), config], {
			stdio: 'pipe',
		});
		children.push(child);
		let diagnostics = '';
		child.stderr?.on('data', (c) => {
			diagnostics += c;
		});
		const identity = await until(
			async () => {
				if (child.exitCode !== null) throw new Error(diagnostics);
				const id = await readIdentity(store, key);
				return id && id.pid === child.pid ? id : undefined;
			},
			30_000,
			'host identity'
		);
		const client = await connectHost(identity);
		clients.set(key.id, client);
		await until(
			async () => ((await client.snapshot()).connected ? true : undefined),
			30_000,
			'host connected'
		);
		await client.startAgent();
		await until(
			async () => (await client.snapshot()).records.find((r) => r.event.kind === 'session.started'),
			180_000,
			'foreman session'
		);
		return { child, client };
	}
	/** The test is the human: permissions of any worker are granted once; nothing else is answered for the agents. */
	async function approvals() {
		while (!stopApprovals) {
			try {
				for (const id of await readdir(join(store.root, 'projects', project.id, 'tasks'))) {
					const key = { projectId: project.id, id };
					const journal = await store.journal(key).catch(() => null);
					if (!journal) continue;
					const pending = pendingInputs(journal.records);
					if (!pending.permissions.length) continue;
					let client = clients.get(id);
					if (!client) {
						const identity = await readIdentity(store, key);
						if (!identity) continue;
						client = await connectHost(identity).catch(() => undefined);
						if (!client) continue;
						clients.set(id, client);
					}
					for (const request of pending.permissions) {
						const option =
							request.options.find((o) => o.kind === 'allow_once') ??
							request.options.find((o) => o.kind === 'allow_always');
						if (option) {
							await client
								.command({ kind: 'answerPermission', id: request.id, optionId: option.id })
								.catch(() => {});
							(report.approvals as number[] | undefined)
								? (report.approvals as number[]).push(1)
								: (report.approvals = [1]);
						}
					}
				}
			} catch {
				/* journals may be mid-write */
			}
			await delay(700);
		}
	}
	const approvalLoop = approvals();
	const tasks = async () =>
		(
			await Promise.all(
				(await readdir(join(store.root, 'projects', project.id, 'tasks'))).map((id) =>
					store.task({ projectId: project.id, id }).catch(() => null)
				)
			)
		).filter((item): item is NonNullable<typeof item> => item !== null);
	const save = async (status?: string) => {
		if (status) {
			report.status = status;
			report.exitCode = status === 'passed' ? 0 : 1;
		}
		report.finishedAt = new Date().toISOString();
		await writeFile(output, JSON.stringify(sanitize(report, root), null, 2) + '\n');
	};
	const events = (records: readonly EventRecord[]) =>
		records
			.filter(
				(r) => r.event.kind.startsWith('crew.') || (r.event.kind === 'turn.started' && r.event.crew)
			)
			.map((r) => ({
				seq: r.seq,
				at: r.at,
				event:
					r.event.kind === 'turn.started'
						? { kind: 'turn.started', crew: r.event.crew, text: r.event.text.slice(0, 600) }
						: r.event,
			}));
	async function dispose() {
		stopApprovals = true;
		await approvalLoop.catch(() => {});
		for (const client of clients.values()) {
			await client.command({ kind: 'shutdown' }).catch(() => {});
			client.close();
		}
		for (const child of children)
			if (child.exitCode === null && child.signalCode === null) {
				child.kill('SIGTERM');
				await until(
					async () => (child.exitCode !== null || child.signalCode !== null ? true : undefined),
					20_000,
					'host exit'
				).catch(() => child.kill('SIGKILL'));
			}
		await run('pkill', ['-f', root]).catch(() => {});
		await rm(root, { recursive: true, force: true });
	}
	return {
		root,
		repo,
		store,
		project,
		task,
		spec,
		report,
		save,
		launch,
		tasks,
		events,
		dispose,
		clients,
	};
}
const developerPart = (file: string, content: string) =>
	`Create the file ${file} containing exactly one line: ${content}. Create nothing else and do not touch other files. Then finish your turn with one sentence.`;
const foremanPrompt = (part: { title: string; agent: string; file: string; content: string }) =>
	`You run a crew. Do exactly this, nothing more:\n1. Call propose_plan with one part: title "${part.title}", agent "${part.agent}", files ["${part.file}"], prompt "${developerPart(part.file, part.content).replace(/"/g, '\\"')}".\n2. When propose_plan returns approved, call create_worker_task with the same title, agent, files and prompt.\n3. Then end your turn with the single word WAITING. Reports arrive as new messages.\n4. When a report for that task arrives (approved or disputed, or a plain report), call accept_task with its taskId, then end your turn with the single word ACCEPTED. Do not use any other tool.`;
const crewOf = (
	developer: AgentProvider,
	reviewer: AgentProvider,
	reviewerExtra = '',
	mode = true
): CrewTemplate => ({
	schemaVersion: 1,
	id: 'live-review',
	name: 'Live review loop',
	builtin: false,
	root: {
		id: 'root',
		name: 'Foreman',
		template: 'foreman-default',
		agents: [
			{
				id: 'developer',
				name: 'Developer',
				template: 'developer',
				provider: developer,
				checkedBy: ['reviewer'],
				...(mode && developer === 'claude' ? { choices: { modeId: 'acceptEdits' } } : {}),
			},
			{
				id: 'reviewer',
				name: 'Reviewer',
				template: 'reviewer',
				provider: reviewer,
				...(reviewerExtra ? { extraInstructions: reviewerExtra } : {}),
			},
		],
	},
});

for (const [developer, reviewer] of [
	['claude', 'codex'],
	['codex', 'claude'],
] as [AgentProvider, AgentProvider][]) {
	it.skipIf(!enabled('g3'))(
		`G3: ${developer} developer, ${reviewer} reviewer: the host routes the report through the reviewer`,
		async () => {
			const h = await harness(
				`G3-${developer}-dev-${reviewer}-review`,
				crewOf(developer, reviewer),
				'claude'
			);
			try {
				const { client } = await h.launch(h.task);
				await client.command({
					kind: 'prompt',
					text: foremanPrompt({
						title: 'Write greeting',
						agent: 'Developer',
						file: 'out/greeting.txt',
						content: 'hello',
					}),
				});
				const plan = await until(
					async () =>
						(await client.snapshot()).records.find((r) => r.event.kind === 'crew.plan.requested'),
					240_000,
					'plan card'
				);
				h.report.plan = sanitize(plan.event, h.root);
				await client.command({
					kind: 'decidePlan',
					decision: {
						id: (plan.event as { plan: { id: string } }).plan.id,
						approved: true,
						parts: null,
					},
				});
				const created = await until(
					async () =>
						(await client.snapshot()).records.find(
							(r) =>
								r.event.kind === 'crew.worker.created' &&
								(r.event as { name: string }).name === 'Developer'
						),
					240_000,
					'worker created'
				);
				const workerKey = {
					projectId: h.project.id,
					id: (created.event as { taskId: string }).taskId,
				};
				await until(
					async () =>
						(await client.snapshot()).records.find(
							(r) =>
								r.event.kind === 'crew.worker.created' &&
								(r.event as { name: string }).name === 'Reviewer'
						),
					120_000,
					'reviewer created'
				);
				// The developer's report never reaches the foreman before the reviewer's verdict.
				const review = await until(
					async () =>
						(await client.snapshot()).records.find(
							(r) =>
								r.event.kind === 'crew.review' &&
								['comments', 'approved', 'disputed'].includes((r.event as { state: string }).state)
						),
					900_000,
					'first verdict'
				);
				h.report.firstVerdict = sanitize(review.event, h.root);
				const beforeVerdict = (await client.snapshot()).records.filter((r) => r.seq < review.seq);
				expect(
					beforeVerdict.some(
						(r) => r.event.kind === 'turn.started' && r.event.crew?.kind === 'report'
					)
				).toBe(false);
				const runs = JSON.parse(
					await readFile(join(await h.store.taskDir(h.task), 'crew-reviews.json'), 'utf8')
				).reviews as {
					state: string;
					round: number;
					verdicts: { reviewer: string; approved: boolean; comments: number }[];
				}[];
				expect(runs.length).toBeGreaterThan(0);
				expect(runs[0]!.verdicts[0]!.reviewer).toBe('Reviewer');
				if (runs[0]!.state === 'comments') {
					const reviewFile = JSON.parse(
						await readFile(join(await h.store.taskDir(workerKey), 'review.json'), 'utf8')
					);
					expect(reviewFile.comments[0].author).toBe('Reviewer · checks Developer');
					h.report.comment = sanitize(reviewFile.comments[0], h.root);
				}
				const final = await until(
					async () =>
						(await client.snapshot()).records.find(
							(r) => r.event.kind === 'turn.started' && r.event.crew?.kind === 'report'
						),
					900_000,
					'report with verdict'
				);
				const marker = final.event.kind === 'turn.started' ? final.event.crew : undefined;
				expect(
					marker?.kind === 'report' &&
						['approved', 'disputed'].includes(marker.report.verdict ?? '')
				).toBe(true);
				h.report.finalReport = sanitize(marker, h.root);
				await until(
					async () =>
						(await client.snapshot()).records.find(
							(r) => r.seq > final.seq && r.event.kind === 'crew.accepted'
						),
					600_000,
					'accept_task'
				);
				expect((await readFile(join(h.repo, 'out/greeting.txt'), 'utf8')).trim()).toBe('hello');
				h.report.runs = runs.map((run) => ({
					round: run.round,
					state: run.state,
					verdicts: run.verdicts,
				}));
				h.report.finalRuns = JSON.parse(
					await readFile(join(await h.store.taskDir(h.task), 'crew-reviews.json'), 'utf8')
				).reviews.map((run: { round: number; state: string; verdicts: unknown[] }) => ({
					round: run.round,
					state: run.state,
					verdicts: run.verdicts,
				}));
				h.report.events = h.events((await client.snapshot()).records);
				await h.save('passed');
			} catch (error) {
				h.report.error = String(error instanceof Error ? error.message : error);
				h.report.events = h.events(
					(await h.clients
						.get(h.task.id)
						?.snapshot()
						.catch(() => ({ records: [] as EventRecord[] })))!.records
				);
				await h.save('failed');
				throw error;
			} finally {
				await h.dispose();
			}
		},
		2_400_000
	);
}

it.skipIf(!enabled('g4'))(
	'G4: two rounds end in a dispute, a foreman restart keeps the check, two reviewers give two verdicts',
	async () => {
		const never =
			'Never approve. Every time you are asked to check, call submit_review with exactly one comment on the changed file asking for a different wording. Do not call approve.';
		const h = await harness('G4-dispute-restart', crewOf('claude', 'codex', never), 'claude');
		try {
			let { client, child } = await h.launch(h.task);
			await client.command({
				kind: 'prompt',
				text: foremanPrompt({
					title: 'Write greeting',
					agent: 'Developer',
					file: 'out/greeting.txt',
					content: 'hello',
				}),
			});
			const plan = await until(
				async () =>
					(await client.snapshot()).records.find((r) => r.event.kind === 'crew.plan.requested'),
				240_000,
				'plan card'
			);
			await client.command({
				kind: 'decidePlan',
				decision: {
					id: (plan.event as { plan: { id: string } }).plan.id,
					approved: true,
					parts: null,
				},
			});
			// Restart the foreman host while the first check is out with the reviewer.
			await until(
				async () => {
					const runs = JSON.parse(
						await readFile(join(await h.store.taskDir(h.task), 'crew-reviews.json'), 'utf8').catch(
							() => '{"reviews":[]}'
						)
					).reviews as { state: string; dispatched: string[] }[];
					return runs.some((run) => run.state === 'reviewing' && run.dispatched.length)
						? true
						: undefined;
				},
				900_000,
				'first check dispatched'
			);
			h.report.restart = 'foreman host killed while round 1 was with the reviewer';
			child.kill('SIGTERM');
			await until(
				async () => (child.exitCode !== null || child.signalCode !== null ? true : undefined),
				30_000,
				'foreman exit'
			);
			client.close();
			h.clients.delete(h.task.id);
			({ client, child } = await h.launch(h.task));
			const afterRestart = JSON.parse(
				await readFile(join(await h.store.taskDir(h.task), 'crew-reviews.json'), 'utf8')
			).reviews as { state: string; verdicts: unknown[] }[];
			expect(afterRestart[0]!.state).toBe('reviewing');
			h.report.afterRestart = afterRestart;
			const disputed = await until(
				async () =>
					(await client.snapshot()).records.find(
						(r) =>
							r.event.kind === 'crew.review' && (r.event as { state: string }).state === 'disputed'
					),
				1_500_000,
				'dispute after two rounds'
			);
			h.report.disputed = sanitize(disputed.event, h.root);
			const runs = JSON.parse(
				await readFile(join(await h.store.taskDir(h.task), 'crew-reviews.json'), 'utf8')
			).reviews as {
				round: number;
				state: string;
				verdicts: { approved: boolean; comments: number }[];
			}[];
			expect(runs.map((run) => [run.round, run.state])).toEqual([
				[1, 'comments'],
				[2, 'disputed'],
			]);
			expect(runs.every((run) => run.verdicts.every((v) => !v.approved && v.comments >= 1))).toBe(
				true
			);
			const final = await until(
				async () =>
					(await client.snapshot()).records.find(
						(r) =>
							r.event.kind === 'turn.started' &&
							r.event.crew?.kind === 'report' &&
							r.event.crew.report.verdict === 'disputed'
					),
				120_000,
				'disputed report to the foreman'
			);
			expect(final.event.kind === 'turn.started' && final.event.text).toContain(
				'did not agree after two rounds'
			);
			h.report.runs = runs;
			h.report.events = h.events((await client.snapshot()).records);
			await h.save('passed');
		} catch (error) {
			h.report.error = String(error instanceof Error ? error.message : error);
			await h.save('failed');
			throw error;
		} finally {
			await h.dispose();
		}
	},
	3_000_000
);

it.skipIf(!enabled('g4'))(
	'G4b: two reviewers on different providers both give a verdict before anything reaches the foreman',
	async () => {
		const always =
			'When asked to check, read the report and the diff, then call approve if the file contains the requested line. Do not comment on style.';
		const template: CrewTemplate = {
			schemaVersion: 1,
			id: 'live-two-reviewers',
			name: 'Two reviewers',
			builtin: false,
			root: {
				id: 'root',
				name: 'Foreman',
				template: 'foreman-default',
				agents: [
					{
						id: 'developer',
						name: 'Developer',
						template: 'developer',
						provider: 'claude',
						checkedBy: ['r1', 'r2'],
						choices: { modeId: 'acceptEdits' },
					},
					{
						id: 'r1',
						name: 'Reviewer A',
						template: 'reviewer',
						provider: 'claude',
						extraInstructions: always,
					},
					{
						id: 'r2',
						name: 'Reviewer B',
						template: 'reviewer',
						provider: 'codex',
						extraInstructions: always,
					},
				],
			},
		};
		const h = await harness('G4b-two-reviewers', template, 'claude');
		try {
			const { client } = await h.launch(h.task);
			await client.command({
				kind: 'prompt',
				text: foremanPrompt({
					title: 'Write greeting',
					agent: 'Developer',
					file: 'out/greeting.txt',
					content: 'hello',
				}),
			});
			const plan = await until(
				async () =>
					(await client.snapshot()).records.find((r) => r.event.kind === 'crew.plan.requested'),
				240_000,
				'plan card'
			);
			await client.command({
				kind: 'decidePlan',
				decision: {
					id: (plan.event as { plan: { id: string } }).plan.id,
					approved: true,
					parts: null,
				},
			});
			const settled = await until(
				async () =>
					(await client.snapshot()).records.find(
						(r) =>
							r.event.kind === 'crew.review' &&
							['approved', 'comments', 'disputed'].includes((r.event as { state: string }).state)
					),
				1_500_000,
				'round settled'
			);
			const runs = JSON.parse(
				await readFile(join(await h.store.taskDir(h.task), 'crew-reviews.json'), 'utf8')
			).reviews as { state: string; verdicts: { reviewer: string }[] }[];
			expect(runs[0]!.verdicts.map((v) => v.reviewer).sort()).toEqual(['Reviewer A', 'Reviewer B']);
			const before = (await client.snapshot()).records.filter((r) => r.seq < settled.seq);
			expect(
				before.some((r) => r.event.kind === 'turn.started' && r.event.crew?.kind === 'report')
			).toBe(false);
			h.report.verdicts = runs[0]!.verdicts;
			h.report.settled = sanitize(settled.event, h.root);
			h.report.events = h.events((await client.snapshot()).records);
			await h.save('passed');
		} catch (error) {
			h.report.error = String(error instanceof Error ? error.message : error);
			await h.save('failed');
			throw error;
		} finally {
			await h.dispose();
		}
	},
	2_400_000
);

it.skipIf(!enabled('g5'))(
	'G5: a lead creates a subordinate in its zone, accepts the branch and hands one report up',
	async () => {
		const template: CrewTemplate = {
			schemaVersion: 1,
			id: 'live-lead',
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
							{ id: 'a', name: 'A', template: 'developer', provider: 'codex', zone: ['out/**'] },
						],
					},
				],
			},
		};
		const h = await harness('G5-lead', template, 'claude');
		try {
			const { client } = await h.launch(h.task);
			const leadPrompt = `You lead a branch. Do exactly this: 1. Call propose_plan with one part: title "Write lead file", agent "A", files ["out/lead.txt"], prompt "${developerPart('out/lead.txt', 'lead').replace(/"/g, '\\"')}". 2. When it returns approved, call create_worker_task with the same values. 3. End your turn with WAITING. 4. When the report for that task arrives, call accept_task with its taskId and end your turn with the single word ACCEPTED.`;
			await client.command({
				kind: 'prompt',
				text: `You run a crew with one lead. Do exactly this: 1. Call propose_plan with one part: title "UI branch", agent "UI lead", files ["out/**"], prompt "${leadPrompt.replace(/"/g, '\\"')}". 2. When it returns approved, call create_worker_task with the same values. 3. End your turn with WAITING. 4. When a branch report arrives, call accept_task with its taskId and end your turn with ACCEPTED. Use no other tools.`,
			});
			const plan = await until(
				async () =>
					(await client.snapshot()).records.find((r) => r.event.kind === 'crew.plan.requested'),
				240_000,
				'plan card'
			);
			await client.command({
				kind: 'decidePlan',
				decision: {
					id: (plan.event as { plan: { id: string } }).plan.id,
					approved: true,
					parts: null,
				},
			});
			const created = await until(
				async () =>
					(await client.snapshot()).records.find((r) => r.event.kind === 'crew.worker.created'),
				240_000,
				'lead created'
			);
			const leadKey = { projectId: h.project.id, id: (created.event as { taskId: string }).taskId };
			const child = await until(
				async () => (await h.tasks()).find((item) => item.parentTaskId === leadKey.id),
				900_000,
				'subordinate created'
			);
			expect(child.crewTaskId).toBe(h.task.id);
			expect(child.crewNodeId).toBe('a');
			const accepted = await until(
				async () =>
					(await h.store.journal(leadKey)).records.find((r) => r.event.kind === 'crew.accepted'),
				1_200_000,
				'lead accepted the part'
			);
			h.report.leadAccepted = sanitize(accepted.event, h.root);
			const leadProject = await h.store.projectForTask(leadKey);
			expect((await readFile(join(leadProject.path, 'out/lead.txt'), 'utf8')).trim()).toBe('lead');
			const branch = await until(
				async () =>
					(await client.snapshot()).records.find(
						(r) => r.event.kind === 'turn.started' && r.event.crew?.kind === 'branch-report'
					),
				600_000,
				'branch report'
			);
			expect(
				(await client.snapshot()).records.filter(
					(r) => r.event.kind === 'turn.started' && r.event.crew?.kind === 'branch-report'
				).length
			).toBe(1);
			h.report.branchReport = sanitize(
				branch.event.kind === 'turn.started' ? branch.event.crew : null,
				h.root
			);
			await until(
				async () =>
					(await client.snapshot()).records.find(
						(r) => r.seq > branch.seq && r.event.kind === 'crew.accepted'
					),
				600_000,
				'root accepted the branch'
			);
			expect((await readFile(join(h.repo, 'out/lead.txt'), 'utf8')).trim()).toBe('lead');
			h.report.events = h.events((await client.snapshot()).records);
			h.report.leadEvents = h.events((await h.store.journal(leadKey)).records);
			await h.save('passed');
		} catch (error) {
			h.report.error = String(error instanceof Error ? error.message : error);
			await h.save('failed');
			throw error;
		} finally {
			await h.dispose();
		}
	},
	3_000_000
);
