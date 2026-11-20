import { useEffect, useMemo, useRef, useState } from 'react';
import {
	brigadirCards,
	mcpCall,
	mcpVerb,
	settingEdit,
	type ToolPatch,
	t,
	type BrigadirCard,
	type BrigadirChatRow,
	type Locale,
	type MessageKey,
	type SettingsTab,
} from '@brigadir/core';
import { settingLocation } from '@brigadir/core';
import { Button, IconButton } from './ui/Controls';
import { Glyph, type GlyphName } from './ui/Glyph';
import { TextArea, TextInput } from './ui/Input';
import { ChatComposer, useChatSlash, type ChatMentions } from './ChatComposer';
import { PromptText } from './ui/PromptText';
import { ChatCard } from './ui/ChatCard';
import { MarkdownStill, markdown } from './MarkdownBlock';
import { toastError } from './ui/Toast';
import { useBrigadirChat } from './brigadir-data';
import { useWorkspace } from './store';
import n from './NoteChat.module.css';
import s from './BrigadirChat.module.css';

type Part =
	| { kind: 'text'; text: string; key: string }
	| { kind: 'tool'; title: string; status: string; key: string; tool: ToolPatch }
	| { kind: 'card'; id: string; key: string }
	| { kind: 'row'; row: BrigadirChatRow; key: string };
type Turn = { prompt: Extract<BrigadirChatRow, { kind: 'prompt' }> | null; parts: Part[] };
/** Rows into turns: the person's message, the agent's text and tool rows, each card once (at its first state), the end. */
function turns(rows: readonly BrigadirChatRow[]): Turn[] {
	const out: Turn[] = [];
	let turn: Turn | null = null;
	const tools = new Map<string, { title: string; status: string; key: string; tool: ToolPatch }>(),
		cards = new Set<string>();
	for (const row of rows) {
		if (row.kind === 'prompt') {
			turn = { prompt: row, parts: [] };
			out.push(turn);
			continue;
		}
		if (!turn) {
			turn = { prompt: null, parts: [] };
			out.push(turn);
		}
		if (row.kind === 'event') {
			const event = row.event;
			if (
				event.kind === 'message.delta' &&
				event.role === 'assistant' &&
				event.content.kind === 'text' &&
				!event.subagentId
			) {
				const last = turn.parts.at(-1);
				if (last?.kind === 'text') last.text += event.content.text;
				else turn.parts.push({ kind: 'text', text: event.content.text, key: `t${row.seq}` });
			} else if (event.kind === 'tool.changed' && !event.patch.parentId) {
				const known = tools.get(event.patch.id);
				if (known) {
					known.tool = { ...known.tool, ...event.patch };
					if (event.patch.title) known.title = event.patch.title;
					if (event.patch.status) known.status = event.patch.status;
				} else {
					// Claude's own loader of deferred tools says nothing to the person.
					if (event.patch.title === 'ToolSearch') continue;
					const part = {
						kind: 'tool' as const,
						title: event.patch.title ?? '',
						status: event.patch.status ?? '',
						key: `x${row.seq}`,
						tool: event.patch,
					};
					tools.set(event.patch.id, part);
					turn.parts.push(part);
				}
			}
		} else if (row.kind === 'card') {
			if (!cards.has(row.card.id)) {
				cards.add(row.card.id);
				turn.parts.push({ kind: 'card', id: row.card.id, key: `c${row.card.id}` });
			}
		} else turn.parts.push({ kind: 'row', row, key: `r${row.seq}` });
	}
	return out;
}
const seconds = (ms: number) => `${Math.max(1, Math.round(ms / 1000))}s`;
const valueText = (locale: Locale, value: string | number | boolean | null) =>
	value === true
		? t(locale, 'On')
		: value === false
			? t(locale, 'Off')
			: value === null
				? t(locale, 'Default')
				: String(value);
