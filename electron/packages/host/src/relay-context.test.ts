import { it, expect } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Attachments, SessionStore, atomicJson, safePath } from '@brigadir/persistence';
import { relayContext } from './relay-context';
// spec/tasks#backlog-edit: the first turn carries the attachments a backlog task was saved with, after a relay's handoff.
it('adds the task own attachments to the first turn context', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-first-turn-'));
	try {
		const repo = join(root, 'repo');
		await mkdir(repo);
		const store = await SessionStore.at(join(root, 'data')),
			project = await store.addProject(repo),
			assets = new Attachments(store);
		const task = await store.createTask(
			project.id,
			'fixture',
			'claude',
			'gui',
			'New task',
			'backlog'
		);
		expect(await relayContext(store, task)).toEqual({ attachmentIds: [], resources: [] });
		const note = await assets.create(task, {
			kind: 'text',
			name: 'notes.md',
			text: 'File reference',
		});
		await store.updateTask(task, { attachments: [note] });
		expect(await relayContext(store, task)).toEqual({ attachmentIds: [note.id], resources: [] });
		const source = await store.createTask(project.id, 'source', 'claude'),
			relay = await store.createTask(project.id, 'relay', 'claude', 'gui', 'New task', 'backlog');
		await store.updateTask(relay, { continuesTaskId: source.id });
		const summary = await assets.create(relay, { kind: 'text', name: 'Summary', text: 'done' }),
			own = await assets.create(relay, { kind: 'text', name: 'own', text: 'x' });
		await atomicJson(await safePath(await store.taskDir(relay), 'relay.json'), {
			schemaVersion: 1,
			handoff: { sourceId: source.id, attachmentIds: [summary.id], files: [] },
		});
		await store.updateTask(relay, { attachments: [own] });
		expect((await relayContext(store, relay)).attachmentIds).toEqual([summary.id, own.id]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
