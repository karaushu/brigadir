import { editingServices, indentExtensions } from './editor-commands';
import { crlfBreaks } from './editor-lineend';
import { syntaxDecorations } from './syntax';
import {
	defaultIndentSize,
	detectIndent,
	languageIndentSize,
	resolveIndent,
	syntaxLanguage,
	type DetectedIndent,
	type IndentSettings,
	type ProjectIndent,
	type ResolvedIndent,
	type SyntaxSnapshot,
} from '@brigadir/core';
import { Compartment, EditorState, Text } from '@codemirror/state';
import {
	defaultKeymap,
	history,
	historyField,
	historyKeymap,
	isolateHistory,
} from '@codemirror/commands';
import {
	drawSelection,
	EditorView,
	highlightActiveLine,
	highlightActiveLineGutter,
	keymap,
	lineNumbers,
} from '@codemirror/view';
import { search } from '@codemirror/search';
import type { EditorDocument } from '@brigadir/core';
export class EditorModel {
	readonly selectionUI = new Compartment();
	readonly notes = new Compartment();
	readonly typing = new Compartment();
	readonly wiring = new Compartment();
	readonly separator = new Compartment();
	readonly indent = new Compartment();
	/** spec/chat#code-pills: line wrapping follows the task's `wrap`, shared with the diff. */
	readonly wrapping = new Compartment();
	/** spec/editor#indentation: the document's own indentation is read when it is opened (and on a reload), not on every edit, so the unit does not jump while typing. */
	detected: DetectedIndent | null;
	indentSettings: IndentSettings = {
		indentStyle: 'auto',
		indentSize: defaultIndentSize,
		tabWidth: 'auto',
	};
	indentProject: ProjectIndent | null = null;
	resolved: ResolvedIndent;
	state: EditorState;
	saved: EditorState['doc'];
	scrollTop = 0;
	scrollLeft = 0;
	syntax: SyntaxSnapshot | null = null;
	syntaxDoc: Text | null = null;
	saving = false;
	conflict: EditorDocument | null = null;
	/** spec/editor#save-during-turn: the save the host holds until the turn ends — the text at ⌘S; a newer ⌘S replaces it. */
	queued: { doc: Text; text: string } | null = null;
	/** The queued save holds exactly this buffer: Save has nothing new to send. */
	get waiting() {
		return this.queued?.doc === this.state.doc;
	}
	/** spec/editor#editor-groups: a passive group showing this buffer follows its edits, colours and reloads. */
	private readonly watchers = new Set<() => void>();
	watch(listener: () => void) {
		this.watchers.add(listener);
		return () => {
			this.watchers.delete(listener);
		};
	}
	notify() {
		for (const listener of this.watchers) listener();
	}
	/** `draft` (spec/task-window-workspace#restore-window): the unsaved buffer of a hot exit — its text, selection and undo over the disk `document`. */
	constructor(
		public document: EditorDocument,
		draft?: { state: unknown; scrollTop: number; scrollLeft: number }
	) {
		this.detected = detectIndent(document.text);
		this.resolved = this.resolveNow();
		const extensions = [
			editingServices(document.path),
			this.indent.of(indentExtensions(this.resolved)),
			syntaxDecorations,
			crlfBreaks,
			history(),
			keymap.of([...defaultKeymap, ...historyKeymap]),
			// spec/appearance#evolution-redesign: a line number selects nothing; code is selected as text.
			lineNumbers({ domEventHandlers: { mousedown: () => true } }),
			drawSelection(),
			highlightActiveLine(),
			highlightActiveLineGutter(),
			search({ top: true }),
			// spec/editor#editor-chrome: several ranges come only from Select all matches (⌥↩); a ⌘+click stays Go to definition.
			EditorState.allowMultipleSelections.of(true),
			EditorView.clickAddsSelectionRange.of(() => false),
			this.separator.of(EditorState.lineSeparator.of(document.lineEnding)),
			this.notes.of([]),
			this.selectionUI.of([]),
			this.typing.of([]),
			this.wiring.of([]),
			this.wrapping.of([]),
		];
		this.state = EditorState.create({ doc: document.text, extensions });
		this.saved = this.state.doc;
		if (draft) {
			try {
				this.state = EditorState.fromJSON(draft.state, { extensions }, { history: historyField });
			} catch {
				// A history CodeMirror cannot read back still leaves the text and the caret.
				const json = draft.state as { doc: string };
				this.state = EditorState.create({ doc: json.doc, extensions });
			}
			this.scrollTop = draft.scrollTop;
			this.scrollLeft = draft.scrollLeft;
		}
	}
	/** spec/task-window-workspace#restore-window: what a hot exit keeps of the buffer — the text, the selection, the undo history and the scroll. */
	draft() {
		return {
			state: this.state.toJSON({ history: historyField }) as { doc: string },
			scrollTop: this.scrollTop,
			scrollLeft: this.scrollLeft,
		};
	}
	private resolveNow() {
		return resolveIndent({
			settings: this.indentSettings,
			project: this.indentProject,
			detected: this.detected,
			languageSize: languageIndentSize(syntaxLanguage(this.document.path)),
		});
	}
	/** spec/editor#editor-groups: the live CodeEditor view of this buffer while one is mounted; the indent goes through it, not past it. */
	live: EditorView | null = null;
	/**
	 * spec/editor#indentation: Settings and the project's answer go into the buffer (through its live view when one is
	 * mounted) and every passive group showing it follows, so the indentation never depends on which group has the focus.
	 */
	applyIndent(settings: IndentSettings, project: ProjectIndent | null) {
		const effect = this.setIndent(settings, project);
		if (!effect) return;
		if (this.live) this.live.dispatch({ effects: effect });
		else this.state = this.state.update({ effects: effect }).state;
		this.notify();
	}
	/** The reconfiguring effect for new Settings or a new project answer; null when nothing changed. */
	setIndent(settings: IndentSettings, project: ProjectIndent | null) {
		this.indentSettings = settings;
		this.indentProject = project;
		return this.reindent();
	}
	private reindent() {
		const next = this.resolveNow(),
			same =
				next.insertSpaces === this.resolved.insertSpaces &&
				next.indentSize === this.resolved.indentSize &&
				next.tabWidth === this.resolved.tabWidth;
		if (same) return null;
		this.resolved = next;
		return this.indent.reconfigure(indentExtensions(next));
	}
	get dirty() {
		return !this.state.doc.eq(this.saved);
	}
	text() {
		return this.state.sliceDoc();
	}
	/** The disk text replaces the buffer as the smallest change, so the caret, the selection and the marks outside it stay. */
	replace(document: EditorDocument, view?: EditorView) {
		this.document = document;
		this.detected = detectIndent(document.text);
		const reindent = this.reindent();
		const base = view?.state ?? this.state;
		const next = Text.of(document.text.split(document.lineEnding)),
			a = base.doc.toString(),
			b = next.toString(),
			limit = Math.min(a.length, b.length);
		let start = 0,
			end = 0;
		while (start < limit && a.charCodeAt(start) === b.charCodeAt(start)) start++;
		while (
			end < limit - start &&
			a.charCodeAt(a.length - 1 - end) === b.charCodeAt(b.length - 1 - end)
		)
			end++;
		// A surrogate pair is never cut in two.
		if (start > 0 && (a.charCodeAt(start - 1) & 0xfc00) === 0xd800) start--;
		if (end > 0 && (a.charCodeAt(a.length - end) & 0xfc00) === 0xdc00) end--;
		// With a view the change goes through it, so the scroll, the marks and the language server follow it like any edit;
		// ⌘Z takes it back as one step.
		const transaction = base.update({
			changes: { from: start, to: a.length - end, insert: next.slice(start, b.length - end) },
			effects: [
				this.separator.reconfigure(EditorState.lineSeparator.of(document.lineEnding)),
				...(reindent ? [reindent] : []),
			],
			annotations: isolateHistory.of('full'),
		});
		this.saved = transaction.state.doc;
		this.conflict = null;
		this.queued = null;
		if (view) view.dispatch(transaction);
		this.state = transaction.state;
		this.notify();
	}
	/**
	 * «Keep mine»: the disk text becomes the base the buffer is compared with, so every state of the buffer that differs
	 * from the disk is dirty, ⌘Z back to the old base included, and the next save overwrites the disk on purpose.
	 * The buffer keeps its own line breaks.
	 */
	keepMine(conflict: EditorDocument) {
		this.document = { ...conflict, text: this.document.text, lineEnding: this.document.lineEnding };
		this.saved = Text.of(conflict.text.split(conflict.lineEnding));
		this.conflict = null;
		this.queued = null;
	}
	/** The disk now holds exactly the buffer's text: nothing is left to resolve, the buffer is its own base. True when it settled. */
	settle(current: EditorDocument) {
		if (current.state !== 'text' || current.text !== this.text()) return false;
		this.document = current;
		this.saved = this.state.doc;
		this.conflict = null;
		this.queued = null;
		return true;
	}
	/** spec/editor#save-during-turn: the disk holds the queued text — the held save is written; later edits stay dirty. True when it landed. */
	landed(current: EditorDocument) {
		const queued = this.queued;
		if (!queued || current.state !== 'text' || current.text !== queued.text) return false;
		this.document = current;
		this.saved = queued.doc;
		this.conflict = null;
		this.queued = null;
		return true;
	}
}
/** spec/editor#editor-groups: the scroll a passive group's view hands to the live editor of the same buffer when that group takes the focus. */
/** Settings ▸ Editor's indentation choice with its defaults filled in. */
export function indentSettingsOf(choice: Partial<IndentSettings> | undefined): IndentSettings {
	return {
		indentStyle: choice?.indentStyle ?? 'auto',
		indentSize: choice?.indentSize ?? defaultIndentSize,
		tabWidth: choice?.tabWidth ?? 'auto',
	};
}
export const scrollHandover = new WeakMap<EditorModel, { top: number; left: number }>();
const theme = EditorView.theme({
	'&': {
		height: '100%',
		fontSize: 'var(--editor-size,12px)',
		backgroundColor: 'var(--content)',
		color: 'var(--fg)',
	},
	'.cm-scroller': {
		overflow: 'auto',
		fontFamily: 'var(--editor-family,ui-monospace)',
		lineHeight: 'var(--editor-line,19px)',
		fontVariantLigatures: 'var(--editor-ligatures,none)',
		// spec/appearance#evolution-redesign: Geist Mono's ligatures are Stylistic Set 11.
		fontFeatureSettings: 'var(--editor-features,normal)',
	},
	'.cm-content': { caretColor: 'var(--fg)', padding: '8px 0' },
	// Leave scrollable room after the final glyph, including a wide emoji and the drawn caret.
	'.cm-line': { paddingRight: '24px' },
	'.cm-cursor': { borderLeftColor: 'var(--fg)' },
	// spec/editor#disk-vs-buffer: the raw CR of a mixed LF/CRLF file, a muted ␍ at the end of its line.
	'.cm-raw-cr': { color: 'var(--fg3)' },
	// spec/editor#editor-chrome: the numbers stand on the code's own ground, no strip and no line; the caret's row is --hover across,
	// its number --fg.
	'.cm-gutters': {
		backgroundColor: 'var(--content)',
		color: 'var(--fg3)',
		borderRight: '0',
	},
	'.cm-lineNumbers .cm-gutterElement': {
		boxSizing: 'border-box',
		minWidth: '34px',
		padding: '0 4px 0 8px',
	},
	'.cm-activeLine,.cm-activeLineGutter': { backgroundColor: 'var(--hover)' },
	'.cm-activeLineGutter': { color: 'var(--fg)' },
	// spec/diff-and-review#diff-selection: the base theme's focused colour (#d7d4f0) uses this exact selector, so ours must match it to win.
	'.cm-selectionBackground,&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground':
		{ background: 'var(--accent-soft)' },
	// spec/editor#editor-chrome: the find panel floats (ui/FindPanel); CodeMirror's panel row holds only its host, with no height.
	'.cm-panels': { backgroundColor: 'transparent', color: 'var(--fg)' },
	'.cm-panels.cm-panels-top': { borderBottom: '0' },
	'.cm-matchingBracket': {
		backgroundColor: 'var(--accent-soft)',
		outline: '1px solid var(--accent)',
	},
	'.cm-nonmatchingBracket': {
		backgroundColor: 'var(--diffRemovedBg)',
		textDecoration: 'underline',
	},
	// spec/appearance#evolution-redesign: every match --amber 22 %, the current one 58 % with an outline.
	'.cm-searchMatch': {
		backgroundColor: 'color-mix(in srgb, var(--amber) 22%, transparent)',
		borderRadius: '2px',
	},
	'.cm-searchMatch.cm-searchMatch-selected': {
		backgroundColor: 'color-mix(in srgb, var(--amber) 58%, transparent)',
		boxShadow: '0 0 0 1px color-mix(in srgb, var(--amber) 85%, transparent)',
	},
	// spec/editor#editor-chrome: the change map — 12 px right of the code, a hair on its left; the code's scroll ends before it.
	'&[data-change-map] > .cm-scroller': { marginRight: '12px' },
	'.cm-change-map': {
		position: 'absolute',
		top: '0',
		bottom: '0',
		right: '0',
		width: '12px',
		borderLeft: '1px solid var(--hair)',
		backgroundColor: 'var(--content)',
		zIndex: '2',
	},
	'.cm-change-map[hidden]': { display: 'none' },
	'.cm-map-band': {
		position: 'absolute',
		left: '0',
		right: '0',
		borderRadius: '2px',
		backgroundColor: 'color-mix(in srgb, var(--fg) 14%, transparent)',
		pointerEvents: 'none',
	},
	'.cm-map-band[hidden]': { display: 'none' },
	'.cm-map-marks': { position: 'absolute', inset: '0' },
	'.cm-map-mark': {
		position: 'absolute',
		left: '3px',
		right: '3px',
		borderRadius: '2px',
		cursor: 'pointer',
	},
	// The hover target is at least 24 px tall and the strip's whole width, however thin the mark.
	'.cm-map-mark::before': {
		content: '""',
		position: 'absolute',
		left: '-3px',
		right: '-3px',
		top: 'min(0px, calc(50% - 12px))',
		bottom: 'min(0px, calc(50% - 12px))',
	},
	'.cm-map-add': { backgroundColor: 'var(--green)' },
	'.cm-map-mod': { backgroundColor: 'var(--accent)' },
	'.cm-map-add:hover,.cm-map-mod:hover': { left: '1px', right: '1px' },
	'.cm-map-del': {
		left: 'auto',
		right: '0',
		width: '0',
		height: '0',
		marginTop: '-4px',
		borderRadius: '0',
		borderTop: '4px solid transparent',
		borderBottom: '4px solid transparent',
		borderRight: '7px solid var(--red)',
	},
	'.cm-map-del:hover': { borderRightWidth: '11px' },
	'.cm-map-del::before': { left: '-5px', right: '-7px', top: '-12px', bottom: '-12px' },
	// With the find panel open the marks share the strip: changes on the left (4 px), matches on the right (4 × 2 px),
	// the current match across the whole width (3 px).
	'&[data-change-map=find] .cm-map-add,&[data-change-map=find] .cm-map-mod': {
		left: '2px',
		right: 'auto',
		width: '4px',
	},
	'&[data-change-map=find] .cm-map-add:hover,&[data-change-map=find] .cm-map-mod:hover': {
		left: '1px',
		width: '6px',
	},
	'.cm-map-tick': {
		position: 'absolute',
		left: '7px',
		width: '4px',
		height: '2px',
		borderRadius: '1px',
		backgroundColor: 'color-mix(in srgb, var(--amber) 75%, transparent)',
		pointerEvents: 'none',
	},
	'.cm-map-tick-current': {
		left: '1px',
		width: '10px',
		height: '3px',
		backgroundColor: 'var(--amber)',
		zIndex: '1',
	},
	// spec/editor#change-marks: 3 px change strip between the line numbers and the code; a deletion is a triangle on the line boundary.
	'.cm-changeGutter': { width: '7px' },
	'.cm-changeGutter .cm-gutterElement': { padding: '0', position: 'relative', cursor: 'pointer' },
	'.cm-change': { position: 'absolute', inset: '0' },
	'.cm-change-add::before,.cm-change-mod::before': {
		content: '""',
		position: 'absolute',
		top: '0',
		bottom: '0',
		left: '2px',
		width: '3px',
	},
	'.cm-change-add::before': { background: 'var(--green)' },
	'.cm-change-mod::before': { background: 'var(--accent)' },
	'.cm-change-del::after,.cm-change-del-top::after': {
		content: '""',
		position: 'absolute',
		left: '2px',
		width: '0',
		height: '0',
		borderTop: '4px solid transparent',
		borderBottom: '4px solid transparent',
		borderLeft: '6px solid var(--red)',
		zIndex: '1',
	},
	'.cm-change-del::after': { bottom: '-4px' },
	'.cm-change-del-top::after': { top: '-4px' },
	'.cm-change-peek': {
		margin: '3px 12px 5px 4px',
		border: '1px solid var(--sep)',
		borderRadius: '7px',
		background: 'var(--card)',
		overflow: 'hidden',
		boxShadow: '0 4px 14px var(--shadow)',
		animation: 'var(--motion-reveal)',
	},
	'.cm-change-peek header': {
		display: 'flex',
		alignItems: 'center',
		gap: '6px',
		padding: '5px 6px 5px 10px',
		borderBottom: '1px solid var(--sep)',
		font: 'var(--text-11)/16px var(--ui-family)',
	},
	'.cm-change-peek-base,.cm-change-peek-count': {
		color: 'var(--fg2)',
		fontVariantNumeric: 'tabular-nums',
	},
	'.cm-change-peek-icon': {
		width: 'var(--control-h-s)',
		padding: '0',
		display: 'grid',
		placeItems: 'center',
	},
	'.cm-change-peek-old': {
		display: 'flex',
		background: 'var(--diffRemovedBg)',
		whiteSpace: 'pre',
	},
	'.cm-change-peek-old > span:first-child': {
		width: '34px',
		flex: 'none',
		textAlign: 'right',
		paddingRight: '4px',
		color: 'var(--fg3)',
	},
	'.cm-change-peek-old > span:nth-child(2)': {
		width: '14px',
		flex: 'none',
		textAlign: 'center',
		color: 'var(--red)',
	},
	'.cm-change-peek-more': {
		padding: '2px 10px',
		color: 'var(--fg2)',
		font: 'var(--text-11)/16px var(--ui-family)',
	},
	// spec/editor#line-author: the line author after the caret line; the editor's font, dimmed, no room taken in the layout.
	'.cm-line-author': {
		display: 'inline-flex',
		alignItems: 'center',
		verticalAlign: 'top',
		gap: '6px',
		marginLeft: '32px',
		color: 'var(--fg2)',
		opacity: '.72',
		whiteSpace: 'nowrap',
		cursor: 'default',
		userSelect: 'none',
	},
	'.cm-line-author:hover': {
		opacity: '1',
		textDecoration: 'underline',
		textDecorationColor: 'var(--fg3)',
		textUnderlineOffset: '3px',
	},
	'.cm-line-author svg': { flex: 'none' },
});
export const editorTheme = [
	theme,
	// Keep the caret clear of the right edge, not just the final glyph's bounding box.
	EditorView.scrollMargins.of(() => ({ right: 24 })),
];
