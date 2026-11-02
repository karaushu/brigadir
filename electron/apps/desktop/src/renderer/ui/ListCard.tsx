import type { HTMLAttributes, MouseEvent, ReactNode } from 'react';
import s from './ListCard.module.css';
/** spec/settings-modules-and-onboarding#intro-remote, rule 17: one card of rows for the intro and Settings ▸ Modules / ▸ Remote. */
export function ListCard({
	children,
	...rest
}: { children: ReactNode } & HTMLAttributes<HTMLDivElement>) {
	return (
		<div className={s.list} {...rest}>
			{children}
		</div>
	);
}
/**
 * A row of a ListCard: `lead` marks (status, glyph), the name with an optional second line, then `control`.
 * `tall` is the 56 px row of a list with second lines; `onActivate` lets the whole row toggle (rule 15) while the
 * switch in `control` stays the keyboard control; `below` sits under the row inside its border (an install hint, a form).
 */
export function ListRow({
	lead,
	title,
	detail,
	control,
	below,
	off,
	dim,
	tall,
	compact,
	wrap,
	onActivate,
	onHover,
	line,
}: {
	lead?: ReactNode | undefined;
	title: ReactNode;
	detail?: ReactNode | undefined;
	control?: ReactNode | undefined;
	below?: ReactNode | undefined;
	/** The whole row at half strength (a provider turned off). */ off?: boolean | undefined;
	/** Only the lead and the name dimmed (a module turned off): the switch keeps full strength. */ dim?:
		boolean | undefined;
	tall?: boolean | undefined;
	compact?: boolean | undefined;
	/** The second line wraps instead of ending in «…». */ wrap?: boolean | undefined;
	onActivate?: (() => void) | undefined;
	onHover?: ((inside: boolean) => void) | undefined;
	/** Data attributes of the row line, for tests and styles. */ line?: Record<
		`data-${string}`,
		string | boolean | undefined
	>;
}) {
	const activate = onActivate
		? (event: MouseEvent) => {
				// The control handles its own click; a click anywhere else on the row does the same.
				if ((event.target as HTMLElement).closest('button, a, input, [role=switch]')) return;
				onActivate();
			}
		: undefined;
	return (
		<div className={s.row} data-off={off ?? undefined}>
			<div
				className={s.line}
				data-tall={tall || undefined}
				data-compact={compact || undefined}
				data-dim={dim || undefined}
				data-interactive={onActivate ? true : undefined}
				onClick={activate}
				onMouseEnter={onHover && (() => onHover(true))}
				onMouseLeave={onHover && (() => onHover(false))}
				{...line}>
				{lead}
				<span className={s.name} data-wrap={wrap || undefined}>
					<span className={s.title}>{title}</span>
					{detail && <small>{detail}</small>}
				</span>
				{control}
			</div>
			{below}
		</div>
	);
}
/** A glyph or mark at the start of a row, in --fg2. */
export function ListLead({ children }: { children: ReactNode }) {
	return <span className={s.lead}>{children}</span>;
}
