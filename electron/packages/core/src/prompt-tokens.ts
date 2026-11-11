import { planChatWords } from './plan-approval';
import type { PromptAttachment } from './attachments';
import type { AgentTask } from './workspace';
import type { EventRecord } from './session';

/**
 * spec/composer#mentions: a mention in the composer's text is a token without spaces the person never sees. It is self-delimited
 * (`@[kind:value]`), so text typed right after a pill never becomes part of it:
 * `@[att:<id>]` an attachment in its place (file, text, image, task summary), `@[task:<id>]` a task before sending,
 * `@[model:<provider>:<model>]` a model reference.
 */
export type PromptToken =
	| { kind: 'attachment'; id: string }
	| { kind: 'task'; id: string }
	| { kind: 'model'; provider: 'claude' | 'codex'; model: string };
export type PromptPart =
	{ kind: 'text'; text: string } | { kind: 'token'; token: PromptToken; raw: string };

const tokenPattern = /@\[(att|task|model):([^\]\s]{1,300})\]/g;
const attachmentId = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const taskId = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

function token(kind: string, value: string): PromptToken | null {
	if (kind === 'att') return attachmentId.test(value) ? { kind: 'attachment', id: value } : null;
	if (kind === 'task') return taskId.test(value) ? { kind: 'task', id: value } : null;
	const model = /^(claude|codex):(.+)$/.exec(value);
	return model
		? { kind: 'model', provider: model[1] as 'claude' | 'codex', model: model[2]! }
		: null;
}

/** The text split into plain runs and tokens, in order; an unknown `@[…]` stays text. */
export function promptParts(text: string): PromptPart[] {
	const parts: PromptPart[] = [];
	let from = 0;
	for (const match of text.matchAll(tokenPattern)) {
		const found = token(match[1]!, match[2]!);
		if (!found) continue;
		if (match.index! > from) parts.push({ kind: 'text', text: text.slice(from, match.index) });
		parts.push({ kind: 'token', token: found, raw: match[0] });
		from = match.index! + match[0].length;
	}
	if (from < text.length) parts.push({ kind: 'text', text: text.slice(from) });
	return parts;
}
/** Where each token stands: the editor turns these ranges into pills. */
export function promptTokenRanges(
	text: string
): { from: number; to: number; token: PromptToken }[] {
	const ranges: { from: number; to: number; token: PromptToken }[] = [];
	for (const match of text.matchAll(tokenPattern)) {
		const found = token(match[1]!, match[2]!);
		if (found)
			ranges.push({ from: match.index!, to: match.index! + match[0].length, token: found });
	}
	return ranges;
}
export const attachmentToken = (id: string) => `@[att:${id}]`;
export const taskToken = (id: string) => `@[task:${id}]`;
export const modelToken = (provider: 'claude' | 'codex', model: string) =>
	`@[model:${provider}:${model}]`;
/** Attachment ids in the order the text places them, each once. */
export function promptAttachmentIds(text: string): string[] {
	return [
		...new Set(
			promptParts(text).flatMap((part) =>
				part.kind === 'token' && part.token.kind === 'attachment' ? [part.token.id] : []
			)
		),
	];
}
export const promptHasTokens = (text: string) =>
	promptParts(text).some((part) => part.kind === 'token');

/** spec/composer#mentions: what the agent reads in place of a model pill — the exact id and the provider. */
export function modelMentionText(provider: 'claude' | 'codex', model: string) {
	return `\`${model}\` (${provider === 'claude' ? 'Claude' : 'Codex'})`;
}

/** The prefix of a task summary attachment's name (spec/composer#mentions); the rest is the task's title. */
export const taskSummaryPrefix = 'Task summary · ';
/** What a pill shows for an attachment: a task summary is the task, a file its base name, an image the image. */
export function attachmentMention(item: Pick<PromptAttachment, 'kind' | 'name'>): {
	kind: 'image' | 'file' | 'folder' | 'text' | 'task';
	label: string;
} {
	if (item.kind === 'image') return { kind: 'image', label: item.name };
	// spec/composer#mention-menu: a folder reference is named with a trailing `/` (`Files.attach`); its pill has the folder glyph.
	if (item.kind === 'text' && item.name.length > 1 && item.name.endsWith('/'))
		return { kind: 'folder', label: item.name.slice(0, -1).split('/').at(-1)! };
	if (item.name.startsWith(taskSummaryPrefix))
		return { kind: 'task', label: item.name.slice(taskSummaryPrefix.length) };
	const path = /^(.*?)(:\d+(?:-\d+)?)?$/.exec(item.name)!,
		base = path[1]!.split('/').at(-1) || path[1]!;
	return {
		kind: path[1]!.includes('/') || /\.[A-Za-z0-9]{1,8}$/.test(path[1]!) ? 'file' : 'text',
		label: base + (path[2] ?? ''),
	};
}
/** spec/chat#code-pills: the lines a pill names — `src/a.ts:12-20` from the editor, `src/a.ts:12-20 · new` from the diff (its path in the repo). */
export function attachmentLines(
	item: Pick<PromptAttachment, 'kind' | 'name'>
): { path: string; start: number; end: number; side: 'old' | 'new' } | null {
	if (item.kind !== 'text' || item.name.startsWith(taskSummaryPrefix)) return null;
	const match = /^(.+):(\d+)(?:-(\d+))?(?: · (old|new))?$/.exec(item.name);
	if (!match) return null;
	const start = Number(match[2]),
		end = match[3] ? Number(match[3]) : start;
	if (start < 1 || end < start) return null;
	return { path: match[1]!, start, end, side: match[4] === 'old' ? 'old' : 'new' };
}

