import { rm } from 'node:fs/promises';
import { SessionStore, readDocument, safePath } from '@brigadir/persistence';

/**
 * spec/task-window-workspace#restore-window: Desktop / Mobile belongs to a browser tab («task#tab»), not to the app. A tab keeps
 * its mode while the cache closes its view (spec/browser-and-simulator#background) and over a restart (`surface.json`); a new tab starts Desktop.
 *
 * Migration: an older app-wide `browser-preferences.json` is read once. Its mode goes to the tabs a restart brings
 * back in this run — an older `surface.json` wrote that same setting into each tab, more exactly than its own record,
 * which said Desktop for a page that was never on screen. The file then leaves the disk; one of another schemaVersion is
 * neither read nor touched.
 */
export class BrowserModes {
	private modes = new Map<string, boolean>();
	private legacy: Promise<boolean | null> | null = null;
	private removing: Promise<unknown> = Promise.resolve();
	constructor(readonly dataDir: string | undefined) {}
	/** The tab's mode: its own, else Desktop. */
	of(id: string) {
		return this.modes.get(id) ?? false;
	}
	/** The tab has a mode of its own (chosen, or brought back by a restart). */
	has(id: string) {
		return this.modes.has(id);
	}
	set(id: string, mobile: boolean) {
		this.modes.set(id, mobile);
	}
	/** The tab is gone (closed, or its task discarded): a tab with the same name later starts Desktop. */
	forget(id: string) {
		this.modes.delete(id);
	}
	/** Tabs a restart brought back with the mode `surface.json` kept; a tab this run already knows keeps its own. */
	async restore(tabs: { id: string; mobile: boolean }[]) {
		if (!tabs.length) return;
		const legacy = await this.readLegacy();
		for (const { id, mobile } of tabs)
			if (!this.modes.has(id)) this.modes.set(id, legacy ?? mobile);
	}
	/** Resolves once the old preferences file is gone (or kept, when it is not ours to remove). */
	settled() {
		return this.removing;
	}
	private readLegacy() {
		return (this.legacy ??= (async () => {
			let path: string;
			try {
				path = await safePath(
					(await SessionStore.at(this.dataDir)).root,
					'browser-preferences.json'
				);
			} catch {
				return null;
			}
			let mobile: boolean | null = null;
			try {
				const doc = await readDocument(path);
				if (typeof doc.mobile !== 'boolean') return null;
				mobile = doc.mobile;
			} catch {
				// Missing, unreadable or a newer schema: nothing to migrate, and the file stays as it is.
				return null;
			}
			this.removing = rm(path, { force: true }).catch(() => {});
			await this.removing;
			return mobile;
		})());
	}
}
