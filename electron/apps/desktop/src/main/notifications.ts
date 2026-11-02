import {
	rateLimits,
	reduceRateLimits,
	blockedRateLimit,
	type RateLimitWindow,
} from '@brigadir/core';
import {
	noticeKind,
	notificationDecision,
	notificationPermissionChoices,
	pendingInputs,
	t,
	type EventRecord,
	type Locale,
	type NoticeKind,
	type NoticeEntryKind,
	type NotificationPreferences,
	type PendingNotice,
	type PendingNoticeKind,
	type PermissionRequest,
	type SessionSnapshot,
	type TaskKey,
} from '@brigadir/core';

/** One delivered notice; `id` is stable per task/kind/request so repeats coalesce (spec/sidebar#layout). */
export type Notice = {
	id: string;
	groupId: string;
	kind: NoticeKind;
	key: TaskKey;
	title: string;
	body: string;
	actions: { allow: string | null; deny: string | null };
};
export type NoticeHandlers = { open(): void; allow(): void; deny(): void };
export type NoticeHandle = { close(): void };
export interface NoticeGateway {
	supported(): boolean;
	show(notice: Notice, handlers: NoticeHandlers): NoticeHandle | null;
	removeGroup(groupId: string): void;
}
export interface SoundPlayer {
	play(name: string): void;
}
export type Visibility = { active: boolean; task: TaskKey | null };
type Deps = {
	gateway: NoticeGateway;
	sounds: SoundPlayer;
	preferences(): NotificationPreferences;
	visibility(): Visibility;
	locale(): Locale;
	/** spec/notifications-slack-notes-and-schedules#macos-permission: resolves whether macOS lets the notice show, asking on the first need. */
	allowed(): Promise<boolean>;
	taskTitle(key: TaskKey): Promise<string | null>;
	answerPermission(key: TaskKey, id: string, optionId: string): Promise<unknown>;
	openTask(key: TaskKey): void;
	badge(count: number): void;
	/** spec/notifications-slack-notes-and-schedules#notification-center: the notification center's history — what a notice says, whatever «When» and the OS permission are. */
	log?(input: {
		kind: NoticeEntryKind;
		task: TaskKey;
		title: string;
		body: string;
		read: boolean;
		/** spec/notifications-slack-notes-and-schedules#slack: the request a Needs you waits on (a permission's or a question's id), for Slack's buttons. */
		request?: string;
	}): void;
	/** spec/notifications-slack-notes-and-schedules#notification-center: the live requests changed. */
	pendingChanged?(): void;
	/**
	 * spec/remote-access-and-mobile#phone: the same notice as a Web Push to the paired phones — the task's name and the kind on the screen, and the
	 * task's key `<project>/<task>` the phone opens on a tap (spec/remote-access-and-mobile#phone-task-tools).
	 */
	push?(type: PhonePushKind, task: string, key: string): void;
};
/** What a phone's lock screen says (spec/remote-access-and-mobile#phone): Question, Permission, Plan, Done, or that the agent waits. */
export type PhonePushKind = 'needs-you' | 'question' | 'permission' | 'plan' | 'done';
/** The push for a notice, or null for the kinds a phone does not get (a failure, a limit, a read-only repo). */
export function phonePushKind(kind: NoticeKind, eventKind: string): PhonePushKind | null {
	if (kind === 'turn-ended') return 'done';
	if (kind !== 'needs-you') return null;
	if (eventKind === 'permission.requested') return 'permission';
	if (eventKind === 'crew.plan.requested') return 'plan';
	if (
		eventKind === 'question.requested' ||
		eventKind === 'crew.question.escalated' ||
		eventKind === 'turn.completed'
	)
		return 'question';
	return 'needs-you';
}
type TaskState = {
	/** spec/chat-turns-plans-and-questions#background-commands: names of background commands, and the last turn start (an agent that went on after a command). */ background: Map<
		string,
		string
	>;
	turnSeq: number;
	rateLimits: RateLimitWindow[];
	seeded: boolean;
	watermark: number;
	buffer: EventRecord[];
	permissions: Map<string, PermissionRequest>;
	questions: Set<string>;
	proposals: Set<string>;
	plans: Set<string>;
	crewQuestions: Set<string>;
	crewWaiting: boolean;
	handles: Map<string, NoticeHandle>;
	/** spec/notifications-slack-notes-and-schedules#notification-center: when each request now waiting for the person was made, for the center's «Needs you». */
	since: Map<string, number>;
};
const requested = new Set([
	'permission.requested',
	'question.requested',
	'task.proposal.requested',
	'crew.plan.requested',
	'crew.question.requested',
]);
const requestIdOf = (event: EventRecord['event']): string | null =>
	event.kind === 'permission.requested'
		? event.request.id
		: event.kind === 'question.requested' || event.kind === 'crew.question.requested'
			? event.question.id
			: event.kind === 'task.proposal.requested'
				? event.proposal.id
				: event.kind === 'crew.plan.requested'
					? event.plan.id
					: null;
