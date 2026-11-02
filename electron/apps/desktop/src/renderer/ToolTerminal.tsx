import { terminalTypography } from './typography';
import { terminalColor } from './terminal-color';
import { useEffect, useMemo, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { toolOutput, t, type ToolPatch, type Locale } from '@brigadir/core';
import '@xterm/xterm/css/xterm.css';
import styles from './ToolTerminal.module.css';
/** Tool output in the chat is mono 11/17 in the secondary colour; the family follows the terminal setting (spec/appearance#fonts). */
function outputTypography() {
	return { ...terminalTypography(), fontSize: 11, lineHeight: OUTPUT_LINE_HEIGHT };
}
const OUTPUT_LINE_HEIGHT = 1.4;
export default function ToolTerminal({ tool, locale }: { tool: ToolPatch; locale: Locale }) {
	const output = useMemo(() => toolOutput(tool), [tool.output, tool.content]),
		mount = useRef<HTMLDivElement>(null),
		box = useRef<HTMLDivElement>(null);
	// Counted without splitting up to 128 KiB on every render; mounted only in an open tool row (perf review TUI-05).
	// A trailing newline ends the last line; it does not start an empty one: three lines of output, three rows.
	const rows = useMemo(() => {
		const text = output.text.replace(/\r?\n$/, '');
		let lines = 1;
		for (
			let index = text.indexOf('\n');
			index >= 0 && lines < 10;
			index = text.indexOf('\n', index + 1)
		)
			lines++;
		return lines;
	}, [output.text]);
	useEffect(() => {
		if (!mount.current || !output.text) return;
		let disposed = false;
		const theme = () => {
			const css = getComputedStyle(document.documentElement),
				color = (name: string) => css.getPropertyValue(name).trim();
			return {
				background: color('--term'),
				foreground: color('--fg2'),
				selectionBackground: terminalColor(color('--accent-soft')),
				red: color('--red'),
				brightRed: color('--red'),
				green: color('--green'),
				brightGreen: color('--green'),
				yellow: color('--amber'),
				brightYellow: color('--amber'),
				blue: color('--accent'),
				brightBlue: color('--accent'),
			};
		};
		const terminal = new Terminal({
				rows,
				cols: 80,
				scrollback: 10000,
				...outputTypography(),
				disableStdin: true,
				cursorBlink: false,
				cursorInactiveStyle: 'none',
				convertEol: true,
				screenReaderMode: true,
				theme: theme(),
			}),
			fit = new FitAddon();
		terminal.loadAddon(fit);
		terminal.open(mount.current);
		const resize = () => {
			if (disposed || !mount.current?.clientWidth) return;
			const cols = fit.proposeDimensions()?.cols;
			if (cols) terminal.resize(cols, rows);
			const height = terminal.element?.querySelector<HTMLElement>('.xterm-screen')?.offsetHeight;
			if (height && box.current) box.current.style.height = `${height + 14}px`;
		};
		resize();
		terminal.write(output.text.replace(/\r?\n$/, ''), () => {
			if (!disposed) terminal.scrollToBottom();
		});
		const observer = new ResizeObserver(resize);
		observer.observe(mount.current);
		const appearance = new MutationObserver(() => {
			terminal.options.theme = theme();
			Object.assign(terminal.options, outputTypography());
			resize();
		});
		appearance.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ['data-theme', 'data-accent', 'data-accent-text', 'style'],
		});
		return () => {
			disposed = true;
			observer.disconnect();
			appearance.disconnect();
			terminal.dispose();
		};
	}, [output.text, rows]);
	if (output.unavailable) return <p role="status">{t(locale, 'Tool output is unavailable.')}</p>;
	if (!output.text) return null;
	return (
		<section className={styles.block} aria-label={t(locale, 'Tool output')}>
			{/* spec/terminal-and-cli-agents#render-and-theme: FitAddon measures the terminal's parent; the padding stays on the box around it, or columns over-count. */}
			<div ref={box} className={styles.mount} style={{ height: rows * 17 + 14 }}>
				<div ref={mount} />
			</div>
			{output.truncated && <p role="status">{t(locale, 'Only the last 128 KiB are shown.')}</p>}
		</section>
	);
}
