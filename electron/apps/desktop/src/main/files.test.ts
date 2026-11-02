import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { SessionStore } from '@brigadir/persistence';
import { git, readSnapshots } from '@brigadir/git';
import { Files } from './files';
import { Changes } from './changes';
import { Sessions } from './sessions';
const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
it('resolves opaque IDs, enforces task leases, and records offline save checkpoints without an agent', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-editor-'));
	roots.push(root);
	const repo = join(root, 'repo');
	await mkdir(repo);
	await git(repo, ['init', '-q']);
	await writeFile(join(repo, 'a.txt'), 'before\n');
	const store = await SessionStore.at(join(root, 'data'));
	const project = await store.addProject(repo);
	const task = await store.createTask(project.id, 'Edit', 'claude');
	const other = await store.createTask(project.id, 'Other', 'codex');
	const changes = new Changes(store.root, resolve('apps/desktop/out/services/diff.cjs'));
	const sessions = new Sessions(store.root, resolve('apps/desktop/out/services'), () => {});
	const files = new Files(changes, sessions);
	const search = await files.search(task, 'at');
	expect(search.entries.map((e) => e.path)).toEqual(['a.txt']);
	expect((await files.search(task, 'no-match')).entries).toHaveLength(0);
	const id = (await files.list(task, null)).entries[0]!.id;
	const doc = await files.read(task, id);
	expect(doc.locked).toBe(false);
	await expect(files.read(other, id)).rejects.toThrow('Unknown file');
	const otherId = (await files.list(other, null)).entries[0]!.id;
	expect((await files.read(other, otherId)).locked).toBe(true);
	await expect(files.save(other, otherId, doc.version, 'wrong')).rejects.toThrow('another task');
	const result = await files.save(task, id, doc.version, 'after\n');
	expect(result.status).toBe('saved');
	expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('after\n');
	const snapshots = await readSnapshots(store, task);
	expect(snapshots?.checkpoints.map((c) => c.reason)).toEqual(['user-before', 'user-after']);
	expect((await store.journal(task)).records.some((r) => r.event.kind === 'file.saved')).toBe(true);
	await expect(readFile(join(await store.taskDir(task), 'host.json'))).rejects.toMatchObject({
		code: 'ENOENT',
	});
	await files.release(task, id);
	expect((await files.read(other, otherId)).locked).toBe(false);
	const events = join(await store.taskDir(other), 'events.jsonl');
	await writeFile(events, '{"schemaVersion":99}\n');
	await expect(
		files.save(other, otherId, result.content.version, 'should not write')
	).rejects.toThrow('unsupported_schema');
	expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('after\n');
});
it('anchors an unchanged editor file to its snapshot and rejects unsnapshotted or stale bytes', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-editor-notes-'));
	roots.push(root);
	const repo = join(root, 'repo');
	await mkdir(repo);
	await git(repo, ['init', '-q']);
	const source = 'export function value() {\n  return "ok";\n}\n';
	await writeFile(join(repo, 'a.ts'), source);
	const store = await SessionStore.at(join(root, 'data'));
	const project = await store.addProject(repo);
	const task = await store.createTask(project.id, 'Notes', 'claude');
	const { Snapshots } = await import('@brigadir/git');
	const snapshots = await Snapshots.open(store, task);
	await snapshots.capture('baseline');
	const index = await readFile(
		join(await store.taskDir(task), 'snap-index-' + snapshots.current.scopes[0]!.id)
	);
	const changes = new Changes(store.root, resolve('apps/desktop/out/services/diff.cjs'));
	const files = new Files(
		changes,
		new Sessions(store.root, resolve('apps/desktop/out/services'), () => {})
	);
	const { Reviews } = await import('./review');
	const reviews = new Reviews(changes);
	expect((await changes.read(task)).files).toHaveLength(0);
	const id = (await files.list(task, null)).entries[0]!.id;
	const document = await files.read(task, id);
	const context = await files.commentContext(task, id, document.version);
	await reviews.addEditor(task, { start: 2, end: 2, text: 'Name this result' }, context);
	const comment = (await reviews.readEditor(task, context)).comments[0]!;
	expect(comment.anchor.symbolPath).toBe('value');
	expect(comment.anchor.quote).toEqual(['  return "ok";']);
	expect(comment.position?.state).toBe('exact');
	expect((await files.fromAnchor(task, await reviews.anchor(task, comment.id))).text).toBe(source);
	await expect(reviews.anchor(task, '00000000-0000-0000-0000-000000000000')).rejects.toThrow(
		'missing'
	);
	expect((await reviews.prepare(task)).kind).toBe('submitReview');
	await reviews.addNote(task, 'Check the whole task');
	const note = (await reviews.read(task, null)).notes![0]!;
	const batch = await reviews.prepare(task);
	expect(batch.kind).toBe('submitReview');
	if (batch.kind === 'submitReview') {
		expect(batch.review.comments).toHaveLength(2);
		expect(batch.text).toContain('General note: Check the whole task');
	}
	await reviews.edit(task, note.id, 'Updated general note');
	expect((await reviews.read(task, null)).notes![0]!.version).toBe(2);
	await reviews.remove(task, note.id);
	expect((await reviews.read(task, null)).notes).toHaveLength(0);
	expect(
		await readFile(join(await store.taskDir(task), 'snap-index-' + snapshots.current.scopes[0]!.id))
	).toEqual(index);
	await writeFile(join(repo, 'a.ts'), '// inserted\n' + source);
	await expect(files.commentContext(task, id, document.version)).rejects.toThrow('version');
	const next = await files.read(task, id);
	await expect(files.commentContext(task, id, next.version)).rejects.toThrow('Refresh');
	await snapshots.capture('refresh');
	const moved = await reviews.readEditor(task, await files.commentContext(task, id, next.version));
	expect(moved.comments[0]!.position).toEqual({ state: 'relocated', start: 3, end: 3 });
});

