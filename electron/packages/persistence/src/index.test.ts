import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readWorkspace, resolveDataRoot } from './index';
let home: string;
let dataDir: string;
async function json(path: string, value: unknown) {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify(value));
}
function project(id = 'choice') {
	return { schemaVersion: 1, project: { id, name: 'shop', path: '/projects/shop' } };
}
function task(id = 'task-1') {
	return {
		schemaVersion: 1,
		task: { id, projectId: 'choice', title: 'Build v2', status: 'working' },
	};
}
function projectFile() {
	return join(dataDir, 'projects/choice/project.json');
}
function taskFile() {
	return join(dataDir, 'projects/choice/tasks/task-1/task.json');
}
beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), 'brigadir-store-'));
	dataDir = join(home, '.brigadir');
});
afterEach(async () => {
	await rm(home, { recursive: true, force: true });
});
describe('read-only v2 storage', () => {
	it('treats absent v2 storage as empty without creating it', async () => {
		expect(await readWorkspace({ home })).toEqual({ projects: [], tasks: [], issues: [] });
		expect(await readdir(home)).toEqual([]);
	});
	it('reads v2 documents and preserves their exact bytes', async () => {
		await json(projectFile(), project());
		await json(taskFile(), task());
		const before = await readFile(taskFile(), 'utf8');
		const value = await readWorkspace({ home });
		expect(value.projects).toEqual([project().project]);
		expect(value.tasks).toEqual([{ ...task().task, updatedAt: expect.any(String) }]);
		expect(value.issues).toEqual([]);
		expect(await readFile(taskFile(), 'utf8')).toBe(before);
	});
	it('reports a newer schema without quarantining or rewriting it', async () => {
		await json(projectFile(), { ...project(), schemaVersion: 99 });
		const before = await readFile(projectFile(), 'utf8');
		expect((await readWorkspace({ home })).issues).toEqual([
			{ path: 'projects/choice/project.json', code: 'unsupported_schema' },
		]);
		expect(await readFile(projectFile(), 'utf8')).toBe(before);
		expect(await readdir(dirname(projectFile()))).toEqual(['project.json']);
	});
	it('keeps the valid project when a task has malformed JSON', async () => {
		await json(projectFile(), project());
		await json(taskFile(), task());
		await writeFile(taskFile(), '{');
		const value = await readWorkspace({ home });
		expect(value.projects).toHaveLength(1);
		expect(value.tasks).toEqual([]);
		expect(value.issues[0]?.code).toBe('invalid_document');
		expect(await readFile(taskFile(), 'utf8')).toBe('{');
	});
	it('rejects document IDs that disagree with their directories', async () => {
		await json(projectFile(), project());
		await json(taskFile(), task('different'));
		expect((await readWorkspace({ home })).issues[0]?.code).toBe('invalid_document');
	});
	it('rejects a task claiming a different project', async () => {
		await json(projectFile(), project());
		await json(taskFile(), { ...task(), task: { ...task().task, projectId: 'other' } });
		expect((await readWorkspace({ home })).tasks).toEqual([]);
		expect((await readWorkspace({ home })).issues[0]?.code).toBe('invalid_document');
	});
	it('rejects the home folder, its ancestors and relative roots', async () => {
		for (const candidate of [home, dirname(home)]) {
			await expect(resolveDataRoot(candidate, home)).rejects.toMatchObject({ code: 'unsafe_path' });
		}
		await expect(resolveDataRoot('relative', home)).rejects.toMatchObject({ code: 'unsafe_path' });
	});
	it('does not follow a document symlink out of the v2 root', async () => {
		const target = join(home, 'outside.json');
		await json(target, project());
		await mkdir(dirname(projectFile()), { recursive: true });
		await symlink(target, projectFile());
		expect((await readWorkspace({ home })).issues[0]?.code).toBe('unsafe_path');
		expect(await readFile(target, 'utf8')).toBe(JSON.stringify(project()));
	});
	it('does not follow a projects-directory symlink out of the root', async () => {
		const outside = join(home, 'outside');
		await mkdir(outside);
		await mkdir(dataDir);
		await symlink(outside, join(dataDir, 'projects'));
		expect((await readWorkspace({ home })).issues[0]?.code).toBe('unsafe_path');
		expect(await readdir(outside)).toEqual([]);
	});
});
