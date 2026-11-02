import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// electron-updater and Electron's own autoUpdater are replaced: the driver is checked for what it asks of them.
const made: FakeUpdater[] = [];
class FakeUpdater extends EventEmitter {
	kind: string;
	autoDownload = true;
	autoInstallOnAppQuit = true;
	autoRunAppAfterInstall = true;
	logger: unknown = null;
	feed: unknown = null;
	latest: { isUpdateAvailable: boolean; updateInfo: { version: string } } | null = {
		isUpdateAvailable: true,
		updateInfo: { version: '1.1.0' },
	};
	calls: string[] = [];
	constructor(kind: string) {
		super();
		this.kind = kind;
		made.push(this);
	}
	setFeedURL(feed: unknown) {
		this.feed = feed;
	}
	async checkForUpdates() {
		this.calls.push('check');
		return this.latest;
	}
	async downloadUpdate() {
		this.calls.push('download');
		this.emit('download-progress', { percent: 50 });
		return [];
	}
	quitAndInstall(...args: unknown[]) {
		this.calls.push(`quitAndInstall(${args.join(',')}) run=${this.autoRunAppAfterInstall}`);
	}
	install(...args: unknown[]) {
		this.calls.push(`install(${args.join(',')})`);
		this.emit('appimage-filename-updated', '/home/me/Apps/Brigadir-1.1.0-x86_64.AppImage');
		return true;
	}
}
const native = new EventEmitter();
vi.mock('electron', () => ({ autoUpdater: native }));
vi.mock('electron-updater', () => ({
	MacUpdater: class extends FakeUpdater {
		constructor() {
			super('mac');
		}
	},
	AppImageUpdater: class extends FakeUpdater {
		constructor() {
			super('appimage');
		}
	},
	DebUpdater: class extends FakeUpdater {
		constructor() {
			super('deb');
		}
	},
}));
const { appBundle, createUpdateDriver, developerIdSigned } = await import('./app-updater');

function driver(platform: NodeJS.Platform, appImage?: string, feedUrl?: string) {
	const relaunch: { path: (() => string | undefined) | null } = { path: null };
	const failures: unknown[] = [];
	const result = createUpdateDriver({
		platform,
		appImage,
		feedUrl,
		log: () => {},
		relaunchAfterQuit: (path) => {
			relaunch.path = path;
		},
		failed: (error) => failures.push(error),
	});
	return { driver: result, updater: made.at(-1)!, relaunch, failures };
}
beforeEach(() => {
	made.length = 0;
	native.removeAllListeners();
});

describe('update driver', () => {
	it('picks Squirrel.Mac, the AppImage updater, or a check-only updater for .deb and .rpm', () => {
		expect(driver('darwin').updater.kind).toBe('mac');
		expect(driver('linux', '/home/me/Brigadir.AppImage').updater.kind).toBe('appimage');
		expect(driver('linux').updater.kind).toBe('deb');
	});
	it('never downloads or installs on its own, and takes a test feed', () => {
		const { updater } = driver('darwin', undefined, 'http://127.0.0.1:8080/');
		expect(updater.autoDownload).toBe(false);
		expect(updater.autoInstallOnAppQuit).toBe(false);
		expect(updater.feed).toEqual({ provider: 'generic', url: 'http://127.0.0.1:8080/' });
		expect(driver('darwin').updater.feed).toBeNull();
	});
	it('answers only a version that is available, and reports download progress', async () => {
		const { driver: d, updater } = driver('darwin');
		expect(await d.check()).toBe('1.1.0');
		updater.latest = { isUpdateAvailable: false, updateInfo: { version: '1.0.0' } };
		expect(await d.check()).toBeNull();
		updater.latest = null;
		expect(await d.check()).toBeNull();
		const progress: number[] = [];
		await d.download((percent) => progress.push(percent));
		expect(progress).toEqual([50]);
	});
	it('macOS restarts through Squirrel.Mac, which reopens the app', () => {
		const { driver: d, updater, relaunch } = driver('darwin');
		d.restart();
		expect(updater.calls).toEqual(['quitAndInstall() run=true']);
		expect(relaunch.path).toBeNull();
	});
	it('macOS installs on quit once Squirrel.Mac has the update, without reopening', async () => {
		const { driver: d, updater } = driver('darwin');
		let done = false;
		const staged = d.installOnQuit().then(() => {
			done = true;
		});
		await Promise.resolve();
		expect(updater.calls).toEqual(['quitAndInstall() run=false']);
		expect(done).toBe(false);
		native.emit('update-downloaded');
		await staged;
		expect(done).toBe(true);
	});
	it('an AppImage installs silently and relaunches from the installed file after the quit', async () => {
		const {
			driver: d,
			updater,
			relaunch,
		} = driver('linux', '/home/me/Apps/Brigadir-1.0.0-x86_64.AppImage');
		d.restart();
		expect(updater.calls).toEqual(['quitAndInstall(true,false) run=true']);
		updater.install(true, false);
		expect(relaunch.path?.()).toBe('/home/me/Apps/Brigadir-1.1.0-x86_64.AppImage');
		const quit = driver('linux', '/home/me/Brigadir.AppImage');
		await quit.driver.installOnQuit();
		expect(quit.updater.calls).toEqual(['install(true,false)']);
	});
	it('forwards errors outside a check or download', () => {
		const { updater, failures } = driver('darwin');
		updater.emit('error', new Error('Could not get code signature for running application'));
		expect(failures).toHaveLength(1);
	});
});

describe('macOS signature', () => {
	it('finds the bundle of the running executable', () => {
		expect(appBundle('/Applications/Brigadir.app/Contents/MacOS/Brigadir')).toBe(
			'/Applications/Brigadir.app'
		);
	});
	it('installs only into a Developer ID app; ad-hoc builds only notify', () => {
		expect(
			developerIdSigned(
				'Executable=/Applications/Brigadir.app/Contents/MacOS/Brigadir\nAuthority=Developer ID Application: Acme Inc (TEAM123456)\nAuthority=Developer ID Certification Authority\nTeamIdentifier=TEAM123456'
			)
		).toBe(true);
		expect(
			developerIdSigned(
				'Executable=/Applications/Brigadir.app/Contents/MacOS/Brigadir\nSignature=adhoc\nTeamIdentifier=not set'
			)
		).toBe(false);
	});
});
