import { useLayoutEffect, useRef } from 'react';
import { motionTime } from './ui/motion';
/** Animate retained sidebar rows only. New tasks and filtered/disclosed rows never replay entrances. */
export function useSidebarOrder(order: string, layout: string) {
	const previous = useRef(new Map<string, number>()),
		lastLayout = useRef(layout);
	useLayoutEffect(() => {
		if (lastLayout.current !== layout) {
			previous.current.clear();
			lastLayout.current = layout;
		}
		const next = new Map<string, number>(),
			reduced = matchMedia('(prefers-reduced-motion: reduce)').matches,
			duration = motionTime('--motion-travel');
		// Read every position first, then touch animations: interleaving them forced a layout per row (perf review UI-05).
		const lists = new Map<HTMLElement, number>(),
			rows = [...document.querySelectorAll<HTMLElement>('[data-sidebar-order]')].map((node) => {
				const transform = getComputedStyle(node).transform,
					shift = transform === 'none' ? 0 : new DOMMatrixReadOnly(transform).m42,
					list = node.closest<HTMLElement>('[data-sidebar-list]');
				let origin = 0;
				if (list) {
					if (!lists.has(list)) lists.set(list, list.getBoundingClientRect().top - list.scrollTop);
					origin = lists.get(list)!;
				}
				return {
					node,
					id: node.dataset.sidebarOrder!,
					shift,
					top: node.getBoundingClientRect().top - shift - origin,
				};
			});
		for (const { node, id, shift, top } of rows) {
			const before = previous.current.get(id);
			node
				.getAnimations()
				.filter((animation) => animation.id === 'sidebar-order')
				.forEach((animation) => animation.cancel());
			next.set(id, top);
			if (!reduced && before !== undefined && Math.abs(before + shift - top) > 0.5) {
				const animation = node.animate(
					[{ transform: `translateY(${before + shift - top}px)` }, { transform: 'translateY(0)' }],
					{ duration, easing: 'cubic-bezier(.2,.8,.2,1)' }
				);
				animation.id = 'sidebar-order';
			}
		}
		previous.current = next;
	}, [order, layout]);
}
