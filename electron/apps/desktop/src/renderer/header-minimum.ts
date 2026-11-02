import { useEffect, useState } from 'react';

/** One child of a one-line header: its width, or — for a flexible slot — the widths of what stands in it. */
export type HeaderItem = { width: number } | { inner: number[]; gap: number };

/** spec/diff-and-review#changes-header: the width a one-line header needs — paddings, gaps and its controls at their own width, flexible slots at their content. */
export function headerNeed(row: { padding: number; gap: number; items: HeaderItem[] }) {
	const items = row.items.map((item) =>
		'width' in item
			? item.width
			: item.inner.reduce((sum, width) => sum + width, 0) +
				Math.max(0, item.inner.length - 1) * item.gap
	);
	return Math.ceil(
		row.padding +
			items.reduce((sum, width) => sum + width, 0) +
			Math.max(0, items.length - 1) * row.gap
	);
}

const px = (value: string) => Number.parseFloat(value) || 0;
const width = (node: Element) => node.getBoundingClientRect().width;

function measure(header: HTMLElement) {
	const style = getComputedStyle(header);
	return headerNeed({
		padding: px(style.paddingLeft) + px(style.paddingRight),
		gap: px(style.columnGap),
		items: [...header.children].map((child) => {
			const own = getComputedStyle(child);
			return px(own.flexGrow) > 0
				? { inner: [...child.children].map(width), gap: px(own.columnGap) }
				: { width: width(child) };
		}),
	});
}

/**
 * spec/diff-and-review#changes-header: the panel gives way only down to its header in one line. Measured while the panel is compact (≤ `compact` px,
 * where the header takes its narrow look), the widest header seen so far; `key` (the locale) starts it over.
 * `null` keeps the last minimum (the search field stands in the header).
 */
export function useHeaderMinimum(header: HTMLElement | null, compact: number, key: string) {
	const [minimum, setMinimum] = useState<{ key: string; width: number } | null>(null);
	useEffect(() => {
		const panel = header?.closest('aside');
		if (!header || !panel) return;
		let frame = 0;
		const update = () => {
			cancelAnimationFrame(frame);
			// The next frame: a width set inside the observer would re-enter it in the same frame.
			frame = requestAnimationFrame(() => {
				if (panel.clientWidth > compact || !header.isConnected) return;
				const need = measure(header) + (panel.offsetWidth - panel.clientWidth);
				setMinimum((current) =>
					current?.key === key && current.width >= need ? current : { key, width: need }
				);
			});
		};
		const resize = new ResizeObserver(update),
			mutation = new MutationObserver(update);
		resize.observe(header);
		mutation.observe(header, { childList: true, subtree: true, characterData: true });
		update();
		return () => {
			cancelAnimationFrame(frame);
			resize.disconnect();
			mutation.disconnect();
		};
	}, [header, compact, key]);
	return minimum?.key === key ? minimum.width : null;
}
