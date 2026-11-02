import { create } from 'zustand';
import { commandAccelerator, defaultKeymap, formatAccelerator, menuCommands } from '@brigadir/core';
import { useWorkspace } from './store';
import type {
	AgentProvider,
	QuickAskChoice,
	ChangeRange,
	PermissionRequest,
	QuickAskEvent,
	QuickAskFile,
	QuickAskSelection,
	TaskKey,
} from '@brigadir/core';
/**
 * spec/composer-steering-queue-and-ghost#quick-question: quick questions live in the window's memory, keyed by task, surface, file, side and lines; nothing is
 * written to disk. A thread is the popover's history on those lines; `live` while its session in main is open.
 */
export type QuickTurn = {
	question: string;
	answer: string;
	status: 'starting' | 'writing' | 'done' | 'failed';
	stopped: boolean;
	startedAt: number;
	milliseconds: number | null;
	tool: string | null;
	changes: { files: QuickAskFile[]; range: ChangeRange } | null;
	reverted: Record<string, 'done' | 'failed'>;
	error: { message: string; quota: boolean; resetsAt: number | null } | null;
	applied: Record<number, boolean>;
	/** Who answered this turn; a thread may hold turns of an earlier session (spec/composer-steering-queue-and-ghost#quick-question). */
	provider: AgentProvider | null;
	/** The turn began another session on these lines: the divider «New session · Codex · model» above it. */
	session: QuickAskChoice | null;
};
export type QuickThread = {
	choice: QuickAskChoice;
	id: string;
	anchor: string;
	key: TaskKey;
	selection: QuickAskSelection;
	provider: AgentProvider | null;
	forked: boolean;
	readOnly: boolean;
	lockedBy: string | null;
	turns: QuickTurn[];
	permission: PermissionRequest | null;
	live: boolean;
};
export type QuickAnchor = {
	surface: 'editor' | 'diff';
	path: string;
	side: 'old' | 'new';
	start: number;
	end: number;
};
export const anchorKey = (key: TaskKey, anchor: QuickAnchor) =>
	`${key.projectId}/${key.id}/${anchor.surface}/${anchor.side}/${anchor.start}-${anchor.end}/${anchor.path}`;
type State = { threads: Record<string, QuickThread>; ids: Record<string, string> };
export const useQuickAsk = create<State>(() => ({ threads: {}, ids: {} }));
const change = (id: string, update: (thread: QuickThread) => QuickThread) =>
	useQuickAsk.setState((state) => {
		const anchor = state.ids[id];
		const thread = anchor ? state.threads[anchor] : undefined;
		return thread ? { threads: { ...state.threads, [anchor!]: update(thread) } } : state;
	});
const last = (thread: QuickThread, update: (turn: QuickTurn) => QuickTurn) => ({
	...thread,
	turns: thread.turns.map((turn, index) =>
		index === thread.turns.length - 1 ? update(turn) : turn
	),
});
let subscribed = false;
function listen() {
	if (subscribed) return;
	subscribed = true;
	window.brigadir.onQuickAskEvent((event: QuickAskEvent) => {
		switch (event.kind) {
			case 'started':
				change(event.id, (thread) =>
					last(
						{
							...thread,
							provider: event.provider,
							forked: event.forked,
							readOnly: event.readOnly,
							lockedBy: event.lockedBy,
						},
						(turn) => ({ ...turn, status: 'writing', provider: event.provider })
					)
				);
				break;
			case 'text':
				change(event.id, (thread) =>
					last(thread, (turn) => ({ ...turn, status: 'writing', answer: turn.answer + event.text }))
				);
				break;
			case 'tool':
				change(event.id, (thread) =>
					last(thread, (turn) => ({
						...turn,
						tool:
							event.status === 'completed' || event.status === 'failed'
								? null
								: event.title || turn.tool,
					}))
				);
				break;
			case 'permission':
				change(event.id, (thread) => ({ ...thread, permission: event.request }));
				break;
			case 'changes':
				change(event.id, (thread) =>
					last(thread, (turn) => ({ ...turn, changes: { files: event.files, range: event.range } }))
				);
				break;
			case 'done':
				change(event.id, (thread) =>
					last({ ...thread, permission: null }, (turn) => ({
						...turn,
						status: 'done',
						stopped: event.stopped,
						tool: null,
						milliseconds: event.milliseconds,
					}))
				);
				break;
			case 'failed':
				void window.brigadir.closeQuickQuestion(event.id).catch(() => {});
				change(event.id, (thread) =>
					last({ ...thread, permission: null, live: false }, (turn) => ({
						...turn,
						status: 'failed',
						tool: null,
						error: { message: event.message, quota: event.quota, resetsAt: event.resetsAt ?? null },
					}))
				);
				break;
		}
	});
}
const turn = (question: string, session: QuickAskChoice | null = null): QuickTurn => ({
	question,
	answer: '',
	status: 'starting',
	stopped: false,
	startedAt: Date.now(),
	milliseconds: null,
	tool: null,
	changes: null,
	reverted: {},
	error: null,
	applied: {},
	provider: null,
	session,
});
/** Choices are sent normalized: `{}` is the task's own provider and model. */
export const sameQuickChoice = (a: QuickAskChoice, b: QuickAskChoice) =>
	a.provider === b.provider && a.model === b.model;
