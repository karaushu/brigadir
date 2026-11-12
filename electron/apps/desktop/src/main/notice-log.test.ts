import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { CIWatch, NoticeCenter, PendingNotice, TaskKey } from '@brigadir/core';
import { NoticeLog } from './notice-log';

const task: TaskKey = { projectId: 'business', id: 'phone' };
async function harness(pending: PendingNotice[] = []) {
	const dataDir = await mkdtemp(join(tmpdir(), 'brigadir-notices-'));
	const opened: TaskKey[] = [],
		runs: CIWatch[] = [],
		answers: string[] = [],
		changes: NoticeCenter[] = [];
	let now = Date.UTC(2026, 9, 29, 12);
	const log = new NoticeLog({
		dataDir,
		pending: () => pending,
		answer: (id, option) => answers.push(`${id}:${option}`),
		openTask: (key) => opened.push(key),
		openRun: (watch) => runs.push(watch),
		changed: (center) => changes.push(center),
		now: () => now,
	});
	return { dataDir, log, opened, runs, answers, changes, tick: (ms: number) => (now += ms) };
}

it('spec/notifications-slack-notes-and-schedules#notification-center: keeps entries in notifications.jsonl, reads them back and skips a torn line', async () => {
	const h = await harness();
	await h.log.addTask({
		kind: 'turn-ended',
		task,
		title: 'Phone validation',
		body: 'The turn ended.',
		read: false,
	});
	await h.log.waitForWrites();
	const file = join(h.dataDir, 'notifications.jsonl');
	await writeFile(file, `${await readFile(file, 'utf8')}{"torn`);
	const again = new NoticeLog({
		dataDir: h.dataDir,
		pending: () => [],
		answer() {},
		openTask() {},
		openRun() {},
		changed() {},
		now: () => Date.UTC(2026, 9, 29, 12),
	});
	const center = await again.center();
	expect(center.entries).toHaveLength(1);
	expect(center.entries[0]).toMatchObject({ title: 'Phone validation', read: false });
});

it('spec/notifications-slack-notes-and-schedules#notification-center: opening a row reads it and goes to its task or run; opening the task reads its rows', async () => {
	const watch: CIWatch = {
		projectId: 'business',
		taskId: null,
		scopeId: 'root',
		runId: 413,
		label: 'CI',
	};
	const h = await harness([
		{
			id: 'business/phone/q1',
			at: 1,
			kind: 'question',
			task,
			title: 'Phone validation',
			body: 'Q',
			allow: null,
			deny: null,
		},
	]);
	await h.log.addTask({
		kind: 'failed',
		task,
		title: 'Phone validation',
		body: 'The session failed.',
		read: false,
	});
	await h.log.addRun({
		watch,
		run: {} as never,
		state: 'fail',
		title: 'CI #413 failed',
		body: 'fix',
	});
	let { entries } = await h.log.center();
	await h.log.act({ kind: 'open', id: entries.find((entry) => entry.kind === 'ci-fail')!.id });
	expect(h.runs).toEqual([watch]);
	await h.log.act({ kind: 'open', id: 'business/phone/q1' });
	expect(h.opened).toEqual([task]);
	await h.log.readTask(task);
	({ entries } = await h.log.center());
	expect(entries.every((entry) => entry.read)).toBe(true);
	await h.log.act({ kind: 'answer', id: 'business/phone/q1', option: 'deny' });
	expect(h.answers).toEqual(['business/phone/q1:deny']);
	await h.log.act({ kind: 'clear' });
	expect((await h.log.center()).entries).toEqual([]);
	expect(h.changes.at(-1)?.pending).toHaveLength(1);
});

it('spec/notifications-slack-notes-and-schedules#notification-center: the same toast within a minute is one row with ×N', async () => {
	const h = await harness();
	const toast = {
		kind: 'error' as const,
		text: 'Could not send the message.',
		action: 'Retry',
		task,
		title: 'Phone',
		read: false,
	};
	await h.log.addToast(toast);
	h.tick(10_000);
	await h.log.addToast(toast);
	const { entries } = await h.log.center();
	expect(entries).toHaveLength(1);
	expect(entries[0]!.count).toBe(2);
});
