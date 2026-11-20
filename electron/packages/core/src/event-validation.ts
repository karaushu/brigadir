import { budgetDecisions, isTokenBudgetValue, type BudgetDecision } from './task-tokens';
import { isRateReset } from './rate-limit';
import { isQuotaReading } from './quota';
import { isPRRef } from './forge';
import { isQueuedPrompt } from './prompt-queue';
import { isPromptAttachment, isAttachmentId } from './attachments';
import { isReviewBatch } from './review';
import { isRecord } from './workspace';
import { isQuestionAnswer, isUserQuestion, type SessionEvent } from './session';
import {
	isCrewNote,
	isCrewPlan,
	isCrewPlanPart,
	isCrewQuestion,
	isCrewReportSummary,
	isCrewTurnMarker,
	isCrewAssignmentKind,
	crewDismissReasons,
	type CrewDismissReason,
} from './crew-runtime';
import { isCrewSpecAgent } from './crew';
import { isId } from './workspace';
import {
	isAutoBudget,
	isAutoHire,
	isAutoHirePart,
	isAutoHired,
	isAutoModelAnswer,
	isAutoModelRequest,
} from './auto';
import { isTaskProposal, isTaskProposalResult } from './task-proposal';
import {
	isWorkspaceMoveFields,
	isWorktreeJoinedFields,
	isWorktreeRemovedFields,
} from './workspace-move';
import { isReviewPoint, isTaskReviewWho } from './task-review';
import { isDesignNode, isDesignReviewState, isDesignVerdict } from './design-review';
import { isTaskClass } from './task-class';
import { isSmokeStep, isSmokeStepList, smokeLimits } from './smoke';
const starter = (v: unknown) => v === 'person' || v === 'agent' || v === 'host';
import { isBackgroundId, isBackgroundPath } from './background';
type Check = (v: unknown) => boolean;
const text: Check = (v) => typeof v === 'string';
const number: Check = (v) => typeof v === 'number' && Number.isFinite(v);
const tokens: Check = (v) => Number.isSafeInteger(v) && Number(v) >= 0;
const bool: Check = (v) => typeof v === 'boolean';
const nil =
	(check: Check): Check =>
	(v) =>
		v === null || check(v);
const array =
	(check: Check): Check =>
	(v) =>
		Array.isArray(v) && v.every(check);
const object =
	(fields: Record<string, Check>, optional: Record<string, Check> = {}): Check =>
	(v) =>
		isRecord(v) &&
		Object.entries(fields).every(([key, check]) => check(v[key])) &&
		Object.entries(optional).every(([key, check]) => v[key] === undefined || check(v[key]));
const content: Check = (v) => {
	if (!isRecord(v)) return false;
	switch (v.kind) {
		case 'text':
			return text(v.text);
		case 'image':
		case 'audio':
			return text(v.mimeType) && text(v.data);
		case 'resource':
			return text(v.uri) && nil(text)(v.name) && nil(text)(v.text);
		case 'unsupported':
			return text(v.format);
		case 'diff':
			return text(v.path) && nil(text)(v.before) && text(v.after);
		case 'terminal':
			return text(v.id);
		default:
			return false;
	}
};
const tool = object(
	{ id: text },
	{
		name: text,
		title: text,
		category: text,
		status: text,
		input: text,
		output: text,
		exitCode: number,
		content: array(content),
		locations: array(object({ path: text, line: nil(number) })),
		parentId: text,
	}
);
const option: Check = (v) =>
	object({ id: text, name: text, description: nil(text), category: nil(text) })(v) &&
	isRecord(v) &&
	(v.kind === 'boolean'
		? bool(v.value)
		: v.kind === 'select' &&
			text(v.value) &&
			array(object({ value: text, name: text, description: nil(text), group: nil(text) }))(
				v.choices
			));
