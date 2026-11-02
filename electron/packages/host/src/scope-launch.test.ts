import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ProcessCoordinator, SessionStore } from '@brigadir/persistence';
import { discoverScopes, gitText } from '@brigadir/git';
import { startHost } from './server';
import { connectHost } from './client';
import { ScopeLocks } from './scope-locks';
import { checklistBrief } from './crew';
it('atomically admits one in-place agent, permits an explicit override, releases on stop and keeps scope context out of the saved user prompt', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-lock-launch-'));
	const hosts: Awaited<ReturnType<typeof startHost>>[] = [],
		clients: Awaited<ReturnType<typeof connectHost>>[] = [];
	try {
		const repo = join(root, 'repo');
		await mkdir(repo);
		await gitText(repo, ['init', '-b', 'main']);
		await gitText(repo, ['config', 'user.name', 'Fixture']);
		await gitText(repo, ['config', 'user.email', 'fixture@example.invalid']);
		await writeFile(join(repo, 'file.txt'), 'base\n');
		await gitText(repo, ['add', '.']);
		await gitText(repo, ['commit', '-m', 'Initial']);
		const store = await SessionStore.at(join(root, 'data')),
			project = await store.addProject(repo);
		const launch = {
			isolation: 'in-place' as const,
			branch: '',
			baseRef: 'main',
			setupCommand: '',
			scopes: (await discoverScopes(repo)).map(({ id, name, kind }) => ({
				id,
				name,
				kind,
				selected: true,
			})),
		};
		const a = await store.createTask(
				project.id,
				'First task',
				'claude',
				'gui',
				'New task',
				'queued',
				launch
			),
			b = await store.createTask(
				project.id,
				'Second task',
				'claude',
				'gui',
				'New task',
				'queued',
				launch
			);
		const services = resolve('apps/desktop/out/services'),
			log = join(root, 'agent.jsonl'),
			config = {
				dataDir: store.root,
				mcpEntry: join(services, 'mcp-relay'),
				adapter: {
					command: process.execPath,
					args: [resolve('packages/transport/fixtures/agent.mjs'), 'normal', log],
				},
			};
		const results = await Promise.allSettled([
			startHost({ ...config, key: a }),
			startHost({ ...config, key: b }),
		]);
		for (const result of results) if (result.status === 'fulfilled') hosts.push(result.value);
		expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
		expect(results.find((result) => result.status === 'rejected')).toMatchObject({
			reason: expect.objectContaining({ message: expect.stringContaining('locked') }),
		});
		const winner = hosts[0]!,
			loser = winner.identity.key.id === a.id ? b : a,
			registry = new ScopeLocks(store, new ProcessCoordinator(join(services, 'process-owner')));
		expect(await registry.snapshot()).toHaveLength(1);
		const other = await startHost({ ...config, key: loser, allowScopeConflict: true });
		hosts.push(other);
		expect(await registry.snapshot()).toHaveLength(2);
		const client = await connectHost(winner.identity);
		clients.push(client);
		await client.command({ kind: 'prompt', text: 'Inspect the scope' });
		await expect
			.poll(
				async () =>
					(await client.snapshot()).records.filter(
						(record) => record.event.kind === 'turn.completed'
					).length
			)
			.toBe(1);
		const entries = (await readFile(log, 'utf8'))
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line));
		const blocks = entries.find((entry) => entry.event === 'prompt-blocks').params;
		expect(blocks[0].text).toBe('Inspect the scope');
		expect(blocks[1].text).toContain(checklistBrief);
		expect(blocks.at(-1).text).toContain('Workspace repositories');
		expect(blocks.at(-1).text).toContain('"writable": true');
		expect(
			(await client.snapshot()).records.find((record) => record.event.kind === 'turn.started')
				?.event
		).toEqual({ kind: 'turn.started', text: 'Inspect the scope' });
		await client.command({ kind: 'prompt', text: 'Next turn' });
		await expect
			.poll(
				async () =>
					(await client.snapshot()).records.filter(
						(record) => record.event.kind === 'turn.completed'
					).length
			)
			.toBe(2);
		const second = (await readFile(log, 'utf8'))
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line))
			.filter((entry) => entry.event === 'prompt-blocks')
			.at(-1).params;
		expect(second).toEqual([{ type: 'text', text: 'Next turn' }]);
		const nested = join(repo, 'new-context');
		await mkdir(nested);
		await gitText(nested, ['init', '-b', 'main']);
		await writeFile(join(nested, 'context.txt'), 'read only');
		await client.command({ kind: 'checkpoint' });
		await client.command({ kind: 'prompt', text: 'Inspect new context' });
		await expect
			.poll(
				async () =>
					(await client.snapshot()).records.filter(
						(record) => record.event.kind === 'turn.completed'
					).length
			)
			.toBe(3);
		const updated = (await readFile(log, 'utf8'))
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line))
			.filter((entry) => entry.event === 'prompt-blocks')
			.at(-1).params;
		expect(updated[1].text).toContain('new-context');
		expect(updated[1].text).toContain('"writable": false');
		await other.stop();
		expect(await registry.snapshot()).toHaveLength(1);
		await winner.stop();
		expect(await registry.snapshot()).toEqual([]);
		const resumed = await startHost({ ...config, key: winner.identity.key });
		hosts.push(resumed);
		const resumedClient = await connectHost(resumed.identity);
		clients.push(resumedClient);
		await resumedClient.command({ kind: 'prompt', text: 'Resumed turn' });
		await expect
			.poll(
				async () =>
					(await resumedClient.snapshot()).records.filter(
						(record) => record.event.kind === 'turn.completed'
					).length
			)
			.toBe(4);
		const resumedBlocks = (await readFile(log, 'utf8'))
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line))
			.filter((entry) => entry.event === 'prompt-blocks')
			.at(-1).params;
		expect(resumedBlocks.at(-1).text).toContain('Workspace repositories');
		expect(resumedBlocks.at(-1).text).toContain('new-context');
	} finally {
		for (const client of clients) client.close();
		for (const host of hosts) await host.stop();
		await rm(root, { recursive: true, force: true });
	}
}, 20000);
