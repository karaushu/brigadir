import {
	isRecord,
	isWebURL,
	type CIState,
	type CIStep,
	type CIJob,
	type CIRun,
	type CIDeploy,
	type CIAnnotation,
} from '@brigadir/core';
/**
 * spec/pull-requests-and-ci#ci: GitHub Actions runs, jobs, steps and deployments over REST (`gh api`). GitHub's shapes are read defensively:
 * a run, job or step that does not parse is dropped, not shown half-empty.
 */
const live = ['queued', 'waiting', 'requested', 'pending'];
export function ciState(status: unknown, conclusion: unknown): CIState {
	if (status !== 'completed')
		return typeof status === 'string' && live.includes(status) ? 'queued' : 'running';
	switch (conclusion) {
		case 'success':
		case 'neutral':
			return 'pass';
		case 'cancelled':
		case 'stale':
			return 'cancelled';
		case 'skipped':
			return 'skipped';
		default:
			return 'fail';
	}
}
function text(value: unknown, max = 500) {
	return typeof value === 'string' ? value.slice(0, max) : '';
}
function id(value: unknown) {
	return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}
function seconds(start: unknown, end: unknown, now = Date.now()) {
	const from = typeof start === 'string' ? Date.parse(start) : NaN,
		to = typeof end === 'string' ? Date.parse(end) : now;
	return Number.isFinite(from) && Number.isFinite(to)
		? Math.max(0, Math.round((to - from) / 1000))
		: null;
}
export function parseRuns(value: unknown, viewer: string | null): CIRun[] {
	if (!isRecord(value) || !Array.isArray(value.workflow_runs)) return [];
	return value.workflow_runs.flatMap((run) => {
		if (!isRecord(run)) return [];
		const runId = id(run.id),
			number = id(run.run_number);
		if (!runId || !number || !isWebURL(run.html_url)) return [];
		const state = ciState(run.status, run.conclusion),
			actor =
				isRecord(run.actor) && typeof run.actor.login === 'string'
					? run.actor.login.slice(0, 100)
					: '';
		const sha = text(run.head_sha, 64);
		if (!/^[0-9a-f]{7,64}$/.test(sha)) return [];
		return [
			{
				id: runId,
				workflow: text(run.name, 200) || 'Workflow',
				number,
				title:
					text(run.display_title, 500) ||
					(text(isRecord(run.head_commit) ? run.head_commit.message : '', 500).split('\n')[0] ??
						''),
				branch: text(run.head_branch, 255),
				sha,
				actor,
				mine: !!viewer && actor === viewer,
				state,
				createdAt: text(run.created_at, 64),
				seconds: seconds(
					run.run_started_at ?? run.created_at,
					state === 'queued' || state === 'running' ? undefined : run.updated_at
				),
				link: run.html_url,
			},
		];
	});
}
function steps(value: unknown): CIStep[] {
	if (!Array.isArray(value)) return [];
	return value
		.flatMap((step) => {
			if (!isRecord(step)) return [];
			const number = id(step.number);
			if (!number) return [];
			const state = ciState(step.status, step.conclusion);
			return [
				{
					number,
					name: text(step.name, 300) || `Step ${number}`,
					state,
					seconds:
						state === 'queued' || state === 'skipped'
							? null
							: seconds(step.started_at, state === 'running' ? undefined : step.completed_at),
				},
			];
		})
		.sort((a, b) => a.number - b.number);
}
export function parseJobs(value: unknown): CIJob[] {
	if (!isRecord(value) || !Array.isArray(value.jobs)) return [];
	return value.jobs.flatMap((job) => {
		if (!isRecord(job)) return [];
		const jobId = id(job.id);
		if (!jobId || !isWebURL(job.html_url)) return [];
		const state = ciState(job.status, job.conclusion);
		return [
			{
				id: jobId,
				name: text(job.name, 300) || 'Job',
				state,
				seconds:
					state === 'queued' || state === 'skipped'
						? null
						: seconds(job.started_at, state === 'running' ? undefined : job.completed_at),
				link: job.html_url,
				steps: steps(job.steps),
			},
		];
	});
}
/** The job a deployment status belongs to: GitHub writes its page into `log_url` (`…/actions/runs/1/job/2`). */
function statusJob(status: Record<string, unknown>) {
	const link = [status.log_url, status.target_url].find(
		(value) => typeof value === 'string' && /\/job\/\d+/.test(value)
	) as string | undefined;
	const match = link?.match(/\/job\/(\d+)/);
	return match ? Number(match[1]) : null;
}
export function deployState(state: unknown): CIDeploy['state'] | null {
	switch (state) {
		case 'success':
		case 'inactive':
			return 'pass';
		case 'failure':
		case 'error':
			return 'fail';
		case 'queued':
		case 'pending':
		case 'in_progress':
			return 'running';
		default:
			return null;
	}
}
/** spec/pull-requests-and-ci#ci: the deployment of one of these jobs; one without a job of this run, or without a status, says nothing. */
export function parseDeploy(
	deployment: unknown,
	statuses: unknown,
	jobs: readonly CIJob[]
): CIDeploy | null {
	if (!isRecord(deployment) || !Array.isArray(statuses)) return null;
	const status = statuses.find(isRecord);
	if (!status) return null;
	const state = deployState(status.state),
		jobId = statusJob(status);
	if (!state || !jobId || !jobs.some((job) => job.id === jobId)) return null;
	const environment = text(deployment.environment, 100) || text(status.environment, 100);
	if (!environment) return null;
	return {
		environment,
		state,
		url: isWebURL(status.environment_url) ? status.environment_url : null,
		jobId,
	};
}
export function parseAnnotation(value: unknown, jobId: number): CIAnnotation | null {
	if (!Array.isArray(value)) return null;
	const note = value.find(
		(item) =>
			isRecord(item) &&
			item.annotation_level === 'failure' &&
			typeof item.message === 'string' &&
			item.message.trim()
	);
	return isRecord(note) ? { jobId, message: text(note.message, 500).trim() } : null;
}
