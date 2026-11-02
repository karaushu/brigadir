import { fileURLToPath } from 'node:url';
import {
	codeLimits,
	codeWordAt,
	type CodeChange,
	type CodeCompletion,
	type CodeCompletionKind,
	type CodeHover,
	type CodeProblem,
	type CodeSignatureHelp,
} from '@brigadir/core';
import type { Range, TextMirror } from './mirror';
/** LSP → domain. Anything malformed is dropped rather than trusted (spec/editor-code-intelligence#architecture). */
type Json = Record<string, unknown>;
const record = (value: unknown): value is Json =>
	typeof value === 'object' && value !== null && !Array.isArray(value);
const isRange = (value: unknown): value is Range =>
	record(value) &&
	record(value.start) &&
	record(value.end) &&
	[value.start.line, value.start.character, value.end.line, value.end.character].every(
		(n) => Number.isSafeInteger(n) && (n as number) >= 0
	);
const offsets = (mirror: TextMirror, range: Range) => ({
	from: mirror.offset(range.start),
	to: mirror.offset(range.end),
});
export type RawLocation = { absolute: string; line: number; character: number };
const escapeMarkdown = (text: string) => text.replace(/[\\`*_{}[\]<>#|]/g, '\\$&');
export function markdown(value: unknown): string {
	if (typeof value === 'string') return value;
	if (Array.isArray(value)) return value.map(markdown).filter(Boolean).join('\n\n---\n\n');
	if (!record(value) || typeof value.value !== 'string') return '';
	if (typeof value.language === 'string')
		return '```' + value.language.replace(/[^\w+-]/g, '') + '\n' + value.value + '\n```';
	return value.kind === 'plaintext' ? escapeMarkdown(value.value) : value.value;
}
const bounded = (text: string) =>
	text.length > codeLimits.hover ? text.slice(0, codeLimits.hover) + '\n\n…' : text;
const kinds: Record<number, CodeCompletionKind> = {
	1: 'text',
	2: 'method',
	3: 'function',
	4: 'function',
	5: 'property',
	6: 'variable',
	7: 'class',
	8: 'interface',
	9: 'namespace',
	10: 'property',
	11: 'constant',
	12: 'constant',
	13: 'enum',
	14: 'keyword',
	15: 'text',
	16: 'constant',
	17: 'text',
	18: 'text',
	19: 'namespace',
	20: 'constant',
	21: 'constant',
	22: 'class',
	23: 'property',
	24: 'keyword',
	25: 'type',
};
export function edits(mirror: TextMirror, value: unknown): CodeChange[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter(
			(edit): edit is { range: Range; newText: string } =>
				record(edit) && isRange(edit.range) && typeof edit.newText === 'string'
		)
		.map((edit) => ({ ...offsets(mirror, edit.range), insert: edit.newText }));
}
export function completions(
	mirror: TextMirror,
	value: unknown,
	offset: number,
	language?: string | null
): { items: CodeCompletion[]; raw: Json[]; incomplete: boolean } {
	const list = Array.isArray(value)
		? value
		: record(value) && Array.isArray(value.items)
			? value.items
			: [];
	const incomplete = record(value) && value.isIncomplete === true;
	const defaults = record(value) && record(value.itemDefaults) ? value.itemDefaults : null;
	const word = codeWordAt(mirror.text, offset, language);
	const start = word && word.to === offset ? word.from : offset;
	// Servers such as tsserver return every name in scope; the typed prefix narrows them before the bound applies.
	const typed = mirror.text.slice(start, offset).toLowerCase();
	const rank = (item: Json) => {
		const text = String(item.filterText ?? item.label).toLowerCase();
		if (text.startsWith(typed)) return 0;
		let at = 0;
		for (const char of typed) {
			at = text.indexOf(char, at);
			if (at < 0) return -1;
			at++;
		}
		return 1;
	};
	const matching = list
		.filter(record)
		.filter((item) => typeof item.label === 'string')
		.map((item) => ({ item, rank: rank(item) }))
		.filter((entry) => entry.rank >= 0)
		.sort(
			(a, b) =>
				a.rank - b.rank ||
				String(a.item.sortText ?? a.item.label).localeCompare(
					String(b.item.sortText ?? b.item.label)
				) ||
				String(a.item.label).localeCompare(String(b.item.label))
		);
	const raw = matching.slice(0, codeLimits.completions).map((entry) => entry.item);
	const items = raw.map((item, id): CodeCompletion => {
		const edit = record(item.textEdit) ? item.textEdit : null;
		const range = edit
			? isRange(edit.range)
				? edit.range
				: isRange(edit.insert)
					? edit.insert
					: null
			: record(defaults?.editRange)
				? isRange(defaults.editRange)
					? defaults.editRange
					: isRange(defaults.editRange.insert)
						? defaults.editRange.insert
						: null
				: null;
		const place = range ? offsets(mirror, range) : { from: start, to: offset };
		const insert =
			edit && typeof edit.newText === 'string'
				? edit.newText
				: typeof item.insertText === 'string'
					? item.insertText
					: String(item.label);
		const detail =
			typeof item.detail === 'string'
				? item.detail
				: record(item.labelDetails) && typeof item.labelDetails.description === 'string'
					? item.labelDetails.description
					: undefined;
		const extra = edits(mirror, item.additionalTextEdits);
		return {
			id,
			label: String(item.label),
			kind: kinds[Number(item.kind)] ?? 'text',
			...(detail ? { detail: detail.slice(0, 500) } : {}),
			from: Math.min(place.from, offset),
			to: Math.max(place.to, offset),
			insert,
			...(extra.length ? { edits: extra } : {}),
			resolve: false,
		};
	});
	return { items, raw, incomplete: incomplete || matching.length > raw.length };
}
export function hover(
	mirror: TextMirror,
	value: unknown,
	offset: number,
	language?: string | null
): CodeHover | null {
	if (!record(value)) return null;
	const text = markdown(value.contents).trim();
	if (!text) return null;
	const word = codeWordAt(mirror.text, offset, language);
	const place = isRange(value.range)
		? offsets(mirror, value.range)
		: word
			? { from: word.from, to: word.to }
			: { from: offset, to: offset };
	return { ...place, markdown: bounded(text) };
}
export function signatures(value: unknown): CodeSignatureHelp | null {
	if (!record(value) || !Array.isArray(value.signatures) || !value.signatures.length) return null;
	const result: CodeSignatureHelp['signatures'] = [];
	for (const signature of value.signatures.slice(0, 20)) {
		if (!record(signature) || typeof signature.label !== 'string') continue;
		const label = signature.label;
		let cursor = 0;
		const parameters = (Array.isArray(signature.parameters) ? signature.parameters : [])
			.filter(record)
			.map((parameter) => {
				let from = -1,
					to = -1;
				if (
					Array.isArray(parameter.label) &&
					parameter.label.length === 2 &&
					parameter.label.every((n) => Number.isSafeInteger(n))
				)
					[from, to] = parameter.label as [number, number];
				else if (typeof parameter.label === 'string') {
					from = label.indexOf(parameter.label, cursor);
					to = from + parameter.label.length;
				}
				if (from >= 0) cursor = to;
				const documentation = bounded(markdown(parameter.documentation));
				return {
					from: Math.max(0, from),
					to: Math.max(0, to),
					...(documentation ? { documentation } : {}),
				};
			});
		const documentation = bounded(markdown(signature.documentation));
		result.push({
			label: label.slice(0, 2000),
			parameters,
			...(documentation ? { documentation } : {}),
		});
	}
	if (!result.length) return null;
	const active = Math.min(
		Number.isSafeInteger(value.activeSignature) ? (value.activeSignature as number) : 0,
		result.length - 1
	);
	const own = record(value.signatures[active])
		? (value.signatures[active] as Json).activeParameter
		: undefined;
	const activeParameter = Number.isSafeInteger(own)
		? (own as number)
		: Number.isSafeInteger(value.activeParameter)
			? (value.activeParameter as number)
			: 0;
	return { signatures: result, active: Math.max(0, active), activeParameter };
}
function fileLocation(uri: unknown, range: unknown): RawLocation | null {
	if (typeof uri !== 'string' || !uri.startsWith('file:') || !isRange(range)) return null;
	try {
		return {
			absolute: fileURLToPath(uri),
			line: range.start.line,
			character: range.start.character,
		};
	} catch {
		return null;
	}
}
export function locations(
	value: unknown,
	limit: number
): { locations: RawLocation[]; truncated: boolean } {
	const list = Array.isArray(value) ? value : value ? [value] : [];
	const result: RawLocation[] = [];
	const seen = new Set<string>();
	for (const item of list) {
		if (!record(item)) continue;
		const location =
			'targetUri' in item
				? fileLocation(item.targetUri, item.targetSelectionRange ?? item.targetRange)
				: fileLocation(item.uri, item.range);
		if (!location) continue;
		const key = `${location.absolute}:${location.line}:${location.character}`;
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(location);
	}
	return { locations: result.slice(0, limit), truncated: result.length > limit };
}
const severities = { 1: 'error', 2: 'warning', 3: 'info', 4: 'hint' } as const;
export function problems(mirror: TextMirror, value: unknown[]): CodeProblem[] {
	return value
		.filter(record)
		.filter((item) => isRange(item.range) && typeof item.message === 'string')
		.slice(0, codeLimits.problems)
		.map((item) => {
			const place = offsets(mirror, item.range as Range);
			const code =
				typeof item.code === 'string' || typeof item.code === 'number' ? ` (${item.code})` : '';
			return {
				...place,
				severity: severities[Number(item.severity) as 1 | 2 | 3 | 4] ?? 'error',
				message: String(item.message).slice(0, 4000),
				...(typeof item.source === 'string' ? { source: item.source.slice(0, 100) + code } : {}),
			};
		});
}
