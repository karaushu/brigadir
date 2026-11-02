import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { codeSelection, type CodeMark, type CodeSelection } from './code-selection';
export type DiffSelection = CodeSelection;
const element = (node: Node | null) =>
	node?.nodeType === Node.ELEMENT_NODE ? (node as Element) : (node?.parentElement ?? null);
/** The code text of the diff cell holding `node`: the text itself, or any part of its row (sign, padding, the empty space
 *  right of the text), so a drag reads the same wherever in the row it starts (spec/diff-and-review#diff-selection). */
function codeText(node: Node | null) {
	const at = element(node);
	return (
		at?.closest<HTMLElement>('[data-side]') ??
		at?.closest('[data-kind]')?.querySelector<HTMLElement>('[data-side]') ??
		null
	);
}
/** The text nodes of a line's code, without the «no newline» mark after it. */
function textNodes(cell: HTMLElement) {
	const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT, {
		acceptNode: (node) =>
			node.parentElement?.closest('[data-line-ending]')
				? NodeFilter.FILTER_REJECT
				: NodeFilter.FILTER_ACCEPT,
	});
	const nodes: Text[] = [];
	for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
	return nodes;
}
/** The column of a range boundary inside `cell`: characters of its code before the boundary. */
function column(nodes: Text[], container: Node, offset: number) {
	const point = document.createRange();
	point.setStart(container, offset);
	point.collapse(true);
	let count = 0;
	for (const node of nodes) {
		if (node === container) return count + offset;
		// A text node that ends at or before the boundary counts whole; the first one past it ends the count.
		if (point.comparePoint(node, node.data.length) > 0) return count;
		count += node.data.length;
	}
	return count;
}
/** spec/appearance#evolution-redesign: the native text selection inside `root` as a code selection, or null when none of its code is selected. */
export function readDiffSelection(root: HTMLElement | null): CodeSelection | null {
	const selection = window.getSelection();
	if (!root || !selection || selection.isCollapsed || !selection.rangeCount) return null;
	const range = selection.getRangeAt(0);
	if (!root.contains(range.commonAncestorContainer) && !range.intersectsNode(root)) return null;
	// Side by side keeps a selection in the column it started in (the other one is `user-select: none` during the drag),
	// though the rows hold both columns in document order.
	const lane =
		root.dataset.mode === 'sbs'
			? (codeText(selection.anchorNode)?.dataset.side ?? root.dataset.selectSide)
			: undefined;
	const pieces: (CodeMark & { text: string })[] = [];
	for (const cell of root.querySelectorAll<HTMLElement>('[data-code-line][data-side]')) {
		if (!range.intersectsNode(cell) || (lane && cell.dataset.side !== lane)) continue;
		const side = cell.dataset.side,
			line = Number(cell.dataset.codeLine);
		if ((side !== 'old' && side !== 'new') || !Number.isSafeInteger(line) || line < 1) continue;
		const nodes = textNodes(cell),
			text = nodes.map((node) => node.data).join('');
		const from = cell.contains(range.startContainer)
				? Math.min(text.length, column(nodes, range.startContainer, range.startOffset))
				: 0,
			to = cell.contains(range.endContainer)
				? Math.min(text.length, column(nodes, range.endContainer, range.endOffset))
				: text.length;
		pieces.push({ side, line, from, to: Math.max(from, to), text });
	}
	return codeSelection(pieces);
}
/** The text node and offset of character `at` in a line's code; the cell itself for an empty line. */
function point(cell: HTMLElement, at: number): [Node, number] {
	const nodes = textNodes(cell);
	let count = 0;
	for (const node of nodes) {
		if (at <= count + node.data.length) return [node, at - count];
		count += node.data.length;
	}
	const last = nodes.at(-1);
	return last ? [last, last.data.length] : [cell, 0];
}
const lengthOf = (cell: HTMLElement) =>
	textNodes(cell).reduce((sum, node) => sum + node.data.length, 0);
/** The column `⇧`+↑/↓ keep while they cross shorter lines, and where they left the focus. */
let goal: { node: Node; offset: number; column: number } | null = null;
/**
 * spec/diff-and-review#diff-selection: side by side lays both columns out row by row, so the native `⇧`+arrows walk into the other column
 * (→ at a line's end, ↑/↓ past a row whose own side is empty). Here they move the selection's focus through the lines of
 * the column it started in: ←/→ by a character across line ends, ↑/↓ to the column's previous / next line at the same
 * column. False when the key is not one to handle here.
 */
