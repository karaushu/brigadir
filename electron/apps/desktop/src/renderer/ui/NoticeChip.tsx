import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { t, type Locale } from '@brigadir/core';
import { Button } from './Controls';
import { Glyph, type GlyphName } from './Glyph';
import { Popover } from './Popover';
import styles from './NoticeChip.module.css';

/** Facts this window already opened by itself. A fact is a caller's key for «what is new» (for contention: task + repo +
 *  owner set); it lives until the app restarts, so a restart reminds once more. */
const shown = new Set<string>();
/** Test seam: forget what was shown. */
export const resetShownNotices = () => shown.clear();

export type NoticePlacement = 'composer' | 'repo' | 'shelf';
type Opened = 'click' | 'auto' | null;

/** spec/notifications-slack-notes-and-schedules#repo-contention: an ongoing state (class S) as a chip instead of a banner. The chip stands in the composer's environment
 *  footer (`composer`), in the CLI shelf of a CLI task (`shelf`, spec/notifications-slack-notes-and-schedules#notice-chips) or in a repo heading of the Changes panel
 *  (`repo`). In the composer, a fact key not shown yet
 *  opens the popover by itself once, without taking focus; a click opens it any time. Esc and a click outside close
 *  it (rule 14, shared PopupClose); a popover opened by a click gives focus back to the chip. The popover is portalled
 *  with fixed position: the Changes rows clip their content, the composer island is a containing block. */
export function NoticeChip({
	locale,
	label,
	accessibleLabel,
	icon,
	placement,
	facts = [],
	title,
	autoNote,
	clickNote,
	children,
	...data
}: {
	locale: Locale;
	label: string;
	accessibleLabel: string;
	icon: GlyphName;
	placement: NoticePlacement;
	/** Keys of the facts behind the chip; only a composer chip opens by itself, once per new key. */ facts?: readonly string[];
	title: string;
	/** Footer line when the popover opened by itself (with `Got it`). */ autoNote?: string;
	/** Footer line when opened by a click. */ clickNote?: string;
	children(close: (focus: boolean) => void): ReactNode;
} & { [key: `data-${string}`]: string | undefined }) {
	const [opened, setOpened] = useState<Opened>(null),
		button = useRef<HTMLButtonElement>(null),
		anchor = useRef<HTMLElement | null>(null),
		id = useId();
	const keys = facts.join('\n');
	const close = (focus: boolean) => {
		setOpened(null);
		if (focus) button.current?.focus();
	};
	useEffect(() => {
		if (placement === 'repo' || !keys) return;
		const all = keys.split('\n');
		if (all.every((key) => shown.has(key))) return;
		for (const key of all) shown.add(key);
		setOpened((value) => value ?? 'auto');
	}, [keys, placement]);
	// In the composer the popover stands above the island, its right edge on the island's; elsewhere under the chip.
	anchor.current =
		placement === 'composer' ? (button.current?.closest('form') ?? button.current) : button.current;
	const note = opened === 'auto' ? autoNote : clickNote;
	return (
		<>
			<button
				ref={button}
				type="button"
				className={styles.chip}
				data-placement={placement}
				{...data}
				aria-label={accessibleLabel}
				title={accessibleLabel}
				aria-haspopup="dialog"
				aria-expanded={!!opened}
				aria-controls={opened ? id : undefined}
				onClick={() => (opened ? close(false) : setOpened('click'))}>
				<Glyph name={icon} size={11} />
				<span>{label}</span>
			</button>
			<Popover
				id={id}
				open={!!opened}
				onClose={() => setOpened(null)}
				anchor={anchor}
				returnFocus={button}
				side={placement === 'composer' ? 'top' : 'bottom'}
				align="end"
				width={360}
				label={title}
				locale={locale}
				className={styles.popover}
				data-notice-popover={opened ?? undefined}
				focusOnOpen={opened === 'click'}
				closeOnScroll={placement === 'repo'}>
				{children(close)}
				{(note || opened === 'auto') && (
					<footer data-size="m">
						<span>{note}</span>
						{opened === 'auto' && (
							<Button variant="soft" onClick={() => close(true)}>
								{t(locale, 'Got it')}
							</Button>
						)}
					</footer>
				)}
			</Popover>
		</>
	);
}
/** spec/notifications-slack-notes-and-schedules#notice-chips: the sections every class S popover shares (rule 17) — the lede under the header, a repo's row with
 *  its count, a repo's name. A popover's own CSS only places its own rows (paths, tasks). */
export function NoticeLede({ children }: { children: ReactNode }) {
	return <div className={styles.lede}>{children}</div>;
}
export function NoticeRepoName({ children }: { children: ReactNode }) {
	return <span className={styles.repo}>{children}</span>;
}
export function NoticeRepoRow({
	name,
	count,
	icon,
}: {
	name: ReactNode;
	count: ReactNode;
	/** Contention marks the repo with its lock (amber). */ icon?: GlyphName;
}) {
	return (
		<h4 className={styles.repoRow}>
			{icon && <Glyph name={icon} size={11} />}
			<NoticeRepoName>{name}</NoticeRepoName>
			<span className={styles.count}>{count}</span>
		</h4>
	);
}
/** The same amber chip as a plain label, without its popover (spec/composer-steering-queue-and-ghost#quick-question: «Claude limit · 48 min» in the quick
 *  question's limit card, «Limit · 48 min» on a provider in the model menu). Not a target, so it may be under 24 px. */
export function NoticeLabel({
	label,
	icon,
	title,
	...data
}: {
	label: string;
	icon: GlyphName;
	title?: string | undefined;
} & { [key: `data-${string}`]: string | undefined }) {
	return (
		<span className={styles.chip} data-static {...data} title={title}>
			<Glyph name={icon} size={11} />
			<span>{label}</span>
		</span>
	);
}
