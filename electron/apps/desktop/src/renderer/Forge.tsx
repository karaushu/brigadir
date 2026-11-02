import { HelperSplit, useHelperRun } from './HelperAgent';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { onSessionEvent } from './session-events';
import {
	commitsAhead,
	repoBlockers,
	t,
	validBranch,
	type AgentTask,
	type Locale,
	type ForgeSnapshot,
	type ForgeScope,
	type PushDraft,
	type PushStep,
	type PullRequestDraft,
	type PullRequestPair,
	type PRCheck,
} from '@brigadir/core';
import { Button, Popup } from './ui/Controls';
import { BranchName } from './ui/BranchName';
import { branchTail } from './BranchPicker';
import { TextInput, TextArea } from './ui/Input';
import { PopupClose } from './ui/PopupClose';
import { Glyph } from './ui/Glyph';
import { CIGlyph, checkCIState } from './ui/RunSteps';
import { usePresence } from './ui/use-presence';
import { useWorkspace } from './store';
import { openTaskPR } from './task-state';
import { resolveToast, toastWarning } from './ui/Toast';
import styles from './Forge.module.css';
import { SkeletonRows } from './ui/Loading';
type Action = 'push' | 'pr' | 'checks';
type Context = {
	data: ForgeSnapshot | null;
	error: string;
	locale: Locale;
	refresh(remote: boolean, fresh?: boolean): Promise<ForgeSnapshot | undefined>;
	/** `returnFocus`: where focus goes when the dialog closes, for a dialog opened from a menu row that leaves with the menu.
	 *  `done`: after the dialog's push or PR went through, with the new snapshot (spec/pull-requests-and-ci#ready-card: the new PR becomes the selected row). */
	open(
		action: Action,
		id: string,
		returnFocus?: HTMLElement | null,
		done?: (value: ForgeSnapshot) => void
	): void;
	/** spec/pull-requests-and-ci#ready-card: × on the card of a branch ready for a PR — hidden until that branch is pushed again. */
	hide(id: string): Promise<void>;
};
const ForgeContext = createContext<Context | null>(null);
export const useForge = () => useContext(ForgeContext);
const failure = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** spec/git#pull: ↑N in a repo row without the main tree open opens the main tree first; its provider opens the dialog. */
let pendingAction: { projectId: string; id: string; action: Action; scopeId: string } | null = null;
export function requestForgeAction(
	task: { projectId: string; id: string },
	action: Action,
	scopeId: string
) {
	pendingAction = { projectId: task.projectId, id: task.id, action, scopeId };
}
export function ForgeProvider({
	task,
	locale,
	children,
}: {
	task: AgentTask | undefined;
	locale: Locale;
	children: ReactNode;
}) {
	const [data, setData] = useState<ForgeSnapshot | null>(null),
		[error, setError] = useState(''),
		[modal, setModal] = useState<{
			action: Action;
			id: string;
			returnFocus?: HTMLElement | null;
			done?: ((value: ForgeSnapshot) => void) | undefined;
		} | null>(null),
		mounted = useRef(true),
		revision = useRef(0);
	const present = usePresence(Boolean(modal)),
		lastModal = useRef(modal);
	if (modal) lastModal.current = modal;
	async function refresh(remote: boolean, fresh = false) {
		if (!task) return;
		const id = ++revision.current;
		try {
			const value = await window.brigadir.readForge(task, remote, fresh);
			if (mounted.current && id === revision.current) {
				setData(value);
				setError('');
				if (
					pendingAction &&
					pendingAction.projectId === task.projectId &&
					pendingAction.id === task.id &&
					value.scopes.some((item) => item.scope.id === pendingAction!.scopeId)
				) {
					setModal({ action: pendingAction.action, id: pendingAction.scopeId });
					pendingAction = null;
				}
			}
			return value;
		} catch (error) {
			if (mounted.current && id === revision.current) setError(failure(error));
		}
	}
	useEffect(() => {
		mounted.current = true;
		if (!task) return;
		void refresh(true);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const focus = () => {
			void refresh(true, true);
		};
		window.addEventListener('focus', focus);
		const stop = onSessionEvent(({ key, record }) => {
			if (
				key.id === task.id &&
				key.projectId === task.projectId &&
				(!record ||
					[
						'turn.completed',
						'checkpoint.created',
						'file.saved',
						'scopes.changed',
						'pull-request.changed',
					].includes(record.event.kind))
			) {
				clearTimeout(timer);
				timer = setTimeout(() => {
					void refresh(false);
				}, 2000);
			}
		});
		return () => {
			mounted.current = false;
			revision.current++;
			stop();
			clearTimeout(timer);
			window.removeEventListener('focus', focus);
		};
	}, [task?.id, task?.projectId]);
	return (
		<ForgeContext.Provider
			value={{
				data,
				error,
				locale,
				refresh,
				open: (action, id, returnFocus, done) =>
					setModal({ action, id, returnFocus: returnFocus ?? null, done }),
				hide: async (id) => {
					if (!task) return;
					const value = await window.brigadir.hidePullRequestSuggestion(task, id);
					if (mounted.current) {
						revision.current++;
						setData(value);
					}
				},
			}}>
			{children}
			{task && present && lastModal.current && (
				<ForgeDialog
					key={`${lastModal.current.action}/${lastModal.current.id}`}
					open={Boolean(modal)}
					task={task}
					action={lastModal.current.action}
					scopeId={lastModal.current.id}
					returnFocus={lastModal.current.returnFocus ?? null}
					locale={locale}
					refresh={refresh}
					accept={(value) => {
						revision.current++;
						setData(value);
						setError('');
						lastModal.current?.done?.(value);
					}}
					close={() => setModal(null)}
				/>
			)}
		</ForgeContext.Provider>
	);
}
/** spec/notifications-slack-notes-and-schedules#toasts: GitHub state is a warning toast once per state, with Retry; the raw error never reaches the person. It leaves when GitHub is ready again. */
const FORGE_TEXTS = [
	'Install GitHub CLI (gh) to create pull requests.',
	'Sign in with gh auth login to use GitHub.',
	'GitHub status could not be read.',
] as const;
export function ForgeToast() {
	const context = useForge(),
		data = context?.data,
		locale = context?.locale,
		refresh = useRef(context?.refresh);
	refresh.current = context?.refresh;
	const message = !context
		? null
		: context.error || data?.error
			? FORGE_TEXTS[2]
			: data?.auth === 'missing'
				? FORGE_TEXTS[0]
				: data?.auth === 'login'
					? FORGE_TEXTS[1]
					: data && data.auth !== 'ready'
						? FORGE_TEXTS[2]
						: null;
	useEffect(() => {
		if (!locale) return;
		for (const text of FORGE_TEXTS) if (text !== message) resolveToast(t(locale, text));
		if (message)
			toastWarning(t(locale, message), {
				action: {
					label: t(locale, 'Retry'),
					run: () => {
						void refresh.current?.(true, true);
					},
				},
			});
	}, [message, locale]);
	return null;
}
function checkState(item: ForgeScope) {
	if (item.pr?.state === 'MERGED') return 'merged';
	if (item.pr?.state === 'CLOSED') return 'closed';
	if (item.checksError) return 'unknown';
	if (
		item.details?.mergeable === 'CONFLICTING' ||
		item.details?.checks.some((check) => check.bucket === 'fail' || check.bucket === 'cancel')
	)
		return 'fail';
	if (item.details?.checks.some((check) => check.bucket === 'pending')) return 'pending';
	return item.details?.checks.length ? 'pass' : 'none';
}
export function ScopeForgeActions({
	scopeId,
	scopeName,
}: {
	scopeId?: string;
	scopeName?: string;
}) {
	const context = useForge();
	if (!context) return null;
	const { data, locale, open } = context,
		item = data?.scopes.find((item) =>
			scopeId ? item.scope.id === scopeId : item.scope.name === scopeName
		);
	if (!item) return null;
	const state = checkState(item),
		blockers = [
			...item.blockers,
			...(data?.auth !== 'ready' ? [t(locale, 'GitHub is unavailable')] : []),
		],
		reason = blockers.length
			? blockers.map((value) => t(locale, value as Parameters<typeof t>[1]) || value).join('\n')
			: item.git.warnings.length
				? `${t(locale, 'Submodule commits must be available upstream before merging:')} ${item.git.warnings.join(', ')}`
				: '';
	return (
		<div className={styles.scopeActions} data-size="s" data-forge-scope={item.scope.name}>
			{item.git.pushAhead > 0 && (
				<Button
					title={t(locale, 'Push commits')}
					aria-label={`${t(locale, 'Push commits')} · ${item.scope.name}`}
					onClick={() => open('push', item.scope.id)}>
					↑{item.git.pushAhead}
				</Button>
			)}
			{/* spec/sidebar#repos: the badge is for an open PR only; a merged or closed one lives in the repo's PR counter and the PR panel. */}
			{item.pr?.state === 'OPEN' && (
				<Button
					appearance="primary"
					className={styles.badge}
					data-state={state}
					title={`${item.pr.title} · ${item.pr.state}`}
					aria-label={`PR #${item.pr.number} · ${t(locale, 'Checks')}`}
					onClick={() => open('checks', item.scope.id)}>
					<Glyph name="pr-branch" size={11} />#{item.pr.number}
					{state === 'pending' ? (
						<Glyph name="check-pending" size={11} />
					) : state === 'pass' ? (
						<Glyph name="badge-pass" size={11} />
					) : state === 'fail' ? (
						<Glyph name="badge-fail" size={11} />
					) : state === 'unknown' ? (
						<span>?</span>
					) : null}
				</Button>
			)}
			{item.pr?.state !== 'OPEN' && (
				<span title={reason}>
					<Button
						variant="ghost"
						title={reason || undefined}
						disabled={repoBlockers(blockers).length > 0}
						onClick={() => open('pr', item.scope.id)}>
						<Glyph name="pr-branch" size={11} />
						{t(locale, 'Create PR')}
					</Button>
				</span>
			)}
		</div>
	);
}
/** Sidebar row and its menu read the same forge snapshot as the diff header (spec/sidebar#layout). */
export function useScopeForge(scopeId: string) {
	const context = useForge();
	if (!context) return null;
	const { data, locale, open } = context,
		item = data?.scopes.find((entry) => entry.scope.id === scopeId);
	if (!item) return null;
	const blockers = [
		...item.blockers,
		...(data?.auth !== 'ready' ? [t(locale, 'GitHub is unavailable')] : []),
	];
	const reason = blockers.length
		? blockers.map((value) => t(locale, value as Parameters<typeof t>[1]) || value).join('\n')
		: item.git.warnings.length
			? `${t(locale, 'Submodule commits must be available upstream before merging:')} ${item.git.warnings.join(', ')}`
			: '';
	return {
		push: item.git.pushAhead,
		pr: item.pr,
		state: checkState(item),
		// spec/pull-requests-and-ci#from-into: a branch's own reason does not shut the dialog — its pickers choose another pair.
		blocked: repoBlockers(blockers).length > 0,
		reason,
		open: (action: Action, returnFocus?: HTMLElement | null) =>
			open(action, item.scope.id, returnFocus),
	};
}
function PushList({ steps, locale }: { steps: PushStep[]; locale: Locale }) {
	return (
		<div className={styles.commits} tabIndex={0} aria-label={t(locale, 'Commits to push')}>
			{steps.map((step) => (
				<section key={step.scopeId}>
					<div className={styles.pushHeading}>
						<strong>{step.name}</strong>
						<span>
							{step.published ? t(locale, 'Update branch') : t(locale, 'First push')} · ↑
							{step.count}
						</span>
					</div>
					<p className={styles.branch} title={step.remote}>
						{step.branch} → origin
					</p>
					{step.commits.map((commit) => (
						<div className={styles.commit} key={commit.sha}>
							<code>{commit.sha.slice(0, 7)}</code>
							<span title={commit.subject}>{commit.subject}</span>
						</div>
					))}
					{step.count > step.commits.length && (
						<p>{t(locale, 'Showing the most recent 100 commits.')}</p>
					)}
				</section>
			))}
		</div>
	);
}
function ForgeDialog({
	open,
	task,
	action,
	scopeId,
	locale,
	refresh,
	accept,
	close,
	returnFocus,
}: {
	open: boolean;
	task: AgentTask;
	action: Action;
	scopeId: string;
	locale: Locale;
	refresh: Context['refresh'];
	accept(value: ForgeSnapshot): void;
	close(): void;
	returnFocus: HTMLElement | null;
}) {
	const dialog = useRef<HTMLDialogElement>(null),
		active = useRef(true),
		draftRef = useRef<string | null>(null),
		[push, setPush] = useState<PushDraft | null>(null),
		[pr, setPR] = useState<PullRequestDraft | null>(null),
		[scope, setScope] = useState<ForgeScope | null>(null),
		[loading, setLoading] = useState(true),
		[busy, setBusy] = useState(false),
		[error, setError] = useState(''),
		[generating, setGenerating] = useState(false),
		[generationError, setGenerationError] = useState(false),
		[title, setTitle] = useState(''),
		[body, setBody] = useState(''),
		[branch, setBranch] = useState(''),
		// spec/pull-requests-and-ci#from-into: the `From → Into` pair and the check main made of it.
		[head, setHead] = useState(''),
		[base, setBase] = useState(''),
		[pair, setPair] = useState<PullRequestPair | null>(null),
		[pairError, setPairError] = useState(''),
		pairSeq = useRef(0),
		[expanded, setExpanded] = useState(false),
		previousFocus = useRef<Element | null>(null),
		editRevision = useRef(0);
	async function readChecks() {
		setLoading(true);
		setError('');
		const value = await refresh(true, true);
		if (active.current) {
			const item = value?.scopes.find((item) => item.scope.id === scopeId);
			setScope(item ?? null);
			setError(item?.checksError ?? (!item ? t(locale, 'GitHub status could not be read.') : ''));
			setLoading(false);
		}
	}
	useEffect(() => {
		const element = dialog.current!;
		if (open) {
			previousFocus.current = returnFocus?.isConnected ? returnFocus : document.activeElement;
			element.showModal();
		} else {
			element.close();
			const previous = previousFocus.current;
			if (previous instanceof HTMLElement && previous.isConnected && !previous.matches(':disabled'))
				previous.focus({ preventScroll: true });
		}
	}, [open]);
	useEffect(() => {
		active.current = true;
		const element = dialog.current!,
			previous = previousFocus.current;
		const anchor = previous instanceof HTMLElement ? previous.getBoundingClientRect() : null,
			position = () => {
				if (action !== 'checks' || !anchor) return;
				const rect = element.getBoundingClientRect();
				element.style.inset = `${Math.max(16, Math.min(anchor.top - rect.height - 8, innerHeight - rect.height - 16))}px auto auto ${Math.max(16, Math.min(anchor.right - rect.width, innerWidth - rect.width - 16))}px`;
			};
		const observer = new ResizeObserver(position);
		observer.observe(element);
		position();
		void (async () => {
			try {
				if (action === 'checks') {
					await readChecks();
					return;
				}
				if (action === 'push' || action === 'pr') {
					const draft =
						action === 'push'
							? await window.brigadir.preparePush(task, scopeId)
							: await window.brigadir.preparePullRequest(task, scopeId);
					if (!active.current) {
						await window.brigadir.discardForgeDraft(task, draft.id).catch(() => {});
						return;
					}
					draftRef.current = draft.id;
					if ('title' in draft) {
						setPR(draft);
						setTitle(draft.title);
						setBody(draft.body);
						setBranch(draft.branch);
						setHead(draft.branch);
						setBase(draft.base);
					} else setPush(draft);
				}
			} catch (error) {
				if (active.current) setError(failure(error));
			} finally {
				if (active.current) setLoading(false);
			}
		})();
		return () => {
			active.current = false;
			observer.disconnect();
			element.close();
			if (draftRef.current)
				void window.brigadir.discardForgeDraft(task, draftRef.current).catch(() => {});
			if (previous instanceof HTMLElement && previous.isConnected && !previous.matches(':disabled'))
				previous.focus({ preventScroll: true });
		};
	}, []);
	// spec/pull-requests-and-ci#from-into: each pair is checked by main; until the person edits the text, it follows `From`.
	useEffect(() => {
		if (!pr || !head || !base) return;
		const seq = ++pairSeq.current;
		setPair(null);
		setPairError('');
		window.brigadir.checkPullRequest(task, pr.id, { head, base }).then(
			(value) => {
				if (!active.current || seq !== pairSeq.current) return;
				setPair(value);
				if (editRevision.current === 0) {
					setTitle(value.title);
					setBody(value.body);
				}
			},
			(error) => {
				if (active.current && seq === pairSeq.current) setPairError(failure(error));
			}
		);
	}, [pr?.id, head, base]);
	const dismiss = () => {
		if (!busy) close();
	};
	async function submit(web = false) {
		if (busy) return;
		setBusy(true);
		setError('');
		try {
			let result: ForgeSnapshot;
			if (action === 'push' && push) result = await window.brigadir.pushChanges(task, push.id);
			else if (action === 'pr' && pr)
				result = await window.brigadir.createPullRequest(task, pr.id, {
					title,
					body,
					branch,
					head,
					base,
					web,
				});
			else return;
			draftRef.current = null;
			if (active.current) {
				accept(result);
				close();
			}
		} catch (error) {
			if (active.current) setError(failure(error));
		} finally {
			if (active.current) setBusy(false);
		}
	}
	const helper = useHelperRun('prText');
	async function generate() {
		if (!pr) return;
		setGenerating(true);
		setGenerationError(false);
		const revision = editRevision.current;
		try {
			const result = await window.brigadir.generatePullRequest(task, pr.id, helper.run);
			if (active.current && editRevision.current === revision) {
				setTitle(result.title);
				setBody(result.body);
			}
		} catch {
			if (active.current) setGenerationError(true);
		} finally {
			if (active.current) setGenerating(false);
		}
	}
	const pullRequests = useWorkspace((state) => state.appearance.modules.pullRequests);
	const heading = t(
			locale,
			action === 'push' ? 'Push commits' : action === 'pr' ? 'New pull request' : 'Checks'
		),
		checks = scope?.details?.checks ?? [],
		own = !!pr && !!head && head === pr.branch,
		branchSearch = {
			placeholder: t(locale, 'Search branches'),
			empty: t(locale, 'No branches match'),
			clear: t(locale, 'Clear the field'),
		},
		steps = pair ? pair.steps : own ? (pr?.steps ?? []) : [],
		// spec/pull-requests-and-ci#from-into: Create PR takes the pair main checked last — no reason, the same `From` and `Into`.
		paired =
			!!pair &&
			pair.head === head &&
			pair.base === base &&
			!pair.reason &&
			(!own || validBranch(branch)),
		counts = checks.reduce(
			(sum, check) => ({ ...sum, [check.bucket]: (sum[check.bucket] ?? 0) + 1 }),
			{} as Partial<Record<PRCheck['bucket'], number>>
		);
	return (
		<dialog
			ref={dialog}
			className={styles.dialog}
			data-kind={action}
			aria-label={heading}
			onCancel={(event) => {
				event.preventDefault();
				dismiss();
			}}>
			<header>
				<h2>
					{heading}
					{action === 'checks' && scope?.pr ? ` · #${scope.pr.number}` : ''}
				</h2>
				<PopupClose locale={locale} close={dismiss} />
			</header>
			{loading && <SkeletonRows count={4} height={34} />}
			{error && (
				<p className={styles.error} role="alert">
					{error}
				</p>
			)}
			{action === 'push' && push && (
				<>
					<PushList steps={push.steps} locale={locale} />
					{push.pr?.state === 'OPEN' && (
						<p>
							{t(locale, 'This push updates PR')} #{push.pr.number}.
						</p>
					)}
				</>
			)}
			{action === 'pr' && pr && (
				<>
					<p className={styles.branch}>
						<Glyph name="pr-branch" size={11} />
						{pr.name}
					</p>
					{/* spec/pull-requests-and-ci#from-into: `From → Into` — the sheet's branch list (spec/git#main-tree-branches, rule 17), a row of M as the fields. */}
					<div className={styles.pair} data-size="m" data-pr-pair>
						<div className={styles.end}>
							<span className={styles.endLabel}>{t(locale, 'From')}</span>
							<Popup
								label={t(locale, 'From')}
								disabled={busy}
								value={head}
								displayValue={head ? <BranchName name={head} /> : t(locale, 'Detached HEAD')}
								search={branchSearch}
								groups={{
									local: { label: t(locale, 'Local branches') },
									remote: { label: t(locale, 'Remote branches') },
								}}
								menuWidth={300}
								options={[
									...(pr.createsBranch
										? [
												{
													value: pr.branch,
													label: pr.branch,
													branch: true,
													group: 'local',
													tail: t(locale, 'New branch'),
												},
											]
										: []),
									...pr.heads.map((entry) => {
										const tail = entry.worktree ? 'worktree' : branchTail(locale, entry);
										return {
											value: entry.name,
											label: entry.name,
											branch: true,
											group: entry.remote ? 'remote' : 'local',
											...(tail ? { tail } : {}),
										};
									}),
								]}
								onChange={setHead}
							/>
						</div>
						<span className={styles.arrow} aria-hidden>
							→
						</span>
						<div className={styles.end}>
							<span className={styles.endLabel}>{t(locale, 'Into')}</span>
							<Popup
								label={t(locale, 'Into')}
								disabled={busy}
								align="end"
								value={base}
								displayValue={base ? <BranchName name={base} /> : '—'}
								search={branchSearch}
								menuWidth={300}
								options={pr.bases.map((name) => ({ value: name, label: name, branch: true }))}
								onChange={setBase}
							/>
						</div>
					</div>
					{own && pr.createsBranch && <p>{t(locale, 'A branch will be created automatically.')}</p>}
					{(pairError || !head || pair?.reason) && (
						<p className={styles.warning} data-pr-pair-reason>
							{(pairError && (t(locale, pairError as Parameters<typeof t>[1]) || pairError)) ||
								(!head
									? t(locale, 'Detached HEAD')
									: `${t(locale, pair!.reason as Parameters<typeof t>[1]) || pair!.reason}${pair!.open ? ` · #${pair!.open}` : ''}`)}
						</p>
					)}
					{pair && !pair.reason && (
						<p className={styles.ahead} data-pr-pair-ahead>
							{commitsAhead(locale, pair.ahead, pair.base)}
						</p>
					)}
					{own && pr.hasUncommittedChanges && (
						<p className={styles.warning}>
							{t(locale, 'Uncommitted changes stay local and are not included in this PR.')}
						</p>
					)}
					{own && pr.canRename && (
						<label className={styles.field}>
							{t(locale, 'Branch')}
							<TextInput
								value={branch}
								disabled={busy}
								onChange={(event) => setBranch(event.target.value)}
							/>
						</label>
					)}
					<label className={styles.field}>
						{t(locale, 'Title')}
						<TextInput
							value={title}
							disabled={busy}
							onChange={(event) => {
								editRevision.current++;
								setTitle(event.target.value);
							}}
						/>
					</label>
					<div className={styles.field}>
						{/* spec/pull-requests-and-ci#ci-segment: the label and Generate are a row of S — Generate is 24. */}
						<div className={styles.descriptionHeading} data-size="s">
							<label htmlFor="pr-description">{t(locale, 'Description')}</label>
							{/* spec/appearance#evolution-redesign: `Generate | ✳ Haiku 4.5 ▾` — the Helper agent, another one for this run in place. */}
							<HelperSplit
								locale={locale}
								state={helper}
								disabled={busy || generating}
								title={t(locale, 'Generate the title and description')}
								label={t(
									locale,
									generating ? 'Generating…' : generationError ? 'Generate again' : 'Generate'
								)}
								onClick={() => {
									void generate();
								}}
							/>
						</div>
						<TextArea
							id="pr-description"
							className={styles.description}
							value={body}
							disabled={busy}
							onChange={(event) => {
								editRevision.current++;
								setBody(event.target.value);
							}}
						/>
					</div>
					{generationError && (
						<p className={styles.warning}>
							{t(
								locale,
								'The description could not be generated. You can edit it and create the PR.'
							)}
						</p>
					)}
					{own && pr.warnings.length > 0 && (
						<p className={styles.warning}>
							{t(locale, 'Submodule commits must be available upstream before merging:')}{' '}
							{pr.warnings.join(', ')}
						</p>
					)}
					{steps.some((step) => step.count > 0) && (
						<div>
							<Button
								variant="ghost"
								size="s"
								className={styles.disclosure}
								aria-expanded={expanded}
								onClick={() => setExpanded(!expanded)}>
								<span data-open={expanded}>
									<Glyph name="commit-disclosure" size={9} />
								</span>
								{t(locale, 'Commits to push')}
							</Button>
							<div
								className={styles.reveal}
								data-open={expanded}
								inert={!expanded}
								aria-hidden={!expanded}>
								<div>
									<PushList
										steps={steps.map((step) =>
											own && step.scopeId === pr.scopeId ? { ...step, branch } : step
										)}
										locale={locale}
									/>
								</div>
							</div>
						</div>
					)}
				</>
			)}
			{action === 'checks' && scope?.pr && (
				<>
					<div className={styles.prSummary}>
						<strong>{scope.pr.title}</strong>
						<span>
							{t(
								locale,
								scope.pr.state === 'MERGED'
									? 'Merged'
									: scope.pr.state === 'CLOSED'
										? 'Closed'
										: 'Open'
							)}
						</span>
						<p className={styles.branch}>
							{scope.pr.head} → {scope.pr.base}
						</p>
					</div>
					{scope.details && (
						<>
							{checks.length > 0 && (
								<div className={styles.checkCounts}>
									{(['pass', 'fail', 'pending', 'skipping', 'cancel'] as const)
										.filter((bucket) => counts[bucket])
										.map((bucket) => (
											<span key={bucket}>
												{counts[bucket]}{' '}
												{t(
													locale,
													bucket === 'pass'
														? 'passed'
														: bucket === 'fail'
															? 'failed'
															: bucket === 'pending'
																? 'pending'
																: bucket === 'skipping'
																	? 'skipped'
																	: 'cancelled'
												)}
											</span>
										))}
								</div>
							)}
							{checks.length === 0 && <p>{t(locale, 'No checks')}</p>}
							{checks.length > 0 && (
								<div className={styles.checks}>
									{checks.map((check, index) => (
										<div
											className={styles.check}
											data-state={check.bucket}
											key={`${check.name}/${index}`}>
											<CIGlyph state={checkCIState(check.bucket)} />
											<span className={styles.checkName} title={check.name}>
												{check.name}
											</span>
											<small>
												{t(
													locale,
													check.bucket === 'pass'
														? 'passed'
														: check.bucket === 'fail'
															? 'failed'
															: check.bucket === 'pending'
																? 'pending'
																: check.bucket === 'skipping'
																	? 'skipped'
																	: 'cancelled'
												)}
											</small>
										</div>
									))}
								</div>
							)}
							{scope.details.mergeable === 'CONFLICTING' && (
								<p className={styles.warning}>
									{t(locale, 'This pull request has merge conflicts.')}
								</p>
							)}
						</>
					)}
				</>
			)}
			<footer data-size="m">
				{action === 'checks' ? (
					<>
						<Button
							disabled={loading}
							onClick={() => {
								void readChecks();
							}}>
							{t(locale, 'Refresh')}
						</Button>
						<Button
							disabled={!scope?.pr}
							onClick={() => {
								void window.brigadir
									.openPullRequest(task, scopeId)
									.catch((error) => setError(failure(error)));
							}}>
							{t(locale, 'Open on GitHub')}
						</Button>
						{/* spec/pull-requests-and-ci#task-pr-badge: the PR opens in the task's PR panel, beside the code. */}
						{pullRequests && (
							<Button
								appearance="primary"
								disabled={!scope?.pr}
								onClick={() => {
									if (!scope?.pr) return;
									openTaskPR(task, { scopeId, number: scope.pr.number });
									close();
								}}>
								{t(locale, 'Open PR')}
							</Button>
						)}
					</>
				) : (
					<>
						{action === 'pr' && pr && (
							<Button
								disabled={busy || generating || !title.trim() || !paired}
								onClick={() => {
									void submit(true);
								}}>
								{t(locale, 'Open form in browser')}
							</Button>
						)}
						<span />
						<Button disabled={busy} onClick={dismiss}>
							{t(locale, 'Cancel')}
						</Button>
						<Button
							appearance="primary"
							disabled={
								busy ||
								loading ||
								generating ||
								(action === 'pr' && (!pr || !title.trim() || !paired)) ||
								(action === 'push' && !push)
							}
							onClick={() => {
								void submit();
							}}>
							{action === 'pr' && <Glyph name="pr-branch" size={11} />}{' '}
							{t(locale, busy ? 'Working…' : action === 'push' ? 'Push' : 'Create PR')}
						</Button>
					</>
				)}
			</footer>
		</dialog>
	);
}
