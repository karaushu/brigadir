import type { HTMLAttributes, ReactNode } from 'react';
import { Glyph, type GlyphName } from './Glyph';
import s from './ChatCard.module.css';
/**
 * spec/appearance#one-look-one-component: a card in the log — a head with a glyph, a title and a muted hint, a body and a foot with a note and
 * actions. `waiting` adds the amber dot of a card that waits for the person (rule 17).
 */
export function ChatCard({
	glyph,
	title,
	hint,
	waiting = false,
	note,
	actions,
	children,
	...rest
}: {
	glyph: GlyphName;
	title: ReactNode;
	hint?: ReactNode;
	waiting?: boolean;
	note?: ReactNode;
	actions?: ReactNode;
	children: ReactNode;
} & Omit<HTMLAttributes<HTMLElement>, 'title'> & {
		[key: `data-${string}`]: string | boolean | undefined;
	}) {
	return (
		<section {...rest} className={s.card}>
			<header className={s.head}>
				{waiting && <span className={s.wait} aria-hidden="true" />}
				<Glyph name={glyph} size={14} />
				<strong>{title}</strong>
				{hint && <small className={s.hint}>{hint}</small>}
			</header>
			<div className={s.body}>{children}</div>
			{(note || actions) && (
				<footer className={s.foot}>
					<small className={s.note}>{note}</small>
					{actions}
				</footer>
			)}
		</section>
	);
}
/** A chip of the card's body: a glyph and a value on the tint, 24 px. */
export function ChatCardChips({ children }: { children: ReactNode }) {
	return <div className={s.chips}>{children}</div>;
}
export function ChatCardChip({
	children,
	...rest
}: { children: ReactNode } & HTMLAttributes<HTMLSpanElement> & {
		[key: `data-${string}`]: string | boolean | undefined;
	}) {
	return (
		<span {...rest} className={s.chip}>
			{children}
		</span>
	);
}