/** spec/composer#mentions: the text as people read it — the rail, the queue deck, search and «Copy message» show names, not tokens. */
export function promptDisplayText(
	text: string,
	attachments: readonly Pick<PromptAttachment, 'id' | 'kind' | 'name'>[] = [],
	tasks: readonly Pick<AgentTask, 'id' | 'title'>[] = []
): string {
	text = planChatWords(text) ?? text;
	if (!text.includes('@[')) return text;
	return promptParts(text)
		.map((part) => {
			if (part.kind === 'text') return part.text;
			const value = part.token;
			if (value.kind === 'model') return `@${value.model}`;
			if (value.kind === 'task')
				return `@${tasks.find((task) => task.id === value.id)?.title ?? value.id}`;
			const item = attachments.find((entry) => entry.id === value.id);
			return item ? `@${attachmentMention(item).label}` : '';
		})
		.join('');
}

/**
 * spec/composer#mentions: what the agent gets, in the order of the text. Attachment tokens become the attachment's place, models
 * become text, a token of an attachment the prompt does not carry disappears. Attachments the text does not place follow
 * the text, as before this decision.
 */
export function promptSequence(
	text: string,
	attachmentIds: readonly string[]
): ({ kind: 'text'; text: string } | { kind: 'attachment'; id: string })[] {
	const known = new Set(attachmentIds),
		placed = new Set<string>(),
		out: ({ kind: 'text'; text: string } | { kind: 'attachment'; id: string })[] = [];
	let run = '';
	for (const part of promptParts(text)) {
		if (part.kind === 'text') {
			run += part.text;
			continue;
		}
		const value = part.token;
		if (value.kind === 'model') {
			run += modelMentionText(value.provider, value.model);
			continue;
		}
		if (value.kind === 'task') {
			run += part.raw;
			continue;
		}
		if (!known.has(value.id) || placed.has(value.id)) continue;
		if (run.trim()) out.push({ kind: 'text', text: run });
		run = '';
		out.push({ kind: 'attachment', id: value.id });
		placed.add(value.id);
	}
	if (run.trim()) out.push({ kind: 'text', text: run });
	for (const id of attachmentIds) if (!placed.has(id)) out.push({ kind: 'attachment', id });
	return out;
}

/**
 * spec/composer#mentions: the task summary a `@task` mention attaches — a snapshot at sending, built without a model: the title,
 * state, branch, first request, latest agent answer and the diff `--stat`, as the relay does (spec/tasks#relay) but with no generation.
 */
export function taskSummaryText(
	task: Pick<AgentTask, 'title' | 'status' | 'provider' | 'worktreeBranch' | 'taskTree'>,
	records: readonly EventRecord[],
	stat: string
): string {
	const first = records.find(
		(record) => record.event.kind === 'turn.started' && record.event.origin !== 'agent'
	)?.event;
	let answer = '',
		current = '';
	for (const record of records) {
		const event = record.event;
		if (event.kind === 'turn.started') {
			if (current.trim()) answer = current;
			current = '';
		} else if (
			event.kind === 'message.delta' &&
			event.role === 'assistant' &&
			event.content.kind === 'text'
		)
			current += event.content.text;
	}
	if (current.trim()) answer = current;
	const branch = task.taskTree?.branch ?? task.worktreeBranch ?? null;
	const clip = (value: string, limit: number) =>
		value.length > limit ? `${value.slice(0, limit)}\n[…]` : value;
	return [
		`Task: ${task.title}`,
		`State: ${task.status}${task.provider ? ` · agent: ${task.provider === 'claude' ? 'Claude' : 'Codex'}` : ''}${branch ? ` · branch: ${branch}` : ''}`,
		first?.kind === 'turn.started'
			? `\nOriginal request:\n${clip(promptDisplayText(first.text, first.attachments ?? []), 4000)}`
			: '',
		answer.trim() ? `\nLatest agent answer:\n${clip(answer.trim(), 12000)}` : '',
		`\nChanges (snapshot, diff --stat):\n${clip(stat || 'No captured changes.', 20000)}`,
	]
		.filter(Boolean)
		.join('\n');
}
