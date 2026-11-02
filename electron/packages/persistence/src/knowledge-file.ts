import { open, link, unlink, lstat } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isRecord } from '@brigadir/core';
import { projectFile, readProjectFile, writeProjectFile } from './files';
const limit = 128 * 1024;
export async function readKnowledgeFile(root: string, path: string): Promise<string | null> {
	try {
		const content = await readProjectFile(root, path);
		if (content.state !== 'text' || Buffer.byteLength(content.text) > limit)
			throw new Error('Choose a text file smaller than 128 KB.');
		return content.text;
	} catch (error) {
		if (isRecord(error) && error.code === 'ENOENT') return null;
		throw error;
	}
}
/** Entire-file compare, including absence. Existing-file writes preserve file mode. */
export async function replaceKnowledgeFile(
	root: string,
	path: string,
	before: string | null,
	after: string | null
) {
	if ((await readKnowledgeFile(root, path)) !== before)
		throw new Error('The file changed. Review it again.');
	if (
		after !== null &&
		(Buffer.byteLength(after) > limit || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(after))
	)
		throw new Error('Choose a text file smaller than 128 KB.');
	const target = await projectFile(root, path);
	if (before !== null) {
		const identity = await lstat(target);
		const content = await readProjectFile(root, path);
		if (content.text !== before) throw new Error('The file changed. Review it again.');
		if (after === null) {
			if (
				(await readKnowledgeFile(root, path)) !== before ||
				(await lstat(await projectFile(root, path))).ino !== identity.ino
			)
				throw new Error('The file changed. Review it again.');
			await unlink(target);
		} else if (
			(await writeProjectFile(root, { path, text: after, expectedVersion: content.version }))
				.status !== 'saved'
		)
			throw new Error('The file changed. Review it again.');
		return;
	}
	if (after === null) return;
	const temp = join(dirname(target), `.${basename(target)}.brigadir-${randomUUID()}.tmp`),
		file = await open(temp, 'wx', 0o644);
	try {
		try {
			await file.writeFile(after);
			await file.sync();
		} finally {
			await file.close();
		}
		await projectFile(root, path);
		await link(temp, target);
	} finally {
		await unlink(temp).catch(() => {});
	}
}
