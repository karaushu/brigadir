import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '@brigadir/persistence';
import { gitText } from '@brigadir/git';
import type { SessionCommand, TaskKey, TaskProposal } from '@brigadir/core';
import { TaskProposals } from './task-proposals';
import { LaunchSettingsStore } from './launch-settings';

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-proposal-')),
		repo = join(root, 'repo'),
		backend = join(root, 'backend'),
		docs = join(root, 'docs');
	for (const dir of [repo, backend, docs]) await mkdir(dir);
	for (const dir of [repo, backend]) {
		await gitText(dir, ['init', '-b', 'main']);
		await gitText(dir, ['config', 'user.name', 'Fixture']);
		await gitText(dir, ['config', 'user.email', 'fixture@example.invalid']);
		await writeFile(join(dir, 'a.txt'), 'a\n');
		await gitText(dir, ['add', '.']);
		await gitText(dir, ['commit', '-m', 'init']);
	}
	await writeFile(join(docs, 'spec.md'), '# Spec\n');
	const store = await SessionStore.at(join(root, 'data')),
		project = await store.addProject(repo),
		settings = new LaunchSettingsStore(store.root);
	const source = await store.createTask(
		project.id,
		'Build the screen',
		'claude',
		'gui',
		'New task',
		'queued',
		{ ...(await settings.read(project.id)), branch: 'feature/screen' }
	);
	const commands: [TaskKey, SessionCommand][] = [],
		started: TaskKey[] = [];
	const proposals = new TaskProposals({
		dataDir: store.root,
		settings,
		changes: { range: () => undefined },
		command: async (key, command) => {
			commands.push([key, command]);
		},
		start: async (key) => {
			started.push(key);
		},
		emptyTitle: () => 'New task',
	});
	const propose = async (proposal: TaskProposal) => {
		const writer = await store.writer(source);
		try {
			await writer.append({ kind: 'task.proposal.requested', proposal });
		} finally {
			await writer.close();
		}
		return proposal.id;
	};
	return {
		root,
		store,
		project,
		source,
		settings,
		proposals,
		commands,
		started,
		propose,
		backend: await realpath(backend),
		docs: await realpath(docs),
	};
}

it('creates the proposed task in the same project with its context, folders, link and a new branch (spec/tasks#agent-created-tasks)', async () => {
	const f = await fixture();
	try {
		const id = await f.propose({
			id: 'p1',
			title: 'Backend API',
			prompt: 'Add the endpoint the screen calls.',
			context: [
				{ kind: 'summary' },
				{ kind: 'diff', full: false },
				{ kind: 'file', path: join(f.docs, 'spec.md') },
				{ kind: 'text', name: 'Notes', text: 'Use v2' },
			],
			folders: [f.backend, f.docs],
			start: 'now',
		});
		const task = await f.proposals.create(f.source, id);
		expect(task).toMatchObject({
			projectId: f.project.id,
			title: 'Backend API',
			prompt: 'Add the endpoint the screen calls.',
			originTaskId: f.source.id,
			provider: 'claude',
			transport: 'gui',
			status: 'backlog',
		});
		expect(task.launch?.branch).not.toBe('feature/screen');
		expect(task.launch?.branch).toBeTruthy();
		const folders = task.launch!.scopes.filter(
			(scope) => scope.kind === 'external' || scope.kind === 'folder'
		);
		expect(folders.map((scope) => [scope.kind, scope.path, scope.selected])).toEqual([
			['external', f.backend, true],
			['folder', f.docs, true],
		]);
		expect(task.attachments?.map((item) => item.name)).toEqual([
			'Task summary · Build the screen',
			'Diff · Build the screen',
			'Notes',
			'spec.md',
		]);
		expect(f.commands).toEqual([
			[
				f.source,
				{
					kind: 'resolveTaskProposal',
					id,
					task: { projectId: f.project.id, id: task.id, title: 'Backend API' },
				},
			],
		]);
		await expect.poll(() => f.started.length).toBe(1);
		// spec/projects-and-board#external-folders: the folders belong to the new task; the project's defaults stay its own repos.
		expect((await f.settings.read(f.project.id)).scopes.filter((scope) => scope.path)).toEqual([]);
		await expect(f.proposals.create(f.source, 'gone')).rejects.toThrow('already resolved');
	} finally {
		await rm(f.root, { recursive: true, force: true });
	}
});

