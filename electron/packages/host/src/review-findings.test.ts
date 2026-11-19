import { expect, it } from 'vitest';
import { findingRule, requestRule } from './review-findings';

// spec/reviews#findings: a task's own reviewer runs checks in its synced tree; a crew reviewer's tree is not the worker's change.
it('tells only a reviewer whose tree is the change to run commands there', () => {
	expect(findingRule(true)).toContain('run commands that change no files');
	expect(findingRule(false)).not.toContain('run commands that change no files');
	expect(findingRule(false)).toContain('the files of your own tree are not this change');
	for (const own of [true, false]) expect(findingRule(own)).toContain('is not a finding');
});

// spec/reviews#requests: every code review traces the requests the change adds, whoever the reviewer is.
it('asks every code reviewer to trace the network requests of the change', () => {
	for (const own of [true, false]) {
		const rule = findingRule(own);
		expect(rule).toContain(requestRule);
		expect(rule).toContain('more than three requests at once');
		expect(rule).toContain('name every call site (path:line)');
		expect(rule).toContain('skip this when it touches none');
	}
});
