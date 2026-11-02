import { useEffect, useState, type ReactNode } from 'react';
import { Glyph } from './Glyph';
import styles from './Loading.module.css';

/** spec/appearance#loading: a wait shorter than this shows nothing; cached data comes in before any skeleton would. */
export const LOADING_DELAY = 150;

const barWidths = [
	[70, 44],
	[56, 58],
	[82, 36],
	[64, 44],
];
const cardWidths = [
	[30, 84, 92, 58, 40],
	[26, 70, 88, 44, 34],
	[34, 78, 96, 66, 36],
];

/** True once `active` has held for `ms` (spec/appearance#loading); false again as soon as it stops. `ms <= 0` is at once. */
export function useDelayed(active: boolean, ms = LOADING_DELAY) {
	const [shown, setShown] = useState(active && ms <= 0);
	useEffect(() => {
		if (!active) {
			setShown(false);
			return;
		}
		if (ms <= 0) {
			setShown(true);
			return;
		}
		const timer = setTimeout(() => setShown(true), ms);
		return () => clearTimeout(timer);
	}, [active, ms]);
	return active && shown;
}

/** Its children only once the wait has lasted `delay` ms since it mounted: a quick answer never flashes a skeleton. */
export function Delayed({
	delay = LOADING_DELAY,
	children,
}: {
	delay?: number;
	children: ReactNode;
}) {
	return useDelayed(true, delay) ? <>{children}</> : null;
}

/** The ring that turns while something loads or runs; it stands still with reduced motion. */
export function Spinner({ size = 12 }: { size?: number }) {
	return (
		<span className={styles.spin} aria-hidden="true">
			<Glyph name="check-run" size={size} />
		</span>
	);
}

/** Text lines that have not come yet: one bar per width, in % of the line. */
export function Skeleton({ widths }: { widths: readonly number[] }) {
	return (
		<div className={styles.skeleton} aria-hidden="true">
			{widths.map((width, index) => (
				<i key={index} style={{ width: `${width}%` }} />
			))}
		</div>
	);
}

/**
 * List rows that have not come yet: a name and the line under it, of varied lengths, `height` px each — the height of
 * the list's real row. They come after `delay` ms (spec/appearance#loading).
 */
export function SkeletonRows({
	count,
	height = 34,
	single = false,
	delay = LOADING_DELAY,
}: {
	count: number;
	height?: number | undefined;
	/** One bar a row, for rows of a single line (sidebar rows, menus). */
	single?: boolean;
	delay?: number;
}) {
	if (!useDelayed(true, delay)) return null;
	return (
		<>
			{Array.from({ length: count }, (_, index) => {
				const widths = barWidths[index % barWidths.length]!;
				return (
					<div key={index} className={styles.row} style={{ height }} aria-hidden="true">
						<Skeleton widths={single ? [widths[0]!] : widths} />
					</div>
				);
			})}
		</>
	);
}

const textWidths = [62, 84, 48, 76, 36, 70, 54, 90, 42, 66];

/**
 * A panel, a diff, a log or an editor that has not come yet (spec/appearance#loading): text lines as bars at the top of its frame,
 * the frame's whole width. It comes after `delay` ms; `label` names it for assistive tech.
 */
export function SkeletonText({
	lines = 6,
	label,
	delay = LOADING_DELAY,
}: {
	lines?: number;
	label?: string | undefined;
	delay?: number;
}) {
	if (!useDelayed(true, delay)) return null;
	return (
		<div
			className={styles.text}
			data-loading
			{...(label
				? { role: 'status', 'aria-label': label, 'aria-busy': true }
				: { 'aria-hidden': true })}>
			<Skeleton
				widths={Array.from({ length: lines }, (_, index) => textWidths[index % textWidths.length]!)}
			/>
		</div>
	);
}

/** A board card that has not come yet: the state line, the title, its preview and the meta line as bars, a card's height. */
export function SkeletonCard({ index = 0 }: { index?: number }) {
	return (
		<div className={styles.card} aria-hidden="true">
			<Skeleton widths={cardWidths[index % cardWidths.length]!} />
		</div>
	);
}

/**
 * A board (Tasks, Pull requests) while it is read (spec/appearance#loading): its columns with their headings and two or three
 * skeleton cards each; in the list view, its sections with skeleton rows. `className` only places it.
 */
export function SkeletonBoard({
	columns,
	view = 'board',
	label,
	className = '',
	delay = LOADING_DELAY,
}: {
	/** The headings of the columns, as the board will show them. */
	columns: readonly string[];
	view?: 'board' | 'list';
	/** The accessible name of the waiting board. */
	label: string;
	className?: string | undefined;
	delay?: number;
}) {
	if (!useDelayed(true, delay)) return null;
	return (
		<div
			className={`${styles.board} ${className}`}
			data-view={view}
			data-loading-board
			role="status"
			aria-label={label}
			aria-busy="true">
			{columns.map((column, index) => (
				<div key={column} className={styles.column} aria-hidden="true">
					<div className={styles.columnHeading}>{column}</div>
					<div className={styles.cards}>
						{view === 'list' ? (
							<SkeletonRows count={3 - (index % 2)} delay={0} />
						) : (
							Array.from({ length: 3 - (index % 2) }, (_, card) => (
								<SkeletonCard key={card} index={index + card} />
							))
						)}
					</div>
				</div>
			))}
		</div>
	);
}

/**
 * A list while it loads over the network (spec/appearance#loading): its rows in place and a small spinning line under them, so the
 * content lands where the eye already is. It comes after `delay` ms.
 */
export function LoadingPlaceholder({
	label,
	rows = 6,
	height,
	delay = LOADING_DELAY,
}: {
	label: string;
	rows?: number;
	/** The height of the list's real row. */
	height?: number;
	delay?: number;
}) {
	if (!useDelayed(true, delay)) return null;
	return (
		<div className={styles.placeholder}>
			<SkeletonRows count={rows} height={height} delay={0} />
			<div className={styles.status} role="status">
				<Spinner />
				{label}
			</div>
		</div>
	);
}

/** The spinning status alone, for a place that has its own frame. It comes after `delay` ms. */
export function LoadingStatus({
	label,
	className = '',
	under = false,
	delay = LOADING_DELAY,
}: {
	label: string;
	className?: string;
	/** Under skeleton blocks, at the start of the line, not in the middle of an empty frame. */
	under?: boolean;
	delay?: number;
}) {
	if (!useDelayed(true, delay)) return null;
	return (
		<div className={`${styles.status} ${className}`} data-under={under || undefined} role="status">
			<Spinner />
			{label}
		</div>
	);
}
