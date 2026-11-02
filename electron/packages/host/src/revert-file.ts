import { constants } from 'node:fs';
import { lstat, open, unlink, link } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isRecord, type ChangeView, type SessionEvent, type TaskKey } from '@brigadir/core';
import {
	projectFile,
	readProjectFile,
	writeProjectFile,
	type SessionStore,
} from '@brigadir/persistence';
import { readChanges, readBlobs, type Snapshots } from '@brigadir/git';
/** Revert to the base of the displayed diff: a snapshot range, or HEAD under the base setting (spec/diff-and-review#diff-base). Never the user's index. */
export async function revertTaskFile(
	store: SessionStore,
	key: TaskKey,
	snapshots: Snapshots,
	fileId: string,
	range: ChangeView | undefined,
	emit: (event: SessionEvent) => Promise<void>
) {
	const changes = await readChanges(store, key, range);
	const file = changes.files.find((file) => file.id === fileId),
		scope = changes.scopes.find((scope) => scope.id === file?.scopeId);
	if (
		!file ||
		!scope ||
		file.gitlink ||
		file.binary ||
		![file.beforeMode, file.afterMode].every((mode) =>
			['000000', '100644', '100755'].includes(mode)
		)
	)
		throw new Error('This file cannot be reverted');
	const [before, after] = await readBlobs(scope, [file.before, file.after]);
	if (before!.tooLarge || after!.tooLarge || before!.binary || after!.binary)
		throw new Error('This file cannot be reverted');
	const path = await projectFile(scope.path, file.path);
	const renamed = file.status.startsWith('R');
	const copied = file.status.startsWith('C');
	const oldPath = renamed ? await projectFile(scope.path, file.oldPath) : path;
	const absent = async (path: string) => {
		try {
			await lstat(path);
			throw new Error('The file already exists');
		} catch (e) {
			if (!isRecord(e) || e.code !== 'ENOENT') throw e;
		}
	};
	const verify = async () => {
		if (!file.after) {
			await absent(path);
			return null;
		}
		const value = await readProjectFile(scope.path, file.path);
		if (
			value.state !== 'text' ||
			value.text !== after!.text ||
			value.mode !== parseInt(file.afterMode, 8) % 512
		)
			throw new Error('The file changed after this snapshot. Refresh before reverting.');
		return value;
	};
	const current = await verify();
	if (renamed) await absent(oldPath);
	const start = await snapshots.capture('user-before', { scopeIds: [scope.id] });
	async function create(path: string, text: string, mode: number) {
		const temp = join(dirname(path), `.${basename(path)}.brigadir-${randomUUID()}.tmp`);
		const handle = await open(temp, 'wx', mode);
		try {
			try {
				await handle.chmod(mode);
				await handle.writeFile(text, 'utf8');
				await handle.sync();
			} finally {
				await handle.close();
			}
			await link(temp, path);
		} finally {
			await unlink(temp).catch(() => {});
		}
	}
	try {
		await verify();
		if (!file.before || copied) {
			await unlink(path);
		} else if (renamed) {
			await create(oldPath, before!.text, parseInt(file.beforeMode, 8) % 512);
			try {
				await verify();
				await unlink(path);
			} catch (e) {
				const restored = await readProjectFile(scope.path, file.oldPath);
				if (restored.text === before!.text) await unlink(oldPath);
				throw e;
			}
		} else if (!file.after) {
			await create(path, before!.text, parseInt(file.beforeMode, 8) % 512);
		} else {
			const result = await writeProjectFile(scope.path, {
				path: file.path,
				expectedVersion: current!.version,
				text: before!.text,
			});
			if (result.status === 'conflict') throw new Error('The file changed during revert');
			const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
			try {
				await handle.chmod(parseInt(file.beforeMode, 8) % 512);
				await handle.sync();
			} finally {
				await handle.close();
			}
		}
		const directory = await open(dirname(path), 'r');
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
	} finally {
		const finish = await snapshots.capture('user-after', { scopeIds: [scope.id] });
		if (finish && finish.id !== start?.id)
			await emit({ kind: 'checkpoint.created', checkpoint: finish.id });
	}
}
