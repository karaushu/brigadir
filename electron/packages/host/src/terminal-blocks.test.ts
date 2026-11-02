import { expect, it } from 'vitest';
import headless from '@xterm/headless';
import { TerminalBlocks } from './terminal-blocks';
import type { TerminalBlock } from '@brigadir/core';
it('extracts only a completed command, joins wraps and rejects malformed status markers', async () => {
	const terminal = new headless.Terminal({
		cols: 12,
		rows: 4,
		scrollback: 20,
		allowProposedApi: true,
	});
	let block: TerminalBlock | undefined;
	new TerminalBlocks(terminal, '/repo', (value) => {
		block = value;
	});
	const write = (text: string) => new Promise<void>((resolve) => terminal.write(text, resolve));
	try {
		await write('earlier secret\r\n');
		await write(
			`\x1b]777;brigadir;${Buffer.from('test').toString('base64')};${Buffer.from('/repo/src').toString('base64')}\x07\x1b]133;C\x07`
		);
		await write('\x1b[31m123456789012345\x1b[0m\r\nlast\r\n\x1b]133;D;evil\x07');
		expect(block?.exitCode).toBe(null);
		await write('\x1b]133;D;1\x07prompt> ');
		expect(block?.output).toBe('123456789012345\nlast');
		expect(block?.cwd).toBe('src');
		expect(block?.exitCode).toBe(1);
	} finally {
		terminal.dispose();
	}
});
it('reads the command of a shell whose base64 wraps lines, as GNU coreutils does on Linux (spec/architecture-and-platform#linux-package)', async () => {
	const terminal = new headless.Terminal({
		cols: 40,
		rows: 4,
		scrollback: 20,
		allowProposedApi: true,
	});
	let block: TerminalBlock | undefined;
	new TerminalBlocks(terminal, '/repo', (value) => {
		block = value;
	});
	const write = (text: string) => new Promise<void>((resolve) => terminal.write(text, resolve));
	const command =
		`pnpm exec vitest run ${'packages/host/src/terminal-blocks.test.ts '.repeat(3)}`.trim();
	// `printf '%s\0%s' "$command" "$PWD" | base64` with GNU base64: a line break after every 76 characters, which the tty
	// delivers as CR LF.
	const wrapped = Buffer.from(`${command}\0/repo/packages/host`)
		.toString('base64')
		.replace(/.{76}/g, '$&\r\n');
	expect(wrapped).toContain('\n');
	try {
		await write(`\x1b]777;brigadir;${wrapped}\x07\x1b]133;C\x07`);
		await write('ok\r\n\x1b]133;D;0\x07');
		expect(block?.command).toBe(command);
		expect(block?.cwd).toBe('packages/host');
		expect(block?.exitCode).toBe(0);
	} finally {
		terminal.dispose();
	}
});
