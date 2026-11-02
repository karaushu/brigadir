import { isRecord } from './workspace';
import type { Scope } from './changes';
import type { SwitchBranch } from './branch-switch';
export type PRRef = {
	number: number;
	url: string;
	title: string;
	state: 'OPEN' | 'CLOSED' | 'MERGED';
	head: string;
	base: string;
};
export type PRCheck = {
	name: string;
	bucket: 'pass' | 'fail' | 'pending' | 'skipping' | 'cancel';
	link: string;
};
export type PRDetails = { pr: PRRef; mergeable: string; checks: PRCheck[] };
export type ForgeRepository = { name: string; url: string; defaultBranch: string };
export type ForgeAuth = 'ready' | 'missing' | 'login' | 'error';
export type PushCommit = { sha: string; subject: string };
export type GitPublishState = {
	branch: string | null;
	head: string | null;
	remote: string | null;
	pushRemote: string | null;
	base: string | null;
	baseRef: string | null;
	dirty: boolean;
	ahead: number;
	pushAhead: number;
	published: boolean;
	commits: PushCommit[];
	warnings: string[];
};
export type ForgeScope = {
	scope: Scope;
	git: GitPublishState;
	repository: ForgeRepository | null;
	pr: PRRef | null;
	details: PRDetails | null;
	checksError: string | null;
	blockers: string[];
	error: string | null;
	/** spec/pull-requests-and-ci#ready-card: the branch on origin — the SHA of `origin/<branch>`, when it last moved there and whether × hid its card. */
	pushed?: ForgePush | null;
};
export type ForgePush = { sha: string; at: string | null; hidden: boolean };
export type ForgeSnapshot = { auth: ForgeAuth; scopes: ForgeScope[]; error: string | null };
/**
 * spec/pull-requests-and-ci#from-into: the reasons of the repo's current branch. They do not keep the «New pull request» dialog shut — its
 * `From` and `Into` pickers choose another pair; only the repo's own reasons (origin, GitHub) do.
 */
const BRANCH_BLOCKERS: readonly string[] = [
	'Detached HEAD',
	'Base branch is unavailable',
	'No commits ahead of base',
	'A pull request is already open',
];
export function repoBlockers(reasons: readonly string[]): string[] {
	return reasons.filter((reason) => !BRANCH_BLOCKERS.includes(reason));
}
/**
 * spec/pull-requests-and-ci#ready-card: a repo the «New PR» button offers, with the forge blockers of its current branch (none — ready); `blocked` —
 * the repo's own ones that keep the dialog shut (spec/pull-requests-and-ci#from-into).
 */
export type NewPRChoice = { item: ForgeScope; reasons: string[]; blocked: string[] };
/** The git repos of the snapshot (a folder or an outside path has no PR), narrowed to the PR panel's picked repo. */
export function newPRChoices(data: ForgeSnapshot | null, only: string | null): NewPRChoice[] {
	if (!data) return [];
	return data.scopes
		.filter(
			(item) =>
				item.scope.kind !== 'folder' &&
				item.scope.kind !== 'external' &&
				(!only || item.scope.id === only)
		)
		.map((item) => {
			const reasons =
				data.auth !== 'ready' && !item.blockers.includes('GitHub is unavailable')
					? [...item.blockers, 'GitHub is unavailable']
					: item.blockers;
			return { item, reasons, blocked: repoBlockers(reasons) };
		});
}
/**
 * spec/pull-requests-and-ci#ready-card: the card «ready for a PR» — a ready repo whose own branch (not the base) is on origin, ahead of the base,
 * and whose card × did not hide for this push.
 */
export function suggestsPR(choice: NewPRChoice): boolean {
	const { item } = choice;
	return (
		!choice.reasons.length &&
		Boolean(item.pushed && !item.pushed.hidden) &&
		Boolean(item.git.branch) &&
		item.git.branch !== item.git.base &&
		item.git.ahead > 0
	);
}
export type PushStep = {
	scopeId: string;
	name: string;
	branch: string;
	remote: string;
	published: boolean;
	count: number;
	commits: PushCommit[];
};
export type PushDraft = { id: string; scopeId: string; steps: PushStep[]; pr: PRRef | null };
export type PullRequestDraft = {
	id: string;
	scopeId: string;
	name: string;
	branch: string;
	base: string;
	canRename: boolean;
	createsBranch: boolean;
	/** spec/pull-requests-and-ci#from-into: the `From` list — the repo's local branches and those only on origin (`origin/<name>`). */
	heads: SwitchBranch[];
	/** spec/pull-requests-and-ci#from-into: the `Into` list — the branches on origin, without the `origin/` prefix. */
	bases: string[];
	hasUncommittedChanges: boolean;
	title: string;
	body: string;
	warnings: string[];
	steps: PushStep[];
};
/**
 * spec/pull-requests-and-ci#from-into: a `From → Into` pair as main checked it — commits ahead of `origin/<base>`, what goes to origin, the reason
 * the PR cannot be created (`null` — it can), the open PR of the pair, and the text that follows the pair.
 */
export type PullRequestPair = {
	head: string;
	base: string;
	ahead: number;
	steps: PushStep[];
	reason: string | null;
	open: number | null;
	title: string;
	body: string;
};
export function isWebURL(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length <= 8192 &&
		/^https:\/\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]+)?(?:\/[^\s\\]*)?$/i.test(value) &&
		!/[\x00-\x1f\x7f]/.test(value)
	);
}
export function isPRRef(value: unknown): value is PRRef {
	return (
		isRecord(value) &&
		Number.isSafeInteger(value.number) &&
		Number(value.number) > 0 &&
		isWebURL(value.url) &&
		typeof value.title === 'string' &&
		value.title.length <= 2000 &&
		['OPEN', 'CLOSED', 'MERGED'].includes(String(value.state)) &&
		typeof value.head === 'string' &&
		value.head.length <= 512 &&
		typeof value.base === 'string' &&
		value.base.length <= 512
	);
}
/** spec/tasks#lock-registry: field-by-field, never `JSON.stringify` — `task.json` stores sorted keys, GitHub gives another order. */
export function samePullRequest(a: PRRef | null | undefined, b: PRRef | null | undefined) {
	return (
		(!a && !b) ||
		(!!a &&
			!!b &&
			a.number === b.number &&
			a.url === b.url &&
			a.title === b.title &&
			a.state === b.state &&
			a.head === b.head &&
			a.base === b.base)
	);
}
