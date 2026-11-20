import type { CSSProperties, ReactNode } from 'react';
import { t, type Locale } from '@brigadir/core';
import { Glyph, type GlyphName } from './ui/Glyph';
import styles from './App.module.css';

/**
 * spec/sidebar#section-rail (rule 17): a group of a section's list in the project group's look — the chevron, the glyph, the name and the
 * count; the whole header folds it (rule 15). The Brigadir, Todo and Slack sections' lists; a project's group takes its icon and tone.
 */
export function SidebarGroup({
	locale,
	name,
	glyph,
	icon,
	tone,
	title,
	count,
	shut,
	onFold,
	children,
	...data
}: {
	locale: Locale;
	name: string;
	glyph?: GlyphName;
	/** In place of the glyph: a project's icon. */ icon?: ReactNode;
	/** A project's tone on the header (`projectToneStyle`). */ tone?: CSSProperties | undefined;
	/** The name's tooltip: a project's folder. */ title?: string | undefined;
	count: number;
	shut: boolean;
	onFold(): void;
	children: ReactNode;
} & { [key: `data-${string}`]: string | undefined }) {
	return (
		<section className={styles.project} data-open={!shut} {...data}>
			<div className={styles.projectHeader} style={tone}>
				<button
					className={styles.projectCollapse}
					aria-label={`${t(locale, shut ? 'Expand project' : 'Collapse project')} · ${name}`}
					title={t(locale, shut ? 'Expand project' : 'Collapse project')}
					aria-expanded={!shut}
					onClick={onFold}>
					<Glyph name="sidebar-chevron" size={10} />
				</button>
				<span className={styles.projectIconButton} aria-hidden="true">
					{icon ?? (glyph && <Glyph name={glyph} size={14} />)}
				</span>
				<h3 title={title}>
					<button className={styles.projectSelect} aria-expanded={!shut} onClick={onFold}>
						{name}
					</button>
				</h3>
				<span className={styles.sectionGroupCount}>{count}</span>
			</div>
			<div className={styles.projectDisclosure} data-open={!shut} inert={shut} aria-hidden={shut}>
				<div>{children}</div>
			</div>
		</section>
	);
}
