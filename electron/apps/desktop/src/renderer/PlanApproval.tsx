import { shortcutHint } from './ui/shortcut-hint';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
	formatTime,
	planAllowOptions,
	planEditsPrompt,
	planFeedbackPrompt,
	planLineCount,
	planLinesLabel,
	planRejectOption,
	planTitle,
	providerName,
	samePlanText,
	t,
	type AgentTask,
	type Locale,
	type PermissionRequest,
	type PlanApproveChoice,
	type PlanRevisionBase,
	type SessionCommand,
} from '@brigadir/core';
import { planChangeView, type PlanChangeView } from '@brigadir/diff';
import { allChangesLabel, PlanChanges, PlanRevisionBar } from './PlanChanges';
import { markdown, MarkdownBlock } from './MarkdownBlock';
import { openTaskEditor } from './task-state';
// spec/editor#markdown-views: the plan copy opens to be edited, so in Code view (a line opens the code), not in the preview a new .md gets.
import { Button, Chevron, IconButton, SplitButton } from './ui/Controls';
import { TextArea } from './ui/Input';
import { Glyph } from './ui/Glyph';
import { MenuItem, MenuPopover } from './ui/Popover';
import { toastError } from './ui/Toast';
import styles from './PlanApproval.module.css';

/** spec/notifications-slack-notes-and-schedules#message-classes: the plan copy that did not open is a toast with Retry. */
function copyFailed(locale: Locale, retry: () => void) {
	toastError(t(locale, 'The plan copy could not be opened.'), {
		action: { label: t(locale, 'Retry'), run: retry },
	});
}
/** The plan body: chat markdown, folded to ~210 px until `Whole plan` (spec/chat-turns-plans-and-questions#plan-approval). */
function PlanBody({
	id,
	text,
	task,
	locale,
	revision,
	folded,
}: {
	id: string;
	text: string;
	task: AgentTask;
	locale: Locale;
	revision: number;
	folded: boolean;
}) {
	const tokens = useMemo(() => markdown.parse(text, {}), [text]),
		html = useMemo(() => markdown.renderer.render(tokens, markdown.options, {}), [tokens]);
	return (
		<div className={styles.body} data-folded={folded}>
			<MarkdownBlock
				rowId={id}
				html={html}
				tokens={tokens}
				locale={locale}
				task={task}
				revision={revision}
			/>
		</div>
	);
}

/** spec/chat-turns-plans-and-questions#plan-revisions: the revision's changes against its base, and which view the card opens on. */
function useRevision(text: string, base: PlanRevisionBase | undefined) {
	const before = base?.base?.text ?? null;
	const view = useMemo(
		() => (before === null ? null : planChangeView(before, text)),
		[before, text]
	);
	const [mode, setMode] = useState<'changes' | 'plan'>(
		view && !view.rewritten && view.additions + view.deletions > 0 ? 'changes' : 'plan'
	);
	return { view, mode: view ? mode : ('plan' as const), setMode };
}

/** The body of a plan card: the changes view or the plan, the bar over them, and the fold buttons under them. */
function RevisionBody({
	id,
	text,
	task,
	locale,
	revision,
	base,
	view,
	mode,
	setMode,
	whole,
	setWhole,
	foldable,
	tag,
}: {
	id: string;
	text: string;
	task: AgentTask;
	locale: Locale;
	revision: number;
	base: PlanRevisionBase['base'];
	view: PlanChangeView;
	mode: 'changes' | 'plan';
	setMode(mode: 'changes' | 'plan'): void;
	whole: boolean;
	setWhole(whole: boolean): void;
	foldable: boolean;
	tag: React.ReactNode;
}) {
	const lines = planLineCount(text),
		long = mode === 'changes' ? view.shownLines > 10 : lines > 10;
	return (
		<>
			{base && (
				<PlanRevisionBar
					view={view}
					base={base}
					mode={mode}
					locale={locale}
					onMode={(next) => {
						setMode(next);
						setWhole(false);
					}}
					tag={tag}
				/>
			)}
			{mode === 'changes' ? (
				<PlanChanges
					id={id}
					view={view}
					task={task}
					locale={locale}
					revision={revision}
					folded={foldable && !whole && long}
				/>
			) : (
				<PlanBody
					id={id}
					text={text}
					task={task}
					locale={locale}
					revision={revision}
					folded={foldable && !whole && long}
				/>
			)}
			{foldable && long && mode === 'changes' && (
				<div className={styles.wholeRow}>
					<Button
						size="s"
						appearance="primary"
						variant="ghost"
						aria-expanded={whole}
						onClick={() => setWhole(!whole)}>
						{allChangesLabel(locale, view.sections, whole)}
					</Button>
					<span className={styles.space} />
					<Button
						size="s"
						appearance="primary"
						variant="ghost"
						onClick={() => {
							setMode('plan');
							setWhole(true);
						}}>
						{t(locale, 'Whole plan · {n}').replace('{n}', planLinesLabel(locale, lines))}
					</Button>
				</div>
			)}
			{foldable && long && mode === 'plan' && (
				<Button
					size="s"
					appearance="primary"
					variant="ghost"
					className={styles.whole}
					aria-expanded={whole}
					onClick={() => setWhole(!whole)}>
					{whole
						? t(locale, 'Collapse plan')
						: t(locale, 'Whole plan · {n}').replace('{n}', planLinesLabel(locale, lines))}
				</Button>
			)}
		</>
	);
}

