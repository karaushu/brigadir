import { isPRRef, type PRRef } from './forge';
import type { QueuedPrompt } from './prompt-queue';
import { isAttachmentId, isAttachmentIds, type PromptAttachment } from './attachments';
import { isReviewBatch, type ReviewBatch } from './review';
import type { AgentCommand, AgentEvent, PermissionRequest } from './agent';
import { isId, isRecord } from './workspace';
import {
	isCrewPlan,
	isCrewPlanDecision,
	isCrewTurnMarker,
	type CrewNote,
	type CrewPlan,
	type CrewPlanDecision,
	type CrewQuestion,
	type CrewReportSummary,
	type CrewTurnMarker,
} from './crew-runtime';
export type TaskKey = { projectId: string; id: string };
export type UserQuestion = {
	id: string;
	question: string;
	header: string;
	options: { label: string; description: string }[];
	allowsFreeText: boolean;
	allowsMultiple: boolean;
};
export type QuestionAnswer = { labels: string[]; text: string };
export type SessionEvent =
	| AgentEvent
	| { kind: 'rate-limit.expired'; window: string | null; resetsAt: number }
	| { kind: 'pull-request.changed'; scopeId: string; pr: PRRef }
	/** `before`: a held message (spec/composer-steering-queue-and-ghost#steering-hold) goes in front of what was queued after it was held, so the order of sending stays. */
	| { kind: 'prompt.queued'; prompt: QueuedPrompt; before?: string }
	/** spec/composer-steering-queue-and-ghost#steering: the prompt went into the running turn (`_session/steering`), journaled before the request. A later `prompt.queued`
	 *  with the same id means the agent declined it and the host queued it after all. */
	| { kind: 'prompt.steered'; prompt: QueuedPrompt }
	/** spec/composer-steering-queue-and-ghost#steering-hold: the host holds the person's mid-turn message until the step boundary; `prompt.steered`, `prompt.queued` or
	 *  `prompt.removed` with the same id ends the hold. */
	| { kind: 'prompt.held'; prompt: QueuedPrompt }
	| { kind: 'prompt.removed'; id: string }
	| { kind: 'queue.resumed' }
	| { kind: 'queue.paused' }
	/** `origin: 'agent'` — the agent began this turn on its own (Claude Code after a background task, spec/chat-turns-plans-and-questions#agent-started-turns): nobody prompted
	 *  it, so `text` is empty and the log has no person's row for it. */
	| {
			kind: 'turn.started';
			text: string;
			queuedPromptId?: string;
			review?: ReviewBatch;
			attachments?: PromptAttachment[];
			attachmentBatchId?: string;
			crew?: CrewTurnMarker;
			origin?: 'agent';
	  }
	| { kind: 'crew.plan.requested'; plan: CrewPlan }
	| {
			kind: 'crew.plan.resolved';
			id: string;
			approved: boolean;
			parts: CrewPlan['parts'] | null;
			/** spec/crew#compose: the person's edit of the proposed crew. */ crew?: NonNullable<
				CrewPlan['crew']
			>;
	  }
	| { kind: 'crew.worker.created'; taskId: string; nodeId: string; name: string; title: string }
	/** spec/crew#parts: the next part of a crew member, in its one task. */
	| {
			kind: 'crew.part.started';
			taskId: string;
			nodeId: string;
			name: string;
			title: string;
			part: number;
	  }
	/** spec/crew#parts: the human aborted the crew tree's merge into the member's branch; the waiting part is withdrawn. */
	| {
			kind: 'crew.part.dropped';
			taskId: string;
			nodeId: string;
			name: string;
			title: string;
			part: number;
	  }
	| { kind: 'crew.report'; report: CrewReportSummary }
	| { kind: 'crew.note'; note: CrewNote }
	| { kind: 'crew.question.requested'; question: CrewQuestion }
	| { kind: 'crew.question.escalated'; id: string }
	| {
			kind: 'crew.question.resolved';
			id: string;
			answer: string | null;
			answeredBy: 'foreman' | 'human' | null;
	  }
	| {
			kind: 'crew.review';
			reviewId: string;
			taskId: string;
			name: string;
			reviewer: string;
			round: number;
			approved: boolean;
			comments: number;
			state: 'reviewing' | 'comments' | 'approved' | 'disputed';
	  }
	/** spec/diff-and-review#agent-review-start: the agent proposed a review (`propose_review`), the person dismissed it, a review started or ended. Its rounds are `crew.review`. */
	| { kind: 'review.proposed'; summary: string }
	| { kind: 'review.dismissed' }
	/** The task's agent answered a reviewer's comment (`review_reply`); the thread is in `review.json`. */
	| { kind: 'review.replied'; commentId: string }
	| { kind: 'review.started'; id: string; reviewers: string[]; who: TaskReviewWho }
	| { kind: 'review.finished'; id: string; state: 'approved' | 'disputed' | 'outdated' | 'stopped' }
	| { kind: 'crew.accepted'; taskId: string; nodeId: string; name: string; conflicts: string[] }
	| { kind: 'crew.worker.stopped'; taskId: string; nodeId: string; name: string; reason: string }
	/** `returnMode`: `Погодити` on a plan asked the host to bring this mode back once the agent leaves the plan (spec/chat-turns-plans-and-questions#plan-approval). */
	| { kind: 'permission.resolved'; id: string; optionId: string | null; returnMode?: string }
	| { kind: 'question.requested'; question: UserQuestion }
	| { kind: 'question.resolved'; id: string; answer: QuestionAnswer | null }
	/** spec/tasks#agent-created-tasks: `create_task` waits on a card; `task` is the created task, `null` — the person declined or the turn stopped. */
	| { kind: 'task.proposal.requested'; proposal: TaskProposal }
	| { kind: 'task.proposal.resolved'; id: string; task: TaskProposalResult }
	| {
			kind: 'file.saved';
			path: string;
			before: number | null;
			after: number | null;
			version: string;
	  }
	/** spec/composer-steering-queue-and-ghost#quick-question: a quick question (a separate session, outside the chat) changed these files between two checkpoints. */
	| { kind: 'quick-ask.changed'; question: string; files: string[]; before: number; after: number }
	| { kind: 'scopes.changed' }
	| { kind: 'scope.violation'; scopeId: string; name: string; paths: string[]; checkpoint: number }
	| { kind: 'checkpoint.created'; checkpoint: number }
	| { kind: 'snapshot.failed'; message: string }
	| { kind: 'host.stopped'; reason: string };
