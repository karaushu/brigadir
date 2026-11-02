import { watch, type FSWatcher } from 'node:fs';
import {
	defaultModules,
	isAppModules,
	isRecord,
	sameModules,
	withModuleDefaults,
	type AppModules,
} from '@brigadir/core';
import { readDocument, safePath } from '@brigadir/persistence';
/**
 * spec/settings-modules-and-onboarding#modules: which modules are on, read from the app's `settings.json` the way `crew.ts` reads `agents.maxConcurrent`.
 * The host watches the file itself, so a switch in Settings reaches every open MCP session (`tools/list_changed`)
 * without a new message from the app. An unreadable or missing file means the defaults.
 */
export class ModuleSettings {
	private value: AppModules = { ...defaultModules };
	private listeners = new Set<(value: AppModules) => void>();
	private watcher: FSWatcher | null = null;
	private timer: NodeJS.Timeout | null = null;
	constructor(private root: string) {}
	current() {
		return this.value;
	}
	async load() {
		let next: AppModules = { ...defaultModules };
		try {
			const doc = await readDocument(await safePath(this.root, 'settings.json'));
			const modules = isRecord(doc.settings) ? withModuleDefaults(doc.settings.modules) : null;
			if (isAppModules(modules)) next = { ...modules };
		} catch {
			/* No settings: the defaults. */
		}
		if (sameModules(next, this.value)) return false;
		this.value = next;
		for (const listener of this.listeners) listener(next);
		return true;
	}
	/** Settings are written by an atomic rename, so the directory is watched, not the file. */
	start() {
		if (this.watcher) return;
		try {
			this.watcher = watch(this.root, { persistent: false }, (_event, name) => {
				if (name !== 'settings.json') return;
				if (this.timer) clearTimeout(this.timer);
				this.timer = setTimeout(() => {
					this.timer = null;
					void this.load();
				}, 50);
				this.timer.unref();
			});
			this.watcher.on('error', () => {
				this.watcher?.close();
				this.watcher = null;
			});
		} catch {
			/* No watch: modules keep the value read at start. */
		}
	}
	subscribe(listener: (value: AppModules) => void) {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	close() {
		this.watcher?.close();
		this.watcher = null;
		if (this.timer) clearTimeout(this.timer);
		this.listeners.clear();
	}
}
