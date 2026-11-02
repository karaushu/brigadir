import { access, readFile, realpath } from 'node:fs/promises';
import { join, posix, relative, sep } from 'node:path';
import { discoverScopes, git } from '@brigadir/git';
import {
	declaredManager,
	lockFiles,
	packageFileLimit,
	packageScripts,
	type PackageManager,
	type PackageScripts,
	type ProjectScripts,
} from '@brigadir/core';

/** spec/search-menus-and-commands#package-scripts: `packageManager` of the file, else the first lock file from its folder up to the repo root, else npm. */
export async function packageManagerAt(
	repoPath: string,
	directory: string,
	json: unknown
): Promise<PackageManager> {
	const declared = declaredManager(json);
	if (declared) return declared;
	for (let folder = directory; ; folder = posix.dirname(folder)) {
		for (const [file, manager] of lockFiles)
			if (
				await access(join(repoPath, folder === '.' ? '' : folder, file)).then(
					() => true,
					() => false
				)
			)
				return manager;
		if (folder === '' || folder === '.') return 'npm';
	}
}
/** The `package.json` folders of a repo, relative to it: what Git lists (tracked and untracked, not ignored), or the root. */
async function packageFolders(repoPath: string, isGit: boolean): Promise<string[]> {
	if (!isGit) return [''];
	const output = await git(
		repoPath,
		[
			'ls-files',
			'-z',
			'--cached',
			'--others',
			'--exclude-standard',
			'--',
			':(glob)**/package.json',
		],
		{ maxBytes: 4 << 20, timeoutMs: 8000 }
	).catch(() => null);
	if (!output) return [''];
	return [
		...new Set(
			output
				.toString('utf8')
				.split('\0')
				.filter((path) => path && posix.basename(path) === 'package.json')
				.filter((path) => !path.split('/').includes('node_modules'))
				.map((path) => (posix.dirname(path) === '.' ? '' : posix.dirname(path)))
		),
	]
		.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
		.slice(0, packageFileLimit);
}
async function readPackage(
	repoPath: string,
	repo: string,
	directory: string
): Promise<PackageScripts | null> {
	let json: unknown;
	try {
		json = JSON.parse(await readFile(join(repoPath, directory, 'package.json'), 'utf8'));
	} catch {
		return null;
	}
	const scripts = packageScripts(json);
	if (!scripts.length) return null;
	return {
		repo,
		directory,
		manager: await packageManagerAt(repoPath, directory, json),
		scripts,
	};
}
/** spec/search-menus-and-commands#package-scripts: every repo of the project (relative to its root) and the scripts of their `package.json` files. */
export async function readProjectScripts(projectPath: string): Promise<ProjectScripts> {
	const root = await realpath(projectPath);
	const scopes = await discoverScopes(root).catch(() => []);
	const repos = scopes.map((scope) => ({
		path: scope.path,
		repo: relative(root, scope.path).split(sep).join('/'),
		git: true,
	}));
	if (!repos.some((item) => item.repo === '')) repos.unshift({ path: root, repo: '', git: false });
	const packages: PackageScripts[] = [];
	for (const item of repos) {
		for (const directory of await packageFolders(item.path, item.git)) {
			if (packages.length >= packageFileLimit) break;
			const found = await readPackage(item.path, item.repo, directory);
			if (found) packages.push(found);
		}
	}
	return { repos: repos.map((item) => item.repo), packages };
}
