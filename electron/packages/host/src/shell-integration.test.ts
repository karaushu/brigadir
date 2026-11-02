import { expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import headless from '@xterm/headless';
import { TerminalBlocks } from './terminal-blocks';
import type { TerminalBlock } from '@brigadir/core';
// Perf review TUI-11: the zsh preexec marker as the host parses it (one base64 pipeline instead of two base64+tr).
it('marks a zsh command with one encoding pipeline that TerminalBlocks reads back', async () => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-preexec-'));
	const cwd = join(root, 'dir with ; and ünïcode');
	await mkdir(cwd);
	try {
		const command = "git log --format='%h;%s' | head -n 1 # ünïcode ;";
		const script = `source "$ZDOTDIR/.zshrc";cd ${JSON.stringify(cwd)};_brigadir_preexec "$1" >"$2"`;
		const assets = resolve('packages/host/resources/shell'),
			marker = join(root, 'marker');
		await promisify(execFile)('/bin/zsh', ['-f', '-c', script, 'zsh', command, marker], {
			env: {
				PATH: '/usr/bin:/bin',
				HOME: root,
				ZDOTDIR: assets,
				BRIGADIR_SHELL_HOME: root,
				BRIGADIR_SHELL_ASSETS: assets,
			},
		});
		const terminal = new headless.Terminal({ cols: 80, rows: 4, allowProposedApi: true });
		let block: TerminalBlock | undefined;
		new TerminalBlocks(terminal, root, (value) => {
			block = value;
		});
		const data = await readFile(marker, 'utf8');
		await new Promise<void>((done) => terminal.write(data, done));
		expect(block).toMatchObject({ command, cwd: 'dir with ; and ünïcode', exitCode: null });
		terminal.dispose();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
