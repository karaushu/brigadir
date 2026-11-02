import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	type DependencyList,
} from 'react';

/**
 * spec/appearance#evolution-redesign: a header row with a wide look (words) and a narrow one (glyphs) takes
 * the narrow look exactly when the wide one overflows. A fixed switch width does not hold: the wide header can need
 * ≈ 671 px, and the Ukrainian words and the agent's name in the capsule
 * change the need. So the row is measured while it is wide; `need` is the box width at which it fits.
 */
export type FitState = {
	/** The row shows its narrow look. */ narrow: boolean;
	/** The box width the wide row needs; 0 — not known yet (the row fitted every time it was measured). */ need: number;
	/** The box is under the caller's `below` width (a layout beside the row, e.g. the cards in a column). */ below: boolean;
};
export const fitStart: FitState = { narrow: false, need: 0, below: false };

/**
 * One measure. `box` — the width of the surface; `overflow` — how far the wide row's content runs past the row
 * (`scrollWidth - clientWidth`), null while the narrow look is shown (the wide one cannot be measured then).
 * Returns `state` itself when nothing changes, so a React update bails out.
 */
export function fitStep(
	state: FitState,
	box: number,
	overflow: number | null,
	below = 0
): FitState {
	const under = box < below;
	let next: FitState = state;
	if (!state.narrow) {
		if (overflow !== null && overflow > 0)
			next = { ...state, narrow: true, need: Math.ceil(box + overflow) };
	} else if (box >= state.need) next = { ...state, narrow: false };
	return next.below === under ? next : { ...next, below: under };
}
/** Content of the row changed while it is narrow: the old need may be stale, so the wide look is measured again. */
export function fitRetry(state: FitState): FitState {
	return state.narrow ? { ...state, narrow: false, need: 0 } : state;
}

/**
 * `boxRef` goes on the surface whose width changes, `rowRef` on the row itself (`display: flex`, `min-width: 0`). The
 * row is measured after every render while wide and on every resize of the box; `deps` are what changes the wide
 * row's width outside a resize (locale, the PR state, the capsule's agent) — on a change a narrow row tries wide again.
 * Both switches happen in a layout effect, so the overflowing wide frame is never painted.
 */
export function useFitRow(deps: DependencyList, below = 0) {
	const [state, setState] = useState<FitState>(fitStart),
		box = useRef<HTMLElement | null>(null),
		row = useRef<HTMLElement | null>(null),
		observer = useRef<ResizeObserver | null>(null);
	const measure = useCallback(() => {
		const node = box.current;
		if (!node) return;
		const width = node.getBoundingClientRect().width,
			line = row.current;
		setState((current) =>
			fitStep(
				current,
				width,
				current.narrow || !line ? null : line.scrollWidth - line.clientWidth,
				below
			)
		);
	}, [below]);
	const boxRef = useCallback(
		(node: HTMLElement | null) => {
			observer.current?.disconnect();
			observer.current = null;
			box.current = node;
			if (!node) return;
			observer.current = new ResizeObserver(measure);
			observer.current.observe(node);
		},
		[measure]
	);
	// The caller's list of what changes the row, not this effect's own inputs.
	useLayoutEffect(() => setState(fitRetry), deps);
	useLayoutEffect(measure);
	const rowRef = useCallback((node: HTMLElement | null) => {
		row.current = node;
	}, []);
	useEffect(() => () => observer.current?.disconnect(), []);
	return { boxRef, rowRef, narrow: state.narrow, below: state.below };
}
