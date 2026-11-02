import { isNotificationPermission, type NotificationPermission } from '@brigadir/core';
export interface AuthorizationSource {
	status(): Promise<unknown>;
	request(): Promise<unknown>;
}
/**
 * spec/notifications-slack-notes-and-schedules#macos-permission: the app's macOS notification authorization. Reads are shared while in flight;
 * a request happens only on the first need (a notice about to show) or the person's own click.
 */
export class NotificationPermissionState {
	private value: NotificationPermission = 'unknown';
	private reading: Promise<NotificationPermission> | null = null;
	private requesting: Promise<NotificationPermission> | null = null;
	constructor(
		private source: AuthorizationSource | null,
		private changed: (value: NotificationPermission) => void
	) {}
	get current() {
		return this.value;
	}
	refresh(): Promise<NotificationPermission> {
		if (!this.source) return Promise.resolve(this.value);
		return (this.reading ??= this.source
			.status()
			.then(
				(value) => this.set(value),
				() => this.value
			)
			.finally(() => {
				this.reading = null;
			}));
	}
	request(): Promise<NotificationPermission> {
		if (!this.source) return Promise.resolve(this.value);
		return (this.requesting ??= this.source
			.request()
			.then(
				(value) => this.set(value),
				() => this.value
			)
			.finally(() => {
				this.requesting = null;
			}));
	}
	/** A notice may show unless macOS said no; `unknown` leaves delivery to Electron as before. */
	async ensure(): Promise<boolean> {
		let value = await this.refresh();
		if (value === 'not-determined') value = await this.request();
		return value === 'granted' || value === 'unknown';
	}
	private set(value: unknown) {
		const next = isNotificationPermission(value) ? value : 'unknown';
		if (next !== this.value) {
			this.value = next;
			this.changed(next);
		}
		return next;
	}
}
/** The addon lives next to the other services; any other platform or a missing build reads as `unknown`. */
export function nativeAuthorization(path: string): AuthorizationSource | null {
	if (process.platform !== 'darwin') return null;
	try {
		const module = { exports: {} as AuthorizationSource };
		process.dlopen(module, path);
		return typeof module.exports.status === 'function' &&
			typeof module.exports.request === 'function'
			? module.exports
			: null;
	} catch {
		return null;
	}
}
