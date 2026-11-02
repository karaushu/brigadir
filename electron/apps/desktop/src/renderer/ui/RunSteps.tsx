import { useState, type ReactNode } from 'react';
import {
	prAge,
	t,
	type CIDeploy,
	type CIJob,
	type CIRun,
	type CIRunDetail,
	type CIState,
	type CIStep,
	type Locale,
	type PRCheckRun,
	type PRCheckState,
} from '@brigadir/core';
import { Glyph, type GlyphName } from './Glyph';
import { Button } from './Controls';
import { BranchName } from './BranchName';
import styles from './RunSteps.module.css';

/**
 * spec/pull-requests-and-ci#ci: one look for a GitHub Actions run in a merged PR's Checks tab, the CI segment's run page and the
 * Overview feed (rule 17). Job, step and run rows hover across their whole width (rule 15); a job expands to its steps.
 */
export const ciGlyph = (state: CIState): GlyphName =>
	state === 'pass'
		? 'check-pass'
		: state === 'fail'
			? 'check-fail'
			: state === 'running'
				? 'check-run'
				: state === 'queued'
					? 'check-queued'
					: 'check-skipped';
export function CIGlyph({ state, size = 12 }: { state: CIState; size?: number }) {
	return (
		<span className={styles.glyph} data-state={state}>
			<Glyph name={ciGlyph(state)} size={size} />
		</span>
	);
}
/** A check of a PR (or of the forge dialog) on the CI scale: skipped and cancelled get the same «circle with a dash» as a
 *  skipped or cancelled job and step (spec/pull-requests-and-ci#ci, rule 17), not a pending or failed glyph of their own. */
export const checkCIState = (state: PRCheckState): CIState =>
	state === 'pending'
		? 'running'
		: state === 'skipping'
			? 'skipped'
			: state === 'cancel'
				? 'cancelled'
				: state;
/** One check row of a PR: glyph, name (tooltip «workflow · check»), duration; a failed one has a red ground and
 *  «Log on GitHub». The tab Checks of an open PR and the folded checks under a merged PR's runs. */
export function CheckRow({
	check,
	locale,
	onLog,
}: {
	check: PRCheckRun;
	locale: Locale;
	onLog?: ((link: string) => void) | undefined;
}) {
	return (
		<div className={styles.check} data-state={check.state} data-check={check.name}>
			<div className={styles.checkLine}>
				<CIGlyph state={checkCIState(check.state)} />
				<span
					className={styles.checkName}
					title={check.workflow ? `${check.workflow} · ${check.name}` : check.name}>
					{check.name}
				</span>
				<small>{check.seconds === null ? '' : ciDuration(locale, check.seconds)}</small>
			</div>
			{check.state === 'fail' && check.link && onLog && (
				<div className={styles.checkLog} data-size="s">
					<Button size="s" onClick={() => onLog(check.link)}>
						<Glyph name="external" size={10} />
						{t(locale, 'Log on GitHub')}
					</Button>
				</div>
			)}
		</div>
	);
}
/** «1 хв 12 с» / «1 min 12 s»: the duration of a job, a step or a check. */
export function ciDuration(locale: Locale, seconds: number) {
	const minutes = Math.floor(seconds / 60),
		rest = seconds % 60;
	return minutes
		? locale === 'en'
			? `${minutes} min ${String(rest).padStart(2, '0')} s`
			: `${minutes} хв ${String(rest).padStart(2, '0')} с`
		: locale === 'en'
			? `${rest} s`
			: `${rest} с`;
}
const live = (state: CIState) => state === 'queued' || state === 'running';
/** The running (or failed) step and its number out of all: «Push to ECR · step 5 of 8». */
export function currentStep(job: CIJob): { step: CIStep; index: number } | null {
	const index = job.steps.findIndex((step) => step.state === 'running' || step.state === 'fail');
	return index < 0 ? null : { step: job.steps[index]!, index };
}

