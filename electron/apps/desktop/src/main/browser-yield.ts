import type { WebContents } from 'electron';
/**
 * spec/task-window-workspace#work-area.1: the person and the agent on one page — the agent yields for a moment. The agent's mouse goes through
 * CDP and never moves the person's pointer; only focus and typing clash. While the person types in the agent's tab or
 * holds a mouse button (a selection, a drag), the agent's next action waits for `quiet` ms without such input; scrolling
 * and hovering do not hold it. Input that goes on without a pause for `limit` ms gives the action back to the agent.
 */
export const yieldQuiet = 1500,
	yieldLimit = 10_000;
type Watch = {
	/** The last key or button event of the person, ms. */ at: number;
	/** When the current streak of input began; a pause of `quiet` ends a streak. */ since: number;
	/** A mouse button is down now. */ held: boolean;
	/** The agent's own input is on its way (CDP input reaches the same event): not the person's. */ agent: number;
};
const typing = new Set(['rawKeyDown', 'keyDown', 'keyUp', 'char']);
export class PersonInput {
	private watches = new WeakMap<WebContents, Watch>();
	constructor(
		readonly quiet = yieldQuiet,
		readonly limit = yieldLimit,
		private now: () => number = Date.now
	) {}
	watch(web: WebContents) {
		const state: Watch = { at: 0, since: 0, held: false, agent: 0 };
		this.watches.set(web, state);
		web.on('input-event', (_event, input) => {
			if (state.agent > 0) return;
			const type = input.type;
			if (type === 'mouseDown') this.touch(state, true);
			else if (type === 'mouseUp') this.touch(state, false);
			else if (typing.has(type)) this.touch(state, state.held);
		});
	}
	private touch(state: Watch, held: boolean) {
		const now = this.now();
		if (!state.held && now - state.at >= this.quiet) state.since = now;
		state.at = now;
		state.held = held;
	}
	/** Whether the person is at it now: typing within the last `quiet` ms or holding a button. */
	busy(web: WebContents) {
		const state = this.watches.get(web);
		return !!state && (state.held || this.now() - state.at < this.quiet);
	}
	/**
	 * Waits until the person has been quiet for `quiet` ms. `held` says once that the agent waits (the bar shows it);
	 * `'busy'` — the person kept at it past `limit` and the action goes back to the agent undone.
	 */
	async settle(
		web: WebContents,
		held: (waiting: boolean) => void,
		signal?: AbortSignal
	): Promise<'ready' | 'waited' | 'busy'> {
		const state = this.watches.get(web);
		if (!state || !this.busy(web)) return 'ready';
		held(true);
		try {
			while (this.busy(web)) {
				if (signal?.aborted || web.isDestroyed()) return 'busy';
				if (this.now() - state.since >= this.limit) return 'busy';
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			return 'waited';
		} finally {
			held(false);
		}
	}
	/** Runs the agent's own input: the events it causes are not the person's (a short tail covers late ones). */
	async agent<T>(web: WebContents, run: () => Promise<T>): Promise<T> {
		const state = this.watches.get(web);
		if (!state) return run();
		state.agent++;
		try {
			return await run();
		} finally {
			setTimeout(() => {
				state.agent--;
			}, 150);
		}
	}
	/** Test hook: the person typed or pressed now (Playwright cannot reach a WebContentsView's own input). */
	person(web: WebContents, kind: 'key' | 'down' | 'up') {
		const state = this.watches.get(web);
		if (state) this.touch(state, kind === 'down' ? true : kind === 'up' ? false : state.held);
	}
}
