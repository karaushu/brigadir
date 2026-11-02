import { useEffect, useRef, useState } from 'react';
import {
	inputModifiers,
	isBrowserPicker,
	isPersonGesture,
	deviceCopyWindowMs,
	type AgentTask,
	type BrowserPicker,
	type BrowserMouseButton,
	type BrowserScreenCommand,
	type BrowserState,
	type Locale,
} from '@brigadir/core';
import { useRemote } from './remote-store';
import { fill } from './remote-text';
import styles from './BrowserPanel.module.css';

/** The device's own shortcuts: ⌘ on a Mac, Ctrl elsewhere (a Mac working machine reads Ctrl as ⌘, spec/remote-access-and-mobile#browser-from-device). */
const macDevice = /Mac/i.test(navigator.platform);
const buttons: Record<number, BrowserMouseButton> = { 0: 'left', 1: 'middle', 2: 'right' };
function modifiers(event: {
	altKey: boolean;
	ctrlKey: boolean;
	metaKey: boolean;
	shiftKey: boolean;
}) {
	return (
		(event.altKey ? inputModifiers.alt : 0) |
		(event.ctrlKey ? inputModifiers.ctrl : 0) |
		(event.metaKey ? inputModifiers.meta : 0) |
		(event.shiftKey ? inputModifiers.shift : 0)
	);
}
/** What a printable key types; Enter types a return, as a keyboard does. */
function typed(event: KeyboardEvent) {
	if (event.ctrlKey || event.metaKey) return '';
	if (event.key === 'Enter') return '\r';
	return event.key.length === 1 ? event.key : '';
}

/**
 * spec/remote-access-and-mobile#architecture, spec/remote-access-and-mobile#browser-from-device: a browser tab of the working machine in its window on a device. The page is the
 * machine's (its session, its agent); here are frames of it in a canvas, drawn as they come and acknowledged so the next
 * one may come, and the person's pointer, keys, input method, copy and paste going back. It streams while the panel has
 * a size and the window is not hidden; the machine ends it when this device loses control and it starts again when the
 * device takes control back.
 */
