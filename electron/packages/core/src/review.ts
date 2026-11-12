import { isRecord } from './workspace';
export type Anchor = {
	scopeId: string;
	path: string;
	side: 'old' | 'new';
	blob: string;
	start: number;
	end: number;
	quote: string[];
	before: string[];
	after: string[];
	contextHash: string;
	symbolPath: string | null;
};
/** `author` names an agent reviewer (`<agent> · checks <agent>`, spec/crew#reviewer); human comments have none. */
/** spec/diff-and-review#agent-review-rounds: a reviewer's comment of a task's review before the PR — its round, and whether a reviewer insisted in round 2. */
export type ReviewCommentRound = {
	reviewId: string;
	round: number;
	reviewer: string;
	disputed?: boolean;
};
/** The thread under a reviewer's comment: the task agent's answer (`review_reply`) or a reviewer insisting in round 2. */
export type ReviewReply = {
	author: string;
	text: string;
	at: string;
	round: number;
	agent: boolean;
};
export const reviewReplyLimit = 20;
export type ReviewComment = {
	author?: string;
	review?: ReviewCommentRound;
	replies?: ReviewReply[];
	/** spec/appearance#evolution-redesign: the selected text verbatim (a partial line stays partial); the anchor stays the lines it touches. */
	excerpt?: string;
	id: string;
	version: number;
	resolvedVersion?: number;
	addressedVersion?: number;
	addressedCheckpoint?: number;
	text: string;
	at: string;
	anchor: Anchor;
};
export type ReviewBatch = { id: string; comments: { id: string; version: number }[] };
export type ReviewNote = Pick<ReviewComment, 'id' | 'version' | 'text' | 'at' | 'resolvedVersion'>;
export type ReviewStatus = { sent: boolean; addressed?: boolean; resolved?: boolean };
export type ReviewSnapshot = {
	notes?: (ReviewNote & ReviewStatus)[];
	comments: (ReviewComment & ReviewStatus & { position?: AnchorPosition })[];
};
export type ReviewPosition = { id: string; version: number; position: AnchorPosition | null };
export type AnchorPosition = {
	state: 'exact' | 'relocated' | 'outdated';
	start: number | null;
	end: number | null;
};
export function isReviewBatch(value: unknown): value is ReviewBatch {
	return (
		isRecord(value) &&
		typeof value.id === 'string' &&
		/^[a-f0-9]{64}$/.test(value.id) &&
		Array.isArray(value.comments) &&
		value.comments.length > 0 &&
		value.comments.length <= 500 &&
		value.comments.every(
			(c) =>
				isRecord(c) &&
				typeof c.id === 'string' &&
				/^[a-f0-9-]{36}$/.test(c.id) &&
				Number.isSafeInteger(c.version) &&
				Number(c.version) > 0
		)
	);
}

export type CommentInput = {
	fileId: string;
	side: 'old' | 'new';
	start: number;
	end: number;
	text: string;
	/** spec/appearance#evolution-redesign */ excerpt?: string;
};
/** The longest quote a comment keeps: 100 lines of the anchor limit, 4000 characters each. */
export const excerptLimit = 400_000;
export const isExcerpt = (value: unknown) =>
	value === undefined || (typeof value === 'string' && value.length <= excerptLimit);
