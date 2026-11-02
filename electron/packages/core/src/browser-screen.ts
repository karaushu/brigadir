/**
 * spec/remote-access-and-mobile#architecture, spec/remote-access-and-mobile#browser-from-device: the browser page of the working machine on a device. The device's window draws frames of
 * CDP `Page.startScreencast` in a `<canvas>` and sends back what the person does on it; main of the working machine runs
 * it on the page through `Input.*`. Every value here crosses the gateway, so each has its validator.
 */
import { isRecord } from './workspace';
import { isTaskKey, type TaskKey } from './session';
import { fitsUtf8 } from './utf8';

export type BrowserScreenFormat = 'webp' | 'jpeg';
export const browserScreenFormats: readonly BrowserScreenFormat[] = ['webp', 'jpeg'];
/** CDP `Input` modifiers: Alt 1, Ctrl 2, Meta (⌘) 4, Shift 8. */
export const inputModifiers = { alt: 1, ctrl: 2, meta: 4, shift: 8 } as const;
export type BrowserMouseButton = 'none' | 'left' | 'middle' | 'right';
export type BrowserScreenCommand =
	/** The panel is on screen: its CSS size and the device's pixel ratio; again on every resize. */
	| {
			kind: 'start';
			tab: string;
			width: number;
			height: number;
			scale: number;
			formats: BrowserScreenFormat[];
	  }
	| { kind: 'stop'; tab: string }
	/** The device drew this frame: main lets Chromium send the next one. */
	| { kind: 'ack'; tab: string; frame: number }
	/** A point in the page's CSS pixels (the frame's own `width`/`height`). */
	| {
			kind: 'mouse';
			tab: string;
			type: 'move' | 'down' | 'up' | 'wheel';
			x: number;
			y: number;
			button: BrowserMouseButton;
			buttons: number;
			clickCount: number;
			modifiers: number;
			deltaX: number;
			deltaY: number;
			/** spec/remote-access-and-mobile#networking: Ctrl is the device's primary key (Windows, Linux) — Ctrl+click is ⌘+click on a Mac. */
			ctrlPrimary: boolean;
	  }
	/**
	 * A key as the device's window got it. `text` — what a printable key types (empty for the rest); `ctrlPrimary` — the
	 * device's own shortcuts use Ctrl (Windows, Linux), which a Mac working machine reads as ⌘.
	 */
	| {
			kind: 'key';
			tab: string;
			type: 'down' | 'up';
			key: string;
			code: string;
			keyCode: number;
			text: string;
			location: number;
			repeat: boolean;
			modifiers: number;
			ctrlPrimary: boolean;
	  }
	/** What an input method composed (or any text the keys did not type): `Input.insertText`. */
	| { kind: 'text'; tab: string; text: string }
	/** spec/remote-access-and-mobile#networking: the input method's text while it composes (`Input.imeSetComposition`); empty — cancelled. */
	| { kind: 'ime'; tab: string; text: string; start: number; end: number }
	/** spec/remote-access-and-mobile#networking: the device's answer to a page picker `id`; null — closed without a choice. */
	| { kind: 'pick'; tab: string; id: number; value: string | null }
	/** ⌘C / ⌘X on the device: the page's copy or cut; the answer is the text for the device's clipboard. */
	| { kind: 'copy'; tab: string; cut: boolean }
	/** ⌘V on the device: its clipboard's text, as the page's paste. */
	| { kind: 'paste'; tab: string; text: string };
/** What main sends the window that streams a tab. */
export type BrowserScreenEvent =
	| {
			key: TaskKey;
			tab: string;
			kind: 'frame';
			frame: number;
			format: BrowserScreenFormat;
			data: Uint8Array;
			/** The page viewport in CSS pixels: pointer positions are in these. */
			width: number;
			height: number;
	  }
	| { key: TaskKey; tab: string; kind: 'cursor'; cursor: string }
	/** The page copied text after the person's input on the device: it goes to the device's clipboard. */
	| { key: TaskKey; tab: string; kind: 'copy'; text: string }
	/** The machine ended the stream (the device lost control, the tab closed): the panel asks again when it may. */
	| { key: TaskKey; tab: string; kind: 'end' }
	/** spec/remote-access-and-mobile#networking: the page opened a picker; the device shows its own over the element. */
	| { key: TaskKey; tab: string; kind: 'picker'; picker: BrowserPicker };
