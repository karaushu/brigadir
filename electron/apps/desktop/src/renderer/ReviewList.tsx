import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
	reviewFiles,
	commentCount,
	t,
	type ReviewFile,
	type ReviewPosition,
	type AgentTask,
	type ChangesSnapshot,
	type Locale,
	type MessageKey,
	type ReviewSnapshot,
} from '@brigadir/core';
import { useTaskState, rowPosition } from './task-state';
import { Rows } from './ui/Rows';
import { Button, IconButton } from './ui/Controls';
import { Glyph } from './ui/Glyph';
import { CommentCard, CommentDraft } from './ui/ReviewControls';
import controls from './ui/ReviewControls.module.css';
import styles from './ReviewList.module.css';
import { ChangeCounts } from './ui/ChangeCounts';
import { listStep } from './ui/list-keys';
export function ReviewList({
	task,
	locale,
	review,
	changes,
	projectName,
	reload,
	openFile,
}: {
	task: AgentTask;
	locale: Locale;
	review: ReviewSnapshot;
	changes: ChangesSnapshot | null;
	projectName: string;
	reload(): Promise<void>;
	openFile(scopeId: string, path: string, id: string, line: number): void;
}) {
	const [{ positions, commentDraft }, setTask] = useTaskState(task);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<MessageKey | null>(null);
	/** spec/notifications-slack-notes-and-schedules#message-classes T*: the list sits in a modal dialog where a toast is not seen; the line names the failed action and goes with the next one. */
	async function act(work: () => Promise<unknown>, failure: MessageKey) {
		setBusy(true);
		setError(null);
		try {
			await work();
			await reload();
		} catch {
			setError(failure);
		} finally {
			setBusy(false);
		}
	}
	const pendingFocus = useRef<string | null>(null);
	const [selected, setSelected] = useState<string>(),
		[jumpTarget, setJumpTarget] = useState<string>();
	const groups = reviewFiles(review, changes).groups;
	const selectable = groups.flatMap((group) => group.files);
	const rows = [
		...(review.notes ?? []).map((comment) => ({ id: comment.id, kind: 'note' as const, comment })),
		...groups.flatMap((group) => [
			{ id: `scope-${group.id}`, kind: 'scope' as const, group },
			...group.files.map((file) => ({ id: file.id, kind: 'file' as const, file })),
		]),
	];
	function card(
		comment: NonNullable<ReviewSnapshot['notes']>[number] | ReviewSnapshot['comments'][number]
	) {
		const anchor = 'anchor' in comment ? comment.anchor : null;
		if (commentDraft?.editingId === comment.id)
			return (
				<CommentDraft
					key={comment.id}
					locale={locale}
					text={commentDraft.text}
					busy={busy}
					editing
					quote={
						'anchor' in comment
							? {
									text: comment.excerpt ?? comment.anchor.quote.join('\n'),
									path: comment.anchor.path,
								}
							: undefined
					}
					onText={(text) => setTask({ commentDraft: { ...commentDraft, text } })}
					onCancel={() => setTask({ commentDraft: null })}
					onSave={() => {
						void act(async () => {
							await window.brigadir.editComment(task, comment.id, commentDraft.text);
							setTask({ commentDraft: null });
						}, 'Could not save the comment.');
					}}
				/>
			);
		const edit = () =>
			setTask({
				commentDraft: {
					fileId: 'review',
					side: anchor?.side ?? 'new',
					start: anchor?.start ?? 1,
					end: anchor?.end ?? 1,
					text: comment.text,
					editingId: comment.id,
				},
			});
		const resolve = () => {
			void act(
				() => window.brigadir.resolveComment(task, comment.id, !comment.resolved),
				'Could not update the comment.'
			);
		};
		const remove = () => {
			void act(
				() => window.brigadir.removeComment(task, comment.id),
				'Could not delete the comment.'
			);
		};
		if ('anchor' in comment)
			return (
				<CommentCard
					key={comment.id}
					comment={comment}
					locale={locale}
					sent={comment.sent}
					{...(comment.position ? { position: comment.position } : {})}
					onEdit={edit}
					onRemove={remove}
					onResolve={resolve}
				/>
			);
		return (
			<article key={comment.id} className={controls.comment} data-size="s">
				<header>
					<span>{t(locale, 'General note')}</span>
					{comment.sent && <small>{t(locale, comment.resolved ? 'Resolved' : 'Sent')}</small>}
					{comment.sent && (
						<Button disabled={busy} onClick={resolve}>
							{t(locale, comment.resolved ? 'Reopen' : 'Resolve')}
						</Button>
					)}
					<IconButton label={t(locale, 'Edit comment')} disabled={busy} onClick={edit}>
						<Glyph name="edit" />
					</IconButton>
					<IconButton label={t(locale, 'Remove comment')} disabled={busy} onClick={remove}>
						<Glyph name="close" />
					</IconButton>
				</header>
				<p>{comment.text}</p>
			</article>
		);
	}
	if (!rows.length)
		return (
			<div className={styles.empty} role="status">
				<strong>{t(locale, 'No review comments yet')}</strong>
				<p>{t(locale, 'Select lines in the editor or diff to add a comment.')}</p>
			</div>
		);
	return (
		<div className={styles.list}>
			{error && <p role="alert">{t(locale, error)}</p>}
			<Rows
				maxHeight={408}
				targetId={jumpTarget}
				position={rowPosition(positions, 'review', false)}
				rows={rows}
				label={t(locale, 'Review')}
				followOutput={false}
				estimatedHeight={100}
				render={(row) => {
					if (row.kind === 'note') return card(row.comment);
					if (row.kind === 'scope')
						return (
							<h3 className={styles.scope}>
								{row.group.scope
									? row.group.scope.kind === 'root' && row.group.scope.name === '.'
										? projectName
										: row.group.scope.name
									: t(locale, 'Unknown repository')}
								<small>{row.group.scope?.branch}</small>
								<span className={styles.scopeCount}>{row.group.files.length}</span>
							</h3>
						);
					return (
						<PositionedFile
							task={task}
							file={row.file}
							revision={review}
							checkpoint={changes?.checkpoint ?? null}>
							{(file, unavailable) => {
								const first = file.comments[0]!,
									outdated = file.comments.some(
										(comment) => comment.position?.state === 'outdated'
									);
								const open = () =>
									openFile(
										file.scopeId,
										file.path,
										first.id,
										first.position?.start ?? first.anchor.start
									);
								return (
									<article
										className={styles.file}
										data-size="s"
										data-selected={(selected ?? selectable[0]?.id) === file.id}>
										<header>
											<button
												ref={(node) => {
													if (node && pendingFocus.current === file.id) {
														pendingFocus.current = null;
														node.focus();
													}
												}}
												className={styles.open}
												onFocus={() => setSelected(file.id)}
												aria-label={file.path}
												onClick={open}
												onKeyDown={(event) => {
													if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
													event.preventDefault();
													const index = selectable.findIndex((item) => item.id === file.id),
														step = listStep(event.key, index, selectable.length),
														next = step === null ? undefined : selectable[step];
													if (next) {
														pendingFocus.current = next.id;
														setSelected(next.id);
														setJumpTarget(next.id);
													}
												}}>
												<Glyph name="file" size={14} />
												<span>
													<strong>{file.path.split('/').at(-1)}</strong>
													<small>
														{file.path.includes('/')
															? file.path.slice(0, file.path.lastIndexOf('/'))
															: ''}
													</small>
												</span>
											</button>
											<IconButton
												size="s"
												label={`${t(locale, 'Remove file comments')}: ${file.path}`}
												disabled={busy}
												onClick={() => {
													void act(
														() =>
															window.brigadir.removeReviewSelection(
																task,
																file.comments.map(({ id, version }) => ({ id, version }))
															),
														'Could not remove the file comments.'
													);
												}}>
												<Glyph name="trash" />
											</IconButton>
											<span className={styles.badge} data-outdated={outdated}>
												{t(locale, outdated ? 'Outdated' : file.change ? 'Diff' : 'Editor')}
											</span>
										</header>
										{unavailable && (
											<small role="status">{t(locale, 'Comment location is unavailable.')}</small>
										)}
										<p className={styles.preview}>{first.text}</p>
										<div className={styles.meta}>
											<span>
												{commentCount(locale, file.comments.length)} ·{' '}
												{file.comments
													.map((comment) =>
														comment.anchor.start === comment.anchor.end
															? String(comment.anchor.start)
															: `${comment.anchor.start}–${comment.anchor.end}`
													)
													.join(', ')}
											</span>
											{file.change && (
												<ChangeCounts
													additions={file.change.additions}
													deletions={file.change.deletions}
													locale={locale}
													tone={(selected ?? selectable[0]?.id) === file.id ? 'inherit' : 'state'}
													split
												/>
											)}
										</div>
										<details>
											<summary>{t(locale, 'Show comments')}</summary>
											{file.comments.map(card)}
										</details>
									</article>
								);
							}}
						</PositionedFile>
					);
				}}
			/>
		</div>
	);
}

