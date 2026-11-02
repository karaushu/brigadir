import { isRecord } from './workspace';
import { isWebURL, type ForgeAuth, type ForgeRepository } from './forge';

/** spec/pull-requests-and-ci#pr-panel: our own PR domain model (rule 1). The GitHub response shape stays in forge. */
export type PRState = 'OPEN' | 'DRAFT' | 'MERGED' | 'CLOSED';
export type PRReviewDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
export type PRReviewState =
	'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'PENDING' | 'DISMISSED';
export type PRChecksState = 'pass' | 'fail' | 'pending' | 'none';
export type PRReviewer = { login: string; state: PRReviewState | 'REQUESTED' };
export type PullRequestSummary = {
	number: number;
	title: string;
	url: string;
	state: PRState;
	author: string;
	mine: boolean;
	waiting: boolean;
	head: string;
	base: string;
	updatedAt: string;
	closedAt: string | null;
	reviewDecision: PRReviewDecision;
	reviewers: PRReviewer[];
	comments: number;
	checks: PRChecksState;
	/** spec/remote-access-and-mobile#phone-pr-list: `+N −M` of the list row, read by the same list query; absent in an older cache. */ additions?: number;
	deletions?: number;
};
/** One repo of a task or project; `error` — a read failure, not "no PRs" (spec/pull-requests-and-ci#reading-and-refresh). */
export type RepoPullRequests = {
	scopeId: string;
	name: string;
	repository: ForgeRepository | null;
	prs: PullRequestSummary[];
	error: string | null;
};
export type PullRequestsSnapshot = {
	auth: ForgeAuth;
	viewer: string | null;
	repos: RepoPullRequests[];
};

/** Recently closed — 7 days. */
export const recentlyClosedDays = 7;
export function recentlyClosed(
	pr: Pick<PullRequestSummary, 'state' | 'closedAt'>,
	now = Date.now()
) {
	return (
		(pr.state === 'MERGED' || pr.state === 'CLOSED') &&
		pr.closedAt !== null &&
		now - Date.parse(pr.closedAt) <= recentlyClosedDays * 86_400_000
	);
}
export const isOpenPR = (pr: Pick<PullRequestSummary, 'state'>) =>
	pr.state === 'OPEN' || pr.state === 'DRAFT';
export type PRCounts = { open: number; closed: number; waiting: boolean };
export function prCounts(prs: readonly PullRequestSummary[], now = Date.now()): PRCounts {
	return {
		open: prs.filter(isOpenPR).length,
		closed: prs.filter((pr) => recentlyClosed(pr, now)).length,
		waiting: prs.some((pr) => isOpenPR(pr) && pr.waiting),
	};
}
export type PRGroup = 'waiting' | 'mine' | 'others' | 'closed';
/** spec/pull-requests-and-ci#pr-list: Waiting for you, Yours, Others, Recently closed; newer first within each. */
export function prGroups(
	prs: readonly PullRequestSummary[],
	now = Date.now()
): { group: PRGroup; prs: PullRequestSummary[] }[] {
	const by = (group: PRGroup) =>
		prs
			.filter((pr) =>
				group === 'closed'
					? recentlyClosed(pr, now)
					: isOpenPR(pr) &&
						(group === 'waiting'
							? pr.waiting
							: group === 'mine'
								? !pr.waiting && pr.mine
								: !pr.waiting && !pr.mine)
			)
			.sort(
				(a, b) =>
					Date.parse(group === 'closed' ? b.closedAt! : b.updatedAt) -
					Date.parse(group === 'closed' ? a.closedAt! : a.updatedAt)
			);
	return (['waiting', 'mine', 'others', 'closed'] as const)
		.map((group) => ({ group, prs: by(group) }))
		.filter((item) => item.prs.length > 0);
}
/** Review state as one mark (spec/pull-requests-and-ci#repo-counter): your own PR shows the reviewers' verdict, someone else's shows that it waits for you. */
export type PRMark = 'waiting' | 'changes' | 'approved' | null;
export function prMark(pr: Pick<PullRequestSummary, 'waiting' | 'reviewDecision'>): PRMark {
	return pr.waiting
		? 'waiting'
		: pr.reviewDecision === 'CHANGES_REQUESTED'
			? 'changes'
			: pr.reviewDecision === 'APPROVED'
				? 'approved'
				: null;
}

