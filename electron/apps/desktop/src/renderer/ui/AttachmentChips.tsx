import { DocumentDialog } from './DocumentDialog';
import { ImageViewer } from './ImageViewer';
import { Thumbnail, useThumbnail } from './Thumbnail';
import { onSessionEvent } from '../session-events';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
	t,
	attachmentLabel,
	attachmentLines,
	attachmentSize,
	type AgentTask,
	type TaskKey,
	type Locale,
	type PromptAttachment,
	type AttachmentInput,
} from '@brigadir/core';
import { openTaskEditor, useTaskState } from '../task-state';
import { useWorkspace } from '../store';
import { readSessionState } from '../session-read';
import { Button, IconButton } from './Controls';
import { Glyph } from './Glyph';
import { toastError } from './Toast';
import styles from './AttachmentChips.module.css';
/** spec/composer#island shelf above the composer, spec/terminal-and-cli-agents#cli-context above the CLI, spec/chat#images under the person's message in the log (`log`: no ×, the
 * message's own spacing). The queue keeps compact chips. Images open the window-wide viewer, text the document sheet. */
/** spec/chat#code-pills: a pill of lines opens its file in the task's editor with the lines selected; false leaves it to the sheet (the old
 *  side of a diff, a file that is gone or not found once, a sheet's draft with no task yet). */
