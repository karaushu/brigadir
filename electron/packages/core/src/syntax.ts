export type SyntaxKind =
	'keyword' | 'string' | 'comment' | 'number' | 'type' | 'function' | 'property';
export type SyntaxToken = { from: number; to: number; kind: SyntaxKind };
export type SyntaxSymbol = { from: number; to: number; start: number; end: number; path: string };
export type SyntaxSnapshot = {
	status: 'ready' | 'plain' | 'large' | 'failed';
	language: string | null;
	tokens: SyntaxToken[];
	symbols: SyntaxSymbol[];
};
export const syntaxLimit = 5 * 1024 * 1024;
export function syntaxLanguage(path: string): string | null {
	const ext = path.split('.').at(-1)?.toLowerCase();
	return (
		(
			{
				js: 'javascript',
				jsx: 'javascript',
				mjs: 'javascript',
				cjs: 'javascript',
				ts: 'typescript',
				mts: 'typescript',
				cts: 'typescript',
				tsx: 'tsx',
				css: 'css',
				scss: 'scss',
				py: 'python',
				sh: 'bash',
				bash: 'bash',
				rs: 'rust',
				go: 'go',
				rb: 'ruby',
				java: 'java',
				c: 'cpp',
				h: 'cpp',
				cpp: 'cpp',
				hpp: 'cpp',
				cs: 'c-sharp',
				php: 'php',
				ini: 'ini',
				json: 'json',
				jsonc: 'json',
				ps1: 'powershell',
			} as Record<string, string>
		)[ext ?? ''] ?? null
	);
}
/** spec/editor#markdown-views: Markdown has no grammar here (no tree-sitter-markdown.wasm), so it is not a syntax language: the LSP and the
 *  syntax worker keep ignoring it. The editor names it and offers the preview by this check. */
export function isMarkdownPath(path: string): boolean {
	return /\.(md|markdown)$/i.test(path);
}
/** The language the editor footer names: the syntax language, else Markdown. */
export function documentLanguage(path: string): string | null {
	return syntaxLanguage(path) ?? (isMarkdownPath(path) ? 'markdown' : null);
}
export function enclosingSymbol(
	symbols: SyntaxSymbol[],
	start: number,
	end: number
): SyntaxSymbol | null {
	return (
		symbols
			.filter((s) => s.start <= start && s.end >= end)
			.sort((a, b) => a.to - a.from - (b.to - b.from))[0] ?? null
	);
}

/** Markdown language labels map only to grammars already supported by file views. */
export function syntaxFencePath(label: string): string {
	const language = label.trim().toLowerCase().split(/\s+/)[0] ?? '';
	if (!/^[a-z0-9_+#-]+$/.test(language)) return 'code.txt';
	const ext =
		(
			{
				javascript: 'js',
				typescript: 'ts',
				python: 'py',
				shell: 'sh',
				shellscript: 'sh',
				bash: 'sh',
				zsh: 'sh',
				rust: 'rs',
				golang: 'go',
				ruby: 'rb',
				'c++': 'cpp',
				'c#': 'cs',
				'c-sharp': 'cs',
				csharp: 'cs',
				powershell: 'ps1',
				jsonc: 'json',
			} as Record<string, string>
		)[language] ?? language;
	return syntaxLanguage(`code.${ext}`) ? `code.${ext}` : 'code.txt';
}
