import {
	appUpdateEvery,
	appUpdateFirstCheck,
	type AppUpdateCheck,
	type AppUpdateState,
	type AppUpdateSupport,
} from '@brigadir/core';
/**
 * spec/architecture-and-platform#auto-update: what installs an update on this platform. `app-updater.ts` builds it on electron-updater; tests
 * pass a fake. `check` answers the newest published version (null: nothing newer); `download` fetches it in the background;
 * `restart` quits and starts the new version; `installOnQuit` makes the quit that follows install it.
 */
export type UpdateDriver = {
	check(): Promise<string | null>;
	download(progress: (percent: number) => void): Promise<void>;
	restart(): void;
	installOnQuit(): Promise<void>;
};
export type AppUpdateDeps = {
	support: AppUpdateSupport;
	current: string;
	/** Null when `support` is `off`. */
	driver: UpdateDriver | null;
	releaseUrl(version: string): string | null;
	/** Settings ▸ Language ▸ Updates ▸ «Download in the background». */
	autoDownload(): boolean;
	/** Agent turns that have not ended (a task `working` or `needs-you`). */
	runningTurns(): Promise<number>;
	/** A restart for the interface language is under way: the quit must not install as well. */
	relaunching(): boolean;
	changed(state: AppUpdateState): void;
	log(line: string): void;
};
export type AppUpdateTimes = { first: number; every: number; turnsDebounce: number };
const defaultTimes: AppUpdateTimes = {
	first: appUpdateFirstCheck,
	every: appUpdateEvery,
	turnsDebounce: 500,
};
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** Numeric `x.y.z` with an optional pre-release; anything else compares as text. */
export function compareVersions(a: string, b: string): number {
	const parse = (value: string) => {
		const [core = '', pre = ''] = value.replace(/^v/, '').split('-', 2);
		return { parts: core.split('.').map((part) => Number(part)), pre };
	};
	const x = parse(a),
		y = parse(b);
	for (let index = 0; index < Math.max(x.parts.length, y.parts.length); index++) {
		const left = x.parts[index] ?? 0,
			right = y.parts[index] ?? 0;
		if (Number.isNaN(left) || Number.isNaN(right)) return a.localeCompare(b);
		if (left !== right) return left < right ? -1 : 1;
	}
	if (x.pre === y.pre) return 0;
	if (!x.pre) return 1;
	if (!y.pre) return -1;
	return x.pre < y.pre ? -1 : 1;
}
/**
 * spec/architecture-and-platform#auto-update: how this build updates. A development build and a build whose `releases` field still holds the
 * placeholder never check (a test feed counts as configured). Squirrel.Mac installs only a Developer ID app, so an ad-hoc one
 * only says that a version exists; on Linux an AppImage installs itself and a `.deb` or `.rpm` only says so.
 */
export function updateSupport(build: {
	packaged: boolean;
	platform: NodeJS.Platform;
	configured: boolean;
	developerId: boolean;
	appImage: boolean;
}): AppUpdateSupport {
	if (!build.packaged || !build.configured) return 'off';
	if (build.platform === 'darwin') return build.developerId ? 'install' : 'notify';
	if (build.platform === 'linux') return build.appImage ? 'install' : 'notify';
	return 'off';
}
/**
 * spec/architecture-and-platform#auto-update: a host whose code comes from another app version is replaced at a turn boundary. `current` is
 * null when the app replaces nothing (a development build). A host without a recorded version predates this check, so it is
 * an older build too.
 */
export function hostNeedsReplacing(hostVersion: string | undefined, current: string | null) {
	return current !== null && hostVersion !== current;
}
/**
 * spec/architecture-and-platform#auto-update: Brigadir's own updates. Checks a minute after start, then every 6 hours and on the menu item; a
 * newer version downloads in the background when the setting allows and the build can install it. The download installs on
 * «Restart to update» or on quit, never while an agent turn runs: a restart waits for the turns, a quit leaves the update for
 * the next one.
 */
