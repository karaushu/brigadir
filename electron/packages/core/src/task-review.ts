import type { AgentProvider } from './agent';
import { crewName, isCrewSpec, type CrewSpec, type CrewSpecAgent } from './crew';
import type { AgentProviderId } from './settings';
import { isRecord } from './workspace';

/**
 * spec/reviews#points: a review the host runs on a task — the plan, mid-task or before the PR. The rounds are the crew's check edge
 * (spec/crew#reviewer) with the task itself as the checked author; this is the task-side record of the proposal and the reviews.
 */
export const reviewPoints = ['plan', 'mid', 'pre-pr'] as const;
export type ReviewPoint = (typeof reviewPoints)[number];
export const isReviewPoint = (value: unknown): value is ReviewPoint =>
	reviewPoints.includes(value as ReviewPoint);
/** spec/reviews#loop: `waiting` for the task's turn to end, `reading` the first read, `fixing` the author's pass, `verifying` the closure
 *  check, `yours` the open findings with the person; the rest are ends. */
export type TaskReviewState =
	| 'waiting'
	| 'reading'
	| 'fixing'
	| 'verifying'
	| 'yours'
	| 'passed'
	| 'accepted'
	| 'stopped'
	| 'failed'
	| 'outdated';
export type TaskReviewStarter = 'person' | 'agent' | 'host';
/** Who reviews: one reviewer agent, or the agents of a library crew. */
export type TaskReviewWho = { kind: 'agent' } | { kind: 'crew'; id: string; name: string };
/** spec/reviews#who: the resolved reviewer — the setting, another signed-in provider, a fresh session of the task's own, or the person's pick. */
export type ReviewerSource = 'setting' | 'other' | 'same' | 'person';
export type ReviewerChoice = {
	provider: AgentProviderId;
	model: string | null;
	effort: string | null;
	source: ReviewerSource;
};
export type TaskReviewProposal = { summary: string; at: string };
export type TaskReviewTree = { scopeId: string; tree: string };
export type TaskReview = {
	id: string;
	point: ReviewPoint;
	/** spec/reviews#points: the reviewed task; a crew worker's review names its part. */
	target: { taskId: string; part?: number };
	startedBy: TaskReviewStarter;
	/** The agent's `request_review` reason: what was just finished. */
	reason?: string;
	who: TaskReviewWho;
	reviewer?: ReviewerChoice;
	/** The person's instructions as typed. */
	instructions: string;
	/** What every reviewer's prompt ends with: project review notes and the instructions, English-framed (rule 12). */
	guidance: string;
	startedAt: string;
	state: TaskReviewState;
	/** Runs opened: 1 is the first read, the next ones are closure checks; 0 while the review waits for the task's turn to end. */
	round: number;
	/** The author's passes so far: the automatic one and one per `Fix {n}`. */
	passes: number;
	reviewers: string[];
	/** The result tree of each repo the last run read: a pass covers only these. */
	trees: TaskReviewTree[];
	/** `Since the last review`: the trees the first read starts from instead of the task's change base. */
	base?: TaskReviewTree[];
	/** The last batch sent to the author: the turn that answers it opens the closure check. */
	batch?: string;
	/** Why the review could not start. */
	failure?: string;
	finishedAt?: string;
};
export type TaskReviewDocument = {
	schemaVersion: 2;
	proposal: TaskReviewProposal | null;
	/** The current or last review. */
	review: TaskReview | null;
	/** Earlier reviews, newest last: each point shows its last result. */
	past: TaskReview[];
};
export const taskReviewSummaryLimit = 4000,
	taskReviewInstructionsLimit = 20_000,
	taskReviewGuidanceLimit = 60_000,
	taskReviewReasonLimit = 500,
	taskReviewPastLimit = 20,
	/** spec/reviews#reviewer-sessions: the task's agent is the root of the review crew. */
	taskReviewRootId = 'task-agent',
	taskReviewRootName = 'Task agent';
export const emptyTaskReviewDocument: TaskReviewDocument = {
	schemaVersion: 2,
	proposal: null,
	review: null,
	past: [],
};
const states: readonly TaskReviewState[] = [
	'waiting',
	'reading',
	'fixing',
	'verifying',
	'yours',
	'passed',
	'accepted',
	'stopped',
	'failed',
	'outdated',
];
const text = (value: unknown, limit: number): value is string =>
	typeof value === 'string' && value.length <= limit;
export const isTaskReviewState = (value: unknown): value is TaskReviewState =>
	states.includes(value as TaskReviewState);
