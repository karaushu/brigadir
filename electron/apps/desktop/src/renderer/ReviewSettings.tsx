import {
	smallTaskLimits,
	smokeMinutesLimits,
	t,
	type AppSettings,
	type Locale,
} from '@brigadir/core';
import { Stepper } from './ui/Controls';
import { SettingsRow, SettingsSection } from './SettingsForm';
import styles from './LayoutSettings.module.css';
/**
 * spec/settings-modules-and-onboarding#settings-keys: the `Reviews` card of Settings ▸ Agents — the files and changed lines past which a small
 * task gets a mid-task review from the host (spec/reviews#tripwire), and the minutes of a smoke run's limit (spec/smoke-run#limit).
 */
export function ReviewSettings({
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
	const limit = settings.reviews.smallTask,
		set = (patch: Partial<typeof limit>) =>
			update({ reviews: { ...settings.reviews, smallTask: { ...limit, ...patch } } }),
		label = t(locale, 'Small task limit');
	const smokeLabel = t(locale, 'Smoke run limit');
	return (
		<SettingsSection title={t(locale, 'Reviews')} disabled={busy}>
			<SettingsRow
				label={label}
				hint={t(locale, 'A small task that grows past this gets a mid-task review.')}>
				<span className={styles.inline} data-small-task-limit data-size="m">
					<Stepper
						label={`${label} · ${t(locale, 'files (limit)')}`}
						min={smallTaskLimits.files.min}
						max={smallTaskLimits.files.max}
						step={smallTaskLimits.files.step}
						value={limit.files}
						disabled={busy}
						onChange={(files) => set({ files })}
						increaseLabel={`${t(locale, 'files (limit)')} · ${t(locale, 'Increase')}`}
						decreaseLabel={`${t(locale, 'files (limit)')} · ${t(locale, 'Decrease')}`}
					/>
					<span>{t(locale, 'files (limit)')}</span>
					<Stepper
						label={`${label} · ${t(locale, 'lines (limit)')}`}
						min={smallTaskLimits.lines.min}
						max={smallTaskLimits.lines.max}
						step={smallTaskLimits.lines.step}
						value={limit.lines}
						disabled={busy}
						onChange={(lines) => set({ lines })}
						increaseLabel={`${t(locale, 'lines (limit)')} · ${t(locale, 'Increase')}`}
						decreaseLabel={`${t(locale, 'lines (limit)')} · ${t(locale, 'Decrease')}`}
					/>
					<span>{t(locale, 'lines (limit)')}</span>
				</span>
			</SettingsRow>
			<SettingsRow
				label={smokeLabel}
				hint={t(locale, 'At the limit the run stops and the agent reports.')}>
				<span className={styles.inline} data-smoke-limit data-size="m">
					<Stepper
						label={`${smokeLabel} · ${t(locale, 'min (limit)')}`}
						min={smokeMinutesLimits.min}
						max={smokeMinutesLimits.max}
						step={smokeMinutesLimits.step}
						value={settings.reviews.smokeMinutes}
						disabled={busy}
						onChange={(smokeMinutes) => update({ reviews: { ...settings.reviews, smokeMinutes } })}
						increaseLabel={`${t(locale, 'min (limit)')} · ${t(locale, 'Increase')}`}
						decreaseLabel={`${t(locale, 'min (limit)')} · ${t(locale, 'Decrease')}`}
					/>
					<span>{t(locale, 'min (limit)')}</span>
				</span>
			</SettingsRow>
		</SettingsSection>
	);
}
