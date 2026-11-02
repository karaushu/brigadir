import {
	type EventRecord,
	type ReviewSnapshot,
	type TaskKey,
	type AnchorPosition,
	type AttributionRange,
	traceAttributionRange,
} from '@brigadir/core';
import { type SessionStore } from '@brigadir/persistence';
import { readSnapshots, changedFiles, readBlobs, attributionHunks } from '@brigadir/git';
import type { WorkerPool } from './worker';

/** A comment's tracking state after checkpoint `checked`. Checkpoints and the journal are append-only,
 *  so a repeat read walks only new deltas. If the `from` window moved, the walk starts over. */
type Progress = {
	from: number;
	seq: number;
	checked: number;
	at: string;
	boundary: number;
	path: string;
	range: AttributionRange | null | undefined;
	addressed: number | null;
};
const progress = new Map<string, Progress>(),
	positions = new Map<string, AttributionRange | null>();
const remember = <T>(map: Map<string, T>, key: string, value: T) => {
	map.delete(key);
	map.set(key, value);
	while (map.size > 1000) map.delete(map.keys().next().value!);
};

/** Only the first tracked change of the lines can confirm an agent's fix. */
export async function markAddressed(
	store: SessionStore,
	key: TaskKey,
	review: ReviewSnapshot,
	records: EventRecord[],
	worker: WorkerPool
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
			name: `${key.projectId}/${key.id}/${comment.id}/${comment.version}`,
			path: comment.anchor.path,
			range: undefined as AttributionRange | null | undefined,
			seq: accepted.get(`${comment.id}/${comment.version}`) ?? Infinity,
			checked: from - 1,
			cacheable: true,
			saved: null as Progress | null,
		}))
		.filter((item) => item.seq > cutoff);
	for (const item of tracked) {
		const saved = progress.get(item.name);
		if (
			saved &&
			saved.from === from &&
			saved.seq === item.seq &&
			doc.checkpoints[saved.checked]?.at === saved.at &&
			boundaries.get(saved.checked)?.seq === saved.boundary
		) {
			item.checked = saved.checked;
			item.path = saved.path;
			item.range = saved.range;
			item.saved = saved;
			if (saved.addressed !== null) {
				item.comment.addressed = true;
				item.comment.addressedCheckpoint = saved.addressed;
			}
		}
	}
	const available = doc.scopes.filter((scope) => scope.available !== false);
	for (let i = from; i < doc.checkpoints.length; i++) {
		const checkpoint = doc.checkpoints[i]!,
			previous = doc.checkpoints[i - 1]!,
			boundary = boundaries.get(i),
			open = tracked.filter((item) => item.checked < i);
		if (!open.length) continue;
		// Without the event there is no proof of order relative to the review's acceptance. The event may not have arrived yet, so this state is not cached.
		if (!boundary) {
			for (const item of open) {
				item.range = null;
				item.cacheable = false;
			}
			continue;
		}
		for (const scope of available) {
			const waiting = open.filter(
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
				const fresh = matching.filter((item) => item.range === undefined),
					unknown = fresh.filter((item) => !positions.has(`${item.name}/${file.before}`));
				if (unknown.length) {
					const [blob] = await readBlobs(scope, [file.before]);
					if (!blob || blob.binary || blob.tooLarge) {
						for (const item of unknown) remember(positions, `${item.name}/${file.before}`, null);
					} else {
						const found = await worker.run<AnchorPosition[]>({
							anchors: unknown.map((item) => ({ ...item.comment.anchor, side: 'old' })),
							before: blob.text,
							after: blob.text,
							oldBlob: file.before,
							newBlob: file.before,
						});
						unknown.forEach((item, index) => {
							const position = found[index]!;
							remember(
								positions,
								`${item.name}/${file.before}`,
								position.start === null || position.end === null
									? null
									: { start: position.start, end: position.end }
							);
						});
					}
				}
				for (const item of fresh) item.range = positions.get(`${item.name}/${file.before}`) ?? null;
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
		for (const item of open)
			if (item.cacheable && available.some((scope) => scope.id === item.comment.anchor.scopeId)) {
				item.checked = i;
				item.saved = {
					from,
					seq: item.seq,
					checked: i,
					at: checkpoint.at,
					boundary: boundary.seq,
					path: item.path,
					range: item.range,
					addressed: item.comment.addressed ? (item.comment.addressedCheckpoint ?? null) : null,
				};
			}
	}
	for (const item of tracked) if (item.saved) remember(progress, item.name, item.saved);
}