export function isTaskReviewWho(value: unknown): value is TaskReviewWho {
	if (!isRecord(value)) return false;
	if (value.kind === 'agent') return true;
	return (
		value.kind === 'crew' && text(value.id, 200) && value.id.length > 0 && text(value.name, 200)
	);
}
export function isReviewerChoice(value: unknown): value is ReviewerChoice {
	return (
		isRecord(value) &&
		(value.provider === 'claude' || value.provider === 'codex') &&
		(value.model === null || text(value.model, 200)) &&
		(value.effort === null || text(value.effort, 200)) &&
		['setting', 'other', 'same', 'person'].includes(String(value.source))
	);
}
function isTree(value: unknown): value is TaskReviewTree {
	return isRecord(value) && text(value.scopeId, 200) && text(value.tree, 200);
}
const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
export function isTaskReview(value: unknown): value is TaskReview {
	return (
		isRecord(value) &&
		text(value.id, 200) &&
		value.id.length > 0 &&
		isReviewPoint(value.point) &&
		isRecord(value.target) &&
		text(value.target.taskId, 200) &&
		(value.target.part === undefined || count(value.target.part)) &&
		['person', 'agent', 'host'].includes(String(value.startedBy)) &&
		(value.reason === undefined || text(value.reason, taskReviewReasonLimit)) &&
		isTaskReviewWho(value.who) &&
		(value.reviewer === undefined || isReviewerChoice(value.reviewer)) &&
		text(value.instructions, taskReviewInstructionsLimit) &&
		text(value.guidance, taskReviewGuidanceLimit) &&
		text(value.startedAt, 64) &&
		isTaskReviewState(value.state) &&
		count(value.round) &&
		count(value.passes) &&
		Array.isArray(value.reviewers) &&
		value.reviewers.every((name) => text(name, 200)) &&
		Array.isArray(value.trees) &&
		value.trees.every(isTree) &&
		(value.base === undefined || (Array.isArray(value.base) && value.base.every(isTree))) &&
		(value.batch === undefined || text(value.batch, 200)) &&
		(value.failure === undefined || text(value.failure, 2000)) &&
		(value.finishedAt === undefined || text(value.finishedAt, 64))
	);
}
export function isTaskReviewDocument(value: unknown): value is TaskReviewDocument {
	return (
		isRecord(value) &&
		value.schemaVersion === 2 &&
		(value.proposal === null ||
			(isRecord(value.proposal) &&
				text(value.proposal.summary, taskReviewSummaryLimit) &&
				text(value.proposal.at, 64))) &&
		(value.review === null || isTaskReview(value.review)) &&
		Array.isArray(value.past) &&
		value.past.length <= taskReviewPastLimit &&
		value.past.every(isTaskReview)
	);
}
/** spec/reviews#data: the states of a version-1 review — before the PR, started by the person, two full rounds. */
const v1States: Record<string, TaskReviewState> = {
	waiting: 'waiting',
	comments: 'fixing',
	approved: 'passed',
	disputed: 'yours',
	outdated: 'outdated',
	stopped: 'stopped',
};
/**
 * spec/reviews#data: the task's review document of any version, or null. A version-1 document reads as a `pre-pr` review the person started;
 * the host writes it back as version 2 on the next change. `taskId` is the task whose directory holds the file.
 */
export function readTaskReviewDocument(value: unknown, taskId: string): TaskReviewDocument | null {
	if (isTaskReviewDocument(value)) return value;
	if (!isRecord(value) || value.schemaVersion !== 1) return null;
	const proposal =
		value.proposal === null ||
		(isRecord(value.proposal) &&
			text(value.proposal.summary, taskReviewSummaryLimit) &&
			text(value.proposal.at, 64))
			? ((value.proposal ?? null) as TaskReviewProposal | null)
			: null;
	const old = value.review;
	if (!isRecord(old)) return { ...emptyTaskReviewDocument, proposal };
	const round = Number.isSafeInteger(old.round) ? Number(old.round) : 0,
		state =
			old.state === 'reviewing'
				? round > 1
					? 'verifying'
					: 'reading'
				: (v1States[String(old.state)] ?? null);
	const review = state && {
		id: old.id,
		point: 'pre-pr' as const,
		target: { taskId },
		startedBy: 'person' as const,
		who: old.who,
		instructions: old.instructions,
		guidance: old.guidance,
		startedAt: old.startedAt,
		state,
		round: Math.max(0, round),
		passes: round > 1 || state === 'fixing' ? 1 : 0,
		reviewers: old.reviewers,
		trees: old.trees,
		...(old.base !== undefined ? { base: old.base } : {}),
		...(old.finishedAt !== undefined ? { finishedAt: old.finishedAt } : {}),
	};
	return isTaskReview(review)
		? { ...emptyTaskReviewDocument, proposal, review }
		: { ...emptyTaskReviewDocument, proposal };
}
/** A review under way: its rounds run, wait, or wait for the person — a second one cannot start. */
export const taskReviewLive = (review: TaskReview | null | undefined) =>
	!!review && ['waiting', 'reading', 'fixing', 'verifying', 'yours'].includes(review.state);