export function extendInLane(root: HTMLElement, key: string): boolean {
	const selection = window.getSelection();
	if (root.dataset.mode !== 'sbs' || !selection?.rangeCount || !selection.anchorNode) return false;
	if (!root.contains(selection.anchorNode)) return false;
	const anchorCell = codeText(selection.anchorNode),
		lane = anchorCell?.dataset.side;
	if (lane !== 'old' && lane !== 'new') return false;
	const selector = `[data-code-line][data-side='${lane}']`;
	const cells = [...root.querySelectorAll<HTMLElement>(selector)];
	// The focus's line in the lane: its own cell, else the lane's cell in the focus's row, else the anchor's line.
	const focusAt = element(selection.focusNode),
		own = focusAt?.closest<HTMLElement>(selector) ?? null,
		cell =
			own ??
			focusAt?.closest('[data-kind]')?.querySelector<HTMLElement>(selector) ??
			anchorCell!.closest<HTMLElement>(selector);
	let index = cell ? cells.indexOf(cell) : -1;
	if (index < 0) return false;
	let at =
		own && selection.focusNode
			? Math.min(lengthOf(own), column(textNodes(own), selection.focusNode, selection.focusOffset))
			: lengthOf(cells[index]!);
	const vertical = key === 'ArrowUp' || key === 'ArrowDown';
	const kept =
		vertical && goal && goal.node === selection.focusNode && goal.offset === selection.focusOffset
			? goal.column
			: at;
	if (key === 'ArrowRight') {
		if (at < lengthOf(cells[index]!)) at += 1;
		else if (index < cells.length - 1) [index, at] = [index + 1, 0];
	} else if (key === 'ArrowLeft') {
		if (at > 0) at -= 1;
		else if (index > 0) [index, at] = [index - 1, lengthOf(cells[index - 1]!)];
	} else if (key === 'ArrowDown') {
		if (index < cells.length - 1)
			[index, at] = [index + 1, Math.min(kept, lengthOf(cells[index + 1]!))];
		else at = lengthOf(cells[index]!);
	} else if (key === 'ArrowUp') {
		if (index > 0) [index, at] = [index - 1, Math.min(kept, lengthOf(cells[index - 1]!))];
		else at = 0;
	} else return false;
	const [node, offset] = point(cells[index]!, at);
	root.dataset.selectSide = lane;
	selection.setBaseAndExtent(selection.anchorNode, selection.anchorOffset, node, offset);
	goal = vertical ? { node, offset, column: kept } : null;
	cells[index]!.scrollIntoView({ block: 'nearest' });
	return true;
}
/** The same selection read again (a repeated `selectionchange`): keep the previous object, so nothing re-renders. */
export const sameSelection = (a: CodeSelection | null, b: CodeSelection | null) =>
	a === b ||
	(!!a &&
		!!b &&
		a.side === b.side &&
		a.start === b.start &&
		a.end === b.end &&
		a.quote === b.quote &&
		a.marks.length === b.marks.length &&
		a.marks.every((mark, i) => mark.from === b.marks[i]!.from && mark.to === b.marks[i]!.to));
/**
 * The diff's text selection, read when the gesture ends: on release of the pointer, and on every keyboard change
 * (`⇧`+arrows extend the native selection, a click elsewhere collapses it). While the pointer is down nothing is read:
 * the native highlight shows the drag and the panel waits (spec/diff-and-review#selection-panel).
 */
export function useLiveDiffSelection(commit: (range: CodeSelection | null) => void) {
	const root = useRef<HTMLElement>(null),
		pointer = useRef<number | null>(null);
	const publishRef = useRef(commit);
	publishRef.current = commit;
	useEffect(() => {
		const change = () => {
			if (pointer.current === null) publishRef.current(readDiffSelection(root.current));
		};
		const finish = (event: PointerEvent) => {
			if (pointer.current !== event.pointerId) return;
			pointer.current = null;
			publishRef.current(readDiffSelection(root.current));
		};
		const cancel = () => {
			pointer.current = null;
		};
		// spec/diff-and-review#diff-selection: ⇧+arrows in side by side stay in the column the selection started in.
		const key = (event: KeyboardEvent) => {
			if (!event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return;
			if (!event.key.startsWith('Arrow') || !root.current) return;
			if ((event.target as Element | null)?.closest?.('input,textarea,[contenteditable="true"]'))
				return;
			if (extendInLane(root.current, event.key)) event.preventDefault();
		};
		document.addEventListener('selectionchange', change);
		document.addEventListener('keydown', key);
		window.addEventListener('pointerup', finish);
		window.addEventListener('pointercancel', cancel);
		window.addEventListener('blur', cancel);
		return () => {
			document.removeEventListener('selectionchange', change);
			document.removeEventListener('keydown', key);
			window.removeEventListener('pointerup', finish);
			window.removeEventListener('pointercancel', cancel);
			window.removeEventListener('blur', cancel);
		};
	}, []);
	function begin(event: ReactPointerEvent<HTMLElement>) {
		const target = event.target as HTMLElement;
		const cell =
			event.button === 0 && event.isPrimary && !target.closest('button,textarea,input')
				? codeText(target)
				: null;
		if (!cell) return;
		// spec/diff-and-review#diff-selection: in side by side the drag stays on the side it started on, so the native highlight never spans both columns.
		if (root.current) root.current.dataset.selectSide = cell.dataset.side;
		pointer.current = event.pointerId;
	}
	return { root, begin };
}
/**
 * spec/agents-and-providers#editor-state: the diff selection the agent's `editor_state` reads. Going to the chat or the console moves the page's selection
 * out of the diff and clears the diff's own; the agent still gets it, as the editor keeps its selection when it loses focus.
 * A new selection replaces it; a click in the diff (the selection collapses inside it) drops it.
 */
export function heldDiffSelection(
	next: DiffSelection | null,
	held: DiffSelection | null,
	root: Pick<Node, 'contains'> | null,
	anchor: Node | null
): DiffSelection | null {
	if (next) return next;
	return anchor && root && !root.contains(anchor) ? held : null;
}
