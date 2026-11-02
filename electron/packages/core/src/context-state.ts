import { isRecord } from './workspace';
import type { DiffBase } from './settings';
import type { PRDraft, PRReviewDraft, PullRequestDetail } from './pull-requests';
import { toolTabKinds, type ToolTabKind } from './document-tabs';
/**
 * spec/agents-and-providers#context-tools: what the person is looking at, for the agent of the same task (`editor_state`, `pr_state`). The renderer
 * reports the task's documents, cursor, selections and the open PR (`ContextReport`); main checks the shape, adds what
 * only it knows (repo paths, the diff base, the PR from GitHub and its drafts) and answers the agent with JSON.
 */
export type ContextTool = 'editor' | 'pr';
export const isContextTool = (value: unknown): value is ContextTool =>
	value === 'editor' || value === 'pr';
/** One line and column, both from 1. */
export type ContextPosition = { line: number; column: number };
export type ContextLines = { start: number; end: number };
/** Text the person selected, clipped at `contextTextLimit`; `length` is the full length when it was clipped. */
export type ContextText = { text: string; truncated?: true; length?: number };
export const contextTextLimit = 20_000;
export const contextCommentLimit = 4_000;
export const contextThreadLimit = 200;
export function clipText(text: string, limit = contextTextLimit): ContextText {
	return text.length > limit
		? { text: text.slice(0, limit), truncated: true, length: text.length }
		: { text };
}
export type ContextDiffSource = 'changes' | 'history' | 'commit' | 'pr';
type ContextPRRef = { scopeId: string; number: number };
/** spec/agents-and-providers#editor-state: `group` — the editor group (from 1, in tree order) whose strip holds the tab, when there are several. */
export type ContextReportTab = { active: boolean; group?: number } & (
	| { kind: 'file'; path: string; dirty: boolean }
	| {
			kind: 'diff';
			scopeId: string;
			path: string;
			source: ContextDiffSource;
			pr?: ContextPRRef;
	  }
	| { kind: 'pr-overview'; scopeId: string; number: number }
	| { kind: ToolTabKind; title: string }
);
export type ContextReportEditor = {
	path: string;
	view: 'editor' | 'markdown-preview' | 'markdown-side';
	lineCount: number;
	dirty: boolean;
	readOnly: boolean;
	cursor: ContextPosition;
	/** spec/agents-and-providers#editor-state: every caret, when there are several. */
	cursors?: ContextPosition[];
	/** All the selections share one `contextTextLimit` of text (spec/agents-and-providers#editor-state). */
	selections: (ContextText & { from: ContextPosition; to: ContextPosition })[];
	visibleLines: ContextLines | null;
};
export type ContextReportDiff = {
	scopeId: string;
	path: string;
	oldPath: string;
	status: string;
	source: ContextDiffSource;
	baseLabel: string | null;
	afterLabel: string | null;
	range: { base: number; current: number } | null;
	layout: 'unified' | 'split';
	preview: boolean;
	/** `changed` — the selected lines that are changes on that side: removed on `old`, added on `new` (spec/agents-and-providers#editor-state). */
	selection:
		| (ContextText & { side: 'old' | 'new'; start: number; end: number; changed?: ContextLines[] })
		| null;
	visibleLines: { old: ContextLines | null; new: ContextLines | null } | null;
	pr: ContextPRRef | null;
};
/** spec/agents-and-providers#editor-state: the document each editor group shows; `tab` — its index in `tabs`. */
export type ContextReportGroup = {
	group: number;
	focused: boolean;
	tab: number | null;
	editor: ContextReportEditor | null;
	diff: ContextReportDiff | null;
};
export type ContextReport = {
	/** The task's view is mounted in the window (the task is the one shown). */
	visible: boolean;
	/** The documents area is on screen: three columns with a tab, or the editor side of the two-column toggle. */
	documentsShown: boolean;
	tabs: ContextReportTab[];
	/** The focused group's document. */
	editor: ContextReportEditor | null;
	diff: ContextReportDiff | null;
	/** spec/agents-and-providers#editor-state: present with more than one editor group. */
	groups?: ContextReportGroup[];
	panel: {
		shown: boolean;
		tab: 'changes' | 'files' | 'prs';
		changesView: 'diff' | 'history' | 'turns';
	};
	/** The PR of the panel; `panel: false` — none is open there, this is the PR of the active tab (spec/agents-and-providers#editor-state). */
	pr: (ContextPRRef & { tab: 'comments' | 'files' | 'commits' | 'checks'; panel?: false }) | null;
};

