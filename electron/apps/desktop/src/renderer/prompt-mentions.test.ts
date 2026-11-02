import { describe, expect, it } from 'vitest';
import {
	agentMentions,
	looksLikeFile,
	matchOptions,
	mentionLabel,
	mentionToken,
	mentionTrigger,
	type MentionOption,
} from './prompt-mentions';

describe('spec/tasks#sheet-layout: згадки в промпті', () => {
	it('відкриває меню лише на @ на початку слова', () => {
		expect(mentionTrigger.exec('Подивись @Scope')?.[2]).toBe('Scope');
		expect(mentionTrigger.exec('@')?.[2]).toBe('');
		expect(mentionTrigger.exec('mail@example')).toBeNull();
		expect(mentionTrigger.exec('@Scope далі')).toBeNull();
	});
	it('не забирає в згадку розділовий знак речення', () => {
		const found = [...'Глянь @kit/src/Button.tsx, потім @Codex.'.matchAll(mentionToken)].map(
			(match) => match[1]
		);
		expect(found).toEqual(['kit/src/Button.tsx', 'Codex']);
	});
	it("показує вузол бригади українською, а в тексті лишає англійське ім'я", () => {
		const crew: MentionOption[] = [
			{ kind: 'crew', token: 'Reviewer', label: 'Ревʼюер', icon: 'person' },
		];
		const known = new Map([...crew, ...agentMentions].map((option) => [option.token, option]));
		expect(mentionLabel('Reviewer', known)).toEqual({
			kind: 'crew',
			label: 'Ревʼюер',
			icon: 'person',
		});
		expect(mentionLabel('apps/desktop/ScopePanel.tsx', known)).toEqual({
			kind: 'file',
			label: 'ScopePanel.tsx',
		});
		expect(mentionLabel('someone', known)).toBeNull();
	});
	it('розпізнає файл за шляхом або розширенням', () => {
		expect(looksLikeFile('README.md')).toBe(true);
		expect(looksLikeFile('src/index')).toBe(true);
		expect(looksLikeFile('Reviewer')).toBe(false);
	});
	it('spec/composer#mention-menu: розпізнає теку за кінцевим /', () => {
		expect(mentionLabel('src/ui/VibePreview/', new Map())).toEqual({
			kind: 'file',
			label: 'VibePreview',
			icon: 'folder',
		});
		expect([...'Глянь @src/ui/ і все'.matchAll(mentionToken)].map((match) => match[1])).toEqual([
			'src/ui/',
		]);
	});
	it('шукає за токеном і за назвою', () => {
		expect(matchOptions(agentMentions, 'cod').map((option) => option.token)).toEqual(['Codex']);
		expect(matchOptions(agentMentions, '').length).toBe(2);
	});
});
