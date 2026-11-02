import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { glyphMarkup } from './ui/glyph-markup';
import {
	attachmentLabel,
	attachmentMention,
	attachmentToken,
	matchSlash,
	promptAttachmentIds,
	promptTokenRanges,
	t,
	type AttachmentOwner,
	type Locale,
	type PromptAttachment,
	type SlashEntry,
} from '@brigadir/core';
import { Glyph } from './ui/Glyph';
import {
	useMentionEditor,
	type MentionDisplay,
	type MentionMatch,
	type MentionTrigger,
} from './mention-editor';
import { useAttachmentPreview } from './ui/AttachmentChips';
import { pasteKind, clipboardHasImage } from './composer-paste';
import { slashMenuGroups, useSlashWords } from './slash-menu-items';
import type { MentionGroup } from './ui/mention-tabs';
import styles from './PromptEditor.module.css';
import {
	agentMentions,
	matchOptions,
	mentionLabel,
	mentionToken,
	type MentionOption,
} from './prompt-mentions';

/** `insertText` (spec/tasks#backlog-edit): text at the caret, or at the end when the editor has no focus. */
export type PromptEditorHandle = { focus(): void; insertText(text: string): void };
/** spec/tasks#backlog-edit, spec/composer#mentions: the prompt's attachments — pills and thumbnails in the text, at the caret where they were added.
 * A pill taken out of the text removes its attachment (`onRemove`). `onPaste` gets ⌘V with an image or Finder files
 * (`pasteKind`, spec/composer#paste); the owner attaches them, the editor only reports. */
export type PromptAttachments = {
	owner: AttachmentOwner;
	items: readonly PromptAttachment[];
	onRemove(id: string): void;
	onPaste(data: { files: File[]; text: string }): void;
};
type FileHit = { path: string; scope: string; scopePath: string; directory?: true };

const glyphs = {
	file: glyphMarkup(<Glyph name="file" size={10} />),
	folder: glyphMarkup(<Glyph name="folder" size={10} />),
	code: glyphMarkup(<Glyph name="code" size={10} />),
	claude: glyphMarkup(<Glyph name="claude" size={10} />),
	openai: glyphMarkup(<Glyph name="openai" size={10} />),
	helmet: glyphMarkup(<Glyph name="helmet" size={10} />),
	person: glyphMarkup(<Glyph name="person" size={10} />),
};
const thumbnails = new Map<string, Promise<string>>();

/**
 * spec/tasks#sheet-layout: the prompt of the New task sheet. The text goes to the agent as typed: a file mention is its path, a crew node
 * its template's English name; an attachment stands in the text as a token the agent gets as a block in its place.
 * spec/composer#mentions: the `@` menu has the composer's tabs, `All · Files · Crew · Agents`; `/` (spec/composer#slash-menu) — its groups as tabs.
 */
export const PromptEditor = forwardRef<
	PromptEditorHandle,
	{
		value: string;
		onChange(value: string): void;
		locale: Locale;
		placeholder: string;
		ariaLabel: string;
		crew: readonly MentionOption[];
		searchFiles(query: string): Promise<FileHit[]>;
		onSubmit(): void;
		disabled?: boolean;
		attachments?: PromptAttachments;
		/** spec/composer#slash-menu: the `/` menu's entries (disk and our MCP tools; the agent has not started) and when it opens. */
		slash?: { entries: readonly SlashEntry[]; preliminary: boolean; onOpen(open: boolean): void };
	}
