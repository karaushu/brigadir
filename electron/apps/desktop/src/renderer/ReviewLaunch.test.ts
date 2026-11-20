import { expect, it } from 'vitest';
import { autoEntryText } from './ReviewLaunch';

it('the Who popup on Auto names the resolved reviewer as its detail (spec/reviews#start)', () => {
	expect(autoEntryText('en', { text: 'Codex · gpt-5.5', failure: false })).toBe(
		'Auto · Codex · gpt-5.5'
	);
	// Not resolved yet, or no reviewer available: the entry alone; the reason stands in the list.
	expect(autoEntryText('en', null)).toBe('Auto');
	expect(autoEntryText('en', { text: 'No reviewer is available.', failure: true })).toBe('Auto');
});