const permission = object({
	id: text,
	tool,
	options: array(object({ id: text, name: text, kind: text })),
});
const checks: Record<string, Check> = {
	'prompt.queued': object({ prompt: isQueuedPrompt }, { before: isAttachmentId }),
	'prompt.steered': object({ prompt: isQueuedPrompt }),
	'prompt.held': object({ prompt: isQueuedPrompt }),
	'prompt.removed': object({ id: isAttachmentId }),
	'queue.resumed': object({}),
	'queue.paused': object({}),
	'file.saved': object({ path: text, before: nil(number), after: nil(number), version: text }),
	'quick-ask.changed': object({
		question: (v) => typeof v === 'string' && v.length <= 200,
		files: (v) =>
			Array.isArray(v) &&
			v.length > 0 &&
			v.length <= 128 &&
			v.every((path) => typeof path === 'string' && path.length > 0 && path.length <= 4096),
		before: number,
		after: number,
	}),
	'pull-request.changed': object({
		scopeId: (v) => typeof v === 'string' && /^[a-f0-9]{16}$/.test(v),
		pr: isPRRef,
	}),
	'simulator.device': object({
		device: (v) => typeof v === 'string' && v.length > 0 && v.length <= 200,
		metroPort: nil((v) => Number.isSafeInteger(v) && Number(v) > 0 && Number(v) <= 65_535),
		lowMemory: bool,
	}),
	'scopes.changed': object({}),
	'scope.violation': object({
		scopeId: (v) => typeof v === 'string' && /^[a-f0-9]{16}$/.test(v),
		name: (v) => typeof v === 'string' && v.length <= 4096,
		paths: (v) =>
			Array.isArray(v) &&
			v.length > 0 &&
			v.length <= 128 &&
			v.every((path) => typeof path === 'string' && path.length <= 4096),
		checkpoint: (v) => Number.isSafeInteger(v) && Number(v) >= 0,
	}),
	'checkpoint.created': object({ checkpoint: number }),
	'snapshot.failed': object({ message: text }),
	'session.started': object(
		{
			sessionId: text,
			modes: array(object({ id: text, name: text, description: nil(text) })),
			modeId: nil(text),
			options: array(option),
		},
		{ steering: bool }
	),
	'message.delta': object(
		{
			role: (v) => ['user', 'assistant', 'thought'].includes(String(v)),
			messageId: nil(text),
			content,
		},
		{ subagentId: text, parentId: text }
	),
	'tool.changed': object({ patch: tool }, { subagentId: text }),
	'subagent.started': object({ id: text, parentId: nil(text), name: text, prompt: nil(text) }),
	'subagent.changed': object(
		{ id: text },
		{
			state: (v) => ['running', 'completed', 'failed', 'cancelled'].includes(String(v)),
			prompt: text,
			toolId: text,
			type: text,
			model: text,
			tokens: number,
			durationMs: number,
		}
	),
	'background.started': object({
		id: isBackgroundId,
		toolId: nil(text),
		name: (v) => typeof v === 'string' && v.length <= 4096,
	}),
	'background.changed': object(
		{ id: isBackgroundId },
		{
			state: (v) => ['completed', 'failed', 'stopped'].includes(String(v)),
			reason: (v) => ['person', 'closed', 'restarted'].includes(String(v)),
			outputPath: isBackgroundPath,
		}
	),
	'plan.changed': object({ entries: array(object({ text, priority: text, status: text })) }),
	'plan.document': object({
		planId: text,
		text: (v) => typeof v === 'string' && v.length <= 1_000_000,
	}),
	'plan.removed': object({ planId: text }),
	'options.changed': object({ options: array(option) }),
	'mode.changed': object({ modeId: text }),
	'commands.changed': object({
		commands: array(object({ name: text, description: text, inputHint: nil(text) })),
	}),
	'rate-limit.expired': object({
		window: nil(text),
		resetsAt: (v) => typeof v === 'number' && isRateReset(v),
	}),
	'quota.observed': object({
		provider: (v) => v === 'claude' || v === 'codex',
		windows: (v) => Array.isArray(v) && v.length <= 16 && v.every(isQuotaReading),
		complete: bool,
	}),
	'rate-limit.changed': object({
		status: (v) => ['allowed', 'allowed_warning', 'rejected'].includes(String(v)),
		window: nil(text),
		resetsAt: isRateReset,
	}),
	'usage.changed': object({
		used: number,
		capacity: number,
		cost: nil(object({ amount: number, currency: text })),
	}),
	'context.compacted': object({ before: nil(tokens), after: nil(tokens) }),
	'turn.usage': object(
		{ input: tokens, output: tokens, cacheRead: tokens, cacheWrite: tokens },
		{ main: object({ input: tokens, output: tokens, cacheRead: tokens, cacheWrite: tokens }) }
	),
	'session.info': object({}, { title: text, updatedAt: text }),
	'permission.requested': object({ request: permission }),
	'permission.resolved': object({ id: text, optionId: nil(text) }, { returnMode: text }),
	'question.requested': object({ question: isUserQuestion }),
	'question.resolved': object({ id: text, answer: nil(isQuestionAnswer) }),
	'task.proposal.requested': object({ proposal: isTaskProposal }),
	'task.proposal.resolved': object({ id: text, task: isTaskProposalResult }),
	'turn.started': object(
		{ text },
		{
			queuedPromptId: isAttachmentId,
			review: isReviewBatch,
			attachments: array(isPromptAttachment),
			attachmentBatchId: isAttachmentId,
			crew: isCrewTurnMarker,
			origin: (v) => v === 'agent',
		}
	),
	'crew.plan.requested': object({ plan: isCrewPlan }),
	'crew.plan.resolved': object(
		{ id: isId, approved: bool, parts: nil(array(isCrewPlanPart)) },
		{ crew: array(isCrewSpecAgent) }
	),
	'crew.worker.created': object({ taskId: isId, nodeId: isId, name: text, title: text }),
	'crew.part.started': object({
		taskId: isId,
		nodeId: isId,
		name: text,
		title: text,
		part: number,
	}),
	'crew.part.dropped': object({
		taskId: isId,
		nodeId: isId,
		name: text,
		title: text,
		part: number,
	}),
	'crew.assignment.restored': object({
		compactedSeq: number,
		assignment: (v) => Array.isArray(v) && v.length <= 3 && v.every(isCrewAssignmentKind),
	}),
	'crew.report': object({ report: isCrewReportSummary }),
	'crew.note': object({ note: isCrewNote }),
	'crew.question.requested': object({ question: isCrewQuestion }),
	'crew.question.escalated': object({ id: isId }),
	'crew.question.resolved': object({
		id: isId,
		answer: nil(text),
		answeredBy: nil((v) => v === 'foreman' || v === 'human'),
	}),
	'crew.review': object({
		reviewId: isId,
		taskId: isId,
		name: text,
		reviewer: text,
		round: number,
		approved: bool,
		comments: number,
		state: (v) => ['reviewing', 'comments', 'approved', 'disputed'].includes(String(v)),
	}),
	'review.proposed': object({ summary: text }),
	'review.dismissed': object({}),
	'review.replied': object({ commentId: text }),
	'review.started': object({ id: isId, reviewers: array(text), who: isTaskReviewWho }),
	'review.finished': object({
		id: isId,
		state: (v) => ['approved', 'disputed', 'outdated', 'stopped'].includes(String(v)),
	}),
	'task-review.started': object(
		{ id: isId, point: isReviewPoint, startedBy: starter, reviewers: array(text) },
		{
			reason: text,
			threshold: object({ files: number, lines: number }),
			hired: (v) => v === true,
		}
	),
	'task.class': object(
		{ class: isTaskClass, reason: text, by: (v) => v === 'agent' || v === 'host' },
		{
			previous: isTaskClass,
			cause: (v) => v === 'threshold' || v === 'hire',
			files: number,
			lines: number,
		}
	),
	'task-review.findings': object(
		{
			id: isId,
			point: isReviewPoint,
			findings: number,
			reviewers: array(text),
		},
		{ gaps: number }
	),
	'task-review.answered': object({
		id: isId,
		point: isReviewPoint,
		fixed: number,
		answered: number,
	}),
	'task-review.verified': object({
		id: isId,
		point: isReviewPoint,
		closed: number,
		open: number,
		introduced: number,
	}),
	'task-review.decided': object({
		id: isId,
		point: isReviewPoint,
		decision: (v) => v === 'fix' || v === 'accept',
		findings: number,
	}),
	'task-review.finished': object(
		{
			id: isId,
			point: isReviewPoint,
			state: (v) => ['passed', 'accepted', 'stopped', 'failed', 'outdated'].includes(String(v)),
		},
		{ failure: text, approval: (v) => v === true, open: number }
	),
	'smoke.started': object({ id: isId, steps: isSmokeStepList, limitMs: tokens }),
	'smoke.extended': object({ id: isId, limitMs: tokens, by: (v) => v === 'person' }),
	'smoke.stopped': object({ id: isId, cause: (v) => v === 'limit' || v === 'person' }),
	'smoke.reported': object(
		{
			id: isId,
			steps: (v) =>
				Array.isArray(v) &&
				v.length >= 1 &&
				v.length <= smokeLimits.reportSteps + smokeLimits.steps &&
				v.every(isSmokeStep),
			summary: (v) => typeof v === 'string' && v.length <= smokeLimits.summary,
			elapsedMs: number,
		},
		{ stopped: (v) => v === 'limit' || v === 'person' }
	),
	'smoke.dropped': object({
		id: isId,
		reason: (v) => v === 'cancelled' || v === 'no-report',
		elapsedMs: number,
	}),
	'task.ready': object(
		{
			id: isId,
			screen: (v) => typeof v === 'string' && v.length > 0 && v.length <= smokeLimits.screen,
			where: (v) => v === 'simulator' || v === 'browser',
		},
		{
			device: (v) => typeof v === 'string' && v.length <= 200,
			tab: (v) => typeof v === 'string' && v.length <= 32,
			url: (v) => typeof v === 'string' && v.length <= 4096,
		}
	),
	'source.saved': object({ id: isId, title: text, chars: number }, { url: text }),
	'design.reviewed': object(
		{
			id: isId,
			screen: text,
			state: isDesignReviewState,
			verdict: isDesignVerdict,
			nodes: (v) => Array.isArray(v) && v.length >= 1 && v.every(isDesignNode),
		},
		{ reviewId: isId }
	),
	'crew.accepted': object({ taskId: isId, nodeId: isId, name: text, conflicts: array(text) }),
	'crew.worker.stopped': object({ taskId: isId, nodeId: isId, name: text, reason: text }),
	'crew.hire.requested': object({ hire: isAutoHire }),
	'crew.hire.resolved': object(
		{
			id: isId,
			approved: bool,
			parts: nil(array(isAutoHirePart)),
			hired: array(isAutoHired),
		},
		{ reason: (v) => v === 'no-worktree' }
	),
	'workspace.move': isWorkspaceMoveFields,
	'worktree.joined': isWorktreeJoinedFields,
	'worktree.removed': isWorktreeRemovedFields,
	'crew.worker.dismissed': object({
		taskId: isId,
		nodeId: isId,
		name: text,
		title: text,
		reason: (v) => crewDismissReasons.includes(v as CrewDismissReason),
	}),
	'crew.lead.committed': object({
		reason: (v) => v === 'hire' || v === 'accept',
		commits: array(object({ scope: text, sha: text })),
	}),
	'crew.budget.exceeded': object({
		taskId: isId,
		name: text,
		title: text,
		budget: isAutoBudget,
		used: object({ minutes: number, tokens: number }),
	}),
	'crew.zone.touched': object({ taskId: isId, name: text, title: text, paths: array(text) }),
	'crew.model.requested': object({ request: isAutoModelRequest }),
	'crew.model.resolved': object(
		{
			id: isId,
			answer: nil(isAutoModelAnswer),
			by: (v) => v === 'person' || v === 'agent',
			role: text,
		},
		{ part: text, cancelled: (v) => v === true }
	),
	// spec/agents-and-providers#budget-reached
	'budget.reached': object({
		id: isId,
		provider: (v) => v === 'claude' || v === 'codex',
		tokens,
		budget: isTokenBudgetValue,
		estimated: bool,
	}),
	'budget.decided': object(
		{ id: isId, decision: (v) => budgetDecisions.includes(v as BudgetDecision) },
		{ budget: isTokenBudgetValue }
	),
	'turn.completed': object({ reason: text }),
	'session.failed': object({ message: text }, { reason: (v) => v === 'auth' }),
	'host.stopped': object({ reason: text }),
	unhandled: object({ name: text }),
};
export function isSessionEvent(v: unknown): v is SessionEvent {
	return isRecord(v) && typeof v.kind === 'string' && Boolean(checks[v.kind]?.(v));
}
