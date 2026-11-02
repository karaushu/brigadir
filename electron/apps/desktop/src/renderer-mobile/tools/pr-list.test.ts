import { describe, expect, it } from 'vitest';
import type { AgentTask, PullRequestSummary, PullRequestsSnapshot } from '@brigadir/core';
import {
	chipCounts,
	defaultChip,
	githubRepos,
	prBadge,
	prItems,
	prSections,
	prTask,
} from './pr-list';

const now = Date.parse('2026-10-16T12:00:00Z');
const pr = (number: number, patch: Partial<PullRequestSummary> = {}): PullRequestSummary => ({
	number,
	title: `PR ${number}`,
	url: `https://github.com/acme/repo/pull/${number}`,
	state: 'OPEN',
	author: 'olena-p',
	mine: false,
	waiting: false,
	head: `feat/${number}`,
	base: 'main',
	updatedAt: '2026-10-16T11:00:00Z',
	closedAt: null,
	reviewDecision: null,
	reviewers: [],
	comments: 0,
	checks: 'pass',
	additions: 3,
	deletions: 1,
	...patch,
});
const repository = {
	owner: 'acme',
	name: 'repo',
	url: 'https://github.com/acme/repo',
	defaultBranch: 'main',
};
const snapshot: PullRequestsSnapshot = {
	auth: 'ready',
	viewer: 'me',
	repos: [
		{ scopeId: 'root', name: '.', repository, prs: [], error: null },
		{
			scopeId: 'admin',
			name: 'apps/admin',
			repository,
			prs: [
				pr(1031, { waiting: true, title: 'New template', head: 'feat/new-template' }),
				pr(1029, { mine: true, author: 'me' }),
				pr(1022, { state: 'MERGED', closedAt: '2026-10-15T10:00:00Z', mine: true }),
			],
			error: null,
		},
		{
			scopeId: 'kit',
			name: 'kit',
			repository,
			prs: [pr(98, { state: 'DRAFT', author: 'maks-d' })],
			error: null,
		},
		{ scopeId: 'local', name: 'tools', repository: null, prs: [], error: null },
	],
};
describe('the phone’s PR list (spec/remote-access-and-mobile#phone-pr-list)', () => {
	it('lists the repos on GitHub only and names the root by the project', () => {
		expect(githubRepos(snapshot).map((repo) => repo.name)).toEqual(['.', 'apps/admin', 'kit']);
		expect(prItems(snapshot, 'choice', 'kit').map((item) => item.repo)).toEqual(['kit']);
		expect(prItems(snapshot, 'choice', null)).toHaveLength(4);
	});
	it('counts the chips over open PRs and starts on «Чекають тебе» while any waits', () => {
		const items = prItems(snapshot, 'choice', null);
		expect(chipCounts(items)).toEqual({ all: 3, waiting: 1, mine: 1 });
		expect(defaultChip(items)).toBe('waiting');
		expect(defaultChip(prItems(snapshot, 'choice', 'kit'))).toBe('all');
		expect(prBadge(snapshot)).toEqual({ open: 3, waiting: true });
	});
	it('keeps one group per chip, the closed ones under «Усі» without a search', () => {
		const items = prItems(snapshot, 'choice', null);
		expect(prSections(items, { chip: 'all', query: '' }, now).map((s) => s.group)).toEqual([
			'waiting',
			'mine',
			'others',
			'closed',
		]);
		expect(prSections(items, { chip: 'mine', query: '' }, now).map((s) => s.group)).toEqual([
			'mine',
		]);
		const found = prSections(items, { chip: 'all', query: 'templ' }, now);
		expect(found.map((s) => s.items.map((item) => item.pr.number))).toEqual([[1031]]);
		expect(
			prSections(items, { chip: 'all', query: 'apps/admin' }, now).flatMap((s) => s.items)
		).toHaveLength(2);
	});
	it('shows the recently closed ones of a list without open PRs only when asked', () => {
		const closedOnly = prItems(
			{ ...snapshot, repos: [{ ...snapshot.repos[1]!, prs: [snapshot.repos[1]!.prs[2]!] }] },
			'choice',
			null
		);
		expect(prSections(closedOnly, { chip: 'all', query: '' }, now)).toEqual([]);
		expect(prSections(closedOnly, { chip: 'all', query: '', closed: true }, now)[0]?.group).toBe(
			'closed'
		);
	});
	it('finds the PR’s task by its address or by the repo and number', () => {
		const task = (patch: Partial<AgentTask>): AgentTask =>
			({ id: 't', projectId: 'p', title: 'Task', status: 'working', ...patch }) as AgentTask;
		const ref = {
			number: 1031,
			url: pr(1031).url,
			title: '',
			state: 'OPEN' as const,
			head: '',
			base: '',
		};
		const byUrl = task({ pullRequests: { worktreeScope: ref } });
		expect(prTask([byUrl], 'p', { scopeId: 'admin', number: 1031, url: ref.url })).toBe(byUrl);
		expect(prTask([byUrl], 'p', { scopeId: 'admin', number: 1031 })).toBeNull();
		const byScope = task({ pullRequests: { admin: { ...ref, url: 'other' } } });
		expect(prTask([byScope], 'p', { scopeId: 'admin', number: 1031 })).toBe(byScope);
		expect(prTask([byScope], 'other', { scopeId: 'admin', number: 1031 })).toBeNull();
	});
});
