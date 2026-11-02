import { constants } from 'node:fs';
import { mkdir, open, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {
	isRecord,
	isSurfaceDraft,
	mapSurfaceTabs,
	readSurfaceDocument,
	surfaceSchemaVersion,
	surfaceTabs,
	surfaceVersionOf,
	type SurfaceDraft,
	type SurfaceTab,
	type TaskKey,
	type TaskSurface,
	type TerminalInfo,
} from '@brigadir/core';
import { SessionStore, atomicJson, safePath } from '@brigadir/persistence';

/** What main knows of a task's tabs that the renderer does not: file paths behind ids, folders, addresses, the device. */
export type SurfaceSources = {
	filePath(key: TaskKey, id: string): string | null;
	fileId(key: TaskKey, path: string): Promise<string | null>;
	terminals(key: TaskKey): Promise<TerminalInfo[] | null>;
	browser(key: TaskKey, tab: string): { url: string; title: string; mobile: boolean } | null;
	/** The tabs come back with their own Desktop / Mobile mode (spec/task-window-workspace#restore-window). */
	restoreBrowsers(
		key: TaskKey,
		tabs: { tab: string; url: string; title: string; mobile: boolean }[]
	): void | Promise<void>;
	device(projectId: string): Promise<string | null>;
};
const taskName = (key: TaskKey) => `${key.projectId}/${key.id}`;
const surfaceLimit = 4 * 1024 * 1024,
	draftLimit = 64 * 1024 * 1024;
async function readJson(path: string, limit: number): Promise<unknown> {
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		if ((await file.stat()).size > limit) throw new Error('Document is too large');
		return JSON.parse(await file.readFile('utf8'));
	} finally {
		await file.close();
	}
}
const missing = (error: unknown) => isRecord(error) && error.code === 'ENOENT';
/** A draft's file name: the path's hash, so a path never becomes a name on disk. */
export const draftName = (path: string) =>
	`${createHash('sha256').update(path).digest('hex').slice(0, 32)}.json`;

/**
 * spec/task-window-workspace#restore-window: each task's `surface.json` and `drafts/`. One write queue per task, so a quit waits for every pending write
 * (spec/architecture-and-platform#exit). A file of a schema this app does not know is never written over: it belongs to a newer Brigadir.
 */
