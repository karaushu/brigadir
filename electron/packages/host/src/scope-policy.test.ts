import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SessionStore, contentVersion } from '@brigadir/persistence';
import { discoverScopes, gitText, readChanges } from '@brigadir/git';
import { isSessionEvent, noticeKind } from '@brigadir/core';
import { startHost } from './server';
import { connectHost } from './client';
it('enforces ACP scope writes and reports hidden read-only changes once without rewriting user saves or blaming a process', async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'brigadir-scope-policy-')));
	let host: Awaited<ReturnType<typeof startHost>> | undefined,
		client: Awaited<ReturnType<typeof connectHost>> | undefined;
	try {
		const repo = join(root, 'repo');
		await mkdir(repo);
		for (const path of [repo, join(repo, 'child')]) {
			await mkdir(path, { recursive: true });
			await gitText(path, ['init', '-b', 'main']);
			await gitText(path, ['config', 'user.name', 'Fixture']);
			await gitText(path, ['config', 'user.email', 'fixture@example.invalid']);
			await writeFile(join(path, 'read.txt'), 'first\nsecond\n');
			await writeFile(join(path, '.gitignore'), 'child/\n');
			await gitText(path, ['add', '.']);
			await gitText(path, ['commit', '-m', 'Initial']);
		}
		const store = await SessionStore.at(join(root, 'data')),
			project = await store.addProject(repo),
			scopes = (await discoverScopes(repo)).map(({ id, name, kind }) => ({
				id,
				name,
				kind,
				selected: name !== '.',
			}));
		const task = await store.createTask(
			project.id,
			'Policy',
			'claude',
			'gui',
			'New task',
			'queued',
			{ isolation: 'in-place', branch: '', baseRef: 'main', setupCommand: '', scopes }
		);
		const log = join(root, 'wire.jsonl');
		host = await startHost({
			dataDir: store.root,
			key: task,
			mcpEntry: resolve('apps/desktop/out/services/mcp-relay'),
			adapter: {
				command: process.execPath,
				args: [resolve('packages/transport/fixtures/agent.mjs'), 'fs-policy', log],
			},
		});
		client = await connectHost(host.identity);
		const connected = client;
		await client.command({ kind: 'prompt', text: 'test files' });
		await expect
			.poll(
				async () =>
					(await connected.snapshot()).records.some(
						(record) => record.event.kind === 'turn.completed'
					),
				{ timeout: 15_000 }
			)
			.toBe(true);
		const wire = (await readFile(log, 'utf8'))
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line));
		expect(wire.find((entry) => entry.event === 'initialize').params.clientCapabilities.fs).toEqual(
			{ readTextFile: true, writeTextFile: true }
		);
		expect(wire.find((entry) => entry.event === 'new').params.additionalDirectories).toEqual([
			join(repo, 'child'),
		]);
		expect(wire.find((entry) => entry.event === 'fs-read').params).toEqual({ content: 'second' });
		expect(wire.find((entry) => entry.event === 'fs-denied').params).toContain('not in the task');
		expect(await readFile(join(repo, 'read.txt'), 'utf8')).toBe('first\nsecond\n');
		expect(await readFile(join(repo, 'child/new/deep.txt'), 'utf8')).toBe('agent file\n');
		expect(
			(await readChanges(store, task)).files.some((file) => file.path === 'new/deep.txt')
		).toBe(true);
		await client.command({ kind: 'prompt', text: 'hold' });
		await expect
			.poll(async () =>
				(await connected.snapshot()).records.some(
					(record) => record.event.kind === 'turn.started' && record.event.text === 'hold'
				)
			)
			.toBe(true);
		await writeFile(join(repo, 'read.txt'), 'external write during a turn\n');
		await client.command({ kind: 'checkpoint' });
		await expect
			.poll(
				async () =>
					(await connected.snapshot()).records.filter(
						(record) => record.event.kind === 'scope.violation'
					).length
			)
			.toBe(1);
		const violation = (await client.snapshot()).records.find(
			(record) => record.event.kind === 'scope.violation'
		)!.event;
		expect(violation).toMatchObject({ kind: 'scope.violation', name: '.', paths: ['read.txt'] });
		expect(isSessionEvent(violation)).toBe(true);
		expect(noticeKind(violation)).toBe('scope-violation');
		expect(
			(await readChanges(store, task)).files.every(
				(file) => file.scopeId !== scopes.find((scope) => scope.name === '.')!.id
			)
		).toBe(true);
		await client.command({ kind: 'checkpoint' });
		expect(
			(await client.snapshot()).records.filter((record) => record.event.kind === 'scope.violation')
		).toHaveLength(1);
		await expect(
			client.command({ kind: 'setScope', update: { id: scopes[0]!.id, selected: true } })
		).rejects.toThrow('Stop the task');
		await expect(
			client.command({
				kind: 'setScope',
				update: { id: scopes.find((scope) => scope.name === '.')!.id, selected: true },
			})
		).rejects.toThrow('Stop the task');
		expect(
			(await store.task(task)).launch!.scopes.find((scope) => scope.name === '.')!.selected
		).toBe(false);
		await client.command({ kind: 'cancel' });
		await expect
			.poll(
				async () =>
					(await connected.snapshot()).records.filter(
						(record) => record.event.kind === 'turn.completed'
					).length
			)
			.toBe(2);
		const beforeUser = await readFile(join(repo, 'read.txt'));
		await client.saveFile({
			path: 'read.txt',
			expectedVersion: contentVersion(beforeUser),
			text: 'explicit user save\n',
		});
		expect(
			(await client.snapshot()).records.filter((record) => record.event.kind === 'scope.violation')
		).toHaveLength(1);
	} finally {
		client?.close();
		await host?.stop();
		await rm(root, { recursive: true, force: true });
	}
}, 20000);