export type EventRecord = { schemaVersion: 1; seq: number; at: string; event: SessionEvent };
export type SessionCommand =
	| AgentCommand
	| { kind: 'recordPullRequest'; scopeId: string; pr: PRRef }
	| { kind: 'setScope'; update: ScopeUpdate }
	/** spec/projects-and-board#folders-mid-task: a folder from outside the root joins the task chosen, also while its agent runs. */
	| { kind: 'addScope'; choice: ScopeChoice }
	/** `returnMode`: the plan is approved with `allow_once`; the host sets this mode once the agent leaves the plan mode (spec/chat-turns-plans-and-questions#plan-approval). */
	| { kind: 'answerPermission'; id: string; optionId: string | null; returnMode?: string }
	| { kind: 'answerQuestion'; id: string; answer: QuestionAnswer | null }
	/** spec/tasks#agent-created-tasks: main after it created the proposed task, or the card's `Відхилити` with `null`. */
	| { kind: 'resolveTaskProposal'; id: string; task: TaskProposalResult }
	| { kind: 'decidePlan'; decision: CrewPlanDecision }
	| { kind: 'answerCrewQuestion'; id: string; answer: string }
	/** spec/diff-and-review#agent-review-start: main resolved the reviewers and the guidance; the host runs the rounds. */
	| {
			kind: 'startReview';
			reviewers: CrewSpecAgent[];
			who: TaskReviewWho;
			instructions: string;
			guidance: string;
			/** spec/diff-and-review#agent-review-start: `Since the last review`. */
			since?: 'start' | 'last';
	  }
	| { kind: 'stopReview' }
	| { kind: 'dismissReviewProposal' }
	| { kind: 'submitReview'; text: string; review: ReviewBatch }
	| { kind: 'removeQueuedPrompt'; id: string }
	/** spec/composer-steering-queue-and-ghost#steering-hold: «Надіслати зараз» on a queued row — the host holds it for the running turn like a fresh Enter. */
	| { kind: 'steerQueuedPrompt'; id: string }
	/** spec/agents-and-providers#sign-in-recovery: start the failed turn again on a fresh adapter process; `auth` — only when it failed on sign-in (after a sign-in, sent to every host). */
	| { kind: 'retryTurn'; reason?: 'auth' }
	| { kind: 'resumePromptQueue' }
	| { kind: 'pausePromptQueue' }
	| { kind: 'checkpoint' }
	/** spec/composer-steering-queue-and-ghost#quick-question: the checkpoint before (`quick-before`) and after (`quick-after`) a quick question; `after` journals its files. */
	| { kind: 'quickAsk'; phase: 'before' }
	| { kind: 'quickAsk'; phase: 'after'; question: string; files: string[]; before: number }
	| { kind: 'discardQueuedReview' }
	| { kind: 'attachContext'; id: string }
	| { kind: 'removeContext'; id: string }
	| { kind: 'shutdown' }
	/** spec/architecture-and-platform#auto-update: the host runs an older app's code; it stops at the first moment nothing runs, as an idle stop does. */
	| { kind: 'retire' };
