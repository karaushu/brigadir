import { app } from 'electron';
import { SessionStore } from '@brigadir/persistence';
import {
	isOpenPR,
	prMenuIcons,
	selectLocale,
	t,
	type AgentTask,
	type Locale,
	type MessageKey,
	type NativeMenuItem,
	type PRMenuAction,
	type PRMenuRow,
	type PRRefKey,
	type PRReviewDraft,
	type PullRequestDetail,
	type TaskKey,
} from '@brigadir/core';
import type { ClientUi } from './client-ui';
import type { Client } from './clients';

export type PRMenuState = {
	/** What the row shows: the PR's state, its head branch and its page. */
	pr: PRMenuRow;
	/** Drafts of this PR's review on disk (spec/pull-requests-and-ci#review-drafts): «Continue review…» instead of «Start review…». */
	drafts: number;
	/** GitHub says the PR conflicts with its base and the PR branch takes a push (the «Merging» card's split, spec/pull-requests-and-ci#resolve-conflicts). */
	conflicts: boolean;
	/** This task reviews this PR (spec/pull-requests-and-ci#review-with-agent): no agent review, as with the button. */
	reviewsThis: boolean;
	/** A review task of this PR is live (spec/pull-requests-and-ci#review-with-agent): «Open the review» instead of a new one. */
	liveReview: boolean;
};

/**
 * spec/appearance#evolution-redesign: the right-click menu of a PR list row. An open PR: review, the agent's review in a submenu, the
 * conflict when there is one; then GitHub and the two copies. A merged or closed PR: GitHub and the copies only.
 * The copies finish where the menu shows (spec/remote-access-and-mobile#client-ui-seam), like every other copy item of a menu.
 */
export function prMenuTemplate(locale: Locale, state: PRMenuState): NativeMenuItem[] {
	const item = (id: keyof typeof prMenuIcons, label: MessageKey, extra = {}) => ({
		id,
		label: t(locale, label),
		icon: prMenuIcons[id],
		...extra,
	});
	const page: NativeMenuItem[] = [
		item('github', 'Open on GitHub'),
		item('copy-link', 'Copy link', { copy: state.pr.url }),
		item('copy-branch', 'Copy branch name', { copy: state.pr.head }),
	];
	if (!isOpenPR(state.pr)) return page;
	return [
		item('review', state.drafts > 0 ? 'Continue review…' : 'Start review…'),
		...(state.reviewsThis
			? []
			: [
					state.liveReview
						? item('open-review', 'Open the review')
						: item('agent-review', 'Review with an agent…'),
				]),
		...(state.conflicts ? [item('conflicts', 'Resolve conflicts…')] : []),
		null,
		...page,
	];
}

/** The «Merging» card's condition (PROverview): a conflict, and a branch this person can push the merge into. */
export const resolvable = (detail: PullRequestDetail) =>
	(detail.mergeable === 'CONFLICTING' || detail.mergeState === 'DIRTY') &&
	detail.canPush &&
	!detail.crossRepository;

export type PRMenuSource = {
	lastDetail(
		projectId: string,
		taskId: string | null,
		scopeId: string,
		number: number
	): Promise<PullRequestDetail | null>;
	detail(
		projectId: string,
		taskId: string | null,
		scopeId: string,
		number: number
	): Promise<PullRequestDetail>;
	readDraft(key: TaskKey, scopeId: string, number: number): Promise<PRReviewDraft>;
	/** spec/pull-requests-and-ci#review-with-agent: whether a review task of this PR is live in the project. */
	liveReview(key: TaskKey, ref: PRRefKey): Promise<boolean>;
};
/** How long a menu waits for a PR nobody has opened yet; past it the menu shows without «Resolve conflicts…». */
export const prMenuDetailWait = 500;

export class PRMenus {
	constructor(
		readonly dataDir: string | undefined,
		readonly ui: ClientUi,
		readonly source: PRMenuSource,
		readonly locale: () => Locale = () => selectLocale(app.getLocale()),
		readonly wait = prMenuDetailWait
	) {}
	private async conflicts(key: TaskKey, ref: PRRefKey) {
		const known = await this.source
			.lastDetail(key.projectId, key.id, ref.scopeId, ref.number)
			.catch(() => null);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const detail =
			known ??
			(await Promise.race([
				this.source.detail(key.projectId, key.id, ref.scopeId, ref.number).catch(() => null),
				new Promise<null>((resolve) => {
					timer = setTimeout(() => resolve(null), this.wait);
				}),
			]));
		clearTimeout(timer);
		return detail ? resolvable(detail) : false;
	}
	async show(
		client: Client,
		key: TaskKey,
		ref: PRRefKey,
		pr: PRMenuRow
	): Promise<PRMenuAction | null> {
		const open = isOpenPR(pr);
		const [drafts, conflicts, task, liveReview] = open
			? await Promise.all([
					this.source
						.readDraft(key, ref.scopeId, ref.number)
						.then((review) => review.drafts.length)
						.catch(() => 0),
					this.conflicts(key, ref),
					SessionStore.at(this.dataDir)
						.then((store) => store.task(key))
						.catch((): AgentTask | null => null),
					this.source.liveReview(key, ref).catch(() => false),
				])
			: [0, false, null, false];
		const reviewsThis = task?.prReview?.mode === 'review' && task.prReview.number === ref.number;
		return (await this.ui.menu(
			client,
			prMenuTemplate(this.locale(), { pr, drafts, conflicts, reviewsThis, liveReview })
		)) as PRMenuAction | null;
	}
}
