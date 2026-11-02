import { useEffect, useLayoutEffect, useRef } from 'react';
import {
	Compartment,
	EditorState,
	RangeSetBuilder,
	StateEffect,
	StateField,
} from '@codemirror/state';
import {
	Decoration,
	drawSelection,
	EditorView,
	highlightActiveLine,
	highlightActiveLineGutter,
	keymap,
	lineNumbers,
	placeholder,
	ViewPlugin,
	WidgetType,
	type DecorationSet,
	type ViewUpdate,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { search } from '@codemirror/search';
import { noteTaskLinkPattern, type AgentTask } from '@brigadir/core';
import { editorTheme } from './editor-model';
import { inlineSelection } from './editor-selection';
import { noteMarkdown } from './note-markdown';
import { glyphMarkup } from './ui/glyph-markup';
import { Glyph } from './ui/Glyph';
import { StatusGlyph } from './ui/Controls';
import styles from './NoteEditor.module.css';
/** The lines a selection covers, 1-based; null — nothing is selected. */
export type NoteSelection = {
	from: number;
	to: number;
	startLine: number;
	endLine: number;
	text: string;
};
/** What a link to a task shows: the task's title and state now; null — the task is gone. */
export type NoteTaskInfo = { title: string; status: AgentTask['status']; label: string } | null;
const taskGlyph = glyphMarkup(<Glyph name="task-new" size={11} />);
/** spec/notifications-slack-notes-and-schedules#notes: the lines an answer names (`L5-7`), flashed once where the editor scrolled to. */
const flashLines = StateEffect.define<{ from: number; to: number } | null>();
const flashField = StateField.define<DecorationSet>({
	create: () => Decoration.none,
	update(value, tr) {
		for (const effect of tr.effects)
			if (effect.is(flashLines)) {
				if (!effect.value) return Decoration.none;
				const ranges = [];
				for (let n = effect.value.from; n <= effect.value.to; n++)
					ranges.push(Decoration.line({ class: styles.flash! }).range(tr.state.doc.line(n).from));
				return Decoration.set(ranges);
			}
		return value.map(tr.changes);
	},
	provide: (field) => EditorView.decorations.from(field),
});
class TaskChip extends WidgetType {
	constructor(
		readonly projectId: string,
		readonly taskId: string,
		readonly title: string,
		readonly info: NoteTaskInfo,
		readonly gone: string,
		readonly open: (projectId: string, taskId: string) => void
	) {
		super();
	}
	override eq(other: TaskChip) {
		return (
			other.taskId === this.taskId &&
			other.projectId === this.projectId &&
			other.title === this.title &&
			other.gone === this.gone &&
			other.info?.status === this.info?.status &&
			other.info?.label === this.info?.label &&
			other.info?.title === this.info?.title
		);
	}
	override toDOM() {
		const chip = document.createElement('button');
		chip.type = 'button';
		chip.className = styles.chip!;
		chip.dataset.noteTask = this.taskId;
		chip.dataset.status = this.info?.status ?? 'gone';
		chip.innerHTML =
			`<span class="${styles.chipGlyph}">${taskGlyph}</span><b></b><i></i>` +
			(this.info
				? `<span class="${styles.chipState}">${glyphMarkup(<StatusGlyph status={this.info.status} size={12} />)}</span>`
				: '');
		chip.querySelector('b')!.textContent = this.info?.title ?? this.title;
		chip.querySelector('i')!.textContent = `· ${this.info?.label ?? this.gone}`;
		chip.disabled = !this.info;
		chip.addEventListener('mousedown', (event) => event.preventDefault());
		chip.addEventListener('click', () => this.open(this.projectId, this.taskId));
		return chip;
	}
	override ignoreEvent() {
		return true;
	}
}
/** spec/notifications-slack-notes-and-schedules#notes: each `→ [title](brigadir://task/…)` is drawn as a chip; the Markdown under it stays as it is. */
function taskChips(
	lookup: (projectId: string, taskId: string) => NoteTaskInfo,
	gone: string,
	open: TaskChip['open']
) {
	const build = (view: EditorView) => {
		const builder = new RangeSetBuilder<Decoration>();
		for (const { from, to } of view.visibleRanges) {
			const text = view.state.doc.sliceString(from, to);
			for (const match of text.matchAll(noteTaskLinkPattern)) {
				const start = from + match.index!;
				builder.add(
					start,
					start + match[0].length,
					Decoration.replace({
						widget: new TaskChip(
							match[2]!,
							match[3]!,
							match[1]!,
							lookup(match[2]!, match[3]!),
							gone,
							open
						),
					})
				);
			}
		}
		return builder.finish();
	};
	const plugin = ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;
			constructor(view: EditorView) {
				this.decorations = build(view);
			}
			update(update: ViewUpdate) {
				if (update.docChanged || update.viewportChanged) this.decorations = build(update.view);
			}
		},
		{ decorations: (value) => value.decorations }
	);
	return [
		plugin,
		EditorView.atomicRanges.of((view) => view.plugin(plugin)?.decorations ?? Decoration.none),
	];
}
/**
 * spec/notifications-slack-notes-and-schedules#notes: a note in our editor — the same CodeMirror look as a `.md` file, lines wrap; spec/notifications-slack-notes-and-schedules#note-markdown: Markdown marks
 * are coloured, checkboxes and radios are controls, Enter continues a list. The note is not a file of a task: no LSP, blame or gutter of changes.
 * `text` from outside (the agent's edit, another window) replaces the document only when it differs from what the editor
 * holds. The selection's panel goes into `selectionHost` under its last line, as in the code editor (spec/diff-and-review#selection-panel).
 */
