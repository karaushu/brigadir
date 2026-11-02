import { dirname, relative, sep } from 'node:path';
import ts from 'typescript';
import type { CodeChange } from '@brigadir/core';

/** Explicit ESM files run without a bundler. The server's inferred project defaults to bundler resolution,
 * which can generate extensionless relative imports even in .mjs. Correct only generated import declarations;
 * leave existing imports, package specifiers and configured TS/React files to the language server.
 */
export function esmImportEdits(absolute: string, edits: CodeChange[]): CodeChange[] {
	if (!/\.m[jt]s$/i.test(absolute)) return edits;
	return edits.map((edit) => {
		if (!edit.insert.includes('import')) return edit;
		const source = ts.createSourceFile(absolute, edit.insert, ts.ScriptTarget.Latest, true);
		const changes: CodeChange[] = [];
		for (const statement of source.statements) {
			if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
				continue;
			const specifier = statement.moduleSpecifier;
			if (!/^\.{1,2}\//.test(specifier.text) || /\.(?:[cm]?[jt]sx?|json)$/i.test(specifier.text))
				continue;
			const resolved = ts.resolveModuleName(
				specifier.text,
				absolute,
				{
					moduleResolution: ts.ModuleResolutionKind.Bundler,
					allowJs: true,
				},
				ts.sys
			).resolvedModule;
			if (
				!resolved ||
				resolved.isExternalLibraryImport ||
				/\.d\.[cm]?ts$/i.test(resolved.resolvedFileName)
			)
				continue;
			let path = relative(dirname(absolute), resolved.resolvedFileName).split(sep).join('/');
			path = path
				.replace(/\.mts$/i, '.mjs')
				.replace(/\.cts$/i, '.cjs')
				.replace(/\.tsx?$/i, '.js');
			if (!path.startsWith('.')) path = './' + path;
			const quote = specifier.getText(source)[0]!;
			path = path.replaceAll('\\', '\\\\').replaceAll(quote, '\\' + quote);
			changes.push({ from: specifier.getStart(source) + 1, to: specifier.end - 1, insert: path });
		}
		let insert = edit.insert;
		for (const change of changes.reverse())
			insert = insert.slice(0, change.from) + change.insert + insert.slice(change.to);
		return insert === edit.insert ? edit : { ...edit, insert };
	});
}
