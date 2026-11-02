import s from './ProgressBar.module.css';
/**
 * A thin progress line: 4 px, the accent while it runs, green when all is done. Viewed files of
 * a PR in the PR panel and in the review modal (spec/appearance#evolution-redesign). The numbers beside it say the same in words.
 */
export function ProgressBar({ value, total }: { value: number; total: number }) {
	const share = total > 0 ? Math.min(1, value / total) : 0;
	return (
		<span
			className={s.bar}
			data-done={total > 0 && value >= total ? true : undefined}
			aria-hidden="true">
			<i style={{ width: `${Math.round(share * 100)}%` }} />
		</span>
	);
}
