import { expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createConnection } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { atomicJson, safePath, Attachments, SessionStore } from '@brigadir/persistence';
import type { TerminalInfo, TerminalSnapshot } from '@brigadir/core';
import { discoverScopes } from '@brigadir/git';
import { startHost } from './server';
import { connectHost } from './client';
import { Peer } from './peer';
it.each(['claude', 'codex'] as const)(
	'tracks %s CLI through real hook relay and PTY, cancels and resumes the same provider session',
	async (provider) => {
		const root = await mkdtemp(join(tmpdir(), 'brigadir-cli-test-'));
		const repo = join(root, 'repo with spaces');
		await mkdir(repo);
		const git = promisify(execFile);
		await git('git', ['init', '-q', repo]);
		await writeFile(join(repo, 'cli.txt'), 'baseline\n');
		const store = await SessionStore.at(join(root, 'data'));
		const project = await store.addProject(repo);
		const task = await store.createTask(
			project.id,
			'Prompt with `literal` $(text)',
			provider,
			'terminal',
			'New task',
			'queued',
			{
				isolation: 'in-place',
				branch: '',
				baseRef: 'main',
				setupCommand: '',
				scopes: (await discoverScopes(repo)).map(({ id, name, kind }) => ({
					id,
					name,
					kind,
					selected: true,
				})),
			}
		);
		const previous = await store.createTask(project.id, 'Previous CLI task', provider),
			relayAsset = await new Attachments(store).create(task, {
				kind: 'text',
				name: 'Relay summary',
				text: 'Previous task handoff',
			});
		await store.updateTask(task, { continuesTaskId: previous.id });
		await atomicJson(await safePath(await store.taskDir(task), 'relay.json'), {
			schemaVersion: 1,
			handoff: {
				sourceId: previous.id,
				attachmentIds: [relayAsset.id],
				files: ['cli.txt', 'missing.txt'],
			},
		});
		const config = {
			dataDir: store.root,
			key: task,
			mcpEntry: resolve('apps/desktop/out/services/mcp-relay'),
			cli: {
				command: process.execPath,
				args: [
					resolve('packages/transport/fixtures/cli.mjs'),
					resolve('apps/desktop/out/services/hook.zsh'),
				],
			},
		};
		let host = await startHost(config);
		let client = await connectHost(host.identity);
		let forbidden: Peer | undefined;
		let questionPeer: Peer | undefined;
		try {
			await expect
				.poll(
					async () =>
						(await client.snapshot()).records.filter((r) => r.event.kind === 'turn.completed')
							.length,
					{ timeout: 10000 }
				)
				.toBe(1);
			const firstLaunch = JSON.parse(
				await readFile(join(await store.taskDir(task), 'cli-launch.json'), 'utf8')
			);
			expect(firstLaunch.args.at(-1)).toBe(task.prompt);
			const firstContext = await readFile(join(repo, 'hook-context.json'), 'utf8');
			expect(firstContext).toContain('Workspace repositories');
			expect(firstContext).toContain('writable');
			expect(firstContext).toContain('Previous task handoff');
			expect(firstContext).toContain('cli.txt');
			expect(firstContext).not.toContain('missing.txt');
			expect(JSON.stringify((await client.snapshot()).records)).not.toContain(
				'Workspace repositories'
			);
			expect(host.adapterInfo).toBeNull();
			const snapshot = await client.snapshot();
			expect(JSON.stringify(snapshot.records)).not.toContain('Private tool output');
			expect(JSON.stringify(snapshot.records)).not.toContain('Second line');
			expect(
				snapshot.records.some(
					(r) => r.event.kind === 'checkpoint.created' && r.event.checkpoint > 0
				)
			).toBe(true);
			forbidden = new Peer(createConnection(host.identity.socket));
			await forbidden.request('handshake', {
				protocolVersion: 1,
				instance: host.identity.instance,
				key: task,
				role: 'hook',
				token: host.identity.hookToken,
			});
			await expect(forbidden.request('command', { kind: 'shutdown' })).rejects.toThrow(
				'not available'
			);
			await expect(forbidden.request('snapshot', {})).rejects.toThrow('not available');
			await expect(
				forbidden.request('cli_hook', { session_id: 'wrong-session', hook_event_name: 'Stop' })
			).rejects.toThrow('does not match');
			forbidden.close();
			forbidden = undefined;
			const info = ((await client.terminal({ kind: 'list' })) as TerminalInfo[])[0]!;
			expect(
				((await client.terminal({ kind: 'read', id: info.id })) as TerminalSnapshot).anchors
			).toEqual([
				{
					turn: snapshot.records.find((record) => record.event.kind === 'turn.started')!.seq,
					line: 0,
				},
			]);
			await client.terminal({ kind: 'input', id: info.id, data: 'n' });
			await expect
				.poll(
					async () =>
						(await client.snapshot()).records.filter((r) => r.event.kind === 'turn.started').length
				)
				.toBe(2);
			questionPeer = new Peer(createConnection(host.identity.socket));
			await questionPeer.request('handshake', {
				protocolVersion: 1,
				instance: host.identity.instance,
				key: task,
				role: 'mcp',
				token: host.identity.mcpToken,
			});
			const cancelledQuestion = questionPeer
				.request('ask_user', {
					question: 'Cancel the waiting CLI question?',
					header: 'CLI',
					options: [],
					allowsFreeText: true,
					allowsMultiple: false,
				})
				.then(
					() => false,
					() => true
				);
			await expect
				.poll(async () =>
					(await client.snapshot()).records.some((r) => r.event.kind === 'question.requested')
				)
				.toBe(true);
			await client.command({ kind: 'cancel' });
			expect(await cancelledQuestion).toBe(true);
			expect(
				(await client.snapshot()).records.some(
					(r) => r.event.kind === 'question.resolved' && r.event.answer === null
				)
			).toBe(true);
			questionPeer.close();
			questionPeer = undefined;
			await expect
				.poll(
					async () =>
						(await client.snapshot()).records
							.filter((r) => r.event.kind === 'turn.completed')
							.at(-1)?.event
				)
				.toEqual({ kind: 'turn.completed', reason: 'cancelled' });
			const batch = {
				kind: 'submitReview' as const,
				text: 'Review the boundary case',
				review: {
					id: 'a'.repeat(64),
					comments: [{ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', version: 1 }],
				},
			};
			await client.command(batch);
			expect((await client.snapshot()).pendingReview).toEqual(batch.review);
			await client.command({ kind: 'discardQueuedReview' });
			expect((await client.snapshot()).pendingReview).toBeUndefined();
			await client.command(batch);
			const assets = new Attachments(store);
			const text = await assets.create(task, {
				kind: 'text',
				name: 'Build output',
				text: 'Explicit build failure',
			});
			const image = await assets.create(task, {
				kind: 'image',
				name: 'Screenshot',
				mimeType: 'image/png',
				data: 'iVBORw0KGgo=',
			});
			await client.command({ kind: 'attachContext', id: text.id });
			await client.command({ kind: 'removeContext', id: text.id });
			expect((await client.snapshot()).pendingAttachments).toEqual([]);
			await client.command({ kind: 'attachContext', id: text.id });
			await client.command({ kind: 'attachContext', id: image.id });
			await host.stop();
			client.close();
			host = await startHost(config);
			client = await connectHost(host.identity);
			await expect
				.poll(
					async () =>
						(await client.snapshot()).records.filter((r) => r.event.kind === 'session.started')
							.length
				)
				.toBe(2);
			const launch = JSON.parse(
				await readFile(join(await store.taskDir(task), 'cli-launch.json'), 'utf8')
			);
			expect(launch.resume).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
			expect(launch.args).not.toContain(task.prompt);
			expect(
				(await client.snapshot()).records.filter((r) => r.event.kind === 'turn.started')
			).toHaveLength(2);
			expect((await client.snapshot()).pendingReview).toEqual(batch.review);
			expect((await client.snapshot()).pendingAttachments).toEqual([text, image]);
			const resumed = ((await client.terminal({ kind: 'list' })) as TerminalInfo[])[0]!;
			await client.terminal({ kind: 'input', id: resumed.id, data: 'n' });
			await expect
				.poll(
					async () =>
						(await client.snapshot()).records.filter((r) => r.event.kind === 'turn.started').at(-1)
							?.event
				)
				.toMatchObject({ review: batch.review });
			await expect
				.poll(async () => readFile(join(repo, 'hook-context.json'), 'utf8').catch(() => ''))
				.toContain('Review the boundary case');
			const context = await readFile(join(repo, 'hook-context.json'), 'utf8');
			expect(context).toContain('Workspace repositories');
			expect(context).not.toContain('Previous task handoff');
			expect(context).toContain('Explicit build failure');
			expect(context).toContain((await assets.read(task, image.id)).path);
			expect(context).not.toContain('iVBOR');
			expect((await client.snapshot()).pendingAttachments).toEqual([]);
			expect(JSON.stringify((await client.snapshot()).records)).not.toContain(
				'Explicit build failure'
			);
			expect((await client.snapshot()).pendingReview).toBeUndefined();
			await client.command(batch);
			expect((await client.snapshot()).pendingReview).toBeUndefined();
			await client.terminal({ kind: 'input', id: resumed.id, data: 'q' });
			await expect
				.poll(async () => ((await client.terminal({ kind: 'list' })) as TerminalInfo[])[0]?.exited)
				.toBe(true);
			await client.startAgent();
			await expect
				.poll(
					async () =>
						(await client.snapshot()).records.filter((r) => r.event.kind === 'session.started')
							.length
				)
				.toBe(3);
		} finally {
			questionPeer?.close();
			forbidden?.close();
			client.close();
			await host.stop();
			await rm(root, { recursive: true, force: true });
		}
	},
	20000
);
