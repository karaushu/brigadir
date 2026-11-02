import { expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Forge, ghCommand, ciState, parseDeploy } from './index';
// @ts-expect-error — a plain .mjs fixture shared with the e2e tests
import { stagingActions } from '../fixtures/actions.mjs';
const repository = {
		name: 'fixture/repo',
		url: 'https://github.com/fixture/repo',
		defaultBranch: 'main',
	},
	sha = 'b2d2ffe'.padEnd(40, '0');
async function forgeWith(state: object) {
	const dir = await mkdtemp(join(tmpdir(), 'brigadir-gh-')),
		file = join(dir, 'gh.json');
	await writeFile(file, JSON.stringify(state));
	process.env.BRIGADIR_TEST_GH_STATE = file;
	return new Forge(ghCommand(process.execPath, [resolve(__dirname, '../fixtures/gh.mjs')]));
}

it('maps GitHub statuses and conclusions to one state', () => {
	expect(ciState('queued', null)).toBe('queued');
	expect(ciState('waiting', null)).toBe('queued');
	expect(ciState('in_progress', null)).toBe('running');
	expect(ciState('completed', 'success')).toBe('pass');
	expect(ciState('completed', 'neutral')).toBe('pass');
	expect(ciState('completed', 'timed_out')).toBe('fail');
	expect(ciState('completed', 'cancelled')).toBe('cancelled');
	expect(ciState('completed', 'skipped')).toBe('skipped');
});
it('reads the runs of a commit, marks mine, filters by workflow', async () => {
	const forge = await forgeWith({ viewer: 'me', actions: stagingActions(sha) });
	const runs = await forge.ciRuns('.', repository, { sha }, 'me');
	expect(runs).toHaveLength(1);
	expect(runs[0]).toMatchObject({
		workflow: 'Staging Pipeline',
		number: 1068,
		branch: 'staging',
		sha,
		mine: true,
		state: 'running',
	});
	expect(
		(await forge.ciRuns('.', repository, {}, 'someone')).map((run) => [run.workflow, run.mine])
	).toEqual([
		['Staging Pipeline', false],
		['CI/CD Pipeline', false],
	]);
	expect(await forge.ciRuns('.', repository, { workflow: 'CI/CD Pipeline' }, 'me')).toHaveLength(1);
});
it('a repo with Actions off or without workflows is an empty list, not an error', async () => {
	expect(
		await (await forgeWith({ actions: { disabled: true } })).ciRuns('.', repository, {}, 'me')
	).toEqual([]);
	expect(await (await forgeWith({ actions: {} })).ciRuns('.', repository, {}, 'me')).toEqual([]);
	await expect(
		(await forgeWith({ actionsError: true })).ciRuns('.', repository, {}, 'me')
	).rejects.toThrow(/network error/);
});
it('reads a running run down to its steps and the deployment of its job', async () => {
	const forge = await forgeWith({ actions: stagingActions(sha) }),
		detail = await forge.ciRun('.', repository, 1068, 'me');
	expect(detail.jobs.map((job) => [job.name, job.state])).toEqual([
		['build', 'pass'],
		['test', 'pass'],
		['deploy-staging', 'running'],
	]);
	expect(detail.jobs[2]!.steps.map((step) => step.state)).toEqual([
		'pass',
		'pass',
		'pass',
		'pass',
		'running',
		'queued',
		'queued',
		'queued',
	]);
	expect(detail.jobs[2]!.steps[5]!.seconds).toBeNull();
	expect(detail.deploy).toEqual({
		environment: 'staging',
		state: 'running',
		url: null,
		jobId: 9003,
	});
	expect(detail.annotation).toBeNull();
});
it('a deployed run has the environment URL; a failed one has the first failure annotation', async () => {
	const pass = await (
		await forgeWith({ actions: stagingActions(sha, { kind: 'pass' }) })
	).ciRun('.', repository, 1068, 'me');
	expect(pass.deploy).toMatchObject({ state: 'pass', url: 'https://admin.staging.example.com' });
	const fail = await (
		await forgeWith({ actions: stagingActions(sha, { kind: 'fail' }) })
	).ciRun('.', repository, 1068, 'me');
	expect(fail.deploy?.state).toBe('fail');
	expect(fail.jobs[2]!.steps.map((step) => step.state).slice(4)).toEqual([
		'pass',
		'fail',
		'skipped',
		'pass',
	]);
	expect(fail.annotation).toEqual({
		jobId: 9003,
		message: 'ECS service choice-admin-staging did not stabilize: 0/2 tasks running',
	});
});
it('a deployment of a job outside this run says nothing', () => {
	const job = {
		id: 1,
		name: 'deploy',
		state: 'pass' as const,
		seconds: 1,
		link: 'https://github.com/x',
		steps: [],
	};
	expect(
		parseDeploy(
			{ environment: 'staging' },
			[{ state: 'success', log_url: 'https://github.com/o/r/actions/runs/5/job/2' }],
			[job]
		)
	).toBeNull();
	expect(
		parseDeploy(
			{ environment: 'staging' },
			[{ state: 'success', log_url: 'https://github.com/o/r/actions/runs/5/job/1' }],
			[job]
		)
	).toMatchObject({ state: 'pass', jobId: 1 });
	expect(parseDeploy({ environment: 'staging' }, [], [job])).toBeNull();
});
it('reads the merge commit of a merged PR', async () => {
	const forge = await forgeWith({
		viewer: 'me',
		pullRequests: [
			{ number: 421, title: 'Loyalty', state: 'MERGED', mergeSha: sha },
			{ number: 422, title: 'Open' },
		],
	});
	expect((await forge.pullRequestDetail('.', repository, 421)).mergeSha).toBe(sha);
	expect((await forge.pullRequestDetail('.', repository, 422)).mergeSha).toBeNull();
});