/** Starts a new session on these lines and closes the older one there. Its turns are replaced, unless the person picked
 *  another model: then they stay above a divider, and the new session gets the selection, not them (spec/composer-steering-queue-and-ghost#quick-question). */
export async function askQuick(
	key: TaskKey,
	anchor: QuickAnchor,
	selection: QuickAskSelection,
	question: string,
	language: 'uk' | 'en',
	choice: QuickAskChoice = {}
) {
	listen();
	const id = crypto.randomUUID(),
		at = anchorKey(key, anchor),
		previous = useQuickAsk.getState().threads[at];
	if (previous?.live) void window.brigadir.closeQuickQuestion(previous.id).catch(() => {});
	const kept =
		previous?.turns.length && !sameQuickChoice(previous.choice, choice) ? previous.turns : [];
	useQuickAsk.setState((state) => ({
		threads: {
			...state.threads,
			[at]: {
				id,
				anchor: at,
				choice,
				key,
				selection,
				provider: null,
				forked: false,
				readOnly: false,
				lockedBy: null,
				turns: [...kept, turn(question, kept.length ? choice : null)],
				permission: null,
				live: true,
			},
		},
		ids: { ...state.ids, [id]: at },
	}));
	try {
		await window.brigadir.askQuickQuestion(key, { id, selection, question, language, ...choice });
	} catch (error) {
		change(id, (thread) =>
			last({ ...thread, live: false }, (value) => ({
				...value,
				status: 'failed',
				error: {
					message: error instanceof Error ? error.message : String(error),
					quota: false,
					resetsAt: null,
				},
			}))
		);
	}
}
export async function followQuick(thread: QuickThread, question: string) {
	change(thread.id, (value) => ({ ...value, turns: [...value.turns, turn(question)] }));
	try {
		await window.brigadir.askQuickFollowUp(thread.key, thread.id, question);
	} catch (error) {
		change(thread.id, (value) =>
			last(value, (item) => ({
				...item,
				status: 'failed',
				error: {
					message: error instanceof Error ? error.message : String(error),
					quota: false,
					resetsAt: null,
				},
			}))
		);
	}
}
/** Esc: the session closes, the answer stays (spec/composer-steering-queue-and-ghost#quick-question). */
export function closeQuick(thread: QuickThread) {
	if (thread.live) void window.brigadir.closeQuickQuestion(thread.id).catch(() => {});
	change(thread.id, (value) => ({ ...value, live: false, permission: null }));
}
export function forgetQuick(thread: QuickThread) {
	closeQuick(thread);
	useQuickAsk.setState((state) => {
		const threads = { ...state.threads };
		delete threads[thread.anchor];
		return { threads };
	});
}
export function markApplied(thread: QuickThread, turnIndex: number, block: number, value: boolean) {
	change(thread.id, (item) => ({
		...item,
		turns: item.turns.map((turn, index) =>
			index === turnIndex ? { ...turn, applied: { ...turn.applied, [block]: value } } : turn
		),
	}));
}
export function markReverted(
	thread: QuickThread,
	turnIndex: number,
	fileId: string,
	value: 'done' | 'failed'
) {
	change(thread.id, (item) => ({
		...item,
		turns: item.turns.map((turn, index) =>
			index === turnIndex ? { ...turn, reverted: { ...turn.reverted, [fileId]: value } } : turn
		),
	}));
}
/** The current shortcut of «Ask the agent» for its tooltip (the keymap may move it from ⌘I). */
export function useAskShortcut(): string | undefined {
	const keymap = useWorkspace((state) => state.appearance.keymap) ?? defaultKeymap,
		command = menuCommands.find((item) => item.id === 'ask-agent'),
		key = command && commandAccelerator(command, keymap);
	return key ? formatAccelerator(key) : undefined;
}
