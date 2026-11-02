import { join, relative } from 'node:path';
import { inTask, isGitScope, type ScopeChoice } from '@brigadir/core';
import { gitText } from '@brigadir/git';

/** One hit for the mention menu: the path from its repo's root and the repo it belongs to. */
export type ProjectFileHit = {
	path: string;
	scope: string;
	scopePath: string;
	/** spec/composer#mention-menu: a folder, not a file. */ directory?: true;
};

const limit = 20,
	ttl = 5000;
/** `folders` — every folder the listed files lie in (spec/composer#mention-menu); git lists files only. */
type Listing = { paths: string[]; lower: string[]; folders: string[]; lowerFolders: string[] };
const listings = new Map<string, { at: number | null; promise: Promise<Listing> }>();
/**
 * A repo's file list while typing in the menu: `git ls-files --others` walks the whole untracked tree, so an
 * in-flight request is shared and its age counts from completion. A new file shows up within 5 s.
 */
function listing(scopePath: string, now: () => number): Promise<Listing> {
	const cached = listings.get(scopePath);
	if (cached && (cached.at === null || now() - cached.at <= ttl)) return cached.promise;
	const entry: { at: number | null; promise: Promise<Listing> } = {
		at: null,
		promise: gitText(scopePath, ['ls-files', '--cached', '--others', '--exclude-standard'])
			.catch(() => '')
			.then((listed) => {
				const paths = listed.split('\n').filter(Boolean),
					folders = new Set<string>();
				for (const path of paths)
					for (
						let at = path.lastIndexOf('/');
						at > 0 && !folders.has(path.slice(0, at));
						at = path.lastIndexOf('/', at - 1)
					)
						folders.add(path.slice(0, at));
				const sorted = [...folders].sort();
				return {
					paths,
					lower: paths.map((path) => path.toLocaleLowerCase()),
					folders: sorted,
					lowerFolders: sorted.map((path) => path.toLocaleLowerCase()),
				};
			}),
	};
	listings.set(scopePath, entry);
	if (listings.size > 16) listings.delete(listings.keys().next().value!);
	void entry.promise.then(() => {
		entry.at = now();
	});
	return entry.promise;
}

/**
 * spec/tasks#sheet-layout: the `@` menu on the launch sheet searches files before the task exists.
 * The source is `git ls-files` of the selected git repos, i.e. what git already shows the person;
 * a folder without git is left out, since it has no index (spec/projects-and-board#external-folders).
 */
export async function searchProjectFiles(
	root: string,
	scopes: readonly (ScopeChoice & { path?: string })[],
	query: string,
	now: () => number = Date.now
): Promise<ProjectFileHit[]> {
	const groups: (Listing & { scope: string; scopePath: string })[] = [];
	for (const scope of scopes.filter((scope) => inTask(scope) && isGitScope(scope))) {
		const scopePath = scope.path ?? (scope.name === '.' ? root : join(root, scope.name));
		groups.push({
			...(await listing(scopePath, now)),
			scope: scope.name,
			scopePath: relative(root, scopePath) || '.',
		});
	}
	return rankProjectFiles(groups, query);
}
/** Scores each path once and keeps the best `limit` in order: score, length, then listing order, as the stable sort did. */
export function rankProjectFiles(
	groups: readonly (Listing & { scope: string; scopePath: string })[],
	query: string
): ProjectFileHit[] {
	const needle = query.toLocaleLowerCase().trim();
	type Row = { hit: ProjectFileHit; score: number };
	const best: Row[] = [];
	const worse = (a: Row, b: Row) => a.score - b.score || a.hit.path.length - b.hit.path.length;
	const offer = (hit: ProjectFileHit, lower: string) => {
		const score = fuzzy(lower, needle);
		if (score === null) return;
		const row = { hit, score };
		if (best.length === limit && worse(row, best[limit - 1]!) >= 0) return;
		let at = best.length;
		while (at > 0 && worse(row, best[at - 1]!) < 0) at--;
		best.splice(at, 0, row);
		if (best.length > limit) best.pop();
	};
	for (const { paths, lower, folders, lowerFolders, scope, scopePath } of groups) {
		for (let i = 0; i < paths.length; i++) offer({ path: paths[i]!, scope, scopePath }, lower[i]!);
		for (let i = 0; i < folders.length; i++)
			offer({ path: folders[i]!, scope, scopePath, directory: true }, lowerFolders[i]!);
	}
	return best.map((row) => row.hit);
}

/**
 * Lower is better. An empty query passes everything. An exact substring beats scattered letters, and a match in the
 * file name beats one only in folders (spec/composer#mention-menu): `sse` finds `useSse.ts` before `src/assets/news.jpg`.
 * Tiers: name exact < path exact < name scattered < path scattered; within a tier: position, gaps, length.
 */
export function fuzzy(value: string, needle: string): number | null {
	if (!needle) return value.length;
	const name = value.slice(value.lastIndexOf('/') + 1),
		length = value.length * 0.01;
	const inName = name.indexOf(needle);
	if (inName >= 0) return inName + length;
	const exact = value.indexOf(needle);
	if (exact >= 0) return 500 + exact + length;
	const nameGaps = scattered(name, needle);
	if (nameGaps !== null) return 1000 + nameGaps + length;
	const gaps = scattered(value, needle);
	return gaps === null ? null : 5000 + gaps + length;
}
function scattered(value: string, needle: string): number | null {
	let cursor = 0,
		gaps = 0;
	for (const char of needle) {
		const next = value.indexOf(char, cursor);
		if (next < 0) return null;
		gaps += next - cursor;
		cursor = next + 1;
	}
	return gaps;
}
