import buttons from './ui/Controls.module.css';
import closeStyles from './ui/PopupClose.module.css';
import {
	Decoration,
	EditorView,
	GutterMarker,
	WidgetType,
	gutter,
	keymap,
	type DecorationSet,
} from '@codemirror/view';
import {
	EditorState,
	Prec,
	RangeSet,
	StateEffect,
	StateField,
	type Extension,
	type Text,
	type TransactionSpec,
} from '@codemirror/state';
import { t, type EditorGutter, type GutterHunk, type Locale } from '@brigadir/core';

/**
 * spec/editor#change-marks: change marks between the line numbers and the code, against the base setting (spec/diff-and-review#diff-base) and the live buffer.
 * Hunks arrive from main for one exact document; each keeps a mapped range, so marks follow an edit until the next
 * answer replaces them. A click on a mark or Next/Previous change opens the peek: an inline block under the hunk.
 */
type Ready = Extract<EditorGutter, { state: 'ready' }>;
export type Placed = { from: number; to: number; hunk: GutterHunk };
type Value = {
	ready: Ready | null;
	placed: Placed[];
	marks: RangeSet<GutterMarker>;
	peek: number | null;
};
export type GutterActions = { canEdit(): boolean; openDiff(hunk: GutterHunk): void };

const setGutter = StateEffect.define<{ gutter: EditorGutter; doc: Text }>();
const setPeek = StateEffect.define<number | null>();

class Mark extends GutterMarker {
	constructor(readonly kind: 'add' | 'mod' | 'del' | 'del-top') {
		super();
	}
	override eq(other: Mark) {
		return other.kind === this.kind;
	}
	override toDOM() {
		const mark = document.createElement('div');
		mark.className = `cm-change cm-change-${this.kind}`;
		mark.dataset.change = this.kind;
		return mark;
	}
}
const marks = {
	add: new Mark('add'),
	mod: new Mark('mod'),
	del: new Mark('del'),
	'del-top': new Mark('del-top'),
};
/** Keeps the strip's width with no marks; carries no change state. */
const spacer = new (class extends GutterMarker {
	override toDOM() {
		const element = document.createElement('div');
		element.className = 'cm-change';
		return element;
	}
})();

/** A deletion sits under the line above it; at the top of the file, over line 1. */
function place(doc: Text, hunk: GutterHunk): Placed {
	if (hunk.count > 0) {
		const first = doc.line(Math.min(hunk.start, doc.lines)),
			last = doc.line(Math.min(hunk.start + hunk.count - 1, doc.lines));
		return { from: first.from, to: last.to, hunk };
	}
	const line = doc.line(Math.max(1, Math.min(hunk.start, doc.lines)));
	return { from: line.from, to: line.to, hunk };
}
function markSet(doc: Text, placed: Placed[]): RangeSet<GutterMarker> {
	const ranges = [];
	for (const { from, to, hunk } of placed) {
		if (hunk.count === 0) {
			ranges.push((hunk.start === 0 ? marks['del-top'] : marks.del).range(from));
			continue;
		}
		const mark = hunk.removedCount ? marks.mod : marks.add;
		for (let line = doc.lineAt(from).number, end = doc.lineAt(to).number; line <= end; line++)
			ranges.push(mark.range(doc.line(line).from));
	}
	return RangeSet.of(ranges, true);
}