export type SessionSnapshot = {
	key: TaskKey;
	records: EventRecord[];
	connected: boolean;
	issue: string | null;
	pendingReview?: ReviewBatch;
	pendingAttachments?: PromptAttachment[];
	/** spec/tasks#launch-sheet: waiting for a free agent slot; main starts it and sends the first prompt itself. */ queued?: boolean;
};
/** A snapshot cursor past any journal: the current state (connected, queued review and attachments) without records. */
export const sessionStateOnly = Number.MAX_SAFE_INTEGER;
/** What pollers need from a host without the journal: readiness, the last seq, the latest start/failure seqs and whether a turn runs.
 *  `busy` is absent from hosts started before it existed (wave 1); callers then read the snapshot once. */
export type HostStatus = {
	connected: boolean;
	seq: number;
	started: number | null;
	failed: number | null;
	busy?: boolean;
};
const turnBoundaries: ReadonlySet<string> = new Set([
	'turn.started',
	'turn.completed',
	'session.failed',
	'host.stopped',
]);
/** spec/architecture-and-platform#host-lifecycle: the `host.stopped` reason of a stop for idleness. The agent stays resumable: the next message starts the host again. */
export const hostIdleReason = 'idle';
/** spec/architecture-and-platform#auto-update: the `host.stopped` reason of a host replaced after an app update. Like an idle stop, the next message starts a host of the new app. */
export const hostUpdateReason = 'update';
/** A stop that leaves the session resumable with the next message: no «Agent is not running.», no Resume. */
export function resumableStop(reason: string) {
	return reason === hostIdleReason || reason === hostUpdateReason;
}
/** The last agent boundary is an idle or update stop of a session that has started. A console-only host (`console_closed`) never ran the agent and does not count. */
export function idleStopped(records: readonly EventRecord[]) {
	for (let index = records.length - 1; index >= 0; index--) {
		const event = records[index]!.event;
		if (event.kind === 'host.stopped') {
			if (event.reason === 'console_closed') continue;
			return (
				resumableStop(event.reason) &&
				records.some((record) => record.event.kind === 'session.started')
			);
		}
		if (
			event.kind === 'session.started' ||
			event.kind === 'session.failed' ||
			event.kind === 'turn.started'
		)
			return false;
	}
	return false;
}
/** No host stopped since the last `session.started`: its agent still runs. A host started for the task's consoles (spec/task-window-workspace#restore-window)
 *  is connected without an agent, so the session of a host that quit yesterday is not live. */
