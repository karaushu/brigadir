/**
 * spec/remote-access-and-mobile#phone-task-tools: who watches which terminal's output. The host keeps one watch set per task, so one client's `unwatch` (a
 * phone that closed the terminal) would stop the output another still shows (the computer's panel). Main counts watchers
 * by client and lets an `unwatch` reach the host only when nobody else watches; a client that went away lets go of its own.
 */
import type { TerminalCommand } from '@brigadir/core';
export class TerminalWatchers {
	private readonly watchers = new Map<string, Set<string>>();
	/**
	 * A client's terminal command on its way to the host (`run`), with the watchers counted: an `unwatch` another client still
	 * needs stays here (null), a `close` forgets the terminal, a `read` counts the client. A `read` the host refuses (no host,
	 * no such terminal) counts nobody — otherwise each id a client tries would stay here until it disconnects (security
	 * review W2).
	 */
	command<T>(
		task: string,
		command: TerminalCommand,
		client: string,
		run: () => Promise<T>
	): Promise<T | null> {
		if (command.kind === 'unwatch' && !this.unwatch(task, command.id, client))
			return Promise.resolve(null);
		if (command.kind === 'close') this.closed(task, command.id);
		const result = run();
		if (command.kind === 'read') {
			const id = command.id;
			this.watch(task, id, client);
			result.catch(() => this.unwatch(task, id, client));
		}
		return result;
	}
	private static key(task: string, id: string) {
		return `${task}\0${id}`;
	}
	watch(task: string, id: string, client: string) {
		const key = TerminalWatchers.key(task, id);
		const set = this.watchers.get(key) ?? new Set<string>();
		set.add(client);
		this.watchers.set(key, set);
	}
	/** The client lets go; true when nobody watches any more and the host may stop sending. */
	unwatch(task: string, id: string, client: string): boolean {
		const key = TerminalWatchers.key(task, id),
			set = this.watchers.get(key);
		set?.delete(client);
		if (set?.size) return false;
		this.watchers.delete(key);
		return true;
	}
	/** Somebody still watches this output (spec/remote-access-and-mobile#outbox: the window reloaded, a phone still shows it). */
	watched(task: string, id: string): boolean {
		return Boolean(this.watchers.get(TerminalWatchers.key(task, id))?.size);
	}
	/** The terminal closed: nobody watches it. */
	closed(task: string, id: string) {
		this.watchers.delete(TerminalWatchers.key(task, id));
	}
	/** A client went away: the outputs it alone watched, for the host to stop. */
	forget(client: string): { task: string; id: string }[] {
		const released: { task: string; id: string }[] = [];
		for (const [key, set] of this.watchers) {
			if (!set.delete(client) || set.size) continue;
			this.watchers.delete(key);
			const [task, id] = key.split('\0') as [string, string];
			released.push({ task, id });
		}
		return released;
	}
}
/**
 * spec/terminal-and-cli-agents#pty-host: a main-frame navigation replaces the window's document only as a reload of its own address; `will-navigate`
 * refuses every other one, yet Electron reports it as started first. The hash is the route, not the document.
 */
export function replacesDocument(current: string, next: string): boolean {
	const page = (url: string) => url.split('#')[0];
	return current !== '' && page(current) === page(next);
}
