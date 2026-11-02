import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SessionStore } from '@brigadir/persistence';
import { git, Snapshots } from '@brigadir/git';
import { Changes } from './changes';
const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
it('explains historical lines after shifts and rename, bounds the end, and preserves user attribution', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-attribution-'));
	roots.push(root);
	const repo = join(root, 'repo');
	await mkdir(repo);
	await git(repo, ['init', '-q']);
	let lines = Array.from({ length: 12 }, (_, i) => `unique baseline ${i + 1}`),
		path = 'file.txt';
	const save = () => writeFile(join(repo, path), lines.join('\n') + '\n');
	await save();
	const store = await SessionStore.at(join(root, 'data')),
		project = await store.addProject(repo),
		task = await store.createTask(project.id, 'History', 'claude');
	const snapshots = await Snapshots.open(store, task);
	await snapshots.capture('baseline');
	const writer = await store.writer(task),
		changes = new Changes(store.root, resolve('apps/desktop/out/services/diff.cjs'));
	const capture = async (text: string, edit: () => Promise<void>) => {
		const turn = await writer.append({ kind: 'turn.started', text });
		await edit();
		await writer.append({
			kind: 'message.delta',
			role: 'assistant',
			messageId: null,
			content: { kind: 'text', text: `Working on: ${text}` },
		});
		await writer.append({
			kind: 'tool.changed',
			patch: { id: 'edit', title: 'Edit file', locations: [{ path, line: null }] },
		});
		const point = (await snapshots.capture('turn'))!;
		await writer.append({ kind: 'checkpoint.created', checkpoint: point.id });
		await writer.append({
			kind: 'message.delta',
			role: 'assistant',
			messageId: null,
			content: { kind: 'text', text: 'AFTER_CHECKPOINT' },
		});
		await writer.append({ kind: 'turn.completed', reason: 'end_turn' });
		return turn.seq;
	};
	try {
		const first = await capture('Change the eighth line', async () => {
			lines[7] = 'agent change';
			await save();
		});
		await capture('Insert header', async () => {
			lines.unshift('new header');
			await save();
		});
		await capture('Edit an unrelated line', async () => {
			lines[1] = 'other change';
			await save();
		});
		let file = (await changes.read(task)).files[0]!;
		let result = await changes.attribution(task, file.id, { start: 9, end: 9 });
		expect(result.entries[0]).toMatchObject({
			checkpoint: 1,
			precision: 'lines',
			turn: first,
			author: 'agent',
		});
		expect(result.entries.filter((entry) => entry.precision === 'lines')).toHaveLength(1);
		expect(result.entries[0]!.excerpt).not.toContain('AFTER_CHECKPOINT');
		await writer.append({ kind: 'checkpoint.created', checkpoint: 1 }); // A reattached host may reannounce an existing checkpoint.
		await changes.selectRange(task, { base: 0, current: 1 });
		file = (await changes.read(task)).files[0]!;
		result = await changes.attribution(task, file.id, { start: 8, end: 8 });
		expect(result.entries.map((entry) => entry.checkpoint)).toEqual([1]);
		expect(result.entries[0]).toMatchObject({ author: 'agent', turn: first, turnNumber: 1 });
		await changes.selectRange(task, null);
		await capture('Rename the file', async () => {
			await rename(join(repo, path), join(repo, 'renamed.txt'));
			path = 'renamed.txt';
		});
		file = (await changes.read(task)).files[0]!;
		expect(file.path).toBe('renamed.txt');
		result = await changes.attribution(task, file.id, { start: 9, end: 9 });
		expect(result.entries[0]).toMatchObject({ checkpoint: 1, precision: 'lines', turn: first });
		const before = snapshots.current.checkpoints.at(-1)!.id;
		lines[8] = 'my explicit edit';
		await save();
		const user = (await snapshots.capture('user-after'))!;
		await writer.append({ kind: 'checkpoint.created', checkpoint: user.id });
		await writer.append({ kind: 'file.saved', path, before, after: user.id, version: 'fixture' });
		file = (await changes.read(task)).files[0]!;
		result = await changes.attribution(task, file.id, { start: 9, end: 9 });
		expect(result.entries[0]).toMatchObject({
			checkpoint: user.id,
			precision: 'lines',
			author: 'user',
			turn: null,
		});
		expect(result.entries.filter((entry) => entry.precision === 'lines')).toHaveLength(1);
		await capture('Remove third line', async () => {
			lines.splice(2, 1);
			await save();
		});
		file = (await changes.read(task)).files[0]!;
		result = await changes.attribution(task, file.id, { start: 3, end: 3 });
		expect(result.entries[0]).toMatchObject({ precision: 'lines', prompt: 'Remove third line' });
		expect(
			(await changes.attribution(task, file.id)).entries.every(
				(entry) => entry.precision === 'file'
			)
		).toBe(true);
		await capture('Copy the file', () =>
			writeFile(join(repo, 'copy.txt'), lines.join('\n') + '\n')
		);
		const copied = (await changes.read(task)).files.find((file) => file.path === 'copy.txt')!;
		const copiedHistory = await changes.attribution(task, copied.id, { start: 1, end: 1 });
		expect(copiedHistory.entries).toHaveLength(1);
		expect(copiedHistory.entries[0]).toMatchObject({ prompt: 'Copy the file', precision: 'lines' });
	} finally {
		await writer.close();
	}
}, 20000);