const timeOf = (record: EventRecord) => Date.parse(record.at) || Date.now();
/** What the live requests of a task are, to tell the center only when they change (not on every streamed event). */
const pendingSignature = (state: TaskState) =>
	[
		[...state.permissions.keys()].join(','),
		[...state.questions].join(','),
		[...state.proposals].join(','),
		[...state.plans].join(','),
		state.crewWaiting ? [...state.crewQuestions].join(',') : '',
		state.seeded,
	].join('|');
const name = (key: TaskKey) => `${key.projectId}/${key.id}`;
const bufferLimit = 2000;
/** A lead's plan is resolved right after it is requested (spec/crew#subordinates); only a plan still open after this wait reaches the person. */
const planSettleMs = 750;
/** spec/chat-turns-plans-and-questions#background-commands: Claude goes on by itself ~1.5 s after a background command ends; a finished command notifies
 *  only when no turn began within this wait — the end of that turn notifies instead, so there are never two. */
export const backgroundSettleMs = 5000;
/**
 * Live delivery for Sessions.publish. Events are buffered until the first snapshot
 * seeds a per-task sequence watermark, so reopening or reattaching a journal never
 * re-notifies; pending inputs from the snapshot only feed the Dock badge.
 */
export class Notifications {
	private tasks = new Map<string, TaskState>();
	private chain = Promise.resolve();
	constructor(private deps: Deps) {}
	private state(key: TaskKey) {
		let state = this.tasks.get(name(key));
		if (!state) {
			state = {
				background: new Map(),
				turnSeq: 0,
				rateLimits: [],
				seeded: false,
				watermark: 0,
				buffer: [],
				permissions: new Map(),
				questions: new Set(),
				proposals: new Set(),
				plans: new Set(),
				crewQuestions: new Set(),
				crewWaiting: false,
				handles: new Map(),
				since: new Map(),
			};
			this.tasks.set(name(key), state);
		}
		return state;
	}
	get pendingTasks() {
		return [...this.tasks.values()].filter(
			(state) =>
				state.permissions.size ||
				state.questions.size ||
				state.proposals.size ||
				state.plans.size ||
				state.crewWaiting
		).length;
	}
	seed(key: TaskKey, snapshot: SessionSnapshot | null) {
		const state = this.state(key);
		if (snapshot) {
			state.rateLimits = rateLimits(snapshot.records);
			state.watermark = maxSeq(state.watermark, snapshot.records);
			const pending = pendingInputs(snapshot.records);
			state.permissions = new Map(pending.permissions.map((request) => [request.id, request]));
			state.questions = new Set(pending.questions.map((question) => question.id));
			state.proposals = new Set(pending.proposals.map((proposal) => proposal.id));
			state.plans = new Set(pending.crewPlan ? [pending.crewPlan.id] : []);
			state.crewQuestions = new Set(pending.crewQuestions.map((question) => question.id));
			state.crewWaiting = state.crewQuestions.size > 0 && !snapshotBusy(snapshot.records);
			for (const record of snapshot.records)
				if (requested.has(record.event.kind)) {
					const id = requestIdOf(record.event);
					if (id) state.since.set(id, timeOf(record));
				}
		} else state.watermark = maxSeq(state.watermark, state.buffer);
		state.seeded = true;
		const buffered = state.buffer;
		state.buffer = [];
		for (const record of buffered) this.process(key, state, record);
		if (state.since.size) this.titleOf(key);
		this.updateBadge();
		this.deps.pendingChanged?.();
	}
	observe(key: TaskKey, record: EventRecord) {
		const state = this.state(key);
		if (!state.seeded) {
			if (state.buffer.length < bufferLimit) state.buffer.push(record);
			return;
		}
		this.process(key, state, record);
	}
	/** The host connection ended: nothing is actionable until a reattach reseeds. */
	detached(key: TaskKey) {
		const state = this.state(key);
		state.seeded = false;
		state.buffer = [];
		state.permissions.clear();
		state.questions.clear();
		state.plans.clear();
		for (const [id, handle] of state.handles) {
			if (id.includes('/needs-you/')) {
				handle.close();
				state.handles.delete(id);
			}
		}
		this.updateBadge();
		this.deps.pendingChanged?.();
	}
	private process(key: TaskKey, state: TaskState, record: EventRecord) {
		if (record.seq <= state.watermark) return;
		state.watermark = record.seq;
		const event = record.event,
			group = name(key),
			before = pendingSignature(state);
		if (requested.has(event.kind)) {
			const id = requestIdOf(event);
			if (id) state.since.set(id, timeOf(record));
			this.titleOf(key);
		}
		let requestId: string | null = null;
		switch (event.kind) {
			case 'permission.requested':
				state.permissions.set(event.request.id, event.request);
				requestId = event.request.id;
				break;
			case 'permission.resolved':
				state.permissions.delete(event.id);
				this.close(state, `${group}/needs-you/${event.id}`);
				break;
			case 'question.requested':
				state.questions.add(event.question.id);
				requestId = event.question.id;
				break;
			case 'question.resolved':
				state.questions.delete(event.id);
				this.close(state, `${group}/needs-you/${event.id}`);
				break;
			case 'task.proposal.requested':
				state.proposals.add(event.proposal.id);
				requestId = event.proposal.id;
				break;
			case 'task.proposal.resolved':
				state.proposals.delete(event.id);
				this.close(state, `${group}/needs-you/${event.id}`);
				break;
			case 'crew.plan.requested':
				state.plans.add(event.plan.id);
				requestId = event.plan.id;
				break;
			case 'crew.plan.resolved':
				state.plans.delete(event.id);
				this.close(state, `${group}/needs-you/${event.id}`);
				break;
			// spec/crew#attention: a worker's question waits for the person once the foreman ends its turn without answering, or after escalation.
			case 'crew.question.requested':
				state.crewQuestions.add(event.question.id);
				break;
			case 'crew.question.escalated':
				if (state.crewQuestions.has(event.id) && !state.crewWaiting) {
					state.crewWaiting = true;
					requestId = event.id;
				}
				break;
			case 'crew.question.resolved':
				state.crewQuestions.delete(event.id);
				if (!state.crewQuestions.size) state.crewWaiting = false;
				this.close(state, `${group}/needs-you/${event.id}`);
				break;
			case 'host.stopped':
				state.permissions.clear();
				state.questions.clear();
				state.proposals.clear();
				for (const id of [...state.handles.keys()])
					if (id.includes('/needs-you/')) this.close(state, id);
				break;
			case 'turn.started':
				state.turnSeq = record.seq;
				state.crewWaiting = false;
				this.close(state, `${group}/turn-ended`);
				this.close(state, `${group}/failed`);
				break;
			case 'turn.completed':
				if (event.reason !== 'cancelled' && state.crewQuestions.size) {
					state.crewWaiting = true;
					requestId = [...state.crewQuestions].at(-1)!;
				}
				break;
			case 'background.started':
				state.background.set(event.id, event.name);
				while (state.background.size > 256)
					state.background.delete(state.background.keys().next().value!);
				break;
			case 'background.changed':
				if (event.state === 'completed') {
					const seq = record.seq,
						id = event.id;
					setTimeout(() => {
						if (state.turnSeq < seq) this.deliver(key, state, 'turn-ended', event.kind, id, null);
					}, backgroundSettleMs).unref?.();
				}
				break;
		}
		const wasLimited = Boolean(blockedRateLimit(state.rateLimits));
		state.rateLimits = reduceRateLimits(state.rateLimits, event);
		const limited = blockedRateLimit(state.rateLimits);
		if (!limited) this.close(state, `${group}/rate-limited`);
		const candidate =
				(event.kind === 'turn.completed' && state.crewWaiting) ||
				(event.kind === 'crew.question.escalated' && requestId)
					? 'needs-you'
					: noticeKind(event),
			kind =
				(candidate === 'rate-limited' && (wasLimited || !limited)) ||
				((candidate === 'failed' || candidate === 'turn-ended') && limited)
					? null
					: candidate;
		if (kind && event.kind === 'crew.plan.requested') {
			const id = event.plan.id;
			setTimeout(() => {
				if (state.plans.has(id)) this.deliver(key, state, kind, event.kind, id, null);
			}, planSettleMs).unref?.();
		} else if (kind)
			this.deliver(
				key,
				state,
				kind,
				event.kind,
				event.kind === 'background.changed' ? event.id : requestId,
				event.kind === 'permission.requested' ? event.request : null
			);
		this.updateBadge();
		if (pendingSignature(state) !== before) this.deps.pendingChanged?.();
	}
	private deliver(
		key: TaskKey,
		state: TaskState,
		kind: NoticeKind,
		eventKind: string,
		requestId: string | null,
		request: PermissionRequest | null
	) {
		const decision = notificationDecision(
			kind,
			this.deps.preferences(),
			key,
			this.deps.visibility()
		);
		if (decision.sound) this.deps.sounds.play(decision.sound);
		if (kind !== 'page' && this.deps.log) {
			const visibility = this.deps.visibility(),
				read =
					visibility.active &&
					visibility.task?.id === key.id &&
					visibility.task.projectId === key.projectId;
			void this.deps.taskTitle(key).then(
				(title) => {
					if (kind === 'rate-limited' && !blockedRateLimit(state.rateLimits)) return;
					const locale = this.deps.locale();
					this.deps.log?.({
						kind: entryKind(kind, eventKind),
						task: key,
						title: title ?? t(locale, 'Brigadir'),
						body: this.body(state, kind, eventKind, request, requestId, locale),
						read,
						...(kind === 'needs-you' && requestId ? { request: requestId } : {}),
					});
				},
				() => {}
			);
		}
		const push = decision.show && this.deps.push ? phonePushKind(kind, eventKind) : null;
		if (push)
			void this.deps.taskTitle(key).then(
				(title) =>
					this.deps.push?.(
						push,
						title ?? t(this.deps.locale(), 'Brigadir'),
						`${key.projectId}/${key.id}`
					),
				() => {}
			);
		if (decision.show && this.deps.gateway.supported()) {
			const id =
				kind === 'needs-you' ? `${name(key)}/needs-you/${requestId}` : `${name(key)}/${kind}`;
			this.chain = this.chain
				.then(() => this.show(key, state, id, kind, eventKind, request, requestId))
				.catch(() => {});
		}
	}
	private async show(
		key: TaskKey,
		state: TaskState,
		id: string,
		kind: NoticeKind,
		eventKind: string,
		request: PermissionRequest | null,
		requestId: string | null = null
	) {
		const locale = this.deps.locale(),
			title = (await this.deps.taskTitle(key)) ?? t(locale, 'Brigadir');
		if (kind === 'rate-limited' && !blockedRateLimit(state.rateLimits)) return;
		if (!(await this.deps.allowed())) return;
		const choices = request ? notificationPermissionChoices(request) : { allow: null, deny: null };
		const body = this.body(state, kind, eventKind, request, requestId, locale);
		// Revalidate before dispatch: the request may have been answered in the app meanwhile.
		const answer = (optionId: string | null) => {
			this.close(state, id);
			if (
				!request ||
				!optionId ||
				state.permissions.get(request.id) !== request ||
				!request.options.some((option) => option.id === optionId)
			) {
				this.deps.openTask(key);
				return;
			}
			void this.deps
				.answerPermission(key, request.id, optionId)
				.catch(() => this.deps.openTask(key));
		};
		this.close(state, id);
		const handle = this.deps.gateway.show(
			{
				id,
				groupId: name(key),
				kind,
				key,
				title,
				body,
				actions: {
					allow: choices.allow ? t(locale, 'Allow') : null,
					deny: choices.deny ? t(locale, 'Deny') : null,
				},
			},
			{
				open: () => {
					this.deps.gateway.removeGroup(name(key));
					for (const handleId of [...state.handles.keys()]) this.close(state, handleId);
					this.deps.openTask(key);
				},
				allow: () => answer(choices.allow),
				deny: () => answer(choices.deny),
			}
		);
		if (handle) state.handles.set(id, handle);
	}
	/** The notice's text — the system banner's body and the center's line 2 (spec/notifications-slack-notes-and-schedules#notification-center). */
	private body(
		state: TaskState,
		kind: NoticeKind,
		eventKind: string,
		request: PermissionRequest | null,
		requestId: string | null,
		locale: Locale
	) {
		return eventKind === 'background.changed'
			? [
					t(
						locale,
						kind === 'failed'
							? 'The background command failed.'
							: 'The background command finished.'
					),
					requestId ? state.background.get(requestId) : null,
				]
					.filter(Boolean)
					.join(' ')
			: eventKind === 'permission.requested'
				? [request?.tool.title, t(locale, 'The agent is waiting for your permission.')]
						.filter(Boolean)
						.join(' · ')
				: eventKind === 'question.requested'
					? t(locale, 'The agent asked a question.')
					: eventKind === 'task.proposal.requested'
						? t(locale, 'The agent proposes a new task.')
						: eventKind === 'crew.plan.requested'
							? t(locale, 'The foreman proposes a split')
							: (eventKind === 'turn.completed' && kind === 'needs-you') ||
								  eventKind === 'crew.question.escalated'
								? t(locale, 'A worker is waiting for your answer.')
								: kind === 'turn-ended'
									? t(locale, 'The turn ended.')
									: kind === 'rate-limited'
										? [
												t(locale, 'Subscription limit reached.'),
												limitedReset(state.rateLimits, locale),
											].join(' ')
										: kind === 'scope-violation'
											? t(locale, 'A read-only repo changed.')
											: t(locale, 'The session failed.');
	}
	/** spec/notifications-slack-notes-and-schedules#notification-center: the live requests of every task for the center's «Needs you», newest first. */
	pendingNotices(): PendingNotice[] {
		const locale = this.deps.locale(),
			out: PendingNotice[] = [];
		for (const [group, state] of this.tasks) {
			if (!state.seeded) continue;
			const [projectId, id] = group.split('/') as [string, string],
				task = { projectId, id },
				title = this.titleOf(task),
				item = (
					requestId: string,
					kind: PendingNoticeKind,
					body: string,
					choices = { allow: null as string | null, deny: null as string | null }
				) =>
					out.push({
						id: `${group}/${encodeURIComponent(requestId)}`,
						at: state.since.get(requestId) ?? 0,
						kind,
						task,
						title,
						body,
						...choices,
					});
			for (const request of state.permissions.values())
				item(
					request.id,
					'permission',
					[request.tool.title, t(locale, 'The agent is waiting for your permission.')]
						.filter(Boolean)
						.join(' · '),
					notificationPermissionChoices(request)
				);
			for (const question of state.questions)
				item(question, 'question', t(locale, 'The agent asked a question.'));
			for (const proposal of state.proposals)
				item(proposal, 'proposal', t(locale, 'The agent proposes a new task.'));
			for (const plan of state.plans) item(plan, 'plan', t(locale, 'The foreman proposes a split'));
			if (state.crewWaiting && state.crewQuestions.size)
				item(
					[...state.crewQuestions].at(-1)!,
					'worker',
					t(locale, 'A worker is waiting for your answer.')
				);
		}
		return out.sort((a, b) => b.at - a.at);
	}
	private titles = new Map<string, string>();
	private titleOf(key: TaskKey) {
		const known = this.titles.get(name(key));
		if (known) return known;
		void this.deps.taskTitle(key).then(
			(title) => {
				if (!title) return;
				this.titles.set(name(key), title);
				this.deps.pendingChanged?.();
			},
			() => {}
		);
		return t(this.deps.locale(), 'Brigadir');
	}
	/** The center's Allow / Deny: the same one-time options and the same check as the banner's (spec/notifications-slack-notes-and-schedules#notification-center). */
	answer(id: string, option: 'allow' | 'deny') {
		const cut = id.lastIndexOf('/'),
			group = id.slice(0, cut),
			requestId = decodeURIComponent(id.slice(cut + 1)),
			state = this.tasks.get(group);
		if (!state) return;
		const [projectId, taskId] = group.split('/') as [string, string],
			key = { projectId, id: taskId },
			request = state.permissions.get(requestId);
		const optionId = request ? notificationPermissionChoices(request)[option] : null;
		if (!request || !optionId) {
			this.deps.openTask(key);
			return;
		}
		this.close(state, `${group}/needs-you/${requestId}`);
		void this.deps.answerPermission(key, request.id, optionId).catch(() => this.deps.openTask(key));
	}
	/**
	 * spec/browser-and-simulator#notifications: a page's notification out of sight — silent, in the task's group, off with «When» = Never. The same
	 * `tag` of the page replaces its earlier one; `close` is the page closing it.
	 */
	async page(
		key: TaskKey,
		notice: { id: string; title: string; body: string },
		open: () => void
	): Promise<NoticeHandle | null> {
		const state = this.state(key);
		// spec/notifications-slack-notes-and-schedules#notification-center: the page's notification is history whatever «When» and the OS permission are.
		if (this.deps.log) {
			const visibility = this.deps.visibility();
			this.deps.log({
				kind: 'page',
				task: key,
				title: notice.title,
				body: notice.body,
				read:
					visibility.active &&
					visibility.task?.id === key.id &&
					visibility.task.projectId === key.projectId,
			});
		}
		if (this.deps.preferences().mode === 'off' || !(await this.deps.allowed())) return null;
		this.close(state, notice.id);
		const handle = this.deps.gateway.show(
			{
				id: notice.id,
				groupId: name(key),
				kind: 'page',
				key,
				title: notice.title,
				body: notice.body,
				actions: { allow: null, deny: null },
			},
			{
				open: () => {
					this.close(state, notice.id);
					this.deps.openTask(key);
					open();
				},
				allow: () => {},
				deny: () => {},
			}
		);
		if (handle) state.handles.set(notice.id, handle);
		return handle && { close: () => this.close(state, notice.id) };
	}
	private close(state: TaskState, id: string) {
		const handle = state.handles.get(id);
		if (handle) {
			state.handles.delete(id);
			handle.close();
		}
	}
	/** The Dock badge changes only when the number of tasks waiting for the person does. */
	private badgeCount: number | null = null;
	private updateBadge() {
		const count = this.pendingTasks;
		if (count === this.badgeCount) return;
		this.badgeCount = count;
		this.deps.badge(count);
	}
}

