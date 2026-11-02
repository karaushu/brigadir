import { it, expect } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskReads } from './task-reads';
it('coalesces monotonic read watermarks, flushes on quit and refuses corrupt/future read state', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-task-reads-'));
	try {
		const reads = new TaskReads(root),
			key = { projectId: 'project', id: 'task' };
		expect(await reads.read()).toEqual({});
		await Promise.all([reads.mark(key, 10), reads.mark(key, 5), reads.mark(key, 11)]);
		expect(reads.isSaving).toBe(true);
		await reads.waitForWrites();
		expect(reads.isSaving).toBe(false);
		expect(await new TaskReads(root).read()).toEqual({ 'project/task': 11 });
		const path = join(root, 'task-reads.json');
		for (const bad of [
			'{"schemaVersion":99,"seen":{}}',
			'{"schemaVersion":1,"seen":{"../outside":20}}',
			'broken',
		]) {
			await writeFile(path, bad);
			await expect(new TaskReads(root).mark(key, 20)).rejects.toThrow();
			expect(await readFile(path, 'utf8')).toBe(bad);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
