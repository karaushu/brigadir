import type { Locator } from '@playwright/test';
/**
 * spec/appearance#evolution-redesign: select diff code as text, the way a drag would — from column `from` of line `start` to column `to` of
 * line `end` (the whole last line by default) on one side. The diff reads the native selection on `selectionchange`.
 */
export async function selectCode(
	diff: Locator,
	side: 'old' | 'new',
	start: number,
	end = start,
	{ from = 0, to }: { from?: number; to?: number } = {}
) {
	await diff.evaluate(
		(root, { side, start, end, from, to }) => {
			const cell = (line: number) => {
				const found = root.querySelector(`[data-side="${side}"][data-code-line="${line}"]`);
				if (!found) throw new Error(`No ${side}:${line} in the diff`);
				return found;
			};
			const point = (node: Element, offset: number): [Node, number] => {
				const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, {
					acceptNode: (text) =>
						text.parentElement?.closest('[data-line-ending]')
							? NodeFilter.FILTER_REJECT
							: NodeFilter.FILTER_ACCEPT,
				});
				let last: Text | null = null;
				for (
					let text = walker.nextNode() as Text | null;
					text;
					text = walker.nextNode() as Text | null
				) {
					if (offset <= text.data.length) return [text, offset];
					offset -= text.data.length;
					last = text;
				}
				return last ? [last, last.data.length] : [node, 0];
			};
			const [a, aOffset] = point(cell(start), from),
				[b, bOffset] = point(cell(end), to ?? Number.MAX_SAFE_INTEGER);
			window.getSelection()!.setBaseAndExtent(a, aOffset, b, bOffset);
		},
		{ side, start, end, from, to }
	);
}
