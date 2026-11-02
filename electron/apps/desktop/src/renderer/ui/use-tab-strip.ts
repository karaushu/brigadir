import { useCallback, useLayoutEffect, useRef } from 'react';

/** The tab that is one direct child of the strip, around the element that marks the active tab. */
function stripItem(strip: HTMLElement, node: HTMLElement) {
	let item = node;
	while (item.parentElement && item.parentElement !== strip) item = item.parentElement;
	return item.parentElement === strip ? item : null;
}

/**
 * spec/task-window#tab-strips: a tab strip has no visible scrollbar (CSS), so it scrolls by other means. A vertical mouse wheel over an
 * overflowing strip scrolls it sideways; a trackpad's horizontal swipe stays native. The active tab — new, clicked or
 * chosen with ⌥⌘←/→ — slides into view at the nearest edge. Only the strip scrolls: ancestors never move
 * (`scrollIntoView` would scroll them too).
 * With `fade` the strip marks the edges that hide tabs — `data-fade="start" | "end" | "both"` — and
 * `tabStripStyles.fade` turns each into a gradient, so a hidden tab is never a cut word.
 */
export function useTabStrip(
	active: string | null | undefined,
	selector = '[aria-selected=true]',
	fade = false
) {
	const strip = useRef<HTMLElement | null>(null),
		detach = useRef<(() => void) | null>(null);
	const ref = useCallback(
		(node: HTMLElement | null) => {
			detach.current?.();
			detach.current = null;
			strip.current = node;
			if (!node) return;
			// A tab scrolled into view stops at the track's padding, a few px short of the end: that is no hidden tab.
			const edges = () => {
				const start = node.scrollLeft > 4,
					end = node.scrollLeft + node.clientWidth < node.scrollWidth - 4;
				const value = start && end ? 'both' : start ? 'start' : end ? 'end' : null;
				if (value) node.dataset.fade = value;
				else delete node.dataset.fade;
			};
			// The tabs' widths change with their counts and the strip's with the row: both move the edges.
			const sizes = fade ? new ResizeObserver(edges) : null,
				children = fade
					? new MutationObserver(() => {
							for (const child of node.children) sizes?.observe(child);
							edges();
						})
					: null;
			if (fade) {
				sizes?.observe(node);
				for (const child of node.children) sizes?.observe(child);
				children?.observe(node, { childList: true });
				node.addEventListener('scroll', edges, { passive: true });
				edges();
			}
			const wheel = (event: WheelEvent) => {
				if (
					event.ctrlKey ||
					node.scrollWidth <= node.clientWidth ||
					Math.abs(event.deltaY) <= Math.abs(event.deltaX)
				)
					return;
				event.preventDefault();
				node.scrollLeft +=
					event.deltaY *
					(event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? node.clientWidth : 1);
			};
			node.addEventListener('wheel', wheel, { passive: false });
			detach.current = () => {
				node.removeEventListener('wheel', wheel);
				node.removeEventListener('scroll', edges);
				sizes?.disconnect();
				children?.disconnect();
			};
		},
		[fade]
	);
	useLayoutEffect(() => {
		const node = strip.current,
			marked = node?.querySelector<HTMLElement>(selector),
			item = node && marked ? stripItem(node, marked) : null;
		if (!node || !item) return;
		const box = node.getBoundingClientRect(),
			tab = item.getBoundingClientRect();
		const shift =
			tab.left < box.left
				? tab.left - box.left
				: tab.right > box.right
					? Math.min(tab.right - box.right, tab.left - box.left)
					: 0;
		if (!shift) return;
		const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches;
		node.scrollTo({ left: node.scrollLeft + shift, behavior: smooth ? 'smooth' : 'auto' });
	}, [active, selector]);
	return ref;
}
