import { expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createConnection } from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Attachments, SessionStore } from '@brigadir/persistence';
import { discoverScopes } from '@brigadir/git';
import { createRequire } from 'node:module';
import { startHost } from './server';
import { connectHost } from './client';
import { Peer } from './peer';
import { cliLaunch } from './cli-launch';
// Perf review TUI-06/MCP-10: what a CLI hook costs the agent. The relay runs as the CLI runs it: the command from cliLaunch through /bin/sh.
const session = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
it('answers tool and stop hooks without waiting for a capture, through the shipped relay', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-hook-relay-'));
	const repo = join(root, 'repo');
	await mkdir(join(repo, 'src'), { recursive: true });
	const git = promisify(execFile);
	await Promise.all(
		Array.from({ length: 1500 }, (_, i) =>
			writeFile(join(repo, 'src', `file-${i}.txt`), `line ${i}\n`)
		)
	);
	await git('git', ['init', '-q', repo]);
	await git('git', ['-C', repo, 'add', '.']);
	await git('git', [
		'-C',
		repo,
		'-c',
		'user.name=t',
		'-c',
		'user.email=t@t',
		'commit',
		'-qm',
		'base',
	]);
	const store = await SessionStore.at(join(root, 'data'));
	const project = await store.addProject(repo);
	const task = await store.createTask(
		project.id,
		'Hook relay',
		'claude',
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
	const services = resolve('apps/desktop/out/services');
	const config = {
		dataDir: store.root,
		key: task,
		mcpEntry: join(services, 'mcp-relay'),
		cli: {
			command: process.execPath,
			args: [resolve('packages/transport/fixtures/cli.mjs'), join(services, 'hook.zsh')],
		},
	};
	const host = await startHost(config);
	const client = await connectHost(host.identity);
	let hook: Peer | undefined;
	try {
		await expect
			.poll(
				async () =>
					(await client.snapshot()).records.filter((r) => r.event.kind === 'turn.completed').length,
				{ timeout: 10000 }
			)
			.toBe(1);
		hook = new Peer(createConnection(host.identity.socket));
		await hook.request('handshake', {
			protocolVersion: 1,
			instance: host.identity.instance,
			key: task,
			role: 'hook',
			token: host.identity.hookToken,
		});
		const timed = async (value: Record<string, unknown>) => {
			const start = performance.now();
			await hook!.request('cli_hook', { session_id: session, ...value });
			return performance.now() - start;
		};
		await timed({ hook_event_name: 'UserPromptSubmit', prompt: 'Second turn', turn_id: 'relay-2' });
		const records0 = (await client.snapshot()).records.filter(
			(r) => r.event.kind === 'checkpoint.created'
		).length;
		const posts: number[] = [];
		for (let i = 0; i < 5; i++) {
			await timed({
				hook_event_name: 'PreToolUse',
				tool_name: 'Edit',
				tool_use_id: `relay-tool-${i}`,
			});
			await writeFile(join(repo, 'src', `file-${i}.txt`), `edited ${i}\n`);
			posts.push(
				await timed({
					hook_event_name: 'PostToolUse',
					tool_name: 'Edit',
					tool_use_id: `relay-tool-${i}`,
				})
			);
		}
		// The fifth tool's capture follows its answer.
		const count = async () =>
			(await client.snapshot()).records.filter((r) => r.event.kind === 'checkpoint.created').length;
		const checkpoints = await count();
		await expect.poll(count).toBeGreaterThan(records0);
		await writeFile(join(repo, 'src', 'last.txt'), 'last\n');
		const stop = await timed({ hook_event_name: 'Stop' });
		await expect
			.poll(
				async () =>
					(await client.snapshot()).records.filter((r) => r.event.kind === 'turn.completed').length
			)
			.toBe(2);
		const records = (await client.snapshot()).records,
			kinds = records
				.slice(records.findLastIndex((r) => r.event.kind === 'turn.started'))
				.map((r) => r.event.kind);
		// The fifth tool's capture and the turn's closing capture both land, in order, before the turn completes.
		expect(kinds.filter((kind) => kind === 'checkpoint.created').length).toBeGreaterThanOrEqual(2);
		expect(kinds.at(-1)).toBe('turn.completed');
		expect(kinds.at(-2)).toBe('checkpoint.created');
		// The relay as the CLI launches it: zsh on macOS, the C relay elsewhere (spec/architecture-and-platform#linux-package); both are built on a Mac.
		for (const platform of ['darwin', 'linux'] as const) {
			const electron = createRequire(resolve('apps/desktop/package.json'))('electron') as string;
			const launch = await cliLaunch(
				store,
				{ ...task, transport: 'terminal' },
				host.identity,
				config.mcpEntry,
				electron,
				undefined,
				undefined,
				undefined,
				platform
			);
			const settings = JSON.parse(
				await (
					await import('node:fs/promises')
				).readFile(launch.args[launch.args.indexOf('--settings') + 1]!, 'utf8')
			) as { hooks: Record<string, [{ hooks: [{ command: string }] }]> };
			const command = settings.hooks.PreToolUse![0].hooks[0].command;
			expect(command).toContain(platform === 'darwin' ? 'hook.zsh' : "cli-relay' 'hook'");
			const relay = (input: string) =>
				new Promise<{ ms: number; code: number | null; stdout: string; stderr: string }>(
					(done, reject) => {
						const start = performance.now();
						const child = spawn('/bin/sh', ['-c', command], {
							env: { ...process.env, ...launch.env },
						});
						let stdout = '',
							stderr = '';
						child.stdout.on('data', (data) => (stdout += data));
						child.stderr.on('data', (data) => (stderr += data));
						child.on('error', reject);
						child.on('exit', (code) =>
							done({ ms: performance.now() - start, code, stdout, stderr })
						);
						child.stdin.end(input);
					}
				);
			expect(
				await relay(
					JSON.stringify({
						session_id: session,
						hook_event_name: 'PreToolUse',
						tool_name: 'Read',
						tool_use_id: 'relay-read',
					})
				)
			).toMatchObject({ code: 0, stdout: '' });
			expect(
				(
					await relay(
						JSON.stringify({
							session_id: session,
							hook_event_name: 'PreToolUse',
							tool_name: 'Read',
							tool_use_id: 'relay-large',
							tool_input: 'x'.repeat(1024 * 1024),
						})
					)
				).code
			).toBe(1);
			expect(
				await relay(JSON.stringify({ session_id: 'wrong-session', hook_event_name: 'Stop' }))
			).toMatchObject({
				code: 1,
				stdout: '',
				stderr: 'Brigadir could not record this CLI hook.\n',
			});
			// A large additionalContext comes back whole.
			const text = 'context '.repeat(30_000),
				asset = await new Attachments(store).create(task, {
					kind: 'text',
					name: 'Big context',
					text,
				});
			await client.command({ kind: 'attachContext', id: asset.id });
			const prompt = await relay(
				JSON.stringify(
					{
						session_id: session,
						hook_event_name: 'UserPromptSubmit',
						prompt: 'Third turn\nwith a second line',
						turn_id: `relay-3-${platform}`,
					},
					null,
					2
				)
			);
			expect(prompt.code).toBe(0);
			expect(JSON.parse(prompt.stdout).hookSpecificOutput.additionalContext).toContain(text);
			expect(
				(
					await relay(
						JSON.stringify({
							session_id: session,
							hook_event_name: 'Notification',
							message: 'ignored',
						})
					)
				).code
			).toBe(0);
		}
	} finally {
		hook?.close();
		client.close();
		await host.stop();
		await rm(root, { recursive: true, force: true });
	}
}, 60000);
