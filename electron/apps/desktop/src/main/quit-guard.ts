/** A store whose writes must land before the window closes or the app quits. */
export type PendingWrite = { name: string; busy(): boolean; wait(): Promise<unknown> };
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
/**
 * spec/architecture-and-platform#exit: close and quit wait for named work. A failed write settles its wait (it already reported itself), a stalled one is
 * named in the log every few seconds, and a quit still waiting at the deadline logs what it abandons and goes on. The
 * continuation always runs in a later macrotask: Electron ignores `app.quit()` from inside the `close` event it cancels.
 */
export class QuitGuard {
	private since: number | null = null;
	private expired = false;
	constructor(
		private log: (text: string) => void = (text) => console.error(text),
		private deadlineMs = 30_000,
		private reportMs = 5_000,
		private tickMs = 1_000
	) {}
	/** The deadline runs from the first quit request across every wait round, so writes queued meanwhile cannot hold it open. */
	begin() {
		this.since ??= Date.now();
	}
	cancel() {
		this.since = null;
		this.expired = false;
	}
	/** Names of the writes a close or quit must still wait for; none once a quit gave up. */
	busy(writes: readonly PendingWrite[]) {
		return this.expired ? [] : writes.filter((write) => write.busy()).map((write) => write.name);
	}
	settle(label: string, writes: readonly PendingWrite[]) {
		return this.watch(
			label,
			writes
				.filter((write) => write.busy())
				.map((write) => ({ name: write.name, work: write.wait }))
		);
	}
	run(label: string, name: string, work: () => Promise<unknown>) {
		return this.watch(label, [{ name, work }]);
	}
	private watch(
		label: string,
		items: { name: string; work: () => Promise<unknown> }[]
	): Promise<void> {
		const pending = new Set(items.map((item) => item.name)),
			started = Date.now();
		const waits = items.map((item) =>
			Promise.resolve()
				.then(item.work)
				.catch((error) => this.log(`[quit] ${label}: ${item.name} failed: ${message(error)}`))
				.finally(() => pending.delete(item.name))
		);
		return new Promise<void>((resolve) => {
			let reported = started,
				finished = false;
			const finish = () => {
				if (finished) return;
				finished = true;
				clearInterval(tick);
				setImmediate(resolve);
			};
			const tick = setInterval(() => {
				const now = Date.now();
				if (this.since !== null && now - this.since >= this.deadlineMs) {
					this.expired = true;
					this.log(
						`[quit] ${label}: gave up after ${Math.round((now - this.since) / 1000)} s waiting for ${[...pending].join(', ')}; quitting without them`
					);
					finish();
					return;
				}
				if (now - reported >= this.reportMs) {
					reported = now;
					this.log(
						`[quit] ${label}: waiting ${Math.round((now - started) / 1000)} s for ${[...pending].join(', ')}`
					);
				}
			}, this.tickMs);
			void Promise.all(waits).then(finish);
		});
	}
}
