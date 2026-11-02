import { useSurfaceFont } from './typography';
import { registerEditorView } from './context-sources';
import { onSessionEvent } from './session-events';
import { inlineSelection } from './editor-selection';
import {
	useTaskState,
	openTaskEditor,
	openTaskTerminal,
	recordLocation,
	stepLocation,
	parkedTaskState,
	type CodePlace,
} from './task-state';
import { toastError, toastWarning, resolveToast } from './ui/Toast';
import { codeIntel, codeSession, codeCommands, showParameters, applyProblems } from './code-intel';
import { CodeLocations } from './CodeLocations';
import {
	formatDocument,
	formatNotice,
	formattersChanged,
	type FormatNotice,
} from './editor-format';
import { FilePath } from './ui/FilePath';
import { Glyph } from './ui/Glyph';
import { inlineNotes } from './editor-notes';
import { editorTyping } from './editor-typing';
import { conflictBlocks, conflictMarkers } from './editor-conflicts';
import { applyGutter, changeCommands, changeGutter, type GutterActions } from './editor-gutter';
import {
	authorAt,
	blameOf,
	lineAuthor,
	refreshLineAuthor,
	setBlame,
	type LineAuthor,
	type LineAuthorHost,
} from './editor-blame';
import { LineAuthorCard } from './LineAuthorCard';
import { addScriptCommand, runScript } from './ProjectCommands';
import { openTaskFileHistory, openTaskHistoryFile } from './task-state';
import { useWorkspace } from './store';
import { Rows } from './ui/Rows';
import { setSyntax } from './syntax';
import { EditorReview, type EditorRange, type ReviewMenu } from './EditorReview';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { EditorSelection, EditorState, Prec, StateEffect, StateField } from '@codemirror/state';
import { isolateHistory } from '@codemirror/commands';
import type { QuickApply } from './QuickAsk';
import { Decoration, EditorView, keymap, type DecorationSet } from '@codemirror/view';
import { redo, undo, indentMore, indentLess, toggleComment } from '@codemirror/commands';
import {
	closeSearchPanel,
	findNext,
	findPrevious,
	getSearchQuery,
	replaceAll,
	replaceNext,
	searchPanelOpen,
	selectMatches,
	type SearchQuery,
} from '@codemirror/search';
import { createPortal } from 'react-dom';
import { findPanel, findSpec, findStatus, openFind, setFind } from './editor-find';
import { changeMap } from './editor-map';
import { FindPanel } from './ui/FindPanel';
import {
	type ProjectIndent,
	isMarkdownPath,
	isPackageJsonPath,
	scriptAt,
	formatAccelerator,
	codeMirrorKey,
	commandAccelerator,
	defaultKeymap,
	menuCommands,
	codeWordAt,
	syntaxLanguage,
	enclosingSymbol,
	onDeclaration,
	t,
	type EditorMenuState,
	type FileDiff,
	type AgentTask,
	type Locale,
	type MessageKey,
	type CodeFormatInfo,
	type CodeFormatReason,
	type CodeLocation,
	type CodeLocations as CodeLocationList,
} from '@brigadir/core';
import { EditorModel, editorTheme, indentSettingsOf, scrollHandover } from './editor-model';
import { rawCarriageReturn } from './editor-lineend';
import {
	MarkdownPreview,
	flashPreviewLine,
	previewBlockStart,
	previewTopBlockLine,
	previewTopLine,
	scrollPreviewToLine,
	type PreviewFind,
} from './MarkdownPreview';
import { markdownViewTokens } from './markdown-view';
import { newMarkdownView, withMarkdownView, type MarkdownView } from './task-state';
import { Button, IconButton, Segments } from './ui/Controls';
import styles from './CodeEditor.module.css';
const fileName = (path: string) => path.split('/').at(-1) || path;
function cursorPosition(state: EditorState) {
	const cursor = state.selection.main.head;
	const line = state.doc.lineAt(cursor);
	return { line: line.number, column: cursor - line.from + 1 };
}
/** spec/editor#markdown-views: the line the place moved to after a switch, flashed once (Decoration, so a redraw keeps it). */
const flashLine = StateEffect.define<number | null>();
const flashField = StateField.define<DecorationSet>({
	create: () => Decoration.none,
	update(value, tr) {
		for (const effect of tr.effects)
			if (effect.is(flashLine))
				return effect.value === null
					? Decoration.none
					: Decoration.set([Decoration.line({ class: 'cm-md-flash' }).range(effect.value)]);
		return value.map(tr.changes);
	},
	provide: (field) => EditorView.decorations.from(field),
});
/** The code's search as a pattern over the preview's text: the same words, case and whole-word rules. */
function findPattern(query: SearchQuery): RegExp {
	const source = query.regexp ? query.search : query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	try {
		return new RegExp(
			query.wholeWord ? `\\b(?:${source})\\b` : source,
			query.caseSensitive ? 'g' : 'gi'
		);
	} catch {
		return /$^/g;
	}
}
/** The first line of the code shown at the top of the editor. */
function codeTopLine(view: EditorView) {
	const top = view.scrollDOM.getBoundingClientRect().top;
	return view.state.doc.lineAt(view.lineBlockAtHeight(Math.max(0, top - view.documentTop)).from)
		.number;
}
const languageNames: Record<string, string> = {
	markdown: 'Markdown',
	javascript: 'JavaScript',
	typescript: 'TypeScript',
	tsx: 'TSX',
	css: 'CSS',
	scss: 'SCSS',
	python: 'Python',
	bash: 'Shell',
	rust: 'Rust',
	go: 'Go',
	ruby: 'Ruby',
	java: 'Java',
	cpp: 'C/C++',
	'c-sharp': 'C#',
	php: 'PHP',
	ini: 'INI',
	json: 'JSON',
	powershell: 'PowerShell',
};
function selectedLines(state: EditorState): EditorRange | null {
	const selection = state.selection.main;
	return selection.empty
		? null
		: {
				start: state.doc.lineAt(selection.from).number,
				end: state.doc.lineAt(Math.max(selection.from, selection.to - 1)).number,
			};
}
export function CodeEditor({
	model,
	task,
	locale,
	agentBusy,
	changed,
	onReviewChanged,
	onCompose,
}: {
	model: EditorModel;
	task: AgentTask;
	locale: Locale;
	agentBusy: boolean;
	changed(): void;
	onReviewChanged(): Promise<void>;
	onCompose(
		text: string,
		focus?: boolean,
		immediate?: boolean,
		name?: string,
		after?: string
	): Promise<boolean>;
}) {
	const typography = useSurfaceFont('editor');
	// spec/editor#change-marks: the gutter follows the base setting (spec/diff-and-review#diff-base) and asks main again when it changes.
	const diffBase = useWorkspace((state) => state.appearance.diffBase);
	// spec/settings-modules-and-onboarding#settings-keys: save, find and replace follow the keymap, like their Editor menu items.
	const shortcuts = useWorkspace((state) => state.appearance.keymap) ?? defaultKeymap;
	const editorKey = (id: string, run: (view: EditorView) => boolean) => {
		const command = menuCommands.find((item) => item.id === id),
			key = command && commandAccelerator(command, shortcuts);
		return key ? [{ key: codeMirrorKey(key), run }] : [];
	};
	// spec/editor-code-intelligence#typing-help: typing aids reconfigure in place; language servers make the session reopen its document.
	const editing = useWorkspace((state) => state.appearance.editing);
	const callParens = useRef(editing.callParens);
	callParens.current = editing.callParens && editing.languageServers;
	const busyNow = useRef(agentBusy);
	busyNow.current = agentBusy;
	const gutterTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
		readGutter = useRef(() => {}),
		gutterTarget = useRef<{ scopeId: string; path: string } | null>(null);
	const gutterActions = useMemo<GutterActions>(
		() => ({
			canEdit: () =>
				!busyNow.current && !model.document.locked && !model.document.readOnly && !model.conflict,
			openDiff: (hunk) => {
				const target = gutterTarget.current;
				if (target)
					setTask({
						changeRange: null,
						panel: 'changes',
						panelShown: true,
						filter: '',
						selected: `${target.scopeId}/${target.path}`,
						surface: 'diff',
						diffLineTarget: Math.max(1, hunk.start),
					});
			},
		}),
		[model]
	);
	useEffect(() => {
		view.current?.requestMeasure();
	}, [typography]);
	// spec/editor#line-author: the line author tail and its card; the blame is read like the gutter, after an edit, a save or a commit.
	const indentChoice = useWorkspace((state) => state.appearance.indent);
	const lineAuthorOn = useWorkspace((state) => state.appearance.lineAuthor ?? true);
	const authorOn = useRef(lineAuthorOn);
	authorOn.current = lineAuthorOn;
	const blameTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
		readBlame = useRef(() => {});
	const [blameState, setBlameState] = useState<'ready' | 'untracked' | 'none' | 'too-large' | null>(
		null
	);
	type Card = {
		author: LineAuthor;
		anchor: { left: number; top: number };
		bounds: { left: number; right: number };
	};
	const [card, setCard] = useState<Card | null>(null);
	const cardTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const messages = useRef(new Map<string, string>());
	const [message, setMessage] = useState<string | null>(null);
	const keepCard = () => clearTimeout(cardTimer.current);
	const dropCard = () => {
		clearTimeout(cardTimer.current);
		cardTimer.current = setTimeout(() => setCard(null), 200);
	};
	const authorHost = useMemo<LineAuthorHost>(
		() => ({
			enabled: () => authorOn.current,
			locale,
			hover: (target) => {
				if (!target) {
					dropCard();
					return;
				}
				keepCard();
				const tail = target.element.getBoundingClientRect(),
					row = target.element.closest('.cm-line')?.getBoundingClientRect() ?? tail,
					frame = parent.current?.getBoundingClientRect();
				setCard({
					author: target.author,
					anchor: { left: tail.left, top: row.bottom + 2 },
					bounds: { left: frame?.left ?? 0, right: frame?.right ?? window.innerWidth },
				});
			},
		}),
		[model, locale]
	);
	useEffect(() => {
		if (card?.author.kind !== 'commit') {
			setMessage(null);
			return;
		}
		const sha = card.author.commit.sha,
			known = messages.current.get(sha);
		if (known !== undefined) {
			setMessage(known);
			return;
		}
		setMessage(null);
		let live = true;
		void window.brigadir.readBlameMessage(task, model.document.id, sha).then(
			(text) => {
				messages.current.set(sha, text);
				if (live) setMessage(text);
			},
			() => {}
		);
		return () => {
			live = false;
		};
	}, [card?.author]);
	useEffect(() => {
		if (!card) return;
		const close = (event: KeyboardEvent) => {
			if (event.key === 'Escape') setCard(null);
		};
		window.addEventListener('keydown', close);
		return () => window.removeEventListener('keydown', close);
	}, [card]);
	useEffect(() => {
		const instance = view.current;
		if (instance) {
			refreshLineAuthor(instance);
			if (!lineAuthorOn) setCard(null);
		}
	}, [lineAuthorOn]);
	/** The Git root and path that own this file, when the blame knows them. */
	const gitTarget = () => {
		const blame = view.current ? blameOf(view.current.state) : null;
		return blame && (blame.state === 'ready' || blame.state === 'untracked')
			? { scopeId: blame.scopeId, path: blame.path }
			: null;
	};
	function openFileHistory() {
		const target = gitTarget();
		if (target) {
			setCard(null);
			openTaskFileHistory(task, target.scopeId, target.path);
		}
	}
	function openLineCommit(author: LineAuthor | null) {
		const target = gitTarget();
		if (!target || author?.kind !== 'commit') return;
		setCard(null);
		const open = () => {
			void openTaskHistoryFile(
				task,
				target.scopeId,
				author.commit.sha,
				target.path,
				author.origin || undefined
			).catch(() => fail('Could not open {file} from the commit.', fileName(target.path), open));
		};
		open();
	}
	const [{ editorTarget, editorDraft, codeNotice, markdownViews, quickAsk, wrap }, setTask] =
		useTaskState(task);
	// spec/editor#markdown-views: Code, Side by side or Preview for a Markdown tab; a large file stays code (no preview for plain text mode).
	const markdownDoc = isMarkdownPath(model.document.path),
		previewOff = Boolean(model.document.large);
	// A file with conflict markers is opened to resolve them, and the places live in the code: it starts in `Code`.
	const conflicted = useMemo(
		() => markdownDoc && conflictBlocks(model.state).length > 0,
		[markdownDoc, model.document.id]
	);
	const markdownView: MarkdownView | null = markdownDoc
		? (markdownViews.get(model.document.id) ??
			(conflicted ? { ...newMarkdownView, view: 'code' } : newMarkdownView))
		: null;
	const viewMode: MarkdownView['view'] = !markdownView || previewOff ? 'code' : markdownView.view;
	const viewNow = useRef(viewMode);
	viewNow.current = viewMode;
	const previewRoot = useRef<HTMLDivElement | null>(null);
	const pendingPlace = useRef<{ line: number; to: 'code' | 'preview' | 'sync' } | null>(null);
	const syncing = useRef<'code' | 'preview' | null>(null);
	const [previewText, setPreviewText] = useState(() => (markdownDoc ? model.text() : ''));
	const previewTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const previewTokens = useMemo(
		() => (markdownDoc && viewMode !== 'code' ? markdownViewTokens(previewText) : null),
		[markdownDoc, viewMode === 'code', previewText]
	);
	const [find, setPreviewFind] = useState<PreviewFind | null>(null);
	// spec/editor#editor-chrome: CodeMirror shows an empty panel host; the floating find panel is portalled into it.
	const [findHost, setFindHost] = useState<HTMLElement | null>(null);
	const [, setFindTick] = useState(0);
	const [replaceOpen, setReplaceOpen] = useState(false);
	const replaceShown = useRef(false);
	const findField = useRef<HTMLInputElement | null>(null);
	const replaceField = useRef<HTMLInputElement | null>(null);
	const findHostApi = useMemo(
		() => ({
			mount: (dom: HTMLElement) => setFindHost(dom),
			unmount: (dom: HTMLElement) => setFindHost((host) => (host === dom ? null : host)),
			changed: () => setFindTick((n) => n + 1),
		}),
		[]
	);
	/** ⌘F: the panel opens (or takes the selection again) and its field the focus. */
	function focusFind(instance: EditorView, replace: boolean) {
		openFind(instance);
		if (replace) {
			setReplaceOpen(true);
			setReplaceFocus((value) => value + 1);
		} else {
			findField.current?.focus();
			findField.current?.select();
		}
		return true;
	}
	const findQuery = useRef<SearchQuery | null>(null);
	function setView(next: MarkdownView['view'], line?: number) {
		const instance = view.current;
		if (!markdownDoc || previewOff || !instance) return;
		if (next === viewMode) {
			if (line !== undefined) placeCode(line);
			return;
		}
		// spec/editor#markdown-views: the place moves with the switch. From the preview the code opens on the first line of its top block;
		// into the preview it shows the block with the caret; beside the code it starts where the code stands.
		const root = previewRoot.current;
		pendingPlace.current =
			line !== undefined
				? { line, to: 'code' }
				: viewMode === 'preview' && root
					? { line: previewTopBlockLine(root), to: 'code' }
					: next === 'preview'
						? {
								line: instance.state.doc.lineAt(instance.state.selection.main.head).number,
								to: 'preview',
							}
						: next === 'side'
							? { line: codeTopLine(instance), to: 'sync' }
							: null;
		clearTimeout(previewTimer.current);
		setPreviewText(model.text());
		setTask((state) => ({
			markdownViews: withMarkdownView(state.markdownViews, model.document.id, next),
		}));
	}
	/** The caret on the first column of `line`, that line at the top, flashed once. */
	function placeCode(line: number) {
		const instance = view.current;
		if (!instance) return;
		const target = instance.state.doc.line(Math.max(1, Math.min(line, instance.state.doc.lines)));
		instance.dispatch({
			selection: { anchor: target.from },
			effects: [EditorView.scrollIntoView(target.from, { y: 'start' }), flashLine.of(target.from)],
		});
		instance.focus();
		setTimeout(() => {
			if (view.current === instance) instance.dispatch({ effects: flashLine.of(null) });
		}, 900);
	}
	const setViewNow = useRef(setView);
	setViewNow.current = setView;
	const shown = markdownView?.shown ?? 'preview';
	const shownNow = useRef(shown);
	shownNow.current = shown;
	const selectionHost = useMemo(() => {
		const node = document.createElement('div');
		node.className = styles.selectionWidget!;
		node.dataset.editorSelection = 'true';
		return node;
	}, [model]);
	const parent = useRef<HTMLDivElement>(null);
	const view = useRef<EditorView | null>(null);
	const actions = useRef({
		save: () => {},
		format: () => {},
		definition: (_pos: number) => {},
		references: (_pos: number) => {},
		menu: (_atCaret: boolean) => {},
	});
	const reviewMenu = useRef<ReviewMenu | null>(null);
	const session = useMemo(() => codeSession(task, model), [model]);
	const [locations, setLocations] = useState<{
		title: 'References' | 'Go to definition';
		result: CodeLocationList;
	} | null>(null);
	// The footer note outlives the tab switch a jump causes, so it lives in the task state.
	const notice = codeNotice;
	const setNotice = (text: string) => setTask({ codeNotice: text });
	useEffect(() => {
		if (!notice) return;
		const timer = setTimeout(() => setTask({ codeNotice: '' }), 3000);
		return () => clearTimeout(timer);
	}, [notice]);
	const mounted = useRef(false);
	const syntaxChanged = useRef(() => {});
	/** spec/notifications-slack-notes-and-schedules#message-classes: a failure is its own toast that names the action and the file; a failed disk check warns once per streak. */
	const diskFailed = useRef(false);
	function fail(key: MessageKey, file: string, retry?: () => void) {
		toastError(t(locale, key).replace('{file}', file), {
			bold: file,
			action: retry ? { label: t(locale, 'Retry'), run: retry } : undefined,
		});
	}
	/** The file name of an editor document id, from the task's open or parked tabs. */
	function nameOf(id: string) {
		const state = parkedTaskState(task);
		const path =
			state?.editorTabs.find((tab) => tab.document.id === id)?.document.path ??
			state?.evictedEditors.get(id)?.path;
		return path ? fileName(path) : null;
	}
	// spec/editor-code-intelligence#format-states: the footer names the formatter a save runs; a failed format keeps its strip until the next edit.
	const [formatInfo, setFormatInfo] = useState<CodeFormatInfo | null>(null);
	const [formatStrip, setFormatStrip] = useState<FormatNotice | null>(null);
	// spec/editor#indentation: the project's Prettier or .editorconfig says how this file indents; Settings and the file's own text fill the rest.
	const [indentProject, setIndentProject] = useState<ProjectIndent | null>(null);
	const readIndentInfo = () => {
		void session
			.sync()
			.then(() => window.brigadir.indentInfoCode(task, model.document.id))
			.then(
				(info) => {
					if (mounted.current)
						setIndentProject((previous) =>
							JSON.stringify(previous) === JSON.stringify(info.project) ? previous : info.project
						);
				},
				() => {}
			);
	};
	const readFormatInfo = () => {
		void session
			.sync()
			.then(() => window.brigadir.formatInfoCode(task, model.document.id))
			.then(
				(info) => {
					if (mounted.current) setFormatInfo(info);
				},
				() => {}
			);
	};
	const [range, setRange] = useState<EditorRange | null>(() => selectedLines(model.state));
	const searchSelection = useRef(false);
	const [comparison, setComparison] = useState<Pick<
		FileDiff,
		'lines' | 'pairs' | 'tooLarge'
	> | null>(null);
	const [busy, setBusy] = useState(false);
	const [position, setPosition] = useState(() => cursorPosition(model.state));
	const [, refresh] = useState(0);
	const repaint = () => {
		setRange(searchSelection.current ? null : selectedLines(model.state));
		setPosition(cursorPosition(model.state));
		refresh((n) => n + 1);
	};
	const rerender = () => {
		repaint();
		changed();
	};
	useEffect(() => {
		if (editorTarget?.id !== model.document.id || !view.current) return;
		const instance = view.current,
			target = instance.state.doc.line(
				Math.max(1, Math.min(editorTarget.line, instance.state.doc.lines))
			);
		const anchor =
			target.from + Math.min(Math.max(0, (editorTarget.column ?? 1) - 1), target.length);
		// spec/chat#code-pills: a pill of lines selects them whole and shows them in the middle.
		const head =
			editorTarget.end && editorTarget.end >= target.number
				? instance.state.doc.line(Math.min(editorTarget.end, instance.state.doc.lines)).to
				: anchor;
		instance.dispatch({
			selection: { anchor, head },
			effects: EditorView.scrollIntoView(EditorSelection.range(anchor, head), { y: 'center' }),
		});
		setTask({ editorTarget: null });
		if (editorTarget.focus) instance.focus();
		// spec/editor-code-intelligence#diff-cmd-click: ⌘+click in a diff lands here; the diff line must still be this line.
		if (editorTarget.definition) {
			if (
				target.text.trimEnd() !== editorTarget.definition.text.trimEnd() ||
				target.number !== editorTarget.line
			)
				setNotice(t(locale, 'The file changed. Refresh the changes.'));
			else {
				instance.focus();
				actions.current.definition(anchor);
			}
		}
	}, [editorTarget, model]);
	/** After the buffer was replaced from the disk the gutter and the line authors are read at once, not on the next poll. */
	const refreshMarks = () => {
		readGutter.current();
		readBlame.current();
	};
	async function checkDisk() {
		if (model.saving) return;
		const version = model.document.version;
		// A shown conflict already holds the disk version: an unchanged disk needs no second copy.
		try {
			const current = await window.brigadir.checkEditorFile(
				task,
				model.document.id,
				model.conflict?.version ?? version
			);
			if (diskFailed.current)
				resolveToast(
					t(locale, 'Could not check {file} on disk.').replace(
						'{file}',
						fileName(model.document.path)
					)
				);
			diskFailed.current = false;
			if (!mounted.current || model.saving || model.document.version !== version) return;
			// An unchanged file answers with its lease only; the text crosses IPC when the version differs.
			if (!('version' in current)) {
				if (current.locked !== model.document.locked) {
					model.document = { ...model.document, locked: current.locked };
					rerender();
				}
			}
			// The disk text equals the buffer (an agent or a revert wrote what is already here): no conflict, the buffer is clean.
			else if (model.settle(current) || model.landed(current)) {
				setComparison(null);
				void window.brigadir.setEditorDirty(task, model.document.id, model.dirty).catch(() => {});
				rerender();
			} else if (current.version !== model.document.version) {
				if (model.dirty || current.state !== 'text') {
					// A held save (spec/editor#save-during-turn) would meet the same conflict at the host and write nothing.
					model.queued = null;
					model.conflict = current;
					rerender();
				} else {
					model.replace(current, view.current ?? undefined);
					void session.sync();
					syntaxChanged.current();
					refreshMarks();
					rerender();
				}
			}
			// The disk is back to the text the buffer was read from: there is nothing to resolve any more.
			else if (model.conflict) {
				model.document = current;
				model.conflict = null;
				setComparison(null);
				rerender();
			} else if (current.locked !== model.document.locked) {
				model.document = current;
				rerender();
			}
		} catch {
			if (mounted.current && !diskFailed.current) {
				diskFailed.current = true;
				toastWarning(
					t(locale, 'Could not check {file} on disk.').replace(
						'{file}',
						fileName(model.document.path)
					),
					{ bold: fileName(model.document.path) }
				);
			}
		}
	}
	async function save() {
		if (
			model.saving ||
			busy ||
			view.current?.composing ||
			model.document.locked ||
			!model.dirty ||
			model.conflict ||
			model.waiting
		)
			return;
		if (agentBusy) {
			await saveAfterTurn();
			return;
		}
		model.saving = true;
		setBusy(true);
		changed();
		try {
			const instance = view.current;
			if (instance) showFormat(await formatDocument(task, session, instance, 'save'), 'save');
			if (view.current !== instance) return;
			const submitted = model.state;
			const result = await window.brigadir.saveEditorFile(
				task,
				model.document.id,
				model.document.version,
				model.text()
			);
			if (result.status === 'conflict') model.conflict = { ...model.document, ...result.content };
			else {
				model.document = { ...model.document, ...result.content };
				model.saved = submitted.doc;
				await window.brigadir.setEditorDirty(task, model.document.id, model.dirty);
				readBlame.current();
			}
			rerender();
		} catch {
			fail('Could not save {file}.', fileName(model.document.path), () => {
				void save();
			});
		} finally {
			model.saving = false;
			setBusy(false);
			changed();
		}
	}
	/**
	 * spec/editor#save-during-turn: during a turn the host holds the write until the turn ends. The buffer stays editable meanwhile; the text
	 * at ⌘S is what gets written, and the answer lands on the model even if this editor is gone by then.
	 */
	async function saveAfterTurn() {
		const instance = view.current;
		setBusy(true);
		try {
			if (instance) showFormat(await formatDocument(task, session, instance, 'save'), 'save');
		} finally {
			if (mounted.current) setBusy(false);
		}
		if (view.current !== instance || model.conflict || model.document.locked || !model.dirty)
			return;
		const held = { doc: model.state.doc, text: model.text() };
		model.queued = held;
		rerender();
		try {
			const result = await window.brigadir.saveEditorFile(
				task,
				model.document.id,
				model.document.version,
				held.text,
				true
			);
			if (model.queued !== held) return;
			if (result.status === 'conflict') {
				const current = { ...model.document, ...result.content };
				if (!model.landed(current) && !model.settle(current)) {
					model.queued = null;
					model.conflict = current;
				}
			} else {
				model.queued = null;
				model.document = { ...model.document, ...result.content };
				model.saved = held.doc;
				if (mounted.current) readBlame.current();
			}
			await window.brigadir.setEditorDirty(task, model.document.id, model.dirty).catch(() => {});
		} catch {
			if (model.queued !== held) return;
			model.queued = null;
			fail('Could not save {file}.', fileName(model.document.path), () => {
				void save();
			});
		}
		rerender();
	}
	function showFormat(
		result: Awaited<ReturnType<typeof formatDocument>>,
		reason: CodeFormatReason
	) {
		const next = formatNotice(locale, result, reason);
		if (next?.place === 'footer') setNotice(next.text);
		else setFormatStrip(next);
	}
	async function formatNow() {
		const instance = view.current;
		if (
			!instance ||
			model.saving ||
			busy ||
			agentBusy ||
			model.document.locked ||
			model.document.readOnly ||
			model.conflict
		)
			return;
		const result = await formatDocument(task, session, instance, 'command');
		if (mounted.current) showFormat(result, 'command');
	}
	function goToLine(line: number) {
		const instance = view.current;
		if (!instance) return;
		const target = instance.state.doc.line(Math.max(1, Math.min(line, instance.state.doc.lines)));
		instance.dispatch({
			selection: { anchor: target.from },
			effects: EditorView.scrollIntoView(target.from, { y: 'center' }),
		});
		instance.focus();
	}
	const here = (): CodePlace | null => {
		const instance = view.current;
		if (!instance) return null;
		const head = instance.state.selection.main.head,
			line = instance.state.doc.lineAt(head);
		return { fileId: model.document.id, line: line.number, column: head - line.from + 1 };
	};
	async function openPlace(place: CodePlace) {
		const instance = view.current;
		if (place.fileId === model.document.id && instance) {
			const line = instance.state.doc.line(
				Math.max(1, Math.min(place.line, instance.state.doc.lines))
			);
			const anchor = line.from + Math.min(Math.max(0, place.column - 1), line.length);
			instance.dispatch({
				selection: { anchor },
				effects: EditorView.scrollIntoView(anchor, { y: 'center' }),
			});
			instance.focus();
			return;
		}
		try {
			await openTaskEditor(
				task,
				await window.brigadir.readEditorFile(task, place.fileId),
				place.line,
				place.column
			);
		} catch {
			const name = nameOf(place.fileId);
			if (name)
				fail('Could not open {file}.', name, () => {
					void openPlace(place);
				});
			else
				toastError(t(locale, 'Could not open the file.'), {
					action: {
						label: t(locale, 'Retry'),
						run: () => {
							void openPlace(place);
						},
					},
				});
		}
	}
	function go(location: CodeLocation) {
		const from = here();
		if (from) recordLocation(task, from);
		setLocations(null);
		void openPlace({ fileId: location.fileId, line: location.line, column: location.column });
	}
	const languageName =
		languageNames[session.status?.language ?? model.syntax?.language ?? ''] ??
		t(locale, 'Plain text');
	async function lookup(kind: 'definition' | 'references', pos: number) {
		await session.sync();
		const instance = view.current;
		if (!instance || !session.ready(instance.state.doc)) return;
		const request =
			kind === 'definition' ? window.brigadir.definitionCode : window.brigadir.referencesCode;
		// spec/editor-code-intelligence#definition-and-usages: the clicked word, read from the text the server was asked about.
		const line = instance.state.doc.lineAt(pos),
			word = codeWordAt(line.text, pos - line.from, syntaxLanguage(model.document.path)),
			fileId = model.document.id;
		const result = await request(task, fileId, session.version, pos).catch(() => null);
		if (!result || !mounted.current) return;
		// Already on the declaration: going to it would go nowhere, so ⌘+click, ⌘B and the menu show its references.
		if (
			kind === 'definition' &&
			word &&
			onDeclaration(result.locations, {
				fileId,
				line: line.number,
				from: word.from + 1,
				to: word.to + 1,
			})
		) {
			await lookup('references', pos);
			return;
		}
		if (kind === 'definition' && result.locations.length === 1) {
			if (result.source === 'fallback')
				setNotice(
					editing.languageServers
						? t(locale, 'Found by name: no language server for {language}.').replace(
								'{language}',
								languageName
							)
						: t(locale, 'Found by name: language servers are off.')
				);
			go(result.locations[0]!);
			return;
		}
		if (kind === 'definition' && !result.locations.length) {
			setNotice(t(locale, 'No definition found.'));
			return;
		}
		setLocations({ title: kind === 'definition' ? 'Go to definition' : 'References', result });
	}
	/** spec/editor#editor-context-menu: the native menu about the caret line or the selection; path items finish in main. */
	async function openMenu(atCaret: boolean) {
		const instance = view.current;
		if (!instance) return;
		const state = instance.state,
			selection = state.selection.main,
			line = state.doc.lineAt(selection.head),
			change = changeCommands.at(instance);
		const lines = selectedLines(state) ?? { start: line.number, end: line.number };
		const editable = !state.readOnly && !model.document.locked && !model.document.readOnly;
		const caret = atCaret ? instance.coordsAtPos(selection.head) : null;
		// spec/search-menus-and-commands#package-scripts: in a package.json, the top-level script on the caret line, read from the buffer.
		const script = isPackageJsonPath(model.document.path)
			? scriptAt(state.doc.toString(), selection.head)
			: null;
		const menu: EditorMenuState = {
			selection: !selection.empty,
			word: Boolean(
				codeWordAt(line.text, selection.head - line.from, syntaxLanguage(model.document.path))
			),
			change: Boolean(change),
			revert: Boolean(change?.revertable) && editable && gutterActions.canEdit(),
			editable,
			format: editable && !model.saving && !busy && !agentBusy && !model.conflict,
			comment: reviewMenu.current?.canComment(lines) ?? false,
			lines,
			at: caret ? { x: Math.max(0, caret.left), y: Math.max(0, caret.bottom) } : null,
			git: {
				history: Boolean(gitTarget()),
				commit: authorAt(state, line.number)?.kind === 'commit',
			},
			script: isPackageJsonPath(model.document.path) ? script !== null : null,
		};
		const action = await window.brigadir.editorMenu(task, model.document.id, menu).catch(() => {
			toastError(t(locale, 'Could not open the menu.'));
			return null;
		});
		if (!action || view.current !== instance) return;
		if (action === 'script-run' && script)
			void runScript(task, model.document.path, script, locale);
		else if (action === 'script-command' && script)
			void addScriptCommand(task, model.document.path, script, locale);
		else if (action === 'ask') reviewMenu.current?.ask(lines);
		else if (action === 'comment') reviewMenu.current?.comment(lines);
		else if (action === 'compose') reviewMenu.current?.compose(lines);
		else if (action === 'definition') actions.current.definition(selection.head);
		else if (action === 'references') actions.current.references(selection.head);
		else if (action === 'diff') {
			if (change) gutterActions.openDiff(change.hunk);
		} else if (action === 'revert') changeCommands.revert(instance, gutterActions);
		else if (action === 'toggle-comment') toggleComment(instance);
		else if (action === 'format') actions.current.format();
		else if (action === 'terminal') {
			const terminal = () => {
				void openTaskTerminal(task, model.document.id).catch(() =>
					toastError(t(locale, 'The terminal could not be opened.'), {
						action: { label: t(locale, 'Retry'), run: terminal },
					})
				);
			};
			terminal();
		} else if (action === 'history') openFileHistory();
		else if (action === 'line-commit') openLineCommit(authorAt(instance.state, line.number));
		if (
			action !== 'ask' &&
			action !== 'comment' &&
			action !== 'compose' &&
			action !== 'terminal' &&
			action !== 'diff' &&
			action !== 'history' &&
			action !== 'line-commit' &&
			action !== 'script-run' &&
			action !== 'script-command'
		)
			instance.focus();
	}
	// spec/composer-steering-queue-and-ghost#quick-question: «Apply» puts the agent's suggestion into this buffer as one transaction, so ⌘Z takes it back.
	const quickApply = useMemo<QuickApply>(
		() => ({
			lines: (start, end) => {
				const doc = model.state.doc;
				if (start < 1 || end > doc.lines || end < start) return null;
				return doc.sliceString(doc.line(start).from, doc.line(end).to);
			},
			replace: (start, end, text) => {
				const instance = view.current,
					doc = instance?.state.doc;
				if (
					!instance ||
					!doc ||
					model.document.locked ||
					model.document.readOnly ||
					model.conflict ||
					start < 1 ||
					end > doc.lines ||
					end < start
				)
					return false;
				instance.dispatch({
					changes: { from: doc.line(start).from, to: doc.line(end).to, insert: text },
					userEvent: 'input.quick',
					annotations: isolateHistory.of('full'),
					scrollIntoView: false,
				});
				return true;
			},
		}),
		[model]
	);
	actions.current = {
		save: () => {
			void save();
		},
		format: () => {
			void formatNow();
		},
		definition: (pos) => {
			void lookup('definition', pos);
		},
		references: (pos) => {
			void lookup('references', pos);
		},
		menu: (atCaret) => {
			void openMenu(atCaret);
		},
	};
	useLayoutEffect(() => {
		mounted.current = true;
		const instance = new EditorView({ state: model.state, parent: parent.current! });
		view.current = instance;
		model.live = instance;
		const unregisterContext = registerEditorView(task, model.document.id, instance);
		instance.dispatch({
			effects: model.wiring.reconfigure([
				// spec/composer-steering-queue-and-ghost#quick-question: ⌘I asks about the selection (or the caret line); above CodeMirror's own Mod-i (select parent syntax).
				Prec.high(
					keymap.of(
						editorKey('ask-agent', (current) => {
							const line = current.state.doc.lineAt(current.state.selection.main.head).number;
							reviewMenu.current?.ask(selectedLines(current.state) ?? { start: line, end: line });
							return true;
						})
					)
				),
				keymap.of([
					...editorKey('editor-save', () => {
						actions.current.save();
						return true;
					}),
					...editorKey('editor-find', (current) => focusFind(current, false)),
					...editorKey('editor-replace', (current) => focusFind(current, true)),
					// spec/editor#editor-chrome: while the panel is open, Find next / Find previous (⌘G / ⇧⌘G, F3 on a PC) step from the code
					// too and Esc closes it; the keys are the keymap's, like their Editor menu items (spec/search-menus-and-commands#menu-structure).
					...editorKey(
						'editor-find-next',
						(current) => searchPanelOpen(current.state) && findNext(current)
					),
					...editorKey(
						'editor-find-previous',
						(current) => searchPanelOpen(current.state) && findPrevious(current)
					),
					{ key: 'Escape', run: closeSearchPanel },
					{
						key: 'Shift-F10',
						run: () => {
							actions.current.menu(true);
							return true;
						},
					},
				]),
				// spec/editor#editor-context-menu: a right click outside the selection moves the caret there; inside, it keeps it. The default mousedown
				// would select the word under the pointer on macOS and silently change what a comment anchors to.
				EditorView.domEventHandlers({
					mousedown: (event, view) => {
						if (event.button !== 2 && !(event.button === 0 && event.ctrlKey)) return false;
						event.preventDefault();
						const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }),
							{ from, to } = view.state.selection.main;
						if (pos !== null && (from === to || pos < from || pos > to))
							view.dispatch({ selection: { anchor: pos } });
						view.focus();
						return true;
					},
					contextmenu: (event) => {
						event.preventDefault();
						actions.current.menu(false);
						return true;
					},
				}),
				editorTheme,
				findPanel(findHostApi),
				changeMap(locale),
				flashField,
				rawCarriageReturn(locale),
				conflictMarkers(locale),
				changeGutter(locale, gutterActions),
				lineAuthor(authorHost),
				EditorState.readOnly.of(model.document.locked || Boolean(model.document.readOnly)),
				EditorView.editable.of(!model.document.locked && !model.document.readOnly),
				codeIntel(session, {
					definition: (_view, pos) => actions.current.definition(pos),
					callParens: () => callParens.current,
				}),
				EditorView.contentAttributes.of({ 'aria-label': t(locale, 'File content') }),
				EditorState.phrases.of(
					Object.fromEntries(
						(
							[
								'Find',
								'Replace',
								'current match',
								'on line',
								'replaced match on line $',
								'replaced $ matches',
							] as const
						).map((key) => [key, t(locale, key)])
					)
				),
				EditorView.updateListener.of((update) => {
					const dirty = model.dirty;
					model.state = update.state;
					if (update.docChanged) model.notify();
					// The last result stays until the next parse: colors map through the edit, symbols wait for `syntaxDoc`.
					if (update.docChanged || update.selectionSet) setCard(null);
					if (update.docChanged) {
						clearTimeout(blameTimer.current);
						blameTimer.current = setTimeout(() => readBlame.current(), 200);
					}
					if (update.docChanged) {
						syntaxChanged.current();
						clearTimeout(gutterTimer.current);
						gutterTimer.current = setTimeout(() => readGutter.current(), 200);
						if (!update.transactions.some((tr) => tr.isUserEvent('format'))) setFormatStrip(null);
					}
					if (update.docChanged && dirty !== model.dirty) {
						void window.brigadir
							.setEditorDirty(task, model.document.id, model.dirty)
							.catch(() => {});
						changed();
					}
					if (markdownDoc) {
						if (update.docChanged) {
							clearTimeout(previewTimer.current);
							previewTimer.current = setTimeout(() => setPreviewText(model.text()), 150);
						}
						const open = searchPanelOpen(update.state),
							query = getSearchQuery(update.state),
							was = searchPanelOpen(update.startState);
						if (open !== was || !query.eq(getSearchQuery(update.startState))) {
							findQuery.current = open && query.valid && query.search ? query : null;
							setPreviewFind(
								findQuery.current
									? { pattern: findPattern(findQuery.current), current: null }
									: null
							);
						}
						// A match the code's search selected is shown in the preview: its block, then its order inside the block.
						if (
							findQuery.current &&
							update.transactions.some((tr) => tr.isUserEvent('select.search')) &&
							previewRoot.current
						) {
							const from = update.state.selection.main.from,
								line = update.state.doc.lineAt(from).number,
								start = previewBlockStart(previewRoot.current, line) ?? line;
							const pattern = findPattern(findQuery.current);
							const before =
								update.state.doc.sliceString(update.state.doc.line(start).from, from).match(pattern)
									?.length ?? 0;
							setPreviewFind({ pattern, current: { line, index: before } });
						}
						if (was && !open && viewNow.current === 'preview')
							previewRoot.current?.focus({ preventScroll: true });
					}
					if (update.selectionSet || update.docChanged) {
						const cursor = update.state.selection.main.head;
						const line = update.state.doc.lineAt(cursor);
						setPosition({ line: line.number, column: cursor - line.from + 1 });
						const selection = update.state.selection.main;
						// spec/diff-and-review#diff-selection: a match the find panel selected (next, previous, all) is not the person's
						// selection (nor a replace's) — no panel until they select code themselves.
						if (update.selectionSet)
							searchSelection.current = update.transactions.some(
								(transaction) =>
									transaction.isUserEvent('select.search') ||
									transaction.isUserEvent('input.replace')
							);
						setRange(
							selection.empty || searchSelection.current
								? null
								: {
										start: update.state.doc.lineAt(selection.from).number,
										end: update.state.doc.lineAt(Math.max(selection.from, selection.to - 1)).number,
									}
						);
					}
				}),
			]),
		});
		{
			const place = scrollHandover.get(model) ?? { top: model.scrollTop, left: model.scrollLeft };
			scrollHandover.delete(model);
			instance.scrollDOM.scrollTop = place.top;
			instance.scrollDOM.scrollLeft = place.left;
		}
		// spec/task-window-workspace#restore-window: the buffer knows its scroll at any moment, so a hot exit keeps it without asking the view.
		const keepScroll = () => {
			model.scrollTop = instance.scrollDOM.scrollTop;
			model.scrollLeft = instance.scrollDOM.scrollLeft;
		};
		instance.scrollDOM.addEventListener('scroll', keepScroll, { passive: true });
		// spec/editor#markdown-views, side by side: the preview follows the code's scroll and the code follows the preview's, one side leading at a time.
		const followCode = () => {
			if (viewNow.current !== 'side' || syncing.current === 'preview' || !previewRoot.current)
				return;
			syncing.current = 'code';
			scrollPreviewToLine(previewRoot.current, codeTopLine(instance));
			requestAnimationFrame(() => {
				if (syncing.current === 'code') syncing.current = null;
			});
		};
		instance.scrollDOM.addEventListener('scroll', followCode, { passive: true });
		const stopView = window.brigadir.onWorkspaceAction((action) => {
			if (
				action !== 'markdown-preview' ||
				!markdownDoc ||
				document.activeElement?.closest('dialog,[data-browser],[data-role="console"]')
			)
				return;
			setViewNow.current(viewNow.current === 'code' ? shownNow.current : 'code');
		});
		readGutter.current = () => {
			clearTimeout(gutterTimer.current);
			if (model.document.state !== 'text' || view.current !== instance) return;
			const doc = instance.state.doc;
			void window.brigadir.readEditorGutter(task, model.document.id, doc.toString()).then(
				(result) => {
					if (view.current !== instance) return;
					gutterTarget.current = result.state === 'ready' ? result.target : null;
					applyGutter(instance, result, doc);
				},
				() => {}
			);
		};
		readGutter.current();
		// spec/editor#line-author: an answer for an older buffer is dropped; the tail stays hidden until the answer for this one.
		readBlame.current = () => {
			clearTimeout(blameTimer.current);
			if (model.document.state !== 'text' || view.current !== instance) return;
			const doc = instance.state.doc;
			void window.brigadir.readEditorBlame(task, model.document.id, doc.toString()).then(
				(result) => {
					if (view.current !== instance || instance.state.doc !== doc) return;
					if (result !== blameOf(instance.state))
						instance.dispatch({ effects: setBlame.of(result) });
					setBlameState(result.state);
				},
				() => {}
			);
		};
		readBlame.current();
		const stop = window.brigadir.onEditorAction((action) => {
			const focused = document.activeElement;
			if (focused?.closest('[role=tree],[data-editor-selection]')) return;
			if (focused?.closest('dialog,textarea,input') && !instance.dom.contains(focused)) return;
			if (
				focused !== document.body &&
				document.querySelector('[data-columns="3"]') &&
				!parent.current?.closest('section')?.contains(focused)
			)
				return;
			if (action === 'save') actions.current.save();
			else if (action === 'undo') undo(instance);
			else if (action === 'redo') redo(instance);
			else if (action === 'indent') indentMore(instance);
			else if (action === 'outdent') indentLess(instance);
			else if (action === 'comment') toggleComment(instance);
			else if (action === 'format') actions.current.format();
			else if (action === 'definition')
				actions.current.definition(instance.state.selection.main.head);
			else if (action === 'references')
				actions.current.references(instance.state.selection.main.head);
			else if (action === 'completions') codeCommands.startCompletion(instance);
			else if (action === 'parameters') void showParameters(instance, session);
			else if (action === 'problem-next') codeCommands.nextDiagnostic(instance);
			else if (action === 'problem-previous') codeCommands.previousDiagnostic(instance);
			else if (action === 'change-next') changeCommands.next(instance);
			else if (action === 'change-previous') changeCommands.previous(instance);
			else if (action === 'change-revert') changeCommands.revert(instance, gutterActions);
			else if (action === 'history') openFileHistory();
			// spec/search-menus-and-commands#menu-structure: Editor ▸ Find next / Find previous / Replace all act as the open find panel's own buttons.
			else if (action === 'find-next' || action === 'find-previous') {
				if (!searchPanelOpen(instance.state)) return;
				if (action === 'find-next') findNext(instance);
				else findPrevious(instance);
			} else if (action === 'replace-all') {
				if (searchPanelOpen(instance.state) && replaceShown.current) replaceAll(instance);
			} else if (action === 'location-previous' || action === 'location-next') {
				const target = stepLocation(
					task,
					action === 'location-previous' ? 'back' : 'forward',
					here()
				);
				if (target) void openPlace(target);
			} else {
				if (action === 'replace' && viewNow.current === 'preview') setViewNow.current('code');
				focusFind(instance, action === 'replace');
			}
		});
		const stopStatus = session.onStatus(() => {
			if (mounted.current) {
				refresh((n) => n + 1);
				readFormatInfo();
				readIndentInfo();
			}
		});
		readFormatInfo();
		readIndentInfo();
		window.addEventListener(formattersChanged, readFormatInfo);
		const stopProblems = window.brigadir.onCodeProblems((event) => {
			if (
				event.key.id !== task.id ||
				event.key.projectId !== task.projectId ||
				event.fileId !== model.document.id
			)
				return;
			session.problems = { version: event.version, list: event.problems };
			applyProblems(instance, session);
		});
		const stopRestarted = window.brigadir.onCodeRestarted((keys) => {
			if (!keys.some((key) => key.id === task.id && key.projectId === task.projectId)) return;
			void session.reopen().then(() => {
				if (view.current === instance) applyProblems(instance, session);
			});
		});
		void session.sync().then(() => {
			if (view.current === instance) applyProblems(instance, session);
		});
		return () => {
			mounted.current = false;
			unregisterContext();
			stopView();
			instance.scrollDOM.removeEventListener('scroll', followCode);
			clearTimeout(previewTimer.current);
			clearTimeout(gutterTimer.current);
			readGutter.current = () => {};
			clearTimeout(blameTimer.current);
			clearTimeout(cardTimer.current);
			readBlame.current = () => {};
			stop();
			stopStatus();
			stopProblems();
			stopRestarted();
			window.removeEventListener(formattersChanged, readFormatInfo);
			model.state = instance.state.update({
				effects: [
					model.wiring.reconfigure([]),
					model.notes.reconfigure([]),
					model.selectionUI.reconfigure([]),
				],
			}).state;
			model.scrollTop = instance.scrollDOM.scrollTop;
			model.scrollLeft = instance.scrollDOM.scrollLeft;
			if (model.live === instance) model.live = null;
			instance.destroy();
			view.current = null;
		};
	}, [model, locale, model.document.locked]);
	useEffect(() => {
		readGutter.current();
	}, [diffBase]);
	// spec/editor#indentation: a changed answer reconfigures the open document; with no view yet (first mount) the state itself takes it.
	useLayoutEffect(() => {
		model.applyIndent(indentSettingsOf(indentChoice), indentProject);
	}, [
		model,
		indentProject,
		indentChoice?.indentStyle,
		indentChoice?.indentSize,
		indentChoice?.tabWidth,
	]);
	useLayoutEffect(() => {
		view.current?.dispatch({
			effects: model.typing.reconfigure(editorTyping(model.document.path, editing)),
		});
	}, [model, locale, model.document.locked, editing.closeBrackets, editing.closeTags]);
	// spec/chat#code-pills: the task's `wrap`, the same switch as the diff's.
	useLayoutEffect(() => {
		view.current?.dispatch({
			effects: model.wrapping.reconfigure(wrap ? EditorView.lineWrapping : []),
		});
	}, [model, wrap]);
	const serversOn = useRef(editing.languageServers);
	useEffect(() => {
		if (serversOn.current === editing.languageServers) return;
		serversOn.current = editing.languageServers;
		const instance = view.current;
		void session.sync().then(() => {
			if (instance && view.current === instance) applyProblems(instance, session);
		});
	}, [editing.languageServers]);
	const draftEnd = editorDraft?.fileId === model.document.id ? editorDraft.end : null;
	// spec/composer-steering-queue-and-ghost#quick-question: the open quick question keeps its lines' place even after the selection moves.
	const quickEnd =
		quickAsk?.surface === 'editor' && quickAsk.path === model.document.path ? quickAsk.end : null;
	const selectionEnd = quickEnd ?? draftEnd ?? range?.end ?? null;
	useLayoutEffect(() => {
		const instance = view.current;
		if (!instance) return;
		instance.dispatch({
			effects: model.selectionUI.reconfigure(
				selectionEnd === null ? [] : inlineSelection(instance.state, selectionHost, selectionEnd)
			),
		});
		if (draftEnd !== null) selectionHost.querySelector('textarea')?.focus({ preventScroll: true });
	}, [
		model,
		locale,
		model.document.locked,
		model.document.version,
		selectionHost,
		selectionEnd,
		draftEnd,
		quickEnd,
	]);
	useEffect(() => {
		// A commit made elsewhere moves a HEAD base without any event here, so focus asks for the gutter too.
		const focus = () => {
			void checkDisk();
			readGutter.current();
			readBlame.current();
		};
		window.addEventListener('focus', focus);
		const stop = onSessionEvent(({ key, record }) => {
			if (
				key.id === task.id &&
				key.projectId === task.projectId &&
				(!record || ['checkpoint.created', 'turn.completed'].includes(record.event.kind))
			) {
				void checkDisk();
				readGutter.current();
				readBlame.current();
			}
		});
		// Poll only the active document of a visible window, also covering editors outside this app; `focus` covers the return.
		const timer = setInterval(() => {
			if (!document.hidden) focus();
		}, 2000);
		return () => {
			stop();
			window.removeEventListener('focus', focus);
			clearInterval(timer);
		};
	}, [model, task.id, task.projectId, locale]);
	useEffect(() => {
		let active = true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let running = false;
		async function parse() {
			if (running) return;
			const doc = model.state.doc;
			if (model.syntaxDoc === doc && model.syntax) return;
			running = true;
			try {
				const result = await window.brigadir.readEditorSyntax(
					task,
					model.document.id,
					doc.toString()
				);
				if (active && model.state.doc === doc) {
					model.syntax = result;
					model.syntaxDoc = doc;
					view.current?.dispatch({ effects: setSyntax.of(result.tokens) });
					model.notify();
					repaint();
				}
			} catch {
				if (active && model.state.doc === doc) {
					model.syntax = { status: 'failed', language: null, tokens: [], symbols: [] };
					model.syntaxDoc = doc;
					view.current?.dispatch({ effects: setSyntax.of([]) });
					repaint();
				}
			} finally {
				running = false;
				if (active && model.state.doc !== doc)
					timer = setTimeout(() => {
						void parse();
					}, 180);
			}
		}
		syntaxChanged.current = () => {
			clearTimeout(timer);
			timer = setTimeout(() => {
				void parse().catch(() => {});
			}, 180);
		};
		syntaxChanged.current();
		return () => {
			active = false;
			clearTimeout(timer);
			syntaxChanged.current = () => {};
		};
	}, [model, task.id, task.projectId, model.document.version]);
	useLayoutEffect(() => {
		const instance = view.current,
			place = pendingPlace.current;
		pendingPlace.current = null;
		if (!instance) return;
		if (viewMode !== 'preview') instance.requestMeasure();
		if (!place) return;
		const root = previewRoot.current;
		if (place.to === 'code') placeCode(place.line);
		else if (root) {
			scrollPreviewToLine(root, place.line);
			if (place.to === 'preview') {
				flashPreviewLine(root, place.line);
				if (instance.hasFocus || document.activeElement === document.body)
					root.focus({ preventScroll: true });
			}
		}
	}, [viewMode]);
	// ⌥⌘F from the preview: the replace field shows once the switch to code commits, and after placeCode above has focused the code.
	const [replaceFocus, setReplaceFocus] = useState(0);
	useLayoutEffect(() => {
		if (replaceFocus) replaceField.current?.focus();
	}, [replaceFocus]);
	/** Side by side: the code follows the preview the person scrolls. */
	function followPreview() {
		const instance = view.current,
			root = previewRoot.current;
		if (viewNow.current !== 'side' || syncing.current === 'code' || !instance || !root) return;
		syncing.current = 'preview';
		const line = instance.state.doc.line(
			Math.max(1, Math.min(previewTopLine(root), instance.state.doc.lines))
		);
		instance.dispatch({ effects: EditorView.scrollIntoView(line.from, { y: 'start' }) });
		requestAnimationFrame(() =>
			requestAnimationFrame(() => {
				if (syncing.current === 'preview') syncing.current = null;
			})
		);
	}
	/** A menu command's key as the keymap spells it on this platform. */
	const keyOf = (id: string) => {
		const command = menuCommands.find((item) => item.id === id),
			key = command && commandAccelerator(command, shortcuts);
		return key ? formatAccelerator(key) : undefined;
	};
	const withKey = (label: string, key?: string) => (key ? `${label} · ${key}` : label);
	const findHint = withKey(t(locale, 'Find'), keyOf('editor-find'));
	const canReplace = !model.document.locked && !model.document.readOnly && viewMode !== 'preview';
	// Replace all from the menu acts only with the replace row on screen, where the replacement can be seen.
	replaceShown.current = canReplace && replaceOpen;
	const findInstance = findHost ? view.current : null;
	const viewHint = (label: string) => {
		const command = menuCommands.find((item) => item.id === 'markdown-preview'),
			key = command && commandAccelerator(command, shortcuts);
		return previewOff
			? t(locale, 'The file is too large for the preview')
			: key
				? `${label} · ${formatAccelerator(key)}`
				: label;
	};
	const viewOption = (
		value: MarkdownView['view'],
		label: string,
		glyph: 'code' | 'md-side' | 'md-preview'
	) => ({
		value,
		label,
		hint: value === 'side' && !previewOff ? label : viewHint(label),
		icon: (
			<>
				<span className={styles.viewIcon}>
					<Glyph name={glyph} size={14} />
				</span>
				<span className={styles.viewLabel}>{label}</span>
			</>
		),
	});
	const symbol =
		model.syntaxDoc === model.state.doc
			? enclosingSymbol(
					model.syntax?.symbols ?? [],
					range?.start ?? position.line,
					range?.end ?? position.line
				)
			: null;
	function selectSymbol() {
		if (symbol) {
			view.current?.dispatch({
				selection: { anchor: symbol.from, head: symbol.to },
				scrollIntoView: true,
			});
			view.current?.focus();
		}
	}
	return (
		<section
			className={styles.editor}
			data-font-surface="editor"
			data-markdown-view={markdownDoc ? viewMode : undefined}
			data-menu-save={
				!model.saving &&
				!busy &&
				!model.document.locked &&
				model.dirty &&
				!model.conflict &&
				!model.waiting
			}>
			<header data-size="s">
				<FilePath path={model.document.path} dirty={model.dirty} />
				{markdownDoc && (
					<Segments
						iconOnly
						className={styles.viewSwitch}
						disabled={previewOff}
						label={t(locale, 'Markdown view')}
						value={viewMode}
						onChange={(value) => setView(value as MarkdownView['view'])}
						options={[
							viewOption('code', t(locale, 'Code'), 'code'),
							viewOption('side', t(locale, 'Side by side'), 'md-side'),
							viewOption('preview', t(locale, 'Preview'), 'md-preview'),
						]}
					/>
				)}
				<IconButton
					label={t(locale, 'Select a declaration')}
					disabled={!symbol}
					onClick={selectSymbol}>
					<Glyph name="symbol" />
				</IconButton>
				<IconButton
					label={t(locale, 'Find')}
					hint={findHint}
					onClick={() => view.current && focusFind(view.current, false)}>
					<Glyph name="search" />
				</IconButton>
				{/* spec/chat#code-pills: line wrap, as in the diff header (spec/editor#line-wrap); one task value for both. */}
				<IconButton
					label={t(locale, 'Wrap lines')}
					disabled={viewMode === 'preview'}
					aria-pressed={wrap}
					onClick={() => setTask({ wrap: !wrap })}>
					<Glyph name="wrap" />
				</IconButton>
				<IconButton
					label={t(locale, agentBusy ? 'Save after the turn' : 'Save')}
					hint={
						agentBusy
							? t(locale, 'Save after the turn')
							: withKey(t(locale, 'Save'), keyOf('editor-save'))
					}
					disabled={
						model.saving ||
						busy ||
						model.document.locked ||
						!model.dirty ||
						Boolean(model.conflict) ||
						model.waiting
					}
					onClick={() => {
						void save();
					}}>
					<Glyph name="save" />
				</IconButton>
			</header>
			{model.queued && (
				<p className={styles.notice}>{t(locale, 'The save waits for the turn to end.')}</p>
			)}
			{model.document.locked && (
				<p className={styles.notice}>{t(locale, 'This file is open in another task.')}</p>
			)}
			{model.document.readOnly && (
				<p className={styles.notice}>{t(locale, 'This file is outside the project. Read only.')}</p>
			)}
			{model.document.large && (
				<p className={styles.notice}>{t(locale, 'Large file. Plain text mode.')}</p>
			)}
			{model.syntax?.status === 'failed' && (
				<p className={styles.notice}>
					{t(locale, 'Syntax highlighting is unavailable.')}{' '}
					<Button
						size="s"
						onClick={() => {
							model.syntaxDoc = null;
							syntaxChanged.current();
						}}>
						{t(locale, 'Retry')}
					</Button>
				</p>
			)}
			{model.syntax?.status === 'large' && !model.document.large && (
				<p className={styles.notice}>{t(locale, 'Syntax highlighting limit reached.')}</p>
			)}
			{formatStrip && (
				<p role="status" className={styles.notice} data-format-notice>
					{formatStrip.line
						? (() => {
								const [before, after] = formatStrip.text.split('{line}');
								return (
									<>
										{before}
										<button
											type="button"
											className={styles.noticeLink}
											onClick={() => goToLine(formatStrip.line!)}>
											{t(locale, 'line {line}').replace('{line}', String(formatStrip.line))}
										</button>
										{after}
									</>
								);
							})()
						: formatStrip.text}
				</p>
			)}
			{model.conflict && (
				<div role="alert" className={styles.notice}>
					{t(locale, 'This file changed on disk.')}{' '}
					<Button
						size="s"
						disabled={model.conflict.state !== 'text'}
						onClick={() => {
							model.replace(model.conflict!, view.current ?? undefined);
							setComparison(null);
							void session.sync();
							void window.brigadir.setEditorDirty(task, model.document.id, false);
							refreshMarks();
							rerender();
						}}>
						{t(locale, 'Reload')}
					</Button>{' '}
					<Button
						size="s"
						disabled={model.conflict.state !== 'text'}
						onClick={() => {
							model.keepMine(model.conflict!);
							setComparison(null);
							void window.brigadir
								.setEditorDirty(task, model.document.id, model.dirty)
								.catch(() => {});
							rerender();
						}}>
						{t(locale, 'Keep mine')}
					</Button>{' '}
					<Button
						size="s"
						onClick={() => {
							const compare = () => {
								void window.brigadir
									.compareEditorFile(task, model.document.id, model.text())
									.then(setComparison, () =>
										fail(
											'Could not compare {file} with the disk.',
											fileName(model.document.path),
											compare
										)
									);
							};
							compare();
						}}>
						{t(locale, 'Show diff')}
					</Button>
				</div>
			)}
			{comparison && (
				<section className={styles.comparison} aria-label={t(locale, 'Disk and buffer')}>
					<header>
						{t(locale, 'Disk and buffer')}{' '}
						<Button onClick={() => setComparison(null)}>{t(locale, 'Close')}</Button>
					</header>
					{comparison.tooLarge ? (
						<p>{t(locale, 'This file is too large to display.')}</p>
					) : (
						<Rows
							measurementKey={JSON.stringify(typography)}
							rows={comparison.lines.map((line, id) => ({ ...line, id: String(id) }))}
							label={t(locale, 'Disk and buffer')}
							followOutput={false}
							estimatedHeight={Math.round(typography.size * typography.lineHeight)}
							render={(line) => (
								<pre data-kind={line.kind}>
									{line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '} {line.text}
								</pre>
							)}
						/>
					)}
				</section>
			)}
			{markdownDoc ? (
				<div className={styles.markdownLayout} data-view={viewMode}>
					<div ref={parent} className={styles.mount} />
					{previewTokens && (
						<MarkdownPreview
							tokens={previewTokens}
							rowId={`preview:${model.document.id}`}
							path={model.document.path}
							task={task}
							locale={locale}
							label={t(locale, 'Preview')}
							scrollRef={previewRoot}
							onScroll={followPreview}
							onOpenLine={(line) => (viewMode === 'side' ? placeCode(line) : setView('code', line))}
							find={find}
						/>
					)}
				</div>
			) : (
				<div ref={parent} className={styles.mount} />
			)}
			<EditorReview
				menu={reviewMenu}
				quickApply={quickApply}
				focusEditor={() => view.current?.focus()}
				selectionStart={() => {
					const current = view.current;
					const at = current?.coordsAtPos(current.state.selection.main.from, 1);
					return at ? new DOMRect(at.left, at.top, 0, at.bottom - at.top) : null;
				}}
				clearSelection={() => {
					const instance = view.current;
					if (instance)
						instance.dispatch({ selection: { anchor: instance.state.selection.main.head } });
				}}
				selectionHost={selectionHost}
				onInlineNotes={(notes, edit, remove, resolve) => {
					view.current?.dispatch({
						effects: model.notes.reconfigure(
							inlineNotes(model.state, notes, locale, edit, remove, resolve)
						),
					});
				}}
				model={model}
				task={task}
				locale={locale}
				range={range}
				symbol={symbol}
				onReviewChanged={onReviewChanged}
				onCompose={onCompose}
			/>
			<footer>
				{position.line}:{position.column} · {model.document.lineEnding === '\r\n' ? 'CRLF' : 'LF'} ·{' '}
				{model.syntax?.status === 'ready'
					? languageNames[model.syntax.language!]
					: markdownDoc
						? languageNames.markdown
						: t(locale, 'Plain text')}
				{formatInfo?.onSave && formatInfo.source && (
					<span data-format-source title={t(locale, 'On save')}>
						{' '}
						· {t(locale, formatInfo.source === 'prettier' ? 'Prettier' : 'Language server')}
					</span>
				)}
				{blameState === 'none' && <span data-outside-git> · {t(locale, 'outside Git')}</span>}
				{notice && (
					<span role="status" className={styles.codeNotice}>
						{' '}
						· {notice}
					</span>
				)}
			</footer>
			{card && lineAuthorOn && (
				<LineAuthorCard
					locale={locale}
					author={card.author}
					anchor={card.anchor}
					bounds={card.bounds}
					message={message}
					onEnter={keepCard}
					onLeave={dropCard}
					onHistory={openFileHistory}
					onOpenCommit={() => openLineCommit(card.author)}
					onCopy={(sha) => {
						void window.brigadir.copyText(sha).then(
							() => setNotice(t(locale, 'Copied')),
							() => toastError(t(locale, 'Could not copy the commit hash.'))
						);
					}}
				/>
			)}
			{findInstance &&
				findHost &&
				createPortal(
					<FindPanel
						locale={locale}
						query={findSpec(findInstance.state)}
						count={findStatus(findInstance.state)}
						replace={
							canReplace
								? {
										open: replaceOpen,
										toggle: () => {
											setReplaceOpen(!replaceOpen);
											if (!replaceOpen) setReplaceFocus((value) => value + 1);
											else findField.current?.focus();
										},
									}
								: null
						}
						showReplaceKey={keyOf('editor-replace')}
						keymap={shortcuts}
						fieldRef={findField}
						replaceRef={replaceField}
						onQuery={(next) => setFind(findInstance, next)}
						onNext={() => findNext(findInstance)}
						onPrevious={() => findPrevious(findInstance)}
						onSelectAll={() => {
							if (selectMatches(findInstance)) findInstance.focus();
						}}
						onReplace={() => replaceNext(findInstance)}
						onReplaceAll={() => replaceAll(findInstance)}
						onClose={() => closeSearchPanel(findInstance)}
					/>,
					findHost
				)}
			{locations && (
				<CodeLocations
					title={locations.title}
					result={locations.result}
					languageName={languageName}
					locale={locale}
					open={go}
					close={() => {
						setLocations(null);
						view.current?.focus();
					}}
				/>
			)}
		</section>
	);
}