/* ── PRs in the panel and Overview (spec/pull-requests-and-ci#pr-list, spec/chat#row-engine) ── */
export type PRThreadComment = {
	id: string;
	databaseId: number;
	author: string;
	body: string;
	createdAt: string;
	url: string;
};
export type PRThread = {
	id: string;
	path: string;
	line: number | null;
	startLine: number | null;
	side: 'LEFT' | 'RIGHT';
	resolved: boolean;
	outdated: boolean;
	comments: PRThreadComment[];
	/** The end of the first comment's diff hunk — the code lines in Overview. */ hunk: string | null;
};
export type PRIssueComment = {
	id: string;
	author: string;
	body: string;
	createdAt: string;
	url: string;
};
export type PRReview = {
	id: string;
	author: string;
	state: PRReviewState;
	body: string;
	submittedAt: string;
};
export type PRFileChange = 'ADDED' | 'DELETED' | 'MODIFIED' | 'RENAMED' | 'COPIED' | 'CHANGED';
export type PRFile = {
	path: string;
	additions: number;
	deletions: number;
	change: PRFileChange;
	viewed: boolean;
};
export type PRCommitEntry = { sha: string; subject: string; author: string; at: string };
export type PRCheckState = 'pass' | 'fail' | 'pending' | 'skipping' | 'cancel';
export type PRCheckRun = {
	name: string;
	workflow: string | null;
	state: PRCheckState;
	link: string;
	seconds: number | null;
};
export type PRMergeMethod = 'squash' | 'merge' | 'rebase';
/** `mergeState` — GitHub's `mergeStateStatus`: merging is possible only at `CLEAN` (spec/pull-requests-and-ci#merge). */
export type PullRequestDetail = {
	id: string;
	summary: PullRequestSummary;
	body: string;
	createdAt: string;
	headSha: string;
	/** spec/pull-requests-and-ci#ci: the merge commit of a merged PR; the deploy runs on it. */ mergeSha?:
		string | null;
	/** spec/pull-requests-and-ci#pr-files: the tip of the base branch on GitHub; with it and the head present locally a PR file needs no `git fetch`. */ baseSha?:
		string | null;
	additions: number;
	deletions: number;
	mergeState: string;
	mergeable: string;
	requiredApprovals: number | null;
	canPush: boolean;
	/** spec/pull-requests-and-ci#resolve-conflicts: the head branch lives in a fork; a push to `origin` would not reach the PR. */ crossRepository?: boolean;
	canMerge: boolean;
	mergeMethods: PRMergeMethod[];
	defaultMergeMethod: PRMergeMethod;
	threads: PRThread[];
	comments: PRIssueComment[];
	reviews: PRReview[];
	files: PRFile[];
	commits: PRCommitEntry[];
	checks: PRCheckRun[];
};
export type PRRefKey = { scopeId: string; number: number };
/** spec/pull-requests-and-ci#pr-definition: a declaration found by name in the PR head tree; `changed` — the file is among the PR's changes. */
export type PRDefinitionPlace = {
	path: string;
	line: number;
	column: number;
	preview: string;
	changed: boolean;
};
/** spec/pull-requests-and-ci#ci: a GitHub Actions run, job or step in one state; `skipped` — not run because an earlier step failed or a condition. */
export type CIState = 'queued' | 'running' | 'pass' | 'fail' | 'cancelled' | 'skipped';
export type CIStep = { number: number; name: string; state: CIState; seconds: number | null };
export type CIJob = {
	id: number;
	name: string;
	state: CIState;
	seconds: number | null;
	link: string;
	steps: CIStep[];
};
/** `title` — the commit headline or the PR title GitHub shows for the run; `mine` — run by the viewer. */
export type CIRun = {
	id: number;
	workflow: string;
	number: number;
	title: string;
	branch: string;
	sha: string;
	actor: string;
	mine: boolean;
	state: CIState;
	createdAt: string;
	seconds: number | null;
	link: string;
};
/** spec/pull-requests-and-ci#ci: a deployment GitHub made for a job with `environment`; `jobId` — the job whose id stands in the status `log_url`. */
export type CIDeploy = {
	environment: string;
	state: 'running' | 'pass' | 'fail';
	url: string | null;
	jobId: number | null;
};
/** First `failure` annotation of the failed job (spec/pull-requests-and-ci#ci) — one line, not a log. */
export type CIAnnotation = { jobId: number; message: string };
export type CIRunDetail = {
	run: CIRun;
	jobs: CIJob[];
	deploy: CIDeploy | null;
	annotation: CIAnnotation | null;
};
export type CIRunsQuery = { sha?: string; branch?: string; workflow?: string };
/** spec/pull-requests-and-ci#ci-bell: a run someone asked to be told about; `label` names it in the notification (`#421`, the run title). */
export type CIWatch = {
	projectId: string;
	taskId: string | null;
	scopeId: string;
	runId: number;
	label: string;
	since?: number;
};
/** A bell the renderer may set (spec/pull-requests-and-ci#ci-bell); the watch file reuses it when it reads back. */
export function isCIWatch(value: unknown): value is CIWatch {
	return (
		isRecord(value) &&
		typeof value.projectId === 'string' &&
		value.projectId.length > 0 &&
		(value.taskId === null || (typeof value.taskId === 'string' && value.taskId.length > 0)) &&
		typeof value.scopeId === 'string' &&
		value.scopeId.length > 0 &&
		value.scopeId.length <= 512 &&
		Number.isSafeInteger(value.runId) &&
		Number(value.runId) > 0 &&
		typeof value.label === 'string' &&
		value.label.length <= 300 &&
		(value.since === undefined || typeof value.since === 'number')
	);
}
/** spec/pull-requests-and-ci#ci-bell: a watched run ended — the OS notification and the in-app toast say the same. */
export type CIFinished = {
	watch: CIWatch;
	run: CIRun;
	state: 'pass' | 'fail' | 'cancelled';
	title: string;
	body: string;
};
export function isCIRunsQuery(value: unknown): value is CIRunsQuery {
	return (
		isRecord(value) &&
		Object.keys(value).every((key) => ['sha', 'branch', 'workflow'].includes(key)) &&
		(value.sha === undefined ||
			(typeof value.sha === 'string' && /^[0-9a-f]{7,64}$/.test(value.sha))) &&
		(value.branch === undefined ||
			(typeof value.branch === 'string' &&
				value.branch.length > 0 &&
				value.branch.length <= 255)) &&
		(value.workflow === undefined ||
			(typeof value.workflow === 'string' &&
				value.workflow.length > 0 &&
				value.workflow.length <= 255))
	);
}
/** A run still moves: the surface that shows it reads it again every 10 s (spec/pull-requests-and-ci#ci). */
export function ciLive(state: CIState) {
	return state === 'queued' || state === 'running';
}
/** `stale` — the clicked line is no longer that line of the head blob (the PR moved on). */
export type PRDefinitionAnswer =
	| { state: 'stale' }
	| { state: 'found'; word: string; places: PRDefinitionPlace[]; truncated: boolean };