/** The kinds of a page's picker a device shows itself (spec/remote-access-and-mobile#networking). */
export const browserPickerTypes = [
	'select',
	'color',
	'date',
	'time',
	'datetime-local',
	'month',
	'week',
] as const;
export type BrowserPickerType = (typeof browserPickerTypes)[number];
export type BrowserPickerOption = {
	label: string;
	value: string;
	/** The `<optgroup>` label, null outside one. */
	group: string | null;
	disabled: boolean;
};
/** A page's `<select>` or date/time/colour input that asked for its popup; its box in the page's CSS pixels. */
export type BrowserPicker = {
	id: number;
	type: BrowserPickerType;
	value: string;
	options: BrowserPickerOption[];
	min: string;
	max: string;
	step: string;
	x: number;
	y: number;
	width: number;
	height: number;
};
export const browserPickerOptionsMax = 1000;

const tabId = (value: unknown): value is string =>
	typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const between = (value: unknown, low: number, high: number): value is number =>
	typeof value === 'number' && Number.isFinite(value) && value >= low && value <= high;
const whole = (value: unknown, low: number, high: number): value is number =>
	Number.isSafeInteger(value) && between(value, low, high);
const keys = (value: Record<string, unknown>, names: readonly string[]) =>
	Object.keys(value).length === names.length && names.every((name) => name in value);
/** The longest side a device may ask for, in CSS pixels; the ratio up to 4. */
export const browserScreenMax = 8192;
export function isBrowserScreenCommand(value: unknown): value is BrowserScreenCommand {
	if (!isRecord(value) || !tabId(value.tab)) return false;
	switch (value.kind) {
		case 'start':
			return (
				keys(value, ['kind', 'tab', 'width', 'height', 'scale', 'formats']) &&
				whole(value.width, 1, browserScreenMax) &&
				whole(value.height, 1, browserScreenMax) &&
				between(value.scale, 0.5, 4) &&
				Array.isArray(value.formats) &&
				value.formats.length > 0 &&
				value.formats.length <= 2 &&
				value.formats.every((format) => browserScreenFormats.includes(format))
			);
		case 'stop':
			return keys(value, ['kind', 'tab']);
		case 'ack':
			return (
				keys(value, ['kind', 'tab', 'frame']) && whole(value.frame, 0, Number.MAX_SAFE_INTEGER)
			);
		case 'mouse':
			return (
				keys(value, [
					'kind',
					'tab',
					'type',
					'x',
					'y',
					'button',
					'buttons',
					'clickCount',
					'modifiers',
					'deltaX',
					'deltaY',
					'ctrlPrimary',
				]) &&
				['move', 'down', 'up', 'wheel'].includes(value.type as string) &&
				between(value.x, -browserScreenMax, browserScreenMax) &&
				between(value.y, -browserScreenMax, browserScreenMax) &&
				['none', 'left', 'middle', 'right'].includes(value.button as string) &&
				whole(value.buttons, 0, 31) &&
				whole(value.clickCount, 0, 3) &&
				whole(value.modifiers, 0, 15) &&
				between(value.deltaX, -100_000, 100_000) &&
				between(value.deltaY, -100_000, 100_000) &&
				typeof value.ctrlPrimary === 'boolean'
			);
		case 'key':
			return (
				keys(value, [
					'kind',
					'tab',
					'type',
					'key',
					'code',
					'keyCode',
					'text',
					'location',
					'repeat',
					'modifiers',
					'ctrlPrimary',
				]) &&
				(value.type === 'down' || value.type === 'up') &&
				typeof value.key === 'string' &&
				value.key.length > 0 &&
				value.key.length <= 32 &&
				typeof value.code === 'string' &&
				/^[A-Za-z0-9]{0,32}$/.test(value.code) &&
				whole(value.keyCode, 0, 255) &&
				typeof value.text === 'string' &&
				value.text.length <= 4 &&
				whole(value.location, 0, 3) &&
				typeof value.repeat === 'boolean' &&
				whole(value.modifiers, 0, 15) &&
				typeof value.ctrlPrimary === 'boolean'
			);
		case 'text':
			return (
				keys(value, ['kind', 'tab', 'text']) &&
				typeof value.text === 'string' &&
				value.text.length > 0 &&
				value.text.length <= 10_000
			);
		case 'ime':
			return (
				keys(value, ['kind', 'tab', 'text', 'start', 'end']) &&
				typeof value.text === 'string' &&
				value.text.length <= 1000 &&
				whole(value.start, 0, 1000) &&
				whole(value.end, 0, 1000) &&
				value.start <= value.end &&
				value.end <= value.text.length
			);
		case 'pick':
			return (
				keys(value, ['kind', 'tab', 'id', 'value']) &&
				whole(value.id, 1, Number.MAX_SAFE_INTEGER) &&
				(value.value === null || (typeof value.value === 'string' && value.value.length <= 4096))
			);
		case 'copy':
			return keys(value, ['kind', 'tab', 'cut']) && typeof value.cut === 'boolean';
		case 'paste':
			return (
				keys(value, ['kind', 'tab', 'text']) &&
				typeof value.text === 'string' &&
				value.text.length <= 1_000_000 &&
				fitsUtf8(value.text, 4 * 1024 * 1024)
			);
		default:
			return false;
	}
}
/**
 * spec/remote-access-and-mobile#browser-from-device: a command that is the person acting on the page — a click, a key, text, a paste, a pick — and not a
 * pointer passing over it. Only such a command opens the second in which what the page copies reaches the device's
 * clipboard (security review R2–R4, V3).
 */
