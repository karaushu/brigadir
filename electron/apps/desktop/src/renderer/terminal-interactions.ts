import { shortcutHint } from './ui/shortcut-hint';
import type { IDecoration, IMarker, Terminal } from '@xterm/xterm';
import {
	externalLink,
	filePathCandidates,
	pullRequestLink,
	t,
	type AgentTask,
	type FilePathLink,
	type Locale,
	type TerminalMenuAction,
	type TerminalMenuState,
} from '@brigadir/core';
import { readFileLinksQueued } from './file-link-queue';
import { openInTaskBrowser, openTaskFile, openTaskLink } from './FileLinks';
import { useWorkspace } from './store';

/** spec/terminal-and-cli-agents#console-links: what the console does with the mouse and the clipboard; xterm keeps its selection to itself, so the page asks it. */
export type TerminalTarget = { kind: 'web' | 'mail' | 'file'; text: string; file?: FilePathLink };
type Hooks = {
	task: AgentTask;
	locale: Locale;
	writable: () => boolean;
	showAgent: () => void;
	clear: () => void;
	tip: (text: string | null, x?: number, y?: number) => void;
};
type Found = {
	from: number;
	to: number;
	target: TerminalTarget;
	line: ReturnType<typeof logicalLine>;
};

const mac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);
/** ⌘ on macOS; Ctrl+Shift elsewhere, where Ctrl+C is the interrupt of the shell. */
const copyKey = (event: KeyboardEvent) =>
	mac ? event.metaKey && !event.ctrlKey && !event.altKey : event.ctrlKey && event.shiftKey;
const linkKey = (event: { metaKey: boolean; ctrlKey: boolean }) =>
	mac ? event.metaKey : event.ctrlKey;
