import { expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SessionStore, readRelayHandoff, Attachments } from '@brigadir/persistence';
import { Snapshots, gitText, readRelayDiff } from '@brigadir/git';
import { Relays } from './relays';
import { LaunchSettingsStore } from './launch-settings';
import { Preparations } from './preparations';
import { startHost } from '../../../../packages/host/src/server';
import { connectHost } from '@brigadir/host/client';
it('freezes a relay diff, inherits launch choices, rebases links to the new worktree and sends context only once', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-relay-'));
	let host: Awaited<ReturnType<typeof startHost>> | undefined,
		client: Awaited<ReturnType<typeof connectHost>> | undefined;
	try {
		const repo = join(root, 'repo');
		await mkdir(repo);
		await gitText(repo, ['init', '-b', 'main']);
		await gitText(repo, ['config', 'user.name', 'Fixture']);
		await gitText(repo, ['config', 'user.email', 'fixture@example.invalid']);
		await writeFile(join(repo, 'existing.txt'), 'base\n');
		await gitText(repo, ['add', '.']);
		await gitText(repo, ['commit', '-m', 'Initial']);
		const store = await SessionStore.at(join(root, 'data')),
			project = await store.addProject(repo),
			settings = new LaunchSettingsStore(store.root),
			launch = { ...(await settings.read(project.id)), branch: '', baseRef: 'main' },
			source = await store.createTask(
				project.id,
				'Original objective',
				'claude',
				'gui',
				'Task',
				'queued',
				launch
			),
			snapshots = await Snapshots.open(store, source);
		await snapshots.capture('baseline');
		await writeFile(join(repo, 'existing.txt'), 'base\nchange\n');
		await writeFile(join(repo, 'new.txt'), 'untracked handoff file\n');
		await snapshots.capture('turn');
		const writer = await store.writer(source);
		await writer.append({ kind: 'turn.started', text: 'Original objective' });
		await writer.append({
			kind: 'message.delta',
			role: 'assistant',
			messageId: null,
			content: { kind: 'text', text: 'Updated existing.txt, still need to check the UI.' },
		});
		await writer.append({ kind: 'turn.completed', reason: 'end_turn' });
		await writer.close();
		await store.setStatus(source, 'done');
		const original = await readFile(join(await store.taskDir(source), 'events.jsonl'), 'utf8');
		let calls = 0;
		const relays = new Relays(store.root, settings, { range: () => undefined }, async (input) => {
			calls++;
			expect(input.prompt).toContain('Original objective');
			return 'Completed the file update. Next: check the UI.';
		});
		const draft = await relays.prepare(source);
		expect(calls).toBe(0);
		expect(draft.launch).toMatchObject({ branch: '', baseRef: 'main', scopes: launch.scopes });
		expect(draft.diff.stat).toContain('new.txt');
		expect(draft.diff.patch).toContain('untracked handoff file');
		await Promise.all([relays.summarize(draft.id), relays.summarize(draft.id)]);
		expect(calls).toBe(1);
		const task = await relays.create(
			{
				draftId: draft.id,
				text: 'Verify the UI',
				provider: 'claude',
				transport: 'gui',
				backlog: false,
				launch: { ...draft.launch, isolation: 'worktree', branch: 'codex/relay-fixture' },
				selection: { summary: true, diff: true, fullPatch: false },
			},
			'Task'
		);
		expect(task.continuesTaskId).toBe(source.id);
		expect(task.prompt).toBe('Verify the UI');
		expect(calls).toBe(1);
		const handoff = await readRelayHandoff(store, task);
		expect(handoff?.attachmentIds).toHaveLength(2);
		const bodies = await new Attachments(store).resolve(task, handoff!.attachmentIds);
		expect(JSON.stringify(bodies.map((value) => value.input))).not.toContain(
			'+untracked handoff file'
		);
		const preparations = new Preparations(
			store.root,
			resolve('apps/desktop/out/services'),
			() => {}
		);
		await preparations.prepare(task);
		const workspace = await store.projectForTask(task),
			log = join(root, 'wire.jsonl');
		host = await startHost({
			dataDir: store.root,
			key: task,
			mcpEntry: resolve('apps/desktop/out/services/mcp-relay'),
			adapter: {
				command: process.execPath,
				args: [resolve('packages/transport/fixtures/agent.mjs'), 'normal', log],
			},
		});
		client = await connectHost(host.identity);
		const connected = client;
		await client.command({ kind: 'prompt', text: 'Verify the UI' });
		await expect
			.poll(
				async () =>
					(await connected.snapshot()).records.filter(
						(record) => record.event.kind === 'turn.completed'
					).length
			)
			.toBe(1);
		const wire = () =>
			readFile(log, 'utf8').then((text) =>
				text
					.trim()
					.split('\n')
					.map((line) => JSON.parse(line))
			);
		const blocks = (await wire()).find((entry) => entry.event === 'prompt-blocks').params;
		expect(blocks[0].text).toBe('Verify the UI');
		expect(blocks.some((block: any) => block.text?.includes('Completed the file update'))).toBe(
			true
		);
		expect(blocks.filter((block: any) => block.type === 'resource_link')).toEqual([
			{
				type: 'resource_link',
				name: 'existing.txt',
				uri: new URL(`file://${workspace.path}/existing.txt`).href,
			},
		]);
		expect(
			(await connected.snapshot()).records.find((record) => record.event.kind === 'turn.started')
				?.event
		).toMatchObject({ text: 'Verify the UI', attachments: expect.any(Array) });
		await client.command({ kind: 'prompt', text: 'Next instruction' });
		await expect
			.poll(
				async () =>
					(await connected.snapshot()).records.filter(
						(record) => record.event.kind === 'turn.completed'
					).length
			)
			.toBe(2);
		expect((await wire()).filter((entry) => entry.event === 'prompt-blocks').at(-1).params).toEqual(
			[{ type: 'text', text: 'Next instruction' }]
		);
		expect(await readFile(join(await store.taskDir(source), 'events.jsonl'), 'utf8')).toBe(
			original
		);
		await host.stop();
		await preparations.remove(task);
	} finally {
		client?.close();
		await host?.stop();
		await rm(root, { recursive: true, force: true });
	}
}, 20000);
it('refreshes backlog context at startup and lets a failed summary leave the diff usable', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-relay-backlog-'));
	try {
		const repo = join(root, 'repo');
		await mkdir(repo);
		await gitText(repo, ['init', '-b', 'main']);
		const store = await SessionStore.at(join(root, 'data')),
			project = await store.addProject(repo),
			settings = new LaunchSettingsStore(store.root),
			source = await store.createTask(project.id, 'Source', 'claude');
		await store.setStatus(source, 'done');
		const writer = await store.writer(source);
		await writer.append({ kind: 'turn.started', text: 'Source' });
		await writer.append({ kind: 'turn.completed', reason: 'end_turn' });
		await writer.close();
		const snapshots = await Snapshots.open(store, source);
		await writeFile(join(repo, 'file.txt'), 'before');
		await snapshots.capture('baseline');
		let calls = 0;
		const relays = new Relays(store.root, settings, { range: () => undefined }, async () => {
			calls++;
			throw new Error('Fixture generation failed');
		});
		const draft = await relays.prepare(source);
		await expect(relays.summarize(draft.id)).rejects.toThrow('Fixture');
		const task = await relays.create(
			{
				draftId: draft.id,
				text: 'Continue later',
				provider: 'claude',
				transport: 'gui',
				backlog: true,
				launch: draft.launch,
				selection: { summary: true, diff: true, fullPatch: true },
			},
			'Task'
		);
		expect(await readRelayHandoff(store, task)).toBeNull();
		expect(calls).toBe(1);
		await writeFile(join(repo, 'file.txt'), 'later change');
		await snapshots.capture('turn');
		await relays.prepareBacklog(task);
		expect(calls).toBe(2);
		expect((await store.task(task)).relayIssue).toBe('summary-failed');
		const handoff = await readRelayHandoff(store, task);
		expect(handoff?.attachmentIds).toHaveLength(1);
		const [asset] = await new Attachments(store).resolve(task, handoff!.attachmentIds);
		expect(asset?.input).toMatchObject({
			kind: 'text',
			text: expect.stringContaining('+later change'),
		});
		await relays.prepareBacklog(task);
		expect(calls).toBe(2);
		expect((await readRelayDiff(store, source)).stat).toContain('file.txt');
		const missingDraft = await relays.prepare(source),
			orphan = await relays.create(
				{
					draftId: missingDraft.id,
					text: 'Continue after source deletion',
					provider: 'claude',
					transport: 'gui',
					backlog: true,
					launch: missingDraft.launch,
					selection: { summary: true, diff: true, fullPatch: false },
				},
				'Task'
			);
		await rm(await store.taskDir(source), { recursive: true, force: true });
		await relays.prepareBacklog(orphan);
		expect((await store.task(orphan)).relayIssue).toBe('source-unavailable');
		expect(await readRelayHandoff(store, orphan)).toMatchObject({
			sourceId: source.id,
			attachmentIds: [],
			files: [],
		});
		expect(calls).toBe(2);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
