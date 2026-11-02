import { isRecord } from './workspace';
import { isRelativeFolder } from './project-commands';

/** spec/search-menus-and-commands#package-scripts: the package manager a script line starts with. */
export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';
export type PackageScript = { name: string; body: string };
/** One `package.json` of a repo: `repo` is relative to the project root, `directory` to the repo (`''` = its root). */
export type PackageScripts = {
	repo: string;
	directory: string;
	manager: PackageManager;
	scripts: PackageScript[];
};
export type ProjectScripts = { repos: string[]; packages: PackageScripts[] };
export const packageFileLimit = 64;
export const packageScriptLimit = 200;
export const packageManagers: readonly PackageManager[] = ['npm', 'pnpm', 'yarn', 'bun'];
/** The lock files that name a manager, checked in this order in each folder from the package up to the repo root. */
export const lockFiles: readonly (readonly [string, PackageManager])[] = [
	['pnpm-lock.yaml', 'pnpm'],
	['yarn.lock', 'yarn'],
	['bun.lock', 'bun'],
	['bun.lockb', 'bun'],
	['package-lock.json', 'npm'],
];

export const isPackageJsonPath = (path: string) => /(^|\/)package\.json$/.test(path);

/** The `scripts` of a parsed `package.json`: string pairs only, in file order. */
export function packageScripts(json: unknown): PackageScript[] {
	if (!isRecord(json) || !isRecord(json.scripts)) return [];
	return Object.entries(json.scripts)
		.filter(
			(entry): entry is [string, string] =>
				typeof entry[1] === 'string' && entry[0].trim().length > 0 && entry[0].length <= 80
		)
		.slice(0, packageScriptLimit)
		.map(([name, body]) => ({ name, body }));
}
/** `packageManager: "pnpm@9.1.0"` → pnpm; anything else is no answer. */
export function declaredManager(json: unknown): PackageManager | null {
	if (!isRecord(json) || typeof json.packageManager !== 'string') return null;
	const name = json.packageManager.split('@')[0] as PackageManager;
	return packageManagers.includes(name) ? name : null;
}
/** spec/search-menus-and-commands#package-scripts: `pnpm run dev`; a name with anything but letters, digits and `_ - : . / @` is single-quoted. */
export function scriptLine(manager: PackageManager, name: string) {
	const quoted = /^[\p{L}\p{N}_\-:./@]+$/u.test(name) ? name : `'${name.replaceAll("'", `'\\''`)}'`;
	return `${manager} run ${quoted}`;
}

/** spec/search-menus-and-commands#package-scripts: the name of the top-level `scripts` pair on the line at `offset`, or null. JSONC comments are skipped. */
export function scriptAt(text: string, offset: number): string | null {
	const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
	const next = text.indexOf('\n', offset);
	const lineEnd = next === -1 ? text.length : next;
	// The path of keys down to the current value; `key` is the last string read where a key may stand.
	const stack: { kind: '{' | '['; key: string | null }[] = [];
	let key: string | null = null,
		expectKey = false;
	for (let i = 0; i < text.length && i < lineEnd; i++) {
		const char = text[i]!;
		if (char === '"') {
			let end = i + 1;
			while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
			const value = text.slice(i, end + 1);
			if (expectKey) {
				let parsed: string | null = null;
				try {
					parsed = JSON.parse(value) as string;
				} catch {}
				key = parsed;
				const top = stack.at(-1);
				if (
					parsed !== null &&
					i >= lineStart &&
					stack.length === 2 &&
					top?.kind === '{' &&
					stack[0]!.kind === '{' &&
					stack[1]!.key === 'scripts'
				)
					return parsed;
			}
			i = end;
			continue;
		}
		if (char === '/' && text[i + 1] === '/') {
			const end = text.indexOf('\n', i);
			i = end === -1 ? text.length : end - 1;
			continue;
		}
		if (char === '/' && text[i + 1] === '*') {
			const end = text.indexOf('*/', i + 2);
			i = end === -1 ? text.length : end + 1;
			continue;
		}
		if (char === '{' || char === '[') {
			stack.push({ kind: char, key: stack.at(-1)?.kind === '{' ? key : null });
			key = null;
			expectKey = char === '{';
		} else if (char === '}' || char === ']') {
			stack.pop();
			expectKey = false;
		} else if (char === ',') expectKey = stack.at(-1)?.kind === '{';
		else if (char === ':') expectKey = false;
	}
	return null;
}

function isPackageScripts(value: unknown): value is PackageScripts {
	return (
		isRecord(value) &&
		isRelativeFolder(value.repo) &&
		isRelativeFolder(value.directory) &&
		packageManagers.includes(value.manager as PackageManager) &&
		Array.isArray(value.scripts) &&
		value.scripts.length <= packageScriptLimit &&
		value.scripts.every(
			(script) =>
				isRecord(script) && typeof script.name === 'string' && typeof script.body === 'string'
		)
	);
}
export function isProjectScripts(value: unknown): value is ProjectScripts {
	return (
		isRecord(value) &&
		Array.isArray(value.repos) &&
		value.repos.every(isRelativeFolder) &&
		Array.isArray(value.packages) &&
		value.packages.every(isPackageScripts)
	);
}
/** The repo of a project-relative folder: the longest repo it lies in (`''` is the project root). */
export function repoOf(repos: string[], folder: string) {
	return (
		repos
			.filter((repo) => repo === '' || folder === repo || folder.startsWith(`${repo}/`))
			.sort((a, b) => b.length - a.length)[0] ?? ''
	);
}
