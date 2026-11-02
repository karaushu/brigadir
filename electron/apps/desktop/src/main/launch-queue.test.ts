import { it, expect } from 'vitest';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentTask, SessionSnapshot, TaskKey } from '@brigadir/core';
import { LaunchQueue } from './launch-queue';
const key = (id: string): TaskKey => ({ projectId: 'project', id });
function world(
	root: string,
	limit: () => number | null,
	eligible?: (key: TaskKey, interactive: boolean) => Promise<'ready' | 'queue' | 'cancel'>
) {
	const tasks = new Map<string, AgentTask>(),
		started: string[] = [],
		prompts: { id: string; text: string }[] = [],
		changed: string[] = [];
	let failStart = false,
		failureStatus: AgentTask['status'] | undefined,
		quietStart = false;
	const snapshot = (id: string): SessionSnapshot => ({
		key: key(id),
		records: [],
		connected: false,
		issue: null,
	});
	const queue = new LaunchQueue(
		root,
		{
			...(eligible ? { eligible } : {}),
			limit,
			active: async () =>
				[...tasks.values()]
					.filter((task) => task.status === 'working' || task.status === 'needs-you')
					.map((task) => key(task.id)),
			start: async (k) => {
				if (failStart) {
					if (failureStatus) tasks.get(k.id)!.status = failureStatus;
					throw new Error('boom');
				}
				started.push(k.id);
				if (!quietStart) tasks.get(k.id)!.status = 'working';
				return snapshot(k.id);
			},
			sendPrompt: async (k, text) => {
				prompts.push({ id: k.id, text });
			},
			task: async (k) => {
				const task = tasks.get(k.id);
				if (!task) throw new Error('missing');
				return task;
			},
			hasTurns: async () => false,
			setStatus: async (k, status) => {
				tasks.get(k.id)!.status = status;
			},
			snapshot: async (k) => snapshot(k.id),
			changed: (k) => {
				changed.push(k.id);
			},
		},
		50
	);
	const add = (id: string, extra: Partial<AgentTask> = {}) => {
		tasks.set(id, {
			id,
			projectId: 'project',
			title: id,
			status: 'queued',
			provider: 'claude',
			transport: 'gui',
			prompt: `${id} prompt`,
			...extra,
		});
	};
	return {
		queue,
		tasks,
		started,
		prompts,
		changed,
		add,
		setQuietStart: (value: boolean) => {
			quietStart = value;
		},
		setFailStart: (value: boolean, status?: AgentTask['status']) => {
			failStart = value;
			failureStatus = status;
		},
	};
}
it('starts within the limit, queues beyond it, promotes in order with the stored prompt and persists the queue', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-launch-queue-'));
	try {
		let limit: number | null = 1;
		const w = world(root, () => limit);
		w.add('a');
		w.add('b');
		w.add('c', { transport: 'terminal' });
		w.add('d');
		expect((await w.queue.request(key('a'))).queued).toBeUndefined();
		expect(w.started).toEqual(['a']);
		expect(w.changed).toEqual(['a']);
		expect((await w.queue.request(key('b'))).queued).toBe(true);
		expect(w.tasks.get('b')!.status).toBe('queued');
		expect(JSON.parse(await readFile(join(root, 'launch-queue.json'), 'utf8'))).toEqual({
			schemaVersion: 1,
			queue: [key('b')],
		});
		expect((await w.queue.request(key('b'))).queued).toBe(true);
		expect(w.queue.keys).toEqual([key('b')]);
		await w.queue.request(key('c'));
		expect(w.queue.keys).toEqual([key('b'), key('c')]);
		w.tasks.get('a')!.status = 'done';
		await w.queue.kick();
		expect(w.started).toEqual(['a', 'b']);
		expect(w.prompts).toEqual([
			{ id: 'a', text: 'a prompt' },
			{ id: 'b', text: 'b prompt' },
		]);
		expect(w.queue.keys).toEqual([key('c')]);
		w.tasks.get('b')!.status = 'done';
		await w.queue.kick();
		expect(w.started).toEqual(['a', 'b', 'c']);
		expect(w.prompts).toHaveLength(2);
		expect(JSON.parse(await readFile(join(root, 'launch-queue.json'), 'utf8')).queue).toEqual([]);
		w.tasks.get('c')!.status = 'done';
		limit = null;
		await w.queue.request(key('d'));
		expect(w.started).toEqual(['a', 'b', 'c', 'd']);
		expect(w.prompts).toHaveLength(3);
		w.queue.stop();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
it('lets Stop leave the queue, restores queued tasks after restart and marks failed promotions interrupted', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-launch-queue-restore-'));
	try {
		const w = world(root, () => 1);
		w.add('a', { status: 'working' });
		w.add('b');
		w.add('c');
		await w.queue.request(key('b'));
		await w.queue.request(key('c'));
		expect(await w.queue.dequeue(key('b'))).toBe(true);
		expect(w.tasks.get('b')!.status).toBe('interrupted');
		expect(await w.queue.dequeue(key('b'))).toBe(false);
		expect(JSON.parse(await readFile(join(root, 'launch-queue.json'), 'utf8')).queue).toEqual([
			key('c'),
		]);
		w.queue.stop();
		const again = world(root, () => 1);
		again.add('a', { status: 'working' });
		again.add('c');
		again.add('gone');
		await writeFile(
			join(root, 'launch-queue.json'),
			JSON.stringify({
				schemaVersion: 1,
				queue: [key('c'), key('missing'), { bad: true }, key('gone')],
			})
		);
		again.tasks.get('gone')!.status = 'done';
		await again.queue.restore();
		expect(again.queue.keys).toEqual([key('c')]);
		again.setFailStart(true);
		again.tasks.get('a')!.status = 'done';
		await again.queue.kick();
		expect(again.tasks.get('c')!.status).toBe('interrupted');
		expect(again.queue.keys).toEqual([]);
		again.queue.stop();
		const empty = new LaunchQueue(join(root, 'fresh'), {
			limit: () => 1,
			active: async () => [],
			start: async () => {
				throw new Error('unused');
			},
			sendPrompt: async () => {},
			task: async () => {
				throw new Error('unused');
			},
			hasTurns: async () => false,
			setStatus: async () => {},
			snapshot: async () => {
				throw new Error('unused');
			},
			changed: () => {},
		});
		await mkdir(join(root, 'fresh'), { recursive: true });
		await empty.restore();
		expect(empty.keys).toEqual([]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
it('serializes simultaneous admissions and coalesces repeated starts into one first prompt', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-launch-concurrent-'));
	try {
		const w = world(root, () => 1);
		w.add('a');
		w.add('b');
		await Promise.all([
			w.queue.request(key('a')),
			w.queue.request(key('a')),
			w.queue.request(key('b')),
		]);
		expect(w.started).toEqual(['a']);
		expect(w.prompts).toEqual([{ id: 'a', text: 'a prompt' }]);
		expect(w.queue.keys).toEqual([key('b')]);
		w.queue.stop();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it('skips a locked head, promotes another task, and observes released locks without a user action', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-lock-queue-'));
	const blocked = new Set(['a']);
	const w = world(
		root,
		() => 1,
		async (key) => (blocked.has(key.id) ? 'queue' : 'ready')
	);
	try {
		w.add('busy', { status: 'working' });
		w.add('a');
		w.add('b');
		await w.queue.request(key('a'));
		await w.queue.request(key('b'));
		w.tasks.get('busy')!.status = 'done';
		await w.queue.kick();
		expect(w.started).toEqual(['b']);
		expect(w.queue.keys).toEqual([key('a')]);
		w.tasks.get('b')!.status = 'done';
		blocked.clear();
		await expect.poll(() => w.started).toEqual(['b', 'a']);
		expect(w.queue.keys).toEqual([]);
	} finally {
		w.queue.stop();
		await rm(root, { recursive: true, force: true });
	}
});

it('preserves a preparation failure when a queued start fails', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-queue-preparation-'));
	const w = world(root, () => 1);
	try {
		w.add('busy', { status: 'working' });
		w.add('queued');
		await w.queue.request(key('queued'));
		w.setFailStart(true, 'failed');
		w.tasks.get('busy')!.status = 'done';
		await w.queue.kick();
		expect(w.tasks.get('queued')!.status).toBe('failed');
		expect(w.queue.keys).toEqual([]);
	} finally {
		w.queue.stop();
		await rm(root, { recursive: true, force: true });
	}
});
it('leaves a backlog task in backlog when its launch conflict is cancelled', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-cancel-backlog-'));
	const w = world(
		root,
		() => 1,
		async () => 'cancel'
	);
	try {
		w.add('backlog', { status: 'backlog' });
		await w.queue.request(key('backlog'));
		expect(w.tasks.get('backlog')!.status).toBe('backlog');
		expect(w.started).toEqual([]);
		expect(w.prompts).toEqual([]);
		expect(w.queue.keys).toEqual([]);
	} finally {
		w.queue.stop();
		await rm(root, { recursive: true, force: true });
	}
});

it('a start with no first prompt is not queued: the task is done and waits for the person (spec/tasks#lock-registry)', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-queue-empty-'));
	let limit: number | null = 1;
	const w = world(root, () => limit);
	try {
		// A start that sends no prompt begins no turn, so the host leaves the status as it found it.
		w.setQuietStart(true);
		w.add('empty', { prompt: '' });
		w.add('blank', { prompt: '  ' });
		w.add('cli', { prompt: '', transport: 'terminal' });
		await w.queue.request(key('empty'));
		expect(w.started).toEqual(['empty']);
		expect(w.prompts).toEqual([]);
		expect(w.tasks.get('empty')!.status).toBe('done');
		// The same task promoted from the waiting list once a slot is free.
		w.tasks.get('empty')!.status = 'working';
		await w.queue.request(key('blank'));
		expect(w.queue.keys).toEqual([key('blank')]);
		expect(w.tasks.get('blank')!.status).toBe('queued');
		w.tasks.get('empty')!.status = 'done';
		await w.queue.kick();
		expect(w.tasks.get('blank')!.status).toBe('done');
		expect(w.prompts).toEqual([]);
		expect(w.queue.keys).toEqual([]);
		// A CLI task is not touched: its hooks set the status.
		await w.queue.request(key('cli'));
		expect(w.started).toEqual(['empty', 'blank', 'cli']);
		expect(w.tasks.get('cli')!.status).toBe('queued');
		// A task that sent its prompt keeps the status the host gives it.
		w.setQuietStart(false);
		w.add('full');
		limit = null;
		await w.queue.request(key('full'));
		expect(w.prompts).toEqual([{ id: 'full', text: 'full prompt' }]);
		expect(w.tasks.get('full')!.status).toBe('working');
	} finally {
		w.queue.stop();
		await rm(root, { recursive: true, force: true });
	}
});