/**
 * spec/chat-turns-plans-and-questions#plan-approval: the plan for approval as a card in the chat. `Approve plan` answers with the agent's option for the mode
 * the session had before the plan, else `allow_once` asking the host for that mode back; the chevron lists its
 * `allow_*` options as they are, `Plan further…` rejects and queues what to change, and a copy edited
 * in the editor turns `Approve plan` into `Send edits`.
 */
export function PlanApproval({
	request,
	choice,
	text,
	task,
	locale,
	revision,
	base,
	disabled,
	send,
}: {
	request: PermissionRequest;
	choice: PlanApproveChoice | null;
	text: string;
	task: AgentTask;
	locale: Locale;
	revision: number;
	/** spec/chat-turns-plans-and-questions#plan-revisions: what this revision is compared with. */
	base?: PlanRevisionBase;
	disabled: boolean;
	send(command: SessionCommand): Promise<boolean>;
}) {
	const agent = task.provider ? providerName(task.provider) : '',
		approve = choice?.option ?? null,
		allow = planAllowOptions(request),
		reject = planRejectOption(request);
	const [whole, setWhole] = useState(false),
		[copy, setCopy] = useState<string | null>(null),
		[path, setPath] = useState<string | null>(null);
	const [feedback, setFeedback] = useState<string | null>(null),
		[menu, setMenu] = useState(false);
	const root = useRef<HTMLElement>(null),
		toggle = useRef<HTMLButtonElement>(null),
		field = useRef<HTMLTextAreaElement>(null);
	const edited = copy !== null && !samePlanText(copy, text),
		lines = planLineCount(text),
		changes = useRevision(text, base);
	// The copy is compared while the request lives; the poll is a stat in main and stops with the card.
	useEffect(() => {
		let alive = true;
		const read = () => {
			void window.brigadir.readPlanFile(task, request.id, text).then(
				(value) => {
					if (alive) {
						setCopy(value.text);
						setPath(value.path);
					}
				},
				() => {}
			);
		};
		read();
		const timer = setInterval(read, 1500);
		window.addEventListener('focus', read);
		return () => {
			alive = false;
			clearInterval(timer);
			window.removeEventListener('focus', read);
		};
	}, [task.projectId, task.id, request.id, text]);
	useEffect(() => {
		if (feedback !== null) field.current?.focus();
	}, [feedback !== null]);
	const open = () => {
		void window.brigadir
			.openPlanFile(task, request.id, text)
			.then((document) => {
				setPath(document.path);
				return openTaskEditor(task, document, 1);
			})
			.catch(() => copyFailed(locale, open));
	};
	// spec/chat-turns-plans-and-questions#plan-approval: an option from the chevron is the person's own choice and asks for no mode back.
	const answer = (optionId: string, returnMode?: string | null) => {
		setMenu(false);
		void send({
			kind: 'answerPermission',
			id: request.id,
			optionId,
			...(returnMode ? { returnMode } : {}),
		});
	};
	const rejectWith = async (prompt: string) => {
		if (!reject) return;
		if (await send({ kind: 'answerPermission', id: request.id, optionId: reject.id }))
			await send({ kind: 'prompt', text: prompt });
	};
	const submitFeedback = () => {
		const value = feedback?.trim();
		if (!value) return;
		setFeedback(null);
		void rejectWith(planFeedbackPrompt(value));
	};
	return (
		<section
			ref={root}
			className={styles.card}
			aria-label={t(locale, 'Plan for approval')}
			data-plan-approval={request.id}
			data-edited={edited || undefined}>
			<header className={styles.head} data-size="m">
				<span className={styles.wait} aria-hidden="true" />
				<Glyph name="plan-document" size={14} />
				<strong>{t(locale, 'Plan for approval')}</strong>
				{edited ? (
					<span className={styles.badge}>{t(locale, 'edited in the editor')}</span>
				) : (
					agent && (
						<small className={styles.hint}>
							{t(locale, '{agent} is waiting for approval').replace('{agent}', agent)}
						</small>
					)
				)}
				<span className={styles.space} />
				<Button
					className={styles.open}
					title={t(locale, 'Open {file} in the editor').replace(
						'{file}',
						path?.split('/').at(-1) ?? '.md'
					)}
					onClick={open}>
					<Glyph name="external" size={12} />
					{t(locale, 'Open in editor')}
				</Button>
			</header>
			{changes.view ? (
				<RevisionBody
					id={`plan-approval-${request.id}`}
					text={text}
					task={task}
					locale={locale}
					revision={revision}
					base={base?.base ?? null}
					view={changes.view}
					mode={changes.mode}
					setMode={changes.setMode}
					whole={whole}
					setWhole={setWhole}
					foldable
					tag={<span className={styles.badge}>{t(locale, 'Rewritten')}</span>}
				/>
			) : (
				<>
					<PlanBody
						id={`plan-approval-${request.id}`}
						text={text}
						task={task}
						locale={locale}
						revision={revision}
						folded={!whole && lines > 10}
					/>
					{lines > 10 && (
						<Button
							size="s"
							appearance="primary"
							variant="ghost"
							className={styles.whole}
							aria-expanded={whole}
							onClick={() => setWhole((value) => !value)}>
							{whole
								? t(locale, 'Collapse plan')
								: t(locale, 'Whole plan · {n}').replace('{n}', planLinesLabel(locale, lines))}
						</Button>
					)}
				</>
			)}
			{feedback !== null ? (
				<form
					className={styles.feedback}
					onSubmit={(event) => {
						event.preventDefault();
						submitFeedback();
					}}>
					<label htmlFor={`plan-feedback-${request.id}`}>
						{t(locale, 'What should change in the plan?')}
					</label>
					<TextArea
						ref={field}
						id={`plan-feedback-${request.id}`}
						rows={2}
						value={feedback}
						onChange={(event) => setFeedback(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === 'Escape') {
								event.preventDefault();
								event.stopPropagation();
								setFeedback(null);
							} else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
								event.preventDefault();
								submitFeedback();
							}
						}}
					/>
					<div className={styles.actions} data-size="m">
						<small>{shortcutHint(locale, '⌘↩ send · Esc cancel')}</small>
						<span className={styles.space} />
						<Button onClick={() => setFeedback(null)}>{t(locale, 'Cancel')}</Button>
						<Button appearance="primary" type="submit" disabled={disabled || !feedback.trim()}>
							{t(locale, 'Send to the agent')}
						</Button>
					</div>
				</form>
			) : (
				<footer className={styles.foot} data-size="m">
					<small className={styles.path} title={path ?? undefined}>
						{path?.split('/').at(-1)}
					</small>
					{reject && (
						<Button
							variant="ghost"
							disabled={disabled}
							title={t(locale, 'Reject the plan and tell the agent what to change')}
							onClick={() => setFeedback('')}>
							{t(locale, 'Plan further…')}
						</Button>
					)}
					{edited
						? reject && (
								<Button
									appearance="primary"
									disabled={disabled}
									onClick={() => {
										if (copy) void rejectWith(planEditsPrompt(copy));
									}}>
									{t(locale, 'Send edits')}
								</Button>
							)
						: approve && (
								<SplitButton
									appearance="primary"
									disabled={disabled}
									onClick={() => answer(approve.id, choice?.returnMode)}
									second={
										allow.length > 1
											? {
													label: t(locale, 'How to approve'),
													ref: toggle,
													expanded: menu,
													onClick: () => setMenu((value) => !value),
												}
											: undefined
									}
									menu={
										<MenuPopover
											open={menu}
											onClose={() => setMenu(false)}
											anchor={toggle}
											side="top"
											align="end"
											width={330}
											label={t(locale, 'How to approve')}
											title={t(locale, 'How to approve · the agent’s options')}
											locale={locale}>
											{allow.map((option) => (
												<MenuItem
													key={option.id}
													kind="radio"
													checked={option.id === approve.id}
													onSelect={() => answer(option.id)}>
													{option.name}
												</MenuItem>
											))}
										</MenuPopover>
									}>
									{t(locale, 'Approve plan')}
								</SplitButton>
							)}
				</footer>
			)}
		</section>
	);
}