function PositionedFile({
	task,
	file,
	revision,
	checkpoint,
	children,
}: {
	task: AgentTask;
	file: ReviewFile;
	revision: ReviewSnapshot;
	checkpoint: number | null;
	children(file: ReviewFile, unavailable: boolean): ReactNode;
}) {
	const [result, setResult] = useState<{
			revision: ReviewSnapshot;
			signature: string;
			positions: ReviewPosition[];
		} | null>(null),
		[failed, setFailed] = useState(false);
	const signature = `${checkpoint}/${file.change?.id ?? file.id}`;
	const first = file.comments[0]!.id;
	useEffect(() => {
		let active = true;
		setFailed(false);
		void window.brigadir.readReviewPositions(task, first).then(
			(positions) => {
				if (active) setResult({ revision, signature, positions });
			},
			() => {
				if (active) setFailed(true);
			}
		);
		return () => {
			active = false;
		};
	}, [task.id, task.projectId, first, revision, signature]);
	const positions =
		result?.revision === revision && result.signature === signature ? result.positions : [];
	const comments = file.comments.map((comment) => {
		const found = positions.find(
			(item) => item.id === comment.id && item.version === comment.version
		);
		if (!found) return comment;
		const { position, ...rest } = comment;
		return found.position ? { ...rest, position: found.position } : rest;
	});
	return children(
		{ ...file, comments },
		failed || positions.some((item) => item.position === null)
	);
}
