import { useLayoutEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { formatAccelerator } from '@brigadir/core';
import controls from './Controls.module.css';
import { Segments } from './Controls';
import styles from './MentionMenu.module.css';
import type { MentionTab } from './mention-tabs';
import { tabStripStyles } from './TabStrip';
import { SkeletonRows } from './Loading';
import { useTabStrip } from './use-tab-strip';

export type MentionMenuItem = {
	key: string;
	group: string;
	label: string;
	icon?: ReactNode;
	mono?: boolean;
	tail?: string;
	title?: string;
	/** spec/composer#mentions: a crew agent under its task. */ depth?: number;
	/** spec/composer#mentions: the task's own model in Models. */ checked?: boolean;
};

const MENU_TOP_RESERVE = 56,
	MENU_EDGE = 12,
	MENU_MIN_LIST = 96,
	MENU_LIST_CAP = 280;

/**
 * spec/tasks#sheet-layout: the menu `@` and `/` open while typing — the popup organ of the rail (padding 4, radius 7,
 * 12 px rows, the active row on `--accent`, a 10 px `--fg2` tail). The prompt editor of the New task sheet and
 * the task composer (spec/composer#mention-menu) share it. Focus stays in the text: the pointer only moves the active row and picks.
 * spec/composer#mentions: with two sources or more the menu has segment tabs on top, `All` first; `Tab` / `⇧Tab` switch them.
 */
export function MentionMenu({
	id,
	label,
	items,
	active,
	status,
	loading = false,
	note,
	side,
	className = '',
	style,
	onActive,
	onPick,
	tabs = null,
	tab,
	tabsLabel,
	hint,
	onTab,
}: {
	id: string;
	label: string;
	items: readonly MentionMenuItem[];
	active: number;
	/** A row in place of the items (spec/composer#mention-menu): the menu answers at once instead of staying silent. */
	status?: string | null;
	/** The items still load (spec/appearance#loading): skeleton rows in their place, `status` names them for assistive tech. */
	loading?: boolean;
	/** spec/composer#slash-menu: a grey row above the items that says what kind of list it is (preliminary before the agent starts). */
	note?: string | null;
	side?: 'top';
	className?: string;
	style?: CSSProperties;
	onActive(index: number): void;
	onPick(item: MentionMenuItem): void;
	tabs?: readonly MentionTab[] | null;
	tab?: string;
	tabsLabel?: string;
	/** The word after the `⇥` key in the tab row. */ hint?: string;
	onTab?(tab: string): void;
}) {
	const list = useRef<HTMLDivElement>(null),
		root = useRef<HTMLDivElement>(null),
		// More tabs than the row holds scroll sideways under edge fades; the chosen one slides into view.
		strip = useTabStrip(tab, '[aria-selected=true]', true);
	// spec/composer#mention-menu: the menu never leaves the window. The list's cap is what the window leaves on the side the menu grows to
	// (above the island, or below the caret), less the title bar and a margin; inside the cap the list scrolls under the tabs.
	useLayoutEffect(() => {
		const menu = root.current,
			body = list.current;
		if (!menu || !body) return;
		const fit = () => {
			body.style.maxHeight = '';
			const rect = menu.getBoundingClientRect(),
				chrome = menu.offsetHeight - body.offsetHeight;
			const room =
				side === 'top' ? rect.bottom - MENU_TOP_RESERVE : window.innerHeight - rect.top - MENU_EDGE;
			body.style.maxHeight = `${Math.max(MENU_MIN_LIST, Math.floor(Math.min(room - chrome, MENU_LIST_CAP)))}px`;
		};
		fit();
		window.addEventListener('resize', fit);
		return () => window.removeEventListener('resize', fit);
	}, [items, tabs, note, status, side]);
	// The keys move the active row past the scrolled edge: it follows into view, the page stays put.
	useLayoutEffect(() => {
		list.current
			?.querySelector<HTMLElement>('[aria-selected="true"]')
			?.scrollIntoView({ block: 'nearest' });
	}, [active, items]);
	let lastGroup = '';
	return (
		<div
			ref={root}
			className={`${controls.menu} ${styles.menu} ${className}`}
			data-open="true"
			data-side={side}
			data-mention-tabs={tabs ? tabs.length : undefined}
			style={style}>
			{tabs && (
				<div className={styles.tabsRow}>
					<Segments
						rootRef={strip}
						label={tabsLabel ?? label}
						tablist
						keepFocus
						controls={id}
						size="m"
						className={`${tabStripStyles.tabs} ${tabStripStyles.fade} ${styles.tabs}`}
						options={tabs.map((item) => ({
							value: item.id,
							label: item.label,
							badge: <span className={styles.count}>{item.count}</span>,
						}))}
						value={tab ?? ''}
						onChange={(next) => onTab?.(next)}
					/>
					{hint && (
						<span className={styles.hint} aria-hidden="true">
							<kbd>{formatAccelerator('Tab')}</kbd>
							{hint}
							<span className={styles.esc}>Esc</span>
						</span>
					)}
				</div>
			)}
			<div
				ref={list}
				id={id}
				role="listbox"
				aria-label={label}
				aria-busy={status && !items.length ? true : undefined}
				aria-description={note && items.length ? note : undefined}
				className={styles.list}>
				{note && items.length > 0 && (
					<div className={styles.note} aria-hidden="true">
						{note}
					</div>
				)}
				{loading && !items.length ? (
					<div role="status" aria-label={status ?? undefined}>
						<SkeletonRows count={4} height={26} single />
					</div>
				) : status && !items.length ? (
					<div role="status" className={styles.status}>
						{status}
					</div>
				) : (
					items.map((item, index) => {
						const header = item.group !== lastGroup && item.group !== '';
						lastGroup = item.group;
						return (
							<div key={item.key} className={styles.item}>
								{header && (
									<div className={styles.group} aria-hidden="true">
										{item.group}
									</div>
								)}
								<div
									id={`${id}-${index}`}
									role="option"
									aria-selected={index === active}
									data-active={index === active}
									className={styles.option}
									title={item.title}
									style={item.depth ? { paddingLeft: 8 + item.depth * 18 } : undefined}
									onPointerMove={() => onActive(index)}
									onPointerDown={(event) => {
										event.preventDefault();
										onPick(item);
									}}>
									{item.icon}
									<span className={item.mono ? styles.mono : styles.label}>{item.label}</span>
									{item.tail && <small className={styles.tail}>{item.tail}</small>}
									{item.checked && (
										<span className={styles.check} aria-hidden="true">
											<svg
												aria-hidden="true"
												width="11"
												height="11"
												viewBox="0 0 16 16"
												fill="none">
												<path
													d="m3.5 8.4 2.9 2.9 6.1-6.6"
													stroke="currentColor"
													strokeWidth="1.5"
													strokeLinecap="round"
													strokeLinejoin="round"
												/>
											</svg>
										</span>
									)}
								</div>
							</div>
						);
					})
				)}
			</div>
		</div>
	);
}
