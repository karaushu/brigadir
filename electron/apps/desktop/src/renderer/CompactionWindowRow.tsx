import {
	compactionWindowChoices,
	formatTokenCount,
	t,
	type AppSettings,
	type Locale,
} from '@brigadir/core';
import { SettingsRow } from './SettingsForm';
import { Popup } from './ui/Controls';
const agentDefault = 'agent';
/**
 * spec/agents-and-providers#compaction-window: the context size at which new sessions compact. `Agent's default` passes nothing;
 * a saved value the menu does not list stays shown as it is.
 */
export function CompactionWindowRow({
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
	const value = settings.agents.compactionWindow,
		sizes: readonly number[] = compactionWindowChoices;
	return (
		<SettingsRow
			label={t(locale, 'Compaction window')}
			hint={t(locale, 'New sessions compact their context when it reaches this many tokens.')}>
			<Popup
				label={t(locale, 'Compaction window')}
				disabled={busy}
				value={value === null ? agentDefault : String(value)}
				options={[
					{ value: agentDefault, label: t(locale, "Agent's default") },
					...[...sizes, ...(value !== null && !sizes.includes(value) ? [value] : [])].map(
						(size) => ({ value: String(size), label: formatTokenCount(size) })
					),
				]}
				onChange={(next) => {
					update({
						agents: {
							...settings.agents,
							compactionWindow: next === agentDefault ? null : Number(next),
						},
					});
				}}
			/>
		</SettingsRow>
	);
}