async function openLines(owner: TaskKey, item: PromptAttachment) {
	const lines = attachmentLines(item),
		task = useWorkspace
			.getState()
			.workspace?.tasks.find(
				(entry) => entry.projectId === owner.projectId && entry.id === owner.id
			);
	if (!lines || lines.side !== 'new' || !task) return false;
	try {
		const [links] = await window.brigadir.readFileLinks(task, [
			{ text: `${lines.path}:${lines.start}`, literal: true },
		]);
		const link = links?.find((entry) => entry.from === 0 && !entry.folder);
		if (!link) return false;
		const document = await window.brigadir.readEditorFile(task, link.id);
		await openTaskEditor(task, document, lines.start, undefined, undefined, lines.end);
		return true;
	} catch {
		return false;
	}
}
/** Opening an attachment: an image in the window-wide viewer (with the message's other images), text in the document sheet. */
export function useAttachmentPreview(
	task: TaskKey,
	locale: Locale,
	attachments: readonly PromptAttachment[]
) {
	const [preview, setPreview] = useState<AttachmentInput | null>(null);
	const [viewer, setViewer] = useState<number | null>(null);
	const generation = useRef(0);
	useEffect(
		() => () => {
			generation.current++;
		},
		[]
	);
	const images = attachments.filter((item) => item.kind === 'image');
	async function open(item: PromptAttachment) {
		if (item.kind === 'image') {
			generation.current++;
			setViewer(images.findIndex((image) => image.id === item.id));
			return;
		}
		// spec/notifications-slack-notes-and-schedules#message-classes: a failed open is a toast with the attachment's name, not a line under the chips.
		const request = ++generation.current;
		if (await openLines(task, item)) return;
		if (request !== generation.current) return;
		try {
			const input = await window.brigadir.readAttachment(task, item.id);
			if (request === generation.current) setPreview(input);
		} catch {
			if (request === generation.current) {
				const name = attachmentLabel(locale, item);
				toastError(t(locale, 'Could not open {file}.').replace('{file}', name), {
					bold: name,
					action: {
						label: t(locale, 'Retry'),
						run: () => {
							void open(item);
						},
					},
				});
			}
		}
	}
	const dialogs = (
		<>
			{preview && (
				<DocumentDialog
					title={attachmentLabel(locale, { kind: preview.kind, name: preview.name })}
					locale={locale}
					close={() => setPreview(null)}>
					<pre>{preview.kind === 'text' ? preview.text : ''}</pre>
				</DocumentDialog>
			)}
			{viewer !== null && viewer >= 0 && (
				<ImageViewer
					task={task}
					locale={locale}
					images={images}
					index={viewer}
					close={() => setViewer(null)}
				/>
			)}
		</>
	);
	return { open, dialogs };
}
export function AttachmentChips({
	task,
	locale,
	attachments,
	onRemove,
	shelf = false,
	log = false,
	spaced = false,
	description,
}: {
	task: TaskKey;
	locale: Locale;
	attachments: PromptAttachment[];
	onRemove?: (id: string) => void;
	shelf?: boolean;
	/** spec/chat#images: tiles in a sent message. */ log?: boolean;
	/** spec/chat#images: the message has text above the tiles. */ spaced?: boolean;
	/** spec/terminal-and-cli-agents#cli-context: what the shelf is for, read by VoiceOver instead of a visible caption. */ description?: string;
}) {
	const { open, dialogs } = useAttachmentPreview(task, locale, attachments);
	if (shelf || log)
		return (
			<>
				{attachments.length > 0 && (
					<div
						className={log ? styles.log : styles.shelf}
						data-attachments
						data-spaced={(log && spaced) || undefined}
						aria-label={t(locale, 'Attachments')}
						{...(description ? { 'aria-description': description } : {})}>
						{attachments.map((item) => (
							<AttachmentTile
								key={item.id}
								task={task}
								locale={locale}
								item={item}
								open={() => {
									void open(item);
								}}
								{...(onRemove && !log ? { remove: () => onRemove(item.id) } : {})}
							/>
						))}
					</div>
				)}
				{dialogs}
			</>
		);
	return (
		<>
			{attachments.length > 0 && (
				<div className={styles.chips} data-attachments aria-label={t(locale, 'Attachments')}>
					{attachments.map((item) => {
						const label = attachmentLabel(locale, item);
						return (
							<span key={item.id} className={styles.chip} data-size="s">
								<Button
									size="s"
									variant="ghost"
									className={styles.open}
									title={label}
									onClick={() => {
										void open(item);
									}}>
									<Glyph name={item.kind === 'image' ? 'camera' : 'file'} size={12} />
									<span className={styles.name}>
										<bdi>{label}</bdi>
									</span>
								</Button>
								{onRemove && (
									<IconButton
										size="s"
										className={styles.remove}
										label={`${t(locale, 'Remove attachment')}: ${label}`}
										onClick={() => onRemove(item.id)}>
										<Glyph name="close" size={10} />
									</IconButton>
								)}
							</span>
						);
					})}
				</div>
			)}
			{dialogs}
		</>
	);
}
/** A path splits into a bold file name (with its `:12-34` range) and the folder under it; other text shows its size. */
export function tileParts(name: string): { base: string; range: string; folder: string } {
	const match = /^(.*?)(:\d+(?:-\d+)?)?$/.exec(name)!,
		path = match[1] ?? name,
		slash = path.lastIndexOf('/');
	return {
		base: slash >= 0 ? path.slice(slash + 1) : path,
		range: match[2] ?? '',
		folder: slash >= 0 ? path.slice(0, slash + 1) : '',
	};
}
function AttachmentTile({
	task,
	locale,
	item,
	open,
	remove,
}: {
	task: TaskKey;
	locale: Locale;
	item: PromptAttachment;
	open(): void;
	remove?: () => void;
}) {
	const thumb = useThumbnail(task, item),
		label = attachmentLabel(locale, item);
	const { base, range, folder } = tileParts(item.name),
		bytes = attachmentSize(item),
		size = new Intl.NumberFormat(locale, {
			style: 'unit',
			unit: bytes < 1024 * 1024 ? 'kilobyte' : 'megabyte',
			maximumFractionDigits: 1,
		}).format(bytes / (bytes < 1024 * 1024 ? 1024 : 1024 * 1024));
	const state =
			item.kind !== 'image'
				? undefined
				: thumb.failed
					? 'missing'
					: thumb.src
						? undefined
						: 'loading',
		title = state === 'missing' ? `${label} · ${t(locale, 'could not be opened')}` : label;
	return (
		<span
			className={styles.tile}
			data-kind={item.kind}
			data-attachment-id={item.id}
			data-state={state}>
			<button
				type="button"
				className={styles.tileOpen}
				title={title}
				aria-label={title}
				onClick={open}>
				{item.kind === 'image' ? (
					<span className={styles.thumb}>
						{thumb.src ? (
							<Thumbnail src={thumb.src} />
						) : (
							thumb.failed && <Glyph name="image-off" size={14} />
						)}
					</span>
				) : (
					<>
						<span className={styles.tileIcon}>
							<Glyph name={range ? 'code' : 'file'} size={13} />
						</span>
						<span className={styles.tileText}>
							<bdi className={styles.tileName}>
								{base}
								{range && <span className={styles.range}>{range}</span>}
							</bdi>
							<small>{folder || size}</small>
						</span>
					</>
				)}
			</button>
			{remove && (
				<IconButton
					size="s"
					appearance="neutral"
					variant="solid"
					className={styles.tileRemove}
					label={`${t(locale, 'Remove attachment')}: ${label}`}
					onClick={remove}>
					<Glyph name="close" size={9} />
				</IconButton>
			)}
		</span>
	);
}
export function CliAttachments({
	task,
	locale,
	notices,
}: {
	task: AgentTask;
	locale: Locale;
	/** spec/notifications-slack-notes-and-schedules#notice-chips: a CLI task has no composer — its class S chips stand in this shelf. */ notices?: ReactNode;
}) {
	const [{ attachments }, setTask] = useTaskState(task);
	useEffect(() => {
		let active = true;
		let request = 0;
		const refresh = () => {
			const id = ++request;
			void readSessionState(task).then(
				(snapshot) => {
					if (active && id === request && snapshot.connected)
						setTask({ attachments: snapshot.pendingAttachments ?? [] });
				},
				() => {}
			);
		};
		refresh();
		const stop = onSessionEvent(({ key, record }) => {
			if (key.id === task.id && key.projectId === task.projectId) {
				if (record?.event.kind === 'turn.started') {
					const ids = record.event.attachments?.map((item) => item.id) ?? [];
					setTask((state) => ({
						attachments: state.attachments.filter((item) => !ids.includes(item.id)),
					}));
				} else if (record?.event.kind === 'session.started') refresh();
			}
		});
		return () => {
			active = false;
			stop();
		};
	}, [task.id, task.projectId]);
	async function remove(id: string) {
		try {
			await window.brigadir.sendCommand(task, { kind: 'removeContext', id });
			setTask((state) => ({ attachments: state.attachments.filter((item) => item.id !== id) }));
		} catch {
			toastError(t(locale, 'Could not remove the attachment.'), {
				action: {
					label: t(locale, 'Retry'),
					run: () => {
						void remove(id);
					},
				},
			});
		}
	}
	// spec/terminal-and-cli-agents#cli-context: the same shelf as the composer's, without a caption; the tiles already say what goes into the next prompt.
	return (
		<div className={styles.cli}>
			<AttachmentChips
				shelf
				task={task}
				locale={locale}
				attachments={attachments}
				description={t(locale, 'Context attached to your next CLI prompt.')}
				onRemove={(id) => {
					void remove(id);
				}}
			/>
			{notices && (
				<div className={styles.cliNotices} data-cli-notices>
					{notices}
				</div>
			)}
		</div>
	);
}
