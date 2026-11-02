import type { ReactNode } from 'react';
import { Glyph } from './Glyph';
import s from './Banner.module.css';

/**
 * A banner of the row's size (rule 17: one look, one component): a sign, a line with a dim second line, and an action —
 * `Stop` while the agent works, `Undo` after its proposal, `Try again` after a failure (the commit dialog's split,
 * spec/git#commit-dialog; the Conflicts dialog and its merge view, spec/appearance#evolution-redesign), and the Changes banner of a merge or rebase that
 * stopped (`warning`) or whose conflicts are all resolved (`success`).
 */
export function Banner({
	tone,
	title,
	note,
	action,
	glyph,
	className = '',
	size = 'm',
	...data
}: {
	/** `s` — the 28 px notice of a narrow column: the review modal's hints and failures. */ size?:
		's' | 'm';
	/**
	 * `working` — a spinner; `done` — the spark (✦); `error` — red; `warning` — amber ⚠; `success` — green ✓; `quiet` — a
	 * tint and dim text, why something is not there (the review summary's reasons, spec/appearance#evolution-redesign).
	 */ tone: 'working' | 'done' | 'error' | 'warning' | 'success' | 'quiet';
	/** A sign of its own in place of the tone's, e.g. the agent's key of «Sign in to Claude». */ glyph?: ReactNode;
	title: ReactNode;
	note?: ReactNode;
	action?: ReactNode;
	className?: string | undefined;
} & { [key: `data-${string}`]: string | boolean | undefined }) {
	return (
		<div
			{...data}
			className={`${s.banner} ${className}`}
			role={tone === 'error' ? 'alert' : 'status'}
			data-tone={tone}
			data-size={size}
			data-banner={size}>
			{glyph ?? (
				<Glyph
					name={
						tone === 'working'
							? 'agent-spinner'
							: tone === 'error'
								? 'toast-error'
								: tone === 'warning'
									? 'review-warning'
									: tone === 'success'
										? 'check-pass'
										: 'generate'
					}
					size={size === 's' ? 13 : 14}
				/>
			)}
			<div>
				{title}
				{note && <small>{note}</small>}
			</div>
			{action}
		</div>
	);
}
