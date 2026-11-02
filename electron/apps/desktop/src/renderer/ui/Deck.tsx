import type { HTMLAttributes, ReactNode, Ref } from 'react';
import s from './Deck.module.css';
/**
 * spec/composer#queue-deck / spec/chat-turns-plans-and-questions#background-commands: the deck over the composer island — one look for the queue of messages (spec/composer-steering-queue-and-ghost#steering-hold) and the background
 * commands (spec/chat-turns-plans-and-questions#background-commands), rule 17. A deck holds lists; a list is a region with its own name, its rows carry the list's label
 * (queued · N, in background · N) in the first row's own column and their actions on the right.
 */
export function Deck({
	children,
	className = '',
	ref,
	...rest
}: HTMLAttributes<HTMLDivElement> & { children: ReactNode; ref?: Ref<HTMLDivElement> }) {
	return (
		<div {...rest} ref={ref} className={`${s.deck} ${className}`.trim()}>
			{children}
		</div>
	);
}
export function DeckList({
	label,
	header,
	children,
	...rest
}: { label: string; header?: ReactNode; children: ReactNode } & {
	[key: `data-${string}`]: string | boolean | undefined;
}) {
	return (
		<section {...rest} className={s.list} aria-label={label}>
			{header}
			<ol>{children}</ol>
		</section>
	);
}
/** `hover`: the whole row reacts as one target (rule 15); then the row's main control is a button that stretches over it. */
export function DeckRow({
	label,
	children,
	actions,
	hover = false,
	...rest
}: { label: ReactNode; children: ReactNode; actions?: ReactNode; hover?: boolean } & {
	[key: `data-${string}`]: string | boolean | undefined;
}) {
	return (
		<li {...rest} data-hover={hover || undefined}>
			<span className={s.label} aria-hidden="true">
				{label}
			</span>
			<div>{children}</div>
			<span className={s.actions}>{actions}</span>
		</li>
	);
}