/** The last part of a setting's place: the row's own name, as Settings shows it. */
const placeLabel = (place: string) => place.split(' ▸ ').slice(-2).join(' ▸ ');

export const brigadirExamples = (
	project: string | null
): { glyph: GlyphName; text: MessageKey; project?: string }[] => [
	{ glyph: 'slack', text: 'Set up a Slack bot for me' },
	{ glyph: 'font-larger', text: 'Make the code font one size bigger' },
	{ glyph: 'layout-three', text: 'Three columns instead of two' },
	...(project
		? [
				{
					glyph: 'agents' as const,
					text: 'What is up with my tasks in {project}?' as const,
					project,
				},
				{
					glyph: 'search' as const,
					text: 'How is the main flow built in {project}?' as const,
					project,
				},
			]
		: []),
	{ glyph: 'remote', text: 'Turn on access from my laptop' },
];
/** spec/composer#chat-composer: the Brigadir chat's `@` — every project's tasks and the projects; no files. */
const brigadirMentions: ChatMentions = {
	tasksOf: null,
	projects: true,
	filesOf: null,
	taskWay: 'Goes to Brigadir as the task: its title, id and project.',
};
/**
 * spec/settings-modules-and-onboarding#brigadir-chat-entry: the Brigadir section's screen — the open chat with its cards, or the example tiles when
 * none is open; the composer under either. The log is the note chat's look (rule 17); the cards are `ui/ChatCard`.
 */
