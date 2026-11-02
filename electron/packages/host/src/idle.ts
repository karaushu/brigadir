import type { AgentTask } from '@brigadir/core';
/** BG-09 (spec/architecture-and-platform#host-lifecycle): a GUI host with nothing to do stops after this long, as after Stop; the next message resumes the session. */
export const hostIdleMs = 15 * 60_000;
/** Tests shorten the wait with `BRIGADIR_TEST_IDLE_MS`; nothing else sets it. */
export function idleTimeout(env: NodeJS.ProcessEnv = process.env) {
	const value = Number(env.BRIGADIR_TEST_IDLE_MS);
	return Number.isSafeInteger(value) && value > 0 ? value : hostIdleMs;
}
export type IdleState = {
	terminal: boolean;
	busy: boolean;
	starting: boolean;
	saving: boolean;
	inputs: number;
	queued: number;
	quota: boolean;
	consoles: boolean;
	visible: boolean;
	/** `worker`: a worker, lead or reviewer of a crew (the parent manages it, spec/architecture-and-platform#host-lifecycle); `active`: a foreman whose crew still runs. */
	crew: 'none' | 'worker' | 'active' | 'settled';
	status?: AgentTask['status'];
	/** spec/chat-turns-plans-and-questions#background-commands: a background command runs; the agent may go on when it ends. */
	background?: boolean;
};
/** What keeps a host alive; null when it may stop for idleness. The user's consoles and CLI agents are never stopped by this. */
export function idleBlocker(state: IdleState): string | null {
	if (state.terminal) return 'terminal';
	if (state.busy || state.starting) return 'turn';
	if (state.saving) return 'saving';
	if (state.inputs) return 'input';
	if (state.queued) return 'queue';
	if (state.background) return 'background';
	if (state.quota) return 'quota';
	if (state.consoles) return 'console';
	if (state.visible) return 'visible';
	if (state.crew === 'worker' || state.crew === 'active') return 'crew';
	if (state.status === 'preparing' || state.status === 'queued') return 'launch';
	return null;
}
