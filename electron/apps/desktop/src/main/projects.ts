import { lstat, mkdir, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { isRecord, type Project } from '@brigadir/core';
import {
	SessionStore,
	readWorkspace,
	readDocument,
	safePath,
	atomicJson,
} from '@brigadir/persistence';
const limit = 20;
/** Main-owned native selection and recent paths; never accepts a renderer path. */
export class Projects {
	isRemoving: (id: string) => boolean = () => false;
	private tail: Promise<unknown> = Promise.resolve();
	private pending = 0;
	constructor(private dataDir?: string) {}
	get isSaving() {
		return this.pending > 0;
	}
	waitForWrites() {
		return this.tail.catch(() => {});
	}
	async recent(): Promise<string[]> {
		const store = await SessionStore.at(this.dataDir);
		try {
			const doc = await readDocument(await safePath(store.root, 'recent-projects.json'));
			if (
				!Array.isArray(doc.paths) ||
				doc.paths.length > limit ||
				!doc.paths.every(
					(path) =>
						typeof path === 'string' &&
						isAbsolute(path) &&
						path.length <= 16384 &&
						!path.includes('\0')
				)
			)
				throw new Error('Invalid recent projects');
			return [...new Set(doc.paths as string[])];
		} catch (error) {
			if (!isRecord(error) || error.code !== 'ENOENT') throw error;
			return [
				...new Set(
					(await readWorkspace(this.dataDir ? { dataDir: this.dataDir } : {})).projects.map(
						(project) => project.path
					)
				),
			].slice(0, limit);
		}
	}
	private serialize<T>(action: () => Promise<T>) {
		this.pending++;
		const work = this.tail
			.catch(() => {})
			.then(action)
			.finally(() => this.pending--);
		this.tail = work;
		return work;
	}
	private async write(paths: string[]) {
		const store = await SessionStore.at(this.dataDir);
		await mkdir(store.root, { recursive: true, mode: 0o700 });
		await atomicJson(await safePath(store.root, 'recent-projects.json'), {
			schemaVersion: 1,
			paths,
		});
	}
	open(path: string): Promise<Project> {
		return this.serialize(async () => {
			const recent = await this.recent(),
				actual = await realpath(path);
			if (!(await lstat(actual)).isDirectory()) throw new Error('Project must be a directory');
			const workspace = await readWorkspace(this.dataDir ? { dataDir: this.dataDir } : {});
			if (workspace.issues.some((issue) => issue.path.endsWith('project.json')))
				throw new Error('Project metadata could not be read');
			let existing: Project | undefined;
			for (const project of workspace.projects) {
				if (
					project.path === actual ||
					(await realpath(project.path).catch(() => null)) === actual
				) {
					existing = project;
					break;
				}
			}
			if (existing && this.isRemoving(existing.id)) throw new Error('Removal is in progress');
			const project = existing ?? (await (await SessionStore.at(this.dataDir)).addProject(actual));
			const normalized = await Promise.all(recent.map((item) => realpath(item).catch(() => item)));
			await this.write(
				[actual, ...new Set(normalized.filter((item) => item !== actual))].slice(0, limit)
			);
			return project;
		});
	}
	clear() {
		return this.serialize(async () => {
			await this.recent();
			await this.write([]);
		});
	}
}
