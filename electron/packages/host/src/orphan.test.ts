import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SessionStore, atomicJson } from '@brigadir/persistence';
import { connectHost, readIdentity, orphanCheckMs } from './index';
const run = promisify(execFile);
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn();
});
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(read: () => Promise<T | undefined>, timeout = 10000): Promise<T> {
	const end = Date.now() + timeout;
	while (Date.now() < end) {
		const v = await read();
		if (v !== undefined) return v;
		await delay(25);
	}
	throw new Error('Condition timed out');
}
const alive = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;
async function launch() {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-orphan-test-'));
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	const repo = join(root, 'repo');
	await mkdir(repo);
	await run('git', ['init', '-q', '-b', 'main'], { cwd: repo });
	await writeFile(join(repo, 'README.md'), 'hello\n');
	const store = await SessionStore.at(join(root, 'data'));
	const project = await store.addProject(repo);
	const key = await store.createTask(project.id, 'Orphan', 'claude');
	const config = join(await store.taskDir(key), 'config.json');
	await atomicJson(config, {
		schemaVersion: 1,
		dataDir: store.root,
		key,
		mcpEntry: resolve('apps/desktop/out/services/mcp-relay'),
		adapter: {
			command: process.execPath,
			args: [resolve('packages/transport/fixtures/agent.mjs'), 'normal', join(root, 'agent.jsonl')],
		},
	});
	const child = spawn(process.execPath, [resolve('apps/desktop/out/services/host.cjs'), config], {
		stdio: 'pipe',
	});
	let diagnostics = '';
	child.stderr.on('data', (c) => {
		diagnostics += c;
	});
	cleanup.push(async () => {
		if (alive(child)) {
			child.kill('SIGTERM');
			await until(async () => (alive(child) ? undefined : true)).catch(() => child.kill('SIGKILL'));
		}
	});
	const identity = await until(async () => {
		if (child.exitCode !== null) throw new Error(diagnostics);
		const id = await readIdentity(store, key);
		return id && id.pid === child.pid ? id : undefined;
	});
	const client = await connectHost(identity);
	cleanup.push(async () => client.close());
	await until(async () => ((await client.snapshot()).connected ? true : undefined));
	return { root, data: store.root, child, client };
}

// spec/architecture-and-platform#host-lifecycle: the host outlives the app (spec/tasks#task-states), but not its task dir; no idle blocker keeps an unreachable host.
it('stops a host whose data dir was deleted, selected or not, and leaves the others running', async () => {
	const removed = await launch(),
		kept = await launch();
	// Selected in the window and attached: an idle stop would never happen, the orphan stop still does.
	await removed.client.visible(true);
	await rm(removed.data, { recursive: true, force: true });
	await until(async () => (alive(removed.child) ? undefined : true), orphanCheckMs * 3);
	expect(alive(kept.child)).toBe(true);
	expect((await kept.client.status()).connected).toBe(true);
	// No client at all: the app quit, then the fixture dir went away.
	kept.client.close();
	await delay(orphanCheckMs + 500);
	expect(alive(kept.child)).toBe(true);
	await rm(kept.data, { recursive: true, force: true });
	await until(async () => (alive(kept.child) ? undefined : true), orphanCheckMs * 3);
}, 60000);
