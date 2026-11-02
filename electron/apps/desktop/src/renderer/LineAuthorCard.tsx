import { useLayoutEffect, useRef, useState } from 'react';
import { ageAgo, authorInitials, formatDateTime, t, type Locale } from '@brigadir/core';
import { Button } from './ui/Controls';
import { Glyph } from './ui/Glyph';
import type { LineAuthor } from './editor-blame';
import styles from './LineAuthorCard.module.css';

/**
 * spec/editor#line-author: the card over the line author tail. A hint, not a modal: it closes when the pointer leaves both the tail
 * and the card, on Esc and on a caret move, so it has no Esc button of its own (rule 14 is for modal surfaces).
 */
export function LineAuthorCard({
	locale,
	author,
	anchor,
	bounds,
	message,
	onEnter,
	onLeave,
	onHistory,
	onOpenCommit,
	onCopy,
}: {
	locale: Locale;
	author: LineAuthor;
	anchor: { left: number; top: number };
	bounds: { left: number; right: number };
	message: string | null;
	onEnter(): void;
	onLeave(): void;
	onHistory(): void;
	onOpenCommit(): void;
	onCopy(sha: string): void;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const [left, setLeft] = useState(anchor.left);
	// The card starts at the tail and stays inside the editor.
	useLayoutEffect(() => {
		const width = ref.current?.offsetWidth ?? 348;
		setLeft(Math.max(bounds.left + 4, Math.min(anchor.left, bounds.right - width - 8)));
	}, [anchor.left, bounds.left, bounds.right]);
	const style = { left, top: anchor.top };
	{
		const { commit } = author,
			body = (message ?? '').split('\n').slice(1).join('\n').trim();
		return (
			<div
				ref={ref}
				role="dialog"
				aria-label={t(locale, 'Commit of line {line}').replace('{line}', String(author.line))}
				data-line-author-card="commit"
				className={styles.card}
				style={style}
				onMouseEnter={onEnter}
				onMouseLeave={onLeave}>
				<div className={styles.head}>
					<span className={styles.avatar} aria-hidden="true">
						{authorInitials(commit.author)}
					</span>
					<div className={styles.who}>
						<strong>{commit.author}</strong>
						<small>
							{ageAgo(locale, commit.time)} · {formatDateTime(commit.time)}
						</small>
					</div>
				</div>
				<div className={styles.body}>
					<span className={styles.subject}>{commit.summary}</span>
					{body && <span className={styles.message}>{body}</span>}
				</div>
				<div className={styles.foot}>
					<button
						type="button"
						className={styles.hash}
						title={t(locale, 'Copy hash')}
						aria-label={`${t(locale, 'Copy hash')} ${commit.sha.slice(0, 7)}`}
						onClick={() => onCopy(commit.sha)}>
						{commit.sha.slice(0, 7)}
						<Glyph name="copy" size={11} />
					</button>
					<span className={styles.spacer} />
					<Button onClick={onHistory}>{t(locale, 'File history')}</Button>
					<Button appearance="primary" onClick={onOpenCommit}>
						{t(locale, 'Open commit')}
					</Button>
				</div>
			</div>
		);
	}
}
