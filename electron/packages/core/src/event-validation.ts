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
} from './crew-runtime';
import { isCrewSpecAgent } from './crew';
import { isId } from './workspace';
import { isTaskProposal, isTaskProposalResult } from './task-proposal';
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
	'turn.usage': object({ input: tokens, output: tokens, cacheRead: tokens, cacheWrite: tokens }),
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
	'crew.accepted': object({ taskId: isId, nodeId: isId, name: text, conflicts: array(text) }),
	'crew.worker.stopped': object({ taskId: isId, nodeId: isId, name: text, reason: text }),
	'turn.completed': object({ reason: text }),
	'session.failed': object({ message: text }, { reason: (v) => v === 'auth' }),
	'host.stopped': object({ reason: text }),
	unhandled: object({ name: text }),
};
export function isSessionEvent(v: unknown): v is SessionEvent {
	return isRecord(v) && typeof v.kind === 'string' && Boolean(checks[v.kind]?.(v));
}
