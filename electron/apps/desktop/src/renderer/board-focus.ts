/**
 * spec/projects-and-board#board-moves: a card that moves to another column mounts anew, so the focused one is lost. Focus goes to the card with the
 * same id once the old one leaves the page — also when that happens later than the action (a stop waits for the turn, up to 15 s) — unless the person
 * has focused something else meanwhile. `fallback` is a selector for when the card is gone.
 */
export const boardFocusWaitMs = 16_000;
export function followBoardFocus(
	focused: Element | null,
	id: string,
	fallback: string,
	alive: () => boolean = () => true
): void {
	if (!(focused instanceof HTMLElement)) return;
	let observer: MutationObserver | null = null,
		timer: ReturnType<typeof setTimeout> | undefined;
	const stop = () => {
		observer?.disconnect();
		clearTimeout(timer);
	};
	const check = () => {
		if (!alive()) return stop();
		if (focused.isConnected) return;
		stop();
		const active = document.activeElement;
		if (active && active !== document.body) return;
		(
			document.querySelector<HTMLElement>(`[data-board-task="${CSS.escape(id)}"]`) ??
			document.querySelector<HTMLElement>(fallback)
		)?.focus({ preventScroll: true });
	};
	requestAnimationFrame(() => {
		check();
		if (!focused.isConnected || !alive()) return;
		observer = new MutationObserver(check);
		observer.observe(document.body, { childList: true, subtree: true });
		timer = setTimeout(stop, boardFocusWaitMs);
	});
}