export function isCommentInput(value: unknown): value is CommentInput {
	return (
		isRecord(value) &&
		typeof value.fileId === 'string' &&
		/^[a-f0-9]{64}$/.test(value.fileId) &&
		(value.side === 'old' || value.side === 'new') &&
		Number.isSafeInteger(value.start) &&
		Number.isSafeInteger(value.end) &&
		Number(value.start) > 0 &&
		Number(value.end) >= Number(value.start) &&
		Number(value.end) - Number(value.start) < 100 &&
		isCommentText(value.text) &&
		isExcerpt(value.excerpt)
	);
}
export function isCommentText(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0 && value.length <= 10000;
}
function isReviewCommentRound(value: unknown): value is ReviewCommentRound {
	return (
		isRecord(value) &&
		typeof value.reviewId === 'string' &&
		value.reviewId.length > 0 &&
		value.reviewId.length <= 100 &&
		Number.isSafeInteger(value.round) &&
		Number(value.round) >= 1 &&
		typeof value.reviewer === 'string' &&
		value.reviewer.length > 0 &&
		value.reviewer.length <= 200 &&
		(value.disputed === undefined || typeof value.disputed === 'boolean')
	);
}
export function isReviewReply(value: unknown): value is ReviewReply {
	return (
		isRecord(value) &&
		typeof value.author === 'string' &&
		value.author.length > 0 &&
		value.author.length <= 200 &&
		isCommentText(value.text) &&
		typeof value.at === 'string' &&
		Number.isFinite(Date.parse(value.at)) &&
		Number.isSafeInteger(value.round) &&
		Number(value.round) >= 1 &&
		typeof value.agent === 'boolean'
	);
}
export function isReviewComment(value: unknown): value is ReviewComment {
	if (
		!isRecord(value) ||
		!validResolved(value) ||
		!isExcerpt(value.excerpt) ||
		!(
			value.author === undefined ||
			(typeof value.author === 'string' && value.author.length > 0 && value.author.length <= 200)
		) ||
		!(
			(value.addressedVersion === undefined && value.addressedCheckpoint === undefined) ||
			(Number.isSafeInteger(value.addressedVersion) &&
				Number(value.addressedVersion) > 0 &&
				Number(value.addressedVersion) <= Number(value.version) &&
				Number.isSafeInteger(value.addressedCheckpoint) &&
				Number(value.addressedCheckpoint) > 0)
		) ||
		!(value.review === undefined || isReviewCommentRound(value.review)) ||
		!(
			value.replies === undefined ||
			(Array.isArray(value.replies) &&
				value.replies.length <= reviewReplyLimit &&
				value.replies.every(isReviewReply))
		) ||
		typeof value.id !== 'string' ||
		!/^[a-f0-9-]{36}$/.test(value.id) ||
		!Number.isSafeInteger(value.version) ||
		Number(value.version) < 1 ||
		!isCommentText(value.text) ||
		typeof value.at !== 'string' ||
		!Number.isFinite(Date.parse(value.at)) ||
		!isRecord(value.anchor)
	)
		return false;
	const a = value.anchor;
	const lines = (v: unknown, max: number) =>
		Array.isArray(v) &&
		v.length <= max &&
		v.every((l) => typeof l === 'string' && l.length <= 4000);
	return (
		typeof a.scopeId === 'string' &&
		/^[a-f0-9]{16}$/.test(a.scopeId) &&
		typeof a.path === 'string' &&
		a.path.length > 0 &&
		!a.path.startsWith('/') &&
		!a.path.split('/').includes('..') &&
		(a.side === 'old' || a.side === 'new') &&
		typeof a.blob === 'string' &&
		/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(a.blob) &&
		Number.isSafeInteger(a.start) &&
		Number.isSafeInteger(a.end) &&
		Number(a.start) > 0 &&
		Number(a.end) >= Number(a.start) &&
		lines(a.quote, 100) &&
		Array.isArray(a.quote) &&
		a.quote.length === Number(a.end) - Number(a.start) + 1 &&
		lines(a.before, 2) &&
		lines(a.after, 2) &&
		typeof a.contextHash === 'string' &&
		/^[a-f0-9]{64}$/.test(a.contextHash) &&
		(a.symbolPath === null || typeof a.symbolPath === 'string')
	);
}

export type EditorCommentInput = {
	fileId: string;
	version: string;
	start: number;
	end: number;
	text: string;
	/** spec/appearance#evolution-redesign */ excerpt?: string;
};
export function isEditorCommentInput(value: unknown): value is EditorCommentInput {
	return (
		isRecord(value) &&
		isCommentInput({ ...value, side: 'new' }) &&
		typeof value.version === 'string' &&
		/^[a-f0-9]{64}$/.test(value.version)
	);
}

export function isReviewNote(v: unknown): v is ReviewNote {
	return (
		isRecord(v) &&
		validResolved(v) &&
		typeof v.id === 'string' &&
		/^[a-f0-9-]{36}$/.test(v.id) &&
		Number.isSafeInteger(v.version) &&
		Number(v.version) > 0 &&
		isCommentText(v.text) &&
		typeof v.at === 'string' &&
		Number.isFinite(Date.parse(v.at))
	);
}

function validResolved(value: Record<string, unknown>) {
	return (
		value.resolvedVersion === undefined ||
		(Number.isSafeInteger(value.resolvedVersion) &&
			Number(value.resolvedVersion) > 0 &&
			Number(value.resolvedVersion) <= Number(value.version))
	);
}

export type ReviewSelection = { id: string; version: number }[];
export function isReviewSelection(value: unknown): value is ReviewSelection {
	return (
		Array.isArray(value) &&
		value.length <= 500 &&
		value.every(
			(item) =>
				isRecord(item) &&
				typeof item.id === 'string' &&
				/^[a-f0-9-]{36}$/.test(item.id) &&
				Number.isSafeInteger(item.version) &&
				Number(item.version) > 0
		) &&
		new Set(value.map((item) => item.id)).size === value.length
	);
}
