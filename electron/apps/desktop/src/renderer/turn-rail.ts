import { formatDateTime, formatTime } from '@brigadir/core';
/** Rail geometry, spec/chat-turns-plans-and-questions#turn-rail: 2 px marks on a 7 px step; a Dock-like lens under the pointer. */
export const RAIL = { pitch: 7, margin: 40, lens: 10, sigma: 3.5 } as const;
export type RailLayout = { tops: number[]; sizes: number[]; total: number; weights: number[] };

/**
 * The step is 7 px while the rail fits in `height`; below that it shrinks evenly, with no lower bound. Around `focus`
 * the step grows to about 10 px and falls off as a Gaussian; far marks shrink so the rail never grows past `height`.
 */
export function railLayout(count: number, height: number, focus: number | null): RailLayout {
	const room = Math.max(0, height),
		base = count ? Math.min(RAIL.pitch, room / count) : 0,
		gain = base ? Math.max(0.6, RAIL.lens / base - 1) : 0;
	const weights = Array.from({ length: count }, (_, i) =>
		focus === null ? 0 : Math.exp(-((i - focus) ** 2) / (2 * RAIL.sigma ** 2))
	);
	const raw = weights.map((weight) => base * (1 + gain * weight)),
		sum = raw.reduce((a, b) => a + b, 0),
		limit = Math.max(count * base, room);
	const scale = sum > limit ? limit / sum : 1,
		sizes = raw.map((size) => size * scale),
		tops: number[] = [];
	let y = 0;
	for (const size of sizes) {
		tops.push(y);
		y += size;
	}
	return { tops, sizes, total: y, weights };
}
/** The mark under `y` (rail coordinates) in the layout the pointer is looking at. */
export function railHit(layout: RailLayout, y: number): number | null {
	if (!layout.tops.length) return null;
	for (let i = 0; i < layout.tops.length; i++) if (y < layout.tops[i]! + layout.sizes[i]!) return i;
	return layout.tops.length - 1;
}
/** A turn is on screen when any part of it, from its prompt to the next prompt, is inside the viewport. */
export function visibleTurns(
	starts: readonly (number | undefined)[],
	top: number,
	height: number,
	end: number
): Set<number> {
	const shown = new Set<number>();
	let to = end;
	for (let i = starts.length - 1; i >= 0; i--) {
		const from = starts[i];
		if (from === undefined) continue;
		if (to > top && from < top + height) shown.add(i);
		to = from;
	}
	return shown;
}
/**
 * ⌥⌘↑ / ⌥⌘↓ from the top of the viewport: the nearest prompt above, or the first below. A prompt the view cannot
 * scroll to (the conversation ends before it reaches the top) is the end: ⌥⌘↓ then goes to the bottom and follows.
 */
export function turnStep(
	starts: readonly (number | undefined)[],
	top: number,
	maxTop: number,
	direction: 1 | -1
): number | 'end' | null {
	if (direction < 0) {
		for (let i = starts.length - 1; i >= 0; i--) {
			const at = starts[i];
			if (at !== undefined && at < top - 1) return i;
		}
		return null;
	}
	const next = starts.findIndex((at) => at !== undefined && at > top + 1);
	return next < 0 || starts[next]! > maxTop + 1 ? 'end' : next;
}
/** Today: the time only; another day: date · time, the app's European format (date-time.ts). */
export function railTime(at: string, now = new Date()): string {
	const date = new Date(at);
	return date.toDateString() === now.toDateString() ? formatTime(date) : formatDateTime(date);
}
/**
 * spec/chat-turns-plans-and-questions#rail-scrollbar: the rail is the conversation's scrollbar. Each mark's cell (`tops[i]`…`tops[i]+sizes[i]`) stands for its
 * turn, from its prompt to the next prompt (the last one to `end`); a scroll offset maps linearly inside its turn's cell.
 * Content above the first prompt maps to the rail's top edge.
 */
function cells(starts: readonly (number | undefined)[], end: number) {
	const known: number[] = [];
	let last = 0;
	for (const at of starts) {
		last = at === undefined ? last : Math.max(last, at);
		known.push(last);
	}
	return known.map((from, i) => ({
		from,
		to: Math.max(from, i + 1 < known.length ? known[i + 1]! : end),
	}));
}
export function railY(
	starts: readonly (number | undefined)[],
	end: number,
	layout: RailLayout,
	y: number
): number {
	const list = cells(starts, end);
	if (!list.length) return 0;
	if (y <= list[0]!.from) return 0;
	for (let i = 0; i < list.length; i++) {
		const { from, to } = list[i]!;
		if (y < to || i === list.length - 1) {
			const k = to > from ? Math.min(1, (y - from) / (to - from)) : 1;
			return layout.tops[i]! + layout.sizes[i]! * k;
		}
	}
	return layout.total;
}
/** The inverse of `railY`: the scroll offset a rail position stands for. */
export function railOffset(
	starts: readonly (number | undefined)[],
	end: number,
	layout: RailLayout,
	y: number
): number {
	const list = cells(starts, end);
	if (!list.length) return 0;
	if (y <= 0) return 0;
	for (let i = 0; i < list.length; i++) {
		const top = layout.tops[i]!,
			size = layout.sizes[i]!;
		if (y < top + size || i === list.length - 1) {
			const { from, to } = list[i]!;
			return from + (to - from) * Math.min(1, Math.max(0, size ? (y - top) / size : 1));
		}
	}
	return end;
}
/** The viewport's band on the rail, rail coordinates; never thinner than `min`, centred on the viewport when it would be. */
export function railBand(
	starts: readonly (number | undefined)[],
	end: number,
	layout: RailLayout,
	top: number,
	height: number,
	min = 6
): { top: number; height: number } {
	const from = railY(starts, end, layout, top),
		to = railY(starts, end, layout, top + height),
		size = to - from;
	if (size >= min) return { top: from, height: size };
	return { top: Math.max(0, Math.min(layout.total - min, (from + to - min) / 2)), height: min };
}
export type MarkState = 'rest' | 'shown' | 'active' | 'running';
/** Mark length: 8 px at rest, 12 px on screen, 18 px in focus; the lens adds up to 8 px to its neighbours. */
export function markWidth(state: MarkState, shown: boolean, weight: number) {
	return state === 'active' ? 18 : (shown ? 12 : 8) + 8 * weight;
}