export function isPRRefKey(value: unknown): value is PRRefKey {
	return (
		isRecord(value) &&
		Object.keys(value).length === 2 &&
		typeof value.scopeId === 'string' &&
		value.scopeId.length > 0 &&
		value.scopeId.length <= 512 &&
		Number.isSafeInteger(value.number) &&
		Number(value.number) > 0
	);
}
/** spec/appearance#evolution-redesign: what a PR list row tells main for its right-click menu — the state, the head branch and the page. */
export type PRMenuRow = Pick<PullRequestSummary, 'state' | 'head' | 'url'>;
/** The menu's answer; the copies finish in main and answer null. */
export type PRMenuAction = 'review' | 'agent-quick' | 'agent-worktree' | 'conflicts' | 'github';
const prStates: readonly unknown[] = ['OPEN', 'DRAFT', 'MERGED', 'CLOSED'] satisfies PRState[];
export function isPRMenuRow(value: unknown): value is PRMenuRow {
	return (
		isRecord(value) &&
		Object.keys(value).length === 3 &&
		prStates.includes(value.state) &&
		typeof value.head === 'string' &&
		value.head.length > 0 &&
		value.head.length <= 255 &&
		!/[\0-\x1f\x7f]/.test(value.head) &&
		isWebURL(value.url)
	);
}
/** Checks as one state: any failed — fail; else any running — pending; else pass; empty — none. */
export function checksState(checks: readonly Pick<PRCheckRun, 'state'>[]): PRChecksState {
	return !checks.length
		? 'none'
		: checks.some((check) => check.state === 'fail')
			? 'fail'
			: checks.some((check) => check.state === 'pending')
				? 'pending'
				: 'pass';
}
/** Why «Merge PR…» is disabled — in words, not a GitHub code (spec/pull-requests-and-ci#merge). */
export type MergeBlock =
	'approvals' | 'checks' | 'conflicts' | 'draft' | 'closed' | 'permission' | 'blocked' | null;