export function agentRunning(records: readonly EventRecord[]) {
	for (let index = records.length - 1; index >= 0; index--) {
		const kind = records[index]!.event.kind;
		if (kind === 'session.started') return true;
		if (kind === 'host.stopped') return false;
	}
	return false;
}
/** A turn runs when the last turn boundary is its start. */
export function isBusy(records: readonly EventRecord[]) {
	for (let index = records.length - 1; index >= 0; index--) {
		const kind = records[index]!.event.kind;
		if (turnBoundaries.has(kind)) return kind === 'turn.started';
	}
	return false;
}
export function hostStatus(records: readonly EventRecord[], connected: boolean): HostStatus {
	let started: number | null = null,
		failed: number | null = null,
		busy: boolean | null = null;
	for (
		let index = records.length - 1;
		index >= 0 && (started === null || failed === null || busy === null);
		index--
	) {
		const record = records[index]!,
			kind = record.event.kind;
		if (busy === null && turnBoundaries.has(kind)) busy = kind === 'turn.started';
		if (started === null && kind === 'session.started') started = record.seq;
		else if (failed === null && kind === 'session.failed') failed = record.seq;
	}
	return { connected, seq: records.at(-1)?.seq ?? 0, started, failed, busy: busy ?? false };
}
const seqOrNull = (value: unknown) => value === null || Number.isSafeInteger(value);
export function isHostStatus(value: unknown): value is HostStatus {
	return (
		isRecord(value) &&
		typeof value.connected === 'boolean' &&
		Number.isSafeInteger(value.seq) &&
		seqOrNull(value.started) &&
		seqOrNull(value.failed) &&
		(value.busy === undefined || typeof value.busy === 'boolean')
	);
}
/** Events after which scope rows, locks or change totals can differ. Streaming deltas and tool updates never do (perf review R1). */
const scopeEventKinds: ReadonlySet<string> = new Set([
	'session.started',
	'session.failed',
	'host.stopped',
	'turn.started',
	'turn.completed',
	'checkpoint.created',
	'scopes.changed',
	'file.saved',
	'quick-ask.changed',
	'crew.accepted',
]);
export function affectsScopes(record: EventRecord | null) {
	return !record || scopeEventKinds.has(record.event.kind);
}
export function isTaskKey(v: unknown): v is TaskKey {
	return isRecord(v) && isId(v.projectId) && isId(v.id);
}
const text = (v: unknown): v is string => typeof v === 'string';
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(text);
export function isQuestionAnswer(v: unknown): v is QuestionAnswer {
	return isRecord(v) && strings(v.labels) && text(v.text) && v.text.length <= 100_000;
}
export function isUserQuestion(v: unknown): v is UserQuestion {
	return (
		isRecord(v) &&
		text(v.id) &&
		text(v.question) &&
		v.question.trim().length > 0 &&
		v.question.length <= 100_000 &&
		text(v.header) &&
		typeof v.allowsFreeText === 'boolean' &&
		typeof v.allowsMultiple === 'boolean' &&
		Array.isArray(v.options) &&
		v.options.length <= 100 &&
		v.options.every(
			(o) => isRecord(o) && text(o.label) && o.label.trim().length > 0 && text(o.description)
		) &&
		(v.allowsFreeText || v.options.length > 0) &&
		new Set(v.options.map((o) => (o as { label: string }).label)).size === v.options.length
	);
}
export function validAnswer(q: UserQuestion, a: QuestionAnswer): boolean {
	return (
		isQuestionAnswer(a) &&
		(q.allowsMultiple || a.labels.length <= 1) &&
		(q.allowsFreeText || a.text === '') &&
		new Set(a.labels).size === a.labels.length &&
		a.labels.every((l) => q.options.some((o) => o.label === l)) &&
		(a.labels.length > 0 || a.text.trim().length > 0)
	);
}
export function isSessionCommand(v: unknown): v is SessionCommand {
	if (!isRecord(v)) return false;
	switch (v.kind) {
		case 'recordPullRequest':
			return typeof v.scopeId === 'string' && /^[a-f0-9]{16}$/.test(v.scopeId) && isPRRef(v.pr);
		case 'setScope':
			return isScopeUpdate(v.update);
		case 'addScope':
			return (
				isScopeChoice(v.choice) &&
				(v.choice.kind === 'external' || v.choice.kind === 'folder') &&
				typeof v.choice.path === 'string'
			);
		case 'cancel':
		case 'shutdown':
		case 'retire':
		case 'checkpoint':
		case 'discardQueuedReview':
		case 'resumePromptQueue':
		case 'pausePromptQueue':
			return true;
		case 'submitReview':
			return (
				text(v.text) &&
				v.text.trim().length > 0 &&
				v.text.length <= 1_000_000 &&
				isReviewBatch(v.review)
			);
		case 'attachContext':
		case 'removeContext':
		case 'removeQueuedPrompt':
		case 'steerQueuedPrompt':
			return isAttachmentId(v.id);
		case 'prompt':
			return (
				text(v.text) &&
				v.text.length <= 1_000_000 &&
				(v.attachmentIds === undefined || isAttachmentIds(v.attachmentIds)) &&
				(v.crew === undefined || isCrewTurnMarker(v.crew)) &&
				(v.steer === undefined || (v.steer === true && v.crew === undefined)) &&
				(v.text.trim().length > 0 || (Array.isArray(v.attachmentIds) && v.attachmentIds.length > 0))
			);
		case 'retryTurn':
			return v.reason === undefined || v.reason === 'auth';
		case 'stopBackground':
			return isBackgroundId(v.id);
		case 'stopSubagent':
			return isSubagentId(v.id);
		case 'quickAsk':
			return (
				v.phase === 'before' ||
				(v.phase === 'after' &&
					text(v.question) &&
					v.question.length <= 200 &&
					Number.isSafeInteger(v.before) &&
					Number(v.before) >= 0 &&
					Array.isArray(v.files) &&
					v.files.length > 0 &&
					v.files.length <= 128 &&
					v.files.every(
						(path) =>
							text(path) &&
							path.length > 0 &&
							path.length <= 4096 &&
							!path.startsWith('/') &&
							!path.split('/').includes('..')
					))
			);
		case 'setMode':
			return text(v.modeId);
		case 'setOption':
			return text(v.id) && (text(v.value) || typeof v.value === 'boolean');
		case 'answerPermission':
			return (
				text(v.id) &&
				(v.optionId === null || text(v.optionId)) &&
				(v.returnMode === undefined || (text(v.returnMode) && v.optionId !== null))
			);
		case 'answerQuestion':
			return text(v.id) && (v.answer === null || isQuestionAnswer(v.answer));
		case 'resolveTaskProposal':
			return text(v.id) && v.id.length <= 64 && isTaskProposalResult(v.task);
		case 'decidePlan':
			return isCrewPlanDecision(v.decision);
		case 'startReview':
			return (
				Array.isArray(v.reviewers) &&
				v.reviewers.length > 0 &&
				v.reviewers.length <= 8 &&
				v.reviewers.every(isCrewSpecAgent) &&
				isTaskReviewWho(v.who) &&
				text(v.instructions) &&
				v.instructions.length <= taskReviewInstructionsLimit &&
				text(v.guidance) &&
				v.guidance.length <= taskReviewGuidanceLimit &&
				(v.since === undefined || v.since === 'start' || v.since === 'last')
			);
		case 'stopReview':
		case 'dismissReviewProposal':
			return true;
		case 'answerCrewQuestion':
			return (
				isId(v.id) && text(v.answer) && v.answer.trim().length > 0 && v.answer.length <= 100_000
			);
		default:
			return false;
	}
}
export type PendingInputs = {
	permissions: PermissionRequest[];
	questions: UserQuestion[];
	crewPlan: CrewPlan | null;
	crewQuestions: CrewQuestion[];
	proposals: TaskProposal[];
};
export function pendingInputs(records: readonly EventRecord[]): PendingInputs {
	const permissions = new Map<string, PermissionRequest>();
	const questions = new Map<string, UserQuestion>();
	const crewQuestions = new Map<string, CrewQuestion>();
	const proposals = new Map<string, TaskProposal>();
	let crewPlan: CrewPlan | null = null;
	for (const { event: e } of records) {
		if (e.kind === 'crew.plan.requested') crewPlan = e.plan;
		if (e.kind === 'crew.plan.resolved' && crewPlan?.id === e.id) crewPlan = null;
		if (e.kind === 'crew.question.requested') crewQuestions.set(e.question.id, e.question);
		// spec/crew#ask-foreman: after five minutes the person may answer for the foreman; the card follows the escalation.
		if (e.kind === 'crew.question.escalated') {
			const question = crewQuestions.get(e.id);
			if (question) crewQuestions.set(e.id, { ...question, state: 'escalated' });
		}
		if (e.kind === 'crew.question.resolved') crewQuestions.delete(e.id);
		if (e.kind === 'permission.requested') permissions.set(e.request.id, e.request);
		if (e.kind === 'permission.resolved') permissions.delete(e.id);
		if (e.kind === 'question.requested') questions.set(e.question.id, e.question);
		if (e.kind === 'question.resolved') questions.delete(e.id);
		if (e.kind === 'task.proposal.requested') proposals.set(e.proposal.id, e.proposal);
		if (e.kind === 'task.proposal.resolved') proposals.delete(e.id);
		if (e.kind === 'host.stopped') {
			permissions.clear();
			questions.clear();
			proposals.clear();
		}
	}
	return {
		permissions: [...permissions.values()],
		questions: [...questions.values()],
		crewPlan,
		crewQuestions: [...crewQuestions.values()],
		proposals: [...proposals.values()],
	};
}
import { isScopeUpdate, type ScopeUpdate } from './scope-controls';
import { isScopeChoice, type ScopeChoice } from './launch';
import { isTaskProposalResult, type TaskProposal, type TaskProposalResult } from './task-proposal';
import { isBackgroundId, isSubagentId } from './background';
import { isCrewSpecAgent, type CrewSpecAgent } from './crew';
import {
	isTaskReviewWho,
	taskReviewGuidanceLimit,
	taskReviewInstructionsLimit,
	type TaskReviewWho,
} from './task-review';
/** The card or row that waits for the person's answer keeps the task in `needs-you` (spec/tasks#agent-created-tasks adds the proposed task, spec/crew#workers the foreman's plan). */
export function waitsForPerson(inputs: PendingInputs) {
	return (
		inputs.questions.length > 0 ||
		inputs.permissions.length > 0 ||
		inputs.proposals.length > 0 ||
		inputs.crewPlan !== null
	);
}
