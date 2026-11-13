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
