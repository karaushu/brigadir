import { expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SessionStore } from '@brigadir/persistence';
import { newIdentity, saveIdentity } from '@brigadir/host/client';
import { Sessions } from './sessions';
it('does not publish a disconnect for a connection that never attached to a stale host', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-stale-host-'));
	try {
		const store = await SessionStore.at(join(root, 'data')),
			project = await store.addProject(root),
			task = await store.createTask(project.id, 'Dead host', 'claude');
		await saveIdentity(store, await newIdentity(store, task));
		const publish = vi.fn(),
			sessions = new Sessions(store.root, resolve('apps/desktop/out/services'), publish),
			detached = vi.fn();
		sessions.onDetached = detached;
		expect((await sessions.read(task)).connected).toBe(false);
		expect((await sessions.read(task)).connected).toBe(false);
		expect(publish).not.toHaveBeenCalled();
		expect(detached).not.toHaveBeenCalled();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
it('unwatches on the host only what no other client still shows when the window goes (spec/remote-access-and-mobile#outbox)', async () => {
	const sessions = new Sessions('/nonexistent', resolve('apps/desktop/out/services'), vi.fn());
	const sent: unknown[] = [];
	const inside = sessions as unknown as {
		watching: Map<string, Set<string>>;
		clients: Map<string, { terminal(command: unknown): Promise<unknown> }>;
	};
	inside.clients.set('p/t', { terminal: async (command) => sent.push(command) });
	inside.watching.set('p/t', new Set(['phone', 'window']));
	sessions.unwatchAll((task, id) => task === 'p/t' && id === 'phone');
	expect(sent).toEqual([{ kind: 'unwatch', id: 'window' }]);
	expect([...inside.watching.get('p/t')!]).toEqual(['phone']);
	sessions.unwatchAll();
	expect(sent).toEqual([
		{ kind: 'unwatch', id: 'window' },
		{ kind: 'unwatch', id: 'phone' },
	]);
	expect(inside.watching.size).toBe(0);
});
