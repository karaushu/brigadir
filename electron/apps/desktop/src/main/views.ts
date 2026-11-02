import { mkdir } from 'node:fs/promises';
import {
	isId,
	isProjectMode,
	isProjectView,
	isRecord,
	type ProjectMode,
	type ProjectView,
} from '@brigadir/core';
import { SessionStore, readDocument, safePath, atomicJson } from '@brigadir/persistence';
type Doc = { views: Record<string, ProjectView>; modes: Record<string, ProjectMode> };
const isKey = (id: string) => id === '*' || isId(id);
/**
 * spec/projects-and-board#board: Board/List choice persists per project (and for the combined "all projects" screen under `*`).
 * spec/projects-and-board#pr-mode: beside it, the tab (Tasks / Pull requests) and the PR filter, under `modes`.
 */
export class ProjectViews {
	private writes: Promise<unknown> = Promise.resolve();
	private pending = 0;
	get isSaving() {
		return this.pending > 0;
	}
	waitForWrites() {
		return this.writes;
	}
	constructor(private dataDir?: string) {}
	private async document(): Promise<Doc> {
		const store = await SessionStore.at(this.dataDir);
		try {
			const doc = await readDocument(await safePath(store.root, 'project-views.json'));
			const modes = doc.modes ?? {};
			if (
				!isRecord(doc.views) ||
				!Object.entries(doc.views).every(([id, view]) => isKey(id) && isProjectView(view)) ||
				!isRecord(modes) ||
				!Object.entries(modes).every(([id, mode]) => isKey(id) && isProjectMode(mode))
			)
				throw new Error('Invalid views');
			return {
				views: doc.views as Record<string, ProjectView>,
				modes: modes as Record<string, ProjectMode>,
			};
		} catch (error) {
			if (isRecord(error) && error.code === 'ENOENT') return { views: {}, modes: {} };
			throw error;
		}
	}
	async read(): Promise<Record<string, ProjectView>> {
		return (await this.document()).views;
	}
	async readModes(): Promise<Record<string, ProjectMode>> {
		return (await this.document()).modes;
	}
	private write(update: (doc: Doc) => Doc) {
		this.pending++;
		const write = this.writes
			.then(async () => {
				const doc = update(await this.document());
				const store = await SessionStore.at(this.dataDir);
				await mkdir(store.root, { recursive: true, mode: 0o700 });
				await atomicJson(await safePath(store.root, 'project-views.json'), {
					schemaVersion: 1,
					...doc,
				});
				return doc;
			})
			.finally(() => {
				this.pending--;
			});
		this.writes = write.catch(() => {});
		return write;
	}
	async save(projectId: string, view: ProjectView) {
		if (!isKey(projectId) || !isProjectView(view)) throw new Error('Invalid view');
		return (await this.write((doc) => ({ ...doc, views: { ...doc.views, [projectId]: view } })))
			.views;
	}
	async saveMode(projectId: string, mode: ProjectMode) {
		if (!isKey(projectId) || !isProjectMode(mode)) throw new Error('Invalid mode');
		await this.write((doc) => ({
			...doc,
			modes: {
				...doc.modes,
				[projectId]: {
					tab: mode.tab,
					filter: mode.filter,
					...(mode.repo ? { repo: mode.repo } : {}),
				},
			},
		}));
	}
}
