import {
	Decoration,
	EditorView,
	ViewPlugin,
	WidgetType,
	type DecorationSet,
	type ViewUpdate,
} from '@codemirror/view';
import { StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state';
import {
	ageAgo,
	blameUncommitted,
	blameUnsaved,
	type BlameCommit,
	type EditorBlame,
	type Locale,
} from '@brigadir/core';

/**
 * spec/editor#line-author: the line author after the end of the caret line (Zed's inline blame). Main answers for one exact buffer; an edit
 * makes the answer stale and hides the tail until the next one. The tail shows once the caret has rested for `delay`.
 */
export type LineAuthor = { kind: 'commit'; commit: BlameCommit; origin: number; line: number };
export type LineAuthorHost = {
	enabled(): boolean;
	locale: Locale;
	hover(target: { element: HTMLElement; author: LineAuthor } | null): void;
};
type Value = { blame: EditorBlame | null; stale: boolean; shown: number | null };
export const lineAuthorDelay = 200,
	lineAuthorCardDelay = 300;
export const setBlame = StateEffect.define<EditorBlame | null>();
const showLine = StateEffect.define<number | null>();
const refresh = StateEffect.define<null>();

const field = StateField.define<Value>({
	create: () => ({ blame: null, stale: false, shown: null }),
	update(value, tr) {
		let next = value;
		if (tr.docChanged) next = { ...next, stale: true };
		for (const effect of tr.effects) {
			if (effect.is(setBlame)) next = { ...next, blame: effect.value, stale: false };
			else if (effect.is(showLine)) next = { ...next, shown: effect.value };
		}
		return next;
	},
});

/** What the file's blame says about one buffer line; `null` for no author (no data, no line on disk, not in Git, no commit yet). */
export function authorAt(state: EditorState, line: number): LineAuthor | null {
	const value = state.field(field, false);
	if (!value?.blame || value.stale) return null;
	const blame = value.blame;
	// spec/editor#line-author: a line without a commit (changed after HEAD, unsaved, in an untracked file) has no author: no tail, no card.
	if (blame.state !== 'ready') return null;
	const index = blame.lines[line - 1];
	if (index === undefined || index === blameUncommitted || index === blameUnsaved) return null;
	const commit = blame.commits[index];
	return commit ? { kind: 'commit', commit, origin: blame.origins[line - 1] ?? 0, line } : null;
}
export function blameOf(state: EditorState): EditorBlame | null {
	return state.field(field, false)?.blame ?? null;
}

export function tailText(locale: Locale, author: LineAuthor, now = Date.now()): string {
	return `${author.commit.author}, ${ageAgo(locale, author.commit.time, now)}`;
}
// The same commit mark as `base-head` (spec/diff-and-review#changes-header).
const commitMark =
	'<svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="2.6"/><path d="M1.6 8h3.8M10.6 8h3.8"/></svg>';

class Tail extends WidgetType {
	constructor(
		readonly text: string,
		readonly author: LineAuthor,
		readonly host: LineAuthorHost
	) {
		super();
	}
	override eq(other: Tail) {
		return (
			other.text === this.text &&
			other.author.line === this.author.line &&
			other.author.kind === this.author.kind
		);
	}
	override toDOM() {
		const tail = document.createElement('span');
		tail.className = 'cm-line-author';
		tail.dataset.inlineBlame = this.author.kind;
		tail.innerHTML = commitMark;
		const text = document.createElement('span');
		text.textContent = this.text;
		tail.append(text);
		// Hover intent: the card opens once the pointer moves onto the tail and rests there, so a tail that appears under a
		// still pointer (a click at the end of a line) does not throw a card over the lines below.
		let intent: ReturnType<typeof setTimeout> | undefined;
		tail.addEventListener('mousemove', () => {
			clearTimeout(intent);
			intent = setTimeout(() => {
				if (tail.isConnected) this.host.hover({ element: tail, author: this.author });
			}, lineAuthorCardDelay);
		});
		tail.addEventListener('mouseleave', () => {
			clearTimeout(intent);
			this.host.hover(null);
		});
		return tail;
	}
	// The tail is not text: a click does not move the caret, the pointer only opens the card.
	override ignoreEvent() {
		return true;
	}
}

function decorations(state: EditorState, host: LineAuthorHost): DecorationSet {
	const value = state.field(field),
		selection = state.selection.main;
	if (!host.enabled() || value.stale || !selection.empty) return Decoration.none;
	const line = state.doc.lineAt(selection.head);
	if (value.shown !== line.number) return Decoration.none;
	const author = authorAt(state, line.number);
	if (!author) return Decoration.none;
	return Decoration.set([
		Decoration.widget({
			widget: new Tail(tailText(host.locale, author), author, host),
			side: 1,
		}).range(line.to),
	]);
}

export function lineAuthor(host: LineAuthorHost): Extension {
	const plugin = ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;
			timer: ReturnType<typeof setTimeout> | undefined;
			constructor(readonly view: EditorView) {
				this.decorations = decorations(view.state, host);
				this.schedule();
			}
			update(update: ViewUpdate) {
				if (update.selectionSet || update.docChanged) {
					const line = update.state.doc.lineAt(update.state.selection.main.head).number;
					if (update.state.field(field).shown !== line || update.docChanged) this.schedule();
				}
				if (
					update.docChanged ||
					update.selectionSet ||
					update.transactions.some((tr) =>
						tr.effects.some(
							(effect) => effect.is(setBlame) || effect.is(showLine) || effect.is(refresh)
						)
					)
				)
					this.decorations = decorations(update.state, host);
			}
			/** The tail waits until the caret rests on a line, so arrowing through a file does not flicker. */
			schedule() {
				clearTimeout(this.timer);
				this.timer = setTimeout(() => {
					const view = this.view,
						line = view.state.doc.lineAt(view.state.selection.main.head).number;
					view.dispatch({ effects: showLine.of(line) });
				}, lineAuthorDelay);
			}
			destroy() {
				clearTimeout(this.timer);
			}
		},
		{ decorations: (value) => value.decorations }
	);
	return [field, plugin];
}
/** The Settings switch or the menu item changed: draw again with the same data. */
export function refreshLineAuthor(view: EditorView) {
	view.dispatch({ effects: refresh.of(null) });
}
