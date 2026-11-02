import { EditorSelection, Prec, RangeSetBuilder } from '@codemirror/state';
import {
	Decoration,
	EditorView,
	keymap,
	ViewPlugin,
	WidgetType,
	type DecorationSet,
	type ViewUpdate,
} from '@codemirror/view';
import { indentLess, indentMore } from '@codemirror/commands';
import { createMarkdown } from './markdown';
/**
 * spec/notifications-slack-notes-and-schedules#note-markdown: writing Markdown in a note. A list item, a checkbox `[ ]` and a radio `( )` are lines of the text — the editor
 * draws the marks as controls, continues the list on Enter and the preview shows them checked or not.
 */
// `- `, `* `, `+ `, `1. `, `1) `, then an optional `[ ]` / `[x]` or `( )` / `(x)`. A bare `[ ] text` line is a checkbox too.
const ITEM = /^(\s*)(?:([-*+])|(\d{1,9})([.)]))(\s+)(?:(\[[ xX]?\]|\([ xX]?\))(\s+|$))?/;
const BARE = /^(\s*)(\[[ xX]?\]|\([ xX]?\))(\s+|$)/;
export type ListLine = {
	indent: string;
	/** `-`, `*`, `+`, a number with `.` or `)`, or null for a bare mark line. */ bullet:
		string | null;
	number: number | null;
	mark: 'check' | 'radio' | null;
	checked: boolean;
	/** Where the mark (`[` or `(`) starts in the line, or -1; `[]` and `()` are 2 long, `[ ]` and `[x]` 3. */ markAt: number;
	markLength: number;
	/** Where the item's own text starts. */ textAt: number;
};
export function listLine(text: string): ListLine | null {
	const item = ITEM.exec(text);
	if (item) {
		const [, indent = '', bullet, number, delimiter, space = '', mark] = item;
		const head = indent.length + (bullet ?? `${number}${delimiter}`).length + space.length;
		return {
			indent,
			bullet: bullet ?? `${number}${delimiter}`,
			number: number ? Number(number) : null,
			mark: mark ? (mark.startsWith('[') ? 'check' : 'radio') : null,
			checked: !!mark && /x/i.test(mark),
			markAt: mark ? head : -1,
			markLength: mark?.length ?? 0,
			textAt: item[0].length,
		};
	}
	const bare = BARE.exec(text);
	if (!bare) return null;
	const [, indent = '', mark = ''] = bare;
	return {
		indent,
		bullet: null,
		number: null,
		mark: mark.startsWith('[') ? 'check' : 'radio',
		checked: /x/i.test(mark),
		markAt: indent.length,
		markLength: mark.length,
		textAt: bare[0].length,
	};
}
/**
 * Enter on a list line: the next item with the same bullet (the next number, an unchecked mark); on an item with no text the
 * list ends — the marks go and the line is empty. null — not a list line, Enter as usual.
 */
export function continueList(
	text: string,
	column: number
): { replace: string } | { insert: string } | null {
	const line = listLine(text);
	if (!line || column < line.textAt) return null;
	if (!text.slice(line.textAt).trim()) return { replace: '' };
	const bullet =
		line.number !== null ? `${line.number + 1}${line.bullet!.slice(-1)}` : (line.bullet ?? '');
	const mark = line.mark === 'check' ? '[ ] ' : line.mark === 'radio' ? '( ) ' : '';
	return { insert: `\n${line.indent}${bullet ? `${bullet} ` : ''}${mark}` };
}
const withMark = (text: string, line: ListLine, checked: boolean) =>
	`${text.slice(0, line.markAt)}${line.mark === 'check' ? (checked ? '[x]' : '[ ]') : checked ? '(x)' : '( )'}${text.slice(line.markAt + line.markLength)}`;
/**
 * The lines with line `index`'s checkbox toggled, or its radio chosen and the other radios of its group cleared; null —
 * the line has no mark. A short `[]` or `()` becomes `[ ]` or `( )` on the way.
 */
export function toggleInText(lines: readonly string[], index: number): string[] | null {
	const own = listLine(lines[index] ?? '');
	if (!own?.mark) return null;
	const next = [...lines];
	if (own.mark === 'check') next[index] = withMark(lines[index]!, own, !own.checked);
	else
		for (const i of radioGroup(lines, index))
			next[i] = withMark(lines[i]!, listLine(lines[i]!)!, i === index);
	return next;
}
/** A radio is one of its group: the lines next to it with a radio at the same indent. Choosing it clears the others. */
export function radioGroup(lines: readonly string[], index: number): number[] {
	const own = listLine(lines[index] ?? '');
	if (own?.mark !== 'radio') return [];
	const same = (i: number) => {
		const line = listLine(lines[i] ?? '');
		return line?.mark === 'radio' && line.indent === own.indent;
	};
	let from = index,
		to = index;
	while (from > 0 && same(from - 1)) from--;
	while (to < lines.length - 1 && same(to + 1)) to++;
	return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}