const url = /(?:https?:\/\/|mailto:)[^\s<>"'`\\]+/gi;

/** The end of a URL in prose: the closing mark, a dot, a comma, a bracket that was never opened. */
function trimUrl(raw: string) {
	let value = raw;
	for (;;) {
		const last = value.at(-1);
		if (last && /[.,;:!?'"*]/.test(last)) value = value.slice(0, -1);
		else if (last === ')' && (value.match(/\(/g)?.length ?? 0) < (value.match(/\)/g)?.length ?? 0))
			value = value.slice(0, -1);
		else if (last && /[\]}]/.test(last) && !value.includes(last === '}' ? '{' : '['))
			value = value.slice(0, -1);
		else return value;
	}
}
/** URLs of a text with their offsets; only what the system may open (spec/chat#web-links). */
export function terminalUrls(text: string) {
	const found: { from: number; to: number; text: string }[] = [];
	for (const match of text.matchAll(url)) {
		const value = trimUrl(match[0]);
		if (externalLink(value))
			found.push({ from: match.index, to: match.index + value.length, text: value });
	}
	return found;
}

/** One logical line: the screen lines that xterm wrapped, joined, with the first buffer index. */
function logicalLine(terminal: Terminal, y: number) {
	const buffer = terminal.buffer.active;
	let first = y - 1;
	while (first > 0 && buffer.getLine(first)?.isWrapped) first--;
	let text = '';
	for (let i = first; i < buffer.length && (i === first || buffer.getLine(i)?.isWrapped); i++)
		text += buffer.getLine(i)?.translateToString(false) ?? '';
	return { text, first, cols: terminal.cols };
}
export function installTerminalInteractions(terminal: Terminal, mount: HTMLElement, hooks: Hooks) {
	// OSC 8 links have their own xterm activation path. Route them like detected text links,
	// instead of xterm's default confirm() + window.open(), which bypasses the PR panel.
	const previousLinkHandler = terminal.options.linkHandler;
	terminal.options.linkHandler = {
		activate(event, href) {
			if (!linkKey(event) || !externalLink(href)) return;
			event.preventDefault();
			openTaskLink(hooks.task, href);
		},
	};
	let held = false;
	const track = (event: { metaKey: boolean; ctrlKey: boolean }) => {
		const next = linkKey(event);
		if (next === held) return;
		held = next;
		if (!held) clearHover();
	};
	const blur = () => {
		held = false;
		clearHover();
	};
	window.addEventListener('keydown', track, true);
	window.addEventListener('keyup', track, true);
	window.addEventListener('blur', blur);

	const fileLinks = async (text: string): Promise<FilePathLink[]> => {
		if (!filePathCandidates(text).length) return [];
		try {
			return (
				(await readFileLinksQueued(hooks.task, [{ text, literal: false }], () => true))?.[0] ?? []
			);
		} catch {
			return [];
		}
	};
	/** Links of the logical line that holds screen line `y` (1-based): URLs at once, files after main checked them. */
	async function targets(y: number): Promise<Found[]> {
		const line = logicalLine(terminal, y);
		const urls: Found[] = terminalUrls(line.text).map((item) => ({
			from: item.from,
			to: item.to,
			line,
			target: {
				kind: item.text.toLowerCase().startsWith('mailto:') ? 'mail' : 'web',
				text: item.text,
			},
		}));
		const files: Found[] = (await fileLinks(line.text))
			.filter((file) => !urls.some((item) => file.from < item.to && item.from < file.to))
			.map((file) => ({
				from: file.from,
				to: file.to,
				line,
				target: { kind: 'file', text: line.text.slice(file.from, file.to), file },
			}));
		return [...urls, ...files];
	}
	function open(target: TerminalTarget) {
		if (target.kind === 'file') {
			if (target.file) openTaskFile(hooks.task, hooks.locale, target.file);
		} else openTaskLink(hooks.task, target.text);
	}
	// The link under the pointer while ⌘ is held: underlined by decorations (one per screen line it covers), a pointer, a hint.
	// xterm's own link layer asks once per line and keeps the answer, so it cannot follow the ⌘ key.
	let current: {
			found: Found;
			decorations: (IDecoration | undefined)[];
			markers: (IMarker | undefined)[];
		} | null = null,
		ask = 0;
	function clearHover() {
		ask++;
		if (!current) return;
		for (const item of current.decorations) item?.dispose();
		for (const item of current.markers) item?.dispose();
		current = null;
		terminal.element?.classList.remove('xterm-cursor-pointer');
		hooks.tip(null);
	}
	function showHover(found: Found, event: MouseEvent) {
		const buffer = terminal.buffer.active,
			decorations: (IDecoration | undefined)[] = [],
			markers: (IMarker | undefined)[] = [];
		for (let offset = found.from; offset < found.to;) {
			const lineIndex = found.line.first + Math.floor(offset / terminal.cols),
				x = offset % terminal.cols,
				width = Math.min(found.to - offset, terminal.cols - x);
			const marker = terminal.registerMarker(lineIndex - (buffer.baseY + buffer.cursorY));
			markers.push(marker);
			if (marker) {
				const decoration = terminal.registerDecoration({
					marker,
					x,
					width,
					height: 1,
					layer: 'top',
				});
				decorations.push(decoration);
				decoration?.onRender((element) => {
					element.style.borderBottom = '1px solid var(--accent)';
					element.style.boxSizing = 'border-box';
				});
			}
			offset += width;
		}
		current = { found, decorations, markers };
		terminal.element?.classList.add('xterm-cursor-pointer');
		hooks.tip(
			shortcutHint(
				hooks.locale,
				found.target.kind === 'file' ? '⌘+click opens in editor' : '⌘+click opens the link'
			),
			event.clientX,
			event.clientY
		);
	}
	async function onMove(event: MouseEvent) {
		track(event);
		if (!held) {
			return;
		}
		const cell = cellAt(event);
		if (!cell) {
			clearHover();
			return;
		}
		const id = ++ask,
			found = await targets(cell.row + 1);
		if (id !== ask) return;
		const hit = found.find((item) => {
			const position = (cell.row - item.line.first) * terminal.cols + cell.col;
			return position >= item.from && position < item.to;
		});
		if (!hit) {
			if (current) {
				const keep = ask;
				clearHover();
				ask = keep;
			}
			return;
		}
		if (
			current &&
			current.found.target.text === hit.target.text &&
			current.found.from === hit.from &&
			current.found.line.first === hit.line.first
		)
			return;
		const keep = ask;
		clearHover();
		ask = keep;
		showHover(hit, event);
	}
	const onClick = (event: MouseEvent) => {
		if (!held || !current || !linkKey(event)) return;
		event.preventDefault();
		event.stopPropagation();
		open(current.found.target);
	};
	const move = (event: MouseEvent) => {
		void onMove(event);
	};
	mount.addEventListener('mousemove', move, true);
	mount.addEventListener('mouseleave', clearHover);
	mount.addEventListener('click', onClick, true);
	const scroll = terminal.onScroll(clearHover);

	// ⌘C and ⌘A at the keyboard: the system Copy sees an empty textarea, not xterm's selection.
	terminal.attachCustomKeyEventHandler((event) => {
		if (event.type !== 'keydown' || !copyKey(event)) return true;
		if (event.code === 'KeyC' && terminal.hasSelection()) {
			void window.brigadir.copyText(terminal.getSelection()).catch(() => {});
			return false;
		}
		if (event.code === 'KeyA') {
			terminal.selectAll();
			return false;
		}
		return true;
	});
	// A selection also stands in the helper textarea, so the system Copy (the Edit menu) is enabled for it and xterm's own `copy` handler runs.
	const textarea = terminal.textarea;
	const selection = terminal.onSelectionChange(() => {
		if (!textarea) return;
		const text = terminal.getSelection();
		textarea.value = text;
		if (text) textarea.select();
	});

	function cellAt(event: MouseEvent) {
		const screen = mount.querySelector<HTMLElement>('.xterm-screen');
		if (!screen) return null;
		const box = screen.getBoundingClientRect(),
			col = Math.floor((event.clientX - box.left) / (box.width / terminal.cols)),
			row = Math.floor((event.clientY - box.top) / (box.height / terminal.rows));
		if (col < 0 || row < 0 || col >= terminal.cols || row >= terminal.rows) return null;
		return { col, row: row + terminal.buffer.active.viewportY };
	}
	function inSelection(col: number, row: number) {
		const position = terminal.getSelectionPosition();
		if (!position) return false;
		const at = row * terminal.cols + col,
			from = position.start.y * terminal.cols + position.start.x,
			to = position.end.y * terminal.cols + position.end.x;
		return at >= Math.min(from, to) && at < Math.max(from, to);
	}
	async function menu(event: MouseEvent) {
		event.preventDefault();
		event.stopPropagation();
		const cell = cellAt(event);
		if (cell && !inSelection(cell.col, cell.row)) terminal.clearSelection();
		let target: TerminalTarget | null = null;
		if (cell) {
			const found = await targets(cell.row + 1);
			target =
				found.find((item) => {
					const at = (cell.row - item.line.first) * terminal.cols + cell.col;
					return at >= item.from && at < item.to;
				})?.target ?? null;
		}
		const modules = useWorkspace.getState().appearance.modules;
		// spec/terminal-and-cli-agents#console-menu: a PR page gets «Open in the PR panel»; whether it is this project's is decided by openTaskLink, as in the chat.
		const link = target?.file?.folder
			? 'folder'
			: target?.kind === 'web' && modules.pullRequests && pullRequestLink(target.text)
				? 'pr'
				: (target?.kind ?? null);
		const state: TerminalMenuState = {
			selection: terminal.hasSelection(),
			link,
			browser: modules.browser,
			canPaste: hooks.writable(),
		};
		let action: TerminalMenuAction | null = null;
		try {
			action = await window.brigadir.terminalMenu(state);
		} catch {
			return;
		}
		if (action === 'open-pr' && target) openTaskLink(hooks.task, target.text);
		else if (action === 'open-task-browser' && target) openInTaskBrowser(hooks.task, target.text);
		else if (action === 'open-system' && target)
			void window.brigadir.openWebLink(target.text).catch(() => {});
		else if (action === 'copy-link' && target)
			void window.brigadir.copyText(target.text).catch(() => {});
		else if (action === 'open-file' && target) open(target);
		else if (action === 'copy' && terminal.hasSelection())
			void window.brigadir.copyText(terminal.getSelection()).catch(() => {});
		else if (action === 'paste')
			void window.brigadir
				.readClipboardText()
				.then((text) => {
					if (text && hooks.writable()) terminal.paste(text);
				})
				.catch(() => {});
		else if (action === 'select-all') terminal.selectAll();
		else if (action === 'show-agent') hooks.showAgent();
		else if (action === 'clear') hooks.clear();
		terminal.focus();
	}
	const onMenu = (event: MouseEvent) => {
		void menu(event);
	};
	mount.addEventListener('contextmenu', onMenu, true);

	return {
		dispose() {
			terminal.options.linkHandler = previousLinkHandler ?? null;
			clearHover();
			scroll.dispose();
			mount.removeEventListener('mousemove', move, true);
			mount.removeEventListener('mouseleave', clearHover);
			mount.removeEventListener('click', onClick, true);
			selection.dispose();
			window.removeEventListener('keydown', track, true);
			window.removeEventListener('keyup', track, true);
			window.removeEventListener('blur', blur);
			mount.removeEventListener('contextmenu', onMenu, true);
			hooks.tip(null);
		},
	};
}