const int = (value: unknown, min = 0) => Number.isSafeInteger(value) && Number(value) >= min;
const str = (value: unknown, max = 8192) => typeof value === 'string' && value.length <= max;
const oneOf = <T extends string>(value: unknown, options: readonly T[]): value is T =>
	typeof value === 'string' && (options as readonly string[]).includes(value);
const isPosition = (value: unknown) =>
	isRecord(value) && int(value.line, 1) && int(value.column, 1);
const isLines = (value: unknown) =>
	isRecord(value) &&
	int(value.start, 1) &&
	int(value.end, 1) &&
	Number(value.start) <= Number(value.end);
// spec/agents-and-providers#editor-state: a selection clipped by the limit the selections share may be shorter than the limit itself.
const isText = (value: Record<string, unknown>) =>
	str(value.text, contextTextLimit) &&
	(value.truncated === undefined ||
		(value.truncated === true &&
			int(value.length, 1) &&
			Number(value.length) > String(value.text).length));
const sources = ['changes', 'history', 'commit', 'pr'] as const;
const isRef = (value: unknown) =>
	isRecord(value) && str(value.scopeId, 512) && int(value.number, 1);
const isGroup = (value: unknown) => value === undefined || int(value, 1);
function isTab(value: unknown) {
	if (!isRecord(value) || typeof value.active !== 'boolean' || !isGroup(value.group)) return false;
	if (value.kind === 'pr-overview') return isRef(value);
	if (oneOf(value.kind, toolTabKinds)) return str(value.title, 1024);
	if (!str(value.path, 4096)) return false;
	return value.kind === 'file'
		? typeof value.dirty === 'boolean'
		: value.kind === 'diff' &&
				str(value.scopeId, 512) &&
				oneOf(value.source, sources) &&
				(value.pr === undefined || isRef(value.pr));
}
/** spec/agents-and-providers#editor-state: the selections of one editor share the text limit. */
const textTotal = (items: unknown[]) =>
	items.reduce<number>(
		(sum, item) => sum + (isRecord(item) && typeof item.text === 'string' ? item.text.length : 0),
		0
	);
