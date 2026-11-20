import s from './ProgressBar.module.css';
/**
 * A thin progress line: 4 px, the accent while it runs, green when all is done. Viewed files of
 * a PR in the PR panel and in the review modal (spec/appearance#evolution-redesign). The numbers beside it say the same in words.
 */
export function ProgressBar({
	value,
	total,
	tone,
}: {
	value: number;
	total: number;
	/** spec/composer#task-usage: a budget, not a progress — amber near it, red at it; never the green of «done». */ tone?:
		'amber' | 'red' | 'accent';
}) {
	const share = total > 0 ? Math.min(1, value / total) : 0;
	return (
		<span
			className={s.bar}
			data-done={!tone && total > 0 && value >= total ? true : undefined}
			data-tone={tone}
			aria-hidden="true">
			<i style={{ clipPath: `inset(0 ${100 - Math.round(share * 100)}% 0 0 round 2px)` }} />
		</span>
	);
}
