import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { CIRun, CIRunDetail, CIWatch, PRState, TaskStatus } from '@brigadir/core';
import { SlackWatches, slackWatchPollMs, type SlackWatchInput } from './slack-watches';

const roots: string[] = [];
const all: SlackWatches[] = [];
afterEach(async () => {
	vi.useRealTimers();
	for (const item of all.splice(0)) item.dispose();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const pr = {
	projectId: 'p',
	taskId: 't',
	scopeId: 's',
	number: 12,
	url: 'https://github.com/acme/business/pull/12',
};
const base = {
	channel: 'C0DEPLOY',
	ts: '100.1',
	by: 'U2CD',
	language: 'en' as const,
	task: { projectId: 'p', id: 't', title: 'Phone validation' },
};
const run = (id: number, state: CIRun['state'], createdAt = '2026-10-30T10:00:00Z'): CIRun => ({
	id,
	workflow: 'CI',
	number: id,
	title: 'Phone validation',
	branch: 'claude/phone',
	sha: 'abc1234',
	actor: 'dev',
	mine: true,
	state,
	createdAt,
	seconds: state === 'running' ? null : 372,
	link: `https://github.com/acme/business/actions/runs/${id}`,
});
const detailOf = (value: CIRun): CIRunDetail => ({
	run: value,
	jobs: [],
	deploy: null,
	annotation: value.state === 'fail' ? { jobId: 1, message: 'expected +380' } : null,
});

async function setup(root?: string) {
	const dir = root ?? (await mkdtemp(join(tmpdir(), 'brigadir-slack-watches-')));
	if (!root) roots.push(dir);
	const state = {
		pr: 'OPEN' as PRState,
		runs: [] as CIRun[],
		bells: [] as CIWatch[],
		task: 'working' as TaskStatus | null,
		ready: true,
		fail: false,
		now: Date.parse('2026-10-30T10:00:00Z'),
		prReads: 0,
	};
	const posts: { channel: string; ts: string; text: string }[] = [];
	const watches = new SlackWatches({
		file: async () => join(dir, 'watches.json'),
		post: async (thread, text) => {
			if (state.fail) throw new Error('unreachable');
			posts.push({ channel: thread.channel, ts: thread.ts, text });
		},
		ready: () => state.ready,
		now: () => state.now,
		pr: async () => {
			state.prReads++;
			return {
				state: state.pr,
				repo: 'business',
				head: 'claude/phone',
				base: 'main',
				url: pr.url,
				headSha: 'abc1234',
				mergeSha: null,
			};
		},
		runs: async () => state.runs,
		run: async (_, id) => detailOf(state.runs.find((item) => item.id === id)!),
		bells: async () => state.bells,
		bell: async (watch, on) => {
			state.bells = state.bells.filter((item) => item.runId !== watch.runId);
			if (on) state.bells.push(watch);
		},
		task: async () =>
			state.task ? { status: state.task, repo: 'business', branch: 'claude/phone' } : null,
	});
	all.push(watches);
	await watches.loaded;
	return { dir, state, posts, watches };
}
const ci: SlackWatchInput = { ...base, kind: 'ci', pr };
const merged: SlackWatchInput = { ...base, kind: 'pr-merged', pr };
const done: SlackWatchInput = { ...base, kind: 'task-done', pr: null, last: 'working' };

it('tells the thread when the PR is merged, reading GitHub once a minute per PR, and survives a restart', async () => {
	vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
	const { dir, state, posts, watches } = await setup();
	expect(await watches.add([merged, { ...merged, ts: '200.2', language: 'uk' }])).toBe('ok');
	// The same request again in the same thread is the same watch.
	expect(await watches.add([merged])).toBe('ok');
	expect(await watches.list()).toHaveLength(2);
	await vi.advanceTimersByTimeAsync(slackWatchPollMs);
	expect(state.prReads).toBe(1);
	expect(posts).toEqual([]);

	watches.dispose();
	const again = await setup(dir);
	again.state.pr = 'MERGED';
	await again.watches.poll();
	expect(again.posts).toEqual([
		{
			channel: 'C0DEPLOY',
			ts: '100.1',
			text: [
				'<@U2CD>',
				'🔀 *PR merged* — business (`claude/phone → main`)',
				'📋 Task: Phone validation',
				'🔗 <https://github.com/acme/business/pull/12|#12 on GitHub>',
			].join('\n'),
		},
		{
			channel: 'C0DEPLOY',
			ts: '200.2',
			text: [
				'<@U2CD>',
				'🔀 *PR змержено* — business (`claude/phone → main`)',
				'📋 Задача: Phone validation',
				'🔗 <https://github.com/acme/business/pull/12|#12 на GitHub>',
			].join('\n'),
		},
	]);
	expect(await again.watches.list()).toEqual([]);
	expect(JSON.parse(await readFile(join(dir, 'watches.json'), 'utf8')).watches).toEqual([]);
});

it('says when the PR is closed without a merge', async () => {
	const { state, posts, watches } = await setup();
	await watches.add([merged]);
	state.pr = 'CLOSED';
	await watches.poll();
	expect(posts.map((post) => post.text)).toEqual([
		'<@U2CD>\n🚫 *PR closed without merge* — business <https://github.com/acme/business/pull/12|#12>',
	]);
});

it('waits for a run, puts a bell on it, answers in the watch’s thread when it ends and takes nothing it did not put', async () => {
	const { state, posts, watches } = await setup();
	await watches.add([ci]);
	await watches.poll();
	expect(state.bells).toEqual([]);
	state.runs = [run(7, 'pass', '2026-10-30T09:00:00Z'), run(8, 'running')];
	await watches.poll();
	expect(state.bells).toEqual([
		{ projectId: 'p', taskId: 't', scopeId: 's', runId: 8, label: '#12' },
	]);
	expect((await watches.list())[0]!.run).toEqual({ id: 8, bell: true });
	// A bell's run that is not a watch's: nothing here.
	const other = { ...state.bells[0]!, runId: 99 };
	expect(
		await watches.ciFinished(
			{ watch: other, run: run(99, 'pass'), state: 'pass', title: '', body: '' },
			detailOf(run(99, 'pass'))
		)
	).toBe(false);
	const ended = run(8, 'fail');
	expect(
		await watches.ciFinished(
			{ watch: state.bells[0]!, run: ended, state: 'fail', title: '', body: '' },
			detailOf(ended)
		)
	).toBe(true);
	expect(posts).toEqual([
		{
			channel: 'C0DEPLOY',
			ts: '100.1',
			text: [
				'<@U2CD>',
				'❌ *CI failed* — business (`claude/phone`)',
				'🌐 Environment: *claude/phone*',
				'📋 Task: Phone validation',
				'⏱️ Duration: 6m 12s',
				'🔗 <https://github.com/acme/business/actions/runs/8|View run>',
				'```expected +380```',
			].join('\n'),
		},
	]);
	expect(await watches.list()).toEqual([]);
});

it('answers a run that ended before the ask, and reads a run whose bell went', async () => {
	const { state, posts, watches } = await setup();
	state.runs = [run(7, 'pass')];
	await watches.add([ci]);
	await watches.poll();
	expect(posts[0]!.text).toContain('✅ *CI passed* — business');
	expect(state.bells).toEqual([]);

	state.runs = [run(9, 'running')];
	await watches.add([{ ...ci, ts: '300.3' }]);
	await watches.poll();
	expect(state.bells.map((bell) => bell.runId)).toEqual([9]);
	// The person took the bell off in Brigadir; the run ended without it.
	state.bells = [];
	state.runs = [run(9, 'pass')];
	await watches.poll();
	expect(posts.at(-1)).toMatchObject({ ts: '300.3' });
	expect(posts.at(-1)!.text).toContain('✅ *CI passed*');
});

it('fires a task-done watch on the turn that ends it or on Completed, keeps the answer while Slack is down', async () => {
	const { state, posts, watches } = await setup();
	await watches.add([done]);
	await watches.taskEnded({ projectId: 'p', id: 't' });
	expect(posts).toEqual([]);
	state.task = 'done';
	state.fail = true;
	await watches.taskEnded({ projectId: 'p', id: 't' });
	expect(posts).toEqual([]);
	// Asked while the task is Done already: the pass waits for a change — Completed, or a turn that ends again.
	await watches.add([{ ...done, ts: '400.4', last: 'done' }]);
	state.fail = false;
	await watches.poll();
	expect(posts.map((post) => post.ts)).toEqual(['100.1']);
	expect(posts[0]!.text).toBe(
		['<@U2CD>', '🏁 *Turn ended* — business (`claude/phone`)', '📋 Task: Phone validation'].join(
			'\n'
		)
	);
	state.task = 'completed';
	await watches.poll();
	expect(posts.map((post) => post.ts)).toEqual(['100.1', '400.4']);
	expect(await watches.list()).toEqual([]);
	// A task that is gone takes its watch with it, silently.
	await watches.add([done]);
	state.task = null;
	await watches.poll();
	expect(await watches.list()).toEqual([]);
	expect(posts).toHaveLength(2);
});

it('cancels a thread’s watches with their bells, holds at most 50 and lets a watch go after 7 days', async () => {
	const { state, posts, watches } = await setup();
	state.runs = [run(8, 'running')];
	await watches.add([ci, merged]);
	await watches.poll();
	expect(state.bells).toHaveLength(1);
	expect(await watches.cancel('C0DEPLOY', '999.9')).toBe(0);
	expect(await watches.cancel('C0DEPLOY', '100.1')).toBe(2);
	expect(state.bells).toEqual([]);

	const many = Array.from({ length: 50 }, (_, index) => ({ ...done, ts: `${index}.0` }));
	expect(await watches.add(many)).toBe('ok');
	expect(await watches.add([{ ...done, ts: 'x.0' }])).toBe('full');
	await watches.cancel('C0DEPLOY', '0.0');
	expect(await watches.add([{ ...done, ts: 'x.0' }])).toBe('ok');
	for (const item of await watches.list()) await watches.cancel(item.channel, item.ts);

	await watches.add([{ ...merged, language: 'uk' }]);
	state.now += 7 * 86_400_000 + 1;
	await watches.poll();
	expect(posts.at(-1)!.text).toBe(
		'⌛ *Перестав стежити через 7 днів*\n🔀 PR змержать — <https://github.com/acme/business/pull/12|#12>'
	);
	expect(await watches.list()).toEqual([]);
});