/** A review whose host works: the strip offers `Stop`. */
export const taskReviewRunning = (review: TaskReview | null | undefined) =>
	!!review && ['waiting', 'reading', 'fixing', 'verifying'].includes(review.state);
/** The last review of each point: the current one, else the newest earlier one. */
export function taskReviewAt(
	doc: Pick<TaskReviewDocument, 'review' | 'past'>,
	point: ReviewPoint
): TaskReview | null {
	if (doc.review?.point === point) return doc.review;
	return doc.past.findLast((review) => review.point === point) ?? null;
}
/** spec/reviews#loop: the finished review goes to `past`, which keeps the newest ones. */
export function withNextReview(doc: TaskReviewDocument, next: TaskReview): TaskReviewDocument {
	const past = doc.review ? [...doc.past, doc.review] : doc.past;
	return { ...doc, proposal: null, review: next, past: past.slice(-taskReviewPastLimit) };
}
/**
 * spec/reviews#before-pr: the changes are covered when the last review before the PR read exactly the trees the task has now — the same
 * repos, each with the same tree — and ended passed, accepted or stopped. `current` holds the latest checkpoint tree of each repo of the
 * task (a repo that joined after the review is not covered).
 */
export function taskReviewCovers(
	review: TaskReview | null | undefined,
	current: readonly TaskReviewTree[]
) {
	if (!review || !['passed', 'accepted', 'stopped'].includes(review.state) || !review.trees.length)
		return false;
	return (
		review.trees.every(
			(tree) => current.find((item) => item.scopeId === tree.scopeId)?.tree === tree.tree
		) && current.every((item) => review.trees.some((tree) => tree.scopeId === item.scopeId))
	);
}

// ── the loop (spec/reviews#loop) ─────────────────────────────────────────────

export type ReviewLoopEvent =
	/** The first read opened (the task's turn ended, or the agent asked). */
	| { kind: 'begin' }
	/** Every reviewer gave its verdict on the first read. */
	| { kind: 'read'; findings: number }
	/** The author's turn that answered a batch ended. */
	| { kind: 'answered' }
	/** Every reviewer gave its verdict on the closure check; `open` counts open and new findings. */
	| { kind: 'verified'; open: number }
	| { kind: 'decided'; decision: 'fix' | 'accept' }
	| { kind: 'stop' }
	| { kind: 'fail' }
	/** The task's tree changed after the review ended. */
	| { kind: 'changed' };
/** What the host does next: open the first read, deliver a batch to the author, open a closure check, hand the list to the person, end. */
export type ReviewLoopAction = 'read' | 'deliver' | 'verify' | 'person' | 'finish';
/**
 * spec/reviews#loop: one read, one fix, one closure check, then the person — never an automatic third round. Returns null for an event the
 * state does not take (a late verdict, a second decision).
 */
export function reviewLoop(
	state: TaskReviewState,
	event: ReviewLoopEvent
): { state: TaskReviewState; action: ReviewLoopAction } | null {
	switch (event.kind) {
		case 'begin':
			return state === 'waiting' ? { state: 'reading', action: 'read' } : null;
		case 'read':
			if (state !== 'reading') return null;
			return event.findings > 0
				? { state: 'fixing', action: 'deliver' }
				: { state: 'passed', action: 'finish' };
		case 'answered':
			return state === 'fixing' ? { state: 'verifying', action: 'verify' } : null;
		case 'verified':
			if (state !== 'verifying') return null;
			return event.open > 0
				? { state: 'yours', action: 'person' }
				: { state: 'passed', action: 'finish' };
		case 'decided':
			if (state !== 'yours') return null;
			return event.decision === 'fix'
				? { state: 'fixing', action: 'deliver' }
				: { state: 'accepted', action: 'finish' };
		case 'stop':
			return ['waiting', 'reading', 'fixing', 'verifying', 'yours'].includes(state)
				? { state: 'stopped', action: 'finish' }
				: null;
		case 'fail':
			return ['waiting', 'reading', 'fixing', 'verifying'].includes(state)
				? { state: 'failed', action: 'finish' }
				: null;
		case 'changed':
			return state === 'passed' || state === 'accepted'
				? { state: 'outdated', action: 'finish' }
				: null;
	}
}
/** The point's name in the prompts to agents (rule 12) and in the batch header. */
export const reviewPointPrompt: Record<ReviewPoint, string> = {
	plan: 'plan review',
	mid: 'mid-task review',
	'pre-pr': 'review before the pull request',
};

