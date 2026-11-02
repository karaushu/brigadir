import type { CodeMark } from './code-selection';
/**
 * spec/appearance#evolution-redesign: while a draft or a quick question holds the focus, the selected characters of a diff stay painted in the
 * selection colour. The native selection left with the focus, so a CSS custom highlight (`::highlight(code-selection)`)
 * paints the same ranges; it never touches the DOM, so rows neither move nor re-render.
 */
const owners = new Map<object, Range[]>();
const NAME = 'code-selection';
function publish() {
	const registry = typeof CSS !== 'undefined' ? CSS.highlights : undefined;
	if (!registry) return;
	const ranges = [...owners.values()].flat();
	if (ranges.length) registry.set(NAME, new Highlight(...ranges));
	else registry.delete(NAME);
}
/** The ranges of `marks` among the lines `root` renders now; virtualized rows out of view have none. */
export function markRanges(root: HTMLElement, marks: readonly CodeMark[]): Range[] {
	const ranges: Range[] = [];
	for (const mark of marks) {
		const cell = root.querySelector<HTMLElement>(
			`[data-side="${mark.side}"][data-code-line="${mark.line}"]`
		);
		if (!cell || mark.to <= mark.from) continue;
		const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT, {
			acceptNode: (node) =>
				node.parentElement?.closest('[data-line-ending]')
					? NodeFilter.FILTER_REJECT
					: NodeFilter.FILTER_ACCEPT,
		});
		const range = document.createRange();
		let offset = 0,
			started = false;
		for (
			let node = walker.nextNode() as Text | null;
			node;
			node = walker.nextNode() as Text | null
		) {
			const length = node.data.length;
			if (!started && mark.from <= offset + length) {
				range.setStart(node, mark.from - offset);
				started = true;
			}
			if (started && mark.to <= offset + length) {
				range.setEnd(node, mark.to - offset);
				ranges.push(range);
				break;
			}
			offset += length;
		}
	}
	return ranges;
}
/** Paint `marks` inside `root` for `owner`, and again whenever its rows change; returns the stop. */
export function paintMarks(owner: object, root: HTMLElement, marks: readonly CodeMark[]) {
	const paint = () => {
		owners.set(owner, markRanges(root, marks));
		publish();
	};
	paint();
	const observer = new MutationObserver(paint);
	observer.observe(root, { childList: true, subtree: true, characterData: true });
	return () => {
		observer.disconnect();
		owners.delete(owner);
		publish();
	};
}