export class AppUpdates {
	private state: AppUpdateState;
	private checking: Promise<AppUpdateState> | null = null;
	private downloading: Promise<AppUpdateState> | null = null;
	private first: ReturnType<typeof setTimeout> | null = null;
	private timer: ReturnType<typeof setInterval> | null = null;
	private recount: ReturnType<typeof setTimeout> | null = null;
	private checks = 0;
	/** The quit has decided about the update (installed or left it); a second `before-quit` of the same quit does not ask again. */
	private quitDecided = false;
	private restarting = false;
	constructor(
		private deps: AppUpdateDeps,
		private times: AppUpdateTimes = defaultTimes,
		private now = () => Date.now()
	) {
		this.state = {
			support: deps.support,
			phase: 'idle',
			current: deps.current,
			version: null,
			progress: null,
			checkedAt: null,
			failed: null,
			waitingTurns: null,
			releaseUrl: null,
			lastCheck: null,
		};
	}
	status(): AppUpdateState {
		return structuredClone(this.state);
	}
	private set(patch: Partial<AppUpdateState>) {
		this.state = { ...this.state, ...patch };
		this.deps.changed(this.status());
	}
	private checked(manual: boolean, outcome: AppUpdateCheck['outcome']): AppUpdateCheck {
		return { id: ++this.checks, manual, outcome };
	}
	/** Development builds and builds without a releases repository never schedule anything. */
	start() {
		if (this.state.support === 'off' || this.timer) return;
		this.first = setTimeout(() => {
			void this.check(false);
		}, this.times.first);
		this.first.unref?.();
		this.timer = setInterval(() => {
			void this.check(false);
		}, this.times.every);
		this.timer.unref?.();
	}
	stop() {
		if (this.first) clearTimeout(this.first);
		if (this.timer) clearInterval(this.timer);
		if (this.recount) clearTimeout(this.recount);
		this.first = this.timer = this.recount = null;
	}
	/** The menu item and «Check now» (`manual`) or the timer. A check already going is joined; a downloaded update is not checked again. */
	check(manual: boolean): Promise<AppUpdateState> {
		const driver = this.deps.driver;
		if (this.state.support === 'off' || !driver) return Promise.resolve(this.status());
		if (this.state.phase === 'ready' || this.state.phase === 'downloading') {
			if (manual)
				this.set({
					lastCheck: this.checked(true, this.state.phase === 'ready' ? 'ready' : 'available'),
				});
			return Promise.resolve(this.status());
		}
		if (this.checking) return this.checking;
		const run = (async () => {
			this.set({ phase: 'checking', failed: null });
			let found: string | null;
			try {
				found = await driver.check();
			} catch (error) {
				this.deps.log(`app-update: the check failed: ${message(error)}`);
				this.set({
					phase: 'error',
					failed: 'check',
					checkedAt: new Date(this.now()).toISOString(),
					lastCheck: this.checked(manual, 'failed'),
				});
				return this.status();
			}
			const newer = found && compareVersions(found, this.state.current) > 0 ? found : null;
			const result: Partial<AppUpdateState> = {
				version: newer,
				releaseUrl: newer ? this.deps.releaseUrl(newer) : null,
				checkedAt: new Date(this.now()).toISOString(),
				lastCheck: this.checked(manual, newer ? 'available' : 'current'),
			};
			// A background download goes straight to `downloading`: the window never sees an «available» it need not act on.
			if (newer && this.state.support === 'install' && this.deps.autoDownload())
				return this.download(result);
			this.set({ phase: newer ? 'available' : 'idle', ...result });
			return this.status();
		})().finally(() => {
			this.checking = null;
		});
		this.checking = run;
		return run;
	}
	/** «Download in the background» turned on while a version waits: it downloads now. */
	settingsChanged() {
		if (
			this.state.phase === 'available' &&
			this.state.support === 'install' &&
			this.deps.autoDownload()
		)
			void this.download();
	}
	/** A newer version found: downloads it (`install`) — the person's «Download update» or the background setting; `found` is a check's result. */
	download(found?: Partial<AppUpdateState>): Promise<AppUpdateState> {
		const driver = this.deps.driver;
		if (this.downloading) return this.downloading;
		if (
			!driver ||
			this.state.support !== 'install' ||
			!(found?.version ?? this.state.version) ||
			(!found &&
				this.state.phase !== 'available' &&
				!(this.state.phase === 'error' && this.state.failed === 'download'))
		)
			return Promise.resolve(this.status());
		const run = (async () => {
			this.set({ ...found, phase: 'downloading', progress: 0, failed: null });
			try {
				await driver.download((percent) => {
					const rounded = Math.floor(percent);
					if (this.state.phase === 'downloading' && rounded !== this.state.progress)
						this.set({ progress: rounded });
				});
			} catch (error) {
				this.deps.log(
					`app-update: the download of ${this.state.version} failed: ${message(error)}`
				);
				this.set({ phase: 'error', failed: 'download', progress: null });
				return this.status();
			}
			this.set({ phase: 'ready', progress: null });
			return this.status();
		})().finally(() => {
			this.downloading = null;
		});
		this.downloading = run;
		return run;
	}
	/** «Restart to update»: now when no turn runs; otherwise the restart waits for the running turns and says how many. */
	async install(): Promise<AppUpdateState> {
		if (this.state.phase !== 'ready' || this.restarting) return this.status();
		const turns = await this.deps.runningTurns().catch(() => 1);
		if (turns > 0) {
			this.set({ waitingTurns: turns });
			return this.status();
		}
		this.restart();
		return this.status();
	}
	cancelRestart(): AppUpdateState {
		if (this.state.waitingTurns !== null) this.set({ waitingTurns: null });
		return this.status();
	}
	/** A session event that may end or start a turn: a restart that waits counts again after a short quiet. */
	turnsChanged() {
		if (this.state.waitingTurns === null || this.recount) return;
		this.recount = setTimeout(() => {
			this.recount = null;
			void this.recountTurns();
		}, this.times.turnsDebounce);
		this.recount.unref?.();
	}
	private async recountTurns() {
		if (this.state.waitingTurns === null) return;
		const turns = await this.deps.runningTurns().catch(() => this.state.waitingTurns ?? 1);
		if (this.state.waitingTurns === null) return;
		if (turns > 0) {
			if (turns !== this.state.waitingTurns) this.set({ waitingTurns: turns });
			return;
		}
		this.set({ waitingTurns: null });
		this.restart();
	}
	private restart() {
		const driver = this.deps.driver;
		if (!driver || this.restarting) return;
		this.restarting = true;
		this.quitDecided = true;
		try {
			driver.restart();
		} catch (error) {
			this.restarting = false;
			this.quitDecided = false;
			this.deps.log(`app-update: the restart failed: ${message(error)}`);
			this.set({ phase: 'error', failed: 'install' });
		}
	}
	/** Quit waits for `prepareQuit` while this is true (a `QuitGuard` wait in main). */
	quitPending() {
		return (
			this.state.support === 'install' &&
			this.state.phase === 'ready' &&
			!this.quitDecided &&
			!this.deps.relaunching()
		);
	}
	/** Install on quit, unless a turn runs: then the update stays downloaded for the next quit or restart. */
	async prepareQuit() {
		if (!this.quitPending() || !this.deps.driver) return;
		this.quitDecided = true;
		const turns = await this.deps.runningTurns().catch(() => 1);
		if (turns > 0) {
			this.deps.log(
				`app-update: ${this.state.version} is not installed on this quit: ${turns} turn(s) still run`
			);
			return;
		}
		try {
			await this.deps.driver.installOnQuit();
		} catch (error) {
			this.deps.log(`app-update: install on quit failed: ${message(error)}`);
		}
	}
	/** A failed install leaves the downloaded update for another try (the driver's `error` event). */
	failed(error: unknown) {
		if (this.restarting || this.state.phase === 'ready') {
			this.deps.log(`app-update: the install of ${this.state.version} failed: ${message(error)}`);
			this.restarting = false;
			this.quitDecided = false;
			this.set({ phase: 'error', failed: 'install' });
		}
	}
}
