import { t, type AgentLoginState, type Locale } from '@brigadir/core';
import { notify } from './ui/Toast';

type Provider = 'claude' | 'codex';
/**
 * spec/remote-access-and-mobile#browser-from-device: in a window of another machine its CLI opens no browser there; the page of the sign-in opens on this
 * device as soon as the machine knows it, and «Open the page again» opens it here too. spec/remote-access-and-mobile#networking: it opens through
 * `openAgentSignIn`, which also listens on this device's loopback for the page's way back to the machine.
 */
const opening = new Set<Provider>();
/** Read when called: the card's module loads in tests without a window. */
const remote = () => !!window.brigadir.remoteMachine;
let following: (() => void) | null = null;
export function signInAgent(provider: Provider): Promise<AgentLoginState> {
	if (remote()) {
		opening.add(provider);
		following ??= window.brigadir.onAgentLogin((state) => {
			if (!opening.has(state.provider as Provider) || state.phase !== 'waiting') {
				if (state.phase !== 'waiting') opening.delete(state.provider as Provider);
				return;
			}
			if (!state.url) return;
			opening.delete(state.provider as Provider);
			void window.brigadir.openAgentSignIn(state.provider as Provider, state.url).catch(() => {});
		});
	}
	return window.brigadir.signInAgent(provider).then((state) => {
		if (remote() && state.phase === 'waiting' && state.url && opening.delete(provider))
			void window.brigadir.openAgentSignIn(provider, state.url).catch(() => {});
		return state;
	});
}
/**
 * spec/appearance#component-details: «Sign in…» in the chat's card, Settings ▸ Agents and the intro — a sign-in that could not start is
 * the same toast with Retry everywhere (spec/notifications-slack-notes-and-schedules#message-classes).
 */
export function startAgentSignIn(provider: Provider, locale: Locale): void {
	const run = () => {
		void signInAgent(provider).catch(() =>
			notify('error', t(locale, 'The sign-in could not start.'), {
				action: { label: t(locale, 'Retry'), run },
			})
		);
	};
	run();
}
export function reopenAgentLogin(provider: Provider, url: string | null): Promise<unknown> {
	return remote()
		? url
			? window.brigadir.openAgentSignIn(provider, url)
			: Promise.resolve()
		: window.brigadir.reopenAgentLogin(provider);
}