function isEditor(value: unknown) {
	return (
		isRecord(value) &&
		str(value.path, 4096) &&
		oneOf(value.view, ['editor', 'markdown-preview', 'markdown-side'] as const) &&
		int(value.lineCount, 1) &&
		typeof value.dirty === 'boolean' &&
		typeof value.readOnly === 'boolean' &&
		isPosition(value.cursor) &&
		Array.isArray(value.selections) &&
		value.selections.length <= 16 &&
		value.selections.every(
			(item) => isRecord(item) && isPosition(item.from) && isPosition(item.to) && isText(item)
		) &&
		textTotal(value.selections) <= contextTextLimit &&
		(value.cursors === undefined ||
			(Array.isArray(value.cursors) &&
				value.cursors.length <= 16 &&
				value.cursors.every(isPosition))) &&
		(value.visibleLines === null || isLines(value.visibleLines))
	);
}
function isDiff(value: unknown) {
	if (
		!isRecord(value) ||
		!str(value.scopeId, 512) ||
		!str(value.path, 4096) ||
		!str(value.oldPath, 4096) ||
		!str(value.status, 32) ||
		!oneOf(value.source, sources)
	)
		return false;
	if (
		!(value.baseLabel === null || str(value.baseLabel, 512)) ||
		!(value.afterLabel === null || str(value.afterLabel, 512))
	)
		return false;
	if (!(
		value.range === null ||
		(isRecord(value.range) && int(value.range.base) && int(value.range.current))
	))
		return false;
	if (
		!oneOf(value.layout, ['unified', 'split'] as const) ||
		typeof value.preview !== 'boolean' ||
		!(value.pr === null || isRef(value.pr))
	)
		return false;
	const selection = value.selection,
		visible = value.visibleLines;
	if (!(
		selection === null ||
		(isRecord(selection) &&
			oneOf(selection.side, ['old', 'new'] as const) &&
			int(selection.start, 1) &&
			int(selection.end, 1) &&
			Number(selection.start) <= Number(selection.end) &&
			isText(selection) &&
			(selection.changed === undefined ||
				(Array.isArray(selection.changed) &&
					selection.changed.length <= 1024 &&
					selection.changed.every(isLines))))
	))
		return false;
	return (
		visible === null ||
		(isRecord(visible) &&
			(visible.old === null || isLines(visible.old)) &&
			(visible.new === null || isLines(visible.new)))
	);
}
/** Main checks the renderer's report before it reaches a host (spec/architecture-and-platform#ipc-boundary). */
export function isContextReport(value: unknown): value is ContextReport {
	if (
		!isRecord(value) ||
		typeof value.visible !== 'boolean' ||
		typeof value.documentsShown !== 'boolean'
	)
		return false;
	if (!Array.isArray(value.tabs) || value.tabs.length > 256 || !value.tabs.every(isTab))
		return false;
	if (
		!(value.editor === null || isEditor(value.editor)) ||
		!(value.diff === null || isDiff(value.diff))
	)
		return false;
	if (
		value.groups !== undefined &&
		!(
			Array.isArray(value.groups) &&
			value.groups.length <= 64 &&
			value.groups.every(
				(group) =>
					isRecord(group) &&
					int(group.group, 1) &&
					typeof group.focused === 'boolean' &&
					(group.tab === null || int(group.tab)) &&
					(group.editor === null || isEditor(group.editor)) &&
					(group.diff === null || isDiff(group.diff))
			)
		)
	)
		return false;
	const panel = value.panel;
	if (
		!isRecord(panel) ||
		typeof panel.shown !== 'boolean' ||
		!oneOf(panel.tab, ['changes', 'files', 'prs'] as const) ||
		!oneOf(panel.changesView, ['diff', 'history', 'turns'] as const)
	)
		return false;
	return (
		value.pr === null ||
		(isRef(value.pr) &&
			oneOf((value.pr as Record<string, unknown>).tab, [
				'comments',
				'files',
				'commits',
				'checks',
			] as const) &&
			[undefined, false].includes((value.pr as Record<string, unknown>).panel as undefined))
	);
}

/** A repo of the task, by scope id: its name and its path relative to the task's working directory ('' — the root). */
export type ContextRepo = { name: string; path: string };
export type ContextOptions = {
	visible: boolean;
	diffBase: DiffBase;
	repo: (scopeId: string) => ContextRepo | null;
	/** spec/agents-and-providers#editor-state: every repo of the task, to tell which one a file belongs to. */
	repos?: readonly ContextRepo[];
};
const join = (dir: string, path: string) => (dir ? `${dir}/${path}` : path);
const pair = (lines: ContextLines | null) => (lines ? [lines.start, lines.end] : null);
const notes = {
	closed: 'The Brigadir window is closed, so the person is not looking at any file.',
	unseen: 'The person has not opened this task in the app since it started.',
	hidden:
		'The person is looking at another task now; these are the tabs this task had when they left it.',
	empty: 'No file or diff is open in this task.',
	chat: 'The person is looking at the chat; the documents area is not on screen.',
	noPr: 'No pull request is open in the Pull requests panel of this task. The person opens one there (⇧⌘P).',
};
export const contextClosed = (tool: ContextTool) =>
	tool === 'editor'
		? { window: 'closed', note: notes.closed }
		: { window: 'closed', open: false, note: notes.closed };