it('refreshes offline without an agent, preserves the writer lock and refuses newer journals', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-offline-refresh-'));
	roots.push(root);
	const repo = join(root, 'repo');
	await mkdir(repo);
	await git(repo, ['init', '-q']);
	await writeFile(join(repo, 'a.txt'), 'before\n');
	const store = await SessionStore.at(join(root, 'data')),
		project = await store.addProject(repo),
		task = await store.createTask(project.id, 'Refresh', 'claude');
	const changes = new Changes(store.root, resolve('apps/desktop/out/services/diff.cjs')),
		sessions = new Sessions(store.root, resolve('apps/desktop/out/services'), () => {}),
		files = new Files(changes, sessions);
	await files.refresh(task);
	expect((await changes.read(task)).files).toEqual([]);
	await writeFile(join(repo, 'a.txt'), 'outside\n');
	const writer = await store.writer(task);
	await writer.append({ kind: 'turn.started', text: 'crashed turn' });
	await writer.close();
	await files.refresh(task);
	expect((await changes.read(task)).files.map((file) => file.path)).toEqual(['a.txt']);
	const records = (await store.journal(task)).records;
	const stopped = records.findLast((record) => record.event.kind === 'host.stopped')!;
	expect(stopped.event).toMatchObject({ reason: 'recovered_before_refresh' });
	expect(stopped.seq).toBeLessThan(records.at(-1)!.seq);
	await expect(readFile(join(await store.taskDir(task), 'host.json'))).rejects.toMatchObject({
		code: 'ENOENT',
	});
	const { acquireOwner } = await import('@brigadir/host/client');
	const release = await acquireOwner(
		store,
		task,
		resolve('apps/desktop/out/services/process-owner')
	);
	try {
		await expect(files.refresh(task)).rejects.toThrow();
	} finally {
		await release();
	}
	const path = join(await store.taskDir(task), 'events.jsonl');
	await writeFile(path, '{"schemaVersion":99}\n');
	const before = await readFile(join(await store.taskDir(task), 'snapshots.json'));
	await expect(files.refresh(task)).rejects.toThrow('unsupported_schema');
	expect(await readFile(join(await store.taskDir(task), 'snapshots.json'))).toEqual(before);
});

