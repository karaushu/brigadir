import { useCallback, useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import {
	ciLive,
	t,
	type AgentTask,
	type CIJob,
	type CIRun,
	type CIRunDetail,
	type CIRunsQuery,
	type CIStep,
	type CIWatch,
	type CIFinished,
	type Locale,
	type PRCheckRun,
} from '@brigadir/core';
import { openTaskRun, useTaskState } from './task-state';
import { useWorkspace } from './store';
import { openInTaskBrowser } from './FileLinks';
import { Glyph } from './ui/Glyph';
import { LoadingPlaceholder } from './ui/Loading';
import { Button, IconButton, Popup, PopupMarks } from './ui/Controls';
import { notify } from './ui/Toast';
import { CIGlyph, DeployBand, RunHead, RunJobs, RunRow, ciDuration } from './ui/RunSteps';
import styles from './PullRequestPanel.module.css';

/** The height of a run row (`ui/RunSteps` `.row`): the title line and the meta line under it. */
const RUN_ROW = 46;

/** spec/pull-requests-and-ci#ci: «Agent fixes it» for a failed job; which agent gets it is decided in TaskView. */
export type CIFix = (
	scopeId: string,
	detail: CIRunDetail,
	job: CIJob,
	step: CIStep | null,
	pr?: number
) => void;
const POLL = 10_000,
	DETAILS = 3;
/** The last seen deploy state of each run, one per app: the Checks tab and the Overview of the same PR give one toast. */
const seenDeploys = new Map<number, string>();
const liveDetail = (detail: CIRunDetail) =>
	ciLive(detail.run.state) || detail.deploy?.state === 'running';

/** spec/pull-requests-and-ci#ci-bell: main's watches; the bells redraw from its events. */
export const useCIWatches = create<{ watches: CIWatch[] }>(() => ({ watches: [] }));
/** Runs whose end the bell already announced: the watch is gone, but the surface gives no toast of its own for them. */
const toldByBell = new Set<string>();
const watchedBy = (watches: CIWatch[], projectId: string, scopeId: string, runId: number) =>
	watches.some(
		(watch) => watch.projectId === projectId && watch.scopeId === scopeId && watch.runId === runId
	);
export function useWatched(task: AgentTask, scopeId: string | null, runId: number) {
	return useCIWatches((state) =>
		scopeId ? watchedBy(state.watches, task.projectId, scopeId, runId) : false
	);
}
/** The watch's task (or its project, if the task is gone) and the run's page. */
function openWatched(event: Pick<CIFinished, 'watch'>) {
	const { watch } = event,
		workspace = useWorkspace.getState(),
		task = workspace.workspace?.tasks.find(
			(item) => item.projectId === watch.projectId && item.id === watch.taskId
		);
	if (location.hash === '#kit') location.hash = 'workspace';
	if (!task) return;
	workspace.selectTask(task.projectId, task.id);
	openTaskRun(task, { scopeId: watch.scopeId, runId: watch.runId });
}
/** Listener for main's events: the watch list, the toast at a run's end, a click on the OS notification. One per window (App). */
export function CIWatchEvents({ locale }: { locale: Locale }) {
	useEffect(() => {
		void window.brigadir
			.readCIWatches()
			.then((watches) => useCIWatches.setState({ watches }))
			.catch(() => {});
		const off = [
			window.brigadir.onCIWatches((watches) => useCIWatches.setState({ watches })),
			window.brigadir.onCIFinished((event) => {
				toldByBell.add(`${event.watch.projectId}:${event.run.id}`);
				notify(event.state === 'pass' ? 'success' : 'error', `${event.title}. ${event.body}`, {
					bold: event.title,
					key: `ci-watch:${event.watch.projectId}:${event.watch.runId}`,
					action: { label: t(locale, 'Open the run'), run: () => openWatched(event) },
					// spec/notifications-slack-notes-and-schedules#notification-center: main writes the run into the notification center itself.
					log: false,
				});
			}),
			window.brigadir.onCIOpen((event) => openWatched(event)),
		];
		return () => off.forEach((stop) => stop());
	}, [locale]);
	return null;
}
/** spec/pull-requests-and-ci#ci-bell: the bell in the run's header, only while there is something to wait for (or while already watching). */
export function WatchBell({
	task,
	locale,
	scopeId,
	detail,
	label,
}: {
	task: AgentTask;
	locale: Locale;
	scopeId: string;
	detail: CIRunDetail;
	label?: string | undefined;
}) {
	const run = detail.run,
		on = useWatched(task, scopeId, run.id),
		[busy, setBusy] = useState(false);
	if (!on && !liveDetail(detail)) return null;
	const toggle = async () => {
		setBusy(true);
		try {
			const watches = await window.brigadir.watchCIRun(
				{
					projectId: task.projectId,
					taskId: task.id,
					scopeId,
					runId: run.id,
					label: label ?? run.title,
				},
				!on
			);
			useCIWatches.setState({ watches });
		} catch {
			notify('error', t(locale, 'The run could not be read.'));
		} finally {
			setBusy(false);
		}
	};
	return (
		<IconButton
			size="s"
			label={t(locale, on ? 'Stop notifying' : 'Notify when the run finishes')}
			aria-pressed={on}
			aria-busy={busy || undefined}
			data-ci-bell={on ? 'on' : 'off'}
			className={styles.ciBell}
			onClick={() => void toggle()}>
			<Glyph name={on ? 'bell-on' : 'bell'} size={12} />
		</IconButton>
	);
}

/** «Open staging»: the environment's page in the task's browser (spec/browser-and-simulator#browser); with the browser module off, in the system one. */
export function openDeploy(task: AgentTask, url: string) {
	if (useWorkspace.getState().appearance.modules.browser) openInTaskBrowser(task, url);
	else void window.brigadir.openWebLink(url).catch(() => {});
}

/**
 * spec/pull-requests-and-ci#ci: a repo's runs and the details of some of them. Read on mount, on window focus and «Refresh»; while a
 * visible run is queued or running (or its deploy is), also every 10 s, and the timer goes with the surface. A deploy that
 * finished in view gives a toast with «Open staging».
 */
export function useCIRuns(
	task: AgentTask,
	locale: Locale,
	scopeId: string | null,
	query: CIRunsQuery | null,
	detailsFor: (run: CIRun) => boolean,
	label?: string
) {
	const key = scopeId && query ? JSON.stringify([task.projectId, task.id, scopeId, query]) : null;
	const [state, setState] = useState<{
		key: string | null;
		runs: CIRun[] | null;
		details: Record<number, CIRunDetail>;
		error: boolean;
	}>({ key, runs: null, details: {}, error: false });
	const seq = useRef(0),
		pick = useRef(detailsFor);
	pick.current = detailsFor;
	const read = useCallback(
		async (fresh: boolean) => {
			if (!scopeId || !query) return;
			const request = ++seq.current;
			try {
				const runs = await window.brigadir.readCIRuns(
					task.projectId,
					task.id,
					scopeId,
					query,
					fresh
				);
				const chosen = runs.filter((run) => pick.current(run)).slice(0, DETAILS),
					pairs = await Promise.all(
						chosen.map((run) =>
							window.brigadir.readCIRun(task.projectId, task.id, scopeId, run.id, fresh).then(
								(detail) => [run.id, detail] as const,
								() => null
							)
						)
					);
				if (request !== seq.current) return;
				const details = Object.fromEntries(pairs.filter((pair) => pair !== null));
				for (const detail of Object.values(details)) announce(task, locale, detail, label);
				setState({ key, runs, details, error: false });
			} catch {
				if (request === seq.current) setState((old) => ({ ...old, key, error: true }));
			}
		},
		[key]
	);
	useEffect(() => {
		setState({ key, runs: null, details: {}, error: false });
		void read(false);
		const focus = () => {
			void read(true);
		};
		window.addEventListener('focus', focus);
		return () => {
			seq.current++;
			window.removeEventListener('focus', focus);
		};
	}, [read]);
	const shown: { runs: CIRun[] | null; details: Record<number, CIRunDetail>; error: boolean } =
			state.key === key ? state : { runs: null, details: {}, error: false },
		live = Boolean(
			shown.runs?.some((run) => ciLive(run.state)) || Object.values(shown.details).some(liveDetail)
		);
	useEffect(() => {
		if (!live) return;
		const timer = setInterval(() => {
			void read(true);
		}, POLL);
		return () => clearInterval(timer);
	}, [live, read]);
	return {
		runs: shown.runs,
		details: shown.details,
		error: shown.error,
		live,
		refresh: () => read(true),
	};
}
export function useCIRun(task: AgentTask, locale: Locale, scopeId: string, runId: number) {
	const [state, setState] = useState<{ id: number; detail: CIRunDetail | null; error: boolean }>({
		id: runId,
		detail: null,
		error: false,
	});
	const seq = useRef(0);
	const read = useCallback(
		async (fresh: boolean) => {
			const request = ++seq.current;
			try {
				const detail = await window.brigadir.readCIRun(
					task.projectId,
					task.id,
					scopeId,
					runId,
					fresh
				);
				if (request !== seq.current) return;
				announce(task, locale, detail);
				setState({ id: runId, detail, error: false });
			} catch {
				if (request === seq.current) setState((old) => ({ ...old, error: true }));
			}
		},
		[task.projectId, task.id, scopeId, runId]
	);
	useEffect(() => {
		setState({ id: runId, detail: null, error: false });
		void read(false);
		const focus = () => {
			void read(true);
		};
		window.addEventListener('focus', focus);
		return () => {
			seq.current++;
			window.removeEventListener('focus', focus);
		};
	}, [read]);
	const detail = state.id === runId ? state.detail : null,
		live = Boolean(detail && liveDetail(detail));
	useEffect(() => {
		if (!live) return;
		const timer = setInterval(() => {
			void read(true);
		}, POLL);
		return () => clearInterval(timer);
	}, [live, read]);
	return { detail, error: state.error, refresh: () => read(true) };
}
/** A toast only for a transition the surface saw: the deploy was running and finished. */
function announce(task: AgentTask, locale: Locale, detail: CIRunDetail, label?: string) {
	const deploy = detail.deploy,
		before = seenDeploys.get(detail.run.id);
	if (!deploy) return;
	seenDeploys.set(detail.run.id, deploy.state);
	if (before !== 'running' || deploy.state === 'running') return;
	// spec/pull-requests-and-ci#ci-bell: main notifies about a run with a bell; the surface gives no toast of its own.
	if (
		toldByBell.has(`${task.projectId}:${detail.run.id}`) ||
		useCIWatches
			.getState()
			.watches.some((watch) => watch.projectId === task.projectId && watch.runId === detail.run.id)
	)
		return;
	const env = deploy.environment;
	if (deploy.state === 'pass')
		notify(
			'success',
			t(locale, '#{n} deployed to {env}.')
				.replace('#{n}', label ?? `${detail.run.workflow} #${detail.run.number}`)
				.replace('{env}', env),
			{
				bold: label,
				key: `deploy:${detail.run.id}`,
				...(deploy.url
					? {
							action: {
								label: t(locale, 'Open {env}').replace('{env}', env),
								run: () => openDeploy(task, deploy.url!),
							},
						}
					: {}),
			}
		);
	else
		notify('error', t(locale, 'Deploy to {env} failed.').replace('{env}', env), {
			key: `deploy:${detail.run.id}`,
			action: {
				label: t(locale, 'Open the run'),
				run: () => {
					void window.brigadir.openWebLink(detail.run.link).catch(() => {});
				},
			},
		});
}

/** A run with its jobs and steps: the same block in a merged PR's Checks tab and on the run page of the CI segment. */
export function RunBlock({
	task,
	locale,
	scopeId,
	detail,
	onCIFix,
	band = true,
	label,
}: {
	task: AgentTask;
	locale: Locale;
	scopeId: string;
	detail: CIRunDetail;
	onCIFix?: CIFix | undefined;
	band?: boolean;
	/** How to name the run in the spec/pull-requests-and-ci#ci-bell notification (`#421`); without it, the run's name. */
	label?: string | undefined;
}) {
	return (
		<div className={styles.ciRun} data-ci-run-block={detail.run.id}>
			{band && detail.deploy && (
				<DeployBand
					deploy={detail.deploy}
					jobs={detail.jobs}
					locale={locale}
					onOpen={(url) => openDeploy(task, url)}
				/>
			)}
			<RunHead
				run={detail.run}
				locale={locale}
				action={
					<WatchBell task={task} locale={locale} scopeId={scopeId} detail={detail} label={label} />
				}
			/>
			<RunJobs
				detail={detail}
				locale={locale}
				onLog={(link) => {
					void window.brigadir
						.openPullRequestLink(task.projectId, task.id, scopeId, link)
						.catch(() => {});
				}}
				onAgent={onCIFix ? (job, step) => onCIFix(scopeId, detail, job, step) : undefined}
			/>
		</div>
	);
}

/** spec/pull-requests-and-ci#ci: a merged PR's Checks tab: the runs on the merge commit, the PR's checks folded under them. */
export function MergedChecks({
	task,
	locale,
	scopeId,
	ci,
	checks,
	onCIFix,
	checkRows,
	label,
}: {
	task: AgentTask;
	locale: Locale;
	scopeId: string;
	ci: ReturnType<typeof useCIRuns>;
	checks: readonly PRCheckRun[];
	onCIFix?: CIFix | undefined;
	checkRows: React.ReactNode;
	label?: string | undefined;
}) {
	const [open, setOpen] = useState(false),
		runs = ci.runs ?? [],
		passed = checks.filter((check) => check.state === 'pass' || check.state === 'skipping').length;
	const workflows =
		[...new Set(checks.map((check) => check.workflow).filter(Boolean))].join(', ') ||
		t(locale, 'Checks');
	const state = checks.some((check) => check.state === 'fail')
		? 'fail'
		: checks.some((check) => check.state === 'pending')
			? 'running'
			: 'pass';
	return (
		<>
			<div className={styles.ciGroup}>
				<h3 className={styles.groupHeading} data-first="true">
					<span>{t(locale, 'After merge')}</span>
				</h3>
				{/* The state of the runs, only when there are runs: not «finished» while reading, on an error or with none. */}
				{runs.length > 0 && (
					<small>{t(locale, ci.live ? 'Updates while the run is going' : 'Run finished')}</small>
				)}
			</div>
			{!ci.runs && !ci.error && (
				<LoadingPlaceholder
					label={t(locale, 'Reading runs from GitHub…')}
					rows={2}
					height={RUN_ROW}
				/>
			)}
			{ci.error && (
				<div className={styles.error} role="alert">
					<Glyph name="check-fail" size={13} />
					<span>{t(locale, 'Runs could not be read: the network is unavailable.')}</span>
					<Button
						size="s"
						onClick={() => {
							void ci.refresh();
						}}>
						{t(locale, 'Retry')}
					</Button>
				</div>
			)}
			{ci.runs && !runs.length && (
				<p className={styles.hint}>{t(locale, 'No runs after the merge')}</p>
			)}
			{runs.map((run) => {
				const detail = ci.details[run.id];
				return detail ? (
					<RunBlock
						key={run.id}
						task={task}
						locale={locale}
						scopeId={scopeId}
						detail={detail}
						onCIFix={onCIFix}
						label={label}
					/>
				) : (
					<RunHead key={run.id} run={run} locale={locale} />
				);
			})}
			{checks.length > 0 && (
				<>
					<div className={styles.ciGroup}>
						<h3 className={styles.groupHeading}>
							<span>{t(locale, 'PR · before merge')}</span>
						</h3>
						<small>
							{state === 'pass'
								? t(locale, '{n}/{total} green')
										.replace('{n}', String(passed))
										.replace('{total}', String(checks.length))
								: `${passed}/${checks.length}`}
						</small>
					</div>
					<button
						type="button"
						className={styles.ciFold}
						aria-expanded={open}
						data-open={open || undefined}
						onClick={() => setOpen((value) => !value)}>
						<span className={styles.ciChevron}>
							<Glyph name="chevron-down" size={10} />
						</span>
						<CIGlyph state={state} />
						<span className={styles.ciFoldName}>
							{workflows} · {checks.length}
						</span>
						<small>
							{(() => {
								const total = checks.reduce((sum, check) => sum + (check.seconds ?? 0), 0);
								return total ? ciDuration(locale, total) : '';
							})()}
						</small>
					</button>
					{open && checkRows}
				</>
			)}
		</>
	);
}

/** spec/pull-requests-and-ci#ci: the CI segment: a repo's runs, «Yours» and «Others», Branch and Workflow filters; a click opens the run's page. */
export function CIListView({
	task,
	locale,
	scopeId,
	onCIFix,
	github,
	refreshRef,
}: {
	task: AgentTask;
	locale: Locale;
	scopeId: string | null;
	onCIFix?: CIFix | undefined;
	github(): void;
	refreshRef?: React.MutableRefObject<(() => Promise<void>) | null>;
}) {
	const [{ ciOpen, ciBranch, ciWorkflow }, setTask] = useTaskState(task),
		watches = useCIWatches((state) => state.watches);
	const query: CIRunsQuery = {
		...(ciBranch ? { branch: ciBranch } : {}),
		...(ciWorkflow ? { workflow: ciWorkflow } : {}),
	};
	const ci = useCIRuns(task, locale, ciOpen ? null : scopeId, ciOpen ? null : query, (run) =>
		ciLive(run.state)
	);
	if (refreshRef && !ciOpen) refreshRef.current = ci.refresh;
	// Filter values come from the unfiltered runs, so the chosen one stays in the menu.
	const [known, setKnown] = useState<{ branches: string[]; workflows: string[] }>({
		branches: [],
		workflows: [],
	});
	useEffect(() => {
		if (!ci.runs) return;
		setKnown((old) => ({
			branches: [
				...new Set([...old.branches, ...ci.runs!.map((run) => run.branch).filter(Boolean)]),
			],
			workflows: [...new Set([...old.workflows, ...ci.runs!.map((run) => run.workflow)])],
		}));
	}, [ci.runs]);
	if (ciOpen && scopeId)
		return (
			<CIRunView
				task={task}
				locale={locale}
				scopeId={ciOpen.scopeId}
				runId={ciOpen.runId}
				onCIFix={onCIFix}
				back={() => setTask({ ciOpen: null })}
				refreshRef={refreshRef}
			/>
		);
	const all = t(locale, 'all'),
		runs = ci.runs ?? [],
		mine = runs.filter((run) => run.mine),
		others = runs.filter((run) => !run.mine);
	const group = (label: string, list: CIRun[], first: boolean) =>
		list.length > 0 && (
			<section className={styles.group} role="group" aria-label={label}>
				<h3 className={styles.groupHeading} data-first={first}>
					<span>{label}</span>
					<small>{list.length}</small>
				</h3>
				{list.map((run) => {
					const job =
						ci.details[run.id]?.jobs.find((item) => item.state === 'running') ??
						ci.details[run.id]?.jobs.find((item) => ciLive(item.state));
					return (
						<RunRow
							key={run.id}
							run={run}
							locale={locale}
							steps={ciLive(run.state) ? (job?.steps ?? null) : null}
							watched={Boolean(scopeId && watchedBy(watches, task.projectId, scopeId, run.id))}
							onOpen={() => {
								if (scopeId) setTask({ ciOpen: { scopeId, runId: run.id } });
							}}
						/>
					);
				})}
			</section>
		);
	return (
		<>
			{/* spec/pull-requests-and-ci#ci-segment: the filters are as wide as their text; the list marks the chosen value with ✓. */}
			<div className={styles.ciFilters} data-size="s">
				<PopupMarks.Provider value>
					<Popup
						fit
						label={t(locale, 'Branch')}
						displayValue={`${t(locale, 'Branch')} ${ciBranch ?? all}`}
						value={ciBranch ?? ''}
						onChange={(value) => setTask({ ciBranch: value || null })}
						options={[
							{ value: '', label: all },
							...known.branches.map((branch) => ({ value: branch, label: branch })),
						]}
					/>
					<Popup
						fit
						label={t(locale, 'Workflow')}
						displayValue={`${t(locale, 'Workflow')} ${ciWorkflow ?? all}`}
						value={ciWorkflow ?? ''}
						onChange={(value) => setTask({ ciWorkflow: value || null })}
						options={[
							{ value: '', label: all },
							...known.workflows.map((workflow) => ({ value: workflow, label: workflow })),
						]}
					/>
				</PopupMarks.Provider>
			</div>
			<div className={styles.list} role="list" aria-label={t(locale, 'Workflow runs')}>
				{!ci.runs && !ci.error && (
					<LoadingPlaceholder
						label={t(locale, 'Reading runs from GitHub…')}
						rows={5}
						height={RUN_ROW}
					/>
				)}
				{ci.error && (
					<div className={styles.error} role="alert">
						<Glyph name="check-fail" size={13} />
						<span>{t(locale, 'Runs could not be read: the network is unavailable.')}</span>
						<Button
							size="s"
							onClick={() => {
								void ci.refresh();
							}}>
							{t(locale, 'Retry')}
						</Button>
					</div>
				)}
				{group(t(locale, 'Yours'), mine, true)}
				{group(t(locale, 'Others'), others, !mine.length)}
				{ci.runs && !runs.length && <p className={styles.hint}>{t(locale, 'No runs')}</p>}
				<span className={styles.space} />
				{/* While the runs are read or could not be, there is nothing older to point at. */}
				{scopeId && ci.runs && !ci.error && (
					<Button variant="ghost" size="s" className={styles.older} onClick={github}>
						{t(locale, 'Older runs are on GitHub')}
					</Button>
				)}
			</div>
		</>
	);
}
function CIRunView({
	task,
	locale,
	scopeId,
	runId,
	onCIFix,
	back,
	refreshRef,
}: {
	task: AgentTask;
	locale: Locale;
	scopeId: string;
	runId: number;
	onCIFix?: CIFix | undefined;
	back(): void;
	refreshRef?: React.MutableRefObject<(() => Promise<void>) | null> | undefined;
}) {
	const { detail, error, refresh } = useCIRun(task, locale, scopeId, runId);
	if (refreshRef) refreshRef.current = refresh;
	return (
		<div className={styles.list} data-ci-run-page={runId}>
			<div className={styles.ciRunTitle} data-size="s">
				<IconButton label={t(locale, 'Back to the runs')} onClick={back}>
					<Glyph name="chevron-left" size={11} />
				</IconButton>
				<h2 className={styles.prTitle} title={detail?.run.title}>
					{detail?.run.title ?? `#${runId}`}
				</h2>
				{detail && (
					<IconButton
						label={t(locale, 'Open on GitHub')}
						onClick={() => {
							void window.brigadir
								.openPullRequestLink(task.projectId, task.id, scopeId, detail.run.link)
								.catch(() => {});
						}}>
						<Glyph name="external" size={12} />
					</IconButton>
				)}
			</div>
			{error && (
				<div className={styles.error} role="alert">
					<Glyph name="check-fail" size={13} />
					<span>{t(locale, 'The run could not be read.')}</span>
					<Button
						size="s"
						onClick={() => {
							void refresh();
						}}>
						{t(locale, 'Retry')}
					</Button>
				</div>
			)}
			{!detail && !error && (
				<LoadingPlaceholder label={t(locale, 'Reading runs from GitHub…')} rows={4} height={28} />
			)}
			{detail && (
				<RunBlock task={task} locale={locale} scopeId={scopeId} detail={detail} onCIFix={onCIFix} />
			)}
		</div>
	);
}
/** A merged PR's state in the panel header and in Overview: «deploy 5/8», «deployed», «deploy failed» or the run's state. */
export function mergedState(
	ci: ReturnType<typeof useCIRuns>,
	locale: Locale
): { state: 'running' | 'pass' | 'fail'; text: string; detail: CIRunDetail | null } | null {
	const details = Object.values(ci.details),
		withDeploy = details.find((detail) => detail.deploy),
		runs = ci.runs ?? [];
	if (withDeploy?.deploy) {
		const deploy = withDeploy.deploy,
			job = withDeploy.jobs.find((item) => item.id === deploy.jobId),
			done =
				job?.steps.filter((step) => step.state === 'pass' || step.state === 'skipped').length ?? 0;
		return {
			state: deploy.state,
			detail: withDeploy,
			text:
				deploy.state === 'running'
					? t(locale, 'deploy {n}/{total}')
							.replace('{n}', String(Math.min(done + 1, job?.steps.length ?? 1)))
							.replace('{total}', String(job?.steps.length ?? 1))
					: t(locale, deploy.state === 'pass' ? 'deployed' : 'deploy failed'),
		};
	}
	if (!runs.length) return null;
	const state = runs.some((run) => run.state === 'fail')
		? 'fail'
		: runs.some((run) => ciLive(run.state))
			? 'running'
			: 'pass';
	return {
		state,
		detail: details[0] ?? null,
		text: t(
			locale,
			state === 'running' ? 'run going' : state === 'pass' ? 'run passed' : 'run failed'
		),
	};
}
