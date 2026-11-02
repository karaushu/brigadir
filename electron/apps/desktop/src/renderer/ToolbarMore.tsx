import { Fragment, useRef, useState, type ComponentProps } from 'react';
import { t, type Locale } from '@brigadir/core';
import { Glyph } from './ui/Glyph';
import { IconButton } from './ui/Controls';
import { MenuItem, MenuPopover, MenuSection, MenuSeparator } from './ui/Popover';
type GlyphName = ComponentProps<typeof Glyph>['name'];
/** One row of the «…» menu: a toolbar button that did not fit, with the same glyph and shortcut (spec/task-window#narrow-toolbar). */
export type MoreEntry = {
	key: string;
	label: string;
	icon: GlyphName;
	kbd?: string | undefined;
	tail?: string;
	checked?: boolean;
	kind: 'action' | 'check' | 'radio';
	/** A section label above the row, the first of its group: `Panel`, `View`. */
	section?: string | undefined;
	separator?: boolean;
	/** The row opens its own surface (search, the agents popup): focus goes there, not back to «…». */
	hands?: boolean;
	run(anchor: HTMLElement): void;
};
/** spec/task-window#narrow-toolbar: «…» stands before the right-side toggle while any toolbar button is out. */
/** `attention`: Agents are out and an agent needs the person — «…» carries their amber sign (spec/task-window#narrow-toolbar). */
export function ToolbarMore({
	locale,
	count,
	entries,
	attention = false,
	width,
}: {
	locale: Locale;
	count?: number | undefined;
	entries: MoreEntry[];
	attention?: boolean;
	width?: number | undefined;
}) {
	const [open, setOpen] = useState(false),
		button = useRef<HTMLButtonElement>(null);
	const label = `${t(locale, 'More')}${count === undefined ? '' : ` · ${count}`}${attention ? ` · ${t(locale, 'Needs you')}` : ''}`;
	return (
		<>
			<IconButton
				ref={button}
				data-toolbar-more
				data-attention={attention || undefined}
				appearance={attention ? 'warning' : 'neutral'}
				variant={attention ? 'soft' : 'ghost'}
				label={label}
				aria-haspopup="menu"
				aria-expanded={open}
				onClick={() => setOpen((value) => !value)}>
				<Glyph name="more" size={16} />
			</IconButton>
			<MenuPopover
				open={open}
				onClose={() => setOpen(false)}
				anchor={button}
				align="end"
				width={width ?? 250}
				label={t(locale, 'More')}
				locale={locale}>
				{entries.map((entry) => (
					<Fragment key={entry.key}>
						{entry.separator && <MenuSeparator />}
						{entry.section && <MenuSection>{entry.section}</MenuSection>}
						<MenuItem
							kind={entry.kind}
							checked={!!entry.checked}
							icon={<Glyph name={entry.icon} size={14} />}
							tail={entry.tail}
							kbd={entry.kbd}
							hands={!!entry.hands}
							onSelect={() => entry.run(button.current!)}>
							{entry.label}
						</MenuItem>
					</Fragment>
				))}
			</MenuPopover>
		</>
	);
}
