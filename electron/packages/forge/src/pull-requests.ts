import {
	isRecord,
	isWebURL,
	checksState,
	type PullRequestSummary,
	type PullRequestDetail,
	type PRState,
	type PRReviewDecision,
	type PRReviewState,
	type PRReviewer,
	type PRChecksState,
	type PRThread,
	type PRFile,
	type PRFileChange,
	type PRCheckRun,
	type PRCheckState,
	type PRMergeMethod,
} from '@brigadir/core';

/** spec/pull-requests-and-ci#reading-and-refresh: GitHub is read only through `gh api graphql`; one query for a repo's list, one for a PR. */
const summaryFields = `number title url state isDraft author{login} headRefName baseRefName updatedAt closedAt mergedAt reviewDecision totalCommentsCount additions deletions
 reviewRequests(first:20){nodes{requestedReviewer{... on User{login}}}}
 latestReviews(first:20){nodes{author{login} state}}
 commits(last:1){nodes{commit{statusCheckRollup{state}}}}`;
export const listQuery = `query($owner:String!,$name:String!){viewer{login}
 repository(owner:$owner,name:$name){
  open:pullRequests(states:OPEN,first:100,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{${summaryFields}}}
  closed:pullRequests(states:[CLOSED,MERGED],first:30,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{${summaryFields}}}}}`;
export const detailQuery = `query($owner:String!,$name:String!,$number:Int!){viewer{login}
 repository(owner:$owner,name:$name){viewerPermission mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed viewerDefaultMergeMethod
  pullRequest(number:$number){${summaryFields} id body createdAt headRefOid baseRefOid mergeCommit{oid} mergeStateStatus mergeable maintainerCanModify isCrossRepository
   baseRef{branchProtectionRule{requiredApprovingReviewCount}}
   reviewThreads(first:100){nodes{id path line startLine diffSide isResolved isOutdated comments(first:50){nodes{id databaseId author{login} body createdAt url diffHunk}}}}
   comments(first:100){nodes{id author{login} body createdAt url}}
   reviews(first:100){nodes{id author{login} state body submittedAt}}
   files(first:100){nodes{path additions deletions changeType viewerViewedState}}
   allCommits:commits(first:100){nodes{commit{oid messageHeadline authoredDate author{name user{login}}}}}
   lastCommit:commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){nodes{__typename
    ... on CheckRun{name status conclusion detailsUrl startedAt completedAt checkSuite{workflowRun{workflow{name}}}}
    ... on StatusContext{context state targetUrl}}}}}}}}}}`;

class Invalid extends Error {}
const str = (value: unknown, max = 100_000): string => {
	if (typeof value !== 'string' || value.length > max) throw new Invalid('text');
	return value;
};
const optStr = (value: unknown, max = 100_000): string | null =>
	value === null || value === undefined ? null : str(value, max);
const int = (value: unknown): number => {
	if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Invalid('number');
	return Number(value);
};
const nodes = (value: unknown): unknown[] =>
	isRecord(value) && Array.isArray(value.nodes) ? value.nodes : [];
const login = (value: unknown) =>
	isRecord(value) && typeof value.login === 'string' ? value.login : 'ghost';
