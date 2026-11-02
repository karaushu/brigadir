import { expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SessionStore } from '@brigadir/persistence';
import { acquireOwner, reclaimAbsentOwner } from './runtime';
const helper = resolve('apps/desktop/out/services/process-owner');
it('task ownership is exclusive across callers and reclaims a reused PID, while keeping unknown live legacy owners', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-owner-'));
	try {
		const repo = join(root, 'repo');
		await mkdir(repo);
		const store = await SessionStore.at(join(root, 'data')),
			project = await store.addProject(repo),
			task = await store.createTask(project.id, 'Owner', 'claude');
		const file = join(await store.taskDir(task), 'host.lock');
		const results = await Promise.allSettled([
			acquireOwner(store, task, helper),
			acquireOwner(store, task, helper),
		]);
		expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
		const winner = results.find((result) => result.status === 'fulfilled')!;
		if (winner.status !== 'fulfilled') throw new Error('No owner');
		expect(JSON.parse(await readFile(file, 'utf8')).processStart).toBeTruthy();
		await expect(reclaimAbsentOwner(store, task, helper)).rejects.toThrow('already owns');
		await winner.value();
		await writeFile(
			file,
			JSON.stringify({ schemaVersion: 1, pid: process.pid, processStart: '1:000000' })
		);
		await reclaimAbsentOwner(store, task, helper);
		await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
		const legacy = JSON.stringify({
			schemaVersion: 1,
			pid: process.pid,
			startedAt: '2020-01-01T00:00:00Z',
		});
		await writeFile(file, legacy);
		await expect(acquireOwner(store, task, helper)).rejects.toThrow('already owns');
		expect(await readFile(file, 'utf8')).toBe(legacy);
		await writeFile(file, 'broken');
		await expect(reclaimAbsentOwner(store, task, helper)).rejects.toThrow();
		expect(await readFile(file, 'utf8')).toBe('broken');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
