import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { defaultModules } from '@brigadir/core';
import { SessionStore, ProcessCoordinator } from '@brigadir/persistence';
import { Snapshots, Worktrees, discoverScopes, git } from '@brigadir/git';
import { Changes } from './changes';
import { Files } from './files';
import { Sessions } from './sessions';
import { ActivityDetails } from './activity-details';
import { QuickAsks } from './quick-ask';
import { readSlashCatalog, agentHomes } from './slash-catalog';
/** spec/tasks#released-worktree: every reader of an archived task whose worktree was removed answers calmly instead of failing on `worktree.json`. */
it('the panels of a task whose worktree was removed answer without errors', async () => {
	const root = await mkdtemp(join(tmpdir(), 'released-panels-'));
	try {
		const data = join(root, 'data'),
			repo = join(root, 'repo');
		await mkdir(repo);
		await git(repo, ['init', '-b', 'main']);
		await git(repo, ['config', 'user.name', 'F']);
		await git(repo, ['config', 'user.email', 'f@example.invalid']);
		await writeFile(join(repo, 'file'), 'base\n');
		await git(repo, ['add', '.']);
		await git(repo, ['commit', '-m', 'Initial']);
		const store = await SessionStore.at(data),
			project = await store.addProject(repo),
			task = await store.createTask(project.id, 'Isolated', 'claude'),
			trees = new Worktrees(
				store,
				new ProcessCoordinator(resolve('apps/desktop/out/services/process-owner'))
			);
		const state = await trees.prepare(task, {
			branch: 'brigadir/released-panels',
			baseRef: 'main',
		});
		await store.updateTask(task, {
			launch: {
				isolation: 'worktree',
				branch: state.branch,
				baseRef: 'main',
				setupCommand: '',
				scopes: (await discoverScopes(repo)).map(({ id, name, kind }) => ({
					id,
					name,
					kind,
					selected: true,
				})),
			},
		});
		const snapshots = await Snapshots.open(store, task);
		await snapshots.capture('baseline');
		await writeFile(join(state.root, 'file'), 'base\nadded\n');
		await snapshots.capture('turn');
		const changes = new Changes(data, resolve('apps/desktop/out/services/diff.cjs')),
			files = new Files(
				changes,
				new Sessions(data, resolve('apps/desktop/out/services'), () => {})
			);
		expect((await files.list(task, null)).entries.map((entry) => entry.name)).toContain('file');
		await trees.remove(task);
		// Tree, search, links, code navigation: empty, never an error.
		expect(await files.list(task, null)).toEqual({ entries: [], truncated: false, released: true });
		expect(await files.search(task, 'file')).toEqual({ entries: [], truncated: false });
		expect(await files.textFiles(task)).toEqual({ root: '', entries: [], truncated: false });
		expect(await files.links(task, [{ text: 'see file', literal: false }])).toEqual([[]]);
		expect(await files.codeFiles(task, 'typescript')).toEqual([]);
		expect(await files.locate(task, join(repo, 'file'))).toBeNull();
		// The editor cannot open a file that is not there, and says why.
		const diff = await changes.read(task);
		await expect(files.fromDiff(task, diff.files[0]!.id)).rejects.toThrow(
			'The task worktree was removed'
		);
		// The diff, its attribution and the «open the current file» lookup keep working from the snapshots.
		expect(diff.files.map((file) => file.path)).toEqual(['file']);
		await expect(changes.attribution(task, diff.files[0]!.id)).resolves.toMatchObject({
			entries: expect.any(Array),
		});
		await expect(new ActivityDetails(changes).currentToolChange(task, 1, 0)).rejects.toThrow(
			'Tool diff is unavailable'
		);
		// The slash catalog reads the project's own tree.
		expect(
			(
				await readSlashCatalog(
					store,
					{ projectId: task.projectId, taskId: task.id, provider: 'claude' },
					defaultModules,
					agentHomes({}, join(root, 'home'))
				)
			).provider
		).toBe('claude');
		// Quick Ask reports the removal as a failed answer instead of rejecting unhandled.
		const sent: unknown[] = [];
		await new QuickAsks({ dataDir: data, send: (event: unknown) => sent.push(event) } as never).ask(
			task,
			{
				id: 'a'.repeat(32),
				selection: { path: 'file', start: 1, end: 1, text: 'base' },
				question: 'Why?',
				language: 'en',
			} as never
		);
		expect(sent).toEqual([
			expect.objectContaining({
				kind: 'failed',
				message: expect.stringContaining('worktree was removed'),
			}),
		]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}, 60000);
