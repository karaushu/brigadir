import type { FileDiff, ChangeRange, ChangedFile } from './changes';
export type ToolDiffPreview = Pick<
	FileDiff,
	'lines' | 'tooLarge' | 'beforeText' | 'afterText' | 'beforeSyntax' | 'afterSyntax'
> & { path: string };
export type TurnChanges = { range: ChangeRange | null; files: ChangedFile[]; total: number };
import type { PromptAttachment } from './attachments';
import type { EventRecord } from './session';
import { planChatWords } from './plan-approval';
import type { SubagentState, ToolPatch } from './agent';
export type ActivityRow = { id: string } & (
	| {
			kind: 'message';
			role: 'user' | 'assistant' | 'thought';
			text: string;
			attachments?: PromptAttachment[];
			/** spec/chat#collapse-rules: a thought's first and last chunk; one chunk has no duration yet («thinking», never «thought · 0 s»). */ startedAt?: number;
			endedAt?: number;
			/** spec/composer-steering-queue-and-ghost#steering-hold: held by the host, the agent has not got it yet; `promptId` edits or removes it. */ waiting?: boolean;
			promptId?: string;
	  }
	| {
			kind: 'tool';
			startedAt: number;
			finishedAt: number | null;
			tool: ToolPatch;
			contentSeq?: number;
	  }
	/** spec/agents-and-providers#sign-in-recovery: `detail` — the agent's own text of a sign-in failure, folded out of the log into the card. */
	| { kind: 'event'; record: EventRecord; detail?: string }
	/** spec/chat#subagents: a subagent with its own session, on the place where it started; `rows` are its own text and calls. `type`, `model`,
	 *  `tokens` and `durationMs` are the adapter's, absent when it sent none. `finishedAt` without `state`: the turn ended first. */
	| {
			kind: 'subagent';
			subagentId: string;
			startedAt: number;
			finishedAt: number | null;
			name: string;
			prompt: string | null;
			state: SubagentState | null;
			type?: string;
			model?: string;
			tokens?: number;
			durationMs?: number;
			rows: ActivityRow[];
	  }
);
export function activityRows(records: EventRecord[]): ActivityRow[] {
	const rows: ActivityRow[] = [];
	const messages = new Map<string, ActivityRow & { kind: 'message' }>();
	const tools = new Map<string, ActivityRow & { kind: 'tool' }>();
	let activeTools: Extract<ActivityRow, { kind: 'tool' }>[] = [];
	const subagents = new Map<string, ActivityRow & { kind: 'subagent' }>(),
		owners = new Map<string, string>();
	let activeSubagents: (ActivityRow & { kind: 'subagent' })[] = [];
	const closeTools = (at: string) => {
		for (const row of activeTools) if (row.finishedAt === null) row.finishedAt = Date.parse(at);
		activeTools = [];
		for (const row of activeSubagents) if (row.finishedAt === null) row.finishedAt = Date.parse(at);
		activeSubagents = [];
	};
	let turn = 0;
	let plan: (ActivityRow & { kind: 'event' }) | undefined;
	const planDocuments = new Map<string, ActivityRow & { kind: 'event' }>();
	// spec/composer-steering-queue-and-ghost#steering: a steered prompt the agent declined (queued after all) or that opened a turn of its own shows once, where it ran.
	// spec/composer-steering-queue-and-ghost#steering-hold: a held or steered message keeps its row where it was sent, unless it later moved to the FIFO, opened a turn of its
	// own or was removed (the last such seq per id). A queued message sent now is held after its prompt.queued, so it shows.
	const left = new Map<string, number>(),
		held = new Set<string>(),
		sent = new Set<string>();
	for (const { seq, event } of records) {
		const id =
			event.kind === 'prompt.queued'
				? event.prompt.id
				: event.kind === 'turn.started'
					? event.queuedPromptId
					: event.kind === 'prompt.removed'
						? event.id
						: undefined;
		if (id) left.set(id, seq);
		if (event.kind === 'prompt.held') held.add(event.prompt.id);
		else if (event.kind === 'prompt.steered') sent.add(event.prompt.id);
	}
	const stays = (id: string, seq: number) => (left.get(id) ?? -1) < seq;
	for (const record of records) {
		const e = record.event;
		if (
			(e.kind === 'prompt.held' || (e.kind === 'prompt.steered' && !held.has(e.prompt.id))) &&
			e.prompt.command.kind === 'prompt' &&
			stays(e.prompt.id, record.seq)
		)
			rows.push({
				id: `user-${record.seq}`,
				kind: 'message',
				role: 'user',
				text: e.prompt.command.text,
				...(e.prompt.attachments.length ? { attachments: e.prompt.attachments } : {}),
				...(e.kind === 'prompt.held' && !sent.has(e.prompt.id)
					? { waiting: true, promptId: e.prompt.id }
					: {}),
			});
		if (e.kind === 'turn.started') {
			closeTools(record.at);
			turn = record.seq;
			plan = undefined;
			if (e.crew) rows.push({ id: `user-${record.seq}`, kind: 'event', record });
			else if (e.origin !== 'agent')
				rows.push({
					id: `user-${record.seq}`,
					kind: 'message',
					role: 'user',
					// spec/chat-turns-plans-and-questions#plan-chat: the person's row shows their own words, not the app's wrapper.
					text: planChatWords(e.text) ?? e.text,
					...(e.attachments ? { attachments: e.attachments } : {}),
				});
		}
		if (e.kind === 'subagent.started') {
			const parent = e.parentId ? subagents.get(e.parentId) : undefined;
			if (!subagents.has(e.id)) {
				const row: ActivityRow & { kind: 'subagent' } = {
					id: `subagent/${e.id}`,
					kind: 'subagent',
					subagentId: e.id,
					startedAt: Date.parse(record.at),
					finishedAt: null,
					name: e.name,
					prompt: e.prompt,
					state: null,
					rows: [],
				};
				subagents.set(e.id, row);
				activeSubagents.push(row);
				(parent?.rows ?? rows).push(row);
			}
		}
		if (e.kind === 'subagent.changed') {
			const row = subagents.get(e.id);
			if (row) {
				if (e.state) {
					row.state = e.state;
					row.finishedAt ??= Date.parse(record.at);
				}
				if (e.type) row.type = e.type;
				if (e.model) row.model = e.model;
				if (e.tokens !== undefined) row.tokens = e.tokens;
				if (e.durationMs !== undefined) row.durationMs = e.durationMs;
			}
		}
		// spec/chat#subagents: a subagent's own text and calls go into its block, in the order they came.
		const sink =
			(e.kind === 'message.delta' || e.kind === 'tool.changed') && e.subagentId
				? (subagents.get(e.subagentId)?.rows ?? rows)
				: rows;
		if (e.kind === 'message.delta') {
			if (e.role === 'user') continue; // ACP may echo history; the host's turn.started owns the user row.
			const content =
				e.content.kind === 'text'
					? e.content.text
					: e.content.kind === 'resource'
						? (e.content.text ?? e.content.uri)
						: `[${e.content.kind}]`;
			const previous = sink.at(-1),
				owner = e.subagentId
					? `subagent-${e.subagentId}/`
					: e.parentId
						? `parent-${e.parentId}/`
						: '';
			// A subagent's text without its own session (`parentId`) never joins the main agent's message.
			const id = e.messageId
				? `${turn}/${owner}${e.role}/${e.messageId}`
				: previous?.kind === 'message' &&
					  previous.role === e.role &&
					  (owners.get(previous.id) ?? '') === owner
					? previous.id
					: `message-${owner}${record.seq}`;
			let row = messages.get(id);
			if (!row) {
				row = {
					id,
					kind: 'message',
					role: e.role,
					text: '',
					...(e.role === 'thought' ? { startedAt: Date.parse(record.at) } : {}),
				};
				messages.set(id, row);
				owners.set(id, owner);
				sink.push(row);
			} else if (e.role === 'thought') row.endedAt = Date.parse(record.at);
			row.text += content;
		}
		if (e.kind === 'tool.changed') {
			const id = `${turn}/tool/${e.patch.id}`;
			let row = tools.get(id);
			if (!row) {
				row = {
					id,
					kind: 'tool',
					startedAt: Date.parse(record.at),
					finishedAt: null,
					tool: { id: e.patch.id },
				};
				activeTools.push(row);
				tools.set(id, row);
				sink.push(row);
			}
			row.tool = { ...row.tool, ...e.patch };
			if (['completed', 'failed'].includes(row.tool.status ?? '') && row.finishedAt === null)
				row.finishedAt = Date.parse(record.at);
			if (e.patch.content) row.contentSeq = record.seq;
		}
		if (['turn.completed', 'session.failed', 'host.stopped'].includes(e.kind))
			closeTools(record.at);
		if (e.kind === 'plan.changed') {
			if (plan) plan.record = record;
			else {
				plan = { id: `event-${record.seq}`, kind: 'event', record };
				rows.push(plan);
			}
		}
		// spec/chat-turns-plans-and-questions#plan-approval: one row per plan document, on the place of its first update, replaced whole.
		if (e.kind === 'plan.document') {
			const row = planDocuments.get(e.planId);
			if (row) row.record = record;
			else {
				const created = { id: `plan-${record.seq}`, kind: 'event' as const, record };
				planDocuments.set(e.planId, created);
				rows.push(created);
			}
		}
		if (
			[
				'question.requested',
				'permission.requested',
				'question.resolved',
				'permission.resolved',
				'task.proposal.requested',
				'task.proposal.resolved',
				'turn.completed',
				'session.failed',
				'host.stopped',
				'crew.plan.requested',
				'crew.plan.resolved',
				'crew.worker.created',
				'crew.part.started',
				'crew.part.dropped',
				'crew.note',
				'crew.question.requested',
				'crew.question.resolved',
				'crew.review',
				'crew.accepted',
				'crew.worker.stopped',
				'quick-ask.changed',
			].includes(e.kind)
		) {
			// spec/agents-and-providers#sign-in-recovery: an assistant message that was the failed turn's only output is the CLI's own sign-in text; it shows as the card's detail.
			let detail: string | undefined;
			if (e.kind === 'session.failed' && e.reason === 'auth') {
				const start = rows.findIndex((row) => row.id === `user-${turn}`),
					only = start >= 0 && rows.length === start + 2 ? rows[start + 1] : undefined;
				if (only?.kind === 'message' && only.role === 'assistant' && only.text.trim()) {
					detail = only.text.trim();
					rows.pop();
				}
			}
			rows.push({
				id: `event-${record.seq}`,
				kind: 'event',
				record,
				...(detail ? { detail } : {}),
			});
		}
	}
	return rows;
}
/** spec/chat-turns-plans-and-questions#plan-row: the one-line agent plan: done count, the step in progress (else the next one) and whether steps fit as segments (12 at most). */
export type PlanEntry = { text: string; priority: string; status: string };
export function planSummary(entries: readonly PlanEntry[]): {
	done: number;
	total: number;
	current: string | null;
	next: string | null;
	segments: boolean;
} {
	return {
		done: entries.filter((entry) => entry.status === 'completed').length,
		total: entries.length,
		current: entries.find((entry) => entry.status === 'in_progress')?.text ?? null,
		next: entries.find((entry) => entry.status === 'pending')?.text ?? null,
		segments: entries.length <= 12,
	};
}