/** The center's row kind for a notice: a request names what it waits for (spec/notifications-slack-notes-and-schedules#notification-center). */
function entryKind(kind: NoticeKind, eventKind: string): NoticeEntryKind {
	if (kind === 'needs-you')
		return eventKind === 'permission.requested'
			? 'permission'
			: eventKind === 'question.requested'
				? 'question'
				: eventKind === 'task.proposal.requested'
					? 'proposal'
					: eventKind === 'crew.plan.requested'
						? 'plan'
						: 'worker';
	if (kind === 'turn-ended' && eventKind === 'background.changed') return 'background';
	return kind as NoticeEntryKind;
}
/** The journal ends inside a turn: a pending crew question is the foreman's to answer, not yet the person's. */
function snapshotBusy(records: readonly EventRecord[]) {
	for (let index = records.length - 1; index >= 0; index--) {
		const kind = records[index]!.event.kind;
		if (kind === 'turn.started') return true;
		if (kind === 'turn.completed' || kind === 'host.stopped') return false;
	}
	return false;
}
/** A loop, not Math.max(...seqs): spreading a long journal overflows the argument stack. */
function maxSeq(start: number, records: readonly EventRecord[]) {
	let max = start;
	for (const record of records) if (record.seq > max) max = record.seq;
	return max;
}
function limitedReset(windows: RateLimitWindow[], locale: Locale) {
	const limit = blockedRateLimit(windows);
	return limit?.resetsAt == null
		? t(locale, 'Reset time is unavailable. Waiting for the provider.')
		: t(locale, 'Resets in {minutes} min').replace(
				'{minutes}',
				new Intl.NumberFormat(locale).format(
					Math.max(0, Math.ceil((limit.resetsAt * 1000 - Date.now()) / 60000))
				)
			);
}
