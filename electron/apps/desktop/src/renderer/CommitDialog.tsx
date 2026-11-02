import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import {
	addBasket,
	applyProposal,
	basketLabels,
	basketOf,
	basketScopes,
	commitCount,
	commitPlan,
	fileCount,
	fileKey,
	formatAccelerator,
	initialBaskets,
	moveFiles,
	reconcileBaskets,
	removeBasket,
	scopeCount,
	setBasketMessage,
	t,
	takeOut,
	type AgentTask,
	type BasketFile,
	type CommitBasket,
	type CommitFile,
	type CommitPreview,
	type FileDiff,
	type Locale,
} from '@brigadir/core';
import { useTaskState } from './task-state';
import { onSessionEvent } from './session-events';
import {
	useCommitRuns,
	runCommitBaskets,
	clearCommitRun,
	pushRepos,
	type CommitStep,
} from './commit-run';
import { useForge } from './Forge';
import { ModalDialog } from './ui/ModalDialog';
import { Button, Choice, IconButton } from './ui/Controls';
import { TextArea } from './ui/Input';
import { Glyph } from './ui/Glyph';
import { GenerateButton } from './ui/GenerateButton';
import { HelperSplit, helperShown, useHelperRun } from './HelperAgent';
import { Banner } from './ui/Banner';
import { FileListBox } from './ui/FileListBox';
import { FileIcon } from './ui/FileIcon';
import { ChangeCounts } from './ui/ChangeCounts';
import { DiffCode } from './ui/DiffCode';
import { MenuItem, MenuPopover, MenuSeparator, Popover } from './ui/Popover';
import { primaryKey } from './ui/primary-key';
import { toastError } from './ui/Toast';
import { lineTokens } from './syntax';
import styles from './CommitDialog.module.css';
import { SkeletonText } from './ui/Loading';

/**
 * spec/appearance#evolution-redesign, spec/git#commit-dialog: the commit dialog with baskets. Left — the changed files of the task's repos, each with the
 * basket it goes in; right — the baskets, one future commit each, with a message, ✦ and file chips. Files move by drag or
 * by selection and «Move N to»; «Split with the agent» proposes baskets only on the person's click, with Undo.
 */
