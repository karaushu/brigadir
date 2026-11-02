import { forwardRef, type ReactNode } from 'react';
import { IconButton } from './Controls';
import s from './Rail.module.css';

/**
 * spec/sidebar#section-rail: the sections rail left of the sidebar — a 48 px column under the window's
 * top strip, its sections at the top and its tools at the foot. Every tile is an XL 40 icon button (rule 16: the column is
 * one size); hover and selection fill the whole tile (rule 15). The strip above it is a drag region (☰ on Windows and
 * Linux), with the same hairline under it as the sidebar's strip.
 */
export function Rail({
	label,
	strip,
	sections,
	tools,
}: {
	label: string;
	/** The strip's content: ☰ on Windows and Linux, nothing under the macOS traffic lights. */ strip?: ReactNode;
	sections: ReactNode;
	tools: ReactNode;
}) {
	return (
		<nav className={s.rail} aria-label={label} data-size="xl" data-rail>
			<div className={s.strip} data-rail-strip>
				{strip}
			</div>
			<div className={s.group}>{sections}</div>
			<span className={s.fill} />
			<div className={s.group}>{tools}</div>
		</nav>
	);
}

/**
 * A section of the rail: its glyph, the name and shortcut in the hint, `--sel` with an accent glyph while it is open, and a
 * 14 px count on the glyph's corner — amber when someone waits, accent when something waits for you; past 9 it reads 9+.
 */
export const RailSection = forwardRef<
	HTMLButtonElement,
	{
		section: string;
		label: string;
		hint: string;
		selected: boolean;
		count?: number;
		tone?: 'amber' | 'accent';
		/** A state dot in place of a count (a CSS colour); `null` keeps the slot so it fades out. */ dot?:
			string | null;
		children: ReactNode;
		onClick(): void;
	}
>(function RailSection(
	{ section, label, hint, selected, count = 0, tone = 'accent', dot, children, onClick },
	ref
) {
	return (
		<IconButton
			ref={ref}
			label={count ? `${label} · ${count}` : label}
			hint={hint}
			aria-pressed={selected}
			data-rail-section={section}
			className={s.section}
			{...(dot !== undefined ? { dot } : {})}
			onClick={onClick}>
			{children}
			{count > 0 && (
				<span className={s.count} data-tone={tone} aria-hidden="true">
					{count > 9 ? '9+' : count}
				</span>
			)}
		</IconButton>
	);
});
