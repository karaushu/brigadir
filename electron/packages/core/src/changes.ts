import type { SyntaxSnapshot } from './syntax';
import type { ScopeKind } from './launch';
import type { DiffBase } from './settings';
/** `source`: the repo of a released worktree (spec/tasks#released-worktree) that still holds this scope's snapshot objects; read-only, the scope itself stays unavailable. */
export type Scope = {
	available?: boolean;
	source?: string;
	id: string;
	path: string;
	name: string;
	kind: ScopeKind;
	branch: string | null;
	remote?: string | null;
	selected: boolean;
};
export type SnapshotTree = { scopeId: string; tree: string; commit: string; ref: string };
export type Checkpoint = {
	id: number;
	at: string;
	reason:
		| 'baseline'
		| 'turn'
		| 'tools'
		| 'refresh'
		| 'user-before'
		| 'user-after'
		| 'quick-before'
		| 'quick-after';
	trees: SnapshotTree[];
};
export type SnapshotDocument = { schemaVersion: 1; scopes: Scope[]; checkpoints: Checkpoint[] };
export type ChangedFile = {
	id: string;
	scopeId: string;
	path: string;
	oldPath: string;
	status: string;
	beforeMode: string;
	afterMode: string;
	before: string | null;
	after: string | null;
	additions: number;
	deletions: number;
	binary: boolean;
	generated: boolean;
	gitlink: boolean;
};
/** `heads` is present when the base is each repo's HEAD (spec/diff-and-review#diff-base): scope id → commit, null before the first commit. */
export type ChangesSnapshot = {
	scopes: Scope[];
	files: ChangedFile[];
	checkpoint: number | null;
	issue: string | null;
	heads?: Record<string, string | null>;
};
export type DiffLine = {
	kind: 'context' | 'added' | 'removed';
	text: string;
	oldLine: number | null;
	newLine: number | null;
	ending?: 'none' | 'crlf';
	/** Word changes of a paired line, one number per token: its end offset in `text` × 2, plus 1 when it changed. No text copies. */
	spans?: number[];
};
export type DiffPair = { old: DiffLine | null; new: DiffLine | null };
export type FileDiff = {
	baseLabel?: string;
	/** spec/diff-and-review#diff-base: the base is this HEAD commit (null: no commit yet); comments stay allowed. */ head?:
		string | null;
	/** The right side is read as is: History labels it with its commit (spec/git#merge). */ afterLabel?: string;
	beforeSyntax?: SyntaxSnapshot;
	afterSyntax?: SyntaxSnapshot;
	file: ChangedFile;
	beforeText: string;
	afterText: string;
	lines: DiffLine[];
	pairs: DiffPair[];
	binary: boolean;
	tooLarge: boolean;
	/** spec/pull-requests-and-ci#pr-definition: a PR head file the PR did not change, opened by a definition jump — every line is context, read only. */
	unchanged?: boolean;
};

/** spec/editor#change-marks: one change run of the editor buffer against the base. `count` 0 is a deletion below line `start`;
 *  `oldStart` numbers the first removed line in the base (the base line above, when nothing was removed). */
export type GutterHunk = {
	start: number;
	count: number;
	oldStart: number;
	removed: string[];
	removedCount: number;
};
/** The editor gutter of one open file: its hunks against the base setting, or why it has none. */
export type EditorGutter =
	| {
			state: 'ready';
			base: DiffBase;
			head?: string | null;
			hunks: GutterHunk[];
			target: { scopeId: string; path: string };
	  }
	| { state: 'none' | 'too-large' };
export type ChangeRange = { base: number; current: number };
/** spec/crew#parts: the checkpoint a task's changes count from — its `changeBase` when the document holds it, else the first. */
export function changeBaseOf(
	doc: Pick<SnapshotDocument, 'checkpoints'> | null | undefined,
	base: number | undefined
): number {
	return doc &&
		base !== undefined &&
		Number.isSafeInteger(base) &&
		base >= 0 &&
		base < doc.checkpoints.length
		? base
		: 0;
}
/** A repo's base tree from checkpoint `from`: its tree there, else its first appearance after (a repo found later starts at its own baseline). */
export function baseTree(
	doc: Pick<SnapshotDocument, 'checkpoints'>,
	scopeId: string,
	from = 0
): SnapshotTree | undefined {
	return doc.checkpoints
		.slice(from)
		.find((point) => point.trees.some((tree) => tree.scopeId === scopeId))
		?.trees.find((tree) => tree.scopeId === scopeId);
}
/** What a change read compares: a snapshot range, or HEAD of each repo against the latest snapshot (spec/diff-and-review#diff-base). */
export type ChangeView = ChangeRange | 'head';
export type TimelineEntry = Pick<Checkpoint, 'id' | 'at' | 'reason'>;
export type Attribution = {
	entries: {
		checkpoint: number;
		at: string;
		author: 'user' | 'agent' | 'unknown';
		turn: number | null;
		turnNumber?: number;
		prompt: string | null;
		excerpt?: string;
		/** spec/composer-steering-queue-and-ghost#quick-question: a quick question's edit; `prompt` is its question. */ quick?: true;
		precision: 'file' | 'lines';
	}[];
	truncated: boolean;
};
