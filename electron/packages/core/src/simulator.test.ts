import { expect, it } from 'vitest';
import {
	devicePoint,
	hidUsage,
	isProjectSimulator,
	isSimulatorCommand,
	orientationAngle,
} from './simulator';
it('accepts only the simulator commands the column and the agent send (spec/browser-and-simulator#simulator)', () => {
	for (const command of [
		{ kind: 'state' },
		{ kind: 'boot' },
		{ kind: 'shutdown' },
		{ kind: 'shutdown', device: 'Pixel_9_Pro' },
		{ kind: 'paste' },
		{ kind: 'select', device: '4900CF11-BDEA-4EC2-BE33-11CE51B20141' },
		{ kind: 'watch', on: true },
		{ kind: 'touch', phase: 'move', x: 0, y: 1 },
		{ kind: 'key', usage: 4, down: true },
		{ kind: 'button', name: 'home' },
		{ kind: 'text', text: 'wifi' },
	])
		expect(isSimulatorCommand(command), JSON.stringify(command)).toBe(true);
	for (const command of [
		{ kind: 'state', extra: 1 },
		{ kind: 'select', device: '../x' },
		{ kind: 'shutdown', device: '../x' },
		{ kind: 'shutdown', text: 'x' },
		{ kind: 'touch', phase: 'down', x: 1.2, y: 0 },
		{ kind: 'touch', phase: 'tap', x: 0, y: 0 },
		{ kind: 'key', usage: -1, down: true },
		{ kind: 'button', name: 'power' },
		{ kind: 'text', text: '' },
		{ kind: 'shell' },
	])
		expect(isSimulatorCommand(command), JSON.stringify(command)).toBe(false);
	expect(isProjectSimulator({ platform: 'ios', device: 'AAAA-1' })).toBe(true);
	expect(isProjectSimulator({ platform: 'tvos', device: 'AAAA-1' })).toBe(false);
});
it('maps physical keys to USB HID usages', () => {
	expect(hidUsage('KeyA')).toBe(0x04);
	expect(hidUsage('KeyZ')).toBe(0x1d);
	expect(hidUsage('Digit1')).toBe(0x1e);
	expect(hidUsage('Digit0')).toBe(0x27);
	expect(hidUsage('Enter')).toBe(0x28);
	expect(hidUsage('ShiftLeft')).toBe(0xe1);
	expect(hidUsage('MetaRight')).toBe(0xe7);
	expect(hidUsage('F13')).toBeNull();
});
it('turns an interface point into the device frame the way the iOS frame lies (probe on iPhone 17, Xcode 27)', () => {
	// Bookmarks at interface (150, 32) of 874×402 in landscapeLeft opened the sheet at device (1−32/402, 150/874).
	expect(devicePoint('landscapeLeft', 150 / 874, 32 / 402)).toEqual({
		x: 1 - 32 / 402,
		y: 150 / 874,
	});
	expect(devicePoint('landscapeRight', 814 / 874, 46 / 402)).toEqual({
		x: 46 / 402,
		y: 1 - 814 / 874,
	});
	expect(devicePoint('portraitUpsideDown', 0.25, 0.1)).toEqual({ x: 0.75, y: 0.9 });
	expect(devicePoint('portrait', 0.3, 0.4)).toEqual({ x: 0.3, y: 0.4 });
	expect([
		orientationAngle('portrait'),
		orientationAngle('landscapeLeft'),
		orientationAngle('landscapeRight'),
		orientationAngle('portraitUpsideDown'),
	]).toEqual([0, -90, 90, 180]);
});