it('respects Git ignore while retaining known nested scopes, reports rollup status and leaves the index untouched', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-tree-'));
	roots.push(root);
	const repo = join(root, 'repo');
	await mkdir(repo);
	await git(repo, ['init', '-q']);
	await git(repo, ['config', 'user.name', 'Fixture']);
	await git(repo, ['config', 'user.email', 'fixture@localhost']);
	await writeFile(join(repo, '.gitignore'), 'hidden.txt\napps/\nnode_modules/\n');
	await writeFile(join(repo, 'a.txt'), 'before\n');
	await git(repo, ['add', '.']);
	await git(repo, ['commit', '-qm', 'Baseline']);
	const nested = join(repo, 'apps/admin');
	await mkdir(nested, { recursive: true });
	await git(nested, ['init', '-q']);
	await writeFile(join(nested, '.gitignore'), 'secret.txt\n');
	await writeFile(join(nested, 'visible.ts'), 'visible\n');
	await writeFile(join(nested, 'secret.txt'), 'hidden\n');
	await writeFile(join(repo, 'hidden.txt'), 'hidden\n');
	await mkdir(join(repo, 'node_modules'));
	await writeFile(join(repo, 'node_modules/package.txt'), 'dependency\n');
	const store = await SessionStore.at(join(root, 'data')),
		project = await store.addProject(repo),
		task = await store.createTask(project.id, 'Tree', 'claude');
	const { Snapshots } = await import('@brigadir/git');
	const snapshots = await Snapshots.open(store, task);
	await snapshots.capture('baseline');
	await writeFile(join(repo, 'a.txt'), 'after\n');
	const index = await readFile(join(repo, '.git/index'));
	const changes = new Changes(store.root, resolve('apps/desktop/out/services/diff.cjs')),
		files = new Files(
			changes,
			new Sessions(store.root, resolve('apps/desktop/out/services'), () => {})
		);
	const entries = (await files.list(task, null)).entries;
	expect(entries.map((entry) => entry.name)).toEqual(['apps', '.gitignore', 'a.txt']);
	expect(entries.find((entry) => entry.name === 'a.txt')?.status).toBe('modified');
	const apps = entries.find((entry) => entry.name === 'apps')!;
	expect(apps.ignored).toBe(true);
	const admin = (await files.list(task, apps.id)).entries.find((entry) => entry.name === 'admin')!;
	expect(admin.scopeKind).toBe('nested');
	expect((await files.list(task, admin.id)).entries.map((entry) => entry.name)).toEqual([
		'.gitignore',
		'visible.ts',
	]);
	expect(
		(await files.list(task, admin.id, true)).entries.find((entry) => entry.name === 'secret.txt')
			?.ignored
	).toBe(true);
	expect(
		(await files.list(task, null, true)).entries.find((entry) => entry.name === 'node_modules')
			?.ignored
	).toBe(true);
	expect((await files.search(task, 'visible')).entries.map((entry) => entry.path)).toEqual([
		'apps/admin/visible.ts',
	]);
	expect((await files.search(task, 'secret', true)).entries.map((entry) => entry.path)).toEqual([
		'apps/admin/secret.txt',
	]);
	expect(await readFile(join(repo, '.git/index'))).toEqual(index);
});

