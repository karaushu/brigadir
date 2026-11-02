import { expect, it } from 'vitest';
import type { Anchor } from '@brigadir/core';
import { anchorContext, reanchor } from './anchors';
const original = 'intro\nabove\nselected one\nselected two\nbelow\nend\n';
const anchor: Anchor = {
	scopeId: 'fixture',
	path: 'a.ts',
	side: 'new',
	blob: 'old',
	start: 3,
	end: 4,
	...anchorContext(original, 3, 4),
	contextHash: 'hash',
	symbolPath: null,
};
it('retains exact blobs and visibly relocates one matching context', () => {
	expect(reanchor(anchor, 'old', original)).toEqual({ state: 'exact', start: 3, end: 4 });
	expect(
		reanchor(anchor, 'new', 'inserted\n' + original.replace('selected one', '   selected   one'))
	).toEqual({ state: 'relocated', start: 4, end: 5 });
});
it('never guesses among duplicates or missing context and validates ranges', () => {
	expect(reanchor(anchor, 'new', original + original).state).toBe('outdated');
	expect(reanchor(anchor, 'new', original.replace('selected one', 'changed')).state).toBe(
		'outdated'
	);
	expect(reanchor(anchor, null, '').state).toBe('outdated');
	expect(() => anchorContext(original, 0, 2)).toThrow();
	expect(() => anchorContext(original, 3, 10)).toThrow();
});
