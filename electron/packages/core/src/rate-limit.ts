import type { EventRecord, SessionEvent } from './session';
export type RateLimitWindow = { window: string | null; resetsAt: number | null };
export function isRateReset(value: unknown): value is number | null {
	return (
		value === null ||
		(typeof value === 'number' &&
			Number.isFinite(value) &&
			value >= 0 &&
			value <= 8_640_000_000_000)
	);
}
/** Only rejected is a block. Warnings still permit normal work. Expiry is its own fact, never invented provider permission. */
export function reduceRateLimits(
	windows: readonly RateLimitWindow[],
	event: SessionEvent
): RateLimitWindow[] {
	if (event.kind === 'rate-limit.changed')
		return [
			...windows.filter((item) => item.window !== event.window),
			...(event.status === 'rejected' ? [{ window: event.window, resetsAt: event.resetsAt }] : []),
		];
	if (event.kind === 'rate-limit.expired')
		return windows.filter(
			(item) => item.window !== event.window || item.resetsAt !== event.resetsAt
		);
	return windows as RateLimitWindow[];
}
export function rateLimits(records: readonly EventRecord[]) {
	return records.reduce(
		(state, record) => reduceRateLimits(state, record.event),
		[] as RateLimitWindow[]
	);
}
/** A known deadline expires locally; unknown windows remain blocked until a structured update. */
export function blockedRateLimit(
	windows: readonly RateLimitWindow[],
	now = Date.now()
): { resetsAt: number | null } | null {
	const active = windows.filter((item) => item.resetsAt === null || item.resetsAt * 1000 > now);
	return active.length
		? {
				resetsAt: active.some((item) => item.resetsAt === null)
					? null
					: Math.max(...active.map((item) => item.resetsAt!)),
			}
		: null;
}
