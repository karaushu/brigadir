import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SessionStore } from '@brigadir/persistence';
import { Snapshots, git } from '@brigadir/git';
import { Changes } from './changes';
import { ActivityDetails } from './activity-details';
it('reads tool previews from journal capabilities and turn chips from bounded snapshots without changing the selected range', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-activity-details-')),
		repo = join(root, 'repo');
	await mkdir(repo);
	let writer: Awaited<ReturnType<SessionStore['writer']>> | undefined;
	try {
		await git(repo, ['init', '-q']);
		await writeFile(join(repo, 'a.ts'), 'export const a = 1;\n');
		const store = await SessionStore.at(join(root, 'data')),
			project = await store.addProject(repo),
			task = await store.createTask(project.id, 'Preview', 'claude');
		const snapshots = await Snapshots.open(store, task);
		await snapshots.capture('baseline');
		writer = await store.writer(task);
		await writer.append({ kind: 'checkpoint.created', checkpoint: 0 });
		const turn = await writer.append({ kind: 'turn.started', text: 'Change a' });
		const tool = await writer.append({
			kind: 'tool.changed',
			patch: {
				id: 'edit',
				category: 'edit',
				content: [
					{
						kind: 'diff',
						path: 'a.ts',
						before: 'export const a = 1;\n',
						after: 'export const a = 99;\n',
					},
				],
			},
		});
		await writer.append({ kind: 'tool.changed', patch: { id: 'edit', status: 'completed' } });
		await writeFile(join(repo, 'a.ts'), 'export const a = 2;\n');
		await snapshots.capture('turn');
		await writer.append({ kind: 'checkpoint.created', checkpoint: 1 });
		await writer.append({ kind: 'turn.completed', reason: 'end_turn' });
		await writeFile(join(repo, 'later.ts'), 'later human change\n');
		await snapshots.capture('refresh');
		await writer.append({ kind: 'checkpoint.created', checkpoint: 2 });
		const changes = new Changes(store.root, resolve('apps/desktop/out/services/diff.cjs')),
			details = new ActivityDetails(changes);
		await changes.selectRange(task, { base: 1, current: 2 });
		const preview = await details.tool(task, tool.seq, 0);
		expect(preview.lines.filter((line) => line.kind === 'added').map((line) => line.text)).toEqual([
			'export const a = 99;',
		]);
		expect(preview.afterSyntax?.tokens.some((token) => token.kind === 'keyword')).toBe(true);
		await expect(details.tool(task, turn.seq, 0)).rejects.toThrow('unavailable');
		await expect(details.tool(task, tool.seq, 1)).rejects.toThrow('unavailable');
		const footer = await details.turn(task, turn.seq);
		expect(footer.range).toEqual({ base: 0, current: 1 });
		expect(footer.files.map((file) => file.path)).toEqual(['a.ts']);
		expect(footer.files[0]).toMatchObject({ additions: 1, deletions: 1 });
		expect(changes.range(task)).toEqual({ base: 1, current: 2 });
		expect((await changes.read(task)).files.map((file) => file.path)).toEqual(['later.ts']);
		expect(await details.currentToolChange(task, tool.seq, 0)).toMatchObject({ path: 'a.ts' });
		expect(changes.range(task)).toEqual({ base: 1, current: 2 });
		await expect(details.currentToolChange(task, turn.seq, 0)).rejects.toThrow('unavailable');
		await writeFile(join(repo, 'a.ts'), 'export const a = 1;\n');
		await snapshots.capture('refresh');
		expect(await details.currentToolChange(task, tool.seq, 0)).toBeNull();
		const outside = await writer.append({
			kind: 'tool.changed',
			patch: {
				id: 'outside',
				content: [{ kind: 'diff', path: join(root, 'a.ts'), before: 'a', after: 'b' }],
			},
		});
		expect(await details.currentToolChange(task, outside.seq, 0)).toBeNull();
		const live = await writer.append({ kind: 'turn.started', text: 'Not finished' });
		await expect(details.turn(task, live.seq)).rejects.toThrow('not complete');
		// The parsed journal is reused between reads; an appended completion is still seen.
		await writer.append({ kind: 'turn.completed', reason: 'end_turn' });
		expect((await details.turn(task, live.seq)).range).toEqual({ base: 2, current: 2 });
		expect(await details.canCopyTurn(task, live.seq)).toBe(false);
	} finally {
		await writer?.close();
		await rm(root, { recursive: true, force: true });
	}
}, 15000);
