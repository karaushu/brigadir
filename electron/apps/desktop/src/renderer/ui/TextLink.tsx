import type { ButtonHTMLAttributes, ReactNode } from 'react';
import s from './TextLink.module.css';
/**
 * spec/reviews#strip, spec/smoke-run#chat: a count or a word in running text that opens something — a dotted underline in the text's colour at
 * rest, solid on hover (rule 17: the findings count, a smoke report's steps, `Show` of Ready to look).
 */
export function TextLink({
	children,
	...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }) {
	return (
		<button type="button" {...rest} className={s.link}>
			{children}
		</button>
	);
}
