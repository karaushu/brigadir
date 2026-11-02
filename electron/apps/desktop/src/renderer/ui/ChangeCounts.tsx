import { changeCountsTitle, type Locale } from '@brigadir/core';
import { ChangeCount } from './ChangeCount';
import styles from './ChangeCounts.module.css';

/**
 * spec/diff-and-review#change-counters, spec/appearance#component-details (rule 17): the `+N −M` pair of a file, a turn, a task or a repo — a green and a red half and the
 * pair's tooltip (`changeCountsTitle`) on the whole. The caller's class only places the pair and sets the line's type;
 * `split` gives the pair no box of its own, so the halves are the parent's items and take its gap (a row of a file list).
 */
export function ChangeCounts({
	additions,
	deletions,
	locale,
	tone = 'state',
	split = false,
	nonzero = false,
	className = '',
	...data
}: {
	additions: number;
	deletions: number;
	locale: Locale;
	/** `diff` — the diff's own green and red (a chat file chip, a turn's footer); `inherit` — the text colour of the row
	 *  (a selected row on the accent fill). */ tone?: 'state' | 'diff' | 'inherit';
	/** The halves are the parent's own items (`display: contents`). */ split?: boolean;
	/** Only the halves that are not zero (a commit's file in History, a branch's file). */ nonzero?: boolean;
	className?: string | undefined;
} & { [key: `data-${string}`]: string | boolean | undefined }) {
	const plus = !nonzero || additions > 0,
		minus = !nonzero || deletions > 0;
	return (
		<span
			{...data}
			className={`${styles.counts} ${className}`}
			data-tone={tone}
			data-split={split || undefined}
			title={changeCountsTitle(locale, additions, deletions)}>
			{plus && (
				<span className={styles.add} data-change="add">
					<ChangeCount sign="+" value={additions} locale={locale} />
				</span>
			)}
			{/* A split pair takes the row's gap; a pair of its own reads `+N −M`. */}
			{plus && minus && !split && ' '}
			{minus && (
				<span className={styles.remove} data-change="remove">
					<ChangeCount sign="−" value={deletions} locale={locale} />
				</span>
			)}
		</span>
	);
}
