import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore, atomicJson } from '@brigadir/persistence';
import type { AgentCheck, ProviderCatalog } from '@brigadir/core';
import { readTaskReview, reviewerFor } from './task-review';

const run = promisify(execFile);
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn();
});
const check = (provider: 'claude' | 'codex', signIn: AgentCheck['signIn'], found = true) =>
	({ provider, found, via: 'path', version: '1', signIn }) as AgentCheck;
const catalog = (model: string, effort: string): ProviderCatalog =>
	({
		options: [
			{
				id: 'model',
				name: 'Model',
				category: 'model',
				kind: 'select',
				description: null,
				value: model,
				choices: [{ value: model, name: model }],
			},
			{
				id: 'effort',
				name: 'Effort',
				category: 'thought_level',
				kind: 'select',
				description: null,
				value: effort,
				choices: [{ value: effort, name: effort }],
			},
		],
	}) as unknown as ProviderCatalog;

describe('who reviews, from the app’s state (spec/reviews#who)', () => {
	const base = {
		author: 'claude' as const,
		point: 'mid' as const,
		enabled: { claude: true, codex: true },
		actionAgents: {},
		catalogs: { codex: catalog('gpt-5.5', 'medium') },
	};
	it('another provider signed in: its catalog’s own model and effort', () => {
		expect(
			reviewerFor({ ...base, agents: [check('claude', 'signed-in'), check('codex', 'signed-in')] })
		).toEqual({ provider: 'codex', model: 'gpt-5.5', effort: 'medium', source: 'other' });
	});
	it('the other provider absent, signed out or not known: a fresh session of the task’s own', () => {
		for (const agents of [
			[check('claude', 'signed-in'), check('codex', 'signed-out')],
			[check('claude', 'signed-in'), check('codex', 'signed-in', false)],
			[check('claude', 'signed-in'), check('codex', 'unknown')],
			[],
		])
			expect(reviewerFor({ ...base, agents })).toMatchObject({
				provider: 'claude',
				source: 'same',
			});
	});
	it('the setting of the point wins: Plan review for the plan, Code reviews for the rest', () => {
		const actionAgents = {
			planReview: { provider: 'claude' as const, model: 'opus', name: 'Opus', effort: 'high' },
			taskReview: { provider: 'claude' as const, model: 'sonnet', name: 'Sonnet', effort: null },
		};
		const agents = [check('claude', 'signed-in'), check('codex', 'signed-in')];
		expect(reviewerFor({ ...base, agents, actionAgents })).toEqual({
			provider: 'claude',
			model: 'sonnet',
			effort: null,
			source: 'setting',
		});
		expect(reviewerFor({ ...base, point: 'plan', agents, actionAgents })).toMatchObject({
			model: 'opus',
			source: 'setting',
		});
	});
});

describe('what the window reads (spec/reviews#strip, spec/reviews#before-pr)', () => {
	async function task() {
		const root = await mkdtemp(join(tmpdir(), 'brigadir-main-review-'));
		cleanup.push(() => rm(root, { recursive: true, force: true }));
		const repo = join(root, 'repo');
		await mkdir(repo);
		await run('git', ['init', '-q', '-b', 'main'], { cwd: repo });
		const store = await SessionStore.at(join(root, 'data'));
		const project = await store.addProject(repo);
		const created = await store.createTask(project.id, 'T', 'claude', 'gui', 'T');
		return { store, key: { projectId: created.projectId, id: created.id } };
	}
	it('reads a version-2 record with its past reviews and the findings of each', async () => {
		const { store, key } = await task();
		const review = (id: string, point: 'mid' | 'pre-pr', state: string) => ({
			id,
			point,
			target: { taskId: key.id },
			startedBy: point === 'mid' ? 'agent' : 'person',
			who: { kind: 'agent' },
			instructions: '',
			guidance: '',
			startedAt: '2026-01-01T00:00:00.000Z',
			state,
			round: 2,
			passes: 1,
			reviewers: ['Codex'],
			trees: [],
		});
		await atomicJson(join(await store.taskDir(key), 'task-review.json'), {
			schemaVersion: 2,
			proposal: null,
			review: review('r2', 'pre-pr', 'yours'),
			past: [review('r1', 'mid', 'passed')],
		});
		const finding = (id: string, reviewId: string, marks: Record<string, unknown>) => ({
			id,
			version: 1,
			text: id,
			at: '',
			anchor: { scopeId: 's1', path: 'src/a.ts', start: 4 },
			review: { reviewId, round: 1, reviewer: 'Codex', ...marks },
			replies: [{ author: 'Codex', text: 'Still there.', at: '', round: 2, agent: false }],
			sent: true,
		});
		const view = await readTaskReview(store, key, async () => ({
			comments: [
				finding('a', 'r1', { closed: 2 }),
				finding('b', 'r2', { open: 2 }),
				finding('c', 'other', {}),
			] as never,
		}));
		expect(view.review).toMatchObject({ id: 'r2', state: 'yours' });
		expect(view.past.map((item) => item.id)).toEqual(['r1']);
		expect(view.comments.map((item) => [item.id, item.reviewId, item.state])).toEqual([
			['a', 'r1', 'fixed'],
			['b', 'r2', 'open'],
		]);
		expect(view.comments[1]!.reason).toBe('Still there.');
		expect(view.beforePR).toBe('running');
	});
	it('a task without changes needs no review before the PR', async () => {
		const { store, key } = await task();
		expect((await readTaskReview(store, key, async () => ({ comments: [] }))).beforePR).toBe(
			'covered'
		);
	});
});
