import { expect, it } from 'vitest';
import type { AgentTask, FileDiff } from '@brigadir/core';
import {
	cachedCommitDiffs,
	commitDiffLimit,
	forgetCommitDiff,
	keepCommitDiff,
	readCommitDiff,
	type CommitDiffSource,
} from './commit-diffs';
const task = { projectId: 'p', id: 't' } as AgentTask;
const diff = (id: string) =>
	({
		file: { id, scopeId: 's', path: `${id}.ts` },
		beforeText: 'x'.repeat(100000),
		afterText: 'y'.repeat(100000),
		lines: [],
		pairs: [],
		binary: false,
		tooLarge: false,
	}) as unknown as FileDiff;
it('keeps only file metadata in the store and at most a few full diffs, reading an evicted one again (DIFF-07)', async () => {
	const entries = Array.from({ length: 10 }, (_, i) =>
		keepCommitDiff(task, `history:abc${i}:s/f${i}.ts`, diff(`f${i}`), {
			kind: 'history',
			scopeId: 's',
			sha: `abc${i}`.padEnd(40, '0'),
			id: `f${i}`,
		})
	);
	expect(cachedCommitDiffs()).toBe(commitDiffLimit);
	expect(JSON.stringify(entries).length).toBeLessThan(3000);
	expect(entries[0]).not.toHaveProperty('beforeText');
	const reads: CommitDiffSource[] = [];
	const read = async (_: AgentTask, source: CommitDiffSource) => {
		reads.push(source);
		return diff(source.id);
	};
	expect((await readCommitDiff(task, 'history:abc9:s/f9.ts', entries[9]!, read)).file.id).toBe(
		'f9'
	);
	expect(reads).toEqual([]);
	expect((await readCommitDiff(task, 'history:abc0:s/f0.ts', entries[0]!, read)).file.id).toBe(
		'f0'
	);
	expect(reads).toEqual([entries[0]!.source]);
	await readCommitDiff(task, 'history:abc0:s/f0.ts', entries[0]!, read);
	expect(reads).toHaveLength(1);
	forgetCommitDiff(task, 'history:abc0:s/f0.ts', entries[0]!);
	await readCommitDiff(task, 'history:abc0:s/f0.ts', entries[0]!, read);
	expect(reads).toHaveLength(2);
	const commit = keepCommitDiff(task, 'commit:s/a.ts', diff('a'), {
		kind: 'commit',
		revision: 'r1',
		id: 'a',
	});
	expect(commit.revision).toBe('r1');
	await readCommitDiff(
		task,
		'commit:s/a.ts',
		{ ...commit, revision: 'r2', source: { kind: 'commit', revision: 'r2', id: 'a' } },
		read
	);
	expect(reads.at(-1)).toEqual({ kind: 'commit', revision: 'r2', id: 'a' });
});
