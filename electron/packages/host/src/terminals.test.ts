import { expect, it, vi } from 'vitest';
import { mkdtemp, rm, chmod, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { Terminals } from './terminals';
import type { TerminalInfo, TerminalSnapshot, TerminalEvent } from '@brigadir/core';
it.each(['/bin/zsh', '/bin/bash'])(
	'runs a real %s PTY, restores command output and terminates console processes',
	async (shell) => {
		// Published node-pty archives may omit spawn-helper's executable bit.
		const root = await mkdtemp(join(tmpdir(), 'brigadir-pty-'));
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
		vi.stubEnv('SHELL', shell);
		await writeFile(join(root, '.zshrc'), 'export BRIGADIR_PROFILE_LOADED=yes\n');
		await writeFile(
			join(root, '.bashrc'),
			'export BRIGADIR_PROFILE_LOADED=yes\nPROMPT_COMMAND="printf prompt-hook"\n'
		);
		const events: TerminalEvent[] = [];
		const terminals = new Terminals(
			root,
			{ id: 'task', projectId: 'project', title: 'PTY', status: 'done', provider: 'claude' },
			(event) => events.push(event)
		);
		try {
			const info = (await terminals.command({ kind: 'create', role: 'console' })) as TerminalInfo;
			await terminals.command({
				kind: 'input',
				id: info.id,
				data: "printf '\\033[31mPTY_OK\\033[0m\\n'\r",
			});
			await expect.poll(() => terminals.command({ kind: 'text', id: info.id })).toContain('PTY_OK');
			await expect
				.poll(
					async () =>
						((await terminals.command({ kind: 'read', id: info.id })) as TerminalSnapshot).block
							?.exitCode
				)
				.toBe(0);
			await terminals.command({
				kind: 'input',
				id: info.id,
				data: 'printf \'FAIL_%s\\n\' "$BRIGADIR_PROFILE_LOADED"; (exit 7)\r',
			});
			await expect
				.poll(
					async () =>
						((await terminals.command({ kind: 'read', id: info.id })) as TerminalSnapshot).block
							?.exitCode
				)
				.toBe(7);
			const block = ((await terminals.command({ kind: 'read', id: info.id })) as TerminalSnapshot)
				.block!;
			expect(block.output).toBe('FAIL_yes');
			expect(block.cwd).toBe('.');
			expect(block.command).toContain('(exit 7)');
			expect(block.duration).toBeGreaterThanOrEqual(0);
			expect(await terminals.command({ kind: 'text', id: info.id })).not.toContain('PTY_OK');
			if (shell.endsWith('zsh')) {
				await terminals.command({
					kind: 'input',
					id: info.id,
					data: 'printf \'HISTORY_LOCATION=%s\\n\' "$HISTFILE"\r',
				});
				await expect
					.poll(() => terminals.command({ kind: 'text', id: info.id }))
					.toContain(`HISTORY_LOCATION=${root}/.zsh_history`);
			}
			const snapshot = (await terminals.command({ kind: 'read', id: info.id })) as TerminalSnapshot;
			expect(snapshot.data).toContain('PTY_OK');
			expect(snapshot.seq).toBeGreaterThan(0);
			await terminals.command({ kind: 'resize', id: info.id, cols: 80, rows: 20 });
			expect(
				((await terminals.command({ kind: 'read', id: info.id })) as TerminalSnapshot).cols
			).toBe(80);
			await expect(terminals.command({ kind: 'create', role: 'agent' })).rejects.toThrow('GUI');
			await terminals.command({ kind: 'close-consoles' });
			expect(await terminals.command({ kind: 'list' })).toEqual([]);
		} finally {
			terminals.closeAll();
			vi.unstubAllEnvs();
			await rm(root, { recursive: true, force: true });
		}
	}
);

it('retains real normal-buffer turn markers and does not invent alternate-screen anchors', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-anchors-'));
	const fixture = join(root, 'tui.cjs');
	await writeFile(
		fixture,
		"process.stdin.setEncoding('utf8');process.stdout.write('ready\\r\\n');process.stdin.on('data',data=>{if(data.includes('alt'))process.stdout.write('\\x1b[?1049hALT');else if(data.includes('normal'))process.stdout.write('\\x1b[?1049lNORMAL\\r\\n');else if(data.includes('many'))process.stdout.write('line\\r\\n'.repeat(5100));});"
	);
	const terminals = new Terminals(
		root,
		{
			id: 'task',
			projectId: 'project',
			title: 'Anchors',
			status: 'done',
			provider: 'claude',
			transport: 'terminal',
		},
		() => {},
		() => {},
		{ command: process.execPath, args: [fixture] }
	);
	try {
		const info = (await terminals.command({ kind: 'create', role: 'agent' })) as TerminalInfo;
		const read = async () =>
			(await terminals.command({ kind: 'read', id: info.id })) as TerminalSnapshot;
		await expect.poll(async () => (await read()).data).toContain('ready');
		await terminals.markTurn(10);
		expect((await read()).anchors?.map((anchor) => anchor.turn)).toEqual([10]);
		await terminals.command({ kind: 'input', id: info.id, data: 'alt\r' });
		await expect.poll(async () => (await read()).normal).toBe(false);
		await terminals.markTurn(20);
		expect((await read()).anchors?.some((anchor) => anchor.turn === 20)).toBe(false);
		await terminals.command({ kind: 'input', id: info.id, data: 'normal\r' });
		await expect.poll(async () => (await read()).normal).toBe(true);
		expect((await read()).anchors?.map((anchor) => anchor.turn)).toEqual([10]);
		await terminals.markTurn(30);
		expect((await read()).anchors?.map((anchor) => anchor.turn)).toEqual([10, 30]);
		await terminals.command({ kind: 'input', id: info.id, data: 'many\r' });
		await expect.poll(async () => (await read()).anchors?.length).toBe(0);
	} finally {
		terminals.closeAll();
		await rm(root, { recursive: true, force: true });
	}
}, 15000);

