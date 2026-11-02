import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SessionStore, atomicJson } from '@brigadir/persistence';
import { git, Snapshots } from '@brigadir/git';
import { Changes } from './changes';
import { Reviews } from './review';
const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
it('persists both sides, marks relocated and ambiguous anchors, and derives sent state from the journal', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-review-'));
	roots.push(root);
	const repo = join(root, 'repo');
	await mkdir(repo);
	await git(repo, ['init', '-q']);
	await writeFile(join(repo, 'file.ts'), 'above\nold\nbelow\n');
	const store = await SessionStore.at(join(root, 'data'));
	const project = await store.addProject(repo);
	const task = await store.createTask(project.id, 'Review', 'claude');
	const snapshots = await Snapshots.open(store, task);
	await snapshots.capture('baseline');
	const text = 'above\nnew\nbelow\n';
	await writeFile(join(repo, 'file.ts'), text);
	await snapshots.capture('turn');
	const changes = new Changes(store.root, resolve('apps/desktop/out/services/diff.cjs'));
	const reviews = new Reviews(changes);
	let file = (await changes.read(task)).files[0]!;
	await Promise.all([
		reviews.add(task, { fileId: file.id, side: 'old', start: 2, end: 2, text: 'Old code note' }),
		reviews.add(task, {
			fileId: file.id,
			side: 'new',
			start: 2,
			end: 2,
			text: 'Use a descriptive name',
		}),
	]);
	expect((await reviews.read(task, file.id)).comments.map((c) => c.position?.state)).toEqual([
		'exact',
		'exact',
	]);
	const command = await reviews.prepare(task);
	expect(command.kind).toBe('submitReview');
	if (command.kind !== 'submitReview') throw new Error('Wrong command');
	const writer = await store.writer(task);
	await writer.append({ kind: 'turn.started', text: command.text, review: command.review });
	await writer.close();
	expect((await reviews.read(task, null)).comments.every((c) => c.sent)).toBe(true);
	await expect(reviews.prepare(task)).rejects.toThrow('No pending');
	const comment = (await reviews.read(task, null)).comments[1]!;
	await reviews.edit(task, comment.id, 'Updated note');
	expect((await reviews.read(task, null)).comments[1]?.sent).toBe(false);
	await writeFile(join(repo, 'file.ts'), 'inserted\n' + text);
	await snapshots.capture('turn');
	file = (await changes.read(task)).files[0]!;
	expect((await reviews.read(task, file.id)).comments[1]?.position).toEqual({
		state: 'relocated',
		start: 3,
		end: 3,
	});
	expect(
		(await reviews.positions(task, comment.id)).find((item) => item.id === comment.id)?.position
	).toEqual({ state: 'relocated', start: 3, end: 3 });
	await writeFile(join(repo, 'file.ts'), text + text);
	await snapshots.capture('turn');
	file = (await changes.read(task)).files[0]!;
	expect((await reviews.read(task, file.id)).comments[1]?.position?.state).toBe('outdated');
	expect(
		(await reviews.positions(task, comment.id)).find((item) => item.id === comment.id)?.position
			?.state
	).toBe('outdated');
	const path = join(await store.taskDir(task), 'review.json');
	await atomicJson(path, { schemaVersion: 2, comments: [] });
	const bytes = await readFile(path);
	await expect(reviews.remove(task, comment.id)).rejects.toThrow();
	expect(await readFile(path)).toEqual(bytes);
}, 20000);