/** spec/chat-turns-plans-and-questions#plan-approval: after the answer the card folds into one row; the chevron opens the plan read-only. */
export function PlanApprovalSummary({
	request,
	text,
	approved,
	mode,
	feedback,
	at,
	task,
	locale,
	revision,
	base,
	open,
	onToggle,
}: {
	request: PermissionRequest;
	text: string;
	/** spec/chat-turns-plans-and-questions#plan-revisions */
	base?: PlanRevisionBase;
	approved: boolean;
	mode: string | null;
	feedback: string | null;
	at: string;
	task: AgentTask;
	locale: Locale;
	revision: number;
	open: boolean;
	onToggle(event: React.SyntheticEvent<HTMLDetailsElement>): void;
}) {
	const changes = useRevision(text, base),
		[whole, setWhole] = useState(false);
	const openFile = () => {
		void window.brigadir
			.openPlanFile(task, request.id, text)
			.then((document) => openTaskEditor(task, document, 1))
			.catch(() => copyFailed(locale, openFile));
	};
	const openCopy = (event: React.MouseEvent) => {
		event.preventDefault();
		event.stopPropagation();
		openFile();
	};
	return (
		<details
			className={styles.summary}
			data-plan-approval-summary={approved ? 'approved' : 'revision'}
			open={open}
			onToggle={onToggle}>
			<summary>
				{approved ? <Glyph name="agent-idle" size={13} /> : <Glyph name="undo" size={13} />}
				<strong>{t(locale, approved ? 'The plan is approved' : 'Plan in revision')}</strong>
				<span className={styles.title}>{planTitle(text)}</span>
				{approved && mode && <small className={styles.mode}>· {mode}</small>}
				<span className={styles.space} />
				<small className={styles.time}>{formatTime(at)}</small>
				<IconButton size="s" label={t(locale, 'Open in editor')} onClick={openCopy}>
					<Glyph name="external" size={12} />
				</IconButton>
				<Chevron />
			</summary>
			{!approved && feedback && <blockquote className={styles.quote}>{feedback}</blockquote>}
			{open &&
				(changes.view ? (
					<RevisionBody
						id={`plan-summary-${request.id}`}
						text={text}
						task={task}
						locale={locale}
						revision={revision}
						base={base?.base ?? null}
						view={changes.view}
						mode={changes.mode}
						setMode={changes.setMode}
						whole={whole}
						setWhole={setWhole}
						foldable={false}
						tag={<span className={styles.badge}>{t(locale, 'Rewritten')}</span>}
					/>
				) : (
					<PlanBody
						id={`plan-summary-${request.id}`}
						text={text}
						task={task}
						locale={locale}
						revision={revision}
						folded={false}
					/>
				))}
		</details>
	);
}

