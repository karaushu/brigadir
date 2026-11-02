/**
 * spec/remote-access-and-mobile#phone-task-tools: what the phone's tools compute from the machine's data, without a window — the diff's hunks, the code view's
 * change bars, the PR's checks line and why it cannot be merged yet. The screens draw these; vitest keeps them.
 */
import {
	canArchive,
	checksState,
	isOpenPR,
	mergeBlock,
	type ChangedFile,
	type DiffLine,
	type FileContent,
	type PRCheckRun,
	type PullRequestDetail,
	type CIState,
	type AgentTask,
} from '@brigadir/core';
import type { Row } from '../../renderer/diff-rows';

export const markdownFile = (name: string) => /\.(md|markdown|mdx)$/i.test(name);
/**
 * How the phone shows a file (spec/remote-access-and-mobile#phone-task-tools): Markdown as its preview, text as code with the machine's colours. A large file
 * (`large`: over 5 MB or 50 000 lines) is plain code, as the computer's Plain text mode — no preview rendered at once and its
 * text is not sent back to the machine for colours (security review, spec/remote-access-and-mobile#phone-task-tools).
 */
export function fileView(name: string, content: Pick<FileContent, 'state' | 'large'> | null) {
	const plain = Boolean(content?.large);
	return { preview: markdownFile(name) && !plain, syntax: content?.state === 'text' && !plain };
}
/** `M`, `A`, `D`, `R`, `C`, `T`: the first letter of git's raw status (`R100`, `C75` carry a score). */
export const fileMark = (file: Pick<ChangedFile, 'status'>) => file.status.slice(0, 1) || 'M';
export const fileName = (path: string) => path.slice(path.lastIndexOf('/') + 1);
export const fileFolder = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')));

export type Hunk = { id: string; header: string; lines: DiffLine[] };
/**
 * The diff as hunks: the computer's `diffRows` in unified mode folds each run of context past three lines; every visible
 * stretch between folds is one hunk with git's header `@@ −a,b +c,d @@`.
 */
export function diffHunks(rows: readonly Row[]): Hunk[] {
	const hunks: Hunk[] = [];
	let lines: DiffLine[] = [];
	const close = () => {
		if (!lines.length) return;
		const old = lines.filter((line) => line.oldLine !== null),
			next = lines.filter((line) => line.newLine !== null);
		const range = (list: DiffLine[], side: 'oldLine' | 'newLine') =>
			`${list[0]?.[side] ?? 0},${list.length}`;
		hunks.push({
			id: `h${hunks.length}`,
			header: `@@ −${range(old, 'oldLine')} +${range(next, 'newLine')} @@`,
			lines,
		});
		lines = [];
	};
	for (const row of rows) {
		if (row.hidden) close();
		else if (row.line) lines.push(row.line);
	}
	close();
	return hunks;
}

export type ChangeBar = 'added' | 'modified';
/**
 * spec/editor#change-marks on the phone: the gutter's bars of a file from its diff — a new line next to removed ones is modified, a new line
 * on its own is added. Keys are the file's line numbers now.
 */
export function changeBars(lines: readonly DiffLine[]): Map<number, ChangeBar> {
	const bars = new Map<number, ChangeBar>();
	let run: DiffLine[] = [];
	const flush = () => {
		const removed = run.some((line) => line.kind === 'removed');
		for (const line of run)
			if (line.kind === 'added' && line.newLine !== null)
				bars.set(line.newLine, removed ? 'modified' : 'added');
		run = [];
	};
	for (const line of lines) {
		if (line.kind === 'context') flush();
		else run.push(line);
	}
	flush();
	return bars;
}

/** A check's state in the CI glyphs of the computer (`ui/RunSteps`). */
export const checkState = (check: Pick<PRCheckRun, 'state'>): CIState =>
	check.state === 'pass'
		? 'pass'
		: check.state === 'fail'
			? 'fail'
			: check.state === 'pending'
				? 'running'
				: check.state === 'cancel'
					? 'cancelled'
					: 'skipped';
/**
 * The glyph of the PR card's checks line: the same `CIGlyph` as a check's row in the list — a failure is × in a
 * circle in both, not a separate «!».
 */
export const checksGlyph = (state: ChecksLine['state']): CIState =>
	state === 'pass'
		? 'pass'
		: state === 'fail'
			? 'fail'
			: state === 'pending'
				? 'running'
				: 'skipped';
export type ChecksLine = {
	passed: number;
	total: number;
	state: ReturnType<typeof checksState>;
	/** The check the line names: the first failed, else the first running. */
	named: PRCheckRun | null;
};
export function checksLine(checks: readonly PRCheckRun[]): ChecksLine {
	const state = checksState(checks);
	return {
		passed: checks.filter((check) => check.state === 'pass' || check.state === 'skipping').length,
		total: checks.length,
		state,
		named:
			checks.find((check) => check.state === 'fail') ??
			checks.find((check) => check.state === 'pending') ??
			null,
	};
}

/**
 * What the overview's line says about the merge: `ready`; `checks-failed`; waiting for checks
 * still running and/or for approvals; or the reason `mergeBlock` gives (spec/pull-requests-and-ci#merge-card).
 */
export type MergeLine =
	| { kind: 'ready' }
	| { kind: 'merged' }
	| { kind: 'waiting'; checks: boolean; approvals: number }
	| { kind: 'block'; block: Exclude<ReturnType<typeof mergeBlock>, null> };
export function mergeLine(detail: PullRequestDetail): MergeLine {
	if (detail.summary.state === 'MERGED') return { kind: 'merged' };
	const block = mergeBlock(detail);
	if (block === null) return { kind: 'ready' };
	if (!isOpenPR(detail.summary) || block === 'draft' || block === 'permission')
		return { kind: 'block', block };
	if (block === 'conflicts' || block === 'checks') return { kind: 'block', block };
	const running = checksState(detail.checks) === 'pending',
		review = detail.summary.reviewDecision;
	const approvals =
		review === 'REVIEW_REQUIRED' || review === 'CHANGES_REQUESTED'
			? Math.max(
					1,
					(detail.requiredApprovals ?? 1) -
						detail.summary.reviewers.filter((reviewer) => reviewer.state === 'APPROVED').length
				)
			: 0;
	if (running || approvals) return { kind: 'waiting', checks: running, approvals };
	return { kind: 'block', block };
}

/**
 * Complete task in the task's menu: the rule of the card's swipe and the computer (spec/tasks#archive-actions) — not while an agent
 * works in the task or under it, or the turn still runs (`busy`, the session's own state ahead of the workspace).
 */
export function completeInMenu(
	task: AgentTask,
	tasks: readonly AgentTask[],
	busy: boolean
): boolean {
	return !busy && task.status !== 'completed' && canArchive(task, tasks);
}
