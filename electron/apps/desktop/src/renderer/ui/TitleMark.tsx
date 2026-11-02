import { Glyph, type GlyphName } from './Glyph';
import styles from './TitleMark.module.css';
/**
 * A glyph mark in the title line of a sidebar card (rule 17: one look, one component): the archive clock (spec/tasks#archive)
 * and the agent's live browser page off screen (spec/browser-and-simulator#background). Not a control: no hover, no focus; the title names it.
 */
export function TitleMark({
	icon,
	title,
	tone = 'quiet',
	className = '',
	...data
}: {
	icon: GlyphName;
	title: string;
	tone?: 'quiet' | 'accent';
	className?: string | undefined;
} & { [key: `data-${string}`]: string | boolean | undefined }) {
	return (
		<span {...data} className={`${styles.mark} ${className}`} data-tone={tone} title={title}>
			<Glyph name={icon} size={11} />
		</span>
	);
}
