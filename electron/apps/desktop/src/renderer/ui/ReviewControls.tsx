import { TextArea } from './Input';
import { Glyph } from './Glyph';
import {
	useEffect,
	useLayoutEffect,
	useRef,
	useId,
	useSyncExternalStore,
	type ReactNode,
} from 'react';
import {
	t,
	commentCount,
	fileCount,
	type Locale,
	type ReviewComment,
	type ReviewStatus,
	type AnchorPosition,
} from '@brigadir/core';
import { Button, IconButton, SplitButton } from './Controls';
import styles from './ReviewControls.module.css';
import { CodeQuote } from './CodeQuote';
import { lineSpan } from '../code-selection';
/**
 * spec/diff-and-review#selection-panel: a bare selection's panel floats over the lines below it and takes no height, so selecting never moves a
 * line. Only an open draft (a comment placed on these lines) takes its block in the flow.
 * Canvas v3 5.8: the panel is a pill as wide as its content, under the selection where the selection starts (`start`,
 * the rectangle of its first character), kept inside the visible code; with no room below it goes above the selection.
 * The label truncates only when the code is narrower than the pill.
 */
export function SelectionFloat({
	children,
	start,
}: {
	children: ReactNode;
	start?: (() => DOMRect | null) | undefined;
}) {
	const held = useSyncExternalStore(onPress, selecting);
	const anchor = useRef<HTMLDivElement>(null),
		float = useRef<HTMLDivElement>(null);
	const startRef = useRef(start);
	startRef.current = start;
	useLayoutEffect(() => {
		const host = anchor.current,
			panel = float.current;
		const view = host?.closest<HTMLElement>('.cm-scroller, [role=log]');
		if (!host || !panel || !view) return;
		let frame = 0;
		const place = () => {
			cancelAnimationFrame(frame);
			const box = view.getBoundingClientRect(),
				at = host.getBoundingClientRect(),
				// The code itself: the gutter of a diff or the editor stays clear.
				code = view.querySelector('.cm-content, [data-code-line]')?.getBoundingClientRect(),
				from = Math.max(box.left, Math.min(code?.left ?? box.left, box.right)) + GAP,
				to = box.right - GAP;
			panel.style.maxWidth = `${Math.max(120, to - from)}px`;
			const width = panel.offsetWidth,
				height = panel.offsetHeight,
				first = startRef.current?.() ?? null;
			const x = Math.max(from, Math.min(first?.left ?? from, to - width));
			const below =
				at.top + GAP + height <= box.bottom || !first || first.top - GAP - height < box.top;
			panel.style.left = `${Math.round(x - at.left)}px`;
			panel.style.top = below ? `${GAP}px` : `${Math.round(first.top - GAP - height - at.top)}px`;
			panel.dataset.side = below ? 'below' : 'above';
		};
		const later = () => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(place);
		};
		place();
		const observer = new ResizeObserver(later);
		observer.observe(view);
		observer.observe(panel);
		view.addEventListener('scroll', later, { passive: true });
		window.addEventListener('resize', later);
		return () => {
			cancelAnimationFrame(frame);
			observer.disconnect();
			view.removeEventListener('scroll', later);
			window.removeEventListener('resize', later);
		};
	});
	return (
		<div ref={anchor} data-selection-float className={styles.floatAnchor}>
			<div ref={float} className={styles.float} data-held={held || undefined}>
				{children}
			</div>
		</div>
	);
}
const GAP = 4;
// A selection still being made sees through the panel: while the button is down on the code, or Shift is held to extend
// it (a Shift+click on a line number below), hit testing (CodeMirror's posAtCoords, native text selection, the gutter)
// reaches the lines under the panel, and the panel shows where the gesture ends. Tracked from the start, since the
// gesture usually begins before the panel exists.
let pressed = false,
	shifted = false;
