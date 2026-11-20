import type { DesignNode, DesignReviewState, DesignVerdict } from './design-review';
import { isPRRef, type PRRef } from './forge';
import type { QueuedPrompt } from './prompt-queue';
import { isAttachmentId, isAttachmentIds, type PromptAttachment } from './attachments';
import { isReviewBatch, type ReviewBatch } from './review';
import type { AgentCommand, AgentEvent, PermissionRequest } from './agent';
import { isId, isRecord } from './workspace';
import {
	isAutoBudget,
	isAutoHireDecision,
	isAutoModelAnswer,
	type AutoBudget,
	type AutoHire,
	type AutoHireDecision,
	type AutoHired,
	type AutoHirePart,
	type AutoModelAnswer,
	type AutoModelRequest,
} from './auto';
import type { CrewDismissReason } from './crew-runtime';
import type { TaskClass, TaskClassCause } from './task-class';
import type { ReadyWhere, SmokeDropReason, SmokeStep, SmokeStopCause } from './smoke';
import {
	isCrewPlan,
	isCrewPlanDecision,
	isCrewTurnMarker,
	isCrewAssignmentId,
	type CrewNote,
	type CrewPlan,
	type CrewAssignmentKind,
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
	/** spec/crew#assignment-after-compaction: the host gave the member its current assignment back after the compaction at `compactedSeq` (or later ones up to it);
	 *  `assignment` — what the block held, empty when nothing was open or the prompt itself carried it. The block's text is never journaled. */
	| { kind: 'crew.assignment.restored'; compactedSeq: number; assignment: CrewAssignmentKind[] }
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
	/** spec/reviews#start: the agent proposed a review (`propose_review`), the person dismissed it, a review started or ended. Its rounds are `crew.review`. */
	| { kind: 'review.proposed'; summary: string }
	| { kind: 'review.dismissed' }
	/** The task's agent answered a reviewer's comment (`review_reply`); the thread is in `review.json`. */
	| { kind: 'review.replied'; commentId: string }
	/** Older journals: a review's start and end before the loop of spec/reviews#loop; they replay as they were drawn. */
	| { kind: 'review.started'; id: string; reviewers: string[]; who: TaskReviewWho }
	| { kind: 'review.finished'; id: string; state: 'approved' | 'disputed' | 'outdated' | 'stopped' }
	/** spec/reviews#data: a review at one point of the task — started, read, answered, closure-checked, decided by the person, ended. */
	| {
			kind: 'task-review.started';
			id: string;
			point: ReviewPoint;
			startedBy: TaskReviewStarter;
			reviewers: string[];
			reason?: string;
			/** spec/reviews#tripwire: the host started it because a small task grew past its limit. */
			threshold?: { files: number; lines: number };
			/** spec/reviews#large-review: the host started it because a Large task's hired parts are back. */
			hired?: boolean;
	  }
	| {
			kind: 'task-review.findings';
			id: string;
			point: ReviewPoint;
			findings: number;
			reviewers: string[];
			/** spec/reviews#plan-verdict: a plan review's gaps in the ticket, for the person. */
			gaps?: number;
	  }
	| {
			kind: 'task-review.answered';
			id: string;
			point: ReviewPoint;
			fixed: number;
			answered: number;
	  }
	| {
			kind: 'task-review.verified';
			id: string;
			point: ReviewPoint;
			closed: number;
			open: number;
			introduced: number;
	  }
	| {
			kind: 'task-review.decided';
			id: string;
			point: ReviewPoint;
			decision: 'fix' | 'accept';
			findings: number;
	  }
	| {
			kind: 'task-review.finished';
			id: string;
			point: ReviewPoint;
			state: 'passed' | 'accepted' | 'stopped' | 'failed' | 'outdated';
			failure?: string;
			/** spec/reviews#plan-loop: the plan's approval ended the review with this many findings open. */
			approval?: boolean;
			open?: number;
	  }
	/** spec/reviews#classes: the agent stated the task's class, or the host raised it (a hire, the tripwire). */
	| {
			kind: 'task.class';
			class: TaskClass;
			reason: string;
			by: 'agent' | 'host';
			previous?: TaskClass;
			cause?: TaskClassCause;
			files?: number;
			lines?: number;
	  }
	/** spec/smoke-run#data: the agent started a smoke run; `limitMs` is the setting's limit then. */
	| { kind: 'smoke.started'; id: string; steps: string[]; limitMs: number }
	/** spec/smoke-run#limit: the person's `+5 min`; `limitMs` is the new total. */
	| { kind: 'smoke.extended'; id: string; limitMs: number; by: 'person' }
	/** spec/smoke-run#limit: the host stopped the run at its limit, or the person's `Stop`. */
	| { kind: 'smoke.stopped'; id: string; cause: SmokeStopCause }
	| {
			kind: 'smoke.reported';
			id: string;
			steps: SmokeStep[];
			summary: string;
			elapsedMs: number;
			stopped?: SmokeStopCause;
	  }
	/** spec/smoke-run#limit: the run ended without a report. */
	| { kind: 'smoke.dropped'; id: string; reason: SmokeDropReason; elapsedMs: number }
	/** spec/smoke-run#ready: the agent says a screen is assembled and can be looked at. */
	| {
			kind: 'task.ready';
			id: string;
			screen: string;
			where: ReadyWhere;
			device?: string;
			tab?: string;
			url?: string;
	  }
	/** spec/reviews#save-source: the author saved a ticket, spec or contract next to the plan. */
	| { kind: 'source.saved'; id: string; title: string; url?: string; chars: number }
	/** spec/design-review#data: a screen checked against its design, with what the host verified of each node. */
	| {
			kind: 'design.reviewed';
			id: string;
			screen: string;
			state: DesignReviewState;
			verdict: DesignVerdict;
			reviewId?: string;
			nodes: DesignNode[];
	  }
	| { kind: 'crew.accepted'; taskId: string; nodeId: string; name: string; conflicts: string[] }
	| { kind: 'crew.worker.stopped'; taskId: string; nodeId: string; name: string; reason: string }
	/** spec/crew#auto-hire: the Auto agent asked to hire; the card waits for the person (`needs-you`) and survives a restart. */
	| { kind: 'crew.hire.requested'; hire: AutoHire }
	/** `parts`: the person's edit, null — as proposed; `hired`: the worker tasks that started. */
	| {
			kind: 'crew.hire.resolved';
			id: string;
			approved: boolean;
			parts: AutoHirePart[] | null;
			hired: AutoHired[];
			/** spec/crew#auto-move: the move into a worktree failed, so the hire did not start. */
			reason?: 'no-worktree';
	  }
	/** spec/crew#auto-move: a task without isolation moves into a worktree before its hire; the newest event of an id is its chat row. */
	| WorkspaceMoveEvent
	/** spec/tasks#agent-worktrees: a worktree made in the task's turns joined it, or its folder went away. */
	| WorktreeJoinedEvent
	| WorktreeRemovedEvent
	/** spec/crew#auto-dismiss */
	| {
			kind: 'crew.worker.dismissed';
			taskId: string;
			nodeId: string;
			name: string;
			title: string;
			reason: CrewDismissReason;
	  }
	/** spec/crew#auto-commit: the Auto agent's own edits committed to its branch before a hire or an accept. */
	| {
			kind: 'crew.lead.committed';
			reason: 'hire' | 'accept';
			commits: { scope: string; sha: string }[];
	  }
	/** spec/crew#auto-budget: in the Auto agent's journal and in the worker's own, where it sets `needs-you`. */
	| {
			kind: 'crew.budget.exceeded';
			taskId: string;
			name: string;
			title: string;
			budget: AutoBudget;
			used: { minutes: number; tokens: number };
	  }
	/** spec/crew#auto-guard: the Auto agent changed files inside a zone it hired out. */
	| { kind: 'crew.zone.touched'; taskId: string; name: string; title: string; paths: string[] }
	/** spec/crew#auto-model: the question card; `resolved` by the person, or by the agent itself with `Any catalog model`. */
	| { kind: 'crew.model.requested'; request: AutoModelRequest }
	| {
			kind: 'crew.model.resolved';
			id: string;
			answer: AutoModelAnswer | null;
			by: 'person' | 'agent';
			role: string;
			part?: string;
			/** The agent's call was cancelled before anyone answered; the card closes unanswered. */
			cancelled?: true;
	  }
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
	/** spec/browser-and-simulator#sim-chat-row: the task's lease moved to `device` (its name), or the person started it past low memory. */
	| { kind: 'simulator.device'; device: string; metroPort: number | null; lowMemory: boolean }
	| { kind: 'host.stopped'; reason: string }
	/** spec/agents-and-providers#budget-reached: a provider's count reached the task's budget; the task pauses and asks. `tokens` and `estimated` — the count then. */
	| {
			kind: 'budget.reached';
			id: string;
			provider: import('./agent').AgentProvider;
			tokens: number;
			budget: number;
			estimated: boolean;
	  }
	/** spec/agents-and-providers#budget-reached: the person's answer; `budget` — the new one of a `raise`. */
	| {
			kind: 'budget.decided';
			id: string;
			decision: import('./task-tokens').BudgetDecision;
			budget?: number;
	  };
export type EventRecord = { schemaVersion: 1; seq: number; at: string; event: SessionEvent };
export type SessionCommand =
	| AgentCommand
	| { kind: 'recordPullRequest'; scopeId: string; pr: PRRef }
	/** spec/browser-and-simulator#sim-chat-row: main journals the task's device row; never sent by a window. */
	| { kind: 'recordDevice'; device: string; metroPort: number | null; lowMemory: boolean }
	| { kind: 'setScope'; update: ScopeUpdate }
	/** spec/projects-and-board#folders-mid-task: a folder from outside the root joins the task chosen, also while its agent runs. */
	| { kind: 'addScope'; choice: ScopeChoice }
	/** `returnMode`: the plan is approved with `allow_once`; the host sets this mode once the agent leaves the plan mode (spec/chat-turns-plans-and-questions#plan-approval). */
	| { kind: 'answerPermission'; id: string; optionId: string | null; returnMode?: string }
	| { kind: 'answerQuestion'; id: string; answer: QuestionAnswer | null }
	/** spec/tasks#agent-created-tasks: main after it created the proposed task, or the card's `Відхилити` with `null`. */
	| { kind: 'resolveTaskProposal'; id: string; task: TaskProposalResult }
	| { kind: 'decidePlan'; decision: CrewPlanDecision }
	/** spec/crew#auto-hire: the hire card's `Hire {n}` or `Do it yourself`. */
	| { kind: 'decideHire'; decision: AutoHireDecision }
	/** spec/crew#auto-model: `Use this model`, or null — keep the base role. */
	| { kind: 'answerModel'; id: string; answer: AutoModelAnswer | null }
	/** spec/crew#auto-dismiss: the person dismisses a worker of an Auto task from its row. */
	| { kind: 'dismissWorker'; taskId: string }
	/** spec/tasks#move-to-worktree: the person moves the task into a worktree; `cancelMove` drops a move that still waits for the turn. */
	| { kind: 'moveToWorktree' }
	| { kind: 'cancelMove' }
	/** spec/crew#auto-budget: the Auto agent's host tells a worker's host its part went over budget. */
	| {
			kind: 'overBudget';
			title: string;
			budget: AutoBudget;
			used: { minutes: number; tokens: number };
	  }
	| { kind: 'answerCrewQuestion'; id: string; answer: string }
	/** spec/reviews#start: main resolved the reviewers and the guidance; the host runs the rounds. */
	| {
			kind: 'startReview';
			reviewers: CrewSpecAgent[];
			who: TaskReviewWho;
			instructions: string;
			guidance: string;
			/** spec/reviews#start: `Since the last review`. */
			since?: 'start' | 'last';
			/** spec/reviews#points: absent — before the PR. */
			point?: ReviewPoint;
			startedBy?: TaskReviewStarter;
			reviewer?: ReviewerChoice;
			/** spec/reviews#request-tool: what the agent just finished. */
			reason?: string;
			/** spec/reviews#who: nobody can review (`reviewers` is empty); the review is recorded as `failed`. */
			failure?: string;
	  }
	| { kind: 'stopReview' }
	/** spec/smoke-run#limit: the person's `+5 min` and `Stop` on the deck row. */
	| { kind: 'extendSmoke'; id: string }
	| { kind: 'stopSmoke'; id: string }
	/** spec/reviews#loop: the person's `Fix {n}` or `Accept` on the open findings. */
	| { kind: 'decideReview'; decision: 'fix' | 'accept' }
	| { kind: 'dismissReviewProposal' }
	/** `crew`: spec/reviews#loop — the reviewers' batch of the task's own review, a service row instead of the person's message. */
	| { kind: 'submitReview'; text: string; review: ReviewBatch; crew?: CrewTurnMarker }
	| { kind: 'removeQueuedPrompt'; id: string }
	/** spec/composer-steering-queue-and-ghost#steering-hold: «Надіслати зараз» on a queued row — the host holds it for the running turn like a fresh Enter. */
	| { kind: 'steerQueuedPrompt'; id: string }
	/** spec/agents-and-providers#sign-in-recovery: start the failed turn again on a fresh adapter process; `auth` — only when it failed on sign-in (after a sign-in, sent to every host). */
	| { kind: 'retryTurn'; reason?: 'auth' }
	| { kind: 'resumePromptQueue' }
	| { kind: 'pausePromptQueue' }
	/** spec/agents-and-providers#task-budget: the budget of this task for one provider, from `Task usage`; null — no limit. */
	| { kind: 'setTokenBudget'; provider: import('./agent').AgentProvider; budget: number | null }
	/** spec/agents-and-providers#budget-reached: the answer to the budget question; `budget` — the value of `Raise to …`. */
	| {
			kind: 'decideBudget';
			id: string;
			decision: import('./task-tokens').BudgetDecision;
			budget?: number;
	  }
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
		case 'recordDevice':
			return (
				Object.keys(v).length === 4 &&
				typeof v.device === 'string' &&
				v.device.length > 0 &&
				v.device.length <= 200 &&
				(v.metroPort === null ||
					(Number.isSafeInteger(v.metroPort) &&
						Number(v.metroPort) > 0 &&
						Number(v.metroPort) <= 65_535)) &&
				typeof v.lowMemory === 'boolean'
			);
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
				isReviewBatch(v.review) &&
				(v.crew === undefined || isCrewTurnMarker(v.crew))
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
				(v.answersPlan === undefined || (v.answersPlan === true && v.crew === undefined)) &&
				(v.assignment === undefined || isCrewAssignmentId(v.assignment)) &&
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
		case 'decideHire':
			return isAutoHireDecision(v.decision);
		case 'answerModel':
			return isId(v.id) && (v.answer === null || isAutoModelAnswer(v.answer));
		case 'dismissWorker':
			return isId(v.taskId);
		case 'moveToWorktree':
		case 'cancelMove':
			return Object.keys(v).length === 1;
		case 'overBudget':
			return (
				text(v.title) &&
				v.title.length <= 200 &&
				isAutoBudget(v.budget) &&
				isRecord(v.used) &&
				Number.isFinite(v.used.minutes) &&
				Number.isFinite(v.used.tokens)
			);
		case 'startReview':
			return (
				Array.isArray(v.reviewers) &&
				(v.reviewers.length > 0 || (text(v.failure) && v.failure.length <= 2000)) &&
				v.reviewers.length <= 8 &&
				(v.failure === undefined || (text(v.failure) && v.failure.length <= 2000)) &&
				(v.reason === undefined || (text(v.reason) && v.reason.length <= 500)) &&
				v.reviewers.every(isCrewSpecAgent) &&
				isTaskReviewWho(v.who) &&
				text(v.instructions) &&
				v.instructions.length <= taskReviewInstructionsLimit &&
				text(v.guidance) &&
				v.guidance.length <= taskReviewGuidanceLimit &&
				(v.since === undefined || v.since === 'start' || v.since === 'last') &&
				(v.point === undefined || isReviewPoint(v.point)) &&
				(v.startedBy === undefined || ['person', 'agent', 'host'].includes(String(v.startedBy))) &&
				(v.reviewer === undefined || isReviewerChoice(v.reviewer))
			);
		case 'decideReview':
			return v.decision === 'fix' || v.decision === 'accept';
		case 'setTokenBudget':
			return (
				(v.provider === 'claude' || v.provider === 'codex') &&
				(v.budget === null || isTokenBudgetValue(v.budget))
			);
		case 'decideBudget':
			return (
				isId(v.id) &&
				budgetDecisions.includes(v.decision as BudgetDecision) &&
				(v.decision === 'raise' ? isTokenBudgetValue(v.budget) : v.budget === undefined)
			);
		case 'stopReview':
		case 'dismissReviewProposal':
			return true;
		case 'extendSmoke':
		case 'stopSmoke':
			return isId(v.id);
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
	/** spec/crew#auto-hire: the hire card waiting for the person; it survives a restart. */
	crewHire: AutoHire | null;
	/** spec/crew#auto-model: model questions waiting for the person. */
	crewModels: AutoModelRequest[];
	/** spec/agents-and-providers#budget-reached: the budget question that waits; a host stop does not answer it. */
	budget: BudgetQuestion | null;
};
export function pendingInputs(records: readonly EventRecord[]): PendingInputs {
	const permissions = new Map<string, PermissionRequest>();
	const questions = new Map<string, UserQuestion>();
	const crewQuestions = new Map<string, CrewQuestion>();
	const proposals = new Map<string, TaskProposal>();
	let crewPlan: CrewPlan | null = null,
		crewHire: AutoHire | null = null,
		budget = emptyBudgetJournal();
	const crewModels = new Map<string, AutoModelRequest>();
	for (const record of records) {
		const e = record.event;
		budget = reduceBudgetJournal(budget, record);
		if (e.kind === 'crew.hire.requested') crewHire = e.hire;
		if (e.kind === 'crew.hire.resolved' && crewHire?.id === e.id) crewHire = null;
		// spec/crew#auto-move: an approved hire that moves the task first no longer waits for the person.
		if (e.kind === 'workspace.move' && e.hireId === crewHire?.id) crewHire = null;
		if (e.kind === 'crew.model.requested') crewModels.set(e.request.id, e.request);
		if (e.kind === 'crew.model.resolved') crewModels.delete(e.id);
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
			crewModels.clear();
		}
	}
	return {
		permissions: [...permissions.values()],
		questions: [...questions.values()],
		crewPlan,
		crewQuestions: [...crewQuestions.values()],
		proposals: [...proposals.values()],
		crewHire,
		crewModels: [...crewModels.values()],
		budget: budget.pending,
	};
}
import {
	budgetDecisions,
	emptyBudgetJournal,
	isTokenBudgetValue,
	reduceBudgetJournal,
	type BudgetDecision,
	type BudgetQuestion,
} from './task-tokens';
import { isScopeUpdate, type ScopeUpdate } from './scope-controls';
import { isScopeChoice, type ScopeChoice } from './launch';
import { isTaskProposalResult, type TaskProposal, type TaskProposalResult } from './task-proposal';
import { isBackgroundId, isSubagentId } from './background';
import { isCrewSpecAgent, type CrewSpecAgent } from './crew';
import type {
	WorkspaceMoveEvent,
	WorktreeJoinedEvent,
	WorktreeRemovedEvent,
} from './workspace-move';
import {
	isReviewPoint,
	isReviewerChoice,
	isTaskReviewWho,
	taskReviewGuidanceLimit,
	taskReviewInstructionsLimit,
	type ReviewPoint,
	type ReviewerChoice,
	type TaskReviewStarter,
	type TaskReviewWho,
} from './task-review';
/** The card or row that waits for the person's answer keeps the task in `needs-you` (spec/tasks#agent-created-tasks adds the proposed task, spec/crew#workers the foreman's plan). */
/**
 * spec/crew#auto-hire, spec/crew#plan, spec/crew#attention: the task's status when a turn of its agent ends. A hire card or a split still
 * waits for the person though the agent's call is gone with the turn (a message sent into the turn moves the call to the background; Codex
 * ends its turn with the call open), and so do a worker's question, the budget question and a review's open findings. Permissions and agent
 * questions end with their turn and do not count here.
 */
