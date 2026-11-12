import {
	emptyTaskReviewView,
	isRecord,
	isReviewRun,
	isTaskReviewDocument,
	resolveCrewAgent,
	taskReviewCommentState,
	templateLookup,
	type AgentProvider,
	type AgentTemplate,
	type CrewSpecAgent,
	type ReviewRun,
	type ReviewSnapshot,
	type TaskKey,
	type TaskReview,
	type TaskReviewMember,
	type TaskReviewView,
} from '@brigadir/core';
import { changedFiles, readChanges, readSnapshots } from '@brigadir/git';
import { readDocument, safePath, type SessionStore } from '@brigadir/persistence';

async function json(store: SessionStore, key: TaskKey, name: string) {
	try {
		return await readDocument(await safePath(await store.taskDir(key), name), 16 * 1024 * 1024);
	} catch {
		return null;
	}
}
/**
 * spec/diff-and-review#agent-review-start: one reviewer when the person picked an agent — the Reviewer template with that provider and its launch
 * options (model, effort) as the node's choices.
 */
export function reviewerAgent(
	provider: AgentProvider,
	launchOptions: readonly { id: string; value: string | boolean }[],
	agents: readonly AgentTemplate[]
): CrewSpecAgent {
	return resolveCrewAgent(
		{
			id: 'reviewer',
			name: 'Reviewer',
			template: 'reviewer',
			provider,
			choices: {
				configOptions: Object.fromEntries(launchOptions.map((item) => [item.id, item.value])),
			},
		},
		{ lookup: templateLookup(agents), defaultProvider: provider },
		[],
		false
	);
}
/** spec/diff-and-review#agent-review-ui: the review as the window shows it — the task's record, its reviewers' states and its comments. */
export async function readTaskReview(
	store: SessionStore,
	key: TaskKey,
	review: (key: TaskKey) => Promise<ReviewSnapshot>
): Promise<TaskReviewView> {
	const files = await readChanges(store, key)
		.then((value) => value.files)
		.catch(() => []);
	const changes = {
		files: files.length,
		additions: files.reduce((sum, file) => sum + file.additions, 0),
		deletions: files.reduce((sum, file) => sum + file.deletions, 0),
	};
	const doc = await json(store, key, 'task-review.json');
	if (!isTaskReviewDocument(doc)) return { ...emptyTaskReviewView, changes };
	const current = doc.review;
	if (!current) return { ...emptyTaskReviewView, changes, proposal: doc.proposal };
	const task = await store.task(key),
		spec = task.reviewCrew ?? task.crew,
		nodes = (spec?.root.checkedBy ?? [])
			.map((id) => spec!.root.agents.find((agent) => agent.id === id))
			.filter((agent): agent is CrewSpecAgent => Boolean(agent));
	const workers = await json(store, key, 'crew-workers.json'),
		records = (Array.isArray(workers?.workers) ? workers.workers : []).filter(isRecord);
	const runsDoc = await json(store, key, 'crew-reviews.json'),
		runs = (Array.isArray(runsDoc?.reviews) ? runsDoc.reviews : [])
			.filter(isReviewRun)
			.filter((run) => run.taskId === key.id);
	const run = runs.at(-1) ?? null;
	const members: TaskReviewMember[] = await Promise.all(
		nodes.map(async (node) => {
			const record = records.findLast((item) => item.nodeId === node.id),
				taskId = typeof record?.taskId === 'string' ? record.taskId : null,
				worker = taskId
					? await store.task({ projectId: key.projectId, id: taskId }).catch(() => null)
					: null;
			return {
				name: node.name,
				provider: node.provider,
				taskId,
				...memberState(current, run, node.id, worker?.status ?? null),
				...(worker?.status === 'failed' && worker.failure ? { failure: worker.failure } : {}),
			};
		})
	);
	const snapshot = await review(key).catch(() => ({ comments: [] }) as ReviewSnapshot);
	const comments = snapshot.comments
		.filter((comment) => comment.review?.reviewId === current.id)
		.map((comment) => ({
			id: comment.id,
			text: comment.text,
			path: comment.anchor.path,
			line: comment.position?.start ?? comment.anchor.start,
			scopeId: comment.anchor.scopeId,
			reviewer: comment.review!.reviewer,
			round: comment.review!.round,
			state: taskReviewCommentState(comment),
			answer: comment.replies?.findLast((reply) => reply.agent)?.text ?? null,
		}));
	const snapshots = await readSnapshots(store, key).catch(() => null),
		now = snapshots?.checkpoints.at(-1)?.trees ?? [],
		changed =
			current.trees.length > 0 &&
			current.trees.some(
				(tree) => now.find((item) => item.scopeId === tree.scopeId)?.tree !== tree.tree
			);
	let sinceLast: number | null = null;
	if (current.trees.length && !['waiting', 'reviewing', 'comments'].includes(current.state)) {
		sinceLast = 0;
		for (const tree of current.trees) {
			const scope = snapshots?.scopes.find((item) => item.id === tree.scopeId),
				after = now.find((item) => item.scopeId === tree.scopeId)?.tree;
			if (scope && after && after !== tree.tree)
				sinceLast += (await changedFiles(scope, tree.tree, after).catch(() => [])).length;
		}
	}
	return { ...doc, changes, changed, members, comments, sinceLast };
}
function memberState(
	review: TaskReview,
	run: ReviewRun | null,
	nodeId: string,
	status: string | null
): Pick<TaskReviewMember, 'state' | 'comments' | 'since'> {
	const verdict = run?.verdicts.find((item) => item.reviewerNodeId === nodeId),
		comments = verdict?.comments ?? 0;
	if (status === 'failed') return { state: 'failed', comments, since: null };
	if (review.state === 'stopped') return { state: 'stopped', comments, since: null };
	if (verdict?.approved) return { state: 'approved', comments, since: verdict.at };
	if (verdict)
		return {
			state: review.state === 'disputed' ? 'disputed' : 'comments',
			comments,
			since: verdict.at,
		};
	if (run && run.state === 'reviewing' && run.dispatched.includes(nodeId))
		return { state: run.round > 1 ? 'checking' : 'reading', comments, since: run.createdAt };
	return { state: 'starting', comments, since: null };
}
