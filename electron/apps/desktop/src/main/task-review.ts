import {
	agentProviders,
	emptyTaskReviewView,
	isRecord,
	isReviewRun,
	isTaskReviewAgent,
	providerName,
	readTaskReviewDocument,
	resolveCrewAgent,
	resolveReviewer,
	selectOption,
	taskReviewAt,
	taskReviewCommentState,
	planFindingState,
	type TaskReviewCommentRow,
	isTaskSourcesDocument,
	taskReviewCovers,
	taskReviewLive,
	taskReviewRunning,
	templateLookup,
	inTask,
	type CrewLibrary,
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
/**
 * spec/reviews#who: a crew remembered for code reviews that the library no longer offers (deleted or hidden) counts as no crew: the review
 * falls back to the resolved reviewer instead of failing to start.
 */
export function rememberedReviewCrew(
	library: Pick<CrewLibrary, 'crews' | 'hiddenCrews'>,
	id: string | null
) {
	return id && library.crews.some((crew) => crew.id === id) && !library.hiddenCrews.includes(id)
		? id
		: null;
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
		// The repos a review reads: in the task and on disk (a run pins the same set).
		inReview = new Set(
			(snapshots?.scopes ?? [])
				.filter((scope) => inTask(scope) && scope.available !== false)
				.map((scope) => scope.id)
		),
		now = (snapshots?.checkpoints.at(-1)?.trees ?? []).filter((tree) => inReview.has(tree.scopeId));
	// spec/reviews#before-pr: any review that runs or waits for the person — mid-task too — is the one `Create PR` expands.
	const gate = (pre: TaskReview | null): TaskReviewView['beforePR'] =>
		taskReviewLive(doc?.review)
			? 'running'
			: !changes.files || taskReviewCovers(pre, now)
				? 'covered'
				: 'needed';
	// spec/reviews#plan-surfaces: the sources show as chips on the plan and in the strip, with or without a review.
	const index = await readDocument(
			await safePath(await store.taskDir(key), 'sources', 'sources.json')
		).catch(() => null),
		sources = isTaskSourcesDocument(index) ? index.sources : [];
	if (!doc) return { ...emptyTaskReviewView, changes, sources, beforePR: gate(null) };
	const current = doc.review;
	if (!current)
		return {
			...emptyTaskReviewView,
			changes,
			proposal: doc.proposal,
			past: doc.past,
			sources,
			beforePR: gate(taskReviewAt(doc, 'pre-pr')),
		};
	// spec/reviews#reviewer-sessions: the host adds a review's reviewers to the task's crew when it has one (a foreman, an Auto task after a hire),
	// else to its review crew; the current review's reviewers are the root's checkers among them.
	const task = await store.task(key),
		spec = task.crew ?? task.reviewCrew,
		nodes = (spec?.root.checkedBy ?? [])
			.map((id) => spec!.root.agents.find((agent) => agent.id === id))
			.filter((agent): agent is CrewSpecAgent => Boolean(agent) && isTaskReviewAgent(agent!));
	const workers = await json(store, key, 'crew-workers.json'),
		records = (Array.isArray(workers?.workers) ? workers.workers : []).filter(isRecord);
	const runsDoc = await json(store, key, 'crew-reviews.json'),
		runs = (Array.isArray(runsDoc?.reviews) ? runsDoc.reviews : [])
			.filter(isReviewRun)
			.filter((run) => run.taskId === key.id);
	const run = current.state === 'failed' ? null : (runs.at(-1) ?? null);
	const snapshot = await review(key).catch(() => ({ comments: [] }) as ReviewSnapshot);
	const ids = new Set([current.id, ...doc.past.map((item) => item.id)]);
	const comments: TaskReviewCommentRow[] = snapshot.comments
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
	// spec/reviews#plan-surfaces: a plan review's findings live in its record; they have no thread in the diff.
	for (const item of [...doc.past, current])
		for (const finding of item.findings ?? [])
			comments.push({
				id: finding.id,
				reviewId: item.id,
				text: finding.text,
				path: '',
				line: 0,
				scopeId: '',
				reviewer: finding.reviewer,
				round: finding.round,
				state: planFindingState(finding),
				answer: finding.answer ?? null,
				reason: finding.reason ?? null,
				kind: finding.kind,
				...(finding.where ? { where: finding.where } : {}),
			});
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
									(item) =>
										item.reviewId === current.id &&
										item.reviewer === node.name &&
										item.kind !== 'gap'
								)
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
		sources,
		beforePR: gate(taskReviewAt(doc, 'pre-pr')),
	};
}
/**
 * spec/reviews#surfaces: a reviewer's state in this review. `findings` counts what it filed, except while the person decides (`open`), where it
 * counts the findings still open, as the task's line does; after the person's `Accept` it reads `accepted`.
 */
export function memberState(
	review: TaskReview,
	run: ReviewRun | null,
	nodeId: string,
	status: string | null,
	filed: readonly Pick<TaskReviewCommentRow, 'state'>[]
): Pick<TaskReviewMember, 'state' | 'findings' | 'since' | 'note'> {
	const verdict = run?.verdicts.find((item) => item.reviewerNodeId === nodeId),
		findings = filed.length;
	// A stopped review stops its reviewers too: one cut off by the stop reads `stopped`, not `did not start`.
	if (review.state === 'stopped') return { state: 'stopped', findings, since: null };
	if (status === 'failed') return { state: 'failed', findings, since: null };
	if (review.state === 'accepted') return { state: 'accepted', findings, since: null };
	if (review.state === 'yours' && verdict && !verdict.approved)
		return {
			state: 'open',
			findings: filed.filter((item) => item.state === 'open' || item.state === 'new').length,
			since: verdict.at,
		};
	if (verdict?.approved)
		return {
			state: 'approved',
			findings,
			since: verdict.at,
			...(verdict.note ? { note: verdict.note } : {}),
		};
	if (verdict) return { state: 'findings', findings, since: verdict.at };
	if (run && run.state === 'reviewing' && run.dispatched.includes(nodeId))
		return { state: run.round > 1 ? 'checking' : 'reading', findings, since: run.createdAt };
	return { state: 'starting', findings, since: null };
}
