import type { KeyboardEvent, MouseEvent } from 'react';
import { Glyph } from './Glyph';
import s from './SpotBadges.module.css';

/**
 * spec/appearance#evolution-redesign: the review summary on a file — ⚠ amber, a risky spot in it; ✓
 * accent, something to check there. The tooltip is the text of the items; a click lands the diff on the first one's line.
 * One look on the review's file list and on the diff's file row (rule 17). Inside the file row's button the badges are
 * plain marks (`focusable` off): the row is the keyboard's way to the file. The diff row's badges are buttons.
 */
export function SpotBadges({
	risks,
	checks,
	riskLabel,
	checkLabel,
	go,
	focusable = false,
}: {
	/** Tooltip lines of the risky spots, `index.tsx:110 — Web shows a bare alert().` */ risks: string[];
	checks: string[];
	riskLabel: string;
	checkLabel: string;
	go(kind: 'risk' | 'check'): void;
	focusable?: boolean;
}) {
	const badge = (kind: 'risk' | 'check', lines: string[]) => {
		if (!lines.length) return null;
		const title = lines.join('\n'),
			run = (event: MouseEvent | KeyboardEvent) => {
				event.stopPropagation();
				event.preventDefault();
				go(kind);
			};
		return (
			<span
				className={s.badge}
				data-kind={kind}
				data-spot-badge={kind}
				title={title}
				aria-label={`${kind === 'risk' ? riskLabel : checkLabel} · ${title}`}
				{...(focusable
					? {
							role: 'button',
							tabIndex: 0,
							onKeyDown: (event: KeyboardEvent) => {
								if (event.key === 'Enter' || event.key === ' ') run(event);
							},
						}
					: {})}
				onClick={run}>
				<Glyph name={kind === 'risk' ? 'review-warning' : 'tick'} size={11} />
			</span>
		);
	};
	return (
		<>
			{badge('risk', risks)}
			{badge('check', checks)}
		</>
	);
}
