import { test, expect } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Projects } from './projects';
import { SessionStore, readWorkspace } from '@brigadir/persistence';
test('canonical recent projects survive relaunch, reuse concurrent opens and reopen removed entries without restoring old task metadata', async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'recent-projects-')));
	try {
		const data = join(root, 'data'),
			repo = join(root, 'repo'),
			alias = join(root, 'alias');
		await mkdir(repo);
		await symlink(repo, alias);
		const projects = new Projects(data),
			opened = await Promise.all([projects.open(repo), projects.open(alias)]);
		expect(opened[0]!.id).toBe(opened[1]!.id);
		expect((await readWorkspace({ dataDir: data })).projects).toHaveLength(1);
		expect(await new Projects(data).recent()).toEqual([repo]);
		await rm(join(data, 'projects', opened[0]!.id), { recursive: true });
		const reopened = await projects.open(repo);
		expect(reopened.id).not.toBe(opened[0]!.id);
		await rm(repo, { recursive: true });
		await expect(projects.open(repo)).rejects.toThrow();
		expect(await projects.recent()).toEqual([repo]);
		await projects.clear();
		expect(await new Projects(data).recent()).toEqual([]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
test('seeds v2 projects, limits history and preserves unsupported recent metadata before mutating projects', async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'recent-state-')));
	try {
		const data = join(root, 'data'),
			repo = join(root, 'repo');
		await mkdir(repo);
		const store = await SessionStore.at(data);
		await store.addProject(repo);
		const projects = new Projects(data);
		expect(await projects.recent()).toEqual([repo]);
		const file = join(data, 'recent-projects.json');
		await writeFile(
			file,
			JSON.stringify({
				schemaVersion: 1,
				paths: Array.from({ length: 20 }, (_, i) => join(root, `old${i}`)),
			})
		);
		await projects.open(repo);
		expect(await projects.recent()).toHaveLength(20);
		expect((await projects.recent())[0]).toBe(repo);
		await writeFile(file, '{"schemaVersion":99,"paths":[]}');
		await expect(projects.clear()).rejects.toThrow();
		await expect(projects.open(root)).rejects.toThrow();
		expect(await readFile(file, 'utf8')).toContain('99');
		expect((await readWorkspace({ dataDir: data })).projects).toHaveLength(1);
		expect(projects.isSaving).toBe(false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
