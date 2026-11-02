import { describe, expect, it } from 'vitest';
import {
	continueList,
	listLine,
	noteLineLinks,
	radioGroup,
	renderNote,
	toggleInText,
} from './note-markdown';
describe('Markdown in a note (spec/notifications-slack-notes-and-schedules#note-markdown)', () => {
	it('continues a list on Enter with the next bullet, number and an unchecked mark', () => {
		expect(continueList('- one', 5)).toEqual({ insert: '\n- ' });
		expect(continueList('  * two', 7)).toEqual({ insert: '\n  * ' });
		expect(continueList('9. nine', 7)).toEqual({ insert: '\n10. ' });
		expect(continueList('- [x] done', 10)).toEqual({ insert: '\n- [ ] ' });
		expect(continueList('[x] 123', 7)).toEqual({ insert: '\n[ ] ' });
		expect(continueList('() 123', 6)).toEqual({ insert: '\n( ) ' });
		expect(continueList('- ( ) a', 7)).toEqual({ insert: '\n- ( ) ' });
	});
	it('ends the list on an empty item and leaves other lines to the editor', () => {
		expect(continueList('- ', 2)).toEqual({ replace: '' });
		expect(continueList('- [ ] ', 6)).toEqual({ replace: '' });
		expect(continueList('plain text', 10)).toBeNull();
		expect(continueList('- one', 1)).toBeNull();
	});
	it('toggles a checkbox, and a radio clears the others of its group', () => {
		expect(toggleInText(['- [ ] a'], 0)).toEqual(['- [x] a']);
		expect(toggleInText(['[] a'], 0)).toEqual(['[x] a']);
		const radios = ['- (x) one', '- ( ) two', '', '- (x) other group'];
		expect(radioGroup(radios, 1)).toEqual([0, 1]);
		expect(toggleInText(radios, 1)).toEqual(['- ( ) one', '- (x) two', '', '- (x) other group']);
		expect(toggleInText(['text'], 0)).toBeNull();
		expect(listLine('- [x] a')).toMatchObject({
			mark: 'check',
			checked: true,
			markAt: 2,
			textAt: 6,
		});
	});
	it('previews marks as controls bound to their source line, a line break as a break', () => {
		const html = renderNote('# asd\n[x] 123\n() 123\n\n- [ ] item');
		expect(html).toContain('<input type="checkbox" data-note-line="2" checked');
		expect(html).toContain('<input type="radio" data-note-line="3"');
		expect(html).toContain('<input type="checkbox" data-note-line="5"');
		expect(html).toContain('<br>');
	});
	it('turns L5 and L5-7 of an answer into buttons, not inside code', () => {
		expect(noteLineLinks('<p>L5 і L6-7, але <code>L9</code></p>')).toBe(
			'<p><button type="button" data-note-lines="5-5">L5</button> і <button type="button" data-note-lines="6-7">L6-7</button>, але <code>L9</code></p>'
		);
		expect(noteLineLinks('<p>HTML5 XL5</p>')).toBe('<p>HTML5 XL5</p>');
	});
});
