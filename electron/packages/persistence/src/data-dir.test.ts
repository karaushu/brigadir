import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { defaultDataDir, markAppRunning, moveDataDir } from './data-dir';

let home: string;
const previous = () => join(home, '.brigadir-v2');
const current = () => join(home, '.brigadir');
async function json(path: string, value: unknown) {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify(value, null, 2));
}
const git = (cwd: string, ...args: string[]) =>
	execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

beforeEach(async () => {
	home = await realpath(await mkdtemp(join(tmpdir(), 'brigadir-home-')));
});
afterEach(async () => {
	await rm(home, { recursive: true, force: true });
});
describe('data folder move (spec/architecture-and-platform#data-root)', () => {
	it('uses ~/.brigadir when nothing exists yet and does nothing', () => {
		expect(defaultDataDir(home)).toBe(current());
		expect(moveDataDir(home)).toBe('none');
		expect(existsSync(current())).toBe(false);
	});
	it('moves the folder, rewrites absolute paths, repairs worktrees and moves Claude transcripts', async () => {
		const source = join(home, 'repo');
		await mkdir(source);
		git(source, 'init', '-q', '-b', 'main');
		git(
			source,
			'-c',
			'user.name=t',
			'-c',
			'user.email=t@t',
			'commit',
			'-q',
			'--allow-empty',
			'-m',
			'init'
		);
		const task = join(previous(), 'projects/p1/tasks/t1');
		const tree = join(previous(), 'worktrees/p1/t1');
		await mkdir(dirname(tree), { recursive: true });
		git(source, 'worktree', 'add', '-q', '-b', 'brigadir/t1', tree);
		await json(join(task, 'worktree.json'), {
			schemaVersion: 1,
			root: tree,
			repositories: [{ kind: 'root', relativePath: '', source, ready: true }],
		});
		await json(join(task, 'host-config.json'), { dataDir: previous() });
		await writeFile(join(task, 'events.jsonl'), `${JSON.stringify({ cwd: tree })}\n`);
		await json(join(tree, 'package.json'), { note: previous() });
		const transcripts = join(home, '.claude/projects', tree.replace(/[^a-zA-Z0-9]/g, '-'));
		await mkdir(transcripts, { recursive: true });
		await writeFile(join(transcripts, 'session.jsonl'), '{}\n');

		expect(defaultDataDir(home)).toBe(previous());
		expect(moveDataDir(home)).toBe('moved');

		const moved = join(current(), 'worktrees/p1/t1');
		expect(existsSync(previous())).toBe(false);
		expect(defaultDataDir(home)).toBe(current());
		const doc = JSON.parse(
			await readFile(join(current(), 'projects/p1/tasks/t1/worktree.json'), 'utf8')
		);
		expect(doc.root).toBe(moved);
		expect(
			JSON.parse(await readFile(join(current(), 'projects/p1/tasks/t1/host-config.json'), 'utf8'))
				.dataDir
		).toBe(current());
		// Journals are history, user checkouts are never touched.
		expect(await readFile(join(current(), 'projects/p1/tasks/t1/events.jsonl'), 'utf8')).toContain(
			tree
		);
		expect(JSON.parse(await readFile(join(moved, 'package.json'), 'utf8')).note).toBe(previous());
		expect(git(moved, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('brigadir/t1');
		expect(git(source, 'worktree', 'list')).toContain(moved);
		expect(
			existsSync(
				join(home, '.claude/projects', moved.replace(/[^a-zA-Z0-9]/g, '-'), 'session.jsonl')
			)
		).toBe(true);
		expect(existsSync(transcripts)).toBe(false);
	});
	it('waits while a task host or another copy of the app is alive', async () => {
		const other = execFileSync('sh', ['-c', 'sleep 30 >/dev/null 2>&1 & echo $!'], {
			encoding: 'utf8',
		}).trim();
		try {
			await json(join(previous(), 'projects/p1/tasks/t1/host.lock'), { pid: Number(other) });
			expect(moveDataDir(home)).toBe('postponed');
			await rm(join(previous(), 'projects'), { recursive: true });
			await json(join(previous(), 'run', `app-${other}.lock`), { pid: Number(other) });
			expect(moveDataDir(home)).toBe('postponed');
			expect(existsSync(previous())).toBe(true);
			expect(defaultDataDir(home)).toBe(previous());
		} finally {
			process.kill(Number(other));
		}
		// Its own marker does not stop this copy.
		await rm(join(previous(), 'run'), { recursive: true });
		markAppRunning(previous());
		expect(moveDataDir(home)).toBe('moved');
	});
	it('leaves both folders alone when ~/.brigadir already exists', async () => {
		await mkdir(previous());
		await mkdir(current());
		expect(moveDataDir(home)).toBe('none');
		expect(existsSync(previous())).toBe(true);
		expect(defaultDataDir(home)).toBe(current());
	});
});
