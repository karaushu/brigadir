import type { PRFile } from '@brigadir/core';

/**
 * spec/pull-requests-and-ci#pr-files: «Viewed» flips at the click, before GitHub answers. A file with a request in flight shows the mark the person
 * set (`viewed`); after `savingAfter` ms it also shows that it is saving. A reply that is not the latest for its file changes
 * nothing; a failed latest reply returns the mark GitHub has and names the file in an error.
 */
export type ViewedRequest = { viewed: boolean; saving: boolean; seq: number };
export type ViewedPending = Readonly<Record<string, ViewedRequest>>;
export type ViewedError = { path: string; viewed: boolean; message: string };
export const savingAfter = 400;

/** The files as the panel shows them: GitHub's marks with the person's requests in flight on top. */
export function shownFiles(files: readonly PRFile[], pending: ViewedPending): PRFile[] {
	return files.map((file) => {
		const request = pending[file.path];
		return request && request.viewed !== file.viewed ? { ...file, viewed: request.viewed } : file;
	});
}
/** `{n} of {total} viewed` counts the shown marks, so the caption moves with the click. */
export function viewedCount(files: readonly PRFile[], pending: ViewedPending) {
	return shownFiles(files, pending).filter((file) => file.viewed).length;
}
export const isSaving = (pending: ViewedPending) =>
	Object.values(pending).some((request) => request.saving);

function without(pending: ViewedPending, path: string): ViewedPending {
	const next = { ...pending };
	delete next[path];
	return next;
}
/** A click: the request becomes the file's latest; an error about this file goes away. */
export function requested(
	state: { viewing: ViewedPending; viewedError: ViewedError | null },
	path: string,
	viewed: boolean,
	seq: number
) {
	return {
		viewing: { ...state.viewing, [path]: { viewed, saving: false, seq } },
		viewedError: state.viewedError?.path === path ? null : state.viewedError,
	};
}
/** The slow request starts to show that it is saving; a newer click already replaced it, so nothing changes. */
export function slow(state: { viewing: ViewedPending }, path: string, seq: number) {
	const request = state.viewing[path];
	return request?.seq === seq
		? { viewing: { ...state.viewing, [path]: { ...request, saving: true } } }
		: {};
}
/** GitHub saved the mark: the PR files keep it; the request leaves only if it is still the latest for the file. */
export function saved(
	state: { viewing: ViewedPending; files: readonly PRFile[] },
	path: string,
	viewed: boolean,
	seq: number
) {
	return {
		files: state.files.map((file) => (file.path === path ? { ...file, viewed } : file)),
		viewing: state.viewing[path]?.seq === seq ? without(state.viewing, path) : state.viewing,
	};
}
/** GitHub did not save the mark: the latest request rolls back to GitHub's mark and the panel names the file. */
export function failed(
	state: { viewing: ViewedPending },
	path: string,
	viewed: boolean,
	seq: number,
	message: string
) {
	return state.viewing[path]?.seq === seq
		? { viewing: without(state.viewing, path), viewedError: { path, viewed, message } }
		: {};
}
