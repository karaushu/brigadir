import { join } from 'node:path';
import { diffLines } from '@brigadir/diff';
import { prettierVersion } from '@brigadir/lsp';
import { readWorkspace, SessionStore } from '@brigadir/persistence';
import type {
	AppSettings,
	CodeChange,
	CodeFormatReason,
	ProjectFormatter,
	ProjectFormatterInfo,
	ProjectIndent,
} from '@brigadir/core';
/** spec/editor-code-intelligence#format-on-save: the effective mode of one request; `off` stops a save, while the menu command still tries `auto`. */
export function formatMode(
	settings: AppSettings,
	project: ProjectFormatter | undefined,
	reason: CodeFormatReason
): 'auto' | 'prettier' | 'language-server' | 'off' {
	const mode = !project || project === 'default' ? settings.editor.format : project;
	return mode === 'off' && reason === 'command' ? 'auto' : mode;
}
const trimmed = (from: number, before: string, after: string): CodeChange | null => {
	let start = 0;
	const limit = Math.min(before.length, after.length);
	while (start < limit && before.charCodeAt(start) === after.charCodeAt(start)) start++;
	let end = 0;
	while (
		end < limit - start &&
		before.charCodeAt(before.length - 1 - end) === after.charCodeAt(after.length - 1 - end)
	)
		end++;
	if (start === before.length - end && start === after.length - end) return null;
	return {
		from: from + start,
		to: from + before.length - end,
		insert: after.slice(start, after.length - end),
	};
};
/**
 * Minimal edits in the offsets of `before`, ascending and non-overlapping, so CodeMirror applies them in one transaction
 * and untouched lines keep the cursor and review decorations (spec/editor-code-intelligence#format-on-save). Paired changed lines are trimmed one by one.
 */
export function formatEdits(before: string, after: string): CodeChange[] {
	if (before === after) return [];
	const { lines } = diffLines(before, after);
	const full = (line: (typeof lines)[number]) =>
		line.text + (line.ending === 'none' ? '' : line.ending === 'crlf' ? '\r\n' : '\n');
	const edits: CodeChange[] = [];
	let offset = 0;
	for (let i = 0; i < lines.length;) {
		if (lines[i]!.kind === 'context') {
			offset += full(lines[i]!).length;
			i++;
			continue;
		}
		const removed: string[] = [],
			added: string[] = [];
		while (i < lines.length && lines[i]!.kind !== 'context') {
			const line = lines[i++]!;
			(line.kind === 'removed' ? removed : added).push(full(line));
		}
		if (removed.length === added.length) {
			for (let n = 0; n < removed.length; n++) {
				const edit = trimmed(offset, removed[n]!, added[n]!);
				if (edit) edits.push(edit);
				offset += removed[n]!.length;
			}
		} else {
			const old = removed.join('');
			const edit = trimmed(offset, old, added.join(''));
			if (edit) edits.push(edit);
			offset += old.length;
		}
	}
	return edits;
}
/** The config's answer for a project root, in at most this long (a cold Prettier takes a moment; the row then shows no indentation). */
const indentWait = 2500;
export type IndentOf = (root: string) => Promise<ProjectIndent | null>;
/** Settings ▸ Editor: every project with its choice, the Prettier its root holds and the indentation its config gives (spec/editor#indentation). */
export async function readFormatters(
	dataDir: string | undefined,
	indentOf?: IndentOf
): Promise<ProjectFormatterInfo[]> {
	const workspace = await readWorkspace(dataDir ? { dataDir } : {});
	return Promise.all(
		workspace.projects.map(async (project) => {
			const indent = indentOf
				? await Promise.race([
						indentOf(project.path).catch(() => null),
						new Promise<null>((resolve) => setTimeout(resolve, indentWait, null)),
					])
				: null;
			return {
				projectId: project.id,
				name: project.name,
				formatter: project.formatter ?? 'default',
				prettier: prettierVersion(join(project.path, 'node_modules/prettier')),
				indent,
			};
		})
	);
}
export async function setProjectFormatter(
	dataDir: string | undefined,
	projectId: string,
	formatter: ProjectFormatter,
	indentOf?: IndentOf
) {
	await (await SessionStore.at(dataDir)).setProjectFormatter(projectId, formatter);
	return readFormatters(dataDir, indentOf);
}
