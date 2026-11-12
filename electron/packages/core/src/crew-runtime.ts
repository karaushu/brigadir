import { isId, isRecord } from './workspace';
import {
	isCrewName,
	normalizeZonePath,
	findSpecAgent,
	specChildByName,
	zoneCovers,
	isBuiltinCrewName,
	isCrewSpecAgent,
	crewAgentsPerNodeLimit,
	type CrewChoices,
	type CrewSpec,
	type CrewSpecAgent,
	isCrewChoices,
} from './crew';
import { t, type Locale, type MessageKey } from './messages';
/** spec/crew#task-type/spec/crew#communication runtime records of a running crew: plans, workers, notes, questions and reports. Pure types and validators. */
export type CrewPlanPart = {
	id: string;
	title: string;
	agent: string;
	prompt: string;
	files: string[];
	scopes: string[];
};
/** `crew`: the agents the foreman proposes with the plan when it composes the crew itself (spec/crew#compose). */
export type CrewPlan = {
	id: string;
	parts: CrewPlanPart[];
	summary: string;
	crew?: CrewSpecAgent[];
};
/** `message` is English for the agent (rule 12); the other fields let the card say it in the interface language (spec/chat-turns-plans-and-questions#plan-row). */
export type CrewPlanDifference = {
	code:
		'unknown_agent' | 'duplicate_agent' | 'outside_zone' | 'reviewer_part' | 'idle_agent' | 'empty';
	partId: string | null;
	message: string;
	agent?: string;
	agents?: string[];
	otherPartId?: string;
	zone?: string[];
	outside?: string[];
};
/** `crew`: the person's edit of the proposed crew (spec/crew#compose); absent keeps the proposal. */
export type CrewPlanDecision = {
	id: string;
	approved: boolean;
	parts: CrewPlanPart[] | null;
	crew?: CrewSpecAgent[];
};
/**
 * spec/crew#parts: one task per crew member for the crew's whole life. `title` and `acceptedAt` belong to the current part (`part`, 1 when
 * absent); `acceptedTips` are the worker-branch tips the last acceptance squashed, by repo path relative to the project ('' — root).
 * `next` is a part waiting to start: `queued` for its slot, `merging` while the crew tree's merge into the worker branch waits for
 * the human; `previous` restores the accepted part when that merge is aborted.
 */
export type CrewNextPart = {
	prompt: string;
	state: 'queued' | 'merging';
	previous: { title: string; acceptedAt: string };
	/** While `merging`: the parent HEAD merged into each repo with a conflict. */ heads?: Record<
		string,
		string
	>;
};
export type CrewWorkerRecord = {
	taskId: string;
	nodeId: string;
	name: string;
	title: string;
	createdAt: string;
	planPartId: string | null;
	acceptedAt?: string;
	effectiveChoices?: CrewChoices;
	unavailableOptions?: string[];
	part?: number;
	acceptedTips?: Record<string, string>;
	next?: CrewNextPart;
};
export type CrewNote = {
	id: string;
	seq: number;
	authorTaskId: string;
	crewNodeId: string;
	author: string;
	createdAt: string;
	text: string;
	files?: string[];
};
export type CrewQuestionState = 'pending' | 'escalated' | 'answered' | 'cancelled';
export type CrewQuestion = {
	id: string;
	workerTaskId: string;
	parentTaskId: string;
	callId: string;
	agent: string;
	question: string;
	options: string[];
	createdAt: string;
	escalateAt: string;
	state: CrewQuestionState;
	answer?: string;
	answeredBy?: 'foreman' | 'human';
};
export type CrewReportSummary = {
	taskId: string;
	nodeId: string;
	name: string;
	title: string;
	additions: number;
	deletions: number;
	files: number;
	outside: number;
	verdict: 'approved' | 'disputed' | 'pending' | null;
	round: number | null;
	newNotes: number;
};
/** Service row markers on a foreman's `turn.started` (spec/crew-templates-and-editor#after-launch activity rows). */
export type CrewTurnMarker =
	| { kind: 'report'; report: CrewReportSummary }
	| { kind: 'question'; questionId: string; agent: string }
	| { kind: 'plan-decision'; planId: string; approved: boolean }
	| { kind: 'branch-report'; report: CrewReportSummary }
	| { kind: 'part-dropped'; taskId: string; agent: string; part: number }
	/** spec/diff-and-review#agent-review-rounds: the reviewers' comments of a round go to the task's own agent. */
	| { kind: 'review-comments'; round: number; comments: number };
export const crewPlanPartLimit = 64,
	crewPlanPromptLimit = 100_000,
	crewNoteLimit = 8 * 1024,
	crewNotePageLimit = 100,
	crewQuestionLimit = 100_000,
	crewQuestionEscalationMs = 5 * 60_000;
