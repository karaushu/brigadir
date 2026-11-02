import { accessSync, constants, existsSync } from 'node:fs';
import { lstat, readlink } from 'node:fs/promises';
import { delimiter, dirname, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
/** Only launch names live here. Capabilities always come from `initialize` (spec/editor-code-intelligence#architecture, rule 7). */
export type ServerCandidate = { binary: string; args: string[] };
/** spec/editor-code-intelligence#language-server-restart: the dependency folder at the server root and the files an install writes at its end. */
export type ServerInstalls = { folder: string; markers: string[] };
export type ServerDefinition = {
	id: string;
	name: string;
	languages: string[];
	candidates: ServerCandidate[];
	markers: string[];
	installs?: ServerInstalls;
	languageId(path: string): string;
};
const stdio = (binary: string, ...args: string[]): ServerCandidate => ({
	binary,
	args: args.length ? args : ['--stdio'],
});
export const typescriptServer: ServerDefinition = {
	id: 'typescript',
	name: 'TypeScript',
	languages: ['javascript', 'typescript', 'tsx'],
	candidates: [],
	markers: [],
	installs: {
		folder: 'node_modules',
		markers: [
			'node_modules/.package-lock.json',
			'node_modules/.modules.yaml',
			'node_modules/.yarn-state.yml',
			'node_modules/.yarn-integrity',
			'.yarn/install-state.gz',
		],
	},
	languageId: (path) =>
		/\.tsx$/i.test(path)
			? 'typescriptreact'
			: /\.[mc]?tsx?$/i.test(path)
				? 'typescript'
				: /\.jsx$/i.test(path)
					? 'javascriptreact'
					: 'javascript',
};
export const serverDefinitions: readonly ServerDefinition[] = [
	typescriptServer,
	{
		id: 'python',
		name: 'Python',
		languages: ['python'],
		candidates: [
			stdio('basedpyright-langserver'),
			stdio('pyright-langserver'),
			{ binary: 'pylsp', args: [] },
		],
		markers: ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt'],
		languageId: () => 'python',
	},
	{
		id: 'go',
		name: 'Go',
		languages: ['go'],
		candidates: [{ binary: 'gopls', args: [] }],
		markers: ['go.work', 'go.mod'],
		languageId: () => 'go',
	},
	{
		id: 'rust',
		name: 'Rust',
		languages: ['rust'],
		candidates: [{ binary: 'rust-analyzer', args: [] }],
		markers: ['Cargo.toml'],
		languageId: () => 'rust',
	},
	{
		id: 'cpp',
		name: 'C/C++',
		languages: ['cpp'],
		candidates: [{ binary: 'clangd', args: [] }],
		markers: ['compile_commands.json', 'CMakeLists.txt'],
		languageId: (path) => (/\.(c|h)$/i.test(path) ? 'c' : 'cpp'),
	},
	{
		id: 'ruby',
		name: 'Ruby',
		languages: ['ruby'],
		candidates: [{ binary: 'ruby-lsp', args: [] }, stdio('solargraph', 'stdio')],
		markers: ['Gemfile'],
		languageId: () => 'ruby',
	},
	{
		id: 'css',
		name: 'CSS',
		languages: ['css', 'scss'],
		candidates: [stdio('vscode-css-language-server')],
		markers: [],
		languageId: (path) => (/\.scss$/i.test(path) ? 'scss' : 'css'),
	},
	{
		id: 'bash',
		name: 'Bash',
		languages: ['bash'],
		candidates: [stdio('bash-language-server', 'start')],
		markers: [],
		languageId: () => 'shellscript',
	},
	{
		id: 'php',
		name: 'PHP',
		languages: ['php'],
		candidates: [stdio('intelephense'), stdio('phpactor', 'language-server')],
		markers: ['composer.json'],
		languageId: () => 'php',
	},
];
export function serverFor(language: string | null) {
	return language
		? (serverDefinitions.find((server) => server.languages.includes(language)) ?? null)
		: null;
}
/** Finder-launched apps get a minimal PATH, so well-known tool directories follow the app's own PATH. */
export function serverSearchPath(path = process.env.PATH ?? '', home = homedir()) {
	const extra = [
		'/opt/homebrew/bin',
		'/usr/local/bin',
		join(home, '.cargo/bin'),
		join(home, 'go/bin'),
		join(home, '.local/bin'),
	];
	return [...new Set([...path.split(delimiter).filter(Boolean), ...extra])].join(delimiter);
}
export function findExecutable(binary: string, searchPath: string) {
	for (const directory of searchPath.split(delimiter).filter(Boolean)) {
		const command = resolve(directory, binary);
		try {
			accessSync(command, constants.X_OK);
			return command;
		} catch {
			/* next directory */
		}
	}
	return null;
}
const inside = (root: string, path: string) => {
	const rest = relative(root, path);
	return rest === '' || (!rest.startsWith('..') && !rest.startsWith(sep) && rest !== '..');
};
/** Nearest ancestor with a marker, bounded by the project root; the project root otherwise. */
export function workspaceRoot(definition: ServerDefinition, file: string, projectRoot: string) {
	if (!definition.markers.length) return projectRoot;
	for (
		let directory = dirname(file);
		inside(projectRoot, directory);
		directory = dirname(directory)
	) {
		if (definition.markers.some((marker) => existsSync(join(directory, marker)))) return directory;
		if (directory === projectRoot || dirname(directory) === directory) break;
	}
	return projectRoot;
}
/** The project's own TypeScript first, searched upward from the file; the bundled one otherwise. */
export function projectTsserver(file: string, projectRoot: string) {
	for (
		let directory = dirname(file);
		inside(projectRoot, directory);
		directory = dirname(directory)
	) {
		const candidate = join(directory, 'node_modules/typescript/lib/tsserver.js');
		if (existsSync(candidate)) return candidate;
		if (directory === projectRoot || dirname(directory) === directory) break;
	}
	return null;
}
/** spec/editor-code-intelligence#language-server-restart: the folder by kind, inode and link target (its mtime moves with every cache folder), markers by content. */
export async function installStamp(root: string, installs: ServerInstalls) {
	const parts: string[] = [];
	let folder = false,
		marker = false;
	for (const path of [installs.folder, ...installs.markers]) {
		const absolute = join(root, path);
		const info = await lstat(absolute).catch(() => null);
		if (!info) {
			parts.push('');
			continue;
		}
		if (path === installs.folder) {
			folder = true;
			const link = info.isSymbolicLink() ? await readlink(absolute).catch(() => '') : '';
			parts.push(`${info.isSymbolicLink() ? 'link' : 'dir'}:${info.ino}:${link}`);
		} else {
			marker = true;
			parts.push(`${info.ino}:${info.mtimeMs}:${info.size}`);
		}
	}
	return { stamp: parts.join('\n'), folder, marker };
}
