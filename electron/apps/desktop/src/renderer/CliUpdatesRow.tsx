import { useEffect, useState } from 'react';
import {
	cliUpdateLabel,
	t,
	type AppSettings,
	type CliUpdateStatus,
	type Locale,
} from '@brigadir/core';
import { Button, Switch } from './ui/Controls';
import { SettingsRow } from './SettingsForm';
import styles from './LayoutSettings.module.css';
/** spec/agents-and-providers#cli-updates: the third row of the agents card — the background switch, «Check now» and the one status line under them.
 *  A run that ends re-reads the agents (their versions); `checked` lets the card refresh them. */
export function CliUpdatesRow({
	settings,
	locale,
	busy,
	update,
	checked,
}: {
	settings: AppSettings;
	locale: Locale;
	busy: boolean;
	update(patch: Partial<AppSettings>): void;
	checked(): void;
}) {
	const [status, setStatus] = useState<CliUpdateStatus | null>(null),
		[, setMinute] = useState(0);
	useEffect(() => {
		let live = true;
		void window.brigadir
			.readCliUpdates()
			.then((value) => {
				if (live) setStatus((current) => current ?? value);
			})
			.catch(() => {});
		const stop = window.brigadir.onCliUpdates((value) => {
			setStatus(value);
			if (!value.running) checked();
		});
		// «today at» turns into «yesterday at» while Settings stay open.
		const timer = setInterval(() => setMinute((value) => value + 1), 60_000);
		return () => {
			live = false;
			stop();
			clearInterval(timer);
		};
	}, []); // eslint-disable-line react-hooks/exhaustive-deps
	const label = status ? cliUpdateLabel(locale, status) : null,
		name = t(locale, 'Update in the background');
	return (
		<SettingsRow
			label={t(locale, 'CLI updates')}
			{...(label
				? { hint: <span data-cli-update-status>{label.text}</span>, warning: label.warning }
				: {})}>
			<span className={`${styles.inline} ${styles.wideGap}`} data-cli-updates>
				<label className={`${styles.inline} ${styles.wideGap}`}>
					<Switch
						label={name}
						checked={settings.agents.updateClis}
						disabled={busy}
						onChange={(updateClis) => {
							update({ agents: { ...settings.agents, updateClis } });
						}}
					/>
					<span>{name}</span>
				</label>
				<Button
					disabled={!status || status.running}
					onClick={() => {
						setStatus((current) => current && { ...current, running: true });
						void window.brigadir
							.checkCliUpdates()
							.then(setStatus)
							.catch(() => {
								void window.brigadir
									.readCliUpdates()
									.then(setStatus)
									.catch(() => {});
							});
					}}>
					{t(locale, 'Check now')}
				</Button>
			</span>
		</SettingsRow>
	);
}
