import type { SimulatorDevice } from '@brigadir/core';
/** spec/browser-and-simulator#simulator: the device picker lists iOS first, then Android; headers only when both platforms are there. */
export function pickerDevices(devices: readonly SimulatorDevice[]) {
	const ordered = [...devices].sort(
		(a, b) => Number(a.platform !== 'ios') - Number(b.platform !== 'ios')
	);
	return { devices: ordered, grouped: new Set(ordered.map((item) => item.platform)).size > 1 };
}
