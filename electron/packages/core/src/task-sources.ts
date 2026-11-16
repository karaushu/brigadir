import { planSlug } from './plan-approval';
import { isRecord } from './workspace';

/**
 * spec/reviews#save-source: the ticket, spec or contract a plan is written from, saved by the task's agent next to the plans so a reviewer on
 * any provider reads the same version (`sources/sources.json` and one Markdown file per source).
 */
export type TaskSourceEntry = {
	id: string;
	title: string;
	url?: string;
	/** The Markdown file in `sources/`. */
	file: string;
	chars: number;
	savedAt: string;
};
export type TaskSourcesDocument = { schemaVersion: 1; sources: TaskSourceEntry[] };
export const emptyTaskSources: TaskSourcesDocument = { schemaVersion: 1, sources: [] };
export const sourceTitleLimit = 200,
	sourceUrlLimit = 2000,
	sourceTextLimit = 200_000,
	sourcesPerTask = 20,
	sourcesCharsPerTask = 1_000_000;
const text = (value: unknown, limit: number): value is string =>
	typeof value === 'string' && value.length <= limit;
export function isTaskSourceEntry(value: unknown): value is TaskSourceEntry {
	return (
		isRecord(value) &&
		text(value.id, 200) &&
		value.id.length > 0 &&
		text(value.title, sourceTitleLimit) &&
		(value.url === undefined || text(value.url, sourceUrlLimit)) &&
		text(value.file, 300) &&
		/^[a-z0-9-]+\.md$/.test(value.file) &&
		Number.isSafeInteger(value.chars) &&
		Number(value.chars) >= 0 &&
		text(value.savedAt, 64)
	);
}
export function isTaskSourcesDocument(value: unknown): value is TaskSourcesDocument {
	return (
		isRecord(value) &&
		value.schemaVersion === 1 &&
		Array.isArray(value.sources) &&
		value.sources.length <= sourcesPerTask &&
		value.sources.every(isTaskSourceEntry)
	);
}
/** The slug of a source's file: the plan copies' rule, `source` when the title has nothing usable. */
export function sourceSlug(title: string): string {
	const slug = planSlug(title);
	return slug === 'plan' && !/plan/i.test(title) ? 'source' : slug;
}
/**
 * spec/reviews#save-source: `save_source` arguments checked against the task's sources. A title that exists (case ignored) replaces that source.
 * Errors are English for the agent (rule 12) and name the limit.
 */
export function checkSource(
	input: { title?: unknown; url?: unknown; text?: unknown },
	existing: readonly TaskSourceEntry[]
): { title: string; url?: string; text: string; replaces: TaskSourceEntry | null } {
	const title = typeof input.title === 'string' ? input.title.trim() : '';
	if (!title) throw new Error('title is required');
	if (title.length > sourceTitleLimit)
		throw new Error(`title is at most ${sourceTitleLimit} characters`);
	let url: string | undefined;
	if (input.url !== undefined && input.url !== null && input.url !== '') {
		if (typeof input.url !== 'string' || input.url.length > sourceUrlLimit)
			throw new Error(`url is an http(s) address of at most ${sourceUrlLimit} characters`);
		if (!/^https?:\/\/[^\s/?#]+[^\s]*$/i.test(input.url.trim()))
			throw new Error(`url is an http(s) address of at most ${sourceUrlLimit} characters`);
		url = input.url.trim();
	}
	const body = typeof input.text === 'string' ? input.text : '';
	if (!body.trim()) throw new Error('text is required: the source as it reads');
	if (body.length > sourceTextLimit)
		throw new Error(
			`text is at most ${sourceTextLimit} characters; save the part the plan is written from, or split it into several sources`
		);
	const replaces =
		existing.find((item) => item.title.toLowerCase() === title.toLowerCase()) ?? null;
	const others = existing.filter((item) => item !== replaces);
	if (others.length >= sourcesPerTask)
		throw new Error(`A task keeps at most ${sourcesPerTask} sources`);
	if (others.reduce((sum, item) => sum + item.chars, 0) + body.length > sourcesCharsPerTask)
		throw new Error(`A task's sources hold at most ${sourcesCharsPerTask} characters in all`);
	return { title, ...(url ? { url } : {}), text: body, replaces };
}
