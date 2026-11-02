import { expect, it } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Terminals, terminalTiming } from './terminals';
import type { TerminalEvent, TerminalInfo, TerminalSnapshot } from '@brigadir/core';
// Perf review TUI-02/08/09: what crosses to the UI and what a reattach costs, over the real class and a real PTY.
const tui =
	"process.stdin.setEncoding('utf8');process.stdout.write('ready\\r\\n');const line=n=>'\\x1b[32m'+String(n).padStart(6,'0')+'\\x1b[0m '+'x'.repeat(100)+'\\r\\n';process.stdin.on('data',data=>{const n=Number(data.trim().split(' ')[1]);let out='';for(let i=0;i<n;i++)out+=line(i);process.stdout.write(out+'DONE-'+n+'\\r\\n');});setInterval(()=>{},1000);";
async function agent(events: TerminalEvent[]) {
	// Published node-pty archives may omit spawn-helper's executable bit.
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
	const root = await mkdtemp(join(tmpdir(), 'brigadir-pty-output-'));
	const fixture = join(root, 'tui.cjs');
	await writeFile(fixture, tui);
	const terminals = new Terminals(
		root,
		{
			id: 'task',
			projectId: 'project',
			title: 'Output',
			status: 'done',
			provider: 'claude',
			transport: 'terminal',
		},
		(event) => events.push(event),
		() => {},
		{ command: process.execPath, args: [fixture] }
	);
	const info = (await terminals.command({ kind: 'create', role: 'agent' })) as TerminalInfo;
	const read = async () =>
		(await terminals.command({ kind: 'read', id: info.id })) as TerminalSnapshot;
	// `text` reads the screen without subscribing.
	const print = async (lines: number) => {
		await terminals.command({ kind: 'input', id: info.id, data: `print ${lines}\r` });
		await expect
			.poll(() => terminals.command({ kind: 'text', id: info.id }), { timeout: 15000 })
			.toContain(`DONE-${lines}`);
	};
	return {
		root,
		terminals,
		info,
		read,
		print,
		async close() {
			terminals.closeAll();
			await rm(root, { recursive: true, force: true });
		},
	};
}
it('sends PTY output only for a terminal the UI has read, and exits regardless', async () => {
	const events: TerminalEvent[] = [];
	const pty = await agent(events);
	try {
		// 5 MB of colored lines that nobody shows.
		await pty.print(45000);
		const unwatched = events.filter((event) => event.data);
		events.length = 0;
		expect(unwatched).toEqual([]);
		const snapshot = await pty.read();
		await pty.print(10);
		expect(
			events
				.filter((event) => event.seq > snapshot.seq)
				.map((event) => event.data)
				.join('')
		).toContain('DONE-10');
		await pty.terminals.command({ kind: 'unwatch', id: pty.info.id });
		events.length = 0;
		await pty.print(20);
		expect(events.filter((event) => event.data)).toEqual([]);
		await pty.terminals.command({ kind: 'input', id: pty.info.id, data: '\x03' });
		await expect.poll(() => events.some((event) => event.exited), { timeout: 5000 }).toBe(true);
	} finally {
		await pty.close();
	}
}, 40000);

it('attaches turn anchors to agent output only when they change', async () => {
	const events: TerminalEvent[] = [];
	const pty = await agent(events);
	try {
		await expect.poll(async () => (await pty.read()).data).toContain('ready');
		for (let turn = 1; turn <= 100; turn++)
			await pty.terminals
				.command({ kind: 'input', id: pty.info.id, data: '\r' })
				.then(() => pty.terminals.markTurn(turn));
		await pty.read();
		events.length = 0;
		await pty.print(2000);
		const withAnchors = events.filter((event) => event.anchors);
		expect(withAnchors.length).toBeLessThanOrEqual(1);
		// Scrollback trims move and then drop the anchors: the UI hears each change, the last one equals a fresh read.
		events.length = 0;
		await pty.print(4000);
		expect(events.filter((event) => event.anchors).at(-1)?.anchors).toEqual(
			(await pty.read()).anchors
		);
		expect(events.filter((event) => event.anchors).at(-1)?.anchors?.length).toBeLessThan(100);
	} finally {
		await pty.close();
	}
}, 40000);

it('serializes an unchanged buffer once across reattaches', async () => {
	const events: TerminalEvent[] = [];
	const pty = await agent(events);
	try {
		await pty.print(45000);
		const time = async () => {
			const start = performance.now();
			const snapshot = await pty.read();
			return { ms: performance.now() - start, snapshot };
		};
		const first = await time(),
			second = await time();
		expect(second.snapshot.data).toBe(first.snapshot.data);
		expect(second.ms).toBeLessThan(5);
		await pty.print(1);
		expect((await pty.read()).data).not.toBe(first.snapshot.data);
		await pty.terminals.command({ kind: 'resize', id: pty.info.id, cols: 80, rows: 24 });
		const resized = await pty.read();
		expect(resized.cols).toBe(80);
		expect(resized.data).not.toBe(first.snapshot.data);
	} finally {
		await pty.close();
	}
}, 40000);

it('keeps an exited terminal as its serialized buffer', async () => {
	const events: TerminalEvent[] = [];
	const pty = await agent(events);
	const freeze = terminalTiming.freezeAfterExit;
	terminalTiming.freezeAfterExit = 50;
	try {
		await pty.print(45000);
		await pty.terminals.command({ kind: 'input', id: pty.info.id, data: '\x03' });
		await expect.poll(async () => (await pty.read()).exited, { timeout: 5000 }).toBe(true);
		const before = await pty.read(),
			screen = await pty.terminals.command({ kind: 'text', id: pty.info.id });
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect((await pty.read()).data).toBe(before.data);
		expect(await pty.terminals.command({ kind: 'text', id: pty.info.id })).toBe(screen);
		await pty.terminals.command({ kind: 'clear', id: pty.info.id });
		expect((await pty.read()).data).toBe('');
		await expect(
			pty.terminals.command({ kind: 'resize', id: pty.info.id, cols: 80, rows: 24 })
		).rejects.toThrow('exited');
	} finally {
		terminalTiming.freezeAfterExit = freeze;
		await pty.close();
	}
}, 40000);