export function BrigadirChat({
	locale,
	chat,
	ask,
	project,
	onOpenChat,
	onOpenSettings,
	onOpenTask,
}: {
	locale: Locale;
	chat: string | null;
	/** A message to send in a new chat once the screen is up (Search Everywhere's `Ask Brigadir`). */
	ask: string | null;
	/** A project's name for the example tiles. */
	project: string | null;
	onOpenChat(id: string | null, ask?: string): void;
	onOpenSettings(target: { tab: SettingsTab; setting?: string }): void;
	onOpenTask(task: { projectId: string; id: string }): void;
}) {
	const { rows, busy, title } = useBrigadirChat(chat),
		[draft, setDraft] = useState(''),
		log = useRef<HTMLDivElement>(null);
	const all = useMemo(() => turns(rows ?? []), [rows]);
	/** Brigadir's own tools read as what they did (`Changed a setting`); another tool keeps its title. */
	const toolTitle = (part: Extract<Part, { kind: 'tool' }>) => {
		const call = mcpCall(part.tool);
		return call
			? mcpVerb(
					locale,
					call,
					part.status === 'completed' ? 'done' : part.status === 'failed' ? 'failed' : 'running'
				)
			: part.title;
	};
	const cards = useMemo(
		() => new Map(brigadirCards(rows ?? []).map((card) => [card.id, card])),
		[rows]
	);
	useEffect(() => {
		log.current?.scrollTo({ top: log.current.scrollHeight });
	}, [rows?.length]);
	// spec/composer#chat-composer: `/` lists the agent's commands (from disk until it announces them) and the chat's own tools; `@` every
	// project's tasks and the projects.
	const events = useMemo(
		() => (rows ?? []).flatMap((row) => (row.kind === 'event' ? [row] : [])),
		[rows]
	);
	const slash = useChatSlash(
		'brigadir',
		() => window.brigadir.readBrigadirSlashCatalog(),
		events,
		locale
	);
	// A new chat is made for its first attachment, so the file has a folder to live in.
	const made = useRef<string | null>(null);
	const ensureChat = async () => {
		if (chat) return chat;
		if (made.current) return made.current;
		const id = (await window.brigadir.createBrigadirChat()).id;
		made.current = id;
		onOpenChat(id);
		return id;
	};
	useEffect(() => {
		if (chat !== made.current) made.current = null;
	}, [chat]);
	const start = async (text: string, attachments: string[] = []) => {
		const message = text.trim();
		if (!message) return;
		try {
			const id = await ensureChat();
			await window.brigadir.sendBrigadirChat(id, message, attachments);
		} catch {
			setDraft(message);
			toastError(t(locale, 'Could not send the message.'));
		}
	};
	// `Ask Brigadir: «…»` opens the section with the query: a new chat takes it as its first message.
	const asked = useRef<string | null>(null);
	useEffect(() => {
		if (!ask || asked.current === ask) return;
		asked.current = ask;
		void start(ask);
	}, [ask]);
	const send = (attachments: string[]) => {
		if (busy) return;
		const message = draft;
		setDraft('');
		void start(message, attachments);
	};
	const answer = (
		card: string,
		action: 'apply' | 'cancel' | 'secret' | 'start' | 'decline' | 'close',
		value: string | null = null
	) =>
		chat &&
		void window.brigadir
			.answerBrigadirCard(chat, card, action, value)
			.catch(() => toastError(t(locale, 'Could not change the setting.')));
	const card = (item: BrigadirCard) => (
		<BrigadirCardView
			key={item.id}
			card={item}
			locale={locale}
			onAnswer={answer}
			onUndo={(id) =>
				chat &&
				void window.brigadir
					.undoBrigadirCard(chat, id)
					.catch(() => toastError(t(locale, 'Could not undo the change.')))
			}
			onOpenLink={(id) => chat && void window.brigadir.openBrigadirLink(chat, id)}
			onOpenSettings={(key) => {
				const edit = settingEdit(key),
					place = edit && settingLocation(edit.id, locale);
				onOpenSettings(place && edit ? { tab: place.tab, setting: edit.id } : { tab: 'modules' });
			}}
			onOpenTask={onOpenTask}
		/>
	);
	return (
		<section
			className={s.screen}
			aria-label={t(locale, 'Brigadir (section)')}
			data-brigadir-chat={chat ?? ''}>
			<header className={s.head} data-size="m">
				<Glyph name="helmet" size={16} />
				<strong>{chat ? title || t(locale, 'New chat') : t(locale, 'Brigadir (section)')}</strong>
				{chat && <small>{t(locale, 'Brigadir (section)')}</small>}
				<span className={n.gap} />
				<Button size="m" onClick={() => onOpenSettings({ tab: 'appearance' })}>
					<Glyph name="settings" size={13} />
					{t(locale, 'Open Settings')}
				</Button>
				<Button size="m" onClick={() => onOpenChat(null)}>
					<Glyph name="plus" size={13} />
					{t(locale, 'New chat')}
				</Button>
			</header>
			{!chat ? (
				<div className={s.empty}>
					<span className={s.mark}>
						<Glyph name="helmet-chat" size={26} />
					</span>
					<h2>{t(locale, 'Brigadir (section)')}</h2>
					<div className={s.examples}>
						{brigadirExamples(project).map((item) => {
							const text = t(locale, item.text).replace('{project}', item.project ?? '');
							return (
								<button
									key={item.text}
									type="button"
									className={s.example}
									onClick={() => void start(text)}>
									<Glyph name={item.glyph} size={15} />
									<span>{text}</span>
								</button>
							);
						})}
					</div>
				</div>
			) : (
				<div className={`${n.log} ${s.log}`} ref={log} role="log">
					<div className={s.column}>
						{all.map((turn, index) => (
							<div key={turn.prompt?.seq ?? `p${index}`} className={n.turn}>
								{turn.prompt && (
									<div className={n.user}>
										<PromptText
											owner={{ chat: 'brigadir', id: chat }}
											locale={locale}
											text={turn.prompt.text}
											rowId={`brigadir/${chat}/${turn.prompt.seq}`}
											attachments={turn.prompt.attachments ?? []}
											commands={slash.commands}
										/>
									</div>
								)}
								{turn.parts.map((part) =>
									part.kind === 'text' ? (
										<div key={part.key} className={n.text}>
											<MarkdownStill html={markdown.render(part.text)} />
										</div>
									) : part.kind === 'tool' && !toolTitle(part) ? null : part.kind === 'tool' ? (
										<div key={part.key} className={n.tool} data-status={part.status}>
											<Glyph
												name={
													part.status === 'completed'
														? 'tick'
														: part.status === 'failed'
															? 'agent-failed'
															: 'agent-run'
												}
												size={12}
											/>
											<span>{toolTitle(part)}</span>
										</div>
									) : part.kind === 'card' ? (
										cards.get(part.id) && card(cards.get(part.id)!)
									) : part.row.kind === 'done' ? (
										<div key={part.key} className={n.foot}>
											{t(locale, part.row.stopped ? 'Stopped' : 'Done')} ·{' '}
											{seconds(part.row.milliseconds)}
										</div>
									) : part.row.kind === 'failed' ? (
										<div key={part.key} className={n.failed} role="alert">
											<Glyph name="agent-failed" size={13} />
											<span>{part.row.message}</span>
										</div>
									) : null
								)}
							</div>
						))}
						{busy && (
							<div className={n.tool} data-status="working">
								<Glyph name="agent-run" size={12} />
								<span>{t(locale, 'Working')}</span>
							</div>
						)}
					</div>
				</div>
			)}
			<div className={`${n.compose} ${s.compose}`}>
				<ChatComposer
					locale={locale}
					value={draft}
					onChange={setDraft}
					placeholder={t(locale, 'Ask about tasks, code or settings')}
					busy={busy && !!chat}
					onSend={send}
					onStop={() => chat && void window.brigadir.stopBrigadirChat(chat)}
					holder={chat ? { chat: 'brigadir', id: chat } : undefined}
					onNeedHolder={async () => ({ chat: 'brigadir' as const, id: await ensureChat() })}
					mentions={brigadirMentions}
					slash={slash}
				/>
			</div>
		</section>
	);
}

