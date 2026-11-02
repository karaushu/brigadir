import { expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitText } from './command';
import {
	commitMessageContext,
	commitMessagePrompt,
	commitMessageText,
	commitSplitPrompt,
	parseCommitSplit,
} from './commit-message';

it('asks the split for JSON in English and keeps only commits of known repos with files (spec/git#commit-dialog)', () => {
	const prompt = commitSplitPrompt([
		{
			scopeId: 'aaaaaaaaaaaaaaaa',
			context: {
				scope: 'business',
				recentCommitMessages: '',
				stat: '',
				patch: '+x',
				repositoryInstructions: '',
			},
			files: [{ path: 'a.ts', status: ' M', additions: 1, deletions: 0 }],
		},
	]);
	expect(prompt.startsWith('Split these changes into commits')).toBe(true);
	expect(prompt).toContain('"repo":"business"');
	const repos = [
		{ scopeId: 'aaaaaaaaaaaaaaaa', name: 'business' },
		{ scopeId: 'bbbbbbbbbbbbbbbb', name: 'kit' },
	];
	expect(
		parseCommitSplit(
			'```json\n{"commits":[{"repo":"kit","message":" Bump ","reason":"deps","files":["p.json",3]},{"repo":"nope","message":"x","files":["a"]},{"repo":"business","message":"","files":["a.ts"]}]}\n```',
			repos
		)
	).toEqual([{ scopeId: 'bbbbbbbbbbbbbbbb', message: 'Bump', reason: 'deps', files: ['p.json'] }]);
	expect(() => parseCommitSplit('I could not', repos)).toThrow('Invalid split');
	expect(() => parseCommitSplit('{"commits":[]}', repos)).toThrow('Invalid split');
});

it('gives the generator the log, the diff, CLAUDE.md and commit.template of the repo (spec/agents-and-providers#one-shot, spec/crew#accept)', async () => {
	const path = await mkdtemp(join(tmpdir(), 'brigadir-commit-message-'));
	try {
		await gitText(path, ['init', '-q', '-b', 'main']);
		await gitText(path, ['config', 'user.name', 'Fixture']);
		await gitText(path, ['config', 'user.email', 'fixture@example.invalid']);
		await writeFile(join(path, 'CLAUDE.md'), 'Commits: <type>: [<Area>] <what>.\n');
		await writeFile(join(path, 'a.ts'), 'one\n');
		await gitText(path, ['add', '-A']);
		await gitText(path, ['commit', '-q', '-m', 'feat: [Couriers] logout for app courier accesses']);
		const base = await gitText(path, ['rev-parse', 'HEAD']);
		await gitText(path, ['checkout', '-q', '-b', 'worker']);
		await writeFile(join(path, 'a.ts'), 'one\ntwo\n');
		await gitText(path, ['commit', '-q', '-am', 'Developer: two']);
		const tip = await gitText(path, ['rev-parse', 'HEAD']);
		await gitText(path, ['checkout', '-q', 'main']);
		// Without a template the key is absent, so the commit strip's material stays as it was.
		let [context] = await commitMessageContext([{ name: 'choice', path, base, tree: tip }]);
		expect(context).toMatchObject({
			scope: 'choice',
			repositoryInstructions: 'Commits: <type>: [<Area>] <what>.\n',
		});
		expect(context!.recentCommitMessages).toContain(
			'feat: [Couriers] logout for app courier accesses'
		);
		expect(context!.recentCommitMessages).not.toContain('Developer: two');
		expect(context!.stat).toMatch(/a\.ts \| 1 \+/);
		expect(context!.patch).toContain('+two');
		expect(context).not.toHaveProperty('commitTemplate');
		await writeFile(join(path, '.gitmessage'), '<type>: [<Area>] <subject>\n');
		await gitText(path, ['config', 'commit.template', '.gitmessage']);
		[context] = await commitMessageContext([{ name: 'choice', path, base, tree: tip }]);
		expect(context!.commitTemplate).toBe('<type>: [<Area>] <subject>\n');
		// An unborn base diffs against the empty tree.
		[context] = await commitMessageContext([{ name: 'choice', path, base: null, tree: tip }]);
		expect(context!.stat).toMatch(/CLAUDE\.md/);
		const prompt = commitMessagePrompt([context!], 'Live updates wave 0');
		expect(prompt.startsWith('Write only a commit message for these changes.')).toBe(true);
		expect(JSON.parse(prompt.slice(prompt.indexOf('\n') + 1))).toMatchObject({
			task: 'Live updates wave 0',
			changes: [{ scope: 'choice' }],
		});
		expect(JSON.parse(commitMessagePrompt([context!]).split('\n').slice(1).join('\n'))).toEqual([
			context,
		]);
	} finally {
		await rm(path, { recursive: true, force: true });
	}
});

it('takes the text out of a fenced answer', () => {
	expect(commitMessageText('```\nfeat: [A] b\n\nbody\n```')).toBe('feat: [A] b\n\nbody');
	expect(commitMessageText('  fix: [A] c \n')).toBe('fix: [A] c');
	expect(commitMessageText('')).toBe('');
});
