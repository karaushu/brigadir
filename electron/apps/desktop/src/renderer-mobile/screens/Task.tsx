/**
 * spec/remote-access-and-mobile#phone, spec/remote-access-and-mobile#phone-app: a task is its chat — the history in the shared row engine
 * (`ui/Rows`, rule 6), the cards that wait for the person (question, permission, the agent's plan, the foreman's plan), the
 * turn's state line and the composer; ⋯ opens the task's menu.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
	agentRunning,
	blockedRateLimit,
	crewNeedsYou,
	idleStopped,
	isPlanApproval,
	pendingInputs,
	planApprovalText,
	promptQueue,
	isOwnQueuedPrompt,
	t,
	turnStatus,
	type AgentTask,
	type EventRecord,
	type Locale,
	type PermissionRequest,
	type QuestionAnswer,
	type SessionCommand,
	type SessionSnapshot,
} from '@brigadir/core';
import { Rows } from '../../renderer/ui/Rows';
import { PermissionCard, Question } from '../../renderer/ui/SessionInputs';
import { onSessionEvent } from '../../renderer/session-events';
import { mergeRecords, sessionReads } from '../../renderer/session-read';
import { displayRows, type MarkdownCache } from '../../renderer/conversation-rows';
import { markdown } from '../../renderer/markdown';
import { statusLabels } from '../../renderer/task-line';
import { BackButton, NavBar, NavIcon } from '../ui/Nav';
import { back, navigate, openSheet, type Route } from '../router';
import { useMobile, useOffline } from '../store';
import { renderChatRow, type ChatRow } from '../chat/ChatRows';
import { CrewPlanCard } from '../chat/CrewPlanCard';
import { CrewQuestionCard } from '../chat/CrewQuestionCard';
import { ProposalCard } from '../chat/ProposalCard';
import { useConnection } from '../context';
import { Loading } from '../ui/Loading';
import { openChatLink } from '../chat/links';
import { Composer, limitTime } from '../chat/Composer';
import { TaskSheets } from './TaskSheets';
import { useRouter } from '../router';
import { Icon } from '../ui/Icon';
import { useSecondTick } from '../../renderer/ui/second-tick';
import s from './Screen.module.css';
import c from '../chat/Chat.module.css';
import cards from '../chat/Cards.module.css';

function appendRecord(records: EventRecord[], record: EventRecord) {
	const last = records.at(-1);
	if (!last || record.seq > last.seq) return [...records, record];
	return records.some((item) => item.seq === record.seq)
		? records
		: [...records, record].sort((a, b) => a.seq - b.seq);
}
/**
 * The chats this page has read, by task: while the machine is away the phone opens them from here, read-only. Only in
 * the page's memory — the phone keeps no data of the machine on its disk (spec/remote-access-and-mobile#outbox).
 */
const sessionCache = new Map<string, SessionSnapshot>();
/**
 * The task's journal: read once, then the records the machine sends; a null event re-reads the tail (as the computer's chat).
 * After the link comes back the tail is read again: the events sent while it was down never reached this page.
 */
export function useSession(task: { projectId: string; id: string }) {
	const name = `${task.projectId}/${task.id}`;
	const connection = useConnection();
	const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(
		() => sessionCache.get(name) ?? null
	);
	useEffect(() => {
		if (snapshot) sessionCache.set(name, snapshot);
	}, [snapshot, name]);
	const merge = useCallback(
		(value: SessionSnapshot) =>
			setSnapshot((current) => ({
				...value,
				records: mergeRecords(current?.records ?? [], value.records),
			})),
		[]
	);
	useEffect(() => {
		setSnapshot(sessionCache.get(name) ?? null);
		const reads = sessionReads(task, merge);
		const stopLink = connection.watchLink((state) => {
			if (state === 'up') reads.refresh();
		});
		const stop = onSessionEvent(({ key, record }) => {
			if (key.id !== task.id || key.projectId !== task.projectId) return;
			if (!record) reads.refresh();
			setSnapshot((current) => ({
				key,
				issue: current?.issue ?? null,
				connected: record ? true : Boolean(current?.connected),
				records: record ? appendRecord(current?.records ?? [], record) : (current?.records ?? []),
			}));
		});
		reads.refresh();
		return () => {
			reads.stop();
			stop();
			stopLink();
		};
	}, [task.id, task.projectId, merge, connection]);
	return { snapshot, merge };
}
/**
 * The second line of the header: the project and what the task does now. Every other state says its own
 * name, as the card's status does (`statusLabels`): a task in the backlog, the queue or after an error is not «готово».
 */