/** spec/settings-modules-and-onboarding#brigadir-chat-cards: one card in its latest state. */
function BrigadirCardView({
	card,
	locale,
	onAnswer,
	onUndo,
	onOpenLink,
	onOpenSettings,
	onOpenTask,
}: {
	card: BrigadirCard;
	locale: Locale;
	onAnswer(
		card: string,
		action: 'apply' | 'cancel' | 'secret' | 'start' | 'decline' | 'close',
		value?: string | null
	): void;
	onUndo(card: string): void;
	onOpenLink(card: string): void;
	onOpenSettings(key: string): void;
	onOpenTask(task: { projectId: string; id: string }): void;
}) {
	if (card.type === 'setting') {
		const values = (
			<span className={s.values}>
				{card.state === 'undone' ? (
					<b>{valueText(locale, card.before)}</b>
				) : (
					<>
						<s>{valueText(locale, card.before)}</s> → <b>{valueText(locale, card.after)}</b>
					</>
				)}
			</span>
		);
		if (card.state === 'pending' || card.state === 'cancelled')
			return (
				<ChatCard
					glyph="settings"
					title={placeLabel(card.place)}
					hint={card.place.split(' ▸ ')[1]}
					waiting={card.state === 'pending'}
					data-brigadir-card="setting"
					note={card.state === 'cancelled' ? t(locale, 'Cancelled') : card.fact}
					actions={
						card.state === 'pending' && (
							<>
								<Button size="s" onClick={() => onAnswer(card.id, 'cancel')}>
									{t(locale, 'Cancel')}
								</Button>
								<Button size="s" appearance="primary" onClick={() => onAnswer(card.id, 'apply')}>
									{t(locale, 'Apply')}
								</Button>
							</>
						)
					}>
					{values}
				</ChatCard>
			);
		return (
			<div className={s.setting} data-brigadir-card="setting" data-state={card.state} data-size="s">
				<Glyph name={card.state === 'undone' ? 'undo' : 'check-pass'} size={14} />
				<span className={s.settingName}>{placeLabel(card.place)}</span>
				{values}
				{card.state === 'undone' && <small>{t(locale, 'Undone')}</small>}
				<span className={n.gap} />
				{card.state === 'done' && (
					<Button size="s" onClick={() => onUndo(card.id)}>
						{t(locale, 'Undo')}
					</Button>
				)}
				<Button size="s" onClick={() => onOpenSettings(card.key)}>
					{t(locale, 'Open in Settings')}
				</Button>
			</div>
		);
	}
	if (card.type === 'steps') {
		const done = card.steps.filter((step) => step.done).length,
			current = card.steps.findIndex((step) => !step.done);
		return (
			<ChatCard
				glyph={card.setup === 'slack' ? 'slack' : 'remote'}
				title={t(locale, 'Slack setup')}
				hint={
					current < 0
						? t(locale, 'Done')
						: t(locale, '{n} of {total}')
								.replace('{n}', String(done))
								.replace('{total}', String(card.steps.length))
				}
				data-brigadir-card="steps">
				<ol className={s.steps}>
					{card.steps.map((step, index) => (
						<li
							key={step.name}
							data-state={step.done ? 'done' : index === current ? 'current' : 'waiting'}>
							<span className={s.dot}>
								{step.done ? <Glyph name="tick" size={11} /> : index + 1}
							</span>
							<span>
								<b>{step.name}</b>
								<small>{step.detail}</small>
							</span>
						</li>
					))}
				</ol>
			</ChatCard>
		);
	}
	if (card.type === 'secret') return <SecretCard card={card} locale={locale} onAnswer={onAnswer} />;
	if (card.type === 'note')
		return (
			<div className={s.link} data-brigadir-card="note" data-size="s">
				<Glyph name="note" size={14} />
				<span>
					<b>{t(locale, 'Note saved')}</b>
					<small>{card.title}</small>
				</span>
				<Button size="s" onClick={() => useWorkspace.getState().openNotes(card.note)}>
					{t(locale, 'Open note')}
				</Button>
			</div>
		);
	// spec/todo-and-slack-inbox#todo-chat-tools: a to-do the agent added — its title, where it went, `Open list`.
	if (card.type === 'todo')
		return (
			<div className={s.link} data-brigadir-card="todo" data-size="s">
				<Glyph name="todo" size={14} />
				<span>
					<b>{card.title}</b>
					<small>
						{card.project ? `${card.project} › ` : ''}
						{card.listName || t(locale, 'Untitled list')}
					</small>
				</span>
				<Button size="s" onClick={() => useWorkspace.getState().openTodo(card.list)}>
					{t(locale, 'Open list')}
				</Button>
			</div>
		);
	if (card.type === 'event')
		return (
			<div className={s.setting} data-brigadir-card="event" data-tone={card.tone} data-size="s">
				<span className={s.eventDot} data-tone={card.tone} aria-hidden="true" />
				<span className={s.settingName}>{card.text}</span>
				<span className={n.gap} />
				{card.link && (
					<a className={s.fix} href={card.link} target="_blank" rel="noreferrer">
						GitHub
					</a>
				)}
				{card.task && (
					<Button size="s" onClick={() => onOpenTask(card.task!)}>
						{t(locale, 'Open task')}
					</Button>
				)}
			</div>
		);
	if (card.type === 'link')
		return (
			<div className={s.link} data-brigadir-card="link" data-size="s">
				<span>
					<b>{card.title}</b>
					<small>{card.detail}</small>
				</span>
				<Button
					size="s"
					appearance={card.opened ? 'neutral' : 'primary'}
					onClick={() => onOpenLink(card.id)}>
					<Glyph name="external" size={12} />
					{card.opened ? t(locale, 'Open again') : card.label}
				</Button>
			</div>
		);
	return (
		<ChatCard
			glyph="task-new"
			title={t(locale, 'New task')}
			hint={`${card.project}${card.base ? ` · ${card.base}` : ''}`}
			waiting={card.state === 'proposed'}
			data-brigadir-card="task"
			note={
				card.state === 'declined'
					? t(locale, 'Declined')
					: card.state === 'started'
						? t(locale, 'Started')
						: null
			}
			actions={
				card.state === 'proposed' ? (
					<>
						<Button size="s" onClick={() => onAnswer(card.id, 'decline')}>
							{t(locale, 'Decline')}
						</Button>
						<Button size="s" appearance="primary" onClick={() => onAnswer(card.id, 'start')}>
							{t(locale, 'Start')}
						</Button>
					</>
				) : card.state === 'started' && card.task ? (
					<Button size="s" onClick={() => onOpenTask(card.task!)}>
						{t(locale, 'Open task')}
					</Button>
				) : null
			}>
			<b className={s.taskTitle}>{card.title}</b>
			<p className={s.taskPrompt}>{card.prompt}</p>
		</ChatCard>
	);
}

