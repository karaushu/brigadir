import { describe, expect, it } from 'vitest';
import {
	attachmentSize,
	isAttachmentInput,
	isAttachmentList,
	isAttachmentOwner,
	isPromptAttachment,
	thumbnailCrop,
} from './attachments';
import { attachmentCount } from './messages';
import { attachmentLabel } from './messages';
const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
describe('spec/chat#images attachments in the log', () => {
	it('crops a tall picture from its top, a wide one from its left edge, the rest from the centre', () => {
		expect(thumbnailCrop(600, 1900)).toBe('top');
		expect(thumbnailCrop(2400, 220)).toBe('start');
		expect(thumbnailCrop(1600, 1000)).toBe('center');
		expect(thumbnailCrop(1000, 1250)).toBe('center');
		expect(thumbnailCrop(1000, 1251)).toBe('top');
	});
	it('names a pasted image by its kind in the interface language, also when the stored name is already translated', () => {
		expect(attachmentLabel('uk', { kind: 'image', name: 'Pasted image' })).toBe(
			'Вставлене зображення'
		);
		expect(attachmentLabel('en', { kind: 'image', name: 'Вставлене зображення' })).toBe(
			'Pasted image'
		);
		expect(attachmentLabel('uk', { kind: 'image', name: 'shot.png' })).toBe('shot.png');
		expect(attachmentLabel('en', { kind: 'text', name: 'Вставлене зображення' })).toBe(
			'Вставлене зображення'
		);
	});
	it('shows the size of a file attached by path, not of its stored reference', () => {
		expect(
			attachmentSize({ id, name: 'notes.txt', kind: 'text', bytes: 180, fileBytes: 52000 })
		).toBe(52000);
		expect(attachmentSize({ id, name: 'Terminal output', kind: 'text', bytes: 1200 })).toBe(1200);
		expect(
			isPromptAttachment({ id, name: 'notes.txt', kind: 'text', bytes: 180, fileBytes: 52000 })
		).toBe(true);
		expect(
			isPromptAttachment({ id, name: 'notes.txt', kind: 'text', bytes: 180, fileBytes: -1 })
		).toBe(false);
		expect(
			isPromptAttachment({ id, name: 'notes.txt', kind: 'text', bytes: 180, fileBytes: '1' })
		).toBe(false);
		expect(isAttachmentInput({ kind: 'text', name: 'notes.txt', text: 'ref', fileBytes: 0 })).toBe(
			true
		);
		expect(
			isAttachmentInput({ kind: 'text', name: 'notes.txt', text: 'ref', fileBytes: 1.5 })
		).toBe(false);
	});
});

// spec/tasks#backlog-edit: a task's own list keeps the composer's limits; a sheet draft names its owner with the draft flag only.
it('bounds a task attachment list and recognises a sheet draft owner', () => {
	const item = (n: number, bytes = 100) => ({
		id: `0000000${n}-0000-4000-8000-00000000000${n}`,
		name: 'a',
		kind: 'image' as const,
		bytes,
	});
	expect(isAttachmentList([item(1), item(2)])).toBe(true);
	expect(isAttachmentList([item(1), item(1)])).toBe(false);
	expect(isAttachmentList(Array.from({ length: 11 }, (_, n) => item(n % 10)))).toBe(false);
	expect(isAttachmentList([item(1, 4 * 1024 * 1024), item(2, 4 * 1024 * 1024), item(3, 1)])).toBe(
		false
	);
	expect(isAttachmentOwner({ projectId: 'p1', id: 't1' })).toBe(true);
	expect(isAttachmentOwner({ projectId: 'p1', id: 't1', draft: true })).toBe(true);
	expect(isAttachmentOwner({ projectId: 'p1', id: 't1', draft: false })).toBe(false);
	expect(isAttachmentOwner({ projectId: '../x', id: 't1' })).toBe(false);
	expect([1, 3, 5, 21].map((n) => attachmentCount('uk', n))).toEqual([
		'1 вкладення',
		'3 вкладення',
		'5 вкладень',
		'21 вкладення',
	]);
	expect(attachmentCount('en', 1)).toBe('1 attachment');
});
