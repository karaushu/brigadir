import { createHash } from 'node:crypto';
import {
	taskReviewCommentState,
	type ReviewBatch,
	type ReviewComment,
	type TaskKey,
} from '@brigadir/core';
import { atomicJson, readDocument, safePath, type SessionStore } from '@brigadir/persistence';

/** spec/reviews#findings: the findings of a task's review live in the task's `review.json` as review comments with `review` marks. */
async function file(store: SessionStore, key: TaskKey) {
	return safePath(await store.taskDir(key), 'review.json');
}
async function readDoc(store: SessionStore, key: TaskKey): Promise<Record<string, unknown>> {
	try {
		return await readDocument(await file(store, key), 16 * 1024 * 1024);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT')
			return { schemaVersion: 1, comments: [], notes: [] };
		throw error;
	}
}
const comments = (doc: Record<string, unknown>) =>
	(Array.isArray(doc.comments) ? doc.comments : []) as ReviewComment[];
export async function reviewFindings(store: SessionStore, key: TaskKey, reviewId: string) {
	return comments(await readDoc(store, key)).filter((item) => item.review?.reviewId === reviewId);
}
/**
 * spec/reviews#findings: the counts of a closure check from the marks — open (not closed), new (a problem the fix introduced), closed (the
 * rest). `addressed` is main's to tell; the host counts by marks and replies only.
 */
export function findingCounts(list: readonly ReviewComment[]) {
	const state = list.map((item) =>
		taskReviewCommentState({
			...(item.review ? { review: item.review } : {}),
			...(item.replies ? { replies: item.replies } : {}),
			resolved: item.resolvedVersion === item.version,
		})
	);
	return {
		findings: list.length,
		open: state.filter((value) => value === 'open').length,
		introduced: state.filter((value) => value === 'new').length,
		closed: state.filter((value) => !['open', 'new', 'accepted', 'resolved'].includes(value))
			.length,
		answered: list.filter((item) => item.replies?.some((reply) => reply.agent)).length,
	};
}
/** The findings still open after a closure check: open and new, oldest first. */
export const openFindings = (list: readonly ReviewComment[]) =>
	list.filter((item) => {
		const value = taskReviewCommentState({
			...(item.review ? { review: item.review } : {}),
			resolved: item.resolvedVersion === item.version,
		});
		return value === 'open' || value === 'new';
	});
/** spec/reviews#loop: `Accept` — the open findings are recorded as accepted and their threads resolved. */
export async function acceptFindings(store: SessionStore, key: TaskKey, ids: readonly string[]) {
	if (!ids.length) return;
	const doc = await readDoc(store, key),
		list = comments(doc).map((item) =>
			ids.includes(item.id) && item.review
				? { ...item, review: { ...item.review, accepted: true }, resolvedVersion: item.version }
				: item
		);
	await atomicJson(await file(store, key), { ...doc, comments: list });
}
/** A batch the server dedups by id: the review, the pass and the findings, so `Fix {n}` on the same findings is a new batch. */
export function findingBatch(salt: string, list: readonly ReviewComment[]): ReviewBatch {
	const ids = list.map((comment) => ({ id: comment.id, version: comment.version }));
	return {
		id: createHash('sha256')
			.update(`${salt}\0${JSON.stringify(ids)}`)
			.digest('hex'),
		comments: ids,
	};
}
/** spec/reviews#loop: the findings as the task's agent reads them — the [Sending a review](spec/diff-and-review#send-review) format with ids. */
export function findingsText(list: readonly ReviewComment[], reasons = false) {
	return (
		'Address the following review comments for this task. The quoted code belongs to the specified snapshot; verify its current location before editing.\n\n' +
		list
			.map((comment, index) => {
				const reason = reasons
					? comment.replies?.findLast((reply) => !reply.agent)?.text
					: undefined;
				return `${index + 1}. Comment id ${comment.id} by ${comment.review?.reviewer ?? comment.author}. File ${JSON.stringify(comment.anchor.path)}, scope ${comment.anchor.scopeId}, new side, blob ${comment.anchor.blob}, lines ${comment.anchor.start}-${comment.anchor.end}.\nComment: ${comment.text}${reason ? `\nWhy it is still open: ${reason}` : ''}\nQuoted code: ${JSON.stringify(comment.anchor.quote.join('\n'))}`;
			})
			.join('\n\n') +
		'\n\nFor a comment you do not fix as asked, call review_reply with its comment id and your reason.'
	);
}

/**
 * spec/reviews#requests: the network requests a code review traces (English, rule 12). Part of the finding rule, so a task's own review,
 * a crew reviewer and a pull request's review crew all carry it.
 */
export const requestRule =
	'Trace the network requests this change adds or alters; skip this when it touches none. For each screen or action, count the requests that fire for one open or one action, and when they fire: on open, on focus, on every render, per list item. Raise a finding when the same data is requested from more than one place; when a request fires per list item, or again on every focus or render with no cache; when requests wait on each other without need; or when one screen fires more than three requests at once, even to different endpoints. In that finding name every call site (path:line), give the count, and propose the change: reuse the existing query or cache, give the request one owner, load a secondary section when it is shown, or ask the back-end for one endpoint.';
/**
 * spec/reviews#findings: what a finding is, for the reviewer's prompt of a code review (English, rule 12). A wish for more verification is not one;
 * a doubt is checked by the reviewer itself, and a word that needs no fix goes with the approval (spec/reviews#remark). `ownTree`: the reviewer's
 * files are the reviewed change (a task's own review syncs them); a crew reviewer's are not, so it checks through read_diff only.
 */
export function findingRule(ownTree: boolean): string {
	const check = ownTree
		? "read the files of your tree and run commands that change no files (the project's tests or type check, a short script that calls the changed code)"
		: 'read the whole diff with read_diff and the report; the files of your own tree are not this change, so a command you run there does not test it';
	return `A finding names something wrong in the change — wrong behaviour, a broken contract, a missed requirement, or work outside the task — with its evidence: the lines and what goes wrong. A wish for more checks, tests or a fuller report is not a finding. When you doubt, check it yourself: ${check}; then report the defect you found, or approve. Something the person should know that needs no fix (a risk to watch, the check you ran) goes in approve's note. ${requestRule}`;
}
