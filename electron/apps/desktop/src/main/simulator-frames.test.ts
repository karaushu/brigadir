import { describe, expect, it } from 'vitest';
import { SimulatorFrames } from './simulator-frames';
import type { Client } from './clients';

const frame = (key: boolean) => ({ key, timestamp: 1, data: new Uint8Array([1]) });
describe('simulator frames to a device (spec/remote-access-and-mobile#browser-from-device)', () => {
	it('after a missed frame sends no delta until a key frame, and asks for one at most once a second', () => {
		let now = 0,
			room = true;
		const got: boolean[] = [],
			asked: string[] = [];
		const device = {
			id: 'remote:1',
			local: false,
			device: { id: 'd', name: 'ThinkPad' },
			send: (_channel: string, value: { key: boolean }, droppable?: boolean) => {
				expect(droppable).toBe(true);
				if (!room) return false;
				got.push(value.key);
				return true;
			},
			owns: () => false,
		} as unknown as Client;
		const frames = new SimulatorFrames(
			{ each: (_channel, run) => run(device) },
			(projectId) => asked.push(projectId),
			() => now
		);
		frames.frame('p', frame(true));
		frames.frame('p', frame(false));
		room = false;
		frames.frame('p', frame(false));
		frames.frame('p', frame(false));
		expect(asked).toEqual(['p']);
		room = true;
		frames.frame('p', frame(false));
		now = 1500;
		room = false;
		frames.frame('p', frame(true));
		expect(asked).toEqual(['p', 'p']);
		room = true;
		frames.frame('p', frame(false));
		frames.frame('p', frame(true));
		frames.frame('p', frame(false));
		expect(got).toEqual([true, false, true, false]);
	});
	it('ignores a window that is gone', () => {
		const asked: string[] = [];
		const window = { id: 'local', local: true, send: () => false, owns: () => false } as Client;
		const frames = new SimulatorFrames({ each: (_channel, run) => run(window) }, (id) =>
			asked.push(id)
		);
		frames.frame('p', frame(false));
		expect(asked).toEqual([]);
	});
});
