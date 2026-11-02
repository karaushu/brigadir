import type { Locale } from './messages';
/**
 * spec/diff-and-review#change-counters: the one format of a line-change counter (`+N −M`). Below 1000 the number as is; from 1000 one decimal,
 * truncated (never rounded up, so the counter never shows more than changed), a dot in both locales, no trailing `.0`,
 * suffix `k`, from a million `M`. The exact value lives in the title and the accessible name ({@link formatChangeCountFull}).
 */
export function formatChangeCount(value: number): string {
	const count = Math.max(0, Number.isFinite(value) ? Math.floor(value) : 0);
	if (count < 1000) return String(count);
	const [unit, suffix] = count < 1_000_000 ? [1000, 'k'] : [1_000_000, 'M'],
		tenths = Math.floor(count / (unit / 10)),
		whole = Math.floor(tenths / 10),
		fraction = tenths % 10;
	return `${whole}${fraction ? `.${fraction}` : ''}${suffix}`;
}
/** spec/appearance#evolution-redesign: a token counter, short as spec/diff-and-review#change-counters — 1, 10, 100, 1k, 1.5k, 10k, 100k, 1m, 10m (lowercase `m`: tokens, not
 *  a change count). The context meter reads `156k / 200k tokens`, a subagent `34k tokens`. */
export const formatTokenCount = (value: number): string =>
	formatChangeCount(value).replace(/M$/, 'm');
/** True when {@link formatChangeCount} shortens the value, so the exact one has to be offered separately. */
export const isCompactChangeCount = (value: number) =>
	formatChangeCount(value) !== String(Math.max(0, Number.isFinite(value) ? Math.floor(value) : 0));
const fullFormats = new Map<Locale, Intl.NumberFormat>();
/** The exact count with the locale's grouping: `3 150` in `uk`, `3,150` in `en`. */
export function formatChangeCountFull(locale: Locale, value: number): string {
	let format = fullFormats.get(locale);
	if (!format) {
		format = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
		fullFormats.set(locale, format);
	}
	return format.format(Math.max(0, Number.isFinite(value) ? Math.floor(value) : 0));
}
/** The exact pair `+3 150 −245` for a tooltip or an accessible name. */
export const changeCountsLabel = (locale: Locale, additions: number, deletions: number) =>
	`+${formatChangeCountFull(locale, additions)} −${formatChangeCountFull(locale, deletions)}`;
/** The tooltip of a counter pair: the exact pair, only when one of the two is shortened. */
export const changeCountsTitle = (locale: Locale, additions: number, deletions: number) =>
	isCompactChangeCount(additions) || isCompactChangeCount(deletions)
		? changeCountsLabel(locale, additions, deletions)
		: undefined;
