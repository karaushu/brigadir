import { useState, type ReactNode } from 'react';
import { t, type Locale } from '@brigadir/core';
import { Glyph } from './Glyph';
import s from './ReadOnlyDetails.module.css';

/**
 * spec/appearance#one-look-one-component: a collapsed read-only text — a turning chevron, the title and `· read-only`, then the text as written.
 * The rules of a role's rights in the library and the crew editor, a template's instructions in the crew editor.
 */
export function ReadOnlyDetails({
	title,
	text,
	locale,
	className = '',
	open: controlled,
	onToggle,
}: {
	title: ReactNode;
	text: ReactNode;
	locale: Locale;
	/** Placement only (rule 17). */ className?: string | undefined;
	open?: boolean;
	onToggle?(open: boolean): void;
}) {
	const [own, setOwn] = useState(false),
		open = controlled ?? own;
	return (
		<details
			className={`${s.details} ${className}`}
			open={open}
			data-read-only-details
			onToggle={(event) => {
				const next = event.currentTarget.open;
				if (next === open) return;
				setOwn(next);
				onToggle?.(next);
			}}>
			<summary>
				<Glyph name="tree-right" size={9} />
				<span>{title}</span>
				<small>· {t(locale, 'read only')}</small>
			</summary>
			<p>{text}</p>
		</details>
	);
}
