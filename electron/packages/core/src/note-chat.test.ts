import { describe, expect, it } from 'vitest';
import {
	isNoteChatRow,
	lastSeenNote,
	noteChatPrompt,
	noteLineDelta,
	undoableEdit,
	type NoteChatRow,
} from './note-chat';
const at = '2026-10-30T10:00:00Z';
describe('note chat (spec/notifications-slack-notes-and-schedules#notes)', () => {
	it('counts the lines one text has and the other lacks', () => {
		expect(noteLineDelta('a\nb\n', 'a\nb\nc\n')).toEqual({ added: 1, removed: 0 });
		expect(noteLineDelta('a\nb', 'a\nB')).toEqual({ added: 1, removed: 1 });
	});
	it('knows the note the chat saw last and which edit Undo may take back', () => {
		const rows: NoteChatRow[] = [
			{ seq: 1, at, kind: 'prompt', text: 'hi', note: 'one' },
			{ seq: 2, at, kind: 'edit', before: 'one', after: 'two', added: 1, removed: 1 },
		];
		expect(lastSeenNote(rows)).toBe('two');
		expect(undoableEdit(rows, 'two')).toBe(2);
		expect(undoableEdit(rows, 'three')).toBeNull();
		const undone = [...rows, { seq: 3, at, kind: 'undo' as const, of: 2 }];
		expect(lastSeenNote(undone)).toBe('one');
		expect(undoableEdit(undone, 'one')).toBeNull();
	});
	it('gives the agent the note with every message, in English', () => {
		const prompt = noteChatPrompt({
			text: 'Що далі?',
			note: '# A',
			file: '/n/note-a.md',
			project: null,
			first: true,
		});
		expect(prompt).toContain('the file /n/note-a.md');
		expect(prompt).toContain('<note>\n# A\n</note>');
		expect(prompt.endsWith('The person writes:\nЩо далі?')).toBe(true);
		expect(
			noteChatPrompt({ text: 'x', note: '', file: '/n/a.md', project: 'p', first: false })
		).toMatch(/^The same note/);
	});
});

describe('note chat attachments (spec/composer#chat-composer)', () => {
	it("keeps the message's attachments in its row, within the prompt's limits", () => {
		const item = {
			id: '0b1c2d3e-0000-4000-8000-000000000001',
			name: 'shot.png',
			kind: 'image' as const,
			bytes: 10,
		};
		const row = {
			seq: 1,
			at,
			kind: 'prompt',
			text: '@[att:0b1c2d3e-0000-4000-8000-000000000001]',
			note: '',
		};
		expect(isNoteChatRow({ ...row, attachments: [item] })).toBe(true);
		expect(isNoteChatRow(row)).toBe(true);
		expect(isNoteChatRow({ ...row, attachments: [item, item] })).toBe(false);
		expect(isNoteChatRow({ ...row, attachments: [{ ...item, id: 'x' }] })).toBe(false);
	});
});
