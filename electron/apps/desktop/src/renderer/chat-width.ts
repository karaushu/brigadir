/** spec/task-window#layout-overview: the chat and the work area never draw narrower than these. */
export const chatMinimum = 380;
export const workAreaMinimum = 400;

/**
 * spec/task-window#width-rules: how wide the chat handle goes — the task body less the work area at its minimum and the open panel at the width
 * it wants (`null` — no panel), each with its 1 px left border. The panel counts at its wish, not as drawn, so dragging the
 * chat narrows only the work area. Never under the chat's own minimum.
 */
export function chatCeiling(body: number, panel: number | null) {
	const taken = workAreaMinimum + 1 + (panel === null ? 0 : panel + 1);
	return Math.max(chatMinimum, Math.floor(body - taken));
}
