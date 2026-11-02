import type { Locale } from './messages';
export function formatDuration(locale: Locale, milliseconds: number): string {
	const value = Math.max(0, Number.isFinite(milliseconds) ? milliseconds : 0),
		seconds = Math.floor(value / 1000),
		space = locale === 'uk' ? '\u202f' : '',
		units = locale === 'uk' ? ['мс', 'с', 'хв', 'год'] : ['ms', 's', 'm', 'h'];
	const format = (number: number, unit: number) =>
		`${new Intl.NumberFormat(locale, { maximumFractionDigits: 1, useGrouping: false }).format(number)}${space}${units[unit]}`;
	if (value < 1000) return format(Math.round(value), 0);
	if (value < 10000) return format(value / 1000, 1);
	if (seconds < 60) return format(seconds, 1);
	if (seconds < 3600)
		return [format(Math.floor(seconds / 60), 2), seconds % 60 ? format(seconds % 60, 1) : '']
			.filter(Boolean)
			.join(' ');
	return [
		format(Math.floor(seconds / 3600), 3),
		Math.floor((seconds % 3600) / 60) ? format(Math.floor((seconds % 3600) / 60), 2) : '',
	]
		.filter(Boolean)
		.join(' ');
}
