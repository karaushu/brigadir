import { join, relative } from 'node:path';
import { git, GitError } from '@brigadir/git';
import type { FileEntry } from '@brigadir/core';
type Status = NonNullable<FileEntry['status']>;
export class FileTreeMetadata {
	private roots = new Map<string, { at: number; promise: Promise<string | null> }>();
	private statuses = new Map<string, { at: number; promise: Promise<Map<string, Status>> }>();
	async read(directory: string, names: string[]) {
		const repo = await this.repo(directory);
		if (!repo) return { ignored: new Set<string>(), statuses: new Map<string, Status>() };
		const statuses = this.status(repo),
			ignored = await this.ignored(directory, names);
		const all = await statuses,
			result = new Map<string, Status>();
		for (const name of names) {
			const path = relative(repo, join(directory, name));
			const direct = all.get(path);
			if (direct) result.set(name, direct);
		}
		return { ignored, statuses: result };
	}
	repo(directory: string) {
		let root = this.roots.get(directory);
		if (!root || Date.now() - root.at > 3000) {
			const promise = git(directory, ['rev-parse', '--show-toplevel']).then(
				(bytes) => bytes.toString('utf8').trim(),
				() => null
			);
			root = { at: Date.now(), promise };
			this.roots.set(directory, root);
			if (this.roots.size > 100) this.roots.delete(this.roots.keys().next().value!);
		}
		return root.promise;
	}
	/** Paths relative to `cwd` that its repository ignores; one process for any number of paths. */
	async ignored(cwd: string, paths: string[]) {
		return paths.length
			? git(cwd, ['check-ignore', '-z', '--stdin'], { input: paths.join('\0') + '\0' }).then(
					(bytes) => new Set(bytes.toString('utf8').split('\0').filter(Boolean)),
					(error) => {
						if (error instanceof GitError && error.code === 1) return new Set<string>();
						throw error;
					}
				)
			: new Set<string>();
	}
	status(repo: string) {
		let status = this.statuses.get(repo);
		if (!status || Date.now() - status.at > 1500) {
			const promise = git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=normal'], {
				env: { GIT_OPTIONAL_LOCKS: '0' },
			}).then((bytes) => {
				const fields = bytes.toString('utf8').split('\0'),
					result = new Map<string, Status>();
				for (let i = 0; i < fields.length; i++) {
					const field = fields[i]!;
					if (!field) continue;
					const xy = field.slice(0, 2),
						path = field.slice(3).replace(/\/$/, '');
					result.set(
						path,
						xy.includes('U') || ['AA', 'DD'].includes(xy)
							? 'conflict'
							: xy === '??'
								? 'untracked'
								: xy.includes('D')
									? 'deleted'
									: xy.includes('A')
										? 'added'
										: xy.includes('R')
											? 'renamed'
											: 'modified'
					);
					if (/[RC]/.test(xy)) i++;
				}
				for (const path of [...result.keys()]) {
					let parent = path.lastIndexOf('/');
					while (parent > 0) {
						const directory = path.slice(0, parent);
						if (!result.has(directory)) result.set(directory, 'modified');
						parent = path.lastIndexOf('/', parent - 1);
					}
				}
				return result;
			});
			status = { at: Date.now(), promise };
			this.statuses.set(repo, status);
			if (this.statuses.size > 20) this.statuses.delete(this.statuses.keys().next().value!);
			void promise.catch(() => {
				if (this.statuses.get(repo)?.promise === promise) this.statuses.delete(repo);
			});
		}
		return status.promise;
	}
}
