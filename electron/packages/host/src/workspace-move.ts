import { randomUUID } from 'node:crypto';
import { cp, lstat, realpath, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import {
	changeBaseOf,
	freeBranch,
	isAutoHireDecision,
	isRecord,
	isWorkspaceStayed,
	suggestedBranch,
	workspaceStayedLimit,
	type AutoHireDecision,
	type Checkpoint,
	type EventRecord,
	type Scope,
	type SnapshotDocument,
	type SnapshotTree,
	type TaskKey,
	type TaskLaunch,
	type WorkspaceStayed,
} from '@brigadir/core';
import {
	ProcessCoordinator,
	atomicJson,
	readDocument,
	safePath,
	type SessionStore,
} from '@brigadir/persistence';
import {
	Worktrees,
	advanceTip,
	git,
	gitText,
	isSha,
	planRepoMove,
	projectStayed,
	readSnapshots,
	restoreProjectRepo,
	tipRef,
	writeRepoMove,
	type RepoMovePlan,
} from '@brigadir/git';

/**
 * spec/crew#auto-move: an Auto task without isolation moves into a worktree before its hire starts. `workspace-move.json` carries the move
 * across the host's restart: `pending` (the decision waits for the turn) → `moving` → `switching` (the task's documents are rewritten) →
 * `switched` (the task is a worktree task; the project folder is restored) → `moved`; or `failed`.
 */
export type MoveState = 'pending' | 'moving' | 'switching' | 'switched' | 'moved' | 'failed';
export type RepoMove = {
	scopeId: string;
	/** The repo's path relative to the project folder ('' for the root). */
	relativePath: string;
	baseTree: string;
	moved: RepoMovePlan['moved'];
};
export type MoveDocument = {
	schemaVersion: 1;
	id: string;
	hireId: string;
	decision: AutoHireDecision;
	state: MoveState;
	repos: string[];
	branch?: string;
	base?: string;
	/** The project folder and the worktree root. */
	from?: string;
	to?: string;
	launch?: TaskLaunch;
	checkpoint?: Checkpoint;
	moves?: RepoMove[];
	stayed?: WorkspaceStayed[];
	restored?: boolean;
	message?: string;
	/** A Claude session whose transcript follows the task into the worktree's folder. */
	sessionId?: string;
};
export const moveFile = 'workspace-move.json';
const moveDocumentBytes = 64 * 1024 * 1024;
const inRoot = (scope: Scope) =>
	scope.kind === 'root' ||
	scope.kind === 'submodule' ||
	scope.kind === 'nested' ||
	scope.kind === 'worktree';
export async function readMove(store: SessionStore, key: TaskKey): Promise<MoveDocument | null> {
	let doc: Record<string, unknown>;
	try {
		doc = await readDocument(await safePath(await store.taskDir(key), moveFile), moveDocumentBytes);
	} catch (error) {
		if (isRecord(error) && error.code === 'ENOENT') return null;
		throw error;
	}
	if (
		typeof doc.id !== 'string' ||
		typeof doc.hireId !== 'string' ||
		!isAutoHireDecision(doc.decision) ||
		!['pending', 'moving', 'switching', 'switched', 'moved', 'failed'].includes(
			String(doc.state)
		) ||
		!Array.isArray(doc.repos) ||
		(doc.stayed !== undefined &&
			(!Array.isArray(doc.stayed) || !doc.stayed.every(isWorkspaceStayed)))
	)
		throw new Error('Invalid workspace move');
	return doc as unknown as MoveDocument;
}
export async function saveMove(store: SessionStore, key: TaskKey, doc: MoveDocument) {
	await atomicJson(await safePath(await store.taskDir(key), moveFile), doc);
}
/** The repos a move takes: every repo of the project folder that the task's snapshots see. */
export function movedScopes(doc: SnapshotDocument, projectPath: string): Scope[] {
	return doc.scopes.filter(
		(scope) =>
			inRoot(scope) &&
			scope.available !== false &&
			(scope.path === projectPath || scope.path.startsWith(`${projectPath}/`))
	);
}
export function repoNames(scopes: readonly Scope[], projectName: string) {
	return scopes.map((scope) => (scope.name === '.' ? projectName : scope.name));
}
/**
 * spec/crew#auto-move: the paths of each repo that a checkpoint outside the agent's turns, or the person's Save, changed after the task's
 * start (the attribution rules of spec/diff-and-review#why-changed). A quick question's edit is the task's.
 */
export async function personPaths(
	snapshots: SnapshotDocument,
	records: readonly EventRecord[],
	from: number,
	projectPath: string
): Promise<Map<string, Set<string>>> {
	const agent = new Set<number>(),
		saves = new Map<number, Set<string>>();
	let inTurn = false;
	for (const { event } of records) {
		if (event.kind === 'turn.started') inTurn = true;
		else if (
			event.kind === 'turn.completed' ||
			event.kind === 'session.failed' ||
			event.kind === 'host.stopped'
		)
			inTurn = false;
		else if (event.kind === 'checkpoint.created' && inTurn) agent.add(event.checkpoint);
		else if (event.kind === 'quick-ask.changed') agent.add(event.after);
		else if (event.kind === 'file.saved' && event.after !== null) {
			const set = saves.get(event.after) ?? new Set<string>();
			set.add(event.path);
			saves.set(event.after, set);
		}
	}
	const result = new Map<string, Set<string>>();
	for (let i = from + 1; i < snapshots.checkpoints.length; i++) {
		const point = snapshots.checkpoints[i]!,
			previous = snapshots.checkpoints[i - 1]!;
		const saved = saves.get(point.id);
		if (agent.has(point.id) && !saved) continue;
		for (const tree of point.trees) {
			const before = previous.trees.find((item) => item.scopeId === tree.scopeId);
			if (!before || before.tree === tree.tree) continue;
			const scope = snapshots.scopes.find((item) => item.id === tree.scopeId);
			if (!scope) continue;
			const changed = (
				await git(
					scope.path,
					['diff-tree', '-r', '-z', '--no-renames', '--name-only', before.tree, tree.tree],
					{
						maxBytes: 64 * 1024 * 1024,
					}
				)
			)
				.toString('utf8')
				.split('\0')
				.filter(Boolean);
			const set = result.get(scope.id) ?? new Set<string>();
			for (const path of changed) {
				const projectRelative = relative(projectPath, join(scope.path, path));
				if (!agent.has(point.id) || saved?.has(projectRelative)) set.add(path);
			}
			result.set(scope.id, set);
		}
	}
	return result;
}
const writeCategories = new Set(['edit', 'delete', 'move']);
/**
 * spec/crew#auto-move: files the agent wrote with its edit tools that no snapshot holds: git ignores them, or no repo of the worktree holds
 * them. They cannot move and are named.
 */
export async function untrackedWrites(
	records: readonly EventRecord[],
	projectPath: string,
	scopes: readonly Scope[]
): Promise<WorkspaceStayed[]> {
	const paths = new Set<string>();
	for (const { event } of records) {
		if (event.kind !== 'tool.changed') continue;
		const patch = event.patch;
		const writes =
			writeCategories.has(patch.category ?? '') ||
			(patch.content ?? []).some((item) => item.kind === 'diff');
		if (!writes) continue;
		for (const location of patch.locations ?? []) paths.add(location.path);
		for (const item of patch.content ?? []) if (item.kind === 'diff') paths.add(item.path);
	}
	const byRepo = new Map<Scope | null, string[]>();
	for (const named of paths) {
		// The agent names a path as it sees it; the repos are recorded by their real paths.
		const folder = await realpath(dirname(named)).catch(() => null);
		if (!folder) continue;
		const path = join(folder, basename(named));
		if (path !== projectPath && !path.startsWith(`${projectPath}/`)) continue;
		if (!(await lstat(path).catch(() => null))?.isFile()) continue;
		const scope =
			[...scopes]
				.filter((item) => path.startsWith(`${item.path}/`))
				.sort((a, b) => b.path.length - a.path.length)[0] ?? null;
		byRepo.set(scope, [...(byRepo.get(scope) ?? []), path]);
	}
	const stayed: WorkspaceStayed[] = [];
	for (const [scope, list] of byRepo) {
		if (!scope) {
			for (const path of list)
				stayed.push({ path: relative(projectPath, path), reason: 'outside' });
			continue;
		}
		let ignored: Set<string>;
		try {
			ignored = new Set(
				(
					await git(scope.path, ['check-ignore', '-z', '--stdin'], {
						input: list.map((path) => relative(scope.path, path)).join('\0') + '\0',
					})
				)
					.toString('utf8')
					.split('\0')
					.filter(Boolean)
			);
		} catch {
			ignored = new Set();
		}
		for (const path of list)
			if (ignored.has(relative(scope.path, path)))
				stayed.push({ path: relative(projectPath, path), reason: 'ignored' });
	}
	return stayed;
}
/** The branch the worktree gets: derived from the task's title, free in every repo that moves. */
export async function moveBranch(
	title: string,
	prompt: string,
	id: string,
	repos: readonly string[]
) {
	const taken = new Set<string>();
	for (const repo of repos)
		for (const line of (
			await gitText(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
		).split('\n'))
			if (line) taken.add(line);
	return freeBranch(suggestedBranch(title, prompt, id), taken);
}
/** What the worktree is shown to start from: the root repo's branch, or its short commit on a detached `HEAD`. */
export async function moveBase(root: string) {
	const branch = await gitText(root, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '');
	if (branch) return branch;
	return (await gitText(root, ['rev-parse', '--short', 'HEAD'])).trim();
}
export type MoveDeps = {
	store: SessionStore;
	key: TaskKey;
	services: { mcpEntry: string };
	records(): readonly EventRecord[];
};
function worktrees(deps: MoveDeps) {
	return new Worktrees(
		deps.store,
		new ProcessCoordinator(join(dirname(deps.services.mcpEntry), 'process-owner'))
	);
}
/**
 * spec/crew#auto-move, steps 3–5: the worktree, the plan of what moves, the writes and their check. Nothing in the project folder changes
 * here; on any failure the caller rolls the worktree back. Returns the document ready to switch.
 */
export async function prepareMove(deps: MoveDeps, doc: MoveDocument): Promise<MoveDocument> {
	const { store, key } = deps;
	const task = await store.task(key),
		stored = await store.project(key.projectId),
		// Repos are recorded by their real paths (discovery), so the project's folder is compared as one too.
		project = { ...stored, path: await realpath(stored.path) },
		snapshots = await readSnapshots(store, key);
	if (!snapshots?.checkpoints.length) throw new Error('The task has no snapshots to move');
	const scopes = movedScopes(snapshots, project.path),
		root = scopes.find((scope) => scope.path === project.path);
	if (!root) throw new Error('The project must be a Git repository to create a worktree');
	const from = changeBaseOf(snapshots, task.changeBase),
		latest = snapshots.checkpoints.at(-1)!;
	const branch = await moveBranch(
			task.title,
			task.prompt ?? '',
			key.id,
			scopes.map((scope) => scope.path)
		),
		base = await moveBase(root.path);
	const person = await personPaths(snapshots, deps.records(), from, project.path);
	// The plans first: a repo without commits or a broken tree fails the move before any copy exists.
	const plans = new Map<string, { scope: Scope; plan: RepoMovePlan; baseTree: string }>();
	for (const scope of scopes) {
		const tree = (id: number) =>
			snapshots.checkpoints[id]?.trees.find((item) => item.scopeId === scope.id)?.tree;
		const current = latest.trees.find((item) => item.scopeId === scope.id)?.tree;
		let baseTree = tree(from);
		for (let i = from; !baseTree && i < snapshots.checkpoints.length; i++) baseTree = tree(i);
		if (!current || !baseTree) continue;
		plans.set(scope.id, {
			scope,
			baseTree,
			plan: await planRepoMove({
				repo: scope.path,
				baseTree,
				currentTree: current,
				personPaths: person.get(scope.id) ?? new Set(),
			}),
		});
	}
	// Every copy starts at its own repo's HEAD, also a repo without snapshots (it has nothing to move).
	const starts: Record<string, string> = {};
	for (const scope of scopes) {
		const head =
			plans.get(scope.id)?.plan.head ??
			(await gitText(scope.path, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']).catch(
				() => ''
			));
		if (!isSha(head))
			throw new Error(`${scope.name}: the repo has no commit to start a worktree from`);
		starts[relative(project.path, scope.path)] = head;
	}
	const launch = task.launch;
	const setupCommand = launch?.setupCommand ?? '';
	const prepared = await worktrees(deps).prepare(key, {
		branch,
		baseRef: base,
		scopeIds: scopes.map((scope) => scope.id),
		setupCommand,
		copyEnvFiles: launch?.copyEnvFiles === true,
		starts,
	});
	const to = prepared.root;
	// Repos the copy skipped (no plan) start at their own HEAD from `prepare`; the moved paths go into the copies and are checked.
	const stayed: WorkspaceStayed[] = [];
	const moves: RepoMove[] = [];
	for (const { scope, plan, baseTree } of plans.values()) {
		const relativePath = relative(project.path, scope.path);
		const copy = await safePath(to, relativePath);
		const head = await gitText(copy, ['rev-parse', 'HEAD']);
		if (head !== plan.head)
			throw new Error(`${scope.name}: the working copy is not at the repo's HEAD`);
		const wrong = await writeRepoMove(copy, plan);
		if (wrong.length)
			throw new Error(
				`${scope.name === '.' ? project.name : scope.name}: ${wrong.slice(0, 3).join(', ')} did not arrive in the worktree`
			);
		stayed.push(...projectStayed(relativePath, plan.stayed));
		moves.push({ scopeId: scope.id, relativePath, baseTree, moved: plan.moved });
	}
	stayed.push(
		...(await untrackedWrites(deps.records(), project.path, scopes)).filter(
			(item) => !stayed.some((other) => other.path === item.path)
		)
	);
	// spec/tasks#worktree-move: the `move` checkpoint — each moved repo's HEAD tree in the copy, the other repos' trees at the task's start.
	const id = snapshots.checkpoints.length,
		trees: SnapshotTree[] = [];
	for (const scope of snapshots.scopes) {
		const prior = snapshots.checkpoints
			.findLast((point) => point.trees.some((item) => item.scopeId === scope.id))
			?.trees.find((item) => item.scopeId === scope.id);
		if (!prior) continue;
		const planned = plans.get(scope.id);
		if (!planned) {
			const start =
				snapshots.checkpoints[from]?.trees.find((item) => item.scopeId === scope.id) ?? prior;
			trees.push(start);
			continue;
		}
		const tree = await gitText(scope.path, ['rev-parse', `${planned.plan.head}^{tree}`]);
		if (tree === prior.tree) {
			trees.push(prior);
			continue;
		}
		const commit = await gitText(
			scope.path,
			['commit-tree', tree, '-p', prior.commit, '-m', `Brigadir snapshot ${id}`],
			{
				env: {
					GIT_AUTHOR_NAME: 'Brigadir',
					GIT_AUTHOR_EMAIL: 'brigadir@localhost',
					GIT_COMMITTER_NAME: 'Brigadir',
					GIT_COMMITTER_EMAIL: 'brigadir@localhost',
				},
			}
		);
		if (!isSha(commit)) throw new Error('Invalid snapshot commit');
		await advanceTip(
			scope.path,
			key,
			scope.id,
			commit,
			prior.commit,
			undefined,
			(oid) =>
				snapshots.checkpoints.find((point) =>
					point.trees.some((item) => item.scopeId === scope.id && item.commit === oid)
				)?.id ?? id
		);
		trees.push({ scopeId: scope.id, tree, commit, ref: tipRef(key, scope.id) });
	}
	const {
		switches: _switches,
		pull: _pull,
		branchAuto: _auto,
		...kept
	} = launch ?? {
		isolation: 'in-place' as const,
		branch: '',
		baseRef: '',
		setupCommand: '',
		scopes: snapshots.scopes
			.filter(inRoot)
			.map(({ id: scopeId, name, kind, selected }) => ({ id: scopeId, name, kind, selected })),
	};
	return {
		...doc,
		state: 'switching',
		branch,
		base,
		from: project.path,
		to,
		// Discovery in a worktree knows its copies by the names in `launch.scopes`: every moved repo is named there, with its kind.
		launch: {
			...kept,
			isolation: 'worktree',
			branch,
			baseRef: base,
			scopes: [
				...kept.scopes,
				...scopes
					.filter((scope) => !kept.scopes.some((choice) => choice.name === scope.name))
					.map(({ id: scopeId, name, kind, selected }) => ({ id: scopeId, name, kind, selected })),
			],
		},
		checkpoint: { id, at: new Date().toISOString(), reason: 'move', trees },
		moves,
		stayed: stayed.slice(0, workspaceStayedLimit),
	};
}
/**
 * spec/crew#auto-move, step 6: the task becomes a worktree task. Idempotent, so a host that starts on a `switching` document finishes it:
 * the snapshot document's repos point at the copies under their old ids and end with the `move` checkpoint; `task.json` gets the launch.
 */
export async function applySwitch(store: SessionStore, key: TaskKey, doc: MoveDocument) {
	if (!doc.from || !doc.to || !doc.launch || !doc.checkpoint || !doc.branch)
		throw new Error('Invalid workspace move');
	const { from, to, checkpoint } = doc;
	const path = await safePath(await store.taskDir(key), 'snapshots.json'),
		raw = await readDocument(path, 32 * 1024 * 1024);
	if (!Array.isArray(raw.scopes) || !Array.isArray(raw.checkpoints))
		throw new Error('Invalid snapshots');
	const scopes = (raw.scopes as Record<string, unknown>[]).map((scope) => {
		const at = String(scope.path);
		if (!inRoot(scope as unknown as Scope) || (at !== from && !at.startsWith(`${from}/`)))
			return scope;
		return { ...scope, path: `${to}${at.slice(from.length)}` };
	});
	await atomicJson(path, {
		...raw,
		scopes,
		checkpoints: [...(raw.checkpoints as unknown[]).slice(0, checkpoint.id), checkpoint],
	});
	await store.updateTask(key, {
		launch: doc.launch,
		worktreeBranch: doc.branch,
		preparation: { state: 'ready', step: 'ready' },
		changeBase: checkpoint.id,
	});
	// spec/crew#auto-move, step 8: part of the switch, so a host that finishes a half-written switch copies it too before the session loads.
	if (doc.sessionId) await copyClaudeTranscript(from, to, doc.sessionId);
	await saveMove(store, key, { ...doc, state: 'switched' });
	return { ...doc, state: 'switched' as const };
}
/** spec/crew#auto-move: a host that starts on a half-written switch completes it before anything reads the task's folder. */
export async function finishSwitch(store: SessionStore, key: TaskKey) {
	const doc = await readMove(store, key).catch(() => null);
	if (doc?.state === 'switching') await applySwitch(store, key, doc);
}
/**
 * spec/crew#auto-move, step 7: the project folder returns to the task's start for every moved path; a path the person changed meanwhile stays
 * and is added to the stayed list.
 */
export async function restoreProject(store: SessionStore, key: TaskKey, doc: MoveDocument) {
	if (doc.restored || !doc.from) return doc;
	const stayed = [...(doc.stayed ?? [])];
	for (const move of doc.moves ?? []) {
		const repo = move.relativePath ? join(doc.from, move.relativePath) : doc.from;
		try {
			for (const path of await restoreProjectRepo(repo, move.baseTree, move.moved))
				stayed.push({
					path: move.relativePath ? `${move.relativePath}/${path}` : path,
					reason: 'moving',
				});
		} catch {
			// Nothing is lost: every moved path is in the worktree; the project folder keeps its copy, named.
			for (const item of move.moved)
				stayed.push({
					path: move.relativePath ? `${move.relativePath}/${item.path}` : item.path,
					reason: 'moving',
				});
		}
	}
	const next = { ...doc, restored: true, stayed: stayed.slice(0, workspaceStayedLimit) };
	await saveMove(store, key, next);
	return next;
}
/**
 * spec/crew#auto-move: a move that failed before the switch leaves nothing behind: the copies, their branches and the manifest go. The
 * project folder was never touched.
 */
export async function rollbackMove(deps: MoveDeps, branch: string | undefined) {
	const trees = worktrees(deps);
	const state = await trees.read(deps.key).catch(() => null);
	if (state) {
		await trees.remove(deps.key).catch(() => {});
		for (const repo of state.repositories)
			await gitText(repo.source, ['branch', '-D', '--', state.branch]).catch(() => {});
	} else if (branch) {
		const project = await deps.store.project(deps.key.projectId);
		await gitText(await realpath(project.path), ['branch', '-D', '--', branch]).catch(() => {});
	}
	await rm(await safePath(await deps.store.taskDir(deps.key), 'worktree-released.json'), {
		force: true,
	});
}
/** spec/crew#auto-move, step 8: Claude Code keys transcripts by the session's folder; the worktree's folder gets a copy so `session/load` finds it. */
export async function copyClaudeTranscript(from: string, to: string, sessionId: string) {
	if (!/^[A-Za-z0-9._-]{1,200}$/.test(sessionId)) return;
	const encode = (path: string) => path.replace(/[^a-zA-Z0-9]/g, '-');
	const projects = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects');
	const source = join(projects, encode(from)),
		target = join(projects, encode(to));
	for (const name of [`${sessionId}.jsonl`, sessionId]) {
		const exists = await stat(join(source, name)).catch(() => null);
		if (!exists) continue;
		await cp(join(source, name), join(target, name), {
			recursive: true,
			force: false,
			errorOnExist: false,
		});
	}
}
export const newMoveId = () => randomUUID();
