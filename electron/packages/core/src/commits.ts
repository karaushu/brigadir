import type { ChangedFile, Scope } from './changes';
import type { TaskKey } from './session';
import { isRecord } from './workspace';
import { fitsUtf8 } from './utf8';
export type CommitFile = {
	path: string;
	oldPath: string;
	status: string;
	beforeTask: boolean;
	diff: ChangedFile | null;
};
export type CommitScope = { scope: Scope; head: string | null; tree: string; files: CommitFile[] };
export type CommitPreview = { revision: string; scopes: CommitScope[] };
export type CommitResult = {
	committed: { scopeId: string; name: string; sha: string }[];
	error: string | null;
};
/** spec/git#commit-dialog: one commit of the commit dialog — a basket of whole files of one repo and its message. */
export type CommitBasketPlan = { id: string; scopeId: string; message: string; files: string[] };
export type CommitBasketState = 'waiting' | 'running' | 'done' | 'skipped' | 'failed';
/** A step of the basket sequence as main reports it (`commits:progress`); `output` — the hook's or git's text. */
export type CommitProgress = {
	key: TaskKey;
	basketId: string;
	state: CommitBasketState;
	sha?: string | undefined;
	output?: string | undefined;
};
export type CommitBasketsResult = CommitResult & {
	baskets: {
		id: string;
		state: CommitBasketState;
		sha?: string | undefined;
		output?: string | undefined;
	}[];
};
/** spec/git#commit-dialog: the agent's split — baskets with a message and a short reason, by repo. */
export type CommitSplitProposal = {
	scopeId: string;
	message: string;
	reason: string;
	files: string[];
}[];
export function isCommitBasketId(value: unknown): value is string {
	return typeof value === 'string' && /^[a-z0-9-]{1,40}$/.test(value);
}
export function isCommitScopeId(value: unknown): value is string {
	return typeof value === 'string' && /^[a-f0-9]{16}$/.test(value);
}
export function isCommitPath(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		value.length <= 4096 &&
		!value.includes('\0') &&
		!value.startsWith('/') &&
		!value.split('/').includes('..')
	);
}
export function isCommitPaths(value: unknown): value is string[] {
	return (
		Array.isArray(value) &&
		value.length > 0 &&
		value.length <= 10000 &&
		value.every(isCommitPath) &&
		new Set(value).size === value.length
	);
}
/** The plan the renderer sends: at most 64 baskets of 10 000 files, a message of 16 000 bytes at most. */
export function isCommitBasketPlans(value: unknown): value is CommitBasketPlan[] {
	return (
		Array.isArray(value) &&
		value.length > 0 &&
		value.length <= 64 &&
		new Set(value.map((item) => (isRecord(item) ? item.id : null))).size === value.length &&
		value.every(
			(item) =>
				isRecord(item) &&
				isCommitBasketId(item.id) &&
				isCommitScopeId(item.scopeId) &&
				typeof item.message === 'string' &&
				item.message.trim().length > 0 &&
				!item.message.includes('\0') &&
				fitsUtf8(item.message, 16000) &&
				isCommitPaths(item.files)
		)
	);
}
