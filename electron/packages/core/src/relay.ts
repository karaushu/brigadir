import { isId, isRecord, type AgentTask } from './workspace';
import { isLaunchInput, type TaskLaunch } from './launch';
import { isAttachmentIds } from './attachments';
import type { EventRecord } from './session';
export type RelaySelection = { summary: boolean; diff: boolean; fullPatch: boolean };
export const isRelaySelection = (value: unknown): value is RelaySelection =>
	isRecord(value) &&
	typeof value.summary === 'boolean' &&
	typeof value.diff === 'boolean' &&
	typeof value.fullPatch === 'boolean';
export type RelayDiff = { stat: string; patch: string; files: string[]; truncated: boolean };
export type RelayDraft = {
	id: string;
	source: AgentTask;
	launch: TaskLaunch;
	diff: RelayDiff;
	summary: string | null;
};
export type RelayCreate = {
	draftId: string;
	text: string;
	provider: 'claude' | 'codex';
	transport: 'gui' | 'terminal';
	backlog: boolean;
	launch: TaskLaunch;
	selection: RelaySelection;
};
export function isRelayCreate(value: unknown): value is RelayCreate {
	return (
		isRecord(value) &&
		isId(value.draftId) &&
		typeof value.text === 'string' &&
		value.text.length <= 1_000_000 &&
		(value.provider === 'claude' || value.provider === 'codex') &&
		(value.transport === 'gui' || value.transport === 'terminal') &&
		typeof value.backlog === 'boolean' &&
		isLaunchInput(value.launch) &&
		isRelaySelection(value.selection)
	);
}
export type RelayHandoff = { sourceId: string; attachmentIds: string[]; files: string[] };
export function isRelayHandoff(value: unknown): value is RelayHandoff {
	return (
		isRecord(value) &&
		isId(value.sourceId) &&
		isAttachmentIds(value.attachmentIds) &&
		Array.isArray(value.files) &&
		value.files.length <= 20 &&
		value.files.every(
			(path) =>
				typeof path === 'string' &&
				path.length > 0 &&
				path.length <= 4096 &&
				!path.startsWith('/') &&
				!path.includes('\0') &&
				!path.split('/').some((part) => !part || part === '.' || part === '..' || part === '.git')
		)
	);
}
export type PromptResource = { name: string; uri: string };
export const estimatedTokens = (text: string) => Math.ceil(text.length / 4);
/** Bounded source material for a disposable summary call, never the new task's prompt. */
export function relayJournal(records: readonly EventRecord[], limit = 48000): string {
	const chunks: string[] = [];
	let length = 0,
		truncated = false,
		assistant = '';
	const append = (chunk: string) => {
		if (!chunk) return true;
		if (length + chunk.length + 2 > limit) {
			truncated = true;
			return false;
		}
		chunks.push(chunk);
		length += chunk.length + 2;
		return true;
	};
	const flush = () => {
		const value = assistant;
		assistant = '';
		return !value || append(`Assistant: ${value}`);
	};
	for (let i = records.length - 1; i >= 0; i--) {
		const event = records[i]!.event;
		let chunk = '';
		if (
			event.kind === 'message.delta' &&
			event.role === 'assistant' &&
			event.content.kind === 'text'
		) {
			const next = event.content.text + assistant;
			if (next.length > 6000) truncated = true;
			assistant = next.slice(-6000);
			continue;
		}
		if (!flush()) break;
		if (event.kind === 'turn.started' && event.origin !== 'agent')
			chunk = `User: ${event.text.slice(0, 6000)}`;
		if (event.kind === 'tool.changed' && (event.patch.title || event.patch.output))
			chunk = `Tool (${event.patch.status ?? 'unknown'}): ${(event.patch.title ?? '').slice(0, 500)} ${(event.patch.output ?? '').slice(-1000)}`;
		if (event.kind === 'session.failed') chunk = `Failure: ${event.message.slice(0, 1000)}`;
		if (event.kind === 'turn.completed') chunk = `Turn finished: ${event.reason}`;
		if (!append(chunk)) break;
	}
	flush();
	const first = records.find(
		(record) => record.event.kind === 'turn.started' && record.event.origin !== 'agent'
	)?.event;
	return `${truncated ? '[Some earlier events or long messages omitted]\nOriginal request: ' + (first?.kind === 'turn.started' ? first.text.slice(0, 4000) : '') + '\n\n' : ''}${chunks.reverse().join('\n\n')}`;
}