/** spec/chat-turns-plans-and-questions#plan-row: the whole plan under the agent's checklist, read-only in the chat — the body and `Collapse plan` of the plan card. */
export function PlanReadOnly({
	id,
	text,
	task,
	locale,
	revision,
	onCollapse,
}: {
	id: string;
	text: string;
	task: AgentTask;
	locale: Locale;
	revision: number;
	onCollapse(): void;
}) {
	return (
		<section className={styles.card} aria-label={t(locale, 'Plan')} data-plan-read-only>
			<PlanBody
				id={`plan-read-${id}`}
				text={text}
				task={task}
				locale={locale}
				revision={revision}
				folded={false}
			/>
			<Button
				size="s"
				appearance="primary"
				variant="ghost"
				className={styles.whole}
				aria-expanded
				onClick={onCollapse}>
				{t(locale, 'Collapse plan')}
			</Button>
		</section>
	);
}

/** spec/chat-turns-plans-and-questions#plan-approval: a plan document the agent is still writing, before it asks (Codex). */
export function PlanDocument({
	planId,
	text,
	task,
	locale,
	revision,
}: {
	planId: string;
	text: string;
	task: AgentTask;
	locale: Locale;
	revision: number;
}) {
	const agent = task.provider ? providerName(task.provider) : '';
	return (
		<section className={styles.card} aria-label={t(locale, 'Plan')} data-plan-document={planId}>
			<header className={styles.head} data-size="m">
				<span className={styles.spinner} aria-hidden="true" />
				<strong>{t(locale, 'Plan')}</strong>
				{agent && (
					<small className={styles.hint}>
						{t(locale, '{agent} is writing…').replace('{agent}', agent)}
					</small>
				)}
			</header>
			<PlanBody
				id={`plan-document-${planId}`}
				text={text}
				task={task}
				locale={locale}
				revision={revision}
				folded={planLineCount(text) > 10}
			/>
		</section>
	);
}

/** spec/chat-turns-plans-and-questions#plan-approval: while the chat is hidden (the plan copy open in the editor), the request stays one row on top with a way back. */
export function PlanApprovalNotice({
	text,
	task,
	locale,
	onChat,
}: {
	text: string;
	task: AgentTask;
	locale: Locale;
	onChat(): void;
}) {
	const agent = task.provider ? providerName(task.provider) : '';
	return (
		<div className={styles.notice} data-plan-approval-notice>
			<span className={styles.wait} aria-hidden="true" />
			<strong>{t(locale, 'Plan for approval')}</strong>
			<span className={styles.title}>{planTitle(text)}</span>
			{agent && (
				<small className={styles.hint}>
					{t(locale, '{agent} is waiting for approval').replace('{agent}', agent)}
				</small>
			)}
			<span className={styles.space} />
			<Button onClick={onChat}>
				<Glyph name="chat" size={12} />
				{t(locale, 'Back to chat')}
			</Button>
		</div>
	);
}
