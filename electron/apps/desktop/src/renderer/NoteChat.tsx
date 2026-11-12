import { useEffect, useMemo, useRef, useState } from 'react';
import {
	providerName,
	quotaProviders,
	t,
	undoableEdit,
	type AgentProvider,
	type Locale,
	type NoteChatChoice,
	type NoteChatRow,
	type NoteDocument,
} from '@brigadir/core';
import { Button, IconButton } from './ui/Controls';
import { Glyph } from './ui/Glyph';
import { TextArea } from './ui/Input';
import { ComposerIsland, ComposerBar } from './ui/ComposerIsland';
import { ComposerOptions, type CapsuleModelGroup } from './ComposerOptions';
import { MarkdownStill, markdown } from './MarkdownBlock';
import { noteLineLinks } from './note-markdown';
import { useModelCatalogs } from './QuickAsk';
import { toastError } from './ui/Toast';
import s from './NoteChat.module.css';
/** The note's chat as rows, kept in step with every window by `notes:chat-event`. */
function useNoteChat(id: string) {
	const [rows, setRows] = useState<NoteChatRow[] | null>(null),
		[busy, setBusy] = useState(false),
		[choice, setChoice] = useState<NoteChatChoice | null>(null);
	useEffect(() => {
		let active = true;
		setRows(null);
		const pending: NoteChatRow[] = [];
		let loaded = false;
		const off = window.brigadir.onNoteChatEvent((event) => {
			if (event.id !== id) return;
			if ('busy' in event) setBusy(event.busy);
			else if (loaded)
				setRows((current) =>
					current && !current.some((row) => row.seq === event.row.seq)
						? [...current, event.row]
						: current
				);
			else pending.push(event.row);
		});
		void window.brigadir.readNoteChat(id).then(
			(state) => {
				if (!active) return;
				loaded = true;
				const known = new Set(state.rows.map((row) => row.seq));
				setRows([...state.rows, ...pending.filter((row) => !known.has(row.seq))]);
				setBusy(state.busy);
				setChoice(state.choice);
			},
			() => active && setRows([])
		);
		return () => {
			active = false;
			off();
		};
	}, [id]);
	return { rows, busy, choice };
}
type Turn = {
	prompt: Extract<NoteChatRow, { kind: 'prompt' }> | null;
	parts: (
		| { kind: 'text'; text: string; key: string }
		| { kind: 'tool'; title: string; status: string; key: string }
		| { kind: 'row'; row: NoteChatRow; key: string }
	)[];
};
/** Rows into turns: the person's message, then the agent's text and tool calls of the answer, its edit and its end. */
function turns(rows: readonly NoteChatRow[]): Turn[] {
	const out: Turn[] = [];
	let turn: Turn | null = null;
	const tools = new Map<string, { title: string; status: string; key: string }>();
	for (const row of rows) {
		if (row.kind === 'person-edit') {
			out.push({ prompt: null, parts: [{ kind: 'row', row, key: `r${row.seq}` }] });
			turn = null;
			continue;
		}
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
					if (event.patch.title) known.title = event.patch.title;
					if (event.patch.status) known.status = event.patch.status;
				} else {
					const part = {
						kind: 'tool' as const,
						title: event.patch.title ?? '',
						status: event.patch.status ?? '',
						key: `x${row.seq}`,
					};
					tools.set(event.patch.id, part);
					turn.parts.push(part);
				}
			}
		} else turn.parts.push({ kind: 'row', row, key: `r${row.seq}` });
	}
	return out;
}
const seconds = (ms: number) => `${Math.max(1, Math.round(ms / 1000))}s`;
function EditCard({
	row,
	undoable,
	undone,
	locale,
	onUndo,
}: {
	row: Extract<NoteChatRow, { kind: 'edit' }>;
	undoable: boolean;
	undone: boolean;
	locale: Locale;
	onUndo(): void;
}) {
	const before = new Set(row.before.split('\n')),
		after = new Set(row.after.split('\n'));
	const lines = [
		...row.before
			.split('\n')
			.filter((line) => !after.has(line))
			.map((text) => ({ kind: 'del' as const, text })),
		...row.after
			.split('\n')
			.filter((line) => !before.has(line))
			.map((text) => ({ kind: 'add' as const, text })),
	].slice(0, 12);
	return (
		<section className={s.edit} data-note-edit={row.seq}>
			<header data-size="s">
				<Glyph name="edit" size={13} />
				<b>{t(locale, 'Edited the note')}</b>
				<span className={s.delta}>
					<span data-sign="add">+{row.added}</span> <span data-sign="del">−{row.removed}</span>
				</span>
			</header>
			<div className={s.lines}>
				{lines.map((line, i) => (
					<div key={i} data-line={line.kind}>
						<i>{line.kind === 'add' ? '+' : '−'}</i>
						<span>{line.text || ' '}</span>
					</div>
				))}
			</div>
			<footer data-size="s">
				{undone ? (
					<span>{t(locale, 'Undone. The note is as before the answer.')}</span>
				) : undoable ? (
					<>
						<span className={s.saved}>
							<Glyph name="tick" size={12} />
							{t(locale, 'Saved to the note')}
						</span>
						<span className={s.gap} />
						<Button size="s" onClick={onUndo}>
							<Glyph name="undo" size={12} />
							{t(locale, 'Undo')}
						</Button>
					</>
				) : (
					<span className={s.stale}>
						{t(locale, 'You edited the note after the answer. Undo is off.')}
					</span>
				)}
			</footer>
		</section>
	);
}
/**
 * spec/notifications-slack-notes-and-schedules#notes: the note's one chat, kept like a task's. The agent gets the note's text with every message (the header
 * says so; an amber chip over the field appears when the note changed since the last message); its edits come as cards with Undo.
 */
