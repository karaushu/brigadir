// spec/chat-turns-plans-and-questions#background-commands: background commands from the raw SDK `task_*` messages, on the wire of a live run (fixtures/claude-background.jsonl),
// and Stop on a real process in its own group (`background-live`).
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentEvent } from '@brigadir/core';
import { AgentTransport } from './transport';
import { backgroundProcesses, procTable, psTable } from './background-stop';
let directory: string;
let events: AgentEvent[];
const transports: AgentTransport[] = [];
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'brigadir-background-'));
	events = [];
});
afterEach(async () => {
	for (const transport of transports.splice(0)) {
		transport.close();
		await transport.closed;
	}
	await rm(directory, { recursive: true, force: true });
});
const fixture = fileURLToPath(new URL('../fixtures/agent.mjs', import.meta.url));
async function start(scenario: string) {
	const transport = await AgentTransport.start({
		provider: 'claude',
		cwd: directory,
		startupTimeoutMs: 3000,
		adapter: {
			command: process.execPath,
			args: [fixture, scenario, join(directory, 'wire.jsonl')],
		},
		onEvent: (event) => {
			events.push(event);
		},
	});
	transports.push(transport);
	return transport;
}
const background = () =>
	events.filter(
		(event) => event.kind === 'background.started' || event.kind === 'background.changed'
	);

it('asks the adapter for the raw task messages', async () => {
	await start('background-done');
	const wire = (await readFile(join(directory, 'wire.jsonl'), 'utf8'))
		.trim()
		.split('\n')
		.map((line) => JSON.parse(line) as { event: string; params: Record<string, unknown> });
	const raw = JSON.stringify(wire.find((line) => line.event === 'new')?.params);
	for (const subtype of ['task_started', 'task_updated', 'task_notification'])
		expect(raw).toContain(`{"type":"system","subtype":"${subtype}"}`);
	// Not an AIR client (spec/chat-turns-plans-and-questions#background-commands, Rejected): the capability would change the adapter's other updates.
	expect(JSON.stringify(wire.find((line) => line.event === 'initialize')?.params)).not.toContain(
		'jetbrains'
	);
});
it('announces a backgrounded Bash inside the turn, with its call and name, then its output file and its end after the turn', async () => {
	const transport = await start('background-done');
	await transport.send({ kind: 'prompt', text: 'run it' });
	const started = events.findIndex((event) => event.kind === 'background.started');
	expect(events[started]).toEqual({
		kind: 'background.started',
		id: 'b01ijw66c',
		toolId: 'toolu_01AHRZDYSmN3uaQ37bokjoEw',
		name: 'Print six ticks three seconds apart, then finished',
	});
	expect(started).toBeLessThan(events.findIndex((event) => event.kind === 'turn.completed'));
	expect(events.find((event) => event.kind === 'background.changed' && event.outputPath)).toEqual({
		kind: 'background.changed',
		id: 'b01ijw66c',
		outputPath: '/tmp/brigadir-fixture/fixture-session/tasks/b01ijw66c.output',
	});
	await vi.waitFor(() =>
		expect(background().at(-1)).toEqual({
			kind: 'background.changed',
			id: 'b01ijw66c',
			state: 'completed',
		})
	);
	expect(
		background().filter((event) => event.kind === 'background.changed' && event.state)
	).toHaveLength(1);
});
it('ends a command that exits non-zero as failed', async () => {
	const transport = await start('background-fail');
	await transport.send({ kind: 'prompt', text: 'run it' });
	await vi.waitFor(() =>
		expect(background().at(-1)).toEqual({
			kind: 'background.changed',
			id: 'b7tcibyc6',
			state: 'failed',
		})
	);
});
it('stops the command: SIGTERM to its process group under this adapter, journaled once as stopped by the person', async () => {
	const transport = await start('background-live');
	await transport.send({ kind: 'prompt', text: 'run it' });
	await vi.waitFor(() =>
		expect(events.some((event) => event.kind === 'background.changed' && event.outputPath)).toBe(
			true
		)
	);
	const path = join(directory, 'tasks', 'blive.output');
	await vi.waitFor(async () => expect(await readFile(path, 'utf8')).toContain('begin'));
	await transport.send({ kind: 'stopBackground', id: 'blive' });
	expect(background().at(-1)).toEqual({
		kind: 'background.changed',
		id: 'blive',
		state: 'stopped',
		reason: 'person',
	});
	// The agent then reports the killed shell as failed; that is not a second end.
	await new Promise((resolve) => setTimeout(resolve, 300));
	expect(
		background().filter((event) => event.kind === 'background.changed' && event.state)
	).toHaveLength(1);
	await expect(transport.send({ kind: 'stopBackground', id: 'blive' })).rejects.toThrow(
		'not running'
	);
});
it('never signals a process outside the adapter', async () => {
	const exec = async (command: string, args: string[]) =>
		command === 'lsof'
			? '4242\n'
			: args[1] === 'ppid='
				? args[3] === '4242'
					? '77\n'
					: '1\n'
				: '4242\n';
	expect(await backgroundProcesses('/tmp/x/tasks/a.output', 9999, exec, psTable(exec))).toEqual([]);
	expect(await backgroundProcesses('/tmp/x/tasks/a.output', 77, exec, psTable(exec))).toEqual([
		{ pid: 4242, group: true },
	]);
});
it('finds the writers and their ancestry in /proc on Linux, without lsof (spec/architecture-and-platform#linux-package)', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-proc-'));
	try {
		const output = join(root, 'a.output');
		await writeFile(output, '');
		// /proc shows the canonical path; macOS's tmpdir is a symlink.
		const real = await realpath(output);
		// pid 4242 (the shell, leads its group) and 4300 (in that group) hold the file; 4242's parent is the adapter 77.
		const processes: [number, number, number, string[]][] = [
			[4242, 77, 4242, [real, '/dev/null']],
			[4300, 4242, 4242, [real]],
			[5000, 1, 5000, [real]],
			[77, 1, 77, ['/dev/null']],
		];
		for (const [pid, ppid, pgrp, files] of processes) {
			await mkdir(join(root, 'proc', String(pid), 'fd'), { recursive: true });
			await writeFile(
				join(root, 'proc', String(pid), 'stat'),
				`${pid} (a (b) c) S ${ppid} ${pgrp} ${pgrp} 0 -1\n`
			);
			for (const [fd, file] of files.entries())
				await symlink(file, join(root, 'proc', String(pid), 'fd', String(fd)));
		}
		await mkdir(join(root, 'proc', 'self'));
		const table = procTable(join(root, 'proc'));
		expect((await table.writers(output)).sort()).toEqual([4242, 4300, 5000]);
		expect(await backgroundProcesses(output, 77, async () => '', table)).toEqual([
			{ pid: 4242, group: true },
			{ pid: 4300, group: false },
		]);
		expect(await backgroundProcesses(output, 9999, async () => '', table)).toEqual([]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