// ── who reviews (spec/reviews#who) ──────────────────────────────────────────

/**
 * spec/reviews#who: the setting, else another provider that is enabled, installed and signed in (its catalog's own model and effort), else a
 * fresh session of the task's own provider, else nobody. Reads only settings, sign-in state and catalogs — no knowledge of agents (rule 7).
 */
export function resolveReviewer(input: {
	/** The app's providers in its own order. */
	providers: readonly AgentProviderId[];
	author: AgentProviderId;
	enabled: Record<AgentProviderId, boolean>;
	/** Installed and signed in; absent — not known. */
	ready: Partial<Record<AgentProviderId, boolean>>;
	override: { provider: AgentProviderId; model: string; effort: string | null } | null;
	/** Each provider's catalog default, for the record and the strip. */
	defaults?: Partial<Record<AgentProviderId, { model: string | null; effort: string | null }>>;
}): ReviewerChoice | { failure: string } {
	const own = (provider: AgentProviderId, source: ReviewerSource): ReviewerChoice => ({
		provider,
		model: input.defaults?.[provider]?.model ?? null,
		effort: input.defaults?.[provider]?.effort ?? null,
		source,
	});
	if (input.override && input.enabled[input.override.provider])
		return { ...input.override, source: 'setting' };
	const other = input.providers.find(
		(provider) =>
			provider !== input.author && input.enabled[provider] && input.ready[provider] === true
	);
	if (other) return own(other, 'other');
	if (input.ready[input.author] !== false) return own(input.author, 'same');
	return { failure: 'No reviewer is available: no agent is signed in.' };
}

// ── reviewers as crew members (spec/reviews#reviewer-sessions) ───────────────

/**
 * spec/reviews#start: the reviewers as crew members. Every agent below a crew's root reviews (its own model and effort, no zone, no
 * children); the crew's foreman is not used. Names stay unique, as the host addresses members by name.
 */
