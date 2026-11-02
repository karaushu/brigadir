import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyBinding } from '@codemirror/view';
import {
	agentSlashCommands,
	attachmentLabel,
	attachmentMention,
	attachmentToken,
	loggedMcpTools,
	matchSlash,
	modelToken,
	promptAttachmentIds,
	promptParts,
	promptTokenRanges,
	selectOption,
	slashEntries,
	t,
	taskToken,
	type AgentTask,
	type EventRecord,
	type FileEntry,
	type Locale,
	type MessageKey,
	type PromptAttachment,
	type ProviderCatalog,
	type SlashAction,
} from '@brigadir/core';
import { slashMenuGroups, useSlashWords } from './slash-menu-items';
import { useSlashCatalog } from './use-slash-catalog';
import {
	useMentionEditor,
	type MentionDisplay,
	type MentionMatch,
	type MentionTrigger,
} from './mention-editor';
import { attachTaskFile, useTaskState } from './task-state';
import { useWorkspace } from './store';
import { Glyph } from './ui/Glyph';
import { glyphMarkup } from './ui/glyph-markup';
import { StatusIcon } from './ui/Controls';
import { useAttachmentPreview } from './ui/AttachmentChips';
import type { MentionGroup, MentionGroupItem } from './ui/mention-tabs';
import styles from './ComposerMentions.module.css';

