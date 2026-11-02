import type { EditorView } from '@codemirror/view';
import {
	clipText,
	contextTextLimit,
	groupLeaves,
	isMarkdownPath,
	isToolTab,
	type ContextLines,
	type ContextReport,
	type ContextReportDiff,
	type ContextReportEditor,
	type ContextReportGroup,
	type ContextReportTab,
	type DiffLine,
	type DocumentTab,
	type FileDiff,
	type TaskKey,
} from '@brigadir/core';
import { groupsNow, parkedTaskState } from './task-state';
import type { DiffSelection } from './diff-selection';
/**
 * spec/agents-and-providers#context-tools: what the person is looking at, read when the task's agent calls `editor_state` or `pr_state`. The task store
 * holds the tabs and buffers; the mounted surfaces add what lives only in them: the editor's scroll and the diff's
 * selection and visible rows. Nothing is sent until main asks. spec/agents-and-providers#editor-state: every editor group (Split) reports its own document,
 * so a task keeps one source per mounted diff and per mounted editor view.
 */
type ViewSource = { documentsShown: boolean; panelShown: boolean };
type DiffSource = { diff: FileDiff; root: HTMLElement | null };
type HeldDiff = { fileId: string; selection: NonNullable<ContextReportDiff['selection']> };
const views = new Map<string, () => ViewSource>(),
	editors = new Map<string, Map<string, Set<EditorView>>>(),
	diffs = new Map<string, Set<() => DiffSource>>(),
	held = new Map<string, Map<string, HeldDiff>>();
const fileKey = (scopeId: string, path: string) => `${scopeId}\0${path}`;
const name = (key: TaskKey) => `${key.projectId}/${key.id}`;
function register<T>(map: Map<string, T>, key: TaskKey, value: T) {
	const id = name(key);
	map.set(id, value);
	return () => {
		if (map.get(id) === value) map.delete(id);
	};
}
/** The task view says whether its documents area and right panel are on screen. */
export const registerTaskView = (key: TaskKey, read: () => ViewSource) =>
	register(views, key, read);
/** A diff shown in the task's documents area (one per editor group), with the person's selection. */
export function registerDiffView(key: TaskKey, read: () => DiffSource) {
	const id = name(key),
		set = diffs.get(id) ?? new Set<() => DiffSource>();
	diffs.set(id, set);
	set.add(read);
	return () => {
		set.delete(read);
		if (!set.size && diffs.get(id) === set) diffs.delete(id);
	};
}
/**
 * spec/agents-and-providers#editor-state: the person's last selection in a diff, kept for the agent after they go to the chat or the console and after the
 * diff unmounts (two columns). The diff sets it when the selection changes; `null` drops it. Text is read here, once.
 */
export function holdDiffSelection(key: TaskKey, diff: FileDiff, selection: DiffSelection | null) {
	const id = name(key),
		map = held.get(id) ?? new Map<string, HeldDiff>(),
		at = fileKey(diff.file.scopeId, diff.file.path);
	if (!selection) {
		map.delete(at);
		if (!map.size) held.delete(id);
		return;
	}
	held.set(id, map);
	map.set(at, {
		fileId: diff.file.id,
		selection: {
			side: selection.side,
			start: selection.start,
			end: selection.end,
			...clipText(diffLinesText(diff.lines, selection.side, selection.start, selection.end)),
			changed: diffChanges(diff.lines, selection.side, selection.start, selection.end),
		},
	});
}
export function registerEditorView(key: TaskKey, documentId: string, view: EditorView) {
	const id = name(key),
		map = editors.get(id) ?? new Map<string, Set<EditorView>>(),
		set = map.get(documentId) ?? new Set<EditorView>();
	editors.set(id, map);
	map.set(documentId, set);
	set.add(view);
	return () => {
		set.delete(view);
		if (!set.size && map.get(documentId) === set) map.delete(documentId);
		if (!map.size && editors.get(id) === map) editors.delete(id);
	};
}

