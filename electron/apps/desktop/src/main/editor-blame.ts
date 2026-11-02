import { readFile, stat } from 'node:fs/promises';
import { relative } from 'node:path';
import {
	blameByteLimit,
	blameLineLimit,
	blameNoLine as noLine,
	blameUnsaved,
	bufferToDisk,
	type EditorBlame,
	type GutterHunk,
	type Scope,
	type TaskKey,
} from '@brigadir/core';
import { blameFile, commitMessage, gitText, type DiskBlame } from '@brigadir/git';
import type { Changes } from './changes';
import type { GitHistory } from './git-history';

type Target = { absolute: string; readOnly: boolean };
type Entry = { stamp: string; result: Promise<{ blame: DiskBlame | 'untracked'; disk: string }> };

/**
 * spec/editor#line-author: the line author of open files. `git blame` runs as a child process in the Git root that owns the file and is
 * cached per file on its disk stamp (mtime, size) and the repo's HEAD, so it runs again only after a save or a commit.
 * The buffer meets the disk through line hunks computed in the diff worker, never on the main thread.
 */
export class EditorBlames {
	private cache = new Map<string, Entry>();
	constructor(
		private changes: Changes,
		private history: GitHistory,
		private target: (key: TaskKey, id: string) => Promise<Target>
	) {}
	private async owner(
		key: TaskKey,
		id: string
	): Promise<{ scope: Scope; path: string; absolute: string } | null> {
		const target = await this.target(key, id);
		if (target.readOnly) return null;
		const scope = await this.history.owner(key, target.absolute);
		if (!scope) return null;
		return { scope, path: relative(scope.path, target.absolute), absolute: target.absolute };
	}
	async read(key: TaskKey, id: string, text: string): Promise<EditorBlame> {
		const owner = await this.owner(key, id);
		if (!owner) return { state: 'none' };
		const { scope, path, absolute } = owner,
			info = await stat(absolute);
		if (!info.isFile()) return { state: 'none' };
		if (info.size > blameByteLimit || Buffer.byteLength(text, 'utf8') > blameByteLimit)
			return { state: 'too-large' };
		const head = await gitText(scope.path, ['rev-parse', '--verify', '-q', 'HEAD']).catch(() => '');
		const stamp = `${info.mtimeMs}:${info.size}:${head}`,
			cacheKey = `${scope.path}\0${path}`;
		let entry = this.cache.get(cacheKey);
		if (entry?.stamp !== stamp) {
			const created: Entry = {
				stamp,
				result: Promise.all([blameFile(scope, path), readFile(absolute, 'utf8')]).then(
					([blame, disk]) => ({ blame, disk })
				),
			};
			entry = created;
			created.result.catch(() => {
				if (this.cache.get(cacheKey) === created) this.cache.delete(cacheKey);
			});
		}
		this.cache.delete(cacheKey);
		this.cache.set(cacheKey, entry);
		while (this.cache.size > 32) this.cache.delete(this.cache.keys().next().value!);
		const { blame, disk } = await entry.result;
		if (blame === 'untracked') return { state: 'untracked', scopeId: scope.id, path };
		if (blame.lines.length > blameLineLimit || disk.includes('\0'))
			return { state: blame.lines.length > blameLineLimit ? 'too-large' : 'none' };
		const bufferLines = text === '' ? 0 : text.replace(/\r\n/g, '\n').split('\n').length;
		let map: Int32Array;
		if (text.replace(/\r\n/g, '\n') === disk.replace(/\r\n/g, '\n'))
			map = Int32Array.from({ length: bufferLines }, (_, index) => index + 1);
		else {
			const result = await this.changes.compute<{ hunks: GutterHunk[]; tooLarge: boolean }>({
				hunks: true,
				before: disk,
				after: text,
			});
			if (result.tooLarge) return { state: 'too-large' };
			map = bufferToDisk(result.hunks, bufferLines);
		}
		const lines: number[] = new Array(bufferLines),
			origins: number[] = new Array(bufferLines);
		for (let i = 0; i < bufferLines; i++) {
			const line = map[i]!;
			if (line === 0) {
				lines[i] = blameUnsaved;
				origins[i] = 0;
			} else if (line > blame.lines.length) {
				lines[i] = noLine;
				origins[i] = 0;
			} else {
				lines[i] = blame.lines[line - 1]!;
				origins[i] = blame.origins[line - 1]!;
			}
		}
		return { state: 'ready', scopeId: scope.id, path, commits: blame.commits, lines, origins };
	}
	/** The card's commit message, read the first time it shows. */
	async message(key: TaskKey, id: string, sha: string): Promise<string> {
		const owner = await this.owner(key, id);
		if (!owner) throw new Error('The file is outside Git');
		return commitMessage(owner.scope, sha);
	}
}
