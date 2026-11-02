import type { ChangesSnapshot, ChangedFile, Scope } from './changes';
import type { ReviewSnapshot } from './review';
export type ReviewFile = {
	id: string;
	scopeId: string;
	path: string;
	comments: ReviewSnapshot['comments'];
	change: ChangedFile | null;
};
export type ReviewScope = { id: string; scope: Scope | null; files: ReviewFile[] };
/** One source for popup rows and footer totals; scope order follows Changes. */
export function reviewFiles(review: ReviewSnapshot, changes: ChangesSnapshot | null) {
	const byPath = new Map<string, ChangedFile>();
	for (const file of changes?.files ?? []) byPath.set(`${file.scopeId}/${file.oldPath}`, file);
	for (const file of changes?.files ?? []) byPath.set(`${file.scopeId}/${file.path}`, file);
	const scopes = new Map<string, ReviewScope>(
		(changes?.scopes ?? []).map((scope) => [scope.id, { id: scope.id, scope, files: [] }])
	);
	const files = new Map<string, ReviewFile>();
	for (const comment of review.comments) {
		const { scopeId } = comment.anchor,
			change = byPath.get(`${scopeId}/${comment.anchor.path}`) ?? null,
			path = change?.path ?? comment.anchor.path,
			id = `${scopeId}/${path}`;
		let group = scopes.get(scopeId);
		if (!group) {
			group = { id: scopeId, scope: null, files: [] };
			scopes.set(scopeId, group);
		}
		let file = files.get(id);
		if (!file) {
			file = { id, scopeId, path, comments: [], change };
			files.set(id, file);
			group.files.push(file);
		}
		file.comments.push(comment);
	}
	return {
		groups: [...scopes.values()].filter((group) => group.files.length),
		fileCount: files.size,
		count: review.comments.length + (review.notes?.length ?? 0),
		pending: [...review.comments, ...(review.notes ?? [])].filter((comment) => !comment.sent)
			.length,
	};
}
