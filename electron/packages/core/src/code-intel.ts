import { isRecord, type ProjectFormatter } from './workspace';
import type { TaskKey } from './session';
import type { ProjectIndent } from './indent';
/** Code intelligence domain (spec/editor-code-intelligence#architecture). Language-server protocol types never cross into the renderer. */
export type CodeChange = { from: number; to: number; insert: string };
export type CodeSource = 'server' | 'fallback' | 'stylesheet';
export type CodeFeatures = {
	completion: boolean;
	hover: boolean;
	signature: boolean;
	definition: boolean;
	references: boolean;
	problems: boolean;
};
export type CodeStatus = {
	source: CodeSource;
	language: string | null;
	server: string | null;
	version: number;
	features: CodeFeatures;
	completionTriggers: string[];
	signatureTriggers: string[];
};
export type CodeChangeResult = { status: 'ok' | 'resync' };
export type CodeCompletionKind =
	| 'function'
	| 'method'
	| 'class'
	| 'interface'
	| 'enum'
	| 'variable'
	| 'constant'
	| 'property'
	| 'type'
	| 'keyword'
	| 'namespace'
	| 'text';
export type CodeCompletion = {
	id: number;
	label: string;
	kind: CodeCompletionKind;
	detail?: string;
	from: number;
	to: number;
	insert: string;
	edits?: CodeChange[];
	resolve: boolean;
};
export type CodeCompletionList = { list: number; items: CodeCompletion[]; incomplete: boolean };
export type CodeCompletionDetail = { detail?: string; documentation?: string; edits: CodeChange[] };
export type CodeHover = { from: number; to: number; markdown: string };
export type CodeSignature = {
	label: string;
	documentation?: string;
	parameters: { from: number; to: number; documentation?: string }[];
};
export type CodeSignatureHelp = {
	signatures: CodeSignature[];
	active: number;
	activeParameter: number;
};
export type CodeLocation = {
	fileId: string;
	path: string;
	line: number;
	column: number;
	preview: string;
	readOnly: boolean;
	byName: boolean;
};
export type CodeLocations = {
	locations: CodeLocation[];
	source: CodeSource;
	language: string | null;
	truncated: boolean;
};
export type CodeProblemSeverity = 'error' | 'warning' | 'info' | 'hint';
export type CodeProblem = {
	from: number;
	to: number;
	severity: CodeProblemSeverity;
	message: string;
	source?: string;
};
export type CodeProblemsEvent = {
	key: TaskKey;
	fileId: string;
	version: number;
	problems: CodeProblem[];
};
/** spec/editor-code-intelligence#language-server-restart: `off` — Settings switched the language servers off; `restarted` — server names, empty when none ran. */
export type CodeRestartResult = { off: boolean; restarted: string[] };
export type CodeTrigger = { kind: 'invoked' } | { kind: 'character'; character: string };
/** spec/editor-code-intelligence#format-on-save: who formats a file. `reason` tells a save (honours `off`) from the menu command (always tries). */
export type CodeFormatSource = 'prettier' | 'language-server';
export type CodeFormatReason = 'save' | 'command';
export type CodeFormatInfo = { source: CodeFormatSource | null; onSave: boolean };
export type CodeFormatResult =
	| { status: 'formatted'; source: CodeFormatSource; version: number; edits: CodeChange[] }
	| {
			status: 'skipped';
			reason: 'none' | 'off' | 'ignored' | 'not-found' | 'unsupported' | 'stale';
			source?: CodeFormatSource;
	  }
	| {
			status: 'failed';
			source: CodeFormatSource;
			reason: 'syntax' | 'timeout' | 'crashed';
			line?: number;
	  };
export const isCodeFormatReason = (value: unknown): value is CodeFormatReason =>
	value === 'save' || value === 'command';
/** Settings ▸ Editor rows: the project's choice and what its root holds. */
export type ProjectFormatterInfo = {
	projectId: string;
	name: string;
	formatter: ProjectFormatter;
	prettier: string | null;
	/** spec/editor#indentation: what the project's Prettier or .editorconfig says about indentation at its root. */ indent: ProjectIndent | null;
};
/** spec/editor#indentation: the config's answer for one open file; null when neither Prettier nor .editorconfig speaks. */
export type CodeIndentInfo = { project: ProjectIndent | null };

export const codeLimits = {
	completions: 200,
	hover: 16 * 1024,
	definitions: 20,
	references: 500,
	problems: 500,
	changes: 256,
	changeBytes: 1024 * 1024,
} as const;
const offset = (value: unknown): value is number =>
	Number.isSafeInteger(value) && (value as number) >= 0;
export function isCodeChanges(value: unknown): value is CodeChange[] {
	if (!Array.isArray(value) || value.length > codeLimits.changes) return false;
	let bytes = 0;
	for (const change of value) {
		if (
			!isRecord(change) ||
			!offset(change.from) ||
			!offset(change.to) ||
			change.to < change.from ||
			typeof change.insert !== 'string'
		)
			return false;
		bytes += change.insert.length;
	}
	return bytes <= codeLimits.changeBytes;
}
export const isCodeOffset = offset;
export function isCodeTrigger(value: unknown): value is CodeTrigger {
	return (
		isRecord(value) &&
		((value.kind === 'invoked' && Object.keys(value).length === 1) ||
			(value.kind === 'character' &&
				typeof value.character === 'string' &&
				value.character.length === 1 &&
				Object.keys(value).length === 2))
	);
}
/** spec/editor-code-intelligence#hyphenated-words: style sheets name things with hyphens — `--page-content`, `$gap-sm`, `pad-x` — so `-` joins their words. */
export function codeWordChars(language: string | null | undefined) {
	return language === 'css' || language === 'scss' ? '\\p{L}\\p{N}_$-' : '\\p{L}\\p{N}_$';
}
/** Identifier under a UTF-16 offset: letters, digits, `_` and `$`, plus `-` in CSS and SCSS. */
export function codeWordAt(
	text: string,
	pos: number,
	language?: string | null
): { from: number; to: number; word: string } | null {
	const part = new RegExp(`[${codeWordChars(language)}]`, 'u');
	let from = pos,
		to = pos;
	while (from > 0 && part.test(text[from - 1]!)) from--;
	while (to < text.length && part.test(text[to]!)) to++;
	// A bare `-` (`a - b`) or a number (`-4px`) is no name.
	if (from === to || /^-*(?:\p{N}|$)/u.test(text.slice(from, to))) return null;
	return { from, to, word: text.slice(from, to) };
}
/** Where a ⌘+click happened: the file, its 1-based line and the clicked word as 1-based columns, `to` exclusive. */
export type CodeClick = { fileId: string; line: number; from: number; to: number };
/**
 * spec/editor-code-intelligence#definition-and-usages: one of the definitions is the clicked name itself, so the click sits on the declaration and
 * shows its references instead of going nowhere. Servers point at the name, so its start lies in the word.
 */
export function onDeclaration(locations: readonly CodeLocation[], click: CodeClick): boolean {
	return locations.some(
		(location) =>
			location.fileId === click.fileId &&
			location.line === click.line &&
			location.column >= click.from &&
			location.column < click.to
	);
}
