/**
 * spec/pull-requests-and-ci#repo-counter: a PR's state and its review state as glyphs without words. One look in the PR panel and in the phone's PR
 * list (spec/remote-access-and-mobile#phone-pr-list, rule 17); the size is the host's.
 */
import { isOpenPR, prMark, t, type Locale, type PullRequestSummary } from '@brigadir/core';
import { Glyph } from './Glyph';
import s from './PRGlyphs.module.css';

export function PRStateGlyph({
	pr,
	size = 14,
}: {
	pr: Pick<PullRequestSummary, 'state'>;
	size?: number;
}) {
	const name =
		pr.state === 'MERGED'
			? 'pr-merged'
			: pr.state === 'CLOSED'
				? 'pr-closed'
				: pr.state === 'DRAFT'
					? 'pr-draft'
					: 'pr-branch';
	return (
		<span className={s.state} data-pr-state={pr.state}>
			<Glyph name={name} size={size} />
		</span>
	);
}
/** Its own PR shows the reviewers' decision, someone else's — that it waits for you. */
export function PRMarkGlyph({
	pr,
	locale,
	size = 13,
}: {
	pr: PullRequestSummary;
	locale: Locale;
	size?: number;
}) {
	const mark = prMark(pr);
	if (!mark || !isOpenPR(pr)) return null;
	const label = t(
		locale,
		mark === 'waiting'
			? 'Waiting for your review'
			: mark === 'changes'
				? 'Changes requested'
				: 'Approved'
	);
	return (
		<span className={s.mark} data-mark={mark} title={label} role="img" aria-label={label}>
			{mark === 'waiting' ? (
				<span className={s.waitingDot} />
			) : (
				<Glyph name={mark === 'changes' ? 'review-changes' : 'check-pass'} size={size} />
			)}
		</span>
	);
}
