import { isId, isRecord } from './workspace';
/** `fileBytes` (spec/chat#images): the size of a file attached by path, which is stored as a short reference whose own size is `bytes`. */
export type PromptAttachment = {
	id: string;
	name: string;
	kind: 'text' | 'image';
	bytes: number;
	fileBytes?: number;
};
export type AttachmentInput = { name: string } & (
	| { kind: 'text'; text: string; fileBytes?: number }
	| { kind: 'image'; mimeType: 'image/png'; data: string }
);
export const attachmentTotalLimit = 8 * 1024 * 1024;
export const isAttachmentId = (v: unknown): v is string =>
	typeof v === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v);
export function isAttachmentIds(v: unknown): v is string[] {
	return (
		Array.isArray(v) && v.length <= 10 && v.every(isAttachmentId) && new Set(v).size === v.length
	);
}
export function isPromptAttachment(v: unknown): v is PromptAttachment {
	return (
		isRecord(v) &&
		isAttachmentId(v.id) &&
		typeof v.name === 'string' &&
		v.name.length > 0 &&
		v.name.length <= 200 &&
		(v.kind === 'text' || v.kind === 'image') &&
		Number.isSafeInteger(v.bytes) &&
		Number(v.bytes) > 0 &&
		Number(v.bytes) <= 4 * 1024 * 1024 &&
		(v.fileBytes === undefined || isFileBytes(v.fileBytes))
	);
}
export function isAttachmentInput(v: unknown): v is AttachmentInput {
	return (
		isRecord(v) &&
		typeof v.name === 'string' &&
		v.name.trim().length > 0 &&
		v.name.length <= 200 &&
		(v.kind === 'text'
			? typeof v.text === 'string' &&
				v.text.length > 0 &&
				v.text.length <= 256 * 1024 &&
				(v.fileBytes === undefined || isFileBytes(v.fileBytes))
			: v.kind === 'image' &&
				v.mimeType === 'image/png' &&
				typeof v.data === 'string' &&
				v.data.length <= 6 * 1024 * 1024 &&
				v.data.length > 0)
	);
}
const isFileBytes = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
/** spec/chat#images: square tiles crop a tall picture from its top and a wide one from its left edge. */
export function thumbnailCrop(width: number, height: number): 'top' | 'start' | 'center' {
	return height > width * 1.25 ? 'top' : width > height * 2.5 ? 'start' : 'center';
}
/** spec/chat#images: what a tile shows under a file's name — its size on disk, not the size of the stored reference. */
export function attachmentSize(item: PromptAttachment) {
	return item.fileBytes ?? item.bytes;
}
/** spec/tasks#backlog-edit: who keeps an attachment — a task, or the draft of a sheet whose task does not exist yet (`draft`). */
export type AttachmentOwner = { projectId: string; id: string; draft?: true };
export function isAttachmentOwner(v: unknown): v is AttachmentOwner {
	return (
		isRecord(v) && isId(v.projectId) && isId(v.id) && (v.draft === undefined || v.draft === true)
	);
}
/** spec/tasks#backlog-edit: a task's own list keeps the composer's limits — 10 attachments, 8 MB together, no repeats. */
export function isAttachmentList(v: unknown): v is PromptAttachment[] {
	return (
		Array.isArray(v) &&
		v.length <= 10 &&
		v.every(isPromptAttachment) &&
		new Set(v.map((item) => item.id)).size === v.length &&
		v.reduce((sum, item) => sum + item.bytes, 0) <= attachmentTotalLimit
	);
}
