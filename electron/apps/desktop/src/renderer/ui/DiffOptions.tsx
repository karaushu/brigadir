import { Popover } from './Popover';
import { useId, useRef, useState } from 'react';
import { formatDateTime, t, type Locale, type TimelineEntry } from '@brigadir/core';
import { Glyph } from './Glyph';
import { Button, IconButton, Popup } from './Controls';
import styles from './DiffOptions.module.css';
type Range = { base: number; current: number } | null;
/**
 * spec/editor#line-wrap: only snapshot choice lives here; Wrap lines moved to the diff header. The funnel in the Changes header opens it,
 * and so does the snapshot picker at the foot of the Diff tab (`snapshot`, spec/git#commit-dialog): «Current snapshot · 14 ▾».
 */
export function DiffOptions({
	locale,
	range,
	timeline,
	onRange,
	snapshot,
}: {
	locale: Locale;
	range: Range;
	timeline: TimelineEntry[];
	onRange(value: Range): void;
	/** The picker's text in place of the funnel; it shrinks with `…`, the whole text stays in the tooltip. */ snapshot?: string;
}) {
	const [open, setOpen] = useState(false),
		button = useRef<HTMLButtonElement>(null),
		id = useId();
	const first = timeline[0]?.id ?? 0,
		last = timeline.at(-1)?.id ?? first;
	function checkpoint(kind: 'base' | 'current') {
		const value = kind === 'base' ? (range?.base ?? first) : (range?.current ?? last);
		const label = t(locale, kind === 'base' ? 'Base' : 'End');
		return (
			<div className={styles.checkpoint} data-endpoint={kind}>
				<span className={styles.label}>{label}</span>
				<Popup
					size="xl"
					label={label}
					value={String(value)}
					options={timeline.map((step) => ({
						value: String(step.id),
						label: formatDateTime(step.at, { seconds: true }),
						icon: <span className={styles.badge}>#{step.id}</span>,
					}))}
					onChange={(selected) => {
						const checkpoint = Number(selected);
						onRange(
							kind === 'base'
								? { base: checkpoint, current: Math.max(checkpoint, range?.current ?? last) }
								: { base: Math.min(range?.base ?? first, checkpoint), current: checkpoint }
						);
					}}
				/>
			</div>
		);
	}
	return (
		<div className={snapshot === undefined ? styles.options : styles.pickerRoot}>
			{snapshot === undefined ? (
				<IconButton
					ref={button}
					label={t(locale, 'Diff options')}
					aria-expanded={open}
					aria-controls={id}
					aria-pressed={open || Boolean(range)}
					onClick={() => setOpen(!open)}>
					<Glyph name="filter" size={14} />
				</IconButton>
			) : (
				<Button
					ref={button}
					variant="ghost"
					className={styles.picker}
					aria-label={t(locale, 'Compare snapshots')}
					aria-haspopup="dialog"
					aria-expanded={open}
					aria-controls={id}
					title={snapshot}
					onClick={() => setOpen(!open)}>
					<span>{snapshot}</span>
					<Glyph name="chevron-down" size={8} />
				</Button>
			)}
			<Popover
				id={id}
				open={open}
				onClose={() => setOpen(false)}
				anchor={button}
				align={snapshot === undefined ? 'end' : 'start'}
				width={304}
				overflow="visible"
				label={t(locale, 'Diff options')}
				locale={locale}
				title={
					<>
						<Glyph name="history" size={14} />
						{t(locale, 'Compare snapshots')}
					</>
				}>
				<div className={styles.timeline} aria-label={t(locale, 'Checkpoints')}>
					{timeline.length ? (
						<>
							<Button
								size="xl"
								className={styles.all}
								aria-label={t(locale, 'All changes')}
								aria-pressed={!range}
								onClick={() => onRange(null)}>
								<span className={styles.allIcon}>
									<Glyph name="diff" size={16} />
								</span>
								<span>
									<strong>{t(locale, 'All changes')}</strong>
									<small>{t(locale, 'From first to latest snapshot')}</small>
								</span>
							</Button>
							<div className={styles.range}>
								{checkpoint('base')}
								{checkpoint('current')}
							</div>
						</>
					) : (
						<p className={styles.empty}>{t(locale, 'No snapshots yet')}</p>
					)}
				</div>
			</Popover>
		</div>
	);
}
