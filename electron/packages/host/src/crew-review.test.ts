import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SessionStore } from '@brigadir/persistence';
import {
	builtinAgentTemplates,
	builtinCrewTemplates,
	defaultAppSettings,
	resolveCrew,
	reviewCrewTemplateId,
	templateLookup,
	type CrewTemplate,
	type SessionEvent,
} from '@brigadir/core';
import { humanToolsAllowed } from '@brigadir/orchestrator';
import { discoverScopes } from '@brigadir/git';
import { CrewHost } from './crew';
import { mcpTools } from './mcp';

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
const reviewCrew = builtinCrewTemplates.find((item) => item.id === reviewCrewTemplateId)!;
/** A foreman CrewHost of a PR review (spec/pull-requests-and-ci#review-crew): a repo whose PR head is fetched as `refs/brigadir-v2/pr/7`. */
async function crew(template: CrewTemplate, review: 'quick' | 'worktree' | null) {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-crew-review-'));
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	const repo = join(root, 'repo');
	await mkdir(repo, { recursive: true });
	await git(repo, 'init', '-q', '-b', 'main');
	await writeFile(join(repo, 'a.txt'), 'a\n');
	await git(repo, 'add', '-A');
	await git(repo, 'commit', '-q', '-m', 'init');
	await git(repo, 'checkout', '-q', '-b', 'feature');
	await writeFile(join(repo, 'a.txt'), 'pr\n');
	await git(repo, 'commit', '-q', '-am', 'pr');
	await git(repo, 'update-ref', 'refs/brigadir-v2/pr/7', 'HEAD');
	await git(repo, 'checkout', '-q', 'main');
	const store = await SessionStore.at(join(root, 'data')),
		project = await store.addProject(repo),
		scope = (await discoverScopes(repo)).find((item) => item.kind === 'root')!;
	const spec = resolveCrew(template, {
		lookup: templateLookup([...builtinAgentTemplates]),
		defaultProvider: 'claude',
		now: new Date().toISOString(),
	});
	let task = await store.createTask(
		project.id,
		'Review the PR',
		'claude',
		'gui',
		'Review #7',
		'queued',
		review === 'worktree'
			? {
					isolation: 'worktree',
					branch: 'pr-7-review',
					baseRef: 'refs/brigadir-v2/pr/7',
					setupCommand: 'pnpm install',
					scopes: [{ id: scope.id, name: scope.name, kind: scope.kind, selected: true }],
				}
			: {
					isolation: 'in-place',
					branch: '',
					baseRef: 'HEAD',
					setupCommand: 'pnpm install',
					scopes: [{ id: scope.id, name: scope.name, kind: scope.kind, selected: true }],
				}
	);
	task = await store.updateTask(task, {
		crew: spec,
		...(review
			? {
					prReview: { scopeId: scope.id, number: 7, mode: 'review' as const, base: 'main' },
					readOnlyAgent: true,
				}
			: {}),
	});
	const events: SessionEvent[] = [];
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
		prompt: async () => {},
		records: () => events.map((event, seq) => ({ schemaVersion: 1, seq, at: '', event })),
		parent: () => null,
	});
	host['watchSlots'] = () => {};
	await host.start();
	return { repo, store, task, host, events, signal: new AbortController().signal };
}

it('starts each reviewer of a PR review without a plan, read-only on the PR head and without setup (spec/pull-requests-and-ci#review-crew)', async () => {
	const { store, task, host, signal } = await crew(reviewCrew, 'quick');
	const created = (await host.tool(
		'create_worker_task',
		{ agent: 'Astra', title: 'Review the PR', prompt: 'Review all of it.' },
		signal
	)) as { taskId: string; agent: string };
	expect(created.agent).toBe('Astra');
	await host.tool(
		'create_worker_task',
		{ agent: 'Opus', title: 'Review the PR', prompt: 'Review all of it.' },
		signal
	);
	const workers = await Promise.all(
		(host['workers'] as { taskId: string }[]).map((record) =>
			store.task({ projectId: task.projectId, id: record.taskId })
		)
	);
	expect(workers.map((item) => item.provider).sort()).toEqual(['claude', 'codex']);
	for (const worker of workers) {
		expect(worker.readOnlyAgent).toBe(true);
		expect(worker.launch?.baseRef).toBe('refs/brigadir-v2/pr/7');
		expect(worker.launch?.setupCommand).toBe('');
		// The worker drafts nothing: only the foreman's task reviews the PR.
		expect(worker.prReview).toBeUndefined();
	}
	const astra = workers.find((item) => item.id === created.taskId)!;
	expect(astra.launchOptions).toEqual(
		expect.arrayContaining([{ id: 'model', value: 'gpt-6-astra' }])
	);
});

