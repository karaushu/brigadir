import { autoBudgetLimits, t, type AppSettings, type Locale } from '@brigadir/core';
import { Stepper, Switch } from './ui/Controls';
import { SettingsRow, SettingsSection } from './SettingsForm';
import styles from './LayoutSettings.module.css';
/**
 * spec/settings-modules-and-onboarding#settings-keys: the `Auto` card of Settings ▸ Agents — whether an Auto task's agent may take any catalog
 * model for a part without asking, and the budget a hired part starts with (new Auto tasks).
 */
export function AutoSettings({
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
	const auto = settings.auto,
		minutes = autoBudgetLimits.minutes,
		tokens = autoBudgetLimits.tokens;
	return (
		<SettingsSection title={t(locale, 'Auto')} disabled={busy}>
			<SettingsRow
				label={t(locale, 'Models')}
				hint={t(
					locale,
					auto.anyModel
						? 'On: the agent picks a model for a part without asking.'
						: 'Off: for a model outside the roles the agent asks first.'
				)}>
				<label className={styles.inline} data-auto-any-model>
					<Switch
						label={t(locale, 'Any catalog model')}
						checked={auto.anyModel}
						disabled={busy}
						onChange={(anyModel) => update({ auto: { ...auto, anyModel } })}
					/>
					<span>{t(locale, 'Any catalog model')}</span>
				</label>
			</SettingsRow>
			<SettingsRow
				label={t(locale, 'Part budget')}
				hint={t(locale, 'A worker over its budget stops and asks.')}>
				<span className={styles.inline} data-auto-part-budget data-size="m">
					<Stepper
						label={t(locale, 'Part budget')}
						min={minutes.min}
						max={minutes.max}
						step={minutes.step}
						value={auto.partBudget.minutes}
						disabled={busy}
						onChange={(value) =>
							update({ auto: { ...auto, partBudget: { ...auto.partBudget, minutes: value } } })
						}
						increaseLabel={`${t(locale, 'Part budget')} · ${t(locale, 'Increase')}`}
						decreaseLabel={`${t(locale, 'Part budget')} · ${t(locale, 'Decrease')}`}
					/>
					<span>{t(locale, 'min (budget)')}</span>
					<Stepper
						label={t(locale, 'k tokens')}
						min={tokens.min / 1000}
						max={tokens.max / 1000}
						step={tokens.step / 1000}
						value={Math.round(auto.partBudget.tokens / 1000)}
						disabled={busy}
						onChange={(value) =>
							update({
								auto: { ...auto, partBudget: { ...auto.partBudget, tokens: value * 1000 } },
							})
						}
						increaseLabel={`${t(locale, 'k tokens')} · ${t(locale, 'Increase')}`}
						decreaseLabel={`${t(locale, 'k tokens')} · ${t(locale, 'Decrease')}`}
					/>
					<span>{t(locale, 'k tokens')}</span>
				</span>
			</SettingsRow>
		</SettingsSection>
	);
}
