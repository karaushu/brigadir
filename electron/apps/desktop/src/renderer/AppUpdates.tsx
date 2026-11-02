import { useEffect, useRef, useState } from 'react';
import {
	appUpdateAvailableText,
	appUpdateLabel,
	appUpdateReadyText,
	appUpdateWaitingText,
	t,
	type AppSettings,
	type AppUpdateState,
	type Locale,
} from '@brigadir/core';
import { Button, Switch } from './ui/Controls';
import { notify, showToast, toastError } from './ui/Toast';
import { SettingsRow } from './SettingsForm';
import styles from './LayoutSettings.module.css';

const restart = () => window.brigadir.installAppUpdate().catch(() => null);
const download = () => window.brigadir.downloadAppUpdate().catch(() => null);
/** The state main publishes; null until the first read answers. */
function useAppUpdate(): [AppUpdateState | null, (state: AppUpdateState) => void] {
	const [state, setState] = useState<AppUpdateState | null>(null);
	useEffect(() => {
		let live = true;
		void window.brigadir
			.readAppUpdate()
			.then((value) => {
				if (live) setState((current) => current ?? value);
			})
			.catch(() => {});
		const stop = window.brigadir.onAppUpdate(setState);
		return () => {
			live = false;
			stop();
		};
	}, []);
	return [state, setState];
}
/** Versions this window already offered, so a toast is not repeated on every state change. */
const offered = new Set<string>();
/**
 * spec/architecture-and-platform#auto-update: the update toasts — a downloaded version with «Restart to update», a version this build only
 * announces (or does not download in the background) with «Download update», a restart that waits for running turns, and
 * the answer to a check the person asked for.
 */
export function AppUpdateToasts({ locale }: { locale: Locale }) {
	const [state] = useAppUpdate();
	/** The last check this window answered; checks before the window opened stay unanswered. */
	const answered = useRef<number | null>(null),
		waiting = useRef<number | null>(null);
	useEffect(() => {
		if (!state) return;
		const check = state.lastCheck;
		const manual =
			check && answered.current !== null && check.id > answered.current && check.manual
				? check
				: null;
		answered.current = Math.max(answered.current ?? 0, check?.id ?? 0);
		const offer = (kind: 'ready' | 'available', again: boolean) => {
			const version = state.version;
			if (!version || (offered.has(`${kind}:${version}`) && !again)) return;
			offered.add(`${kind}:${version}`);
			if (kind === 'ready')
				notify('info', appUpdateReadyText(locale, version), {
					key: 'app-update:ready',
					action: {
						label: t(locale, 'Restart to update'),
						run: () => {
							void restart();
						},
					},
				});
			else
				notify('info', appUpdateAvailableText(locale, version), {
					key: 'app-update:available',
					action:
						state.support === 'install' || state.releaseUrl
							? {
									label: t(locale, 'Download update'),
									run: () => {
										void download();
									},
								}
							: undefined,
				});
		};
		if (state.phase === 'ready' && state.waitingTurns === null) offer('ready', Boolean(manual));
		else if (state.phase === 'available') offer('available', Boolean(manual));
		else if (manual?.outcome === 'available' && state.phase === 'downloading' && state.version)
			notify('info', appUpdateAvailableText(locale, state.version), {
				key: 'app-update:available',
			});
		if (manual?.outcome === 'current') showToast(t(locale, 'Brigadir is up to date'));
		if (manual?.outcome === 'failed')
			toastError(t(locale, 'Could not check for updates.'), {
				action: {
					label: t(locale, 'Retry'),
					run: () => {
						void window.brigadir.checkAppUpdate().catch(() => {});
					},
				},
			});
		// «Restart to update» while turns run: say so once, with a way back.
		if (state.waitingTurns !== null && waiting.current === null)
			notify('info', appUpdateWaitingText(locale, state.waitingTurns), {
				key: 'app-update:waiting',
				action: {
					label: t(locale, 'Cancel restart'),
					run: () => {
						void window.brigadir.cancelAppUpdateRestart().catch(() => {});
					},
				},
			});
		waiting.current = state.waitingTurns;
	}, [state, locale]);
	return null;
}
/**
 * spec/architecture-and-platform#auto-update: Settings ▸ Language ▸ Updates — the background download switch, one button that follows the
 * state («Check now», «Download update», «Restart to update», «Cancel restart») and the status line under them.
 */
export function AppUpdateRow({
	settings,
	locale,
	busy,
	update,
}: {
	settings: AppSettings;
	locale: Locale;
	busy: boolean;
	update(patch: Partial<AppSettings>): void;
}) {
	const [state, setState] = useAppUpdate(),
		[, setMinute] = useState(0);
	useEffect(() => {
		// «today at» turns into «yesterday at» while Settings stay open.
		const timer = setInterval(() => setMinute((value) => value + 1), 60_000);
		return () => clearInterval(timer);
	}, []);
	const label = state ? appUpdateLabel(locale, state) : null,
		name = t(locale, 'Download in the background');
	const off = !state || state.support === 'off';
	const act = (run: () => Promise<AppUpdateState | null>) => {
		void run().then((value) => {
			if (value) setState(value);
		});
	};
	const button =
		state?.waitingTurns !== null && state?.waitingTurns !== undefined
			? {
					text: t(locale, 'Cancel restart'),
					run: () => act(() => window.brigadir.cancelAppUpdateRestart().catch(() => null)),
					disabled: false,
				}
			: state?.phase === 'ready'
				? { text: t(locale, 'Restart to update'), run: () => act(restart), disabled: false }
				: state?.phase === 'available' && (state.support === 'install' || state.releaseUrl)
					? { text: t(locale, 'Download update'), run: () => act(download), disabled: false }
					: {
							text: t(locale, 'Check now'),
							run: () => act(() => window.brigadir.checkAppUpdate().catch(() => null)),
							disabled: off || state.phase === 'checking' || state.phase === 'downloading',
						};
	return (
		<SettingsRow
			label={t(locale, 'Brigadir')}
			{...(label
				? { hint: <span data-app-update-status>{label.text}</span>, warning: label.warning }
				: {})}>
			<span className={`${styles.inline} ${styles.wideGap}`} data-app-updates>
				<label className={`${styles.inline} ${styles.wideGap}`}>
					<Switch
						label={name}
						checked={settings.updates.autoDownload}
						disabled={busy || state?.support !== 'install'}
						onChange={(autoDownload) => {
							update({ updates: { ...settings.updates, autoDownload } });
						}}
					/>
					<span>{name}</span>
				</label>
				<Button disabled={button.disabled} onClick={button.run}>
					{button.text}
				</Button>
			</span>
		</SettingsRow>
	);
}
