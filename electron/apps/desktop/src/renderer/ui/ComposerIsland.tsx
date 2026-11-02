import type { ComponentProps, ReactNode } from 'react';
import { Glyph } from './Glyph';
import styles from './ComposerIsland.module.css';

/**
 * spec/composer#island, spec/composer#glass-overlay, spec/composer#agent-capsule: the composer island — glass card, the text, the agent row and the environment footer. The task
 * chat fills it with the live editor and controls; the intro's sample window shows the same island at rest (spec/settings-modules-and-onboarding#intro-steps,
 * rule 17). The caller places it (`className`: margins, width); the look is here.
 */
export function ComposerIsland({ className, ...form }: ComponentProps<'form'>) {
	return <form className={className ? `${styles.island} ${className}` : styles.island} {...form} />;
}
/**
 * The text area of the island. The chat mounts its editor into it; a shown island passes `placeholder` and gets the empty
 * field's line in the editor's font, padding and colour.
 */
export function ComposerText({
	className,
	placeholder,
	children,
	...div
}: ComponentProps<'div'> & { placeholder?: string | undefined }) {
	return (
		<div className={className ? `${styles.text} ${className}` : styles.text} {...div}>
			{placeholder !== undefined && <p className={styles.still}>{placeholder}</p>}
			{children}
		</div>
	);
}
/** spec/composer#agent-capsule: the agent row, all M 28 — `attach` on the left, then the context, the capsule and Send together on the right. */
export function ComposerBar({ attach, children }: { attach: ReactNode; children: ReactNode }) {
	return (
		<div className={styles.bar} data-composer-bar>
			{attach}
			<span className={styles.space} />
			<span className={styles.controls}>{children}</span>
		</div>
	);
}
/** spec/composer#paste: the drop overlay over the island; first in the island, so the environment footer stays its last row. */
export function ComposerDropZone({ title, note }: { title: string; note: string }) {
	return (
		<div className={styles.dropZone} aria-hidden="true">
			<div>
				<span>
					<Glyph name="drop" size={14} />
					{title}
				</span>
				<small>{note}</small>
			</div>
		</div>
	);
}