type Split = { state: 'running' } | { state: 'failed' } | null;
const DRAG = 'application/x-brigadir-commit-files';
const shortName = (path: string) => path.split('/').at(-1) || path;
const folder = (path: string) => path.split('/').slice(0, -1).join('/');
export function CommitDialog({
	task,
	locale,
	agentBusy,
}: {
	task: AgentTask;
	locale: Locale;
	agentBusy: boolean;
}) {
	const [{ commitDialog, commitBaskets, commitUndo, commitMessage }, setTask] = useTaskState(task);
	const forge = useForge(),
		// spec/appearance#evolution-redesign: messages and the split are two actions of Customize per action, each with its own capsule state.
		helper = useHelperRun('commitMessage'),
		splitHelper = useHelperRun('split'),
		agent =
			helperShown(splitHelper.settings, splitHelper.catalogs, splitHelper.run, 'split')
				?.provider === 'codex'
				? 'Codex'
				: 'Claude',
		run = useCommitRuns((state) => state.runs[`${task.projectId}/${task.id}`]);
	const [preview, setPreview] = useState<CommitPreview | null>(null),
		[readFailed, setReadFailed] = useState(false),
		[selected, setSelected] = useState<Set<string>>(new Set()),
		[active, setActive] = useState<string | null>(null),
		[split, setSplit] = useState<Split>(null),
		[generating, setGenerating] = useState<Set<string>>(new Set()),
		[invalid, setInvalid] = useState<Set<string>>(new Set()),
		[moveOpen, setMoveOpen] = useState(false),
		[drag, setDrag] = useState<{ files: BasketFile[]; over: string | null } | null>(null),
		[peek, setPeek] = useState<{ scopeId: string; path: string } | null>(null);
	const moveButton = useRef<HTMLButtonElement>(null),
		peekAnchor = useRef<HTMLElement | null>(null),
		mounted = useRef(true),
		request = useRef(0);
	const close = () => {
		if (split?.state === 'running') void window.brigadir.stopCommitSplit(task).catch(() => {});
		clearCommitRun(task);
		setTask({ commitDialog: null });
	};
	// The preview, read on open and again after the agent's turn, a checkpoint or a save — as the strip reads it.
	async function refresh() {
		const id = ++request.current;
		try {
			const data = await window.brigadir.readCommits(task);
			if (!mounted.current || id !== request.current) return;
			setPreview(data.preview);
			setReadFailed(false);
		} catch {
			if (mounted.current && id === request.current) setReadFailed(true);
		}
	}
	useEffect(() => {
		mounted.current = true;
		void refresh();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const stop = onSessionEvent(({ key, record }) => {
			if (
				key.id === task.id &&
				key.projectId === task.projectId &&
				(!record ||
					['turn.completed', 'checkpoint.created', 'file.saved', 'scopes.changed'].includes(
						record.event.kind
					))
			) {
				clearTimeout(timer);
				timer = setTimeout(() => void refresh(), 600);
			}
		});
		return () => {
			mounted.current = false;
			request.current++;
			clearTimeout(timer);
			stop();
		};
	}, [task.id, task.projectId]);
	const scopes = useMemo(() => (preview ? basketScopes(preview) : []), [preview]);
	// The baskets follow the preview: the first opening makes one per repo, later reads keep the person's split.
	useEffect(() => {
		if (!preview || run?.running) return;
		setTask((state) => {
			const current = state.commitBaskets;
			if (!current)
				return {
					commitBaskets: {
						baskets: initialBaskets(scopes, state.commitMessage ?? task.title),
						aside: [],
					},
				};
			const live = new Set(
				scopes.flatMap((scope) => scope.files.map((path) => fileKey(scope.id, path)))
			);
			const aside = current.aside.filter((key) => live.has(key)),
				baskets = reconcileBaskets(current.baskets, scopes, undefined, new Set(aside));
			return baskets === current.baskets && aside.length === current.aside.length
				? {}
				: { commitBaskets: { baskets, aside } };
		});
	}, [preview, run?.running]);
	// Opened from a repo's «…» menu: that repo's baskets come into view, its first basket active.
	const focused = useRef(false);
	useEffect(() => {
		const scopeId = commitDialog?.scopeId;
		if (focused.current || !scopeId || !commitBaskets) return;
		focused.current = true;
		const first = commitBaskets.baskets.find((basket) => basket.scopeId === scopeId);
		if (first) setActive(first.id);
		requestAnimationFrame(() =>
			document
				.querySelector(`[data-commit-dialog] [data-scope="${scopeId}"]`)
				?.scrollIntoView({ block: 'nearest' })
		);
	}, [commitBaskets, commitDialog?.scopeId]);
	const baskets = commitBaskets?.baskets ?? [],
		aside = useMemo(() => new Set(commitBaskets?.aside ?? []), [commitBaskets]);
	// A committed basket of a stopped run stays on screen (✓ and its SHA) before the baskets still to commit.
	const shown = useMemo(() => {
		const own = new Set(baskets.map((basket) => basket.id)),
			done = (run?.plan ?? []).filter(
				(basket) =>
					!own.has(basket.id) && ['done', 'skipped'].includes(run?.steps[basket.id]?.state ?? '')
			);
		return [...done.map((basket) => ({ ...basket })), ...baskets];
	}, [baskets, run]);
	// The basket in work: the last one touched; on the first opening the only one.
	const activeId =
		active && shown.some((basket) => basket.id === active)
			? active
			: shown.length === 1
				? shown[0]!.id
				: null;
	const labels = useMemo(() => basketLabels(shown), [shown]);
	const label = (id: string) => labels.get(id) ?? '';
	const files = useMemo(() => {
		const map = new Map<string, CommitFile & { scopeId: string }>();
		for (const item of preview?.scopes ?? [])
			for (const file of item.files)
				map.set(fileKey(item.scope.id, file.path), { ...file, scopeId: item.scope.id });
		return map;
	}, [preview]);
	const scopeName = (id: string) => scopes.find((scope) => scope.id === id)?.name ?? '';
	const multi = scopes.length > 1;
	const totals = useMemo(() => {
		let additions = 0,
			deletions = 0;
		for (const file of files.values()) {
			additions += file.diff?.additions ?? 0;
			deletions += file.diff?.deletions ?? 0;
		}
		return { additions, deletions, count: files.size };
	}, [files]);
	const running = Boolean(run?.running),
		failedRun = !running && run && Object.values(run.steps).some((step) => step.state === 'failed');
	const { plan, skipped, missing } = commitPlan(baskets);
	const update = (next: CommitBasket[], nextAside: Set<string> = aside) =>
		setTask({ commitBaskets: { baskets: next, aside: [...nextAside] } });
	/** A change of the person's after the agent's split: Undo stays only as ⌘Z, the banner goes (spec/appearance#evolution-redesign). */
	const edit = (next: CommitBasket[], nextAside?: Set<string>) => {
		update(next, nextAside);
		if (commitUndo && !split) setTask({ commitUndo: { ...commitUndo, after: -1 } });
	};
	const selectedFiles = (): BasketFile[] =>
		[...selected].map((key) => {
			const file = files.get(key)!;
			return { scopeId: file.scopeId, path: file.path };
		});
	function move(target: string | { newIn: string }, list: BasketFile[]) {
		const result = moveFiles(baskets, list, target);
		if (!result.moved && typeof target === 'string') return result;
		const nextAside = new Set(aside);
		for (const file of list) nextAside.delete(fileKey(file.scopeId, file.path));
		edit(result.baskets, nextAside);
		if (result.target) setActive(result.target);
		return result;
	}
	function setMessage(id: string, message: string) {
		update(setBasketMessage(baskets, id, message));
		if (message.trim()) setInvalid((value) => new Set([...value].filter((item) => item !== id)));
	}
	async function generate(ids: string[]) {
		if (!preview || !ids.length) return;
		setGenerating((value) => new Set([...value, ...ids]));
		await Promise.all(
			ids.map(async (id) => {
				const basket = baskets.find((item) => item.id === id);
				if (!basket?.files.length) return;
				try {
					const text = await window.brigadir.generateBasketMessage(
						task,
						preview.revision,
						basket.scopeId,
						basket.files,
						helper.run
					);
					if (!mounted.current) return;
					setTask((state) =>
						state.commitBaskets
							? {
									commitBaskets: {
										...state.commitBaskets,
										baskets: setBasketMessage(state.commitBaskets.baskets, id, text),
									},
								}
							: {}
					);
					setInvalid((value) => new Set([...value].filter((item) => item !== id)));
				} catch {
					if (mounted.current) toastError(t(locale, 'Could not generate the commit message.'));
				} finally {
					if (mounted.current)
						setGenerating((value) => new Set([...value].filter((item) => item !== id)));
				}
			})
		);
	}
	async function splitWithAgent() {
		if (!preview || split?.state === 'running') return;
		setSplit({ state: 'running' });
		const revision = preview.revision;
		try {
			const proposal = await window.brigadir.splitCommits(task, revision, splitHelper.run);
			if (!mounted.current) return;
			setTask((state) => {
				const current = state.commitBaskets ?? { baskets: [], aside: [] },
					next = applyProposal(current.baskets, scopes, proposal);
				const named = new Set(proposal.map((item) => item.scopeId));
				return {
					commitBaskets: {
						baskets: next,
						aside: current.aside.filter((key) => !named.has(key.split('\0')[0]!)),
					},
					commitUndo: {
						...current,
						before: current.baskets.filter((basket) => named.has(basket.scopeId)).length,
						after: next.filter((basket) => named.has(basket.scopeId)).length,
					},
				};
			});
			setSplit(null);
		} catch {
			if (mounted.current)
				setSplit((value) => (value?.state === 'running' ? { state: 'failed' } : value));
		}
	}
	function stopSplit() {
		void window.brigadir.stopCommitSplit(task).catch(() => {});
		setSplit(null);
	}
	function undo() {
		if (!commitUndo) return;
		setTask({
			commitBaskets: { baskets: commitUndo.baskets, aside: commitUndo.aside },
			commitUndo: null,
		});
	}
	function commit(push: boolean) {
		if (!preview || running || !plan.length) return;
		if (missing.length) {
			setInvalid(new Set(missing.map((basket) => basket.id)));
			return;
		}
		if (split?.state === 'running') stopSplit();
		void runCommitBaskets({
			task,
			locale,
			revision: preview.revision,
			plan: plan.map(({ id, scopeId, message, files }) => ({ id, scopeId, message, files })),
			pushNow: push,
			push: forge ? (ids) => pushRepos(forge, ids) : null,
		}).then(() => {
			// After the commits, and after a refusal too («Files changed…»): the list is read again at once, so the person
			// sees what changed and the next Commit takes the fresh revision (spec/git#commit-dialog — the strip has no Commit all).
			if (mounted.current) void refresh();
		});
	}
	function askAgent(basket: CommitBasket, output: string) {
		setTask({
			text: `The commit hook stopped the commit "${basket.message.split('\n')[0]}" (${basket.files.join(', ')}). Fix the problems it reports, then tell me so I can commit again.\n\n${output}`,
			commitDialog: null,
		});
		clearCommitRun(task);
	}
	const dragStart = (event: DragEvent, file: BasketFile) => {
		const key = fileKey(file.scopeId, file.path),
			list = selected.has(key) ? selectedFiles() : [file];
		event.dataTransfer.setData(DRAG, JSON.stringify(list));
		event.dataTransfer.effectAllowed = 'move';
		setDrag({ files: list, over: null });
	};
	const dropProps = (target: string | { newIn: string }, scopeId: string, id: string) => ({
		onDragOver: (event: DragEvent) => {
			if (!drag || running) return;
			const own = drag.files.some((file) => file.scopeId === scopeId);
			event.preventDefault();
			event.dataTransfer.dropEffect = own ? 'move' : 'none';
			if (drag.over !== id) setDrag({ ...drag, over: id });
		},
		onDragLeave: (event: DragEvent) => {
			if (drag?.over === id && !event.currentTarget.contains(event.relatedTarget as Node))
				setDrag({ ...drag, over: null });
		},
		onDrop: (event: DragEvent) => {
			event.preventDefault();
			if (drag) move(target, drag.files);
			setDrag(null);
		},
	});
	const dropState = (scopeId: string, id: string) =>
		drag?.over === id
			? drag.files.some((file) => file.scopeId === scopeId)
				? 'on'
				: 'no'
			: undefined;
	const selection = selectedFiles(),
		selectionScopes = new Set(selection.map((file) => file.scopeId));
	const order = shown.filter((basket) => basket.files.length).map((basket) => label(basket.id));
	const remaining = plan.map((basket) => label(basket.id));
	const retry = failedRun
		? remaining.length === 1
			? t(locale, 'Retry {commit}').replace('{commit}', remaining[0]!)
			: remaining.length === 2
				? t(locale, 'Retry {first} and {last}')
						.replace('{first}', remaining[0]!)
						.replace('{last}', remaining[1]!)
				: t(locale, 'Retry {first}–{last}')
						.replace('{first}', remaining[0]!)
						.replace('{last}', remaining.at(-1)!)
		: null;
	const runIndex = run ? run.order.findIndex((id) => run.steps[id]?.state === 'running') : -1;
	const doneCount = run
		? Object.values(run.steps).filter((step) => step.state === 'done').length
		: 0;
	const committable = !running && !agentBusy && plan.length > 0 && !generating.size;
	let note: ReactNode = null;
	if (running)
		note = (
			<span className={styles.note}>
				<Glyph name="agent-spinner" size={12} />
				{t(locale, 'Committing {n} of {total}…')
					.replace('{n}', String(Math.max(1, runIndex + 1)))
					.replace('{total}', String(run!.order.length))}
			</span>
		);
	else if (failedRun)
		note = (
			<span className={styles.note} data-tone="error">
				<Glyph name="toast-error" size={12} />
				{t(locale, '{done} of {total} committed · fix {commit} and retry')
					.replace('{done}', String(doneCount))
					.replace('{total}', String(run!.order.length))
					.replace('{commit}', remaining[0] ?? '')}
			</span>
		);
	else if (invalid.size && missing.length)
		note = (
			<span className={styles.note} data-tone="error">
				<Glyph name="toast-error" size={12} />
				{t(locale, '{commit} needs a message').replace('{commit}', label(missing[0]!.id))}
				<GenerateButton
					label={t(locale, 'Generate missing')}
					onClick={() => void generate(missing.map((basket) => basket.id))}
				/>
			</span>
		);
	else if (generating.size)
		note = <span className={styles.note}>{t(locale, 'Waiting for the messages')}</span>;
	else if (split?.state === 'running') note = null;
	else if (agentBusy)
		note = (
			<span className={styles.note}>
				{t(locale, 'Wait for the agent to finish before committing')}
			</span>
		);
	else if (skipped.length)
		note = (
			<span className={styles.note} data-tone="warning">
				<Glyph name="review-warning" size={12} />
				{t(locale, '{commit} is empty and will be skipped').replace(
					'{commit}',
					label(skipped[0]!.id)
				)}
			</span>
		);
	else if (plan.length)
		note = (
			<span className={styles.note}>
				{new Set(plan.map((basket) => basket.scopeId)).size > 1
					? t(locale, '{commits} in {repos}')
							.replace('{commits}', commitCount(locale, plan.length))
							.replace(
								'{repos}',
								scopeCount(locale, new Set(plan.map((basket) => basket.scopeId)).size)
							)
					: plan.length === 1
						? aside.size
							? t(locale, '1 commit · {files} not in a commit').replace(
									'{files}',
									fileCount(locale, aside.size)
								)
							: t(locale, '1 commit · all files')
						: t(locale, '{commits} · in order {first} → {last}')
								.replace('{commits}', commitCount(locale, plan.length))
								.replace('{first}', order[0] ?? '')
								.replace('{last}', order.at(-1) ?? '')}
			</span>
		);
	const header = (
		<>
			{!split && !commitUndo && !running && (
				<GenerateButton
					label={t(locale, 'Split with the agent')}
					title={t(locale, '{agent} proposes commits from the diff. You can undo.').replace(
						'{agent}',
						agent
					)}
					disabled={!preview || !totals.count || generating.size > 0}
					onClick={() => void splitWithAgent()}
				/>
			)}
			{generating.size > 0 ? (
				<span className={styles.status} role="status">
					<Glyph name="agent-spinner" size={12} />
					{t(locale, 'Generating {n} messages…').replace('{n}', String(generating.size))}
				</span>
			) : (
				!running && (
					<HelperSplit
						locale={locale}
						state={helper}
						label={t(locale, 'Generate messages')}
						title={t(locale, 'Generate the empty messages')}
						disabled={!baskets.some((basket) => basket.files.length && !basket.message.trim())}
						onClick={() =>
							void generate(
								baskets
									.filter((basket) => basket.files.length && !basket.message.trim())
									.map((basket) => basket.id)
							)
						}
					/>
				)
			)}
		</>
	);
	const commitLabel = retry ?? t(locale, 'Commit {n}').replace('{n}', String(plan.length));
	const peekFile = peek ? files.get(fileKey(peek.scopeId, peek.path)) : undefined;
	return (
		<ModalDialog
			title={t(locale, 'Commit')}
			locale={locale}
			close={close}
			width={640}
			top={64}
			data-commit-dialog
			note={
				<>
					{fileCount(locale, totals.count)} ·{' '}
					<ChangeCounts additions={totals.additions} deletions={totals.deletions} locale={locale} />
				</>
			}
			headerExtra={header}
			onKeyDown={(event) => {
				if (!primaryKey(event) || event.altKey) return;
				const key = event.key.toLowerCase();
				if (event.key === 'Enter') {
					event.preventDefault();
					commit(event.shiftKey);
				} else if (key === 'm' && selection.length) {
					event.preventDefault();
					setMoveOpen(true);
				} else if (
					key === 'z' &&
					!event.shiftKey &&
					commitUndo &&
					!(event.target instanceof HTMLTextAreaElement)
				) {
					event.preventDefault();
					undo();
				}
			}}
			footer={
				<>
					{note ?? <span className={styles.note} />}
					<Button disabled={!committable || !forge} onClick={() => commit(true)}>
						{t(locale, 'Commit and push')}
					</Button>
					<Button
						appearance="primary"
						disabled={!committable}
						aria-keyshortcuts="Meta+Enter"
						title={
							agentBusy ? t(locale, 'Wait for the agent to finish before committing') : undefined
						}
						onClick={() => commit(false)}>
						{commitLabel}
						<kbd className={styles.kbd}>{formatAccelerator('CmdOrCtrl+Enter')}</kbd>
					</Button>
				</>
			}>
			{split?.state === 'running' && (
				<Banner
					tone="working"
					title={t(locale, '{agent} is splitting the changes into commits…').replace(
						'{agent}',
						agent
					)}
					action={<Button onClick={stopSplit}>{t(locale, 'Stop')}</Button>}
				/>
			)}
			{split?.state === 'failed' && (
				<Banner
					tone="error"
					title={t(locale, 'Could not split the changes.')}
					note={t(locale, 'Your commits did not change.')}
					action={
						<HelperSplit
							locale={locale}
							state={splitHelper}
							label={t(locale, 'Split again')}
							onClick={() => void splitWithAgent()}
						/>
					}
				/>
			)}
			{!split && commitUndo && commitUndo.after >= 0 && (
				<Banner
					tone="done"
					title={t(locale, '{agent} proposed {commits}')
						.replace('{agent}', agent)
						.replace('{commits}', commitCount(locale, commitUndo.after))}
					note={t(locale, 'They replaced your {commits}. Edit them like any other.').replace(
						'{commits}',
						commitCount(locale, commitUndo.before)
					)}
					action={
						<Button
							title={`${t(locale, 'Back to your commits')} · ${formatAccelerator('CmdOrCtrl+Z')}`}
							onClick={undo}>
							<Glyph name="undo" size={12} />
							{t(locale, 'Undo')}
						</Button>
					}
				/>
			)}
			{readFailed && !preview && (
				<p className={styles.empty} role="alert">
					{t(locale, 'Could not read the commit list.')}{' '}
					<Button onClick={() => void refresh()}>{t(locale, 'Retry')}</Button>
				</p>
			)}
			{preview && !totals.count && !shown.length && (
				<p className={styles.empty}>{t(locale, 'No changes')}</p>
			)}
			{(totals.count > 0 || shown.length > 0) && (
				<div className={styles.two}>
					<FileList
						locale={locale}
						scopes={scopes}
						preview={preview}
						multi={multi}
						baskets={baskets}
						activeId={activeId}
						label={label}
						aside={aside}
						selected={selected}
						setSelected={setSelected}
						disabled={running}
						moveButton={moveButton}
						openMove={() => setMoveOpen(true)}
						peek={(scopeId, path, anchor) => {
							peekAnchor.current = anchor;
							setPeek({ scopeId, path });
						}}
						dragStart={dragStart}
						dragEnd={() => setDrag(null)}
					/>
					<div className={styles.baskets}>
						{(multi ? scopes : scopes.slice(0, 1)).map((scope) => {
							const own = shown.filter((basket) => basket.scopeId === scope.id);
							if (!own.length && !multi) return null;
							return (
								<section
									key={scope.id}
									data-scope={scope.id}
									className={styles.repo}
									aria-label={multi ? scope.name : undefined}>
									{multi && (
										<div className={styles.repoHead}>
											<b>{scope.name}</b>
											<span>
												{commitCount(locale, own.filter((basket) => basket.files.length).length)}
											</span>
										</div>
									)}
									{own.map((basket) => (
										<BasketCard
											key={basket.id}
											basket={basket}
											label={label(basket.id)}
											locale={locale}
											files={files}
											step={run?.steps[basket.id]}
											running={running}
											active={activeId === basket.id}
											invalid={invalid.has(basket.id)}
											generating={generating.has(basket.id)}
											drop={dropState(scope.id, basket.id)}
											dropProps={dropProps(basket.id, scope.id, basket.id)}
											repoName={scope.name}
											focus={() => setActive(basket.id)}
											setMessage={(value) => setMessage(basket.id, value)}
											generate={() => void generate([basket.id])}
											remove={() => edit(removeBasket(baskets, basket.id))}
											takeOut={(path) => {
												const next = new Set(aside);
												next.add(fileKey(basket.scopeId, path));
												edit(takeOut(baskets, [{ scopeId: basket.scopeId, path }]), next);
											}}
											peek={(path, anchor) => {
												peekAnchor.current = anchor;
												setPeek({ scopeId: basket.scopeId, path });
											}}
											dragStart={dragStart}
											dragEnd={() => setDrag(null)}
											askAgent={(output) => askAgent(basket, output)}
										/>
									))}
									<button
										type="button"
										className={styles.newCommit}
										disabled={running}
										data-drop={dropState(scope.id, `new:${scope.id}`)}
										{...dropProps({ newIn: scope.id }, scope.id, `new:${scope.id}`)}
										onClick={() => {
											const next = addBasket(baskets, scope.id);
											edit(next);
											setActive(next.find((basket) => !baskets.includes(basket))?.id ?? null);
										}}>
										<Glyph name="plus" size={11} />
										{t(locale, 'New commit')}
										<small>· {t(locale, 'drop files here')}</small>
									</button>
								</section>
							);
						})}
					</div>
				</div>
			)}
			<MenuPopover
				open={moveOpen}
				onClose={() => setMoveOpen(false)}
				anchor={moveButton}
				label={t(locale, 'Move {files} to').replace('{files}', fileCount(locale, selection.length))}
				locale={locale}
				size="s"
				width={250}>
				{baskets.map((basket) => (
					<MenuItem
						key={basket.id}
						icon={<Glyph name="commit-dot" size={12} />}
						disabled={!selectionScopes.has(basket.scopeId)}
						tail={basket.files.length}
						onSelect={() => {
							move(basket.id, selection);
							setSelected(new Set());
						}}>
						{label(basket.id)} · {basket.message.split('\n')[0] || t(locale, 'Commit message')}
					</MenuItem>
				))}
				<MenuSeparator />
				<MenuItem
					icon={<Glyph name="plus" size={12} />}
					disabled={selectionScopes.size !== 1}
					onSelect={() => {
						move({ newIn: [...selectionScopes][0]! }, selection);
						setSelected(new Set());
					}}>
					{t(locale, 'New commit')}
				</MenuItem>
			</MenuPopover>
			{peek && peekFile && preview && (
				<DiffPeek
					key={`${peek.scopeId}/${peek.path}`}
					task={task}
					locale={locale}
					revision={preview.revision}
					file={peekFile}
					anchor={peekAnchor}
					baskets={baskets.filter((basket) => basket.scopeId === peek.scopeId)}
					current={basketOf(baskets, peek.scopeId, peek.path)?.id ?? null}
					label={label}
					disabled={running}
					moveTo={(id) => move(id, [{ scopeId: peek.scopeId, path: peek.path }])}
					close={() => setPeek(null)}
				/>
			)}
		</ModalDialog>
	);
}
function FileList({
	locale,
	scopes,
	preview,
	multi,
	baskets,
	activeId,
	label,
	aside,
	selected,
	setSelected,
	disabled,
	moveButton,
	openMove,
	peek,
	dragStart,
	dragEnd,
}: {
	locale: Locale;
	scopes: ReturnType<typeof basketScopes>;
	preview: CommitPreview | null;
	multi: boolean;
	baskets: CommitBasket[];
	activeId: string | null;
	label(id: string): string;
	aside: Set<string>;
	selected: Set<string>;
	setSelected(value: Set<string>): void;
	disabled: boolean;
	moveButton: React.RefObject<HTMLButtonElement | null>;
	openMove(): void;
	peek(scopeId: string, path: string, anchor: HTMLElement): void;
	dragStart(event: DragEvent, file: BasketFile): void;
	dragEnd(): void;
}) {
	const all = scopes.flatMap((scope) => scope.files.map((path) => fileKey(scope.id, path)));
	const root = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const box = root.current?.querySelector<HTMLInputElement>('[data-select-all]');
		if (box) box.indeterminate = selected.size > 0 && selected.size < all.length;
	});
	const toggle = (key: string) => {
		const next = new Set(selected);
		if (next.has(key)) next.delete(key);
		else next.add(key);
		setSelected(next);
	};
	return (
		<FileListBox
			ref={root}
			className={styles.list}
			role="group"
			aria-label={t(locale, 'Changes')}
			onKeyDown={(event) => {
				if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
				const rows = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-file-open]')],
					index = rows.indexOf(document.activeElement as HTMLElement);
				if (index < 0) return;
				event.preventDefault();
				rows[(index + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length]?.focus();
			}}>
			<div className={styles.listHead} data-size="s">
				<Choice
					data-select-all
					type="checkbox"
					label={t(locale, 'Select all')}
					checked={all.length > 0 && selected.size === all.length}
					disabled={disabled || !all.length}
					onChange={() => setSelected(selected.size === all.length ? new Set() : new Set(all))}
				/>
				<b>{t(locale, 'Changes')}</b>
				<span>{all.length}</span>
				<span className={styles.grow} />
				{selected.size > 0 && (
					<Button ref={moveButton} disabled={disabled} aria-haspopup="menu" onClick={openMove}>
						{t(locale, 'Move {n} to').replace('{n}', String(selected.size))}
						<Glyph name="chevron-down" size={10} />
					</Button>
				)}
			</div>
			{scopes.map((scope) => {
				const branch = preview?.scopes.find((item) => item.scope.id === scope.id)?.scope.branch;
				return (
					<div key={scope.id} role="list" aria-label={scope.name}>
						{multi && (
							<div className={styles.listRepo}>
								<b>{scope.name}</b>
								{branch && <code title={branch}>{branch}</code>}
							</div>
						)}
						{scope.files.map((path) => {
							const key = fileKey(scope.id, path),
								basket = basketOf(baskets, scope.id, path),
								out = aside.has(key);
							return (
								<div
									key={key}
									role="listitem"
									className={styles.file}
									data-selected={selected.has(key) || undefined}
									data-off={out || undefined}
									draggable={!disabled}
									onDragStart={(event) => dragStart(event, { scopeId: scope.id, path })}
									onDragEnd={dragEnd}>
									<Choice
										type="checkbox"
										label={`${t(locale, 'Select')} ${path}`}
										checked={selected.has(key)}
										disabled={disabled}
										onChange={() => toggle(key)}
										onKeyDown={(event) => {
											if (primaryKey(event) && event.key.toLowerCase() === 'm') openMove();
										}}
									/>
									<button
										type="button"
										className={styles.fileOpen}
										data-file-open
										title={path}
										onClick={(event) => peek(scope.id, path, event.currentTarget.parentElement!)}
										onKeyDown={(event) => {
											if (event.key === ' ') {
												event.preventDefault();
												toggle(key);
											}
										}}>
										<FileIcon name={shortName(path)} />
										<span className={styles.name}>{shortName(path)}</span>
										<span className={styles.dir}>{folder(path)}</span>
									</button>
									{basket ? (
										<span className={styles.tag} data-on={basket.id === activeId || undefined}>
											{label(basket.id)}
										</span>
									) : (
										<span className={styles.outTag} title={t(locale, 'Not in a commit')}>
											—
										</span>
									)}
								</div>
							);
						})}
					</div>
				);
			})}
		</FileListBox>
	);
}
function BasketCard({
	basket,
	label,
	locale,
	files,
	step,
	running,
	active,
	invalid,
	generating,
	drop,
	dropProps,
	repoName,
	focus,
	setMessage,
	generate,
	remove,
	takeOut,
	peek,
	dragStart,
	dragEnd,
	askAgent,
}: {
	basket: CommitBasket;
	label: string;
	locale: Locale;
	files: Map<string, CommitFile & { scopeId: string }>;
	step: CommitStep | undefined;
	running: boolean;
	active: boolean;
	invalid: boolean;
	generating: boolean;
	drop: 'on' | 'no' | undefined;
	dropProps: Record<string, (event: DragEvent) => void>;
	repoName: string;
	focus(): void;
	setMessage(value: string): void;
	generate(): void;
	remove(): void;
	takeOut(path: string): void;
	peek(path: string, anchor: HTMLElement): void;
	dragStart(event: DragEvent, file: BasketFile): void;
	dragEnd(): void;
	askAgent(output: string): void;
}) {
	const [menu, setMenu] = useState(false),
		more = useRef<HTMLButtonElement>(null);
	let additions = 0,
		deletions = 0;
	// A committed basket's files have left the preview: its counts are no longer known, only how many files went in.
	const counted = basket.files.every((path) => files.has(fileKey(basket.scopeId, path)));
	for (const path of basket.files) {
		const file = files.get(fileKey(basket.scopeId, path));
		additions += file?.diff?.additions ?? 0;
		deletions += file?.diff?.deletions ?? 0;
	}
	const done = step?.state === 'done' || step?.state === 'skipped',
		failed = step?.state === 'failed',
		empty = !basket.files.length && !done,
		locked = running || done;
	return (
		<article
			className={styles.basket}
			aria-label={label}
			data-basket={label}
			data-active={active || undefined}
			data-tone={empty ? 'warning' : undefined}
			data-drop={drop}
			onFocus={focus}
			{...dropProps}>
			{drop === 'no' && (
				<span className={styles.tip} role="status">
					{t(locale, 'Only commits of {repo}').replace('{repo}', repoName)}
				</span>
			)}
			<div className={styles.basketHead} data-size="s">
				<span
					className={styles.tag}
					data-on={active || undefined}
					data-state={done ? 'ok' : failed ? 'bad' : undefined}>
					{label}
				</span>
				<span>
					{basket.files.length || done
						? fileCount(locale, basket.files.length)
						: t(locale, 'No files')}
				</span>
				{basket.files.length > 0 && counted && (
					<ChangeCounts additions={additions} deletions={deletions} locale={locale} split />
				)}
				<span className={styles.grow} />
				{step?.state === 'done' ? (
					<span className={styles.status}>
						<Glyph name="tick" size={11} />
						<code>{step.sha?.slice(0, 7)}</code>
					</span>
				) : step?.state === 'skipped' ? (
					<span className={styles.status}>{t(locale, 'Skipped')}</span>
				) : step?.state === 'running' ? (
					<span className={styles.status} role="status">
						<Glyph name="agent-spinner" size={11} />
						{t(locale, 'Committing…')}
					</span>
				) : step?.state === 'waiting' && running ? (
					<span className={styles.status}>
						<Glyph name="clock" size={11} />
						{t(locale, 'Waiting')}
					</span>
				) : failed ? (
					<span className={styles.status} data-tone="error">
						<Glyph name="toast-error" size={11} />
						{t(locale, 'Hook failed')}
					</span>
				) : generating ? (
					<span className={styles.status} role="status">
						{t(locale, 'Generating…')}
					</span>
				) : (
					<>
						<IconButton
							label={t(locale, 'Generate message')}
							hint={`${t(locale, 'Generate message')} · ${label}`}
							disabled={!basket.files.length || running}
							onClick={generate}>
							<Glyph name="generate" size={12} />
						</IconButton>
						<IconButton
							ref={more}
							label={`${t(locale, 'Commit actions')} · ${label}`}
							disabled={running}
							aria-haspopup="menu"
							onClick={() => setMenu(true)}>
							<Glyph name="more" size={12} />
						</IconButton>
					</>
				)}
			</div>
			{generating ? (
				<div className={styles.skeleton} aria-hidden="true">
					<span />
					<span />
				</div>
			) : (
				<TextArea
					className={styles.message}
					aria-label={`${t(locale, 'Commit message')} · ${label}`}
					aria-invalid={invalid || undefined}
					data-invalid={invalid || undefined}
					placeholder={t(locale, 'Commit message')}
					value={basket.message}
					disabled={locked}
					rows={1}
					onChange={(event) => setMessage(event.target.value)}
				/>
			)}
			{invalid && (
				<p className={styles.line} data-tone="error">
					<Glyph name="toast-error" size={11} />
					{t(locale, 'Write a message or generate one.')}
				</p>
			)}
			{basket.reason && (
				<p className={styles.line}>
					<Glyph name="why" size={11} />
					{basket.reason}
				</p>
			)}
			{basket.files.length > 0 ? (
				<div className={styles.chips} role="list" aria-label={t(locale, 'Files')}>
					{basket.files.map((path) => (
						<span
							key={path}
							role="listitem"
							className={styles.chip}
							draggable={!locked}
							onDragStart={(event) => dragStart(event, { scopeId: basket.scopeId, path })}
							onDragEnd={dragEnd}>
							<button
								type="button"
								className={styles.chipOpen}
								title={path}
								onClick={(event) => peek(path, event.currentTarget.parentElement!)}>
								<FileIcon name={shortName(path)} />
								{shortName(path)}
							</button>
							{!locked && (
								<button
									type="button"
									className={styles.chipOut}
									aria-label={`${t(locale, 'Leave out of the commit')} · ${shortName(path)}`}
									title={t(locale, 'Leave out of the commit')}
									onClick={() => takeOut(path)}>
									<Glyph name="xmark" size={9} />
								</button>
							)}
						</span>
					))}
				</div>
			) : (
				!done && <div className={styles.dropHere}>{t(locale, 'Drag files here')}</div>
			)}
			{empty && (
				<p className={styles.line} data-tone="warning">
					<Glyph name="review-warning" size={11} />
					{t(locale, 'An empty commit is skipped.')}
					<Button className={styles.lineAction} disabled={running} onClick={remove}>
						{t(locale, 'Remove')}
					</Button>
				</p>
			)}
			{failed && step?.output && (
				<div className={styles.output} data-tone="error">
					<Glyph name="toast-error" size={11} />
					<pre tabIndex={0}>{step.output}</pre>
					<Button className={styles.lineAction} onClick={() => askAgent(step.output!)}>
						{t(locale, 'Ask the agent')}
					</Button>
				</div>
			)}
			<MenuPopover
				open={menu}
				onClose={() => setMenu(false)}
				anchor={more}
				label={`${t(locale, 'Commit actions')} · ${label}`}
				locale={locale}
				size="s"
				align="end"
				width={220}>
				<MenuItem
					icon={<Glyph name="generate" size={12} />}
					disabled={!basket.files.length}
					onSelect={generate}>
					{t(locale, 'Generate message')}
				</MenuItem>
				<MenuItem
					icon={<Glyph name="trash" size={12} />}
					disabled={basket.files.length > 0}
					reason={
						basket.files.length ? t(locale, 'Move its files to another commit first.') : undefined
					}
					onSelect={remove}>
					{t(locale, 'Remove commit')}
				</MenuItem>
			</MenuPopover>
		</article>
	);
}
/** Click a file: its diff over the baskets, the basket changed by the picker in the header. */
function DiffPeek({
	task,
	locale,
	revision,
	file,
	anchor,
	baskets,
	current,
	label,
	disabled,
	moveTo,
	close,
}: {
	task: AgentTask;
	locale: Locale;
	revision: string;
	file: CommitFile;
	anchor: React.RefObject<HTMLElement | null>;
	baskets: CommitBasket[];
	current: string | null;
	label(id: string): string;
	disabled: boolean;
	moveTo(id: string): void;
	close(): void;
}) {
	const [diff, setDiff] = useState<FileDiff | null>(null),
		[failed, setFailed] = useState(false),
		[picker, setPicker] = useState(false),
		pick = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		let live = true;
		if (!file.diff) return;
		void window.brigadir.readCommitFile(task, revision, file.diff.id).then(
			(value) => live && setDiff(value),
			() => live && setFailed(true)
		);
		return () => {
			live = false;
		};
	}, []);
	const tokens = useMemo(
		() =>
			diff && {
				old: lineTokens(diff.beforeText, diff.beforeSyntax?.tokens ?? []),
				new: lineTokens(diff.afterText, diff.afterSyntax?.tokens ?? []),
			},
		[diff]
	);
	const lines = diff?.lines ?? [];
	return (
		<Popover
			open
			onClose={close}
			anchor={anchor}
			label={file.path}
			locale={locale}
			title={
				<span className={styles.peekTitle}>
					<FileIcon name={shortName(file.path)} />
					{shortName(file.path)}
				</span>
			}
			note={
				file.diff && (
					<ChangeCounts
						additions={file.diff.additions}
						deletions={file.diff.deletions}
						locale={locale}
					/>
				)
			}
			headerExtra={
				<Button
					ref={pick}
					className={styles.picker}
					disabled={disabled}
					aria-haspopup="menu"
					aria-label={`${t(locale, 'Commit')} · ${current ? label(current) : t(locale, 'Not in a commit')}`}
					onClick={() => setPicker(true)}>
					{current ? label(current) : '—'}
					<Glyph name="chevron-down" size={10} />
				</Button>
			}
			width={420}
			size="s"
			className={styles.peek}>
			<div className={styles.peekBody} tabIndex={0} aria-label={t(locale, 'Changes')}>
				{!file.diff || diff?.binary || diff?.tooLarge ? (
					<p className={styles.empty}>{t(locale, 'No preview for this file.')}</p>
				) : failed ? (
					<p className={styles.empty}>
						{t(locale, 'Could not open {file}.').replace('{file}', shortName(file.path))}
					</p>
				) : !diff ? (
					<SkeletonText lines={10} />
				) : (
					<>
						{lines.slice(0, 400).map((line, index) => (
							<DiffCode
								key={index}
								line={line}
								tokens={
									(line.kind === 'removed'
										? tokens!.old.get(line.oldLine ?? -1)
										: tokens!.new.get(line.newLine ?? -1)) ?? []
								}
								side={line.kind === 'removed' ? 'old' : 'new'}
								locale={locale}
								compact
							/>
						))}
						{lines.length > 400 && <p className={styles.empty}>…</p>}
					</>
				)}
			</div>
			<MenuPopover
				open={picker}
				onClose={() => setPicker(false)}
				anchor={pick}
				label={t(locale, 'Move to')}
				locale={locale}
				size="s"
				align="end"
				focus="checked"
				width={220}>
				{baskets.map((basket) => (
					<MenuItem
						key={basket.id}
						kind="radio"
						checked={basket.id === current}
						onSelect={() => moveTo(basket.id)}>
						{label(basket.id)} · {basket.message.split('\n')[0] || t(locale, 'Commit message')}
					</MenuItem>
				))}
			</MenuPopover>
		</Popover>
	);
}
