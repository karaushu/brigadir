/**
 * spec/pull-requests-and-ci#reading-and-refresh: one PR read at a time, and no request is lost. A click or ⌘R during a read does not start a second read
 * beside it; it asks for one more pass after it, however many came. The read in flight may have left before the change
 * the person wants to see (in the PR, the list half of a refresh outlives the PR half), so dropping the request — the
 * first version — left the panel on the old value with nothing turning.
 *
 * `request()` resolves when the pass that covers it ends. `run` failing does not stop the next pass: the list and the PR
 * show their own read errors.
 */
export function refreshFlight(
	run: () => Promise<unknown>,
	busy: (busy: boolean) => void = () => {}
) {
	let current: Promise<void> | null = null,
		again = false;
	async function loop() {
		busy(true);
		try {
			do {
				again = false;
				try {
					await run();
				} catch {
					/* shown by the list and the PR */
				}
			} while (again);
		} finally {
			current = null;
			busy(false);
		}
	}
	return {
		get reading() {
			return current !== null;
		},
		request(): Promise<void> {
			if (current) {
				again = true;
				return current;
			}
			current = loop();
			return current;
		},
	};
}