it('counts only agent changes to sent lines, follows shifts and rename, and persists explicit resolution per version', async () => {
	const { rename } = await import('node:fs/promises');
	const root = await mkdtemp(join(tmpdir(), 'brigadir-review-status-'));
	roots.push(root);
	const repo = join(root, 'repo');
	await mkdir(repo);
	await git(repo, ['init', '-q']);
	const original = 'before\nreview me\nafter\n';
	await writeFile(join(repo, 'file.ts'), original);
	const store = await SessionStore.at(join(root, 'data')),
		project = await store.addProject(repo),
		task = await store.createTask(project.id, 'Status', 'claude');
	const snapshots = await Snapshots.open(store, task);
	await snapshots.capture('baseline');
	const writer = await store.writer(task);
	await writer.append({ kind: 'checkpoint.created', checkpoint: 0 });
	const changes = new Changes(store.root, resolve('apps/desktop/out/services/diff.cjs')),
		reviews = new Reviews(changes);
	const scope = snapshots.current.scopes[0]!;
	const { gitText } = await import('@brigadir/git');
	const blob = await gitText(repo, [
		'rev-parse',
		`${snapshots.current.checkpoints[0]!.trees[0]!.tree}:file.ts`,
	]);
	await reviews.addEditor(
		task,
		{ start: 2, end: 2, text: 'Please fix' },
		{ scopeId: scope.id, path: 'file.ts', blob, text: original }
	);
	let comment = (await reviews.read(task, null)).comments[0]!;
	await expect(reviews.resolve(task, comment.id, true)).rejects.toThrow('not been sent');
	const command = await reviews.prepare(task);
	if (command.kind !== 'submitReview') throw new Error('Wrong command');
	await writer.append({ kind: 'turn.started', text: command.text, review: command.review });
	await writeFile(join(repo, 'file.ts'), 'prefix\n' + original);
	await rename(join(repo, 'file.ts'), join(repo, 'renamed.ts'));
	let checkpoint = await snapshots.capture('tools');
	await writer.append({ kind: 'checkpoint.created', checkpoint: checkpoint!.id });
	expect((await reviews.read(task, null)).comments[0]?.addressed).not.toBe(true);
	await writeFile(join(repo, 'renamed.ts'), 'prefix\nbefore\nfixed by agent\nafter\n');
	checkpoint = await snapshots.capture('tools');
	await writer.append({ kind: 'checkpoint.created', checkpoint: checkpoint!.id });
	expect((await reviews.read(task, null)).comments[0]?.addressed).toBe(true);
	expect((await new Reviews(changes).read(task, null)).comments[0]).toMatchObject({
		addressed: true,
		addressedVersion: 1,
		addressedCheckpoint: checkpoint!.id,
	});
	await reviews.resolve(task, comment.id, true);
	expect((await new Reviews(changes).read(task, null)).comments[0]?.resolved).toBe(true);
	await reviews.resolve(task, comment.id, false);
	expect((await reviews.read(task, null)).comments[0]?.resolved).toBe(false);
	await reviews.edit(task, comment.id, 'New version');
	comment = (await reviews.read(task, null)).comments[0]!;
	expect(comment.sent).toBe(false);
	expect(comment.resolved).toBe(false);
	await writer.close();
}, 20000);

it.each(['user-after', 'baseline'] as const)(
	'never attributes a %s rewrite to a later agent edit of the same file',
	async (reason) => {
		const root = await mkdtemp(join(tmpdir(), 'brigadir-review-user-'));
		roots.push(root);
		const repo = join(root, 'repo');
		await mkdir(repo);
		await git(repo, ['init', '-q']);
		const text = 'a\ntarget\nc\n';
		await writeFile(join(repo, 'file.ts'), text);
		const store = await SessionStore.at(join(root, 'data')),
			project = await store.addProject(repo),
			task = await store.createTask(project.id, 'User', 'claude'),
			snapshots = await Snapshots.open(store, task);
		await snapshots.capture('baseline');
		const writer = await store.writer(task);
		await writer.append({ kind: 'checkpoint.created', checkpoint: 0 });
		const changes = new Changes(store.root, resolve('apps/desktop/out/services/diff.cjs')),
			reviews = new Reviews(changes),
			scope = snapshots.current.scopes[0]!;
		const { gitText } = await import('@brigadir/git');
		const blob = await gitText(repo, [
			'rev-parse',
			`${snapshots.current.checkpoints[0]!.trees[0]!.tree}:file.ts`,
		]);
		await reviews.addEditor(
			task,
			{ start: 2, end: 2, text: 'Fix this' },
			{ scopeId: scope.id, path: 'file.ts', blob, text }
		);
		const command = await reviews.prepare(task);
		if (command.kind !== 'submitReview') throw new Error('Wrong command');
		await writer.append({ kind: 'turn.started', text: command.text, review: command.review });
		await writeFile(join(repo, 'file.ts'), 'a\nuser rewrote\nc\n');
		let point = await snapshots.capture(reason);
		await writer.append({ kind: 'checkpoint.created', checkpoint: point!.id });
		expect((await reviews.read(task, null)).comments[0]?.addressed).not.toBe(true);
		await writeFile(join(repo, 'file.ts'), 'a\nagent rewrote\nc\n');
		point = await snapshots.capture('tools');
		await writer.append({ kind: 'checkpoint.created', checkpoint: point!.id });
		expect((await reviews.read(task, null)).comments[0]?.addressed).not.toBe(true);
		await writer.close();
	},
	20000
);

it('removes only explicit review versions atomically and preserves later notes', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-review-delete-'));
	roots.push(root);
	const repo = join(root, 'repo');
	await mkdir(repo);
	const store = await SessionStore.at(join(root, 'data')),
		project = await store.addProject(repo),
		task = await store.createTask(project.id, 'Delete', 'claude'),
		reviews = new Reviews(new Changes(store.root, resolve('apps/desktop/out/services/diff.cjs')));
	await reviews.addNote(task, 'First');
	await reviews.addNote(task, 'Second');
	const selected = (await reviews.read(task, null)).notes!.map(({ id, version }) => ({
		id,
		version,
	}));
	await reviews.addNote(task, 'Later');
	await reviews.edit(task, selected[1]!.id, 'Changed');
	const before = await readFile(join(await store.taskDir(task), 'review.json'));
	await expect(reviews.removeSelection(task, selected)).rejects.toThrow('Review changed');
	expect(await readFile(join(await store.taskDir(task), 'review.json'))).toEqual(before);
	await reviews.removeSelection(task, [selected[0]!, { ...selected[1]!, version: 2 }]);
	expect((await reviews.read(task, null)).notes!.map((note) => note.text)).toEqual(['Later']);
});

