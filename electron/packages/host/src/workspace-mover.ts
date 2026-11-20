import { realpath } from 'node:fs/promises';
import type { AutoHireDecision, SessionEvent, WorkspaceMoveEvent } from '@brigadir/core';
import { readSnapshots } from '@brigadir/git';
import {
	applySwitch,
	movedScopes,
	newMoveId,
	prepareMove,
	readMove,
	repoNames,
	restoreProject,
	rollbackMove,
	saveMove,
	type MoveDeps,
	type MoveDocument,
} from './workspace-move';

/** spec/crew#auto-move: the stay reasons as the agent reads them. */
export const stayReason = {
	person: 'changed outside your turns',
	moving: 'changed while the task moved',
	conflict: 'changed before the task too, and your change does not merge',
	ignored: 'ignored by git',
	outside: 'outside git',
} as const;
/** The host's hold of the task while it moves: the last capture, then nothing reads or writes the folder. */
export type MoveHold = { capture(): Promise<void>; detach(): Promise<void> };
export type MoveWork = (hold: MoveHold) => Promise<boolean>;
/** What follows the move for one starter: in the host that starts in the worktree (`moved`), or in this one (`failed`). */
export type MoveEnd = {
	moved(doc: MoveDocument, preface: string): Promise<void>;
	failed(doc: MoveDocument, message: string): Promise<void>;
};
export type WorkspaceMoverDeps = MoveDeps & {
	emit(event: SessionEvent): Promise<void>;
	/** The host's hold; absent where the host cannot restart (unit tests without one): the move then never starts. */
	hold?(work: MoveWork): void;
	/** Drops a hold that has not started yet; false — it started (or none waits). */
	unhold?(): boolean;
	/** No prompt starts until `work` settles: the host in the worktree finishes the move first. */
	gate?(work: Promise<void>): void;
	sessionId(): string | null;
	/** The task runs in a worktree now (the host after the switch). */
	worktree(): Promise<boolean>;
};
/** spec/tasks#move-to-worktree: what the agent's next prompt starts with after the person's move. */
export function movePreface(doc: MoveDocument) {
	const stayed = doc.stayed ?? [];
	return `The task moved into a worktree: ${doc.to} on branch ${doc.branch} (from ${doc.base}). Your edits moved with it; work there from now on.${
		stayed.length
			? ` These paths stayed in the project folder (${doc.from}): ${stayed
					.slice(0, 50)
					.map((item) => `${item.path} (${stayReason[item.reason]})`)
					.join(', ')}.`
			: ''
	}`;
}
/**
 * spec/crew#auto-move, spec/tasks#move-to-worktree: the one move of a task into a worktree, with two starters — an `Auto` hire and the person.
 * `workspace-move.json` carries it across the host's restart; each starter says what follows (`MoveEnd`).
 */
