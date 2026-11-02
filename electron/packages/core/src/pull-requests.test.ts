import { describe, expect, it } from 'vitest';
import {
	commitsSince,
	fitPatch,
	keepsBranch,
	locateSummaryItem,
	mergeControlState,
	parsePRSummary,
	summaryChecks,
	summaryMarks,
	summarySpotKey,
	summarySpots,
	parsePRVerdictHint,
} from './pull-requests';
const file = (name: string, lines: number) =>
	`diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1 +1,${lines} @@\n${Array.from({ length: lines }, (_, index) => `+line ${index}`).join('\n')}\n`;
it('fits a large patch by file instead of dropping it (spec/agents-and-providers#adapter-launch)', () => {
	const small = file('a.ts', 3),
		patch = small + file('b.ts', 2000) + file('c.ts', 2000);
	expect(fitPatch(patch, 1e6)).toBe(patch);
	const fitted = fitPatch(patch, 4000);
	expect(fitted.length).toBeLessThan(4200);
	expect(fitted.startsWith(small)).toBe(true);
	for (const name of ['b.ts', 'c.ts']) expect(fitted).toContain(`diff --git a/${name} b/${name}\n`);
	expect(fitted).toMatch(/\+line \d+\n… \d+ more lines of this file trimmed\n/);
});

