import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isRecord, type BrowserNotificationPermission } from '@brigadir/core';
import { SessionStore, readDocument, atomicJson, safePath } from '@brigadir/persistence';
/** spec/browser-and-simulator#notifications: the person's decisions for the notifications of the project's domains. */
export type NotificationSites = Record<string, 'granted' | 'denied'>;
const file = 'browser-notifications.json';
const limit = 1000;
const validSites = (value: unknown): value is NotificationSites =>
	isRecord(value) &&
	Object.keys(value).length <= limit &&
	Object.values(value).every((state) => state === 'granted' || state === 'denied');
/** One file a project, read once and kept in memory; writes go one after another. */
export class BrowserNotificationSites {
	private cache = new Map<string, Promise<NotificationSites>>();
	private writes: Promise<unknown> = Promise.resolve();
	constructor(private dataDir: string | undefined) {}
	private async path(projectId: string) {
		const store = await SessionStore.at(this.dataDir);
		return safePath(store.root, `projects/${projectId}/${file}`);
	}
	/** Known synchronously once read: the page script's state is built without waiting. */
	readonly loaded = new Map<string, NotificationSites>();
	of(projectId: string): Promise<NotificationSites> {
		let sites = this.cache.get(projectId);
		if (!sites) {
			sites = this.path(projectId)
				.then(readDocument)
				.then((doc) => {
					if (!validSites(doc.sites)) throw new Error('Invalid browser notification sites');
					return { ...doc.sites };
				})
				// No file yet, or a broken one: the pages ask again rather than the browser stops.
				.catch((): NotificationSites => ({}))
				.then((value) => {
					this.loaded.set(projectId, value);
					return value;
				});
			this.cache.set(projectId, sites);
		}
		return sites;
	}
	/** `default` forgets the domain: the page asks again. */
	set(projectId: string, host: string, permission: BrowserNotificationPermission) {
		const result = this.writes.then(async () => {
			const sites = { ...(await this.of(projectId)) };
			if (permission === 'default') delete sites[host];
			else {
				if (!(host in sites) && Object.keys(sites).length >= limit)
					throw new Error('Browser notification site limit reached');
				sites[host] = permission;
			}
			const path = await this.path(projectId);
			await mkdir(dirname(path), { recursive: true });
			await atomicJson(path, { schemaVersion: 1, sites });
			this.loaded.set(projectId, sites);
			this.cache.set(projectId, Promise.resolve(sites));
			return sites;
		});
		this.writes = result.catch(() => {});
		return result;
	}
}
/** What the page script reports of a shown notification, checked like any page input. */
export type PageNotice = { id: number; title: string; body: string; tag: string };
export function pageNotice(value: Record<string, unknown>): PageNotice | null {
	if (
		!Number.isSafeInteger(value.id) ||
		Number(value.id) < 1 ||
		typeof value.title !== 'string' ||
		typeof value.body !== 'string' ||
		typeof value.tag !== 'string'
	)
		return null;
	return {
		id: Number(value.id),
		title: value.title.slice(0, 200),
		body: value.body.slice(0, 1000),
		tag: value.tag.slice(0, 200),
	};
}
/** spec/browser-and-simulator#notifications: one notification a second from a tab; the rest within that second is dropped. */
export const pageNoticeGapMs = 1000;