it('uses registered file references and directories for attachments and terminal cwd, rejecting foreign IDs and replaced symlinks', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-file-actions-'));
	roots.push(root);
	const repo = join(root, 'repo');
	await mkdir(join(repo, 'space \"quoted\"'), { recursive: true });
	await writeFile(join(repo, 'space \"quoted\"/a.ts'), 'disk content');
	const store = await SessionStore.at(join(root, 'data')),
		project = await store.addProject(repo),
		task = await store.createTask(project.id, 'Files', 'claude'),
		other = await store.createTask(project.id, 'Other', 'claude');
	const sessions = new Sessions(store.root, resolve('apps/desktop/out/services'), () => {}),
		terminal = vi.spyOn(sessions, 'terminal').mockResolvedValue(null),
		files = new Files(
			new Changes(store.root, resolve('apps/desktop/out/services/diff.cjs')),
			sessions
		);
	const dir = (await files.list(task, null)).entries[0]!,
		file = (await files.list(task, dir.id)).entries[0]!;
	const { Attachments } = await import('@brigadir/persistence');
	const asset = await files.attach(task, file.id),
		input = (await new Attachments(store).read(task, asset.id)).input;
	expect(input.kind).toBe('text');
	if (input.kind === 'text') {
		expect(input.text).toContain(JSON.stringify(file.path));
		expect(input.text).not.toContain('disk content');
	}
	await files.terminalHere(task, file.id);
	expect(terminal).toHaveBeenLastCalledWith(task, {
		kind: 'create',
		role: 'console',
		directory: dir.path,
	});
	await files.terminalHere(task, dir.id);
	expect(terminal).toHaveBeenLastCalledWith(task, {
		kind: 'create',
		role: 'console',
		directory: dir.path,
	});
	await expect(files.attach(other, file.id)).rejects.toThrow('Unknown file');
	await expect(files.terminalHere(other, dir.id)).rejects.toThrow('Unknown file');
	await rm(join(repo, dir.path), { recursive: true });
	await symlink(root, join(repo, dir.path));
	await expect(files.attach(task, file.id)).rejects.toThrow('unsafe_path');
	await expect(files.terminalHere(task, dir.id)).rejects.toThrow('unsafe_path');
});

