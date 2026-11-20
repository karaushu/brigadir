import { expect, it } from 'vitest';
import { mergeNoteText } from './note-merge';

it('keeps what the person typed and the Slack addition at the end', () => {
	const base = '# Release\n\n- ship\n',
		ours = '# Release\n\n- ship on Friday\n- tell support\n',
		disk = '# Release\n\n- ship\n\nFrom Slack: #deploys thread\n\nfreeze at noon\n';
	expect(mergeNoteText(base, ours, disk)).toBe(
		'# Release\n\n- ship on Friday\n- tell support\n\nFrom Slack: #deploys thread\n\nfreeze at noon\n'
	);
});

it('applies changes on different lines from both sides', () => {
	expect(mergeNoteText('a\nb\nc\nd\n', 'A\nb\nc\nd\n', 'a\nb\nc\nD\n')).toBe('A\nb\nc\nD\n');
});

it('takes either side whole when the other did not change', () => {
	expect(mergeNoteText('a\n', 'a\n', 'a\nb\n')).toBe('a\nb\n');
	expect(mergeNoteText('a\n', 'a b\n', 'a\n')).toBe('a b\n');
	expect(mergeNoteText('', 'typed', 'added\n')).toBe('typed\nadded');
});

it('keeps a line both sides added, each in its own place', () => {
	expect(mergeNoteText('a\n', 'a\nsame\n', 'a\n\nFrom Slack: x\n\nsame\n')).toBe(
		'a\nsame\n\nFrom Slack: x\n\nsame\n'
	);
});