const text = (value: unknown, limit: number): value is string =>
	typeof value === 'string' && value.length <= limit && !value.includes('\0');
const isPaths = (value: unknown): value is string[] =>
	Array.isArray(value) &&
	value.length <= 1024 &&
	value.every((entry) => typeof entry === 'string' && normalizeZonePath(entry) !== null);
export function isCrewPlanPart(value: unknown): value is CrewPlanPart {
	return (
		isRecord(value) &&
		isId(value.id) &&
		isCrewName(value.title) &&
		isCrewName(value.agent) &&
		text(value.prompt, crewPlanPromptLimit) &&
		(value.prompt as string).trim().length > 0 &&
		isPaths(value.files) &&
		Array.isArray(value.scopes) &&
		value.scopes.length <= 512 &&
		value.scopes.every((scope) => typeof scope === 'string' && scope.length <= 4096) &&
		Object.keys(value).length === 6
	);
}
const isPlanCrew = (value: unknown): value is CrewSpecAgent[] =>
	Array.isArray(value) &&
	value.length > 0 &&
	value.length <= crewAgentsPerNodeLimit &&
	value.every(isCrewSpecAgent);
export function isCrewPlan(value: unknown): value is CrewPlan {
	return (
		isRecord(value) &&
		isId(value.id) &&
		Array.isArray(value.parts) &&
		value.parts.length > 0 &&
		value.parts.length <= crewPlanPartLimit &&
		value.parts.every(isCrewPlanPart) &&
		new Set(value.parts.map((part) => (part as CrewPlanPart).id)).size === value.parts.length &&
		text(value.summary, 20_000) &&
		(value.crew === undefined || isPlanCrew(value.crew)) &&
		Object.keys(value).length === (value.crew === undefined ? 3 : 4)
	);
}
export function isCrewPlanDecision(value: unknown): value is CrewPlanDecision {
	return (
		isRecord(value) &&
		isId(value.id) &&
		typeof value.approved === 'boolean' &&
		(value.parts === null ||
			(Array.isArray(value.parts) &&
				value.parts.length <= crewPlanPartLimit &&
				value.parts.every(isCrewPlanPart))) &&
		(value.crew === undefined || isPlanCrew(value.crew)) &&
		Object.keys(value).length === (value.crew === undefined ? 3 : 4)
	);
}
const isSha = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{40,64}$/.test(value);
function isCrewNextPart(value: unknown): value is CrewNextPart {
	return (
		isRecord(value) &&
		text(value.prompt, 200_000) &&
		(value.prompt as string).trim().length > 0 &&
		(value.state === 'queued' || value.state === 'merging') &&
		isRecord(value.previous) &&
		text(value.previous.title, 200) &&
		typeof value.previous.acceptedAt === 'string' &&
		(value.heads === undefined ||
			(isRecord(value.heads) &&
				Object.keys(value.heads).length <= 256 &&
				Object.values(value.heads).every(isSha)))
	);
}
export function isCrewWorkerRecord(value: unknown): value is CrewWorkerRecord {
	return (
		isRecord(value) &&
		(value.part === undefined || (Number.isSafeInteger(value.part) && Number(value.part) >= 1)) &&
		(value.acceptedTips === undefined ||
			(isRecord(value.acceptedTips) &&
				Object.keys(value.acceptedTips).length <= 256 &&
				Object.entries(value.acceptedTips).every(
					([path, tip]) => path.length <= 4096 && isSha(tip)
				))) &&
		(value.next === undefined || isCrewNextPart(value.next)) &&
		isId(value.taskId) &&
		isId(value.nodeId) &&
		isCrewName(value.name) &&
		text(value.title, 200) &&
		typeof value.createdAt === 'string' &&
		(value.planPartId === null || isId(value.planPartId)) &&
		(value.acceptedAt === undefined || typeof value.acceptedAt === 'string') &&
		(value.effectiveChoices === undefined || isCrewChoices(value.effectiveChoices)) &&
		(value.unavailableOptions === undefined ||
			(Array.isArray(value.unavailableOptions) &&
				value.unavailableOptions.every((id) => typeof id === 'string' && id.length <= 200)))
	);
}
export function isCrewNote(value: unknown): value is CrewNote {
	return (
		isRecord(value) &&
		isId(value.id) &&
		Number.isSafeInteger(value.seq) &&
		Number(value.seq) > 0 &&
		isId(value.authorTaskId) &&
		isId(value.crewNodeId) &&
		isCrewName(value.author) &&
		typeof value.createdAt === 'string' &&
		text(value.text, crewNoteLimit) &&
		(value.text as string).trim().length > 0 &&
		(value.files === undefined || (isPaths(value.files) && (value.files as string[]).length <= 64))
	);
}
export function isCrewQuestion(value: unknown): value is CrewQuestion {
	return (
		isRecord(value) &&
		isId(value.id) &&
		isId(value.workerTaskId) &&
		isId(value.parentTaskId) &&
		typeof value.callId === 'string' &&
		value.callId.length > 0 &&
		value.callId.length <= 200 &&
		isCrewName(value.agent) &&
		text(value.question, crewQuestionLimit) &&
		(value.question as string).trim().length > 0 &&
		Array.isArray(value.options) &&
		value.options.length <= 100 &&
		value.options.every((option) => typeof option === 'string' && option.length <= 1000) &&
		typeof value.createdAt === 'string' &&
		typeof value.escalateAt === 'string' &&
		['pending', 'escalated', 'answered', 'cancelled'].includes(String(value.state)) &&
		(value.answer === undefined || text(value.answer, 100_000)) &&
		(value.answeredBy === undefined ||
			value.answeredBy === 'foreman' ||
			value.answeredBy === 'human')
	);
}
export function isCrewReportSummary(value: unknown): value is CrewReportSummary {
	return (
		isRecord(value) &&
		isId(value.taskId) &&
		isId(value.nodeId) &&
		isCrewName(value.name) &&
		text(value.title, 200) &&
		[value.additions, value.deletions, value.files, value.outside, value.newNotes].every(
			(count) => Number.isSafeInteger(count) && Number(count) >= 0
		) &&
		(value.verdict === null ||
			['approved', 'disputed', 'pending'].includes(String(value.verdict))) &&
		(value.round === null || (Number.isSafeInteger(value.round) && Number(value.round) > 0))
	);
}
export function isCrewTurnMarker(value: unknown): value is CrewTurnMarker {
	if (!isRecord(value)) return false;
	switch (value.kind) {
		case 'report':
		case 'branch-report':
			return isCrewReportSummary(value.report);
		case 'question':
			return isId(value.questionId) && isCrewName(value.agent);
		case 'plan-decision':
			return isId(value.planId) && typeof value.approved === 'boolean';
		case 'review-comments':
			return (
				Number.isSafeInteger(value.round) &&
				Number(value.round) >= 1 &&
				Number.isSafeInteger(value.comments) &&
				Number(value.comments) >= 0
			);
		case 'part-dropped':
			return (
				isId(value.taskId) &&
				isCrewName(value.agent) &&
				Number.isSafeInteger(value.part) &&
				Number(value.part) >= 1
			);
		default:
			return false;
	}
}
/** Pending plan card: the latest request without a matching decision (spec/crew#task-type rule 2). */
export function pendingCrewPlan(
	records: readonly { event: { kind: string; plan?: CrewPlan; id?: string } }[]
): CrewPlan | null {
	let plan: CrewPlan | null = null;
	for (const { event } of records) {
		if (event.kind === 'crew.plan.requested' && event.plan) plan = event.plan;
		if (event.kind === 'crew.plan.resolved' && plan && event.id === plan.id) plan = null;
		if (event.kind === 'host.stopped') plan = null;
	}
	return plan;
}

