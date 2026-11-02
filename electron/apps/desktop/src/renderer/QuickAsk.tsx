import {
	useEffect,
	useMemo,
	useRef,
	useState,
	type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import {
	modelDisplayName,
	providerName,
	quotaProviders,
	selectOption,
	type AgentOption,
	type QuickAskChoice,
	type AgentProvider,
	formatAccelerator,
	formatDuration,
	quickAskChangedLabel,
	quickAskSuggestions,
	t,
	type SessionEvent,
	type AgentTask,
	type ChangeRange,
	type Locale,
	type QuickAskFile,
	type QuickAskSuggestion,
} from '@brigadir/core';
import { MarkdownBlock, markdown } from './MarkdownBlock';
import { TextArea } from './ui/Input';
import { Button } from './ui/Controls';
import { Glyph } from './ui/Glyph';
import { NoticeLabel } from './ui/NoticeChip';
import { ComposerOptions, type CapsuleModelGroup } from './ComposerOptions';
import { useQuota } from './Quota';
import { limitMinutes, rateResetLabel } from './RateLimit';
import { CodeQuote } from './ui/CodeQuote';
import { PopupClose } from './ui/PopupClose';
import { useSecondTick } from './ui/second-tick';
import {
	closeQuick,
	followQuick,
	markApplied,
	markReverted,
	sameQuickChoice,
	type QuickThread,
	type QuickTurn,
} from './quick-ask-store';
import styles from './QuickAsk.module.css';
/** What the surface under the popover can do with a suggestion; absent in the diff (spec/composer-steering-queue-and-ghost#quick-question). */
export type QuickApply = {
	lines(start: number, end: number): string | null;
	replace(start: number, end: number, text: string): boolean;
};
type Segment =
	| { kind: 'markdown'; text: string }
	| { kind: 'replace'; index: number; suggestion: QuickAskSuggestion };
/** Markdown with ```replace a-b blocks cut out as their own pieces, in order. */
function segments(answer: string): Segment[] {
	const out: Segment[] = [],
		pattern =
			/^(`{3,}|~{3,})[ \t]*replace[ \t]+\d+(?:[ \t]*[-–][ \t]*\d+)?[ \t]*\n[\s\S]*?^\1[ \t]*$/gm;
	let at = 0,
		index = 0;
	for (const match of answer.matchAll(pattern)) {
		const [suggestion] = quickAskSuggestions(match[0]);
		if (!suggestion) continue;
		if (match.index > at) out.push({ kind: 'markdown', text: answer.slice(at, match.index) });
		out.push({ kind: 'replace', index: index++, suggestion });
		at = match.index + match[0].length;
	}
	if (at < answer.length) out.push({ kind: 'markdown', text: answer.slice(at) });
	return out;
}
function Markdown({
	text,
	id,
	task,
	locale,
	revision,
}: {
	text: string;
	id: string;
	task: AgentTask;
	locale: Locale;
	revision: number;
}) {
	const tokens = useMemo(() => markdown.parse(text, {}), [text]),
		html = useMemo(() => markdown.renderer.render(tokens, markdown.options, {}), [tokens]);
	return (
		<MarkdownBlock
			rowId={id}
			html={html}
			tokens={tokens}
			locale={locale}
			task={task}
			revision={revision}
			className={styles.markdown}
		/>
	);
}
const fileName = (path: string) => path.split('/').at(-1) ?? path;
type ModelOption = Extract<AgentOption, { kind: 'select' }>;
/** spec/composer-steering-queue-and-ghost#quick-question: each provider's model option from its catalog — undefined while it loads, null without one. */
export function useModelCatalogs() {
	const [catalogs, setCatalogs] = useState<Partial<Record<AgentProvider, ModelOption | null>>>({});
	useEffect(() => {
		let active = true;
		for (const provider of quotaProviders)
			void window.brigadir.readProviderCatalog(provider).then(
				(value) => {
					if (active)
						setCatalogs((all) => ({
							...all,
							[provider]: selectOption(value?.options ?? [], 'model') ?? null,
						}));
				},
				() => {
					if (active) setCatalogs((all) => ({ ...all, [provider]: null }));
				}
			);
		return () => {
			active = false;
		};
	}, []);
	return catalogs;
}
export function QuickAskPopover({
	thread,
	task,
	locale,
	label,
	quote,
	apply,
	onClose,
	onAsk,
	onNew,
	onHand,
	onViewDiff,
}: {
	thread: QuickThread | null;
	task: AgentTask;
	locale: Locale;
	label: string;
	/** spec/diff-and-review#diff-selection: the selected code, quoted under the header as in a review comment. */
	quote: { text: string; path: string };
	apply?: QuickApply | undefined;
	onClose(): void;
	onAsk(question: string, choice: QuickAskChoice): void;
	onNew(): void;
	/** spec/composer-steering-queue-and-ghost#quick-question: the surface puts a pill of the lines into the composer, then this text. */ onHand(
		text: string
	): void;
	onViewDiff(file: QuickAskFile, range: ChangeRange): void;
}) {
	const [draft, setDraft] = useState('');
	// spec/composer-steering-queue-and-ghost#quick-question: the capsule's choice; a null model is the one the provider would run — the task's for its own.
	const taskProvider: AgentProvider = task.provider ?? 'claude',
		taskOption = selectOption(task.agentOptions ?? [], 'model');
	const [pick, setPick] = useState<{ provider: AgentProvider; model: string | null }>(() => ({
		provider: thread?.choice.provider ?? taskProvider,
		model: thread?.choice.model ?? null,
	}));
	const catalogs = useModelCatalogs();
	const modelsOf = (provider: AgentProvider) =>
		catalogs[provider] ?? (provider === taskProvider ? taskOption : catalogs[provider]);
	const inherited = (provider: AgentProvider) =>
		(provider === taskProvider ? taskOption?.value : undefined) ??
		modelsOf(provider)?.value ??
		null;
	const describe = (choice: QuickAskChoice) => {
		const provider = choice.provider ?? taskProvider,
			value = choice.model ?? inherited(provider);
		const name = modelsOf(provider)?.choices.find((item) => item.value === value)?.name ?? value;
		return { provider, value, name };
	};
	const picked = describe({
		provider: pick.provider,
		...(pick.model ? { model: pick.model } : {}),
	});
	// Sent normalized: the task's own provider and model is `{}`, so the session forks and mirrors the task's options.
	const choice: QuickAskChoice =
		pick.provider === taskProvider && picked.value === inherited(taskProvider)
			? {}
			: { provider: pick.provider, ...(picked.value ? { model: picked.value } : {}) };
	const sameChoice = !thread || sameQuickChoice(thread.choice, choice);
	const quota = useQuota();
	const field = useRef<HTMLTextAreaElement>(null);
	const root = useRef<HTMLElement>(null);
	const turns = thread?.turns ?? [],
		current = turns.at(-1),
		busy = current?.status === 'starting' || current?.status === 'writing';
	// A used-up subscription limit: the failed turn's reset, else the account's exhausted window (spec/agents-and-providers#quota-sources).
	const failed = current?.error?.quota ? current : null,
		failedProvider =
			failed && thread ? (failed.provider ?? describe(thread.choice).provider) : null;
	const exhausted = (provider: AgentProvider) =>
		quota?.providers
			.find((entry) => entry.provider === provider)
			?.windows.filter(
				(window) =>
					window.exhausted && window.resetsAt !== null && window.resetsAt * 1000 > Date.now()
			)
			.map((window) => window.resetsAt!)
			.sort((a, b) => a - b)[0] ?? null;
	const limits = new Map<AgentProvider, number | null>();
	for (const provider of quotaProviders) {
		const reset = exhausted(provider);
		if (reset !== null) limits.set(provider, reset);
	}
	if (failedProvider)
		limits.set(failedProvider, failed!.error!.resetsAt ?? limits.get(failedProvider) ?? null);
	const now = useSecondTick(limits.size > 0);
	for (const [provider, reset] of limits)
		if (reset !== null && reset * 1000 <= now) limits.delete(provider);
	const groups: CapsuleModelGroup[] = quotaProviders.flatMap((provider) => {
		const loaded = catalogs[provider],
			option = loaded ?? (provider === taskProvider ? taskOption : undefined);
		if (loaded === null && !option) return [];
		return [
			{
				provider,
				name: providerName(provider),
				choices: option
					? option.choices.map(({ value, name, description }) => ({ value, name, description }))
					: null,
				task: provider === taskProvider ? inherited(provider) : null,
				limit: limits.has(provider)
					? t(locale, 'Limit · {time}').replace(
							'{time}',
							limitMinutes(locale, limits.get(provider) ?? null)
						)
					: null,
			},
		];
	});
	const capsule = (
		<ComposerOptions
			provider={pick.provider}
			locale={locale}
			disabled={busy || Boolean(thread?.permission)}
			models={{
				groups,
				provider: pick.provider,
				value: picked.value ?? '',
				label: picked.name ?? '',
				loading: !picked.name,
				note: '',
				onChoose: (provider, model) => setPick({ provider, model }),
			}}
		/>
	);
	const pickedAgent =
		failedProvider && failedProvider === pick.provider && picked.name
			? modelDisplayName(picked.name, pick.provider)
			: providerName(pick.provider);
	useEffect(() => {
		field.current?.focus({ preventScroll: true });
		root.current?.scrollIntoView({ block: 'nearest' });
	}, []);
	useEffect(() => {
		if (current?.status === 'done' || current?.status === 'failed')
			field.current?.focus({ preventScroll: true });
	}, [current?.status]);
	// The newest turn stays in view while it streams, unless the person scrolled up to read.
	const list = useRef<HTMLDivElement>(null),
		pinned = useRef(true);
	useEffect(() => {
		const node = list.current;
		if (node && pinned.current) node.scrollTop = node.scrollHeight;
	}, [turns.length, current?.answer, current?.status, current?.changes, thread?.permission]);
	const close = () => {
		if (thread) closeQuick(thread);
		onClose();
	};
	const send = () => {
		const question = draft.trim();
		if (!question || busy) return;
		setDraft('');
		if (thread?.live && turns.length && sameChoice) void followQuick(thread, question);
		else onAsk(question, choice);
	};
	const key = (event: ReactKeyboardEvent) => {
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			close();
		} else if (
			event.key === 'Enter' &&
			(event.metaKey || event.ctrlKey) &&
			(event.target as HTMLElement).tagName === 'TEXTAREA'
		) {
			event.preventDefault();
			event.stopPropagation();
			send();
		}
	};
	const reopened = Boolean(thread && !thread.live && turns.length && current?.status !== 'failed');
	const hint = thread?.lockedBy ? (
		<p className={styles.locked}>
			{t(locale, '“{task}” holds the repo. The agent only answers.').replace(
				'{task}',
				thread.lockedBy
			)}
		</p>
	) : null;
	const hand = () => {
		if (!current || !thread) return;
		closeQuick(thread);
		onHand(quickHandText(current.question, current.answer));
	};
	return (
		<section
			ref={root}
			data-quick-ask
			// spec/appearance#chat-text-size: Quick ask is a chat too; it takes the chat's text size.
			data-chat-text
			role="dialog"
			aria-label={t(locale, 'Ask the agent')}
			className={styles.popover}
			onKeyDown={key}>
			<header className={styles.header}>
				<span className={styles.spark}>
					<Glyph name="generate" size={13} />
				</span>
				<strong>{t(locale, 'Ask the agent')}</strong>
				<span className={styles.where} title={label}>
					{label}
				</span>
				<span className={styles.grow} />
				<span className={styles.chip}>{t(locale, 'outside the task chat')}</span>
				<PopupClose locale={locale} close={close} />
			</header>
			<CodeQuote text={quote.text} path={quote.path} locale={locale} />
			{turns.length === 0 ? (
				<>
					<TextArea
						ref={field}
						embedded
						rows={2}
						className={styles.field}
						aria-label={t(locale, 'Question to the agent')}
						placeholder={t(locale, 'What do you want to know about these lines?')}
						maxLength={4000}
						value={draft}
						onChange={(event) => setDraft(event.target.value)}
					/>
					{hint}
					<footer className={styles.footer} data-size="s">
						{capsule}
						<span className={styles.grow} />
						<kbd className={styles.kbd}>{formatAccelerator('CmdOrCtrl+Enter')}</kbd>
						<Button appearance="primary" disabled={!draft.trim()} onClick={send}>
							{t(locale, 'Ask')}
						</Button>
					</footer>
				</>
			) : (
				<>
					<div
						ref={list}
						className={styles.thread}
						onScroll={(event) => {
							const node = event.currentTarget;
							pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
						}}>
						{turns.map((turn, index) => (
							<Turn
								key={index}
								index={index}
								turn={turn}
								thread={thread!}
								task={task}
								locale={locale}
								apply={apply}
								session={turn.session ? describe(turn.session) : null}
								retry={
									index === turns.length - 1 && turn.error
										? turn.error.quota
											? {
													limit: limits.has(failedProvider!)
														? (limits.get(failedProvider!) ?? null)
														: undefined,
													agent: providerName(failedProvider!),
													other: sameChoice ? null : pickedAgent,
												}
											: { limit: undefined, agent: null, other: null }
										: null
								}
								onViewDiff={(file, range) => {
									if (thread) closeQuick(thread);
									onViewDiff(file, range);
								}}
								onRetry={() => onAsk(turn.question, choice)}
							/>
						))}
					</div>
					{thread?.permission && <Permission thread={thread} locale={locale} />}
					{reopened ? (
						<footer className={styles.footer} data-size="s">
							<span className={styles.grow} />
							<Button
								onClick={() => {
									setDraft('');
									onNew();
								}}>
								<Glyph name="generate" size={12} />
								{t(locale, 'New question')}
							</Button>
						</footer>
					) : (
						<>
							<div className={styles.more} data-size="s">
								{capsule}
								<TextArea
									ref={field}
									embedded
									rows={1}
									className={styles.field}
									aria-label={t(locale, 'Question to the agent')}
									placeholder={
										sameChoice
											? t(locale, 'Ask more…')
											: t(locale, 'Ask {agent}…').replace('{agent}', providerName(pick.provider))
									}
									maxLength={4000}
									value={draft}
									disabled={busy}
									onChange={(event) => setDraft(event.target.value)}
								/>
							</div>
							{!sameChoice && (
								<p className={styles.hint} data-quick-new-session>
									{t(
										locale,
										'A new {agent} session. It gets the selection, not the answers above.'
									).replace('{agent}', providerName(pick.provider))}
								</p>
							)}
							<footer className={styles.footer} data-size="s">
								<span className={styles.note}>
									{t(locale, 'The answer stays until the window closes.')}
								</span>
								<Button disabled={!current?.answer.trim() || busy} onClick={hand}>
									<Glyph name="send-chat" size={12} />
									{t(locale, 'Hand to the agent')}
								</Button>
							</footer>
						</>
					)}
				</>
			)}
		</section>
	);
}
function Turn({
	turn,
	index,
	thread,
	task,
	locale,
	apply,
	session,
	retry,
	onViewDiff,
	onRetry,
}: {
	turn: QuickTurn;
	index: number;
	thread: QuickThread;
	task: AgentTask;
	locale: Locale;
	apply?: QuickApply | undefined;
	/** The turn began another session: «New session · Codex · GPT-6 Codex» above it. */ session: {
		provider: AgentProvider;
		name: string | null;
	} | null;
	/** The failed last turn's way on; null on any other turn. A used-up limit names the provider and, while it holds
	 *  (`limit`: its reset, null when unknown), keeps «Try again» off; `other` is the capsule's different pick. */ retry: {
		limit: number | null | undefined;
		agent: string | null;
		other: string | null;
	} | null;
	onViewDiff(file: QuickAskFile, range: ChangeRange): void;
	onRetry(): void;
}) {
	const now = useSecondTick(turn.status === 'writing' || turn.status === 'starting');
	const parts = useMemo(() => segments(turn.answer), [turn.answer]);
	// The lines each suggestion replaces, as they were when the answer ended: «Apply» needs them unchanged.
	const baseline = useRef<Record<number, string | null>>({});
	if (turn.status === 'done' && apply)
		for (const part of parts)
			if (part.kind === 'replace' && !(part.index in baseline.current))
				baseline.current[part.index] = apply.lines(part.suggestion.start, part.suggestion.end);
	const provider = providerName(turn.provider ?? thread.provider ?? 'claude');
	return (
		<>
			{session && (
				<div className={styles.divider} data-quick-session>
					{[
						t(locale, 'New session'),
						providerName(session.provider),
						...(session.name ? [modelDisplayName(session.name, session.provider)] : []),
					].join(' · ')}
				</div>
			)}
			<article className={styles.message}>
				<span className={styles.avatar}>{t(locale, 'You').slice(0, 1)}</span>
				<div>
					<strong>{t(locale, 'You')}</strong>
					<p className={styles.question}>{turn.question}</p>
				</div>
			</article>
			<article className={styles.message} data-quick-answer={turn.status}>
				<span className={`${styles.avatar} ${styles.agent}`}>
					<Glyph name="generate" size={9} />
				</span>
				<div className={styles.body}>
					<strong>{t(locale, 'Agent')}</strong>
					{parts.map((part, at) =>
						part.kind === 'markdown' ? (
							<Markdown
								key={at}
								text={part.text}
								id={`quick:${thread.id}:${index}:${at}`}
								task={task}
								locale={locale}
								revision={turn.answer.length}
							/>
						) : (
							<Suggestion
								key={at}
								part={part.suggestion}
								block={part.index}
								turn={turn}
								turnIndex={index}
								thread={thread}
								locale={locale}
								apply={turn.status === 'done' ? apply : undefined}
								baseline={baseline.current[part.index]}
							/>
						)
					)}
					{turn.changes?.files.map((file) => (
						<Change
							key={file.fileId}
							file={file}
							range={turn.changes!.range}
							state={turn.reverted[file.fileId]}
							locale={locale}
							onView={() => onViewDiff(file, turn.changes!.range)}
							onRevert={() => {
								void window.brigadir
									.revertQuickChange(thread.key, file.fileId, turn.changes!.range)
									.then(
										() => markReverted(thread, index, file.fileId, 'done'),
										() => markReverted(thread, index, file.fileId, 'failed')
									);
							}}
						/>
					))}
					{turn.error ? (
						<div className={styles.error} data-quick-error={turn.error.quota ? 'limit' : 'error'}>
							<p>
								{t(locale, 'The agent did not answer: {reason}.').replace(
									'{reason}',
									turn.error.quota
										? t(locale, 'the subscription limit is used up')
										: turn.error.message.replace(/\.$/, '')
								)}
							</p>
							{retry && (
								<div className={styles.retry} data-size="s">
									{retry.agent && retry.limit !== undefined && (
										<NoticeLabel
											icon="agent-hourglass"
											label={t(locale, '{agent} limit · {time}')
												.replace('{agent}', retry.agent)
												.replace('{time}', limitMinutes(locale, retry.limit))}
											title={rateResetLabel(retry.limit, locale)}
											data-quick-limit=""
										/>
									)}
									<span className={styles.grow} />
									{retry.other ? (
										<Button appearance="primary" onClick={onRetry}>
											{t(locale, 'Ask again with {agent}').replace('{agent}', retry.other)}
										</Button>
									) : (
										<Button
											disabled={retry.agent !== null && typeof retry.limit === 'number'}
											onClick={onRetry}>
											{t(locale, 'Try again')}
										</Button>
									)}
								</div>
							)}
							{retry?.agent && !retry.other && (
								<small className={styles.pick}>{t(locale, 'Pick another model below.')}</small>
							)}
						</div>
					) : turn.status === 'done' ? (
						<p className={styles.status}>
							{provider} · {formatDuration(locale, turn.milliseconds ?? 0)}
							{turn.stopped ? ` · ${t(locale, 'The answer was stopped')}` : ''}
						</p>
					) : (
						<p className={styles.status} data-size="s">
							<span className={styles.dot} />
							{t(locale, turn.status === 'starting' ? 'Starting' : 'Writing')} ·{' '}
							{formatDuration(locale, Math.max(0, now - turn.startedAt))}
							{turn.tool ? ` · ${turn.tool}` : ''}
							<span className={styles.grow} />
							<Button
								size="s"
								variant="ghost"
								onClick={() => {
									void window.brigadir.stopQuickQuestion(thread.id).catch(() => {});
								}}>
								<Glyph name="stop" size={12} />
								{t(locale, 'Stop')}
							</Button>
						</p>
					)}
				</div>
			</article>
		</>
	);
}
function Suggestion({
	part,
	block,
	turn,
	turnIndex,
	thread,
	locale,
	apply,
	baseline,
}: {
	part: QuickAskSuggestion;
	block: number;
	turn: QuickTurn;
	turnIndex: number;
	thread: QuickThread;
	locale: Locale;
	apply?: QuickApply | undefined;
	baseline: string | null | undefined;
}) {
	const applied = turn.applied[block] === true,
		old = baseline ?? apply?.lines(part.start, part.end) ?? null;
	const current = apply?.lines(part.start, part.end) ?? null,
		stale = Boolean(apply) && !applied && old !== null && current !== old;
	const removed = (old ?? '').split('\n'),
		added = part.text.split('\n');
	const title = `${fileName(thread.selection.path)} · ${part.start === part.end ? part.start : `${part.start}–${part.end}`}`;
	return (
		<div className={styles.code} data-size="s" data-quick-suggestion>
			<header>
				<span>{title}</span>
				<span className={styles.grow} />
				<Button
					size="s"
					variant="ghost"
					onClick={() => {
						void navigator.clipboard.writeText(part.text).catch(() => {});
					}}>
					<Glyph name="copy" size={12} />
					{t(locale, 'Copy')}
				</Button>
			</header>
			{old !== null &&
				removed.map((line, at) => (
					<div key={`r${at}`} className={styles.line} data-kind="removed">
						<i>−</i>
						{line}
					</div>
				))}
			{added.map((line, at) => (
				<div key={`a${at}`} className={styles.line} data-kind="added">
					<i>+</i>
					{line}
				</div>
			))}
			{apply ? (
				<footer>
					{applied ? (
						<>
							<span className={styles.applied}>
								<Glyph name="tick" size={12} />
								{t(locale, 'Applied to {file}').replace('{file}', fileName(thread.selection.path))}
							</span>
							<Button
								size="s"
								variant="ghost"
								onClick={() => {
									if (
										apply.lines(part.start, part.start + added.length - 1) === part.text &&
										old !== null &&
										apply.replace(part.start, part.start + added.length - 1, old)
									)
										markApplied(thread, turnIndex, block, false);
								}}>
								<Glyph name="undo" size={12} />
								{t(locale, 'Undo the apply')}
							</Button>
						</>
					) : (
						<>
							<Button
								appearance="primary"
								disabled={stale}
								onClick={() => {
									if (apply.replace(part.start, part.end, part.text))
										markApplied(thread, turnIndex, block, true);
								}}>
								<Glyph name="tick" size={12} />
								{t(locale, 'Apply')}
							</Button>
							{stale && (
								<span className={styles.stale}>
									{t(locale, 'The lines changed after the answer. Ask again.')}
								</span>
							)}
						</>
					)}
				</footer>
			) : (
				turn.status === 'done' && (
					<footer>
						<span className={styles.applyHint}>
							{t(locale, 'Open the file in the editor to apply.')}
						</span>
					</footer>
				)
			)}
		</div>
	);
}
function Change({
	file,
	state,
	locale,
	onView,
	onRevert,
}: {
	file: QuickAskFile;
	range: ChangeRange;
	state: 'done' | 'failed' | undefined;
	locale: Locale;
	onView(): void;
	onRevert(): void;
}) {
	if (state === 'done')
		return (
			<div className={styles.change} data-quick-change="reverted">
				<Glyph name="undo" size={12} />
				<span>{t(locale, 'Reverted: {file}').replace('{file}', fileName(file.path))}</span>
			</div>
		);
	return (
		<>
			<div className={styles.change} data-size="s" data-quick-change>
				<Glyph name="file" size={12} />
				<span>
					{t(locale, 'Changed')} <b title={file.path}>{fileName(file.path)}</b>
				</span>
				<span className={styles.added}>+{file.additions}</span>
				<span className={styles.removed}>−{file.deletions}</span>
				<span className={styles.grow} />
				<Button size="s" onClick={onView}>
					{t(locale, 'View diff')}
				</Button>
				<Button size="s" variant="ghost" onClick={onRevert}>
					<Glyph name="undo" size={12} />
					{t(locale, 'Revert')}
				</Button>
			</div>
			{state === 'failed' && (
				<p className={styles.stale}>
					{t(locale, 'The file changed after the question. It cannot be reverted.')}
				</p>
			)}
		</>
	);
}
function Permission({ thread, locale }: { thread: QuickThread; locale: Locale }) {
	const request = thread.permission!;
	const answer = (option: string | null) => {
		void window.brigadir.answerQuickPermission(thread.id, request.id, option).catch(() => {});
	};
	return (
		<div className={styles.permission} data-quick-permission>
			<header>
				<strong>{t(locale, 'Permission')}</strong>
				<span>{request.tool.title ?? request.tool.name ?? ''}</span>
			</header>
			<footer>
				{request.options.map((option, index) => (
					<Button
						key={option.id}
						appearance={
							index === request.options.findIndex((item) => item.kind.startsWith('allow'))
								? 'primary'
								: 'neutral'
						}
						onClick={() => answer(option.id)}>
						{option.name}
					</Button>
				))}
			</footer>
		</div>
	);
}
/** spec/composer-steering-queue-and-ghost#quick-question: the log row of a quick question that changed files; the whole row opens the task diff on its range. */
export function QuickAskLogRow({
	event,
	locale,
	onOpen,
}: {
	event: Extract<SessionEvent, { kind: 'quick-ask.changed' }>;
	locale: Locale;
	onOpen(): void;
}) {
	return (
		<button
			type="button"
			className={styles.logRow}
			data-quick-ask-row
			title={event.question}
			onClick={onOpen}>
			<Glyph name="generate" size={12} />
			<span className={styles.logLabel}>
				{quickAskChangedLabel(locale, event.files.length)}
				<span> · {event.files.map(fileName).join(', ')}</span>
			</span>
			<small>{t(locale, 'View diff')}</small>
		</button>
	);
}
/** spec/composer-steering-queue-and-ghost#quick-question: the composer text after the pill of the lines (rule 12: English for the agent). */
export function quickHandText(question: string, answer: string) {
	return `Quick question about these lines (a separate agent session answered it; the files may already have its change).\nQuestion: ${question}\nAnswer:\n${answer.trim()}`;
}
