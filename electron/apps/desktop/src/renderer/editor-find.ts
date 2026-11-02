import { EditorSelection, type EditorState, type Text } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
	getSearchQuery,
	openSearchPanel,
	search,
	searchPanelOpen,
	SearchQuery,
	setSearchQuery,
} from '@codemirror/search';

/**
 * spec/editor#editor-chrome: the floating find panel keeps CodeMirror's search — its query, its match highlight and its commands —
 * and draws its own panel (`ui/FindPanel`). Here: the matches of the query, counted once per document and query.
 */
export const findLimit = 10000;
type Matches = { ranges: { from: number; to: number }[]; capped: boolean };
const cache = new WeakMap<Text, { query: SearchQuery; matches: Matches }>();

export function findMatches(state: EditorState): Matches {
	const query = getSearchQuery(state);
	if (!query.valid) return { ranges: [], capped: false };
	const known = cache.get(state.doc);
	if (known && known.query.eq(query)) return known.matches;
	const ranges: { from: number; to: number }[] = [];
	let capped = false;
	const cursor = query.getCursor(state);
	for (let next = cursor.next(); !next.done; next = cursor.next()) {
		if (ranges.length === findLimit) {
			capped = true;
			break;
		}
		ranges.push({ from: next.value.from, to: next.value.to });
	}
	const matches = { ranges, capped };
	cache.set(state.doc, { query, matches });
	return matches;
}

export type FindStatus =
	| { kind: 'empty' }
	| { kind: 'invalid' }
	| { kind: 'none' }
	| { kind: 'found'; current: number | null; total: number; capped: boolean };

/** What the counter says: the match the selection stands on (1-based), of how many. */
export function findStatus(state: EditorState): FindStatus {
	const query = getSearchQuery(state);
	if (!query.search) return { kind: 'empty' };
	if (!query.valid) return { kind: 'invalid' };
	const { ranges, capped } = findMatches(state);
	if (!ranges.length) return { kind: 'none' };
	const { from, to } = state.selection.main;
	let low = 0,
		high = ranges.length - 1,
		current: number | null = null;
	while (low <= high) {
		const middle = (low + high) >> 1,
			range = ranges[middle]!;
		if (range.from < from) low = middle + 1;
		else if (range.from > from) high = middle - 1;
		else {
			current = range.to === to ? middle + 1 : null;
			break;
		}
	}
	return { kind: 'found', current, total: ranges.length, capped };
}

/** The panel covers the code's top: a match the search scrolls to stays below it. */
export const findScroll = (range: { from: number; to: number }) =>
	EditorView.scrollIntoView(EditorSelection.range(range.from, range.to), {
		y: 'nearest',
		yMargin: 72,
	});

export type FindSpec = {
	search: string;
	caseSensitive: boolean;
	wholeWord: boolean;
	regexp: boolean;
	replace: string;
};
export function findSpec(state: EditorState): FindSpec {
	const query = getSearchQuery(state);
	return {
		search: query.search,
		caseSensitive: query.caseSensitive,
		wholeWord: query.wholeWord,
		regexp: query.regexp,
		replace: query.replace,
	};
}

/**
 * A new query from the panel. When the words change, the nearest match from the caret becomes the selection (as in
 * VS Code), so the counter has a current one while typing; a toggle keeps the selection where it is when it still matches.
 */
export function setFind(view: EditorView, spec: FindSpec) {
	const query = new SearchQuery(spec),
		before = getSearchQuery(view.state);
	if (query.eq(before)) return;
	const next = view.state.update({ effects: setSearchQuery.of(query) }).state;
	const { ranges } = findMatches(next);
	const main = view.state.selection.main;
	const sameText = spec.replace !== before.replace && spec.search === before.search;
	const standing = ranges.find((range) => range.from === main.from && range.to === main.to);
	const target =
		sameText || standing
			? null
			: (ranges.find((range) => range.from >= main.from) ?? ranges[0] ?? null);
	view.dispatch({
		effects: [setSearchQuery.of(query), ...(target ? [findScroll(target)] : [])],
		...(target
			? { selection: EditorSelection.single(target.from, target.to), userEvent: 'select.search' }
			: {}),
	});
}

/** ⌘F: opens the panel (seeded from the selection by CodeMirror); when it is open, the selection seeds it again. */
export function openFind(view: EditorView) {
	if (!searchPanelOpen(view.state)) return openSearchPanel(view);
	const selection = view.state.selection.main;
	const text =
		selection.empty || selection.to - selection.from > 100
			? ''
			: view.state.sliceDoc(selection.from, selection.to);
	if (text && !text.includes('\n')) {
		const spec = findSpec(view.state);
		view.dispatch({
			effects: setSearchQuery.of(
				new SearchQuery({
					...spec,
					search: spec.regexp ? text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&') : text,
				})
			),
		});
	}
	return true;
}

export type FindHost = {
	mount(dom: HTMLElement): void;
	unmount(dom: HTMLElement): void;
	changed(): void;
};
/** The panel CodeMirror shows: an empty host React portals `ui/FindPanel` into, out of the code's flow (no shift). */
export function findPanel(host: FindHost) {
	return search({
		scrollToMatch: findScroll,
		createPanel: () => {
			const dom = document.createElement('div');
			dom.className = 'cm-find-host';
			return {
				dom,
				top: true,
				mount: () => host.mount(dom),
				destroy: () => host.unmount(dom),
				update: (update) => {
					if (
						update.docChanged ||
						update.selectionSet ||
						!getSearchQuery(update.state).eq(getSearchQuery(update.startState))
					)
						host.changed();
				},
			};
		},
	});
}
