import { expect, it } from 'vitest';
import type { DiffLine } from '@brigadir/core';
import { markdown } from './markdown';
import {
	markdownDiffTokens,
	markdownUnits,
	markdownViewTokens,
	unitForLine,
} from './markdown-view';

const before = [
	'# State',
	'',
	'Each slice owns its loaders.',
	'',
	'- orders',
	'- tables',
	'',
	'## Polling',
	'',
	'Orders poll every 5 seconds.',
	'',
	'| Rule | Why |',
	'|---|---|',
	'| Pure | Renders |',
	'',
].join('\n');
const after = [
	'# State',
	'',
	'Each slice owns its loaders and its live patch.',
	'',
	'- orders',
	'- tables',
	'- staff',
	'',
	'## Live updates',
	'',
	'Orders update over a WebSocket.',
	'',
	'| Rule | Why |',
	'|---|---|',
	'| Pure | Renders |',
	'| Versioned | Stale events drop |',
	'',
].join('\n');
/** A unified diff of `before` → `after`, line by line, as the diff engine reports it. */
function diffLines(a: string, b: string): DiffLine[] {
	const x = a.split('\n'),
		y = b.split('\n'),
		n = x.length,
		m = y.length,
		l: number[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));
	for (let i = n - 1; i >= 0; i--)
		for (let j = m - 1; j >= 0; j--)
			l[i]![j] = x[i] === y[j] ? l[i + 1]![j + 1]! + 1 : Math.max(l[i + 1]![j]!, l[i]![j + 1]!);
	const out: DiffLine[] = [];
	let i = 0,
		j = 0;
	while (i < n || j < m) {
		if (i < n && j < m && x[i] === y[j]) {
			out.push({ kind: 'context', text: x[i]!, oldLine: i + 1, newLine: j + 1 });
			i++;
			j++;
		} else if (j < m && (i >= n || l[i]![j + 1]! >= l[i + 1]![j]!)) {
			out.push({ kind: 'added', text: y[j]!, oldLine: null, newLine: j + 1 });
			j++;
		} else {
			out.push({ kind: 'removed', text: x[i]!, oldLine: i + 1, newLine: null });
			i++;
		}
	}
	// the engine reports removed lines of a run before its added lines
	for (let k = 0; k < out.length; k++) {
		let e = k;
		while (e < out.length && out[e]!.kind !== 'context') e++;
		const run = out.slice(k, e);
		out.splice(
			k,
			run.length,
			...run.filter((r) => r.kind === 'removed'),
			...run.filter((r) => r.kind === 'added')
		);
		k = e;
	}
	return out;
}

it('splits a document into blocks, list items and table rows with their source lines', () => {
	const units = markdownUnits(markdownViewTokens(after));
	expect(units.map((unit) => `${unit.kind}:${unit.start}-${unit.end}`)).toEqual([
		'block:1-1',
		'block:3-3',
		'item:5-5',
		'item:6-6',
		'item:7-8',
		'block:9-9',
		'block:11-11',
		'row:13-13',
		'row:15-15',
		'row:16-16',
	]);
	expect(unitForLine(units, 10)?.start).toBe(11);
	expect(unitForLine(units, 99)?.start).toBe(16);
});

it('tags every block with its source lines for the place mapping', () => {
	const html = markdown.renderer.render(
		markdownViewTokens('# A\n\ntext\n\n```ts\nx\n```\n'),
		markdown.options,
		{}
	);
	expect(html).toContain('<h1 data-line="1-1">');
	expect(html).toContain('<p data-line="3-3">');
	expect(html).toContain('<code data-line="5-7" class="language-ts">');
});

it('marks a changed block old above new, an added item and an added row', () => {
	const { tokens, newFile } = markdownDiffTokens(before, after, diffLines(before, after));
	expect(newFile).toBe(false);
	const html = markdown.renderer.render(tokens, markdown.options, {});
	const at = (text: string) => html.indexOf(text);
	expect(at('<div data-change="removed"><p>Each slice owns its loaders.</p>')).toBeGreaterThan(-1);
	expect(at('Each slice owns its loaders.</p>')).toBeLessThan(at('its live patch'));
	expect(
		at(
			'<div data-change="added"><p data-line="3-3">Each slice owns its loaders and its live patch.'
		)
	).toBeGreaterThan(-1);
	expect(html).toContain('<li data-line="7-8" data-change="added">staff');
	expect(html).not.toContain('<li data-line="5-5" data-change');
	expect(at('Polling</h2>')).toBeLessThan(at('Live updates</h2>'));
	expect(at('poll every 5 seconds')).toBeLessThan(at('over a WebSocket'));
	expect(html).toContain('<tr data-line="16-16" data-change="added">');
	expect(html).not.toContain('<tr data-line="15-15" data-change');
});

it('shows a new file as one added document', () => {
	const { tokens, newFile } = markdownDiffTokens(
		'',
		after,
		diffLines('', after).filter((line) => line.kind !== 'removed')
	);
	expect(newFile).toBe(true);
	expect(markdown.renderer.render(tokens, markdown.options, {})).not.toContain('data-change');
});

it('keeps a removed list item inside a list and a removed section where it stood', () => {
	const a = '# T\n\n- one\n- two\n- three\n\n## Gone\n\nOld text.\n\n## Kept\n',
		b = '# T\n\n- one\n- three\n\n## Kept\n';
	const html = markdown.renderer.render(
		markdownDiffTokens(a, b, diffLines(a, b)).tokens,
		markdown.options,
		{}
	);
	expect(html).toMatch(/<li data-change="removed">two<\/li>\n<li data-line="4-5">three/);
	expect(html.indexOf('Gone')).toBeLessThan(html.indexOf('Kept'));
	expect(html.indexOf('Old text')).toBeLessThan(html.indexOf('Kept'));
});

it('puts the old block above the new one when the change is on a later line of the block', () => {
	const a = '# T\n\nThe store has slices.\nEach slice owns its loaders.\n\n## Next\n',
		b = '# T\n\nThe store has slices.\nEach slice owns its loaders and its patch.\n\n## Next\n';
	const html = markdown.renderer.render(
		markdownDiffTokens(a, b, diffLines(a, b)).tokens,
		markdown.options,
		{}
	);
	expect(html.indexOf('its loaders.</p>')).toBeGreaterThan(-1);
	expect(html.indexOf('its loaders.</p>')).toBeLessThan(html.indexOf('its patch.'));
	expect(html.indexOf('its patch.')).toBeLessThan(html.indexOf('Next'));
});
