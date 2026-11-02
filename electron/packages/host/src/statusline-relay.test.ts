import { expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SessionStore } from '@brigadir/persistence';
import { discoverScopes } from '@brigadir/git';
import { statuslineReadings } from '@brigadir/transport';
import { startHost } from './server';
import { connectHost } from './client';
import { cliLaunch, userStatusLine } from './cli-launch';
// spec/agents-and-providers#quota-sources: in terminal mode the documented statusline `rate_limits` is the only quota source.
it('reads statusline windows by name and drops what is not a percentage', () => {
	expect(
		statuslineReadings({
			rate_limits: {
				five_hour: { used_percentage: 62, resets_at: 1790252400 },
				seven_day: { used_percentage: 26.4, resets_at: 1790690400 },
				other: { used_percentage: 5 },
			},
		})
	).toEqual([
		{
			id: 'five_hour',
			kind: 'five-hour',
			model: null,
			minutes: 300,
			remaining: 0.38,
			resetsAt: 1790252400,
			exhausted: false,
		},
		{
			id: 'seven_day',
			kind: 'weekly',
			model: null,
			minutes: 10080,
			remaining: expect.closeTo(0.736, 5),
			resetsAt: 1790690400,
			exhausted: false,
		},
	]);
	expect(statuslineReadings({ rate_limits: { five_hour: { used_percentage: '62' } } })).toEqual([]);
	expect(statuslineReadings({ model: {} })).toEqual([]);
});
it('finds the person’s statusline in Claude Code’s order and reads nothing else', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-statusline-')),
		cwd = join(root, 'repo'),
		home = join(root, 'home');
	try {
		await mkdir(join(cwd, '.claude'), { recursive: true });
		await mkdir(home, { recursive: true });
		expect(await userStatusLine(cwd, home)).toBeNull();
		await writeFile(
			join(home, 'settings.json'),
			JSON.stringify({
				statusLine: { type: 'command', command: 'echo user', padding: 0 },
				apiKeyHelper: 'secret',
			})
		);
		expect(await userStatusLine(cwd, home)).toEqual({ command: 'echo user', padding: 0 });
		await writeFile(
			join(cwd, '.claude', 'settings.json'),
			JSON.stringify({ statusLine: { type: 'command', command: 'echo project' } })
		);
		expect(await userStatusLine(cwd, home)).toEqual({ command: 'echo project' });
		await writeFile(join(cwd, '.claude', 'settings.local.json'), '{broken');
		expect(await userStatusLine(cwd, home)).toEqual({ command: 'echo project' });
		await writeFile(
			join(cwd, '.claude', 'settings.local.json'),
			JSON.stringify({ statusLine: { type: 'static' } })
		);
		expect(await userStatusLine(cwd, home)).toBeNull();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
it('prints the person’s statusline unchanged and journals each rate_limits change once', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-statusline-relay-'));
	const repo = join(root, 'repo');
	await mkdir(repo, { recursive: true });
	const git = promisify(execFile);
	await writeFile(join(repo, 'a.txt'), 'a\n');
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
	await mkdir(join(repo, '.claude'), { recursive: true });
	await writeFile(
		join(repo, '.claude', 'settings.local.json'),
		JSON.stringify({
			statusLine: {
				type: 'command',
				command: 'cat >/dev/null; printf "mine %s" "$BRIGADIR_TASK_ID"',
				padding: 1,
			},
		})
	);
	const store = await SessionStore.at(join(root, 'data'));
	const project = await store.addProject(repo);
	const task = await store.createTask(
		project.id,
		'Statusline relay',
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
	try {
		await expect
			.poll(
				async () =>
					(await client.snapshot()).records.filter((r) => r.event.kind === 'turn.completed').length,
				{ timeout: 10000 }
			)
			.toBe(1);
		// No statusline of the person's own (an empty home): nothing is added to the TUI.
		const saved = process.env.CLAUDE_CONFIG_DIR;
		process.env.CLAUDE_CONFIG_DIR = join(root, 'empty-home');
		const bare = await cliLaunch(
			store,
			{ ...task, transport: 'terminal' },
			host.identity,
			config.mcpEntry,
			process.execPath,
			undefined,
			undefined,
			join(root, 'elsewhere')
		).finally(() => {
			if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
			else process.env.CLAUDE_CONFIG_DIR = saved;
		});
		expect(
			Object.keys(
				JSON.parse(await readFile(bare.args[bare.args.indexOf('--settings') + 1]!, 'utf8'))
			)
		).toEqual(['hooks']);
		expect(bare.env.BRIGADIR_USER_STATUSLINE).toBeUndefined();
		// The statusline relay as the CLI runs it: zsh on macOS, the C relay elsewhere (spec/architecture-and-platform#linux-package).
		for (const platform of ['darwin', 'linux'] as const) {
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
it('prints the person’s statusline unchanged and journals each rate_limits change once', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-statusline-relay-'));
	const repo = join(root, 'repo');
	await mkdir(repo, { recursive: true });
	const git = promisify(execFile);
	await writeFile(join(repo, 'a.txt'), 'a\n');
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
	await mkdir(join(repo, '.claude'), { recursive: true });
	await writeFile(
		join(repo, '.claude', 'settings.local.json'),
		JSON.stringify({
			statusLine: {
				type: 'command',
				command: 'cat >/dev/null; printf "mine %s" "$BRIGADIR_TASK_ID"',
				padding: 1,
			},
		})
	);
	const store = await SessionStore.at(join(root, 'data'));
	const project = await store.addProject(repo);
	const task = await store.createTask(
		project.id,
		'Statusline relay',
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
	try {
		await expect
			.poll(
				async () =>
					(await client.snapshot()).records.filter((r) => r.event.kind === 'turn.completed').length,
				{ timeout: 10000 }
			)
			.toBe(1);
		// No statusline of the person's own (an empty home): nothing is added to the TUI.
		const saved = process.env.CLAUDE_CONFIG_DIR;
		process.env.CLAUDE_CONFIG_DIR = join(root, 'empty-home');
		const bare = await cliLaunch(
			store,
			{ ...task, transport: 'terminal' },
			host.identity,
			config.mcpEntry,
			process.execPath,
			undefined,
			undefined,
			join(root, 'elsewhere')
		).finally(() => {
			if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
			else process.env.CLAUDE_CONFIG_DIR = saved;
		});
		expect(
			Object.keys(
				JSON.parse(await readFile(bare.args[bare.args.indexOf('--settings') + 1]!, 'utf8'))
			)
		).toEqual(['hooks']);
		expect(bare.env.BRIGADIR_USER_STATUSLINE).toBeUndefined();
		const launch = await cliLaunch(
			store,
			{ ...task, transport: 'terminal' },
			host.identity,
			config.mcpEntry,
			process.execPath,
			undefined,
			undefined,
			repo
		);
		const settings = JSON.parse(
			await readFile(launch.args[launch.args.indexOf('--settings') + 1]!, 'utf8')
		) as { statusLine: { type: string; command: string; padding?: number } };
		expect(settings.statusLine).toMatchObject({ type: 'command', padding: 1 });
		expect(settings.statusLine.command).toContain('statusline.zsh');
		const mcp = JSON.parse(
			await readFile(launch.args[launch.args.indexOf('--mcp-config') + 1]!, 'utf8')
		);
		expect(JSON.stringify(mcp)).not.toContain('BRIGADIR_USER_STATUSLINE');
		const run = (input: string) =>
			new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
				const child = spawn('/bin/sh', ['-c', settings.statusLine.command], {
					env: { ...process.env, ...launch.env },
				});
				let stdout = '',
					stderr = '';
				child.stdout.on('data', (data) => (stdout += data));
				child.stderr.on('data', (data) => (stderr += data));
				child.once('error', reject);
				child.once('close', (code) => done({ code, stdout, stderr }));
				child.stdin.end(input);
			});
		const status = (used: number) =>
			JSON.stringify({
				model: { display_name: 'Opus' },
				rate_limits: {
					five_hour: { used_percentage: used, resets_at: 1790252400 },
					seven_day: { used_percentage: 26, resets_at: 1790690400 },
				},
			});
		const quota = async () =>
			(await client.snapshot()).records.filter((r) => r.event.kind === 'quota.observed');
		expect(await run(status(62))).toEqual({ code: 0, stdout: `mine ${task.id}`, stderr: '' });
		await expect.poll(async () => (await quota()).length).toBe(1);
		expect((await quota())[0]!.event).toMatchObject({
			kind: 'quota.observed',
			provider: 'claude',
			complete: false,
			windows: [
				{ id: 'five_hour', remaining: 0.38 },
				{ id: 'seven_day', remaining: 0.74 },
			],
		});
		await run(status(62));
		await run(status(63));
		await expect.poll(async () => (await quota()).length).toBe(2);
		// No rate limits yet (before the first answer), a broken host socket: the person's line still prints, no error.
		expect(await run(JSON.stringify({ model: { display_name: 'Opus' } }))).toEqual({
			code: 0,
			stdout: `mine ${task.id}`,
			stderr: '',
		});
		expect(
			await new Promise((done) => {
				const child = spawn('/bin/sh', ['-c', settings.statusLine.command], {
					env: { ...process.env, ...launch.env, BRIGADIR_HOST_SOCKET: join(root, 'missing.sock') },
				});
				let stdout = '';
				child.stdout.on('data', (data) => (stdout += data));
				child.once('close', (code) => done({ code, stdout }));
				child.stdin.end(status(70));
			})
		).toEqual({ code: 0, stdout: `mine ${task.id}` });
	} finally {
		client.close();
		await host.stop();
		await rm(root, { recursive: true, force: true });
	}
}, 60000);
