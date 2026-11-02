import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { findPrettier, type PrettierPool } from '@brigadir/lsp';
import {
	detectIndent,
	editorConfigIndent,
	languageIndentSize,
	resolveIndent,
	syntaxLanguage,
	type AppSettings,
	type ProjectIndent,
	type ResolvedIndent,
} from '@brigadir/core';
const inside = (root: string, path: string) => {
	const rest = relative(root, path);
	return rest === '' || (!rest.startsWith('..') && !rest.startsWith(sep));
};
/**
 * spec/editor#indentation: `.editorconfig` files from the file's directory up to the project root, stopping at the file's own git root
 * (the same bound as `.prettierignore`, spec/editor-code-intelligence#format-on-save), each with the file's path relative to it. A `root = true` file ends the
 * climb later, in the parser.
 */
export async function readEditorConfigs(
	file: string,
	projectRoot: string
): Promise<{ text: string; relative: string }[]> {
	const found: { text: string; relative: string }[] = [];
	for (
		let directory = dirname(file);
		inside(projectRoot, directory);
		directory = dirname(directory)
	) {
		const candidate = join(directory, '.editorconfig');
		if (existsSync(candidate)) {
			try {
				found.push({
					text: await readFile(candidate, 'utf8'),
					relative: relative(directory, file).split(sep).join('/'),
				});
			} catch {
				/* unreadable: as if absent */
			}
		}
		if (
			directory === projectRoot ||
			existsSync(join(directory, '.git')) ||
			dirname(directory) === directory
		)
			break;
	}
	return found;
}
/** What the project's config says about the indentation of `file`: Prettier's own answer, else `.editorconfig`; null when neither speaks. */
export async function projectIndent(
	pool: Pick<PrettierPool, 'indent'>,
	file: string,
	projectRoot: string
): Promise<ProjectIndent | null> {
	const prettier = findPrettier(file, projectRoot);
	if (prettier) {
		const answer = await pool.indent(prettier.directory, file);
		if (answer) return answer;
	}
	return editorConfigIndent(await readEditorConfigs(file, projectRoot));
}
/** The answer for one document: config → settings → content (spec/editor#indentation). */
export function resolveFor(
	settings: AppSettings['editor'],
	project: ProjectIndent | null,
	file: string,
	text: string
): ResolvedIndent {
	return resolveIndent({
		settings,
		project,
		detected: detectIndent(text),
		languageSize: languageIndentSize(syntaxLanguage(file)),
	});
}
/** `textDocument/formatting` options: a level of spaces is `tabSize`; with tabs it is the project's width of a tab (never the shown one, so formatting agrees with Prettier). */
export const lspIndent = (resolved: ResolvedIndent) => ({
	tabSize: resolved.insertSpaces ? resolved.indentSize : resolved.configTabWidth,
	insertSpaces: resolved.insertSpaces,
});
