import { isMessageKey, t, type AgentTemplate, type Locale } from '@brigadir/core';

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