export function stateLine(
	locale: Locale,
	task: AgentTask,
	limited: boolean,
	crewWaits = false
): string {
	if (limited || task.status === 'rate-limited') return t(locale, 'subscription limit');
	if (task.status === 'needs-you') {
		const kind = task.activity?.kind;
		if (task.crew && kind === 'plan') return t(locale, 'the foreman is waiting for you');
		return `${t(locale, 'needs you')} · ${t(
			locale,
			kind === 'question'
				? 'question'
				: kind === 'plan'
					? 'plan'
					: kind === 'proposal'
						? 'new task (state)'
						: 'permission'
		)}`;
	}
	// spec/crew#attention: the foreman whose worker waits for the person.
	if (crewWaits) return t(locale, 'A worker is waiting for you').toLocaleLowerCase(locale);
	if (task.status === 'working' || task.status === 'preparing') return t(locale, 'working');
	return t(locale, statusLabels[task.status]).toLocaleLowerCase(locale);
}
/** «Назад» names the screen it returns to (spec/remote-access-and-mobile#phone-chat): the project, the home («Проєкти») or the task under a worker. */
export function backLabel(locale: Locale, under: Route | undefined, tasks: readonly AgentTask[]) {
	const workspace = useMobile.getState().workspace;
	if (under?.screen === 'project')
		return workspace?.projects.find((project) => project.id === under.projectId)?.name ?? '';
	// spec/remote-access-and-mobile#phone-pr-list: a task opened from a PR of the project's list goes back to that PR.
	if (under?.screen === 'pr') return `PR #${under.number}`;
	if (under?.screen === 'task' || under?.screen === 'tool')
		return (
			tasks.find((task) => task.id === under.taskId && task.projectId === under.projectId)?.title ??
			t(locale, 'Back')
		);
	return t(locale, 'Projects');
}
export function Task({
	projectId,
	taskId,
	locale,
}: {
	projectId: string;
	taskId: string;
	locale: Locale;
}) {
	const workspace = useMobile((state) => state.workspace),
		machine = useMobile((state) => state.machine),
		offline = useOffline(),
		{ sheet, under } = useRouter();
	const task = workspace?.tasks.find((item) => item.id === taskId && item.projectId === projectId),
		project = workspace?.projects.find((item) => item.id === projectId);
	const key = useMemo(() => ({ projectId, id: taskId }), [projectId, taskId]);
	const { snapshot, merge } = useSession(key);
	const [answers, setAnswers] = useState<Record<string, QuestionAnswer>>({});
	const [sentAt, setSentAt] = useState<number | null>(null),
		[retrying, setRetrying] = useState(false);
	const cache = useRef<MarkdownCache>(new Map());
	const records = snapshot?.records ?? [];
	// spec/chat-turns-plans-and-questions#plan-approval: a plan document that a plan request (or its removal) follows is shown by that request, not twice.
	const rows = useMemo(
		() =>
			displayRows(records, cache.current).filter(
				(row) =>
					row.kind !== 'event' ||
					row.record.event.kind !== 'plan.document' ||
					!records.some(
						(record) =>
							record.seq > row.record.seq &&
							((record.event.kind === 'permission.requested' &&
								isPlanApproval(record.event.request)) ||
								(record.event.kind === 'plan.removed' &&
									row.record.event.kind === 'plan.document' &&
									record.event.planId === row.record.event.planId))
					)
			),
		[records]
	);
	const pending = useMemo(() => pendingInputs(records), [records]);
	const queue = useMemo(() => promptQueue(records), [records]);
	const now = useSecondTick((queue.rateLimits ?? []).length > 0);
	const limit = blockedRateLimit(queue.rateLimits ?? [], now);
	const lastTurn = records.findLast((r) =>
		['turn.started', 'turn.completed', 'session.failed', 'host.stopped'].includes(r.event.kind)
	);
	const busy = lastTurn?.event.kind === 'turn.started';
	// The failed turn's «Повторити» (retryTurn): on the last failure only, while nothing came after it.
	const retrySeq = lastTurn?.event.kind === 'session.failed' ? lastTurn.seq : null;
	const session = records.findLast((r) => r.event.kind === 'session.started')?.event;
	const steering =
		busy &&
		session?.kind === 'session.started' &&
		session.steering === true &&
		!queue.paused &&
		!limit;
	const steers = steering && !queue.prompts.length;
	const optionsEvent = records.findLast(
		(r) => r.event.kind === 'options.changed' || r.event.kind === 'session.started'
	)?.event;
	const options = optionsEvent && 'options' in optionsEvent ? optionsEvent.options : [];
	const usage = records.findLast((r) => r.event.kind === 'usage.changed')?.event;
	const context =
		usage?.kind === 'usage.changed' && usage.capacity > 0
			? Math.round((usage.used / usage.capacity) * 100)
			: null;
	const idle = task?.transport !== 'terminal' && !snapshot?.issue && idleStopped(records);
	const connected = Boolean(snapshot?.connected) && agentRunning(records) && !idle;
	const status = useMemo(() => turnStatus(records), [records]);
	const shownStatus =
		status ??
		(sentAt !== null && !busy
			? { state: 'thinking' as const, startedAt: sentAt, target: null, more: 0 }
			: null);
	const send = useCallback(
		async (command: SessionCommand) => {
			try {
				await window.brigadir.sendCommand(key, command);
				return true;
			} catch {
				return false;
			}
		},
		[key]
	);
	/** An idle or never-started agent starts on the first message, as on the computer (spec/architecture-and-platform#host-lifecycle). */
	const prepare = async () => {
		if (connected) return true;
		try {
			const value = await window.brigadir.startSession(key);
			merge(value);
			return Boolean(value.connected && !value.queued);
		} catch {
			return false;
		}
	};
	// spec/chat-turns-plans-and-questions#turn-status-row: «Думає» from the tap on Send until the machine echoes the turn, as on the computer.
	const sendPrompt = async (command: SessionCommand) => {
		if (command.kind !== 'prompt') return send(command);
		setSentAt(Date.now());
		try {
			return await send(command);
		} finally {
			setSentAt(null);
		}
	};
	/** retryTurn sends the failed turn's prompt again; an agent that stopped starts first, as with a new message. */
	const retry = async () => {
		setRetrying(true);
		try {
			if (!(await send({ kind: 'retryTurn' })) && (await prepare()))
				await send({ kind: 'retryTurn' });
		} finally {
			setRetrying(false);
		}
	};
	const planBody = (request: PermissionRequest) => {
		if (!isPlanApproval(request)) return undefined;
		const at = records.find(
				(r) => r.event.kind === 'permission.requested' && r.event.request.id === request.id
			),
			text = at ? planApprovalText(request, records, at.seq) : null;
		return text ? (
			<div
				className={cards.planText}
				data-plan-text
				dangerouslySetInnerHTML={{ __html: markdown.render(text) }}
			/>
		) : undefined;
	};
	/** spec/chat-turns-plans-and-questions#question-card: the question's Markdown, the card's look as the plan's (cards.planText). */
	const questionBody = (text: string) => (
		<div className={cards.planText} dangerouslySetInnerHTML={{ __html: markdown.render(text) }} />
	);
	const cards_: ChatRow[] = [];
	if (task) {
		for (const question of pending.questions)
			cards_.push({
				id: `question-${question.id}`,
				kind: 'card',
				card: (
					<Question
						touch
						question={question}
						body={questionBody(question.question)}
						locale={locale}
						disabled={offline}
						answer={answers[question.id] ?? { labels: [], text: '' }}
						onChange={(answer) => setAnswers((all) => ({ ...all, [question.id]: answer }))}
						send={(command) => void send(command)}
						since={Date.parse(
							records.find(
								(r) => r.event.kind === 'question.requested' && r.event.question.id === question.id
							)?.at ?? ''
						)}
					/>
				),
			});
		for (const request of pending.permissions)
			cards_.push({
				id: `permission-${request.id}`,
				kind: 'card',
				card: (
					<PermissionCard
						touch
						request={request}
						body={planBody(request)}
						locale={locale}
						disabled={offline}
						send={(command) => void send(command)}
						since={Date.parse(
							records.find(
								(r) => r.event.kind === 'permission.requested' && r.event.request.id === request.id
							)?.at ?? ''
						)}
					/>
				),
			});
		for (const question of pending.crewQuestions)
			cards_.push({
				id: `crew-question-${question.id}`,
				kind: 'card',
				card: (
					<CrewQuestionCard
						question={question}
						locale={locale}
						disabled={offline}
						send={(command) => void send(command)}
					/>
				),
			});
		for (const proposal of pending.proposals)
			cards_.push({
				id: `proposal-${proposal.id}`,
				kind: 'card',
				card: <ProposalCard proposal={proposal} task={task} locale={locale} disabled={offline} />,
			});
		if (pending.crewPlan)
			cards_.push({
				id: `plan-${pending.crewPlan.id}`,
				kind: 'card',
				card: (
					<CrewPlanCard
						plan={pending.crewPlan}
						task={task}
						locale={locale}
						disabled={offline}
						send={(command) => void send(command)}
					/>
				),
			});
	}
	const chatRows: ChatRow[] = useMemo(
		() => [
			...rows,
			...(shownStatus
				? [{ id: 'turn-status', kind: 'turnStatus' as const, status: shownStatus }]
				: []),
		],
		[rows, shownStatus?.state, shownStatus?.startedAt, shownStatus?.target]
	);
	if (limit && !shownStatus)
		cards_.unshift({
			id: 'limit-status',
			kind: 'card',
			card: (
				<div className={c.status} data-limit>
					<Icon name="clock" size={16} />
					<b>{t(locale, 'Subscription limit')}</b>
					<span>
						·{' '}
						{t(locale, 'resets in {time}').replace(
							'{time}',
							limitTime(
								locale,
								limit.resetsAt === null
									? null
									: Math.max(1, Math.ceil((limit.resetsAt * 1000 - now) / 60_000))
							)
						)}
					</span>
				</div>
			),
		});
	const allRows = [...chatRows, ...cards_];
	const actions = {
		retrySeq: offline ? null : retrySeq,
		retry: () => void retry(),
		retrying,
	};
	const render = useCallback(
		(row: ChatRow) => <div className={c.row}>{renderChatRow(row, locale, actions)}</div>,
		[locale, answers, offline, pending, retrySeq, retrying]
	);
	const backTo = backLabel(locale, under, workspace?.tasks ?? []);
	if (!task)
		return (
			<div className={s.screen} data-screen="task">
				<NavBar left={<BackButton label={backTo} locale={locale} onClick={back} />} />
				{workspace ? (
					<p className={s.empty}>{t(locale, 'The task is gone.')}</p>
				) : (
					<Loading locale={locale} />
				)}
			</div>
		);
	const crewWaits = task.status !== 'needs-you' && crewNeedsYou(task, workspace?.tasks ?? []);
	const head = `${project?.name ?? ''} · ${stateLine(locale, task, Boolean(limit), crewWaits)}`;
	const limitMinutes = limit
		? limit.resetsAt === null
			? 0
			: Math.max(1, Math.ceil((limit.resetsAt * 1000 - now) / 60_000))
		: null;
	return (
		<div className={s.screen} data-screen="task" data-task={task.id}>
			<NavBar
				left={<BackButton label={backTo} locale={locale} onClick={back} />}
				title={task.title}
				sub={head}
				right={
					<NavIcon
						icon="more"
						label={t(locale, 'Task menu')}
						onClick={() => openSheet({ kind: 'menu' })}
					/>
				}
			/>
			<div
				className={c.log}
				data-chat
				onClick={(event) => {
					const link = (event.target as HTMLElement).closest('a');
					if (!link) return;
					// A link never navigates the app away: that would end the signed-in page (spec/remote-access-and-mobile#phone-chat).
					event.preventDefault();
					openChatLink(link.getAttribute('href') ?? '', task);
				}}>
				{snapshot ? (
					<Rows
						rows={allRows}
						render={render}
						label={t(locale, 'Chat')}
						alignBottom
						followOutput
						estimatedHeight={54}
						bottomInset={7}
						locale={locale}
					/>
				) : offline ? (
					<p className={s.empty}>
						{t(locale, 'No connection to {machine}').replace('{machine}', machine)}
					</p>
				) : (
					<Loading locale={locale} />
				)}
			</div>
			<div className={s.bottom} data-clear>
				<Composer
					task={task}
					locale={locale}
					machine={machine}
					busy={busy}
					steers={steers}
					steering={steering}
					disabled={offline}
					limitMinutes={limitMinutes}
					queued={queue.prompts.filter(isOwnQueuedPrompt)}
					options={options}
					context={context}
					send={sendPrompt}
					prepare={prepare}
					openChanges={() => navigate({ screen: 'tool', projectId, taskId, tool: 'changes' })}
					openModel={() => openSheet({ kind: 'model' })}
					openLimit={() => openSheet({ kind: 'limit' })}
				/>
			</div>
			<TaskSheets
				sheet={sheet}
				task={task}
				locale={locale}
				busy={busy}
				options={options}
				plan={pending.crewPlan}
				limitMinutes={limitMinutes}
				send={send}
				headSub={head}
			/>
		</div>
	);
}