/** spec/crew-templates-and-editor#after-launch differences between plan and crew: shown on the plan card, never accepted silently. */
export function planDifferences(
	spec: CrewSpec,
	nodeId: string,
	parts: readonly CrewPlanPart[]
): CrewPlanDifference[] {
	const node = findSpecAgent(spec.root, nodeId);
	if (!node) throw new Error('Unknown crew node');
	const differences: CrewPlanDifference[] = [],
		used = new Map<string, CrewPlanPart>();
	if (!parts.length)
		differences.push({ code: 'empty', partId: null, message: 'The plan has no parts.' });
	for (const part of parts) {
		const agent = specChildByName(node, part.agent);
		if (!agent) {
			const agents = node.agents.map((item) => item.name);
			differences.push({
				code: 'unknown_agent',
				partId: part.id,
				message: `No agent named ${part.agent}. Your agents: ${agents.join(', ')}.`,
				agent: part.agent,
				agents,
			});
			continue;
		}
		if (agent.role === 'reviewer')
			differences.push({
				code: 'reviewer_part',
				partId: part.id,
				message: `${agent.name} is a reviewer and takes no part of the code.`,
				agent: agent.name,
			});
		const other = used.get(agent.id);
		if (other)
			differences.push({
				code: 'duplicate_agent',
				partId: part.id,
				message: `${agent.name} already has part ${other.title}. One agent works on one part at a time.`,
				agent: agent.name,
				otherPartId: other.id,
			});
		else used.set(agent.id, part);
		const outside = part.files.filter((file) => !zoneCovers(agent.zone, file));
		if (outside.length)
			differences.push({
				code: 'outside_zone',
				partId: part.id,
				message: `${agent.name} owns ${agent.zone.join(', ')}; outside: ${outside.slice(0, 5).join(', ')}${outside.length > 5 ? '…' : ''}.`,
				agent: agent.name,
				zone: [...agent.zone],
				outside,
			});
	}
	for (const agent of node.agents)
		if (agent.role !== 'reviewer' && !used.has(agent.id))
			differences.push({
				code: 'idle_agent',
				partId: null,
				message: `${agent.name} has no part.`,
				agent: agent.name,
			});
	return differences;
}
/** spec/chat-turns-plans-and-questions#plan-row: one difference in the interface language; `parts` numbers the other part of a duplicate. */
export function planDifferenceText(
	locale: Locale,
	difference: CrewPlanDifference,
	parts: readonly CrewPlanPart[]
): string {
	const name = (value: string) =>
			isBuiltinCrewName(value) ? t(locale, value as MessageKey) : value,
		agent = name(difference.agent ?? ''),
		list = (items: readonly string[] | undefined, limit = 5) =>
			(items ?? []).slice(0, limit).join(', ') + ((items?.length ?? 0) > limit ? '…' : '');
	const fill = (key: MessageKey, values: Record<string, string>) =>
		Object.entries(values).reduce((text, [k, v]) => text.replaceAll(`{${k}}`, v), t(locale, key));
	switch (difference.code) {
		case 'empty':
			return t(locale, 'The plan has no parts.');
		case 'unknown_agent':
			return fill('No agent named {agent}. Crew agents: {agents}.', {
				agent,
				agents: (difference.agents ?? []).map(name).join(', '),
			});
		case 'reviewer_part':
			return fill('{agent} is a reviewer and takes no part of the code.', { agent });
		case 'duplicate_agent':
			return fill('{agent} already has part {n}. One agent works on one part at a time.', {
				agent,
				n: String(parts.findIndex((part) => part.id === difference.otherPartId) + 1),
			});
		case 'outside_zone':
			return fill('{agent} owns {zone}; outside the zone: {files}.', {
				agent,
				zone: list(difference.zone),
				files: list(difference.outside),
			});
		case 'idle_agent':
			return fill('{agent} has no part.', { agent });
	}
}
/** Differences that block the card's Start: unknown agents, reviewers with code and files outside a zone. Idle agents are shown, not blocking. */
export function planBlocked(differences: readonly CrewPlanDifference[]): boolean {
	return differences.some((item) => item.code !== 'idle_agent');
}