/** A diff file by its path from the working directory and the name of its repo (spec/agents-and-providers#editor-state: the root repo too). */
function diffPath(diff: { scopeId: string; path: string }, repo: ContextOptions['repo']) {
	const found = repo(diff.scopeId);
	if (!found) return { path: diff.path };
	return { path: found.path ? join(found.path, diff.path) : diff.path, repo: found.name };
}
/** spec/agents-and-providers#editor-state: the repo a file of the working directory belongs to — the deepest one whose folder holds it. */
export function fileRepo(
	path: string,
	repos: readonly ContextRepo[] = []
): { repo: string; repoPath?: string } | null {
	let best: ContextRepo | null = null;
	for (const repo of repos) {
		if (repo.path.startsWith('/') || repo.path.startsWith('..')) continue;
		const inside = !repo.path || path === repo.path || path.startsWith(`${repo.path}/`);
		if (inside && (!best || repo.path.length > best.path.length)) best = repo;
	}
	if (!best) return null;
	return best.path
		? { repo: best.name, repoPath: path.slice(best.path.length + 1) }
		: { repo: best.name };
}
function baseOf(diff: ContextReportDiff, options: ContextOptions) {
	if (diff.source === 'changes') {
		if (diff.range) return `turns: checkpoint ${diff.range.base} to ${diff.range.current}`;
		return options.diffBase === 'head' ? 'last commit (HEAD of the repo)' : 'start of the task';
	}
	if (diff.source === 'pr') return 'merge base of the pull request';
	return diff.baseLabel ?? 'parent commit';
}
function editorAnswer(editor: ContextReportEditor, options: ContextOptions) {
	return {
		kind: 'file',
		path: editor.path,
		...fileRepo(editor.path, options.repos),
		view: editor.view,
		lineCount: editor.lineCount,
		unsaved: editor.dirty,
		...(editor.readOnly ? { readOnly: true } : {}),
		cursor: editor.cursor,
		...(editor.cursors && editor.cursors.length > 1 ? { cursors: editor.cursors } : {}),
		selections: editor.selections.map((item) => ({
			lines: [
				item.from.line,
				item.to.column === 1 && item.to.line > item.from.line ? item.to.line - 1 : item.to.line,
			],
			from: item.from,
			to: item.to,
			text: item.text,
			...(item.truncated ? { truncated: true, length: item.length } : {}),
		})),
		visibleLines: pair(editor.visibleLines),
	};
}
/** spec/agents-and-providers#editor-state: whether the selected diff lines are changes on their side, context, or both. */
function diffSelection(selection: NonNullable<ContextReportDiff['selection']>) {
	const changed = selection.changed,
		count = changed?.reduce((sum, item) => sum + item.end - item.start + 1, 0) ?? 0,
		kind = !changed
			? undefined
			: count === 0
				? 'context'
				: count >= selection.end - selection.start + 1
					? selection.side === 'old'
						? 'removed'
						: 'added'
					: 'mixed';
	return {
		side: selection.side,
		lines: [selection.start, selection.end],
		...(kind ? { kind } : {}),
		...(kind === 'mixed' ? { changed: changed!.map(pair) } : {}),
		text: selection.text,
		...(selection.truncated ? { truncated: true, length: selection.length } : {}),
	};
}
function diffAnswer(diff: ContextReportDiff, options: ContextOptions) {
	return {
		kind: 'diff',
		...diffPath(diff, options.repo),
		...(diff.oldPath !== diff.path ? { oldPath: diff.oldPath } : {}),
		status: diff.status,
		source: diff.source,
		base: baseOf(diff, options),
		...(diff.afterLabel ? { after: diff.afterLabel } : {}),
		view: diff.preview ? 'markdown-preview' : 'diff',
		layout: diff.layout,
		...(diff.pr ? { pullRequest: diff.pr.number } : {}),
		selection: diff.selection ? diffSelection(diff.selection) : null,
		visibleLines: diff.visibleLines
			? { old: pair(diff.visibleLines.old), new: pair(diff.visibleLines.new) }
			: null,
	};
}
const tools: Record<ToolTabKind, string> = {
	terminal: 'A console tab; console_read reads it.',
	browser: 'A browser tab; the browser_* tools read it.',
	simulator: 'A simulator tab; the simulator_* tools read it.',
};
function documentAnswer(
	tab: ContextReportTab | undefined,
	editor: ContextReportEditor | null,
	diff: ContextReportDiff | null,
	options: ContextOptions
) {
	if (editor) return editorAnswer(editor, options);
	if (diff) return diffAnswer(diff, options);
	if (tab?.kind === 'pr-overview')
		return {
			kind: 'pr-overview',
			pullRequest: tab.number,
			note: 'The overview of the pull request; pr_state reads it.',
		};
	if (tab && oneOf(tab.kind, toolTabKinds))
		return { kind: tab.kind, title: (tab as { title: string }).title, note: tools[tab.kind] };
	return null;
}
function tabAnswer(tab: ContextReportTab, options: ContextOptions) {
	const group = tab.group ? { group: tab.group } : {};
	switch (tab.kind) {
		case 'file':
			return {
				kind: 'file',
				path: tab.path,
				...fileRepo(tab.path, options.repos),
				...group,
				active: tab.active,
				unsaved: tab.dirty,
			};
		case 'pr-overview':
			return { kind: 'pr-overview', pullRequest: tab.number, ...group, active: tab.active };
		case 'diff':
			return {
				kind: 'diff',
				...diffPath(tab, options.repo),
				source: tab.source,
				...group,
				active: tab.active,
			};
		default:
			return { kind: tab.kind, title: tab.title, ...group, active: tab.active };
	}
}
/** The `editor_state` answer: tabs, the focused group's document with cursor or diff selection, the other groups, the right panel. */
export function editorStateAnswer(report: ContextReport | null, options: ContextOptions) {
	if (!report) return { window: 'open', visible: false, tabs: [], note: notes.unseen };
	const focused = report.groups?.find((group) => group.focused);
	const active = documentAnswer(
		focused && focused.tab !== null
			? report.tabs[focused.tab]
			: report.tabs.find((tab) => tab.active),
		report.editor,
		report.diff,
		options
	);
	const groups = report.groups && report.groups.length > 1 ? report.groups : null;
	const note = !report.tabs.length
		? notes.empty
		: !report.visible && options.visible === false
			? notes.hidden
			: !report.documentsShown
				? notes.chat
				: undefined;
	return {
		window: 'open',
		visible: report.visible && options.visible,
		documentsShown: report.documentsShown,
		tabs: report.tabs.map((tab) => tabAnswer(tab, options)),
		active: active && focused && groups ? { group: focused.group, ...active } : active,
		...(groups
			? {
					groups: groups.map((group) => ({
						group: group.group,
						focused: group.focused,
						active: documentAnswer(
							group.tab === null ? undefined : report.tabs[group.tab],
							group.editor,
							group.diff,
							options
						),
					})),
				}
			: {}),
		panel: report.panel,
		...(note ? { note } : {}),
	};
}
const clip = (text: string) => {
	const value = clipText(text, contextCommentLimit);
	return value.truncated ? `${value.text}…` : value.text;
};
function draftAnswer(draft: PRDraft) {
	return {
		id: draft.id,
		path: draft.path,
		lines: draft.startLine ? [draft.startLine, draft.line] : [draft.line],
		side: draft.side,
		body: clip(draft.body),
		...(draft.replyTo !== null ? { replyTo: draft.replyTo } : {}),
		from: draft.fromAgent ? 'agent' : 'person',
		...(draft.discussion?.length
			? {
					discussion: draft.discussion.map((reply) => ({
						from: reply.from,
						body: clip(reply.body),
						at: reply.at,
					})),
				}
			: {}),
	};
}
/** spec/agents-and-providers#editor-state: the PR files with «Viewed», the ones open in tabs and the one on screen; at most this many. */
export const contextFileLimit = 300;
/** The `pr_state` answer: the PR, its threads and comments (the person's marked `mine`), the unsent drafts, the files with «Viewed». */
export function prStateAnswer(
	report: ContextReport | null,
	detail: PullRequestDetail | null,
	review: PRReviewDraft | null,
	options: ContextOptions,
	error?: string,
	viewer: string | null = null
) {
	const pr = report?.pr;
	if (!report || !pr) return { window: 'open', open: false, note: notes.noPr };
	const head = {
		window: 'open',
		open: true,
		visible: report.visible && options.visible,
		number: pr.number,
		...(pr.panel === false ? { panel: false } : { tab: pr.tab }),
		...(options.repo(pr.scopeId)?.path ? { repo: options.repo(pr.scopeId)!.name } : {}),
	};
	if (!detail) return { ...head, error: error ?? 'GitHub did not answer.' };
	const s = detail.summary,
		ofPr = (ref: ContextPRRef | null | undefined) =>
			ref?.number === pr.number && ref.scopeId === pr.scopeId;
	// The focused group's PR file first, then one another group shows (spec/agents-and-providers#editor-state).
	const file = [report.diff, ...(report.groups ?? []).map((group) => group.diff)].find(
		(diff) => diff && ofPr(diff.pr)
	);
	const tabs = report.tabs.flatMap((tab) =>
		tab.kind === 'diff' && tab.source === 'pr' && (!tab.pr || ofPr(tab.pr))
			? [{ path: tab.path, active: tab.active, ...(tab.group ? { group: tab.group } : {}) }]
			: []
	);
	const mine = (author: string) => (viewer && author === viewer ? { mine: true } : {});
	const threads = detail.threads.slice(0, contextThreadLimit).map((thread) => ({
		id: thread.id,
		path: thread.path,
		lines:
			thread.line === null
				? null
				: thread.startLine
					? [thread.startLine, thread.line]
					: [thread.line],
		side: thread.side,
		resolved: thread.resolved,
		outdated: thread.outdated,
		comments: thread.comments.map((comment) => ({
			author: comment.author,
			...mine(comment.author),
			at: comment.createdAt,
			body: clip(comment.body),
			url: comment.url,
		})),
	}));
	const files = detail.files.slice(0, contextFileLimit).map((item) => ({
		path: item.path,
		change: item.change,
		additions: item.additions,
		deletions: item.deletions,
		viewed: item.viewed,
		...(tabs.some((tab) => tab.path === item.path) ? { open: true } : {}),
		...(file?.path === item.path ? { active: true } : {}),
	}));
	return {
		...head,
		title: s.title,
		url: s.url,
		state: s.state,
		author: s.author,
		...(viewer ? { viewer } : {}),
		head: s.head,
		base: s.base,
		reviewDecision: s.reviewDecision,
		openFile: file
			? {
					path: file.path,
					active: true,
					selection: file.selection ? diffSelection(file.selection) : null,
					visibleLines: file.visibleLines
						? { old: pair(file.visibleLines.old), new: pair(file.visibleLines.new) }
						: null,
				}
			: null,
		openTabs: tabs,
		files,
		...(detail.files.length > contextFileLimit
			? { moreFiles: detail.files.length - contextFileLimit }
			: {}),
		viewed: {
			n: detail.files.filter((item) => item.viewed).length,
			of: detail.files.length,
		},
		threads,
		...(detail.threads.length > contextThreadLimit
			? { moreThreads: detail.threads.length - contextThreadLimit }
			: {}),
		comments: detail.comments.map((comment) => ({
			author: comment.author,
			...mine(comment.author),
			at: comment.createdAt,
			body: clip(comment.body),
		})),
		reviews: detail.reviews
			.filter((item) => item.body.trim() || item.state !== 'COMMENTED')
			.map((item) => ({
				author: item.author,
				...mine(item.author),
				state: item.state,
				at: item.submittedAt,
				body: clip(item.body),
			})),
		drafts: (review?.drafts ?? []).map(draftAnswer),
		...(review?.body.trim() ? { draftReviewBody: clip(review.body) } : {}),
	};
}