/** The lines on screen in the first laid-out view of a file (Split may show it in two groups). */
function visibleOf(views: Set<EditorView> | undefined): ContextLines | null {
	for (const view of views ?? []) {
		const lines = editorVisible(view);
		if (lines) return lines;
	}
	return null;
}
/** The lines on screen in a CodeMirror view, `null` when it is not laid out (hidden by Markdown preview, parked). */
function editorVisible(view: EditorView | undefined): ContextLines | null {
	if (!view || !view.dom.isConnected) return null;
	const rect = view.scrollDOM.getBoundingClientRect();
	if (rect.height <= 0 || !view.scrollDOM.offsetParent) return null;
	const doc = view.state.doc,
		top = view.lineBlockAtHeight(Math.max(0, rect.top - view.documentTop)),
		bottom = view.lineBlockAtHeight(Math.max(0, rect.bottom - view.documentTop - 1));
	return {
		start: doc.lineAt(top.from).number,
		end: doc.lineAt(Math.min(doc.length, bottom.from)).number,
	};
}
/** Diff rows on screen by side, from the code cells the virtualized list has drawn. */
function diffVisible(root: HTMLElement | null): ContextReportDiff['visibleLines'] {
	if (!root || !root.isConnected) return null;
	const bounds = root.getBoundingClientRect();
	if (bounds.height <= 0) return null;
	const sides: { old: ContextLines | null; new: ContextLines | null } = { old: null, new: null };
	for (const cell of root.querySelectorAll<HTMLElement>('[data-code-line][data-side]')) {
		const rect = cell.getBoundingClientRect();
		if (rect.bottom <= bounds.top || rect.top >= bounds.bottom || rect.height <= 0) continue;
		const side = cell.dataset.side === 'old' ? 'old' : 'new',
			line = Number(cell.dataset.codeLine);
		if (!Number.isSafeInteger(line) || line < 1) continue;
		const range = sides[side];
		sides[side] = range
			? { start: Math.min(range.start, line), end: Math.max(range.end, line) }
			: { start: line, end: line };
	}
	return sides.old || sides.new ? sides : null;
}
/** The text of diff lines `start..end` on one side: removed lines exist only on the old side, added only on the new. */
export function diffLinesText(
	lines: readonly DiffLine[],
	side: 'old' | 'new',
	start: number,
	end: number
): string {
	return lines
		.filter((line) => {
			const number = side === 'old' ? line.oldLine : line.newLine;
			return number !== null && number >= start && number <= end;
		})
		.map((line) => line.text)
		.join('\n');
}
/** spec/agents-and-providers#editor-state: the lines of `start..end` on one side that are changes there — removed on the old side, added on the new. */
export function diffChanges(
	lines: readonly DiffLine[],
	side: 'old' | 'new',
	start: number,
	end: number
): ContextLines[] {
	const ranges: ContextLines[] = [];
	for (const line of lines) {
		const number = side === 'old' ? line.oldLine : line.newLine;
		if (number === null || number < start || number > end) continue;
		if (line.kind !== (side === 'old' ? 'removed' : 'added')) continue;
		const last = ranges.at(-1);
		if (last && last.end === number - 1) last.end = number;
		else ranges.push({ start: number, end: number });
	}
	return ranges;
}
/** spec/agents-and-providers#editor-state: the selections of one editor share `contextTextLimit`; a selection past it keeps its full length only. */
export function clipSelections(texts: readonly string[]) {
	let left = contextTextLimit;
	return texts.map((text) => {
		const value = clipText(text, left);
		left -= value.text.length;
		return value;
	});
}
function editorReport(
	key: TaskKey,
	state: NonNullable<ReturnType<typeof parkedTaskState>>,
	fileId: string
): ContextReportEditor | null {
	const model = state.editorTabs.find((tab) => tab.document.id === fileId);
	if (!model) return null;
	const doc = model.state.doc,
		position = (at: number) => {
			const line = doc.lineAt(at);
			return { line: line.number, column: at - line.from + 1 };
		};
	const ranges = model.state.selection.ranges,
		selected = ranges.filter((range) => !range.empty).slice(0, 16),
		texts = clipSelections(selected.map((range) => model.state.sliceDoc(range.from, range.to)));
	const markdown = isMarkdownPath(model.document.path)
		? (state.markdownViews.get(fileId)?.view ?? 'preview')
		: 'code';
	return {
		path: model.document.path,
		view:
			markdown === 'preview'
				? 'markdown-preview'
				: markdown === 'side'
					? 'markdown-side'
					: 'editor',
		lineCount: doc.lines,
		dirty: model.dirty,
		readOnly: Boolean(model.document.locked || model.document.readOnly),
		cursor: position(model.state.selection.main.head),
		...(ranges.length > 1
			? { cursors: ranges.slice(0, 16).map((range) => position(range.head)) }
			: {}),
		selections: selected.map((range, index) => ({
			from: position(range.from),
			to: position(range.to),
			...texts[index]!,
		})),
		visibleLines: visibleOf(editors.get(name(key))?.get(fileId)),
	};
}
/** What a diff tab's key says: `scope/path` of the changes, `pr:N:scope/path` of a PR file (also before its diff came). */
function diffTarget(
	state: NonNullable<ReturnType<typeof parkedTaskState>>,
	target: string,
	path: string
) {
	const entry = state.commitDiffs[target],
		pr = target.match(/^pr:(\d+):([^/]*)\/(.*)$/);
	if (entry)
		return {
			entry,
			source: entry.source.kind,
			scopeId: entry.file.scopeId,
			path: entry.file.path,
			pr: entry.source.kind === 'pr' ? entry.source.ref : null,
		};
	if (pr)
		return {
			entry: null,
			source: 'pr' as const,
			scopeId: pr[2]!,
			path: pr[3]!,
			pr: { scopeId: pr[2]!, number: Number(pr[1]) },
		};
	return {
		entry: null,
		source: 'changes' as const,
		scopeId: target.includes('/') ? target.slice(0, target.indexOf('/')) : '',
		path,
		pr: null,
	};
}
function diffReport(
	key: TaskKey,
	state: NonNullable<ReturnType<typeof parkedTaskState>>,
	target: string,
	path: string
): ContextReportDiff {
	const at = diffTarget(state, target, path);
	// A mounted diff is this tab's when it shows the same file (a PR file before its diff came has none yet).
	const shown =
		[...(diffs.get(name(key)) ?? [])]
			.map((read) => read())
			.find((live) =>
				at.entry
					? live.diff.file.id === at.entry.file.id
					: live.diff.file.scopeId === at.scopeId && live.diff.file.path === at.path
			) ?? null;
	const file = shown?.diff.file ?? at.entry?.file ?? null,
		kept = held.get(name(key))?.get(fileKey(at.scopeId, at.path)),
		selection = kept && (!at.entry || kept.fileId === at.entry.file.id) ? kept.selection : null;
	return {
		scopeId: at.scopeId,
		path: at.path,
		oldPath: file?.oldPath || at.path,
		status: file?.status ?? 'M',
		source: at.source,
		baseLabel: shown?.diff.baseLabel ?? null,
		afterLabel: shown?.diff.afterLabel ?? null,
		range: at.source === 'changes' ? state.changeRange : null,
		layout: state.mode === 'sbs' ? 'split' : 'unified',
		preview: isMarkdownPath(at.path) && state.diffPreview,
		selection,
		visibleLines: shown ? diffVisible(shown.root) : null,
		pr: at.pr,
	};
}
const overview = (target: string) => target.match(/^overview:(\d+):(.*)\/overview$/);
/** The report for main (spec/agents-and-providers#context-tools); `null` — this window never opened the task. spec/agents-and-providers#editor-state: all editor groups. */
export function readContextReport(key: TaskKey): ContextReport | null {
	const state = parkedTaskState(key);
	if (!state) return null;
	const view = views.get(name(key))?.() ?? null,
		leaves = groupLeaves(groupsNow(state).root),
		focused = leaves.find((group) => group.id === state.editorGroups.focused) ?? leaves[0],
		several = leaves.length > 1;
	const seen = new Map<string, { tab: DocumentTab; group: number }>();
	leaves.forEach((group, index) => {
		for (const tab of group.documents)
			if (!seen.has(tab.id)) seen.set(tab.id, { tab, group: index + 1 });
	});
	const all = [...seen.values()],
		activeId = focused?.activeDocument ?? state.activeDocument;
	// A kept diff selection lives while its tab is open (spec/agents-and-providers#editor-state).
	const kept = held.get(name(key));
	if (kept) {
		const open = new Set(
			all.flatMap(({ tab }) => {
				if (tab.kind !== 'diff' || overview(tab.target)) return [];
				const at = diffTarget(state, tab.target, tab.path);
				return [fileKey(at.scopeId, at.path)];
			})
		);
		for (const at of kept.keys()) if (!open.has(at)) kept.delete(at);
		if (!kept.size) held.delete(name(key));
	}
	const tabs: ContextReportTab[] = all.map(({ tab, group }) => {
		const base = { active: tab.id === activeId, ...(several ? { group } : {}) };
		if (isToolTab(tab)) return { ...base, kind: tab.kind, title: tab.path };
		if (tab.kind === 'file')
			return {
				...base,
				kind: 'file',
				path: tab.path,
				dirty: Boolean(state.editorTabs.find((model) => model.document.id === tab.target)?.dirty),
			};
		const pr = overview(tab.target);
		if (pr) return { ...base, kind: 'pr-overview', scopeId: pr[2]!, number: Number(pr[1]) };
		const at = diffTarget(state, tab.target, tab.path);
		return {
			...base,
			kind: 'diff',
			scopeId: at.scopeId,
			path: at.path,
			source: at.source,
			...(at.pr ? { pr: at.pr } : {}),
		};
	});
	const shownOf = (id: string | null) => {
		const tab = all.find((item) => item.tab.id === id)?.tab;
		return {
			tab,
			editor: tab?.kind === 'file' ? editorReport(key, state, tab.target) : null,
			diff:
				tab?.kind === 'diff' && !overview(tab.target)
					? diffReport(key, state, tab.target, tab.path)
					: null,
		};
	};
	const main = shownOf(activeId);
	const groups: ContextReportGroup[] | undefined = several
		? leaves.map((group, index) => {
				const shown = group === focused ? main : shownOf(group.activeDocument);
				const at = all.findIndex((item) => item.tab.id === group.activeDocument);
				return {
					group: index + 1,
					focused: group === focused,
					tab: at < 0 ? null : at,
					editor: shown.editor,
					diff: shown.diff,
				};
			})
		: undefined;
	// spec/agents-and-providers#editor-state: without a PR in the panel, the PR of the active tab (a PR file or the overview).
	const tabPr =
		main.diff?.pr ??
		(main.tab && overview(main.tab.target)
			? {
					scopeId: overview(main.tab.target)![2]!,
					number: Number(overview(main.tab.target)![1]),
				}
			: null);
	return {
		visible: Boolean(view),
		documentsShown: view?.documentsShown ?? false,
		tabs,
		editor: main.editor,
		diff: main.diff,
		...(groups ? { groups } : {}),
		panel: { shown: view?.panelShown ?? false, tab: state.panel, changesView: state.changesView },
		pr: state.prOpen
			? { ...state.prOpen, tab: state.prTab }
			: tabPr
				? { ...tabPr, tab: state.prTab, panel: false }
				: null,
	};
}
let installed = false;
/** Answers main's requests for the whole window; installed once at start. */
export function installContextAnswers() {
	if (installed) return;
	installed = true;
	window.brigadir.onContextRequest(({ id, key }) => {
		let report: ContextReport | null = null;
		try {
			report = readContextReport(key);
		} catch {
			report = null;
		}
		void window.brigadir.answerContextRequest(id, report).catch(() => {});
	});
}