export function statusAfterTurn(
	reason: string | undefined,
	inputs: PendingInputs,
	reviewWaits: boolean,
	/** spec/chat-turns-plans-and-questions#turn-footer: the turn ended because its plan went back — no interruption. */
	planReturned = false
): 'interrupted' | 'needs-you' | 'done' {
	if (reason === 'cancelled' && !planReturned) return 'interrupted';
	return inputs.crewQuestions.length > 0 ||
		inputs.budget !== null ||
		inputs.crewHire !== null ||
		inputs.crewPlan !== null ||
		reviewWaits
		? 'needs-you'
		: 'done';
}
/**
 * spec/crew#auto-hire, spec/crew#plan, spec/architecture-and-platform#host-lifecycle: the task's status when its host stopped under a running turn
 * (a stop, or a restart after the host exited). The turn is gone, but a hire card, a split, a worker's question, the budget question or a
 * review's open findings still wait for the person, so the task needs them; otherwise the turn was interrupted.
 */
export function statusAfterStop(
	inputs: PendingInputs,
	reviewWaits = false
): 'interrupted' | 'needs-you' {
	return statusAfterTurn(undefined, inputs, reviewWaits) === 'needs-you'
		? 'needs-you'
		: 'interrupted';
}
export function waitsForPerson(inputs: PendingInputs) {
	return (
		inputs.questions.length > 0 ||
		inputs.permissions.length > 0 ||
		inputs.proposals.length > 0 ||
		inputs.crewPlan !== null ||
		inputs.crewHire !== null ||
		inputs.crewModels.length > 0 ||
		inputs.budget !== null
	);
}