>(function PromptEditor(
	{
		value,
		onChange,
		locale,
		placeholder,
		ariaLabel,
		crew,
		searchFiles,
		onSubmit,
		disabled = false,
		attachments,
		slash,
	},
	ref
) {
	const [trigger, setTrigger] = useState<MentionTrigger | null>(null),
		[files, setFiles] = useState<{ query: string; hits: FileHit[] } | null>(null);
	const latest = useRef({ searchFiles, onSubmit, attachments, slash });
	latest.current = { searchFiles, onSubmit, attachments, slash };
	// Known mentions: crew nodes, agents and files the person has already seen in the menu.
	const seenFiles = useRef(new Map<string, MentionOption>());
	// spec/composer#mention-menu: a folder is its path with a trailing `/`, so the agent reads it as a folder.
	const fileOptions = useMemo(
		() =>
			(files?.hits ?? []).map((hit): MentionOption => ({
				kind: 'file',
				token: hit.directory ? `${hit.path}/` : hit.path,
				label: hit.path.split('/').at(-1) || hit.path,
				tail: hit.scopePath === '.' ? hit.path : `${hit.scopePath}/${hit.path}`,
				...(hit.directory ? { icon: 'folder' as const } : {}),
			})),
		[files]
	);
	const known = useMemo(
		() =>
			new Map<string, MentionOption>(
				[...crew, ...agentMentions, ...seenFiles.current.values()].map((option) => [
					option.token,
					option,
				])
			),
		[crew, files]
	);
	const knownRef = useRef(known);
	knownRef.current = known;
	const query = trigger?.query ?? '';
	const slashMatched = useMemo(
		() =>
			trigger?.kind === '/'
				? matchSlash(slash?.entries ?? [], trigger.query, trigger.start === true)
				: [],
		[trigger, slash?.entries]
	);
	const slashOpen = trigger?.kind === '/';
	useEffect(() => {
		slash?.onOpen(slashOpen);
	}, [slashOpen]);
	const groups = useMemo((): MentionGroup[] => {
		if (trigger?.kind === '/') return slashMenuGroups(slash?.entries ?? [], slashMatched, locale);
		const item = (option: MentionOption) => ({
			key: `${option.kind}:${option.token}`,
			label: option.label,
			mono: option.kind === 'file',
			icon: <Glyph name={option.icon ?? (option.kind === 'file' ? 'file' : 'person')} size={12} />,
			...(option.tail ? { tail: option.tail } : {}),
		});
		return [
			{
				id: 'files',
				label: t(locale, 'Files'),
				items: fileOptions.map(item),
				status: files ? null : t(locale, 'Searching…'),
			},
			...(crew.length
				? [{ id: 'crew', label: t(locale, 'Crew'), items: matchOptions(crew, query).map(item) }]
				: []),
			{
				id: 'agents',
				label: t(locale, 'Agents'),
				items: matchOptions(agentMentions, query).map(item),
			},
		];
	}, [trigger?.kind, fileOptions, files, crew, query, locale, slash?.entries, slashMatched]);
	const byId = useMemo(
		() => new Map((attachments?.items ?? []).map((item) => [item.id, item])),
		[attachments?.items]
	);
	const byIdRef = useRef(byId);
	byIdRef.current = byId;
	// An attachment token: a pill or a thumbnail by its record; a mention: a pill by what the sheet knows (spec/tasks#sheet-layout).
	const attachmentDisplay = (id: string): MentionDisplay => {
		const item = byIdRef.current.get(id),
			owner = latest.current.attachments?.owner;
		if (!item || !owner)
			return { kind: 'pill', type: 'file', label: '…', glyph: glyphs.file, missing: true };
		const label = attachmentLabel(locale, item);
		if (item.kind === 'image') {
			const key = `${owner.projectId}/${owner.id}/${item.id}`;
			return {
				kind: 'image',
				key: item.id,
				title: label,
				attachment: item.id,
				src: () => {
					let found = thumbnails.get(key);
					if (!found) {
						found = window.brigadir.readAttachmentThumbnail(owner, item.id);
						thumbnails.set(key, found);
						void found.catch(() => thumbnails.delete(key));
					}
					return found;
				},
			};
		}
		const mention = attachmentMention(item);
		return {
			kind: 'pill',
			type: mention.kind,
			label: mention.label,
			glyph:
				mention.kind === 'text'
					? glyphs.code
					: mention.kind === 'folder'
						? glyphs.folder
						: glyphs.file,
			mono: mention.kind === 'file' || mention.kind === 'folder',
			title: item.name,
			attachment: item.id,
		};
	};
	const find = (line: string): MentionMatch[] => {
		const tokens = promptTokenRanges(line).flatMap((range) =>
			range.token.kind === 'attachment'
				? [{ from: range.from, to: range.to, display: attachmentDisplay(range.token.id) }]
				: []
		);
		const mentions = [...line.matchAll(mentionToken)].flatMap((match) => {
			const from = match.index!,
				to = from + match[0].length;
			if (tokens.some((token) => from < token.to && to > token.from)) return [];
			const found = mentionLabel(match[1]!, knownRef.current);
			if (!found) return [];
			const icon = found.icon ?? (found.kind === 'file' ? 'file' : 'person');
			return [
				{
					from,
					to,
					display: {
						kind: 'pill' as const,
						type: found.kind,
						label: found.label,
						glyph: glyphs[icon],
						mono: found.kind === 'file',
					},
				},
			];
		});
		return [...tokens, ...mentions].sort((a, b) => a.from - b.from);
	};
	const knownKey =
		[...known.values()]
			.map((option) => `${option.kind}:${option.token}:${option.label}:${option.icon ?? ''}`)
			.join('\n') +
		'|' +
		[...byId.values()].map((item) => `${item.id}:${item.name}`).join(',');
	const words = useSlashWords(slash?.entries ?? [], locale);
	const editor = useMentionEditor({
		value,
		onChange,
		ariaLabel,
		placeholder,
		disabled,
		find,
		findKey: `${knownKey}|${words.key}`,
		groups,
		slash: Boolean(slash),
		...(slash ? { commands: words.commands } : {}),
		empty: trigger?.kind === '@' ? t(locale, 'No matches') : null,
		note:
			trigger?.kind === '/' && slash?.preliminary
				? t(locale, 'Preliminary list: the agent has not started')
				: null,
		onTrigger: setTrigger,
		onPick: (item) => {
			if (trigger?.kind === '/')
				return slashMatched.find((entry) => entry.key === item.key)?.insert ?? null;
			const option = [...fileOptions, ...crew, ...agentMentions].find(
				(entry) => `${entry.kind}:${entry.token}` === item.key
			);
			if (!option) return null;
			if (option.kind === 'file') seenFiles.current.set(option.token, option);
			return `@${option.token}`;
		},
		// spec/tasks#backlog-edit: ⌘V with an image or Finder files attaches them through the sheet; text pastes as text.
		ownPaste: (event) => {
			const handler = latest.current.attachments,
				data = event.clipboardData;
			if (!handler || !data) return false;
			const text = data.getData('text/plain');
			if (pasteKind(text, clipboardHasImage(data)) !== 'image') return false;
			event.preventDefault();
			handler.onPaste({ files: Array.from(data.files), text });
			return true;
		},
		keys: [
			{
				key: 'Mod-Enter',
				run: () => {
					latest.current.onSubmit();
					return true;
				},
			},
		],
		menu: {
			label: t(locale, trigger?.kind === '/' ? 'Slash commands' : 'Mention'),
			tabsLabel: t(locale, 'Mention groups'),
			allLabel: t(locale, 'All mentions'),
			hint: t(locale, 'next tab'),
			emptyTab: t(locale, 'No matches'),
			placement: 'caret',
		},
	});
	useImperativeHandle(
		ref,
		() => ({
			focus: () => editor.handle.focus(),
			insertText: (text: string) => {
				const instance = editor.handle.view;
				if (!instance || !text) return;
				const range = instance.hasFocus
					? instance.state.selection.main
					: { from: instance.state.doc.length, to: instance.state.doc.length };
				instance.dispatch({
					changes: { from: range.from, to: range.to, insert: text },
					selection: { anchor: range.from + text.length },
					scrollIntoView: true,
				});
				instance.focus();
			},
		}),
		[]
	);
	// spec/composer#mentions: a new attachment gets its token at the caret (the end without focus); a pill taken out removes its attachment.
	const placed = useRef(new Set<string>());
	useEffect(() => {
		if (!attachments) return;
		const ids = promptAttachmentIds(value);
		for (const id of ids) placed.current.add(id);
		const fresh = attachments.items.filter(
			(item) => !ids.includes(item.id) && !placed.current.has(item.id)
		);
		for (const item of attachments.items)
			if (!ids.includes(item.id) && placed.current.has(item.id) && !fresh.includes(item))
				attachments.onRemove(item.id);
		if (fresh.length) {
			for (const item of fresh) placed.current.add(item.id);
			editor.handle.insert(fresh.map((item) => attachmentToken(item.id)).join(' '));
		}
	}, [value, attachments?.items]);
	// File search runs while the menu is open, debounced so git is not hit on every letter.
	useEffect(() => {
		if (trigger?.kind !== '@') {
			setFiles(null);
			return;
		}
		let alive = true;
		const asked = trigger.query;
		const timer = setTimeout(
			() => {
				void latest.current.searchFiles(asked).then(
					(hits) => {
						if (alive) setFiles({ query: asked, hits: hits.slice(0, 8) });
					},
					() => {
						if (alive) setFiles({ query: asked, hits: [] });
					}
				);
			},
			files ? 120 : 0
		);
		return () => {
			alive = false;
			clearTimeout(timer);
		};
	}, [trigger?.query, trigger?.kind]);
	// spec/composer#island: a click on a pill or a thumbnail opens the attachment.
	const preview = useAttachmentPreview(
		attachments?.owner ?? { projectId: 'none', id: 'none' },
		locale,
		attachments?.items ?? []
	);
	return (
		<div className={styles.wrapper}>
			<div
				ref={editor.host}
				className={styles.editor}
				onClick={(event) => {
					const id = (event.target as Element).closest?.<HTMLElement>('[data-attachment-id]')
							?.dataset.attachmentId,
						item = id && byId.get(id);
					if (item) void preview.open(item);
				}}
			/>
			{editor.menu}
			{preview.dialogs}
		</div>
	);
});
