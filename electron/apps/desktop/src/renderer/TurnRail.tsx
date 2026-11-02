import {
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type MutableRefObject,
} from 'react';
import { t, type AgentTask, type ChangeRange, type Locale } from '@brigadir/core';
import type { RowsNav } from './ui/Rows';
import { StatusIcon } from './ui/Controls';
import { motionTime } from './ui/motion';
import {
	RAIL,
	markWidth,
	railBand,
	railHit,
	railLayout,
	railOffset,
	railTime,
	turnStep,
	visibleTurns,
	type MarkState,
} from './turn-rail';
import styles from './TurnRail.module.css';
import { ChangeCounts } from './ui/ChangeCounts';

export type RailTurn = {
	seq: number;
	number: number;
	text: string;
	at: string;
	running: boolean;
	range: ChangeRange | null;
};
export type TurnRailControl = { step(direction: 1 | -1): void };
const rowId = (turn: RailTurn) => `user-${turn.seq}`,
	HIT_PAD = 6,
	WIDTH = 28,
	BAND_MIN = 20;
type Totals = { additions: number; deletions: number };
type Frame = {
	laneTop: number;
	tops: Float64Array;
	sizes: Float64Array;
	widths: Float64Array;
	states: MarkState[];
};

/**
 * The turn rail, spec/chat-turns-plans-and-questions#turn-rail: one mark per prompt on the right edge of the conversation. Hover or keyboard focus shows
 * the prompt and its time; a click only scrolls (no diff filter, that stays with the Turns panel).
 *
 * Marks are painted on a canvas: Rows re-render the rail on every scroll frame, and ten thousand DOM marks cost a
 * frame budget (p95 45 ms against 14 ms without the rail). Keyboard and screen readers get one roving button.
 */
