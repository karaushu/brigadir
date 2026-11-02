import {
	codeLimits,
	codeWordAt,
	syntaxLanguage,
	type PRDefinitionAnswer,
	type PRDefinitionPlace,
	type Scope,
} from '@brigadir/core';
import { git, readBlobs, repoPath, treeBlob } from '@brigadir/git';

export type Declarations = (
	language: string,
	texts: string[],
	name: string
) => Promise<{ index: number; from: number }[]>;
// spec/editor-code-intelligence#typing-help: JS, TS and TSX import each other, so the search looks through all three.
const scriptLanguages = ['javascript', 'typescript', 'tsx'];
const family = (language: string) =>
	scriptLanguages.includes(language) ? scriptLanguages : [language];
const lineStarts = (text: string) => {
	const starts = [0];
	for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', at + 1)) starts.push(at + 1);
	return starts;
};
function place(
	path: string,
	text: string,
	starts: number[],
	from: number,
	changed: boolean
): PRDefinitionPlace {
	let low = 0,
		high = starts.length - 1;
	while (low < high) {
		const mid = (low + high + 1) >> 1;
		if (starts[mid]! <= from) low = mid;
		else high = mid - 1;
	}
	const end = text.indexOf('\n', starts[low]!),
		line = text.slice(starts[low]!, end < 0 ? undefined : end).replace(/\r$/, '');
	return {
		path,
		line: low + 1,
		column: from - starts[low]! + 1,
		preview: line.trim().slice(0, 300),
		changed,
	};
}
/** Paths of `tree` that contain `word` as a whole word, by one `git grep` over the tree: no checkout, no disk (spec/pull-requests-and-ci#pr-definition). */
async function grep(scope: Scope, tree: string, word: string): Promise<string[]> {
	try {
		const bytes = await git(
			repoPath(scope),
			['grep', '-l', '-z', '-I', '-w', '-F', '-e', word, tree, '--'],
			{ maxBytes: 4 * 1024 * 1024, timeoutMs: 5000 }
		);
		return bytes
			.toString('utf8')
			.split('\0')
			.filter(Boolean)
			.map((entry) => entry.slice(tree.length + 1));
	} catch {
		return [];
	} // exit 1 is «no match»
}
/** Blob ids of `paths` in `tree`, one `ls-tree` for the whole batch. */
async function blobs(scope: Scope, tree: string, paths: string[]): Promise<Map<string, string>> {
	const found = new Map<string, string>();
	if (!paths.length) return found;
	const bytes = await git(
		repoPath(scope),
		['ls-tree', '-z', '--full-tree', tree, '--', ...paths.map((path) => `:(literal)${path}`)],
		{ maxBytes: 1024 * 1024 }
	);
	for (const entry of bytes.toString('utf8').split('\0')) {
		const match = /^\d+ blob ([a-f0-9]+)\t(.+)$/s.exec(entry);
		if (match) found.set(match[2]!, match[1]!);
	}
	return found;
}
/**
 * spec/pull-requests-and-ci#pr-definition: ⌘+click on a name in the new side of a PR file. The clicked line must still be that line of the head blob; then
 * the name's declarations in the same file (nearest above first), else across the head tree: files of the PR first, then the
 * nearest directories, within 200 files and the reading budget.
 */
export async function findPRDefinition(input: {
	scope: Scope;
	tree: string;
	path: string;
	line: number;
	column: number;
	text: string;
	changed: ReadonlySet<string>;
	declarations: Declarations;
	budget?: number;
}): Promise<PRDefinitionAnswer> {
	const { scope, tree, path } = input;
	const blob = await treeBlob(scope, tree, path);
	if (!blob) return { state: 'stale' };
	const [file] = await readBlobs(scope, [blob]);
	const empty: PRDefinitionAnswer = { state: 'found', word: '', places: [], truncated: false };
	if (!file || file.binary || file.tooLarge) return empty;
	const text = file.text,
		starts = lineStarts(text),
		start = starts[input.line - 1];
	if (start === undefined) return { state: 'stale' };
	const end = text.indexOf('\n', start);
	if (
		text.slice(start, end < 0 ? undefined : end).replace(/\r$/, '') !==
		input.text.replace(/\r$/, '')
	)
		return { state: 'stale' };
	const language = syntaxLanguage(path),
		word = codeWordAt(input.text, input.column - 1, language);
	if (!word || !language) return empty;
	const clicked = start + word.from,
		changed = (candidate: string) => input.changed.has(candidate);
	const own = await input.declarations(language, [text], word.word);
	const local = own
		.filter((found) => found.from !== clicked)
		.sort(
			(a, b) =>
				(a.from < clicked ? clicked - a.from : 1e12 + a.from) -
				(b.from < clicked ? clicked - b.from : 1e12 + b.from)
		);
	const answer = (places: PRDefinitionPlace[]): PRDefinitionAnswer => ({
		state: 'found',
		word: word.word,
		places: places.slice(0, codeLimits.definitions),
		truncated: places.length > codeLimits.definitions,
	});
	if (local.length)
		return answer(local.map((found) => place(path, text, starts, found.from, changed(path))));
	const languages = family(language),
		here = path.split('/').slice(0, -1);
	const shared = (candidate: string) => {
		const parts = candidate.split('/').slice(0, -1);
		let n = 0;
		while (n < parts.length && parts[n] === here[n]) n++;
		return n;
	};
	const candidates = (await grep(scope, tree, word.word))
		.filter(
			(candidate) => candidate !== path && languages.includes(syntaxLanguage(candidate) ?? '')
		)
		.sort(
			(a, b) =>
				Number(changed(b)) - Number(changed(a)) || shared(b) - shared(a) || a.localeCompare(b)
		)
		.slice(0, 200);
	const deadline = Date.now() + (input.budget ?? 2000),
		result: PRDefinitionPlace[] = [];
	for (
		let at = 0;
		at < candidates.length && result.length < codeLimits.definitions && Date.now() <= deadline;
		at += 20
	) {
		const batch = candidates.slice(at, at + 20),
			ids = await blobs(scope, tree, batch).catch(() => new Map<string, string>());
		const read = batch.filter((candidate) => ids.has(candidate));
		const texts = await readBlobs(
			scope,
			read.map((candidate) => ids.get(candidate)!)
		).catch(() => null);
		if (!texts) continue;
		const files = read
			.map((candidate, index) => ({ path: candidate, ...texts[index]! }))
			.filter((item) => !item.binary && !item.tooLarge);
		// Each file is parsed with its own grammar: a TSX file is not TypeScript.
		for (const group of new Set(files.map((item) => syntaxLanguage(item.path)!))) {
			const members = files.filter((item) => syntaxLanguage(item.path) === group);
			for (const found of await input.declarations(
				group,
				members.map((item) => item.text),
				word.word
			)) {
				const item = members[found.index];
				if (item)
					result.push(
						place(item.path, item.text, lineStarts(item.text), found.from, changed(item.path))
					);
			}
		}
	}
	// The click was on the declaration itself: it is the answer.
	if (!result.length && own.length)
		result.push(place(path, text, starts, own[0]!.from, changed(path)));
	return answer(result);
}
