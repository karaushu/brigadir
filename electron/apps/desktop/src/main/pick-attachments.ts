import { dialog, nativeImage, type BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { Attachments, SessionStore, safePath } from '@brigadir/persistence';
import {
	attachmentTotalLimit,
	imageSizeRefusal,
	remoteUploadLimit,
	type AttachmentInput,
	type AttachmentOwner,
	type PromptAttachment,
} from '@brigadir/core';
import { fittedPng } from './paste-attachment';

// Only native user selection supplies paths; this is not a renderer file-read API.
export async function pickAttachments(
	window: BrowserWindow | null,
	key: AttachmentOwner,
	dataDir?: string
) {
	const store = await SessionStore.at(dataDir);
	await new Attachments(store).ownerDir(key);
	const paths = await pickFiles(window);
	return paths.length ? attachPaths(key, paths, dataDir) : [];
}
/** The native multiple choice of files over a window of this machine. */
export async function pickFiles(window: BrowserWindow | null): Promise<string[]> {
	const options: Electron.OpenDialogOptions = { properties: ['openFile', 'multiSelections'] };
	const result = window
		? await dialog.showOpenDialog(window, options)
		: await dialog.showOpenDialog(options);
	return result.canceled ? [] : result.filePaths;
}
const imageExtensions = ['.png', '.jpg', '.jpeg', '.webp'];
/**
 * spec/remote-access-and-mobile#client-ui-seam: files a person picked or dropped on a device, for a task on the machine it shows. The device reads
 * them here and sends their bytes; the working machine makes the attachments (`uploadAttachment`).
 */
export async function uploadPaths(
	upload: (name: string, bytes: Uint8Array, image: boolean) => Promise<PromptAttachment>,
	picked: string[]
): Promise<PromptAttachment[]> {
	const paths = [...new Set(picked)];
	if (paths.length > 10) throw new Error('Too many attachments');
	const files: { name: string; bytes: Uint8Array; image: boolean }[] = [];
	for (const path of paths) {
		const file = await open(path, 'r');
		try {
			const stat = await file.stat();
			if (!stat.isFile()) throw new Error('Not a file');
			if (!stat.size) throw new Error('The file is empty');
			if (stat.size > remoteUploadLimit) throw new Error('The file is too large');
			const bytes = await file.readFile();
			if (bytes.length > remoteUploadLimit) throw new Error('The file is too large');
			files.push({
				name: basename(path).slice(0, 200),
				bytes: new Uint8Array(bytes),
				image: imageExtensions.includes(extname(path).toLowerCase()),
			});
		} finally {
			await file.close();
		}
	}
	const attachments: PromptAttachment[] = [];
	for (const file of files) attachments.push(await upload(file.name, file.bytes, file.image));
	return attachments;
}
/**
 * `attachment:upload` on the working machine: an image becomes a PNG attachment (scaled down to the 4 MB limit, like a
 * pasted screenshot); any other file is kept under the project's `uploads/` and attached as the same «File reference» a
 * local file gets — a path on this machine, which the agent reads.
 */
export async function uploadAttachment(
	key: AttachmentOwner,
	name: string,
	bytes: Uint8Array,
	image: boolean,
	dataDir?: string
): Promise<PromptAttachment> {
	const store = await SessionStore.at(dataDir),
		assets = new Attachments(store);
	await assets.ownerDir(key);
	const clean = name.trim().slice(0, 200);
	if (image) {
		// The header first: a small file may decode into gigabytes in main (security review R2–R4, P2).
		const refusal = imageSizeRefusal(bytes);
		if (refusal) throw new Error(refusal);
		const decoded = nativeImage.createFromBuffer(Buffer.from(bytes));
		if (decoded.isEmpty()) throw new Error('Invalid image');
		return assets.create(key, {
			kind: 'image',
			name: clean,
			mimeType: 'image/png',
			data: fittedPng(decoded).toString('base64'),
		});
	}
	const dir = await safePath(store.root, 'projects', key.projectId, 'uploads', randomUUID());
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const path = await safePath(dir, clean);
	const file = await open(path, 'wx', 0o600);
	try {
		await file.writeFile(bytes);
		await file.sync();
	} finally {
		await file.close();
	}
	return assets.create(key, {
		kind: 'text',
		name: clean,
		text: fileReference(path),
		fileBytes: bytes.length,
	});
}
const fileReference = (path: string) =>
	`File reference:\nAbsolute path: ${JSON.stringify(path)}\nRead the current contents from disk when needed.`;

/** spec/composer#paste: the same files a person dropped from Finder or copied there and pasted. Preload takes their paths from the
 * dropped or pasted `File` objects (`webUtils.getPathForFile`), so these too come from the person's own gesture. */
export async function attachPaths(key: AttachmentOwner, picked: string[], dataDir?: string) {
	const store = await SessionStore.at(dataDir);
	await new Attachments(store).ownerDir(key);
	const paths = [...new Set(picked)];
	if (paths.length > 10) throw new Error('Too many attachments');
	const inputs: AttachmentInput[] = [];
	let total = 0;
	for (const path of paths) {
		const file = await open(path, 'r');
		try {
			const stat = await file.stat();
			if (!stat.isFile()) throw new Error('Not a file');
			const name = basename(path).slice(0, 200);
			let input: AttachmentInput;
			if (imageExtensions.includes(extname(path).toLowerCase())) {
				if (stat.size > 4 * 1024 * 1024) throw new Error('Image is too large');
				const buffer = Buffer.alloc(4 * 1024 * 1024 + 1);
				let length = 0;
				while (length < buffer.length) {
					const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
					if (!bytesRead) break;
					length += bytesRead;
				}
				if (length > 4 * 1024 * 1024) throw new Error('Image is too large');
				const refusal = imageSizeRefusal(buffer.subarray(0, length));
				if (refusal) throw new Error(refusal);
				const image = nativeImage.createFromBuffer(buffer.subarray(0, length));
				if (image.isEmpty()) throw new Error('Invalid image');
				const bytes = image.toPNG();
				if (bytes.length > 4 * 1024 * 1024) throw new Error('Image is too large');
				total += bytes.length;
				input = { kind: 'image', name, mimeType: 'image/png', data: bytes.toString('base64') };
			} else {
				const text = fileReference(path);
				total += Buffer.byteLength(text);
				input = { kind: 'text', name, text, fileBytes: stat.size };
			}
			if (total > attachmentTotalLimit) throw new Error('Attachments are too large');
			inputs.push(input);
		} finally {
			await file.close();
		}
	}
	const assets = new Attachments(store),
		attachments = [];
	for (const input of inputs) attachments.push(await assets.create(key, input));
	return attachments;
}

/** spec/chat#images: the tile's picture — the shorter side down to 176 px (a 44 px tile on Retina, with room), the longer one at
 * most 1200 so a strip screenshot stays small. Smaller images are kept as they are. */
export function thumbnailPng(png: Buffer): Buffer {
	const image = nativeImage.createFromBuffer(png);
	if (image.isEmpty()) throw new Error('Invalid image');
	const { width, height } = image.getSize(),
		scale = Math.min(1, 176 / Math.min(width, height), 1200 / Math.max(width, height));
	if (scale >= 1) return image.toPNG();
	return image
		.resize({
			width: Math.max(1, Math.round(width * scale)),
			height: Math.max(1, Math.round(height * scale)),
			quality: 'best',
		})
		.toPNG();
}

/** spec/tasks#backlog-edit: «Description from a .md file…» — the text of one Markdown file the person picked, pasted into the description once. */
export async function readMarkdown(path: string): Promise<{ name: string; text: string }> {
	const file = await open(path, 'r');
	try {
		const stat = await file.stat();
		if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('The file is too large');
		const text = (await file.readFile()).toString('utf8');
		if (text.includes('\0')) throw new Error('The file is not text');
		return { name: basename(path).slice(0, 200), text: text.slice(0, 1_000_000) };
	} finally {
		await file.close();
	}
}
