import { createHash } from 'node:crypto';
import { open, rm, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { gitText } from './command';
import { gitDir } from './scopes';
/**
 * A task's first snapshot from `read-tree HEAD` into an empty index has no stat data, so `add -A` hashes every tracked
 * file (60k files: 3.2–7 s per scope). `read-tree -m <tree>` with one tree gives the same entries as `read-tree <tree>`,
 * but takes stat from the old index where path, mode and blob match. The old index is a copy of the user's index, which
 * we only read. The stat cache is the same trust as in `git status` and in our own index from the second snapshot on.
 * Entries can differ only through flags `read-tree -m` carries over: assume-unchanged, skip-worktree, intent-to-add,
 * a conflict, a sparse directory. With those, as with a split index, the plain `read-tree` path is used.
 */
export async function seedIndex(
	path: string,
	head: string,
	index: string,
	env: Record<string, string>
): Promise<boolean> {
	const dir = await gitDir(path);
	if (!dir) return false;
	let bytes: Buffer, mtime: number;
	try {
		const file = await open(join(dir, 'index'), 'r');
		try {
			const stat = await file.stat();
			if (!stat.isFile() || stat.size > 256 * 1024 * 1024) return false;
			mtime = stat.mtimeMs;
			bytes = await file.readFile();
		} finally {
			await file.close();
		}
	} catch {
		return false;
	}
	const plain = plainIndex(bytes, head.length / 2);
	if (!plain) return false;
	try {
		const file = await open(index, 'wx', 0o600);
		try {
			await file.writeFile(plain);
		} finally {
			await file.close();
		}
		// Racy git: an entry with mtime ≥ the index time is checked by content. The copy is a second newer than the original, so there are more such entries, not fewer.
		const at = new Date(mtime - 1000);
		await utimes(index, at, at);
		await gitText(path, ['read-tree', '-m', head], { env });
		return true;
	} catch {
		await rm(index, { force: true });
		return false;
	}
}
/** Only the index header and entries with a new checksum: extensions (cache-tree, untracked cache, fsmonitor) are dropped.
 *  `null` — an unknown format, a checksum mismatch, or an entry `read-tree -m` would carry over with a flag. */
export function plainIndex(bytes: Buffer, hashBytes: number): Buffer | null {
	if (
		(hashBytes !== 20 && hashBytes !== 32) ||
		bytes.length < 12 + hashBytes ||
		bytes.toString('latin1', 0, 4) !== 'DIRC'
	)
		return null;
	const version = bytes.readUInt32BE(4),
		count = bytes.readUInt32BE(8),
		end = bytes.length - hashBytes,
		algorithm = hashBytes === 20 ? 'sha1' : 'sha256';
	if (version < 2 || version > 4) return null;
	const trailer = bytes.subarray(end);
	if (
		trailer.some((byte) => byte !== 0) &&
		!createHash(algorithm).update(bytes.subarray(0, end)).digest().equals(trailer)
	)
		return null;
	let offset = 12;
	for (let i = 0; i < count; i++) {
		const start = offset;
		if (offset + 42 + hashBytes > end) return null;
		const type = bytes.readUInt32BE(offset + 24) & 0o170000;
		offset += 40 + hashBytes;
		const flags = bytes.readUInt16BE(offset);
		offset += 2;
		// assume-unchanged (bit 15), conflict stage (bits 12-13); extended flags — skip-worktree, intent-to-add.
		if (flags & 0xb000) return null;
		if (flags & 0x4000) {
			if (version < 3 || offset + 2 > end || bytes.readUInt16BE(offset) !== 0) return null;
			offset += 2;
		}
		if (type !== 0o100000 && type !== 0o120000 && type !== 0o160000) return null;
		if (version === 4) {
			while (offset < end && bytes[offset]! & 0x80) offset++;
			const nul = bytes.indexOf(0, offset + 1);
			if (nul < 0 || nul >= end) return null;
			offset = nul + 1;
		} else {
			const length = flags & 0xfff,
				nul = length < 0xfff ? offset + length : bytes.indexOf(0, offset);
			if (nul < 0 || nul >= end || bytes[nul] !== 0) return null;
			offset = start + ((nul - start + 8) & ~7);
			if (offset > end) return null;
		}
	}
	const entries = offset;
	while (offset < end) {
		if (offset + 8 > end) return null;
		const signature = bytes.toString('latin1', offset, offset + 4);
		if (signature === 'link' || signature === 'sdir') return null;
		offset += 8 + bytes.readUInt32BE(offset + 4);
	}
	if (offset !== end) return null;
	return Buffer.concat([
		bytes.subarray(0, entries),
		createHash(algorithm).update(bytes.subarray(0, entries)).digest(),
	]);
}