const pressListeners = new Set<() => void>();
const selecting = () => pressed || shifted;
function setGesture(next: { pressed?: boolean; shifted?: boolean }) {
	const was = selecting();
	pressed = next.pressed ?? pressed;
	shifted = next.shifted ?? shifted;
	if (selecting() !== was) for (const listener of pressListeners) listener();
}
const inCode = (node: EventTarget | Element | null) =>
	node instanceof Element &&
	!node.closest('[data-selection-float]') &&
	!!node.closest('.cm-editor, [role=log]');
if (typeof document !== 'undefined') {
	document.addEventListener(
		'pointerdown',
		(event) => setGesture({ pressed: event.button === 0 && inCode(event.target) }),
		true
	);
	for (const type of ['pointerup', 'pointercancel'] as const)
		window.addEventListener(type, () => setGesture({ pressed: false }), true);
	document.addEventListener(
		'keydown',
		(event) => {
			if (event.key === 'Shift') setGesture({ shifted: inCode(document.activeElement) });
		},
		true
	);
	document.addEventListener(
		'keyup',
		(event) => {
			if (event.key === 'Shift') setGesture({ shifted: false });
		},
		true
	);
	window.addEventListener('blur', (event) => {
		if (event.target === window) setGesture({ pressed: false, shifted: false });
	});
}
function onPress(listener: () => void) {
	pressListeners.add(listener);
	return () => {
		pressListeners.delete(listener);
	};
}
export function SelectionActions({
	commentOpen = false,
	locale,
	label,
	onComment,
	onCompose,
	onDismiss,
	canComment = true,
	onAsk,
	askShortcut,
	onTask,
}: {
	commentOpen?: boolean;
	locale: Locale;
	label: string;
	/** Review comments and the composer; a note's selection has neither (spec/notifications-slack-notes-and-schedules#notes). */
	onComment?: undefined | (() => void);
	onCompose?: undefined | (() => void);
	/** spec/notifications-slack-notes-and-schedules#notes: a task from the selected part of a note — then the primary action, before Ask the agent. */
	onTask?: undefined | (() => void);
	onDismiss?: undefined | (() => void);
	canComment?: boolean;
	/** spec/composer-steering-queue-and-ghost#quick-question: the first, primary action. */ onAsk?:
		undefined | (() => void);
	askShortcut?: string | undefined;
}) {
	// spec/diff-and-review#diff-selection: Esc drops the selection while only the panel is up; an open draft, a field, a popover or a handler that
	// already took the key (CodeMirror collapses its own selection) keep it.
	useEffect(() => {
		if (!onDismiss || commentOpen) return;
		const key = (event: KeyboardEvent) => {
			if (
				event.key !== 'Escape' ||
				event.defaultPrevented ||
				document.querySelector('dialog[open]') ||
				document.activeElement?.closest('textarea,input,[data-prompt]')
			)
				return;
			event.preventDefault();
			onDismiss();
		};
		document.addEventListener('keydown', key);
		return () => document.removeEventListener('keydown', key);
	}, [onDismiss, commentOpen]);
	return (
		<div
			data-selection-actions
			data-size="s"
			className={styles.actions}
			// spec/appearance#evolution-redesign: pressing a button keeps the text selection it acts on (the native one in a diff, CodeMirror's).
			onMouseDown={(event) => {
				if (event.button === 0) event.preventDefault();
			}}>
			{onTask && (
				<Button appearance="primary" data-create-task onClick={onTask}>
					<Glyph name="task-new" size={14} />
					{t(locale, 'Create task')}
				</Button>
			)}
			{onAsk && (
				<Button
					appearance={onTask ? 'neutral' : 'primary'}
					data-ask-agent
					title={
						askShortcut
							? `${t(locale, 'Ask the agent')} · ${askShortcut}`
							: t(locale, 'Ask the agent')
					}
					onClick={onAsk}>
					<Glyph name="generate" size={14} />
					{t(locale, 'Ask the agent')}
				</Button>
			)}
			{onComment && (
				<Button
					appearance={onAsk ? 'neutral' : 'primary'}
					aria-pressed={commentOpen}
					disabled={!canComment && !commentOpen}
					onClick={onComment}>
					<Glyph name="comment" size={14} />
					{t(locale, 'Comment')}
				</Button>
			)}
			{onCompose && (
				<Button onClick={onCompose}>
					<Glyph name="paperclip" size={14} />
					{t(locale, 'To composer')}
				</Button>
			)}
			<span title={label}>{label}</span>
		</div>
	);
}
export function CommentDraft({
	locale,
	text,
	busy,
	onText,
	onSave,
	onCancel,
	onCompose,
	editing = false,
	terminal = false,
	lines,
	quote,
}: {
	locale: Locale;
	text: string;
	busy: boolean;
	onText(text: string): void;
	onSave(): void;
	onCancel(): void;
	onCompose?: (focus: boolean) => void;
	editing?: boolean;
	terminal?: boolean;
	/** spec/appearance#evolution-redesign: the lines the draft anchors to, `109–111` (`· old` for the old side). */
	lines?: string;
	/** The selected code it quotes, and the file that colours it. */
	quote?: { text: string; path: string } | undefined;
}) {
	const ref = useRef<HTMLElement>(null);
	useEffect(
		() =>
			window.brigadir.onWorkspaceAction((action) => {
				if (!ref.current?.contains(document.activeElement) || busy || !text.trim()) return;
				if (action === 'review-send') {
					if (onCompose) onCompose(false);
					else onSave();
				}
				if (action === 'review-send-go' && onCompose) onCompose(true);
			}),
		[busy, text, onCompose, onSave]
	);
	return (
		<section
			ref={ref}
			data-comment-draft
			data-menu-comment={!busy && !!text.trim()}
			data-menu-comment-go={!busy && !!text.trim() && !!onCompose}
			className={styles.draft}
			data-size="s"
			onKeyDown={(event) => {
				if (event.key === 'Escape') {
					event.preventDefault();
					event.stopPropagation();
					onCancel();
				}
			}}>
			<header>
				<span className={styles.avatar}>{t(locale, 'You').slice(0, 1)}</span>
				<strong>{t(locale, editing ? 'Edit comment' : 'New comment')}</strong>
				{lines !== undefined && <span className={styles.lineCount}>{lines}</span>}
				<small>{t(locale, 'Draft')}</small>
			</header>
			{quote && <CodeQuote text={quote.text} path={quote.path} locale={locale} />}
			<TextArea
				embedded
				autoFocus
				placeholder={t(locale, 'What is wrong with these lines?')}
				aria-label={t(locale, 'Comment')}
				value={text}
				maxLength={10000}
				onChange={(e) => onText(e.target.value)}
			/>
			<footer>
				<Button onClick={onCancel}>{t(locale, 'Cancel')}</Button>
				<Button disabled={busy || !text.trim()} onClick={onSave}>
					<Glyph name="comment-list" size={14} />
					{t(locale, editing ? 'Save' : 'Add a comment')}
				</Button>
				{onCompose && (
					<SplitButton
						appearance="primary"
						disabled={busy || !text.trim()}
						onClick={() => onCompose(false)}
						second={{
							label: t(locale, terminal ? 'Attach comment and go' : 'Send to chat and go'),
							icon: <Glyph name="send-chat-go" size={14} />,
							onClick: () => onCompose(true),
						}}>
						<Glyph name="send-chat" size={14} />
						{t(locale, terminal ? 'Attach comment' : 'Send to chat')}
					</SplitButton>
				)}
			</footer>
		</section>
	);
}
export function CommentCard({
	comment,
	locale,
	sent,
	position,
	onEdit,
	onRemove,
	onResolve,
}: {
	comment: ReviewComment & ReviewStatus;
	locale: Locale;
	sent: boolean;
	position?: AnchorPosition;
	onEdit(): void;
	onRemove(): void;
	onResolve(): void;
}) {
	return (
		<article className={styles.comment} data-size="s">
			<header>
				<span className={styles.avatar}>●</span>
				<strong>{t(locale, 'You')}</strong>
				<span className={styles.lineCount}>
					{lineSpan(comment.anchor.start, comment.anchor.end)}
					{position?.state === 'relocated' && position.start !== null && position.end !== null
						? ` → ${lineSpan(position.start, position.end)}`
						: ''}
					{comment.anchor.side === 'old' ? ' · old' : ''}
				</span>
				{position?.state !== 'exact' && position && (
					<small data-outdated={position.state === 'outdated'}>
						{t(locale, position.state === 'outdated' ? 'Outdated' : 'Relocated')}
					</small>
				)}
				<small>
					{t(
						locale,
						comment.resolved
							? 'Resolved'
							: comment.addressed
								? 'Addressed'
								: sent
									? 'Sent'
									: 'Pending'
					)}
				</small>
				{sent && (
					<Button onClick={onResolve}>{t(locale, comment.resolved ? 'Reopen' : 'Resolve')}</Button>
				)}
				<IconButton label={t(locale, 'Edit comment')} onClick={onEdit}>
					<Glyph name="edit" size={14} />
				</IconButton>
				<IconButton label={t(locale, 'Remove comment')} onClick={onRemove}>
					<Glyph name="close" size={14} />
				</IconButton>
			</header>
			<CodeQuote
				text={comment.excerpt ?? comment.anchor.quote.join('\n')}
				path={comment.anchor.path}
				locale={locale}
			/>
			<p>{comment.text}</p>
		</article>
	);
}
export function ReviewFooter({
	compact,
	onCompact,
	locale,
	count,
	draft,
	busy,
	canSend,
	onSend,
	generalNote,
	onGeneralNote,
	onAddNote,
	terminal = false,
	totalCount = count,
	files = 0,
	onOpenReview,
	onDeleteAll,
}: {
	compact: boolean;
	onCompact(compact: boolean): void;
	locale: Locale;
	count: number;
	draft: boolean;
	busy: boolean;
	canSend: boolean;
	onSend(): void;
	generalNote: string;
	onGeneralNote(text: string): void;
	onAddNote(): void;
	terminal?: boolean;
	totalCount?: number;
	files?: number;
	onOpenReview?: () => void;
	onDeleteAll?: () => void;
}) {
	const noteId = useId();
	return (
		<footer data-review-footer data-size="m" data-toast-avoid className={styles.footer}>
			<div id={noteId} hidden={compact} inert={compact} className={styles.generalNote}>
				<TextArea
					rows={1}
					aria-label={t(locale, 'General note')}
					placeholder={t(locale, 'General note')}
					maxLength={10000}
					value={generalNote}
					onChange={(event) => onGeneralNote(event.target.value)}
				/>
				<Button disabled={busy || !generalNote.trim()} onClick={onAddNote}>
					{t(locale, 'Add note')}
				</Button>
			</div>
			<div className={styles.summary}>
				<IconButton
					className={styles.collapse}
					label={t(locale, compact ? 'Expand review panel' : 'Collapse review panel')}
					aria-expanded={!compact}
					aria-controls={noteId}
					onClick={() => onCompact(!compact)}>
					<Glyph name="hide" size={14} />
				</IconButton>
				{onOpenReview ? (
					<Button variant="ghost" title={t(locale, 'Review')} onClick={onOpenReview}>
						{commentCount(locale, totalCount)} · {fileCount(locale, files)}{' '}
						{/* spec/appearance#evolution-redesign: the list opens in a window — the `zoom` glyph, not a chevron. */}
						<Glyph name="zoom" size={14} />
					</Button>
				) : (
					<span>
						{commentCount(locale, totalCount)} · {fileCount(locale, files)}
					</span>
				)}
			</div>
			{draft && (
				<span className={styles.warning}>{t(locale, 'The draft has not been added.')}</span>
			)}
			<div className={styles.footerActions}>
				{onDeleteAll && (totalCount > 0 || Boolean(generalNote.trim())) && (
					<IconButton label={t(locale, 'Delete all')} disabled={busy} onClick={onDeleteAll}>
						<Glyph name="trash" size={14} />
					</IconButton>
				)}
				<Button appearance="primary" disabled={!count || busy || !canSend} onClick={onSend}>
					{t(locale, terminal ? 'Attach review' : 'Send review')}
				</Button>
			</div>
		</footer>
	);
}