/** spec/pull-requests-and-ci#merge-card: the words of a merge block — the Merge card says them, the merge button's tooltip too; `approvals` is counted. */
export const mergeBlockLabels = {
	approvals: 'An approval is required',
	checks: 'Checks did not pass',
	conflicts: 'Conflicts with {base}',
	draft: 'The PR is a draft',
	closed: 'The PR is closed',
	permission: 'You cannot merge in this repo',
	blocked: 'GitHub does not allow merging yet',
} as const;
export function mergeBlock(
	detail: Pick<PullRequestDetail, 'mergeState' | 'mergeable' | 'canMerge' | 'summary' | 'checks'>
): MergeBlock {
	if (!isOpenPR(detail.summary)) return 'closed';
	if (detail.summary.state === 'DRAFT' || detail.mergeState === 'DRAFT') return 'draft';
	if (!detail.canMerge) return 'permission';
	if (detail.mergeState === 'CLEAN') return null;
	if (detail.mergeable === 'CONFLICTING' || detail.mergeState === 'DIRTY') return 'conflicts';
	if (checksState(detail.checks) === 'fail' || detail.mergeState === 'UNSTABLE') return 'checks';
	if (
		detail.summary.reviewDecision === 'REVIEW_REQUIRED' ||
		detail.summary.reviewDecision === 'CHANGES_REQUESTED'
	)
		return 'approvals';
	return 'blocked';
}

/**
 * spec/appearance#evolution-redesign: what the review modal's merge control stands for — the PR's state, a conflict the person can resolve here
 * (`canResolve`: a push into the PR branch from this repo), merging that GitHub keeps off, or a PR ready to merge.
 */
export function mergeControlState(
	detail: Pick<
		PullRequestDetail,
		'mergeState' | 'mergeable' | 'canMerge' | 'summary' | 'checks' | 'canPush' | 'crossRepository'
	>,
	canResolve: boolean
): 'merged' | 'closed' | 'conflicts' | 'blocked' | 'ready' {
	if (detail.summary.state === 'MERGED') return 'merged';
	if (!isOpenPR(detail.summary)) return 'closed';
	if (
		canResolve &&
		(detail.mergeable === 'CONFLICTING' || detail.mergeState === 'DIRTY') &&
		detail.canPush &&
		!detail.crossRepository
	)
		return 'conflicts';
	return mergeBlock(detail) ? 'blocked' : 'ready';
}

