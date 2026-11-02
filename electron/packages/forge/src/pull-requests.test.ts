import { expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { prCounts, prGroups, mergeBlock } from '@brigadir/core';
import { Forge, ghCommand } from './index';
const repository = {
	name: 'fixture/repo',
	url: 'https://github.com/fixture/repo',
	defaultBranch: 'main',
};
async function forgeWith(state: object) {
	const dir = await mkdtemp(join(tmpdir(), 'brigadir-gh-')),
		file = join(dir, 'gh.json');
	await writeFile(file, JSON.stringify(state));
	process.env.BRIGADIR_TEST_GH_STATE = file;
	return new Forge(ghCommand(process.execPath, [resolve(__dirname, '../fixtures/gh.mjs')]));
}
const day = 86_400_000,
	ago = (days: number) => new Date(Date.now() - days * day).toISOString();
it('reads open and recently closed PRs, marks mine and the ones waiting for me', async () => {
	const forge = await forgeWith({
		viewer: 'me',
		pullRequests: [
			{
				number: 421,
				title: 'Loyalty 1+1',
				author: 'mk',
				requested: ['me'],
				comments: 4,
				checks: 'PENDING',
				updatedAt: ago(0.01),
			},
			{
				number: 419,
				title: 'Orders: export',
				author: 'me',
				reviewDecision: 'APPROVED',
				checks: 'SUCCESS',
				updatedAt: ago(0.1),
			},
			{
				number: 416,
				title: 'Bump',
				author: 'bot',
				isDraft: true,
				checks: 'FAILURE',
				updatedAt: ago(1),
			},
			{
				number: 414,
				title: 'Import',
				author: 'me',
				state: 'MERGED',
				closedAt: ago(3),
				updatedAt: ago(3),
			},
			{
				number: 400,
				title: 'Old',
				author: 'me',
				state: 'CLOSED',
				closedAt: ago(20),
				updatedAt: ago(20),
			},
		],
	});
	const { viewer, prs } = await forge.pullRequests('/tmp', repository);
	expect(viewer).toBe('me');
	expect(prs.find((pr) => pr.number === 421)).toMatchObject({
		waiting: true,
		mine: false,
		comments: 4,
		checks: 'pending',
		reviewers: [{ login: 'me', state: 'REQUESTED' }],
	});
	expect(prs.find((pr) => pr.number === 416)?.state).toBe('DRAFT');
	expect(prCounts(prs)).toEqual({ open: 3, closed: 1, waiting: true });
	expect(prGroups(prs).map((group) => [group.group, group.prs.map((pr) => pr.number)])).toEqual([
		['waiting', [421]],
		['mine', [419]],
		['others', [416]],
		['closed', [414]],
	]);
});
it('reads a PR with threads, files, commits and checks, and says why it cannot be merged', async () => {
	const forge = await forgeWith({
		viewer: 'me',
		pullRequests: [
			{
				number: 421,
				title: 'Loyalty',
				author: 'mk',
				mergeState: 'BLOCKED',
				reviewDecision: 'REVIEW_REQUIRED',
				approvals: 1,
				threads: [
					{
						path: 'src/a.ts',
						line: 12,
						comments: [
							{ author: 'mk', body: 'Why?' },
							{ author: 'me', body: 'Because.' },
						],
					},
				],
				files: [{ path: 'src/a.ts', additions: 3, deletions: 1, viewed: true }],
				commitList: [{ sha: 'a'.repeat(40), subject: 'Add rule', author: 'mk' }],
				checkRuns: [
					{ name: 'unit' },
					{ name: 'e2e', conclusion: 'FAILURE' },
					{ name: 'lint', status: 'IN_PROGRESS', conclusion: null },
				],
			},
		],
	});
	const detail = await forge.pullRequestDetail('/tmp', repository, 421);
	expect(detail.threads[0]).toMatchObject({ path: 'src/a.ts', line: 12, resolved: false });
	expect(detail.threads[0]!.comments).toHaveLength(2);
	expect(detail.files[0]).toMatchObject({ viewed: true, additions: 3 });
	expect(detail.commits[0]?.subject).toBe('Add rule');
	expect(detail.checks.map((check) => check.state)).toEqual(['pass', 'fail', 'pending']);
	expect(detail.summary.checks).toBe('fail');
	expect(detail.mergeMethods).toEqual(['squash', 'merge']);
	expect(detail.defaultMergeMethod).toBe('squash');
	expect(detail.requiredApprovals).toBe(1);
	expect(mergeBlock(detail)).toBe('checks');
	expect(mergeBlock({ ...detail, mergeState: 'CLEAN' })).toBeNull();
});
it('turns a network failure into an error, never into an empty list', async () => {
	const forge = await forgeWith({ graphqlError: true });
	await expect(forge.pullRequests('/tmp', repository)).rejects.toThrow('network');
});
it('names GitHub’s reason for a rejected write, not only the HTTP status (spec/pull-requests-and-ci#review-drafts)', async () => {
	const body = {
		message: 'Unprocessable Entity',
		errors: ['Review Can not request changes on your own pull request'],
		documentation_url: 'https://docs.github.com/rest',
		status: '422',
	};
	const forge = new Forge(async () => ({
		code: 1,
		stdout: JSON.stringify(body),
		stderr: 'gh: Unprocessable Entity (HTTP 422)\n',
	}));
	await expect(
		forge.submitReview('/tmp', repository, 7, {
			event: 'REQUEST_CHANGES',
			body: '',
			commitId: 'abc',
			comments: [],
		})
	).rejects.toThrow(
		'Review Can not request changes on your own pull request (Unprocessable Entity (HTTP 422))'
	);
	const plain = new Forge(async () => ({
		code: 1,
		stdout: '',
		stderr: 'gh: Not Found (HTTP 404)\n',
	}));
	await expect(plain.reply('/tmp', repository, 7, 1, 'Yes')).rejects.toThrow(
		'gh: Not Found (HTTP 404)'
	);
});
it('takes a draft PR out of draft with one GraphQL mutation (spec/pull-requests-and-ci#merge-card)', async () => {
	const calls: string[][] = [];
	const forge = new Forge(async (_, args) => {
		calls.push(args);
		return {
			code: 0,
			stdout:
				'{"data":{"markPullRequestReadyForReview":{"pullRequest":{"id":"PR_7","isDraft":false}}}}',
			stderr: '',
		};
	});
	await forge.markReady('/tmp', 'PR_7');
	expect(calls).toHaveLength(1);
	expect(calls[0]!.find((arg) => arg.startsWith('query='))).toContain(
		'markPullRequestReadyForReview(input:{pullRequestId:$pr})'
	);
	expect(calls[0]).toContain('pr=PR_7');
	const failing = new Forge(async () => ({
		code: 0,
		stdout: '{"errors":[{"message":"Pull request is not a draft"}]}',
		stderr: '',
	}));
	await expect(failing.markReady('/tmp', 'PR_7')).rejects.toThrow('Pull request is not a draft');
});
it('a draft keeps «Merge PR…» off even when GitHub says CLEAN, and every block has its words (spec/pull-requests-and-ci#merge-card)', async () => {
	const { mergeBlockLabels, t } = await import('@brigadir/core');
	const detail = {
		mergeState: 'CLEAN' as const,
		mergeable: 'MERGEABLE' as const,
		canMerge: true,
		checks: [],
		summary: { state: 'DRAFT' as const, reviewDecision: null },
	} as unknown as Parameters<typeof mergeBlock>[0];
	expect(mergeBlock(detail)).toBe('draft');
	expect(mergeBlock({ ...detail, summary: { ...detail.summary, state: 'OPEN' } })).toBeNull();
	for (const label of Object.values(mergeBlockLabels)) expect(t('uk', label)).not.toBe(label);
});
