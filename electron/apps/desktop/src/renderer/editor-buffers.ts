import { redoDepth, undoDepth } from '@codemirror/commands';
import { EditorSelection, type Text } from '@codemirror/state';
import type { EditorDocument } from '@brigadir/core';
import { EditorModel } from './editor-model';
/**
 * LRU of the task's editor buffers (dirty buffers and comment drafts are never evicted).
 * A clean buffer that is not active leaves memory past `bufferLimit` buffers or `bufferChars` of text;
 * its document tab and main lease stay, and activating the tab reads the file again at the same selection and scroll.
 * Never evicted: the active buffer, dirty or saving ones, a pending disk conflict, the file of the comment draft and a
 * buffer with undo or redo history (edited and saved: its undo would be lost). The selection is kept as lines and
 * columns: the file may change on disk while the buffer is out.
 */
export type EditorPlace = { line: number; column: number };
export type EvictedEditor = {
	path: string;
	anchor: EditorPlace;
	head: EditorPlace;
	scrollTop: number;
	scrollLeft: number;
	conflict: boolean;
};
export const bufferLimit = 12,
	bufferChars = 16 * 1024 * 1024;
const used = new WeakMap<EditorModel, number>();
let clock = 0;
export const touchBuffer = (model: EditorModel) => {
	used.set(model, ++clock);
};
const marked = new WeakMap<Text, boolean>();
/** The tab's conflict dot: once per document version, line by line, not a full `text()` of every tab on each render. */
export function conflictMarked(doc: Text): boolean {
	let value = marked.get(doc);
	if (value !== undefined) return value;
	value = false;
	for (const iterator = doc.iterLines(); !iterator.next().done;) {
		const line = iterator.value;
		if (line.startsWith('<<<<<<<') && (line.length === 7 || line[7] === ' ')) {
			value = true;
			break;
		}
	}
	marked.set(doc, value);
	return value;
}
export function evictBuffers(
	tabs: EditorModel[],
	active: string | null,
	draft: string | null,
	evicted: Map<string, EvictedEditor>,
	shown: ReadonlySet<string> = new Set()
): { editorTabs: EditorModel[]; evictedEditors: Map<string, EvictedEditor> } | null {
	let count = tabs.length,
		chars = 0;
	for (const tab of tabs) chars += tab.state.doc.length;
	if (count <= bufferLimit && chars <= bufferChars) return null;
	const candidates = tabs
		.filter(
			(tab) =>
				tab.document.id !== active &&
				tab.document.id !== draft &&
				!shown.has(tab.document.id) &&
				!tab.dirty &&
				!tab.saving &&
				!tab.conflict &&
				!undoDepth(tab.state) &&
				!redoDepth(tab.state)
		)
		.sort((a, b) => (used.get(a) ?? 0) - (used.get(b) ?? 0));
	const gone = new Set<EditorModel>();
	for (const tab of candidates) {
		if (count <= bufferLimit && chars <= bufferChars) break;
		gone.add(tab);
		count--;
		chars -= tab.state.doc.length;
	}
	if (!gone.size) return null;
	const evictedEditors = new Map(evicted);
	for (const tab of gone) evictedEditors.set(tab.document.id, bufferPlace(tab));
	return { editorTabs: tabs.filter((tab) => !gone.has(tab)), evictedEditors };
}
/** Where a buffer stands, as lines and columns: an evicted buffer and a closed tab (spec/editor#reopen-closed-tab) come back there. */
export function bufferPlace(tab: EditorModel): EvictedEditor {
	const { anchor, head } = tab.state.selection.main,
		doc = tab.state.doc;
	const place = (offset: number): EditorPlace => {
		const line = doc.lineAt(offset);
		return { line: line.number, column: offset - line.from };
	};
	return {
		path: tab.document.path,
		anchor: place(anchor),
		head: place(head),
		scrollTop: tab.scrollTop,
		scrollLeft: tab.scrollLeft,
		conflict: conflictMarked(doc),
	};
}
/** A buffer for a freshly read document, back at the place an evicted buffer of the same file was left. */
export function restoreBuffer(
	document: EditorDocument,
	place: EvictedEditor | undefined
): EditorModel {
	const model = new EditorModel(document);
	if (!place) return model;
	const doc = model.state.doc;
	const offset = ({ line, column }: EditorPlace) => {
		const target = doc.line(Math.min(line, doc.lines));
		return target.from + Math.min(column, target.length);
	};
	model.state = model.state.update({
		selection: EditorSelection.single(offset(place.anchor), offset(place.head)),
	}).state;
	model.scrollTop = place.scrollTop;
	model.scrollLeft = place.scrollLeft;
	return model;
}
