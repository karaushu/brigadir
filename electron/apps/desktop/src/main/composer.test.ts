import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '@brigadir/persistence';
import { ComposerDrafts } from './composer';
const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function setup() {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-composer-'));
	roots.push(root);
	await mkdir(join(root, 'repo'));
	const store = await SessionStore.at(join(root, 'data')),
		project = await store.addProject(join(root, 'repo')),
		task = await store.createTask(project.id, 'Draft', 'claude');
	return { root, store, task, path: join(await store.taskDir(task), 'composer.json') };
}
it('coalesces text, flushes on close, isolates tasks and deletes an empty draft', async () => {
	const { store, task, path } = await setup(),
		other = await store.createTask(task.projectId, 'Other', 'claude'),
		drafts = new ComposerDrafts(store.root, 60000);
	expect(await drafts.read(task)).toBeNull();
	const first = drafts.save(task, 'earlier'),
		last = drafts.save(task, 'latest'),
		another = drafts.save(other, 'other task');
	expect(drafts.isSaving).toBe(true);
	expect(await drafts.read(task)).toBe('latest');
	await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
	await drafts.waitForWrites();
	await Promise.all([first, last, another]);
	expect(JSON.parse(await readFile(path, 'utf8')).text).toBe('latest');
	expect(await drafts.read(other)).toBe('other task');
	const empty = drafts.save(task, '');
	await drafts.waitForWrites();
	await empty;
	await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('never overwrites a future schema or follows a replaced composer symlink', async () => {
	const { root, store, task, path } = await setup(),
		drafts = new ComposerDrafts(store.root, 60000);
	await writeFile(path, '{"schemaVersion":99,"text":"future"}\n');
	const bytes = await readFile(path);
	await expect(drafts.read(task)).rejects.toThrow('unsupported_schema');
	const future = expect(drafts.save(task, 'replacement')).rejects.toThrow('unsupported_schema');
	await drafts.waitForWrites();
	await future;
	expect(await readFile(path)).toEqual(bytes);
	await rm(path);
	const outside = join(root, 'outside.json');
	await writeFile(outside, '{"schemaVersion":1,"text":"outside"}');
	await symlink(outside, path);
	const linked = expect(drafts.save(task, 'replacement')).rejects.toThrow('unsafe_path');
	await drafts.waitForWrites();
	await linked;
	expect(await readFile(outside, 'utf8')).toContain('outside');
});
