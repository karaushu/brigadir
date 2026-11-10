import { expect, it } from 'vitest';
import type { AgentOption } from './agent';
import { roleModelPick } from './role-models';
const models = (...entries: [string, string][]): { options: AgentOption[] } => ({
	options: [
		{
			id: 'model',
			category: 'model',
			name: 'Model',
			description: null,
			kind: 'select',
			value: entries[0]![0],
			choices: entries.map(([value, name]) => ({ value, name, description: null, group: null })),
		},
	],
});
// spec/crew-templates-and-editor#library-list
it('shows the first catalog entry that says the word of the role, under the catalog name', () => {
	const codex = models(
		['gpt-6.1-sol', '6.1 Sol'],
		['gpt-6-astra', '6 Astra'],
		['gpt-6-sol', '6 Sol']
	);
	expect(roleModelPick('senior-developer', 'codex', codex)).toBe('6.1 Sol');
	expect(roleModelPick('reviewer', 'codex', codex)).toBe('6 Astra');
	// A known catalog without the entry shows nothing; an unknown catalog shows the word.
	expect(roleModelPick('developer', 'codex', codex)).toBeNull();
	expect(roleModelPick('developer', 'codex', null)).toBe('Terra');
	// `Default (recommended)` does not say the word; a part of another word does not count.
	const claude = models(['default', 'Default (recommended)'], ['opus', 'Opus 5.5'], ['x', 'Solar']);
	expect(roleModelPick('reviewer', 'claude', claude)).toBe('Opus 5.5');
	expect(roleModelPick('senior-developer', 'codex', claude)).toBeNull();
	expect(roleModelPick('own-template', 'claude', claude)).toBeNull();
});
