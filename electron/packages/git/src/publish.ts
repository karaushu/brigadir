import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { isRecord, type Scope, type GitPublishState } from '@brigadir/core';
import { git, gitText, isSha } from './command';
import { gitDir } from './scopes';
// «The submodule pointer is on some remote branch» depends only on the commit and the submodule's remote refs. Git writes
// a ref as a new file through lock and rename (loose, packed-refs, reftable tables.list), so the stat of those files is their
// version: a Forge read with no fetch or push skips walking the `branch -r --contains` graph. An unknown format, over 5000
// ref files or a change during the read — no cache.
const contained = new Map<string, { refs: string; value: boolean }>();
async function remoteRefs(path: string): Promise<string | null> {
	const dir = await gitDir(path);
	if (!dir) return null;
	let common = dir;
	try {
		common = resolve(dir, (await readFile(join(dir, 'commondir'), 'utf8')).trim());
	} catch (error) {
		if (!isRecord(error) || error.code !== 'ENOENT') return null;
	}
	const parts: string[] = [];
	let budget = 5000;
	const stat = async (file: string) => {
		try {
			const value = await lstat(file, { bigint: true });
			parts.push(
				`${relative(common, file)}:${value.ino}:${value.mtimeNs}:${value.ctimeNs}:${value.size}`
			);
			return value;
		} catch (error) {
			if (isRecord(error) && error.code === 'ENOENT') {
				parts.push(`${relative(common, file)}:-`);
				return null;
			}
			throw error;
		}
	};
	const walk = async (folder: string): Promise<void> => {
		for (const entry of (await readdir(folder, { withFileTypes: true }).catch(() => [])).sort(
			(a, b) => (a.name < b.name ? -1 : 1)
		)) {
			if (--budget < 0) throw new Error('Too many refs');
			const file = join(folder, entry.name);
			await stat(file);
			if (entry.isDirectory()) await walk(file);
		}
	};
	try {
		await stat(join(common, 'packed-refs'));
		await stat(join(common, 'reftable', 'tables.list'));
		await stat(join(common, 'refs', 'remotes'));
		await walk(join(common, 'refs', 'remotes'));
	} catch {
		return null;
	}
	return parts.join('\n');
}
async function onRemote(path: string, pointer: string): Promise<boolean> {
	const key = `${path}\0${pointer}`,
		refs = await remoteRefs(path),
		hit = contained.get(key);
	if (refs && hit?.refs === refs) {
		contained.delete(key);
		contained.set(key, hit);
		return hit.value;
	}
	const value = Boolean(
		await gitText(path, ['branch', '-r', '--contains', pointer]).catch(() => '')
	);
	if (refs && refs === (await remoteRefs(path))) {
		contained.delete(key);
		contained.set(key, { refs, value });
		while (contained.size > 256) contained.delete(contained.keys().next().value!);
	}
	return value;
}
async function resolveRef(cwd: string, ref: string) {
	try {
		const value = await gitText(cwd, ['rev-parse', '--verify', '--quiet', '--end-of-options', ref]);
		return isSha(value) ? value : null;
	} catch {
		return null;
	}
}
export async function publishState(
	scope: Scope,
	scopes: Scope[],
	base: string | null
): Promise<GitPublishState> {
	const [branch, head, remote, pushRemote, status] = await Promise.all([
		gitText(scope.path, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => null),
		resolveRef(scope.path, 'HEAD'),
		gitText(scope.path, ['remote', 'get-url', 'origin']).catch(() => null),
		gitText(scope.path, ['remote', 'get-url', '--push', 'origin']).catch(() => null),
		gitText(scope.path, ['status', '--porcelain', '--untracked-files=normal']),
	]);
	const remoteRef = branch ? await resolveRef(scope.path, `refs/remotes/origin/${branch}`) : null,
		remoteBase = base ? await resolveRef(scope.path, `refs/remotes/origin/${base}`) : null,
		localBase = base && !remoteBase ? await resolveRef(scope.path, `refs/heads/${base}`) : null,
		baseSha = remoteBase ?? localBase;
	const baseRef = remoteBase ? `origin/${base}` : localBase ? base : null,
		from = remoteRef ?? baseSha;
	const ahead =
			head && baseSha
				? Number(await gitText(scope.path, ['rev-list', '--count', `${baseSha}..${head}`]))
				: 0,
		pushAhead =
			head && from
				? Number(await gitText(scope.path, ['rev-list', '--count', `${from}..${head}`]))
				: 0;
	const log =
			head && from
				? await git(scope.path, [
						'log',
						'--format=%H%x00%s%x00',
						'--max-count=100',
						`${from}..${head}`,
					])
				: Buffer.alloc(0),
		parts = log.toString('utf8').split('\0'),
		commits = [];
	for (let i = 0; i < parts.length - 1; i += 2) {
		const sha = parts[i]!.trim();
		if (isSha(sha)) commits.push({ sha, subject: parts[i + 1]! });
	}
	const warnings: string[] = [];
	if (head)
		for (const child of scopes.filter(
			(child) => child.kind === 'submodule' && child.path.startsWith(`${scope.path}/`)
		)) {
			const path = relative(scope.path, child.path),
				pointer = await resolveRef(scope.path, `${head}:${path}`);
			if (pointer && !(await onRemote(child.path, pointer))) warnings.push(path);
		}
	return {
		branch,
		head,
		remote,
		pushRemote,
		base,
		baseRef,
		dirty: Boolean(status),
		ahead,
		pushAhead,
		published: Boolean(remoteRef),
		commits,
		warnings,
	};
}
export async function pushReviewed(scope: Scope, state: GitPublishState) {
	if (!state.branch || !state.head || !state.remote || !state.pushRemote)
		throw new Error('A branch and origin remote are required');
	const [head, remote, pushRemote, branch] = await Promise.all([
		resolveRef(scope.path, 'HEAD'),
		gitText(scope.path, ['remote', 'get-url', 'origin']),
		gitText(scope.path, ['remote', 'get-url', '--push', 'origin']),
		gitText(scope.path, ['symbolic-ref', '--short', 'HEAD']),
	]);
	if (
		head !== state.head ||
		branch !== state.branch ||
		remote !== state.remote ||
		pushRemote !== state.pushRemote
	)
		throw new Error('The branch or remote changed. Review the push again.');
	await git(
		scope.path,
		['push', '--porcelain', '--', 'origin', `${state.head}:refs/heads/${state.branch}`],
		{ env: { GIT_TERMINAL_PROMPT: '0' } }
	);
	// The explicit SHA refspec can never pick up an unseen newer commit. Set the
	// branch's tracking config only after the reviewed commit was accepted remotely.
	await git(scope.path, ['config', `branch.${state.branch}.remote`, 'origin']);
	await git(scope.path, ['config', `branch.${state.branch}.merge`, `refs/heads/${state.branch}`]);
}
