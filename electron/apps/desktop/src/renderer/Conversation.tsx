import { ArchivedStrip } from './Archive';
import { StateStrip } from './ui/StateStrip';
import { useRateLimit } from './RateLimit';
import { AuthChip, RateLimitChip } from './TaskNotices';
import { onSessionEvent } from './session-events';
import { useHeadlessGhost } from './use-ghost';
import { FileLinkText } from './FileLinks';
import { ComposerOptions } from './ComposerOptions';
import { ComposerSend } from './ComposerSend';
import { ComposerEnvironment } from './ComposerEnvironment';
import { ComposerBar, ComposerDropZone, ComposerIsland, ComposerText } from './ui/ComposerIsland';
import { useComposerEditor, type ComposerAction } from './ComposerMentions';
import { ContextMeter } from './ContextMeter';
import { fileDropHandlers } from './ui/file-drop';
import { ToolDiff, TurnFooter, ToolElapsed } from './ActivityDetails';
import { useSecondTick } from './ui/second-tick';
import { ChangeCounts } from './ui/ChangeCounts';
import { AttachmentChips } from './ui/AttachmentChips';
import { PromptText } from './ui/PromptText';
import { inListLine } from './composer-format';
import {
	Fragment,
	lazy,
	Suspense,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type FormEvent,
	type ClipboardEvent,
} from 'react';
import { markdown, MarkdownBlock } from './MarkdownBlock';
import { QuestionText } from './QuestionText';
import {
	agentSlashCommands,
	withPlatformKeys,
	mcpCall,
	mcpRow,
	foldedCrewEvents,
	crewWorkersFromLog,
	type McpWorker,
	commandAccelerator,
	defaultKeymap,
	formatAccelerator,
	matchesAccelerator,
	menuCommands,
	idleStopped,
	agentRunning,
	ghostSuggestion,
	moreLineCount,
	toolHeadline,
	ghostTurn,
	planSummary,
	type PlanEntry,
	nextAgentMode,
	selectOption,
	promptDisplayText,
	promptQueue,
	isOwnQueuedPrompt,
	turnResponse,
	turnSummarizer,
	shownTurnStatus,
	formatDuration,
	pendingInputs,
	t,
	toolCallCount,
	toolErrorCount,
	moreFileCount,
	toolGroupSummary,
	toolGroupDuration,
	toolMixText,
	toolGroupName,
	chipDirectory,
	type ToolGroupFile,
	validAnswer,
	type QueuedPrompt,
	type TurnStatus,
	type ActivityRow,
	type AgentTask,
	type Locale,
	type QuestionAnswer,
	type SessionCommand,
	type SessionSnapshot,
	type UserQuestion,
	changeCountsLabel,
	type MessageKey,
} from '@brigadir/core';
import { McpToolRow, crewWorkers } from './McpToolRow';
import { SubagentBlock } from './SubagentBlock';
import {
	shownTabs,
	withFocusedTabs,
	turnBackground,
	type ScopeLockView,
	toolInputPrompt,
} from '@brigadir/core';
import {
	useTaskState,
	pickTaskFiles,
	pasteTaskImage,
	dropTaskFiles,
	rowPosition,
} from './task-state';
import { pasteKind, clipboardHasImage } from './composer-paste';
import { applySessionEvent, mergeRecords, sessionReads } from './session-read';
import { Glyph } from './ui/Glyph';
import { Button, Chevron, IconButton, StatusIcon } from './ui/Controls';
import { Question, PermissionCard } from './ui/SessionInputs';
import {
	type TaskProposal,
	checklistPlan,
	planLineCount,
	planLinesLabel,
	isPlanApproval,
	planApprovalText,
	planApproveChoice,
	planApprovedMode,
	planPromptFeedback,
	sessionModeName,
} from '@brigadir/core';
import { CrewAnswerRow, CrewEventRow, PlanCard, PlanSummary } from './Crew';
import { QuickAskLogRow } from './QuickAsk';
import { PlanApproval, PlanApprovalSummary, PlanDocument, PlanReadOnly } from './PlanApproval';
import { TaskProposalCard, TaskProposalSummary } from './TaskProposal';
import { useWorkspace } from './store';
import { Rows } from './ui/Rows';
import { ScrollThumb, TurnRail, type RailTurn, type TurnRailControl } from './TurnRail';
import { AuthCard, AuthRow } from './AuthCard';
import { chatMenuMouseDown, openChatMenu } from './chat-menu';
import { notify } from './ui/Toast';
import { DeckList, DeckRow } from './ui/Deck';
import { BackgroundDeck } from './BackgroundDeck';
import styles from './Conversation.module.css';
const ToolTerminal = lazy(() => import('./ToolTerminal'));
import {
	displayRows,
	type DisplayRow,
	type MarkdownCache,
	type ToolGroupRow,
	type ToolRow,
} from './conversation-rows';
import { SkeletonText } from './ui/Loading';
export { displayRows, type MarkdownCache };
const noContention: readonly ScopeLockView[] = [];
/** Navigate ▸ turns, tools and Expand / Collapse conversation: the keys the conversation reads itself (spec/chat-turns-plans-and-questions#turn-rail). */
const chatNavigation = [
	'turn-next',
	'turn-previous',
	'next-block',
	'previous-block',
	'activity-expand',
	'activity-collapse',
] as const;
/** spec/notifications-slack-notes-and-schedules#message-classes: what a failed session command was, for its own toast. */
const sendFailures: Partial<Record<SessionCommand['kind'], MessageKey>> = {
	prompt: 'Could not send the message.',
	steerQueuedPrompt: 'Could not send the message.',
	cancel: 'Could not stop the turn.',
	setMode: 'Could not change the agent mode.',
	setOption: 'Could not change the agent setting.',
	answerPermission: 'Could not send the answer to the agent.',
	answerQuestion: 'Could not send the answer to the agent.',
	answerCrewQuestion: 'Could not send the answer to the agent.',
	decidePlan: 'Could not send the decision on the plan.',
	removeQueuedPrompt: 'Could not remove the message from the queue.',
	resumePromptQueue: 'Could not resume the queue.',
	retryTurn: 'Could not retry the turn.',
	stopBackground: 'Could not stop the background command.',
	stopSubagent: 'Could not stop the subagent.',
};
/** Texts the composer editor reports as they are; anything else it reports is the raw failure of the `@` file search. */
const editorFailures: readonly MessageKey[] = [
	'The files could not be attached. Check the attachment limits.',
	'The task summary could not be attached.',
];
export function Conversation({
	task,
	locale,
	reviewPending = 0,
	onSendReview = null,
	onRelay,
	onProposal,
	contended = noContention,
	notices,
}: {
	task: AgentTask;
	locale: Locale;
	reviewPending?: number;
	onSendReview?: (() => void) | null;
	onRelay?: () => void;
	onProposal?: (proposal: TaskProposal) => void;
	/** spec/notifications-slack-notes-and-schedules#repo-contention: contended repos of this task, for the chip in the environment footer. */ contended?: readonly ScopeLockView[];
	/** spec/notifications-slack-notes-and-schedules#notice-chips: the task view's other class S chips (read-only change, unavailable repos). */ notices?: React.ReactNode;
}) {
	const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
	const [starting, setStarting] = useState(false);
	const [resuming, setResuming] = useState(false);
	const [linkEpoch, setLinkEpoch] = useState(0);
	const root = useRef<HTMLDivElement>(null),
		focusedToolId = useRef<string | null>(null);
	// The composer island floats over the log (spec/composer#glass-overlay): the log runs under it and keeps its last row clear by the island's height.
	const dock = useRef<HTMLDivElement>(null),
		[dockHeight, setDockHeight] = useState(0);
	useLayoutEffect(() => {
		const node = dock.current;
		if (!node) return;
		const read = () => setDockHeight(node.offsetHeight);
		read();
		const observer = new ResizeObserver(read);
		observer.observe(node);
		return () => observer.disconnect();
	}, []);
	const [pickingFiles, setPickingFiles] = useState(false);
	const [dropOver, setDropOver] = useState(false);
	const composerForm = useRef<HTMLFormElement>(null);
	const [
		{
			ghostDismissedTurn,
			activityExpanded,
			activityTarget,
			composerLoaded,
			composerRevision,
			attachments,
			focusTurn,
			returnToDiff,
			positions,
			text,
			answers,
			focusComposer,
			editorGroups,
			documents,
			activeDocument,
			workShown,
		},
		setTask,
	] = useTaskState(task);
	const [sending, setSending] = useState(false);
	const [submittedAt, setSubmittedAt] = useState<number | null>(null);
	/** spec/notifications-slack-notes-and-schedules#message-classes: each failure is its own toast that names the action; the shared «The request failed.» line is gone. */
	const fail = (key: MessageKey, options: { retry?: () => void; warning?: boolean } = {}) =>
		notify(options.warning ? 'warning' : 'error', t(locale, key), {
			action: options.retry ? { label: t(locale, 'Retry'), run: options.retry } : undefined,
		});
	// The draft saves on every keystroke: one toast per failure streak, not one per key.
	const draftFailed = useRef(false);
	const saveDraft = (value: string) => {
		void window.brigadir.saveComposer(task, value).then(
			() => {
				draftFailed.current = false;
			},
			() => {
				if (draftFailed.current) return;
				draftFailed.current = true;
				fail('The chat draft could not be saved.');
			}
		);
	};
	const setText = (value: string | ((previous: string) => string)) => {
		let next = text,
			changed = false;
		setTask((state) => {
			next = typeof value === 'function' ? value(state.text) : value;
			changed = next !== state.text;
			return { text: next, composerRevision: state.composerRevision + Number(changed) };
		});
		if (changed) saveDraft(next);
	};
	const setAnswers = (
		value: (previous: Record<string, QuestionAnswer>) => Record<string, QuestionAnswer>
	) => setTask((state) => ({ answers: value(state.answers) }));
	const merge = useCallback(
		(value: SessionSnapshot) =>
			setSnapshot((current) => ({
				...value,
				records: mergeRecords(current?.records ?? [], value.records),
			})),
		[]
	);
	useEffect(() => {
		// The history is read once; a null event (metadata, reconnect) asks only for records after it.
		let initial = true;
		const reads = sessionReads(
			task,
			(value) => {
				merge(value);
				if (!initial) return;
				initial = false;
				setTask((state) => ({
					historyLoaded: true,
					text:
						!state.historyLoaded &&
						state.composerRevision === 0 &&
						value.records.some((r) => r.event.kind === 'turn.started')
							? ''
							: state.text,
				}));
			},
			() => {
				if (!initial) return;
				initial = false;
				fail('Could not read the chat history.', {
					warning: true,
					retry: () => {
						initial = true;
						reads.refresh();
					},
				});
			}
		);
		const stop = onSessionEvent(({ key, record }) => {
			if (key.id !== task.id || key.projectId !== task.projectId) return;
			if (!record) {
				setLinkEpoch((value) => value + 1);
				reads.refresh();
			}
			if (record?.event.kind === 'turn.started' && !record.event.queuedPromptId) {
				const sent = record.event.text;
				setText((current) => (current === sent ? '' : current));
			}
			setSnapshot((current) => applySessionEvent(current, key, record));
		});
		reads.refresh();
		return () => {
			reads.stop();
			stop();
		};
	}, [task.id, task.projectId, merge]);
	const markdownCache = useRef<MarkdownCache>(new Map());
	const records = snapshot?.records ?? [];
	const rows = useMemo(() => displayRows(records, markdownCache.current), [records]);
	const workspaceTasks = useWorkspace((state) => state.workspace?.tasks) ?? [];
	const linkRevision =
		(records.findLast(
			(record) => record.event.kind === 'checkpoint.created' || record.event.kind === 'file.saved'
		)?.seq ?? 0) + linkEpoch;
	const queue = useMemo(() => promptQueue(records), [records]);
	// spec/composer-steering-queue-and-ghost#queue-deck: the deck lists the person's own messages; a crew service prompt waits in the FIFO without a row.
	const ownQueue = useMemo(() => queue.prompts.filter(isOwnQueuedPrompt), [queue]);
	const rateLimit = useRateLimit(queue.rateLimits ?? []);
	// Folds only appended records; a new snapshot starts over.
	const foldedCrew = useMemo(() => foldedCrewEvents(records), [records]),
		loggedWorkers = useMemo(() => crewWorkersFromLog(records), [records]);
	const summarize = useRef(turnSummarizer()).current;
	const turns = useMemo(() => summarize(records), [records]);
	const pending = useMemo(() => pendingInputs(records), [records]);
	// spec/chat-turns-plans-and-questions#turn-rail: one rail mark per prompt; the text is the prompt's own row (a human message or a crew event).
	const railTurns = useMemo((): RailTurn[] => {
		const texts = new Map<string, string>();
		for (const row of rows) {
			if (row.kind === 'message' && row.role === 'user')
				texts.set(row.id, promptDisplayText(row.text, row.attachments ?? []));
			else if (row.kind === 'event' && row.record.event.kind === 'turn.started')
				texts.set(
					row.id,
					promptDisplayText(row.record.event.text, row.record.event.attachments ?? [])
				);
		}
		return turns.flatMap((turn) => {
			const text = texts.get(`user-${turn.seq}`);
			return text === undefined
				? []
				: [
						{
							seq: turn.seq,
							number: turn.number,
							text,
							at: turn.at,
							running: turn.status === 'running',
							range: turn.range,
						},
					];
		});
	}, [rows, turns]);
	const railControl = useRef<TurnRailControl | null>(null);
	const lastTurn = records.findLast((r) =>
		['turn.started', 'turn.completed', 'session.failed', 'host.stopped'].includes(r.event.kind)
	);
	const busy = lastTurn?.event.kind === 'turn.started';
	// spec/chat-turns-plans-and-questions#turn-status-row: the last log row while a turn runs; from the click on Send, before the host echoes turn.started.
	const shownStatus = useMemo(() => shownTurnStatus(records, submittedAt), [records, submittedAt]);
	const logRows = useMemo(
		(): DisplayRow[] =>
			shownStatus
				? [...rows, { id: 'turn-status', kind: 'turnStatus', status: shownStatus }]
				: rows,
		[rows, shownStatus]
	);
	const session = records.findLast((r) => r.event.kind === 'session.started')?.event;
	// spec/composer-steering-queue-and-ghost#steering: with steering the person's message goes into the running turn, not behind it.
	// An adopted turn (a steer the agent ran as its own turn, never queued) takes no second steer: the host queues it.
	const adopted =
		lastTurn?.event.kind === 'turn.started' &&
		Boolean(lastTurn.event.queuedPromptId) &&
		!records.some(
			(record) =>
				record.event.kind === 'prompt.queued' &&
				lastTurn.event.kind === 'turn.started' &&
				record.event.prompt.id === lastTurn.event.queuedPromptId
		) &&
		records.some(
			(record) =>
				record.event.kind === 'prompt.steered' &&
				lastTurn.event.kind === 'turn.started' &&
				record.event.prompt.id === lastTurn.event.queuedPromptId
		);
	// spec/composer-steering-queue-and-ghost#steering-hold: a queued message can still go into the running turn (the deck's «Send now»); a new one does when nothing is queued.
	const steering =
		busy &&
		!adopted &&
		session?.kind === 'session.started' &&
		session.steering === true &&
		!queue.paused &&
		!rateLimit;
	const steers = steering && !queue.prompts.length;
	const optionsEvent = records.findLast(
		(r) => r.event.kind === 'options.changed' || r.event.kind === 'session.started'
	)?.event;
	const options = optionsEvent && 'options' in optionsEvent ? optionsEvent.options : [];
	const modeEvent = records.findLast(
		(r) => r.event.kind === 'mode.changed' || r.event.kind === 'session.started'
	)?.event;
	const usage = records.findLast((r) => r.event.kind === 'usage.changed')?.event;
	const hostConnected = Boolean(snapshot?.connected);
	// spec/architecture-and-platform#host-lifecycle: a host stopped for idleness is not a stopped agent: no banner, and the next message starts it again.
	const idle = task.transport !== 'terminal' && !snapshot?.issue && idleStopped(records);
	// A host up only for the task's consoles (spec/task-window-workspace#restore-window) is connected without an agent: the Resume banner, not a prompt it refuses.
	const connected = hostConnected && agentRunning(records) && !idle;
	// spec/chat#collapse-rules: free heuristics first, opt-in disposable generation for remaining cases.
	const suggestion = useMemo(
		() => ghostSuggestion(records, reviewPending, locale),
		[records, reviewPending, locale]
	);
	const [ghostReady, setGhostReady] = useState(false),
		currentTurn = ghostTurn(records);
	const headless = useHeadlessGhost({
		task,
		records,
		composerEmpty: composerLoaded && !text && !attachments.length,
		dismissed: ghostDismissedTurn === currentTurn,
		heuristicFound: Boolean(suggestion),
		connected,
		root,
	});
	useEffect(() => {
		setGhostReady(false);
		if (!suggestion) return;
		const timer = setTimeout(() => setGhostReady(true), 400);
		return () => clearTimeout(timer);
	}, [suggestion?.text, currentTurn]);
	const ghost =
		!rateLimit &&
		(connected || idle) &&
		!busy &&
		!text &&
		!attachments.length &&
		ghostDismissedTurn !== currentTurn
			? ghostReady && suggestion
				? suggestion
				: headless.text
					? { kind: 'generated' as const, text: headless.text }
					: null
			: null;
	const acceptGhost = () => {
		if (!ghost) return;
		if (ghost.kind === 'review') {
			onSendReview?.();
			return;
		}
		setText(ghost.text);
		requestAnimationFrame(() => editor.handle.focus('end'));
	};
	const attachFiles = () => {
		setPickingFiles(true);
		void pickTaskFiles(task)
			.catch(() => fail('The files could not be attached. Check the attachment limits.'))
			.finally(() => setPickingFiles(false));
	};
	// spec/composer#slash-menu: the composer's own actions in `/`; a screenshot only while its column is on screen.
	const modules = useWorkspace((state) => state.appearance.modules);
	// spec/task-window-workspace#work-area: a screenshot only while a tab of that tool is on screen in the work area.
	const toolOnScreen = (kind: 'browser' | 'simulator') =>
		workShown &&
		shownTabs(withFocusedTabs(editorGroups, { documents, activeDocument })).some(
			(tab) => tab.kind === kind
		);
	const composerActions: ComposerAction[] = [
		{
			action: 'attach',
			label: t(locale, 'Attach files'),
			description: t(locale, 'Up to 10 files, 8 MB total; images up to 4 MB.'),
			run: attachFiles,
		},
		...(modules.browser && toolOnScreen('browser')
			? [
					{
						action: 'browser-screenshot' as const,
						label: t(locale, 'Browser screenshot'),
						description: t(locale, 'Attach screenshot'),
						run: () => window.brigadir.dispatchWorkspaceAction('browser-screenshot'),
					},
				]
			: []),
		...(modules.simulator && toolOnScreen('simulator')
			? [
					{
						action: 'simulator-screenshot' as const,
						label: t(locale, 'Simulator screenshot'),
						description: t(locale, 'Send screenshot to chat'),
						run: () => window.brigadir.dispatchWorkspaceAction('simulator-screenshot'),
					},
				]
			: []),
	];
	const send = useCallback(
		async (command: SessionCommand) => {
			setSending(true);
			try {
				await window.brigadir.sendCommand(task, command);
				return true;
			} catch (failure) {
				// The host refuses a queued prompt that already went to the agent: that is a fact, not a failure to send.
				const gone =
					(command.kind === 'removeQueuedPrompt' || command.kind === 'steerQueuedPrompt') &&
					String(failure).includes('no longer queued');
				if (gone) notify('info', t(locale, 'The message has already left the queue.'));
				else fail(sendFailures[command.kind] ?? 'Could not send the command to the agent.');
				return false;
			} finally {
				setSending(false);
			}
		},
		[task.id, task.projectId, locale]
	);
	const nextMode = nextAgentMode(
		options,
		session?.kind === 'session.started' ? session.modes : [],
		modeEvent && 'modeId' in modeEvent ? modeEvent.modeId : null
	);
	// spec/settings-modules-and-onboarding#settings-keys: Next agent mode follows the keymap, like its View menu item.
	const modeKeymap = useWorkspace((state) => state.appearance.keymap) ?? defaultKeymap,
		modeCommand = menuCommands.find((item) => item.id === 'composer-mode'),
		modeShortcut = modeCommand && commandAccelerator(modeCommand, modeKeymap);
	const queueCommand = menuCommands.find((item) => item.id === 'composer-queue'),
		queueShortcut = queueCommand && commandAccelerator(queueCommand, modeKeymap);
	/** A Navigate command's key in the keymap (spec/search-menus-and-commands#menu-structure). */
	const navigationShortcut = (id: (typeof chatNavigation)[number]) => {
		const command = menuCommands.find((item) => item.id === id);
		return command && commandAccelerator(command, modeKeymap);
	};
	const cancelCommand = menuCommands.find((item) => item.id === 'cancel'),
		stopShortcut = cancelCommand && commandAccelerator(cancelCommand, modeKeymap);
	// spec/chat#tool-calls: the question card names the key that answers it — View ▸ Submit (⌘↩ by default).
	const submitCommand = menuCommands.find((item) => item.id === 'review-send'),
		submitAccelerator = submitCommand && commandAccelerator(submitCommand, modeKeymap),
		submitShortcut = submitAccelerator ? formatAccelerator(submitAccelerator) : null;
	const canCycleMode = connected && !busy && !sending && nextMode !== null;
	// spec/composer#agent-capsule: `Compact` in the context popover — only when the agent announced /compact and is free to take it.
	const announcesCompact = useMemo(
			() => agentSlashCommands(records)?.some((command) => command.name === 'compact') ?? false,
			[records]
		),
		canCompact = announcesCompact && connected && !busy && !sending && !rateLimit;
	const cycleMode = () => {
		if (canCycleMode && nextMode) void send(nextMode);
	};
	/** spec/composer#formatting: ⇧Tab on a list item moves the item a level; the agent's mode is for the rest of the text. */
	const onListItem = () => {
		const view = editor.handle.view;
		return Boolean(view?.hasFocus && inListLine(view.state));
	};
	useEffect(
		() =>
			window.brigadir.onWorkspaceAction((action) => {
				if (
					action === 'composer-mode' &&
					!document.querySelector('dialog[open]') &&
					composerForm.current?.contains(document.activeElement) &&
					!onListItem()
				)
					cycleMode();
			}),
		[canCycleMode, JSON.stringify(nextMode)]
	);
	// spec/agents-and-providers#sign-in-recovery: a failed turn starts again in its host; a session that never started starts the task again.
	const retryAuth = useRef<() => void>(() => {});
	// spec/notifications-slack-notes-and-schedules#notice-chips: the sign-in still waits while the last auth failure has no turn or session after it — the same test the log card uses.
	const authFailure = useMemo(() => {
		const index = records.findLastIndex(
			(record) => record.event.kind === 'session.failed' && record.event.reason === 'auth'
		);
		if (index < 0) return null;
		if (
			records
				.slice(index + 1)
				.some(
					(record) =>
						record.event.kind === 'turn.started' || record.event.kind === 'session.started'
				)
		)
			return null;
		const record = records[index]!,
			boundary = (kind: string) =>
				['turn.started', 'turn.completed', 'session.failed', 'host.stopped'].includes(kind);
		const previous = records.slice(0, index).findLast((item) => boundary(item.event.kind))?.event,
			row = rows.find((item) => 'record' in item && item.record.seq === record.seq);
		return {
			detail:
				(row && 'detail' in row ? row.detail : undefined) ??
				(record.event.kind === 'session.failed' ? record.event.message : ''),
			startup: previous?.kind !== 'turn.started',
			failedAt: Date.parse(record.at),
		};
	}, [records, rows]);
	const start = async () => {
		setStarting(true);
		try {
			merge(await window.brigadir.startSession(task));
		} catch {
			fail('Could not start the agent.', {
				retry: () => {
					void start();
				},
			});
		} finally {
			setStarting(false);
		}
	};
	retryAuth.current = () => {
		if (hostConnected) void send({ kind: 'retryTurn' });
		else void start();
	};
	/** The normal launch path (lock conflict, agent slots); false keeps the draft: the start failed, was cancelled or waits in the queue. */
	const resume = async () => {
		setResuming(true);
		try {
			const value = await window.brigadir.startSession(task);
			merge(value);
			return Boolean(value.connected && !value.queued && !idleStopped(value.records));
		} catch {
			fail('Could not start the agent.', {
				retry: () => {
					void start();
				},
			});
			return false;
		} finally {
			setResuming(false);
		}
	};
	useEffect(() => {
		if (composerLoaded) return;
		let active = true;
		const revision = composerRevision;
		void window.brigadir.readComposer(task).then(
			(draft) => {
				if (active)
					setTask((state) => ({
						composerLoaded: true,
						...(draft !== null && state.composerRevision === revision
							? { text: draft, historyLoaded: true }
							: {}),
					}));
			},
			() => {
				if (active) {
					setTask({ composerLoaded: true });
					fail('The chat draft could not be read.', {
						warning: true,
						retry: () => setTask({ composerLoaded: false }),
					});
				}
			}
		);
		return () => {
			active = false;
		};
	}, [task.id, task.projectId, composerLoaded]);
	useEffect(() => {
		if (composerLoaded) saveDraft(text);
	}, [task.id, task.projectId, composerLoaded, text]);
	// spec/composer-steering-queue-and-ghost#steering, spec/composer-steering-queue-and-ghost#steering-hold: the composer's own message may go into the running turn (`steer`); ⌘↩ and «To the queue» queue it instead.
	const submitPrompt = async (steer: boolean) => {
		if (
			rateLimit ||
			sending ||
			resuming ||
			!(connected || idle) ||
			!composerLoaded ||
			(!text.trim() && !attachments.length)
		)
			return;
		setSubmittedAt(Date.now());
		try {
			const prepared = await editor.prepare(text);
			if (!prepared) return;
			const ids = prepared.attachmentIds;
			if (idle && !(await resume())) return;
			if (
				await send({
					kind: 'prompt',
					text: prepared.text,
					attachmentIds: ids,
					...(steer ? { steer: true as const } : {}),
				})
			)
				setTask((state) => ({
					text: state.text === text ? '' : state.text,
					composerRevision: state.composerRevision + 1,
					attachments: state.attachments.filter((item) => !ids.includes(item.id)),
				}));
		} finally {
			setSubmittedAt(null);
		}
	};
	const submit = (e: FormEvent) => {
		e.preventDefault();
		void submitPrompt(true);
	};
	const queuePrompt = () => {
		if (busy) void submitPrompt(false);
	};
	const queuePromptRef = useRef(queuePrompt);
	queuePromptRef.current = queuePrompt;
	/** spec/composer#mentions: the composer text — the sheet's editor with pills; its own keys run under the open `@` / `/` menu. */
	const composerFocused = () =>
		Boolean(
			document.activeElement?.closest('[data-prompt]') &&
			composerForm.current?.contains(document.activeElement)
		);
	const editor = useComposerEditor({
		task,
		locale,
		records,
		text,
		setText,
		actions: composerActions,
		placeholder: ghost
			? ghost.text
			: busy
				? withPlatformKeys(
						steers
							? queueShortcut
								? t(locale, '↩ send now · {queue} to the queue').replace(
										'{queue}',
										formatAccelerator(queueShortcut)
									)
								: t(locale, '↩ send now')
							: t(locale, '↩ to the queue')
					)
				: // spec/composer#agent-capsule: the empty field teaches the keys, named as this platform spells them (spec/architecture-and-platform#window-frame).
					t(locale, '{send} send · {newline} new line · @ files · / commands')
						.replace('{send}', formatAccelerator('Enter'))
						.replace('{newline}', formatAccelerator('Shift+Enter')),
		placeholderKey: ghost ? 'Tab' : undefined,
		attributes: {
			'aria-busy': String(!composerLoaded),
			...(ghost
				? {
						'data-ghost': ghost.kind,
						'aria-description': t(locale, 'Accept the suggestion with Tab'),
					}
				: {}),
		},
		disabled: !!rateLimit || starting || Boolean(snapshot?.issue),
		modelValue: selectOption(options, 'model')?.value ?? null,
		keys: [
			{
				key: 'Enter',
				run: (view) => {
					if (view.composing) return false;
					composerForm.current?.requestSubmit();
					return true;
				},
			},
			{
				key: 'Tab',
				run: () => {
					if (!ghost) return false;
					acceptGhost();
					return true;
				},
			},
			{
				key: 'Escape',
				run: () => {
					if (!ghost && !headless.pending) return false;
					setTask({ ghostDismissedTurn: currentTurn });
					setGhostReady(false);
					return true;
				},
			},
		],
		ownPaste: (event) => {
			const data = event.clipboardData;
			return Boolean(
				data && pasteKind(data.getData('text/plain'), clipboardHasImage(data)) === 'image'
			);
		},
		onError: (message) => {
			if (editorFailures.some((key) => t(locale, key) === message)) notify('error', message);
			else fail('Could not search the files.', { warning: true });
		},
	});
	const slashCommands = editor.commands;
	useEffect(() => {
		if (focusComposer) {
			editor.handle.focus('end');
			setTask({ focusComposer: false });
		}
	}, [focusComposer]);
	useEffect(
		() =>
			window.brigadir.onWorkspaceAction((action) => {
				if (
					action === 'composer-queue' &&
					!document.querySelector('dialog[open]') &&
					composerFocused()
				)
					queuePromptRef.current();
			}),
		[]
	);
	async function editQueued(item: QueuedPrompt) {
		if (
			item.command.kind === 'prompt' &&
			(text.length + item.command.text.length + 2 > 1_000_000 ||
				new Set([...attachments, ...item.attachments].map((item) => item.id)).size > 10)
		) {
			fail('The draft cannot hold this queued message.', { warning: true });
			return;
		}
		if (!(await send({ kind: 'removeQueuedPrompt', id: item.id }))) return;
		if (item.command.kind === 'submitReview') {
			setTask({ reviewOpen: true });
			return;
		}
		setText((previous) => [previous, item.command.text].filter(Boolean).join('\n\n'));
		setTask((state) => ({
			attachments: [
				...new Map(
					[...state.attachments, ...item.attachments].map((item) => [item.id, item])
				).values(),
			],
			focusComposer: true,
		}));
	}
	const editQueuedRef = useRef(editQueued);
	editQueuedRef.current = editQueued;
	const toolTargets = useMemo(
		() =>
			rows.flatMap((row) =>
				row.kind === 'tool'
					? [{ id: row.id, owner: row.id }]
					: row.kind === 'toolGroup'
						? row.tools.map((tool) => ({ id: tool.id, owner: row.id }))
						: []
			),
		[rows]
	);
	const focusedTool = toolTargets.find((tool) => tool.id === activityTarget);
	// spec/task-window-workspace#work-area: «In chat» on the agent's browser bar — the agent's last browser call, its group opened.
	useEffect(() => {
		if (activityTarget !== 'browser-tools') return;
		const browserTool = (tool: ToolRow) => mcpCall(tool.tool)?.tool.startsWith('browser_') ?? false;
		const found = [...rows].reverse().flatMap((row) =>
			row.kind === 'tool' && browserTool(row as ToolRow)
				? [{ id: row.id, owner: row.id }]
				: row.kind === 'toolGroup'
					? [...row.tools]
							.reverse()
							.filter(browserTool)
							.map((tool) => ({ id: tool.id, owner: row.id }))
					: []
		)[0];
		setTask((state) => ({
			activityTarget: found?.id ?? null,
			focusTurn: null,
			...(found
				? { activityExpanded: new Map(state.activityExpanded).set(found.owner, true) }
				: {}),
		}));
	}, [activityTarget, rows]);
	function navigate(action: string) {
		// ⌥⌘↑ / ⌥⌘↓ work from the conversation's own composer too: there they mean nothing to the text (spec/chat-turns-plans-and-questions#turn-rail).
		if (action === 'turn-next' || action === 'turn-previous') {
			const focus = document.activeElement;
			if (
				focus?.closest('dialog,[role="listbox"],[data-role="console"]') ||
				(focus?.closest('textarea,input,[data-prompt]') &&
					!root.current?.querySelector('form')?.contains(focus))
			)
				return;
			if (document.querySelector('[data-columns="3"]') && !root.current?.contains(focus)) return;
			railControl.current?.step(action === 'turn-next' ? 1 : -1);
			return;
		}
		if (
			document.activeElement?.closest(
				'dialog,textarea,input,[data-prompt],[role="listbox"],[data-role="console"]'
			)
		)
			return;
		if (
			document.querySelector('[data-columns="3"]') &&
			!root.current?.contains(document.activeElement)
		)
			return;
		if (action === 'next-block' || action === 'previous-block') {
			if (!toolTargets.length) return;
			const direction = action === 'next-block' ? 1 : -1,
				index = toolTargets.findIndex((tool) => tool.id === activityTarget),
				next =
					toolTargets[
						index < 0
							? direction === 1
								? 0
								: toolTargets.length - 1
							: (index + direction + toolTargets.length) % toolTargets.length
					]!;
			setTask((state) => ({
				activityTarget: next.id,
				focusTurn: null,
				activityExpanded: new Map(state.activityExpanded).set(next.owner, true),
			}));
		}
		if (action === 'activity-expand' || action === 'activity-collapse') {
			const open = action === 'activity-expand';
			setTask((state) => {
				const expanded = new Map(state.activityExpanded),
					shown = new Set(state.codeShown);
				// spec/appearance#evolution-redesign: «Expand» shows every code block whole, «Collapse» folds them back to 8 lines.
				const code = (row: DisplayRow) => {
					if (row.kind !== 'markdown') return;
					let index = 0;
					for (const token of row.tokens)
						if (token.type === 'fence' || token.type === 'code_block') {
							const id = `${row.id}/${index++}`;
							if (open) shown.add(id);
							else shown.delete(id);
						}
				};
				for (const row of rows) {
					if (row.kind === 'toolGroup') {
						expanded.set(row.id, open);
						for (const item of row.items) expanded.set(item.id, open);
						for (const tool of row.tools) expanded.set(`pin/${tool.id}`, open);
					} else if (
						row.kind === 'tool' ||
						row.kind === 'subagentBlock' ||
						(row.kind === 'message' && row.role === 'thought')
					)
						expanded.set(row.id, open);
					else code(row);
				}
				return { activityExpanded: expanded, codeShown: shown };
			});
		}
	}
	// One subscription for the conversation's life, not one per streamed record.
	const navigateRef = useRef(navigate);
	navigateRef.current = navigate;
	useEffect(() => window.brigadir.onWorkspaceAction((action) => navigateRef.current(action)), []);
	useEffect(() => {
		if (!activityTarget) focusedToolId.current = null;
	}, [activityTarget]);
	// A call inside a group that opens in the same commit is not focusable until its disclosure shows: a few more frames (spec/chat#tool-groups).
	function focusTool(node: HTMLElement | null, id: string) {
		if (node && activityTarget === id && focusedToolId.current !== id) {
			focusedToolId.current = id;
			let frames = 0;
			const go = () => {
				if (!node.isConnected || focusedToolId.current !== id) return;
				node.focus({ preventScroll: true });
				if (document.activeElement === node) node.scrollIntoView({ block: 'nearest' });
				else if (frames++ < 30) requestAnimationFrame(go);
			};
			go();
		}
	}

	function disclosure(id: string, fallback: boolean) {
		const open = activityExpanded.get(id) ?? fallback;
		return {
			open,
			onToggle: (event: React.SyntheticEvent<HTMLDetailsElement>) => {
				if (event.target !== event.currentTarget || event.currentTarget.open === open) return;
				const next = event.currentTarget.open;
				setTask((state) => ({ activityExpanded: new Map(state.activityExpanded).set(id, next) }));
			},
		};
	}
	/** One tool call; a pinned copy under a collapsed group keeps its own disclosure and target `pin/<id>`, so it is not the call ⌥⌘↓ moves to. */
	function toolRow(row: ToolRow, key: string, fallback: boolean) {
		// spec/chat#mcp-calls: an MCP call names its action by state and shows the outcome; a Codex call too, not as a terminal row.
		if (mcpCall(row.tool)) {
			const pinnedMcp = key !== row.id,
				state =
					row.tool.status === 'completed'
						? 'done'
						: row.tool.status === 'failed'
							? 'failed'
							: row.finishedAt !== null
								? 'interrupted'
								: 'running',
				mcp = disclosure(key, pinnedMcp ? false : state === 'failed');
			return (
				<McpToolRow
					tool={row.tool}
					state={state}
					startedAt={row.startedAt}
					finishedAt={row.finishedAt}
					locale={locale}
					open={mcp.open}
					onToggle={mcp.onToggle}
					className={styles.tool}
					summaryRef={(node) => {
						if (!pinnedMcp) focusTool(node, row.id);
					}}
					worker={crewWorkers(workspaceTasks, task, loggedWorkers)}
					{...(pinnedMcp ? { target: key } : {})}
				/>
			);
		}
		const pinned = key !== row.id,
			toolDisclosure = disclosure(key, fallback),
			head = toolHeadline(row.tool),
			exit = row.tool.exitCode;
		// spec/chat#subagents: a `think` call of an older log (a subagent before subagent sessions) shows its prompt, not its raw input.
		const prompt =
			row.tool.category === 'think' && row.tool.input ? toolInputPrompt(row.tool.input) : null;
		// spec/chat#tool-headline: chevron · status · name · one-line target · +N lines … exit · time.
		return (
			<details className={styles.tool} {...toolDisclosure}>
				<summary
					{...(pinned
						? { 'data-tool-target': key }
						: {
								ref: (node: HTMLElement | null) => focusTool(node, row.id),
								'data-tool-target': row.id,
							})}>
					<Chevron />
					<StatusIcon
						status={
							row.tool.status === 'completed'
								? 'done'
								: row.tool.status === 'failed'
									? 'failed'
									: row.finishedAt !== null
										? 'interrupted'
										: 'working'
						}
						label={t(
							locale,
							row.tool.status === 'completed'
								? 'Done'
								: row.tool.status === 'failed'
									? 'Error'
									: row.finishedAt !== null
										? 'Interrupted'
										: 'Working'
						)}
					/>
					{head.name && <strong>{head.name}</strong>}
					{head.target && (
						<span className={styles.target} data-named={Boolean(head.name)} title={row.tool.title}>
							<FileLinkText
								text={head.target}
								task={task}
								locale={locale}
								revision={linkRevision}
							/>
						</span>
					)}
					{head.extraLines > 0 && <small>{moreLineCount(locale, head.extraLines)}</small>}
					<span className={styles.spacer} />
					{exit !== undefined && exit !== 0 && <small className={styles.exit}>exit {exit}</small>}
					<ToolElapsed startedAt={row.startedAt} finishedAt={row.finishedAt} locale={locale} />
				</summary>
				{row.tool.category === 'execute' ? (
					<>
						{head.extraLines > 0 && <pre>{row.tool.title}</pre>}
						{toolDisclosure.open && (
							<Suspense fallback={<SkeletonText lines={3} />}>
								<ToolTerminal tool={row.tool} locale={locale} />
							</Suspense>
						)}
					</>
				) : (
					<>
						{row.tool.input &&
							(row.tool.category === 'think' ? (
								prompt && <pre>{prompt}</pre>
							) : (
								<pre>{row.tool.input}</pre>
							))}
						{row.tool.output && <pre>{row.tool.output}</pre>}
						{row.tool.content
							?.filter((c) => !(prompt && c.kind === 'text' && c.text === prompt))
							.map((c, i) =>
								c.kind === 'diff' && row.contentSeq ? (
									<ToolDiff
										key={`${row.contentSeq}/${i}`}
										task={task}
										seq={row.contentSeq}
										index={i}
										locale={locale}
										revision={linkRevision}
									/>
								) : (
									<pre key={i}>{c.kind === 'text' ? c.text : c.kind}</pre>
								)
							)}
					</>
				)}
			</details>
		);
	}
	// Stable across composer keystrokes and other state the rows never read, so Rows reuses mounted rows.
	/** spec/chat#context-menu: a message's whole text — an agent answer's Markdown source, however many log rows it spans. */
	const messageSource = (id: string): string | null => {
		const cached = markdownCache.current.get(id);
		if (cached) return cached.text;
		const find = (list: DisplayRow[]): string | null => {
			for (const row of list) {
				if (row.kind === 'message' && row.id === id)
					return row.role === 'user'
						? promptDisplayText(row.text, row.attachments ?? [])
						: row.text;
				if (row.kind === 'toolGroup' || row.kind === 'subagentBlock') {
					const found = find(row.items);
					if (found !== null) return found;
				}
			}
			return null;
		};
		return find(rows);
	};
	const render = useCallback(
		function render(row: DisplayRow): React.ReactNode {
			if (row.kind === 'turnStatus')
				return (
					<TurnStatusRow
						status={row.status}
						locale={locale}
						worker={crewWorkers(workspaceTasks, task, loggedWorkers)}
					/>
				);
			// spec/chat#subagents: the subagent block; its own rows and answer go through this same render.
			if (row.kind === 'subagentBlock') {
				const block = disclosure(row.id, false);
				return (
					<SubagentBlock
						row={row.row}
						view={row.view}
						locale={locale}
						open={block.open}
						onToggle={block.onToggle}
						onOpen={() =>
							setTask((state) => ({
								activityExpanded: new Map(state.activityExpanded).set(row.id, true),
							}))
						}
						items={row.items.map((item) => (
							<Fragment key={item.id}>{render(item)}</Fragment>
						))}
						answer={
							row.answer.length
								? row.answer.map((item) => <Fragment key={item.id}>{render(item)}</Fragment>)
								: null
						}
						live={row.view.live ? toolRow(row.view.live, `pin/${row.view.live.id}`, false) : null}
					/>
				);
			}
			if (row.kind === 'toolGroup')
				return (
					<ToolGroup
						row={row}
						task={task}
						locale={locale}
						{...disclosure(row.id, false)}
						items={row.items.map((item) => (
							<Fragment key={item.id}>{render(item)}</Fragment>
						))}
						pinned={(id: string) => {
							const tool = row.tools.find((item) => item.id === id);
							return tool ? (
								<Fragment key={id}>{toolRow(tool, `pin/${id}`, false)}</Fragment>
							) : null;
						}}
					/>
				);
			if (row.kind === 'markdown')
				return (
					<MarkdownBlock
						rowId={row.id}
						message={row.id.slice(0, row.id.lastIndexOf('/'))}
						html={row.html}
						tokens={row.tokens}
						locale={locale}
						task={task}
						revision={linkRevision}
						className={styles.reply}
					/>
				);
			if (row.kind === 'message')
				return row.role === 'thought' ? (
					<details
						{...disclosure(row.id, false)}
						className={styles.thought}
						data-chat-message={row.id}>
						<summary>
							<Chevron />
							{busy && rows.at(-1)?.id === row.id
								? t(locale, 'thinking')
								: row.endedAt !== undefined &&
									  row.startedAt !== undefined &&
									  row.endedAt - row.startedAt >= 1000
									? `${t(locale, 'thought')} · ${formatDuration(locale, Math.floor((row.endedAt - row.startedAt) / 1000) * 1000)}`
									: t(locale, 'thought')}
						</summary>
						<p>{row.text}</p>
					</details>
				) : row.waiting ? (
					<HeldMessage
						id={row.id}
						text={
							<PromptText
								task={task}
								locale={locale}
								text={row.text}
								rowId={row.id}
								revision={linkRevision}
								attachments={row.attachments ?? []}
								commands={slashCommands}
							/>
						}
						chips={null}
						item={queue.held?.find((item) => item.id === row.promptId)}
						afterAnswer={pending.permissions.length > 0 || pending.questions.length > 0}
						locale={locale}
						disabled={!hostConnected || sending}
						onEdit={(item) => {
							void editQueuedRef.current(item);
						}}
						onRemove={(item) => {
							void send({ kind: 'removeQueuedPrompt', id: item.id });
						}}
					/>
				) : (
					<div
						className={styles.user}
						data-chat-message={row.id}
						data-first={rows[0]?.id === row.id || undefined}>
						<PromptText
							task={task}
							locale={locale}
							text={row.text}
							rowId={row.id}
							revision={linkRevision}
							attachments={row.attachments ?? []}
							commands={slashCommands}
						/>
					</div>
				);
			if (row.kind === 'tool')
				return toolRow(row, row.id, row.tool.status === 'failed' || row.tool.category === 'edit');
			const e = row.record.event;
			if (foldedCrew.has(row.record.seq)) return null;
			if (e.kind === 'crew.plan.requested') {
				if (pending.crewPlan?.id === e.plan.id && task.crew)
					return (
						<PlanCard
							key={e.plan.id}
							plan={e.plan}
							spec={task.crew}
							task={task}
							revision={linkRevision}
							locale={locale}
							disabled={!hostConnected || sending}
							send={(c) => {
								void send(c);
							}}
						/>
					);
				// spec/chat-turns-plans-and-questions#plan-row: a decided plan folds into its summary on the card's place.
				const resolved = records.find(
					(record) =>
						record.seq > row.record.seq &&
						record.event.kind === 'crew.plan.resolved' &&
						record.event.id === e.plan.id
				);
				if (resolved?.event.kind !== 'crew.plan.resolved') return null;
				const summary = disclosure(row.id, false);
				return (
					<PlanSummary
						plan={e.plan}
						parts={resolved.event.parts}
						approved={resolved.event.approved}
						at={resolved.at}
						spec={task.crew ?? null}
						locale={locale}
						open={summary.open}
						onToggle={summary.onToggle}
					/>
				);
			}
			// spec/chat#tool-calls: the answer to a crew question folds into one plate with the question it answers.
			if (e.kind === 'crew.question.resolved') {
				const asked = records.find(
						(record) =>
							record.event.kind === 'crew.question.requested' && record.event.question.id === e.id
					)?.event,
					fold = disclosure(row.id, false);
				return (
					<CrewAnswerRow
						question={asked?.kind === 'crew.question.requested' ? asked.question : null}
						answer={e.answer}
						answeredBy={e.answeredBy}
						locale={locale}
						open={fold.open}
						onToggle={fold.onToggle}
					/>
				);
			}
			// spec/composer-steering-queue-and-ghost#quick-question: a quick question's edits leave one service row; the question and the answer stay out of the chat.
			if (e.kind === 'quick-ask.changed')
				return (
					<QuickAskLogRow
						event={e}
						locale={locale}
						onOpen={() =>
							setTask({
								changeRange: { base: e.before, current: e.after },
								panel: 'changes',
								panelShown: true,
								filter: '',
								surface: 'diff',
							})
						}
					/>
				);
			if (e.kind === 'turn.started' || e.kind.startsWith('crew.'))
				return (
					<CrewEventRow
						record={row.record}
						locale={locale}
						tasks={workspaceTasks}
						pendingQuestions={pending.crewQuestions}
						disabled={!hostConnected || sending}
						send={(c) => {
							void send(c);
						}}
					/>
				);
			if (e.kind === 'question.requested') {
				if (!pending.questions.some((q) => q.id === e.question.id))
					return (
						<div className={styles.resolved}>
							{e.question.question} · {t(locale, 'Resolved')}
						</div>
					);
				return (
					<Question
						question={e.question}
						body={
							<QuestionText
								id={e.question.id}
								text={e.question.question}
								task={task}
								locale={locale}
								revision={linkRevision}
							/>
						}
						since={Date.parse(row.record.at)}
						submitShortcut={submitShortcut}
						locale={locale}
						disabled={!hostConnected || sending}
						answer={answers[e.question.id] ?? { labels: [], text: '' }}
						onChange={(a) => setAnswers((prev) => ({ ...prev, [e.question.id]: a }))}
						send={(c) => {
							void send(c);
						}}
					/>
				);
			}
			// spec/tasks#agent-created-tasks: the proposed task waits as a card and folds into its summary row once answered.
			if (e.kind === 'task.proposal.requested') {
				if (pending.proposals.some((item) => item.id === e.proposal.id))
					return (
						<TaskProposalCard
							proposal={e.proposal}
							task={task}
							locale={locale}
							disabled={!hostConnected}
							onSheet={(proposal) => onProposal?.(proposal)}
						/>
					);
				const resolved = records.find(
					(record) =>
						record.seq > row.record.seq &&
						record.event.kind === 'task.proposal.resolved' &&
						record.event.id === e.proposal.id
				);
				if (resolved?.event.kind !== 'task.proposal.resolved') return null;
				const summary = disclosure(row.id, false);
				return (
					<TaskProposalSummary
						proposal={e.proposal}
						created={resolved.event.task}
						at={resolved.at}
						locale={locale}
						open={summary.open}
						onToggle={summary.onToggle}
					/>
				);
			}
			if (e.kind === 'task.proposal.resolved') return null;
			if (e.kind === 'question.resolved')
				return (
					<div className={styles.answer}>
						{e.answer
							? [...e.answer.labels, e.answer.text].filter(Boolean).join(' · ')
							: t(locale, 'No answer')}
					</div>
				);
			// spec/chat-turns-plans-and-questions#plan-approval: a switch_mode permission with a plan is the plan for approval; without text it stays an ordinary permission.
			if (e.kind === 'permission.requested' && isPlanApproval(e.request)) {
				const plan = planApprovalText(e.request, records, row.record.seq);
				if (plan !== null) {
					if (pending.permissions.some((p) => p.id === e.request.id))
						return (
							<PlanApproval
								request={e.request}
								choice={planApproveChoice(e.request, records, row.record.seq)}
								text={plan}
								task={task}
								locale={locale}
								revision={linkRevision}
								disabled={!hostConnected || sending}
								send={send}
							/>
						);
					const resolvedAt = records.findIndex(
							(record) =>
								record.seq > row.record.seq &&
								record.event.kind === 'permission.resolved' &&
								record.event.id === e.request.id
						),
						resolved = records[resolvedAt];
					if (resolved?.event.kind === 'permission.resolved') {
						const approved =
							e.request.options
								.find(
									(option) =>
										option.id ===
										(resolved.event.kind === 'permission.resolved' ? resolved.event.optionId : null)
								)
								?.kind.startsWith('allow') ?? false;
						// spec/chat-turns-plans-and-questions#plan-approval: the mode the session is in after the approval, by the agent's name for it.
						const later = records.slice(resolvedAt + 1),
							modeId = approved ? planApprovedMode(records, resolvedAt) : null,
							mode = modeId ? (sessionModeName(records, modeId) ?? modeId) : null;
						const prompt =
								later
									.map((record) =>
										record.event.kind === 'turn.started'
											? record.event.origin === 'agent'
												? null
												: record.event.text
											: record.event.kind === 'prompt.queued'
												? record.event.prompt.command.text
												: null
									)
									.find((text) => text !== null) ?? null,
							feedback = prompt ? planPromptFeedback(prompt) : null;
						const summary = disclosure(row.id, false);
						return (
							<PlanApprovalSummary
								request={e.request}
								text={plan}
								approved={approved}
								mode={mode}
								feedback={feedback}
								at={resolved.at}
								task={task}
								locale={locale}
								revision={linkRevision}
								open={summary.open}
								onToggle={summary.onToggle}
							/>
						);
					}
				}
			}
			// spec/chat-turns-plans-and-questions#plan-approval: the plan document shows while the agent writes it; the request that follows owns the plan.
			if (e.kind === 'plan.document')
				return records.some(
					(record) =>
						record.seq > row.record.seq &&
						((record.event.kind === 'permission.requested' &&
							isPlanApproval(record.event.request)) ||
							(record.event.kind === 'plan.removed' && record.event.planId === e.planId))
				) ? null : (
					<PlanDocument
						planId={e.planId}
						text={e.text}
						task={task}
						locale={locale}
						revision={linkRevision}
					/>
				);
			if (e.kind === 'permission.requested')
				return pending.permissions.some((p) => p.id === e.request.id) ? (
					<PermissionCard
						request={e.request}
						locale={locale}
						disabled={!hostConnected || sending}
						send={(c) => {
							void send(c);
						}}
					/>
				) : (
					<div className={styles.resolved}>
						{e.request.tool.title} · {t(locale, 'Resolved')}
					</div>
				);
			// spec/chat-turns-plans-and-questions#plan-row: the checklist opens the plan it follows, in place.
			if (e.kind === 'plan.changed') {
				const plan = checklistPlan(records, row.record.seq),
					key = `${row.id}:plan`,
					shown = plan !== null && (activityExpanded.get(key) ?? false),
					show = (value: boolean) =>
						setTask((state) => ({
							activityExpanded: new Map(state.activityExpanded).set(key, value),
						}));
				return (
					<>
						<PlanRow
							entries={e.entries}
							locale={locale}
							{...disclosure(row.id, false)}
							plan={plan}
							shown={shown}
							onPlan={() => show(!shown)}
						/>
						{shown && (
							<PlanReadOnly
								id={row.id}
								text={plan}
								task={task}
								locale={locale}
								revision={linkRevision}
								onCollapse={() => show(false)}
							/>
						)}
					</>
				);
			}
			if (e.kind === 'session.failed') {
				if (e.reason !== 'auth' || !task.provider)
					return (
						<div role="alert" className={styles.error}>
							<Glyph name="tool-error" size={12} />
							<span>{e.message}</span>
						</div>
					);
				const boundary = (kind: string) =>
						['turn.started', 'turn.completed', 'session.failed', 'host.stopped'].includes(kind),
					index = records.findIndex((record) => record.seq === row.record.seq);
				const previous = records
						.slice(0, index)
						.findLast((record) => boundary(record.event.kind))?.event,
					next = records
						.slice(index + 1)
						.find(
							(record) =>
								record.event.kind === 'turn.started' || record.event.kind === 'session.started'
						);
				if (next) {
					const retry = records
							.slice(index + 1)
							.find((record) => record.event.kind === 'turn.started'),
						after =
							retry &&
							records
								.slice(records.indexOf(retry) + 1)
								.find((record) => boundary(record.event.kind))?.event;
					return (
						<AuthRow
							provider={task.provider}
							locale={locale}
							retried={
								previous?.kind === 'turn.started' &&
								retry?.event.kind === 'turn.started' &&
								retry.event.text === previous.text &&
								!(after?.kind === 'session.failed' && after.reason === 'auth')
							}
						/>
					);
				}
				return (
					<AuthCard
						provider={task.provider}
						locale={locale}
						detail={row.detail ?? e.message}
						startup={previous?.kind !== 'turn.started'}
						failedAt={Date.parse(row.record.at)}
						retryDisabled={busy || sending}
						onRetry={() => retryAuth.current()}
					/>
				);
			}
			if (e.kind === 'turn.completed') {
				const turn = turns.findLast((turn) => turn.seq < row.record.seq);
				return turn ? (
					<TurnFooter
						response={turnResponse(records, turn.seq)}
						task={task}
						turn={turn}
						locale={locale}
						background={turnBackground(records, turn.seq)}
					/>
				) : (
					<div className={styles.resolved}>
						{t(locale, e.reason === 'cancelled' ? 'Interrupted' : 'Done')}
					</div>
				);
			}
			return null;
			// Everything render reads: disclosure/focusTool/setAnswers only add setTask and a ref.
		},
		[
			locale,
			task,
			linkRevision,
			slashCommands,
			activityExpanded,
			activityTarget,
			pending,
			hostConnected,
			sending,
			workspaceTasks,
			answers,
			turns,
			records,
			rows,
			busy,
			send,
			queue.held,
			foldedCrew,
			loggedWorkers,
			submitShortcut,
		]
	);
	// spec/composer#paste: ⌘V with an image or Finder files on the clipboard attaches them to the shelf; any text pastes as before.
	const pasteImage = (event: ClipboardEvent<HTMLFormElement>) => {
		const target = event.target as HTMLElement;
		if (!target.closest?.('[data-prompt]')) return;
		const data = event.clipboardData,
			text = data.getData('text/plain'),
			files = Array.from(data.files);
		if (pasteKind(text, clipboardHasImage(data)) !== 'image') return;
		event.preventDefault();
		void (async () => {
			// A Finder copy shows its files and no text; a picture on the clipboard is a file without a path and goes on to main.
			if (
				!text &&
				files.length &&
				(await dropTaskFiles(task, files, false).catch(() => {
					fail('The files could not be attached. Check the attachment limits.');
					return -1;
				}))
			)
				return;
			const added = await pasteTaskImage(task, 'Pasted image');
			const view = editor.handle.view;
			if (!added && text && view?.hasFocus) view.dispatch(view.state.replaceSelection(text));
		})().catch(() => fail('The image could not be attached. Check the attachment limits.'));
	};
	const dropFiles = (files: File[]) => {
		void dropTaskFiles(task, files, true).catch(() =>
			fail('The files could not be attached. Check the attachment limits.')
		);
	};
	return (
		<div
			ref={root}
			tabIndex={-1}
			data-activity
			// spec/appearance#chat-text-size: the transcript, the composer and the rows over it take the chat's own text size.
			data-chat-text
			data-turn-rail-shown={railTurns.length > 1 || undefined}
			className={styles.conversation}
			onMouseDown={chatMenuMouseDown}
			onContextMenu={(event) => {
				void openChatMenu(event, task, messageSource, () => fail('Could not run the menu action.'));
			}}
			onPointerDown={(event) => {
				const target = event.target as HTMLElement;
				if (
					target.closest('[role="log"]') &&
					!target.closest('button,input,textarea,a,summary,[role="button"],[role="listbox"],.xterm')
				)
					event.currentTarget.focus({ preventScroll: true });
			}}
			onKeyDown={(event) => {
				// spec/search-menus-and-commands#menu-structure: the Navigate menu's keys as the keymap gives them, never fixed ones.
				const action = chatNavigation.find((id) =>
					matchesAccelerator(event, navigationShortcut(id))
				);
				const turn = action === 'turn-next' || action === 'turn-previous';
				if (
					action &&
					(turn || !(event.target as HTMLElement).closest('input,textarea,[data-prompt]'))
				) {
					event.preventDefault();
					navigate(action);
				}
			}}>
			{snapshot?.issue && (
				<div role="alert" className={styles.error}>
					{t(locale, 'The conversation cannot be continued.')}{' '}
					{t(
						locale,
						snapshot.issue === 'unsupported_schema'
							? 'The file uses a newer schema.'
							: 'The file is invalid.'
					)}
				</div>
			)}
			{returnToDiff && (
				<div className={styles.returnLink}>
					<Button
						onClick={() => setTask({ surface: 'diff', focusTurn: null, returnToDiff: false })}>
						{t(locale, 'Back to diff')}
					</Button>
				</div>
			)}
			{logRows.length ? (
				<Rows
					alignBottom
					bottomInset={dockHeight}
					locale={locale}
					searchText={conversationSearchText}
					targetId={
						focusTurn
							? `user-${focusTurn}`
							: (focusedTool?.owner ??
								(activityTarget?.startsWith('subagent/') ? activityTarget : undefined))
					}
					onInteract={() => {
						if (focusTurn || activityTarget) setTask({ focusTurn: null, activityTarget: null });
					}}
					position={rowPosition(positions, 'conversation', true)}
					rows={logRows}
					render={render}
					label={t(locale, 'Conversation')}
					scrollbar="hidden"
					aside={
						railTurns.length > 1
							? (nav) => (
									<TurnRail
										turns={railTurns}
										nav={nav}
										task={task}
										locale={locale}
										control={railControl}
									/>
								)
							: (nav) => <ScrollThumb nav={nav} />
					}
				/>
			) : (
				<div className={styles.empty}>
					{snapshot ? t(locale, 'No messages') : <SkeletonText lines={9} />}
				</div>
			)}
			<div ref={dock} className={styles.dock} data-toast-avoid>
				<div className={styles.notices}>
					{task.archived ? (
						<ArchivedStrip task={task} locale={locale} onRelay={onRelay} />
					) : (
						!connected &&
						task.provider &&
						!snapshot?.issue &&
						(snapshot?.queued ? (
							<StateStrip
								icon={
									<Glyph name={task.blockedBy?.length ? 'scope-lock' : 'agent-queued'} size={14} />
								}
								text={t(
									locale,
									task.blockedBy?.length ? 'Waiting for the lock' : 'Waiting for a free agent slot.'
								)}
							/>
						) : idle ? (
							resuming && (
								<StateStrip
									icon={<Glyph name="agent-spinner" size={14} />}
									text={t(locale, 'Starting…')}
								/>
							)
						) : (
							<StateStrip
								live={false}
								data-agent-strip
								icon={
									<Glyph
										name={starting ? 'agent-spinner' : hostConnected ? 'agent-stopped' : 'plug'}
										size={14}
									/>
								}
								text={t(
									locale,
									starting
										? 'Starting…'
										: hostConnected
											? 'Agent is not running.'
											: 'The host is disconnected.'
								)}>
								<Button
									appearance="primary"
									onClick={() => {
										void start();
									}}
									disabled={starting}>
									<Glyph name="resume" size={12} />
									{t(locale, records.length ? 'Resume' : 'Start')}
								</Button>
								{onRelay && records.length > 0 && (
									<Button variant="ghost" onClick={onRelay}>
										<Glyph name="relay" size={12} />
										{t(locale, 'Continue in a new task')}
									</Button>
								)}
							</StateStrip>
						))
					)}
				</div>
				{/* spec/composer#queue-deck: one row per message — «Queued · N» stands in the first row's own column, no header and no rules between rows.
        spec/chat-turns-plans-and-questions#background-commands: the background commands stand in the same deck, over the queue (ui/Deck, rule 17). */}
				<BackgroundDeck
					task={task}
					records={records}
					locale={locale}
					send={send}
					onOpenSubagent={(id) =>
						// spec/chat-turns-plans-and-questions#background-subagents: «Open» brings the subagent's block into view, open.
						setTask((state) => ({
							activityTarget: `subagent/${id}`,
							focusTurn: null,
							activityExpanded: new Map(state.activityExpanded).set(`subagent/${id}`, true),
						}))
					}
					queue={
						ownQueue.length || (queue.paused && queue.prompts.length) ? (
							<DeckList
								label={t(locale, 'Queued messages')}
								header={
									queue.paused && (
										<header>
											<span role="status">{t(locale, 'The queue is paused.')}</span>
											<Button
												size="s"
												disabled={!connected || sending}
												onClick={() => {
													void send({ kind: 'resumePromptQueue' });
												}}>
												{t(locale, 'Resume queue')}
											</Button>
										</header>
									)
								}>
								{ownQueue.map((item, index) => (
									<DeckRow
										key={item.id}
										label={
											index === 0 &&
											`${t(locale, 'Queued')} · ${new Intl.NumberFormat(locale).format(ownQueue.length)}`
										}
										actions={
											<>
												{steering && item.command.kind === 'prompt' && (
													<Button
														size="s"
														appearance="primary"
														variant="ghost"
														title={t(locale, 'Send now')}
														disabled={!connected || sending}
														onClick={() => {
															void send({ kind: 'steerQueuedPrompt', id: item.id });
														}}>
														<Glyph name="send-now" size={14} />
														{t(locale, 'Send now')}
													</Button>
												)}
												<IconButton
													size="s"
													label={t(
														locale,
														item.command.kind === 'submitReview'
															? 'Edit queued review'
															: 'Edit queued message'
													)}
													disabled={!connected || sending}
													onClick={() => {
														void editQueued(item);
													}}>
													<Glyph name="edit" size={14} />
												</IconButton>
												<IconButton
													size="s"
													label={t(locale, 'Remove queued message')}
													disabled={!connected || sending}
													onClick={() => {
														void send({ kind: 'removeQueuedPrompt', id: item.id });
													}}>
													<Glyph name="close" size={14} />
												</IconButton>
											</>
										}>
										<p
											title={
												item.command.kind === 'submitReview'
													? undefined
													: promptDisplayText(item.command.text, item.attachments)
											}>
											{item.command.kind === 'submitReview'
												? t(locale, 'Review')
												: promptDisplayText(item.command.text, item.attachments)}
										</p>
										<AttachmentChips task={task} locale={locale} attachments={item.attachments} />
									</DeckRow>
								))}
							</DeckList>
						) : null
					}
				/>
				<ComposerIsland
					ref={composerForm}
					inert={!!task.archived}
					data-archived={task.archived ? true : undefined}
					data-menu-cycle-mode={canCycleMode}
					data-menu-queue={
						steers &&
						connected &&
						!sending &&
						composerLoaded &&
						Boolean(text.trim() || attachments.length)
					}
					{...fileDropHandlers(task, () => fail('Could not attach the file.'), {
						files: dropFiles,
						over: setDropOver,
					})}
					data-drop-over={dropOver || undefined}
					className={styles.composer}
					onPaste={pasteImage}
					onSubmit={(e) => {
						void submit(e);
					}}>
					{/* spec/composer#paste: the drop overlay lies over the island (absolute, z-index 3); first, so the environment footer stays the last row. */}
					<ComposerDropZone
						title={t(locale, 'Release to attach')}
						note={t(locale, 'Up to 10 files, 8 MB together; images up to 4 MB')}
					/>
					{/* spec/composer#mentions: no shelf — attachments stand in the text as pills and thumbnails. Mode and queue keys come before the editor's. */}
					<ComposerText
						ref={editor.host}
						onClick={editor.onClick}
						onKeyDownCapture={(event) => {
							if (event.nativeEvent.isComposing) return;
							if (
								matchesAccelerator(event, modeShortcut) &&
								canCycleMode &&
								!(event.key === 'Tab' && onListItem())
							) {
								event.preventDefault();
								event.stopPropagation();
								cycleMode();
								return;
							}
							if (busy && matchesAccelerator(event, queueShortcut)) {
								event.preventDefault();
								event.stopPropagation();
								queuePrompt();
							}
						}}
					/>
					{editor.menu}
					{editor.dialogs}
					<ComposerBar
						attach={
							<IconButton
								label={t(locale, 'Attach files')}
								title={t(locale, 'Up to 10 files, 8 MB total; images up to 4 MB.')}
								disabled={pickingFiles}
								onClick={attachFiles}>
								<Glyph name="plus" size={15} />
							</IconButton>
						}>
						{usage?.kind === 'usage.changed' && (
							<ContextMeter
								{...(onRelay ? { onRelay } : {})}
								onCompact={
									canCompact
										? () => {
												void send({ kind: 'prompt', text: '/compact' });
											}
										: undefined
								}
								used={usage.used}
								capacity={usage.capacity}
								locale={locale}
							/>
						)}
						<ComposerOptions
							options={options}
							modes={session?.kind === 'session.started' ? session.modes : []}
							modeId={modeEvent && 'modeId' in modeEvent ? modeEvent.modeId : null}
							provider={task.provider}
							locale={locale}
							modeShortcut={modeShortcut}
							disabled={!connected || busy || sending}
							locked={!connected || busy}
							onCommand={(command) => {
								void send(command);
							}}
						/>
						<ComposerSend
							locale={locale}
							busy={busy}
							steers={steers}
							filled={Boolean(text.trim() || attachments.length)}
							stopDisabled={!connected || sending}
							sendDisabled={
								!!rateLimit ||
								!composerLoaded ||
								!(connected || idle) ||
								(!text.trim() && !attachments.length) ||
								sending ||
								resuming
							}
							stopShortcut={stopShortcut}
							queueShortcut={queueShortcut}
							onStop={() => {
								void send({ kind: 'cancel' });
							}}
							onSendNow={() => {
								void submitPrompt(true);
							}}
							onQueue={queuePrompt}
						/>
					</ComposerBar>
					<ComposerEnvironment
						task={task}
						locale={locale}
						contended={contended}
						notices={
							<>
								{authFailure && task.provider && (
									<AuthChip
										provider={task.provider}
										locale={locale}
										card={{
											...authFailure,
											retryDisabled: busy || sending,
											onRetry: () => retryAuth.current(),
										}}
									/>
								)}
								{rateLimit && (
									<RateLimitChip
										task={task}
										locale={locale}
										limit={rateLimit}
										queued={queue.prompts.length > 0 && !queue.paused}
									/>
								)}
								{notices}
							</>
						}
					/>
				</ComposerIsland>
			</div>
		</div>
	);
}

