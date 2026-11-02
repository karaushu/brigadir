import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SessionStore } from '@brigadir/persistence';
import { FETCH_INTERVAL, RemoteWatch } from './remote-watch';
const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it('fetches each repo at most once in 5 minutes and reads the panel again only when remote refs moved (spec/git#pull)', async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'brigadir-remote-watch-')));
	roots.push(root);
	const repo = join(root, 'repo');
	await mkdir(repo);
	const git = (...args: string[]) => promisify(execFile)('git', args, { cwd: repo });
	await git('init', '-q', '-b', 'main');
	await writeFile(join(repo, 'a.txt'), 'a\n');
	await git('add', '.');
	await git('-c', 'user.name=F', '-c', 'user.email=f@x', 'commit', '-qm', 'a');
	const store = await SessionStore.at(join(root, 'data'));
	const project = await store.addProject(repo);
	let now = 0,
		refs = 'r1';
	const fetched: string[] = [],
		changed: string[] = [];
	const watch = new RemoteWatch(
		store.root,
		(id) => changed.push(id),
		() => now,
		async (path) => {
			fetched.push(path);
		},
		async () => refs
	);
	await watch.check();
	expect(fetched).toEqual([repo]);
	expect(changed).toEqual([]);
	now = FETCH_INTERVAL - 1;
	await watch.check();
	expect(fetched).toHaveLength(1);
	now = FETCH_INTERVAL;
	let calls = 0;
	const moving = new RemoteWatch(
		store.root,
		(id) => changed.push(id),
		() => now,
		async (path) => {
			fetched.push(path);
		},
		async () => `r${calls++}`
	);
	await moving.check();
	expect(changed).toEqual([project.id]);
	// A fetch the picker made counts for the throttle.
	watch.fetched(repo);
	now += FETCH_INTERVAL - 1;
	await watch.check();
	expect(fetched).toHaveLength(2);
	void refs;
});
