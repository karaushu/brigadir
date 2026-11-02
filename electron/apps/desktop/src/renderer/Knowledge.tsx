import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { onSessionEvent } from './session-events';
import {
	t,
	taskCount,
	type Locale,
	type MessageKey,
	type KnowledgeSnapshot,
	type KnowledgeProposal,
	type KnowledgePreview,
	type KnowledgeTarget,
	type AgentTask,
} from '@brigadir/core';
import { Button, Popup } from './ui/Controls';
import { TextInput, TextArea } from './ui/Input';
import { Glyph } from './ui/Glyph';
import { GenerateButton } from './ui/GenerateButton';
import { PopupClose } from './ui/PopupClose';
import { DiffCode } from './ui/DiffCode';
import { usePresence } from './ui/use-presence';
import { useWorkspace } from './store';
import { openTaskQuestion } from './task-state';
import { resolveToast, toastError, toastWarning } from './ui/Toast';
import s from './Knowledge.module.css';
import { SkeletonRows } from './ui/Loading';
const changed = () => window.dispatchEvent(new Event('knowledge:changed'));
/** spec/notifications-slack-notes-and-schedules#message-classes: a failure names its action in both languages; the raw error of main never reaches the interface. */
function fail(
	locale: Locale,
	key: MessageKey,
	options: { retry?: () => void; file?: string } = {}
) {
	const text = options.file ? t(locale, key).replace('{file}', options.file) : t(locale, key);
	toastError(text, {
		bold: options.file,
		action: options.retry ? { label: t(locale, 'Retry'), run: options.retry } : undefined,
	});
}
const drafts = new Map<string, { text: string; target: KnowledgeTarget }>();
export function KnowledgePanel({
	projectId,
	projectName,
	locale,
	tasks,
	expandRequest,
	onCount,
}: {
	projectId: string;
	projectName: string;
	locale: Locale;
	tasks: AgentTask[];
	expandRequest: number;
	onCount(count: number): void;
}) {
	const [data, setData] = useState<KnowledgeSnapshot | null>(null),
		[expanded, setExpanded] = useState<string | null>(null),
		[file, setFile] = useState<{ path: string; text: string } | null>(null),
		active = useRef(true),
		revision = useRef(0),
		readFailed = useRef(false);
	const filePresent = usePresence(Boolean(file)),
		lastFile = useRef(file);
	if (file) lastFile.current = file;
	async function refresh() {
		const id = ++revision.current,
			focused = document.activeElement;
		try {
			const value = await window.brigadir.readKnowledge(projectId);
			if (active.current && revision.current === id) {
				setData(value);
				setExpanded((current) =>
					value.proposals.some((item) => item.state === 'proposed' && item.signature === current)
						? current
						: null
				);
				onCount(value.proposals.filter((item) => item.state === 'proposed').length);
				if (readFailed.current) resolveToast(t(locale, 'Could not read the project knowledge.'));
				readFailed.current = false;
				requestAnimationFrame(() => {
					if (active.current && focused instanceof HTMLElement && !focused.isConnected)
						document
							.querySelector<HTMLElement>('[data-project-screen] button')
							?.focus({ preventScroll: true });
				});
			}
		} catch {
			/* A background read: one warning per failure streak. */ if (
				active.current &&
				!readFailed.current
			) {
				readFailed.current = true;
				toastWarning(t(locale, 'Could not read the project knowledge.'), {
					action: {
						label: t(locale, 'Retry'),
						run: () => {
							void refresh();
						},
					},
				});
			}
		}
	}
	useEffect(() => {
		active.current = true;
		void refresh();
		const listener = () => {
			void refresh();
		};
		window.addEventListener('knowledge:changed', listener);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const stop = onSessionEvent(({ key, record }) => {
			if (key.projectId === projectId && record?.event.kind === 'turn.completed') {
				clearTimeout(timer);
				timer = setTimeout(listener, 300);
			}
		});
		return () => {
			active.current = false;
			revision.current++;
			stop();
			clearTimeout(timer);
			window.removeEventListener('knowledge:changed', listener);
			void window.brigadir.cancelKnowledge(projectId).catch(() => {});
		};
	}, [projectId]);
	useEffect(() => {
		if (expandRequest && data?.proposals.some((item) => item.state === 'proposed'))
			setExpanded(data.proposals.find((item) => item.state === 'proposed')!.signature);
	}, [expandRequest]);
	async function action(work: () => Promise<unknown>, key: MessageKey, file?: string) {
		try {
			await work();
			await refresh();
		} catch {
			if (active.current) fail(locale, key, file ? { file } : {});
		}
	}
	const proposed = data?.proposals.filter((item) => item.state === 'proposed') ?? [];
	if (!proposed.length && !data?.receipts.length) return null;
	return (
		<section
			className={s.band}
			aria-label={t(locale, 'Project knowledge')}
			data-knowledge-band
			tabIndex={0}>
			{proposed.map((proposal) => (
				<KnowledgeCard
					key={proposal.signature}
					projectId={projectId}
					projectName={projectName}
					proposal={proposal}
					scopes={data!.scopes}
					tasks={tasks}
					locale={locale}
					open={expanded === proposal.signature}
					expand={() => {
						void window.brigadir.cancelKnowledge(projectId).catch(() => {});
						setExpanded(proposal.signature);
					}}
					collapse={() => {
						void window.brigadir.cancelKnowledge(projectId).catch(() => {});
						setExpanded(null);
					}}
					refresh={refresh}
				/>
			))}
			{data?.receipts.map((receipt) => (
				<article
					className={s.card}
					key={receipt.id}
					data-size="m"
					data-knowledge-added
					onKeyDown={(event) => {
						if (event.key === 'Escape') {
							event.preventDefault();
							event.stopPropagation();
							void action(
								() => window.brigadir.dismissKnowledge(projectId, receipt.id),
								'Could not close the card.'
							);
						}
					}}>
					<header>
						<Glyph name="check-pass" size={15} />
						<div className={s.copy}>
							<span>
								{t(locale, 'Added to')} <code>{receipt.target.path}</code>
							</span>
							<small>
								{receipt.target.scopeId === data.scopes.find((scope) => scope.name === '.')?.id
									? projectName
									: data.scopes.find((scope) => scope.id === receipt.target.scopeId)?.name}{' '}
								· {t(locale, 'Uncommitted change')}
							</small>
						</div>
						<Button
							onClick={() =>
								void action(
									() => window.brigadir.undoKnowledge(projectId, receipt.id),
									'Could not undo the addition.'
								)
							}>
							{t(locale, 'Undo')}
						</Button>
						<Button
							onClick={() =>
								void action(
									async () => {
										const value = await window.brigadir.readKnowledgeFile(
											projectId,
											receipt.target
										);
										if (value.text === null) throw new Error('The file could not be read.');
										if (active.current) setFile({ path: value.path, text: value.text });
									},
									'Could not open {file}.',
									receipt.target.path.split('/').at(-1) || receipt.target.path
								)
							}>
							{t(locale, 'Show the file')}
						</Button>
						<PopupClose
							locale={locale}
							close={() =>
								void action(
									() => window.brigadir.dismissKnowledge(projectId, receipt.id),
									'Could not close the card.'
								)
							}
						/>
					</header>
					<div className={s.added} tabIndex={0}>
						{receipt.added
							.replace(/\r\n/g, '\n')
							.replace(/\n$/, '')
							.split('\n')
							.map((text, index) => (
								<DiffCode
									key={index}
									line={{ kind: 'added', text, oldLine: null, newLine: null }}
									tokens={[]}
									side="new"
									locale={locale}
									bare
								/>
							))}
					</div>
				</article>
			))}
			{filePresent && lastFile.current && (
				<KnowledgeDialog
					locale={locale}
					title={lastFile.current.path.split('/').at(-1) || lastFile.current.path}
					hint={lastFile.current.path}
					open={Boolean(file)}
					close={() => setFile(null)}>
					<pre className={s.file} tabIndex={0}>
						{lastFile.current.text}
					</pre>
				</KnowledgeDialog>
			)}
		</section>
	);
}
function KnowledgeCard({
	projectId,
	projectName,
	proposal,
	scopes,
	tasks,
	locale,
	open,
	expand,
	collapse,
	refresh,
}: {
	projectId: string;
	projectName: string;
	proposal: KnowledgeProposal;
	scopes: KnowledgeSnapshot['scopes'];
	tasks: AgentTask[];
	locale: Locale;
	open: boolean;
	expand(): void;
	collapse(): void;
	refresh(): Promise<void>;
}) {
	const cacheKey = projectId + '/' + proposal.signature,
		cached = drafts.get(cacheKey),
		[target, setTarget] = useState<KnowledgeTarget>(
			cached?.target ?? {
				scopeId: scopes.find((scope) => scope.name === '.')?.id ?? scopes[0]!.id,
				path: 'CLAUDE.md',
			}
		),
		[text, setText] = useState(cached?.text ?? ''),
		[preview, setPreview] = useState<KnowledgePreview | null>(null),
		[busy, setBusy] = useState(false),
		[generating, setGenerating] = useState(false),
		[showExisting, setShowExisting] = useState(false),
		active = useRef(true),
		failed = useRef(false),
		latest = useRef<{ prepare(generate?: boolean): Promise<void>; reject(): Promise<void> }>({
			prepare: async () => {},
			reject: async () => {},
		}),
		editRevision = useRef(0),
		initial = useRef(false),
		body = useRef<HTMLDivElement>(null);
	useEffect(() => {
		active.current = true;
		return () => {
			active.current = false;
		};
	}, []);
	useEffect(() => {
		drafts.set(cacheKey, { text, target });
		while (drafts.size > 50) drafts.delete(drafts.keys().next().value!);
	}, [text, target]);
	useLayoutEffect(() => {
		if (open && !initial.current) {
			initial.current = true;
			void prepare(!text);
		}
		if (open) body.current?.scrollIntoView({ block: 'nearest' });
	}, [open]);
	// After a failure the next preview opens the current file: the person checks what is there before adding.
	async function prepare(generate = false) {
		if (busy || generating) return;
		setBusy(true);
		const after = failed.current;
		failed.current = false;
		try {
			const value = await window.brigadir.prepareKnowledge(projectId, proposal.signature, target);
			if (!active.current) return;
			setPreview(value);
			if (after) setShowExisting(true);
			if (generate) await write(value);
		} catch {
			if (active.current) {
				failed.current = true;
				fail(locale, 'Could not read the instruction file.', {
					retry: () => {
						void latest.current.prepare(generate);
					},
				});
			}
		} finally {
			if (active.current) setBusy(false);
		}
	}
	async function write(value: KnowledgePreview) {
		setGenerating(true);
		const version = editRevision.current;
		try {
			const result = await window.brigadir.generateKnowledge(
				projectId,
				proposal.signature,
				value.id
			);
			if (active.current && editRevision.current === version) setText(result);
		} catch {
			if (active.current) {
				failed.current = true;
				fail(locale, 'Could not generate the text.', {
					retry: () => {
						void latest.current.prepare(true);
					},
				});
			}
		} finally {
			if (active.current) setGenerating(false);
		}
	}
	async function add() {
		if (!open) {
			expand();
			return;
		}
		if (!preview || busy || generating) return;
		setBusy(true);
		failed.current = false;
		try {
			await window.brigadir.addKnowledge(projectId, proposal.signature, preview.id, text);
			drafts.delete(cacheKey);
			await refresh();
		} catch {
			if (active.current) {
				setPreview(null);
				failed.current = true;
				fail(locale, 'Could not add the text. It is kept.');
			}
		} finally {
			if (active.current) setBusy(false);
		}
	}
	async function reject() {
		setBusy(true);
		try {
			await window.brigadir.rejectKnowledge(projectId, proposal.signature);
			drafts.delete(cacheKey);
			await refresh();
		} catch {
			if (active.current) {
				failed.current = true;
				fail(locale, 'Could not reject the proposal.', {
					retry: () => {
						void latest.current.reject();
					},
				});
			}
		} finally {
			if (active.current) setBusy(false);
		}
	}
	// Retry from a toast runs the current render's action: the destination may have changed since.
	latest.current = { prepare, reject };
	const sourceTasks = new Set(proposal.sources.map((item) => item.taskId)).size;
	return (
		<article className={s.card} data-size="m" data-knowledge-card>
			<header>
				<Glyph name="knowledge" size={15} />
				<div className={s.copy}>
					<span>
						{t(locale, 'Repeated question')} · {taskCount(locale, sourceTasks)}
					</span>
					<small>{proposal.sources[0]?.question}</small>
					{!open && (
						<small>
							{t(locale, 'Add the answer to the project instructions so future tasks can use it.')}
						</small>
					)}
				</div>
				<Button aria-expanded={open} onClick={open ? collapse : expand}>
					<span className={s.chevron} data-open={open}>
						<Glyph name="knowledge-disclosure" size={10} />
					</span>
					{t(locale, open ? 'Collapse' : 'Show text')}
				</Button>
				{!open && (
					<>
						<Button disabled={busy} onClick={() => void reject()}>
							{t(locale, 'Reject')}
						</Button>
						<Button disabled={busy} onClick={() => void add()}>
							{t(locale, 'Add')}
						</Button>
					</>
				)}
			</header>
			<div className={s.reveal} data-open={open} inert={!open} aria-hidden={!open}>
				<div>
					<div ref={body} className={s.body}>
						<div className={s.destination}>
							<span>{t(locale, 'Destination')}</span>
							<Popup
								label={t(locale, 'Repo')}
								value={target.scopeId}
								disabled={busy || generating}
								options={scopes.map((scope) => ({
									value: scope.id,
									label: scope.name === '.' ? projectName : scope.name,
								}))}
								onChange={(value) => {
									setTarget({ ...target, scopeId: value });
									setPreview(null);
								}}
							/>
							<TextInput
								aria-label={t(locale, 'Instruction file')}
								value={target.path}
								disabled={busy || generating}
								onChange={(event) => {
									setTarget({ ...target, path: event.target.value });
									setPreview(null);
								}}
							/>
							<small>
								{t(locale, 'At the end of the file')}
								{preview && !preview.exists ? ` · ${t(locale, 'New file')}` : ''}
							</small>
						</div>
						{preview && preview.exists && (
							<div className={s.current}>
								<Button
									size="s"
									aria-expanded={showExisting}
									onClick={() => setShowExisting((value) => !value)}>
									{t(locale, 'Current file')}
								</Button>
								<div
									className={s.reveal}
									data-open={showExisting}
									inert={!showExisting}
									aria-hidden={!showExisting}>
									<div>
										<pre className={s.existing} tabIndex={0}>
											{preview.text}
										</pre>
									</div>
								</div>
							</div>
						)}
						<TextArea
							rows={7}
							className={s.editor}
							aria-label={t(locale, 'Addition')}
							value={text}
							onChange={(event) => {
								editRevision.current++;
								setText(event.target.value);
							}}
						/>
						{/* spec/projects-and-board#screen-layout: the note and the footer are S rows. */}
						<div className={s.note} data-size="s">
							<small>
								{t(
									locale,
									'An agent writes this text using your subscription. You can edit it before adding.'
								)}
							</small>
							<GenerateButton
								busy={generating}
								disabled={busy || generating}
								label={t(locale, 'Generate again')}
								onClick={() => void prepare(true)}
							/>
						</div>
						<div className={s.sources}>
							<small>{t(locale, 'Sources')}</small>
							{proposal.sources.map((source) => {
								const task = tasks.find((task) => task.id === source.taskId);
								return (
									<Button
										key={source.taskId + '/' + source.questionId}
										size="s"
										disabled={!task}
										title={source.answer}
										onClick={() => {
											if (task)
												void openTaskQuestion(task, source.turn)
													.then(() => useWorkspace.getState().selectTask(task.projectId, task.id))
													.catch(() => fail(locale, 'Could not open the task.'));
										}}>
										<Glyph name="person" size={12} />
										<span>{task?.title ?? source.taskId}</span>
										<small>
											{t(locale, 'Turn')} {source.turn} · {source.question}
										</small>
										<Glyph name="tree-right" size={9} />
									</Button>
								);
							})}
						</div>
						<footer data-size="s">
							<code>
								{target.scopeId === scopes.find((scope) => scope.name === '.')?.id
									? projectName
									: scopes.find((scope) => scope.id === target.scopeId)?.name}{' '}
								/ {target.path}
							</code>
							{!preview && (
								<Button disabled={busy || generating} onClick={() => void prepare()}>
									{t(locale, 'Refresh the preview')}
								</Button>
							)}
							<Button disabled={busy || generating} onClick={() => void reject()}>
								{t(locale, 'Reject')}
							</Button>
							<Button
								appearance="primary"
								disabled={!preview || !text.trim() || busy || generating}
								onClick={() => void add()}>
								{t(locale, 'Add')}
							</Button>
						</footer>
					</div>
				</div>
			</div>
		</article>
	);
}
export function RejectedKnowledge({
	projectId,
	locale,
	open,
	close,
}: {
	projectId: string;
	locale: Locale;
	open: boolean;
	close(): void;
}) {
	const [data, setData] = useState<KnowledgeSnapshot | null>(null),
		[error, setError] = useState<MessageKey | null>(null),
		[busy, setBusy] = useState(false),
		active = useRef(true);
	async function refresh() {
		try {
			const value = await window.brigadir.readKnowledge(projectId);
			if (active.current) setData(value);
		} catch {
			if (active.current) setError('Could not read the rejected proposals.');
		}
	}
	useEffect(() => {
		void refresh();
		return () => {
			active.current = false;
		};
	}, [projectId]);
	return (
		<KnowledgeDialog
			locale={locale}
			title={t(locale, 'Project knowledge')}
			open={open}
			close={close}>
			{error && (
				<p role="alert" className={s.error}>
					{t(locale, error)}
				</p>
			)}
			{!data ? (
				<SkeletonRows count={4} height={34} />
			) : !data.proposals.some((item) => item.state === 'rejected') ? (
				<p>{t(locale, 'No rejected proposals')}</p>
			) : (
				<div aria-label={t(locale, 'Rejected proposals')}>
					{data.proposals
						.filter((item) => item.state === 'rejected')
						.map((item) => (
							<div className={s.rejected} key={item.signature}>
								<span>{item.sources[0]?.question ?? item.signature}</span>
								<Button
									size="s"
									disabled={busy}
									onClick={() => {
										setBusy(true);
										setError(null);
										void window.brigadir
											.restoreKnowledge(projectId, item.signature)
											.then(async () => {
												await refresh();
												changed();
											})
											.catch(() => {
												if (active.current) setError('Could not restore the proposal.');
											})
											.finally(() => {
												if (active.current) setBusy(false);
											});
									}}>
									{t(locale, 'Restore')}
								</Button>
							</div>
						))}
				</div>
			)}
		</KnowledgeDialog>
	);
}
function KnowledgeDialog({
	locale,
	title,
	hint,
	open,
	close,
	children,
}: {
	locale: Locale;
	title: string;
	/** spec/projects-and-board#screen-layout: the dialog names the file; its full path is the title's tooltip. */
	hint?: string;
	open: boolean;
	close(): void;
	children: ReactNode;
}) {
	const dialog = useRef<HTMLDialogElement>(null),
		previous = useRef<Element | null>(null);
	useEffect(() => {
		const element = dialog.current!;
		if (open) {
			previous.current = document.activeElement;
			element.showModal();
		} else element.close();
		return () => {
			element.close();
			if (previous.current instanceof HTMLElement && previous.current.isConnected)
				previous.current.focus({ preventScroll: true });
		};
	}, [open]);
	return (
		<dialog
			ref={dialog}
			className={s.dialog}
			aria-label={title}
			onCancel={(event) => {
				event.preventDefault();
				close();
			}}>
			<header>
				<h2 title={hint}>{title}</h2>
				<PopupClose locale={locale} close={close} />
			</header>
			{children}
		</dialog>
	);
}
