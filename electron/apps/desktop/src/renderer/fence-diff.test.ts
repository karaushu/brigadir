import { expect, it } from 'vitest';
import { fenceDiff, isDiffFence } from './fence-diff';

it('a diff or patch fence is drawn as a diff; other labels are code (spec/appearance#evolution-redesign)', () => {
	expect(isDiffFence('diff')).toBe(true);
	expect(isDiffFence('Patch title')).toBe(true);
	expect(isDiffFence('ts')).toBe(false);
	expect(isDiffFence('')).toBe(false);
});

it('signs leave the text, a tab is four spaces and the shared indent goes; similar lines get word spans', () => {
	const diff = fenceDiff(
		[
			'@@ -1,3 +1,3 @@',
			'   if (isIos()) {',
			'-  \tif (!data.silentPush) {',
			'+  \tif (!pushData.silentPush) {',
			'   }',
		].join('\n')
	);
	expect(diff.rows.map((row) => row.kind)).toEqual(['context', 'removed', 'added', 'context']);
	expect(diff.rows.map((row) => ('text' in row ? row.text : ''))).toEqual([
		'if (isIos()) {',
		'    if (!data.silentPush) {',
		'    if (!pushData.silentPush) {',
		'}',
	]);
	expect(diff.additions).toBe(1);
	expect(diff.deletions).toBe(1);
	const removed = diff.rows[1]!,
		added = diff.rows[2]!;
	expect('spans' in removed && removed.spans?.length).toBeGreaterThan(1);
	expect('spans' in added && added.spans?.some((span) => span & 1)).toBe(true);
	// No path: one part without a grammar; lines know their place in the old and new text.
	expect(diff.parts).toEqual([
		{
			language: null,
			old: ['if (isIos()) {', '    if (!data.silentPush) {', '}'],
			new: ['if (isIos()) {', '    if (!pushData.silentPush) {', '}'],
		},
	]);
	expect(diff.rows.map((row) => ('line' in row ? row.line : 0))).toEqual([1, 2, 2, 3]);
});

it('«--- path» is a file row with its counts and grammar; a later hunk or «...» is a break; git headers go', () => {
	const diff = fenceDiff(
		[
			'diff --git a/src/Push.ts b/src/Push.ts',
			'index 1234abc..5678def 100644',
			'--- a/src/Push.ts',
			'+++ b/src/Push.ts',
			'@@ -1,2 +1,2 @@',
			' a',
			'+b',
			'@@ -9,2 +9,2 @@',
			'-c',
			'--- a/README.md',
			'+++ /dev/null',
			'-gone',
			'...',
			'\\ No newline at end of file',
		].join('\n')
	);
	expect(diff.rows.map((row) => row.kind)).toEqual([
		'file',
		'context',
		'added',
		'gap',
		'removed',
		'file',
		'removed',
		'gap',
	]);
	expect(diff.rows[0]).toMatchObject({ path: 'src/Push.ts', additions: 1, deletions: 1, part: 0 });
	expect(diff.rows[5]).toMatchObject({ path: 'README.md', additions: 0, deletions: 1, part: 1 });
	// Markdown has no grammar of the file views: its lines stay plain.
	expect(diff.parts.map((part) => part.language)).toEqual(['ts', null]);
	expect([diff.additions, diff.deletions]).toEqual([1, 2]);
});

it('lines that share hardly a word are not paired for a word diff', () => {
	const diff = fenceDiff(['-const a = 1;', '+import { b } from "c";'].join('\n'));
	expect(diff.rows.every((row) => !('spans' in row) || row.spans === undefined)).toBe(true);
});

it('a removed line pairs with the similar added line even when a new line stands between them', () => {
	const diff = fenceDiff(
		['-if (!data.silentPush) {', '+// the keys moved', '+if (!pushData.silentPush) {'].join('\n')
	);
	expect(diff.rows[1]).not.toHaveProperty('spans');
	expect('spans' in diff.rows[2]! && diff.rows[2].spans?.length).toBeGreaterThan(1);
	expect('spans' in diff.rows[0]! && diff.rows[0].spans?.length).toBeGreaterThan(1);
});