const field = StateField.define<Value>({
	create: () => ({ ready: null, placed: [], marks: RangeSet.empty, peek: null }),
	update(value, tr) {
		let next = value;
		if (tr.docChanged) {
			const open = next.peek === null ? null : next.placed[next.peek];
			let touched = false;
			if (open)
				tr.changes.iterChangedRanges((from, to) => {
					if (from <= open.to && to >= open.from) touched = true;
				});
			next = {
				...next,
				placed: next.placed.map((item) => ({
					...item,
					from: tr.changes.mapPos(item.from, -1),
					to: tr.changes.mapPos(item.to, 1),
				})),
				marks: next.marks.map(tr.changes),
				peek: touched ? null : next.peek,
			};
		}
		for (const effect of tr.effects) {
			if (effect.is(setGutter)) {
				// A late answer for an older document is dropped; the request for this one is on its way.
				if (effect.value.doc !== tr.state.doc) continue;
				const gutter = effect.value.gutter;
				if (gutter.state !== 'ready') {
					next = { ready: null, placed: [], marks: RangeSet.empty, peek: null };
					continue;
				}
				const placed = gutter.hunks.map((hunk) => place(tr.state.doc, hunk));
				const open = next.peek === null ? null : next.placed[next.peek];
				// A new hunk before this one changes its index, not which change the person opened.
				const index =
					open && next.ready?.base === gutter.base && next.ready.head === gutter.head
						? placed.findIndex(
								(item) =>
									item.from === open.from &&
									item.to === open.to &&
									item.hunk.oldStart === open.hunk.oldStart &&
									item.hunk.removedCount === open.hunk.removedCount &&
									JSON.stringify(item.hunk.removed) === JSON.stringify(open.hunk.removed)
							)
						: -1;
				next = {
					ready: gutter,
					placed,
					marks: markSet(tr.state.doc, placed),
					peek: index >= 0 ? index : null,
				};
			}
			if (effect.is(setPeek))
				next = {
					...next,
					peek: effect.value !== null && effect.value < next.placed.length ? effect.value : null,
				};
		}
		return next;
	},
});

