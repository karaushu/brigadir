import { t, type Locale } from './messages';
import { isRecord } from './workspace';
import { formatDate, formatTime } from './date-time';
/** spec/agents-and-providers#cli-updates: one CLI's part of the last run. `before`/`after` are the CLI's own `--version`; `failed` is a non-zero exit. */
export type CliUpdateResult = {
	provider: 'claude' | 'codex';
	before: string | null;
	after: string | null;
	outcome: 'updated' | 'current' | 'failed';
};
/** `checkedAt` is when the last run finished; `running` while one goes. */
export type CliUpdateStatus = {
	checkedAt: string | null;
	running: boolean;
	results: CliUpdateResult[];
};
export const cliUpdateEvery = 24 * 60 * 60_000;
const outcomes = ['updated', 'current', 'failed'];
const version = (value: unknown) =>
	value === null || (typeof value === 'string' && value.length <= 100);
export function isCliUpdateResult(value: unknown): value is CliUpdateResult {
	return (
		isRecord(value) &&
		Object.keys(value).length === 4 &&
		(value.provider === 'claude' || value.provider === 'codex') &&
		version(value.before) &&
		version(value.after) &&
		outcomes.includes(value.outcome as string)
	);
}
export function isCliUpdateStatus(value: unknown): value is CliUpdateStatus {
	return (
		isRecord(value) &&
		Object.keys(value).length === 3 &&
		(value.checkedAt === null ||
			(typeof value.checkedAt === 'string' && !Number.isNaN(Date.parse(value.checkedAt)))) &&
		typeof value.running === 'boolean' &&
		Array.isArray(value.results) &&
		value.results.length <= 2 &&
		value.results.every(isCliUpdateResult)
	);
}
/** «today at 19:20», «yesterday at 10:02», then the date (European, like every date in the app). */
export function checkedTime(locale: Locale, at: string, now = new Date()) {
	const when = new Date(at),
		day = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
	const time = formatTime(when);
	const days = Math.round((day(now) - day(when)) / 86_400_000);
	if (days === 0) return t(locale, 'today at {time}').replace('{time}', time);
	if (days === 1) return t(locale, 'yesterday at {time}').replace('{time}', time);
	return t(locale, '{date} at {time}').replace('{date}', formatDate(when)).replace('{time}', time);
}
const names = { claude: 'Claude Code', codex: 'Codex' } as const;
/** spec/agents-and-providers#cli-updates: the one line under «CLI updates». A failure outranks an update; `warning` paints it amber. */
export function cliUpdateLabel(
	locale: Locale,
	status: CliUpdateStatus,
	now = new Date()
): { text: string; warning: boolean } {
	if (status.running) return { text: t(locale, 'Checking…'), warning: false };
	if (!status.checkedAt) return { text: t(locale, 'Not checked yet'), warning: false };
	const when = checkedTime(locale, status.checkedAt, now),
		failed = status.results.filter((result) => result.outcome === 'failed');
	if (failed.length)
		return {
			text: `${t(locale, 'Could not update {agent}').replace('{agent}', failed.map((result) => names[result.provider]).join(', '))} · ${when}`,
			warning: true,
		};
	const updated = status.results.filter((result) => result.outcome === 'updated');
	if (!updated.length)
		return {
			text: `${t(locale, 'Checked {time} · no new versions').replace('{time}', when)}`,
			warning: false,
		};
	const [first, ...rest] = updated.map((result) => ({
		name: names[result.provider],
		version: result.after ?? '',
	}));
	const text = [
		t(locale, '{agent} updated to {version}')
			.replace('{agent}', first!.name)
			.replace('{version}', first!.version),
		...rest.map((item) =>
			t(locale, '{agent} to {version}')
				.replace('{agent}', item.name)
				.replace('{version}', item.version)
		),
	].join(', ');
	return { text: `${text} · ${when}`, warning: false };
}