/** The secret field: the value goes from here to main and the key store; the log keeps only the check's result. */
function SecretCard({
	card,
	locale,
	onAnswer,
}: {
	card: Extract<BrigadirCard, { type: 'secret' }>;
	locale: Locale;
	onAnswer(card: string, action: 'secret' | 'close', value?: string | null): void;
}) {
	const [value, setValue] = useState('');
	const label = t(
		locale,
		card.kind === 'slackBotToken' ? 'Bot token (field)' : 'App-level token (field)'
	);
	const open = card.state === 'waiting' || card.state === 'error' || card.state === 'scopes';
	const result =
		card.state === 'checking' ? (
			<span className={s.result}>{t(locale, 'Checking with Slack…')}</span>
		) : card.state === 'connected' ? (
			<span className={s.result} data-tone="green">
				{t(locale, 'Connected as {who}').replace('{who}', card.result ?? '')}
			</span>
		) : card.state === 'scopes' ? (
			<span className={s.result} data-tone="amber">
				{card.result} · {t(locale, 'Add them in OAuth & Permissions, then Reinstall to Workspace.')}
			</span>
		) : card.state === 'error' ? (
			<span className={s.result} data-tone="red">
				{card.result}
			</span>
		) : card.state === 'closed' ? (
			<span className={s.result}>{t(locale, 'Cancelled')}</span>
		) : (
			<span className={s.result}>{t(locale, 'Goes to the Keychain, not to the agent.')}</span>
		);
	return (
		<ChatCard
			glyph="agent-key"
			title={label}
			hint={t(locale, 'Secret')}
			waiting={card.state === 'waiting'}
			data-brigadir-card="secret">
			{open ? (
				<form
					className={s.secret}
					data-size="m"
					onSubmit={(event) => {
						event.preventDefault();
						if (!value.trim()) return;
						onAnswer(card.id, 'secret', value.trim());
						setValue('');
					}}>
					<TextInput
						size="m"
						type="password"
						autoComplete="off"
						spellCheck={false}
						placeholder={card.kind === 'slackBotToken' ? 'xoxb-…' : 'xapp-…'}
						value={value}
						aria-label={label}
						onChange={(event) => setValue(event.currentTarget.value)}
					/>
					<Button size="m" appearance="primary" type="submit" disabled={!value.trim()}>
						{t(locale, 'Connect')}
					</Button>
					<Button size="m" onClick={() => onAnswer(card.id, 'close')}>
						{t(locale, 'Cancel')}
					</Button>
				</form>
			) : card.state === 'connected' ? (
				<div className={s.sealed}>
					<Glyph name="agent-key" size={13} />
					{t(locale, 'Token in Keychain')}
				</div>
			) : null}
			{result}
			{card.state === 'scopes' && card.link && (
				<a className={s.fix} href={card.link} target="_blank" rel="noreferrer">
					OAuth & Permissions
				</a>
			)}
		</ChatCard>
	);
}
