import { isRecord } from './workspace';
import type { Scope } from './changes';
import type { LockHolder } from './scope-locks';
/** spec/projects-and-board#repo-selection: one choice instead of two checkboxes, so an update carries only it. */
export type ScopeUpdate = { id: string; selected: boolean };
export function isScopeUpdate(value: unknown): value is ScopeUpdate {
	return (
		isRecord(value) &&
		typeof value.id === 'string' &&
		/^[a-f0-9]{16}$/.test(value.id) &&
		typeof value.selected === 'boolean'
	);
}
export type ScopePanelSnapshot = {
	collapsed: boolean;
	canChangeRepos: boolean;
	scopes: (Scope & {
		owners: LockHolder[];
		additions: number;
		deletions: number;
		firstFile: string | null;
		/** spec/git#pull: commits ahead of and behind the upstream as of the last fetch; null — no upstream, it is gone, or the repo is a task's worktree. */ upstream?: UpstreamCounts | null;
	})[];
};
export type UpstreamCounts = { ahead: number; behind: number };
