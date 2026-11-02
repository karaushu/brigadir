export function isTrustedUrl(candidate: string, entry: string, development: boolean): boolean {
	try {
		const actual = new URL(candidate);
		const expected = new URL(entry);
		if (development)
			return actual.origin === expected.origin && actual.pathname === expected.pathname;
		actual.hash = '';
		expected.hash = '';
		return actual.href === expected.href;
	} catch {
		return false;
	}
}

export type Sender = { mainFrame: { url: string } };
export type ReadEvent = { sender: Sender; senderFrame: { url: string } | null };
/** Object identity binds the request to our window and its top frame, on the entry URL. */
export function isTrustedSender(
	event: ReadEvent,
	sender: Sender | undefined,
	entry: string,
	development: boolean
): boolean {
	return Boolean(
		sender &&
		event.sender === sender &&
		event.senderFrame &&
		event.senderFrame === sender.mainFrame &&
		isTrustedUrl(event.senderFrame.url, entry, development)
	);
}
/** Validate before touching storage. */
export function guardedRead(
	event: ReadEvent,
	args: unknown[],
	sender: Sender | undefined,
	entry: string,
	development: boolean,
	read: () => unknown
): unknown {
	if (!isTrustedSender(event, sender, entry, development) || args.length !== 0)
		throw new Error('Invalid IPC request');
	return read();
}
