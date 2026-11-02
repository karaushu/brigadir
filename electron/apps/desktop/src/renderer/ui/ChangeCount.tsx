import {
	formatChangeCount,
	formatChangeCountFull,
	isCompactChangeCount,
	type Locale,
} from '@brigadir/core';
import { ChangeSign } from './ChangeSign';
import styles from './ChangeSign.module.css';
/** spec/diff-and-review#change-counters: one side of a `+N −M` counter. From 1000 the count is shown short (`5k`, `1.5k`); the exact count stays the text of the element, so copy and the accessible name read `+5 036`. The pair with its tooltip is `ui/ChangeCounts`. */
export function ChangeCount({
	sign,
	value,
	locale,
}: {
	sign: '+' | '−';
	value: number;
	locale: Locale;
}) {
	return (
		<>
			<ChangeSign sign={sign} />
			{isCompactChangeCount(value) ? (
				<span className={styles.compact} data-compact={formatChangeCount(value)}>
					<span className={styles.text}>{formatChangeCountFull(locale, value)}</span>
				</span>
			) : (
				formatChangeCount(value)
			)}
		</>
	);
}
