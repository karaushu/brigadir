import {
	isMessageKey,
	t,
	type AgentProvider,
	type AgentTemplate,
	type Locale,
} from '@brigadir/core';

/**
 * spec/crew-templates-and-editor#agent-cards: a role's When to use, for its card and its row in the `@` menu — a built-in's line in the
 * interface language, an own role's as written, else what its rights allow.
 */
export function templateWork(
	locale: Locale,
	template: Pick<AgentTemplate, 'builtin' | 'whenToUse' | 'role'>
): string {
	const line = template.whenToUse?.trim();
	if (line) return template.builtin && isMessageKey(line) ? t(locale, line) : line;
	return t(
		locale,
		template.role === 'foreman'
			? 'Splits the work, accepts the parts'
			: template.role === 'reviewer'
				? 'Checks the work, writes no code'
				: 'Writes code'
	);
}
/** spec/crew-templates-and-editor#provider-off: the line of a role whose provider Settings ▸ Agents turned off; Auto does not hire it. */
export function roleProviderOff(
	locale: Locale,
	template: Pick<AgentTemplate, 'provider'>,
	enabled: Record<AgentProvider, boolean>,
	defaultProvider: AgentProvider
): string | null {
	const provider = template.provider ?? defaultProvider;
	return enabled[provider]
		? null
		: t(locale, '{provider} is off').replace(
				'{provider}',
				provider === 'codex' ? 'Codex' : 'Claude'
			);
}