export function TurnRail({
	turns,
	nav,
	task,
	locale,
	control,
}: {
	turns: RailTurn[];
	nav: RowsNav;
	task: AgentTask;
	locale: Locale;
	control: MutableRefObject<TurnRailControl | null>;
}) {
	const [hover, setHover] = useState<number | null>(null),
		[focused, setFocused] = useState<number | null>(null),
		[cursor, setCursor] = useState<number | null>(null);
	// spec/chat-turns-plans-and-questions#rail-scrollbar: the band is the viewport on the rail; dragging it scrolls, a click without a drag still jumps to a turn.
	// spec/chat-turns-plans-and-questions#rail-scrollbar: it shows only while the pointer is on the rail, grown to the rail's width and BAND_MIN tall. The lens and
	// the card stay on the band too (a mark there is still a click target); the drag starts after 3 px and keeps the
	// pointer at the same place inside the band.
	const [drag, setDrag] = useState(false),
		[pointer, setPointer] = useState<number | null>(null),
		dragRef = useRef<{ y: number; fraction: number; moved: boolean } | null>(null),
		moved = useRef(false),
		bandNode = useRef<HTMLDivElement>(null);
	const root = useRef<HTMLElement>(null),
		canvas = useRef<HTMLCanvasElement>(null),
		focusButton = useRef<HTMLButtonElement>(null);
	const navRef = useRef(nav);
	navRef.current = nav;
	const turnsRef = useRef(turns);
	turnsRef.current = turns;
	const starts = turns.map((turn) => nav.offset(rowId(turn)));
	const visible = visibleTurns(starts, nav.top, nav.height, nav.total),
		shownKey = [...visible].sort((a, b) => a - b).join(','),
		shown = useMemo(() => visible, [shownKey]);
	const active = drag ? null : (hover ?? focused),
		room = Math.max(0, nav.height - 2 * RAIL.margin);
	// Dock-like: the pointer is read against the rail at rest, and the lens keeps the mark in focus where it was at rest,
	// so marks do not slide under a still pointer. The hit area never moves while the lens does.
	const rest = useMemo(() => railLayout(turns.length, room, null), [turns.length, room]),
		restTop = (nav.height - rest.total) / 2;
	const layout = useMemo(
		() => (active === null ? rest : railLayout(turns.length, room, active)),
		[rest, active, turns.length, room]
	);
	const laneTop =
		active === null
			? restTop
			: Math.min(
					Math.max(
						0,
						restTop +
							rest.tops[active]! +
							rest.sizes[active]! / 2 -
							layout.tops[active]! -
							layout.sizes[active]! / 2
					),
					Math.max(0, nav.height - layout.total)
				);
	const restRef = useRef({ rest, restTop, starts });
	restRef.current = { rest, restTop, starts };
	const band = railBand(starts, nav.total, layout, nav.top, nav.height, BAND_MIN),
		over = pointer !== null,
		onBand =
			pointer !== null &&
			pointer >= laneTop + band.top &&
			pointer <= laneTop + band.top + band.height;
	const restY = (event: { clientY: number; currentTarget: Element }) => {
		const box = event.currentTarget.getBoundingClientRect(),
			{ rest } = restRef.current;
		return box.height
			? (event.clientY - box.top) * ((rest.total + 2 * HIT_PAD) / box.height) - HIT_PAD
			: 0;
	};
	// Roving focus: Tab lands on the first prompt on screen, arrows walk the rail.
	const first = [...shown].sort((a, b) => a - b)[0],
		tabStop = Math.min(turns.length - 1, cursor ?? first ?? turns.length - 1);
	const go = (index: number) => {
		const turn = turnsRef.current[index];
		if (turn) navRef.current.scrollTo(rowId(turn));
	};
	control.current = {
		step(direction) {
			const next = turnStep(starts, nav.top, nav.maxTop, direction);
			if (next === 'end') nav.toEnd();
			else if (next !== null) go(next);
		},
	};
	const totals = useTurnTotals(task, active === null ? undefined : turns[active]);
	const target = useMemo((): Frame => {
		const states = turns.map((turn, i): MarkState =>
			turn.running ? 'running' : i === active ? 'active' : shown.has(i) ? 'shown' : 'rest'
		);
		return {
			laneTop,
			tops: Float64Array.from(layout.tops),
			sizes: Float64Array.from(layout.sizes),
			widths: Float64Array.from(states, (state, i) =>
				markWidth(state, shown.has(i), layout.weights[i] ?? 0)
			),
			states,
		};
	}, [turns, active, shown, layout, laneTop]);
	usePaint(canvas, root, target, nav.height);
	if (turns.length < 2) return null;
	const card = active === null ? null : turns[active]!,
		centre = (i: number) => laneTop + layout.tops[i]! + layout.sizes[i]! / 2;
	const cardTop =
			active === null
				? 0
				: Math.min(Math.max(centre(active), RAIL.margin), nav.height - RAIL.margin),
		stop = turns[tabStop]!;
	return (
		<nav
			ref={root}
			data-turn-rail
			data-count={turns.length}
			data-shown={shownKey}
			data-active={active ?? undefined}
			className={styles.rail}
			aria-label={t(locale, 'Conversation turns')}>
			<div
				ref={bandNode}
				data-rail-band
				className={styles.band}
				data-state={drag || onBand ? 'grab' : over ? 'over' : undefined}
				style={{ top: laneTop + band.top, height: band.height }}
				aria-hidden="true"
			/>
			<canvas ref={canvas} className={styles.canvas} aria-hidden="true" />
			<div
				className={styles.hit}
				data-dragging={drag ? true : undefined}
				data-on-band={onBand || undefined}
				style={{ top: restTop - HIT_PAD, height: rest.total + 2 * HIT_PAD }}
				onPointerDown={(event) => {
					moved.current = false;
					if (event.button !== 0) return;
					const box = bandNode.current?.getBoundingClientRect();
					if (!box || event.clientY < box.top || event.clientY > box.bottom) return;
					event.currentTarget.setPointerCapture(event.pointerId);
					dragRef.current = {
						y: event.clientY,
						fraction: box.height ? (event.clientY - box.top) / box.height : 0,
						moved: false,
					};
				}}
				onPointerMove={(event) => {
					const y = restY(event),
						now = dragRef.current;
					if (now) {
						if (!now.moved && Math.abs(event.clientY - now.y) < 3) return;
						if (!now.moved) {
							now.moved = moved.current = true;
							setHover(null);
							setDrag(true);
						}
						// At rest the band has its rest size; the pointer keeps its place inside it.
						const { rest, starts } = restRef.current,
							{ top, height, total } = navRef.current,
							size = railBand(starts, total, rest, top, height, BAND_MIN).height,
							natural = railBand(starts, total, rest, top, height, 0).height;
						navRef.current.scrollToOffset(
							railOffset(starts, total, rest, y - now.fraction * size + (size - natural) / 2)
						);
						return;
					}
					// The pointer in rail coordinates; whether it is on the band follows each layout of the lens.
					const at = event.clientY - (root.current?.getBoundingClientRect().top ?? 0);
					setPointer((value) => (value === at ? value : at));
					const index = railHit(restRef.current.rest, y);
					setHover((value) => (value === index ? value : index));
				}}
				onLostPointerCapture={(event) => {
					dragRef.current = null;
					setDrag(false);
					const box = event.currentTarget.getBoundingClientRect();
					if (
						event.clientX < box.left ||
						event.clientX > box.right ||
						event.clientY < box.top ||
						event.clientY > box.bottom
					)
						setPointer(null);
				}}
				onPointerLeave={() => {
					if (!dragRef.current) {
						setHover(null);
						setPointer(null);
					}
				}}
				onClick={(event) => {
					if (moved.current) return;
					const index = railHit(restRef.current.rest, restY(event));
					if (index !== null) go(index);
				}}
			/>
			<button
				ref={focusButton}
				type="button"
				className={styles.focus}
				style={{ top: centre(tabStop) }}
				aria-label={`${t(locale, 'Turn')} ${stop.number}: ${stop.text.split(/\r?\n/, 1)[0]}`}
				aria-current={shown.has(tabStop) ? 'location' : undefined}
				onFocus={() => {
					setCursor(tabStop);
					setFocused(tabStop);
				}}
				onBlur={() => {
					setFocused(null);
					setCursor(null);
				}}
				onClick={() => go(tabStop)}
				onKeyDown={(event) => {
					const next =
						event.key === 'ArrowUp'
							? tabStop - 1
							: event.key === 'ArrowDown'
								? tabStop + 1
								: event.key === 'Home'
									? 0
									: event.key === 'End'
										? turns.length - 1
										: null;
					if (next === null || event.altKey || event.metaKey || event.ctrlKey) return;
					event.preventDefault();
					const clamped = Math.max(0, Math.min(turns.length - 1, next));
					setCursor(clamped);
					setFocused(clamped);
				}}
			/>
			{card && (
				<div className={styles.card} style={{ top: cardTop }} aria-hidden="true">
					<p>{card.text}</p>
					<footer>
						<span>
							{t(locale, 'Turn')} {card.number}
						</span>
						{totals && (totals.additions > 0 || totals.deletions > 0) && (
							<ChangeCounts
								additions={totals.additions}
								deletions={totals.deletions}
								locale={locale}
								className={styles.counts}
								split
							/>
						)}
						<span className={styles.space} />
						{card.running ? (
							<span className={styles.running}>
								<StatusIcon status="working" label={t(locale, 'Running')} />
								{t(locale, 'Running')}
							</span>
						) : (
							<time dateTime={card.at}>{railTime(card.at)}</time>
						)}
					</footer>
				</div>
			)}
		</nav>
	);
}

