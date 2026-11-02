import { shortcutHint } from './ui/shortcut-hint';
import { fontFamily, useSurfaceFont } from './typography';
import { holdDiffSelection, registerDiffView } from './context-sources';
import { AttributionContent } from './ui/AttributionContent';
import {
	heldDiffSelection,
	sameSelection,
	useLiveDiffSelection,
	type DiffSelection,
} from './diff-selection';
import { selectionCaption, lineSpan, type CodeMark } from './code-selection';
import { markRanges, paintMarks } from './code-highlight';
import { FilePath } from './ui/FilePath';
import { Glyph } from './ui/Glyph';
import { DiffCode, DiffFold } from './ui/DiffCode';
import codeStyles from './ui/DiffCode.module.css';
import { createPortal } from 'react-dom';
import { lineTokens } from './syntax';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { MarkdownPreview, type PreviewFind } from './MarkdownPreview';
import { markdownDiffTokens } from './markdown-view';
import { PanelSearch } from './ui/PanelSearch';
import {
	quickAskSelection,
	isMarkdownPath,
	menuCommands,
	commandAccelerator,
	formatAccelerator,
	defaultKeymap,
	attributionRangeForLine,
	isAttributionRange,
	codeWordAt,
	syntaxLanguage,
	type AttributionRange,
	enclosingSymbol,
	t,
	type MessageKey,
	type Attribution,
	type FileDiff,
	type DiffLine,
	type Locale,
	type AgentTask,
	type ReviewSnapshot,
	type PRThread,
	type PRDraft,
	type PRSummarySpot,
} from '@brigadir/core';
import { useTaskState, rowPosition } from './task-state';
import { useWorkspace } from './store';
import { SelectionActions, SelectionFloat, CommentDraft, CommentCard } from './ui/ReviewControls';
import { QuickAskPopover } from './QuickAsk';
import {
	anchorKey,
	askQuick,
	forgetQuick,
	useAskShortcut,
	useQuickAsk,
	type QuickAnchor,
} from './quick-ask-store';
import quickStyles from './QuickAsk.module.css';
import { Button, IconButton, Segments } from './ui/Controls';
import { Rows } from './ui/Rows';
import { toastError } from './ui/Toast';
import {
	diffRows,
	editorLines,
	lineAt,
	noExpansion,
	prRows,
	sourceLine,
	unfolded,
	type Row,
} from './diff-rows';
import styles from './DiffView.module.css';
import {
	PRThreadCard,
	PRDraftCard,
	PRNewComment,
	PRSpotCard,
	type PRDiffActions,
} from './PRThreads';
import { ChangeCounts } from './ui/ChangeCounts';
import { primaryKey } from './ui/primary-key';
/** spec/editor-code-intelligence#diff-cmd-click: the UTF-16 column under the pointer within the clicked code line, or null outside it. */
function diffColumn(event: { clientX: number; clientY: number; currentTarget: HTMLElement }) {
	const text = event.currentTarget.querySelector<HTMLElement>('[data-code-line]');
	const caret = document.caretPositionFromPoint?.(event.clientX, event.clientY);
	if (!text || !caret || !text.contains(caret.offsetNode)) return null;
	const range = document.createRange();
	range.setStart(text, 0);
	range.setEnd(caret.offsetNode, caret.offset);
	return range.toString().length + 1;
}
export type PRDiff = {
	threads: PRThread[];
	drafts: PRDraft[];
	actions: PRDiffActions;
	/** spec/appearance#evolution-redesign: the agent summary's markers on this file's lines (the review modal). */ summary?:
		| {
				spots: PRSummarySpot[];
				/** The PR head moved past the summary: the markers are dim. */ stale: boolean;
				dismiss(spot: PRSummarySpot): void;
				/** After «Comment on it» opened the new comment on the lines: the host moves to its step. */ commented?(): void;
		  }
		| undefined;
};
export function DiffView({
	diff,
	locale,
	task,
	comments: taskComments,
	pr,
	highlight = null,
	banner = null,
	head = null,
	onReviewChanged,
	onCompose,
	onOpenEditor,
	onDefinition,
	onRevert,
	onJumpToSource,
	canOpenEditor = true,
}: {
	pr?: PRDiff | undefined;
	/** A line under the file header: where the file was opened from (the PR summary, a PR definition). */ banner?: ReactNode;
	/** spec/appearance#evolution-redesign: a compact file header of the host (the review modal's 32 px row) in place of the own header and sides line; a function gets the layout controls to place. */ head?:
		ReactNode | ((layout: ReactNode) => ReactNode);
	highlight?: { side: 'old' | 'new'; start: number; end: number } | null;
	canOpenEditor?: boolean;
	diff: FileDiff;
	locale: Locale;
	task: AgentTask;
	comments: ReviewSnapshot['comments'];
	onReviewChanged(): Promise<void>;
	onCompose(
		text: string,
		focus?: boolean,
		immediate?: boolean,
		name?: string,
		after?: string
	): Promise<boolean>;
	onOpenEditor(line?: number): void;
	/** spec/editor#reopen-closed-tab: F4 where the diff's own editor target is not the file (a PR file with a local copy); by default the editor. */
	onJumpToSource?: ((line?: number) => void) | undefined;
	onDefinition?: ((line: number, column: number, text: string) => void) | undefined;
	onRevert(): void;
}) {
	const typography = useSurfaceFont('diff');
	const shortcuts = useWorkspace((state) => state.appearance.keymap) ?? defaultKeymap;
	const advance = useMemo(() => {
		const canvas = document.createElement('canvas'),
			context = canvas.getContext('2d')!;
		context.font = `${typography.size}px ${fontFamily(typography)}`;
		return Math.ceil(context.measureText('M').width);
	}, [typography]);
	const [
		{
			reviewTarget,
			diffLineTarget,
			changeRange,
			whyFile,
			positions,
			diffExpanded,
			mode: chosenMode,
			wrap,
			commentDraft,
			diffPreview,
			quickAsk,
		},
		setTask,
	] = useTaskState(task);
	const setMode = (mode: string) => setTask({ mode });
	// spec/pull-requests-and-ci#pr-definition: a PR file without changes is every line context — one column, nothing folded.
	const mode = diff.unchanged ? 'unified' : chosenMode;
	const expandKey = `${diff.file.scopeId}/${diff.file.path}/${mode}`;
	const expanded = diff.unchanged ? unfolded : (diffExpanded.get(expandKey) ?? noExpansion);
	const setExpanded = (update: (current: ReadonlySet<string>) => Set<string>) => {
		const next = new Map(diffExpanded);
		next.set(expandKey, update(expanded));
		setTask({ diffExpanded: next });
	};
	const comments = useMemo(
		() => (pr ? prRows({ ...pr, spots: pr.summary?.spots }, diff.file, diff.lines) : taskComments),
		[pr, taskComments, diff]
	);
	// spec/editor#markdown-views: a Markdown file also shows its changes rendered, the third view beside Unified and Side by side (one per task).
	const markdownDiff =
			isMarkdownPath(diff.file.path) && !diff.binary && !diff.tooLarge && !diff.file.gitlink,
		preview = markdownDiff && diffPreview;
	const rendered = useMemo(
		() => (preview ? markdownDiffTokens(diff.beforeText, diff.afterText, diff.lines) : null),
		[preview, diff]
	);
	const [findOpen, setFindOpen] = useState(false),
		[findText, setFindText] = useState(''),
		[findIndex, setFindIndex] = useState(0),
		[findCount, setFindCount] = useState(0);
	const previewFind = useMemo<PreviewFind | null>(() => {
		const text = findText.trim();
		return findOpen && text
			? {
					pattern: new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
					current: { global: findIndex },
				}
			: null;
	}, [findOpen, findText, findIndex]);
	useEffect(() => {
		if (!preview) setFindOpen(false);
	}, [preview]);
	useEffect(
		() =>
			window.brigadir.onEditorAction((action) => {
				if (
					action === 'find' &&
					preview &&
					!document.activeElement?.closest(
						'dialog,[data-role="console"],[data-menu-tree],[data-activity]'
					)
				) {
					setFindOpen(true);
					setFindIndex(0);
				}
			}),
		[preview]
	);
	const [attribution, setAttribution] = useState<{
		data: Attribution;
		range: AttributionRange | null;
		left: number;
		top: number;
	} | null>(null);
	const explanation = useRef<HTMLDialogElement>(null),
		explanationRequest = useRef(0),
		header = useRef<HTMLElement>(null),
		explanationAnchor = useRef<HTMLElement | null>(null);
	async function explain(range?: AttributionRange | null, anchor?: HTMLElement) {
		const id = ++explanationRequest.current,
			rect = (anchor ?? header.current)?.getBoundingClientRect();
		explanationAnchor.current = anchor ?? header.current;
		const query = isAttributionRange(range) ? range : undefined;
		try {
			const data = await window.brigadir.readAttribution(task, diff.file.id, query);
			if (id === explanationRequest.current)
				setAttribution({
					data,
					range: query ?? null,
					left: Math.max(8, Math.min(rect?.left ?? 8, window.innerWidth - 428)),
					top: Math.max(8, Math.min(rect?.bottom ?? 80, window.innerHeight - 330)),
				});
		} catch {
			if (id === explanationRequest.current)
				toastError(t(locale, 'Could not read why this changed.'));
		}
	}
	function closeExplanation(restoreFocus = true) {
		explanationRequest.current++;
		setAttribution(null);
		if (restoreFocus && explanationAnchor.current?.isConnected)
			explanationAnchor.current.focus({ preventScroll: true });
	}
	useEffect(
		() => () => {
			explanationRequest.current++;
		},
		[]
	);
	useEffect(() => {
		if (!attribution) return;
		explanation.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
		const close = (event: PointerEvent) => {
			if (!explanation.current?.contains(event.target as Node)) closeExplanation(false);
		};
		const key = (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				event.preventDefault();
				closeExplanation();
			}
		};
		document.addEventListener('pointerdown', close);
		document.addEventListener('keydown', key);
		return () => {
			document.removeEventListener('pointerdown', close);
			document.removeEventListener('keydown', key);
		};
	}, [attribution]);
	useEffect(() => {
		if (whyFile === diff.file.id) {
			void explain();
			setTask({ whyFile: null });
		}
	}, [whyFile, diff.file.id]);
	const [hunkTarget, setHunkTarget] = useState<string | undefined>();
	useEffect(() => {
		if (
			reviewTarget &&
			comments.some((comment) => comment.id === reviewTarget && comment.position)
		) {
			setHunkTarget(`comment-${reviewTarget}`);
			setTask({ reviewTarget: null });
		}
	}, [reviewTarget, comments]);
	const [selection, setSelection] = useState<DiffSelection | null>(null);
	const [busy, setBusy] = useState(false);
	const syntax = useMemo(
		() => ({
			old: lineTokens(diff.beforeText, diff.beforeSyntax?.tokens ?? []),
			new: lineTokens(diff.afterText, diff.afterSyntax?.tokens ?? []),
		}),
		[diff]
	);
	const readOnly = Boolean(diff.baseLabel),
		reviewable = !readOnly || Boolean(pr);
	// spec/diff-and-review#open-in-editor: one landing rule for every way from a diff line into the editor; a removed line opens where its block stood.
	const editorLine = useMemo(() => editorLines(diff.lines), [diff]);
	const canOpenLine = canOpenEditor && !diff.file.gitlink && Boolean(diff.file.after);
	const draft = reviewable && commentDraft?.fileId === diff.file.id ? commentDraft : null;
	const range = selection ?? draft;
	// spec/editor#reopen-closed-tab: F4 opens the file at the line of the selection, the caret, the focused number or the top row on screen.
	const jumpToSource = onJumpToSource ?? (canOpenLine ? onOpenEditor : undefined);
	function jumpLine(): number | undefined {
		if (range) return sourceLine(diff.lines, range.side, range.start);
		const root = liveSelection.root.current;
		if (!root) return undefined;
		const cellOf = (node: Node | null) => {
			const at =
				node?.nodeType === Node.ELEMENT_NODE ? (node as Element) : (node?.parentElement ?? null);
			return (
				at?.closest<HTMLElement>('[data-code-line][data-side]') ??
				at?.closest('[data-kind]')?.querySelector<HTMLElement>('[data-code-line][data-side]') ??
				null
			);
		};
		const caret = window.getSelection(),
			anchor = caret?.rangeCount && root.contains(caret.anchorNode) ? caret.anchorNode : null,
			focused = root.contains(document.activeElement) ? document.activeElement : null;
		let cell = cellOf(anchor) ?? cellOf(focused);
		if (!cell) {
			const top =
				header.current?.getBoundingClientRect().bottom ?? root.getBoundingClientRect().top;
			cell =
				[...root.querySelectorAll<HTMLElement>('[data-code-line][data-side]')].find(
					(item) => item.getBoundingClientRect().bottom > top
				) ?? null;
		}
		const side = cell?.dataset.side,
			number = Number(cell?.dataset.codeLine);
		return (side === 'old' || side === 'new') && Number.isSafeInteger(number)
			? sourceLine(diff.lines, side, number)
			: undefined;
	}
	// spec/composer-steering-queue-and-ghost#quick-question: the quick question popover sits where the selection row stood; history and commit views have no task file to ask about.
	const quick =
		quickAsk?.surface === 'diff' && quickAsk.fileId === diff.file.id && !pr ? quickAsk : null;
	const quickAnchor: QuickAnchor | null = quick
		? {
				surface: 'diff',
				path: diff.file.path,
				side: quick.side,
				start: quick.start,
				end: quick.end,
			}
		: null;
	const quickThread = useQuickAsk((state) =>
		quickAnchor ? (state.threads[anchorKey(task, quickAnchor)] ?? null) : null
	);
	const askShortcut = useAskShortcut(),
		canAsk = !pr && !readOnly;
	type Lines = {
		side: 'old' | 'new';
		start: number;
		end: number;
		quote?: string | undefined;
		marks?: CodeMark[] | undefined;
	};
	/** spec/appearance#evolution-redesign: the selected text, or the whole lines of an anchor that has none (a comment being edited). */
	const quoteOf = (r: Lines) =>
		r.quote ??
		(r.side === 'old' ? diff.beforeText : diff.afterText)
			.split('\n')
			.slice(r.start - 1, r.end)
			.join('\n');
	const openQuick = (lines: Lines) => {
		window.getSelection()?.removeAllRanges();
		setTask({
			quickAsk: {
				surface: 'diff',
				path: diff.file.path,
				side: lines.side,
				start: lines.start,
				end: lines.end,
				fileId: diff.file.id,
				...(lines.quote !== undefined ? { quote: lines.quote } : {}),
				...(lines.marks ? { marks: lines.marks } : {}),
			},
		});
	};
	const rowRange = quick ?? range;
	/** «To composer» and «Hand to the agent»: a pill of these lines, then `after` in the composer text (spec/composer#mentions, spec/composer-steering-queue-and-ghost#quick-question). */
	const composeLines = (r: Lines, after?: string) =>
		onCompose(
			`Review ${JSON.stringify(diff.file.path)}, ${r.side} side, lines ${r.start}-${r.end}, snapshot ${r.side === 'old' ? diff.file.before : diff.file.after}.\n${r.quote !== undefined ? 'Selected text' : 'Selected code'}: ${JSON.stringify(quoteOf(r))}`,
			true,
			false,
			`${diff.file.path}:${r.start}-${r.end} · ${r.side}`,
			after
		);
	// spec/agents-and-providers#editor-state: what the agent reads stays after the person goes to the chat; a click in the diff or a clear drops it.
	const heldSelection = useRef<DiffSelection | null>(null);
	const hold = (next: DiffSelection | null) => {
		if (next === heldSelection.current) return;
		heldSelection.current = next;
		holdDiffSelection(task, contextSource.current.diff, next);
	};
	const clearSelection = () => {
		hold(null);
		setSelection(null);
	};
	const liveSelection = useLiveDiffSelection((next) => {
		hold(
			heldDiffSelection(
				next,
				heldSelection.current,
				liveSelection.root.current,
				window.getSelection()?.anchorNode ?? null
			)
		);
		setSelection((previous) => (sameSelection(previous, next) ? previous : next));
	});
	// spec/agents-and-providers#context-tools: the agent's `editor_state` reads the shown file, the selection and the rows on screen when it asks.
	const contextSource = useRef({ diff, root: liveSelection.root });
	contextSource.current = { diff, root: liveSelection.root };
	useEffect(() => {
		heldSelection.current = null;
	}, [diff.file.id]);
	useEffect(
		() =>
			registerDiffView(task, () => ({
				diff: contextSource.current.diff,
				root: contextSource.current.root.current,
			})),
		[task.projectId, task.id]
	);
	// spec/appearance#evolution-redesign: selection is text only; line marks are left for a landing (`highlight`, the PR definition crumb).
	const paintedRange = highlight;
	function dismissSelection() {
		window.getSelection()?.removeAllRanges();
		clearSelection();
	}
	// While a draft or the quick question holds the focus the native selection is gone; its characters stay painted.
	const heldMarks = quick?.marks ?? (selection ? undefined : draft?.marks);
	const painter = useRef({});
	useLayoutEffect(() => {
		const root = liveSelection.root.current;
		if (!root || !heldMarks?.length) return;
		return paintMarks(painter.current, root, heldMarks);
	}, [heldMarks]);
	/** spec/notifications-slack-notes-and-schedules#message-classes: a failed comment action is a toast that names it. */
	async function act(
		operation: () => Promise<void>,
		failure: MessageKey = 'Could not save the comment.'
	) {
		setBusy(true);
		try {
			await operation();
			await onReviewChanged();
		} catch {
			toastError(t(locale, failure));
		} finally {
			setBusy(false);
		}
	}
	const rows = useMemo(
		() =>
			diffRows(
				diff,
				mode,
				expanded,
				comments,
				rowRange?.side,
				rowRange?.end,
				Boolean(draft),
				draft?.editingId ?? null
			),
		[
			diff,
			mode,
			expanded,
			comments,
			rowRange?.side,
			rowRange?.end,
			Boolean(draft),
			draft?.editingId,
		]
	);
	// spec/editor#change-marks: «Open diff» from the editor peek: the first changed row at or after that buffer line; a removed row
	// stands just below the new line above it.
	useEffect(() => {
		if (diffLineTarget === null) return;
		let above = 0;
		const row = rows.find((row) => {
			if (row.comment || row.selection) return false;
			const own = (row.line ?? row.next)?.newLine ?? null;
			const changed = row.line
				? row.line.kind !== 'context'
				: row.old?.kind === 'removed' || row.next?.kind === 'added';
			const at = own ?? above + 1;
			if (own !== null) above = own;
			return changed && at >= diffLineTarget;
		});
		if (row) setHunkTarget(row.id);
		setTask({ diffLineTarget: null });
	}, [diffLineTarget, rows]);
	useEffect(
		() =>
			window.brigadir.onWorkspaceAction((action) => {
				if (
					document.activeElement?.closest(
						'dialog,textarea,input,[data-prompt],[data-browser],[data-activity],[data-role="console"]'
					)
				)
					return;
				if (action === 'next-block') action = 'diff-next';
				if (action === 'previous-block') action = 'diff-previous';
				if (action === 'diff-toggle') {
					if (preview) setTask({ diffPreview: false });
					else setMode(mode === 'unified' ? 'sbs' : 'unified');
				}
				if (action === 'markdown-preview' && markdownDiff) setTask({ diffPreview: !preview });
				if (action === 'diff-expand') setExpanded(() => new Set(['*']));
				if (action === 'diff-collapse') {
					setExpanded(() => new Set());
					setHunkTarget(undefined);
				}
				if (action === 'ask-agent' && canAsk && range && !quick) openQuick(range);
				if (action === 'diff-jump-to-source' && jumpToSource) jumpToSource(jumpLine());
				if (action === 'diff-comment' && reviewable && range && range.end - range.start < 100)
					setTask({
						commentDraft: {
							fileId: diff.file.id,
							...range,
							text: draft?.text ?? '',
							editingId: draft?.editingId ?? null,
						},
					});
				if (action === 'diff-next' || action === 'diff-previous') {
					const codeRows = rows.filter((row) => !row.comment && !row.selection);
					const starts = codeRows.filter((row, index) => {
						const changed = (row: Row | undefined) =>
							!!row &&
							(row.line
								? row.line.kind !== 'context'
								: row.old?.kind === 'removed' || row.next?.kind === 'added');
						return changed(row) && !changed(codeRows[index - 1]);
					});
					if (starts.length) {
						const index = starts.findIndex((row) => row.id === hunkTarget);
						setHunkTarget(
							starts[
								index < 0
									? action === 'diff-next'
										? 0
										: starts.length - 1
									: (index + (action === 'diff-next' ? 1 : starts.length - 1)) % starts.length
							]!.id
						);
					}
				}
			}),
		[
			mode,
			expanded,
			range,
			rows,
			hunkTarget,
			draft,
			preview,
			markdownDiff,
			quick,
			canAsk,
			jumpToSource,
		]
	);
	const previewHint = (() => {
		const command = menuCommands.find((item) => item.id === 'markdown-preview'),
			key = command && commandAccelerator(command, shortcuts);
		return key ? `${t(locale, 'Preview')} · ${formatAccelerator(key)}` : t(locale, 'Preview');
	})();
	const longest = useMemo(
		() => diff.lines.reduce((max, l) => Math.max(max, l.text.replace(/\t/g, '    ').length), 0),
		[diff]
	);
	const minWidth = wrap
		? 0
		: (mode === 'unified' ? 110 : 180) + longest * advance * (mode === 'unified' ? 1 : 2);
	function code(line: DiffLine | null, side: 'old' | 'new' | 'both') {
		const actualSide = side === 'both' ? (line?.kind === 'removed' ? 'old' : 'new') : side;
		const number = actualSide === 'old' ? line?.oldLine : line?.newLine;
		const target = canOpenLine ? editorLine(line) : undefined;
		return (
			<DiffCode
				line={line}
				tokens={syntax[actualSide].get(number ?? 0) ?? []}
				side={actualSide}
				locale={locale}
				onContextMenu={(event) => {
					if (readOnly) return;
					event.preventDefault();
					const node = event.currentTarget;
					void window.brigadir.fileMenu(task, diff.file.id, 'changes').then(
						(action) => {
							if (action === 'why' && number)
								void explain(attributionRangeForLine(diff.lines, actualSide, number), node);
							if (action === 'open' && target) onOpenEditor(target);
							if (action === 'revert') onRevert();
						},
						() => toastError(t(locale, 'Could not open the menu.'))
					);
				}}
				onMouseDown={(event) => {
					if (
						primaryKey(event) &&
						event.button === 0 &&
						!event.shiftKey &&
						!event.altKey &&
						actualSide === 'new' &&
						line?.newLine &&
						onDefinition
					) {
						const column = diffColumn(event);
						if (
							column !== null &&
							codeWordAt(line.text, column - 1, syntaxLanguage(diff.file.path))
						) {
							event.preventDefault();
							onDefinition(line.newLine, column, line.text);
						}
					}
				}}
				data-selected={Boolean(
					paintedRange &&
					paintedRange.side === actualSide &&
					number &&
					number >= paintedRange.start &&
					number <= paintedRange.end
				)}
				data-selection-start={Boolean(
					paintedRange && paintedRange.side === actualSide && number === paintedRange.start
				)}
				data-selection-end={Boolean(
					paintedRange && paintedRange.side === actualSide && number === paintedRange.end
				)}
				gutter={
					<>
						<button
							className={codeStyles.numbers}
							tabIndex={number ? 0 : -1}
							disabled={!number}
							aria-label={`${t(locale, 'Open in editor')} · ${actualSide}:${number ?? ''}`}
							title={target ? shortcutHint(locale, '⌘+click opens in editor') : undefined}
							onKeyDown={(event) => {
								if (event.key === 'Enter' && target) {
									event.preventDefault();
									onOpenEditor(target);
								}
							}}
							// spec/appearance#evolution-redesign: a number selects nothing; ⌘+click (Ctrl+click) and Enter open the editor (spec/diff-and-review#open-in-editor).
							onMouseDown={(event) => event.preventDefault()}
							onClick={(e) => {
								if ((e.metaKey || e.ctrlKey) && target) onOpenEditor(target);
							}}>
							{side === 'both' ? (
								<>
									<span>{line?.oldLine}</span>
									<span>{line?.newLine}</span>
								</>
							) : (
								number
							)}
						</button>
						{number && !readOnly && (
							<button
								className={styles.why}
								aria-label={`${t(locale, 'Why did this change?')} · ${actualSide}:${number}`}
								onClick={(event) => {
									void explain(
										attributionRangeForLine(diff.lines, actualSide, number),
										event.currentTarget
									);
								}}>
								?
							</button>
						)}
					</>
				}
			/>
		);
	}
	function annotation(row: Row) {
		if (row.comment && pr && row.comment.id.startsWith('pr-spot:')) {
			const key = row.comment.id.slice('pr-spot:'.length),
				spot = pr.summary?.spots.find((item) => item.key === key),
				summary = pr.summary,
				end = row.comment.position?.end ?? spot?.end ?? 0;
			if (!spot || !summary) return null;
			return (
				<PRSpotCard
					spot={spot}
					place={`${diff.file.path.split('/').at(-1)}:${lineSpan(spot.start, end)}`}
					locale={locale}
					stale={summary.stale}
					onDismiss={() => summary.dismiss(spot)}
					onComment={() => {
						// spec/appearance#evolution-redesign: the new comment of step 2 on the item's lines, its text to start from (spec/appearance#evolution-redesign flow).
						window.getSelection()?.removeAllRanges();
						clearSelection();
						setTask({
							commentDraft: {
								fileId: diff.file.id,
								side: 'new',
								start: spot.start,
								end,
								text: spot.text,
								editingId: null,
								fromSpot: true,
							},
						});
						summary.commented?.();
					}}
				/>
			);
		}
		if (row.comment && pr && row.comment.id.startsWith('pr-')) {
			const id = row.comment.id.slice(row.comment.id.indexOf(':') + 1);
			if (row.comment.id.startsWith('pr-thread:')) {
				const thread = pr.threads.find((item) => item.id === id);
				return thread ? (
					<PRThreadCard
						thread={thread}
						drafts={pr.drafts.filter((draft) => draft.replyTo === thread.comments[0]?.databaseId)}
						locale={locale}
						actions={pr.actions}
					/>
				) : null;
			}
			const item = pr.drafts.find((draft) => draft.id === id);
			return item ? (
				<PRDraftCard
					draft={item}
					locale={locale}
					actions={pr.actions}
					quote={{
						text: (item.side === 'LEFT' ? diff.beforeText : diff.afterText)
							.split('\n')
							.slice((item.startLine ?? item.line) - 1, item.line)
							.join('\n'),
						path: diff.file.path,
					}}
				/>
			) : null;
		}
		if (row.comment) {
			const comment = row.comment;
			return (
				<CommentCard
					comment={comment}
					locale={locale}
					sent={comment.sent}
					onResolve={() => {
						void act(
							() => window.brigadir.resolveComment(task, comment.id, !comment.resolved),
							'Could not update the comment.'
						);
					}}
					{...(comment.position ? { position: comment.position } : {})}
					onEdit={() => {
						clearSelection();
						setTask({
							commentDraft: {
								fileId: diff.file.id,
								side: comment.anchor.side,
								start: comment.position?.start ?? comment.anchor.start,
								end: comment.position?.end ?? comment.anchor.end,
								text: comment.text,
								editingId: comment.id,
								quote: comment.excerpt ?? comment.anchor.quote.join('\n'),
							},
						});
					}}
					onRemove={() => {
						void act(
							() => window.brigadir.removeComment(task, comment.id),
							'Could not delete the comment.'
						);
					}}
				/>
			);
		}
		if (row.selection && quick && quickAnchor) {
			const lines = quick.side === 'old' ? diff.beforeText : diff.afterText;
			return (
				<div className={quickStyles.anchor}>
					<QuickAskPopover
						key={quickThread?.id ?? 'new'}
						thread={quickThread}
						task={task}
						locale={locale}
						label={selectionCaption(
							diff.file.path.split('/').at(-1)!,
							quick.start,
							quick.end,
							quick.side
						)}
						quote={{ text: quoteOf(quick), path: diff.file.path }}
						onClose={() => {
							setTask({ quickAsk: null });
							liveSelection.root.current?.focus({ preventScroll: true });
						}}
						onNew={() => {
							if (quickThread) forgetQuick(quickThread);
						}}
						onAsk={(question, choice) => {
							void askQuick(
								task,
								quickAnchor,
								{
									...quickAskSelection(diff.file.path, quick.side, lines, quick.start, quick.end),
									...(quick.quote !== undefined ? { excerpt: quick.quote } : {}),
									scopeId: diff.file.scopeId,
								},
								question,
								locale,
								choice
							);
						}}
						onHand={(text) => {
							setTask({ quickAsk: null });
							void composeLines(quick, text);
						}}
						onViewDiff={(file, changeRange) =>
							setTask({
								quickAsk: null,
								changeRange,
								panel: 'changes',
								panelShown: true,
								filter: '',
								selected: `${file.scopeId}/${file.scopePath}`,
								surface: 'diff',
							})
						}
					/>
				</div>
			);
		}
		if (row.selection && range) {
			const symbol = enclosingSymbol(
				(range.side === 'old' ? diff.beforeSyntax : diff.afterSyntax)?.symbols ?? [],
				range.start,
				range.end
			);
			const panel = (
				<SelectionActions
					onAsk={
						canAsk
							? () =>
									openQuick({
										side: range.side,
										start: range.start,
										end: range.end,
										quote: range.quote,
										marks: range.marks,
									})
							: undefined
					}
					askShortcut={askShortcut}
					commentOpen={Boolean(draft)}
					onDismiss={dismissSelection}
					canComment={reviewable && range.end - range.start < 100}
					locale={locale}
					label={selectionCaption(
						symbol?.path ?? diff.file.path.split('/').at(-1)!,
						range.start,
						range.end,
						range.side
					)}
					onComment={() =>
						setTask({
							commentDraft: {
								fileId: diff.file.id,
								...range,
								text: commentDraft?.text ?? '',
								editingId: draft?.editingId ?? null,
								quote: range.quote ?? commentDraft?.quote,
							},
						})
					}
					onCompose={() => {
						void composeLines(range);
					}}
				/>
			);
			return (
				<>
					{draft ? (
						!draft.fromSpot && panel
					) : (
						<SelectionFloat
							start={() => {
								// The pill stands under the selection's first character.
								const root = liveSelection.root.current,
									first = range.marks?.[0];
								return root && first
									? (markRanges(root, [
											{ ...first, to: Math.max(first.to, first.from + 1) },
										])[0]?.getClientRects()[0] ?? null)
									: null;
							}}>
							{panel}
						</SelectionFloat>
					)}
					{draft && pr && (
						<PRNewComment
							range={{ side: draft.side, start: draft.start, end: draft.end }}
							initial={draft.text}
							quote={{ text: quoteOf(draft), path: diff.file.path }}
							locale={locale}
							actions={pr.actions}
							cancel={() => {
								setTask({ commentDraft: null });
								clearSelection();
							}}
						/>
					)}
					{draft && !pr && (
						<CommentDraft
							lines={`${lineSpan(draft.start, draft.end)}${draft.side === 'old' ? ' · old' : ''}`}
							quote={{ text: quoteOf(draft), path: diff.file.path }}
							editing={Boolean(draft.editingId)}
							terminal={task.transport === 'terminal'}
							onCompose={(focus) => {
								void act(async () => {
									const accepted = await onCompose(
										`Review ${JSON.stringify(diff.file.path)}, ${draft.side} side, lines ${draft.start}-${draft.end}.\nComment: ${draft.text}\n${draft.quote !== undefined ? 'Selected text' : 'Selected code'}: ${JSON.stringify(quoteOf(draft))}`,
										focus,
										true
									);
									if (accepted) {
										let cleared = false;
										setTask((state) => {
											cleared = state.commentDraft?.text === draft.text;
											return { commentDraft: cleared ? null : state.commentDraft };
										});
										if (cleared) clearSelection();
									}
								});
							}}
							locale={locale}
							text={draft.text}
							busy={busy}
							onText={(text) => setTask({ commentDraft: { ...draft, text } })}
							onCancel={() => {
								setTask({ commentDraft: null });
								clearSelection();
							}}
							onSave={() => {
								void act(async () => {
									if (draft.editingId)
										await window.brigadir.editComment(task, draft.editingId, draft.text);
									else
										await window.brigadir.addComment(task, {
											fileId: diff.file.id,
											side: draft.side,
											start: draft.start,
											end: draft.end,
											text: draft.text,
											...(draft.quote !== undefined ? { excerpt: draft.quote } : {}),
										});
									setTask({ commentDraft: null });
									clearSelection();
								});
							}}
						/>
					)}
				</>
			);
		}
		return null;
	}
	// spec/appearance#evolution-redesign: the layout controls (unified / side by side / preview, wrap) — one block for the own header and a host header.
	const layout = (
		<>
			{/* The diff mode is a setting of the document, not of the change list. */}
			<Segments
				iconOnly
				disabled={Boolean(diff.unchanged)}
				label={t(locale, 'Diff')}
				value={preview ? 'preview' : mode}
				options={[
					{
						value: 'unified',
						label: t(locale, 'Unified'),
						icon: <Glyph name="unified" size={14} />,
					},
					{
						value: 'sbs',
						label: t(locale, 'Side by side'),
						icon: <Glyph name="split" size={14} />,
					},
					...(markdownDiff
						? [
								{
									value: 'preview',
									label: t(locale, 'Preview'),
									hint: previewHint,
									icon: <Glyph name="md-preview" size={14} />,
								},
							]
						: []),
				]}
				onChange={(value) =>
					value === 'preview'
						? setTask({ diffPreview: true })
						: setTask({ mode: value, diffPreview: false })
				}
			/>
			{/* spec/editor#line-wrap: line wrap is a button in the file header. */}
			{/* An icon button like its neighbours; pressed — the accent tint. */}
			<IconButton
				label={t(locale, 'Wrap lines')}
				hint={t(locale, preview ? 'Lines always wrap in the preview' : 'Wrap lines')}
				disabled={preview}
				aria-pressed={wrap}
				onClick={() => setTask({ wrap: !wrap })}>
				<Glyph name="wrap" />
			</IconButton>
		</>
	);
	return (
		<section
			className={styles.diff}
			data-font-surface="diff"
			data-menu-diff-selection={!!range}
			data-menu-diff-source={!!jumpToSource}
			data-wrap={wrap}
			data-mode={mode}
			data-markdown-view={markdownDiff ? (preview ? 'preview' : 'code') : undefined}
			ref={liveSelection.root}
			onPointerDown={liveSelection.begin}>
			{commentDraft && !draft && (
				<p>
					{t(locale, 'Select lines again to attach this draft.')}{' '}
					<Button onClick={() => setTask({ commentDraft: null })}>{t(locale, 'Cancel')}</Button>
				</p>
			)}
			{head ? (
				<header ref={header} className={styles.hostHeader}>
					{typeof head === 'function' ? head(layout) : head}
				</header>
			) : (
				<header ref={header} className={styles.header}>
					<FilePath path={diff.file.path} />
					{diff.unchanged ? (
						<small>{t(locale, 'Unchanged in the PR')}</small>
					) : (
						<ChangeCounts
							additions={diff.file.additions}
							deletions={diff.file.deletions}
							locale={locale}
							className={styles.counts}
							split
						/>
					)}
					{diff.file.beforeMode !== diff.file.afterMode && (
						<small>
							{diff.file.beforeMode} → {diff.file.afterMode}
						</small>
					)}
					{diff.file.generated && <small>{t(locale, 'Generated file')}</small>}
					{layout}
					<IconButton
						label={t(locale, 'Open in editor')}
						disabled={!canOpenEditor || diff.file.gitlink || !diff.file.after}
						onClick={() => onOpenEditor()}>
						<Glyph name="editor" />
					</IconButton>
					<IconButton
						disabled={readOnly}
						label={t(locale, 'Why did this change?')}
						onClick={(event) => {
							void explain(null, event.currentTarget);
						}}>
						<Glyph name="why" />
					</IconButton>
					<IconButton
						label={t(locale, 'Revert file changes…')}
						disabled={readOnly || diff.binary || diff.tooLarge || diff.file.gitlink}
						onClick={onRevert}>
						<Glyph name="undo" size={14} />
					</IconButton>
				</header>
			)}
			{banner}
			{attribution &&
				createPortal(
					<dialog
						open
						ref={explanation}
						className={styles.attribution}
						style={{ left: attribution.left, top: attribution.top }}
						aria-label={t(locale, 'Why did this change?')}>
						<AttributionContent
							data={attribution.data}
							range={attribution.range}
							path={diff.file.path}
							locale={locale}
							close={() => closeExplanation()}
							goToTurn={(turn) => {
								closeExplanation(false);
								setTask({ focusTurn: turn, returnToDiff: true, surface: 'chat' });
							}}
						/>
					</dialog>,
					document.body
				)}

			{[diff.beforeSyntax, diff.afterSyntax].some((s) => s?.status === 'failed') && (
				<p>{t(locale, 'Syntax highlighting is unavailable.')}</p>
			)}
			{[diff.beforeSyntax, diff.afterSyntax].some((s) => s?.status === 'large') && (
				<p>{t(locale, 'Syntax highlighting limit reached.')}</p>
			)}
			{!head && (
				<div className={styles.sides}>
					<span>
						{diff.baseLabel ??
							(diff.head !== undefined
								? `HEAD ${diff.head?.slice(0, 7) ?? '∅'} · ${diff.file.before?.slice(0, 7) ?? '∅'}`
								: `${t(locale, changeRange && changeRange.base > 0 ? 'Base snapshot' : 'Before the task')}${changeRange ? ` #${changeRange.base}` : ''} · ${diff.file.before?.slice(0, 7) ?? '∅'}`)}
					</span>
					<span>
						{diff.afterLabel ?? t(locale, readOnly ? 'Commit preview' : 'Current snapshot')}
						{!readOnly && changeRange ? ` #${changeRange.current}` : ''} ·{' '}
						{diff.file.after?.slice(0, 7) ?? '∅'}
					</span>
				</div>
			)}
			{rendered ? (
				<>
					{findOpen && (
						<div
							className={styles.previewFind}
							onKeyDown={(event) => {
								if (event.key === 'Enter') {
									event.preventDefault();
									setFindIndex((index) => index + (event.shiftKey ? -1 : 1));
								}
							}}>
							<PanelSearch
								locale={locale}
								label={t(locale, 'Find')}
								value={findText}
								count={
									findCount
										? `${(((findIndex % findCount) + findCount) % findCount) + 1}/${findCount}`
										: '0'
								}
								onChange={(value) => {
									setFindText(value);
									setFindIndex(0);
								}}
								onClose={() => setFindOpen(false)}
							/>
						</div>
					)}
					<MarkdownPreview
						tokens={rendered.tokens}
						newFile={rendered.newFile}
						rowId={`diff-preview:${diff.file.id}`}
						path={diff.file.path}
						task={task}
						locale={locale}
						label={t(locale, 'Changes preview')}
						find={previewFind}
						onMatches={setFindCount}
					/>
				</>
			) : diff.binary || diff.tooLarge || diff.file.gitlink ? (
				<p className={styles.empty}>
					{t(
						locale,
						diff.file.gitlink
							? 'Submodule reference'
							: diff.binary
								? 'Binary file'
								: 'This file is too large to display.'
					)}
				</p>
			) : (
				<Rows
					measurementKey={JSON.stringify(typography)}
					locale={locale}
					onSearchOpen={() => setExpanded(() => new Set(['*']))}
					searchText={diffSearchText}
					targetId={hunkTarget}
					position={rowPosition(
						positions,
						`diff/${diff.file.scopeId}/${diff.file.path}/${mode}`,
						false
					)}
					key={mode}
					rows={rows}
					label={t(locale, 'Diff')}
					followOutput={false}
					estimatedHeight={Math.round(typography.size * typography.lineHeight)}
					minWidth={minWidth}
					render={(row) =>
						row.comment || row.selection ? (
							annotation(row)
						) : row.hidden ? (
							<DiffFold onClick={() => setExpanded((current) => new Set([...current, row.id]))}>
								{t(locale, 'Show unchanged lines')} · {row.hidden}
							</DiffFold>
						) : row.line ? (
							code(row.line, 'both')
						) : (
							<div className={styles.pair}>
								{code(row.old, 'old')}
								{code(row.next, 'new')}
							</div>
						)
					}
				/>
			)}
		</section>
	);
}

function diffSearchText(row: Row) {
	return (
		row.line?.text ?? [row.old?.text, row.next?.text, row.comment?.text].filter(Boolean).join('\n')
	);
}
