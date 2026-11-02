import { afterEach, expect, it, vi } from 'vitest';
import type { PRFile, PullRequestDetail } from '@brigadir/core';
import {
	shownFiles,
	viewedCount,
	isSaving,
	requested,
	slow,
	saved,
	failed,
	type ViewedPending,
} from './pr-viewed';

const file = (path: string, viewed: boolean): PRFile => ({
	path,
	additions: 1,
	deletions: 0,
	change: 'MODIFIED',
	viewed,
});
const files = [file('a.ts', true), file('b.ts', false), file('c.ts', false)];
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

it('shows the person’s marks over GitHub’s, and counts them (spec/pull-requests-and-ci#pr-files)', () => {
	const pending: ViewedPending = {
		'b.ts': { viewed: true, saving: false, seq: 1 },
		'a.ts': { viewed: false, saving: true, seq: 2 },
	};
	expect(shownFiles(files, pending).map((item) => item.viewed)).toEqual([false, true, false]);
	expect(viewedCount(files, {})).toBe(1);
	expect(viewedCount(files, pending)).toBe(1);
	expect(viewedCount(files, { 'c.ts': { viewed: true, saving: false, seq: 3 } })).toBe(2);
	expect(isSaving(pending)).toBe(true);
	expect(isSaving({ 'b.ts': { viewed: true, saving: false, seq: 1 } })).toBe(false);
	// A request equal to GitHub's mark keeps the same file object.
	expect(shownFiles(files, { 'a.ts': { viewed: true, saving: false, seq: 1 } })[0]).toBe(files[0]);
});

it('moves a request from click to saved or failed; an older reply for the same file changes nothing (spec/pull-requests-and-ci#pr-files)', () => {
	let state = {
		viewing: {} as ViewedPending,
		viewedError: { path: 'b.ts', viewed: true, message: 'old' } as {
			path: string;
			viewed: boolean;
			message: string;
		} | null,
		files: files as PRFile[],
	};
	state = { ...state, ...requested(state, 'b.ts', true, 1) };
	expect(state.viewing['b.ts']).toEqual({ viewed: true, saving: false, seq: 1 });
	expect(state.viewedError).toBeNull();
	state = { ...state, ...slow(state, 'b.ts', 1) };
	expect(state.viewing['b.ts']?.saving).toBe(true);
	// A second click on the same file replaces the request; the first reply then only keeps GitHub's mark in the files.
	state = { ...state, ...requested(state, 'b.ts', false, 2) };
	expect(slow(state, 'b.ts', 1)).toEqual({});
	state = { ...state, ...saved(state, 'b.ts', true, 1) };
	expect(state.viewing['b.ts']?.seq).toBe(2);
	expect(state.files[1]!.viewed).toBe(true);
	expect(failed(state, 'b.ts', true, 1, 'late')).toEqual({});
	state = { ...state, ...failed(state, 'b.ts', false, 2, 'GitHub is down') };
	expect(state.viewing).toEqual({});
	expect(state.viewedError).toEqual({ path: 'b.ts', viewed: false, message: 'GitHub is down' });
	expect(shownFiles(state.files, state.viewing)[1]!.viewed).toBe(true);
	// An error about another file stays when this file is clicked.
	expect(requested(state, 'c.ts', true, 3).viewedError).toEqual(state.viewedError);
});

it('the store flips at once, shows saving after 400 ms, keeps the PR on success and rolls back a failure (spec/pull-requests-and-ci#pr-files)', async () => {
	vi.useFakeTimers();
	let answer: { resolve(): void; reject(error: Error): void } | null = null;
	const mark = vi.fn(
		() =>
			new Promise<void>((resolve, reject) => {
				answer = { resolve, reject };
			})
	);
	vi.stubGlobal('window', {
		brigadir: { markPullRequestFileViewed: mark, readPullRequestDetail: vi.fn() },
		addEventListener() {},
		removeEventListener() {},
	});
	const { markViewed, prReviewStore } = await import('./pr-review');
	const task = { projectId: 'p', id: 't' },
		ref = { scopeId: 's', number: 7 },
		store = prReviewStore(task, ref);
	store.setState({ detail: { files } as unknown as PullRequestDetail });
	const done = markViewed(task, ref, 'b.ts', true);
	expect(store.getState().viewing['b.ts']).toEqual({ viewed: true, saving: false, seq: 1 });
	expect(store.getState().busy).toBe(false);
	vi.advanceTimersByTime(399);
	expect(store.getState().viewing['b.ts']?.saving).toBe(false);
	vi.advanceTimersByTime(1);
	expect(store.getState().viewing['b.ts']?.saving).toBe(true);
	answer!.resolve();
	expect(await done).toBe(true);
	expect(store.getState().viewing).toEqual({});
	expect(store.getState().detail!.files[1]!.viewed).toBe(true);
	expect(mark).toHaveBeenCalledWith(task, ref, 'b.ts', true);
	const undo = markViewed(task, ref, 'a.ts', false);
	expect(viewedCount(store.getState().detail!.files, store.getState().viewing)).toBe(1);
	answer!.reject(new Error("Error invoking remote method 'prs:viewed': Error: GitHub is down"));
	expect(await undo).toBe(false);
	expect(store.getState().viewing).toEqual({});
	expect(store.getState().viewedError).toEqual({
		path: 'a.ts',
		viewed: false,
		message: 'GitHub is down',
	});
	expect(viewedCount(store.getState().detail!.files, store.getState().viewing)).toBe(2);
});
