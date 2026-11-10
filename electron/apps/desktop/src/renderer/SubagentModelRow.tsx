import { selectOption, t, type AppSettings, type Locale } from '@brigadir/core';
import { SettingsRow } from './SettingsForm';
import { useProviderCatalogs } from './HelperAgent';
import { Popup } from './ui/Controls';
const same = 'same';
/**
 * spec/agents-and-providers#subagent-model: the model Claude's own subagents search and read on. The list is the Claude catalog (rule 7);
 * a saved value the catalog no longer lists stays shown as it is.
 */
export function SubagentModelRow({
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
	const catalogs = useProviderCatalogs(settings.agents.enabled),
		model = catalogs.claude ? selectOption(catalogs.claude.options, 'model') : undefined,
		value = settings.agents.claudeSubagentModel;
	if (!settings.agents.enabled.claude) return null;
	const models = (model?.choices ?? []).filter((item) => item.value !== 'default');
	return (
		<SettingsRow
			label={t(locale, 'Subagent model')}
			hint={t(locale, "Claude's own subagents search and read on this model.")}>
			<Popup
				label={t(locale, 'Subagent model')}
				disabled={busy}
				value={value ?? same}
				options={[
					{ value: same, label: t(locale, 'Same as the agent') },
					...models.map((item) => ({ value: item.value, label: item.name })),
					...(value && !models.some((item) => item.value === value)
						? [{ value, label: value }]
						: []),
				]}
				onChange={(next) => {
					update({
						agents: { ...settings.agents, claudeSubagentModel: next === same ? null : next },
					});
				}}
			/>
		</SettingsRow>
	);
}