it('locates unchanged literal paths from immutable trees without loading a diff or editor', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-review-location-'));
	roots.push(root);
	const repo = join(root, 'repo');
	await mkdir(repo);
	await git(repo, ['init', '-q']);
	const path = '[note]*.ts',
		text = '// stable note\n';
	await writeFile(join(repo, path), text);
	const store = await SessionStore.at(join(root, 'data')),
		project = await store.addProject(repo),
		task = await store.createTask(project.id, 'Locations', 'claude'),
		snapshots = await Snapshots.open(store, task);
	await snapshots.capture('baseline');
	const { gitText } = await import('@brigadir/git');
	const tree = snapshots.current.checkpoints[0]!.trees[0]!,
		blob = await gitText(repo, ['rev-parse', `${tree.tree}:${path}`]);
	const changes = new Changes(store.root, resolve('apps/desktop/out/services/diff.cjs')),
		reviews = new Reviews(changes);
	await reviews.addEditor(
		task,
		{ start: 1, end: 1, text: 'Keep it' },
		{ scopeId: tree.scopeId, path, blob, text }
	);
	const comment = (await reviews.read(task, null)).comments[0]!;
	changes.file = async () => {
		throw new Error('Must not load a full diff');
	};
	await writeFile(join(repo, path), 'unsnapshotted replacement\n');
	expect(await reviews.positions(task, comment.id)).toEqual([
		{ id: comment.id, version: 1, position: { state: 'exact', start: 1, end: 1 } },
	]);
	const foreign = await store.createTask(project.id, 'Foreign', 'claude');
	await expect(reviews.positions(foreign, comment.id)).rejects.toThrow('missing');
	await rm(join(repo, path));
	await snapshots.capture('turn');
	expect((await reviews.positions(task, comment.id))[0]?.position?.state).toBe('outdated');
});

it('shows a diff before its highlighting, keeps symbol paths and locates every card of a long review list', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-review-cards-'));
	roots.push(root);
	const repo = join(root, 'repo');
	await mkdir(repo);
	await git(repo, ['init', '-q']);
	for (let i = 0; i < 20; i++)
		await writeFile(
			join(repo, `file${i}.ts`),
			`export function first${i}() {\n  return ${i};\n}\n`
		);
	const store = await SessionStore.at(join(root, 'data')),
		project = await store.addProject(repo),
		task = await store.createTask(project.id, 'Cards', 'claude');
	const snapshots = await Snapshots.open(store, task);
	await snapshots.capture('baseline');
	for (let i = 0; i < 20; i++)
		await writeFile(
			join(repo, `file${i}.ts`),
			`export function first${i}() {\n  return ${i + 1};\n}\n`
		);
	await snapshots.capture('turn');
	const changes = new Changes(store.root, resolve('apps/desktop/out/services/diff.cjs')),
		reviews = new Reviews(changes),
		files = (await changes.read(task)).files;
	const diff = await changes.file(task, files[0]!.id);
	expect(diff.lines.some((line) => line.kind === 'added')).toBe(true);
	expect(diff.afterSyntax).toBeUndefined();
	expect((await changes.fileSyntax(task, files[0]!.id)).afterSyntax?.status).toBe('ready');
	// A review round over several files keeps each diff (the old cache held three).
	for (const file of files.slice(1, 6)) await changes.file(task, file.id);
	expect(await changes.file(task, files[0]!.id)).toBe(diff);
	for (const file of files)
		await reviews.add(task, { fileId: file.id, side: 'new', start: 2, end: 2, text: 'Check' });
	const comments = (await reviews.read(task, null)).comments;
	expect(new Set(comments.map((comment) => comment.anchor.symbolPath))).toEqual(
		new Set(files.map((file) => file.path.replace(/file(\d+)\.ts/, 'first$1')))
	);
	// Every card asks on mount and again on a new revision: 40 requests must not overflow the queue of 12.
	const results = await Promise.allSettled(
		[...comments, ...comments].map((comment) => reviews.positions(task, comment.id))
	);
	expect(
		results.every(
			(result) => result.status === 'fulfilled' && result.value[0]?.position?.state === 'exact'
		)
	).toBe(true);
}, 30000);
