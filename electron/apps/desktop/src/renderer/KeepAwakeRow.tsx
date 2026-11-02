import { useEffect, useState } from 'react';
import {
	keepAwakeLabel,
	t,
	type AppSettings,
	type KeepAwakeStatus,
	type Locale,
} from '@brigadir/core';
import { Switch } from './ui/Controls';
import { SettingsRow } from './SettingsForm';
import styles from './LayoutSettings.module.css';
/** spec/architecture-and-platform#keep-awake: «Keep awake» — the switch, the explanation, and over it how many agents keep the computer awake right now. */
export function KeepAwakeRow({
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
	const [status, setStatus] = useState<KeepAwakeStatus | null>(null);
	useEffect(() => {
		let live = true;
		void window.brigadir
			.readKeepAwake()
			.then((value) => {
				if (live) setStatus((current) => current ?? value);
			})
			.catch(() => {});
		const stop = window.brigadir.onKeepAwake(setStatus);
		return () => {
			live = false;
			stop();
		};
	}, []);
	const name = t(locale, 'Keep the Mac awake while agents work'),
		working = keepAwakeLabel(locale, status, settings.agents.keepAwake);
	return (
		<SettingsRow
			label={t(locale, 'Mac sleep')}
			hint={
				<span className={styles.hintLines} data-keep-awake-hint>
					{working && <span data-keep-awake-status>{working}</span>}
					<span>
						{t(
							locale,
							'The display still sleeps; closing a laptop lid still puts the Mac to sleep.'
						)}
					</span>
				</span>
			}>
			<label className={styles.inline} data-keep-awake>
				<Switch
					label={name}
					checked={settings.agents.keepAwake}
					disabled={busy}
					onChange={(keepAwake) => {
						update({ agents: { ...settings.agents, keepAwake } });
					}}
				/>
				<span>{name}</span>
			</label>
		</SettingsRow>
	);
}