export function NoteChat({
	note,
	text,
	locale,
	defaultProvider,
	quote,
	width,
	onHide,
	onLines,
}: {
	note: NoteDocument;
	/** spec/notifications-slack-notes-and-schedules#note-chat: `noteChatWidth`, clamped to the window. */ width: number;
	/** The note as the editor holds it now. */ text: string;
	locale: Locale;
	defaultProvider: AgentProvider;
	/** spec/notifications-slack-notes-and-schedules#note-tasks: lines of the note the person sent from the selection's «To composer»; a new `id` adds them again. */
	quote?: { id: number; text: string } | null | undefined;
	onHide(): void;
	/** A click on `L5-7` in an answer: show those lines of the note. */ onLines(
		from: number,
		to: number
	): void;
}) {
	const { rows, busy, choice } = useNoteChat(note.id),
		[draft, setDraft] = useState(''),
		log = useRef<HTMLDivElement>(null),
		field = useRef<HTMLTextAreaElement>(null);
	// The quote goes in front of what is typed, as a Markdown quote, and the field takes the focus.
	useEffect(() => {
		if (!quote) return;
		const quoted = quote.text
			.split('\n')
			.map((line) => `> ${line}`)
			.join('\n');
		setDraft((current) => `${quoted}\n\n${current}`);
		requestAnimationFrame(() => {
			const element = field.current;
			if (!element) return;
			element.focus();
			element.setSelectionRange(element.value.length, element.value.length);
		});
	}, [quote?.id]);
	const catalogs = useModelCatalogs();
	const [pick, setPick] = useState<NoteChatChoice | null>(null);
	const current: NoteChatChoice = pick ??
		choice ?? { provider: defaultProvider, model: catalogs[defaultProvider]?.value ?? null };
	const groups: CapsuleModelGroup[] = quotaProviders.flatMap((provider) => {
		const option = catalogs[provider];
		if (option === null) return [];
		return [
			{
				provider,
				name: providerName(provider),
				choices: option
					? option.choices.map(({ value, name, description }) => ({ value, name, description }))
					: null,
				task: null,
				limit: null,
			},
		];
	});
	const label =
		catalogs[current.provider]?.choices.find((item) => item.value === current.model)?.name ??
		current.model ??
		'';
	const all = useMemo(() => turns(rows ?? []), [rows]);
	const lastNote = useMemo(() => {
		for (const row of [...(rows ?? [])].reverse())
			if (row.kind === 'prompt') return row.note;
			else if (row.kind === 'edit') return row.after;
		return undefined;
	}, [rows]);
	const changed = lastNote !== undefined && lastNote !== text;
	const undoable = useMemo(() => undoableEdit(rows ?? [], text), [rows, text]);
	const undone = useMemo(
		() => new Set((rows ?? []).flatMap((row) => (row.kind === 'undo' ? [row.of] : []))),
		[rows]
	);
	useEffect(() => {
		log.current?.scrollTo({ top: log.current.scrollHeight });
	}, [rows?.length]);
	const send = () => {
		const message = draft.trim();
		if (!message || busy) return;
		setDraft('');
		void window.brigadir.sendNoteChat(note.id, message, current).catch(() => {
			setDraft(message);
			toastError(t(locale, 'Could not send the message.'));
		});
	};
	return (
		<aside
			className={s.chat}
			style={{ width }}
			aria-label={t(locale, 'Chat about the note')}
			data-note-chat={note.id}>
			<header className={s.head} data-size="s">
				<Glyph name="chat" size={14} />
				<span>{t(locale, 'Chat')}</span>
				<small>· {t(locale, 'about this note')}</small>
				<span className={s.gap} />
				<IconButton size="s" label={t(locale, 'Hide chat')} onClick={onHide}>
					<Glyph name="layout-panel-off" size={14} />
				</IconButton>
			</header>
			{rows && !rows.length ? (
				<div className={s.empty}>
					<Glyph name="chat" size={30} />
					<h2>{t(locale, 'Chat about this note')}</h2>
				</div>
			) : (
				<div
					className={s.log}
					ref={log}
					role="log"
					onClick={(event) => {
						const button = (event.target as HTMLElement).closest<HTMLElement>('[data-note-lines]');
						if (!button) return;
						const [from, to] = button.dataset.noteLines!.split('-').map(Number);
						onLines(from!, to!);
					}}>
					{all.map((turn, index) => (
						<div key={turn.prompt?.seq ?? `p${index}`} className={s.turn}>
							{turn.prompt && <div className={s.user}>{turn.prompt.text}</div>}
							{turn.parts.map((part) =>
								part.kind === 'text' ? (
									<div key={part.key} className={s.text}>
										<MarkdownStill html={noteLineLinks(markdown.render(part.text))} />
									</div>
								) : part.kind === 'tool' ? (
									<div key={part.key} className={s.tool} data-status={part.status}>
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
										<span>{part.title}</span>
									</div>
								) : part.row.kind === 'edit' ? (
									<EditCard
										key={part.key}
										row={part.row}
										undoable={undoable === part.row.seq}
										undone={undone.has(part.row.seq)}
										locale={locale}
										onUndo={() =>
											void window.brigadir
												.undoNoteEdit(note.id, part.row.seq)
												.catch(() => toastError(t(locale, 'Could not undo the edit.')))
										}
									/>
								) : part.row.kind === 'person-edit' ? (
									<div key={part.key} className={s.event}>
										<Glyph name="edit" size={12} />
										<span>{t(locale, 'You edited the note')}</span>
										<span className={s.delta}>
											<span data-sign="add">+{part.row.added}</span>{' '}
											<span data-sign="del">−{part.row.removed}</span>
										</span>
										<span className={s.rule} />
									</div>
								) : part.row.kind === 'done' ? (
									<div key={part.key} className={s.foot}>
										{t(locale, part.row.stopped ? 'Stopped' : 'Done')} ·{' '}
										{seconds(part.row.milliseconds)}
									</div>
								) : part.row.kind === 'failed' ? (
									<div key={part.key} className={s.failed} role="alert">
										<Glyph name="agent-failed" size={13} />
										<span>{part.row.message}</span>
									</div>
								) : null
							)}
						</div>
					))}
					{busy && (
						<div className={s.tool} data-status="working">
							<Glyph name="agent-run" size={12} />
							<span>{t(locale, 'Working')}</span>
						</div>
					)}
				</div>
			)}
			<div className={s.compose}>
				<ComposerIsland
					onSubmit={(event) => {
						event.preventDefault();
						send();
					}}>
					{changed && (
						<div className={s.context}>
							<span className={s.chip} data-changed>
								<Glyph name="note" size={12} />
								<i>{t(locale, 'The note changed since the last message')}</i>
							</span>
						</div>
					)}
					<TextArea
						ref={field}
						embedded
						className={s.field}
						rows={Math.min(8, Math.max(2, draft.split('\n').length))}
						value={draft}
						placeholder={t(locale, 'Ask about this note')}
						aria-label={t(locale, 'Ask about this note')}
						onChange={(event) => setDraft(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
								event.preventDefault();
								send();
							}
						}}
					/>
					<ComposerBar attach={null}>
						<ComposerOptions
							provider={current.provider}
							locale={locale}
							disabled={busy}
							models={{
								groups,
								provider: current.provider,
								value: current.model ?? '',
								label,
								loading: !label,
								note: '',
								onChoose: (provider, model) => setPick({ provider, model }),
							}}
						/>
						{busy ? (
							<IconButton
								label={t(locale, 'Stop')}
								onClick={() => void window.brigadir.stopNoteChat(note.id)}>
								<Glyph name="stop" size={12} />
							</IconButton>
						) : (
							<Button
								appearance="primary"
								type="submit"
								aria-label={t(locale, 'Send')}
								disabled={!draft.trim()}>
								<Glyph name="send" size={13} />
							</Button>
						)}
					</ComposerBar>
				</ComposerIsland>
			</div>
		</aside>
	);
}