export function NoteEditor({
	noteId,
	text,
	label,
	empty,
	gone,
	selectionHost,
	selectionEnd,
	tasks,
	tasksKey,
	onChange,
	onSelection,
	onOpenTask,
}: {
	noteId: string;
	text: string;
	label: string;
	empty: string;
	/** The chip's state of a task that is no more. */ gone: string;
	selectionHost: HTMLElement;
	selectionEnd: number | null;
	tasks(projectId: string, taskId: string): NoteTaskInfo;
	/** Changes when a linked task changes, so the chips are drawn again. */ tasksKey: string;
	onChange(text: string): void;
	onSelection?(selection: NoteSelection | null): void;
	onOpenTask(projectId: string, taskId: string): void;
}) {
	const parent = useRef<HTMLDivElement>(null),
		view = useRef<EditorView | null>(null),
		outside = useRef(false),
		chips = useRef(new Compartment()),
		selection = useRef(new Compartment()),
		handlers = useRef({ onChange, onSelection, onOpenTask, tasks });
	handlers.current = { onChange, onSelection, onOpenTask, tasks };
	useEffect(() => {
		const state = EditorState.create({
			doc: text,
			extensions: [
				history(),
				noteMarkdown(),
				keymap.of([...defaultKeymap, ...historyKeymap]),
				lineNumbers({ domEventHandlers: { mousedown: () => true } }),
				drawSelection(),
				highlightActiveLine(),
				highlightActiveLineGutter(),
				search({ top: true }),
				EditorView.lineWrapping,
				placeholder(empty),
				EditorView.contentAttributes.of({ 'aria-label': label }),
				editorTheme,
				flashField,
				chips.current.of([]),
				selection.current.of([]),
				EditorView.updateListener.of((update) => {
					if (update.docChanged && !outside.current)
						handlers.current.onChange(update.state.doc.toString());
					if (update.selectionSet || update.docChanged) {
						const range = update.state.selection.main;
						const doc = update.state.doc;
						handlers.current.onSelection?.(
							range.empty
								? null
								: {
										from: range.from,
										to: range.to,
										startLine: doc.lineAt(range.from).number,
										endLine: doc.lineAt(Math.max(range.from, range.to - 1)).number,
										text: doc.sliceString(range.from, range.to),
									}
						);
					}
				}),
			],
		});
		view.current = new EditorView({ state, parent: parent.current! });
		return () => {
			view.current?.destroy();
			view.current = null;
		};
		// A new note is a new document; its later text comes through the effect below.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [noteId]);
	useEffect(() => {
		const current = view.current;
		const doc = current?.state.doc.toString();
		if (!current || doc === undefined || doc === text) return;
		// Only the part that differs: the caret and a selection outside it stay where they were (the agent's edit,
		// the link to a new task under the selected lines).
		let start = 0;
		while (start < doc.length && start < text.length && doc[start] === text[start]) start++;
		let end = 0;
		while (
			end < doc.length - start &&
			end < text.length - start &&
			doc[doc.length - 1 - end] === text[text.length - 1 - end]
		)
			end++;
		outside.current = true;
		try {
			current.dispatch({
				changes: {
					from: start,
					to: doc.length - end,
					insert: text.slice(start, text.length - end),
				},
			});
		} finally {
			outside.current = false;
		}
	}, [text]);
	useEffect(() => {
		view.current?.dispatch({
			effects: chips.current.reconfigure(
				taskChips(
					(projectId, taskId) => handlers.current.tasks(projectId, taskId),
					gone,
					(projectId, taskId) => handlers.current.onOpenTask(projectId, taskId)
				)
			),
		});
	}, [noteId, tasksKey, gone]);
	useLayoutEffect(() => {
		const current = view.current;
		if (!current) return;
		current.dispatch({
			effects: selection.current.reconfigure(
				selectionEnd === null ? [] : inlineSelection(current.state, selectionHost, selectionEnd)
			),
		});
	}, [noteId, selectionHost, selectionEnd]);
	return <div ref={parent} className={styles.mount} data-note-editor={noteId} />;
}
/** Where the selection starts, for the panel's place (`SelectionFloat start`). */
export function selectionStartRect(root: HTMLElement | null) {
	const view = root?.querySelector<HTMLElement>('.cm-editor');
	const editor = view ? EditorView.findFromDOM(view) : null;
	const at = editor?.coordsAtPos(editor.state.selection.main.from, 1);
	return at ? new DOMRect(at.left, at.top, 0, at.bottom - at.top) : null;
}
/** Drops the selection to its caret: the selected lines went into a task and their panel goes. */
export function collapseSelection(root: HTMLElement | null) {
	const view = root?.querySelector<HTMLElement>('.cm-editor');
	const editor = view ? EditorView.findFromDOM(view) : null;
	editor?.dispatch({ selection: { anchor: editor.state.selection.main.head } });
}
/** Scrolls the note to lines `from`–`to` (1-based, clamped) and flashes them; false — no editor is shown. */
export function revealLines(root: HTMLElement | null, from: number, to: number) {
	const view = root?.querySelector<HTMLElement>('.cm-editor');
	const editor = view ? EditorView.findFromDOM(view) : null;
	if (!editor) return false;
	const last = editor.state.doc.lines,
		start = Math.min(Math.max(1, from), last),
		end = Math.min(Math.max(start, to), last);
	editor.dispatch({
		effects: [
			flashLines.of({ from: start, to: end }),
			EditorView.scrollIntoView(editor.state.doc.line(start).from, { y: 'center' }),
		],
	});
	setTimeout(() => editor.dispatch({ effects: flashLines.of(null) }), 1200);
	return true;
}
