import { reduceRateLimits, type RateLimitWindow } from './rate-limit';
import type { EventRecord, SessionCommand, SessionEvent } from './session';
import { isSessionCommand } from './session';
import { isAttachmentId, isPromptAttachment, type PromptAttachment } from './attachments';
import { isRecord } from './workspace';
export type PromptCommand = Extract<SessionCommand, { kind: 'prompt' | 'submitReview' }>;
export type QueuedPrompt = { id: string; command: PromptCommand; attachments: PromptAttachment[] };
/** `held`: the person's mid-turn messages the host keeps until the step boundary (spec/composer-steering-queue-and-ghost#steering-hold), outside the FIFO. */
export type PromptQueueState = {
	prompts: QueuedPrompt[];
	paused: boolean;
	rateLimits?: RateLimitWindow[];
	held?: QueuedPrompt[];
};
export function isQueuedPrompt(value: unknown): value is QueuedPrompt {
	if (
		!isRecord(value) ||
		!isAttachmentId(value.id) ||
		!isSessionCommand(value.command) ||
		!['prompt', 'submitReview'].includes(value.command.kind) ||
		!Array.isArray(value.attachments) ||
		value.attachments.length > 10 ||
		!value.attachments.every(isPromptAttachment)
	)
		return false;
	const ids = value.command.kind === 'prompt' ? (value.command.attachmentIds ?? []) : [];
	return (
		ids.length === value.attachments.length &&
		value.attachments.every((item, index) => item.id === ids[index])
	);
}
export function reducePromptQueue(state: PromptQueueState, event: SessionEvent): PromptQueueState {
	if (event.kind === 'rate-limit.changed' || event.kind === 'rate-limit.expired')
		return { ...state, rateLimits: reduceRateLimits(state.rateLimits ?? [], event) };
	// A queued message sent now (spec/composer-steering-queue-and-ghost#steering-hold) leaves the FIFO for the hold.
	if (event.kind === 'prompt.held')
		return state.held?.some((item) => item.id === event.prompt.id)
			? state
			: {
					...state,
					prompts: state.prompts.filter((item) => item.id !== event.prompt.id),
					held: [...(state.held ?? []), event.prompt],
				};
	if (
		state.held?.length &&
		(event.kind === 'prompt.steered' ||
			event.kind === 'prompt.queued' ||
			event.kind === 'prompt.removed')
	) {
		const id = event.kind === 'prompt.removed' ? event.id : event.prompt.id;
		state = { ...state, held: state.held.filter((item) => item.id !== id) };
	}
	if (event.kind === 'prompt.queued') {
		if (state.prompts.some((item) => item.id === event.prompt.id)) return state;
		const at =
			event.before === undefined ? -1 : state.prompts.findIndex((item) => item.id === event.before);
		return {
			...state,
			prompts:
				at < 0
					? [...state.prompts, event.prompt]
					: [...state.prompts.slice(0, at), event.prompt, ...state.prompts.slice(at)],
		};
	}
	if (event.kind === 'prompt.removed' || (event.kind === 'turn.started' && event.queuedPromptId)) {
		const id = event.kind === 'prompt.removed' ? event.id : event.queuedPromptId;
		return { ...state, prompts: state.prompts.filter((item) => item.id !== id) };
	}
	if (
		(event.kind === 'session.failed' && !state.rateLimits?.length && state.prompts.length) ||
		event.kind === 'queue.paused'
	)
		return { ...state, paused: true };
	if (event.kind === 'queue.resumed') return { ...state, paused: false };
	return state;
}
/** spec/composer-steering-queue-and-ghost#queue-deck: a crew service prompt (a worker's report or question, a plan decision) waits in the same FIFO, but it is the
 *  host's message to the foreman's own agent, not the person's: the queue deck lists only the person's messages. The
 *  question and the report already stand in the activity as their own rows (spec/crew-templates-and-editor#after-launch, spec/crew#ask-foreman). */
export function isOwnQueuedPrompt(item: QueuedPrompt): boolean {
	return !(item.command.kind === 'prompt' && item.command.crew);
}
export function promptQueue(records: readonly EventRecord[]): PromptQueueState {
	return records.reduce((state, record) => reducePromptQueue(state, record.event), {
		prompts: [],
		paused: false,
	} as PromptQueueState);
}
