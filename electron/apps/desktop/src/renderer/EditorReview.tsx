import { createPortal } from 'react-dom';
import { onSessionEvent } from './session-events';
import { useEffect, useMemo, useState, type MutableRefObject } from 'react';
import {
	quickAskSelection,
	t,
	type AgentTask,
	type Locale,
	type MessageKey,
	type ReviewSnapshot,
	type SyntaxSymbol,
} from '@brigadir/core';
import { EditorModel } from './editor-model';
import { useTaskState, rowPosition } from './task-state';
import { SelectionActions, SelectionFloat, CommentDraft, CommentCard } from './ui/ReviewControls';
import { QuickAskPopover, type QuickApply } from './QuickAsk';
import {
	anchorKey,
	askQuick,
	forgetQuick,
	useAskShortcut,
	useQuickAsk,
	type QuickAnchor,
} from './quick-ask-store';
import quickStyles from './QuickAsk.module.css';
import { Rows } from './ui/Rows';
import { toastError } from './ui/Toast';
import styles from './CodeEditor.module.css';
import { lineSpan, selectionCaption } from './code-selection';
export type EditorRange = { start: number; end: number };
/** spec/editor#editor-context-menu: the selection panel's comment and composer actions for the editor menu, on any line range. */
export type ReviewMenu = {
	canComment(range: EditorRange): boolean;
	comment(range: EditorRange): void;
	compose(range: EditorRange): void;
	/** spec/composer-steering-queue-and-ghost#quick-question */ ask(range: EditorRange): void;
};
export function EditorReview({
	selectionHost,
	clearSelection,
	model,
	task,
	locale,
	range,
	symbol,
	onReviewChanged,
	onCompose,
	onInlineNotes,
	menu,
	quickApply,
	focusEditor,
	selectionStart,
}: {
	/** Canvas v3 5.8: where the selection starts on screen; the panel pill stands under it. */
	selectionStart?: () => DOMRect | null;
	quickApply: QuickApply;
	focusEditor(): void;
	menu: MutableRefObject<ReviewMenu | null>;
	selectionHost: HTMLElement;
	clearSelection(): void;
	model: EditorModel;
	task: AgentTask;
	locale: Locale;
	range: EditorRange | null;
	symbol: SyntaxSymbol | null;
	onReviewChanged(): Promise<void>;
	onCompose(
		text: string,
		focus?: boolean,
		immediate?: boolean,
		name?: string,
		after?: string
	): Promise<boolean>;
	onInlineNotes(
		notes: ReviewSnapshot['comments'],
		edit: (note: ReviewSnapshot['comments'][number]) => void,
		remove: (id: string) => void,
		resolve: (note: ReviewSnapshot['comments'][number]) => void
	): void;
}) {
	const [{ positions, editorDraft, quickAsk }, setTask] = useTaskState(task);
	const draft = editorDraft?.fileId === model.document.id ? editorDraft : null;
	// spec/composer-steering-queue-and-ghost#quick-question: the quick question popover on these lines; its thread outlives the popover in quick-ask-store.
	const quick =
		quickAsk?.surface === 'editor' && quickAsk.path === model.document.path ? quickAsk : null;
	const quickAnchor: QuickAnchor | null = quick
		? {
				surface: 'editor',
				path: model.document.path,
				side: 'new',
				start: quick.start,
				end: quick.end,
			}
		: null;
	const askShortcut = useAskShortcut();
	const quickThread = useQuickAsk((state) =>
		quickAnchor ? (state.threads[anchorKey(task, quickAnchor)] ?? null) : null
	);
	/** spec/appearance#evolution-redesign: the text selected in CodeMirror now, verbatim; none for a caret. */
	const selectedText = () => {
		const main = model.state.selection.main;
		return main.empty ? undefined : model.state.sliceDoc(main.from, main.to);
	};
	const openQuick = (lines: EditorRange) => {
		const quote = selectedText();
		setTask({
			editorDraft: draft && !draft.text.trim() ? null : editorDraft,
			quickAsk: {
				surface: 'editor',
				path: model.document.path,
				side: 'new',
				start: lines.start,
				end: lines.end,
				fileId: model.document.id,
				...(quote !== undefined ? { quote } : {}),
			},
		});
	};
	const closeQuickPopover = () => {
		setTask({ quickAsk: null });
		focusEditor();
	};
	useEffect(
		() =>
			window.brigadir.onWorkspaceAction((action) => {
				if (action === 'ask-agent' && range && !quick) openQuick(range);
			}),
		[range?.start, range?.end, quick, model.document.id]
	);
	const [review, setReview] = useState<ReviewSnapshot>({ comments: [] });
	const [available, setAvailable] = useState(false);
	/** The file is in no repo of the task: comments do not apply, whatever the buffer does. */
	const [outside, setOutside] = useState(false);
	const [busy, setBusy] = useState(false);
	const version = model.document.version;
	const dirty = model.dirty;
	const large = useMemo(
		() => new TextEncoder().encode(model.document.text).byteLength > 2 * 1024 * 1024,
		[version]
	);
	const selected = draft ?? range;
	async function load() {
		try {
			const next = await window.brigadir.readEditorReview(task, model.document.id, version);
			if (model.document.version === version && !model.dirty) {
				setReview(next && next !== 'outside' ? next : { comments: [] });
				setAvailable(next !== null && next !== 'outside');
				setOutside(next === 'outside');
			}
		} catch {
			setAvailable(false);
		}
	}
	useEffect(() => {
		let active = true;
		setAvailable(false);
		setReview({ comments: [] });
		if (!dirty)
			void window.brigadir.readEditorReview(task, model.document.id, version).then(
				(next) => {
					if (!active || model.dirty) return;
					setOutside(next === 'outside');
					if (next && next !== 'outside') {
						setReview(next);
						setAvailable(true);
					}
				},
				() => {}
			);
		const stop = onSessionEvent(({ key, record }) => {
			if (
				key.id === task.id &&
				key.projectId === task.projectId &&
				(!record ||
					['checkpoint.created', 'turn.started', 'turn.completed'].includes(record.event.kind))
			)
				void load();
		});
		return () => {
			active = false;
			stop();
		};
	}, [model, version, dirty, task.id, task.projectId]);
	/** spec/notifications-slack-notes-and-schedules#message-classes: a failed comment action is a toast that names it. */
	async function act(
		operation: () => Promise<void>,
		failure: MessageKey = 'Could not save the comment.'
	) {
		setBusy(true);
		try {
			await operation();
			await load();
			await onReviewChanged();
		} catch {
			toastError(t(locale, failure));
		} finally {
			setBusy(false);
		}
	}
	useEffect(() => {
		onInlineNotes(
			dirty ? [] : review.comments,
			(comment) =>
				setTask({
					editorDraft: {
						fileId: model.document.id,
						version,
						start: comment.position?.start ?? comment.anchor.start,
						end: comment.position?.end ?? comment.anchor.end,
						text: comment.text,
						editingId: comment.id,
						quote: comment.excerpt ?? comment.anchor.quote.join('\n'),
					},
				}),
			(id) => {
				void act(() => window.brigadir.removeComment(task, id), 'Could not delete the comment.');
			},
			(note) => {
				void act(
					() => window.brigadir.resolveComment(task, note.id, !note.resolved),
					'Could not update the comment.'
				);
			}
		);
	}, [review, dirty, version, locale]);
	const canAdd =
		available &&
		!dirty &&
		!model.conflict &&
		!model.saving &&
		(!draft || draft.version === version) &&
		Boolean(selected && selected.end - selected.start < 100);
	function compose(lines: EditorRange, after?: string, quote = selectedText()) {
		const start = model.state.doc.line(lines.start).from,
			end = model.state.doc.line(lines.end).to;
		// spec/appearance#evolution-redesign: the selected text verbatim goes beside the lines (a partial line stays partial).
		const selected = quote !== undefined ? `\nSelected text: ${JSON.stringify(quote)}` : '';
		return onCompose(
			model.dirty
				? `File ${JSON.stringify(model.document.path)}, lines ${lines.start}-${lines.end} (unsaved buffer).\nSelected code: ${JSON.stringify(model.state.sliceDoc(start, end))}${selected}`
				: `Read file @${JSON.stringify(model.document.path)}, lines ${lines.start}-${lines.end}.${selected}`,
			true,
			false,
			`${model.document.path}:${lines.start}-${lines.end}`,
			after
		);
	}
	// An open draft keeps its text: the menu does not replace it, as the panel's Comment does not.
	menu.current = {
		ask: openQuick,
		canComment: (lines) =>
			available &&
			!model.dirty &&
			!model.conflict &&
			!model.saving &&
			!draft &&
			lines.end - lines.start < 100,
		comment: (lines) =>
			setTask({
				editorDraft: {
					fileId: model.document.id,
					version,
					start: lines.start,
					end: lines.end,
					text: '',
					editingId: null,
					quote: selectedText(),
				},
			}),
		compose: (lines) => {
			void compose(lines);
		},
	};
	const selectionPanel = selected && (
		<>
			<SelectionActions
				onAsk={() => openQuick(selected)}
				askShortcut={askShortcut}
				commentOpen={Boolean(draft)}
				onDismiss={clearSelection}
				locale={locale}
				label={selectionCaption(
					symbol?.path ?? model.document.path.split('/').at(-1)!,
					selected.start,
					selected.end
				)}
				canComment={canAdd}
				onComment={() => {
					if (!draft)
						setTask({
							editorDraft: {
								fileId: model.document.id,
								version,
								start: selected.start,
								end: selected.end,
								text: '',
								editingId: null,
								quote: selectedText(),
							},
						});
				}}
				onCompose={() => {
					void compose(selected);
				}}
			/>
			{!canAdd && !draft?.editingId && (
				<p>
					{t(
						locale,
						outside
							? 'This file is outside the task repos.'
							: large
								? 'This file is too large for review.'
								: selected.end - selected.start >= 100
									? 'Select up to 100 lines for a comment.'
									: 'Save or refresh the file to add a comment.'
					)}
				</p>
			)}
		</>
	);
	/** spec/appearance#evolution-redesign: the selected text, or the whole lines when there is none. */
	const quickQuote = () => {
		if (!quick) return '';
		if (quick.quote !== undefined) return quick.quote;
		const doc = model.state.doc,
			from = Math.max(1, Math.min(quick.start, doc.lines)),
			to = Math.max(from, Math.min(quick.end, doc.lines));
		return doc.sliceString(doc.line(from).from, doc.line(to).to);
	};
	const quickLabel = quick
		? selectionCaption(model.document.path.split('/').at(-1)!, quick.start, quick.end)
		: '';
	return (
		<>
			{quick && quickAnchor
				? createPortal(
						<div className={styles.annotation}>
							<div className={quickStyles.anchor}>
								<QuickAskPopover
									key={quickThread?.id ?? 'new'}
									thread={quickThread}
									task={task}
									locale={locale}
									label={quickLabel}
									quote={{ text: quickQuote(), path: model.document.path }}
									apply={quickApply}
									onClose={closeQuickPopover}
									onNew={() => {
										if (quickThread) forgetQuick(quickThread);
									}}
									onAsk={(question, choice) => {
										void askQuick(
											task,
											quickAnchor,
											{
												...quickAskSelection(
													model.document.path,
													'new',
													model.state.doc.toString(),
													quick.start,
													quick.end
												),
												...(quick.quote !== undefined ? { excerpt: quick.quote } : {}),
											},
											question,
											locale,
											choice
										);
									}}
									onHand={(text) => {
										setTask({ quickAsk: null });
										void compose({ start: quick.start, end: quick.end }, text, quick.quote);
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
						</div>,
						selectionHost
					)
				: selected &&
					createPortal(
						<div className={styles.annotation}>
							{draft ? (
								selectionPanel
							) : (
								<SelectionFloat start={selectionStart}>{selectionPanel}</SelectionFloat>
							)}
							{draft && (
								<CommentDraft
									lines={lineSpan(draft.start, draft.end)}
									quote={{
										text:
											draft.quote ??
											model.state.doc
												.toString()
												.split('\n')
												.slice(draft.start - 1, draft.end)
												.join('\n'),
										path: model.document.path,
									}}
									editing={Boolean(draft.editingId)}
									terminal={task.transport === 'terminal'}
									onCompose={(focus) => {
										void act(async () => {
											const start = model.state.doc.line(
													Math.min(draft.start, model.state.doc.lines)
												).from,
												end = model.state.doc.line(Math.min(draft.end, model.state.doc.lines)).to;
											const accepted = await onCompose(
												`File ${JSON.stringify(model.document.path)}, lines ${draft.start}-${draft.end}${dirty ? ' (unsaved buffer)' : ''}.\nComment: ${draft.text}\nSelected code: ${JSON.stringify(model.state.sliceDoc(start, end))}${draft.quote !== undefined ? `\nSelected text: ${JSON.stringify(draft.quote)}` : ''}`,
												focus,
												true
											);
											if (accepted)
												setTask((state) => ({
													editorDraft:
														state.editorDraft?.text === draft.text ? null : state.editorDraft,
												}));
										}, 'Could not send the message.');
									}}
									locale={locale}
									text={draft.text}
									busy={busy || (!draft.editingId && !canAdd)}
									onText={(text) => setTask({ editorDraft: { ...draft, text } })}
									onCancel={() => setTask({ editorDraft: null })}
									onSave={() => {
										void act(async () => {
											if (draft.editingId)
												await window.brigadir.editComment(task, draft.editingId, draft.text);
											else
												await window.brigadir.addEditorComment(task, {
													fileId: draft.fileId,
													version: draft.version,
													start: draft.start,
													end: draft.end,
													text: draft.text,
													...(draft.quote !== undefined ? { excerpt: draft.quote } : {}),
												});
											setTask({ editorDraft: null });
											clearSelection();
										});
									}}
								/>
							)}
						</div>,
						selectionHost
					)}
			{review.comments.some((comment) => comment.position?.state === 'outdated') && (
				<div className={styles.notes}>
					<Rows
						position={rowPosition(positions, `notes/${model.document.id}`, false)}
						role="list"
						label={t(locale, 'File comments')}
						rows={review.comments.filter((comment) => comment.position?.state === 'outdated')}
						followOutput={false}
						estimatedHeight={100}
						render={(comment) => (
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
								onRemove={() => {
									void act(
										() => window.brigadir.removeComment(task, comment.id),
										'Could not delete the comment.'
									);
								}}
								onEdit={() =>
									setTask({
										editorDraft: {
											fileId: model.document.id,
											version,
											start: comment.position?.start ?? comment.anchor.start,
											end: comment.position?.end ?? comment.anchor.end,
											text: comment.text,
											editingId: comment.id,
											quote: comment.excerpt ?? comment.anchor.quote.join('\n'),
										},
									})
								}
							/>
						)}
					/>
				</div>
			)}
		</>
	);
}
