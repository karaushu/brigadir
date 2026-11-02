import { expect, it } from 'vitest';
import type { SimulatorDevice } from '@brigadir/core';
import { pickerDevices } from './simulator-picker';
const device = (id: string, platform: SimulatorDevice['platform']): SimulatorDevice => ({
	id,
	name: id,
	platform,
	os: platform === 'ios' ? 'iOS 27' : 'Android 16',
	booted: false,
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
