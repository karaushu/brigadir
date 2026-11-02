import { Children, Fragment, type ButtonHTMLAttributes, type ReactNode, type Ref } from 'react';
import s from './SegmentGroup.module.css';

/**
 * spec/task-window#repo-line: a framed group of parts — the toolbar's command `start ▾ │ ▶`. A 1 px frame inside, the row's height
 * (rule 16), parts 2 px less; the outer parts keep the outer radius and meet with a straight edge. A 1 px rule between
 * parts hides next to a hovered, pressed or open part, so the hover never sits under a line.
 */
export function SegmentGroup({
	children,
	className = '',
	...data
}: { children: ReactNode; className?: string | undefined } & {
	[key: `data-${string}`]: string | boolean | undefined;
}) {
	const parts = Children.toArray(children).filter(Boolean);
	return (
		<div {...data} className={`${s.group} ${className}`}>
			{parts.map((part, index) => (
				<Fragment key={index}>
					{index > 0 && <span className={s.rule} aria-hidden="true" />}
					{part}
				</Fragment>
			))}
		</div>
	);
}
/** One part of a `SegmentGroup`: a square for a glyph, `wide` for a name. */
export function SegmentPart({
	wide = false,
	className = '',
	ref,
	...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { wide?: boolean; ref?: Ref<HTMLButtonElement> }) {
	return (
		<button
			type="button"
			{...props}
			ref={ref}
			className={`${s.part} ${className}`}
			data-wide={wide || undefined}
		/>
	);
}
