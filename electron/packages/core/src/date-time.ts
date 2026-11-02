/** User-facing dates are European regardless of UI language; storage stays ISO. */
type DateValue = string | number | Date;
type DateOptions = { timeZone?: string; seconds?: boolean };
export function formatDate(value: DateValue, { timeZone }: DateOptions = {}): string {
	const parts = new Intl.DateTimeFormat('en-GB', {
		day: '2-digit',
		month: '2-digit',
		year: 'numeric',
		...(timeZone ? { timeZone } : {}),
	}).formatToParts(new Date(value));
	const part = (type: Intl.DateTimeFormatPartTypes) =>
		parts.find((part) => part.type === type)!.value;
	return `${part('day')}.${part('month')}.${part('year')}`;
}
export function formatTime(
	value: DateValue,
	{ timeZone, seconds = false }: DateOptions = {}
): string {
	return new Intl.DateTimeFormat('en-GB', {
		hour: '2-digit',
		minute: '2-digit',
		...(seconds ? { second: '2-digit' } : {}),
		hourCycle: 'h23',
		...(timeZone ? { timeZone } : {}),
	}).format(new Date(value));
}
export function formatDateTime(value: DateValue, options: DateOptions = {}): string {
	return `${formatDate(value, options)} · ${formatTime(value, options)}`;
}