export function isPersonGesture(command: BrowserScreenCommand): boolean {
	switch (command.kind) {
		case 'mouse':
			return command.type !== 'move';
		case 'key':
		case 'text':
		case 'ime':
		case 'pick':
		case 'copy':
		case 'paste':
			return true;
		default:
			return false;
	}
}
/** How long after its own gesture a device takes the page's copy for its clipboard: the machine's second plus the way. */
export const deviceCopyWindowMs = 2500;
const shortText = (value: unknown, max: number): value is string =>
	typeof value === 'string' && value.length <= max;
/** A picker as the page reported it (untrusted page data) and as the device gets it. */
export function isBrowserPicker(value: unknown): value is BrowserPicker {
	return (
		isRecord(value) &&
		keys(value, [
			'id',
			'type',
			'value',
			'options',
			'min',
			'max',
			'step',
			'x',
			'y',
			'width',
			'height',
		]) &&
		whole(value.id, 1, Number.MAX_SAFE_INTEGER) &&
		browserPickerTypes.includes(value.type as BrowserPickerType) &&
		shortText(value.value, 4096) &&
		Array.isArray(value.options) &&
		value.options.length <= browserPickerOptionsMax &&
		(value.type === 'select' || value.options.length === 0) &&
		value.options.every(
			(option) =>
				isRecord(option) &&
				keys(option, ['label', 'value', 'group', 'disabled']) &&
				shortText(option.label, 500) &&
				shortText(option.value, 4096) &&
				(option.group === null || shortText(option.group, 500)) &&
				typeof option.disabled === 'boolean'
		) &&
		shortText(value.min, 64) &&
		shortText(value.max, 64) &&
		shortText(value.step, 64) &&
		between(value.x, -browserScreenMax, browserScreenMax) &&
		between(value.y, -browserScreenMax, browserScreenMax) &&
		between(value.width, 0, browserScreenMax) &&
		between(value.height, 0, browserScreenMax)
	);
}
/** spec/remote-access-and-mobile#networking: a mouse event's modifiers on a Mac working machine — Ctrl of a Windows or Linux device is ⌘. */
export function macMouseModifiers(modifiers: number, ctrlPrimary: boolean): number {
	const { ctrl, meta } = inputModifiers;
	if (!ctrlPrimary || !(modifiers & ctrl)) return modifiers;
	return (modifiers & ~ctrl) | meta;
}
export function isBrowserScreenArgs(args: readonly unknown[]): boolean {
	return args.length === 2 && isTaskKey(args[0]) && isBrowserScreenCommand(args[1]);
}

/**
 * A key of a Windows or Linux device on a Mac working machine: Ctrl shortcuts become ⌘ ones (Ctrl+A selects all),
 * Ctrl+←/→/Backspace/Delete move and delete by words (⌥ on a Mac), Home and End go to the line's ends (⌘←, ⌘→).
 */
