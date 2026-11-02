import type { ButtonHTMLAttributes, Ref } from 'react';
import s from './HeaderChip.module.css';

/**
 * The chip of the task header's second line: 11 px text with a 20 px pill drawn inside a
 * 24 px target, `fg2` that turns `fg` on a `tint` hover over the whole chip. The repo chip (spec/appearance#evolution-redesign), the task's
 * relation (spec/appearance#evolution-redesign) and their counters «+N» (`count`: tight, never shrinking) are this one control. `filled` — a
 * counter that rests on `tint` (the repos' «+N ▾»); `pinned` — the menu it opened stays (the relations' «+N»).
 */
export function HeaderChip({
	count = false,
	filled = false,
	pinned = false,
	className = '',
	...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
	ref?: Ref<HTMLButtonElement>;
	count?: boolean;
	filled?: boolean;
	pinned?: boolean;
}) {
	return (
		<button
			type="button"
			{...props}
			className={`${s.chip} ${className}`}
			data-count={count || undefined}
			data-filled={filled || undefined}
			data-pinned={pinned || undefined}
		/>
	);
}
