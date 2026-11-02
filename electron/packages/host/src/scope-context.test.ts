import { it, expect } from 'vitest';
import type { Scope } from '@brigadir/core';
import { scopeContext, scopeDirectories } from './scope-context';
it('separates writable additional roots from the complete metadata manifest', () => {
	const root: Scope = {
		id: 'a',
		name: '.',
		path: '/repo',
		kind: 'root',
		branch: 'main',
		remote: 'git@example.invalid:team/repo.git',
		selected: true,
	};
	const child = { ...root, id: 'b', name: 'child', path: '/repo/child', kind: 'nested' as const };
	const readOnly = { ...child, id: 'c', name: 'context', path: '/repo/context', selected: false };
	const missing = { ...child, id: 'd', name: 'missing', path: '/repo/missing', available: false };
	const scopes = [root, child, readOnly, missing];
	expect(scopeDirectories(scopes)).toEqual(['/repo/child']);
	const context = scopeContext(scopes);
	expect(context).toContain('"remote": "git@example.invalid:team/repo.git"');
	expect(context).toContain('"name": "context"');
	expect(context).toContain('"writable": false');
	expect(context).not.toContain('/repo/missing');
});
