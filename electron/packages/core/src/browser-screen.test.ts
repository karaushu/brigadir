import { describe, expect, it } from 'vitest';
import {
	acceptExtensions,
	browserCursor,
	browserScreenMetrics,
	isBrowserPicker,
	isBrowserScreenCommand,
	isPersonGesture,
	macMouseModifiers,
	isRemoteDialog,
	isRemoteFileChoice,
	isSimulatorCommand,
	macEditCommands,
	macKey,
	remoteCallRefusal,
	type BrowserScreenCommand,
} from './index';

const key = (patch: Partial<Extract<BrowserScreenCommand, { kind: 'key' }>>) =>
	({
		kind: 'key',
		tab: 'b1',
		type: 'down',
		key: 'a',
		code: 'KeyA',
		keyCode: 65,
		text: 'a',
		location: 0,
		repeat: false,
		modifiers: 0,
		ctrlPrimary: false,
		...patch,
	}) as Extract<BrowserScreenCommand, { kind: 'key' }>;

describe('browser on a device (spec/remote-access-and-mobile#browser-from-device)', () => {
	it('takes only the commands it knows, with their exact fields', () => {
		expect(
			isBrowserScreenCommand({
				kind: 'start',
				tab: 'b1',
				width: 640,
				height: 480,
				scale: 2,
				formats: ['webp', 'jpeg'],
			})
		).toBe(true);
		expect(
			isBrowserScreenCommand({
				kind: 'start',
				tab: 'b1',
				width: 0,
				height: 480,
				scale: 2,
				formats: ['webp'],
			})
		).toBe(false);
		expect(
			isBrowserScreenCommand({
				kind: 'start',
				tab: 'b1',
				width: 10,
				height: 10,
				scale: 2,
				formats: ['png'],
			})
		).toBe(false);
		expect(isBrowserScreenCommand({ kind: 'stop', tab: 'b1' })).toBe(true);
		expect(isBrowserScreenCommand({ kind: 'stop', tab: '../x' })).toBe(false);
		expect(isBrowserScreenCommand({ kind: 'ack', tab: 'b1', frame: 3 })).toBe(true);
		expect(isBrowserScreenCommand(key({}))).toBe(true);
		expect(isBrowserScreenCommand({ ...key({}), extra: 1 })).toBe(false);
		expect(isBrowserScreenCommand(key({ text: 'toolong' }))).toBe(false);
		expect(
			isBrowserScreenCommand({
				kind: 'mouse',
				tab: 'b1',
				type: 'down',
				x: 10,
				y: 20,
				button: 'left',
				buttons: 1,
				clickCount: 1,
				modifiers: 0,
				deltaX: 0,
				deltaY: 0,
				ctrlPrimary: false,
			})
		).toBe(true);
		expect(isBrowserScreenCommand({ kind: 'text', tab: 'b1', text: '' })).toBe(false);
		expect(isBrowserScreenCommand({ kind: 'paste', tab: 'b1', text: '' })).toBe(true);
		expect(isBrowserScreenCommand({ kind: 'copy', tab: 'b1', cut: true })).toBe(true);
	});
	it('reads Ctrl shortcuts of a Windows or Linux device as a Mac reads ⌘ and ⌥', () => {
		expect(macKey(key({ modifiers: 2, ctrlPrimary: true })).modifiers).toBe(4);
		expect(macKey(key({ modifiers: 2, ctrlPrimary: false })).modifiers).toBe(2);
		expect(
			macKey(key({ key: 'ArrowLeft', code: 'ArrowLeft', modifiers: 2 | 8, ctrlPrimary: true }))
				.modifiers
		).toBe(1 | 8);
		expect(macKey(key({ key: 'Home', code: 'Home', keyCode: 36, ctrlPrimary: true }))).toEqual({
			modifiers: 4,
			key: 'ArrowLeft',
			code: 'ArrowLeft',
			keyCode: 37,
		});
	});
	it('gives a Mac page the editing commands its key bindings would', () => {
		expect(macEditCommands('a', 'KeyA', 4)).toEqual(['selectAll']);
		expect(macEditCommands('z', 'KeyZ', 4)).toEqual(['undo']);
		expect(macEditCommands('Z', 'KeyZ', 4 | 8)).toEqual(['redo']);
		expect(macEditCommands('ArrowLeft', 'ArrowLeft', 4 | 8)).toEqual([
			'moveToBeginningOfLineAndModifySelection',
		]);
		expect(macEditCommands('ArrowRight', 'ArrowRight', 1)).toEqual(['moveWordRight']);
		expect(macEditCommands('Backspace', 'Backspace', 1)).toEqual(['deleteWordBackward']);
		expect(macEditCommands('a', 'KeyA', 0)).toEqual([]);
		expect(macEditCommands('a', 'KeyA', 2)).toEqual([]);
	});
	it('keeps the frame within the limit and Mobile in its phone viewport', () => {
		const start = {
			kind: 'start' as const,
			tab: 'b1',
			width: 800,
			height: 600,
			scale: 2,
			formats: ['webp' as const],
		};
		expect(browserScreenMetrics(start, false)).toMatchObject({
			width: 800,
			height: 600,
			maxWidth: 1600,
			maxHeight: 1200,
		});
		expect(browserScreenMetrics(start, true)).toMatchObject({
			width: 390,
			height: 844,
			maxWidth: 780,
		});
		expect(browserScreenMetrics({ ...start, width: 8000, scale: 4 }, false).maxWidth).toBe(8192);
	});
	it('names a cursor in CSS', () => {
		expect(browserCursor('hand')).toBe('pointer');
		expect(browserCursor('text')).toBe('text');
		expect(browserCursor('custom')).toBe('default');
		expect(browserCursor('url(x)')).toBe('default');
	});
});
describe('page dialogs and files on a device (spec/remote-access-and-mobile#browser-from-device)', () => {
	it('checks a page dialog and a file request', () => {
		expect(
			isRemoteDialog({
				kind: 'page',
				id: 1,
				type: 'prompt',
				site: 'localhost:5173',
				message: 'Name?',
				value: 'x',
				mute: false,
			})
		).toBe(true);
		expect(
			isRemoteDialog({
				kind: 'page',
				id: 1,
				type: 'print',
				site: '',
				message: '',
				value: '',
				mute: false,
			})
		).toBe(false);
		// P1: whether it offers «Don't show more dialogs from this page» is part of it.
		expect(
			isRemoteDialog({ kind: 'page', id: 1, type: 'alert', site: '', message: '', value: '' })
		).toBe(false);
		expect(isRemoteFileChoice({ id: 2, multiple: true, extensions: ['png'] })).toBe(true);
		expect(isRemoteFileChoice({ id: 2, multiple: true, extensions: ['.png'] })).toBe(false);
		expect(isRemoteFileChoice({ id: 2, multiple: false, extensions: null })).toBe(true);
	});
	it('turns `accept` into extensions, or none when it names what a filter cannot', () => {
		expect(acceptExtensions('.PNG, .jpg')).toEqual(['png', 'jpg']);
		expect(acceptExtensions('image/png,.gif')).toEqual(['png', 'gif']);
		expect(acceptExtensions('')).toBeNull();
		expect(acceptExtensions('application/x-thing')).toBeNull();
	});
});
describe('the machine keeps to itself (spec/remote-access-and-mobile#browser-from-device)', () => {
	it('lets a device paste its own text and not restart the machine', () => {
		expect(isSimulatorCommand({ kind: 'paste' })).toBe(true);
		expect(isSimulatorCommand({ kind: 'paste', text: 'привіт' })).toBe(true);
		expect(isSimulatorCommand({ kind: 'paste', text: '' })).toBe(false);
		expect(remoteCallRefusal('settings:restart')).toMatch(/remote device/);
		expect(remoteCallRefusal('browser:screen')).toBeNull();
	});
});