export function BrowserScreen({
	task,
	tab,
	locale,
	machine,
	onState,
}: {
	task: AgentTask;
	tab: string;
	locale: Locale;
	machine: string;
	/** The page state the start answers with, as a mount does locally. */
	onState?: (state: BrowserState) => void;
}) {
	const canvas = useRef<HTMLCanvasElement>(null),
		keys = useRef<HTMLTextAreaElement>(null),
		box = useRef<HTMLDivElement>(null);
	// The page viewport of the last frame, in CSS pixels: pointer positions are given in these.
	const page = useRef({ width: 1, height: 1 });
	const [restart, setRestart] = useState(0);
	const active = useRemote((state) => state.session?.active ?? true);
	const key = { projectId: task.projectId, id: task.id };
	// The person's last click, key or paste here: the page's copy reaches this clipboard only right after one (V3).
	const gestureAt = useRef(0);
	const send = (command: BrowserScreenCommand) => {
		if (isPersonGesture(command)) gestureAt.current = Date.now();
		return window.brigadir.browserScreen(key, command).catch(() => null);
	};
	useEffect(() => {
		const element = box.current,
			surface = canvas.current;
		if (!element || !surface || !active) return;
		let disposed = false,
			frame = 0,
			sent = '',
			drawing: Promise<void> = Promise.resolve(),
			frames = 0,
			bytes = 0;
		const context = surface.getContext('2d');
		const measure = () => {
			frame = 0;
			if (disposed) return;
			const width = Math.round(element.clientWidth),
				height = Math.round(element.clientHeight),
				visible = width > 0 && height > 0 && document.visibilityState === 'visible';
			const signature = visible ? `${width}x${height}@${devicePixelRatio}` : 'off';
			if (signature === sent) return;
			sent = signature;
			if (!visible) return void send({ kind: 'stop', tab });
			void window.brigadir
				.browserScreen(key, {
					kind: 'start',
					tab,
					width,
					height,
					scale: Math.min(4, Math.max(0.5, devicePixelRatio)),
					formats: ['webp', 'jpeg'],
				})
				.then(
					(state) => {
						if (!disposed && state && typeof state === 'object' && 'url' in state)
							onState?.(state as BrowserState);
					},
					() => {
						if (sent === signature) sent = '';
					}
				);
		};
		const update = () => {
			if (!frame && !disposed) frame = requestAnimationFrame(measure);
		};
		const observer = new ResizeObserver(update);
		observer.observe(element);
		document.addEventListener('visibilitychange', update);
		const off = window.brigadir.onBrowserScreen((event) => {
			if (
				disposed ||
				event.tab !== tab ||
				event.key.projectId !== task.projectId ||
				event.key.id !== task.id
			)
				return;
			if (event.kind === 'cursor') surface.style.cursor = event.cursor;
			else if (event.kind === 'copy') {
				// A machine (or its page) writes this device's clipboard only for what the person just did here.
				if (Date.now() - gestureAt.current < deviceCopyWindowMs)
					void window.brigadir.copyText(event.text).catch(() => {});
			} else if (event.kind === 'picker') {
				if (isBrowserPicker(event.picker)) showPicker(event.picker);
			} else if (event.kind === 'end') {
				// The machine ended it (this device lost control): asked again once it may.
				sent = 'ended';
			} else {
				const { data, format, width, height } = event,
					number = event.frame;
				drawing = drawing.then(async () => {
					if (disposed) return;
					try {
						const picture = await createImageBitmap(
							new Blob([data as Uint8Array<ArrayBuffer>], { type: `image/${format}` })
						);
						if (disposed) return picture.close();
						if (surface.width !== picture.width || surface.height !== picture.height) {
							surface.width = picture.width;
							surface.height = picture.height;
						}
						context?.drawImage(picture, 0, 0);
						picture.close();
						page.current = { width, height };
						// The page's CSS size, smaller only if the panel is (Mobile keeps its phone width, spec/task-window-workspace#restore-window).
						const fit = Math.min(
							1,
							element.clientWidth / Math.max(1, width),
							element.clientHeight / Math.max(1, height)
						);
						surface.style.width = `${width * fit}px`;
						surface.style.height = `${height * fit}px`;
						frames++;
						bytes += data.length;
						surface.dataset.frames = String(frames);
						surface.dataset.bytes = String(bytes);
					} finally {
						if (!disposed) void send({ kind: 'ack', tab, frame: number });
					}
				});
			}
		});
		measure();
		return () => {
			disposed = true;
			cancelAnimationFrame(frame);
			observer.disconnect();
			document.removeEventListener('visibilitychange', update);
			off();
			void send({ kind: 'stop', tab });
		};
	}, [task.id, task.projectId, tab, active, restart]);
	// The device took control back: the stream the machine ended starts again.
	const epoch = useRemote((state) => state.epoch);
	useEffect(() => {
		if (epoch) setRestart((value) => value + 1);
	}, [epoch]);

	/**
	 * spec/remote-access-and-mobile#networking: a picker the page asked for — this device's own element of the same kind, with the same options and
	 * value, laid over the page's element and opened with `showPicker()`: the select menu, colour panel or calendar of
	 * this OS. The choice goes back as `pick`; a newer picker replaces an open one.
	 */
	const proxy = useRef<HTMLSelectElement | HTMLInputElement | null>(null);
	const showPicker = (picker: BrowserPicker) => {
		const element = box.current,
			surface = canvas.current;
		if (!element || !surface) return;
		proxy.current?.remove();
		let node: HTMLSelectElement | HTMLInputElement;
		if (picker.type === 'select') {
			const select = document.createElement('select');
			let group: HTMLOptGroupElement | null = null,
				label: string | null = null;
			for (const item of picker.options) {
				if (item.group !== label) {
					label = item.group;
					group = null;
					if (label !== null) {
						group = select.appendChild(document.createElement('optgroup'));
						group.label = label;
					}
				}
				const option = document.createElement('option');
				option.value = item.value;
				option.textContent = item.label;
				option.disabled = item.disabled;
				(group ?? select).appendChild(option);
			}
			select.value = picker.value;
			node = select;
		} else {
			const input = document.createElement('input');
			input.type = picker.type;
			for (const name of ['min', 'max', 'step'] as const)
				if (picker[name]) input[name] = picker[name];
			input.value = picker.value;
			node = input;
		}
		const at = surface.getBoundingClientRect(),
			inside = element.getBoundingClientRect(),
			scale = at.width / Math.max(1, page.current.width);
		node.className = styles.picker!;
		node.dataset.browserPicker = picker.type;
		node.tabIndex = -1;
		Object.assign(node.style, {
			left: `${at.left - inside.left + picker.x * scale}px`,
			top: `${at.top - inside.top + picker.y * scale}px`,
			width: `${Math.max(1, picker.width * scale)}px`,
			height: `${Math.max(1, picker.height * scale)}px`,
		});
		let done = false;
		const answer = (value: string | null) => {
			if (done) return;
			done = true;
			node.remove();
			if (proxy.current === node) proxy.current = null;
			void send({ kind: 'pick', tab, id: picker.id, value });
		};
		node.addEventListener('change', () => answer(node.value));
		node.addEventListener('cancel', () => answer(null));
		node.addEventListener('blur', () => setTimeout(() => answer(null), 0));
		element.appendChild(node);
		proxy.current = node;
		try {
			node.showPicker();
		} catch {
			// No user activation left (a slow round trip): the page keeps its value.
			answer(null);
		}
	};
	/** A pointer position on the page, in its CSS pixels. */
	const point = (event: { clientX: number; clientY: number }) => {
		const rect = canvas.current!.getBoundingClientRect();
		return {
			x: ((event.clientX - rect.left) / Math.max(1, rect.width)) * page.current.width,
			y: ((event.clientY - rect.top) / Math.max(1, rect.height)) * page.current.height,
		};
	};
	const mouse = (
		type: 'move' | 'down' | 'up' | 'wheel',
		event: PointerEvent | WheelEvent | React.PointerEvent,
		extra: {
			button?: BrowserMouseButton;
			clickCount?: number;
			deltaX?: number;
			deltaY?: number;
		} = {}
	) =>
		send({
			kind: 'mouse',
			tab,
			type,
			...point(event),
			button: extra.button ?? 'none',
			buttons: Math.max(0, Math.min(31, event.buttons)),
			clickCount: extra.clickCount ?? 0,
			modifiers: modifiers(event),
			deltaX: extra.deltaX ?? 0,
			deltaY: extra.deltaY ?? 0,
			ctrlPrimary: !macDevice,
		});
	// Moves go once a frame; the wheel scrolls the page, not the panel.
	useEffect(() => {
		const surface = canvas.current;
		if (!surface) return;
		let pending: PointerEvent | null = null,
			frame = 0;
		const move = (event: PointerEvent) => {
			pending = event;
			if (!frame)
				frame = requestAnimationFrame(() => {
					frame = 0;
					if (pending) void mouse('move', pending);
					pending = null;
				});
		};
		const wheel = (event: WheelEvent) => {
			event.preventDefault();
			const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
			void mouse('wheel', event, { deltaX: event.deltaX * unit, deltaY: event.deltaY * unit });
		};
		surface.addEventListener('pointermove', move);
		surface.addEventListener('wheel', wheel, { passive: false });
		return () => {
			cancelAnimationFrame(frame);
			surface.removeEventListener('pointermove', move);
			surface.removeEventListener('wheel', wheel);
		};
	}, [task.id, task.projectId, tab]);
	const keyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
		const native = event.nativeEvent;
		if (native.isComposing || native.keyCode === 229) return;
		const primary = macDevice ? event.metaKey : event.ctrlKey,
			letter = event.code.replace(/^Key/, '').toLowerCase();
		// Copy, cut and paste use this device's clipboard (spec/remote-access-and-mobile#browser-from-device).
		if (primary && !event.altKey && (letter === 'c' || letter === 'x')) {
			event.preventDefault();
			void window.brigadir
				.browserScreen(key, { kind: 'copy', tab, cut: letter === 'x' })
				.then((text) => {
					if (typeof text === 'string' && text) void window.brigadir.copyText(text);
				})
				.catch(() => {});
			return;
		}
		if (primary && !event.altKey && letter === 'v') {
			event.preventDefault();
			void window.brigadir
				.readClipboardText()
				.then((text) => send({ kind: 'paste', tab, text: text.slice(0, 1_000_000) }))
				.catch(() => {});
			return;
		}
		event.preventDefault();
		void send({
			kind: 'key',
			tab,
			type: 'down',
			key: event.key.slice(0, 32),
			code: event.code.slice(0, 32),
			keyCode: Math.min(255, native.keyCode),
			text: typed(native),
			location: event.location,
			repeat: event.repeat,
			modifiers: modifiers(event),
			ctrlPrimary: !macDevice,
		});
	};
	const keyUp = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
		const native = event.nativeEvent;
		if (native.isComposing || native.keyCode === 229) return;
		event.preventDefault();
		void send({
			kind: 'key',
			tab,
			type: 'up',
			key: event.key.slice(0, 32),
			code: event.code.slice(0, 32),
			keyCode: Math.min(255, native.keyCode),
			text: '',
			location: event.location,
			repeat: false,
			modifiers: modifiers(event),
			ctrlPrimary: !macDevice,
		});
	};
	// What an input method, dictation or the emoji picker typed: the page gets it as text.
	const insert = (text: string) => {
		if (keys.current) keys.current.value = '';
		if (text) void send({ kind: 'text', tab, text: text.slice(0, 10_000) });
	};
	/** spec/remote-access-and-mobile#networking: the composition so far shows in the page, underlined, with the caret where the IME has it. */
	const compose = (text: string) => {
		const field = keys.current,
			value = text.slice(0, 1000),
			end = Math.min(value.length, field?.selectionEnd ?? value.length),
			start = Math.min(end, field?.selectionStart ?? end);
		void send({ kind: 'ime', tab, text: value, start, end });
	};
	return (
		<div ref={box} className={styles.screenBox}>
			<canvas
				ref={canvas}
				className={styles.screen}
				data-browser-screen
				role="img"
				aria-label={fill(locale, 'Page on {machine}', { machine })}
				onPointerDown={(event) => {
					// No mousedown of its own: it would take the focus from the keys' field to the body.
					event.preventDefault();
					keys.current?.focus({ preventScroll: true });
					event.currentTarget.setPointerCapture(event.pointerId);
					void mouse('down', event, {
						button: buttons[event.button] ?? 'left',
						clickCount: Math.max(1, Math.min(3, event.detail || 1)),
					});
				}}
				onPointerUp={(event) => {
					void mouse('up', event, {
						button: buttons[event.button] ?? 'left',
						clickCount: Math.max(1, Math.min(3, event.detail || 1)),
					});
				}}
				onContextMenu={(event) => event.preventDefault()}
			/>
			<textarea
				ref={keys}
				className={styles.keys}
				aria-label={fill(locale, 'Page on {machine}', { machine })}
				autoComplete="off"
				autoCorrect="off"
				spellCheck={false}
				onKeyDown={keyDown}
				onKeyUp={keyUp}
				onCompositionUpdate={(event) => compose(event.data)}
				onCompositionEnd={(event) => {
					// A cancelled composition clears what the page showed; a finished one commits it.
					if (event.data) insert(event.data);
					else compose('');
				}}
				onInput={(event) => {
					const native = event.nativeEvent as InputEvent;
					if (!native.isComposing) insert(event.currentTarget.value);
				}}
			/>
		</div>
	);
}