/* ── Review (spec/pull-requests-and-ci#pr-threads, spec/diff-and-review#review-comments) ── */
/** A draft — a new comment on lines or a thread reply; kept on the task's disk until GitHub accepts it. */
export type PRDraft = {
	id: string;
	path: string;
	side: 'LEFT' | 'RIGHT';
	line: number;
	startLine: number | null;
	body: string;
	createdAt: string;
	/** A reply in a GitHub thread (databaseId of the first comment). */ replyTo: number | null;
	/** From the agent (Review with an agent, spec/pull-requests-and-ci#review-with-agent) — the spark mark. */ fromAgent?: boolean;
	/** spec/pull-requests-and-ci#review-with-agent: the thread under an agent's draft — the person's replies and the agent's answers (never sent to GitHub). */ discussion?: PRDraftReply[];
	/** When the agent last rewrote the draft from the thread. */ updatedByAgent?: string;
	/** spec/pull-requests-and-ci#review-drafts: the review task that wrote an agent's draft; only it answers under the draft. */ taskId?: string;
	/** spec/appearance#evolution-redesign: the person went through the agent's suggestion and kept it («Accept»); it moves to «Yours». */ accepted?: boolean;
};
export type PRDraftReply = { from: 'person' | 'agent'; body: string; at: string };
export type PRReviewEvent = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES' | 'AGENT';
export type PRReviewDraft = {
	body: string;
	event: PRReviewEvent;
	drafts: PRDraft[];
	sendComments: boolean;
	/** What was sent last — for the footer «You requested changes · just now». */ last: {
		event: Exclude<PRReviewEvent, 'AGENT'>;
		at: string;
	} | null;
	/** spec/projects-and-board#pr-mode: the «Viewed» progress the modal recorded last; the PR card on the board shows it without fetching files. */
	viewed?: { n: number; of: number };
};
export const emptyReviewDraft = (): PRReviewDraft => ({
	body: '',
	event: 'COMMENT',
	drafts: [],
	sendComments: true,
	last: null,
});
export type PRDraftInput = Pick<
	PRDraft,
	'path' | 'side' | 'line' | 'startLine' | 'body' | 'replyTo'
> & { fromAgent?: boolean };
export function isPRDraftInput(value: unknown): value is PRDraftInput {
	return (
		isRecord(value) &&
		typeof value.path === 'string' &&
		value.path.length > 0 &&
		value.path.length <= 4096 &&
		!value.path.startsWith('/') &&
		!value.path.split('/').includes('..') &&
		(value.side === 'LEFT' || value.side === 'RIGHT') &&
		Number.isSafeInteger(value.line) &&
		Number(value.line) > 0 &&
		(value.startLine === null ||
			(Number.isSafeInteger(value.startLine) &&
				Number(value.startLine) > 0 &&
				Number(value.startLine) <= Number(value.line))) &&
		typeof value.body === 'string' &&
		value.body.trim().length > 0 &&
		value.body.length <= 65536 &&
		(value.replyTo === null ||
			(Number.isSafeInteger(value.replyTo) && Number(value.replyTo) > 0)) &&
		(value.fromAgent === undefined || typeof value.fromAgent === 'boolean')
	);
}
export function isPRReviewEvent(value: unknown): value is PRReviewEvent {
	return (
		value === 'COMMENT' || value === 'APPROVE' || value === 'REQUEST_CHANGES' || value === 'AGENT'
	);
}

