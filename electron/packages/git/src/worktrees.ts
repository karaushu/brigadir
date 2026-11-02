import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, open, realpath, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { isRecord, validBranch, type ScopeKind, type TaskKey } from '@brigadir/core';
import {
	atomicJson,
	readDocument,
	safePath,
	type ProcessCoordinator,
	type SessionStore,
} from '@brigadir/persistence';
import { git, gitText, GitError } from './command';
import { discoverScopes, worktreePaths } from './scopes';

/** `copyEnvFiles` (spec/git#worktree-env): ignored `.env*` files of every repo go into the new worktree before the setup command. */
export type WorktreeOptions = {
	branch: string;
	baseRef: string;
	scopeIds?: string[];
	setupCommand?: string;
	copyEnvFiles?: boolean;
};
type Repository = {
	source: string;
	relativePath: string;
	kind: 'root' | 'submodule' | 'nested' | 'worktree';
	ready: boolean;
	removed?: boolean;
};
export type WorktreeState = {
	schemaVersion: 1;
	branch: string;
	baseRef: string;
	root: string;
	repositories: Repository[];
	setupCommand: string;
	setupOwner?: { pid: number; processStart: string };
	state: 'preparing' | 'ready' | 'failed';
	step: string;
	error?: string;
};
const inside = (root: string, path: string) => path === root || path.startsWith(`${root}/`);
const inRootKind = (kind: ScopeKind): kind is Repository['kind'] =>
	kind === 'root' || kind === 'submodule' || kind === 'nested' || kind === 'worktree';
const validRef = (ref: string) =>
	!!ref && ref.length <= 240 && !ref.startsWith('-') && !/[\s\0]/.test(ref);

