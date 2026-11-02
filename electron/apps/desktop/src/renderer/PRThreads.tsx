import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import MarkdownIt from 'markdown-it';
import {
	formatAccelerator,
	prAge,
	t,
	type Locale,
	type PRDraft,
	type PRSummarySpot,
	type PRThread,
} from '@brigadir/core';
import { Glyph } from './ui/Glyph';
import { Button, IconButton } from './ui/Controls';
import { TextArea } from './ui/Input';
import { CodeQuote } from './ui/CodeQuote';
import { Popover } from './ui/Popover';
import { Avatar } from './PullRequestPanel';
import { htmlComments } from './markdown-comments';
import styles from './PRThreads.module.css';
import { primaryKey } from './ui/primary-key';

/**
 * GitHub description and comment text is Markdown (GFM without raw HTML), as on GitHub: headings, lists, code, links.
 * Network images are not loaded (as in agent replies); a link opens in the browser only on the repository host.
 */
const markdown = new MarkdownIt({ html: false, linkify: true, breaks: false }).use(htmlComments);
markdown.renderer.rules.image = (tokens, index) =>
	markdown.utils.escapeHtml(tokens[index]?.content ?? '');
export const PRLinkContext = createContext<((url: string) => void) | null>(null);
export function CommentText({ text }: { text: string }) {
	const openLink = useContext(PRLinkContext),
		html = useMemo(() => markdown.render(text.trim()), [text]);
	return (
		<div
			className={styles.markdown}
			data-pr-markdown
			onClick={(event) => {
				const link = (event.target as HTMLElement).closest('a');
				if (!link) return;
				event.preventDefault();
				const href = link.getAttribute('href');
				if (href && /^https:\/\//.test(href)) openLink?.(href);
			}}
			dangerouslySetInnerHTML={{ __html: html }}
		/>
	);
}
/** spec/pull-requests-and-ci#pr-threads: what a PR file's diff tab does with threads and drafts; lives in TaskView because drafts are on the task's disk. */
export type PRDiffActions = {
	viewer: string | null;
	busy: boolean;
	error: string;
	reply(thread: PRThread, body: string, now: boolean): Promise<boolean>;
	resolve(thread: PRThread, resolved: boolean): Promise<void>;
	comment(
		range: { side: 'old' | 'new'; start: number; end: number },
		body: string,
		now: boolean
	): Promise<boolean>;
	editDraft(draft: PRDraft, body: string): Promise<void>;
	removeDraft(draft: PRDraft): Promise<void>;
	/** spec/pull-requests-and-ci#review-with-agent, spec/pull-requests-and-ci#review-drafts: the reply goes to the review task the draft came from; without it the button says why it is off. */
	discuss?: ((draft: PRDraft, body: string) => Promise<boolean>) | undefined;
	canDiscuss?: ((draft: PRDraft) => boolean) | undefined;
	openOnGitHub(url: string): void;
};
const lineLabel = (locale: Locale, start: number | null, end: number | null) =>
	end === null
		? t(locale, 'outdated')
		: start !== null && start < end
			? t(locale, 'lines {start}–{end}')
					.replace('{start}', String(start))
					.replace('{end}', String(end))
			: t(locale, 'line {n}').replace('{n}', String(end));
/** A GitHub thread in the diff lines: author, line, replies; `Reply`, `Resolve`, GitHub. */
export function PRThreadCard({
	thread,
	drafts,
	locale,
	actions,
}: {
	thread: PRThread;
	drafts: PRDraft[];
	locale: Locale;
	actions: PRDiffActions;
}) {
	const [first, ...replies] = thread.comments,
		[replying, setReplying] = useState(false),
		[text, setText] = useState('');
	if (!first) return null;
	return (
		<div
			className={styles.thread}
			data-pr-thread={thread.id}
			data-resolved={thread.resolved}
			data-size="s">
			<div className={styles.head}>
				<Avatar login={first.author} size="m" />
				<strong>{first.author}</strong>
				<small>{lineLabel(locale, thread.startLine, thread.line)}</small>
				<span className={styles.space} />
				{thread.resolved && (
					<small className={styles.resolvedTag}>
						<Glyph name="tick" size={10} />
						{t(locale, 'Resolved')}
					</small>
				)}
				<small>{prAge(locale, first.createdAt)}</small>
			</div>
			<div className={styles.body}>
				<CommentText text={first.body} />
			</div>
			{replies.map((reply) => (
				<div key={reply.id} className={styles.reply}>
					<Avatar login={reply.author} />
					<div>
						<strong>{reply.author}</strong> <small>{prAge(locale, reply.createdAt)}</small>
						<div className={styles.replyText}>
							<CommentText text={reply.body} />
						</div>
					</div>
				</div>
			))}
			{drafts.map((draft) => (
				<DraftReply key={draft.id} draft={draft} locale={locale} actions={actions} />
			))}
			{replying ? (
				<Composer
					locale={locale}
					value={text}
					onChange={setText}
					busy={actions.busy}
					placeholder={t(locale, 'Reply…')}
					left={
						<Button
							variant="ghost"
							disabled={actions.busy}
							onClick={() => {
								void actions.resolve(thread, !thread.resolved);
							}}>
							{t(locale, thread.resolved ? 'Reopen thread' : 'Resolve thread')}
						</Button>
					}
					cancel={() => {
						setReplying(false);
						setText('');
					}}
					now={t(locale, 'Reply now')}
					save={t(locale, 'Add to review')}
					submit={async (now) => {
						if (await actions.reply(thread, text, now)) {
							setReplying(false);
							setText('');
						}
					}}
				/>
			) : (
				<div className={styles.foot}>
					<Button onClick={() => setReplying(true)}>{t(locale, 'Reply')}</Button>
					<Button
						variant="ghost"
						disabled={actions.busy}
						onClick={() => {
							void actions.resolve(thread, !thread.resolved);
						}}>
						{t(locale, thread.resolved ? 'Reopen' : 'Resolve')}
					</Button>
					<span className={styles.space} />
					<IconButton
						label={t(locale, 'Open on GitHub')}
						onClick={() => actions.openOnGitHub(first.url)}>
						<Glyph name="github" size={12} />
					</IconButton>
				</div>
			)}
		</div>
	);
}
function DraftReply({
	draft,
	locale,
	actions,
}: {
	draft: PRDraft;
	locale: Locale;
	actions: PRDiffActions;
}) {
	return (
		<div className={styles.reply} data-pr-draft={draft.id} data-size="s">
			<Avatar login={actions.viewer ?? 'me'} />
			<div>
				<strong>{actions.viewer ?? t(locale, 'you')}</strong>{' '}
				<small className={styles.pending}>
					{draft.fromAgent && <Glyph name="generate" size={10} />}
					{t(locale, 'draft')}
				</small>
				<div className={styles.replyText}>
					<CommentText text={draft.body} />
				</div>
			</div>
			<IconButton
				label={t(locale, 'Remove the draft')}
				disabled={actions.busy}
				onClick={() => {
					void actions.removeDraft(draft);
				}}>
				<Glyph name="xmark" size={10} />
			</IconButton>
		</div>
	);
}
/** A draft of a new comment on lines: a card that is yours and unsent until «Submit review». */
export function PRDraftCard({
	draft,
	locale,
	actions,
	quote = null,
}: {
	draft: PRDraft;
	locale: Locale;
	actions: PRDiffActions;
	/** spec/appearance#evolution-redesign, spec/diff-and-review#diff-selection: the lines the draft is on, quoted as the new comment quoted them. */
	quote?: { text: string; path: string } | null;
}) {
	const [editing, setEditing] = useState(false),
		[text, setText] = useState(draft.body),
		[replying, setReplying] = useState(false),
		[reply, setReply] = useState('');
	useEffect(() => {
		if (!editing) setText(draft.body);
	}, [draft.body, editing]);
	const discussion = draft.discussion ?? [],
		waiting = discussion.at(-1)?.from === 'person';
	return (
		<div className={styles.thread} data-pr-draft={draft.id} data-draft data-size="s">
			<div className={styles.head}>
				<Avatar login={actions.viewer ?? 'me'} size="m" />
				<strong>{actions.viewer ?? t(locale, 'you')}</strong>
				<small>{lineLabel(locale, draft.startLine, draft.line)}</small>
				<span className={styles.space} />
				{draft.updatedByAgent && (
					<small className={styles.updated} data-updated-by-agent>
						{t(locale, 'updated by the agent')}
					</small>
				)}
				<small className={styles.pending}>
					{draft.fromAgent && <Glyph name="generate" size={10} />}
					{t(locale, draft.fromAgent ? 'Agent · draft' : 'Draft')}
				</small>
			</div>
			{quote && quote.text.trim() && (
				<CodeQuote className={styles.quote} text={quote.text} path={quote.path} locale={locale} />
			)}
			{editing ? (
				<Composer
					locale={locale}
					value={text}
					onChange={setText}
					busy={actions.busy}
					cancel={() => {
						setEditing(false);
						setText(draft.body);
					}}
					save={t(locale, 'Save')}
					submit={async () => {
						await actions.editDraft(draft, text);
						setEditing(false);
					}}
				/>
			) : (
				<>
					<div className={styles.body}>
						<CommentText text={draft.body} />
					</div>
					{/* spec/pull-requests-and-ci#review-with-agent: the thread with the agent under its draft — the person's replies and its answers; never sent to GitHub. */}
					{discussion.map((item, index) => (
						<div key={index} className={styles.reply} data-pr-draft-reply={item.from}>
							{item.from === 'agent' ? (
								<span className={styles.agentAvatar} aria-hidden="true">
									<Glyph name="generate" size={8} />
								</span>
							) : (
								<Avatar login={actions.viewer ?? 'me'} />
							)}
							<div>
								<strong>
									{item.from === 'agent'
										? t(locale, 'Agent')
										: (actions.viewer ?? t(locale, 'you'))}
								</strong>{' '}
								<small>{prAge(locale, item.at)}</small>
								<div className={styles.replyText}>
									<CommentText text={item.body} />
								</div>
							</div>
						</div>
					))}
					{waiting && (
						<div className={styles.thinking} role="status">
							<Glyph name="check-run" size={11} />
							<small>{t(locale, 'The agent is thinking…')}</small>
						</div>
					)}
					{replying ? (
						<Composer
							locale={locale}
							value={reply}
							onChange={setReply}
							busy={actions.busy}
							placeholder={t(locale, 'Write to the agent…')}
							cancel={() => {
								setReplying(false);
								setReply('');
							}}
							save={t(locale, 'Send to the agent')}
							shortcut
							submit={async () => {
								if (await actions.discuss?.(draft, reply)) {
									setReplying(false);
									setReply('');
								}
							}}
						/>
					) : (
						<div className={styles.foot}>
							<Button onClick={() => setEditing(true)}>{t(locale, 'Edit')}</Button>
							<Button
								variant="ghost"
								disabled={actions.busy}
								onClick={() => {
									void actions.removeDraft(draft);
								}}>
								{t(locale, 'Remove')}
							</Button>
							{draft.fromAgent && (
								<>
									<span className={styles.space} />
									<Button
										data-reply-agent
										disabled={
											!actions.discuss || !(actions.canDiscuss?.(draft) ?? true) || actions.busy
										}
										title={
											actions.discuss && (actions.canDiscuss?.(draft) ?? true)
												? undefined
												: t(locale, 'The review task is gone')
										}
										onClick={() => setReplying(true)}>
										<Glyph name="generate" size={11} />
										{t(locale, 'Reply to the agent')}
									</Button>
								</>
							)}
						</div>
					)}
				</>
			)}
		</div>
	);
}
/**
 * spec/appearance#evolution-redesign: a diff marker, a risk ⚠ or a «what to check» item ✓ of the agent summary under
 * the line it points at — the card of a comment on the line (rule 17), one row: the glyph, the kind, the text. A click opens
 * the whole text with `Comment on it` (a new comment on these lines, the text to start from) and `Dismiss` (hides it for
 * this person on this head). Not a draft: nothing of it goes to GitHub. A stale summary dims it.
 */
export function PRSpotCard({
	spot,
	place,
	locale,
	stale,
	onComment,
	onDismiss,
}: {
	spot: PRSummarySpot;
	/** `index.tsx:110` — the file and the lines, for the popover's header. */ place: string;
	locale: Locale;
	stale: boolean;
	onComment(): void;
	onDismiss(): void;
}) {
	const [open, setOpen] = useState(false),
		anchor = useRef<HTMLButtonElement>(null),
		kind = t(locale, spot.kind === 'risk' ? 'Risky spot' : 'What to check'),
		glyph = <Glyph name={spot.kind === 'risk' ? 'review-warning' : 'tick'} size={12} />;
	return (
		<div
			className={styles.thread}
			data-pr-spot={spot.kind}
			data-stale={stale || undefined}
			data-active={open || undefined}>
			<button
				ref={anchor}
				type="button"
				className={styles.spot}
				aria-haspopup="dialog"
				aria-expanded={open}
				aria-label={`${kind} · ${place} · ${spot.text}`}
				title={spot.text}
				onClick={() => setOpen((value) => !value)}>
				{glyph}
				<strong>{kind}</strong>
				<span>{spot.text}</span>
			</button>
			<Popover
				open={open}
				onClose={() => setOpen(false)}
				anchor={anchor}
				label={`${kind} · ${place}`}
				title={
					<>
						<span className={styles.spotGlyph} data-kind={spot.kind}>
							{glyph}
						</span>
						{`${kind} · ${place}`}
					</>
				}
				headerSize="s"
				locale={locale}
				width={320}
				initialFocus={(popover) => popover.querySelector<HTMLElement>('[data-spot-comment]')}
				data-pr-spot-popover={spot.kind}>
				<div className={styles.spotPopover}>
					<p>{spot.text}</p>
					<small>
						<Glyph name="generate" size={10} />
						{t(locale, 'From the summary')}
					</small>
					<div className={styles.actions} data-size="s">
						<Button
							data-spot-comment
							onClick={() => {
								setOpen(false);
								onComment();
							}}>
							<Glyph name="bubble" size={11} />
							{t(locale, 'Comment on it')}
						</Button>
						<Button
							variant="ghost"
							onClick={() => {
								setOpen(false);
								onDismiss();
							}}>
							{t(locale, 'Dismiss (marker)')}
						</Button>
					</div>
				</div>
			</Popover>
		</div>
	);
}
/** A new comment on lines: `Add to review` (⌘↩) or `Comment now`. */
export function PRNewComment({
	range,
	quote,
	locale,
	actions,
	cancel,
	initial = '',
}: {
	/** spec/appearance#evolution-redesign: «Comment on it» on a summary marker starts the comment with the item's text. */ initial?: string;
	range: { side: 'old' | 'new'; start: number; end: number };
	/** spec/diff-and-review#diff-selection: the selected code, quoted as in a task comment. */
	quote: { text: string; path: string };
	locale: Locale;
	actions: PRDiffActions;
	cancel(): void;
}) {
	const [text, setText] = useState(initial);
	useEffect(() => {
		if (initial) setText(initial);
	}, [initial]);
	return (
		<div className={styles.thread} data-pr-new-comment data-active data-size="s">
			<div className={styles.head}>
				<Avatar login={actions.viewer ?? 'me'} size="m" />
				<strong>{actions.viewer ?? t(locale, 'you')}</strong>
				<small>{lineLabel(locale, range.start, range.end)}</small>
				<span className={styles.space} />
				<small>Markdown</small>
			</div>
			<CodeQuote className={styles.quote} text={quote.text} path={quote.path} locale={locale} />
			<Composer
				locale={locale}
				bare
				value={text}
				onChange={setText}
				busy={actions.busy}
				placeholder={t(locale, 'Leave a comment')}
				cancel={cancel}
				now={t(locale, 'Comment now')}
				save={t(locale, 'Add to review')}
				shortcut
				submit={async (now) => {
					if (await actions.comment(range, text, now)) {
						setText('');
						cancel();
					}
				}}
			/>
		</div>
	);
}
function Composer({
	locale,
	value,
	onChange,
	busy,
	placeholder,
	left,
	cancel,
	now,
	save,
	shortcut = false,
	bare = false,
	submit,
}: {
	locale: Locale;
	value: string;
	onChange(value: string): void;
	busy: boolean;
	placeholder?: string;
	left?: React.ReactNode;
	cancel(): void;
	now?: string;
	save: string;
	shortcut?: boolean;
	bare?: boolean;
	submit(now: boolean): Promise<void>;
}) {
	const area = useRef<HTMLTextAreaElement>(null);
	useEffect(() => {
		area.current?.focus({ preventScroll: true });
	}, []);
	return (
		<div className={styles.composer} data-bare={bare}>
			<TextArea
				ref={area}
				embedded={bare}
				value={value}
				placeholder={placeholder}
				aria-label={placeholder ?? save}
				disabled={busy}
				rows={bare ? 2 : 1}
				onChange={(event) => onChange(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === 'Escape') {
						event.preventDefault();
						event.stopPropagation();
						cancel();
					}
					if (event.key === 'Enter' && primaryKey(event) && value.trim()) {
						event.preventDefault();
						void submit(false);
					}
				}}
			/>
			<div className={styles.actions}>
				{left}
				<span className={styles.space} />
				<span className={styles.escape}>
					<kbd>esc</kbd>
					{bare ? '' : ` ${t(locale, 'cancel')}`}
				</span>
				{now && (
					<Button
						disabled={busy || !value.trim()}
						onClick={() => {
							void submit(true);
						}}>
						{now}
					</Button>
				)}
				<Button
					appearance="primary"
					disabled={busy || !value.trim()}
					onClick={() => {
						void submit(false);
					}}>
					{save}
					{shortcut && (
						<span className={styles.shortcut}>{formatAccelerator('CmdOrCtrl+Enter')}</span>
					)}
				</Button>
			</div>
		</div>
	);
}
