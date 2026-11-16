import { t, type AppSettings, type Locale } from '@brigadir/core';
import { SettingsRow } from './SettingsForm';
import { BudgetPopup, providerName } from './TaskUsage';
import s from './TaskUsage.module.css';
/**
 * spec/agents-and-providers#task-budget: the token budget a new task takes, one popup per enabled provider; each is named by its provider while two are on.
 * Tasks that exist keep theirs.
 */
export function TaskBudgetRow({
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
	const providers = (['claude', 'codex'] as const).filter(
			(provider) => settings.agents.enabled[provider]
		),
		budget = settings.agents.taskBudget;
	return (
		<SettingsRow
			label={t(locale, 'Task budget')}
			hint={t(
				locale,
				'A task pauses and asks when its agents use this many tokens. New tasks only.'
			)}>
			<span className={s.settings} data-task-budget>
				{providers.map((provider) => (
					<span key={provider} className={s.settingsProvider}>
						{providers.length > 1 && <span>{providerName(locale, provider)}</span>}
						<BudgetPopup
							locale={locale}
							provider={provider}
							value={budget[provider] ?? undefined}
							disabled={busy}
							label={
								providers.length > 1
									? t(locale, '{provider} budget').replace(
											'{provider}',
											providerName(locale, provider)
										)
									: t(locale, 'Task budget')
							}
							onChange={(value) =>
								update({
									agents: { ...settings.agents, taskBudget: { ...budget, [provider]: value } },
								})
							}
						/>
					</span>
				))}
			</span>
		</SettingsRow>
	);
}
