import {
	forwardRef,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef,
	useState,
	type ClipboardEvent,
	type ReactNode,
} from 'react';
import {
	agentSlashCommands,
	attachmentLabel,
	attachmentMention,
	attachmentToken,
	attachmentTotalLimit,
	holderKey,
	loggedMcpTools,
	matchSlash,
	projectToken,
	promptAttachmentIds,
	promptTokenRanges,
	slashEntries,
	t,
	taskToken,
	type AgentEvent,
	type AgentTask,
	type AttachmentHolder,
	type Locale,
	type MessageKey,
	type PromptAttachment,
	type SlashCatalog,
	type SlashEntry,
} from '@brigadir/core';
import {
	ComposerBar,
	ComposerDropZone,
	ComposerIsland,
	ComposerText,
	composerMenuClass,
	composerMenuTaskIcon,
} from './ui/ComposerIsland';
import { ComposerSend } from './ComposerSend';
import { attachmentPillTitle } from './composer-mentions';
import { clipboardHasImage, pasteKind } from './composer-paste';
import {
	useMentionEditor,
	type FindCommands,
	type MentionDisplay,
	type MentionMatch,
	type MentionTrigger,
} from './mention-editor';
import { slashMenuGroups, useSlashWords } from './slash-menu-items';
import { useSlashCatalogFrom } from './use-slash-catalog';
import { useWorkspace } from './store';
import { useAttachmentPreview } from './ui/AttachmentChips';
import { IconButton, StatusIcon } from './ui/Controls';
import { fileDropHandlers } from './ui/file-drop';
import { Glyph } from './ui/Glyph';
import { glyphMarkup } from './ui/glyph-markup';
import type { MentionGroup, MentionGroupItem } from './ui/mention-tabs';
import { toastError } from './ui/Toast';

export type ChatComposerHandle = {
	/** Puts the caret at the end of the text and takes the focus. */
	focus(): void;
};
/** spec/composer#chat-composer: what the chat's `@` menu lists. */
export type ChatMentions = {
	/** Tasks of this project; null — of every project. */ tasksOf: string | null;
	/** The Projects group (the Brigadir chat). */ projects: boolean;
	/** Files and folders of this project's main tree (the note chat with a project); null — no Files group. */ filesOf:
		string | null;
	/** A file or folder picked in Files, as the chat's attachment. */ attachFile?(
		path: string
	): Promise<PromptAttachment>;
	/** What a task pill's title says the agent gets. */ taskWay: MessageKey;
};
/** spec/composer#chat-composer: the chat's `/` list — the agent's commands and skills, its MCP tools and `Attach files`. */
export type ChatSlash = {
	entries: readonly SlashEntry[];
	preliminary: boolean;
	/** The disk has not answered yet. */ loading: boolean;
	/** The agent announced its own commands. */ announced: boolean;
	onOpen(open: boolean): void;
	/** spec/composer#slash-highlight: the known names, marked in the text and in the log. */ commands: FindCommands;
	wordsKey: string;
};
/**
 * spec/composer#chat-composer: the `/` list of a chat that is not a task. Before its agent announces commands the list is read from disk
 * (`read`, again each time the menu opens); after, the agent's own list from the chat's journal, as in the task composer.
 */
export function useChatSlash(
	key: string | null,
	read: () => Promise<SlashCatalog>,
	events: readonly { event: AgentEvent }[],
	locale: Locale
): ChatSlash {
	const [opened, setOpened] = useState(false);
	const catalog = useSlashCatalogFrom(key, read, opened);
	const agent = useMemo(() => agentSlashCommands(events), [events]),
		logged = useMemo(() => loggedMcpTools(events), [events]);
	const slash = useMemo(
		() =>
			slashEntries({
				catalog,
				agent,
				logged,
				actions: [
					{
						action: 'attach',
						label: t(locale, 'Attach files'),
						description: t(locale, 'Up to 10 files, 8 MB total; images up to 4 MB.'),
					},
				],
			}),
		[catalog, agent, logged, locale]
	);
	const words = useSlashWords(slash.entries, locale);
	return {
		entries: slash.entries,
		preliminary: slash.preliminary,
		loading: !catalog,
		announced: Boolean(agent),
		onOpen: setOpened,
		commands: words.commands,
		wordsKey: words.key,
	};
}