// ── the editor ───────────────────────────────────────────────────────────────────────────────────────────────
class MarkWidget extends WidgetType {
	constructor(
		readonly kind: 'check' | 'radio',
		readonly checked: boolean,
		readonly line: number
	) {
		super();
	}
	override eq(other: MarkWidget) {
		return other.kind === this.kind && other.checked === this.checked && other.line === this.line;
	}
	override toDOM() {
		const box = document.createElement('span');
		box.className = `cm-note-mark cm-note-${this.kind}`;
		box.dataset.checked = String(this.checked);
		box.dataset.noteMark = String(this.line);
		box.setAttribute('role', this.kind === 'check' ? 'checkbox' : 'radio');
		box.setAttribute('aria-checked', String(this.checked));
		return box;
	}
	override ignoreEvent() {
		return false;
	}
}
const marks = {
	heading: Decoration.mark({ class: 'cm-note-heading' }),
	bullet: Decoration.mark({ class: 'cm-note-bullet' }),
	code: Decoration.mark({ class: 'cm-note-code' }),
	strong: Decoration.mark({ class: 'cm-note-strong' }),
	em: Decoration.mark({ class: 'cm-note-em' }),
	link: Decoration.mark({ class: 'cm-note-link' }),
	quote: Decoration.mark({ class: 'cm-note-quote' }),
	done: Decoration.mark({ class: 'cm-note-done' }),
	fence: Decoration.line({ class: 'cm-note-fence' }),
};
const INLINE =
	/(`[^`\n]+`)|(\*\*[^*\n]+\*\*|__[^_\n]+__)|((?<![*\w])\*[^*\s][^*\n]*\*(?!\*)|(?<![_\w])_[^_\s][^_\n]*_(?!\w))|(\[[^\]\n]+\]\([^)\s]+\))/g;
/** Marks of the visible lines: headings, bullets, code, bold, italic, links, quotes, fenced code, and the controls. */
function decorate(view: EditorView) {
	const ranges: { from: number; to: number; value: Decoration }[] = [];
	const doc = view.state.doc;
	let fenced = false;
	// A fence opened above the viewport keeps the lines under it code.
	const first = doc.lineAt(view.viewport.from).number;
	for (let n = 1; n < first; n++) if (/^\s*```/.test(doc.line(n).text)) fenced = !fenced;
	for (const { from, to } of view.visibleRanges)
		for (let pos = from; pos <= to;) {
			const line = doc.lineAt(pos),
				text = line.text;
			pos = line.to + 1;
			if (/^\s*```/.test(text)) {
				fenced = !fenced;
				ranges.push({ from: line.from, to: line.from, value: marks.fence });
				continue;
			}
			if (fenced) {
				ranges.push({ from: line.from, to: line.from, value: marks.fence });
				continue;
			}
			if (/^#{1,6}\s/.test(text)) {
				ranges.push({ from: line.from, to: line.to, value: marks.heading });
				continue;
			}
			if (/^\s*>/.test(text)) ranges.push({ from: line.from, to: line.to, value: marks.quote });
			const item = listLine(text);
			if (item) {
				if (item.bullet) {
					const at = line.from + item.indent.length;
					ranges.push({ from: at, to: at + item.bullet.length, value: marks.bullet });
				}
				if (item.mark) {
					const at = line.from + item.markAt;
					ranges.push({
						from: at,
						to: at + item.markLength,
						value: Decoration.replace({
							widget: new MarkWidget(item.mark, item.checked, line.number),
						}),
					});
					if (item.mark === 'check' && item.checked && line.from + item.textAt < line.to)
						ranges.push({ from: line.from + item.textAt, to: line.to, value: marks.done });
				}
			}
			for (const match of text.matchAll(INLINE)) {
				const start = line.from + match.index!,
					end = start + match[0].length;
				if (item?.mark && start < line.from + item.markAt + item.markLength) continue;
				ranges.push({
					from: start,
					to: end,
					value: match[1] ? marks.code : match[2] ? marks.strong : match[3] ? marks.em : marks.link,
				});
			}
		}
	ranges.sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide);
	const builder = new RangeSetBuilder<Decoration>();
	for (const range of ranges) builder.add(range.from, range.to, range.value);
	return builder.finish();
}
/** Toggles the checkbox of line `number` (1-based), or chooses its radio and clears the others of its group. */
export function toggleLine(view: EditorView, number: number) {
	const doc = view.state.doc;
	if (number < 1 || number > doc.lines) return false;
	const lines = doc.toString().split('\n'),
		next = toggleInText(lines, number - 1);
	if (!next) return false;
	const changes = next.flatMap((text, i) => {
		if (text === lines[i]) return [];
		const line = doc.line(i + 1);
		return [{ from: line.from, to: line.to, insert: text }];
	});
	view.dispatch({ changes, userEvent: 'input.toggle' });
	return true;
}
const markPlugin = ViewPlugin.fromClass(
	class {
		decorations: DecorationSet;
		constructor(view: EditorView) {
			this.decorations = decorate(view);
		}
		update(update: ViewUpdate) {
			if (update.docChanged || update.viewportChanged) this.decorations = decorate(update.view);
		}
	},
	{
		decorations: (value) => value.decorations,
		eventHandlers: {
			mousedown(event, view) {
				const target = (event.target as HTMLElement).closest<HTMLElement>('[data-note-mark]');
				if (!target) return false;
				event.preventDefault();
				return toggleLine(view, Number(target.dataset.noteMark));
			},
		},
	}
);
function enter(view: EditorView) {
	const { state } = view,
		range = state.selection.main;
	if (!range.empty || state.selection.ranges.length > 1) return false;
	const line = state.doc.lineAt(range.head);
	const next = continueList(line.text, range.head - line.from);
	if (!next) return false;
	if ('replace' in next)
		view.dispatch({
			changes: { from: line.from, to: line.to, insert: next.replace },
			selection: EditorSelection.cursor(line.from),
			userEvent: 'input',
		});
	else
		view.dispatch(state.replaceSelection(next.insert), {
			scrollIntoView: true,
			userEvent: 'input',
		});
	return true;
}
/** Tab and ⇧Tab on a list line nest the item or take it out; elsewhere they stay the editor's own keys. */
const onList = (command: (view: EditorView) => boolean) => (view: EditorView) =>
	listLine(view.state.doc.lineAt(view.state.selection.main.head).text) ? command(view) : false;
export function noteMarkdown() {
	return [
		markPlugin,
		Prec.high(
			keymap.of([
				{ key: 'Enter', run: enter },
				{ key: 'Tab', run: onList(indentMore) },
				{ key: 'Shift-Tab', run: onList(indentLess) },
				{
					key: 'Mod-Enter',
					run: (view) =>
						toggleLine(view, view.state.doc.lineAt(view.state.selection.main.head).number),
				},
			])
		),
	];
}
// ── the preview ──────────────────────────────────────────────────────────────────────────────────────────────
/** The note's preview: a line break is a break, as typed; a mark at an item's start is a checkbox or a radio. */
const previewMarkdown = createMarkdown(true);
previewMarkdown.core.ruler.push('note_marks', (state) => {
	for (const token of state.tokens) {
		if (token.type !== 'inline' || !token.children?.length || !token.map) continue;
		// Each line of a paragraph may start with its own mark (a line break is a break here).
		const children = [];
		let line = token.map[0] + 1,
			start = true;
		for (const child of token.children) {
			if (start && child.type === 'text') {
				const match = /^(\[[ xX]?\]|\([ xX]?\))\s+/.exec(child.content);
				if (match) {
					const radio = match[1]!.startsWith('('),
						checked = /x/i.test(match[1]!);
					const mark = new state.Token('html_inline', '', 0);
					mark.content = `<input type="${radio ? 'radio' : 'checkbox'}" data-note-line="${line}"${checked ? ' checked' : ''} tabindex="-1">`;
					children.push(mark);
					child.content = child.content.slice(match[0].length);
				}
			}
			start = child.type === 'softbreak' || child.type === 'hardbreak';
			if (start) line++;
			children.push(child);
		}
		token.children = children;
	}
});
export function renderNote(text: string) {
	return previewMarkdown.render(text);
}

/**
 * spec/notifications-slack-notes-and-schedules#notes: `L5` and `L5-7` in an answer become buttons that show those lines of the note. Code spans and blocks keep
 * their text; the HTML is the renderer's own (no raw HTML from the agent, `html: false`).
 */
export function noteLineLinks(html: string) {
	let code = 0;
	return html
		.split(/(<[^>]+>)/)
		.map((part) => {
			if (part.startsWith('<')) {
				if (/^<(code|pre)\b/.test(part)) code++;
				else if (/^<\/(code|pre)>/.test(part)) code = Math.max(0, code - 1);
				return part;
			}
			if (code) return part;
			return part.replace(
				/\bL(\d{1,6})(?:\s?[-–]\s?L?(\d{1,6}))?\b/g,
				(whole, from: string, to?: string) => {
					const end = to && Number(to) >= Number(from) ? to : from;
					return `<button type="button" data-note-lines="${from}-${end}">${whole}</button>`;
				}
			);
		})
		.join('');
}
