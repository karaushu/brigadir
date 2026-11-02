import { afterAll, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Superseded, WorkerPool } from './worker';
const roots: string[] = [];
afterAll(() => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));
async function script() {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-pool-'));
	roots.push(root);
	const path = join(root, 'job.cjs');
	await writeFile(
		path,
		`const {parentPort,threadId}=require('node:worker_threads');parentPort.on('message',m=>{if(m.loop)for(;;){}if(m.exit)process.exit(1);if(m.fail)return parentPort.postMessage({error:'bad input'});setTimeout(()=>parentPort.postMessage({value:{thread:threadId,echo:m.echo}}),m.wait??0);});`
	);
	return path;
}
type Reply = { thread: number; echo?: string };
it('keeps one worker for sequential jobs and answers in order', async () => {
	const pool = new WorkerPool(await script());
	const first = await pool.run<Reply>({ echo: 'a' }),
		second = await pool.run<Reply>({ echo: 'b' });
	expect([first.echo, second.echo]).toEqual(['a', 'b']);
	expect(second.thread).toBe(first.thread);
	pool.close();
});
it('runs up to size jobs at once and queues the rest', async () => {
	const pool = new WorkerPool(await script(), { size: 2 });
	const started = performance.now();
	const replies = await Promise.all(
		[1, 2, 3, 4].map((n) => pool.run<Reply>({ wait: 150, echo: String(n) }))
	);
	expect(replies.map((reply) => reply.echo)).toEqual(['1', '2', '3', '4']);
	expect(new Set(replies.map((reply) => reply.thread)).size).toBe(2);
	expect(performance.now() - started).toBeLessThan(550);
	pool.close();
});
it('fails only the job that crashed, timed out or threw, and replaces the worker', async () => {
	const pool = new WorkerPool(await script(), { deadlineMs: 300 });
	const before = await pool.run<Reply>({});
	await expect(pool.run({ fail: true })).rejects.toThrow('bad input');
	expect((await pool.run<Reply>({})).thread).toBe(before.thread);
	const [crash, after] = await Promise.allSettled([
		pool.run({ exit: true }),
		pool.run<Reply>({ echo: 'next' }),
	]);
	expect(crash.status).toBe('rejected');
	expect(after.status === 'fulfilled' && after.value.echo).toBe('next');
	const [loop, recovered] = await Promise.allSettled([
		pool.run({ loop: true }),
		pool.run<Reply>({ echo: 'recovered' }),
	]);
	expect(loop.status === 'rejected' && String(loop.reason)).toContain('resource limit');
	expect(recovered.status === 'fulfilled' && recovered.value.echo).toBe('recovered');
	pool.close();
});
it('replaces a queued job with the same key, bounds the queue and stops idle workers', async () => {
	const pool = new WorkerPool(await script(), { queue: 2, idleMs: 100 });
	const running = pool.run<Reply>({ wait: 100, echo: 'running' });
	const stale = pool.run<Reply>({ echo: 'stale' }, 'editor'),
		fresh = pool.run<Reply>({ echo: 'fresh' }, 'editor');
	await expect(stale).rejects.toBeInstanceOf(Superseded);
	const other = pool.run<Reply>({ echo: 'other' });
	await expect(pool.run({ echo: 'overflow' })).rejects.toThrow('queue is full');
	const first = await running;
	expect((await fresh).echo).toBe('fresh');
	expect((await other).echo).toBe('other');
	await new Promise((resolve) => setTimeout(resolve, 250));
	expect(pool.pending).toBe(0);
	expect((await pool.run<Reply>({})).thread).not.toBe(first.thread);
	pool.close();
});