const glyphs = {
	file: glyphMarkup(<Glyph name="file" size={10} />),
	folder: glyphMarkup(<Glyph name="folder" size={10} />),
	code: glyphMarkup(<Glyph name="code" size={10} />),
	helmet: glyphMarkup(<Glyph name="helmet" size={10} />),
	person: glyphMarkup(<Glyph name="person" size={10} />),
};
const statusLabels: Record<AgentTask['status'], MessageKey> = {
	'rate-limited': 'Rate limited',
	queued: 'Queued',
	preparing: 'Preparing…',
	working: 'Working',
	'needs-you': 'Needs you',
	done: 'Done',
	interrupted: 'Interrupted',
	failed: 'Error',
	backlog: 'Not started',
	completed: 'Completed task',
};
type FileHit = { path: string; scope: string; scopePath: string; directory?: true };
const thumbnails = new Map<string, Promise<string>>();
const filesFailure = 'The files could not be attached. Check the attachment limits.' as const,
	imageFailure = 'The image could not be attached. Check the attachment limits.' as const;

/**
 * spec/composer#chat-composer (rule 17): the task composer, simplified for the chats that are not a task — the Brigadir chat and the
 * note chat. The same island, the same editor (Markdown keys, `↩` sends, `⇧↩` breaks the line) and the same Send and Stop
 * circles; no context meter, no agent capsule unless the chat passes its own controls, no environment footer. With `holder`
 * the chat takes attachments (`+`, paste, drop) as pills in the text, kept in the chat's own folder; `mentions` and `slash`
 * give the `@` and `/` menus.
 */
export const ChatComposer = forwardRef<
	ChatComposerHandle,
	{
		locale: Locale;
		value: string;
		onChange(value: string): void;
		placeholder: string;
		/** The agent answers now: Stop replaces Send. */ busy: boolean;
		stopDisabled?: boolean;
		/** The message goes; `attachments` — the ids its text places, in order. */ onSend(
			attachments: string[]
		): void;
		onStop(): void;
		/** Who keeps the chat's attachments; without it and `onNeedHolder` the composer takes none. */ holder?:
			AttachmentHolder | undefined;
		/** A chat that does not exist yet makes itself for its first attachment (a new Brigadir chat). */ onNeedHolder?:
			(() => Promise<AttachmentHolder>) | undefined;
		mentions?: ChatMentions | undefined;
		slash?: ChatSlash | undefined;
		/** A row over the text (the note chat's «changed» chip). */ context?: ReactNode;
		/** Controls left of Send (the note chat's model capsule). */ controls?: ReactNode;
		className?: string;
	}
