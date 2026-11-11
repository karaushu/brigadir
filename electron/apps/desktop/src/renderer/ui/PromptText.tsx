import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
	attachmentLabel,
	attachmentMention,
	promptParts,
	type AgentTask,
	type Locale,
	type PromptAttachment,
	type PromptToken,
} from '@brigadir/core';
import { useWorkspace } from '../store';
import { MarkdownBlock } from '../MarkdownBlock';
import { userMarkdown, type UserMarkdownEnv } from '../markdown';
import type { FindCommands } from '../mention-editor';
import { AttachmentChips, useAttachmentPreview } from './AttachmentChips';
import { Glyph } from './Glyph';
import { Thumbnail, useThumbnail } from './Thumbnail';
import styles from './PromptText.module.css';

/**
 * spec/composer#mentions: the person's message in the log with the same pills and thumbnails the composer showed. A pill of a file opens
 * the document, a thumbnail the viewer; attachments the text does not place stay tiles under it (spec/chat#images).
 * spec/composer#formatting: the text is Markdown, rendered as an answer is (lists, code, bold, links); a pill or a thumbnail stands where its token was
 * typed, in the paragraph or the list item, as a portal into the slot the renderer left there.
 */
export function PromptText({
	task,
	locale,
	text,
	rowId,
	revision = 0,
	attachments = [],
	commands,
}: {
	task: AgentTask;
	locale: Locale;
	text: string;
	rowId: string;
	revision?: number;
	attachments?: readonly PromptAttachment[];
	/** spec/composer#slash-highlight: the known `/` names, marked as in the composer. */ commands?:
		FindCommands | undefined;
}) {
	const parts = useMemo(() => promptParts(text), [text]);
	const placed = new Set(
		parts.flatMap((part) =>
			part.kind === 'token' && part.token.kind === 'attachment' ? [part.token.id] : []
		)
	);
	const tasks = useWorkspace((state) => state.workspace?.tasks);
	const { open, dialogs } = useAttachmentPreview(task, locale, attachments);
	const rest = attachments.filter((item) => !placed.has(item.id));
	const parsed = useMemo(() => {
		const tokens = userMarkdown.parse(text, {}),
			env: UserMarkdownEnv = { ...(commands ? { commands } : {}), className: styles.command ?? '' };
		return { tokens, html: userMarkdown.renderer.render(tokens, userMarkdown.options, env) };
	}, [text, commands]);
	// The slots the renderer left in the markup; the markup is replaced as links resolve and code highlights, so they are read again whenever it changes.
	const box = useRef<HTMLDivElement>(null),
		[slots, setSlots] = useState<HTMLElement[]>([]);
	useLayoutEffect(() => {
		const root = box.current;
		if (!root) return;
		const scan = () =>
			setSlots((current) => {
				const found = [...root.querySelectorAll<HTMLElement>('[data-prompt-token]')];
				return found.length === current.length &&
					found.every((node, index) => node === current[index])
					? current
					: found;
			});
		scan();
		const observer = new MutationObserver(scan);
		observer.observe(root, { childList: true, subtree: true });
		return () => observer.disconnect();
	}, []);
	const piece = (token: PromptToken, key: string): ReactNode => {
		if (token.kind === 'model')
			return (
				<span
					key={key}
					className={styles.pill}
					data-kind="model"
					title={`${token.model} · ${token.provider === 'claude' ? 'Claude' : 'Codex'}`}>
					<Glyph name={token.provider === 'claude' ? 'claude' : 'openai'} size={10} />
					<span>{token.model}</span>
				</span>
			);
		if (token.kind === 'task') {
			const item = (tasks ?? []).find((entry: AgentTask) => entry.id === token.id);
			return (
				<span key={key} className={styles.pill} data-kind="task">
					<Glyph name={item?.crew ? 'helmet' : 'person'} size={10} />
					<span>{item?.title ?? token.id}</span>
				</span>
			);
		}
		const item = attachments.find((entry) => entry.id === token.id);
		if (!item) return null;
		const label = attachmentLabel(locale, item);
		if (item.kind === 'image')
			return (
				<InlineImage
					key={key}
					task={task}
					item={item}
					label={label}
					open={() => {
						void open(item);
					}}
				/>
			);
		const mention = attachmentMention(item),
			owner =
				mention.kind === 'task'
					? (tasks ?? []).find(
							(entry: AgentTask) =>
								entry.projectId === task.projectId && entry.title === mention.label
						)
					: null;
		return (
			<button
				key={key}
				type="button"
				className={styles.pill}
				data-kind={mention.kind}
				title={item.name}
				onClick={() => {
					void open(item);
				}}>
				<Glyph
					name={
						mention.kind === 'task'
							? owner?.crew
								? 'helmet'
								: 'person'
							: mention.kind === 'agent'
								? 'person'
								: mention.kind === 'text'
									? 'code'
									: mention.kind === 'folder'
										? 'folder'
										: 'file'
					}
					size={10}
				/>
				<span>{mention.label}</span>
			</button>
		);
	};
	return (
		<>
			<div ref={box} className={styles.text} data-prompt-text>
				<MarkdownBlock
					rowId={rowId}
					html={parsed.html}
					tokens={parsed.tokens}
					locale={locale}
					task={task}
					revision={revision}
					className={styles.markdown}
				/>
			</div>
			{slots.map((node, index) => {
				const token = promptParts(node.dataset.promptToken ?? '').find(
					(part) => part.kind === 'token'
				);
				return token?.kind === 'token'
					? createPortal(
							piece(token.token, `${index}`),
							node,
							`${index}:${node.dataset.promptToken}`
						)
					: null;
			})}
			{rest.length > 0 && (
				<AttachmentChips
					log
					spaced={Boolean(text.trim())}
					task={task}
					locale={locale}
					attachments={rest}
				/>
			)}
			{dialogs}
		</>
	);
}
function InlineImage({
	task,
	item,
	label,
	open,
}: {
	task: AgentTask;
	item: PromptAttachment;
	label: string;
	open(): void;
}) {
	const thumb = useThumbnail(task, item);
	return (
		<button
			type="button"
			className={styles.image}
			data-attachment-id={item.id}
			data-state={thumb.failed ? 'missing' : thumb.src ? undefined : 'loading'}
			title={label}
			aria-label={label}
			onClick={open}>
			{thumb.src && <Thumbnail src={thumb.src} />}
		</button>
	);
}
