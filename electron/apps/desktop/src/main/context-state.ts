import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import {
	contextClosed,
	editorStateAnswer,
	prStateAnswer,
	type ContextOptions,
	type ContextReport,
	type ContextRepo,
	type ContextTool,
	type DiffBase,
	type PRReviewDraft,
	type PullRequestDetail,
	type TaskKey,
} from '@brigadir/core';
import { readSnapshots } from '@brigadir/git';
import { SessionStore } from '@brigadir/persistence';

type Pending = {
	resolve(value: ContextReport | null | 'closed'): void;
	reject(error: Error): void;
	timer: ReturnType<typeof setTimeout>;
};
export type ContextDeps = {
	dataDir: string | undefined;
	/** Sends `context:request` to the window; false when there is no window to ask. */
	send(request: { id: string; key: TaskKey }): boolean;
	/** The task is the one shown and the window is on screen. */
	visible(key: TaskKey): boolean;
	diffBase(): DiffBase;
	pullRequest(
		key: TaskKey,
		scopeId: string,
		number: number
	): Promise<{ detail: PullRequestDetail; review: PRReviewDraft; viewer?: string | null }>;
	timeoutMs?: number;
};
/**
 * spec/agents-and-providers#context-tools: `editor_state` and `pr_state` of a task. The window reports the task's tabs, cursor, selections and the open
 * PR (`context:request` → `answerContextRequest`); this adds the repo paths, the diff base and the PR with its drafts.
 */
export class ContextState {
	private pending = new Map<string, Pending>();
	constructor(private readonly deps: ContextDeps) {}
	async answer(key: TaskKey, tool: ContextTool): Promise<unknown> {
		const id = randomUUID();
		const report = new Promise<ContextReport | null | 'closed'>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error('The task window did not answer.'));
			}, this.deps.timeoutMs ?? 3000);
			this.pending.set(id, { resolve, reject, timer });
		});
		if (!this.deps.send({ id, key })) {
			const entry = this.pending.get(id);
			if (entry) {
				clearTimeout(entry.timer);
				this.pending.delete(id);
			}
			return contextClosed(tool);
		}
		const value = await report;
		if (value === 'closed') return contextClosed(tool);
		const options = await this.options(key);
		if (tool === 'editor') return editorStateAnswer(value, options);
		const pr = value?.pr;
		if (!pr) return prStateAnswer(value, null, null, options);
		try {
			const { detail, review, viewer } = await this.deps.pullRequest(key, pr.scopeId, pr.number);
			return prStateAnswer(value, detail, review, options, undefined, viewer ?? null);
		} catch (error) {
			return prStateAnswer(
				value,
				null,
				null,
				options,
				error instanceof Error ? error.message : String(error)
			);
		}
	}
	/** The renderer's answer; an unknown or late id is dropped. */
	settle(id: string, report: ContextReport | null) {
		const entry = this.pending.get(id);
		if (!entry) return false;
		this.pending.delete(id);
		clearTimeout(entry.timer);
		entry.resolve(report);
		return true;
	}
	/** The window went away: every waiting call answers as if it were closed. */
	closeAll() {
		for (const [id, entry] of this.pending) {
			this.pending.delete(id);
			clearTimeout(entry.timer);
			entry.resolve('closed');
		}
	}
	private async options(key: TaskKey): Promise<ContextOptions> {
		const repos = new Map<string, ContextRepo>();
		try {
			const store = await SessionStore.at(this.deps.dataDir),
				root = await store
					.workspace(key)
					.then(
						({ path }) => realpath(path),
						() => null
					)
					.catch(() => null),
				doc = await readSnapshots(store, key);
			for (const scope of doc?.scopes ?? []) {
				const path = root ? relative(root, scope.path) : '';
				repos.set(scope.id, {
					name: scope.name,
					path: path.startsWith('..') || isAbsolute(path) ? scope.path : path,
				});
			}
		} catch {
			/* No snapshots yet: paths stay relative to their repo. */
		}
		return {
			visible: this.deps.visible(key),
			diffBase: this.deps.diffBase(),
			repo: (scopeId) => repos.get(scopeId) ?? null,
			repos: [...repos.values()],
		};
	}
}
