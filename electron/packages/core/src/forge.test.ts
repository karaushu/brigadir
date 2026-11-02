import { expect, it } from 'vitest';
import {
	newPRChoices,
	repoBlockers,
	samePullRequest,
	suggestsPR,
	type ForgeScope,
	type ForgeSnapshot,
	type PRRef,
} from './forge';
import { commitsAhead, pushedAgo } from './messages';
const pr: PRRef = {
	number: 1065,
	url: 'https://github.com/o/r/pull/1065',
	title: 'Title',
	state: 'MERGED',
	head: 'feature',
	base: 'main',
};
it('compares a pull request by fields, not by key order (spec/tasks#lock-registry)', () => {
	// task.json keeps sorted keys; GitHub answers in its own order.
	const stored = JSON.parse(
		'{"base":"main","head":"feature","number":1065,"state":"MERGED","title":"Title","url":"https://github.com/o/r/pull/1065"}'
	) as PRRef;
	expect(JSON.stringify(stored)).not.toBe(JSON.stringify(pr));
	expect(samePullRequest(stored, pr)).toBe(true);
	expect(samePullRequest(pr, { ...pr, state: 'OPEN' })).toBe(false);
	expect(samePullRequest(pr, { ...pr, title: 'Other' })).toBe(false);
	expect(samePullRequest(pr, { ...pr, base: 'dev' })).toBe(false);
	expect(samePullRequest(undefined, pr)).toBe(false);
	expect(samePullRequest(pr, null)).toBe(false);
	expect(samePullRequest(undefined, null)).toBe(true);
	expect(samePullRequest(null, null)).toBe(true);
});
it('offers a new PR for ready repos and a card only for a pushed branch of its own (spec/pull-requests-and-ci#ready-card)', () => {
	const item = (
		id: string,
		over: Partial<ForgeScope> = {},
		git: Partial<ForgeScope['git']> = {}
	): ForgeScope => ({
		scope: { id, path: `/r/${id}`, name: id, kind: 'root', branch: 'feature', selected: true },
		git: {
			branch: 'feature',
			head: 'a'.repeat(40),
			remote: 'https://github.com/o/r',
			pushRemote: 'https://github.com/o/r',
			base: 'main',
			baseRef: 'origin/main',
			dirty: false,
			ahead: 3,
			pushAhead: 0,
			published: true,
			commits: [],
			warnings: [],
			...git,
		},
		repository: { name: 'o/r', url: 'https://github.com/o/r', defaultBranch: 'main' },
		pr: null,
		details: null,
		checksError: null,
		blockers: [],
		error: null,
		pushed: { sha: 'a'.repeat(40), at: null, hidden: false },
		...over,
	});
	const folder = item('folder');
	folder.scope = { ...folder.scope, kind: 'folder' };
	const data: ForgeSnapshot = {
		auth: 'ready',
		error: null,
		scopes: [
			item('ready'),
			item('blocked', { blockers: ['No commits ahead of base'] }),
			folder,
			item('hidden', { pushed: { sha: 'b'.repeat(40), at: null, hidden: true } }),
			item('local', { pushed: null }),
			item('base', {}, { branch: 'main' }),
		],
	};
	const choices = newPRChoices(data, null);
	expect(choices.map((choice) => choice.item.scope.id)).toEqual([
		'ready',
		'blocked',
		'hidden',
		'local',
		'base',
	]);
	expect(choices.filter(suggestsPR).map((choice) => choice.item.scope.id)).toEqual(['ready']);
	expect(newPRChoices(data, 'blocked')[0]!.reasons).toEqual(['No commits ahead of base']);
	// spec/pull-requests-and-ci#from-into: the branch's own reason leaves the dialog open (its pickers choose the pair); the repo's shut it.
	expect(newPRChoices(data, 'blocked')[0]!.blocked).toEqual([]);
	expect(newPRChoices({ ...data, auth: 'login' }, 'ready')[0]!).toMatchObject({
		reasons: ['GitHub is unavailable'],
		blocked: ['GitHub is unavailable'],
	});
	expect(
		repoBlockers([
			'No origin remote',
			'Detached HEAD',
			'Base branch is unavailable',
			'A pull request is already open',
			'GitHub status could not be read.',
		])
	).toEqual(['No origin remote', 'GitHub status could not be read.']);
	expect(newPRChoices(null, null)).toEqual([]);
});
it('says how far the branch is ahead and when it was pushed, with four uk forms (spec/pull-requests-and-ci#ready-card)', () => {
	expect(commitsAhead('en', 3, 'stage')).toBe('3 commits ahead of stage');
	expect(commitsAhead('en', 1, 'main')).toBe('1 commit ahead of main');
	expect(commitsAhead('en', 3, 'stage', true)).toBe('3 ahead of stage');
	expect(commitsAhead('uk', 1, 'stage')).toBe('1 коміт попереду stage');
	expect(commitsAhead('uk', 3, 'stage')).toBe('3 коміти попереду stage');
	expect(commitsAhead('uk', 5, 'stage')).toBe('5 комітів попереду stage');
	const now = Date.parse('2026-10-22T12:00:00Z'),
		at = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
	expect(pushedAgo('en', at(0), now)).toBe('pushed just now');
	expect(pushedAgo('en', at(2), now)).toBe('pushed 2 min ago');
	expect(pushedAgo('uk', at(2), now)).toBe('push 2 хв тому');
	expect(pushedAgo('en', at(60 * 25), now)).toBe('pushed yesterday');
	expect(pushedAgo('en', at(60 * 24 * 3), now)).toBe('pushed 3 d ago');
});
