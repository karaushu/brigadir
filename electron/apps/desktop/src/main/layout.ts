import { mkdir } from 'node:fs/promises';
import {
	defaultSurfaceLayout,
	isRecord,
	isSidebarSection,
	isSurfaceLayout,
	isWindowBounds,
	type SurfaceLayout,
	type WindowBounds,
} from '@brigadir/core';
import { SessionStore, readDocument, safePath, atomicJson } from '@brigadir/persistence';
export class Layout {
	private writes: Promise<unknown> = Promise.resolve();
	private pending = 0;
	get isSaving() {
		return this.pending > 0;
	}
	waitForWrites() {
		return this.writes;
	}
	constructor(private dataDir?: string) {}
	async read(): Promise<SurfaceLayout> {
		const store = await SessionStore.at(this.dataDir);
		try {
			const doc = await readDocument(await safePath(store.root, 'surface-layout.json'));
			if (!isRecord(doc.layout)) throw new Error('Invalid layout');
			const layout = {
				sidebarWidth: defaultSurfaceLayout.sidebarWidth,
				chatWidth: defaultSurfaceLayout.chatWidth,
				simulatorWidth: defaultSurfaceLayout.simulatorWidth,
				reviewFilesWidth: defaultSurfaceLayout.reviewFilesWidth,
				reviewColumnWidth: defaultSurfaceLayout.reviewColumnWidth,
				composerCapsuleCompact: defaultSurfaceLayout.composerCapsuleCompact,
				sidebarSection: defaultSurfaceLayout.sidebarSection as unknown,
				...doc.layout,
			};
			// spec/sidebar#section-rail: a file from before the rail, or a section this build does not have (a module of a newer one), opens Tasks.
			if (!isSidebarSection(layout.sidebarSection))
				layout.sidebarSection = defaultSurfaceLayout.sidebarSection;
			delete (layout as Record<string, unknown>).composerEnvironmentCollapsed;
			// spec/git#commit-dialog: the commit strip is one row and does not fold; an older file's `commitCollapsed` is dropped.
			delete (layout as Record<string, unknown>).commitCollapsed;
			// spec/task-window-workspace#layout-switch: the two / three columns setting gave way to each task's Layout switch; an older file's value is dropped.
			delete (layout as Record<string, unknown>).columns;
			if (!isSurfaceLayout(layout)) throw new Error('Invalid layout');
			return layout;
		} catch (error) {
			if (isRecord(error) && error.code === 'ENOENT') return { ...defaultSurfaceLayout };
			throw error;
		}
	}
	/** spec/task-window-workspace#restore-window: the app window's last size and place, kept beside the sidebar width; `null` before the first close. */
	async readWindow(): Promise<WindowBounds | null> {
		const store = await SessionStore.at(this.dataDir);
		try {
			const doc = await readDocument(await safePath(store.root, 'surface-layout.json'));
			return isWindowBounds(doc.window) ? doc.window : null;
		} catch {
			return null;
		}
	}
	saveWindow(bounds: WindowBounds) {
		if (!isWindowBounds(bounds)) throw new Error('Invalid window bounds');
		return this.write(async () => ({ layout: await this.read(), window: bounds }));
	}
	save(layout: SurfaceLayout) {
		if (!isSurfaceLayout(layout)) throw new Error('Invalid layout');
		return this.write(async () => ({ layout, window: await this.readWindow() }));
	}
	private write(next: () => Promise<{ layout: SurfaceLayout; window: WindowBounds | null }>) {
		this.pending++;
		const write = this.writes
			.then(async () => {
				await this.read();
				const { layout, window } = await next();
				const store = await SessionStore.at(this.dataDir);
				await mkdir(store.root, { recursive: true, mode: 0o700 });
				await atomicJson(await safePath(store.root, 'surface-layout.json'), {
					schemaVersion: 1,
					layout,
					...(window ? { window } : {}),
				});
			})
			.finally(() => {
				this.pending--;
			});
		this.writes = write.catch(() => {});
		return write;
	}
}