describe('R4 leftovers of the browser on a device (spec/remote-access-and-mobile#networking)', () => {
	it('makes Ctrl+click of a Windows or Linux device a ⌘+click, and leaves a Mac device alone', () => {
		expect(macMouseModifiers(2, true)).toBe(4);
		expect(macMouseModifiers(2 | 8, true)).toBe(4 | 8);
		expect(macMouseModifiers(2, false)).toBe(2);
		expect(macMouseModifiers(1, true)).toBe(1);
	});
	it('takes an IME composition and a pick only with sound fields', () => {
		expect(isBrowserScreenCommand({ kind: 'ime', tab: 'b1', text: 'にほ', start: 2, end: 2 })).toBe(
			true
		);
		expect(isBrowserScreenCommand({ kind: 'ime', tab: 'b1', text: '', start: 0, end: 0 })).toBe(
			true
		);
		expect(isBrowserScreenCommand({ kind: 'ime', tab: 'b1', text: 'ab', start: 2, end: 1 })).toBe(
			false
		);
		expect(isBrowserScreenCommand({ kind: 'ime', tab: 'b1', text: 'ab', start: 0, end: 3 })).toBe(
			false
		);
		expect(isBrowserScreenCommand({ kind: 'pick', tab: 'b1', id: 3, value: 'pear' })).toBe(true);
		expect(isBrowserScreenCommand({ kind: 'pick', tab: 'b1', id: 3, value: null })).toBe(true);
		expect(isBrowserScreenCommand({ kind: 'pick', tab: 'b1', id: 0, value: 'x' })).toBe(false);
		expect(
			isBrowserScreenCommand({ kind: 'pick', tab: 'b1', id: 1, value: 'x'.repeat(5000) })
		).toBe(false);
	});
	it('checks a picker the page reported: kind, options only for a select, bounded text and box', () => {
		const picker = {
			id: 1,
			type: 'select',
			value: 'b',
			options: [
				{ label: 'A', value: 'a', group: null, disabled: false },
				{ label: 'B', value: 'b', group: 'Fruit', disabled: true },
			],
			min: '',
			max: '',
			step: '',
			x: 10,
			y: 20,
			width: 120,
			height: 24,
		};
		expect(isBrowserPicker(picker)).toBe(true);
		expect(isBrowserPicker({ ...picker, type: 'date', options: [] })).toBe(true);
		expect(isBrowserPicker({ ...picker, type: 'date' })).toBe(false);
		expect(isBrowserPicker({ ...picker, type: 'file', options: [] })).toBe(false);
		expect(isBrowserPicker({ ...picker, extra: 1 })).toBe(false);
		expect(
			isBrowserPicker({
				...picker,
				options: Array.from({ length: 1001 }, () => picker.options[0]),
			})
		).toBe(false);
		expect(
			isBrowserPicker({ ...picker, options: [{ ...picker.options[0], label: 'x'.repeat(501) }] })
		).toBe(false);
		expect(isBrowserPicker({ ...picker, width: -1 })).toBe(false);
	});
});

describe('security review R2–R4, V3: what opens the device clipboard to a page', () => {
	const mouse = (type: 'move' | 'down' | 'up' | 'wheel') =>
		({
			kind: 'mouse',
			tab: 't',
			type,
			x: 1,
			y: 1,
			button: 'none',
			buttons: 0,
			clickCount: 0,
			modifiers: 0,
			deltaX: 0,
			deltaY: 0,
			ctrlPrimary: false,
		}) as const;
	it('a click, a key or text is the person; a pointer passing over, a start or an ack is not', () => {
		expect(isPersonGesture(mouse('down'))).toBe(true);
		expect(isPersonGesture(mouse('wheel'))).toBe(true);
		expect(isPersonGesture({ kind: 'text', tab: 't', text: 'a' })).toBe(true);
		expect(isPersonGesture({ kind: 'paste', tab: 't', text: 'a' })).toBe(true);
		expect(isPersonGesture(mouse('move'))).toBe(false);
		expect(isPersonGesture({ kind: 'ack', tab: 't', frame: 1 })).toBe(false);
		expect(isPersonGesture({ kind: 'stop', tab: 't' })).toBe(false);
	});
});
