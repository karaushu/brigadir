import { expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CIFinished, CIRunDetail, CIState, CIWatch } from '@brigadir/core';
import { CIWatches } from './ci-watch';
import type { Notice } from './notifications';

const watch: CIWatch = {
	projectId: 'p',
	taskId: 't',
	scopeId: 'apps/admin',
	runId: 1068,
	label: '#421',
};
const detail = (
	state: CIState,
	deploy: 'running' | 'pass' | 'fail' | null = null
): CIRunDetail => ({
	run: {
		id: 1068,
		workflow: 'Staging Pipeline',
		number: 1068,
		title: 'Merge pull request #421',
		branch: 'staging',
		sha: 'b2d2ffe',
		actor: 'me',
		mine: true,
		state,
		createdAt: new Date().toISOString(),
		seconds: 60,
		link: 'https://github.com/o/r/actions/runs/1068',
	},
	jobs: [],
	deploy: deploy ? { environment: 'staging', state: deploy, url: null, jobId: 1 } : null,
	annotation: null,
});
async function setup(read: () => Promise<CIRunDetail>, now = () => Date.now()) {
	const dataDir = await mkdtemp(join(tmpdir(), 'brigadir-ci-watch-')),
		shown: Notice[] = [],
		finished: CIFinished[] = [],
		changed: CIWatch[][] = [];
	const deps = {
		dataDir,
		read,
		now,
		gateway: {
			supported: () => true,
			show: (notice: Notice) => (shown.push(notice), null),
			removeGroup: () => {},
		},
		allowed: async () => true,
		locale: () => 'en' as const,
		changed: (watches: CIWatch[]) => changed.push(watches),
		finished: (event: CIFinished) => finished.push(event),
		open: () => {},
	};
	return { watches: new CIWatches(deps), deps, shown, finished, changed };
}

it('a watched run that is still going says nothing; one that ended notifies once and is unwatched', async () => {
	let state: CIState = 'running';
	const { watches, shown, finished } = await setup(async () =>
		detail(state, state === 'running' ? 'running' : 'fail')
	);
	expect(await watches.toggle(watch, true)).toHaveLength(1);
	await watches.poll();
	expect(shown).toEqual([]);
	state = 'fail';
	await watches.poll();
	expect(shown.map((notice) => [notice.title, notice.body])).toEqual([
		['Staging Pipeline #1068 failed', 'Deploy to staging failed'],
	]);
	expect(finished.map((event) => event.state)).toEqual(['fail']);
	expect(await watches.list()).toEqual([]);
	await watches.poll();
	expect(shown).toHaveLength(1);
	watches.dispose();
});
it('watches survive a restart; a bell off removes the watch', async () => {
	const first = await setup(async () => detail('running'));
	await first.watches.toggle(watch, true);
	first.watches.dispose();
	const second = new CIWatches({ ...first.deps });
	expect((await second.list()).map((item) => item.runId)).toEqual([1068]);
	expect(await second.toggle(watch, false)).toEqual([]);
	second.dispose();
});
it('a watch older than a day or a run GitHub no longer has is dropped without a notification', async () => {
	let clock = Date.now();
	const old = await setup(
		async () => detail('running'),
		() => clock
	);
	await old.watches.toggle(watch, true);
	clock += 25 * 3_600_000;
	await old.watches.poll();
	expect(await old.watches.list()).toEqual([]);
	expect(old.shown).toEqual([]);
	const gone = await setup(async () => {
		throw new Error('gh: Not Found (HTTP 404)');
	});
	await gone.watches.toggle(watch, true);
	await gone.watches.poll();
	expect(await gone.watches.list()).toEqual([]);
	expect(gone.shown).toEqual([]);
	old.watches.dispose();
	gone.watches.dispose();
});
it('keeps at most 20 watches, the oldest goes first', async () => {
	let clock = 1_000;
	const { watches } = await setup(
		async () => detail('running'),
		() => clock++
	);
	for (let runId = 1; runId <= 21; runId++) await watches.toggle({ ...watch, runId }, true);
	const ids = (await watches.list()).map((item) => item.runId);
	expect(ids).toHaveLength(20);
	expect(ids).not.toContain(1);
	watches.dispose();
});
