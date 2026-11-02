import type { GutterHunk } from './changes';
import type { Locale } from './messages';

/** spec/editor#line-author: the commit that last changed a line, as `git blame --porcelain` names it. */
export type BlameCommit = { sha: string; author: string; time: number; summary: string };
/** Per buffer line: an index into `commits`, or a marker: changed on disk since the last commit, changed only in the
 *  buffer, or no line on disk (the empty line after a final newline), which has no author. */
export const blameUncommitted = -1,
	blameUnsaved = -2,
	blameNoLine = -3;
/**
 * The line author of one open file (spec/editor#line-author). `lines[i]` belongs to buffer line `i + 1`; `origins[i]` is that line's
 * number in its commit, 0 for a line without one. `untracked`: Git does not track the file yet; `none`: the file is in no
 * Git root, or binary; `too-large`: over the blame limits.
 */
export type EditorBlame =
	| {
			state: 'ready';
			scopeId: string;
			path: string;
			commits: BlameCommit[];
			lines: number[];
			origins: number[];
	  }
	| { state: 'untracked'; scopeId: string; path: string }
	| { state: 'none' | 'too-large' };
export const blameLineLimit = 20_000,
	blameByteLimit = 1024 * 1024;

/**
 * The disk line each buffer line stands for, 0 for a line the buffer changed. `hunks` compare the disk text (before) with
 * the buffer (after), as `lineHunks` returns them: `start` is the first changed buffer line, a pure deletion has `count` 0.
 */
export function bufferToDisk(hunks: readonly GutterHunk[], bufferLines: number): Int32Array {
	const out = new Int32Array(bufferLines);
	let shift = 0,
		next = 0;
	for (let line = 1; line <= bufferLines; line++) {
		// Hunks wholly above this line move the disk numbering by their added minus removed lines.
		while (next < hunks.length) {
			const hunk = hunks[next]!;
			if (hunk.count ? hunk.start + hunk.count - 1 >= line : hunk.start >= line) break;
			shift += hunk.count - hunk.removedCount;
			next++;
		}
		const hunk = hunks[next];
		out[line - 1] = hunk && hunk.count && line >= hunk.start ? 0 : line - shift;
	}
	return out;
}

const plural = (
	locale: Locale,
	count: number,
	uk: { one: string; few: string; many: string; other: string },
	en: [string, string]
) => {
	if (locale === 'en') return `${count} ${count === 1 ? en[0] : en[1]}`;
	const form = new Intl.PluralRules('uk').select(count) as keyof typeof uk;
	return `${new Intl.NumberFormat('uk').format(count)} ${uk[form] ?? uk.other}`;
};
const units = {
	minute: [
		{ one: 'хвилину', few: 'хвилини', many: 'хвилин', other: 'хвилини' },
		['minute', 'minutes'],
	],
	hour: [{ one: 'годину', few: 'години', many: 'годин', other: 'години' }, ['hour', 'hours']],
	day: [{ one: 'день', few: 'дні', many: 'днів', other: 'дня' }, ['day', 'days']],
	week: [{ one: 'тиждень', few: 'тижні', many: 'тижнів', other: 'тижня' }, ['week', 'weeks']],
	month: [{ one: 'місяць', few: 'місяці', many: 'місяців', other: 'місяця' }, ['month', 'months']],
	year: [{ one: 'рік', few: 'роки', many: 'років', other: 'року' }, ['year', 'years']],
} as const;
type Unit = keyof typeof units;
const count = (locale: Locale, unit: Unit, value: number) =>
	plural(locale, value, units[unit][0], units[unit][1] as unknown as [string, string]);
/** Calendar-ish parts of an age: years and months from 30.44-day months, the rest from exact units. */
function parts(time: number, now: number) {
	const seconds = Math.max(0, Math.floor((now - time) / 1000)),
		minutes = Math.floor(seconds / 60),
		hours = Math.floor(minutes / 60),
		days = Math.floor(hours / 24);
	const months = Math.floor(days / 30.44),
		years = Math.floor(months / 12);
	return {
		seconds,
		minutes,
		hours,
		days,
		weeks: Math.floor(days / 7),
		months,
		years,
		restMonths: months - years * 12,
	};
}
/** spec/editor#line-author: the line author's long age, four `uk` forms: «1 рік 7 місяців тому», `1 year, 7 months ago`. */
export function ageAgo(locale: Locale, time: number, now: number = Date.now()): string {
	const p = parts(time, now),
		ago = (text: string) => (locale === 'uk' ? `${text} тому` : `${text} ago`);
	if (p.minutes < 1) return locale === 'uk' ? 'щойно' : 'just now';
	if (p.hours < 1) return ago(count(locale, 'minute', p.minutes));
	if (p.days < 1) return ago(count(locale, 'hour', p.hours));
	if (p.days < 7) return ago(count(locale, 'day', p.days));
	if (p.months < 1) return ago(count(locale, 'week', Math.max(1, p.weeks)));
	if (p.years < 1) return ago(count(locale, 'month', p.months));
	const year = count(locale, 'year', p.years);
	return ago(
		p.restMonths
			? `${year}${locale === 'uk' ? ' ' : ', '}${count(locale, 'month', p.restMonths)}`
			: year
	);
}
/** spec/editor#line-author: the History list's short age: `5 хв`, `4 дн`, `2 тиж`, `4 міс`, `1 р 7 міс`. */
export function ageShort(locale: Locale, time: number, now: number = Date.now()): string {
	const p = parts(time, now),
		uk = locale === 'uk';
	if (p.minutes < 1) return uk ? 'зараз' : 'now';
	if (p.hours < 1) return uk ? `${p.minutes} хв` : `${p.minutes} min`;
	if (p.days < 1) return uk ? `${p.hours} год` : `${p.hours} hr`;
	if (p.days < 14) return uk ? `${p.days} дн` : `${p.days} d`;
	if (p.months < 2 && p.weeks < 9) return uk ? `${p.weeks} тиж` : `${p.weeks} wk`;
	if (p.years < 1) return uk ? `${p.months} міс` : `${p.months} mo`;
	const year = uk ? `${p.years} р` : `${p.years} yr`;
	return p.restMonths ? `${year} ${p.restMonths} ${uk ? 'міс' : 'mo'}` : year;
}
/** `6 комітів із цим файлом`, four `uk` forms. */
export function fileCommitCount(locale: Locale, value: number, more = false): string {
	const number = `${new Intl.NumberFormat(locale).format(value)}${more ? '+' : ''}`;
	if (locale === 'en')
		return `${number} ${value === 1 && !more ? 'commit' : 'commits'} with this file`;
	const form = more ? 'many' : new Intl.PluralRules('uk').select(value);
	return `${number} ${({ one: 'коміт', few: 'коміти', many: 'комітів', other: 'коміту' } as Record<string, string>)[form] ?? 'коміту'} із цим файлом`;
}
/** Two letters for the card's avatar: `Ada Lovelace` → `AL`, `dmytro` → `D`. */
export function authorInitials(name: string): string {
	const words = name.trim().split(/\s+/).filter(Boolean);
	return (
		words.length > 1 ? words[0]![0]! + words.at(-1)![0]! : (words[0]?.[0] ?? '?')
	).toLocaleUpperCase();
}