/** spec/crew#reviewer one check of one report: immutable snapshot, one verdict per reviewer, two rounds. */
export type ReviewVerdict = {
	reviewerNodeId: string;
	reviewer: string;
	approved: boolean;
	comments: number;
	at: string;
};
export type ReviewRunState =
	'reviewing' | 'comments' | 'approved' | 'disputed' | 'superseded' | 'cancelled';
export type ReviewRun = {
	reviewId: string;
	taskId: string;
	nodeId: string;
	name: string;
	title: string;
	reportSeq: number;
	reportHash: string;
	scopeSnapshots: { scopeId: string; base: string; result: string }[];
	round: number;
	reviewerNodeIds: string[];
	dispatched: string[];
	verdicts: ReviewVerdict[];
	state: ReviewRunState;
	createdAt: string;
};
export function isReviewRun(value: unknown): value is ReviewRun {
	return (
		isRecord(value) &&
		isId(value.reviewId) &&
		isId(value.taskId) &&
		isId(value.nodeId) &&
		isCrewName(value.name) &&
		typeof value.title === 'string' &&
		Number.isSafeInteger(value.reportSeq) &&
		typeof value.reportHash === 'string' &&
		Array.isArray(value.scopeSnapshots) &&
		value.scopeSnapshots.every(
			(item) =>
				isRecord(item) &&
				typeof item.scopeId === 'string' &&
				typeof item.base === 'string' &&
				typeof item.result === 'string'
		) &&
		Number.isSafeInteger(value.round) &&
		Number(value.round) >= 1 &&
		Array.isArray(value.reviewerNodeIds) &&
		value.reviewerNodeIds.every(isId) &&
		Array.isArray(value.dispatched) &&
		value.dispatched.every(isId) &&
		Array.isArray(value.verdicts) &&
		value.verdicts.every(
			(item) =>
				isRecord(item) &&
				isId(item.reviewerNodeId) &&
				isCrewName(item.reviewer) &&
				typeof item.approved === 'boolean' &&
				Number.isSafeInteger(item.comments) &&
				typeof item.at === 'string'
		) &&
		['reviewing', 'comments', 'approved', 'disputed', 'superseded', 'cancelled'].includes(
			String(value.state)
		) &&
		typeof value.createdAt === 'string'
	);
}
export const crewReviewRounds = 2;