export function conversationSearchText(row: DisplayRow): string {
	if (row.kind === 'message')
		return row.role === 'user' ? promptDisplayText(row.text, row.attachments ?? []) : row.text;
	if (row.kind === 'markdown') return markdown.utils.unescapeAll(row.html.replace(/<[^>]*>/g, ''));
	if (row.kind === 'tool') return [row.tool.title, row.tool.input, row.tool.output].join(' ');
	if (row.kind === 'toolGroup')
		return row.items.map((item) => conversationSearchText(item)).join(' ');
	if (row.kind === 'subagentBlock')
		return [
			row.row.name,
			row.row.type,
			row.row.prompt,
			...row.items.map((item) => conversationSearchText(item)),
			row.view.answer,
		]
			.filter(Boolean)
			.join(' ');
	if (row.kind === 'turnStatus') return '';
	return JSON.stringify(row.record.event);
}
/** spec/chat-turns-plans-and-questions#turn-status-row: state word · turn time · latest running tool +N. Only the icon moves; seconds stay out of the live region. */
function TurnStatusRow({
	status,
	locale,
	worker,
}: {
	status: TurnStatus;
	locale: Locale;
	worker: (taskId: string) => McpWorker | null;
}) {
	// spec/chat#mcp-calls: a running MCP call reads as in its own row, `Reading the changes · Developer 2`.
	const mcp = status.tool ? mcpRow(locale, status.tool, 'running', worker) : null,
		target = mcp ? [mcp.title, mcp.who].filter(Boolean).join(' · ') : status.target;
	const now = useSecondTick(true),
		elapsed = Math.floor((now - status.startedAt) / 1000) * 1000,
		label = t(
			locale,
			status.state === 'working' ? 'Working' : status.state === 'writing' ? 'Writing' : 'Thinking'
		);
	return (
		<div role="status" className={styles.turnStatus} data-turn-status={status.state}>
			<span aria-hidden="true">
				<StatusIcon status="working" label={label} />
			</span>
			<span className={styles.turnStatusWord}>{label}</span>
			{elapsed >= 1000 && (
				<span aria-hidden="true" className={styles.turnStatusTime}>
					{formatDuration(locale, elapsed)}
				</span>
			)}
			{target && <span className={styles.turnStatusTarget}>{target}</span>}
			{status.subagent && (
				<>
					<span className={styles.turnStatusWord}>{t(locale, 'Subagent')}</span>
					<span className={styles.turnStatusTarget}>{status.subagent}</span>
				</>
			)}
			{status.more > 0 && (
				<span className={styles.turnStatusMore}>
					+{new Intl.NumberFormat(locale).format(status.more)}
				</span>
			)}
		</div>
	);
}
/** spec/chat-turns-plans-and-questions#plan-row: the agent plan as one row, like a tool call; the chevron unfolds the steps. */
function PlanRow({
	entries,
	locale,
	open,
	onToggle,
	plan,
	shown,
	onPlan,
}: {
	entries: readonly PlanEntry[];
	locale: Locale;
	open: boolean;
	onToggle(event: React.SyntheticEvent<HTMLDetailsElement>): void;
	plan: string | null;
	shown: boolean;
	onPlan(): void;
}) {
	const { done, total, current, next, segments } = planSummary(entries),
		number = new Intl.NumberFormat(locale);
	const state = (status: string) =>
		status === 'completed' ? 'done' : status === 'in_progress' ? 'working' : 'queued';
	return (
		<details className={styles.planRow} data-plan-row open={open} onToggle={onToggle}>
			<summary>
				<Chevron />
				<Glyph name="plan" size={13} />
				<strong>{t(locale, 'Plan')}</strong>
				<small>
					{number.format(done)}/{number.format(total)}
				</small>
				{segments ? (
					<span className={styles.planSegments} aria-hidden="true">
						{entries.map((entry, i) => (
							<i key={i} data-state={state(entry.status)} />
						))}
					</span>
				) : (
					<span className={styles.planBar} aria-hidden="true">
						<i style={{ width: `${(done / total) * 100}%` }} />
						<i
							data-state="working"
							style={{ left: `${(done / total) * 100}%`, width: current ? `${100 / total}%` : '0' }}
						/>
					</span>
				)}
				{current ? (
					<span className={styles.planCurrent}>{current}</span>
				) : next ? (
					<span className={styles.planCurrent} data-next>
						{next}
					</span>
				) : done === total && total > 0 ? (
					<span className={styles.planDone}>{t(locale, 'done')}</span>
				) : null}
				{plan !== null && (
					<Button
						size="s"
						appearance="primary"
						variant="ghost"
						className={styles.planWhole}
						aria-expanded={shown}
						onClick={(event) => {
							event.preventDefault();
							onPlan();
						}}>
						{shown
							? t(locale, 'Collapse plan')
							: t(locale, 'Whole plan · {n}').replace(
									'{n}',
									planLinesLabel(locale, planLineCount(plan))
								)}
					</Button>
				)}
			</summary>
			<ol>
				{entries.map((entry, i) => (
					<li key={i} data-state={state(entry.status)}>
						<PlanStep status={entry.status} locale={locale} />
						<span>{entry.text}</span>
					</li>
				))}
			</ol>
		</details>
	);
}
function PlanStep({ status, locale }: { status: string; locale: Locale }) {
	const label = t(
		locale,
		status === 'completed' ? 'Done' : status === 'in_progress' ? 'Working' : 'Queued'
	);
	if (status === 'completed')
		return (
			<span role="img" aria-label={label}>
				<Glyph name="agent-idle" size={13} />
			</span>
		);
	if (status === 'in_progress')
		return (
			<span role="img" aria-label={label}>
				<Glyph name="agent-run" size={13} />
			</span>
		);
	return (
		<span role="img" aria-label={label}>
			<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
				<circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.3" />
			</svg>
		</span>
	);
}
/** spec/composer-steering-queue-and-ghost#steering-hold: the person's message the host still holds, where it was sent: «Waiting for the agent» with Edit and Remove until the agent takes it. */
function HeldMessage({
	id,
	text,
	chips,
	item,
	afterAnswer,
	locale,
	disabled,
	onEdit,
	onRemove,
}: {
	id: string;
	text: React.ReactNode;
	chips: React.ReactNode;
	item: QueuedPrompt | undefined;
	afterAnswer: boolean;
	locale: Locale;
	disabled: boolean;
	onEdit(item: QueuedPrompt): void;
	onRemove(item: QueuedPrompt): void;
}) {
	return (
		<div className={styles.user} data-held data-chat-message={id}>
			<div className={styles.userText}>
				{text}
				{chips}
			</div>
			<span
				className={styles.heldStatus}
				role="status"
				data-after-answer={afterAnswer || undefined}>
				<Glyph name="clock" size={12} />
				{t(locale, afterAnswer ? 'Arrives after you answer the request' : 'Waiting for the agent')}
			</span>
			{item && (
				<span className={styles.heldActions}>
					<IconButton
						size="s"
						label={t(locale, 'Edit message')}
						disabled={disabled}
						onClick={() => onEdit(item)}>
						<Glyph name="edit" size={14} />
					</IconButton>
					<IconButton
						size="s"
						label={t(locale, 'Remove message')}
						disabled={disabled}
						onClick={() => onRemove(item)}>
						<Glyph name="close" size={14} />
					</IconButton>
				</span>
			)}
		</div>
	);
}
/**
 * spec/chat#tool-groups: calls in a row under one header — count · tools · changed files · errors · time.
 * Collapsed, only the failed calls and the one still running stay visible under it; open, every call in order.
 */
