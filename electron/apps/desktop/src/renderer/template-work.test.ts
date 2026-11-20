import { expect, it } from 'vitest';
import { builtinAgentTemplates } from '@brigadir/core';
import { roleProviderOff, templateWork } from './template-work';

// spec/crew-templates-and-editor#agent-cards
it("shows a role's When to use: a built-in's translated, an own one's as written, else its rights", () => {
	const tester = builtinAgentTemplates.find((item) => item.id === 'tester')!;
	expect(templateWork('en', tester)).toBe('Writes tests, changes no production code');
	expect(templateWork('uk', tester)).toBe('Пише тести, робочий код не змінює');
	const own = { builtin: false, role: 'developer' as const, whenToUse: 'React screens' };
	expect(templateWork('uk', own)).toBe('React screens');
	expect(templateWork('en', { ...own, whenToUse: '  ' })).toBe('Writes code');
	expect(templateWork('en', { builtin: false, role: 'reviewer' })).toBe(
		'Checks the work, writes no code'
	);
});
// spec/crew-templates-and-editor#provider-off
it('names the provider of a role that Settings turned off, its own or the default one', () => {
	const off = { claude: true, codex: false };
	expect(roleProviderOff('en', { provider: 'codex' }, off, 'claude')).toBe('Codex is off');
	expect(roleProviderOff('uk', { provider: 'codex' }, off, 'claude')).toBe('Codex вимкнено');
	expect(roleProviderOff('en', { provider: 'claude' }, off, 'claude')).toBeNull();
	expect(roleProviderOff('en', {}, { claude: false, codex: true }, 'claude')).toBe('Claude is off');
	expect(
		roleProviderOff('en', { provider: 'codex' }, { claude: true, codex: true }, 'claude')
	).toBeNull();
});
