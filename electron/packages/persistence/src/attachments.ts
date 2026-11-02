import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import {
	attachmentTotalLimit,
	isAttachmentId,
	isAttachmentIds,
	isAttachmentInput,
	isPromptAttachment,
	type AttachmentInput,
	type AttachmentOwner,
	type PromptAttachment,
	type TaskKey,
} from '@brigadir/core';
import { SessionStore, safePath, atomicJson, readDocument } from './session';
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export class Attachments {
	constructor(private store: SessionStore) {}
	/** spec/tasks#backlog-edit: a task keeps its attachments beside task.json; a sheet's draft (`draft`) in the data dir's drafts. */
	async ownerDir(owner: AttachmentOwner): Promise<string> {
		const key = { projectId: owner.projectId, id: owner.id };
		if (owner.draft === true) {
			const dir = await this.store.draftDir(key);
			await mkdir(dir, { recursive: true, mode: 0o700 });
			return dir;
		}
		await this.store.task(key);
		return this.store.taskDir(key);
	}
	/** spec/tasks#backlog-edit: moves a sheet's draft attachments into the task it created (a rename, no copy) and drops the draft. */
	async adopt(draft: TaskKey, task: TaskKey, ids: string[]): Promise<PromptAttachment[]> {
		const moved = await this.list({ projectId: draft.projectId, id: draft.id, draft: true }, ids);
		const source = await this.store.draftDir(draft),
			target = await safePath(await this.ownerDir(task), 'attachments');
		await mkdir(target, { recursive: true, mode: 0o700 });
		for (const item of moved)
			await rename(await safePath(source, 'attachments', item.id), await safePath(target, item.id));
		await this.discard(draft);
		return moved;
	}
	async discard(draft: TaskKey) {
		await rm(await this.store.draftDir(draft), { recursive: true, force: true });
	}
	/** spec/tasks#backlog-edit: the metadata of the owner's attachments in the given order; each one must still be there and unchanged. */
	async list(owner: AttachmentOwner, ids: string[]): Promise<PromptAttachment[]> {
		if (!isAttachmentIds(ids)) throw new Error('Too many attachments');
		const result: PromptAttachment[] = [];
		let total = 0;
		for (const id of ids) {
			const { attachment } = await this.read(owner, id);
			total += attachment.bytes;
			if (total > attachmentTotalLimit) throw new Error('Attachments are too large');
			result.push(attachment);
		}
		return result;
	}
	async create(key: AttachmentOwner, input: AttachmentInput): Promise<PromptAttachment> {
		if (!isAttachmentInput(input)) throw new Error('Invalid attachment');
		const root = await this.ownerDir(key);
		const bytes =
			input.kind === 'text' ? Buffer.from(input.text) : Buffer.from(input.data, 'base64');
		if (!bytes.length || bytes.length > (input.kind === 'text' ? 256 * 1024 : 4 * 1024 * 1024))
			throw new Error('Attachment is too large');
		if (
			input.kind === 'image' &&
			(bytes.toString('base64') !== input.data ||
				!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
		)
			throw new Error('Invalid PNG');
		const attachment: PromptAttachment = {
			id: randomUUID(),
			name: input.name.trim(),
			kind: input.kind,
			bytes: bytes.length,
			...(input.kind === 'text' && input.fileBytes !== undefined
				? { fileBytes: input.fileBytes }
				: {}),
		};
		const dir = await safePath(root, 'attachments', attachment.id);
		await mkdir(dir, { recursive: true, mode: 0o700 });
		const file = await open(
			await safePath(dir, input.kind === 'text' ? 'content.txt' : 'image.png'),
			'wx',
			0o600
		);
		try {
			await file.writeFile(bytes);
			await file.sync();
		} finally {
			await file.close();
		}
		await atomicJson(await safePath(dir, 'attachment.json'), {
			schemaVersion: 1,
			attachment,
			sha256: createHash('sha256').update(bytes).digest('hex'),
		});
		return attachment;
	}
	async read(
		key: AttachmentOwner,
		id: string
	): Promise<{ attachment: PromptAttachment; input: AttachmentInput; path: string }> {
		if (!isAttachmentId(id)) throw new Error('Invalid attachment ID');
		const dir = await safePath(await this.ownerDir(key), 'attachments', id);
		const doc = await readDocument(await safePath(dir, 'attachment.json'));
		if (!isPromptAttachment(doc.attachment) || doc.attachment.id !== id)
			throw new Error('Invalid attachment');
		const attachment = doc.attachment;
		if (attachment.kind === 'text' && attachment.bytes > 256 * 1024)
			throw new Error('Invalid attachment');
		const path = await safePath(dir, attachment.kind === 'text' ? 'content.txt' : 'image.png');
		const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		let bytes: Buffer;
		try {
			if ((await file.stat()).size !== attachment.bytes) throw new Error('Attachment changed');
			bytes = await file.readFile();
		} finally {
			await file.close();
		}
		if (createHash('sha256').update(bytes).digest('hex') !== doc.sha256)
			throw new Error('Attachment changed');
		const input: AttachmentInput =
			attachment.kind === 'text'
				? { name: attachment.name, kind: 'text', text: bytes.toString('utf8') }
				: {
						name: attachment.name,
						kind: 'image',
						mimeType: 'image/png',
						data: bytes.toString('base64'),
					};
		if (!isAttachmentInput(input)) throw new Error('Invalid attachment');
		return { attachment, input, path };
	}
	/** spec/chat#images: a small PNG for tiles, cached beside the image. `make` turns the verified image into it (main owns the
	 * image codec). The cache is trusted only while the image is still there at its recorded size; otherwise the image is read
	 * and verified again, so a deleted or changed image fails here as it does for the full read. */
	async thumbnail(
		key: AttachmentOwner,
		id: string,
		make: (png: Buffer) => Buffer
	): Promise<Buffer> {
		if (!isAttachmentId(id)) throw new Error('Invalid attachment ID');
		const dir = await safePath(await this.ownerDir(key), 'attachments', id),
			doc = await readDocument(await safePath(dir, 'attachment.json'));
		if (
			!isPromptAttachment(doc.attachment) ||
			doc.attachment.id !== id ||
			doc.attachment.kind !== 'image'
		)
			throw new Error('Invalid attachment');
		const image = await lstat(await safePath(dir, 'image.png'));
		if (!image.isFile() || image.size !== doc.attachment.bytes)
			throw new Error('Attachment changed');
		const path = await safePath(dir, 'thumb.png');
		try {
			const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
			try {
				const cached = await file.readFile();
				if (cached.length > 0 && cached.subarray(0, 8).equals(pngSignature)) return cached;
			} finally {
				await file.close();
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		}
		const { input } = await this.read(key, id);
		if (input.kind !== 'image') throw new Error('Invalid attachment');
		const thumb = make(Buffer.from(input.data, 'base64'));
		if (!thumb.subarray(0, 8).equals(pngSignature)) throw new Error('Invalid thumbnail');
		const temp = await safePath(dir, `thumb.${randomUUID()}.tmp`),
			file = await open(temp, 'wx', 0o600);
		try {
			await file.writeFile(thumb);
			await file.sync();
		} finally {
			await file.close();
		}
		await rename(temp, path);
		return thumb;
	}
	async resolve(key: TaskKey, ids: string[]) {
		if (!isAttachmentIds(ids)) throw new Error('Too many attachments');
		const result = [];
		let total = 0;
		for (const id of ids) {
			const value = await this.read(key, id);
			total += value.attachment.bytes;
			if (total > attachmentTotalLimit) throw new Error('Attachments are too large');
			result.push(value);
		}
		return result;
	}
}
