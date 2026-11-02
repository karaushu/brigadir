import { expect, it } from 'vitest';
import {
	branchFromAnswer,
	deriveBranch,
	freeBranch,
	suggestedBranch,
	validBranch,
} from './branch-name';
import { withAutoBranch } from './launch';
it('derives readable ASCII branches, keeps numeric tokens and transliterates Ukrainian', () => {
	expect(deriveBranch('Please fix the 1+1 test in a new parser')).toBe(
		'brigadir/1-1-test-new-parser'
	);
	expect(deriveBranch('Виправ помилку в кошику')).toBe('brigadir/pomylku-koshyku');
	expect(suggestedBranch('', '1+1', 'cf1b7f4e-e55a')).toBe('brigadir/1-1');
	expect(suggestedBranch('', '', 'cf1b7f4e-e55a')).toBe('brigadir/task-cf1b7f');
	expect(deriveBranch('Щастя їжачка')).toBe('brigadir/shchastia-izhachka');
	expect(suggestedBranch('User title', 'Longer prompt', 'abc')).toBe('brigadir/user-title');
	expect(deriveBranch('reallylongword anotherlongword averylongthirdword four')).toBe(
		'brigadir/reallylongword-anotherlongword'
	);
});
it('rejects branch syntax before Git is started', () => {
	for (const name of [
		'',
		'HEAD',
		'@',
		'-option',
		'a/',
		'.a',
		'a/.b',
		'a..b',
		'a@{b',
		'a.lock/x',
		'a//b',
		'a b',
		'a\\b',
		'x\n',
		'кирилиця',
		'a.',
		'a~b',
		'a:b',
	])
		expect(validBranch(name), name).toBe(false);
	for (const name of ['brigadir/example', 'feature-1', 'a/b.c', '123'])
		expect(validBranch(name), name).toBe(true);
});
it('turns the agent answer into 2–4 words under brigadir/ and frees a taken name (spec/git#agent-branch-names)', () => {
	expect(branchFromAnswer('custom-route-vibepreview')).toBe('brigadir/custom-route-vibepreview');
	expect(branchFromAnswer('`brigadir/Custom Route for VibePreview`\nbecause it adds a route')).toBe(
		'brigadir/custom-route-vibepreview'
	);
	expect(branchFromAnswer('one two three four five six')).toBe('brigadir/one-two-three-four');
	expect(branchFromAnswer('')).toBe('');
	expect(branchFromAnswer('ваша гілка')).toBe('brigadir/vasha-hilka');
	expect(freeBranch('brigadir/a', new Set())).toBe('brigadir/a');
	expect(freeBranch('brigadir/a', new Set(['brigadir/a', 'brigadir/a-2']))).toBe('brigadir/a-3');
	const launch = {
		isolation: 'worktree' as const,
		branch: '',
		baseRef: 'main',
		setupCommand: '',
		scopes: [],
	};
	expect(withAutoBranch(launch, 'Create custom route for VibePreview', '', 'abc')).toMatchObject({
		branch: 'brigadir/custom-route-vibepreview',
		branchAuto: true,
	});
	expect(withAutoBranch({ ...launch, branch: 'mine' }, 'Title', '', 'abc')).toEqual({
		...launch,
		branch: 'mine',
	});
});