it('links only existing contained files, resolves path aliases, and acquires no editor lease until opening', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-file-links-'));
	roots.push(root);
	const repo = join(root, 'repo');
	await mkdir(repo);
	await mkdir(join(repo, '.git'));
	await writeFile(join(repo, '.git', 'config'), 'private');
	await writeFile(join(repo, 'My file.ts'), 'export const value = 1;\n');
	await writeFile(join(root, 'outside.ts'), 'outside');
	await symlink(join(root, 'outside.ts'), join(repo, 'escape.ts'));
	const store = await SessionStore.at(join(root, 'data')),
		project = await store.addProject(repo),
		task = await store.createTask(project.id, 'Links', 'claude'),
		other = await store.createTask(project.id, 'Other', 'claude'),
		files = new Files(
			new Changes(store.root, resolve('apps/desktop/out/services/diff.cjs')),
			new Sessions(store.root, resolve('apps/desktop/out/services'), () => {})
		);
	const [links, absolute, outside] = await files.links(task, [
		{ text: '`My file.ts:4` missing.ts escape.ts .git/config ../outside.ts', literal: false },
		{ text: join(repo, 'My file.ts'), literal: true },
		{ text: join(root, 'outside.ts'), literal: true },
	]);
	expect(links).toHaveLength(1);
	expect(absolute).toHaveLength(1);
	expect(outside).toEqual([]);
	expect(absolute![0]!.id).toBe(links![0]!.id);
	expect(links![0]?.line).toBe(4);
	const otherLinks = await files.links(other, [{ text: 'My file.ts', literal: true }]);
	expect((await files.read(other, otherLinks[0]![0]!.id)).locked).toBe(false);
	await files.release(other, otherLinks[0]![0]!.id);
	await expect(files.read(other, links![0]!.id)).rejects.toThrow('Unknown file');
	await rm(join(repo, 'My file.ts'));
	await symlink(join(root, 'outside.ts'), join(repo, 'My file.ts'));
	await expect(files.read(task, links![0]!.id)).rejects.toThrow();
	expect(await readFile(join(root, 'outside.ts'), 'utf8')).toBe('outside');
});
it('links the tail of a path the agent shortened to the one file it names (spec/chat#path-tails)', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-file-tails-'));
	roots.push(root);
	const repo = join(root, 'repo');
	for (const path of [
		'src/App.tsx',
		'src/components/AppLayout/index.js',
		'src/components/AppLayout/lib/Header/index.tsx',
		'src/pages/templates/[templateId]/index.tsx',
		'client/components/Header/index.tsx',
		'client/Card.tsx',
		'admin/Card.tsx',
	]) {
		await mkdir(dirname(join(repo, path)), { recursive: true });
		await writeFile(join(repo, path), 'x\n');
	}
	const store = await SessionStore.at(join(root, 'data')),
		project = await store.addProject(repo),
		task = await store.createTask(project.id, 'Tails', 'claude'),
		files = new Files(
			new Changes(store.root, resolve('apps/desktop/out/services/diff.cjs')),
			new Sessions(store.root, resolve('apps/desktop/out/services'), () => {})
		);
	const paths = async (text: string, literal = false) => {
		const [links] = await files.links(task, [{ text, literal }]);
		return Promise.all(
			links!.map(async (link) => [
				text.slice(link.from, link.to),
				(await files.read(task, link.id)).path,
			])
		);
	};
	expect(
		await Promise.all([
			paths('`AppLayout/index.js:82`, AsidePanel.tsx and `src`'),
			paths('templates/[templateId]/index.tsx:212', true),
		])
	).toEqual([
		[['AppLayout/index.js:82', 'src/components/AppLayout/index.js']],
		[['templates/[templateId]/index.tsx:212', 'src/pages/templates/[templateId]/index.tsx']],
	]);
	// Two files end in `Header/index.tsx`: the one next to `src/App.tsx` of the same message; `Card.tsx` has no such neighbour.
	expect(await paths('src/App.tsx:133 then Header/index.tsx:123 and Card.tsx')).toEqual([
		['src/App.tsx:133', 'src/App.tsx'],
		['Header/index.tsx:123', 'src/components/AppLayout/lib/Header/index.tsx'],
	]);
});
it('links a folder with the IDs Files gives it and the folders above it (spec/chat#folder-links)', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-folder-links-'));
	roots.push(root);
	const repo = join(root, 'repo');
	for (const path of [
		'docs/domains/dashboard/README.md',
		'src/components/AppLayout/lib/Header.tsx',
	]) {
		await mkdir(dirname(join(repo, path)), { recursive: true });
		await writeFile(join(repo, path), 'x\n');
	}
	const store = await SessionStore.at(join(root, 'data')),
		project = await store.addProject(repo),
		task = await store.createTask(project.id, 'Folders', 'claude'),
		files = new Files(
			new Changes(store.root, resolve('apps/desktop/out/services/diff.cjs')),
			new Sessions(store.root, resolve('apps/desktop/out/services'), () => {})
		);
	const text = 'docs/domains/dashboard, `src`, src/components/ and AppLayout/lib',
		[links] = await files.links(task, [{ text, literal: false }]);
	// A bare name of a folder stays text; a written path or a tail with a slash is a folder link with its resolved path.
	expect(
		links!.map((link) => [text.slice(link.from, link.to), link.path, link.folder?.parents.length])
	).toEqual([
		['docs/domains/dashboard', 'docs/domains/dashboard', 2],
		['src/components/', 'src/components', 1],
		['AppLayout/lib', 'src/components/AppLayout/lib', 3],
	]);
	const docs = (await files.list(task, null)).entries.find((entry) => entry.name === 'docs')!,
		domains = (await files.list(task, docs.id)).entries[0]!,
		dashboard = (await files.list(task, domains.id)).entries[0]!;
	expect([...links![0]!.folder!.parents, links![0]!.id]).toEqual([
		docs.id,
		domains.id,
		dashboard.id,
	]);
});
it('polls an open file by stat, reads it only after a change of the same size and keeps the lease', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-editor-check-'));
	roots.push(root);
	const repo = join(root, 'repo');
	await mkdir(repo);
	await writeFile(join(repo, 'a.ts'), 'aaaa\n');
	const store = await SessionStore.at(join(root, 'data')),
		project = await store.addProject(repo),
		task = await store.createTask(project.id, 'Check', 'claude'),
		other = await store.createTask(project.id, 'Other', 'claude');
	const files = new Files(
		new Changes(store.root, resolve('apps/desktop/out/services/diff.cjs')),
		new Sessions(store.root, resolve('apps/desktop/out/services'), () => {})
	);
	const id = (await files.list(task, null)).entries[0]!.id,
		doc = await files.read(task, id);
	expect(await files.check(task, id, doc.version)).toEqual({ locked: false });
	// The unchanged poll is a stat: it neither reads nor hashes the file.
	const read = vi.spyOn(files, 'read');
	for (let i = 0; i < 3; i++)
		expect(await files.check(task, id, doc.version)).toEqual({ locked: false });
	expect(read).not.toHaveBeenCalled();
	await writeFile(join(repo, 'a.ts'), 'bbbb\n');
	const changed = await files.check(task, id, doc.version);
	expect('text' in changed && changed.text).toBe('bbbb\n');
	expect(read).toHaveBeenCalledTimes(1);
	const version = (changed as { version: string }).version;
	expect(await files.check(task, id, version)).toEqual({ locked: false });
	const otherId = (await files.list(other, null)).entries[0]!.id;
	expect(await files.check(other, otherId, version)).toEqual({ locked: true });
	await files.release(task, id);
	expect(await files.check(other, otherId, version)).toEqual({ locked: false });
	expect((await files.read(task, id)).locked).toBe(true);
});
it('opens a changed file of an external repo read-only from the diff (spec/diff-and-review#scope-kinds)', async () => {
	const { realpath: real } = await import('node:fs/promises');
	const root = await real(await mkdtemp(join(tmpdir(), 'brigadir-external-open-')));
	roots.push(root);
	const init = async (path: string) => {
		await mkdir(path, { recursive: true });
		await git(path, ['init', '-q']);
		await git(path, ['config', 'user.name', 'Fixture']);
		await git(path, ['config', 'user.email', 'fixture@localhost']);
		await writeFile(join(path, 'file.txt'), 'base\n');
		await git(path, ['add', '-A']);
		await git(path, ['commit', '-qm', 'Base']);
	};
	const repo = join(root, 'couriers'),
		backend = join(root, 'b2c');
	await init(repo);
	await init(backend);
	const store = await SessionStore.at(join(root, 'data'));
	const project = await store.addProject(repo);
	const task = await store.createTask(project.id, 'Review', 'claude', 'gui', 'New task', 'queued', {
		isolation: 'in-place',
		branch: '',
		baseRef: 'origin/main',
		setupCommand: '',
		scopes: [
			{ id: '9240902625a8938c', name: '.', kind: 'root', selected: true },
			{ id: '8aa2182539d96de8', name: 'b2c', kind: 'external', path: backend, selected: true },
		],
	});
	const { Snapshots } = await import('@brigadir/git');
	const snapshots = await Snapshots.open(store, task);
	await snapshots.capture('baseline');
	await writeFile(join(backend, 'file.txt'), 'changed\n');
	await writeFile(join(repo, 'file.txt'), 'local\n');
	await snapshots.capture('turn');
	const changes = new Changes(store.root, resolve('apps/desktop/out/services/diff.cjs'));
	const files = new Files(
		changes,
		new Sessions(store.root, resolve('apps/desktop/out/services'), () => {})
	);
	const diff = (await changes.read(task)).files;
	const external = diff.find((file) => file.scopeId === '8aa2182539d96de8')!,
		local = diff.find((file) => file.scopeId !== '8aa2182539d96de8')!;
	const document = await files.fromDiff(task, external.id);
	expect(document).toMatchObject({ text: 'changed\n', readOnly: true, locked: false });
	expect(document.path.endsWith('/b2c/file.txt')).toBe(true);
	await expect(files.save(task, document.id, document.version, 'edit\n')).rejects.toThrow(
		'read-only'
	);
	expect(await files.fromDiff(task, local.id)).toMatchObject({ text: 'local\n', path: 'file.txt' });
});
it('spec/composer#mention-menu: the task file index ranks a match in the file name above one only in its folders', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-rank-'));
	roots.push(root);
	const repo = join(root, 'repo');
	await mkdir(join(repo, 'src/assets/ai'), { recursive: true });
	await mkdir(join(repo, 'src/hooks'), { recursive: true });
	for (const path of ['src/assets/ai/news.jpg', 'src/hooks/useSse.ts'])
		await writeFile(join(repo, path), 'x\n');
	const store = await SessionStore.at(join(root, 'data')),
		project = await store.addProject(repo),
		task = await store.createTask(project.id, 'Rank', 'claude');
	const files = new Files(
		new Changes(store.root, resolve('apps/desktop/out/services/diff.cjs')),
		new Sessions(store.root, resolve('apps/desktop/out/services'), () => {})
	);
	expect((await files.search(task, 'sse')).entries.map((entry) => entry.path)).toEqual([
		'src/hooks/useSse.ts',
		'src/assets/ai/news.jpg',
	]);
});
it('spec/composer#mention-menu: the `@` menu finds folders with the files, and a folder attaches as a reference named with a trailing slash', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-folders-'));
	roots.push(root);
	const repo = join(root, 'repo');
	await mkdir(join(repo, 'src/ui/VibePreview'), { recursive: true });
	for (const path of ['src/ui/VibePreview/VibePreviewPane.tsx', 'src/ui/VibePreview/const.ts'])
		await writeFile(join(repo, path), 'x\n');
	const store = await SessionStore.at(join(root, 'data')),
		project = await store.addProject(repo),
		task = await store.createTask(project.id, 'Folders', 'claude');
	const files = new Files(
		new Changes(store.root, resolve('apps/desktop/out/services/diff.cjs')),
		new Sessions(store.root, resolve('apps/desktop/out/services'), () => {})
	);
	// ⌘⇧O and Search Everywhere keep listing files only.
	expect((await files.search(task, 'VibePreview')).entries.map((entry) => entry.path)).toEqual([
		'src/ui/VibePreview/VibePreviewPane.tsx',
		'src/ui/VibePreview/const.ts',
	]);
	const found = (await files.search(task, 'VibePreview', false, true)).entries;
	expect(found.map((entry) => [entry.kind, entry.path])).toEqual([
		['directory', 'src/ui/VibePreview'],
		['file', 'src/ui/VibePreview/VibePreviewPane.tsx'],
		['file', 'src/ui/VibePreview/const.ts'],
	]);
	const attachment = await files.attach(task, found[0]!.id);
	expect(attachment.name).toBe('VibePreview/');
});
/**
 * Security review W2 (spec/remote-access-and-mobile#phone-task-tools): the phone reads with `peekFile`, and a file id is a sha256 of the task, the root and
 * the path — not a secret. A file outside the task that code navigation registered on the computer (`locate`, read-only)
 * must not open by `peek`: the phone would read outside the task's tree with an id it computed itself.
 */
