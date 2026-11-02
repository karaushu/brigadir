import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { autoUpdater as nativeUpdater } from 'electron';
import { AppImageUpdater, DebUpdater, MacUpdater, type AppUpdater } from 'electron-updater';
import type { UpdateDriver } from './app-updates';
/** How long a quit waits for Squirrel.Mac to take the downloaded update before it quits without it. */
const stageTimeoutMs = 20_000;
export type DriverOptions = {
	platform: NodeJS.Platform;
	/** `$APPIMAGE`: the app runs as an AppImage, which installs itself; otherwise Linux only checks (`.deb`, `.rpm`). */
	appImage: string | undefined;
	/** `BRIGADIR_UPDATE_URL`: a generic update server for testing a packaged build; the releases repository otherwise. */
	feedUrl: string | undefined;
	log(line: string): void;
	/** An AppImage restarts through the app's own relaunch after quit, from the path the update was installed to. */
	relaunchAfterQuit(path: () => string | undefined): void;
	/** Errors outside a check or download, e.g. Squirrel.Mac refusing the update. */
	failed(error: unknown): void;
};
/**
 * spec/architecture-and-platform#auto-update: the update driver on electron-updater. macOS uses Squirrel.Mac (`MacUpdater`, the zip next to the
 * DMG), an AppImage replaces its own file (`AppImageUpdater`); a `.deb` or `.rpm` only reads `latest-linux.yml` to say a
 * version exists — the person installs the package. The feed comes from `app-update.yml`, which electron-builder writes
 * from the `releases` field of apps/desktop/package.json.
 */
export function createUpdateDriver(options: DriverOptions): UpdateDriver {
	const updater: AppUpdater =
		options.platform === 'darwin'
			? new MacUpdater()
			: options.appImage
				? new AppImageUpdater()
				: // Check only: `resources/package-type` is not trusted (the `.rpm` is built from the same unpacked folder as the `.deb`).
					new DebUpdater();
	if (options.feedUrl) updater.setFeedURL({ provider: 'generic', url: options.feedUrl });
	// Downloads and installs happen only when AppUpdates asks: never while a turn runs.
	updater.autoDownload = false;
	updater.autoInstallOnAppQuit = false;
	updater.logger = {
		info: () => {},
		warn: (text: unknown) => options.log(`app-update: ${String(text)}`),
		error: (text: unknown) => options.log(`app-update: ${String(text)}`),
	};
	let progress: (percent: number) => void = () => {};
	updater.on('download-progress', (info) => progress(info.percent));
	updater.on('error', (error) => options.failed(error));
	let installedAt = options.appImage;
	updater.on('appimage-filename-updated', (path: string) => {
		installedAt = path;
	});
	/** Squirrel.Mac takes the downloaded zip from electron-updater's local server; after that the next quit installs it. */
	const stage = (relaunch: boolean) =>
		new Promise<void>((done) => {
			const finish = () => {
				clearTimeout(timer);
				nativeUpdater.removeListener('update-downloaded', finish);
				nativeUpdater.removeListener('error', finish);
				done();
			};
			const timer = setTimeout(finish, stageTimeoutMs);
			nativeUpdater.once('update-downloaded', finish);
			nativeUpdater.once('error', finish);
			updater.autoRunAppAfterInstall = relaunch;
			updater.quitAndInstall();
		});
	return {
		async check() {
			const result = await updater.checkForUpdates();
			return result?.isUpdateAvailable ? result.updateInfo.version : null;
		},
		async download(report) {
			progress = report;
			try {
				await updater.downloadUpdate();
			} finally {
				progress = () => {};
			}
		},
		restart() {
			if (options.platform === 'darwin') {
				// Squirrel.Mac quits the app, installs and opens the new version.
				void stage(true);
				return;
			}
			options.relaunchAfterQuit(() => installedAt);
			(updater as AppImageUpdater).quitAndInstall(true, false);
		},
		async installOnQuit() {
			if (options.platform === 'darwin') return stage(false);
			(updater as AppImageUpdater).install(true, false);
		},
	};
}
/** The `.app` of a packaged macOS build: `…/Brigadir.app/Contents/MacOS/Brigadir` → `…/Brigadir.app`. */
export function appBundle(execPath: string) {
	return resolve(execPath, '../../..');
}
/** `codesign -dv` output of a bundle signed with a Developer ID Application certificate. Squirrel.Mac installs only those. */
export function developerIdSigned(codesignOutput: string) {
	return /^Authority=Developer ID Application: /m.test(codesignOutput);
}
export function macDeveloperId(bundle: string): Promise<boolean> {
	return new Promise((done) => {
		execFile(
			'/usr/bin/codesign',
			['-dv', '--verbose=2', bundle],
			{ timeout: 10_000 },
			(error, stdout, stderr) => {
				done(!error && developerIdSigned(`${stdout}\n${stderr}`));
			}
		);
	});
}