it('keeps the setup command of a review in a worktree', async () => {
	const { store, task, host, signal } = await crew(reviewCrew, 'worktree');
	await host.tool(
		'create_worker_task',
		{ agent: 'Opus', title: 'Review the PR', prompt: 'Review all of it.' },
		signal
	);
	const worker = await store.task({
		projectId: task.projectId,
		id: (host['workers'] as { taskId: string }[])[0]!.taskId,
	});
	expect(worker!.launch?.baseRef).toBe('refs/brigadir-v2/pr/7');
	expect(worker!.launch?.setupCommand).toBe('pnpm install');
});

it('still asks for a plan and refuses reviewers in a crew that reviews no PR (spec/crew#communication)', async () => {
	const { host, signal } = await crew(reviewCrew, null);
	await expect(
		host.tool('create_worker_task', { agent: 'Astra', title: 'x', prompt: 'y' }, signal)
	).rejects.toThrow('Call propose_plan first');
	// A checker stays a checker even in a PR review: the host starts it with the part it checks.
	const checked = await crew(builtinCrewTemplates[0]!, 'quick');
	await expect(
		checked.host.tool('create_worker_task', { agent: 'Reviewer', title: 'x', prompt: 'y' }, signal)
	).rejects.toThrow('the host starts reviewers itself');
});

it('accepts a reviewer that changed nothing without a commit or a merge, and sends its findings up', async () => {
	const { repo, store, task, host, events, signal } = await crew(reviewCrew, 'quick');
	const created = (await host.tool(
		'create_worker_task',
		{ agent: 'Astra', title: 'Review the PR', prompt: 'Review all of it.' },
		signal
	)) as { taskId: string };
	const key = { projectId: task.projectId, id: created.taskId };
	const writer = await store.writer(key);
	await writer.append({ kind: 'turn.started', text: 'Review all of it.' });
	await writer.append({
		kind: 'message.delta',
		role: 'assistant',
		messageId: 'm',
		content: { kind: 'text', text: 'a.txt:1 — the value changed without a test' },
	});
	await writer.append({ kind: 'turn.completed', reason: 'end_turn' });
	await writer.close();
	// The reviewer's turn is a report to the foreman, not a verdict on someone's part.
	await host['handleReport'](host['workers'][0]!, 1);
	expect(events.some((event) => event.kind === 'crew.report')).toBe(true);
	const head = (await git(repo, 'rev-parse', 'HEAD')).stdout;
	const accepted = (await host.tool('accept_task', { taskId: created.taskId }, signal)) as {
		accepted: boolean;
		merged: string[];
	};
	expect(accepted).toMatchObject({ accepted: true, merged: [] });
	// The person's branch stays as it was: nothing of the PR head was squashed into it.
	expect((await git(repo, 'rev-parse', 'HEAD')).stdout).toBe(head);
	expect((await git(repo, 'status', '--porcelain')).stdout).toBe('');
	expect((await store.task(key)).status).toBe('completed');
	// The reviewer is a part of this crew: the crew settles only after the foreman accepted it.
	expect(host['isPart'](host['workers'][0]!)).toBe(true);
	expect(host['workers'][0]!.acceptedAt).toBeTruthy();
});

it('keeps pr_comment with the foreman: a crew worker neither lists nor calls it (spec/pull-requests-and-ci#review-crew)', () => {
	const names = (role: 'foreman' | 'reviewer' | 'developer') =>
		(mcpTools(role, defaultAppSettings.modules, true).list.tools as { name: string }[]).map(
			(tool) => tool.name
		);
	expect(names('foreman')).toContain('pr_comment');
	expect(names('reviewer')).not.toContain('pr_comment');
	expect(names('developer')).not.toContain('pr_comment_reply');
	expect(humanToolsAllowed('reviewer')).toBe(false);
	expect(humanToolsAllowed('foreman')).toBe(true);
});
