import {
	agentProviders,
	emptyTaskReviewView,
	isRecord,
	isReviewRun,
	providerName,
	readTaskReviewDocument,
	resolveCrewAgent,
	resolveReviewer,
	selectOption,
	taskReviewAt,
	taskReviewCommentState,
	taskReviewCovers,
	taskReviewRunning,
	templateLookup,
	type ActionAgents,
	type AgentCheck,
	type AgentProvider,
	type AgentProviderId,
	type AgentTemplate,
	type ProviderCatalog,
	type CrewSpecAgent,
	type ReviewerChoice,
	type ReviewPoint,
	type ReviewRun,
	type ReviewSnapshot,
	type TaskKey,
	type TaskReview,
	type TaskReviewMember,
	type TaskReviewView,
} from '@brigadir/core';
import { changedFiles, readChanges, readSnapshots } from '@brigadir/git';
import { readDocument, safePath, type SessionStore } from '@brigadir/persistence';

async function json(store: SessionStore, key: TaskKey, name: string, versions = [1]) {
	try {
		return await readDocument(
			await safePath(await store.taskDir(key), name),
			16 * 1024 * 1024,
			versions
		);
	} catch {
		return null;
	}
}
/**
 * spec/reviews#who: one reviewer — the Reviewer template with that provider, named after it, and its launch options (model, effort) as the
 * node's choices; none when the provider's own defaults review.
 */
export function reviewerAgent(
	provider: AgentProvider,
	launchOptions: readonly { id: string; value: string | boolean }[],
	agents: readonly AgentTemplate[]
): CrewSpecAgent {
	return resolveCrewAgent(
		{
			id: 'reviewer',
			name: providerName(provider),
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
/**
 * spec/reviews#who: who reviews a task of `author` at `point` now — the action's own agent (`planReview`, `taskReview`), else another provider
 * that is enabled and signed in, else a fresh session of the author's provider. Sign-in comes from the environment check; a state it cannot
 * tell counts as not known.
 */
export function reviewerFor(input: {
	author: AgentProviderId;
	point: ReviewPoint;
	enabled: Record<AgentProviderId, boolean>;
	actionAgents: ActionAgents;
	agents: readonly AgentCheck[];
	catalogs: Partial<Record<AgentProviderId, ProviderCatalog | null>>;
}): ReviewerChoice | { failure: string } {
	const own = input.actionAgents[input.point === 'plan' ? 'planReview' : 'taskReview'];
	const ready: Partial<Record<AgentProviderId, boolean>> = {};
	for (const agent of input.agents)
		if (!agent.found || agent.signIn === 'signed-out' || agent.signIn === 'expired')
			ready[agent.provider] = false;
		else if (agent.signIn === 'signed-in') ready[agent.provider] = true;
	const defaults: Partial<
		Record<AgentProviderId, { model: string | null; effort: string | null }>
	> = {};
	for (const provider of agentProviders) {
		const catalog = input.catalogs[provider];
		if (!catalog) continue;
		const model = selectOption(catalog.options, 'model'),
			effort = selectOption((model && catalog.byModel?.[model.value]) || catalog.options, 'effort');
		defaults[provider] = { model: model?.value ?? null, effort: effort?.value ?? null };
	}
	return resolveReviewer({
		providers: agentProviders,
		author: input.author,
		enabled: input.enabled,
		ready,
		override: own ? { provider: own.provider, model: own.model, effort: own.effort } : null,
		defaults,
	});
}
/** spec/reviews#strip: the task's reviews as the window shows them — the record, the reviewers' states, every review's findings and the gate. */
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
	const doc = readTaskReviewDocument(await json(store, key, 'task-review.json', [1, 2]), key.id);
	const snapshots = await readSnapshots(store, key).catch(() => null),
		now = snapshots?.checkpoints.at(-1)?.trees ?? [];
	const gate = (pre: TaskReview | null): TaskReviewView['beforePR'] =>
		taskReviewRunning(pre) || pre?.state === 'yours'
			? 'running'
			: !changes.files || taskReviewCovers(pre, now)
				? 'covered'
				: 'needed';
	if (!doc) return { ...emptyTaskReviewView, changes, beforePR: gate(null) };
	const current = doc.review;
	if (!current)
		return {
			...emptyTaskReviewView,
			changes,
			proposal: doc.proposal,
			past: doc.past,
			beforePR: gate(taskReviewAt(doc, 'pre-pr')),
		};
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
	const run = current.state === 'failed' ? null : (runs.at(-1) ?? null);
	const snapshot = await review(key).catch(() => ({ comments: [] }) as ReviewSnapshot);
	const ids = new Set([current.id, ...doc.past.map((item) => item.id)]);
	const comments = snapshot.comments
		.filter((comment) => comment.review && ids.has(comment.review.reviewId))
		.map((comment) => ({
			id: comment.id,
			reviewId: comment.review!.reviewId,
			text: comment.text,
			path: comment.anchor.path,
			line: comment.position?.start ?? comment.anchor.start,
			scopeId: comment.anchor.scopeId,
			reviewer: comment.review!.reviewer,
			round: comment.review!.round,
			state: taskReviewCommentState(comment),
			answer: comment.replies?.findLast((reply) => reply.agent)?.text ?? null,
			reason: comment.replies?.findLast((reply) => !reply.agent)?.text ?? null,
		}));
	const members: TaskReviewMember[] =
		current.state === 'failed'
			? []
			: await Promise.all(
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
							...memberState(
								current,
								run,
								node.id,
								worker?.status ?? null,
								comments.filter(
									(item) => item.reviewId === current.id && item.reviewer === node.name
								).length
							),
							...(worker?.status === 'failed' && worker.failure ? { failure: worker.failure } : {}),
						};
					})
				);
	const changed =
		current.trees.length > 0 &&
		current.trees.some(
			(tree) => now.find((item) => item.scopeId === tree.scopeId)?.tree !== tree.tree
		);
	let sinceLast: number | null = null;
	if (current.trees.length && !taskReviewRunning(current) && current.state !== 'yours') {
		sinceLast = 0;
		for (const tree of current.trees) {
			const scope = snapshots?.scopes.find((item) => item.id === tree.scopeId),
				after = now.find((item) => item.scopeId === tree.scopeId)?.tree;
			if (scope && after && after !== tree.tree)
				sinceLast += (await changedFiles(scope, tree.tree, after).catch(() => [])).length;
		}
	}
	return {
		...doc,
		changes,
		changed,
		members,
		comments,
		sinceLast,
		beforePR: gate(taskReviewAt(doc, 'pre-pr')),
	};
}
function memberState(
	review: TaskReview,
	run: ReviewRun | null,
	nodeId: string,
	status: string | null,
	findings: number
): Pick<TaskReviewMember, 'state' | 'findings' | 'since'> {
	const verdict = run?.verdicts.find((item) => item.reviewerNodeId === nodeId);
	if (status === 'failed') return { state: 'failed', findings, since: null };
	if (review.state === 'stopped') return { state: 'stopped', findings, since: null };
	if (review.state === 'yours' && verdict && !verdict.approved)
		return { state: 'open', findings, since: verdict.at };
	if (verdict?.approved) return { state: 'approved', findings, since: verdict.at };
	if (verdict) return { state: 'findings', findings, since: verdict.at };
	if (run && run.state === 'reviewing' && run.dispatched.includes(nodeId))
		return { state: run.round > 1 ? 'checking' : 'reading', findings, since: run.createdAt };
	return { state: 'starting', findings, since: null };
}
