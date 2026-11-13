import { t, planPartCountLabel, type Locale } from './messages';
import { formatDuration } from './duration';
import { formatTokenCount } from './change-count';
import type { AutoBudget, AutoPartRefusal } from './auto';
/**
 * spec/chat-turns-plans-and-questions#hire-card: the words of the hire card and its rows. Counts agree with the noun in Ukrainian in four
 * forms (rule 9); a part's budget is minutes and the app's token counter (`40 min · 400k`), the header's sum a duration (`1h 50m`).
 */
type Forms = { one: string; few: string; many: string; other: string };
function word(locale: Locale, count: number, en: readonly [string, string], uk: Forms): string {
	if (locale === 'en') return count === 1 ? en[0] : en[1];
	return uk[new Intl.PluralRules('uk').select(count) as keyof Forms] ?? uk.other;
}
const number = (locale: Locale, count: number) => new Intl.NumberFormat(locale).format(count);
/** «воркера / воркерів» after a verb: `хоче найняти 3 воркерів`, `Найнято 1 воркера`. */
const workers: Forms = { one: 'воркера', few: 'воркерів', many: 'воркерів', other: 'воркера' };
/** `Claude wants to hire 3 workers` / `Claude хоче найняти 3 воркерів`. */
export function hireTitle(locale: Locale, agent: string, count: number): string {
	return t(locale, '{agent} wants to hire {n} {workers}')
		.replace('{agent}', agent)
		.replace('{n}', number(locale, count))
		.replace('{workers}', word(locale, count, ['worker', 'workers'], workers));
}
/** The folded card: `Hired 3 workers` / `Найнято 3 воркерів`. */
export function hiredTitle(locale: Locale, count: number): string {
	return t(locale, 'Hired {n} {workers}')
		.replace('{n}', number(locale, count))
		.replace('{workers}', word(locale, count, ['worker', 'workers'], workers));
}
/** A part's budget, as the canvas draws the chip: `40 min · 400k` / `40 хв · 400k`. */
export function budgetLabel(locale: Locale, budget: AutoBudget): string {
	return `${t(locale, '{n} min').replace('{n}', number(locale, budget.minutes))} · ${formatTokenCount(budget.tokens)}`;
}
/** The header's sum: `1h 50m · 1.1m tokens`. */
export function hireTotalLabel(locale: Locale, total: AutoBudget): string {
	return `${formatDuration(locale, total.minutes * 60_000)} · ${t(locale, '{n} tokens').replace('{n}', formatTokenCount(total.tokens))}`;
}
/** Why the host keeps a part with the agent, in the interface language (the agent reads the English `message`). */
export function refusalText(locale: Locale, refusal: AutoPartRefusal): string {
	if (refusal.code === 'overlap')
		return refusal.part !== null
			? t(locale, 'Not independent: part {n} writes {path} too.')
					.replace('{n}', number(locale, refusal.part))
					.replace('{path}', refusal.path)
			: t(locale, 'Not independent: {worker} already writes {path}.')
					.replace('{worker}', refusal.worker ?? '')
					.replace('{path}', refusal.path);
	const lines = `${number(locale, refusal.lines)} ${word(locale, refusal.lines, ['line', 'lines'], {
		one: 'рядка',
		few: 'рядків',
		many: 'рядків',
		other: 'рядка',
	})}`;
	return refusal.files <= 1
		? t(locale, 'Too small for a worker: about {lines} in one file.').replace('{lines}', lines)
		: t(locale, 'Too small for a worker: about {lines} in {files}.')
				.replace('{lines}', lines)
				.replace(
					'{files}',
					`${number(locale, refusal.files)} ${word(locale, refusal.files, ['files', 'files'], {
						one: 'файлі',
						few: 'файлах',
						many: 'файлах',
						other: 'файла',
					})}`
				);
}
/** `Part 3 stays with Claude.` / `Parts 3 and 4 stay with Claude.` — the footer when the host keeps parts with the agent. */
export function staysWithLabel(locale: Locale, parts: readonly number[], agent: string): string {
	const numbers = parts.map((item) => number(locale, item));
	const list =
		numbers.length > 1
			? `${numbers.slice(0, -1).join(', ')} ${t(locale, 'and')} ${numbers.at(-1)}`
			: (numbers[0] ?? '');
	return t(
		locale,
		numbers.length === 1 ? 'Part {n} stays with {agent}.' : 'Parts {n} stay with {agent}.'
	)
		.replace('{n}', list)
		.replace('{agent}', agent);
}
/** The hire card's footer: `3 parts for 3 workers` / `3 частини для 3 воркерів`. */
export function hireSplitLabel(locale: Locale, parts: number, hired: number): string {
	return t(locale, '{parts} for {n} {workers}')
		.replace('{parts}', planPartCountLabel(locale, parts))
		.replace('{n}', number(locale, hired))
		.replace('{workers}', word(locale, hired, ['worker', 'workers'], workers));
}