/** `action` — the spec/pull-requests-and-ci#ci-bell bell at the right of the first line; the row then takes the S button's height (rule 16). */
export function RunHead({
	run,
	locale,
	action,
}: {
	run: CIRun;
	locale: Locale;
	action?: ReactNode;
}) {
	return (
		<div className={styles.head} data-ci-run-head={run.id}>
			<div className={styles.headLine} data-size={action ? 's' : undefined}>
				<CIGlyph state={run.state} />
				<span className={styles.headTitle}>
					{run.workflow} <span className={styles.number}>#{run.number}</span>
				</span>
				{run.seconds !== null && <small>{ciDuration(locale, run.seconds)}</small>}
				{action}
			</div>
			<div className={styles.headMeta}>
				{run.branch && (
					<span className={styles.branch}>
						<BranchName name={run.branch} />
					</span>
				)}
				<span>{t(locale, 'merge commit')}</span>
				<code>{run.sha.slice(0, 7)}</code>
				{run.actor && <span>· {t(locale, 'started by {who}').replace('{who}', run.actor)}</span>}
			</div>
		</div>
	);
}

/** spec/pull-requests-and-ci#ci: the deploy band — only for a job with an environment that GitHub made a deployment for. */
export function DeployBand({
	deploy,
	jobs,
	locale,
	onOpen,
}: {
	deploy: CIDeploy;
	jobs: readonly CIJob[];
	locale: Locale;
	onOpen?: ((url: string) => void) | undefined;
}) {
	const job = jobs.find((item) => item.id === deploy.jobId),
		at = job ? currentStep(job) : null,
		env = deploy.environment;
	const title = t(
		locale,
		deploy.state === 'pass'
			? 'Deployed to {env}'
			: deploy.state === 'fail'
				? 'Deploy to {env} failed'
				: 'Deploying to {env}'
	).replace('{env}', env);
	const detail =
		deploy.state === 'pass'
			? (deploy.url?.replace(/^https?:\/\//, '').replace(/\/$/, '') ?? job?.name ?? '')
			: job && at
				? `${job.name} · ${at.step.name} · ${t(locale, 'step {n} of {total}')
						.replace('{n}', String(at.index + 1))
						.replace('{total}', String(job.steps.length))}`
				: (job?.name ?? '');
	return (
		<div className={styles.deploy} data-ci-deploy={deploy.state} role="status">
			<CIGlyph state={deploy.state === 'running' ? 'running' : deploy.state} size={14} />
			<span className={styles.deployText}>
				<b>{title}</b>
				{detail && <small>{detail}</small>}
			</span>
			{deploy.state === 'pass' && deploy.url && onOpen && (
				<Button size="s" onClick={() => onOpen(deploy.url!)}>
					<Glyph name="globe" size={11} />
					{t(locale, 'Open {env}').replace('{env}', env)}
				</Button>
			)}
		</div>
	);
}

type JobActions = {
	onLog?: ((link: string) => void) | undefined;
	onAgent?: ((job: CIJob, step: CIStep | null) => void) | undefined;
};
function StepRow({
	step,
	locale,
	children,
}: {
	step: CIStep;
	locale: Locale;
	children?: ReactNode;
}) {
	return (
		<>
			<div className={styles.step} data-state={step.state} role="listitem">
				<span className={styles.stepNo}>{step.number}</span>
				<CIGlyph state={step.state} size={11} />
				<span className={styles.stepName} title={step.name}>
					{step.name}
				</span>
				<small>{step.seconds === null ? '' : ciDuration(locale, step.seconds)}</small>
			</div>
			{children}
		</>
	);
}
export function JobRow({
	job,
	locale,
	deploy,
	annotation,
	open,
	toggle,
	onLog,
	onAgent,
}: {
	job: CIJob;
	locale: Locale;
	deploy: CIDeploy | null;
	annotation: string | null;
	open: boolean;
	toggle(): void;
} & JobActions) {
	const at = currentStep(job),
		failed = job.steps.find((step) => step.state === 'fail') ?? null;
	const time =
		live(job.state) && at && job.steps.length
			? t(locale, 'step {n}/{total}')
					.replace('{n}', String(at.index + 1))
					.replace('{total}', String(job.steps.length))
			: job.seconds === null
				? ''
				: ciDuration(locale, job.seconds);
	const actions =
		job.state === 'fail' && (onLog || onAgent) ? (
			<div className={styles.actions} data-size="s">
				{onLog && (
					<Button size="s" onClick={() => onLog(job.link)}>
						<Glyph name="external" size={10} />
						{t(locale, 'Log on GitHub')}
					</Button>
				)}
				{onAgent && (
					<Button size="s" onClick={() => onAgent(job, failed)}>
						<Glyph name="generate" size={11} />
						{t(locale, 'Agent fixes it')}
					</Button>
				)}
			</div>
		) : null;
	const note = annotation ? (
		<div className={styles.annotation}>
			<small>
				{t(locale, 'GitHub annotation')} · {job.name}
			</small>
			{annotation}
		</div>
	) : null;
	return (
		<div
			className={styles.job}
			data-state={job.state}
			data-open={open || undefined}
			data-ci-job={job.name}>
			<button
				type="button"
				className={styles.jobLine}
				aria-expanded={open}
				disabled={!job.steps.length}
				onClick={toggle}>
				<span className={styles.chevron}>
					<Glyph name="chevron-down" size={10} />
				</span>
				<CIGlyph state={job.state} />
				<span className={styles.jobName} title={job.name}>
					{job.name}
				</span>
				{deploy && deploy.jobId === job.id && (
					<span className={styles.env}>
						<Glyph name="deploy" size={10} />
						{deploy.environment}
					</span>
				)}
				<small>{time}</small>
			</button>
			{open && job.steps.length > 0 && (
				<div
					className={styles.steps}
					role="list"
					aria-label={t(locale, 'Steps of {job}').replace('{job}', job.name)}>
					{job.steps.map((step) => (
						<StepRow key={step.number} step={step} locale={locale}>
							{step === failed && (
								<>
									{note}
									{actions}
								</>
							)}
						</StepRow>
					))}
				</div>
			)}
			{!open && job.state === 'fail' && !failed && (
				<>
					{note}
					{actions}
				</>
			)}
		</div>
	);
}
/** A run's jobs: the running or failed one is expanded by itself; the rest on click. */
export function RunJobs({
	detail,
	locale,
	onLog,
	onAgent,
}: { detail: CIRunDetail; locale: Locale } & JobActions) {
	const auto = new Set(
			detail.jobs
				.filter((job) => job.state === 'running' || job.state === 'fail')
				.map((job) => job.id)
		),
		[toggled, setToggled] = useState<Set<number>>(new Set());
	return (
		<div className={styles.jobs} role="list" aria-label={t(locale, 'Workflow runs')}>
			{detail.jobs.map((job) => {
				const open = auto.has(job.id) !== toggled.has(job.id);
				return (
					<JobRow
						key={job.id}
						job={job}
						locale={locale}
						deploy={detail.deploy}
						annotation={detail.annotation?.jobId === job.id ? detail.annotation.message : null}
						open={open}
						toggle={() =>
							setToggled((set) => {
								const next = new Set(set);
								if (next.has(job.id)) next.delete(job.id);
								else next.add(job.id);
								return next;
							})
						}
						onLog={onLog}
						onAgent={onAgent}
					/>
				);
			})}
		</div>
	);
}

/** A row of the CI segment list; a running run shows the step band of its running job. */
export function RunRow({
	run,
	locale,
	steps,
	onOpen,
	watched = false,
}: {
	run: CIRun;
	locale: Locale;
	steps?: readonly CIStep[] | null;
	onOpen(): void;
	/** spec/pull-requests-and-ci#ci-bell: the bell watches the run. */
	watched?: boolean;
}) {
	return (
		<button
			type="button"
			className={styles.row}
			data-state={run.state}
			data-ci-run={run.id}
			onClick={onOpen}>
			<span className={styles.rowLine}>
				<CIGlyph state={run.state} />
				<span className={styles.rowTitle} title={run.title}>
					{run.title || `${run.workflow} #${run.number}`}
				</span>
				<small>{prAge(locale, run.createdAt)}</small>
				{watched && (
					<span
						className={styles.watched}
						role="img"
						aria-label={t(locale, 'Notifies when the run finishes')}
						title={t(locale, 'Notifies when the run finishes')}
						data-ci-watched>
						<Glyph name="bell-on" size={11} />
					</span>
				)}
			</span>
			<span className={styles.rowMeta}>
				<span>
					{run.workflow} #{run.number}
					{run.mine ? '' : ` · ${run.actor}`}
				</span>
				{run.branch && (
					<span className={styles.branch}>
						<BranchName name={run.branch} />
					</span>
				)}
				<span className={styles.space} />
				{run.seconds !== null && <span>{ciDuration(locale, run.seconds)}</span>}
			</span>
			{steps && steps.length > 0 && (
				<span className={styles.bar} aria-hidden="true">
					{steps.map((step) => (
						<i key={step.number} data-state={step.state} />
					))}
				</span>
			)}
		</button>
	);
}