const url = (value: unknown) => {
	if (!isWebURL(value)) throw new Invalid('url');
	return value;
};
const reviewStates = ['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'PENDING', 'DISMISSED'];
function rollup(value: unknown): PRChecksState {
	const state = isRecord(value) ? value.state : null;
	return state === 'SUCCESS'
		? 'pass'
		: state === 'FAILURE' || state === 'ERROR'
			? 'fail'
			: state === 'PENDING' || state === 'EXPECTED'
				? 'pending'
				: 'none';
}
export function summary(value: unknown, viewer: string): PullRequestSummary {
	if (!isRecord(value)) throw new Invalid('pull request');
	const raw = str(value.state),
		state: PRState =
			raw === 'MERGED'
				? 'MERGED'
				: raw === 'CLOSED'
					? 'CLOSED'
					: value.isDraft === true
						? 'DRAFT'
						: 'OPEN',
		author = login(value.author);
	const requested = nodes(value.reviewRequests)
		.map((node) =>
			isRecord(node) &&
			isRecord(node.requestedReviewer) &&
			typeof node.requestedReviewer.login === 'string'
				? node.requestedReviewer.login
				: null
		)
		.filter((name): name is string => name !== null);
	const reviewers: PRReviewer[] = [
		...requested.map((name) => ({ login: name, state: 'REQUESTED' as const })),
		...nodes(value.latestReviews).flatMap((node) =>
			isRecord(node) &&
			reviewStates.includes(String(node.state)) &&
			!requested.includes(login(node.author))
				? [{ login: login(node.author), state: node.state as PRReviewState }]
				: []
		),
	];
	const decision =
		value.reviewDecision === 'APPROVED' ||
		value.reviewDecision === 'CHANGES_REQUESTED' ||
		value.reviewDecision === 'REVIEW_REQUIRED'
			? (value.reviewDecision as PRReviewDecision)
			: null;
	const commit = nodes(value.commits)[0],
		status = isRecord(commit) && isRecord(commit.commit) ? commit.commit.statusCheckRollup : null;
	return {
		number: int(value.number),
		title: str(value.title, 2000),
		url: url(value.url),
		state,
		author,
		mine: author === viewer,
		waiting: author !== viewer && requested.includes(viewer),
		head: str(value.headRefName, 512),
		base: str(value.baseRefName, 512),
		updatedAt: str(value.updatedAt, 64),
		closedAt: optStr(value.mergedAt ?? value.closedAt, 64),
		reviewDecision: decision,
		reviewers,
		comments: int(value.totalCommentsCount ?? 0),
		checks: rollup(status),
		additions: int(value.additions ?? 0),
		deletions: int(value.deletions ?? 0),
	};
}
function data(value: unknown) {
	if (!isRecord(value) || !isRecord(value.data)) throw new Invalid('response');
	return value.data;
}
export function parseList(value: unknown): { viewer: string; prs: PullRequestSummary[] } {
	const root = data(value),
		viewer = login(root.viewer),
		repository = root.repository;
	if (!isRecord(repository)) throw new Invalid('repository');
	return {
		viewer,
		prs: [...nodes(repository.open), ...nodes(repository.closed)].map((node) =>
			summary(node, viewer)
		),
	};
}
const changes: PRFileChange[] = ['ADDED', 'DELETED', 'MODIFIED', 'RENAMED', 'COPIED', 'CHANGED'];
function check(node: unknown): PRCheckRun | null {
	if (!isRecord(node)) return null;
	if (node.__typename === 'StatusContext') {
		const state =
			node.state === 'SUCCESS'
				? 'pass'
				: node.state === 'FAILURE' || node.state === 'ERROR'
					? 'fail'
					: 'pending';
		return {
			name: str(node.context, 2000),
			workflow: null,
			state,
			link: isWebURL(node.targetUrl) ? node.targetUrl : '',
			seconds: null,
		};
	}
	if (node.__typename !== 'CheckRun') return null;
	const conclusion = node.conclusion,
		state: PRCheckState =
			node.status !== 'COMPLETED'
				? 'pending'
				: conclusion === 'SUCCESS' || conclusion === 'NEUTRAL'
					? 'pass'
					: conclusion === 'SKIPPED'
						? 'skipping'
						: conclusion === 'CANCELLED'
							? 'cancel'
							: 'fail';
	const run =
		isRecord(node.checkSuite) &&
		isRecord(node.checkSuite.workflowRun) &&
		isRecord(node.checkSuite.workflowRun.workflow)
			? node.checkSuite.workflowRun.workflow.name
			: null;
	const started = typeof node.startedAt === 'string' ? Date.parse(node.startedAt) : NaN,
		completed = typeof node.completedAt === 'string' ? Date.parse(node.completedAt) : NaN;
	return {
		name: str(node.name, 2000),
		workflow: typeof run === 'string' ? run : null,
		state,
		link: isWebURL(node.detailsUrl) ? node.detailsUrl : '',
		seconds:
			Number.isFinite(started) && Number.isFinite(completed)
				? Math.max(0, Math.round((completed - started) / 1000))
				: null,
	};
}
export function parseDetail(value: unknown): PullRequestDetail {
	const root = data(value),
		viewer = login(root.viewer),
		repository = root.repository;
	if (!isRecord(repository) || !isRecord(repository.pullRequest)) throw new Invalid('pull request');
	const pr = repository.pullRequest,
		base = summary(pr, viewer),
		write = ['ADMIN', 'MAINTAIN', 'WRITE'].includes(String(repository.viewerPermission));
	const methods: PRMergeMethod[] = [
		...(repository.squashMergeAllowed === true ? ['squash' as const] : []),
		...(repository.mergeCommitAllowed === true ? ['merge' as const] : []),
		...(repository.rebaseMergeAllowed === true ? ['rebase' as const] : []),
	];
	const preferred = String(repository.viewerDefaultMergeMethod).toLowerCase(),
		defaultMergeMethod = (
			methods.includes(preferred as PRMergeMethod) ? preferred : (methods[0] ?? 'merge')
		) as PRMergeMethod;
	const threads: PRThread[] = nodes(pr.reviewThreads)
		.filter(isRecord)
		.map((node) => ({
			id: str(node.id, 200),
			path: str(node.path, 4096),
			line: node.line === null ? null : int(node.line),
			startLine:
				node.startLine === null || node.startLine === undefined ? null : int(node.startLine),
			side: node.diffSide === 'LEFT' ? 'LEFT' : 'RIGHT',
			resolved: node.isResolved === true,
			outdated: node.isOutdated === true,
			comments: nodes(node.comments)
				.filter(isRecord)
				.map((comment) => ({
					id: str(comment.id, 200),
					databaseId: int(comment.databaseId),
					author: login(comment.author),
					body: str(comment.body),
					createdAt: str(comment.createdAt, 64),
					url: url(comment.url),
				})),
			hunk: (() => {
				const first = nodes(node.comments)[0];
				return isRecord(first) && typeof first.diffHunk === 'string'
					? first.diffHunk.slice(-4000)
					: null;
			})(),
		}));
	const files: PRFile[] = nodes(pr.files)
		.filter(isRecord)
		.map((node) => ({
			path: str(node.path, 4096),
			additions: int(node.additions),
			deletions: int(node.deletions),
			change: (changes.includes(node.changeType as PRFileChange)
				? node.changeType
				: 'MODIFIED') as PRFileChange,
			viewed: node.viewerViewedState === 'VIEWED',
		}));
	const last = nodes(pr.lastCommit)[0],
		contexts =
			isRecord(last) && isRecord(last.commit) && isRecord(last.commit.statusCheckRollup)
				? nodes(last.commit.statusCheckRollup.contexts)
				: [];
	const checks = contexts.map(check).filter((item): item is PRCheckRun => item !== null);
	const protection =
		isRecord(pr.baseRef) &&
		isRecord(pr.baseRef.branchProtectionRule) &&
		Number.isSafeInteger(pr.baseRef.branchProtectionRule.requiredApprovingReviewCount)
			? Number(pr.baseRef.branchProtectionRule.requiredApprovingReviewCount)
			: null;
	return {
		id: str(pr.id ?? '', 200),
		summary: { ...base, checks: checks.length ? checksState(checks) : base.checks },
		body: str(pr.body ?? ''),
		createdAt: str(pr.createdAt, 64),
		headSha: str(pr.headRefOid, 64),
		mergeSha:
			isRecord(pr.mergeCommit) &&
			typeof pr.mergeCommit.oid === 'string' &&
			/^[0-9a-f]{40,64}$/.test(pr.mergeCommit.oid)
				? pr.mergeCommit.oid
				: null,
		baseSha:
			typeof pr.baseRefOid === 'string' && /^[0-9a-f]{40,64}$/.test(pr.baseRefOid)
				? pr.baseRefOid
				: null,
		additions: int(pr.additions),
		deletions: int(pr.deletions),
		mergeState: String(pr.mergeStateStatus ?? 'UNKNOWN'),
		mergeable: String(pr.mergeable ?? 'UNKNOWN'),
		requiredApprovals: protection,
		canPush: write && (pr.isCrossRepository !== true || pr.maintainerCanModify === true),
		crossRepository: pr.isCrossRepository === true,
		canMerge: write,
		mergeMethods: methods,
		defaultMergeMethod,
		threads,
		comments: nodes(pr.comments)
			.filter(isRecord)
			.map((node) => ({
				id: str(node.id, 200),
				author: login(node.author),
				body: str(node.body),
				createdAt: str(node.createdAt, 64),
				url: url(node.url),
			})),
		reviews: nodes(pr.reviews)
			.filter(isRecord)
			.flatMap((node) =>
				reviewStates.includes(String(node.state))
					? [
							{
								id: str(node.id, 200),
								author: login(node.author),
								state: node.state as PRReviewState,
								body: str(node.body ?? ''),
								submittedAt: str(node.submittedAt ?? pr.createdAt, 64),
							},
						]
					: []
			),
		files,
		commits: nodes(pr.allCommits)
			.filter(isRecord)
			.flatMap((node) =>
				isRecord(node.commit)
					? [
							{
								sha: str(node.commit.oid, 64),
								subject: str(node.commit.messageHeadline, 2000),
								author: isRecord(node.commit.author)
									? isRecord(node.commit.author.user)
										? login(node.commit.author.user)
										: str(node.commit.author.name ?? '', 200)
									: '',
								at: str(node.commit.authoredDate, 64),
							},
						]
					: []
			),
		checks,
	};
}
export { Invalid as InvalidResponse };
