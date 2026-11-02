import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppUpdateState, AppUpdateSupport } from '@brigadir/core';
import {
	AppUpdates,
	compareVersions,
	hostNeedsReplacing,
	updateSupport,
	type UpdateDriver,
} from './app-updates';

type World = {
	updates: AppUpdates;
	driver: UpdateDriver & {
		checks: number;
		downloads: number;
		restarts: number;
		quitInstalls: number;
	};
	states: AppUpdateState[];
	turns: { count: number };
	settings: { autoDownload: boolean };
	relaunching: { value: boolean };
};
function world(
	options: {
		support?: AppUpdateSupport;
		latest?: string | null | Error;
		download?: Error;
		current?: string;
	} = {}
): World {
	const turns = { count: 0 },
		settings = { autoDownload: true },
		relaunching = { value: false },
		states: AppUpdateState[] = [];
	const driver = {
		checks: 0,
		downloads: 0,
		restarts: 0,
		quitInstalls: 0,
		async check() {
			driver.checks++;
			const latest = options.latest === undefined ? '1.1.0' : options.latest;
			if (latest instanceof Error) throw latest;
			return latest;
		},
		async download(progress: (percent: number) => void) {
			driver.downloads++;
			progress(42.7);
			if (options.download) throw options.download;
		},
		restart() {
			driver.restarts++;
		},
		async installOnQuit() {
			driver.quitInstalls++;
		},
	};
	const updates = new AppUpdates(
		{
			support: options.support ?? 'install',
			current: options.current ?? '1.0.0',
			driver,
			releaseUrl: (version) => `https://github.com/acme/releases/releases/tag/v${version}`,
			autoDownload: () => settings.autoDownload,
			runningTurns: async () => turns.count,
			relaunching: () => relaunching.value,
			changed: (state) => {
				states.push(state);
			},
			log: () => {},
		},
		{ first: 60_000, every: 6 * 60 * 60_000, turnsDebounce: 500 },
		() => Date.parse('2026-10-30T10:00:00Z')
	);
	return { updates, driver, states, turns, settings, relaunching };
}
afterEach(() => {
	vi.useRealTimers();
});

describe('versions and gating', () => {
	it('compares semantic versions numerically, a pre-release below its release', () => {
		expect(compareVersions('1.10.0', '1.9.3')).toBe(1);
		expect(compareVersions('1.2.0', '1.2.0')).toBe(0);
		expect(compareVersions('v1.2.1', '1.2.0')).toBe(1);
		expect(compareVersions('1.3.0-beta.1', '1.3.0')).toBe(-1);
		expect(compareVersions('2.0.0', '10.0.0')).toBe(-1);
	});
	it('replaces a host of another version, an unversioned host, and nothing in development', () => {
		expect(hostNeedsReplacing('1.0.0', '1.1.0')).toBe(true);
		expect(hostNeedsReplacing(undefined, '1.1.0')).toBe(true);
		expect(hostNeedsReplacing('1.1.0', '1.1.0')).toBe(false);
		expect(hostNeedsReplacing('1.0.0', null)).toBe(false);
		expect(hostNeedsReplacing(undefined, null)).toBe(false);
	});
	it('never checks in development or without a releases repository; installs only where it can', () => {
		const build = {
			packaged: true,
			platform: 'darwin' as NodeJS.Platform,
			configured: true,
			developerId: true,
			appImage: false,
		};
		expect(updateSupport(build)).toBe('install');
		expect(updateSupport({ ...build, packaged: false })).toBe('off');
		expect(updateSupport({ ...build, configured: false })).toBe('off');
		expect(updateSupport({ ...build, developerId: false })).toBe('notify');
		expect(updateSupport({ ...build, platform: 'linux', developerId: false, appImage: true })).toBe(
			'install'
		);
		expect(updateSupport({ ...build, platform: 'linux', appImage: false })).toBe('notify');
		expect(updateSupport({ ...build, platform: 'win32' })).toBe('off');
	});
});

describe('scheduling', () => {
	it('checks a minute after start and then every six hours', async () => {
		vi.useFakeTimers();
		const w = world({ latest: null });
		w.updates.start();
		await vi.advanceTimersByTimeAsync(59_000);
		expect(w.driver.checks).toBe(0);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(w.driver.checks).toBe(1);
		await vi.advanceTimersByTimeAsync(6 * 60 * 60_000 - 60_000);
		expect(w.driver.checks).toBe(2);
		await vi.advanceTimersByTimeAsync(6 * 60 * 60_000);
		expect(w.driver.checks).toBe(3);
		w.updates.stop();
		await vi.advanceTimersByTimeAsync(12 * 60 * 60_000);
		expect(w.driver.checks).toBe(3);
	});
	it('schedules nothing and checks nothing when the build does not update', async () => {
		vi.useFakeTimers();
		const w = world({ support: 'off' });
		w.updates.start();
		await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
		await w.updates.check(true);
		expect(w.driver.checks).toBe(0);
		expect(w.updates.status().phase).toBe('idle');
	});
	it('joins a check already going', async () => {
		const w = world({ latest: null });
		await Promise.all([w.updates.check(true), w.updates.check(false)]);
		expect(w.driver.checks).toBe(1);
	});
});

