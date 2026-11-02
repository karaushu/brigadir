/** File format by name for the Files tree icons (spec/task-window#files-look, the `Icons` sheet of the tree canvas). The order of the rules matters: names win over extensions. */
export type FileKind =
	| 'ts'
	| 'js'
	| 'react'
	| 'json'
	| 'md'
	| 'docker'
	| 'git'
	| 'env'
	| 'rc'
	| 'yml'
	| 'image'
	| 'shell'
	| 'lock'
	| 'text';
const byExtension: Record<string, FileKind> = {
	ts: 'ts',
	mts: 'ts',
	cts: 'ts',
	tsx: 'react',
	jsx: 'react',
	js: 'js',
	mjs: 'js',
	cjs: 'js',
	json: 'json',
	jsonc: 'json',
	json5: 'json',
	md: 'md',
	mdx: 'md',
	yml: 'yml',
	yaml: 'yml',
	toml: 'yml',
	png: 'image',
	jpg: 'image',
	jpeg: 'image',
	gif: 'image',
	webp: 'image',
	svg: 'image',
	ico: 'image',
	icns: 'image',
	sh: 'shell',
	bash: 'shell',
	zsh: 'shell',
};
export function fileKind(name: string): FileKind {
	const n = name.toLowerCase(),
		dot = n.lastIndexOf('.'),
		extension = dot > 0 ? n.slice(dot + 1) : '';
	if (n.startsWith('dockerfile') || n === '.dockerignore') return 'docker';
	if (n.startsWith('.git')) return 'git';
	if (n.startsWith('.env')) return 'env';
	if (
		n.endsWith('.lock') ||
		n === 'pnpm-lock.yaml' ||
		n === 'package-lock.json' ||
		n === 'bun.lockb'
	)
		return 'lock';
	if (n === '.editorconfig' || n === '.buckconfig' || (n.startsWith('.') && n.endsWith('rc')))
		return 'rc';
	return byExtension[extension] ?? 'text';
}
