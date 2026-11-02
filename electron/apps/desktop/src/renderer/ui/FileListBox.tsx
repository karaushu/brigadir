import type { HTMLAttributes, Ref } from 'react';
import s from './FileListBox.module.css';

/**
 * Rule 17: the inset box of file rows inside a dialog — the commit dialog's changed files (spec/git#commit-dialog) and the Conflicts
 * dialog's files (spec/appearance#evolution-redesign): `--win` with a 1 px `--sep` edge, 4 px padding, rows 1 px apart. Rows are the caller's.
 */
export function FileListBox({
	ref,
	className = '',
	...props
}: HTMLAttributes<HTMLDivElement> & { ref?: Ref<HTMLDivElement> }) {
	return <div ref={ref} {...props} className={`${s.box} ${className}`} />;
}
