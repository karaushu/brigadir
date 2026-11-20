import type { ReactNode } from 'react';
import { t, type Locale } from '@brigadir/core';
import { Glyph, type GlyphName } from './ui/Glyph';
import styles from './App.module.css';

/**
 * spec/sidebar#section-rail (rule 17): a group of a section's list in the project group's look — the chevron, the glyph, the name and the
 * count; the whole header folds it (rule 15). The Brigadir and Slack sections' lists.
 */
export function SidebarGroup({
	locale,
	name,
	glyph,
	count,
	shut,
	onFold,
	children,
	...data
}: {
	locale: Locale;
	name: string;
	glyph: GlyphName;
	count: number;
	shut: boolean;
	onFold(): void;
	children: ReactNode;
} & { [key: `data-${string}`]: string | undefined }) {
	return (
		<section className={styles.project} data-open={!shut} {...data}>
			<div className={styles.projectHeader}>
				<button
					className={styles.projectCollapse}
					aria-label={`${t(locale, shut ? 'Expand project' : 'Collapse project')} · ${name}`}
					aria-expanded={!shut}
					onClick={onFold}>
					<Glyph name="sidebar-chevron" size={10} />
				</button>
				<span className={styles.projectIconButton} aria-hidden="true">
					<Glyph name={glyph} size={14} />
				</span>
				<h3>
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
