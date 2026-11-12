import type { AgentProvider } from './agent';
import { crewName, isCrewSpec, type CrewSpec, type CrewSpecAgent } from './crew';
import { isRecord } from './workspace';

/**
 * spec/diff-and-review#agent-review: a task's changes checked by reviewer agents before the PR, inside the task. The rounds are the crew's
 * check edge (spec/crew#reviewer) with the task itself as the checked author; this is the task-side record of the proposal and the review.
 */
export type TaskReviewState =
	'waiting' | 'reviewing' | 'comments' | 'approved' | 'disputed' | 'outdated' | 'stopped';
/** Who reviews: one reviewer agent, or the agents of a library crew. */
export type TaskReviewWho = { kind: 'agent' } | { kind: 'crew'; id: string; name: string };
export type TaskReviewProposal = { summary: string; at: string };
export type TaskReviewTree = { scopeId: string; tree: string };
export type TaskReview = {
	id: string;
	who: TaskReviewWho;
	/** The person's instructions as typed. */
	instructions: string;
	/** What every reviewer's prompt ends with: project review notes and the instructions, English-framed (rule 12). */
	guidance: string;
	startedAt: string;
	state: TaskReviewState;
	/** 0 while the review waits for the task's turn to end. */
	round: number;
	reviewers: string[];
	/** The result tree of each repo the last round read: an approval covers only these. */
	trees: TaskReviewTree[];
	/** `Since the last review`: the trees the rounds start from instead of the task's change base. */
	base?: TaskReviewTree[];
	finishedAt?: string;
};
export type TaskReviewDocument = {
	schemaVersion: 1;
	proposal: TaskReviewProposal | null;
	review: TaskReview | null;
};
export const taskReviewSummaryLimit = 4000,
	taskReviewInstructionsLimit = 20_000,
	taskReviewGuidanceLimit = 60_000,
	/** spec/diff-and-review#agent-review-members: the task's agent is the root of the review crew. */
	taskReviewRootId = 'task-agent',
	taskReviewRootName = 'Task agent';
export const emptyTaskReviewDocument: TaskReviewDocument = {
	schemaVersion: 1,
	proposal: null,
	review: null,
};
const states: readonly TaskReviewState[] = [
	'waiting',
	'reviewing',
	'comments',
	'approved',
	'disputed',
	'outdated',
	'stopped',
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
function isTree(value: unknown): value is TaskReviewTree {
	return isRecord(value) && text(value.scopeId, 200) && text(value.tree, 200);
}
export function isTaskReview(value: unknown): value is TaskReview {
	return (
		isRecord(value) &&
		text(value.id, 200) &&
		value.id.length > 0 &&
		isTaskReviewWho(value.who) &&
		text(value.instructions, taskReviewInstructionsLimit) &&
		text(value.guidance, taskReviewGuidanceLimit) &&
		text(value.startedAt, 64) &&
		isTaskReviewState(value.state) &&
		Number.isSafeInteger(value.round) &&
		Number(value.round) >= 0 &&
		Array.isArray(value.reviewers) &&
		value.reviewers.every((name) => text(name, 200)) &&
		Array.isArray(value.trees) &&
		value.trees.every(isTree) &&
		(value.base === undefined || (Array.isArray(value.base) && value.base.every(isTree))) &&
		(value.finishedAt === undefined || text(value.finishedAt, 64))
	);
}
export function isTaskReviewDocument(value: unknown): value is TaskReviewDocument {
	return (
		isRecord(value) &&
		value.schemaVersion === 1 &&
		(value.proposal === null ||
			(isRecord(value.proposal) &&
				text(value.proposal.summary, taskReviewSummaryLimit) &&
				text(value.proposal.at, 64))) &&
		(value.review === null || isTaskReview(value.review))
	);
}
/** A review still under way: its rounds run or wait, so a second one cannot start. */
export const taskReviewLive = (review: TaskReview | null | undefined) =>
	!!review && ['waiting', 'reviewing', 'comments'].includes(review.state);
/**
 * spec/diff-and-review#agent-review-pr: the changes are covered when the last review approved exactly the trees the task has now.
 * `current` holds the latest checkpoint tree of each repo of the task.
 */
export function taskReviewCovers(
	review: TaskReview | null | undefined,
	current: readonly TaskReviewTree[]
) {
	if (!review || review.state !== 'approved' || !review.trees.length) return false;
	return review.trees.every(
		(tree) => current.find((item) => item.scopeId === tree.scopeId)?.tree === tree.tree
	);
}
/**
 * spec/diff-and-review#agent-review-start: the reviewers as crew members. Every agent below a crew's root reviews (its own model and effort, no zone,
 * no children); the crew's foreman is not used. Names stay unique, as the host addresses members by name.
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
/** spec/diff-and-review#agent-review-members: the crew of a task's review — the task's agent at the root, checked by every reviewer. */
export function taskReviewSpec(
	provider: AgentProvider,
	reviewers: readonly CrewSpecAgent[],
	now = new Date().toISOString()
): CrewSpec {
	return {
		schemaVersion: 1,
		templateId: null,
		name: 'Review before PR',
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
export const isTaskReviewSpec = (value: unknown): value is CrewSpec =>
	isCrewSpec(value) && value.root.id === taskReviewRootId;
