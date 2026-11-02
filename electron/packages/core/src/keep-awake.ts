import { crewAgentCountLabel, t, type Locale } from './messages';
import { isRecord } from './workspace';
/** spec/architecture-and-platform#keep-awake: how many agents work now and whether main holds the computer awake for them. */
export type KeepAwakeStatus = { working: number; holding: boolean };
export function isKeepAwakeStatus(value: unknown): value is KeepAwakeStatus {
	return (
		isRecord(value) &&
		Object.keys(value).length === 2 &&
		Number.isSafeInteger(value.working) &&
		Number(value.working) >= 0 &&
		typeof value.holding === 'boolean'
	);
}
/** spec/architecture-and-platform#keep-awake: the line over the explanation under «Keep awake»; none while nobody works or the switch is off. */
export function keepAwakeLabel(
	locale: Locale,
	status: KeepAwakeStatus | null,
	enabled: boolean
): string | null {
	if (!enabled || !status || status.working < 1) return null;
	return t(locale, 'Now working: {count} — the Mac stays awake.').replace(
		'{count}',
		crewAgentCountLabel(locale, status.working)
	);
}
