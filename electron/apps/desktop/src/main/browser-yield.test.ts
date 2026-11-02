import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import { PersonInput } from './browser-yield';
/** A WebContents for the tracker: its input events and nothing else. */
function page() {
	const web = new EventEmitter() as unknown as WebContents & EventEmitter;
	(web as unknown as { isDestroyed(): boolean }).isDestroyed = () => false;
	return web;
}
describe('the agent yields to the person (spec/task-window-workspace#work-area.1)', () => {
	it('holds while the person types or holds a button; scroll and hover do not hold', () => {
		let now = 10_000;
		const input = new PersonInput(1500, 10_000, () => now),
			web = page();
		input.watch(web);
		web.emit('input-event', {}, { type: 'mouseWheel' });
		web.emit('input-event', {}, { type: 'mouseMove' });
		expect(input.busy(web)).toBe(false);
		web.emit('input-event', {}, { type: 'char' });
		expect(input.busy(web)).toBe(true);
		now += 1499;
		expect(input.busy(web)).toBe(true);
		now += 1;
		expect(input.busy(web)).toBe(false);
		web.emit('input-event', {}, { type: 'mouseDown' });
		now += 5000;
		expect(input.busy(web)).toBe(true);
		web.emit('input-event', {}, { type: 'mouseUp' });
		now += 1500;
		expect(input.busy(web)).toBe(false);
	});
	it("ignores the agent's own input", async () => {
		const input = new PersonInput(),
			web = page();
		input.watch(web);
		await input.agent(web, async () => {
			web.emit('input-event', {}, { type: 'keyDown' });
		});
		expect(input.busy(web)).toBe(false);
	});
	it('waits for 1.5 s of quiet, and gives up after 10 s of input', async () => {
		let now = 10_000;
		const input = new PersonInput(1500, 10_000, () => now),
			web = page();
		input.watch(web);
		expect(await input.settle(web, () => {})).toBe('ready');
		web.emit('input-event', {}, { type: 'keyDown' });
		const states: boolean[] = [];
		const waiting = input.settle(web, (value) => states.push(value));
		now += 1600;
		expect(await waiting).toBe('waited');
		expect(states).toEqual([true, false]);
		now += 5000;
		web.emit('input-event', {}, { type: 'mouseDown' });
		const held = input.settle(web, () => {});
		now += 10_000;
		expect(await held).toBe('busy');
	});
});