export class WorkspaceMover {
	private hireEnd: MoveEnd | null = null;
	private resumed = false;
	constructor(
		private deps: WorkspaceMoverDeps,
		private personEnd: MoveEnd
	) {}
	/** The `Auto` host says what follows a hire's move. */
	onHire(end: MoveEnd) {
		this.hireEnd = end;
	}
	read() {
		return readMove(this.deps.store, this.deps.key).catch(() => null);
	}
	private end(doc: MoveDocument): MoveEnd | null {
		return doc.by === 'person' ? this.personEnd : this.hireEnd;
	}
	private event(doc: MoveDocument, state: WorkspaceMoveEvent['state']): WorkspaceMoveEvent {
		return {
			kind: 'workspace.move',
			id: doc.id,
			...(doc.hireId ? { hireId: doc.hireId } : { by: 'person' as const }),
			state,
			repos: doc.repos,
		};
	}
	/**
	 * Step 1: the move is written down and waits for the turn to end (at once when none runs). A hire's row starts at `moving`; the person's
	 * reads `waiting` while a turn runs.
	 */
	async start(
		origin: { hireId: string; decision: AutoHireDecision } | { by: 'person' },
		waiting = false
	) {
		const { store, key } = this.deps;
		const [snapshots, project] = await Promise.all([
			readSnapshots(store, key).catch(() => null),
			store.project(key.projectId),
		]);
		const doc: MoveDocument = {
			schemaVersion: 1,
			id: newMoveId(),
			...origin,
			state: 'pending',
			...(waiting ? { waited: true } : {}),
			repos: snapshots
				? repoNames(movedScopes(snapshots, await realpath(project.path)), project.name)
				: [],
		};
		await saveMove(store, key, doc);
		await this.deps.emit(this.event(doc, waiting ? 'waiting' : 'moving'));
		this.hold(doc);
		return doc;
	}
	/** spec/tasks#move-to-worktree: the person drops a move that still waits for the turn; once it started it goes on. */
	async cancel(): Promise<boolean> {
		const doc = await this.read();
		if (doc?.state !== 'pending' || doc.by !== 'person' || !this.deps.unhold?.()) return false;
		await saveMove(this.deps.store, this.deps.key, { ...doc, state: 'cancelled' });
		await this.deps.emit(this.event(doc, 'cancelled'));
		return true;
	}
	private hold(doc: MoveDocument) {
		this.deps.hold?.((hold) => this.run(doc, hold));
	}
	/** Steps 2–8 in the host that still runs in the project folder. True: the host restarts in the worktree. */
	private async run(doc: MoveDocument, hold: MoveHold): Promise<boolean> {
		const { store, key } = this.deps;
		const sessionId = (await store.task(key)).provider === 'claude' ? this.deps.sessionId() : null;
		let current: MoveDocument = { ...doc, state: 'moving', ...(sessionId ? { sessionId } : {}) };
		try {
			await saveMove(store, key, current);
			if (doc.waited) await this.deps.emit(this.event(doc, 'moving'));
			await hold.capture();
			await hold.detach();
			current = await prepareMove(this.deps, current);
			await saveMove(store, key, current);
		} catch (error) {
			await rollbackMove(this.deps, current.branch).catch(() => {});
			await this.fail(current, error instanceof Error ? error.message : String(error));
			return false;
		}
		try {
			current = await applySwitch(store, key, current);
			current = await restoreProject(store, key, current);
		} catch (error) {
			// The next host finishes a switch it finds half-written (finishSwitch) and restores the project folder.
			process.stderr.write(
				`[host] workspace switch: ${error instanceof Error ? error.message : String(error)}\n`
			);
		}
		return true;
	}
	/** Nothing moved: the row says why; the starter tells whom it concerns. */
	private async fail(doc: MoveDocument, message: string) {
		await saveMove(this.deps.store, this.deps.key, { ...doc, state: 'failed', message });
		await this.deps.emit({ ...this.event(doc, 'failed'), message });
		await this.end(doc)?.failed(doc, message);
	}
	/**
	 * What a host finds at its start: a move that waited for the turn, one that stopped half-way, or one that switched the task before this
	 * host started (step 9: it finishes before any prompt of this host starts). Runs once.
	 */
	async resume() {
		if (this.resumed) return;
		this.resumed = true;
		const doc = await this.read();
		if (!doc) return;
		const worktree = await this.deps.worktree();
		if (doc.state === 'switched' && worktree) {
			const finishing = this.finish(doc);
			if (this.deps.gate) this.deps.gate(finishing);
			else void finishing.catch(() => {});
			return;
		}
		setImmediate(() => void this.resumeNow(doc, worktree).catch(() => {}));
	}
	private async resumeNow(doc: MoveDocument, worktree: boolean) {
		if (doc.state === 'pending' && !worktree) return this.hold(doc);
		if (doc.state === 'moving' && !worktree) {
			// The host stopped before the switch: the project folder never changed; the copies go.
			await rollbackMove(this.deps, doc.branch).catch(() => {});
			return this.fail(doc, 'The move stopped before it finished');
		}
	}
	/** Step 9 in the host that starts in the worktree: the row, then the starter's part. The document stays `switched` until that is done. */
	private async finish(doc: MoveDocument) {
		const { store, key } = this.deps;
		const current = await restoreProject(store, key, doc);
		const announced = this.deps
			.records()
			.some(
				({ event }) =>
					event.kind === 'workspace.move' && event.id === current.id && event.state === 'moved'
			);
		if (!announced)
			await this.deps.emit({
				...this.event(current, 'moved'),
				...(current.branch ? { branch: current.branch } : {}),
				...(current.base ? { base: current.base } : {}),
				stayed: current.stayed ?? [],
			});
		await this.end(current)?.moved(current, `${movePreface(current)}\n\n`);
		await saveMove(store, key, { ...current, state: 'moved' });
	}
	/** spec/tasks#move-to-worktree: the sentence the agent's next prompt starts with, once, after the person's move. */
	async note(): Promise<string | null> {
		const doc = await this.read();
		return doc?.by === 'person' && doc.state === 'moved' && !doc.told ? movePreface(doc) : null;
	}
	async told() {
		const doc = await this.read();
		if (doc?.by === 'person' && doc.state === 'moved')
			await saveMove(this.deps.store, this.deps.key, { ...doc, told: true });
	}
}
