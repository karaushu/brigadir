import { browserFreezeMs } from '@brigadir/core';
/**
 * The agent's interval per view: it starts at each agent call and ends `ms` after the last one. While it runs, a hidden
 * view stays live and the page's dialogs answer to the agent; when it ends, `expire` freezes a hidden view.
 */
export class BrowserAgentClock {
	private until = new Map<string, number>();
	private timers = new Map<string, ReturnType<typeof setTimeout>>();
	constructor(
		private expire: (id: string) => void,
		readonly ms = browserFreezeMs
	) {}
	touch(id: string) {
		this.clear(id);
		this.until.set(id, Date.now() + this.ms);
		this.timers.set(
			id,
			setTimeout(() => {
				this.timers.delete(id);
				this.until.delete(id);
				this.expire(id);
			}, this.ms)
		);
	}
	active(id: string) {
		return (this.until.get(id) ?? 0) > Date.now();
	}
	clear(id: string) {
		const timer = this.timers.get(id);
		if (timer) clearTimeout(timer);
		this.timers.delete(id);
		this.until.delete(id);
	}
	dispose() {
		for (const id of [...this.timers.keys()]) this.clear(id);
	}
}
