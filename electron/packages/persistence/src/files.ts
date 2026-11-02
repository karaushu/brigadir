import { constants } from 'node:fs';
import { open, realpath, rename, unlink, lstat } from 'node:fs/promises';
import { dirname, basename, join, relative, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
	editorByteLimit,
	type FileContent,
	type SaveFileRequest,
	type SaveFileResult,
} from '@brigadir/core';
import { safePath } from './session';
export const contentVersion = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export async function projectFile(root: string, path: string) {
	if (
		!path ||
		isAbsolute(path) ||
		path.split('/').some((p) => !p || p === '.' || p === '..' || p === '.git' || p === '.brigadir')
	)
		throw new Error('Invalid file path');
	const actual = await realpath(root);
	const file = await safePath(actual, path);
	if (relative(actual, file).startsWith('..')) throw new Error('Invalid file path');
	return file;
}
function describe(bytes: Buffer, mode: number): FileContent {
	const text = bytes.toString('utf8');
	const binary =
		/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text) || !Buffer.from(text, 'utf8').equals(bytes);
	return {
		text: binary ? '' : text,
		version: contentVersion(bytes),
		state: binary ? 'binary' : 'text',
		large: bytes.length > 5 * 1024 * 1024 || text.split('\n').length > 50000,
		lineEnding: text.includes('\r\n') && !/(?<!\r)\n/.test(text) ? '\r\n' : '\n',
		mode,
	};
}
export async function readProjectFile(root: string, path: string): Promise<FileContent> {
	const file = await open(await projectFile(root, path), constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = await file.stat();
		if (!stat.isFile()) throw new Error('Not a regular file');
		if (stat.size > editorByteLimit)
			return {
				text: '',
				version: '',
				state: 'too-large',
				large: true,
				lineEnding: '\n',
				mode: stat.mode & 0o777,
			};
		// Bound the read even if another process grows the file after stat.
		const bytes = Buffer.alloc(stat.size + 1);
		let bytesRead = 0;
		while (bytesRead < bytes.length) {
			const read = await file.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
			if (!read.bytesRead) break;
			bytesRead += read.bytesRead;
		}
		if (bytesRead !== stat.size) throw new Error('File changed while reading');
		return describe(bytes.subarray(0, bytesRead), stat.mode & 0o777);
	} finally {
		await file.close();
	}
}
export async function writeProjectFile(
	root: string,
	request: SaveFileRequest
): Promise<SaveFileResult> {
	const bytes = Buffer.from(request.text, 'utf8');
	if (bytes.length > editorByteLimit || describe(bytes, 0).state !== 'text')
		throw new Error('File content is not supported');
	const before = await readProjectFile(root, request.path);
	if (before.state !== 'text') throw new Error('File cannot be edited');
	if (before.version !== request.expectedVersion) return { status: 'conflict', content: before };
	const path = await projectFile(root, request.path);
	const identity = await lstat(path);
	const temp = join(dirname(path), `.${basename(path)}.brigadir-${randomUUID()}.tmp`);
	const file = await open(temp, 'wx', before.mode);
	try {
		try {
			await file.chmod(before.mode);
			await file.writeFile(bytes);
			await file.sync();
		} finally {
			await file.close();
		}
		const latest = await readProjectFile(root, request.path);
		const now = await lstat(await projectFile(root, request.path));
		if (latest.version !== request.expectedVersion || now.ino !== identity.ino)
			return { status: 'conflict', content: latest };
		await rename(temp, path);
		const dir = await open(dirname(path), 'r');
		try {
			await dir.sync();
		} finally {
			await dir.close();
		}
		return { status: 'saved', content: describe(bytes, before.mode) };
	} finally {
		await unlink(temp).catch(() => {});
	}
}