const glyphs = {
	file: glyphMarkup(<Glyph name="file" size={10} />),
	folder: glyphMarkup(<Glyph name="folder" size={10} />),
	code: glyphMarkup(<Glyph name="code" size={10} />),
	claude: glyphMarkup(<Glyph name="claude" size={10} />),
	openai: glyphMarkup(<Glyph name="openai" size={10} />),
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
const providerName = (provider: 'claude' | 'codex') => (provider === 'claude' ? 'Claude' : 'Codex');

// Catalogs and thumbnails live as long as the window: the menu opens often, the answer rarely changes.
const catalogs = new Map<'claude' | 'codex', Promise<ProviderCatalog | null>>();
function providerCatalog(provider: 'claude' | 'codex') {
	let found = catalogs.get(provider);
	if (!found) {
		found = window.brigadir.readProviderCatalog(provider).catch(() => null);
		catalogs.set(provider, found);
		void found.then((value) => {
			if (!value) catalogs.delete(provider);
		});
	}
	return found;
}
const thumbnails = new Map<string, Promise<string>>();
function thumbnail(task: AgentTask, id: string) {
	const key = `${task.projectId}/${task.id}/${id}`;
	let found = thumbnails.get(key);
	if (!found) {
		found = window.brigadir.readAttachmentThumbnail(task, id);
		thumbnails.set(key, found);
		void found.catch(() => thumbnails.delete(key));
	}
	return found;
}

/** spec/composer#slash-menu: an app action the `/` menu offers in this composer right now; a pick removes `/word` and runs it. */
export type ComposerAction = {
	action: SlashAction;
	label: string;
	description: string;
	run(): void;
};
type Models = { provider: 'claude' | 'codex'; choices: { value: string; name: string }[] }[];

/**
 * spec/composer#mentions: the task composer is the sheet's editor (`useMentionEditor`). Mentions are tokens in the text: a file or a pasted
 * image is an attachment in its place, a task is attached as its summary when the message goes, a model is a reference in
 * the text. `@` has the tabs All · Files · Tasks · Models; `/` as the first character lists the agent's commands (spec/composer#mention-menu).
 */
export function useComposerEditor({
	task,
	locale,
	records,
	text,
	setText,
	actions = [],
	placeholder,
	placeholderKey,
	attributes,
	disabled,
	modelValue,
	keys,
	ownPaste,
	onError,
}: {
	task: AgentTask;
	locale: Locale;
	records: readonly EventRecord[];
	text: string;
	setText(value: string): void;
	actions?: readonly ComposerAction[];
	placeholder: string;
	/** spec/composer#agent-capsule: a key drawn after the placeholder (the ghost's `Tab`). */ placeholderKey?:
		string | undefined;
	attributes: Record<string, string>;
	disabled: boolean;
	/** The task's model, ticked in Models. */ modelValue: string | null;
	keys: readonly KeyBinding[];
	ownPaste(event: ClipboardEvent): boolean;
	onError(message: string): void;
}) {
	const [{ attachments, composerInserts }, setTask] = useTaskState(task);
	const workspaceTasks = useWorkspace((state) => state.workspace?.tasks);
	const [trigger, setTrigger] = useState<MentionTrigger | null>(null),
		[found, setFound] = useState<{ query: string; entries: readonly FileEntry[] } | null>(null),
		[models, setModels] = useState<Models | null>(null);
	const [restored, setRestored] = useState<ReadonlyMap<string, PromptAttachment | null>>(new Map());
	const picking = useRef(0),
		placing = useRef(new Set<string>());
	// spec/composer#slash-menu: `/` lists the agent's commands and skills (from disk until the agent announces its own), MCP tools and actions.
	const catalog = useSlashCatalog(
		{ projectId: task.projectId, provider: task.provider ?? 'claude', taskId: task.id },
		trigger?.kind === '/'
	);
	const agent = useMemo(() => agentSlashCommands(records), [records]),
		logged = useMemo(() => loggedMcpTools(records), [records]);
	const actionKey = actions.map((item) => `${item.action}:${item.label}`).join('|');
	const slash = useMemo(
		() => slashEntries({ catalog, agent, logged, actions }),
		[catalog, agent, logged, actionKey]
	);
	const matched = useMemo(
		() =>
			trigger?.kind === '/' ? matchSlash(slash.entries, trigger.query, trigger.start === true) : [],
		[trigger, slash]
	);
	const query = trigger?.query ?? '';

	// Files: the task's index (spec/composer#mention-menu) with its folders (spec/composer#mention-menu); the first answer at once, the next letters after a pause.
	const fileQuery = trigger?.kind === '@' ? trigger.query : null;
	useEffect(() => {
		if (fileQuery === null) {
			setFound(null);
			return;
		}
		let alive = true;
		const asked = fileQuery;
		const timer = setTimeout(
			() => {
				void window.brigadir.searchFiles(task, asked, false, true).then(
					(result) => {
						if (alive)
							setFound({
								query: asked,
								entries: result.entries.filter((entry) => entry.kind !== 'unavailable').slice(0, 8),
							});
					},
					(error) => {
						if (!alive) return;
						setFound({ query: asked, entries: [] });
						onError(String(error));
					}
				);
			},
			found ? 120 : 0
		);
		return () => {
			alive = false;
			clearTimeout(timer);
		};
	}, [fileQuery, task.id, task.projectId]);
	// Models: both catalogs once the first `@` opens; the task's provider first.
	useEffect(() => {
		if (trigger?.kind !== '@' || models) return;
		let alive = true;
		const order: ('claude' | 'codex')[] =
			task.provider === 'codex' ? ['codex', 'claude'] : ['claude', 'codex'];
		void Promise.all(
			order.map(async (provider) => ({
				provider,
				choices:
					selectOption((await providerCatalog(provider))?.options ?? [], 'model')?.choices.map(
						(choice) => ({ value: choice.value, name: choice.name })
					) ?? [],
			}))
		).then((value) => {
			if (alive) setModels(value.filter((entry) => entry.choices.length));
		});
		return () => {
			alive = false;
		};
	}, [trigger?.kind, models === null, task.provider]);

	const projectTasks = useMemo(
		() =>
			(workspaceTasks ?? []).filter(
				(item) => item.projectId === task.projectId && item.id !== task.id
			),
		[workspaceTasks, task.projectId, task.id]
	);
	const known = useMemo(() => {
		const map = new Map<string, PromptAttachment>();
		for (const [id, item] of restored) if (item) map.set(id, item);
		for (const item of attachments) map.set(item.id, item);
		return map;
	}, [attachments, restored]);

	const groups = useMemo((): MentionGroup[] => {
		if (trigger?.kind === '/') {
			// A bare `/` with nothing to list yet says when the agent's commands come, in a grey row nothing can pick (spec/composer#mention-menu).
			const bare = !trigger.query && !agent;
			return slashMenuGroups(
				slash.entries,
				matched,
				locale,
				bare && !catalog
					? t(locale, 'Searching…')
					: bare
						? t(locale, 'Commands appear once the agent starts')
						: null
			);
		}
		const needle = query.toLocaleLowerCase(),
			matches = (value: string) => !needle || value.toLocaleLowerCase().includes(needle);
		const files: MentionGroupItem[] = (found?.entries ?? []).map((entry) => ({
			key: `file:${entry.id}`,
			label: entry.name,
			mono: true,
			tail: entry.path,
			title: entry.kind === 'directory' ? `${entry.path}/` : entry.path,
			icon: <Glyph name={entry.kind === 'directory' ? 'folder' : 'file'} size={12} />,
		}));
		// Tasks: the project's, without this one; crew agents under their task, this task's own crew at the top level.
		const ordered: { task: AgentTask; depth: number }[] = [];
		for (const item of projectTasks)
			if (!item.parentTaskId || item.parentTaskId === task.id) {
				ordered.push({ task: item, depth: 0 });
				for (const child of projectTasks)
					if (child.parentTaskId === item.id) ordered.push({ task: child, depth: 1 });
			}
		const shown = ordered.filter((entry) => matches(entry.task.title));
		const tasks: MentionGroupItem[] = shown.map((entry, index) => {
			const parent =
				entry.depth &&
				shown.slice(0, index).some((other) => other.task.id === entry.task.parentTaskId);
			const activity = entry.task.activity?.kind === 'tool' ? entry.task.activity.title : null;
			return {
				key: `task:${entry.task.id}`,
				label: entry.task.title,
				tail:
					activity && (entry.task.status === 'working' || entry.task.status === 'needs-you')
						? activity
						: t(locale, statusLabels[entry.task.status]),
				...(parent ? { depth: 1 } : {}),
				icon: (
					<span className={styles.taskIcon}>
						<StatusIcon
							size={12}
							status={entry.task.status}
							question={entry.task.activity?.kind === 'question'}
							label={t(locale, statusLabels[entry.task.status])}
						/>
					</span>
				),
			};
		});
		const modelItems: MentionGroupItem[] = (models ?? []).flatMap((entry) =>
			entry.choices
				.filter((choice) => matches(choice.value) || matches(choice.name))
				.map((choice) => {
					const own = entry.provider === (task.provider ?? 'claude') && choice.value === modelValue;
					return {
						key: `model:${entry.provider}:${choice.value}`,
						label: choice.value,
						mono: true,
						section: providerName(entry.provider),
						...(own || choice.name !== choice.value
							? { tail: own ? t(locale, 'task model') : choice.name }
							: {}),
						...(own ? { checked: true } : {}),
						icon: <Glyph name={entry.provider === 'claude' ? 'claude' : 'openai'} size={12} />,
					};
				})
		);
		return [
			{
				id: 'files',
				label: t(locale, 'Files'),
				items: files,
				status: found ? null : t(locale, 'Searching…'),
			},
			{ id: 'tasks', label: t(locale, 'Tasks'), items: tasks },
			{
				id: 'models',
				label: t(locale, 'Models'),
				items: modelItems,
				status: models ? null : t(locale, 'Loading…'),
			},
		];
	}, [
		trigger?.kind,
		query,
		found,
		projectTasks,
		models,
		slash,
		matched,
		catalog,
		agent,
		locale,
		modelValue,
		task.id,
		task.provider,
	]);

	// How a token shows: an attachment by its record, a task by its title, a model by its id (spec/composer#mentions).
	const display = (
		token: ReturnType<typeof promptTokenRanges>[number]['token']
	): MentionDisplay => {
		if (token.kind === 'model')
			return {
				kind: 'pill',
				type: 'model',
				label: token.model,
				glyph: token.provider === 'claude' ? glyphs.claude : glyphs.openai,
				mono: true,
				title: `${token.model} · ${providerName(token.provider)}\n${t(locale, 'Goes to the agent as text: the model id and the provider. The task model does not change.')}`,
			};
		if (token.kind === 'task') {
			const item = projectTasks.find((entry) => entry.id === token.id);
			return item
				? {
						kind: 'pill',
						type: 'task',
						label: item.title,
						glyph: item.crew ? glyphs.helmet : glyphs.person,
						title: item.title,
					}
				: {
						kind: 'pill',
						type: 'task',
						label: token.id,
						glyph: glyphs.person,
						missing: true,
						title: t(locale, 'The task summary could not be attached.'),
					};
		}
		const item = known.get(token.id);
		if (!item) {
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
		if (item.kind === 'image')
			return {
				kind: 'image',
				key: item.id,
				title: label,
				src: () => thumbnail(task, item.id),
				attachment: item.id,
			};
		const mention = attachmentMention(item);
		return {
			kind: 'pill',
			type: mention.kind,
			label: mention.label,
			glyph:
				mention.kind === 'task'
					? glyphs.helmet
					: mention.kind === 'text'
						? glyphs.code
						: mention.kind === 'folder'
							? glyphs.folder
							: glyphs.file,
			mono: mention.kind === 'file' || mention.kind === 'folder',
			title: item.name,
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
		projectTasks.map((item) => `${item.id}:${item.title}:${item.crew ? 1 : 0}`).join(',') +
		'|' +
		locale;

	const words = useSlashWords(slash.entries, locale);
	const editor = useMentionEditor({
		value: text,
		onChange: setText,
		ariaLabel: t(locale, 'Message'),
		placeholder,
		placeholderKey,
		disabled,
		attributes,
		slash: true,
		find,
		findKey: `${findKey}|${words.key}`,
		commands: words.commands,
		groups,
		note:
			trigger?.kind === '/' && slash.preliminary
				? t(locale, 'Preliminary list: the agent has not started')
				: null,
		empty: trigger?.kind === '@' ? t(locale, 'No matches') : null,
		onTrigger: setTrigger,
		keys,
		ownPaste,
		onPick: (item) => {
			const [kind, ...rest] = item.key.split(':'),
				value = rest.join(':');
			if (trigger?.kind === '/') {
				const entry = matched.find((item_) => item_.key === item.key);
				if (!entry) return null;
				if (entry.action)
					queueMicrotask(() => actions.find((action) => action.action === entry.action)?.run());
				return entry.insert;
			}
			if (kind === 'task') return taskToken(value);
			if (kind === 'model') {
				const [provider, ...model] = value.split(':');
				return modelToken(provider as 'claude' | 'codex', model.join(':'));
			}
			// While the file attaches, the attachment is in the state before its token is in the text: it is not homeless.
			picking.current++;
			return attachTaskFile(task, value, false).then(
				(attachment) => {
					picking.current--;
					placing.current.add(attachment.id);
					setTimeout(() => placing.current.delete(attachment.id), 1000);
					return attachmentToken(attachment.id);
				},
				() => {
					picking.current--;
					onError(t(locale, 'The files could not be attached. Check the attachment limits.'));
					return null;
				}
			);
		},
		menu: {
			label: t(locale, trigger?.kind === '/' ? 'Slash commands' : 'Mention'),
			tabsLabel: t(locale, 'Mention groups'),
			allLabel: t(locale, 'All mentions'),
			hint: t(locale, 'next tab'),
			emptyTab: t(locale, 'No matches'),
			placement: 'top',
			className: `${styles.menu ?? ''}${trigger?.kind === '/' ? ` ${styles.slash ?? ''}` : ''}`,
		},
	});

	// spec/composer#mentions: an attachment made outside the menu (paste, drop, +, the file tree, the editor) gets its token at the caret.
	useEffect(() => {
		if (!composerInserts.length || !editor.handle.view) return;
		const ids = composerInserts.filter((id) => !promptAttachmentIds(text).includes(id));
		setTask({ composerInserts: [] });
		if (ids.length) editor.handle.insert(ids.map(attachmentToken).join(' '));
	}, [composerInserts]);
	// A pill removed from the text takes its attachment with it; an attachment without a place (an older draft) gets one at the end.
	const placed = useRef(new Set<string>());
	useEffect(() => {
		if (task.transport === 'terminal') return;
		const ids = promptAttachmentIds(text);
		for (const id of ids) placed.current.add(id);
		const removed = attachments
			.filter((item) => !ids.includes(item.id) && placed.current.has(item.id))
			.map((item) => item.id);
		const homeless = picking.current
			? []
			: attachments
					.filter(
						(item) =>
							!ids.includes(item.id) &&
							!placed.current.has(item.id) &&
							!placing.current.has(item.id) &&
							!composerInserts.includes(item.id)
					)
					.map((item) => item.id);
		if (removed.length)
			setTask((state) => ({
				attachments: state.attachments.filter((item) => !removed.includes(item.id)),
			}));
		if (homeless.length)
			setTask((state) => ({ composerInserts: [...state.composerInserts, ...homeless] }));
		// ⌘Z or a restart brings back a token whose record is not in memory: read it from the task's attachments on disk.
		for (const id of ids)
			if (!known.has(id) && !restored.has(id)) {
				setRestored((current) => new Map(current).set(id, null));
				void window.brigadir.readAttachmentInfo(task, id).then(
					(item) => {
						setRestored((current) => new Map(current).set(id, item));
						if (!placed.current.has(`restored:${id}`)) {
							placed.current.add(`restored:${id}`);
							setTask((state) =>
								state.attachments.some((entry) => entry.id === id)
									? {}
									: { attachments: [...state.attachments, item] }
							);
						}
					},
					() => {}
				);
			}
	}, [text, attachments]);

	/** What goes to the agent: task tokens become their summaries now (spec/composer#mentions); ids in the order of the text. */
	async function prepare(value: string): Promise<{ text: string; attachmentIds: string[] } | null> {
		let out = '';
		for (const part of promptParts(value)) {
			if (part.kind === 'token' && part.token.kind === 'task') {
				try {
					out += attachmentToken(
						(
							await window.brigadir.attachTaskSummary(task, {
								projectId: task.projectId,
								id: part.token.id,
							})
						).id
					);
				} catch {
					onError(t(locale, 'The task summary could not be attached.'));
					return null;
				}
			} else out += part.kind === 'text' ? part.text : part.raw;
		}
		const present = new Set([
			...attachments.map((item) => item.id),
			...[...restored.entries()].flatMap(([id, item]) => (item ? [id] : [])),
		]);
		const ids = promptAttachmentIds(out).filter((id) => present.has(id) || !value.includes(id));
		for (const item of attachments) if (!ids.includes(item.id)) ids.push(item.id);
		if (ids.length > 10) {
			onError(t(locale, 'The files could not be attached. Check the attachment limits.'));
			return null;
		}
		return { text: out, attachmentIds: ids };
	}
	// spec/composer#island stays: a click on a pill or a thumbnail opens the attachment, as the tile did.
	const preview = useAttachmentPreview(task, locale, [...known.values()]);
	const onClick = (event: { target: EventTarget }) => {
		const id = (event.target as Element).closest?.<HTMLElement>('[data-attachment-id]')?.dataset
				.attachmentId,
			item = id && known.get(id);
		if (item) void preview.open(item);
	};
	// spec/composer#slash-highlight: the log marks the same names in the person's messages.
	return { ...editor, prepare, onClick, dialogs: preview.dialogs, commands: words.commands };
}
