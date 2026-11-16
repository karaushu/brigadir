import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import {
	checkSource,
	emptyTaskSources,
	isTaskSourcesDocument,
	planReadLimit,
	sourceSlug,
	type SessionEvent,
	type TaskKey,
	type TaskSourceEntry,
	type TaskSourcesDocument,
} from '@brigadir/core';
import {
	atomicJson,
	atomicText,
	readDocument,
	safePath,
	type SessionStore,
} from '@brigadir/persistence';

/**
 * spec/reviews#save-source: the sources a task's agent saves next to its plans — `sources/sources.json` and one Markdown file per source — and
 * what a reviewer reads of them.
 */
async function folder(store: SessionStore, key: TaskKey) {
	return safePath(await store.taskDir(key), 'sources');
}
export async function readTaskSources(
	store: SessionStore,
	key: TaskKey
): Promise<TaskSourcesDocument> {
	try {
		const doc = await readDocument(await safePath(await folder(store, key), 'sources.json'));
		return isTaskSourcesDocument(doc) ? doc : emptyTaskSources;
	} catch {
		return emptyTaskSources;
	}
}
/** The path of a saved source's text, or null when the entry's file is not a plain name. */
export async function sourcePath(store: SessionStore, key: TaskKey, entry: TaskSourceEntry) {
	return safePath(await folder(store, key), entry.file);
}
const saving = new Map<string, Promise<unknown>>();
/** `save_source`: checked against the limits, written, recorded in the index and the journal; one save of a task at a time. */
export function saveTaskSource(
	store: SessionStore,
	key: TaskKey,
	input: Record<string, unknown>,
	emit: (event: SessionEvent) => Promise<void>
) {
	const id = `${key.projectId}/${key.id}`,
		result = (saving.get(id) ?? Promise.resolve())
			.catch(() => {})
			.then(() => save(store, key, input, emit));
	saving.set(id, result);
	return result;
}
async function save(
	store: SessionStore,
	key: TaskKey,
	input: Record<string, unknown>,
	emit: (event: SessionEvent) => Promise<void>
) {
	const doc = await readTaskSources(store, key),
		checked = checkSource(input, doc.sources),
		id = checked.replaces?.id ?? randomUUID(),
		hash = createHash('sha256').update(id).digest('hex').slice(0, 8),
		file = `${sourceSlug(checked.title)}-${hash}.md`,
		dir = await folder(store, key);
	await mkdir(dir, { recursive: true });
	// The text is replaced whole or not at all; an older file under another name goes only after the index names the new one.
	await atomicText(await safePath(dir, file), checked.text);
	const entry: TaskSourceEntry = {
		id,
		title: checked.title,
		...(checked.url ? { url: checked.url } : {}),
		file,
		chars: checked.text.length,
		savedAt: new Date().toISOString(),
	};
	const sources = [...doc.sources.filter((item) => item.id !== id), entry];
	await atomicJson(await safePath(dir, 'sources.json'), { schemaVersion: 1, sources });
	if (checked.replaces && checked.replaces.file !== file)
		await rm(await safePath(dir, checked.replaces.file), { force: true });
	await emit({
		kind: 'source.saved',
		id,
		title: entry.title,
		...(entry.url ? { url: entry.url } : {}),
		chars: entry.chars,
	});
	return { saved: true, id, chars: entry.chars };
}
/**
 * spec/reviews#plan-inputs: `read_sources` — every source with its text while the call stays under the read limit, the rest listed without
 * text; `sourceId` reads one whole (cut at the limit).
 */
export async function readSourcesForReview(
	store: SessionStore,
	key: TaskKey,
	sourceId?: unknown,
	limit = planReadLimit
) {
	const doc = await readTaskSources(store, key);
	const one = typeof sourceId === 'string' && sourceId ? sourceId : null;
	const list = one ? doc.sources.filter((item) => item.id === one) : doc.sources;
	if (one && !list.length)
		throw new Error(
			`No source ${one}. Sources: ${doc.sources.map((item) => item.id).join(', ') || 'none'}`
		);
	let left = limit,
		cut = false;
	const sources = [];
	for (const entry of list) {
		const body = await readFile(await sourcePath(store, key, entry), 'utf8').catch(() => '');
		const head = {
			id: entry.id,
			title: entry.title,
			...(entry.url ? { url: entry.url } : {}),
			chars: entry.chars,
		};
		if (left <= 0) {
			cut = true;
			sources.push(head);
			continue;
		}
		const text = body.slice(0, left);
		if (text.length < body.length) cut = true;
		left -= text.length;
		sources.push({ ...head, text });
	}
	return {
		sources,
		...(cut
			? {
					note: `Texts are cut at ${limit} characters per call; pass sourceId to read one source whole.`,
				}
			: {}),
		...(!doc.sources.length ? { note: 'The author saved no sources.' } : {}),
	};
}
