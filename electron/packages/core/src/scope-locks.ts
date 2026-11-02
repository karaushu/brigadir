import type { TaskKey } from './session';
export type LockHolder = { key: TaskKey; title: string; acquiredAt: string };
export type ScopeLockView = {
	name: string;
	path: string;
	owners: LockHolder[];
	contended: boolean;
};
export type LaunchConflict = {
	id: string;
	key: TaskKey;
	scopes: ScopeLockView[];
	canIsolate: boolean;
};
export type LaunchConflictChoice = 'worktree' | 'queue' | 'override' | 'cancel';
export const isLaunchConflictChoice = (value: unknown): value is LaunchConflictChoice =>
	['worktree', 'queue', 'override', 'cancel'].includes(String(value));
