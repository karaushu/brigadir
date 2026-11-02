import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PRCheckRun } from '@brigadir/core';
import { CheckRow, CIGlyph, checkCIState } from './RunSteps';

const check = (state: PRCheckRun['state']): PRCheckRun => ({
	name: 'codeql',
	workflow: 'CI',
	state,
	link: 'https://github.com/o/r/actions/runs/1',
	seconds: null,
});

it('maps a PR check onto the CI scale (spec/pull-requests-and-ci#ci, rule 17)', () => {
	expect(checkCIState('pass')).toBe('pass');
	expect(checkCIState('fail')).toBe('fail');
	expect(checkCIState('pending')).toBe('running');
	expect(checkCIState('skipping')).toBe('skipped');
	expect(checkCIState('cancel')).toBe('cancelled');
});

it('draws a skipped or cancelled PR check with the glyph of a skipped or cancelled CI job', () => {
	for (const [state, ci] of [
		['skipping', 'skipped'],
		['cancel', 'cancelled'],
	] as const) {
		const row = renderToStaticMarkup(<CheckRow check={check(state)} locale="en" />),
			glyph = renderToStaticMarkup(<CIGlyph state={ci} />);
		expect(row).toContain(glyph);
		expect(row).toContain('data-glyph="check-skipped"');
		expect(row).not.toContain('Log on GitHub');
	}
	const failed = renderToStaticMarkup(
		<CheckRow check={check('fail')} locale="en" onLog={() => {}} />
	);
	expect(failed).toContain('data-glyph="check-fail"');
	expect(failed).toContain('Log on GitHub');
	expect(failed).toContain('title="CI · codeql"');
});
