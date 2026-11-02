import { expect, it, vi } from 'vitest';
import { canTakeFocus, focusLost, restoreFocus, whenEnabled } from './keep-focus';

/** A control with a disabled state and an inert ancestor; `focus()` succeeds only when the browser would allow it. */
function control(doc: { activeElement: unknown; body: unknown }) {
	const node = {
		isConnected: true,
		disabled: false,
		inert: false,
		matches: (selector: string) => selector === ':disabled' && node.disabled,
		closest: (selector: string) => (selector === '[inert]' && node.inert ? {} : null),
		focus: vi.fn(() => {
			if (canTakeFocus(node)) doc.activeElement = node;
		}),
	};
	return node;
}
const page = () => {
	const body = {};
	return { body, activeElement: body as unknown };
};

it('gives focus back to the control that started a save once the form is enabled again (spec/settings-modules-and-onboarding#module-settings-popup)', () => {
	const doc = page(),
		trigger = control(doc);
	// The save disabled the fieldset: the browser dropped focus to <body>.
	trigger.disabled = true;
	expect(restoreFocus(trigger, doc)).toBe(false);
	expect(trigger.focus).not.toHaveBeenCalled();
	trigger.disabled = false;
	expect(restoreFocus(trigger, doc)).toBe(true);
	expect(doc.activeElement).toBe(trigger);
	expect(trigger.focus).toHaveBeenCalledWith({ preventScroll: true });
});

it('leaves focus that moved elsewhere on purpose, and skips a control gone or in a closing popover', () => {
	const doc = page(),
		trigger = control(doc),
		other = control(doc);
	doc.activeElement = other;
	expect(focusLost(doc)).toBe(false);
	expect(restoreFocus(trigger, doc)).toBe(false);
	expect(doc.activeElement).toBe(other);

	doc.activeElement = null;
	expect(focusLost(doc)).toBe(true);
	trigger.inert = true;
	expect(restoreFocus(trigger, doc)).toBe(false);
	trigger.inert = false;
	trigger.isConnected = false;
	expect(restoreFocus(trigger, doc)).toBe(false);
	expect(restoreFocus(null, doc)).toBe(false);
	expect(trigger.focus).not.toHaveBeenCalled();
});

it('a popover returning focus to a trigger disabled by a save waits until it is enabled', () => {
	vi.useFakeTimers();
	try {
		const doc = page(),
			trigger = control(doc);
		let notify = () => {};
		const disconnect = vi.fn();
		class Observer {
			constructor(callback: () => void) {
				notify = callback;
			}
			observe() {}
			disconnect = disconnect;
		}
		trigger.disabled = true;
		const then = vi.fn();
		whenEnabled(trigger, then, { root: {} as Node, Observer });
		notify();
		expect(then).not.toHaveBeenCalled();
		trigger.disabled = false;
		notify();
		expect(then).toHaveBeenCalledTimes(1);
		expect(disconnect).toHaveBeenCalled();

		// A trigger that never comes back is given up after the limit.
		const late = vi.fn();
		disconnect.mockClear();
		trigger.disabled = true;
		whenEnabled(trigger, late, { root: {} as Node, Observer, limit: 1000 });
		vi.advanceTimersByTime(1000);
		expect(disconnect).toHaveBeenCalled();
		expect(late).not.toHaveBeenCalled();
	} finally {
		vi.useRealTimers();
	}
});
