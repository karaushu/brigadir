import { expect, it } from 'vitest';
import { findingRule } from './review-findings';

// spec/reviews#findings: a task's own reviewer runs checks in its synced tree; a crew reviewer's tree is not the worker's change.
it('tells only a reviewer whose tree is the change to run commands there', () => {
	expect(findingRule(true)).toContain('run commands that change no files');
	expect(findingRule(false)).not.toContain('run commands that change no files');
	expect(findingRule(false)).toContain('the files of your own tree are not this change');
	for (const own of [true, false]) expect(findingRule(own)).toContain('is not a finding');
});