it('fills the sheet from the proposal, links the task the sheet made and declines (spec/tasks#agent-created-tasks)', async () => {
	const f = await fixture();
	try {
		const id = await f.propose({
			id: 'p2',
			title: null,
			prompt: 'Write the docs.',
			context: [{ kind: 'text', name: 'Outline', text: '1. Intro' }],
			folders: [f.docs],
			start: 'backlog',
		});
		const owner = {
			projectId: f.project.id,
			id: '00000000-0000-4000-8000-0000000000aa',
			draft: true as const,
		};
		const draft = await f.proposals.draft(f.source, id, owner);
		expect(draft).toMatchObject({
			prompt: 'Write the docs.',
			title: null,
			provider: 'claude',
			transport: 'gui',
		});
		expect(draft.attachments.map((item) => item.name)).toEqual(['Outline']);
		expect(draft.launch.scopes.find((scope) => scope.path === f.docs)?.selected).toBe(true);
		await expect(
			f.proposals.draft(f.source, id, { projectId: f.project.id, id: f.source.id })
		).rejects.toThrow('Invalid draft');
		const made = await f.store.createTask(
			f.project.id,
			'Write the docs.',
			'claude',
			'gui',
			'New task',
			'backlog',
			draft.launch
		);
		await f.proposals.adopt(f.source, id, made);
		expect((await f.store.task(made)).originTaskId).toBe(f.source.id);
		expect(f.commands.at(-1)).toEqual([
			f.source,
			{
				kind: 'resolveTaskProposal',
				id,
				task: { projectId: f.project.id, id: made.id, title: 'Write the docs.' },
			},
		]);
		await f.proposals.decline(f.source, 'p2');
		expect(f.commands.at(-1)).toEqual([
			f.source,
			{ kind: 'resolveTaskProposal', id: 'p2', task: null },
		]);
	} finally {
		await rm(f.root, { recursive: true, force: true });
	}
});

// spec/tasks#agent-created-tasks: the agent the proposal names replaces the source's provider, model and effort, on the task and in the sheet.
it('creates the task and fills the sheet with the agent the proposal names (spec/tasks#agent-created-tasks)', async () => {
	const f = await fixture();
	try {
		await f.store.updateTask(f.source, {
			launchOptions: [{ id: 'model', value: 'opus' }],
			modelName: 'Opus',
		});
		const agent = {
			provider: 'codex' as const,
			options: [
				{ id: 'model', value: 'gpt-6-astra' },
				{ id: 'reasoning_effort', value: 'high' },
			],
			modelName: '6 Astra',
			effortName: 'High',
		};
		const base = { title: 'Review', prompt: 'Review the PR.', context: [], folders: [] };
		await f.propose({ ...base, id: 'a1', start: 'backlog', agent });
		const draft = await f.proposals.draft(f.source, 'a1', {
			projectId: f.project.id,
			id: '00000000-0000-4000-8000-0000000000ab',
			draft: true,
		});
		expect(draft).toMatchObject({ provider: 'codex', options: agent.options });
		const task = await f.proposals.create(f.source, 'a1');
		expect(task).toMatchObject({
			provider: 'codex',
			transport: 'gui',
			launchOptions: agent.options,
			modelName: '6 Astra',
			effortName: 'High',
		});
		// Only a provider: its defaults, not the source's Claude model.
		await f.propose({
			...base,
			id: 'a2',
			start: 'backlog',
			agent: { provider: 'codex', options: [], modelName: null, effortName: null },
		});
		const plain = await f.proposals.create(f.source, 'a2');
		expect(plain.provider).toBe('codex');
		expect(plain.launchOptions).toBeUndefined();
		expect(plain.modelName).toBeUndefined();
	} finally {
		await rm(f.root, { recursive: true, force: true });
	}
});
