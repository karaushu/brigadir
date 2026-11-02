import { afterEach, expect, it, vi, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
	traceAttributionRange,
	type AnchorPosition,
	type AttributionRange,
	type EventRecord,
	type ReviewSnapshot,
	type TaskKey,
} from '@brigadir/core';
import { SessionStore } from '@brigadir/persistence';
import { anchorContext } from '@brigadir/diff';
const spawned = vi.hoisted(() => ({ git: 0 }));
vi.mock('node:child_process', async (original) => {
	const actual = await original<typeof import('node:child_process')>();
	return {
		...actual,
		spawn: ((command: string, args: string[], options: object) => {
			if (command === 'git') spawned.git++;
			return actual.spawn(command, args, options);
		}) as typeof actual.spawn,
	};
});
const { git, Snapshots, readSnapshots, changedFiles, readBlobs, attributionHunks } =
	await import('@brigadir/git');
const { markAddressed } = await import('./review-status');
const { WorkerPool } = await import('./worker');
const worker = new WorkerPool(resolve('apps/desktop/out/services/diff.cjs'));
afterAll(() => worker.close());
const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
/** markAddressed before GIT-06, verbatim: the full scan is the reference for the incremental one. */
async function legacy(
	store: SessionStore,
	key: TaskKey,
	review: ReviewSnapshot,
	records: EventRecord[]
) {
	const candidates = review.comments.filter(
		(comment) => comment.sent && !comment.resolved && !comment.addressed
	);
	if (!candidates.length) return;
	const doc = await readSnapshots(store, key);
	if (!doc) return;
	const boundaries = new Map<number, { seq: number; agent: boolean }>(),
		accepted = new Map<string, number>();
	let active = false;
	for (const record of records) {
		const event = record.event;
		if (event.kind === 'turn.started') {
			active = true;
			for (const item of event.review?.comments ?? [])
				if (!accepted.has(`${item.id}/${item.version}`))
					accepted.set(`${item.id}/${item.version}`, record.seq);
		}
		if (['turn.completed', 'host.stopped', 'session.failed'].includes(event.kind)) active = false;
		if (event.kind === 'checkpoint.created' && !boundaries.has(event.checkpoint))
			boundaries.set(event.checkpoint, { seq: record.seq, agent: active });
	}
	const from = Math.max(1, doc.checkpoints.length - 128),
		cutoff = from > 1 ? (boundaries.get(from - 1)?.seq ?? Infinity) : 0;
	const tracked = candidates
		.map((comment) => ({
			comment,
			path: comment.anchor.path,
			range: undefined as AttributionRange | null | undefined,
			seq: accepted.get(`${comment.id}/${comment.version}`) ?? Infinity,
		}))
		.filter((item) => item.seq > cutoff);
	for (let i = from; i < doc.checkpoints.length; i++) {
		const checkpoint = doc.checkpoints[i]!,
			previous = doc.checkpoints[i - 1]!,
			boundary = boundaries.get(i);
		if (!boundary) {
			for (const item of tracked) item.range = null;
			continue;
		}
		for (const scope of doc.scopes.filter((scope) => scope.available !== false)) {
			const waiting = tracked.filter(
				(item) =>
					item.range !== null && item.seq < boundary.seq && item.comment.anchor.scopeId === scope.id
			);
			if (!waiting.length) continue;
			const before = previous.trees.find((tree) => tree.scopeId === scope.id),
				after = checkpoint.trees.find((tree) => tree.scopeId === scope.id);
			if (!before || !after) {
				for (const item of waiting) item.range = null;
				continue;
			}
			if (before.tree === after.tree) continue;
			const files = await changedFiles(scope, before.tree, after.tree);
			for (const file of files) {
				if (file.status.startsWith('C')) continue;
				const matching = waiting.filter((item) => item.path === file.oldPath);
				if (!matching.length) continue;
				const hunks = await attributionHunks(scope, file);
				if (!hunks) {
					for (const item of matching) item.range = null;
					continue;
				}
				const fresh = matching.filter((item) => item.range === undefined);
				if (fresh.length) {
					const [blob] = await readBlobs(scope, [file.before]);
					if (!blob || blob.binary || blob.tooLarge) {
						for (const item of fresh) item.range = null;
					} else {
						const positions = await worker.run<AnchorPosition[]>({
							anchors: fresh.map((item) => ({ ...item.comment.anchor, side: 'old' })),
							before: blob.text,
							after: blob.text,
							oldBlob: file.before,
							newBlob: file.before,
						});
						fresh.forEach((item, index) => {
							const position = positions[index]!;
							item.range =
								position.start === null || position.end === null
									? null
									: { start: position.start, end: position.end };
						});
					}
				}
				const forward = hunks.map((hunk) => ({
					oldStart: hunk.newStart,
					oldCount: hunk.newCount,
					newStart: hunk.oldStart,
					newCount: hunk.oldCount,
				}));
				for (const item of matching) {
					if (!item.range) continue;
					const result = traceAttributionRange(item.range, forward);
					if (
						result.hit &&
						boundary.agent &&
						['tools', 'turn', 'refresh'].includes(checkpoint.reason)
					) {
						item.comment.addressed = true;
						item.comment.addressedCheckpoint = checkpoint.id;
					}
					item.range = result.previous;
					item.path = file.path;
				}
			}
		}
	}
}
it('scans only new checkpoint deltas on repeated review reads and matches the full scan (GIT-06)', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-review-status-'));
	roots.push(root);
	const repo = join(root, 'repo');
	await mkdir(repo);
	await git(repo, ['init', '-q']);
	const lines = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`);
	const text = () => lines.join('\n') + '\n';
	await writeFile(join(repo, 'file.ts'), text());
	await writeFile(join(repo, 'other.ts'), 'x\n');
	const store = await SessionStore.at(join(root, 'data')),
		project = await store.addProject(repo),
		key = await store.createTask(project.id, 'Review status', 'claude');
	const snapshots = await Snapshots.open(store, key);
	await snapshots.capture('baseline');
	const records: EventRecord[] = [];
	let seq = 0;
	const push = (event: EventRecord['event']) => {
		records.push({ seq: ++seq, at: new Date().toISOString(), event } as EventRecord);
	};
	push({ kind: 'checkpoint.created', checkpoint: 0 });
	const scope = snapshots.current.scopes[0]!,
		blob = (await git(repo, ['hash-object', 'file.ts'])).toString().trim();
	const anchor = (start: number) => ({
		scopeId: scope.id,
		path: 'file.ts',
		side: 'new' as const,
		blob,
		start,
		end: start,
		...anchorContext(text(), start, start),
		contextHash: 'fixture',
		symbolPath: null,
	});
	const comments = [
		{
			id: randomUUID(),
			version: 1,
			text: 'fix line 5',
			at: new Date().toISOString(),
			anchor: anchor(5),
		},
		{
			id: randomUUID(),
			version: 1,
			text: 'never touched',
			at: new Date().toISOString(),
			anchor: anchor(1),
		},
	];
	push({
		kind: 'turn.started',
		text: 'review',
		review: { id: 'r', comments: comments.map(({ id, version }) => ({ id, version })) },
	});
	const review = (): ReviewSnapshot => ({
		comments: comments.map((comment) => ({
			...comment,
			sent: true,
			resolved: false,
			addressed: false,
		})),
	});
	async function compare() {
		const expected = review(),
			actual = review();
		await legacy(store, key, expected, records);
		spawned.git = 0;
		await markAddressed(store, key, actual, records, worker);
		expect(actual.comments.map((c) => [c.addressed, c.addressedCheckpoint])).toEqual(
			expected.comments.map((c) => [c.addressed, c.addressedCheckpoint])
		);
		spawned.git = 0;
		const again = review();
		await markAddressed(store, key, again, records, worker);
		expect(spawned.git).toBe(0);
		expect(again.comments.map((c) => [c.addressed, c.addressedCheckpoint])).toEqual(
			expected.comments.map((c) => [c.addressed, c.addressedCheckpoint])
		);
		return expected.comments.map((c) => c.addressedCheckpoint ?? null);
	}
	async function step(change: () => Promise<void>, event = true) {
		await change();
		const point = await snapshots.capture('tools');
		if (event && point) push({ kind: 'checkpoint.created', checkpoint: point.id });
		return point!;
	}
	for (let i = 0; i < 4; i++) {
		await step(async () => {
			lines.push(`tail ${i}`);
			await writeFile(join(repo, 'file.ts'), text());
		});
		expect(await compare()).toEqual([null, null]);
	}
	await step(async () => {
		await writeFile(join(repo, 'other.ts'), 'y\n');
	});
	expect(await compare()).toEqual([null, null]);
	// A checkpoint whose event has not reached the journal yet cannot prove order; the next read retries it.
	const late = await step(async () => {
		lines[4] = 'line 5 fixed';
		await writeFile(join(repo, 'file.ts'), text());
	}, false);
	expect(await compare()).toEqual([null, null]);
	push({ kind: 'checkpoint.created', checkpoint: late.id });
	expect(await compare()).toEqual([late.id, null]);
	await step(async () => {
		lines.push('after fix');
		await writeFile(join(repo, 'file.ts'), text());
	});
	expect(await compare()).toEqual([late.id, null]);
	// One more delta after a completed turn: incremental reads keep counting from the cached checkpoint.
	push({ kind: 'turn.completed', reason: 'end_turn' });
	const idle = await step(async () => {
		lines[2] = 'line 3 after the turn';
		await writeFile(join(repo, 'file.ts'), text());
	});
	expect(await compare()).toEqual([late.id, null]);
	expect(idle.id).toBeGreaterThan(late.id);
}, 60000);
