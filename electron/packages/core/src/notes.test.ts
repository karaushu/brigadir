import { describe, expect, it } from 'vitest';
import {
	isNoteId,
	isNoteMeta,
	newNoteId,
	noteFileName,
	noteTaskLine,
	noteTaskLinkPattern,
	noteTitle,
	withNoteTaskLine,
} from './notes';
describe('notes (spec/notifications-slack-notes-and-schedules#notes)', () => {
	it('takes the title from the first heading, else the first line with text', () => {
		expect(noteTitle('\n# Checkout після релізу 57\nтекст')).toBe('Checkout після релізу 57');
		expect(noteTitle('Ідеї на **тиждень**\n## Далі')).toBe('Далі');
		expect(noteTitle('\n- [ ] Спитати бекенд\n')).toBe('Спитати бекенд');
		expect(noteTitle('')).toBe('');
		expect(noteTitle(`# ${'x'.repeat(200)}`)).toHaveLength(120);
	});
	it('makes ids the store and the IPC accept', () => {
		const id = newNoteId(Date.UTC(2026, 9, 30), () => 0.5);
		expect(isNoteId(id)).toBe(true);
		expect(isNoteId('settings')).toBe(false);
		expect(isNoteId('note-../x')).toBe(false);
	});
	it('reads only a whole meta document', () => {
		expect(isNoteMeta({ schemaVersion: 1, project: null, createdAt: 'x', tasks: [] })).toBe(true);
		expect(isNoteMeta({ schemaVersion: 1, project: 'a b', createdAt: 'x', tasks: [] })).toBe(false);
		expect(isNoteMeta({ schemaVersion: 2, project: null, createdAt: 'x', tasks: [] })).toBe(false);
	});
	it('puts the link back under the selected lines, or at the end, as plain Markdown', () => {
		const line = noteTaskLine('Phone [and] email', 'business', 'phone-checks');
		expect(line).toBe('→ [Phone  and  email](brigadir://task/business/phone-checks)');
		expect(withNoteTaskLine('a\nb\nc', line, 2)).toBe(`a\nb\n${line}\nc`);
		expect(withNoteTaskLine('a\nb\n', line, null)).toBe(`a\nb\n${line}\n`);
		const [match] = [...`x ${line}`.matchAll(noteTaskLinkPattern)];
		expect([match![2], match![3]]).toEqual(['business', 'phone-checks']);
	});
	it('names the copied file after the title, without characters a file name cannot hold', () => {
		expect(noteFileName('# Next.js migration to AppRouter\n\ntext', 'Untitled note')).toBe(
			'Next.js migration to AppRouter.md'
		);
		expect(noteFileName('# a/b: c?*\n', 'Untitled note')).toBe('a b c.md');
		expect(noteFileName('', 'Untitled note')).toBe('Untitled note.md');
		expect(noteFileName('# ...\n', 'Untitled note')).toBe('Untitled note.md');
	});
});
