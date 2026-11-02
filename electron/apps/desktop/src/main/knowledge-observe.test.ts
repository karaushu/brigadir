import { mkdtemp, mkdir, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, vi } from 'vitest';
import { SessionStore } from '@brigadir/persistence';
const discovered = vi.hoisted(() => ({ count: 0 }));
vi.mock('@brigadir/git', async (original) => {
	const git = await original<typeof import('@brigadir/git')>();
	return {
		...git,
		discoverScopes: async (...args: Parameters<typeof git.discoverScopes>) => {
			discovered.count++;
			return git.discoverScopes(...args);
		},
	};
});
import { Knowledge } from './knowledge';
test('mines after a turn without repo discovery, rewrites only on change and coalesces a burst of turns', async () => {
	const root = await mkdtemp(join(tmpdir(), 'knowledge-observe-'));
	try {
		const data = join(root, 'data'),
			repo = join(root, 'repo');
		await mkdir(repo);
		const store = await SessionStore.at(data),
			project = await store.addProject(repo),
			path = join(data, 'projects', project.id, 'knowledge.json');
		const answer = async (title: string) => {
			const task = await store.createTask(project.id, title, 'claude'),
				writer = await store.writer(task);
			await writer.append({ kind: 'turn.started', text: title });
			await writer.append({
				kind: 'question.requested',
				question: {
					id: 'q',
					question: 'How do we run the tests?',
					header: 'Tests',
					options: [],
					allowsFreeText: true,
					allowsMultiple: false,
				},
			});
			await writer.append({
				kind: 'question.resolved',
				id: 'q',
				answer: { labels: [], text: 'pnpm test' },
			});
			await writer.append({ kind: 'turn.completed', reason: 'end_turn' });
			await writer.close();
		};
		await answer('First task');
		await answer('Second task');
		const service = new Knowledge(data);
		// A turn.completed must not run discoverScopes (~0.5 s, 25-38 git processes on a large monorepo) or rewrite knowledge.json.
		await service.observe(project.id);
		expect(discovered.count).toBe(0);
		const written = (await stat(path)).mtimeMs;
		expect((await service.read(project.id)).proposals).toHaveLength(1);
		expect(discovered.count).toBe(1);
		await new Promise((resolve) => setTimeout(resolve, 20));
		await service.observe(project.id);
		expect((await stat(path)).mtimeMs).toBe(written);
		// Turns that end while a pass waits for the project join it.
		const passes = [
			service.observe(project.id),
			service.observe(project.id),
			service.observe(project.id),
		];
		expect(new Set(passes).size).toBe(1);
		await Promise.all(passes);
		expect(discovered.count).toBe(1);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
