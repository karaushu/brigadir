import { expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, chmod, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { Terminals, terminalTiming } from './terminals';
import { runState, type TerminalInfo, type TerminalEvent } from '@brigadir/core';
const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
async function setup() {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-run-'));
	const require = createRequire(import.meta.url);
	await chmod(
		join(
			dirname(require.resolve('node-pty/package.json')),
			'prebuilds',
			`${process.platform}-${process.arch}`,
			'spawn-helper'
		),
		0o755
	);
	vi.stubEnv('HOME', root);
	vi.stubEnv('ZDOTDIR', root);
	vi.stubEnv('SHELL', '/bin/zsh');
	// A server that prints its address after a colored prefix and ignores SIGINT only when told to.
	await writeFile(
		join(root, 'server.cjs'),
		"if(process.argv[2]==='stubborn')process.on('SIGINT',()=>{});process.stdout.write('\\x1b[32m  ➜\\x1b[0m  Local: \\x1b[36mhttp://localhost:\\x1b[1m5173\\x1b[22m/\\x1b[0m\\r\\n');process.stdout.write('cwd='+process.cwd()+'\\r\\n');setInterval(()=>{},1000);"
	);
	const events: TerminalEvent[] = [];
	const terminals = new Terminals(
		root,
		{ id: 'task', projectId: 'project', title: 'Run', status: 'done', provider: 'claude' },
		(event) => events.push(event)
	);
	return {
		root,
		events,
		terminals,
		server: (mode = '') =>
			`${quote(process.execPath)} ${quote(join(root, 'server.cjs'))} ${mode}`.trim(),
	};
}
const list = async (terminals: Terminals) =>
	(await terminals.command({ kind: 'list' })) as TerminalInfo[];

it('runs a command in its folder, finds the port, stops it and restarts it in the same place', async () => {
	const { root, events, terminals, server } = await setup();
	try {
		await mkdir(join(root, 'apps', 'admin'), { recursive: true });
		await terminals.command({ kind: 'create', role: 'console' });
		const first = (await terminals.command({
			kind: 'run',
			run: { commandId: 'admin', name: 'Admin dev', line: server(), directory: 'apps/admin' },
		})) as TerminalInfo;
		expect(first.title).toBe('Admin dev');
		expect(runState(first)).toBe('starting');
		// The unwatched tab still announces itself and its port: toolbar and search read no output.
		expect(events.some((event) => event.id === first.id && event.run)).toBe(true);
		await expect
			.poll(async () => (await list(terminals)).find((item) => item.id === first.id)?.run?.port)
			.toBe(5173);
		await expect
			.poll(() => terminals.command({ kind: 'text', id: first.id }))
			.toContain('/apps/admin\n');
		await terminals.command({ kind: 'stop', id: first.id });
		await expect
			.poll(async () => runState((await list(terminals)).find((item) => item.id === first.id)!))
			.toBe('stopped');
		const again = (await terminals.command({
			kind: 'run',
			run: { commandId: 'admin', name: 'Admin dev', line: server(), directory: 'apps/admin' },
		})) as TerminalInfo;
		const items = await list(terminals);
		expect(items.map((item) => item.id)).toEqual([items[0]!.id, again.id]);
		expect(items).toHaveLength(2);
		expect(again.id).not.toBe(first.id);
		await expect
			.poll(async () => (await list(terminals)).find((item) => item.id === again.id)?.run?.port)
			.toBe(5173);
	} finally {
		terminals.closeAll();
		vi.unstubAllEnvs();
		await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
}, 20000);

it('ends a process that ignores Ctrl-C with SIGTERM, and a failed command reports its exit code', async () => {
	const { root, terminals, server } = await setup();
	const saved = { ...terminalTiming };
	terminalTiming.stopTerm = 200;
	terminalTiming.stopKill = 2000;
	try {
		const stubborn = (await terminals.command({
			kind: 'run',
			run: { commandId: 'api', name: 'API', line: server('stubborn'), directory: '' },
		})) as TerminalInfo;
		await expect
			.poll(async () => (await list(terminals)).find((item) => item.id === stubborn.id)?.run?.port)
			.toBe(5173);
		await terminals.command({ kind: 'stop', id: stubborn.id });
		await expect
			.poll(async () => (await list(terminals)).find((item) => item.id === stubborn.id)?.exited, {
				timeout: 5000,
			})
			.toBe(true);
		expect(runState((await list(terminals)).find((item) => item.id === stubborn.id)!)).toBe(
			'stopped'
		);
		const failed = (await terminals.command({
			kind: 'run',
			run: { commandId: null, name: 'exit 3', line: 'echo broken; exit 3', directory: '' },
		})) as TerminalInfo;
		await expect
			.poll(async () => runState((await list(terminals)).find((item) => item.id === failed.id)!))
			.toBe('failed');
		expect((await list(terminals)).find((item) => item.id === failed.id)?.exitCode).toBe(3);
		const done = (await terminals.command({
			kind: 'run',
			run: { commandId: null, name: 'true', line: 'true', directory: '' },
		})) as TerminalInfo;
		await expect
			.poll(async () => runState((await list(terminals)).find((item) => item.id === done.id)!))
			.toBe('done');
		// «Run once» never replaces another tab.
		expect((await list(terminals)).filter((item) => item.run)).toHaveLength(3);
	} finally {
		Object.assign(terminalTiming, saved);
		terminals.closeAll();
		vi.unstubAllEnvs();
		await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
}, 20000);

it('rejects a run outside the task tree', async () => {
	const { root, terminals } = await setup();
	try {
		for (const directory of ['../escape', '/tmp', '.git', 'a/../b'])
			await expect(
				terminals.command({
					kind: 'run',
					run: { commandId: 'x', name: 'X', line: 'true', directory },
				})
			).rejects.toThrow('Invalid terminal command');
		await expect(
			terminals.command({
				kind: 'run',
				run: { commandId: 'x', name: 'X', line: 'true', directory: 'missing' },
			})
		).rejects.toThrow();
	} finally {
		terminals.closeAll();
		vi.unstubAllEnvs();
		await rm(root, { recursive: true, force: true });
	}
});

it('names a console session by its scope, and keeps the shell name without one (spec/terminal-and-cli-agents#console)', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-scope-name-'));
	await mkdir(join(root, 'kit'));
	vi.stubEnv('HOME', root);
	vi.stubEnv('ZDOTDIR', root);
	vi.stubEnv('SHELL', '/bin/zsh');
	const named = new Terminals(
		root,
		{ id: 'task', projectId: 'project', title: 'Scope', status: 'done' },
		() => {},
		() => {},
		undefined,
		undefined,
		(cwd) => (cwd === root ? 'choice' : cwd.endsWith('/kit') ? 'kit' : undefined)
	);
	const plain = new Terminals(
		root,
		{ id: 'task', projectId: 'project', title: 'Scope', status: 'done' },
		() => {}
	);
	try {
		expect(((await named.command({ kind: 'create', role: 'console' })) as TerminalInfo).title).toBe(
			'choice'
		);
		expect(
			((await named.command({ kind: 'create', role: 'console', directory: 'kit' })) as TerminalInfo)
				.title
		).toBe('kit');
		expect(((await plain.command({ kind: 'create', role: 'console' })) as TerminalInfo).title).toBe(
			'zsh'
		);
	} finally {
		named.closeAll();
		plain.closeAll();
		vi.unstubAllEnvs();
		await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
});

it('answers a background query with the window colors before the DA reply, as Claude Code expects', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-osc-'));
	const require = createRequire(import.meta.url);
	await chmod(
		join(
			dirname(require.resolve('node-pty/package.json')),
			'prebuilds',
			`${process.platform}-${process.arch}`,
			'spawn-helper'
		),
		0o755
	);
	vi.stubEnv('HOME', root);
	vi.stubEnv('ZDOTDIR', root);
	vi.stubEnv('SHELL', '/bin/zsh');
	// Claude Code's probe: OSC 11 then DA as the sentinel; the replies are printed back escaped.
	await writeFile(
		join(root, 'probe.cjs'),
		"process.stdin.setRawMode(true);let got='';process.stdin.on('data',d=>{got+=d;if(got.includes('c')&&got.includes('\\x1b[?')){process.stdout.write('REPLY '+JSON.stringify(got)+'\\r\\n');process.exit(0);}});process.stdout.write('\\x1b]11;?\\x07\\x1b[c');"
	);
	const terminals = new Terminals(
		root,
		{ id: 'task', projectId: 'project', title: 'Probe', status: 'done' },
		() => {},
		() => {},
		undefined,
		undefined,
		() => undefined,
		async () => ({ background: '#ffffff', foreground: '#262626' })
	);
	try {
		const run = (await terminals.command({
			kind: 'run',
			run: {
				commandId: 'probe',
				name: 'Probe',
				line: `${quote(process.execPath)} ${quote(join(root, 'probe.cjs'))}`,
				directory: '',
			},
		})) as TerminalInfo;
		await expect
			.poll(() => terminals.command({ kind: 'text', id: run.id }), { timeout: 5000 })
			.toContain('REPLY');
		const text = (await terminals.command({ kind: 'text', id: run.id })) as string;
		expect(text).toMatch(/REPLY "\\u001b\]11;rgb:ffff\/ffff\/ffff\\u001b\\\\\\u001b\[\?1;2c"/);
	} finally {
		terminals.closeAll();
		vi.unstubAllEnvs();
		await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
}, 20000);

it('lists the console sessions and gives their last lines as plain text, after the buffer freezes too (spec/terminal-and-cli-agents#agent-console-tools)', async () => {
	const { root, terminals } = await setup();
	const freeze = terminalTiming.freezeAfterExit;
	terminalTiming.freezeAfterExit = 50;
	try {
		const shell = (await terminals.command({ kind: 'create', role: 'console' })) as TerminalInfo;
		expect(terminals.consoles().map((item) => item.id)).toEqual([shell.id]);
		await terminals.command({
			kind: 'input',
			id: shell.id,
			data: "printf '\\033[31mFIRST\\033[0m\\nSECOND\\nTHIRD\\n'; exit 3\r",
		});
		await expect.poll(() => terminals.consoles()[0]?.exited, { timeout: 15000 }).toBe(true);
		const tail = await terminals.consoleOutput(shell.id, 2);
		expect(tail).toBe('SECOND\nTHIRD');
		expect(await terminals.consoleOutput(shell.id, 400)).toContain('FIRST\nSECOND');
		expect(await terminals.consoleOutput(shell.id, 400)).not.toContain('\x1b[');
		expect(terminals.consoles()[0]).toMatchObject({ exited: true, exitCode: 3 });
		// The frozen buffer keeps the tail of a plain console, not only of a command tab.
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(await terminals.consoleOutput(shell.id, 2)).toBe(tail);
	} finally {
		terminalTiming.freezeAfterExit = freeze;
		terminals.closeAll();
		vi.unstubAllEnvs();
		await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}
}, 30000);
