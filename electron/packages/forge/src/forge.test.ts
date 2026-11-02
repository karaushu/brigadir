import { expect, it } from 'vitest';
import { Forge, type GhRunner } from './index';
const repository = {
		name: 'fixture/repo',
		url: 'https://github.com/fixture/repo',
		defaultBranch: 'main',
	},
	ref = {
		number: 12,
		url: 'https://github.com/fixture/repo/pull/12',
		title: 'A change',
		state: 'OPEN',
		headRefName: 'feature',
		baseRefName: 'main',
		mergeable: 'MERGEABLE',
	};
const ok = (value: unknown) => ({ code: 0, stdout: JSON.stringify(value), stderr: '' });
it('reads branch history in all states and retains merged PRs', async () => {
	const calls: string[][] = [];
	const forge = new Forge(async (_, args) => {
		calls.push(args);
		return ok([{ ...ref, state: 'MERGED' }]);
	});
	expect(await forge.pullRequest('/tmp', repository, 'feature')).toMatchObject({
		number: 12,
		state: 'MERGED',
	});
	expect(calls[0]).toContain('all');
	expect(calls[0]).toContain('--head');
});
it('distinguishes failed/pending/no checks from transport errors', async () => {
	let result = {
		code: 8,
		stdout: JSON.stringify([{ name: 'CI', bucket: 'pending', link: '' }]),
		stderr: '',
	};
	const run: GhRunner = async (_, args) => (args[1] === 'view' ? ok(ref) : result),
		forge = new Forge(run);
	expect((await forge.details('/tmp', repository, 12)).checks[0]?.bucket).toBe('pending');
	result = {
		code: 1,
		stdout: JSON.stringify([
			{ name: 'CI', bucket: 'fail', link: 'https://github.com/fixture/repo/actions/runs/1' },
		]),
		stderr: '',
	};
	expect((await forge.details('/tmp', repository, 12)).checks[0]?.bucket).toBe('fail');
	result = { code: 1, stdout: '', stderr: 'no checks reported on the feature branch' };
	expect((await forge.details('/tmp', repository, 12)).checks).toEqual([]);
	result = { code: 1, stdout: '', stderr: 'network connection failed' };
	await expect(forge.details('/tmp', repository, 12)).rejects.toThrow('network');
	result = { code: 1, stdout: '[]', stderr: 'network connection failed' };
	await expect(forge.details('/tmp', repository, 12)).rejects.toThrow();
});
it('passes exact editable text over stdin, prevents implicit push and validates returned URLs', async () => {
	let response = 'https://github.com/fixture/repo/pull/25';
	const calls: { args: string[]; input: string | undefined }[] = [],
		forge = new Forge(async (_, args, input) => {
			calls.push({ args, input });
			return { code: 0, stdout: response, stderr: '' };
		});
	const input = {
		branch: 'feature',
		base: 'main',
		title: 'Title $(literal)',
		body: '## Details\n\n`literal`\n$HOME',
	};
	expect(await forge.create('/tmp', repository, input)).toBe(response);
	expect(calls[0]?.args).toEqual([
		'pr',
		'create',
		'--repo',
		repository.url,
		'--head',
		'feature',
		'--base',
		'main',
		'--title',
		input.title,
		'--body-file',
		'-',
	]);
	expect(calls[0]?.input).toBe(input.body);
	response = 'https://elsewhere.example/pull/25';
	await expect(forge.create('/tmp', repository, input)).rejects.toThrow('URL');
});
it('does not report every gh failure as a missing installation', async () => {
	expect(
		await new Forge(async () => {
			throw Object.assign(new Error('missing'), { code: 'ENOENT' });
		}).auth('/tmp')
	).toBe('missing');
	expect(
		await new Forge(async () => ({
			code: 1,
			stdout: '',
			stderr: 'not logged into any GitHub hosts',
		})).auth('/tmp')
	).toBe('login');
	expect(
		await new Forge(async () => ({ code: 1, stdout: '', stderr: 'network unavailable' })).auth(
			'/tmp'
		)
	).toBe('error');
});
