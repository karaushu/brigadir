import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';
import { Glyph } from './Glyph';
import { t, type DiffLine, type Locale, type SyntaxToken } from '@brigadir/core';
import { SyntaxText } from '../syntax';
import styles from './DiffCode.module.css';
export function DiffCode({
	line,
	tokens,
	side,
	locale,
	gutter,
	compact = false,
	wrap = false,
	bare = false,
	...props
}: HTMLAttributes<HTMLDivElement> & {
	line: DiffLine | null;
	tokens: SyntaxToken[];
	side: 'old' | 'new';
	locale: Locale;
	gutter?: ReactNode;
	compact?: boolean;
	/** spec/remote-access-and-mobile#phone-task-tools: the phone's diff — long lines wrap under their own text (a hanging indent), the sign and number in colour. */
	wrap?: boolean;
	/** spec/projects-and-board#screen-layout: lines without a file behind them — no numbers, the sign in its colour. */
	bare?: boolean;
}) {
	const number = side === 'old' ? line?.oldLine : line?.newLine;
	return (
		<div
			{...props}
			className={styles.code}
			data-kind={line?.kind ?? 'gap'}
			data-compact={compact}
			data-wrap={wrap || undefined}
			data-bare={bare || undefined}>
			{bare ? null : (gutter ?? <span className={styles.numbers}>{number}</span>)}
			<span className={styles.sign} aria-hidden="true">
				{line?.kind === 'added' ? '+' : line?.kind === 'removed' ? '−' : ''}
			</span>
			<span className={styles.text} data-code-line={number ?? undefined} data-side={side}>
				<SyntaxText text={line?.text ?? ''} spans={line?.spans} tokens={tokens} />
				{line?.ending === 'none' && (
					<span
						className={styles.ending}
						data-line-ending
						title={t(locale, 'No newline at end of file')}>
						{' '}
						↵∅
					</span>
				)}
			</span>
		</div>
	);
}
/** The folded unchanged lines between hunks — a band across the diff with a chevron; the whole band
 *  is the button and lights on hover (rule 15). */
export function DiffFold({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
	return (
		<button type="button" {...props} className={styles.fold}>
			<Glyph name="chevron-down" size={10} />
			{children}
		</button>
	);
}
