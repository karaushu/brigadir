import type { ReactNode } from 'react';
import styles from './DotPill.module.css';
/** The project-icon palette colours a dot pill takes (spec/appearance#evolution-redesign). */
export type DotPillColor = 'green' | 'blue' | 'yellow';
/** spec/reviews#class-row: a label with a coloured dot — the task's class in the chat row. Not a state: the palette is the project icons'. */
export function DotPill({ color, children }: { color: DotPillColor; children: ReactNode }) {
	return (
		<span className={styles.pill} data-color={color} data-dot-pill={color}>
			<span className={styles.text}>{children}</span>
		</span>
	);
}
