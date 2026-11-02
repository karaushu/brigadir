import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { pageAgentScript, type PageAgentState } from './browser-page';

const off: PageAgentState = {
	dialogs: false,
	clipboard: false,
	pickers: false,
	next: null,
	buffer: '',
};
/** The page script in a bare window: what it reports through the binding, and the page's own globals. */
function page(state: Partial<PageAgentState>, frame: 'top' | 'cross' = 'top') {
	const reports: Record<string, unknown>[] = [];
	const proto = () => function () {}.prototype;
	const window: Record<string, any> = {
		EventTarget,
		Event,
		queueMicrotask,
		location: { hostname: 'stage.example.com', host: 'stage.example.com' },
		alert() {},
		confirm() {},
		prompt() {},
		print() {},
		addEventListener() {},
		Document: { prototype: { execCommand() {} } },
		Clipboard: { prototype: { writeText() {}, readText() {}, write() {}, read() {} } },
		HTMLInputElement: { prototype: proto() },
		HTMLSelectElement: { prototype: proto() },
		Notification: function Notification() {},
		Permissions: { prototype: { query: async () => ({ state: 'native' }) } },
		ServiceWorkerRegistration: { prototype: {} },
		__brigadirAgent: (payload: string) => reports.push(JSON.parse(payload)),
	};
	window.navigator = { permissions: window.Permissions.prototype };
	window.window = window;
	window.top =
		frame === 'top'
			? window
			: {
					get location(): never {
						throw new Error('cross-origin');
					},
				};
	const context = createContext(window);
	const run = (value: Partial<PageAgentState>) =>
		runInContext(pageAgentScript({ ...off, ...value }, 'secret'), context);
	run(state);
	const api = () => runInContext(`window[Symbol.for('brigadir.agent')]`, context);
	return { window, reports, run, api, eval: (code: string) => runInContext(code, context) };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('spec/browser-and-simulator#notifications the page’s notifications', () => {
	it('asks once on `default` and settles every request with the person’s answer', async () => {
		const tab = page({});
		expect(tab.eval('Notification.permission')).toBe('default');
		expect(tab.eval('Notification.name')).toBe('Notification');
		const first = tab.eval('Notification.requestPermission()');
		const callback: string[] = [];
		tab.window.done = (value: string) => callback.push(value);
		const second = tab.eval('Notification.requestPermission(done)');
		expect(tab.reports).toEqual([{ kind: 'notification-ask' }]);
		tab.run({ notifications: { 'stage.example.com': 'granted' } });
		expect(await first).toBe('granted');
		expect(await second).toBe('granted');
		expect(callback).toEqual(['granted']);
		expect(tab.eval('Notification.permission')).toBe('granted');
	});
	it('closes the question without an answer as `default`', async () => {
		const tab = page({});
		const asked = tab.eval('Notification.requestPermission()');
		tab.api().asked();
		expect(await asked).toBe('default');
	});
	it('shows, clicks and closes a notification of a granted domain', async () => {
		const tab = page({ notifications: { 'stage.example.com': 'granted' } });
		const note = tab.eval(
			`const note = new Notification('New order', { body: '#12', tag: 'orders' }); note.events = [];
			 note.onshow = () => note.events.push('show'); note.addEventListener('click', () => note.events.push('click'));
			 note.onclose = () => note.events.push('close'); note`
		);
		await tick();
		expect(tab.reports).toEqual([
			{ kind: 'notification', id: 1, title: 'New order', body: '#12', tag: 'orders' },
		]);
		tab.api().click(1);
		note.close();
		note.close();
		expect(note.events).toEqual(['show', 'click', 'close']);
		expect(tab.reports.at(-1)).toEqual({ kind: 'notification-close', id: 1 });
		expect(await tab.eval(`navigator.permissions.query({ name: 'notifications' })`)).toMatchObject({
			state: 'granted',
		});
		await tab.eval(
			`ServiceWorkerRegistration.prototype.showNotification('From worker', { body: 'b' })`
		);
		expect(tab.reports.at(-1)).toMatchObject({ kind: 'notification', title: 'From worker' });
	});
	it('refuses on a blocked domain without reporting', async () => {
		const tab = page({ notifications: { 'stage.example.com': 'denied' } });
		const note = tab.eval(
			`const n = new Notification('x'); n.failed = false; n.onerror = () => { n.failed = true }; n`
		);
		await tick();
		expect(note.failed).toBe(true);
		expect(await tab.eval('Notification.requestPermission()')).toBe('denied');
		await expect(
			tab.eval(`ServiceWorkerRegistration.prototype.showNotification('x')`)
		).rejects.toThrow();
		expect(tab.reports).toEqual([]);
		expect(await tab.eval(`navigator.permissions.query({ name: 'notifications' })`)).toMatchObject({
			state: 'denied',
		});
		expect(await tab.eval(`navigator.permissions.query({ name: 'camera' })`)).toEqual({
			state: 'native',
		});
	});
	it('gives another site’s frame `denied`, as Chrome does', async () => {
		const tab = page({ notifications: { 'stage.example.com': 'granted' } }, 'cross');
		expect(tab.eval('Notification.permission')).toBe('denied');
		expect(await tab.eval('Notification.requestPermission()')).toBe('denied');
		expect(tab.reports).toEqual([]);
	});
});
