import type { ButtonHTMLAttributes } from 'react';
import { Button } from './Controls';
import { Glyph } from './Glyph';
import { Spinner } from './Loading';
import s from './GenerateButton.module.css';
/** spec/appearance#generate-actions: every button where an agent writes the text carries the spark and the verb “Generate”. */
export function GenerateButton({
	label,
	className = '',
	busy = false,
	...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
	label: string;
	/** spec/appearance#loading: the text is being written — the ring in place of the mark. */ busy?: boolean;
}) {
	return (
		<Button {...props} className={`${s.generate} ${className}`} aria-busy={busy || undefined}>
			{busy ? <Spinner size={12} /> : <Glyph name="generate" size={12} />}
			<span>{label}</span>
		</Button>
	);
}
