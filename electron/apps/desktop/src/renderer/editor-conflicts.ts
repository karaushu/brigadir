import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import {
	StateField,
	type EditorState,
	type Extension,
	type Range,
	type Transaction,
} from '@codemirror/state';
import { t, type Locale } from '@brigadir/core';
import buttons from './ui/Controls.module.css';

/**
 * spec/git#merge: a conflict place in the same editor — «Ours / Theirs» blocks with buttons.
 * A button only edits the buffer text; the person saves (⌘S), and the changes panel marks it resolved.
 */
export type ConflictBlock = {
	from: number;
	to: number;
	ours: string;
	theirs: string;
	oursLabel: string;
	theirsLabel: string;
	oursLines: [number, number];
	theirsLines: [number, number];
	markers: number[];
};
const OURS = /^<{7}(?: (.*))?$/,
	BASE = /^\|{7}(?: .*)?$/,
	SPLIT = /^={7}$/,
	THEIRS = /^>{7}(?: (.*))?$/;
const branch = (label: string | undefined) =>
	(label ?? '').replace(/^refs\/(?:heads|remotes)\//, '');

export function conflictBlocks(state: EditorState): ConflictBlock[] {
	const blocks: ConflictBlock[] = [];
	const doc = state.doc;
	for (let n = 1; n <= doc.lines; n++) {
		const start = doc.line(n),
			open = OURS.exec(start.text);
		if (!open) continue;
		let split = 0,
			base = 0,
			end = 0;
		for (let m = n + 1; m <= doc.lines; m++) {
			const text = doc.line(m).text;
			if (!split && !base && BASE.test(text)) base = m;
			else if (!split && SPLIT.test(text)) split = m;
			else if (split && THEIRS.test(text)) {
				end = m;
				break;
			} else if (OURS.test(text)) break;
		}
		if (!split || !end) continue;
		const slice = (a: number, b: number) =>
			a > b ? '' : doc.sliceString(doc.line(a).from, doc.line(b).to);
		const oursEnd = (base || split) - 1,
			close = doc.line(end);
		blocks.push({
			from: start.from,
			to: close.to,
			ours: slice(n + 1, oursEnd),
			theirs: slice(split + 1, end - 1),
			oursLabel: branch(open[1]),
			theirsLabel: branch(THEIRS.exec(close.text)?.[1]),
			oursLines: [n + 1, oursEnd],
			theirsLines: [split + 1, end - 1],
			markers: [n, ...(base ? [base] : []), split, end],
		});
		n = end;
	}
	return blocks;
}

/** The text that replaces the place: one side or both in turn, without markers. */
export function resolvedText(block: ConflictBlock, take: 'ours' | 'theirs' | 'both'): string {
	const parts =
		take === 'ours'
			? [block.ours]
			: take === 'theirs'
				? [block.theirs]
				: [block.ours, block.theirs];
	return parts.filter((part) => part.length > 0).join('\n');
}

class Bar extends WidgetType {
	constructor(
		readonly block: ConflictBlock,
		readonly index: number,
		readonly total: number,
		readonly locale: Locale
	) {
		super();
	}
	override eq(other: Bar) {
		return (
			other.block.from === this.block.from &&
			other.block.to === this.block.to &&
			other.index === this.index &&
			other.total === this.total &&
			other.locale === this.locale
		);
	}
	override toDOM(view: EditorView) {
		const bar = document.createElement('div');
		bar.className = 'cm-conflict-bar';
		bar.setAttribute('role', 'group');
		bar.setAttribute(
			'aria-label',
			`${t(this.locale, 'Conflict place')} ${this.index + 1} / ${this.total}`
		);
		const label = document.createElement('span');
		label.textContent = `${this.index + 1} / ${this.total}`;
		bar.append(label);
		const take = (kind: 'ours' | 'theirs' | 'both', text: string) => {
			const button = document.createElement('button');
			button.type = 'button';
			button.className = buttons.button!;
			button.dataset.size = 's';
			button.dataset.appearance = 'neutral';
			button.dataset.variant = 'soft';
			button.textContent = text;
			button.onclick = () => {
				const current = conflictBlocks(view.state).find((item) => item.from === this.block.from);
				if (!current) return;
				view.dispatch({
					changes: { from: current.from, to: current.to, insert: resolvedText(current, kind) },
				});
				view.focus();
			};
			return button;
		};
		bar.append(
			take(
				'ours',
				`${t(this.locale, 'Ours')}${this.block.oursLabel ? ` · ${this.block.oursLabel}` : ''}`
			),
			take(
				'theirs',
				`${t(this.locale, 'Theirs')}${this.block.theirsLabel ? ` · ${this.block.theirsLabel}` : ''}`
			),
			take('both', t(this.locale, 'Both'))
		);
		return bar;
	}
	override ignoreEvent() {
		return true;
	}
}

function decorate(state: EditorState, locale: Locale): DecorationSet {
	const blocks = conflictBlocks(state),
		ranges: Range<Decoration>[] = [];
	blocks.forEach((block, index) => {
		ranges.push(
			Decoration.widget({
				widget: new Bar(block, index, blocks.length, locale),
				block: true,
				side: -1,
			}).range(block.from)
		);
		for (const n of block.markers)
			ranges.push(Decoration.line({ class: 'cm-conflict-marker' }).range(state.doc.line(n).from));
		for (let n = block.oursLines[0]; n <= block.oursLines[1]; n++)
			ranges.push(Decoration.line({ class: 'cm-conflict-ours' }).range(state.doc.line(n).from));
		for (let n = block.theirsLines[0]; n <= block.theirsLines[1]; n++)
			ranges.push(Decoration.line({ class: 'cm-conflict-theirs' }).range(state.doc.line(n).from));
	});
	return Decoration.set(ranges, true);
}

/** A marker line can appear only on a line the change touched: typing, a paste or a deletion that joins two halves. */
function touchesMarker(transaction: Transaction): boolean {
	const doc = transaction.state.doc;
	let found = false;
	transaction.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
		if (found) return;
		for (let n = doc.lineAt(fromB).number, end = doc.lineAt(toB).number; n <= end; n++) {
			const text = doc.line(n).text;
			if (OURS.test(text) || BASE.test(text) || SPLIT.test(text) || THEIRS.test(text)) {
				found = true;
				return;
			}
		}
	});
	return found;
}

/** A document without conflict places is scanned again only when a change touches a marker line:
 *  47k lines cost 8.5 ms per keystroke. With places present every change rescans, so new lines inside get their class. */
export function conflictMarkers(locale: Locale): Extension {
	const field = StateField.define<DecorationSet>({
		create: (state) => decorate(state, locale),
		update: (value, transaction) =>
			!transaction.docChanged || (value.size === 0 && !touchesMarker(transaction))
				? value
				: decorate(transaction.state, locale),
		provide: (self) => EditorView.decorations.from(self),
	});
	return [
		field,
		EditorView.baseTheme({
			'.cm-conflict-bar': {
				display: 'flex',
				alignItems: 'center',
				gap: '6px',
				padding: '4px 8px',
				background: 'var(--amber-soft)',
				color: 'var(--amber)',
				fontFamily: 'var(--ui-family)',
				fontSize: 'var(--text-11)',
			},
			'.cm-conflict-bar > span': { flex: '1' },
			'.cm-conflict-ours': { background: 'var(--accent-soft)' },
			'.cm-conflict-theirs': { background: 'var(--amber-soft)' },
			'.cm-conflict-marker': { color: 'var(--fg3)' },
		}),
	];
}
