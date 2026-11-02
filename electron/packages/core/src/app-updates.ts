import { t, type Locale } from './messages';
import { checkedTime } from './cli-updates';
/**
 * spec/architecture-and-platform#auto-update: how this build updates itself.
 * `install` — downloads in the background and installs on restart or quit (a Developer ID macOS app, an AppImage);
 * `notify` — only says that a new version exists and links its release page (an ad-hoc macOS app, `.deb`, `.rpm`);
 * `off` — never checks (a development build, or a build without a releases repository).
 */
export type AppUpdateSupport = 'install' | 'notify' | 'off';
export type AppUpdatePhase = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error';
/** What the last check found; `manual` checks (the menu item, «Check now») answer with a toast. */
export type AppUpdateCheck = {
	id: number;
	manual: boolean;
	outcome: 'current' | 'available' | 'ready' | 'failed';
};
export type AppUpdateState = {
	support: AppUpdateSupport;
	phase: AppUpdatePhase;
	/** The running version. */
	current: string;
	/** The newer version found, while one is known. */
	version: string | null;
	/** Download progress, 0–100, while `downloading`. */
	progress: number | null;
	/** When the last check finished, ISO time. */
	checkedAt: string | null;
	/** What failed while `error`. */
	failed: 'check' | 'download' | 'install' | null;
	/** «Restart to update» while turns run: how many still run; null when no restart waits. */
	waitingTurns: number | null;
	/** The release page of `version`, for builds that only notify. */
	releaseUrl: string | null;
	lastCheck: AppUpdateCheck | null;
};
/** The first check comes this long after start, then one every `appUpdateEvery`. */
export const appUpdateFirstCheck = 60_000;
export const appUpdateEvery = 6 * 60 * 60_000;
/** The value `releases` holds until the public releases repository is set up (docs/guides/releasing.md). */
export const releasesPlaceholder = 'OWNER/brigadir-releases';
/** `owner/repo` of the public releases repository, or null for the placeholder or a malformed value. */
export function releasesRepo(value: unknown): { owner: string; repo: string } | null {
	if (typeof value !== 'string' || value === releasesPlaceholder) return null;
	const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/.exec(value);
	return match ? { owner: match[1]!, repo: match[2]! } : null;
}
export function releasePage(repo: { owner: string; repo: string }, version: string) {
	return `https://github.com/${repo.owner}/${repo.repo}/releases/tag/v${encodeURIComponent(version)}`;
}
/** spec/architecture-and-platform#auto-update: the toast once an update waits for a restart. */
export function appUpdateReadyText(locale: Locale, version: string) {
	return t(locale, 'Brigadir {version} is ready').replace('{version}', version);
}
export function appUpdateAvailableText(locale: Locale, version: string) {
	return t(locale, 'Brigadir {version} is available').replace('{version}', version);
}
export function appUpdateWaitingText(locale: Locale, count: number) {
	return t(locale, 'Turns running: {count}. Brigadir restarts when they end.').replace(
		'{count}',
		new Intl.NumberFormat(locale).format(count)
	);
}
/** spec/architecture-and-platform#auto-update: the one line under Settings ▸ Language ▸ Updates. `warning` paints it amber. */
export function appUpdateLabel(
	locale: Locale,
	state: AppUpdateState,
	now = new Date()
): { text: string; warning: boolean } {
	if (state.support === 'off')
		return { text: t(locale, 'This build does not check for updates.'), warning: false };
	if (state.waitingTurns !== null)
		return { text: appUpdateWaitingText(locale, state.waitingTurns), warning: false };
	const when = state.checkedAt ? checkedTime(locale, state.checkedAt, now) : null;
	switch (state.phase) {
		case 'checking':
			return { text: t(locale, 'Checking…'), warning: false };
		case 'downloading':
			return {
				text: t(locale, 'Downloading {version}… {percent}%')
					.replace('{version}', state.version ?? '')
					.replace('{percent}', String(Math.round(state.progress ?? 0))),
				warning: false,
			};
		case 'ready':
			return { text: appUpdateReadyText(locale, state.version ?? ''), warning: false };
		case 'available':
			return { text: appUpdateAvailableText(locale, state.version ?? ''), warning: false };
		case 'error': {
			const text = t(
				locale,
				state.failed === 'download'
					? 'Could not download the update.'
					: state.failed === 'install'
						? 'Could not install the update.'
						: 'Could not check for updates.'
			);
			return { text: when ? `${text} · ${when}` : text, warning: true };
		}
		default: {
			const version = t(locale, 'Version {version}').replace('{version}', state.current);
			return {
				text: when
					? `${version} · ${t(locale, 'checked {time}').replace('{time}', when)}`
					: version,
				warning: false,
			};
		}
	}
}
