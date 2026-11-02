import { it, expect, vi, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '@brigadir/persistence';
import { isBusy, type SessionSnapshot } from '@brigadir/core';
vi.mock('electron', () => ({ Menu: { buildFromTemplate: () => ({ popup: () => {} }) } }));
import { ClientUi } from './client-ui';
import { Boards } from './boards';
import { ProjectViews } from './views';
import type { Sessions } from './sessions';
import type { LaunchQueue } from './launch-queue';
const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function setup() {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-board-'));
	roots.push(root);
	const store = await SessionStore.at(join(root, 'data')),
		project = await store.addProject(root),
		task = await store.createTask(
			project.id,
			'Original intent',
			'claude',
			'gui',
			'New task',
			'backlog'
		);
	let snapshot: SessionSnapshot = { key: task, records: [], connected: false, issue: null };
	const changed = vi.fn();
	const sessions = {
		read: vi.fn(async () => snapshot),
		activity: vi.fn(async () => ({
			connected: snapshot.connected,
			busy: isBusy(snapshot.records),
			started: false,
		})),
		connected: vi.fn(async () => snapshot.connected),
		command: vi.fn(async (commandKey: unknown, command: { kind: string }) => {
			if (command.kind === 'pausePromptQueue') return;
			snapshot = {
				...snapshot,
				records: [
					...snapshot.records,
					{
						schemaVersion: 1,
						seq: 2,
						at: new Date().toISOString(),
						event: { kind: 'turn.completed', reason: 'cancelled' },
					},
				],
			};
		}),
		stopForRemoval: vi.fn(async () => {
			snapshot = { ...snapshot, connected: false };
		}),
	};
	const launches = {
		request: vi.fn(async () => {
			await store.setStatus(task, 'working');
			return snapshot;
		}),
		dequeue: vi.fn(async () => false),
	};
	return {
		root,
		store,
		task,
		sessions,
		launches,
		changed,
		setSnapshot: (value: SessionSnapshot) => {
			snapshot = value;
		},
		boards: new Boards(
			store.root,
			sessions as unknown as Sessions,
			launches as unknown as LaunchQueue,
			new ClientUi(),
			() => 'en',
			changed
		),
	};
}
it('keeps initial backlog cheap, edits the same identity, and refuses edits after a turn', async () => {
	const { store, task, boards } = await setup();
	const updated = await boards.edit(task, 'Changed intention', 'codex', 'terminal');
	expect(updated).toMatchObject({
		id: task.id,
		status: 'backlog',
		prompt: 'Changed intention',
		provider: 'codex',
		transport: 'terminal',
	});
	expect((await store.journal(task)).records).toEqual([]);
	const writer = await store.writer(task);
	await writer.append({ kind: 'turn.started', text: 'Sent intent' });
	await writer.close();
	await expect(boards.edit(task, 'Rewrite history', 'claude', 'gui')).rejects.toThrow(
		'already sent'
	);
	expect((await store.task(task)).prompt).toBe('Changed intention');
});
it('allows only the three-column transitions, cancels before completion, and resumes completed without a new turn', async () => {
	const { store, task, boards, sessions, launches, setSnapshot } = await setup();
	await expect(boards.move(task, 'completed')).rejects.toThrow('not allowed');
	expect(launches.request).not.toHaveBeenCalled();
	await boards.move(task, 'progress');
	expect(launches.request).toHaveBeenCalledOnce();
	setSnapshot({
		key: task,
		connected: true,
		issue: null,
		records: [
			{
				schemaVersion: 1,
				seq: 1,
				at: new Date().toISOString(),
				event: { kind: 'turn.started', text: 'hold' },
			},
		],
	});
	await boards.move(task, 'completed');
	expect(sessions.command).toHaveBeenCalledWith(expect.objectContaining({ id: task.id }), {
		kind: 'cancel',
	});
	expect((await store.task(task)).status).toBe('completed');
	await expect(boards.move(task, 'backlog')).rejects.toThrow('not allowed');
	await boards.move(task, 'progress');
	expect((await store.task(task)).status).toBe('done');
	expect(launches.request).toHaveBeenCalledOnce();
	await boards.move(task, 'backlog');
	expect(sessions.stopForRemoval).toHaveBeenCalledTimes(2);
	expect((await store.task(task)).status).toBe('backlog');
	// Stopping asks the small status; the journal is never pulled for it (BG-04).
	expect(sessions.read).not.toHaveBeenCalled();
	expect(sessions.activity).toHaveBeenCalled();
});
it('refuses overlapping moves and never writes completion if cancellation fails', async () => {
	const { store, task, boards, sessions, setSnapshot } = await setup();
	await store.setStatus(task, 'working');
	setSnapshot({
		key: task,
		connected: true,
		issue: null,
		records: [
			{
				schemaVersion: 1,
				seq: 1,
				at: new Date().toISOString(),
				event: { kind: 'turn.started', text: 'hold' },
			},
		],
	});
	let reject!: (reason: Error) => void;
	sessions.command.mockImplementation(async (_, command) =>
		command.kind === 'pausePromptQueue'
			? undefined
			: new Promise((_, r) => {
					reject = r;
				})
	);
	const first = boards.move(task, 'completed');
	await vi.waitFor(() =>
		expect(sessions.command).toHaveBeenCalledWith(expect.anything(), { kind: 'cancel' })
	);
	await expect(boards.move(task, 'backlog')).rejects.toThrow('changing');
	const failure = expect(first).rejects.toThrow('cancel failed');
	reject(new Error('cancel failed'));
	await failure;
	expect((await store.task(task)).status).toBe('working');
});
it('persists independent views serially and refuses to overwrite corrupt or future documents', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-views-'));
	roots.push(root);
	const views = new ProjectViews(join(root, 'data'));
	expect(await views.read()).toEqual({});
	await Promise.all([views.save('a', 'list'), views.save('*', 'board'), views.save('b', 'list')]);
	expect(await new ProjectViews(join(root, 'data')).read()).toEqual({
		a: 'list',
		'*': 'board',
		b: 'list',
	});
	const path = join(root, 'data/project-views.json');
	for (const content of ['{broken', '{"schemaVersion":99,"views":{}}']) {
		await writeFile(path, content);
		await expect(views.save('a', 'board')).rejects.toThrow();
		expect(await readFile(path, 'utf8')).toBe(content);
	}
});
// spec/projects-and-board#pr-mode: the tab and the PR filter live beside the view in the same document; neither write drops the other.
it('persists the project tab and PR filter beside the view', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-modes-'));
	roots.push(root);
	const views = new ProjectViews(join(root, 'data'));
	expect(await views.readModes()).toEqual({});
	await Promise.all([
		views.save('a', 'list'),
		views.saveMode('a', { tab: 'prs', filter: 'waiting', repo: 'a/kit' }),
		views.saveMode('*', { tab: 'tasks', filter: 'all' }),
	]);
	const fresh = new ProjectViews(join(root, 'data'));
	expect(await fresh.read()).toEqual({ a: 'list' });
	expect(await fresh.readModes()).toEqual({
		a: { tab: 'prs', filter: 'waiting', repo: 'a/kit' },
		'*': { tab: 'tasks', filter: 'all' },
	});
	await expect(views.saveMode('a', { tab: 'x', filter: 'all' } as never)).rejects.toThrow();
});
// spec/tasks#backlog-edit: the edit sheet writes the name, the model choice and the task's attachments; an empty name gives the title back to the text.
it('edits a backlog task with the sheet: name, model options and attachments', async () => {
	const { task, boards } = await setup();
	const attachment = {
		id: '7b0f7c43-4b55-4d55-9d1a-3c3b0c6a1f10',
		name: 'Pasted image',
		kind: 'image' as const,
		bytes: 120,
	};
	const choice = (value: string, name: string) => ({ value, name, description: null, group: null });
	const options = {
		agentOptions: [
			{
				kind: 'select' as const,
				id: 'model',
				name: 'Model',
				description: null,
				category: 'model',
				value: 'opus',
				choices: [choice('opus', 'Opus'), choice('sonnet', 'Sonnet')],
			},
		],
		launchOptions: [{ id: 'model', value: 'opus' }],
		modelName: 'Opus',
	};
	const named = await boards.edit(task, 'Drop the legacy checkout', 'claude', 'gui', undefined, {
		name: 'Legacy checkout',
		options,
		attachments: [attachment],
	});
	expect(named).toMatchObject({
		title: 'Legacy checkout',
		prompt: 'Drop the legacy checkout',
		modelName: 'Opus',
		effortName: '',
		launchOptions: [{ id: 'model', value: 'opus' }],
		attachments: [attachment],
	});
	const plain = await boards.edit(task, 'Only text now', 'claude', 'gui', undefined, {
		name: null,
		attachments: [],
	});
	expect(plain).toMatchObject({ title: 'Only text now', modelName: 'Opus', attachments: [] });
});