/* ── Agent beside a PR (spec/pull-requests-and-ci#pr-overview, spec/editor#editor-principles): one-shot calls spec/agents-and-providers#one-shot, prompts in English (rule 12). ── */
export type PRSummaryItem = {
	path: string | null;
	start: number | null;
	end: number | null;
	text: string;
};
export type PRSummary = {
	headSha: string;
	/** spec/appearance#evolution-redesign: the TL;DR, two or three short sentences; an older cache has none. */ headline?: string;
	/** What changed and why. */ done: PRSummaryItem[];
	/** Risky spots. */ watch: PRSummaryItem[];
	/** What to check by hand: spec/appearance#evolution-redesign — an item on a line of a file; an older cache keeps plain sentences. */ check?: (
		string | PRSummaryItem
	)[];
	/** The agent's estimate of the review time. */ minutes?: number | null;
	provider: 'claude' | 'codex';
	seconds: number;
	files: number;
	at: string;
};
/** The agent's answer under a comment: an explanation for you, a draft PR reply, or (own PR) a fix by the task's agent. */
export type PRAgentAnswer = { kind: 'explanation' | 'reply' | 'change'; text: string };
export type PRAgentQuestion = { threadId: string } | { question: string };
export function isPRAgentQuestion(value: unknown): value is PRAgentQuestion {
	return (
		isRecord(value) &&
		Object.keys(value).length === 1 &&
		((typeof value.threadId === 'string' && /^[\w=-]{1,200}$/.test(value.threadId)) ||
			(typeof value.question === 'string' &&
				value.question.trim().length > 0 &&
				value.question.length <= 8000))
	);
}
/** Parses the summary JSON from the agent's text; paths are PR files only, the rest of the text is not lost. */
export function parsePRSummary(
	text: string,
	files: readonly string[]
): Pick<PRSummary, 'headline' | 'done' | 'watch' | 'check' | 'minutes'> {
	const known = new Set(files),
		item = (value: unknown): PRSummaryItem | null => {
			if (!isRecord(value) || typeof value.text !== 'string' || !value.text.trim()) return null;
			const path =
				typeof value.path === 'string'
					? (files.find((file) => file === value.path || file.endsWith(`/${value.path}`)) ?? null)
					: null;
			const start =
					Number.isSafeInteger(value.start) && Number(value.start) > 0 ? Number(value.start) : null,
				end =
					Number.isSafeInteger(value.end) && Number(value.end) >= (start ?? 1)
						? Number(value.end)
						: start;
			return {
				path: path && known.has(path) ? path : null,
				start: path ? start : null,
				end: path ? end : null,
				text: value.text.trim().slice(0, 2000),
			};
		};
	try {
		const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
		if (isRecord(json) && (Array.isArray(json.done) || Array.isArray(json.watch))) {
			const minutes = Number(json.minutes);
			return {
				// spec/appearance#evolution-redesign: the TL;DR of the column — two or three short sentences, one paragraph.
				headline:
					typeof json.headline === 'string'
						? json.headline
								.trim()
								.split(/\s*\n\s*/)
								.join(' ')
								.slice(0, 600)
						: '',
				done: (Array.isArray(json.done) ? json.done : [])
					.map(item)
					.filter((value): value is PRSummaryItem => value !== null)
					.slice(0, 40),
				watch: (Array.isArray(json.watch) ? json.watch : [])
					.map(item)
					.filter((value): value is PRSummaryItem => value !== null)
					.slice(0, 20),
				check: (Array.isArray(json.check) ? (json.check as unknown[]) : [])
					.map((value) =>
						typeof value === 'string'
							? value.trim().slice(0, 500) || null
							: (() => {
									const found = item(value);
									return found && { ...found, text: found.text.slice(0, 500) };
								})()
					)
					.filter((value): value is string | PRSummaryItem => value !== null)
					.slice(0, 10),
				minutes:
					Number.isFinite(minutes) && minutes > 0 ? Math.min(600, Math.round(minutes)) : null,
			};
		}
	} catch {
		/* plain text */
	}
	return {
		headline: '',
		done: text.trim()
			? [{ path: null, start: null, end: null, text: text.trim().slice(0, 4000) }]
			: [],
		watch: [],
		check: [],
		minutes: null,
	};
}
/**
 * spec/appearance#evolution-redesign: where an item of the summary points. The agent's `path` wins; an item without one (an older cache, a plain
 * «what to check» sentence) is placed by the first `file:line` in its text that names a file of the PR — `a.ts:12`,
 * `src/a.ts:12–14`, `a.ts:12-14`. A name two files share is not guessed.
 */
