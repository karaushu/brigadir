import type { IDisposable, Terminal } from '@xterm/xterm';
/**
 * spec/terminal-and-cli-agents#wheel: the wheel as a native terminal sends it. xterm.js damps a trackpad to 0.3 and reports one wheel event per DOM
 * event however far it travelled, so a TUI that tracks the mouse (Claude Code's fullscreen renderer) crawls and drops lines.
 * Here every line-height of travel is one report, times `speed()`; without mouse tracking xterm scrolls its own buffer.
 */
export function nativeWheel(
	terminal: Terminal,
	screen: () => HTMLElement | null,
	speed: () => number,
	send: (data: string) => void,
	preferScrollback: () => boolean = () => false
): IDisposable {
	// Only SGR (1006) reports are written here; the other encodings stay with xterm.
	let sgr = false,
		travel = 0;
	const mode = (set: boolean) => (params: (number | number[])[]) => {
		if (params.includes(1006)) sgr = set;
		return false;
	};
	const on = terminal.parser.registerCsiHandler({ prefix: '?', final: 'h' }, mode(true)),
		off = terminal.parser.registerCsiHandler({ prefix: '?', final: 'l' }, mode(false));
	terminal.attachCustomWheelEventHandler((event) => {
		const scrollback = preferScrollback() && terminal.buffer.active.type === 'normal';
		if (
			event.deltaY === 0 ||
			(!scrollback && (event.shiftKey || terminal.modes.mouseTrackingMode === 'none' || !sgr))
		)
			return true;
		const element = screen();
		if (!element) return true;
		const box = element.getBoundingClientRect(),
			cell = { width: box.width / terminal.cols, height: box.height / terminal.rows };
		if (!cell.height) return true;
		// deltaMode 1 is lines, 2 pages, 0 pixels.
		const lines =
			event.deltaMode === 1
				? event.deltaY
				: event.deltaMode === 2
					? event.deltaY * terminal.rows
					: event.deltaY / cell.height;
		// A turn of direction starts afresh: no remainder carries the old way.
		if (travel !== 0 && Math.sign(travel) !== Math.sign(lines)) travel = 0;
		travel += lines * speed();
		const count = Math.trunc(travel);
		travel -= count;
		if (scrollback) {
			if (count !== 0) terminal.scrollLines(count);
			event.preventDefault();
			return false;
		}
		if (count !== 0) {
			const col = Math.max(
					1,
					Math.min(terminal.cols, Math.floor((event.clientX - box.left) / cell.width) + 1)
				),
				row = Math.max(
					1,
					Math.min(terminal.rows, Math.floor((event.clientY - box.top) / cell.height) + 1)
				);
			const report = `\x1b[<${count < 0 ? 64 : 65};${col};${row}M`;
			send(report.repeat(Math.min(Math.abs(count), terminal.rows * 3)));
		}
		event.preventDefault();
		return false;
	});
	return {
		dispose() {
			on.dispose();
			off.dispose();
			terminal.attachCustomWheelEventHandler(() => true);
		},
	};
}