/** spec/chat-turns-plans-and-questions#rail-scrollbar: the view moved within the last second; the band (or the thumb) shows it. */
function useScrolling(top: number) {
	const [scrolling, setScrolling] = useState(false),
		first = useRef(true);
	useEffect(() => {
		if (first.current) {
			first.current = false;
			return;
		}
		setScrolling(true);
		const timer = setTimeout(() => setScrolling(false), 1000);
		return () => clearTimeout(timer);
	}, [top]);
	return scrolling;
}

/**
 * spec/chat-turns-plans-and-questions#rail-scrollbar: a conversation without a rail (fewer than two prompts) still hides the system scrollbar; this thin thumb
 * takes its place at the edge. It shows while the view moves and while the pointer is on the edge, and drags.
 */
export function ScrollThumb({ nav }: { nav: RowsNav }) {
	const [hover, setHover] = useState(false),
		[drag, setDrag] = useState<{ y: number; top: number } | null>(null),
		scrolling = useScrolling(nav.top);
	if (nav.total <= nav.height + 1) return null;
	const size = Math.max(24, (nav.height * nav.height) / nav.total),
		top = nav.maxTop ? (nav.height - size) * Math.min(1, nav.top / nav.maxTop) : 0;
	return (
		<div
			data-scroll-thumb
			className={styles.thumbZone}
			data-shown={scrolling || hover || drag ? true : undefined}
			data-active={hover || drag ? true : undefined}
			aria-hidden="true"
			onPointerEnter={() => setHover(true)}
			onPointerLeave={() => setHover(false)}>
			<div
				className={styles.thumb}
				style={{ top, height: size }}
				onPointerDown={(event) => {
					if (event.button !== 0) return;
					event.preventDefault();
					event.currentTarget.setPointerCapture(event.pointerId);
					setDrag({ y: event.clientY, top: nav.top });
				}}
				onPointerMove={(event) => {
					if (drag)
						nav.scrollToOffset(
							drag.top + ((event.clientY - drag.y) * nav.maxTop) / Math.max(1, nav.height - size)
						);
				}}
				onPointerUp={() => setDrag(null)}
				onLostPointerCapture={() => setDrag(null)}
			/>
		</div>
	);
}