it('peeks only into the task’s tree, never a file outside it that the computer registered (security review W2)', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-peek-'));
	roots.push(root);
	const repo = join(root, 'repo');
	await mkdir(repo);
	await git(repo, ['init', '-q']);
	await writeFile(join(repo, 'a.txt'), 'inside\n');
	await writeFile(join(root, 'secret.txt'), 'outside\n');
	const store = await SessionStore.at(join(root, 'data'));
	const project = await store.addProject(repo);
	const task = await store.createTask(project.id, 'Peek', 'claude');
	const changes = new Changes(store.root, resolve('apps/desktop/out/services/diff.cjs'));
	const sessions = new Sessions(store.root, resolve('apps/desktop/out/services'), () => {});
	const files = new Files(changes, sessions);
	const inside = (await files.list(task, null)).entries.find((entry) => entry.name === 'a.txt')!;
	expect((await files.peek(task, inside.id)).text).toBe('inside\n');
	const located = (await files.locate(task, join(root, 'secret.txt')))!;
	expect(located.readOnly).toBe(true);
	const { createHash } = await import('node:crypto');
	const { realpath } = await import('node:fs/promises');
	const computed = createHash('sha256')
		.update(`${task.projectId}/${task.id}\0${await realpath(root)}\0secret.txt`)
		.digest('hex');
	expect(computed).toBe(located.id);
	await expect(files.peek(task, computed)).rejects.toThrow('Not a file of the task');
	// The computer's read-only tab still opens it.
	expect((await files.read(task, located.id)).text).toBe('outside\n');
});
