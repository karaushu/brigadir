import { isolateHistory } from '@codemirror/commands';
import type { EditorView } from '@codemirror/view';
import {
	t,
	type AgentTask,
	type CodeFormatReason,
	type CodeFormatResult,
	type Locale,
	type MessageKey,
} from '@brigadir/core';
import type { CodeSession } from './code-intel';
/** spec/editor-code-intelligence#format-states: a strip until the next edit for failures; `footer` is the short note for a command with nothing to run. */
export type FormatNotice = { place: 'strip' | 'footer'; text: string; line?: number };
/** Renderer-local signal from Settings ▸ Editor, so open editors refresh the footer source. */
export const formattersChanged = 'brigadir:formatters-changed';
export function notifyFormattersChanged() {
	window.dispatchEvent(new Event(formattersChanged));
}
/**
 * Formats the synced document and applies the edits as one undo step. A document edited meanwhile stays as typed:
 * the result is then `stale` and nothing is applied (spec/editor-code-intelligence#format-on-save).
 */
export async function formatDocument(
	task: AgentTask,
	session: CodeSession,
	view: EditorView,
	reason: CodeFormatReason
): Promise<CodeFormatResult | null> {
	await session.sync();
	const doc = view.state.doc;
	if (!session.ready(doc)) return { status: 'skipped', reason: 'stale' };
	const result = await window.brigadir
		.formatCode(task, session.fileId, session.version, reason)
		.catch(() => null);
	if (result?.status !== 'formatted') return result;
	if (view.state.doc !== doc) return { status: 'skipped', reason: 'stale' };
	if (result.edits.length)
		view.dispatch({
			changes: result.edits,
			userEvent: 'format',
			annotations: isolateHistory.of('full'),
			scrollIntoView: false,
		});
	return result;
}
export function formatNotice(
	locale: Locale,
	result: CodeFormatResult | null,
	reason: CodeFormatReason
): FormatNotice | null {
	const saved = reason === 'save';
	if (!result)
		return {
			place: 'strip',
			text: t(
				locale,
				saved
					? 'The formatter did not respond. The file is saved without formatting.'
					: 'The formatter did not respond.'
			),
		};
	if (result.status === 'failed') {
		if (result.reason === 'syntax') {
			const key: MessageKey = result.line
				? saved
					? 'Not formatted: syntax error on {line}. The file is saved.'
					: 'Not formatted: syntax error on {line}.'
				: saved
					? 'Not formatted: syntax error. The file is saved.'
					: 'Not formatted: syntax error.';
			return {
				place: 'strip',
				text: t(locale, key),
				...(result.line ? { line: result.line } : {}),
			};
		}
		return {
			place: 'strip',
			text: t(
				locale,
				saved
					? 'The formatter did not respond. The file is saved without formatting.'
					: 'The formatter did not respond.'
			),
		};
	}
	if (result.status === 'skipped') {
		if (result.reason === 'not-found')
			return { place: 'strip', text: t(locale, 'Prettier was not found in the project.') };
		if (result.reason === 'unsupported')
			return {
				place: 'strip',
				text: t(
					locale,
					result.source === 'prettier'
						? 'Prettier does not format this file.'
						: 'The language server does not format this file.'
				),
			};
		if (!saved && (result.reason === 'none' || result.reason === 'ignored'))
			return { place: 'footer', text: t(locale, 'Nothing formats this file.') };
	}
	return null;
}
