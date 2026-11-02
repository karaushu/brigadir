import { expect, it } from 'vitest';
import { summarySpotKey } from '@brigadir/core';
import { dismissSummarySpot, summaryState, toggleSummaryCheck } from './pr-summary';

it('keeps dismissed markers per PR and head, beside the ticks, never for another PR (spec/appearance#evolution-redesign)', () => {
	const task = { projectId: 'p', id: 't' },
		ref = { scopeId: 's', number: 503 },
		other = { scopeId: 's', number: 504 },
		key = summarySpotKey('h1', 'risk', 0);
	dismissSummarySpot(task as never, ref, key);
	dismissSummarySpot(task as never, ref, key);
	toggleSummaryCheck(task as never, ref, 'h1:0');
	expect(summaryState(task, ref).dismissed).toEqual({ 'h1:risk:0': true });
	expect(summaryState(task, ref).checked).toEqual({ 'h1:0': true });
	expect(summaryState(task, other).dismissed).toEqual({});
});
