import { describe, expect, it } from 'vitest';
import { composerTrigger, replaceTrigger } from './composer-mentions';

describe('spec/composer#mention-menu: @ і / у композері задачі', () => {
	it('відкриває @ після пробілу посеред тексту, як у скриншоті автора', () => {
		expect(composerTrigger('do a @', 6)).toEqual({ kind: 'file', from: 5, to: 6, query: '' });
		expect(composerTrigger('do a @src/Ap', 12)).toEqual({
			kind: 'file',
			from: 5,
			to: 12,
			query: 'src/Ap',
		});
		expect(composerTrigger('@', 1)).toEqual({ kind: 'file', from: 0, to: 1, query: '' });
		expect(composerTrigger('first line\n@read', 16)).toEqual({
			kind: 'file',
			from: 11,
			to: 16,
			query: 'read',
		});
	});
	it('не відкриває @ посеред слова, після пробілу в запиті чи з виділенням поза словом', () => {
		expect(composerTrigger('mail@example', 12)).toBeNull();
		expect(composerTrigger('do a @src now', 13)).toBeNull();
	});
	it('курсор посеред слова бере все слово до кінця', () => {
		expect(composerTrigger('see @Button.tsx please', 7)).toEqual({
			kind: 'file',
			from: 4,
			to: 15,
			query: 'Bu',
		});
	});
	it('/ відкривається будь-де на початку слова (spec/composer#slash-menu), шлях лишається текстом', () => {
		expect(composerTrigger('/', 1)).toEqual({
			kind: 'command',
			from: 0,
			to: 1,
			query: '',
			start: true,
		});
		expect(composerTrigger('/figma:figma-u', 14)).toEqual({
			kind: 'command',
			from: 0,
			to: 14,
			query: 'figma:figma-u',
			start: true,
		});
		expect(composerTrigger('run /compact', 12)).toEqual({
			kind: 'command',
			from: 4,
			to: 12,
			query: 'compact',
			start: false,
		});
		expect(composerTrigger(' /compact', 9)).toEqual({
			kind: 'command',
			from: 1,
			to: 9,
			query: 'compact',
			start: false,
		});
		expect(composerTrigger('/compact now', 12)).toBeNull();
		expect(composerTrigger('/usr/bin', 8)).toBeNull();
		expect(composerTrigger('a/b', 3)).toBeNull();
	});
	it('вибрана команда замінює слово й ставить пробіл; вибраний файл прибирає слово', () => {
		expect(
			replaceTrigger('/rev', { kind: 'command', from: 0, to: 4, query: 'rev' }, '/review')
		).toEqual({ text: '/review ', caret: 8 });
		expect(
			replaceTrigger('/rev now', { kind: 'command', from: 0, to: 4, query: 'rev' }, '/review')
		).toEqual({ text: '/review now', caret: 7 });
		expect(replaceTrigger('do a @', { kind: 'file', from: 5, to: 6, query: '' }, '')).toEqual({
			text: 'do a ',
			caret: 5,
		});
		expect(
			replaceTrigger('look @But and fix', { kind: 'file', from: 5, to: 9, query: 'But' }, '')
		).toEqual({ text: 'look and fix', caret: 5 });
		expect(replaceTrigger('@But fix', { kind: 'file', from: 0, to: 4, query: 'But' }, '')).toEqual({
			text: 'fix',
			caret: 0,
		});
	});
});