it('rejects unsafe console cwd and never starts a pending create after shutdown', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-pty-cwd-'));
	const terminals = new Terminals(
		root,
		{ id: 'task', projectId: 'project', title: 'PTY', status: 'done' },
		() => {}
	);
	try {
		for (const directory of ['../escape', '/tmp', '.git', 'nested/../escape'])
			await expect(
				terminals.command({ kind: 'create', role: 'console', directory })
			).rejects.toThrow('Invalid terminal command');
		const pending = terminals.command({ kind: 'create', role: 'console', directory: '' });
		terminals.closeAll();
		await expect(pending).rejects.toThrow('Terminals are closed');
		expect(await terminals.command({ kind: 'list' })).toEqual([]);
	} finally {
		terminals.closeAll();
		await rm(root, { recursive: true, force: true });
	}
});

it.each(['console', 'agent'] as const)(
	'gives %s its own color-capable PTY despite launcher color flags',
	async (role) => {
		const root = await mkdtemp(join(tmpdir(), 'brigadir-pty-color-')),
			fixture = join(root, 'colors.cjs');
		await writeFile(
			fixture,
			`const colors=process.stdout.hasColors(256),truecolor=process.stdout.hasColors(16777216);
process.stdout.write(colors?'\\x1b[31mANSI_COLOR\\x1b[0m\\r\\n':'NO_ANSI\\r\\n');
process.stdout.write(truecolor?'\\x1b[38;2;40;160;220mTRUE_COLOR\\x1b[0m\\r\\n':'NO_TRUECOLOR\\r\\n');
setInterval(()=>{},1000);`
		);
		vi.stubEnv('NO_COLOR', '1');
		vi.stubEnv('FORCE_COLOR', '0');
		vi.stubEnv('TERM', 'dumb');
		vi.stubEnv('SHELL', '/bin/zsh');
		vi.stubEnv('ZDOTDIR', root);
		const events: TerminalEvent[] = [],
			terminals = new Terminals(
				root,
				{
					id: 'task',
					projectId: 'project',
					title: 'Colors',
					status: 'done',
					provider: 'claude',
					transport: 'terminal',
				},
				(event) => events.push(event),
				() => {},
				{ command: process.execPath, args: [fixture] }
			);
		try {
			// Output reaches the UI once it reads the terminal (TUI-02).
			const info = (await terminals.command({ kind: 'create', role })) as TerminalInfo;
			await terminals.command({ kind: 'read', id: info.id });
			if (role === 'console') {
				const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
				await terminals.command({
					kind: 'input',
					id: info.id,
					data: `${quote(process.execPath)} ${quote(fixture)}\r`,
				});
			}
			await expect
				.poll(() => events.map((event) => event.data).join(''))
				.toContain('\x1b[31mANSI_COLOR\x1b[0m');
			await expect
				.poll(() => events.map((event) => event.data).join(''))
				.toContain('\x1b[38;2;40;160;220mTRUE_COLOR\x1b[0m');
			const snapshot = (await terminals.command({ kind: 'read', id: info.id })) as TerminalSnapshot;
			expect(snapshot.data).toContain('\x1b[31mANSI_COLOR');
			expect(snapshot.data).toMatch(/\x1b\[[\d;]*38;2;40;160;220mTRUE_COLOR/);
			// The login shell may finish writing history after the PTY receives SIGHUP.
		} finally {
			terminals.closeAll();
			vi.unstubAllEnvs();
			await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
		}
	}
);
it('tells a shell at its prompt from one running a command (spec/task-window-workspace#terminal-close)', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-pty-busy-'));
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
	const terminals = new Terminals(
		root,
		{ id: 'task', projectId: 'project', title: 'PTY', status: 'done', provider: 'claude' },
		() => {}
	);
	const busy = async (id: string) =>
		((await terminals.command({ kind: 'list' })) as TerminalInfo[]).find((item) => item.id === id)
			?.busy;
	try {
		const info = (await terminals.command({ kind: 'create', role: 'console' })) as TerminalInfo;
		await terminals.command({ kind: 'input', id: info.id, data: 'echo READY\r' });
		await expect.poll(() => terminals.command({ kind: 'text', id: info.id })).toContain('READY');
		await expect.poll(() => busy(info.id)).toBe(false);
		await terminals.command({ kind: 'input', id: info.id, data: 'sleep 30\r' });
		await expect.poll(() => busy(info.id)).toBe(true);
		await terminals.command({ kind: 'input', id: info.id, data: '\x03' });
		await expect.poll(() => busy(info.id)).toBe(false);
	} finally {
		await terminals.closeAll();
		vi.unstubAllEnvs();
		await rm(root, { recursive: true, force: true });
	}
});