/** Crash-retryable preparation outside source repositories. No shell interpolation for Git. */
export class Worktrees {
	constructor(
		private store: SessionStore,
		private processes: Pick<ProcessCoordinator, 'transaction' | 'run' | 'identity'>
	) {}
	private async location(key: TaskKey) {
		await this.store.task(key);
		return safePath(this.store.root, 'worktrees', key.projectId, key.id);
	}
	private async file(key: TaskKey) {
		return safePath(await this.store.taskDir(key), 'worktree.json');
	}
	/** spec/tasks#delete-task: the branch a removed worktree leaves behind; the next preparation of this task may take it again. */
	private async released(key: TaskKey): Promise<string | null> {
		try {
			const doc = await readDocument(
				await safePath(await this.store.taskDir(key), 'worktree-released.json')
			);
			return typeof doc.branch === 'string' && validBranch(doc.branch) ? doc.branch : null;
		} catch (error) {
			if (isRecord(error) && error.code === 'ENOENT') return null;
			throw error;
		}
	}
	async read(key: TaskKey): Promise<WorktreeState | null> {
		let doc;
		try {
			doc = await readDocument(await this.file(key));
		} catch (error) {
			if (isRecord(error) && error.code === 'ENOENT') return null;
			throw error;
		}
		const root = await this.location(key),
			project = await this.store.project(key.projectId),
			source = await realpath(project.path);
		if (
			doc.root !== root ||
			typeof doc.branch !== 'string' ||
			!validBranch(doc.branch) ||
			typeof doc.baseRef !== 'string' ||
			!validRef(doc.baseRef) ||
			!['preparing', 'ready', 'failed'].includes(String(doc.state)) ||
			typeof doc.step !== 'string' ||
			typeof doc.setupCommand !== 'string' ||
			doc.setupCommand.length > 100000 ||
			!Array.isArray(doc.repositories) ||
			!doc.repositories.length ||
			doc.repositories.length > 512
		)
			throw new Error('Invalid worktree state');
		if (
			doc.setupOwner !== undefined &&
			(!isRecord(doc.setupOwner) ||
				!Number.isSafeInteger(doc.setupOwner.pid) ||
				Number(doc.setupOwner.pid) <= 0 ||
				typeof doc.setupOwner.processStart !== 'string' ||
				!/^[-a-f0-9:]{3,100}$/.test(doc.setupOwner.processStart))
		)
			throw new Error('Invalid setup owner');
		const seen = new Set<string>();
		for (const repo of doc.repositories) {
			if (
				!isRecord(repo) ||
				typeof repo.source !== 'string' ||
				!inside(source, repo.source) ||
				typeof repo.relativePath !== 'string' ||
				isAbsolute(repo.relativePath) ||
				relative(source, repo.source) !== repo.relativePath ||
				!['root', 'submodule', 'nested', 'worktree'].includes(String(repo.kind)) ||
				typeof repo.ready !== 'boolean' ||
				(repo.removed !== undefined && typeof repo.removed !== 'boolean') ||
				seen.has(repo.relativePath)
			)
				throw new Error('Invalid worktree repository');
			await safePath(source, repo.relativePath);
			await safePath(root, repo.relativePath);
			seen.add(repo.relativePath);
		}
		if (!seen.has('') || doc.repositories[0].relativePath !== '')
			throw new Error('Missing root worktree');
		return doc as WorktreeState;
	}
	async prepare(
		key: TaskKey,
		options: WorktreeOptions,
		progress: (state: WorktreeState) => void | Promise<void> = () => {},
		signal?: AbortSignal
	): Promise<WorktreeState> {
		if (
			!validBranch(options.branch) ||
			!validRef(options.baseRef) ||
			(options.setupCommand?.length ?? 0) > 100000
		)
			throw new Error('Invalid worktree options');
		const dir = await this.store.taskDir(key);
		return this.processes.transaction(await safePath(dir, 'worktree.guard'), async () => {
			let state = await this.read(key);
			if (state) {
				await this.requireStopped(state);
				if (
					state.branch !== options.branch ||
					state.baseRef !== options.baseRef ||
					state.repositories.some((repo) => repo.removed)
				)
					throw new Error('Worktree configuration changed');
				if (state.state === 'ready') return state;
				state = {
					...state,
					setupCommand: options.setupCommand ?? state.setupCommand,
					state: 'preparing',
				};
				delete state.error;
			} else {
				try {
					await lstat(await this.location(key));
					throw new Error('The worktree destination already exists without a manifest');
				} catch (error) {
					if (!isRecord(error) || error.code !== 'ENOENT') throw error;
				}
				const project = await this.store.project(key.projectId),
					source = await realpath(project.path),
					found = await discoverScopes(source);
				const root = found.find((scope) => scope.path === source);
				if (!root) throw new Error('The project must be a Git repository to create a worktree');
				if (options.scopeIds?.some((id) => !found.some((scope) => scope.id === id)))
					throw new Error('A selected repo is unavailable');
				// spec/projects-and-board#external-folders: an external repo or a folder without git does not go into the worktree; it stays in place.
				const selected = found.filter(
					(scope) =>
						inRootKind(scope.kind) &&
						(scope === root || !options.scopeIds || options.scopeIds.includes(scope.id))
				);
				// Parents precede children; among siblings submodules precede independent repos.
				selected.sort(
					(a, b) =>
						relative(source, a.path).split('/').filter(Boolean).length -
							relative(source, b.path).split('/').filter(Boolean).length ||
						(a.kind === 'submodule' ? -1 : 0) - (b.kind === 'submodule' ? -1 : 0) ||
						a.path.localeCompare(b.path)
				);
				const own = (await this.released(key)) === options.branch;
				for (const scope of selected) {
					await gitText(scope.path, ['check-ref-format', '--branch', options.branch]);
					if (!own && (await branchExists(scope.path, options.branch)))
						throw new Error(`Branch already exists in ${scope.name}`);
				}
				state = {
					schemaVersion: 1,
					branch: options.branch,
					baseRef: options.baseRef,
					root: await this.location(key),
					repositories: selected.map((scope) => ({
						source: scope.path,
						relativePath: relative(source, scope.path),
						kind: scope.kind as Repository['kind'],
						ready: false,
					})),
					setupCommand: options.setupCommand ?? '',
					state: 'preparing',
					step: 'repositories',
				};
			}
			const save = async () => {
				await atomicJson(await this.file(key), state);
				await progress(structuredClone(state!));
			};
			await save();
			await rm(await safePath(dir, 'worktree-released.json'), { force: true });
			try {
				for (const repository of state.repositories) {
					signal?.throwIfAborted();
					const target = await safePath(state.root, repository.relativePath);
					state.step = repository.relativePath || '.';
					await save();
					const registered = (await worktreePaths(repository.source)).includes(target);
					if (registered) {
						if ((await gitText(target, ['symbolic-ref', '--short', 'HEAD'])) !== state.branch)
							throw new Error(`Worktree branch changed in ${state.step}`);
					} else {
						if (repository.ready) throw new Error(`Prepared worktree is missing in ${state.step}`);
						await mkdir(dirname(target), { recursive: true, mode: 0o700 });
						if (await branchExists(repository.source, state.branch))
							await gitText(repository.source, ['worktree', 'add', '--', target, state.branch]);
						else {
							if (state.baseRef.startsWith('origin/'))
								await gitText(repository.source, [
									'fetch',
									'--quiet',
									'--',
									'origin',
									state.baseRef.slice(7),
								]);
							// spec/pull-requests-and-ci#review-with-agent: the PR ref exists only in that PR's repo; the worktree's other repos (the project root) check out their own HEAD.
							const base = await gitText(repository.source, [
								'rev-parse',
								'--verify',
								'--end-of-options',
								`${state.baseRef}^{commit}`,
							]).catch((error) => {
								if (state!.baseRef.startsWith('refs/brigadir-v2/pr/'))
									return gitText(repository.source, ['rev-parse', '--verify', 'HEAD^{commit}']);
								throw error;
							});
							await gitText(repository.source, [
								'worktree',
								'add',
								'-b',
								state.branch,
								'--',
								target,
								base,
							]);
						}
					}
					repository.ready = true;
					await save();
				}
				if (options.copyEnvFiles) {
					state.step = 'env';
					await save();
					for (const repository of state.repositories) {
						signal?.throwIfAborted();
						await copyEnvFiles(
							repository.source,
							await safePath(state.root, repository.relativePath)
						);
					}
				}
				if (state.setupCommand.trim()) {
					state.step = 'setup';
					await save();
					const log = await open(await safePath(dir, 'worktree-setup.log'), 'a', 0o600);
					try {
						await log.writeFile(`\n--- ${new Date().toISOString()} ---\n`);
						await this.processes.run(
							state.root,
							state.setupCommand,
							log.fd,
							signal,
							async (owner) => {
								state!.setupOwner = owner;
								await save();
							}
						);
					} finally {
						await log.close();
					}
					delete state.setupOwner;
				}
				state.state = 'ready';
				state.step = 'ready';
				await save();
				return state;
			} catch (error) {
				state.state = 'failed';
				state.error = error instanceof Error ? error.message : String(error);
				await save();
				throw error;
			}
		});
	}
	/** spec/tasks#delete-task: uncommitted files a removal would lose, across every repo of the worktree; null without a worktree. */
	async uncommitted(key: TaskKey): Promise<number | null> {
		const state = await this.read(key);
		if (!state) return null;
		let count = 0;
		for (const repo of state.repositories) {
			if (repo.removed) continue;
			const target = await safePath(state.root, repo.relativePath);
			if (!(await worktreePaths(repo.source)).includes(target)) continue;
			// A submodule counts its own files; the parent would only report it as one modified path.
			count += (
				await gitText(target, [
					'status',
					'--porcelain=v1',
					'--untracked-files=all',
					'--ignore-submodules=all',
				])
			)
				.split('\n')
				.filter(Boolean).length;
		}
		return count;
	}
	/** Only paths named in this task's validated manifest are removed. Branches remain available. */
	async remove(key: TaskKey): Promise<void> {
		const dir = await this.store.taskDir(key);
		return this.processes.transaction(await safePath(dir, 'worktree.guard'), async () => {
			const state = await this.read(key);
			if (!state) return;
			await this.requireStopped(state);
			for (const repo of [...state.repositories].reverse()) {
				if (repo.removed) continue;
				const target = await safePath(state.root, repo.relativePath);
				if ((await worktreePaths(repo.source)).includes(target))
					await gitText(repo.source, ['worktree', 'remove', '--force', '--', target]);
				repo.removed = true;
				await atomicJson(await this.file(key), state);
			}
			await rm(state.root, { recursive: true, force: true });
			await rm(await this.file(key));
			await atomicJson(await safePath(dir, 'worktree-released.json'), {
				schemaVersion: 1,
				branch: state.branch,
			});
		});
	}
	private async requireStopped(state: WorktreeState) {
		if (
			state.setupOwner &&
			(await this.processes.identity(state.setupOwner.pid)) === state.setupOwner.processStart
		)
			throw new Error('The previous setup command is still stopping; retry shortly');
	}
}
/** spec/git#worktree-env: `.env`, `.env.local`, `.envrc`… that Git ignores — tracked ones are already in the worktree. Ignored folders
 *  (`node_modules/`) come back as one entry and are skipped whole; a file the worktree already has stays as it is. */
export async function copyEnvFiles(source: string, target: string): Promise<string[]> {
	const copied: string[] = [];
	for (const path of (
		await git(source, [
			'ls-files',
			'-z',
			'--others',
			'--ignored',
			'--exclude-standard',
			'--directory',
		])
	)
		.toString('utf8')
		.split('\0')) {
		if (!path || path.endsWith('/') || !basename(path).startsWith('.env')) continue;
		// A symlinked `.env` copies its content; folders on the way must not be links (safePath).
		const from = join(await safePath(source, dirname(path)), basename(path));
		if (!(await stat(from).catch(() => null))?.isFile()) continue;
		const to = await safePath(target, path);
		await mkdir(dirname(to), { recursive: true });
		try {
			await copyFile(from, to, constants.COPYFILE_EXCL);
			copied.push(path);
		} catch (error) {
			if (!isRecord(error) || error.code !== 'EEXIST') throw error;
		}
	}
	return copied;
}
async function branchExists(path: string, branch: string): Promise<boolean> {
	try {
		await gitText(path, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
		return true;
	} catch (error) {
		if (error instanceof GitError && error.code === 1) return false;
		throw error;
	}
}
