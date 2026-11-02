import { TextInput } from './Input';
import { t, type Locale } from '@brigadir/core';
import { Button } from './Controls';
import { ClearField } from './ClearField';
import { PopupClose } from './PopupClose';
import { flushSync } from 'react-dom';
import {
	memo,
	useEffect,
	useCallback,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type CSSProperties,
	type ReactNode,
} from 'react';
import styles from './Rows.module.css';
/**
 * A row re-renders when its data, the consumer's `render` or its focus changes. Scrolling, measuring and following
 * re-render `Rows` alone and reuse every mounted row (perf review CHAT-08, DIFF-05); a consumer whose `render` depends
 * on outside state passes a new `render` and so still refreshes every row, as before.
 */
const Measured = memo(function Measured<T>({
	id,
	row,
	render,
	focused,
	observe,
}: {
	id: string;
	row: T;
	render(row: T): ReactNode;
	focused: boolean;
	observe(node: HTMLElement): () => void;
}) {
	const ref = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => observe(ref.current!), [observe]);
	return (
		<div ref={ref} className={styles.measured} data-row-id={id}>
			<div data-focused-row={focused}>{render(row)}</div>
		</div>
	);
}) as <T>(props: {
	id: string;
	row: T;
	render(row: T): ReactNode;
	focused: boolean;
	observe(node: HTMLElement): () => void;
}) => ReactNode;
export type RowsPosition = {
	top: number;
	left: number;
	follow: boolean;
	sizes: Map<string, number>;
};
/** What a companion drawn beside the rows (the turn rail, spec/chat-turns-plans-and-questions#turn-rail) reads and does; content coordinates, not screen ones. */
/** `scrollToOffset`: spec/chat-turns-plans-and-questions#rail-scrollbar, the turn rail drags the view like a scrollbar thumb. */
export type RowsNav = {
	top: number;
	height: number;
	total: number;
	maxTop: number;
	offset(id: string): number | undefined;
	scrollTo(id: string): void;
	scrollToOffset(top: number): void;
	toEnd(): void;
};
/** Find hits of every open search (the chat and a diff can both search): one CSS highlight for all of them. */
const finds = new Map<object, { all: Range[]; current: Range[] }>();
function paintFinds() {
	const registry = (globalThis.CSS as { highlights?: Map<string, unknown> } | undefined)
		?.highlights;
	if (!registry || typeof Highlight === 'undefined') return;
	const all: Range[] = [],
		current: Range[] = [];
	for (const value of finds.values()) {
		all.push(...value.all);
		current.push(...value.current);
	}
	for (const [name, ranges] of [
		['rows-find', all],
		['rows-find-current', current],
	] as const)
		if (ranges.length) registry.set(name, new Highlight(...ranges));
		else registry.delete(name);
}
/** The ranges of `query` in the text of the rows mounted under `root`; the target row's go to `current`. */
function findRanges(root: HTMLElement, query: string, target: string | undefined) {
	const all: Range[] = [],
		current: Range[] = [],
		value = query.toLocaleLowerCase(),
		walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	for (
		let node = walker.nextNode();
		node && all.length + current.length < 2000;
		node = walker.nextNode()
	) {
		const parent = node.parentElement;
		if (!parent || parent.closest('input,textarea,[contenteditable="true"],[aria-hidden="true"]'))
			continue;
		const text = (node.textContent ?? '').toLocaleLowerCase(),
			row = parent.closest<HTMLElement>('[data-row-id]')?.dataset.rowId;
		for (let at = text.indexOf(value); at >= 0; at = text.indexOf(value, at + value.length)) {
			const range = document.createRange();
			range.setStart(node, at);
			range.setEnd(node, at + value.length);
			(row !== undefined && row === target ? current : all).push(range);
		}
	}
	return { all, current };
}
/** The shared variable-height surface for activity and diff; only visible rows mount. */
export function Rows<T extends { id: string }>({
	rows,
	render,
	label,
	followOutput = true,
	alignBottom = false,
	role = 'log',
	estimatedHeight = 64,
	measurementKey,
	minWidth = 0,
	position,
	targetId: externalTarget,
	targetAlign = 'start',
	maxHeight,
	onInteract,
	searchText,
	onSearchOpen,
	locale = 'en',
	aside,
	bottomInset = 0,
	scrollbar = 'native',
}: {
	rows: T[];
	render(row: T): ReactNode;
	label: string;
	followOutput?: boolean;
	alignBottom?: boolean;
	role?: 'log' | 'list' | 'tree';
	estimatedHeight?: number;
	measurementKey?: string;
	minWidth?: number;
	position?: RowsPosition;
	targetId?: string | undefined;
	targetAlign?: 'start' | 'nearest';
	maxHeight?: number;
	onInteract?: () => void;
	searchText?: (row: T) => string;
	onSearchOpen?: () => void;
	locale?: Locale;
	aside?: ((nav: RowsNav) => ReactNode) | undefined;
	/** Height of a surface floating over the bottom of the log (the composer island): the last row can scroll clear of it. */ bottomInset?: number;
	/** spec/chat-turns-plans-and-questions#rail-scrollbar: `hidden` when an `aside` draws the scrollbar (the turn rail). */ scrollbar?:
		'native' | 'hidden';
}) {
	const [searching, setSearching] = useState(false),
		[query, setQuery] = useState(''),
		[match, setMatch] = useState(0);
	const searchInput = useRef<HTMLInputElement>(null);
	// Row text is cached by row identity: while a transcript streams, only new or changed rows are stripped again (CHAT-16).
	const texts = useRef<{ source: typeof searchText; map: WeakMap<T, string> }>({
		source: searchText,
		map: new WeakMap(),
	});
	const matches = useMemo(() => {
		if (!searching || !query || !searchText) return [];
		if (texts.current.source !== searchText)
			texts.current = { source: searchText, map: new WeakMap() };
		const value = query.toLocaleLowerCase();
		const found: string[] = [];
		for (const row of rows) {
			let text = texts.current.map.get(row);
			if (text === undefined) {
				text = searchText(row).toLocaleLowerCase();
				texts.current.map.set(row, text);
			}
			if (text.includes(value)) found.push(row.id);
			if (found.length >= 5000) break;
		}
		return found;
	}, [rows, query, searchText, searching]);
	const index = Math.min(match, Math.max(0, matches.length - 1)),
		targetId = searching && query ? matches[index] : externalTarget;
	const move = (delta: number) =>
		setMatch((index + delta + matches.length) % Math.max(1, matches.length));
	// Canvas v3 2.1: the found words are marked in the rows on screen, after every render (scrolling mounts new rows).
	const findOwner = useRef({}).current;
	useEffect(() => {
		const node = viewport.current;
		if (!searching || !query || !node || !searchText) {
			if (finds.delete(findOwner)) paintFinds();
			return;
		}
		finds.set(findOwner, findRanges(node, query, targetId));
		paintFinds();
	});
	useEffect(
		() => () => {
			finds.delete(findOwner);
			paintFinds();
		},
		[findOwner]
	);
	useEffect(() => {
		if (searching) {
			searchInput.current?.focus();
			searchInput.current?.select();
		}
	}, [searching]);
	useEffect(() => {
		if (!searchText) return;
		return window.brigadir.onEditorAction((action) => {
			if (
				action !== 'find' ||
				document.activeElement?.closest('dialog,[data-role="console"],[data-menu-tree]')
			)
				return;
			if (
				document.querySelector('[data-columns="3"]') &&
				!viewport.current?.contains(document.activeElement)
			)
				return;
			onSearchOpen?.();
			setSearching(true);
			searchInput.current?.focus();
			searchInput.current?.select();
		});
	}, [searchText, onSearchOpen]);
	const viewport = useRef<HTMLDivElement>(null);
	const sizes = useRef(position?.sizes ?? new Map<string, number>());
	const follow = useRef(position?.follow ?? followOutput);
	const [following, setFollowing] = useState(follow.current);
	const [revision, update] = useState(0);
	const [view, setView] = useState({ top: position?.top ?? 0, height: 600 });
	const offsets = useMemo(() => {
		const values = [0];
		for (const row of rows)
			values.push(values.at(-1)! + (sizes.current.get(row.id) ?? estimatedHeight));
		return values;
	}, [rows, revision, estimatedHeight]);
	const total = offsets.at(-1)!;
	const applied = useRef<string | undefined>(undefined);

	const indices = useMemo(() => new Map(rows.map((row, index) => [row.id, index])), [rows]);
	const layout = useRef({ indices, offsets, estimatedHeight });
	layout.current = { indices, offsets, estimatedHeight };
	const adjustment = useRef(0);
	// Row heights are fractional and scrollTop is not: the exact position the rows asked for is kept while the viewport
	// still sits where it was put, so jumps and corrections for rows above do not lose a fraction of a pixel each time.
	const exact = useRef<{ wanted: number; got: number } | undefined>(undefined);
	const scrollTopOf = (node: HTMLElement) =>
		exact.current?.got === node.scrollTop ? exact.current.wanted : node.scrollTop;
	const scrollNode = (node: HTMLElement, top: number) => {
		node.scrollTop = top;
		exact.current = { wanted: top, got: node.scrollTop };
	};
	/** Records a row's height; true when it changed. A row that grew above the reader moves the scroll by the same amount. */
	const record = useCallback((node: HTMLElement) => {
		const id = node.dataset.rowId!,
			height = node.getBoundingClientRect().height;
		if (sizes.current.get(id) === height) return false;
		const current = layout.current,
			index = current.indices.get(id) ?? -1,
			top = viewport.current ? scrollTopOf(viewport.current) : 0;
		if (!follow.current && index >= 0 && (current.offsets[index + 1] ?? Infinity) <= top)
			adjustment.current += height - (sizes.current.get(id) ?? current.estimatedHeight);
		sizes.current.set(id, height);
		return true;
	}, []);
	// Rows at their estimated height must never be painted: scrolling up through rows not measured yet made the visible
	// text jump for a frame. A mounting row is measured in its layout effect, so React re-renders before paint; later
	// resizes come through one shared observer, whose callback runs past layout and before paint and flushes right there.
	const observer = useRef<ResizeObserver | undefined>(undefined);
	const observe = useCallback(
		(node: HTMLElement) => {
			observer.current ??= new ResizeObserver((entries) => {
				let changed = false;
				for (const entry of entries) changed = record(entry.target as HTMLElement) || changed;
				if (changed) flushSync(() => update((v) => v + 1));
			});
			if (record(node)) update((v) => v + 1);
			const rows = observer.current;
			rows.observe(node);
			return () => rows.unobserve(node);
		},
		[record]
	);
	useEffect(() => () => observer.current?.disconnect(), []);
	useLayoutEffect(() => {
		const delta = adjustment.current;
		adjustment.current = 0;
		if (delta && !follow.current && viewport.current) {
			scrollNode(viewport.current, scrollTopOf(viewport.current) + delta);
			setView((v) => ({ ...v, top: viewport.current!.scrollTop }));
		}
	}, [revision]);
	useLayoutEffect(() => {
		const node = viewport.current!;
		if (position) {
			node.scrollTop = position.top;
			node.scrollLeft = position.left;
		}
		let width = node.clientWidth;
		const observer = new ResizeObserver(() => {
			if (width !== node.clientWidth) {
				// Child observers may have reported this resize already. Keep current mounted
				// measurements while invalidating offscreen rows; their observers may not fire again.
				sizes.current.clear();
				for (const row of node.querySelectorAll<HTMLElement>(':scope > div > div > [data-row-id]'))
					sizes.current.set(row.dataset.rowId!, row.getBoundingClientRect().height);
				width = node.clientWidth;
				update((v) => v + 1);
			}
			setView({ top: node.scrollTop, height: node.clientHeight });
		});
		observer.observe(node);
		return () => {
			if (position) {
				position.top = node.scrollTop;
				position.left = node.scrollLeft;
				position.follow = follow.current;
			}
			observer.disconnect();
		};
	}, []);
	useLayoutEffect(() => {
		if (measurementKey === undefined) return;
		const node = viewport.current!;
		sizes.current.clear();
		for (const row of node.querySelectorAll<HTMLElement>(':scope > div > div > [data-row-id]'))
			sizes.current.set(row.dataset.rowId!, row.getBoundingClientRect().height);
		update((v) => v + 1);
	}, [measurementKey]);
	useLayoutEffect(() => {
		if (!targetId) {
			applied.current = undefined;
			return;
		}
		if (applied.current === targetId) return;
		const index = rows.findIndex((row) => row.id === targetId);
		if (index < 0 || !viewport.current) return;
		applied.current = targetId;
		adjustment.current = 0;
		follow.current = false;
		setFollowing(false);
		const node = viewport.current,
			top = offsets[index] ?? 0,
			bottom = offsets[index + 1] ?? top;
		if (targetAlign === 'nearest' && !(searching && query)) {
			if (top < node.scrollTop) scrollNode(node, top);
			else if (bottom > node.scrollTop + node.clientHeight - bottomInset)
				scrollNode(node, bottom - node.clientHeight + bottomInset);
		} else scrollNode(node, top);
		setView((v) => ({ ...v, top: node.scrollTop }));
	}, [targetId, rows, offsets, targetAlign, searching, query, bottomInset]);
	useLayoutEffect(() => {
		if (followOutput && follow.current && viewport.current) {
			viewport.current.scrollTop = total + bottomInset;
			setView((v) =>
				v.top === viewport.current!.scrollTop ? v : { ...v, top: viewport.current!.scrollTop }
			);
		}
	}, [total, rows, followOutput, bottomInset]);
	function indexAt(position: number) {
		let lo = 0,
			hi = rows.length;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if (offsets[mid + 1]! < position) lo = mid + 1;
			else hi = mid;
		}
		return lo;
	}
	function toEnd() {
		follow.current = true;
		setFollowing(true);
		if (viewport.current) {
			viewport.current.scrollTop = viewport.current.scrollHeight;
			setView((v) => ({ ...v, top: viewport.current!.scrollTop }));
		}
		if (position) position.follow = true;
	}
	/** A jump the reader asked for: it stops following, exactly like a manual scroll (spec/chat#collapse-rules). */
	function scrollToOffset(top: number) {
		const node = viewport.current;
		if (!node) return;
		adjustment.current = 0;
		node.scrollTop = Math.max(0, top);
		setView((v) => ({ ...v, top: node.scrollTop }));
	}
	function scrollTo(id: string) {
		const index = indices.get(id),
			node = viewport.current;
		if (index === undefined || !node) return;
		adjustment.current = 0;
		follow.current = false;
		setFollowing(false);
		if (position) position.follow = false;
		scrollNode(node, offsets[index] ?? 0);
		setView((v) => ({ ...v, top: node.scrollTop }));
	}
	const visible = Math.max(0, view.height - bottomInset);
	const nav: RowsNav = {
		top: view.top,
		height: visible,
		total,
		maxTop: Math.max(0, total - visible),
		offset: (id) => {
			const index = indices.get(id);
			return index === undefined ? undefined : offsets[index];
		},
		scrollTo,
		scrollToOffset,
		toEnd,
	};
	const start = indexAt(Math.max(0, view.top - 500));
	const end = Math.min(rows.length, indexAt(view.top + view.height + 500) + 1);
	return (
		<>
			{searching && (
				<form
					className={styles.search}
					data-size="m"
					onSubmit={(event) => {
						event.preventDefault();
						move(1);
					}}>
					<div className={styles.searchField}>
						<TextInput
							ref={searchInput}
							aria-label={t(locale, 'Find in view')}
							value={query}
							maxLength={200}
							onChange={(event) => {
								setQuery(event.target.value);
								setMatch(0);
							}}
							onKeyDown={(event) => {
								if (event.key === 'Escape') {
									event.preventDefault();
									setSearching(false);
								}
								if (event.key === 'Enter' && event.shiftKey) {
									event.preventDefault();
									move(-1);
								}
							}}
						/>
						<ClearField
							locale={locale}
							value={query}
							onClear={() => {
								setQuery('');
								setMatch(0);
							}}
						/>
					</div>
					<span role="status">
						{matches.length
							? `${index + 1}/${Math.min(5000, matches.length)}${matches.length === 5000 ? '+' : ''}`
							: t(locale, 'No matches')}
					</span>
					<Button
						type="button"
						aria-label={t(locale, 'Previous match')}
						disabled={!matches.length}
						onClick={() => move(-1)}>
						↑
					</Button>
					<Button type="submit" aria-label={t(locale, 'Next match')} disabled={!matches.length}>
						↓
					</Button>
					<PopupClose locale={locale} close={() => setSearching(false)} />
				</form>
			)}
			<div
				className={styles.surface}
				style={
					{
						...(maxHeight === undefined
							? {}
							: { flex: '0 1 auto', height: Math.min(total, maxHeight) }),
						...(bottomInset ? { '--rows-bottom-inset': `${bottomInset}px` } : {}),
					} as CSSProperties
				}>
				<div
					tabIndex={0}
					onWheel={onInteract}
					onPointerDown={onInteract}
					ref={viewport}
					className={styles.viewport}
					data-scrollbar={scrollbar === 'hidden' ? 'hidden' : undefined}
					role={role}
					aria-label={label}
					aria-live="off"
					onScroll={(e) => {
						const n = e.currentTarget;
						if (position) {
							position.top = n.scrollTop;
							position.left = n.scrollLeft;
						}
						follow.current = n.scrollHeight - n.scrollTop - n.clientHeight < 48;
						setFollowing(follow.current);
						setView((v) =>
							v.top === n.scrollTop && v.height === n.clientHeight
								? v
								: { top: n.scrollTop, height: n.clientHeight }
						);
					}}>
					<div
						style={{
							height: (alignBottom ? Math.max(total, visible) : total) + bottomInset,
							minWidth,
							position: 'relative',
						}}>
						<div
							style={{
								position: 'absolute',
								top: offsets[start]! + (alignBottom ? Math.max(0, visible - total) : 0),
								left: 0,
								right: 0,
							}}>
							{rows.slice(start, end).map((row) => (
								<Measured
									key={row.id}
									id={row.id}
									row={row}
									render={render}
									focused={targetId === row.id}
									observe={observe}
								/>
							))}
						</div>
					</div>
				</div>
				{aside?.(nav)}
				{followOutput && !following && (
					<Button
						className={styles.latest}
						style={bottomInset ? { bottom: 12 + bottomInset } : undefined}
						onClick={toEnd}>
						{t(locale, 'To latest')} ↓
					</Button>
				)}
			</div>
		</>
	);
}