export function locateSummaryItem(
	item: PRSummaryItem | string,
	files: readonly string[]
): PRSummaryItem {
	const value: PRSummaryItem =
		typeof item === 'string' ? { path: null, start: null, end: null, text: item } : item;
	if (value.path) return value;
	for (const match of value.text.matchAll(/([\w./@-]+\.[\w-]+):(\d+)(?:\s*[-–]\s*(\d+))?/g)) {
		const name = match[1]!.replace(/^\.\//, ''),
			found = files.filter((file) => file === name || file.endsWith(`/${name}`));
		if (found.length !== 1) continue;
		const start = Number(match[2]),
			end = match[3] ? Number(match[3]) : start;
		if (start < 1) continue;
		return { ...value, path: found[0]!, start, end: end >= start ? end : start };
	}
	return value;
}
/** spec/appearance#evolution-redesign: «What to check» as items; an older cache's sentences are placed by their text when they name a line. */
export const summaryChecks = (
	summary: Pick<PRSummary, 'check'>,
	files: readonly string[]
): PRSummaryItem[] => (summary.check ?? []).map((item) => locateSummaryItem(item, files));
export type PRSummaryMarks = { risks: PRSummaryItem[]; checks: PRSummaryItem[] };
/**
 * spec/appearance#evolution-redesign: the badges of the files — ⚠ a risky spot in the file, ✓ something to check there — by path, in the order
 * of the summary. Items that point at no file of the PR give no badge.
 */
export function summaryMarks(
	summary: Pick<PRSummary, 'watch' | 'check'>,
	files: readonly string[]
): Map<string, PRSummaryMarks> {
	const marks = new Map<string, PRSummaryMarks>(),
		known = new Set(files),
		add = (item: PRSummaryItem, kind: keyof PRSummaryMarks) => {
			if (!item.path || !known.has(item.path)) return;
			const entry = marks.get(item.path) ?? { risks: [], checks: [] };
			entry[kind].push(item);
			marks.set(item.path, entry);
		};
	for (const item of summary.watch) add(locateSummaryItem(item, files), 'risks');
	for (const item of summaryChecks(summary, files)) add(item, 'checks');
	return marks;
}
/** spec/appearance#evolution-redesign: a marker of the summary under the line its item points at (the new side of the PR diff). */
export type PRSummarySpot = {
	/** `headSha:risk:3` — the key the person's Dismiss keeps, like the ticks of «What to check». */ key: string;
	kind: 'risk' | 'check';
	path: string;
	start: number;
	end: number;
	text: string;
};
export const summarySpotKey = (headSha: string, kind: PRSummarySpot['kind'], index: number) =>
	`${headSha}:${kind}:${index}`;
/**
 * spec/appearance#evolution-redesign: the markers of one file — risks first, then what to check, in the order of the summary. An item without a
 * file of the PR or a line gives none; a dismissed one (its key in `dismissed`) neither.
 */
export function summarySpots(
	summary: Pick<PRSummary, 'headSha' | 'watch' | 'check'>,
	files: readonly string[],
	path: string,
	dismissed: Readonly<Record<string, true>> = {}
): PRSummarySpot[] {
	const spots: PRSummarySpot[] = [],
		add = (item: PRSummaryItem, kind: PRSummarySpot['kind'], index: number) => {
			const key = summarySpotKey(summary.headSha, kind, index);
			if (item.path !== path || !item.start || dismissed[key]) return;
			spots.push({
				key,
				kind,
				path,
				start: item.start,
				end: item.end && item.end >= item.start ? item.end : item.start,
				text: item.text,
			});
		};
	if (!files.includes(path)) return spots;
	summary.watch.forEach((item, index) => add(locateSummaryItem(item, files), 'risk', index));
	summaryChecks(summary, files).forEach((item, index) => add(item, 'check', index));
	return spots;
}
/** spec/appearance#evolution-redesign: commits of the PR after the head the summary was written on; null — that head is not among them. */
export function commitsSince(
	commits: readonly { sha: string }[],
	headSha: string
): string[] | null {
	const index = commits.findIndex((commit) => commit.sha === headSha);
	return index < 0 ? null : commits.slice(index + 1).map((commit) => commit.sha);
}
/** spec/appearance#evolution-redesign: the agent's hint on step 3 — one of GitHub's decisions and why, in one sentence. */
export type PRVerdictHint = { event: Exclude<PRReviewEvent, 'AGENT'>; reason: string };
export function parsePRVerdictHint(text: string): PRVerdictHint | null {
	try {
		const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
		if (
			isRecord(json) &&
			(json.event === 'COMMENT' || json.event === 'APPROVE' || json.event === 'REQUEST_CHANGES') &&
			typeof json.reason === 'string' &&
			json.reason.trim()
		)
			return { event: json.event, reason: (json.reason.trim().split('\n')[0] ?? '').slice(0, 400) };
	} catch {
		/* no hint */
	}
	return null;
}
/** spec/agents-and-providers#adapter-launch: splits a unified diff by file and fits it into `budget` characters. Each file gets an equal share of what is
 *  left after the files that need less; a trimmed file keeps its header, ends on a whole line and says how much was cut. */
export function fitPatch(patch: string, budget: number): string {
	if (patch.length <= budget) return patch;
	const files = patch.split(/(?=^diff --git )/m),
		shares = new Array<number>(files.length).fill(0),
		omitted = new Set<number>();
	let left = budget,
		open = files.map((_, index) => index);
	while (open.length) {
		let share = Math.floor(left / open.length);
		// A share too small even for a header: the biggest files are left out whole and named at the end, so a PR of thousands of files still fits.
		while (share < 300 && open.length > 1) {
			const biggest = open.reduce((a, b) => (files[b]!.length > files[a]!.length ? b : a));
			omitted.add(biggest);
			open = open.filter((index) => index !== biggest);
			share = Math.floor(left / open.length);
		}
		const fits = open.filter((index) => files[index]!.length <= share);
		if (!fits.length) {
			for (const index of open) shares[index] = share;
			break;
		}
		for (const index of fits) {
			shares[index] = files[index]!.length;
			left -= files[index]!.length;
		}
		open = open.filter((index) => !fits.includes(index));
	}
	const names = [...omitted]
		.sort((a, b) => a - b)
		.map((index) => /^diff --git a\/(.*?) b\//.exec(files[index]!)?.[1] ?? '?');
	const body = files
		.map((file, index) => {
			if (omitted.has(index)) return '';
			const share = shares[index]!;
			if (file.length <= share) return file;
			const kept = file.slice(
				0,
				Math.max(file.lastIndexOf('\n', share - 1) + 1, file.indexOf('\n') + 1)
			);
			return `${kept}… ${file.slice(kept.length).split('\n').filter(Boolean).length} more lines of this file trimmed\n`;
		})
		.join('');
	return names.length
		? `${body}\nOmitted from this patch to fit the budget (${names.length} files, see "files" for their +/-): ${names.slice(0, 300).join(', ')}${names.length > 300 ? ', …' : ''}\n`
		: body;
}
export function parsePRAgentAnswer(text: string, own: boolean): PRAgentAnswer {
	try {
		const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
		if (isRecord(json) && typeof json.text === 'string' && json.text.trim()) {
			const kind =
				json.kind === 'reply' || (json.kind === 'change' && own) ? json.kind : 'explanation';
			return { kind, text: json.text.trim().slice(0, 8000) };
		}
	} catch {
		/* plain text */
	}
	return { kind: 'explanation', text: text.trim().slice(0, 8000) };
}

/**
 * Long-lived branches a merge never deletes, whatever the repository calls its default: the toggle
 * «Delete branch» is not offered for them and main refuses the delete.
 */
export const LONG_LIVED_BRANCHES = ['main', 'master', 'stage', 'staging'] as const;
export const keepsBranch = (name: string): boolean =>
	(LONG_LIVED_BRANCHES as readonly string[]).includes(name.trim().toLowerCase());
