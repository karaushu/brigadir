import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ScopeLocks } from '@brigadir/host/client';
import { discoverScopes } from '@brigadir/git';
import { ProcessCoordinator, SessionStore } from '@brigadir/persistence';
import {
	inTask,
	withAutoBranch,
	type TaskKey,
	type LaunchConflict,
	type LaunchConflictChoice,
	type ScopeLockView,
} from '@brigadir/core';
import { LaunchSettingsStore } from './launch-settings';
const name = (key: TaskKey) => `${key.projectId}/${key.id}`;
type Found = Awaited<ReturnType<typeof discoverScopes>>;
type Held = Awaited<ReturnType<ScopeLocks['snapshot']>>;
/** One queue pass over blocked tasks: repo discovery per project and the lock snapshot are read once, not twice per task. */
type Pass = { found: Map<string, Promise<Found>>; locks?: Promise<Held> };
export class LaunchLocks {
	private passes = new WeakMap<object, Pass>();
	private pass(token?: object): Pass {
		if (!token) return { found: new Map() };
		let pass = this.passes.get(token);
		if (!pass) {
			pass = { found: new Map() };
			this.passes.set(token, pass);
		}
		return pass;
	}
	private discover(pass: Pass, path: string) {
		let found = pass.found.get(path);
		if (!found) {
			found = discoverScopes(path);
			pass.found.set(path, found);
		}
		return found;
	}
	private overrides = new Set<string>();
	private pending: {
		conflict: LaunchConflict;
		resolve: (choice: LaunchConflictChoice) => void;
	} | null = null;
	constructor(
		private dataDir: string | undefined,
		private services: string,
		private changed: (key: TaskKey) => void,
		private publish: (conflict: LaunchConflict | null) => void
	) {}
	get conflict() {
		return this.pending?.conflict ?? null;
	}
	cancel() {
		if (this.pending) this.resolve(this.pending.conflict.id, 'cancel');
	}
	resolve(id: string, choice: LaunchConflictChoice) {
		const entry = this.pending;
		if (!entry || entry.conflict.id !== id) throw new Error('This conflict is no longer pending');
		if (choice === 'worktree' && !entry.conflict.canIsolate)
			throw new Error('This task cannot change its workspace');
		this.pending = null;
		this.publish(null);
		entry.resolve(choice);
	}
	forget(key: TaskKey) {
		this.overrides.delete(name(key));
	}
	takeOverride(key: TaskKey) {
		const value = this.overrides.has(name(key));
		this.overrides.delete(name(key));
		return value;
	}
	async scopes(key: TaskKey, token?: object): Promise<ScopeLockView[]> {
		const store = await SessionStore.at(this.dataDir),
			task = await store.task(key),
			pass = this.pass(token);
		// spec/projects-and-board#external-folders: an external repo does not go into the worktree, so an isolated task locks it too.
		const external = (task.launch?.scopes ?? [])
			.filter((choice) => choice.kind === 'external' && choice.path && inTask(choice))
			.map((choice) => ({ name: choice.name, path: choice.path! }));
		const project = await store.project(key.projectId),
			found = [
				...(task.launch?.isolation === 'worktree' ? [] : await this.discover(pass, project.path)),
				...external,
			],
			locks = await (pass.locks ??= new ScopeLocks(
				store,
				new ProcessCoordinator(join(this.services, 'process-owner'))
			).snapshot());
		const titles = new Map<string, string>();
		for (const lock of locks) {
			const id = name(lock.owner.key);
			if (!titles.has(id))
				titles.set(
					id,
					await store.task(lock.owner.key).then(
						(task) => task.title,
						() => lock.owner.key.id
					)
				);
		}
		return found.map((scope) => {
			const owners = locks
				.filter((lock) => lock.path === scope.path)
				.map((lock) => ({
					key: lock.owner.key,
					title: titles.get(name(lock.owner.key))!,
					acquiredAt: lock.acquiredAt,
				}));
			return {
				name: scope.name === '.' ? project.name : scope.name,
				path: scope.path,
				owners,
				contended: owners.length > 1,
			};
		});
	}
	/** `token` groups checks of one queue pass; without it the check reads everything itself, once. */
	async check(
		key: TaskKey,
		interactive: boolean,
		token: object = {}
	): Promise<'ready' | 'queue' | 'cancel'> {
		const store = await SessionStore.at(this.dataDir),
			task = await store.task(key),
			pass = this.pass(token);
		const setBlocked = async (blockedBy: TaskKey[]) => {
			if (JSON.stringify(task.blockedBy ?? []) !== JSON.stringify(blockedBy)) {
				await store.updateTask(key, { blockedBy });
				this.changed(key);
			}
		};
		const external = (task.launch?.scopes ?? [])
			.filter((choice) => choice.kind === 'external' && choice.path && inTask(choice))
			.map((choice) => choice.path!);
		// spec/pull-requests-and-ci#review-with-agent: an agent that writes no code (quick review, crew reviewer) takes no lock, so nothing blocks it.
		if (
			this.overrides.has(name(key)) ||
			task.readOnlyAgent === true ||
			(task.launch?.isolation === 'worktree' && !external.length)
		) {
			await setBlocked([]);
			return 'ready';
		}
		const project = await store.project(key.projectId),
			found = task.launch?.isolation === 'worktree' ? [] : await this.discover(pass, project.path),
			paths = new Set([
				...found
					.filter((scope) =>
						task.launch
							? task.launch.scopes.some((choice) => choice.id === scope.id && inTask(choice))
							: inTask(scope)
					)
					.map((scope) => scope.path),
				...external,
			]);
		const conflicts = (await this.scopes(key, token))
			.filter((scope) => paths.has(scope.path))
			.map((scope) => ({
				...scope,
				owners: scope.owners.filter((owner) => name(owner.key) !== name(key)),
			}))
			.filter((scope) => scope.owners.length);
		if (!conflicts.length) {
			await setBlocked([]);
			return 'ready';
		}
		const blockedBy = [
			...new Map(
				conflicts
					.flatMap((scope) => scope.owners)
					.map((owner) => [name(owner.key), { projectId: owner.key.projectId, id: owner.key.id }])
			).values(),
		];
		if (!interactive) {
			await setBlocked(blockedBy);
			return 'queue';
		}
		if (this.pending) throw new Error('Another launch conflict is pending');
		const journal = await store.journal(key);
		if (journal.issue) throw new Error(journal.issue);
		const canIsolate =
			found.some((scope) => scope.name === '.') &&
			!task.preparation &&
			!journal.records.some(
				(record) =>
					record.event.kind === 'turn.started' || record.event.kind === 'checkpoint.created'
			);
		const choice = await new Promise<LaunchConflictChoice>((resolve) => {
			this.pending = {
				conflict: {
					id: randomUUID(),
					key: { projectId: key.projectId, id: key.id },
					scopes: conflicts,
					canIsolate,
				},
				resolve,
			};
			this.publish(this.pending.conflict);
		});
		if (choice === 'queue') {
			await setBlocked(blockedBy);
			return 'queue';
		}
		await setBlocked([]);
		if (choice === 'cancel') return 'cancel';
		if (choice === 'override') {
			this.overrides.add(name(key));
			return 'ready';
		}
		// A new workspace cannot inherit a journal or baseline from the source tree.
		const latest = await store.journal(key);
		if (
			latest.issue ||
			latest.records.some(
				(record) =>
					record.event.kind === 'turn.started' || record.event.kind === 'checkpoint.created'
			)
		)
			throw new Error('The task has already used its workspace');
		const settings = new LaunchSettingsStore(this.dataDir),
			launch = await settings.resolve(key.projectId, task.launch);
		await store.updateTask(key, {
			launch: withAutoBranch(
				{ ...launch, isolation: 'worktree' },
				task.title,
				task.prompt ?? '',
				task.id
			),
		});
		this.changed(key);
		return 'ready';
	}
}