export function macKey(command: Extract<BrowserScreenCommand, { kind: 'key' }>) {
	const { alt, ctrl, meta } = inputModifiers;
	let { modifiers, key, code, keyCode } = command;
	if (!command.ctrlPrimary) return { modifiers, key, code, keyCode };
	const words = ['ArrowLeft', 'ArrowRight', 'Backspace', 'Delete'];
	if (modifiers & ctrl) {
		modifiers &= ~ctrl;
		modifiers |= words.includes(key) ? alt : meta;
	} else if (key === 'Home' || key === 'End') {
		modifiers |= meta;
		key = key === 'Home' ? 'ArrowLeft' : 'ArrowRight';
		code = key;
		keyCode = key === 'ArrowLeft' ? 37 : 39;
	}
	return { modifiers, key, code, keyCode };
}
/**
 * The macOS editing commands of a key (`Input.dispatchKeyEvent` `commands`): a Mac page gets ⌘A, ⌘Z and the ⌘/⌥ moves
 * from the system's key bindings, which a CDP key does not pass through.
 */
export function macEditCommands(key: string, code: string, modifiers: number): string[] {
	const { alt, ctrl, meta, shift } = inputModifiers;
	if (modifiers & ctrl) return [];
	const select = modifiers & shift ? 'AndModifySelection' : '';
	if (modifiers & meta) {
		if (modifiers & alt) return [];
		if (code === 'KeyA' && !(modifiers & shift)) return ['selectAll'];
		if (code === 'KeyZ') return [modifiers & shift ? 'redo' : 'undo'];
		const moves: Record<string, string> = {
			ArrowLeft: 'moveToBeginningOfLine',
			ArrowRight: 'moveToEndOfLine',
			ArrowUp: 'moveToBeginningOfDocument',
			ArrowDown: 'moveToEndOfDocument',
		};
		if (moves[key]) return [`${moves[key]}${select}`];
		if (key === 'Backspace' && !select) return ['deleteToBeginningOfLine'];
		return [];
	}
	if (modifiers & alt) {
		if (key === 'ArrowLeft') return [`moveWordLeft${select}`];
		if (key === 'ArrowRight') return [`moveWordRight${select}`];
		if (key === 'Backspace' && !select) return ['deleteWordBackward'];
		if (key === 'Delete' && !select) return ['deleteWordForward'];
	}
	return [];
}
/** A cursor of the page (Electron's `cursor-changed`) as CSS; anything unknown is the arrow. */
const cssCursors = new Set([
	'default',
	'pointer',
	'text',
	'wait',
	'progress',
	'help',
	'crosshair',
	'move',
	'not-allowed',
	'grab',
	'grabbing',
	'zoom-in',
	'zoom-out',
	'copy',
	'alias',
	'cell',
	'context-menu',
	'vertical-text',
	'col-resize',
	'row-resize',
	'ew-resize',
	'ns-resize',
	'nesw-resize',
	'nwse-resize',
	'e-resize',
	'n-resize',
	'ne-resize',
	'nw-resize',
	's-resize',
	'se-resize',
	'sw-resize',
	'w-resize',
	'none',
]);
export function browserCursor(value: unknown): string {
	if (value === 'hand') return 'pointer';
	if (value === 'nodrop') return 'not-allowed';
	return typeof value === 'string' && cssCursors.has(value) ? value : 'default';
}
/** spec/browser-and-simulator#browser «Desktop / Mobile»: the phone viewport of Mobile — the real width of a layout, not a scale. */
export const mobileViewport = { width: 390, height: 844 } as const;
/**
 * The frame size a panel asks for: its CSS size times the device's ratio, at most `browserScreenMax` on the longer side.
 * In Mobile the page keeps its phone viewport (spec/task-window-workspace#restore-window): 390 × 844 at the device's ratio.
 */
export function browserScreenMetrics(
	command: Extract<BrowserScreenCommand, { kind: 'start' }>,
	mobile: boolean
) {
	const width = mobile ? mobileViewport.width : command.width,
		height = mobile ? mobileViewport.height : command.height,
		scale = Math.min(command.scale, browserScreenMax / Math.max(width, height));
	return {
		width,
		height,
		scale,
		mobile,
		maxWidth: Math.round(width * scale),
		maxHeight: Math.round(height * scale),
	};
}
