import { describe, expect, it, vi } from 'vitest';
import { replacesDocument, TerminalWatchers } from './terminal-watchers';

describe('TerminalWatchers (spec/remote-access-and-mobile#phone-task-tools)', () => {
	it('lets an unwatch reach the host only when nobody else watches', () => {
		const watchers = new TerminalWatchers();
		watchers.watch('p/t', 'run-1', 'local');
		watchers.watch('p/t', 'run-1', 'phone');
		expect(watchers.unwatch('p/t', 'run-1', 'phone')).toBe(false);
		expect(watchers.unwatch('p/t', 'run-1', 'local')).toBe(true);
		// Nobody watched it here (an older window, a reload): the host lets go, as before.
		expect(watchers.unwatch('p/t', 'run-2', 'local')).toBe(true);
	});
	it('releases what a client that went away watched alone', () => {
		const watchers = new TerminalWatchers();
		watchers.watch('p/t', 'a', 'phone');
		watchers.watch('p/t', 'b', 'phone');
		watchers.watch('p/t', 'b', 'local');
		expect(watchers.forget('phone')).toEqual([{ task: 'p/t', id: 'a' }]);
		expect(watchers.unwatch('p/t', 'b', 'local')).toBe(true);
		watchers.watch('p/t', 'c', 'phone');
		watchers.closed('p/t', 'c');
		expect(watchers.forget('phone')).toEqual([]);
	});
	it('counts nobody for a read the host refused (security review W2)', async () => {
		const watchers = new TerminalWatchers();
		const refused = () => Promise.reject(new Error('Host is not connected'));
		for (let index = 0; index < 50; index++)
			await watchers
				.command('p/t', { kind: 'read', id: `x${index}` }, 'phone', refused)
				.catch(() => {});
		await watchers.command('p/t', { kind: 'read', id: 'live' }, 'phone', () => Promise.resolve({}));
		expect(watchers.forget('phone')).toEqual([{ task: 'p/t', id: 'live' }]);
		// An unwatch another client still needs never reaches the host.
		const run = vi.fn(() => Promise.resolve(null));
		watchers.watch('p/t', 'a', 'local');
		watchers.watch('p/t', 'a', 'phone');
		await watchers.command('p/t', { kind: 'unwatch', id: 'a' }, 'phone', run);
		expect(run).not.toHaveBeenCalled();
		await watchers.command('p/t', { kind: 'unwatch', id: 'a' }, 'local', run);
		expect(run).toHaveBeenCalledTimes(1);
	});
	it('keeps what a phone watches when the machine’s window reloads (spec/remote-access-and-mobile#outbox, review W2 J3)', () => {
		const watchers = new TerminalWatchers();
		watchers.watch('p/t', 'shared', 'local');
		watchers.watch('p/t', 'shared', 'phone');
		watchers.watch('p/t', 'window', 'local');
		// The window's renderer went away: it lets go of its own, the phone's watch stays and is not unwatched on the host.
		watchers.forget('local');
		expect(watchers.watched('p/t', 'shared')).toBe(true);
		expect(watchers.watched('p/t', 'window')).toBe(false);
		expect(watchers.watched('p/t', 'never')).toBe(false);
	});
	it('lets the window go only when a reload replaces its page, not on a refused navigation (spec/terminal-and-cli-agents#pty-host)', () => {
		const page = 'file:///app/out/renderer/index.html#workspace';
		expect(replacesDocument(page, page)).toBe(true);
		expect(replacesDocument(page, 'file:///app/out/renderer/index.html#task')).toBe(true);
		expect(replacesDocument('http://localhost:5173/#workspace', 'http://localhost:5173/')).toBe(
			true
		);
		// A link without its own handler, a dropped file: `will-navigate` refuses them, the page stays.
		expect(replacesDocument(page, 'https://github.com/org/repo/pull/125')).toBe(false);
		expect(replacesDocument(page, 'file:///Users/me/notes.md')).toBe(false);
		// The first load has no page to let go of.
		expect(replacesDocument('', page)).toBe(false);
	});
});
