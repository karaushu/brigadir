import { expect, it } from 'vitest';
import { forgeToastText } from './Forge';

it('the GitHub toast is raised only by GitHub itself (spec/notifications-slack-notes-and-schedules#toasts)', () => {
	expect(forgeToastText({ auth: 'ready', error: null })).toBeNull();
	expect(forgeToastText({ auth: 'error', error: 'GitHub status could not be read.' })).toBe(
		'GitHub status could not be read.'
	);
	expect(forgeToastText({ auth: 'missing', error: null })).toBe(
		'Install GitHub CLI (gh) to create pull requests.'
	);
	expect(forgeToastText({ auth: 'login', error: null })).toBe(
		'Sign in with gh auth login to use GitHub.'
	);
	// No snapshot (the read threw: a local git failure) is a read issue, not this toast.
	expect(forgeToastText(null)).toBeNull();
});
