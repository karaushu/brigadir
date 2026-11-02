import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from 'vitest';
import type { Schedule } from '@brigadir/core';
import { SchedulesStore } from './schedules';
const schedule = (patch: Partial<Schedule> = {}): Schedule => ({
	id: 's_abcdef123456',
	projectId: 'business',
	name: 'Daily review',
	createdAt: '2026-10-30T08:00:00.000Z',
	paused: false,
	timeZone: 'Europe/Kyiv',
	rule: { kind: 'weekly', days: [1, 2, 3, 4, 5], times: ['09:00'] },
	missed: 'catch-up',
	inTasks: 'needs-you',
	task: { prompt: 'Review the PRs merged yesterday', provider: 'claude', transport: 'gui' },
	checkedUntil: '2026-10-30T08:00:00.000Z',
	...patch,
});
test('keeps a schedule as sorted JSON and its runs as JSONL, newest first on read', async () => {
	const root = await mkdtemp(join(tmpdir(), 'schedules-'));
	try {
		const store = new SchedulesStore(root);
		await store.save(schedule());
		const file = join(root, 'projects', 'business', 'schedules', 's_abcdef123456', 'schedule.json');
		const text = await readFile(file, 'utf8');
		expect(JSON.parse(text)).toMatchObject({
			schemaVersion: 1,
			schedule: { name: 'Daily review' },
		});
		expect(text.indexOf('"checkedUntil"')).toBeLessThan(text.indexOf('"name"'));
		await store.update('business', 's_abcdef123456', (s) => ({ ...s, paused: true }));
		expect((await store.read('business', 's_abcdef123456')).paused).toBe(true);
		await store.appendRuns('business', 's_abcdef123456', [
			{
				due: '2026-10-29T07:00:00.000Z',
				at: '2026-10-29T07:00:01.000Z',
				status: 'started',
				taskId: 'daily-1',
			},
			{
				due: '2026-10-30T07:00:00.000Z',
				at: '2026-10-30T09:00:00.000Z',
				status: 'skipped',
				reason: 'missed',
			},
		]);
		expect((await store.runs('business', 's_abcdef123456')).map((r) => r.status)).toEqual([
			'skipped',
			'started',
		]);
		expect((await store.list()).map((s) => s.id)).toEqual(['s_abcdef123456']);
		await store.delete('business', 's_abcdef123456');
		expect(await store.list()).toEqual([]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
test('skips a broken schedule and a torn last run line', async () => {
	const root = await mkdtemp(join(tmpdir(), 'schedules-'));
	try {
		const store = new SchedulesStore(root);
		await store.save(schedule());
		await store.save(schedule({ id: 's_zzzzzz123456', projectId: 'admin', name: 'Nightly' }));
		await writeFile(
			join(root, 'projects', 'admin', 'schedules', 's_zzzzzz123456', 'schedule.json'),
			'{"schemaVersion":1,"schedule":{}}'
		);
		expect((await store.list()).map((s) => s.id)).toEqual(['s_abcdef123456']);
		await writeFile(
			join(root, 'projects', 'business', 'schedules', 's_abcdef123456', 'runs.jsonl'),
			'{"due":"2026-10-29T07:00:00.000Z","at":"2026-10-29T07:00:01.000Z","status":"started"}\n{"due":"2026-10-30T07:0'
		);
		expect(await store.runs('business', 's_abcdef123456')).toHaveLength(1);
		await expect(
			store.save({ ...schedule(), rule: { kind: 'hourly', minute: 99 } })
		).rejects.toThrow();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