>(function ChatComposer(
	{
		locale,
		value,
		onChange,
		placeholder,
		busy,
		stopDisabled = false,
		onSend,
		onStop,
		holder,
		onNeedHolder,
		mentions,
		slash,
		context,
		controls,
		className,
	},
	ref
) {
	const form = useRef<HTMLFormElement>(null);
	const [trigger, setTrigger] = useState<MentionTrigger | null>(null),
		[files, setFiles] = useState<{ query: string; hits: FileHit[] } | null>(null),
		[attachments, setAttachments] = useState<PromptAttachment[]>([]),
		[restored, setRestored] = useState<ReadonlyMap<string, PromptAttachment | null>>(new Map()),
		[picking, setPicking] = useState(false),
		[dropOver, setDropOver] = useState(false);
	const workspaceTasks = useWorkspace((state) => state.workspace?.tasks),
		workspaceProjects = useWorkspace((state) => state.workspace?.projects);
	const latest = useRef({ holder, attachments, onNeedHolder });
	latest.current = { holder, attachments, onNeedHolder };
	/** The holder, or the one the chat makes for its first attachment (a new Brigadir chat); null — none. */
	const ownerNow = async () =>
		latest.current.holder ?? (await latest.current.onNeedHolder?.().catch(() => null)) ?? null;
	// Ids seen in the text (a pill gone from it removes its attachment) and ids just made, whose tokens are on their way into it.
	const placed = useRef(new Set<string>()),
		fresh = useRef(new Set<string>());
	const arriving = (ids: string[]) => {
		for (const id of ids) fresh.current.add(id);
		setTimeout(() => {
			for (const id of ids) fresh.current.delete(id);
		}, 1000);
	};
	// Another holder (another note, another chat) starts with no attachments of its own in memory; a chat made for the first
	// attachment (`onNeedHolder`) keeps it.
	const canAttach = Boolean(holder || onNeedHolder);
	const holderId = holder ? holderKey(holder) : '',
		previousHolder = useRef(holderId);
	useEffect(() => {
		const was = previousHolder.current;
		previousHolder.current = holderId;
		if (!was || was === holderId) return;
		latest.current.attachments = [];
		placed.current.clear();
		setAttachments([]);
		setRestored(new Map());
	}, [holderId]);

	const known = useMemo(() => {
		const map = new Map<string, PromptAttachment>();
		for (const [id, item] of restored) if (item) map.set(id, item);
		for (const item of attachments) map.set(item.id, item);
		return map;
	}, [attachments, restored]);
	const projectName = (id: string) => workspaceProjects?.find((item) => item.id === id)?.name ?? id;
	// spec/composer#chat-composer: tasks of one project or of all, newest first; crew members stay under their crew's task in the task.
	const tasks = useMemo(
		() =>
			mentions
				? (workspaceTasks ?? [])
						.filter(
							(item) =>
								!item.archived &&
								!item.parentTaskId &&
								(mentions.tasksOf === null || item.projectId === mentions.tasksOf)
						)
						.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
				: [],
		[workspaceTasks, mentions?.tasksOf, Boolean(mentions)]
	);
	const allTasks = workspaceTasks ?? [];

	const slashMatched = useMemo(
		() =>
			trigger?.kind === '/' && slash
				? matchSlash(slash.entries, trigger.query, trigger.start === true)
				: [],
		[trigger, slash?.entries]
	);
	const slashOpen = trigger?.kind === '/';
	useEffect(() => {
		slash?.onOpen(slashOpen);
	}, [slashOpen]);

	const query = trigger?.query ?? '';
	const groups = useMemo((): MentionGroup[] => {
		if (trigger?.kind === '/') {
			const bare = !trigger.query && !slash?.announced;
			return slashMenuGroups(
				slash?.entries ?? [],
				slashMatched,
				locale,
				bare && slash?.loading
					? t(locale, 'Searching…')
					: bare && !slash?.entries.some((entry) => entry.kind !== 'action')
						? t(locale, 'Commands appear once the agent starts')
						: null
			);
		}
		if (!mentions) return [];
		const needle = query.toLocaleLowerCase(),
			matches = (text: string) => !needle || text.toLocaleLowerCase().includes(needle);
		const out: MentionGroup[] = [];
		if (mentions.filesOf)
			out.push({
				id: 'files',
				label: t(locale, 'Files'),
				items: (files?.hits ?? []).map((hit) => {
					const path = hit.scopePath === '.' ? hit.path : `${hit.scopePath}/${hit.path}`;
					return {
						key: `file:${hit.directory ? `${path}/` : path}`,
						label: hit.path.split('/').at(-1) || hit.path,
						mono: true,
						tail: path,
						title: hit.directory ? `${path}/` : path,
						icon: <Glyph name={hit.directory ? 'folder' : 'file'} size={12} />,
					};
				}),
				status: files ? null : t(locale, 'Searching…'),
			});
		out.push({
			id: 'tasks',
			label: t(locale, 'Tasks'),
			items: tasks
				.filter((item) => matches(item.title))
				.map((item): MentionGroupItem => {
					const activity = item.activity?.kind === 'tool' ? item.activity.title : null;
					return {
						key: `task:${item.id}`,
						label: item.title,
						tail:
							mentions.tasksOf === null
								? projectName(item.projectId)
								: activity && (item.status === 'working' || item.status === 'needs-you')
									? activity
									: t(locale, statusLabels[item.status]),
						icon: (
							<span className={composerMenuTaskIcon}>
								<StatusIcon
									size={12}
									status={item.status}
									question={item.activity?.kind === 'question'}
									label={t(locale, statusLabels[item.status])}
								/>
							</span>
						),
					};
				}),
		});
		if (mentions.projects)
			out.push({
				id: 'projects',
				label: t(locale, 'Projects'),
				items: (workspaceProjects ?? [])
					.filter((item) => matches(item.name))
					.map((item) => ({
						key: `project:${item.id}`,
						label: item.name,
						tail: item.path,
						title: item.path,
						icon: <Glyph name="folder" size={12} />,
					})),
			});
		return out;
	}, [
		trigger?.kind,
		query,
		files,
		tasks,
		workspaceProjects,
		mentions,
		slash?.entries,
		slash?.loading,
		slash?.announced,
		slashMatched,
		locale,
	]);

	// How a token shows: an attachment by its record, a task by its title, a project by its name (spec/composer#mentions).
	const display = (
		token: ReturnType<typeof promptTokenRanges>[number]['token']
	): MentionDisplay => {
		if (token.kind === 'task') {
			const item = allTasks.find((entry) => entry.id === token.id);
			return item
				? {
						kind: 'pill',
						type: 'task',
						label: item.title,
						glyph: item.crew ? glyphs.helmet : glyphs.person,
						title: `${item.title}\n${t(locale, mentions?.taskWay ?? 'Goes to the agent as a task summary: state, branch, requests and changes.')}`,
					}
				: { kind: 'pill', type: 'task', label: token.id, glyph: glyphs.person, missing: true };
		}
		if (token.kind === 'project') {
			const item = workspaceProjects?.find((entry) => entry.id === token.id);
			return {
				kind: 'pill',
				type: 'project',
				label: item?.name ?? token.id,
				glyph: glyphs.folder,
				...(item
					? {
							title: `${item.name}\n${t(locale, 'Goes to Brigadir as the project: its name and folder.')}`,
						}
					: { missing: true }),
			};
		}
		if (token.kind !== 'attachment')
			return {
				kind: 'pill',
				type: token.kind,
				label: token.kind === 'model' ? token.model : token.id,
				glyph: glyphs.person,
				missing: true,
			};
		const item = known.get(token.id);
		if (!item || !holder) {
			const gone = restored.get(token.id) === null;
			return {
				kind: 'pill',
				type: 'file',
				label: gone ? t(locale, 'Attachments') : '…',
				glyph: glyphs.file,
				missing: true,
				...(gone ? { title: t(locale, 'The attachment is no longer available.') } : {}),
			};
		}
		const label = attachmentLabel(locale, item);
		if (item.kind === 'image') {
			const key = `${holderKey(holder)}/${item.id}`;
			return {
				kind: 'image',
				key: item.id,
				title: label,
				attachment: item.id,
				src: () => {
					let found = thumbnails.get(key);
					if (!found) {
						found = window.brigadir.readAttachmentThumbnail(holder, item.id);
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
			title: attachmentPillTitle(locale, item),
			attachment: item.id,
		};
	};
	const find = (line: string): MentionMatch[] =>
		promptTokenRanges(line).map((range) => ({
			from: range.from,
			to: range.to,
			display: display(range.token),
		}));
	const findKey =
		[...known.values()].map((item) => `${item.id}:${item.name}`).join('\n') +
		'|' +
		[...restored.entries()].map(([id, item]) => `${id}:${item ? 1 : 0}`).join(',') +
		'|' +
		allTasks.map((item) => `${item.id}:${item.title}:${item.crew ? 1 : 0}`).join(',') +
		'|' +
		(workspaceProjects ?? []).map((item) => `${item.id}:${item.name}`).join(',') +
		'|' +
		locale;

	// spec/composer#attachments: new attachments get their tokens at the caret (the end without focus), within the prompt's limits.
	const add = (added: PromptAttachment[], failure: typeof filesFailure | typeof imageFailure) => {
		if (!added.length) return false;
		const next = [...latest.current.attachments, ...added];
		if (
			next.length > 10 ||
			next.reduce((sum, item) => sum + item.bytes, 0) > attachmentTotalLimit
		) {
			toastError(t(locale, failure));
			return false;
		}
		arriving(added.map((item) => item.id));
		latest.current.attachments = next;
		setAttachments(next);
		editor.handle.insert(added.map((item) => attachmentToken(item.id)).join(' '));
		return true;
	};
	const attach = async (
		work: () => Promise<PromptAttachment[]>,
		failure: typeof filesFailure | typeof imageFailure
	) => {
		try {
			return add(await work(), failure);
		} catch {
			toastError(t(locale, failure));
			return false;
		}
	};
	const pickFiles = () => {
		setPicking(true);
		void attach(async () => {
			const owner = await ownerNow();
			return owner ? window.brigadir.pickAttachments(owner) : [];
		}, filesFailure).finally(() => {
			setPicking(false);
			editor.handle.focus();
		});
	};
	const dropFiles = (dropped: File[]) => {
		if (!dropped.length) return;
		void attach(async () => {
			const owner = await ownerNow();
			return owner ? window.brigadir.attachDroppedFiles(owner, dropped) : [];
		}, filesFailure).then(() => editor.handle.focus());
	};
	// spec/composer#paste: ⌘V with an image or Finder files on the clipboard attaches them; any text pastes as before.
	const paste = (event: ClipboardEvent<HTMLFormElement>) => {
		if (!(event.target as HTMLElement).closest?.('[data-prompt]')) return;
		const data = event.clipboardData,
			text = data.getData('text/plain'),
			pasted = Array.from(data.files);
		if (pasteKind(text, clipboardHasImage(data)) !== 'image') return;
		event.preventDefault();
		void (async () => {
			const owner = await ownerNow();
			if (!owner) return;
			// A Finder copy shows its files and no text; a picture on the clipboard is a file without a path and goes on to main.
			if (!text && pasted.length) {
				const added = await window.brigadir.attachDroppedFiles(owner, pasted).catch(() => null);
				if (added === null) {
					toastError(t(locale, filesFailure));
					return;
				}
				if (add(added, filesFailure) || added.length) return;
			}
			const image = await window.brigadir.pasteAttachment(owner, 'Pasted image');
			const view = editor.handle.view;
			if (image) add([image], imageFailure);
			else if (text && view?.hasFocus) view.dispatch(view.state.replaceSelection(text));
		})().catch(() => toastError(t(locale, imageFailure)));
	};

	const editor = useMentionEditor({
		value,
		onChange,
		ariaLabel: placeholder,
		placeholder,
		slash: Boolean(slash),
		find,
		findKey: `${findKey}|${slash?.wordsKey ?? ''}`,
		...(slash ? { commands: slash.commands } : {}),
		groups,
		empty: trigger?.kind === '@' ? t(locale, 'No matches') : null,
		note:
			trigger?.kind === '/' && slash?.preliminary
				? t(locale, 'Preliminary list: the agent has not started')
				: null,
		onTrigger: (next) => setTrigger(next && next.kind === '@' && !mentions ? null : next),
		onPick: (item) => {
			if (trigger?.kind === '/') {
				const entry = slashMatched.find((found) => found.key === item.key);
				if (!entry) return null;
				if (entry.action === 'attach') queueMicrotask(pickFiles);
				return entry.insert;
			}
			const [kind, ...rest] = item.key.split(':'),
				target = rest.join(':');
			if (kind === 'task') return taskToken(target);
			if (kind === 'project') return projectToken(target);
			const attachFile = mentions?.attachFile;
			if (kind !== 'file' || !attachFile) return null;
			// The record is in memory before its token is in the text: it is not taken for a removed pill.
			return attachFile(target).then(
				(attachment) => {
					arriving([attachment.id]);
					const next = [...latest.current.attachments, attachment];
					if (next.length > 10) {
						toastError(t(locale, filesFailure));
						return null;
					}
					latest.current.attachments = next;
					setAttachments(next);
					return attachmentToken(attachment.id);
				},
				() => {
					toastError(t(locale, filesFailure));
					return null;
				}
			);
		},
		keys: [
			{
				key: 'Enter',
				run: (view) => {
					if (view.composing) return false;
					form.current?.requestSubmit();
					return true;
				},
			},
		],
		ownPaste: (event) => {
			const data = event.clipboardData;
			return Boolean(
				canAttach &&
				data &&
				pasteKind(data.getData('text/plain'), clipboardHasImage(data)) === 'image'
			);
		},
		menu: {
			label: t(locale, trigger?.kind === '/' ? 'Slash commands' : 'Mention'),
			tabsLabel: t(locale, 'Mention groups'),
			allLabel: t(locale, 'All mentions'),
			hint: t(locale, 'next tab'),
			emptyTab: t(locale, 'No matches'),
			placement: 'top',
			className: composerMenuClass(trigger?.kind === '/'),
		},
	});
	useImperativeHandle(ref, () => ({ focus: () => editor.handle.focus('end') }), [editor.handle]);

	// Files of the project's main tree while `@` is open: the first answer at once, the next letters after a pause.
	const fileQuery = trigger?.kind === '@' && mentions?.filesOf ? trigger.query : null;
	useEffect(() => {
		if (fileQuery === null || !mentions?.filesOf) {
			setFiles(null);
			return;
		}
		let alive = true;
		const asked = fileQuery,
			project = mentions.filesOf;
		const timer = setTimeout(
			() => {
				void window.brigadir.searchProjectFiles(project, asked).then(
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
	}, [fileQuery, mentions?.filesOf]);

	// A pill removed from the text takes its attachment with it; a token whose record is not in memory (⌘Z, a draft given back) is read
	// from the chat's attachments on disk.
	useEffect(() => {
		if (!holder) return;
		const ids = promptAttachmentIds(value);
		for (const id of ids) placed.current.add(id);
		const kept = attachments.filter(
			(item) => ids.includes(item.id) || fresh.current.has(item.id) || !placed.current.has(item.id)
		);
		if (kept.length !== attachments.length) {
			latest.current.attachments = kept;
			setAttachments(kept);
		}
		for (const id of ids)
			if (!known.has(id) && !restored.has(id)) {
				setRestored((current) => new Map(current).set(id, null));
				void window.brigadir.readAttachmentInfo(holder, id).then(
					(item) => setRestored((current) => new Map(current).set(id, item)),
					() => {}
				);
			}
	}, [value, attachments, holderId]);

	// spec/composer#island: a click on a pill or a thumbnail opens the attachment.
	const preview = useAttachmentPreview(holder ?? { chat: 'note', id: 'note-none' }, locale, [
		...known.values(),
	]);
	const sent = promptAttachmentIds(value).filter((id) => known.has(id));
	const filled = Boolean(value.trim());
	return (
		<ComposerIsland
			ref={form}
			className={className}
			data-chat-composer
			{...(canAttach
				? {
						...fileDropHandlers(null, () => toastError(t(locale, 'Could not attach the file.')), {
							files: dropFiles,
							over: setDropOver,
						}),
						onPaste: paste,
					}
				: {})}
			data-drop-over={dropOver || undefined}
			onSubmit={(event) => {
				event.preventDefault();
				if (!busy && filled) onSend(sent);
			}}>
			{canAttach && (
				<ComposerDropZone
					title={t(locale, 'Release to attach')}
					note={t(locale, 'Up to 10 files, 8 MB together; images up to 4 MB')}
				/>
			)}
			{context}
			<ComposerText
				ref={editor.host}
				onClick={(event) => {
					const id = (event.target as Element).closest?.<HTMLElement>('[data-attachment-id]')
							?.dataset.attachmentId,
						item = id && known.get(id);
					if (item) void preview.open(item);
					else editor.handle.focus();
				}}
			/>
			{editor.menu}
			{preview.dialogs}
			<ComposerBar
				attach={
					canAttach ? (
						<IconButton
							label={t(locale, 'Attach files')}
							title={t(locale, 'Up to 10 files, 8 MB total; images up to 4 MB.')}
							disabled={picking}
							onClick={pickFiles}>
							<Glyph name="plus" size={15} />
						</IconButton>
					) : null
				}>
				{controls}
				<ComposerSend
					locale={locale}
					busy={busy}
					steers={false}
					filled={!busy && filled}
					stopDisabled={stopDisabled}
					sendDisabled={busy || !filled}
					stopShortcut={undefined}
					queueShortcut={undefined}
					onStop={onStop}
					onSendNow={() => onSend(sent)}
					onQueue={() => {}}
				/>
			</ComposerBar>
		</ComposerIsland>
	);
});
