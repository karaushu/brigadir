/**
 * spec/editor#indentation: one answer to «how does this file indent» for the editor, the language server and Settings.
 * Pure: the project's config comes from main (Prettier, `.editorconfig`), the document text from the caller.
 */
export const indentStyles = ['auto', 'tabs', 'spaces'] as const;
export type IndentStyle = (typeof indentStyles)[number];
/** Widths offered in Settings; any 1…16 read from a project config is honoured. */
export const indentWidths = [2, 3, 4, 6, 8] as const;
export const defaultIndentSize = 2;
export const defaultTabWidth = 4;
export const isIndentWidth = (value: unknown): value is number =>
	typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 16;
export type IndentSource = 'prettier' | 'editorconfig' | 'setting' | 'detected' | 'default';
/** `tabWidth` `auto` takes the project's width and falls back to 4; a number is the user's own width of a tab on screen. */
export type IndentSettings = {
	indentStyle: IndentStyle;
	indentSize: number;
	tabWidth: number | 'auto';
};
/** What a project's config says for one file; every field is optional, an absent one is «not configured». */
export type ProjectIndent = {
	source: 'prettier' | 'editorconfig';
	useTabs?: boolean;
	tabWidth?: number;
	indentSize?: number;
};
export type DetectedIndent = { style: 'tabs' | 'spaces'; size: number | null };
/** `configTabWidth` is the width the project's own tools use (Prettier's `tabWidth`); the language server formats with it, whatever is shown. */
export type ResolvedIndent = {
	insertSpaces: boolean;
	indentSize: number;
	tabWidth: number;
	configTabWidth: number;
	styleSource: IndentSource;
	sizeSource: IndentSource;
	widthSource: IndentSource;
};
/** Indentation of the first-level code lines of `text`: tabs when they lead more lines than spaces; the space step is the most common rise. */
export function detectIndent(text: string): DetectedIndent | null {
	let tabs = 0,
		spaces = 0,
		smallest = 0,
		previous = 0;
	const rises = new Map<number, number>();
	for (const match of text.slice(0, 64000).matchAll(/^([ \t]*)(\S?)/gm)) {
		const indent = match[1]!,
			first = match[2]!;
		if (!first) continue;
		if (indent.startsWith('\t')) {
			tabs++;
			previous = 0;
			continue;
		}
		// ` * text` and ` */` continue a block comment one column in; they are not code levels.
		if (indent.length === 1 && first === '*') continue;
		if (indent.length > 0) {
			spaces++;
			if (indent.length >= 2 && indent.length <= 8 && (smallest === 0 || indent.length < smallest))
				smallest = indent.length;
			const rise = indent.length - previous;
			if (rise >= 2 && rise <= 8) rises.set(rise, (rises.get(rise) ?? 0) + 1);
		}
		previous = indent.length;
	}
	if (tabs === 0 && spaces === 0) return null;
	if (tabs > spaces) return { style: 'tabs', size: null };
	let step = 0,
		best = 0;
	for (const [rise, count] of rises)
		if (count > best || (count === best && rise < step)) {
			step = rise;
			best = count;
		}
	return { style: 'spaces', size: step || smallest || null };
}
/**
 * Style: project config → explicit setting → content → spaces. Width of a tab on screen: an explicit Settings number → project config → 4.
 * Size of a level (spaces): project config → explicit `spaces` → content → language default → setting.
 */
export function resolveIndent(input: {
	settings: IndentSettings;
	project?: ProjectIndent | null;
	detected?: DetectedIndent | null;
	languageSize?: number | null;
}): ResolvedIndent {
	const { settings, project, detected } = input;
	const styleSource: IndentSource =
		project?.useTabs !== undefined
			? project.source
			: settings.indentStyle !== 'auto'
				? 'setting'
				: detected
					? 'detected'
					: 'default';
	const tabs =
		project?.useTabs !== undefined
			? project.useTabs
			: settings.indentStyle !== 'auto'
				? settings.indentStyle === 'tabs'
				: detected?.style === 'tabs';
	const configTabWidth =
		project?.tabWidth ?? (settings.tabWidth === 'auto' ? defaultTabWidth : settings.tabWidth);
	// The width of a tab on screen is the user's: a number in Settings beats the project's config; `auto` follows it.
	const widthSource: IndentSource =
		settings.tabWidth !== 'auto'
			? 'setting'
			: project?.tabWidth !== undefined
				? project.source
				: 'default';
	const tabWidth = settings.tabWidth !== 'auto' ? settings.tabWidth : configTabWidth;
	let indentSize: number, sizeSource: IndentSource;
	if (tabs) {
		indentSize = tabWidth;
		sizeSource = widthSource;
	} else if (project?.indentSize !== undefined || project?.tabWidth !== undefined) {
		indentSize = project.indentSize ?? project.tabWidth!;
		sizeSource = project.source;
	} else if (settings.indentStyle === 'spaces') {
		indentSize = settings.indentSize;
		sizeSource = 'setting';
	} else if (detected?.size) {
		indentSize = detected.size;
		sizeSource = 'detected';
	} else if (!detected && input.languageSize) {
		indentSize = input.languageSize;
		sizeSource = 'default';
	} else {
		indentSize = settings.indentSize;
		sizeSource = 'setting';
	}
	return {
		insertSpaces: !tabs,
		indentSize,
		tabWidth,
		configTabWidth,
		styleSource,
		sizeSource,
		widthSource,
	};
}
/** The language default of an unindented file in `Auto`: PEP 8 asks for four. */
export const languageIndentSize = (language: string | null): number | null =>
	language === 'python' ? 4 : null;
/** The `indentUnit` string CodeMirror wants. */
export const indentUnitString = (resolved: ResolvedIndent) =>
	resolved.insertSpaces ? ' '.repeat(resolved.indentSize) : '\t';