export class TaskSurfaces {
	private queues = new Map<string, Promise<unknown>>();
	private pending = 0;
	/** The last surface read or written per task: what a terminal's folder or a page's address was, when main has no live answer. */
	private known = new Map<string, TaskSurface>();
	private foreign = new Set<string>();
	constructor(
		private sources: SurfaceSources,
		private dataDir?: string,
		private log: (text: string) => void = (text) => console.error(text)
	) {}
	get isSaving() {
		return this.pending > 0;
	}
	waitForWrites() {
		return Promise.allSettled([...this.queues.values()]);
	}
	private queue<T>(key: TaskKey, work: () => Promise<T>): Promise<T> {
		const id = taskName(key);
		this.pending++;
		const run = (this.queues.get(id) ?? Promise.resolve()).then(work).finally(() => {
			this.pending--;
		});
		this.queues.set(
			id,
			run.catch(() => {})
		);
		return run;
	}
	private async dir(key: TaskKey) {
		const store = await SessionStore.at(this.dataDir);
		await store.task(key);
		return store.taskDir(key);
	}
	/** The task's surface with ids for its files, and its unsaved buffers; the drafts leave the disk once read (they live in the window now). */
	read(key: TaskKey): Promise<{ surface: TaskSurface | null; drafts: SurfaceDraft[] }> {
		return this.queue(key, async () => {
			const dir = await this.dir(key);
			let stored: TaskSurface | null = null;
			try {
				const document = await readJson(await safePath(dir, 'surface.json'), surfaceLimit),
					version = surfaceVersionOf(document);
				if (version !== null && version !== surfaceSchemaVersion) {
					this.foreign.add(taskName(key));
					this.log(
						`[surface] ${taskName(key)}: schemaVersion ${version} is not ${surfaceSchemaVersion}; the file is kept as it is`
					);
				} else {
					this.foreign.delete(taskName(key));
					stored = readSurfaceDocument(document);
				}
			} catch (error) {
				if (!missing(error)) this.log(`[surface] ${taskName(key)}: unreadable surface.json`);
			}
			let surface: TaskSurface | null = null;
			if (stored) {
				this.known.set(taskName(key), stored);
				const ids = new Map<string, string | null>();
				for (const tab of surfaceTabs(stored))
					if (tab.kind === 'file' && !ids.has(tab.path))
						ids.set(tab.path, await this.sources.fileId(key, tab.path));
				surface = mapSurfaceTabs(stored, (tab) => {
					if (tab.kind !== 'file') return tab;
					const id = ids.get(tab.path);
					return id ? { ...tab, id } : null;
				});
				await this.sources.restoreBrowsers(
					key,
					surfaceTabs(stored).flatMap((tab) =>
						tab.kind === 'browser' && tab.url
							? [{ tab: tab.tab, url: tab.url, title: tab.title, mobile: tab.mobile }]
							: []
					)
				);
			}
			const drafts: SurfaceDraft[] = [];
			const folder = await safePath(dir, 'drafts');
			let names: string[] = [];
			try {
				names = (await readdir(folder)).filter((name) => /^[a-f0-9]{32}\.json$/.test(name));
			} catch (error) {
				if (!missing(error)) throw error;
			}
			for (const name of names) {
				const path = await safePath(folder, name);
				try {
					const document = await readJson(path, draftLimit);
					if (surfaceVersionOf(document) !== surfaceSchemaVersion) continue;
					const draft = isRecord(document) ? document.draft : null;
					if (!isSurfaceDraft(draft)) continue;
					const id = await this.sources.fileId(key, draft.path);
					if (id) drafts.push({ ...draft, id });
				} catch {
					this.log(`[surface] ${taskName(key)}: unreadable draft ${name}`);
					continue;
				}
				await rm(path, { force: true });
			}
			return { surface, drafts };
		});
	}
	/** The surface the renderer sent, with paths for ids and main's own facts; written unless a newer app owns the file. */
	write(key: TaskKey, surface: TaskSurface): Promise<void> {
		return this.queue(key, () => this.writeNow(key, surface));
	}
	/**
	 * Main's own fact of a tab changed without the renderer's surface changing — a page's Desktop / Mobile
	 * (spec/task-window-workspace#restore-window): the last surface written is written again with it, after the writes queued before.
	 */
	refresh(key: TaskKey): Promise<void> {
		return this.queue(key, async () => {
			const known = this.known.get(taskName(key));
			if (known) await this.writeNow(key, known);
		});
	}
	private async writeNow(key: TaskKey, surface: TaskSurface): Promise<void> {
		if (this.foreign.has(taskName(key))) return;
		const before = this.known.get(taskName(key)),
			earlier = new Map<string, SurfaceTab>();
		for (const tab of before ? surfaceTabs(before) : [])
			earlier.set(
				tab.kind === 'terminal' ? `t:${tab.session}` : tab.kind === 'browser' ? `b:${tab.tab}` : '',
				tab
			);
		const tabs = surfaceTabs(surface),
			live = tabs.some((tab) => tab.kind === 'terminal') ? await this.sources.terminals(key) : null,
			device = tabs.some((tab) => tab.kind === 'simulator')
				? await this.sources.device(key.projectId).catch(() => null)
				: null;
		const stored = mapSurfaceTabs(surface, (tab): SurfaceTab | null => {
			switch (tab.kind) {
				case 'file': {
					const path = tab.id ? this.sources.filePath(key, tab.id) : tab.path;
					if (!path) return null;
					return { kind: 'file', path, ...(tab.place ? { place: tab.place } : {}) };
				}
				case 'terminal': {
					const info = live?.find((item) => item.id === tab.session),
						old = earlier.get(`t:${tab.session}`);
					return {
						...tab,
						directory: info
							? (info.directory ?? null)
							: old?.kind === 'terminal'
								? old.directory
								: tab.directory,
					};
				}
				case 'browser': {
					const page = this.sources.browser(key, tab.tab),
						old = earlier.get(`b:${tab.tab}`);
					const url = page?.url || (old?.kind === 'browser' ? old.url : '') || tab.url;
					return {
						...tab,
						url,
						title: page?.title || tab.title,
						mobile: page ? page.mobile : old?.kind === 'browser' ? old.mobile : tab.mobile,
					};
				}
				case 'simulator':
					return { ...tab, device: device ?? tab.device };
				default:
					return tab;
			}
		});
		const dir = await this.dir(key);
		await mkdir(dir, { recursive: true, mode: 0o700 });
		// A newer app may have written the file meanwhile (two copies): its schema is still not ours to overwrite.
		try {
			const version = surfaceVersionOf(
				await readJson(await safePath(dir, 'surface.json'), surfaceLimit)
			);
			if (version !== null && version !== surfaceSchemaVersion) {
				this.foreign.add(taskName(key));
				return;
			}
		} catch {
			/* missing or unreadable: ours to write */
		}
		await atomicJson(await safePath(dir, 'surface.json'), {
			schemaVersion: surfaceSchemaVersion,
			surface: stored,
		});
		this.known.set(taskName(key), stored);
	}
	/** spec/task-window-workspace#restore-window: the task's unsaved buffers at quit — the folder holds exactly these afterwards. */
	writeDrafts(key: TaskKey, drafts: SurfaceDraft[]): Promise<void> {
		return this.queue(key, async () => {
			const dir = await this.dir(key),
				folder = await safePath(dir, 'drafts');
			const wanted = new Map<string, SurfaceDraft>();
			for (const draft of drafts) {
				const path = draft.id ? this.sources.filePath(key, draft.id) : null;
				if (!path) continue;
				const { id: _id, ...rest } = draft;
				wanted.set(draftName(path), { ...rest, path });
			}
			let names: string[] = [];
			try {
				names = await readdir(folder);
			} catch (error) {
				if (!missing(error)) throw error;
			}
			for (const name of names)
				if (/^[a-f0-9]{32}\.json$/.test(name) && !wanted.has(name))
					await rm(await safePath(folder, name), { force: true });
			if (!wanted.size) return;
			await mkdir(folder, { recursive: true, mode: 0o700 });
			for (const [name, draft] of wanted)
				await atomicJson(await safePath(folder, name), {
					schemaVersion: surfaceSchemaVersion,
					draft,
				});
		});
	}
}
