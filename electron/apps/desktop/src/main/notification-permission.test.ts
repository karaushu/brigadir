import { it, expect } from 'vitest';
import { NotificationPermissionState } from './notification-permission';
function source(initial: string, answer: string) {
	const calls = { status: 0, request: 0 };
	let value = initial;
	return {
		calls,
		source: {
			status: async () => {
				calls.status++;
				return value;
			},
			request: async () => {
				calls.request++;
				value = answer;
				return value;
			},
		},
	};
}
it('asks macOS only while undecided and reports every change once', async () => {
	const fake = source('not-determined', 'granted'),
		changes: string[] = [];
	const state = new NotificationPermissionState(fake.source, (value) => changes.push(value));
	expect(await state.ensure()).toBe(true);
	expect(fake.calls.request).toBe(1);
	expect(await state.ensure()).toBe(true);
	expect(fake.calls.request).toBe(1);
	expect(changes).toEqual(['not-determined', 'granted']);
});
it('never shows after a refusal and never asks again; the app cannot re-prompt a denied bundle', async () => {
	const fake = source('not-determined', 'denied'),
		state = new NotificationPermissionState(fake.source, () => {});
	expect(await state.ensure()).toBe(false);
	expect(await state.ensure()).toBe(false);
	expect(fake.calls.request).toBe(1);
	expect(state.current).toBe('denied');
});
it('treats a missing addon or an unreadable answer as unknown and lets delivery proceed', async () => {
	expect(await new NotificationPermissionState(null, () => {}).ensure()).toBe(true);
	const broken = new NotificationPermissionState(
		{
			status: async () => 'provisional',
			request: async () => {
				throw new Error('no');
			},
		},
		() => {}
	);
	expect(await broken.refresh()).toBe('unknown');
	expect(await broken.ensure()).toBe(true);
});
it('shares one read while it is in flight', async () => {
	const fake = source('granted', 'granted'),
		state = new NotificationPermissionState(fake.source, () => {});
	await Promise.all([state.refresh(), state.refresh(), state.refresh()]);
	expect(fake.calls.status).toBe(1);
});
