import type { Terminal, IMarker } from '@xterm/headless';
import { relative } from 'node:path';
import type { TerminalBlock } from '@brigadir/core';

export function boundedOutput(lines: string[]) {
	const selected =
		lines.length > 400
			? [...lines.slice(0, 100), `[… ${lines.length - 400} lines omitted …]`, ...lines.slice(-300)]
			: lines;
	const value = selected.join('\n');
	const bytes = Buffer.from(value);
	return bytes.length > 16384
		? bytes.subarray(0, 4000).toString('utf8') +
				'\n[… output omitted …]\n' +
				bytes.subarray(-12000).toString('utf8')
		: value;
}

/** Shell output is untrusted display metadata; no marker has an external effect. */
export class TerminalBlocks {
	private metadata: { command: string; cwd: string } | null = null;
	private marker: IMarker | undefined;
	private counter = 0;
	private current: TerminalBlock | undefined;
	constructor(
		readonly terminal: Terminal,
		readonly root: string,
		readonly update: (block: TerminalBlock) => void
	) {
		terminal.parser.registerOscHandler(777, (value) => {
			if (value.length > 32768) return true;
			const [kind, first, second] = value.split(';');
			if (
				kind !== 'brigadir' ||
				first === undefined ||
				!/^[A-Za-z0-9+/=]*$/.test(first + (second ?? ''))
			)
				return true;
			// zsh and bash send base64 of `command NUL cwd`, one encoding per command (perf review TUI-11); fish and shells started by
			// an earlier host send each value on its own. A cwd has no NUL, so the last one splits.
			const joined = second === undefined ? Buffer.from(first, 'base64').toString('utf8') : '',
				split = joined.lastIndexOf('\0');
			if (second === undefined && split < 0) return true;
			const [command, cwd] =
				second === undefined
					? [joined.slice(0, split), joined.slice(split + 1)]
					: [
							Buffer.from(first, 'base64').toString('utf8'),
							Buffer.from(second, 'base64').toString('utf8'),
						];
			this.metadata = { command: command.slice(0, 8000), cwd: relative(root, cwd) || '.' };
			return true;
		});
		terminal.parser.registerOscHandler(133, (value) => {
			if (value === 'C' && this.metadata) {
				this.marker?.dispose();
				this.marker = terminal.registerMarker(0);
				this.current = {
					id: ++this.counter,
					...this.metadata,
					startedAt: Date.now(),
					duration: null,
					exitCode: null,
					output: '',
				};
				this.metadata = null;
				this.update({ ...this.current });
			} else if (value.startsWith('D;') && this.current?.exitCode === null) {
				const code = Number(value.slice(2));
				if (!Number.isInteger(code) || code < 0 || code > 255) return true;
				const buffer = terminal.buffer.active;
				const lines: string[] = [];
				const end = buffer.baseY + buffer.cursorY;
				if (this.marker?.isDisposed)
					lines.push('[… beginning of command output left the scrollback …]');
				for (let i = this.marker && !this.marker.isDisposed ? this.marker.line : 0; i <= end; i++) {
					const line = buffer.getLine(i);
					if (!line) continue;
					const text = line.translateToString(true, 0, i === end ? buffer.cursorX : undefined);
					if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
					else lines.push(text);
				}
				while (lines.at(-1) === '') lines.pop();
				this.current = {
					...this.current,
					exitCode: code,
					duration: Date.now() - this.current.startedAt,
					output: boundedOutput(lines),
				};
				this.update({ ...this.current });
			}
			return true;
		});
	}
}
