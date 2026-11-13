import { expect, it } from 'vitest';
import type { AgentTask, SimulatorDevice, SimulatorState } from '@brigadir/core';
import { pickerDevices, pickerModel } from './simulator-picker';
const device = (
	id: string,
	platform: SimulatorDevice['platform'],
	booted = false
): SimulatorDevice => ({
	id,
	name: id,
	platform,
	os: platform === 'ios' ? 'iOS 27' : 'Android 16',
	booted,
});
it('puts iOS devices first and groups only when both platforms are listed', () => {
	const mixed = pickerDevices([
		device('pixel', 'android'),
		device('iphone', 'ios'),
		device('air', 'ios'),
	]);
	expect(mixed.devices.map((item) => item.id)).toEqual(['iphone', 'air', 'pixel']);
	expect(mixed.grouped).toBe(true);
	expect(pickerDevices([device('iphone', 'ios'), device('air', 'ios')]).grouped).toBe(false);
	expect(pickerDevices([]).grouped).toBe(false);
});
const tasks = [
	{ projectId: 'p', id: 'me', title: 'Details screen' },
	{ projectId: 'p', id: 'flows', title: 'Client flows' },
	{ projectId: 'p', id: 'other', title: 'Other' },
] as AgentTask[];
const state = (patch: Partial<SimulatorState>): SimulatorState => ({
	toolchain: { xcode: 'Xcode 27', android: null, ios: true },
	devices: [
		device('iPhone 17 Pro', 'ios', true),
		device('iPhone 17', 'ios', true),
		device('iPhone Air', 'ios'),
		device('iPad Pro', 'ios'),
	],
	device: device('iPhone 17 Pro', 'ios', true),
	status: 'on',
	error: null,
	screen: { width: 402, height: 874 },
	orientation: 'portrait',
	metro: null,
	uses: {
		'iPhone 17 Pro': { kind: 'mine' },
		'iPhone 17': { kind: 'task', task: { projectId: 'p', id: 'flows' } },
		'iPad Pro': { kind: 'tasks', count: 2 },
	},
	gate: { running: 2, max: 3, lowMemory: false },
	metroPort: null,
	...patch,
});
it('ends each row with who holds the device, and offers Shut down only for a device nobody else holds (spec/browser-and-simulator#sim-tab)', () => {
	const model = pickerModel(state({}), 'en', tasks, false);
	expect(
		model.rows.map(
			(row) =>
				`${row.device.id}: ${row.tail}${row.disabled ? ' (off)' : ''}${row.canShutDown ? ' ⏻' : ''}`
		)
	).toEqual([
		'iPhone 17 Pro: this task ⏻',
		'iPhone 17: Client flows',
		'iPhone Air: iOS 27',
		'iPad Pro: 2 tasks',
	]);
	expect(model.trigger).toBe('iPhone 17 Pro · iOS 27');
	expect(model.footer).toBe(null);
	// Ukrainian: the same tails in its own words.
	expect(pickerModel(state({}), 'uk', tasks, false).rows.map((row) => row.tail)).toEqual([
		'ця задача',
		'Client flows',
		'iOS 27',
		'2 задачі',
	]);
});
it('shows the task waiting for its device in the trigger and the row (spec/browser-and-simulator#sim-tab)', () => {
	const model = pickerModel(
		state({
			device: device('iPhone 17', 'ios', true),
			uses: { 'iPhone 17': { kind: 'queued', holder: { projectId: 'p', id: 'flows' } } },
		}),
		'en',
		tasks,
		false
	);
	expect(model.queued).toBe(true);
	expect(model.trigger).toBe('iPhone 17 · waits for Client flows');
	expect(model.rows[1]!.tail).toBe('queued');
	expect(
		pickerModel(
			state({
				uses: { 'iPhone 17': { kind: 'queued', holder: { projectId: 'p', id: 'flows' } } },
				device: device('iPhone 17', 'ios', true),
			}),
			'uk',
			tasks,
			false
		).trigger
	).toBe('iPhone 17 · чекає на Client flows');
});
it('disables devices that are off at the cap and under low memory; Start anyway lifts only low memory (spec/browser-and-simulator#sim-cap)', () => {
	const cap = pickerModel(
		state({ gate: { running: 2, max: 2, lowMemory: true } }),
		'en',
		tasks,
		true
	);
	expect(cap.footer).toEqual({ text: '2 of 2 devices run.' });
	expect(cap.rows.filter((row) => row.disabled).map((row) => row.device.id)).toEqual([
		'iPhone Air',
		'iPad Pro',
	]);
	expect(
		pickerModel(state({ gate: { running: 2, max: 2, lowMemory: false } }), 'uk', tasks, false)
			.footer
	).toEqual({
		text: 'Працює 2 з 2 пристроїв.',
	});
	const low = pickerModel(
		state({ gate: { running: 2, max: 3, lowMemory: true } }),
		'en',
		tasks,
		false
	);
	expect(low.footer).toEqual({
		text: 'Memory is low. New devices are off.',
		tone: 'warning',
		lift: true,
	});
	expect(low.rows.filter((row) => row.disabled)).toHaveLength(2);
	const lifted = pickerModel(
		state({ gate: { running: 2, max: 3, lowMemory: true } }),
		'en',
		tasks,
		true
	);
	expect(lifted.footer).toEqual({ text: 'Memory is low.', tone: 'warning' });
	expect(lifted.rows.some((row) => row.disabled)).toBe(false);
});
