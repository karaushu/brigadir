import { readSnapshots, readBlobs, git, isSha, treeBlob, viewTrees } from '@brigadir/git';
import { reviewFiles, type ReviewPosition, type Scope } from '@brigadir/core';
import { markAddressed } from './review-status';
import { createHash, randomUUID } from 'node:crypto';
import {
	isReviewNote,
	type ReviewNote,
	type ReviewSelection,
	enclosingSymbol,
	isRecord,
	isReviewComment,
	type AnchorPosition,
	type CommentInput,
	type ReviewComment,
	type ReviewSnapshot,
	type SessionCommand,
	type TaskKey,
} from '@brigadir/core';
import { SessionStore, atomicJson, safePath, readDocument } from '@brigadir/persistence';
import { anchorContext, normalizeLine } from '@brigadir/diff';
import { Changes } from './changes';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
export class Reviews {
	private positionTail: Promise<unknown> = Promise.resolve();
	private positionWaiting = new Map<string, Promise<ReviewPosition[]>>();
	private tails = new Map<string, Promise<unknown>>();
	get isSaving() {
		return this.tails.size > 0;
	}
	waitForWrites() {
		return Promise.allSettled([...this.tails.values()]);
	}
	/** `changed`: a review write from any source (API, MCP, another surface); the renderer re-reads the task's review. */
	constructor(
		readonly changes: Changes,
		private readonly changed: (key: TaskKey) => void = () => {}
	) {}
	private async document(key: TaskKey) {
		const store = await SessionStore.at(this.changes.dataDir);
		await store.task(key);
		const path = await safePath(await store.taskDir(key), 'review.json');
		let value: Record<string, unknown>;
		try {
			value = await readDocument(path, 16 * 1024 * 1024);
		} catch (e) {
			if (!isRecord(e) || e.code !== 'ENOENT') throw e;
			value = { schemaVersion: 1, comments: [] };
		}
		if (
			!Array.isArray(value.comments) ||
			value.comments.length > 500 ||
			!value.comments.every(isReviewComment) ||
			new Set(value.comments.map((c) => c.id)).size !== value.comments.length
		)
			throw new Error('Invalid review');
		const notes = value.notes ?? [];
		if (
			!Array.isArray(notes) ||
			!notes.every(isReviewNote) ||
			notes.length + value.comments.length > 500 ||
			new Set([...value.comments, ...notes].map((c) => c.id)).size !==
				value.comments.length + notes.length
		)
			throw new Error('Invalid review notes');
		return {
			store,
			path,
			value,
			notes: notes as ReviewNote[],
			comments: value.comments as ReviewComment[],
		};
	}
	private mutate(
		key: TaskKey,
		change: (
			comments: ReviewComment[],
			notes: ReviewNote[]
		) => Promise<ReviewComment[]> | ReviewComment[]
	) {
		const name = `${key.projectId}/${key.id}`;
		const next = (this.tails.get(name) ?? Promise.resolve())
			.catch(() => {})
			.then(async () => {
				const doc = await this.document(key);
				const comments = await change(doc.comments, doc.notes);
				const value = { ...doc.value, comments, notes: doc.notes };
				if (
					value.comments.length + value.notes.length > 500 ||
					Buffer.byteLength(JSON.stringify(value, null, 2)) > 16 * 1024 * 1024
				)
					throw new Error('Review exceeds its storage limit');
				await atomicJson(doc.path, value);
				this.changed(key);
			});
		this.tails.set(name, next);
		void next
			.finally(() => {
				if (this.tails.get(name) === next) this.tails.delete(name);
			})
			.catch(() => {});
		return next;
	}
	async anchor(key: TaskKey, id: string) {
		const { comments } = await this.document(key);
		const comment = comments.find((comment) => comment.id === id);
		if (!comment) throw new Error('Comment is missing');
		return comment.anchor;
	}
	async read(key: TaskKey, fileId: string | null): Promise<ReviewSnapshot> {
		await this.tails.get(`${key.projectId}/${key.id}`)?.catch(() => {});
		const { comments, notes, store } = await this.document(key);
		if (!comments.length && !notes.length) return { comments: [], notes: [] };
		const journal = await store.journal(key);
		if (journal.issue) throw new Error(journal.issue);
		const sent = new Set(
			journal.records.flatMap((r) =>
				r.event.kind === 'turn.started'
					? (r.event.review?.comments.map((c) => `${c.id}/${c.version}`) ?? [])
					: []
			)
		);
		const result: ReviewSnapshot = {
			notes: notes.map((n) => ({
				...n,
				sent: sent.has(`${n.id}/${n.version}`),
				resolved: n.resolvedVersion === n.version,
			})),
			comments: comments.map((c) => ({
				...c,
				sent: sent.has(`${c.id}/${c.version}`),
				resolved: c.resolvedVersion === c.version,
				addressed: c.addressedVersion === c.version,
			})),
		};
		await markAddressed(store, key, result, journal.records, this.changes.diffs);
		const detected = result.comments.filter(
			(comment) => comment.addressed && comment.addressedVersion !== comment.version
		);
		if (detected.length)
			await this.mutate(key, (comments) =>
				comments.map((comment) => {
					const evidence = detected.find(
						(item) => item.id === comment.id && item.version === comment.version
					);
					return evidence
						? {
								...comment,
								addressedVersion: comment.version,
								addressedCheckpoint: evidence.addressedCheckpoint!,
							}
						: comment;
				})
			);
		if (fileId) {
			const diff = await this.changes.file(key, fileId);
			const relevant = result.comments.filter(
				(c) =>
					c.anchor.scopeId === diff.file.scopeId &&
					(c.anchor.path === diff.file.path || c.anchor.path === diff.file.oldPath)
			);
			if (relevant.length) {
				const positions = await this.changes.compute<AnchorPosition[]>({
					anchors: relevant.map((c) => c.anchor),
					before: diff.beforeText,
					after: diff.afterText,
					oldBlob: diff.file.before,
					newBlob: diff.file.after,
				});
				relevant.forEach((c, i) => {
					c.position = positions[i]!;
				});
			}
		}
		return result;
	}
	/**
	 * One card, one request, run in order. A request that has not started yet reads the review when it starts, so a
	 * repeat for the same comment joins it instead of taking a place in the queue (otherwise a list of cards would
	 * overflow a queue of 12 and show a false "location is unavailable").
	 */
	positions(key: TaskKey, id: string): Promise<ReviewPosition[]> {
		const name = `${key.projectId}/${key.id}/${id}`,
			waiting = this.positionWaiting.get(name);
		if (waiting) return waiting;
		if (this.positionWaiting.size >= 128)
			return Promise.reject(new Error('Review position queue is full'));
		const result = this.positionTail
			.catch(() => {})
			.then(() => {
				this.positionWaiting.delete(name);
				return this.locate(key, id);
			});
		this.positionWaiting.set(name, result);
		this.positionTail = result;
		return result;
	}
	private async locate(key: TaskKey, id: string): Promise<ReviewPosition[]> {
		await this.tails.get(`${key.projectId}/${key.id}`)?.catch(() => {});
		const { comments, store } = await this.document(key),
			comment = comments.find((item) => item.id === id);
		if (!comment) throw new Error('Comment is missing');
		const changes = await this.changes.read(key),
			group = reviewFiles({ comments: comments.map((item) => ({ ...item, sent: false })) }, changes)
				.groups.flatMap((group) => group.files)
				.find((file) => file.comments.some((item) => item.id === id))!;
		const unavailable = () =>
			group.comments.map(({ id, version }) => ({ id, version, position: null }));
		const scope = changes.scopes.find((scope) => scope.id === group.scopeId);
		if (!scope || scope.available === false) return unavailable();
		let before: string | null, after: string | null;
		if (group.change) {
			if (group.change.gitlink || group.change.binary) return unavailable();
			before = group.change.before;
			after = group.change.after;
		} else {
			// The same base as the displayed diff: a snapshot range, or HEAD under the base setting (spec/diff-and-review#diff-base).
			const snapshots = await readSnapshots(store, key),
				trees = snapshots ? await viewTrees(snapshots, scope, this.changes.view(key)) : null;
			if (!trees) return unavailable();
			[before, after] = await Promise.all([
				treeBlob(scope, trees.old, group.path),
				treeBlob(scope, trees.next, group.path),
			]);
		}
		const [old, next] = await readBlobs(scope, [before, after]);
		if (!old || !next || old.binary || next.binary || old.tooLarge || next.tooLarge)
			return unavailable();
		const positions = await this.changes.compute<AnchorPosition[]>({
			anchors: group.comments.map((item) => item.anchor),
			before: old.text,
			after: next.text,
			oldBlob: before,
			newBlob: after,
		});
		return group.comments.map(({ id, version }, index) => ({
			id,
			version,
			position: positions[index]!,
		}));
	}
	add(key: TaskKey, input: CommentInput) {
		return this.mutate(key, async (comments) => {
			const diff = await this.changes.file(key, input.fileId);
			if (diff.binary || diff.tooLarge || diff.file.gitlink)
				throw new Error('The file has no text diff');
			const blob = input.side === 'old' ? diff.file.before : diff.file.after;
			if (!blob) throw new Error('The side has no blob');
			const context = anchorContext(
				input.side === 'old' ? diff.beforeText : diff.afterText,
				input.start,
				input.end
			);
			const syntax = await this.changes.fileSyntax(key, input.fileId);
			const comment: ReviewComment = {
				id: randomUUID(),
				version: 1,
				text: input.text,
				at: new Date().toISOString(),
				...(input.excerpt ? { excerpt: input.excerpt } : {}),
				anchor: {
					scopeId: diff.file.scopeId,
					path: diff.file.path,
					side: input.side,
					blob,
					start: input.start,
					end: input.end,
					...context,
					contextHash: sha(JSON.stringify({ ...context, quote: context.quote.map(normalizeLine) })),
					symbolPath:
						enclosingSymbol(
							(input.side === 'old' ? syntax.beforeSyntax : syntax.afterSyntax)?.symbols ?? [],
							input.start,
							input.end
						)?.path ?? null,
				},
			};
			return [...comments, comment];
		});
	}
	async readEditor(
		key: TaskKey,
		context: { scopeId: string; path: string; blob: string; text: string }
	): Promise<ReviewSnapshot> {
		const review = await this.read(key, null);
		const comments = review.comments.filter(
			(c) => c.anchor.scopeId === context.scopeId && c.anchor.path === context.path
		);
		if (comments.length) {
			const positions = await this.changes.compute<AnchorPosition[]>({
				anchors: comments.map((c) => c.anchor),
				before: context.text,
				after: context.text,
				oldBlob: context.blob,
				newBlob: context.blob,
			});
			comments.forEach((c, i) => {
				c.position = positions[i]!;
			});
		}
		return { comments };
	}
	addEditor(
		key: TaskKey,
		input: { start: number; end: number; text: string; excerpt?: string },
		context: { scopeId: string; path: string; blob: string; text: string }
	) {
		return this.mutate(key, async (comments) => {
			const quoted = anchorContext(context.text, input.start, input.end);
			if (quoted.quote.some((line) => line.length > 4000))
				throw new Error('Selected lines are too large');
			const syntax = await this.changes.syntax.read(context.path, context.text);
			const anchor = {
				scopeId: context.scopeId,
				path: context.path,
				side: 'new' as const,
				blob: context.blob,
				start: input.start,
				end: input.end,
				...quoted,
				contextHash: sha(JSON.stringify({ ...quoted, quote: quoted.quote.map(normalizeLine) })),
				symbolPath: enclosingSymbol(syntax.symbols, input.start, input.end)?.path ?? null,
			};
			return [
				...comments,
				{
					id: randomUUID(),
					version: 1,
					text: input.text,
					at: new Date().toISOString(),
					...(input.excerpt ? { excerpt: input.excerpt } : {}),
					anchor,
				},
			];
		});
	}
	addNote(key: TaskKey, text: string) {
		return this.mutate(key, (comments, notes) => {
			notes.push({ id: randomUUID(), version: 1, text, at: new Date().toISOString() });
			return comments;
		});
	}
	edit(key: TaskKey, id: string, text: string) {
		return this.mutate(key, (comments, notes) => {
			const note = notes.find((n) => n.id === id);
			if (note) {
				note.text = text;
				note.version++;
				return comments;
			}
			if (!comments.some((c) => c.id === id)) throw new Error('Comment is missing');
			return comments.map((c) => (c.id === id ? { ...c, text, version: c.version + 1 } : c));
		});
	}
	resolve(key: TaskKey, id: string, resolved: boolean) {
		return this.mutate(key, async (comments, notes) => {
			const item = [...comments, ...notes].find((item) => item.id === id);
			if (!item) throw new Error('Comment is missing');
			const { store } = await this.document(key),
				journal = await store.journal(key);
			if (journal.issue) throw new Error(journal.issue);
			if (
				!journal.records.some(
					(record) =>
						record.event.kind === 'turn.started' &&
						record.event.review?.comments.some((c) => c.id === id && c.version === item.version)
				)
			)
				throw new Error('Comment has not been sent');
			if (resolved) item.resolvedVersion = item.version;
			else delete item.resolvedVersion;
			return comments;
		});
	}
	remove(key: TaskKey, id: string) {
		return this.mutate(key, (comments, notes) => {
			const index = notes.findIndex((n) => n.id === id);
			if (index >= 0) notes.splice(index, 1);
			return comments.filter((c) => c.id !== id);
		});
	}
	removeSelection(key: TaskKey, selection: ReviewSelection) {
		return this.mutate(key, (comments, notes) => {
			const current = new Map(
				[...comments, ...notes].map((comment) => [comment.id, comment.version])
			);
			for (const item of selection)
				if (current.get(item.id) !== item.version) throw new Error('Review changed');
			const ids = new Set(selection.map((item) => item.id));
			for (let i = notes.length - 1; i >= 0; i--) if (ids.has(notes[i]!.id)) notes.splice(i, 1);
			return comments.filter((comment) => !ids.has(comment.id));
		});
	}
	/**
	 * spec/diff-and-review#agent-review-rounds: `Back to the agent` on a disputed reviewer's comment — a new version of it goes to the task's agent as the
	 * person's own; the thread keeps the reviewer and the round.
	 */
	async sendBack(key: TaskKey, id: string): Promise<SessionCommand> {
		await this.mutate(key, (comments) => {
			const comment = comments.find((item) => item.id === id);
			if (!comment?.review) throw new Error('Comment is missing');
			return comments.map((item) =>
				item.id === id
					? {
							...item,
							version: item.version + 1,
							review: { ...item.review!, disputed: false },
						}
					: item
			);
		});
		const comment = (await this.read(key, null)).comments.find((item) => item.id === id)!;
		const comments = [{ id: comment.id, version: comment.version }];
		return {
			kind: 'submitReview',
			text: `The person sends this reviewer's comment back to you: fix it as it asks.\n\n1. File ${JSON.stringify(comment.anchor.path)}, scope ${comment.anchor.scopeId}, ${comment.anchor.side} side, blob ${comment.anchor.blob}, lines ${comment.anchor.start}-${comment.anchor.end}.\nComment by ${comment.review?.reviewer ?? 'the reviewer'}: ${comment.text}\nQuoted code: ${JSON.stringify(comment.anchor.quote.join('\n'))}`,
			review: { id: sha(JSON.stringify(comments)), comments },
		};
	}
	async prepare(key: TaskKey): Promise<SessionCommand> {
		const review = await this.read(key, null);
		const pending = [
			...review.comments.filter((c) => !c.sent),
			...(review.notes ?? []).filter((n) => !n.sent),
		];
		if (!pending.length) throw new Error('No pending comments');
		const comments = pending.map((c) => ({ id: c.id, version: c.version }));
		const id = sha(JSON.stringify(comments));
		const text =
			'Address the following review comments for this task. The quoted code belongs to the specified snapshot; verify its current location before editing.\n\n' +
			pending
				.map((c, i) =>
					!isReviewComment(c)
						? `${i + 1}. General note: ${c.text}`
						: `${i + 1}. File ${JSON.stringify(c.anchor.path)}, scope ${c.anchor.scopeId}, ${c.anchor.side} side, blob ${c.anchor.blob}, lines ${c.anchor.start}-${c.anchor.end}.\nComment: ${c.text}\nQuoted code: ${JSON.stringify(c.anchor.quote.join('\n'))}${c.excerpt ? `\nSelected text: ${JSON.stringify(c.excerpt)}` : ''}`
				)
				.join('\n\n');
		if (text.length > 1_000_000) throw new Error('Review prompt is too large');
		return { kind: 'submitReview', text, review: { id, comments } };
	}
}