function ToolGroup({
	row,
	task,
	locale,
	open,
	onToggle,
	items,
	pinned,
}: {
	row: ToolGroupRow;
	task: AgentTask;
	locale: Locale;
	open: boolean;
	onToggle(event: React.SyntheticEvent<HTMLDetailsElement>): void;
	items: React.ReactNode[];
	pinned(id: string): React.ReactNode;
}) {
	const calls = useMemo(
		() =>
			row.tools.map((tool) => ({
				id: tool.id,
				tool: tool.tool,
				startedAt: tool.startedAt,
				finishedAt: tool.finishedAt,
			})),
		[row.tools]
	);
	const summary = useMemo(
			() => toolGroupSummary(calls, (tool) => toolGroupName(locale, tool)),
			[calls, locale]
		),
		now = useSecondTick(summary.running),
		[, setTask] = useTaskState(task);
	const label = toolCallCount(locale, summary.calls),
		mix = toolMixText(summary.mix);
	async function openFile(file: ToolGroupFile) {
		const owner = row.tools.find((tool) => tool.id === file.callId);
		if (!owner?.contentSeq) return;
		const changed = await window.brigadir
			.readToolChange(task, owner.contentSeq, file.index)
			.catch(() => null);
		setTask({
			changeRange: null,
			panel: 'changes',
			panelShown: true,
			filter: '',
			...(changed
				? { selected: `${changed.scopeId}/${changed.path}`, surface: 'diff' as const }
				: { selected: null }),
		});
	}
	return (
		<div className={styles.toolGroup} data-tool-group>
			<details open={open} onToggle={onToggle}>
				<summary data-tool-group-head title={mix ? `${label} · ${mix}` : label}>
					<Chevron />
					{summary.running ? (
						<StatusIcon status="working" label={t(locale, 'Working')} />
					) : (
						<Glyph name="tool-group" size={13} />
					)}
					<strong>{label}</strong>
					{mix && (
						<>
							<span className={styles.groupDot} aria-hidden="true">
								·
							</span>
							<span className={styles.groupMix}>{mix}</span>
						</>
					)}
					{summary.files.slice(0, 2).map((file) => (
						<button
							type="button"
							key={file.path}
							className={styles.groupFile}
							data-size="s"
							data-appearance="neutral"
							data-variant="soft"
							title={`${t(locale, 'Open current diff')} · ${file.path}`}
							aria-label={`${t(locale, 'Open current diff')} · ${file.path} ${changeCountsLabel(locale, file.additions, file.deletions)}`}
							onClick={(event) => {
								event.preventDefault();
								event.stopPropagation();
								void openFile(file);
							}}>
							{chipDirectory(file.path) && (
								<span className={styles.groupFileDir}>{chipDirectory(file.path)}</span>
							)}
							<strong>{file.path.slice(file.path.lastIndexOf('/') + 1)}</strong>
							<ChangeCounts
								additions={file.additions}
								deletions={file.deletions}
								locale={locale}
								tone="diff"
								split
							/>
						</button>
					))}
					{summary.files.length > 2 && (
						<small className={styles.groupMore}>
							{moreFileCount(locale, summary.files.length - 2)}
						</small>
					)}
					{summary.errors > 0 && (
						<span className={styles.groupErrors}>
							<Glyph name="tool-error" size={10} />
							{toolErrorCount(locale, summary.errors)}
						</span>
					)}
					<span className={styles.spacer} />
					<small className={styles.groupTime}>
						{formatDuration(locale, toolGroupDuration(calls, now))}
					</small>
				</summary>
				<div className={styles.groupBody}>{items}</div>
			</details>
			{!open && summary.pinned.length > 0 && (
				<div className={styles.groupPins}>{summary.pinned.map((id) => pinned(id))}</div>
			)}
		</div>
	);
}
