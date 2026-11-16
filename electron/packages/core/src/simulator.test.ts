import { expect, it } from 'vitest';
import {
	devicePoint,
	gateOpen,
	hidUsage,
	isProjectSimulator,
	isSimulatorCommand,
	matchDevices,
	orientationAngle,
	simulatorLeases,
	type SimulatorDevice,
} from './simulator';
import { isSimulatorAgentCommand } from './simulator-agent';
import { isSessionCommand, isSessionEvent } from './index';
import { ipcTable } from './ipc-channels';
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

it('reads lease records leniently: a bad entry goes, the others and old documents stay (spec/browser-and-simulator#sim-lease)', () => {
	expect(
		simulatorLeases({
			solo: { platform: 'ios', device: 'AAAA-1' },
			worker: { platform: 'ios', device: 'COPY', own: { source: 'AAAA-1', reinstalled: false } },
			// A copy its task left, kept until it is deleted.
			'worker.OLD-COPY-1': {
				platform: 'ios',
				device: 'OLD-COPY-1',
				own: { source: 'AAAA-1', reinstalled: true },
			},
			port: { metroPort: 8084 },
			half: { platform: 'ios' },
			path: { platform: 'ios', device: '../etc' },
			extra: { platform: 'ios', device: 'X', color: 'red' },
			'bad id!': { platform: 'ios', device: 'X' },
		})
	).toEqual({
		solo: { platform: 'ios', device: 'AAAA-1' },
		worker: { platform: 'ios', device: 'COPY', own: { source: 'AAAA-1', reinstalled: false } },
		'worker.OLD-COPY-1': {
			platform: 'ios',
			device: 'OLD-COPY-1',
			own: { source: 'AAAA-1', reinstalled: true },
		},
	});
	expect(simulatorLeases(undefined)).toEqual({});
	// project.json keeps its old `simulator` shape: the project's device.
	expect(isProjectSimulator({ platform: 'ios', device: 'AAAA-1' })).toBe(true);
});
it('matches a device by id, name, kind or part of the name, running and newer first (spec/browser-and-simulator#sim-lease)', () => {
	const devices: SimulatorDevice[] = [
		{ id: 'A', name: 'iPhone 17 Pro', platform: 'ios', os: 'iOS 27', booted: false },
		{ id: 'B', name: 'iPhone 16', platform: 'ios', os: 'iOS 26.5', booted: true },
		{ id: 'C', name: 'iPad Air 11-inch (M4)', platform: 'ios', os: 'iOS 27', booted: false },
		{ id: 'D', name: 'Pixel 9 Pro', platform: 'android', os: 'Android 16', booted: false },
		{ id: 'E', name: 'iPhone 17 Pro', platform: 'ios', os: 'iOS 26.5', booted: false },
	];
	const ids = (wanted: string) => matchDevices(devices, wanted).map((item) => item.id);
	expect(ids('E')).toEqual(['E']);
	expect(ids('iphone 17 pro')).toEqual(['A', 'E']);
	expect(ids('iPhone')).toEqual(['B', 'A', 'E']);
	expect(ids('iPad')).toEqual(['C']);
	expect(ids('Android')).toEqual(['D']);
	expect(ids('pixel')).toEqual(['D']);
	expect(ids('Galaxy')).toEqual([]);
	expect(ids('  ')).toEqual([]);
});
it('opens the gate under the cap without memory pressure; the person lifts only low memory (spec/browser-and-simulator#sim-cap)', () => {
	expect(gateOpen({ running: 1, max: 2, lowMemory: false })).toBe(true);
	expect(gateOpen({ running: 2, max: 2, lowMemory: false })).toBe(false);
	expect(gateOpen({ running: 1, max: 2, lowMemory: true })).toBe(false);
	expect(gateOpen({ running: 1, max: 2, lowMemory: true }, true)).toBe(true);
	expect(gateOpen({ running: 2, max: 2, lowMemory: true }, true)).toBe(false);
});
it('takes `device` on every simulator tool and `anyway` only on boot (spec/browser-and-simulator#sim-tools)', () => {
	for (const tool of ['state', 'open', 'ui', 'screenshot', 'logs', 'network'])
		expect(isSimulatorAgentCommand({ tool, device: 'iPad' })).toBe(true);
	expect(
		isSimulatorAgentCommand({ tool: 'act', action: 'tap', x: 1, y: 2, device: 'Pixel 9' })
	).toBe(true);
	expect(isSimulatorAgentCommand({ tool: 'wait', text: 'Saved', device: 'iPhone' })).toBe(true);
	expect(isSimulatorAgentCommand({ tool: 'ui', device: '' })).toBe(false);
	expect(isSimulatorAgentCommand({ tool: 'ui', device: 'x'.repeat(129) })).toBe(false);
	expect(isSimulatorCommand({ kind: 'boot', anyway: true })).toBe(true);
	expect(isSimulatorCommand({ kind: 'boot', anyway: false })).toBe(false);
	expect(isSimulatorCommand({ kind: 'boot' })).toBe(true);
});
it('journals the device row as its own event kind; only main sends it (spec/browser-and-simulator#sim-chat-row)', () => {
	expect(
		isSessionEvent({
			kind: 'simulator.device',
			device: 'iPhone Air',
			metroPort: null,
			lowMemory: true,
		})
	).toBe(true);
	expect(
		isSessionEvent({
			kind: 'simulator.device',
			device: 'iPhone Air',
			metroPort: 8083,
			lowMemory: false,
		})
	).toBe(true);
	expect(
		isSessionEvent({ kind: 'simulator.device', device: '', metroPort: null, lowMemory: false })
	).toBe(false);
	expect(
		isSessionEvent({ kind: 'simulator.device', device: 'iPhone', metroPort: 0, lowMemory: false })
	).toBe(false);
	expect(
		isSessionCommand({ kind: 'recordDevice', device: 'iPhone', metroPort: null, lowMemory: false })
	).toBe(true);
	expect(isSessionCommand({ kind: 'recordDevice', device: 'iPhone', metroPort: null })).toBe(false);
});
it('lets a window send a task key with its simulator commands, never the device row (spec/browser-and-simulator#sim-lease)', () => {
	const key = { projectId: 'project', id: 'task' };
	expect(ipcTable.simulatorCommand.validate([key, { kind: 'state' }])).toBe(true);
	expect(ipcTable.simulatorCommand.validate(['project', { kind: 'state' }])).toBe(false);
	expect(
		ipcTable.sendCommand.validate([
			key,
			{ kind: 'recordDevice', device: 'iPhone', metroPort: null, lowMemory: false },
		])
	).toBe(false);
});