/**
 * Paints the marks, easing from the last painted frame to `target` over --motion-fast (0 under reduced motion). The
 * first paint and a changed turn count snap: nothing slides in from a guessed viewport height. Colours are the theme
 * tokens, re-read when the theme or accent changes.
 */
function usePaint(
	canvas: MutableRefObject<HTMLCanvasElement | null>,
	root: MutableRefObject<HTMLElement | null>,
	target: Frame,
	height: number
) {
	const drawn = useRef<Frame | null>(null),
		frame = useRef(0),
		[theme, setTheme] = useState(0);
	useEffect(() => {
		const observer = new MutationObserver(() => setTheme((n) => n + 1));
		observer.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ['data-theme', 'style', 'class', 'data-palette'],
		});
		return () => observer.disconnect();
	}, []);
	useLayoutEffect(() => {
		const node = canvas.current,
			host = root.current;
		if (!node || !host) return;
		const scale = devicePixelRatio || 1,
			style = getComputedStyle(host),
			colors: Record<MarkState, string> = {
				rest: style.getPropertyValue('--fg3'),
				shown: style.getPropertyValue('--fg2'),
				active: style.getPropertyValue('--fg'),
				running: style.getPropertyValue('--accent'),
			};
		if (node.width !== Math.round(WIDTH * scale) || node.height !== Math.round(height * scale)) {
			node.width = Math.round(WIDTH * scale);
			node.height = Math.round(height * scale);
		}
		const context = node.getContext('2d');
		if (!context) return;
		const paint = (value: Frame) => {
			context.setTransform(scale, 0, 0, scale, 0, 0);
			context.clearRect(0, 0, WIDTH, height);
			for (let i = 0; i < value.states.length; i++) {
				const width = value.widths[i]!;
				context.fillStyle = colors[value.states[i]!];
				context.fillRect(
					WIDTH - 4 - width,
					value.laneTop + value.tops[i]! + value.sizes[i]! / 2 - 1,
					width,
					2
				);
			}
		};
		cancelAnimationFrame(frame.current);
		const from = drawn.current,
			duration = motionTime('--motion-fast');
		if (!from || from.states.length !== target.states.length || !duration) {
			drawn.current = target;
			paint(target);
			return;
		}
		const start = performance.now(),
			mix = (a: Float64Array, b: Float64Array, k: number) =>
				Float64Array.from(b, (value, i) => a[i]! + (value - a[i]!) * k);
		const step = (now: number) => {
			const p = Math.min(1, (now - start) / duration),
				k = 1 - (1 - p) ** 3,
				value: Frame = {
					laneTop: from.laneTop + (target.laneTop - from.laneTop) * k,
					tops: mix(from.tops, target.tops, k),
					sizes: mix(from.sizes, target.sizes, k),
					widths: mix(from.widths, target.widths, k),
					states: target.states,
				};
			drawn.current = value;
			paint(value);
			if (p < 1) frame.current = requestAnimationFrame(step);
		};
		step(start);
		return () => cancelAnimationFrame(frame.current);
	}, [target, height, theme]);
}

/** The turn's +N −M, the numbers of its footer (spec/chat#collapse-rules); read when the card first shows a turn, then kept per checkpoint. */
function useTurnTotals(task: AgentTask, turn: RailTurn | undefined): Totals | null {
	const cache = useRef(new Map<string, Totals>()),
		[, refresh] = useState(0);
	const key = turn?.range ? `${turn.seq}/${turn.range.current}` : null;
	useEffect(() => {
		if (!turn || !key || cache.current.has(key)) return;
		let active = true;
		void window.brigadir.readTurnChanges(task, turn.seq).then(
			(value) => {
				cache.current.set(
					key,
					value.files.reduce(
						(sum, file) =>
							file.binary
								? sum
								: {
										additions: sum.additions + file.additions,
										deletions: sum.deletions + file.deletions,
									},
						{ additions: 0, deletions: 0 }
					)
				);
				if (active) refresh((n) => n + 1);
			},
			() => {}
		);
		return () => {
			active = false;
		};
	}, [task.id, task.projectId, key]);
	return key ? (cache.current.get(key) ?? null) : null;
}
