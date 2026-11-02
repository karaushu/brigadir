import { test, expect, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SessionStore, readDocument, atomicJson, ProcessCoordinator } from '@brigadir/persistence';
import { newIdentity, saveIdentity, acquireOwner } from '@brigadir/host/client';
import { LiveAgents } from './live-agents';
const services = resolve('apps/desktop/out/services');
test('observes all live owners including idle tasks without attaching; bounds journal reads and excludes stale process identities', async () => {
	const root = await mkdtemp(join(tmpdir(), 'live-agents-'));
	const releases: (() => Promise<unknown>)[] = [];
	try {
		const store = await SessionStore.at(join(root, 'data')),
			project = await store.addProject(root),
			task = await store.createTask(project.id, 'Idle host', 'claude');
		await store.setStatus(task, 'done');
		releases.push(await acquireOwner(store, task, join(services, 'process-owner')));
		const host = await newIdentity(store, task);
		await saveIdentity(store, host);
		const controlHost = vi.fn(async () => {}),
			live = new LiveAgents(store.root, services, { controlHost }),
			identity = vi.spyOn(ProcessCoordinator.prototype, 'identity');
		expect(
			(await live.read()).agents.map((item) => [item.title, item.status, item.instance])
		).toEqual([['Idle host', 'done', host.instance]]);
		// The popup polls every second: before BG-12 each scan spawned the helper once per live host, now once per host a minute.
		expect(identity).toHaveBeenCalledTimes(1);
		await live.read();
		await live.read();
		expect(identity).toHaveBeenCalledTimes(1);
		expect(controlHost).not.toHaveBeenCalled();
		await store.setStatus(task, 'working');
		const journal = join(await store.taskDir(task), 'events.jsonl'),
			record = {
				schemaVersion: 1,
				seq: 2,
				at: new Date().toISOString(),
				event: {
					kind: 'tool.changed',
					patch: { id: 'x', title: 'Read', locations: [{ path: 'src/main.ts', line: null }] },
				},
			};
		await writeFile(
			journal,
			'x'.repeat(100000) +
				'\n' +
				JSON.stringify(record) +
				'\n' +
				JSON.stringify({ incomplete: true })
		);
		expect((await live.read()).agents[0]?.activity).toBe('Read · src/main.ts');
		await expect(
			live.control({ key: task, instance: '00000000-0000-0000-0000-000000000000' }, 'terminate')
		).rejects.toThrow('changed');
		expect(controlHost).not.toHaveBeenCalled();
		const asked = identity.mock.calls.length;
		await live.control({ key: task, instance: host.instance }, 'stop');
		expect(controlHost).toHaveBeenCalledWith(task, host.instance, 'stop');
		expect(identity.mock.calls.length).toBe(asked + 1);
		const lock = join(await store.taskDir(task), 'host.lock'),
			owner = await readDocument(lock);
		await atomicJson(lock, { ...owner, processStart: '0000:0000' });
		expect((await live.read()).agents).toEqual([]);
		await expect(live.control({ key: task, instance: host.instance }, 'terminate')).rejects.toThrow(
			'changed'
		);
		await atomicJson(lock, owner);
		await rm(journal);
		await symlink(join(root, 'missing'), journal);
		const result = await live.read();
		expect(result.agents).toEqual([]);
		expect(result.issues).toBe(1);
	} finally {
		for (const release of releases) await release();
		await rm(root, { recursive: true, force: true });
	}
});
test('a forged host identity cannot select another project or reach process controls', async () => {
	const root = await mkdtemp(join(tmpdir(), 'live-invalid-'));
	try {
		const store = await SessionStore.at(join(root, 'data')),
			project = await store.addProject(root),
			task = await store.createTask(project.id, 'Forged', 'claude');
		await writeFile(
			join(await store.taskDir(task), 'host.json'),
			JSON.stringify({
				schemaVersion: 1,
				protocolVersion: 1,
				key: { ...task, id: 'other' },
				pid: process.pid,
				startedAt: new Date().toISOString(),
				instance: '00000000-0000-0000-0000-000000000000',
			})
		);
		await writeFile(
			join(await store.taskDir(task), 'host.lock'),
			JSON.stringify({ schemaVersion: 1, pid: process.pid, processStart: '0000' })
		);
		const controlHost = vi.fn(),
			live = new LiveAgents(store.root, services, { controlHost });
		expect(await live.read()).toEqual({ agents: [], issues: 1 });
		await expect(
			live.control({ key: task, instance: '00000000-0000-0000-0000-000000000000' }, 'terminate')
		).rejects.toThrow();
		expect(controlHost).not.toHaveBeenCalled();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
