import { expect, it } from 'vitest';
import { reviewFiles } from './review-files';
import type { ReviewSnapshot, ReviewComment } from './review';
import type { ChangesSnapshot, Scope, ChangedFile } from './changes';
const scope = (id: string): Scope => ({
	id,
	path: `/repo/${id}`,
	name: id,
	kind: 'nested',
	branch: 'main',
	selected: true,
});
const comment = (
	id: string,
	scopeId: string,
	path: string,
	sent = false
): ReviewSnapshot['comments'][number] => ({
	id,
	version: 1,
	text: id,
	at: '2026-09-10T00:00:00Z',
	sent,
	anchor: { scopeId, path, start: 1, end: 1 } as ReviewComment['anchor'],
});
it('shares counts and scope order, keeps unknown roots and groups renamed comments without crossing same-named files', () => {
	const changed = {
		id: 'diff',
		scopeId: 'a',
		oldPath: 'old.ts',
		path: 'Button.tsx',
		additions: 3,
		deletions: 1,
	} as ChangedFile;
	const changes: ChangesSnapshot = {
		scopes: [scope('b'), scope('a')],
		files: [changed],
		checkpoint: 2,
		issue: null,
	};
	const review: ReviewSnapshot = {
		comments: [
			comment('one', 'a', 'old.ts'),
			comment('two', 'b', 'Button.tsx', true),
			comment('three', 'a', 'Button.tsx'),
			comment('four', 'missing', 'Button.tsx'),
		],
		notes: [{ id: 'note', version: 1, text: 'General', at: '2026-09-10T00:00:00Z', sent: false }],
	};
	const result = reviewFiles(review, changes);
	expect(result).toMatchObject({ fileCount: 3, count: 5, pending: 4 });
	expect(result.groups.map((group) => group.id)).toEqual(['b', 'a', 'missing']);
	expect(result.groups[1]?.files[0]).toMatchObject({ path: 'Button.tsx', change: changed });
	expect(result.groups[1]?.files[0]?.comments.map((comment) => comment.id)).toEqual([
		'one',
		'three',
	]);
	expect(result.groups[0]?.files[0]?.change).toBeNull();
	expect(result.groups[2]?.scope).toBeNull();
	expect(review.comments[0]?.anchor.path).toBe('old.ts');
});
it('retains editor-only notes without a changes snapshot and handles an empty batch', () => {
	expect(reviewFiles({ comments: [] }, null)).toEqual({
		groups: [],
		fileCount: 0,
		count: 0,
		pending: 0,
	});
	expect(reviewFiles({ comments: [comment('one', 'a', 'stable.ts', true)] }, null)).toMatchObject({
		fileCount: 1,
		count: 1,
		pending: 0,
		groups: [{ scope: null, files: [{ path: 'stable.ts', change: null }] }],
	});
});
