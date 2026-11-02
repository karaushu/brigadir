import { useEffect, useRef, useState } from 'react';
import {
	soundSlots,
	t,
	type AppSettings,
	type Locale,
	type NotificationPreferences,
	type SoundSlot,
} from '@brigadir/core';
import { Button, Popup, Switch } from './ui/Controls';
import { Glyph } from './ui/Glyph';
import { useNotificationPermission } from './use-notification-permission';
import { SettingsRow, SettingsSection } from './SettingsForm';
import styles from './LayoutSettings.module.css';
/** Only macOS has a notification pane main can open (`notifications:system-settings`). */
const systemSettings = window.brigadir.chromePlatform === 'darwin';
const slotLabels: Record<SoundSlot, 'Needs you' | 'Turn ended' | 'Error'> = {
	needsYou: 'Needs you',
	turnEnded: 'Turn ended',
	failed: 'Error',
};
/** spec/sidebar#layout Notifications tab: OS delivery and in-app sound are independent axes; sounds come from the Mac.
 *  spec/notifications-slack-notes-and-schedules#macos-permission: one «When» picker for each axis and the macOS permission as a state, never an explanation. */
export function NotificationSettings({
	settings,
	locale,
	busy,
	update,
}: {
	settings: AppSettings;
	locale: Locale;
	busy: boolean;
	update(patch: Partial<AppSettings>): Promise<void>;
}) {
	const [sounds, setSounds] = useState<string[] | null>(null),
		[soundError, setSoundError] = useState(false),
		mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		void window.brigadir.readSounds().then(
			(names) => {
				if (mounted.current) setSounds(names);
			},
			() => {
				if (mounted.current) setSounds([]);
			}
		);
		return () => {
			mounted.current = false;
		};
	}, []);
	const preferences = settings.notifications,
		permission = useNotificationPermission(),
		[requesting, setRequesting] = useState(false);
	const change = (patch: Partial<NotificationPreferences>) =>
		update({ notifications: { ...preferences, ...patch } });
	const modeOptions = [
		{ value: 'off', label: t(locale, 'Never') },
		{ value: 'needs-you', label: t(locale, 'When you are needed') },
		{ value: 'turn-ended', label: t(locale, 'When a turn ends') },
	];
	/** spec/settings-modules-and-onboarding#intro: the notification picker explains each value; the sound picker keeps bare names. */
	const notificationOptions = modeOptions.map((option) => ({
		...option,
		description: t(
			locale,
			(
				{
					off: 'Brigadir does not show notifications.',
					'needs-you': 'The agent asks a question or asks for permission.',
					'turn-ended': 'When the agent finishes each turn.',
				} as const
			)[option.value as NotificationPreferences['mode']]
		),
	}));
	const soundOptions = (current: string | null) => [
		{ value: '', label: t(locale, 'None') },
		...(sounds ?? []).map((name) => ({ value: name, label: name })),
		...(current && !(sounds ?? []).includes(current) ? [{ value: current, label: current }] : []),
	];
	const chooseSound = (slot: SoundSlot, value: string) => {
		const name = value || null;
		setSoundError(false);
		void change({ sounds: { ...preferences.sounds, [slot]: name } });
		if (name)
			void window.brigadir.previewSound(name).then(
				(played) => {
					if (mounted.current && !played) setSoundError(true);
				},
				() => {
					if (mounted.current) setSoundError(true);
				}
			);
	};
	// main opens the notification pane of System Settings on macOS only; elsewhere there is no such button (spec/architecture-and-platform#linux-package).
	const openSystem = systemSettings && (
		<Button
			onClick={() => {
				void window.brigadir.openNotificationSettings().catch(() => {});
			}}>
			{t(locale, 'Open System Settings')}
		</Button>
	);
	const wanted = preferences.mode !== 'off',
		denied = wanted && permission === 'denied';
	const request = () => {
		setRequesting(true);
		void window.brigadir
			.requestNotificationPermission()
			.catch(() => {})
			.finally(() => {
				if (mounted.current) setRequesting(false);
			});
	};
	return (
		<>
			<SettingsSection title={t(locale, 'Notifications')} disabled={busy}>
				{denied && (
					<div
						className={styles.permissionWarning}
						role="alert"
						data-notification-permission="denied">
						<Glyph name="notifications-off" size={16} />
						<span>
							{t(locale, 'Brigadir notifications are turned off in macOS.')}
							{openSystem}
						</span>
					</div>
				)}
				<SettingsRow label={t(locale, 'When')} wide>
					<Popup
						label={t(locale, 'When')}
						disabled={busy}
						value={preferences.mode}
						options={notificationOptions}
						onChange={(value) => {
							void change({ mode: value as NotificationPreferences['mode'] });
						}}
					/>
				</SettingsRow>
				{wanted && (permission === 'granted' || permission === 'not-determined') && (
					<SettingsRow label={t(locale, 'macOS permission')}>
						<span className={styles.permissionState} data-notification-permission={permission}>
							{permission === 'granted' ? (
								<>
									<Glyph name="check-pass" size={14} />
									{t(locale, 'Allowed')}
								</>
							) : (
								<>
									{t(locale, 'Not requested yet')}
									<Button disabled={requesting} onClick={request}>
										{t(locale, 'Allow')}
									</Button>
								</>
							)}
						</span>
					</SettingsRow>
				)}
			</SettingsSection>
			<SettingsSection
				title={t(locale, 'Sound')}
				disabled={busy}
				warning={soundError}
				footnote={
					soundError ? (
						<span role="alert">{t(locale, 'The sound could not be played.')}</span>
					) : undefined
				}>
				<SettingsRow label={t(locale, 'When')} wide>
					<Popup
						label={`${t(locale, 'Sound')} · ${t(locale, 'When')}`}
						disabled={busy}
						value={preferences.soundMode}
						options={modeOptions}
						onChange={(value) => {
							void change({ soundMode: value as NotificationPreferences['soundMode'] });
						}}
					/>
				</SettingsRow>
				{soundSlots.map((slot) => (
					<SettingsRow label={t(locale, slotLabels[slot])} key={slot} wide>
						<Popup
							label={t(locale, slotLabels[slot])}
							disabled={busy || preferences.soundMode === 'off' || sounds === null}
							value={preferences.sounds[slot] ?? ''}
							options={soundOptions(preferences.sounds[slot])}
							onChange={(value) => chooseSound(slot, value)}
						/>
					</SettingsRow>
				))}
			</SettingsSection>
			<SettingsSection label={t(locale, 'Quiet while I am viewing the task')} disabled={busy}>
				<SettingsRow label="">
					<label className={styles.inline}>
						<Switch
							label={t(locale, 'Quiet while I am viewing the task')}
							checked={preferences.muteVisibleTask}
							disabled={busy}
							onChange={(value) => {
								void change({ muteVisibleTask: value });
							}}
						/>
						<span>{t(locale, 'Quiet while I am viewing the task')}</span>
					</label>
				</SettingsRow>
			</SettingsSection>
			{!denied && openSystem && (
				<div className={styles.footnote} data-action="true">
					{openSystem}
				</div>
			)}
		</>
	);
}