export function taskReviewers(
	agents: readonly CrewSpecAgent[],
	prefix = 'review',
	/** Names the crew already has: an earlier review's reviewers, a foreman's workers. */
	takenNames: readonly string[] = []
): CrewSpecAgent[] {
	const all: CrewSpecAgent[] = [];
	const visit = (agent: CrewSpecAgent) => {
		all.push(agent);
		agent.agents.forEach(visit);
	};
	agents.forEach(visit);
	const taken = new Set<string>(takenNames.map((name) => name.toLowerCase()));
	return all.map((agent, index) => {
		let name = crewName(agent.name) || 'Reviewer';
		for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${crewName(agent.name)} ${n}`;
		taken.add(name.toLowerCase());
		return {
			...agent,
			id: `${prefix}-${index + 1}`,
			name,
			role: 'reviewer',
			zone: [],
			checkedBy: [],
			agents: [],
		};
	});
}
/** spec/reviews#reviewer-sessions: the crew of a task's review — the task's agent at the root, checked by every reviewer. */
export function taskReviewSpec(
	provider: AgentProvider,
	reviewers: readonly CrewSpecAgent[],
	now = new Date().toISOString()
): CrewSpec {
	return {
		schemaVersion: 1,
		templateId: null,
		name: 'Review',
		resolvedAt: now,
		root: {
			id: taskReviewRootId,
			name: taskReviewRootName,
			role: 'foreman',
			provider,
			requestedChoices: {},
			choiceNames: {},
			instructions: '',
			extraInstructions: '',
			zone: [],
			checkedBy: reviewers.map((agent) => agent.id),
			agents: [...reviewers],
		},
	};
}
/** spec/reviews#start: the launch dialog's choice — one agent (null: the resolved reviewer) or a crew; `point` and who started it. */
export type TaskReviewChoice = {
	agent: { provider: AgentProvider; model: string; effort: string | null } | null;
	crew: string | null;
	notes: string;
	since: 'start' | 'last';
	point?: ReviewPoint;
	startedBy?: TaskReviewStarter;
};
export function isTaskReviewChoice(value: unknown): value is TaskReviewChoice {
	return (
		isRecord(value) &&
		(value.agent === null ||
			(isRecord(value.agent) &&
				(value.agent.provider === 'claude' || value.agent.provider === 'codex') &&
				text(value.agent.model, 200) &&
				(value.agent.effort === null || text(value.agent.effort, 200)))) &&
		(value.crew === null || (text(value.crew, 200) && value.crew.length > 0)) &&
		text(value.notes, taskReviewInstructionsLimit) &&
		(value.since === 'start' || value.since === 'last') &&
		(value.point === undefined || isReviewPoint(value.point)) &&
		(value.startedBy === undefined || ['person', 'agent', 'host'].includes(String(value.startedBy)))
	);
}
export const isTaskReviewSpec = (value: unknown): value is CrewSpec =>
	isCrewSpec(value) && value.root.id === taskReviewRootId;

// ── what the window reads (spec/reviews#strip) ────────────────────────────────

export type TaskReviewMemberState =
	'starting' | 'reading' | 'findings' | 'checking' | 'approved' | 'open' | 'stopped' | 'failed';
export type TaskReviewMember = {
	name: string;
	provider: AgentProvider;
	taskId: string | null;
	state: TaskReviewMemberState;
	/** Its findings in this review. */
	findings: number;
	/** When its current state began (a running read), for `reading · 1m 12s`. */
	since: string | null;
	/** Why it failed to start, as the task says. */
	failure?: string;
};
/** spec/reviews#findings */
export type TaskReviewFindingState =
	'sent' | 'fixed' | 'answered' | 'open' | 'new' | 'accepted' | 'resolved';
export type TaskReviewCommentRow = {
	id: string;
	/** The review the finding belongs to. */
	reviewId: string;
	text: string;
	path: string;
	line: number;
	scopeId: string;
	reviewer: string;
	round: number;
	state: TaskReviewFindingState;
	/** The agent's last answer in the thread. */
	answer: string | null;
	/** The reviewer's reason for an open finding: its last reply. */
	reason: string | null;
};
/** The step of a point on the strip's track (spec/reviews#strip). */
export type TaskReviewStep = 'none' | 'live' | 'yours' | 'done' | 'ended';
export function taskReviewStep(review: TaskReview | null): TaskReviewStep {
	if (!review) return 'none';
	if (review.state === 'yours') return 'yours';
	if (taskReviewRunning(review)) return 'live';
	if (review.state === 'passed' || review.state === 'accepted') return 'done';
	return 'ended';
}
export type TaskReviewView = TaskReviewDocument & {
	/** The task's changes now (all of them, from the task start). */
	changes: { files: number; additions: number; deletions: number };
	/** The task's tree differs from the trees the review read. */
	changed: boolean;
	members: TaskReviewMember[];
	/** The findings of every review in the document. */
	comments: TaskReviewCommentRow[];
	/** Files changed since the trees of the last finished review; null — no such review. */
	sinceLast: number | null;
	/** spec/reviews#before-pr: `Create PR` opens the dialog (`covered`), expands the running review (`running`) or starts one (`needed`). */
	beforePR: 'covered' | 'running' | 'needed';
};
export const emptyTaskReviewView: TaskReviewView = {
	...emptyTaskReviewDocument,
	changes: { files: 0, additions: 0, deletions: 0 },
	changed: false,
	members: [],
	comments: [],
	sinceLast: null,
	beforePR: 'covered',
};
/** Counts the strip, the chat rows and the PR sheet say, for one review. */
export function taskReviewCounts(view: Pick<TaskReviewView, 'comments'>, reviewId?: string) {
	const rows = reviewId ? view.comments.filter((c) => c.reviewId === reviewId) : view.comments;
	const by = (...states: TaskReviewFindingState[]) =>
		rows.filter((comment) => states.includes(comment.state)).length;
	return {
		findings: rows.length,
		fixed: by('fixed'),
		answered: by('answered'),
		open: by('open', 'new'),
		accepted: by('accepted'),
	};
}
/** spec/reviews#findings: a finding's state from its review marks, its thread and the review status of the diff. */
export function taskReviewCommentState(comment: {
	review?: {
		disputed?: boolean;
		open?: number;
		closed?: number;
		introduced?: number;
		accepted?: boolean;
	};
	replies?: { agent: boolean }[];
	addressed?: boolean;
	resolved?: boolean;
}): TaskReviewFindingState {
	const marks = comment.review;
	if (marks?.accepted) return 'accepted';
	if (comment.resolved) return 'resolved';
	const closed = marks?.closed ?? 0;
	if (marks?.open !== undefined && marks.open > closed) return 'open';
	if (marks?.disputed && marks.open === undefined && !marks.closed) return 'open';
	if (marks?.introduced !== undefined && marks.introduced > closed) return 'new';
	if (comment.addressed) return 'fixed';
	if (comment.replies?.some((reply) => reply.agent)) return 'answered';
	if (closed) return 'fixed';
	return 'sent';
}
