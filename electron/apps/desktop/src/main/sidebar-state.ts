import { mkdir } from 'node:fs/promises';
import { isId, isRecord, isSidebarSelection, type SidebarSelection } from '@brigadir/core';
export { isSidebarSelection, type SidebarSelection };
import { SessionStore, readDocument, safePath, atomicJson } from '@brigadir/persistence';
type SidebarDocument = {
	collapsed: string[];
	archiveOpen: string[];
	crewCollapsed: string[];
	completedCollapsed: string[];
	selected: SidebarSelection | null;
};
const selection = (value: unknown): SidebarSelection | null => {
	if (value === undefined || value === null) return null;
	if (
		!isRecord(value) ||
		!(value.project === '*' || isId(value.project)) ||
		(value.task !== undefined && (!isId(value.task) || value.project === '*'))
	)
		throw new Error('Invalid sidebar state: selected');
	return value.task === undefined
		? { project: value.project as string }
		: { project: value.project as string, task: value.task as string };
};
const ids = (value: unknown, field: string) => {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > 10000 || !value.every(isId))
		throw new Error(`Invalid sidebar state: ${field}`);
	return [...new Set(value as string[])];
};
/**
 * Only disclosure choices persist; filters stay transient and never hide work on a fresh launch.
 * `collapsed` — projects folded in the sidebar; `archiveOpen` — projects whose «Archive · N» section is open (spec/tasks#archive, closed by default);
 * `crewCollapsed` — foreman tasks whose crew card is folded (spec/sidebar#crew-collapse): the choice outlives opening, switching and relaunch;
 * `completedCollapsed` — projects whose completed tasks are folded under «Completed · N» (spec/sidebar#completed-fold);
 * `selected` — the project and task open last, reopened on the next launch (spec/sidebar#open-last).
 */
export class SidebarState {
	private tail: Promise<unknown> = Promise.resolve();
	private pending = 0;
	constructor(private dataDir?: string) {}
	get isSaving() {
		return this.pending > 0;
	}
	waitForWrites() {
		return this.tail;
	}
	private async document(): Promise<SidebarDocument> {
		const store = await SessionStore.at(this.dataDir);
		try {
			const doc = await readDocument(await safePath(store.root, 'sidebar.json'));
			return {
				collapsed: ids(doc.collapsed, 'collapsed'),
				archiveOpen: ids(doc.archiveOpen, 'archiveOpen'),
				crewCollapsed: ids(doc.crewCollapsed, 'crewCollapsed'),
				completedCollapsed: ids(doc.completedCollapsed, 'completedCollapsed'),
				selected: selection(doc.selected),
			};
		} catch (error) {
			if (isRecord(error) && error.code === 'ENOENT')
				return {
					collapsed: [],
					archiveOpen: [],
					crewCollapsed: [],
					completedCollapsed: [],
					selected: null,
				};
			throw error;
		}
	}
	private async write(store: SessionStore, doc: SidebarDocument) {
		await mkdir(store.root, { recursive: true, mode: 0o700 });
		await atomicJson(await safePath(store.root, 'sidebar.json'), {
			schemaVersion: 1,
			collapsed: doc.collapsed,
			...(doc.archiveOpen.length ? { archiveOpen: doc.archiveOpen } : {}),
			...(doc.crewCollapsed.length ? { crewCollapsed: doc.crewCollapsed } : {}),
			...(doc.completedCollapsed.length ? { completedCollapsed: doc.completedCollapsed } : {}),
			...(doc.selected ? { selected: doc.selected } : {}),
		});
	}
	async read(): Promise<string[]> {
		return (await this.document()).collapsed;
	}
	async readArchive(): Promise<string[]> {
		return (await this.document()).archiveOpen;
	}
	async readCrews(): Promise<string[]> {
		return (await this.document()).crewCollapsed;
	}
	async readCompleted(): Promise<string[]> {
		return (await this.document()).completedCollapsed;
	}
	async readSelection(): Promise<SidebarSelection | null> {
		return (await this.document()).selected;
	}
	private change(
		id: string,
		field: 'collapsed' | 'archiveOpen' | 'crewCollapsed' | 'completedCollapsed',
		on: boolean
	): Promise<string[]> {
		if (!isId(id)) throw new Error(field === 'crewCollapsed' ? 'Invalid task' : 'Invalid project');
		this.pending++;
		const work = this.tail
			.catch(() => {})
			.then(async () => {
				const store = await SessionStore.at(this.dataDir);
				if (field !== 'crewCollapsed') await store.project(id);
				const doc = await this.document(),
					values = new Set(doc[field]);
				if (on) values.add(id);
				else values.delete(id);
				const next = { ...doc, [field]: [...values].sort() };
				await this.write(store, next);
				return next[field];
			})
			.finally(() => this.pending--);
		this.tail = work;
		return work;
	}
	/** The project and task open now; unchanged, nothing is written. */
	select(value: SidebarSelection): Promise<void> {
		this.pending++;
		const work = this.tail
			.catch(() => {})
			.then(async () => {
				const store = await SessionStore.at(this.dataDir),
					doc = await this.document();
				if (JSON.stringify(doc.selected) === JSON.stringify(value)) return;
				await this.write(store, { ...doc, selected: value });
			})
			.finally(() => this.pending--);
		this.tail = work;
		return work;
	}
	set(id: string, collapsed: boolean) {
		return this.change(id, 'collapsed', collapsed);
	}
	setArchive(id: string, open: boolean) {
		return this.change(id, 'archiveOpen', open);
	}
	setCrew(id: string, collapsed: boolean) {
		return this.change(id, 'crewCollapsed', collapsed);
	}
	setCompleted(id: string, collapsed: boolean) {
		return this.change(id, 'completedCollapsed', collapsed);
	}
}