it('names the files left out when the budget is too small even for their headers', () => {
	const patch = Array.from({ length: 50 }, (_, index) => file(`f${index}.ts`, 20)).join(''),
		fitted = fitPatch(patch, 3000);
	expect(fitted.length).toBeLessThan(4500);
	expect(fitted).toMatch(/Omitted from this patch to fit the budget \(\d+ files/);
	const names = /: (.*)\n$/.exec(fitted)![1]!.split(', ');
	for (const name of names) expect(fitted).not.toContain(`diff --git a/${name} b/`);
});

describe('keepsBranch', () => {
	it('keeps main, master, stage and staging whatever the case, and lets feature branches go', () => {
		for (const name of ['main', 'master', 'stage', 'staging', 'Main', ' staging '])
			expect(keepsBranch(name)).toBe(true);
		for (const name of ['feat/stage', 'main-fix', 'staging2', 'fix/master'])
			expect(keepsBranch(name)).toBe(false);
	});
});

describe('the review summary (spec/appearance#evolution-redesign)', () => {
	it('reads the headline, what to check and the minutes; an older answer still parses', () => {
		const files = ['src/a.ts', 'src/b.ts'];
		const value = parsePRSummary(
			JSON.stringify({
				headline: 'Locks the toggle\nsecond line',
				done: [{ path: 'a.ts', start: 2, end: 4, text: 'adds the check' }],
				watch: [],
				check: ['A web build', ' ', 7],
				minutes: 9.6,
			}),
			files
		);
		expect(value).toEqual({
			headline: 'Locks the toggle second line',
			done: [{ path: 'src/a.ts', start: 2, end: 4, text: 'adds the check' }],
			watch: [],
			check: ['A web build'],
			minutes: 10,
		});
		expect(parsePRSummary(JSON.stringify({ done: [], watch: [] }), files)).toMatchObject({
			headline: '',
			check: [],
			minutes: null,
		});
	});
	it('reads «what to check» on a line as well as a plain sentence (spec/appearance#evolution-redesign)', () => {
		const value = parsePRSummary(
			JSON.stringify({
				done: [],
				watch: [],
				check: [{ path: 'b.ts', start: 7, text: 'the web build' }, 'a case', { text: ' ' }],
			}),
			['src/a.ts', 'src/b.ts']
		);
		expect(value.check).toEqual([
			{ path: 'src/b.ts', start: 7, end: 7, text: 'the web build' },
			'a case',
		]);
	});
	it('places an item without a path by the first file:line of its text that names one file of the PR (spec/appearance#evolution-redesign)', () => {
		const files = ['src/index.tsx', 'src/enums/Partners.ts', 'a/en.json', 'b/en.json'];
		expect(locateSummaryItem('Check index.tsx:110 on web.', files)).toEqual({
			path: 'src/index.tsx',
			start: 110,
			end: 110,
			text: 'Check index.tsx:110 on web.',
		});
		expect(locateSummaryItem('enums/Partners.ts:12–14 lowercases', files)).toMatchObject({
			path: 'src/enums/Partners.ts',
			start: 12,
			end: 14,
		});
		// Two files share the name: no guess; the next reference still counts.
		expect(locateSummaryItem('en.json:3 and Partners.ts:4-2', files)).toMatchObject({
			path: 'src/enums/Partners.ts',
			start: 4,
			end: 4,
		});
		expect(locateSummaryItem('A partner named in another case.', files).path).toBeNull();
		expect(locateSummaryItem('other.ts:5 is not in the PR', files).path).toBeNull();
		const item = { path: 'src/index.tsx', start: 3, end: 3, text: 'a.ts:9' };
		expect(locateSummaryItem(item, files)).toBe(item);
	});
	it('gives each file its risks ⚠ and things to check ✓ in the order of the summary (spec/appearance#evolution-redesign)', () => {
		const files = ['src/index.tsx', 'src/uk.json', 'src/x.ts'];
		const summary = {
			watch: [
				{ path: 'src/index.tsx', start: 110, end: 110, text: 'bare alert' },
				{ path: null, start: null, end: null, text: 'uk.json:4 is long' },
				{ path: null, start: null, end: null, text: 'no place' },
				{ path: 'src/gone.ts', start: 1, end: 1, text: 'not a file of the PR' },
			],
			check: [
				'A web build of index.tsx:12.',
				{ path: 'src/index.tsx', start: 9, end: 9, text: 'the toggle' },
				'by hand',
			],
		};
		const marks = summaryMarks(summary, files);
		expect([...marks.keys()]).toEqual(['src/index.tsx', 'src/uk.json']);
		expect(marks.get('src/index.tsx')!.risks.map((item) => item.text)).toEqual(['bare alert']);
		expect(marks.get('src/index.tsx')!.checks.map((item) => item.start)).toEqual([12, 9]);
		expect(marks.get('src/uk.json')).toEqual({
			risks: [{ path: 'src/uk.json', start: 4, end: 4, text: 'uk.json:4 is long' }],
			checks: [],
		});
		expect(summaryChecks(summary, files).map((item) => item.path)).toEqual([
			'src/index.tsx',
			'src/index.tsx',
			null,
		]);
		expect(summaryMarks({ watch: [] }, files).size).toBe(0);
	});
	it('gives a file the markers of its risks and checks with a line, without dismissed ones (spec/appearance#evolution-redesign)', () => {
		const files = ['src/index.tsx', 'src/uk.json'];
		const summary = {
			headSha: 'h1',
			watch: [
				{ path: 'src/index.tsx', start: 110, end: 112, text: 'bare alert' },
				{ path: 'src/index.tsx', start: null, end: null, text: 'no line' },
				{ path: null, start: null, end: null, text: 'index.tsx:45 lowercases' },
				{ path: 'src/uk.json', start: 4, end: 4, text: 'long text' },
			],
			check: [
				'A web build: index.tsx:9.',
				'by hand',
				{ path: 'src/index.tsx', start: 7, end: 3, text: 'odd end' },
			],
		};
		const spots = summarySpots(summary, files, 'src/index.tsx');
		expect(spots.map(({ key, kind, start, end }) => [key, kind, start, end])).toEqual([
			['h1:risk:0', 'risk', 110, 112],
			['h1:risk:2', 'risk', 45, 45],
			['h1:check:0', 'check', 9, 9],
			['h1:check:2', 'check', 7, 7],
		]);
		expect(spots[0]).toMatchObject({ path: 'src/index.tsx', text: 'bare alert' });
		const dismissed = {
			[summarySpotKey('h1', 'risk', 0)]: true as const,
			'h0:check:0': true as const,
		};
		expect(
			summarySpots(summary, files, 'src/index.tsx', dismissed).map((spot) => spot.key)
		).toEqual(['h1:risk:2', 'h1:check:0', 'h1:check:2']);
		expect(summarySpots(summary, files, 'src/other.ts')).toEqual([]);
	});
	it('counts the commits after the head of the summary; a head no longer in the PR is unknown', () => {
		const commits = [{ sha: 'a' }, { sha: 'b' }, { sha: 'c' }];
		expect(commitsSince(commits, 'a')).toEqual(['b', 'c']);
		expect(commitsSince(commits, 'c')).toEqual([]);
		expect(commitsSince(commits, 'x')).toBeNull();
	});
	it('takes a verdict hint only as one of the decisions of GitHub, with a reason', () => {
		expect(parsePRVerdictHint('{"event":"REQUEST_CHANGES","reason":"a bug"}')).toEqual({
			event: 'REQUEST_CHANGES',
			reason: 'a bug',
		});
		expect(parsePRVerdictHint('{"event":"AGENT","reason":"x"}')).toBeNull();
		expect(parsePRVerdictHint('no json')).toBeNull();
	});
});
it('tells the review modal what its merge control stands for (spec/appearance#evolution-redesign)', () => {
	const pr = (patch: Record<string, unknown> = {}, state = 'OPEN') =>
		({
			summary: { state, reviewDecision: 'APPROVED' },
			mergeState: 'CLEAN',
			mergeable: 'MERGEABLE',
			canMerge: true,
			checks: [],
			canPush: true,
			crossRepository: false,
			...patch,
		}) as never;
	expect(mergeControlState(pr(), true)).toBe('ready');
	expect(mergeControlState(pr({}, 'MERGED'), true)).toBe('merged');
	expect(mergeControlState(pr({}, 'CLOSED'), true)).toBe('closed');
	expect(mergeControlState(pr({}, 'DRAFT'), true)).toBe('blocked');
	const conflict = { mergeState: 'DIRTY', mergeable: 'CONFLICTING' };
	expect(mergeControlState(pr(conflict), true)).toBe('conflicts');
	// Nobody here can resolve it — no way in, no push or a fork: «Merge PR…» stays off with its reason.
	expect(mergeControlState(pr(conflict), false)).toBe('blocked');
	expect(mergeControlState(pr({ ...conflict, canPush: false }), true)).toBe('blocked');
	expect(mergeControlState(pr({ ...conflict, crossRepository: true }), true)).toBe('blocked');
	expect(
		mergeControlState(
			pr({ mergeState: 'BLOCKED', summary: { state: 'OPEN', reviewDecision: 'REVIEW_REQUIRED' } }),
			true
		)
	).toBe('blocked');
});