const chevron = (d: string) =>
	`<svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="${d}" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
class Peek extends WidgetType {
	constructor(
		readonly index: number,
		readonly total: number,
		readonly placed: Placed,
		readonly ready: Ready,
		readonly locale: Locale,
		readonly actions: GutterActions,
		readonly revertable: boolean
	) {
		super();
	}
	// Equal by value: a fresh answer for the same hunk keeps the open block instead of replaying its reveal.
	override eq(other: Peek) {
		return (
			other.index === this.index &&
			other.total === this.total &&
			JSON.stringify(other.placed.hunk) === JSON.stringify(this.placed.hunk) &&
			other.ready.base === this.ready.base &&
			other.ready.head === this.ready.head &&
			other.revertable === this.revertable &&
			other.locale === this.locale
		);
	}
	override toDOM(view: EditorView) {
		const { hunk } = this.placed,
			locale = this.locale,
			root = document.createElement('section');
		root.className = 'cm-change-peek';
		root.setAttribute('role', 'region');
		root.setAttribute(
			'aria-label',
			t(locale, 'Change {index} of {count}')
				.replace('{index}', String(this.index + 1))
				.replace('{count}', String(this.total))
		);
		const header = document.createElement('header'),
			base = document.createElement('span');
		base.className = 'cm-change-peek-base';
		base.textContent =
			this.ready.base === 'head'
				? `HEAD · ${this.ready.head?.slice(0, 7) ?? '∅'}`
				: t(locale, 'Task base');
		const count = document.createElement('span');
		count.className = 'cm-change-peek-count';
		count.textContent = t(locale, '{index} of {count}')
			.replace('{index}', String(this.index + 1))
			.replace('{count}', String(this.total));
		const spacer = document.createElement('span');
		spacer.style.flex = '1';
		header.append(base, count, spacer);
		const button = (
			label: string,
			run: () => void,
			options: { icon?: string; className?: string; disabled?: boolean; keys?: string } = {}
		) => {
			const element = document.createElement('button');
			element.type = 'button';
			element.className = options.className ?? buttons.button!;
			if (!options.className) {
				element.dataset.size = 's';
				element.dataset.appearance = 'neutral';
				element.dataset.variant = options.icon ? 'ghost' : 'soft';
			}
			if (options.icon) {
				element.innerHTML = options.icon;
				element.setAttribute('aria-label', label);
				element.title = label;
				element.classList.add('cm-change-peek-icon');
			} else element.textContent = label;
			if (options.keys) element.setAttribute('aria-keyshortcuts', options.keys);
			element.disabled = Boolean(options.disabled);
			element.onclick = (event) => {
				event.preventDefault();
				run();
			};
			element.onmousedown = (event) => event.preventDefault();
			header.append(element);
			return element;
		};
		button(t(locale, 'Previous change'), () => step(view, -1), {
			icon: chevron('M6.4 2 3.4 5l3 3'),
			disabled: this.total < 2,
		});
		button(t(locale, 'Next change'), () => step(view, 1), {
			icon: chevron('M3.6 2l3 3-3 3'),
			disabled: this.total < 2,
		});
		button(
			t(locale, 'Revert'),
			() => {
				revert(view, this.actions, this.index);
			},
			{ disabled: !this.revertable }
		);
		button(t(locale, 'Open diff'), () => {
			closePeek(view);
			this.actions.openDiff(hunk);
		});
		const close = button(t(locale, 'Close'), () => closePeek(view), {
			className: closeStyles.close!,
			keys: 'Escape',
		});
		close.textContent = 'Esc';
		close.title = `${t(locale, 'Close')} (Esc)`;
		root.append(header);
		hunk.removed.forEach((text, offset) => {
			const row = document.createElement('div');
			row.className = 'cm-change-peek-old';
			const number = document.createElement('span');
			number.textContent = String(hunk.oldStart + offset);
			const sign = document.createElement('span');
			sign.textContent = '−';
			const code = document.createElement('span');
			code.textContent = text;
			row.append(number, sign, code);
			root.append(row);
		});
		if (hunk.removedCount > hunk.removed.length) {
			const more = document.createElement('div');
			more.className = 'cm-change-peek-more';
			more.textContent = `… ${hunk.removedCount - hunk.removed.length}`;
			root.append(more);
		}
		return root;
	}
	override ignoreEvent() {
		return true;
	}
}

function closePeek(view: EditorView) {
	view.dispatch({ effects: setPeek.of(null) });
	view.focus();
}
function peekAt(view: EditorView, index: number): TransactionSpec {
	const { placed } = view.state.field(field),
		item = placed[index]!;
	return {
		selection: { anchor: item.from },
		effects: [setPeek.of(index), EditorView.scrollIntoView(item.from, { y: 'center' })],
	};
}
function step(view: EditorView, direction: 1 | -1) {
	const { placed, peek } = view.state.field(field);
	if (!placed.length) return false;
	const head = view.state.selection.main.head,
		line = view.state.doc.lineAt(head);
	const index =
		peek !== null
			? (peek + direction + placed.length) % placed.length
			: direction > 0
				? Math.max(
						0,
						placed.findIndex((item) => item.from > line.to)
					)
				: (() => {
						for (let i = placed.length - 1; i >= 0; i--) if (placed[i]!.to < line.from) return i;
						return placed.length - 1;
					})();
	const target = index < 0 ? 0 : index;
	view.dispatch(peekAt(view, target));
	view.focus();
	return true;
}
/** Hunk under the cursor: the peek's one, or the one whose lines hold it. */
function current(view: EditorView): number {
	const { placed, peek } = view.state.field(field);
	if (peek !== null) return peek;
	const line = view.state.doc.lineAt(view.state.selection.main.head);
	return placed.findIndex((item) => item.from <= line.to && item.to >= line.from);
}
/** One undoable buffer edit back to the base text of the hunk; nothing reaches the disk (spec/editor#change-marks). */
function revert(view: EditorView, actions: GutterActions, index = current(view)): boolean {
	const { placed } = view.state.field(field),
		item = placed[index];
	if (!item || !actions.canEdit() || view.state.readOnly) return false;
	const { hunk } = item,
		doc = view.state.doc;
	if (hunk.removedCount > hunk.removed.length) return false;
	const old = hunk.removed.join(view.state.lineBreak);
	let change: { from: number; to: number; insert: string };
	// An emptied buffer has no line after the deletion, so no break follows the restored lines.
	if (hunk.count === 0)
		change =
			hunk.start === 0
				? { from: 0, to: 0, insert: doc.length ? old + view.state.lineBreak : old }
				: { from: item.to, to: item.to, insert: view.state.lineBreak + old };
	else if (hunk.removedCount) change = { from: item.from, to: item.to, insert: old };
	// Added lines leave together with one line break, the one after them unless they end the file.
	else
		change =
			item.to < doc.length
				? { from: item.from, to: item.to + 1, insert: '' }
				: { from: Math.max(0, item.from - 1), to: item.to, insert: '' };
	view.dispatch({
		changes: change,
		selection: { anchor: change.from },
		effects: setPeek.of(null),
		userEvent: 'input.revert',
		scrollIntoView: true,
	});
	view.focus();
	return true;
}

/** spec/editor#editor-context-menu: the hunk under the caret for the editor menu, and whether Revert can restore it whole. */
function at(view: EditorView): { hunk: GutterHunk; revertable: boolean } | null {
	const item = view.state.field(field).placed[current(view)];
	return item
		? { hunk: item.hunk, revertable: item.hunk.removedCount === item.hunk.removed.length }
		: null;
}
/** spec/editor#editor-chrome: the hunks as they stand in this buffer, for the change map; empty without a ready gutter. */
export function changePlaces(state: EditorState): readonly Placed[] {
	return state.field(field, false)?.placed ?? [];
}
/** The change map's jump: the caret on the change's first line, that line in the middle; no peek (the gutter opens it). */
export function goToChange(view: EditorView, index: number) {
	const item = view.state.field(field, false)?.placed[index];
	if (!item) return;
	view.dispatch({
		selection: { anchor: item.from },
		effects: EditorView.scrollIntoView(item.from, { y: 'center' }),
		userEvent: 'select.change',
	});
	view.focus();
}
export const changeCommands = {
	next: (view: EditorView) => step(view, 1),
	previous: (view: EditorView) => step(view, -1),
	revert,
	at,
};
/** Applies main's answer when it is still about the document it was asked for. */
export function applyGutter(view: EditorView, gutter: EditorGutter, doc: Text) {
	view.dispatch({ effects: setGutter.of({ gutter, doc }) });
}

export function changeGutter(locale: Locale, actions: GutterActions): Extension {
	const peekDecorations = EditorView.decorations.compute([field, EditorState.readOnly], (state) => {
		const { placed, peek, ready } = state.field(field);
		if (peek === null || !ready) return Decoration.none as DecorationSet;
		const item = placed[peek]!,
			top = item.hunk.count === 0 && item.hunk.start === 0,
			revertable =
				!state.readOnly && actions.canEdit() && item.hunk.removedCount === item.hunk.removed.length;
		return Decoration.set([
			Decoration.widget({
				widget: new Peek(peek, placed.length, item, ready, locale, actions, revertable),
				block: true,
				side: top ? -1 : 1,
			}).range(top ? item.from : item.to),
		]);
	});
	return [
		field,
		peekDecorations,
		gutter({
			class: 'cm-changeGutter',
			markers: (view) => view.state.field(field).marks,
			initialSpacer: () => spacer,
			domEventHandlers: {
				mousedown(view, line) {
					const { placed } = view.state.field(field),
						row = view.state.doc.lineAt(line.from),
						index = placed.findIndex((item) => item.from <= row.to && item.to >= row.from);
					if (index < 0) return false;
					view.dispatch(peekAt(view, index));
					return true;
				},
			},
		}),
		Prec.high(
			keymap.of([
				{
					key: 'Escape',
					run: (view) => {
						if (view.state.field(field).peek === null) return false;
						closePeek(view);
						return true;
					},
				},
			])
		),
	];
}