describe('checking and downloading', () => {
	it('downloads a newer version in the background and is ready, never showing a bare «available»', async () => {
		const w = world();
		const state = await w.updates.check(false);
		expect(state).toMatchObject({ phase: 'ready', version: '1.1.0', progress: null });
		expect(w.driver.downloads).toBe(1);
		expect(w.states.map((s) => s.phase)).not.toContain('available');
		expect(w.states.some((s) => s.phase === 'downloading' && s.progress === 42)).toBe(true);
	});
	it('only announces a version when the background download is off, and downloads on request', async () => {
		const w = world();
		w.settings.autoDownload = false;
		expect((await w.updates.check(false)).phase).toBe('available');
		expect(w.driver.downloads).toBe(0);
		expect((await w.updates.download()).phase).toBe('ready');
	});
	it('downloads once the switch is turned on while a version waits', async () => {
		const w = world();
		w.settings.autoDownload = false;
		await w.updates.check(false);
		w.settings.autoDownload = true;
		w.updates.settingsChanged();
		await vi.waitFor(() => expect(w.updates.status().phase).toBe('ready'));
	});
	it('a build that only notifies never downloads; the release page is known', async () => {
		const w = world({ support: 'notify' });
		const state = await w.updates.check(false);
		expect(state).toMatchObject({
			phase: 'available',
			releaseUrl: 'https://github.com/acme/releases/releases/tag/v1.1.0',
		});
		await w.updates.download();
		expect(w.driver.downloads).toBe(0);
	});
	it('ignores a published version that is not newer and answers a manual check', async () => {
		const w = world({ latest: '1.0.0' });
		const state = await w.updates.check(true);
		expect(state.phase).toBe('idle');
		expect(state.lastCheck).toMatchObject({ manual: true, outcome: 'current' });
		expect(state.checkedAt).toBe('2026-10-30T10:00:00.000Z');
	});
	it('keeps a failed check and a failed download as errors', async () => {
		const failed = world({ latest: new Error('offline') });
		expect(await failed.updates.check(true)).toMatchObject({
			phase: 'error',
			failed: 'check',
			lastCheck: { manual: true, outcome: 'failed' },
		});
		const broken = world({ download: new Error('disk full') });
		expect(await broken.updates.check(false)).toMatchObject({ phase: 'error', failed: 'download' });
	});
	it('does not check again once a version is downloaded; a manual check answers «ready»', async () => {
		const w = world();
		await w.updates.check(false);
		const state = await w.updates.check(true);
		expect(w.driver.checks).toBe(1);
		expect(state.lastCheck).toMatchObject({ manual: true, outcome: 'ready' });
	});
});

describe('installing never interrupts a turn', () => {
	it('restarts at once when no turn runs', async () => {
		const w = world();
		await w.updates.check(false);
		await w.updates.install();
		expect(w.driver.restarts).toBe(1);
	});
	it('waits for running turns, says how many, and restarts when they end', async () => {
		vi.useFakeTimers();
		const w = world();
		await w.updates.check(false);
		w.turns.count = 2;
		expect((await w.updates.install()).waitingTurns).toBe(2);
		expect(w.driver.restarts).toBe(0);
		w.turns.count = 1;
		w.updates.turnsChanged();
		await vi.advanceTimersByTimeAsync(500);
		expect(w.updates.status().waitingTurns).toBe(1);
		w.turns.count = 0;
		w.updates.turnsChanged();
		await vi.advanceTimersByTimeAsync(500);
		expect(w.updates.status().waitingTurns).toBeNull();
		expect(w.driver.restarts).toBe(1);
	});
	it('a cancelled wait does not restart when the turns end', async () => {
		vi.useFakeTimers();
		const w = world();
		await w.updates.check(false);
		w.turns.count = 1;
		await w.updates.install();
		w.updates.cancelRestart();
		w.turns.count = 0;
		w.updates.turnsChanged();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(w.driver.restarts).toBe(0);
	});
	it('a restart before anything is downloaded does nothing', async () => {
		const w = world({ support: 'notify' });
		await w.updates.check(false);
		await w.updates.install();
		expect(w.driver.restarts).toBe(0);
	});
	it('installs on quit only when no turn runs, and asks only once per quit', async () => {
		const idle = world();
		await idle.updates.check(false);
		expect(idle.updates.quitPending()).toBe(true);
		await idle.updates.prepareQuit();
		expect(idle.driver.quitInstalls).toBe(1);
		expect(idle.updates.quitPending()).toBe(false);

		const busy = world();
		await busy.updates.check(false);
		busy.turns.count = 1;
		await busy.updates.prepareQuit();
		expect(busy.driver.quitInstalls).toBe(0);
		expect(busy.updates.quitPending()).toBe(false);
	});
	it('does not install on quit while the app restarts for its language, nor when it only notifies', async () => {
		const language = world();
		await language.updates.check(false);
		language.relaunching.value = true;
		expect(language.updates.quitPending()).toBe(false);
		const notify = world({ support: 'notify' });
		await notify.updates.check(false);
		expect(notify.updates.quitPending()).toBe(false);
	});
	it('a failed install is an error and lets the person try again', async () => {
		const w = world();
		await w.updates.check(false);
		await w.updates.install();
		w.updates.failed(new Error('Code signature did not match'));
		expect(w.updates.status()).toMatchObject({ phase: 'error', failed: 'install' });
		expect((await w.updates.check(true)).phase).toBe('ready');
		expect(w.driver.checks).toBe(2);
	});
});
