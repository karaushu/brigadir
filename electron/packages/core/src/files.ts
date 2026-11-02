import type { ScopeKind } from './launch';
import { isRecord } from './workspace';
export const editorByteLimit = 8 * 1024 * 1024;
export type FileEntry = {
	id: string;
	name: string;
	path: string;
	kind: 'directory' | 'file' | 'unavailable';
	ignored?: boolean;
	status?: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflict';
	scopeName?: string;
	scopeKind?: ScopeKind;
};
export type FileStatus = NonNullable<FileEntry['status']>;
/** spec/appearance#evolution-redesign: the git letter at the end of a changed file's row in the Files tree, as VS Code / JetBrains show it. */
export const fileStatusLetters: Record<FileStatus, 'M' | 'A' | 'D' | 'R' | 'U' | 'C'> = {
	modified: 'M',
	added: 'A',
	deleted: 'D',
	renamed: 'R',
	untracked: 'U',
	conflict: 'C',
};
/** The letter a tree row ends with: a changed file only; a folder or an unchanged file gets none. */
export function fileStatusLetter(entry: Pick<FileEntry, 'kind' | 'status'>) {
	return entry.kind === 'file' && entry.status ? fileStatusLetters[entry.status] : null;
}
/** `released`: the task's worktree was removed (spec/tasks#released-worktree), so there is no tree to list. */
export type FileListing = { entries: FileEntry[]; truncated: boolean; released?: true };
/** Same rows as the tree shows them: a refresh that finds no change keeps the old listing. */
export function sameFileEntries(
	a: readonly FileEntry[] | undefined,
	b: readonly FileEntry[]
): boolean {
	return (
		a !== undefined &&
		a.length === b.length &&
		a.every((entry, i) => {
			const other = b[i]!;
			return (
				entry.id === other.id &&
				entry.name === other.name &&
				entry.path === other.path &&
				entry.kind === other.kind &&
				entry.ignored === other.ignored &&
				entry.status === other.status &&
				entry.scopeName === other.scopeName &&
				entry.scopeKind === other.scopeKind
			);
		})
	);
}
export type FileContent = {
	text: string;
	version: string;
	state: 'text' | 'binary' | 'too-large';
	large: boolean;
	lineEnding: '\n' | '\r\n';
	mode: number;
};
export type EditorDocument = FileContent & {
	id: string;
	path: string;
	locked: boolean;
	readOnly?: boolean;
};
/** Node-to-host request only. Renderer APIs accept registered opaque IDs. */
/** `afterTurn` (spec/editor#save-during-turn): during a turn the host holds the save and writes it when the turn ends instead of refusing. */
export type SaveFileRequest = {
	path: string;
	expectedVersion: string;
	text: string;
	afterTurn?: boolean;
};
export type SaveFileResult = { status: 'saved' | 'conflict'; content: FileContent };
export type EditorAction =
	| 'save'
	| 'find'
	| 'replace'
	| 'find-next'
	| 'find-previous'
	| 'replace-all'
	| 'undo'
	| 'redo'
	| 'indent'
	| 'outdent'
	| 'comment'
	| 'format'
	| 'definition'
	| 'references'
	| 'completions'
	| 'parameters'
	| 'problem-next'
	| 'problem-previous'
	| 'change-next'
	| 'change-previous'
	| 'change-revert'
	| 'location-previous'
	| 'location-next'
	| 'history';
export function isFileId(v: unknown): v is string {
	return typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
}
/** spec/appearance#evolution-redesign: a repo of the task as a root of the Files tree, `scope:<scope id>`. */
export function isRepoFolderId(v: unknown): v is string {
	return typeof v === 'string' && /^scope:[a-f0-9]{16}$/.test(v);
}
export function isSaveFileRequest(v: unknown): v is SaveFileRequest {
	return (
		isRecord(v) &&
		typeof v.path === 'string' &&
		v.path.length > 0 &&
		!v.path.startsWith('/') &&
		!v.path.split('/').some((s) => s === '..' || s === '.' || s === '.git' || !s) &&
		isFileId(v.expectedVersion) &&
		typeof v.text === 'string' &&
		v.text.length <= editorByteLimit &&
		(v.afterTurn === undefined || typeof v.afterTurn === 'boolean')
	);
}

export type FileSearchResult = { entries: (FileEntry & { scope: string })[]; truncated: boolean };
export type WorkspaceAction =
	| 'editor-split-right'
	| 'editor-split-down'
	| 'editor-split-move-right'
	| 'editor-split-move-down'
	| 'editor-group-move'
	| 'editor-unsplit'
	| 'editor-unsplit-all'
	| 'editor-group-next'
	| 'editor-group-previous'
	| 'ask-agent'
	| 'language-servers-restart'
	| 'intro'
	| 'settings-templates'
	| 'relay'
	| 'open-project'
	| 'connect'
	| 'close-task'
	| 'close-tab'
	| 'composer-mode'
	| 'composer-queue'
	| 'new-task'
	| 'new-file'
	| 'quick-open-alias'
	| 'notifications'
	| 'needs-next'
	| 'needs-previous'
	| 'document-next'
	| 'document-previous'
	| 'sidebar-toggle'
	| 'section-tasks'
	| 'section-prs'
	| 'layout-chat'
	| 'layout-work'
	| 'layout-panel'
	| 'layout-all'
	| 'layout-reset'
	| 'tools'
	| 'sidebar-filter'
	| 'font-increase'
	| 'font-decrease'
	| 'font-reset'
	| 'next-block'
	| 'previous-block'
	| 'turn-next'
	| 'turn-previous'
	| 'activity-expand'
	| 'activity-collapse'
	| 'settings'
	| 'browser-address'
	| 'diff-toggle'
	| 'markdown-preview'
	| 'diff-expand'
	| 'diff-collapse'
	| 'diff-comment'
	| 'diff-next'
	| 'diff-jump-to-source'
	| 'commit'
	| 'reopen-tab'
	| 'diff-previous'
	| 'review-send-go'
	| 'permission-deny'
	| 'browser-pick'
	| 'browser-screenshot'
	| 'browser-inspect'
	| 'browser-reload'
	| 'browser-back'
	| 'browser-forward'
	| 'turns'
	| 'pull-requests'
	| 'pull-requests-refresh'
	| 'search'
	| 'find-in-files'
	| 'find-action'
	| 'quick-open'
	| 'diff'
	| 'files'
	| 'review-send'
	| 'composer'
	| 'terminal'
	| 'browser'
	| 'cancel'
	| 'terminal-new'
	| 'terminal-clear'
	| 'terminal-next'
	| 'terminal-previous'
	| 'terminal-compose'
	| 'commands'
	| 'command-run'
	| 'command-stop'
	| 'command-new'
	| 'simulator'
	| 'simulator-home'
	| 'simulator-rotate'
	| 'simulator-reload'
	| 'simulator-devtools'
	| 'simulator-screenshot'
	| 'simulator-shutdown'
	| 'archive-task'
	| 'archive'
	| 'notes'
	| 'note-new'
	| 'schedules'
	| 'schedule-new'
	| 'format-bold'
	| 'format-italic'
	| 'format-code'
	| 'format-link';
