import { expect, it, vi } from 'vitest';
import { guardedRead, isTrustedUrl } from './trusted-sender';
it('accepts only the packaged entry with an optional route hash', () => {
	const entry = 'file:///app/out/index.html';
	expect(isTrustedUrl(`${entry}#kit`, entry, false)).toBe(true);
	for (const candidate of [
		'file:///app/out/other.html',
		`${entry}?injected=1`,
		'https://example.com',
		'about:blank',
	]) {
		expect(isTrustedUrl(candidate, entry, false)).toBe(false);
	}
});
it('rejects foreign windows, subframes, detached frames, navigation and extra arguments before reading', () => {
	const entry = 'file:///app/out/index.html';
	const sender = { mainFrame: { url: entry } };
	const event = { sender, senderFrame: sender.mainFrame };
	const read = vi.fn(() => 'snapshot');
	const foreign = { mainFrame: { url: entry } };
	for (const [candidate, args, owner] of [
		[{ sender: foreign, senderFrame: foreign.mainFrame }, [], sender],
		[{ sender, senderFrame: { url: entry } }, [], sender],
		[{ sender, senderFrame: null }, [], sender],
		[event, ['/etc/passwd'], sender],
		[event, [undefined], sender],
		[event, [], undefined],
	] as const)
		expect(() => guardedRead(candidate, [...args], owner, entry, false, read)).toThrow(
			'Invalid IPC request'
		);
	sender.mainFrame.url = 'https://example.com';
	expect(() => guardedRead(event, [], sender, entry, false, read)).toThrow();
	expect(read).not.toHaveBeenCalled();
	sender.mainFrame.url = `${entry}#kit`;
	expect(guardedRead(event, [], sender, entry, false, read)).toBe('snapshot');
	expect(read).toHaveBeenCalledTimes(1);
});
it('requires the exact development origin and entry path', () => {
	const entry = 'http://localhost:5173/';
	expect(isTrustedUrl(`${entry}#workspace`, entry, true)).toBe(true);
	expect(isTrustedUrl('http://localhost:5174/', entry, true)).toBe(false);
	expect(isTrustedUrl('http://localhost:5173.evil.test/', entry, true)).toBe(false);
	expect(isTrustedUrl(`${entry}other`, entry, true)).toBe(false);
});
