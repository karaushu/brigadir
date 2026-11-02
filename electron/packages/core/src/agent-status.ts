import type { AgentCheck } from './environment';
import { t, type Locale } from './messages';
/** The agent's line in Settings ▸ Agents and the intro (spec/settings-modules-and-onboarding#intro); also its `data-agent-status`. */
export type AgentStatusState = 'failed' | 'checking' | 'missing' | 'login' | 'ready';
/**
 * spec/appearance#component-details: one status line of an agent for every place that shows it.
 * `failed` — the check itself failed (no result yet); `checking` — a check is running; `waiting` — the in-app sign-in
 * waits for the browser; `signedInWith` — the intro names the account behind «Ready».
 */
export function agentStatus(
	locale: Locale,
	agent: AgentCheck | undefined,
	options: { failed?: boolean; checking?: boolean; waiting?: boolean; signedInWith?: boolean } = {}
): { state: AgentStatusState; text: string } {
	if (!agent)
		return options.failed && !options.checking
			? { state: 'failed', text: t(locale, 'Not checked') }
			: { state: 'checking', text: t(locale, 'Looking…') };
	if (!agent.found) return { state: 'missing', text: t(locale, 'Not found on this Mac') };
	if (agent.signIn === 'signed-out' || agent.signIn === 'expired')
		return {
			state: 'login',
			text: t(
				locale,
				options.waiting
					? 'Waiting for the sign-in in the browser…'
					: agent.signIn === 'expired'
						? 'Sign-in expired'
						: 'Found. You need to sign in.'
			),
		};
	if (agent.via === 'npx' && !agent.version)
		return { state: 'ready', text: t(locale, 'Downloads on the first launch') };
	if (options.signedInWith && agent.signIn === 'signed-in')
		return {
			state: 'ready',
			text: t(
				locale,
				agent.provider === 'claude'
					? 'Ready · signed in with Claude Code'
					: 'Ready · signed in with ChatGPT'
			),
		};
	return { state: 'ready', text: [t(locale, 'Ready'), agent.version].filter(Boolean).join(' · ') };
}
