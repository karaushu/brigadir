import type { ReactNode } from 'react';
import { Glyph, type GlyphName } from './Glyph';
import s from './EmptyState.module.css';

/**
 * spec/appearance#one-look-one-component, spec/appearance#no-newbie-explanations: a screen with nothing to show — the section's glyph on a
 * tinted tile, a title and the action that fills it (`children`), no explaining line. The Todo screen's `No lists yet` · `New list`.
 */
export function EmptyState({
	glyph,
	title,
	children,
}: {
	glyph: GlyphName;
	title: string;
	children?: ReactNode;
}) {
	return (
		<div className={s.empty} data-empty-state>
			<span className={s.mark}>
				<Glyph name={glyph} size={22} />
			</span>
			<h2>{title}</h2>
			{children && (
				<div className={s.actions} data-size="m">
					{children}
				</div>
			)}
		</div>
	);
}
