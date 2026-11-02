import type { QuotaAccess, QuotaReading } from '@brigadir/core';
/** Vendor quota payloads stop here; the rest of the app sees only `QuotaReading` (spec/agents-and-providers#quota-sources, spec/agents-and-providers#quota-sources). */
const record = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): value is number =>
	typeof value === 'number' && Number.isFinite(value);
const unix = (value: unknown) =>
	finite(value) && value >= 0 && value <= 8_640_000_000_000 ? value : null;
const share = (used: number) => Math.max(0, Math.min(1, 1 - used));
const models: Record<string, string> = { seven_day_opus: 'Opus', seven_day_sonnet: 'Sonnet' };

/** `_claude/rateLimit` / `rate_limit_info`: `unifiedWindows` carries every window at once (fractions 0..1);
 *  the top-level fields describe the window that limits right now. */
export function claudeRateLimitReadings(info: unknown): QuotaReading[] {
	if (!record(info)) return [];
	const readings = new Map<string, QuotaReading>(),
		exhaustedType =
			info.status === 'rejected' && typeof info.rateLimitType === 'string'
				? info.rateLimitType
				: null;
	const add = (type: string, utilization: unknown, resetsAt: unknown) => {
		if (!finite(utilization)) return;
		const exhausted = exhaustedType === type;
		if (type === 'five_hour')
			readings.set(type, {
				id: type,
				kind: 'five-hour',
				model: null,
				minutes: 300,
				remaining: share(utilization),
				resetsAt: unix(resetsAt),
				exhausted,
			});
		else if (type === 'seven_day')
			readings.set(type, {
				id: type,
				kind: 'weekly',
				model: null,
				minutes: 10080,
				remaining: share(utilization),
				resetsAt: unix(resetsAt),
				exhausted,
			});
		else if (models[type])
			readings.set(`model:${models[type]}`, {
				id: `model:${models[type]}`,
				kind: 'weekly-model',
				model: models[type]!,
				minutes: 10080,
				remaining: share(utilization),
				resetsAt: unix(resetsAt),
				exhausted,
			});
	};
	if (record(info.unifiedWindows))
		for (const [type, window] of Object.entries(info.unifiedWindows))
			if (record(window)) add(type, window.utilization, window.resetsAt);
	if (typeof info.rateLimitType === 'string' && !readings.has(info.rateLimitType))
		add(info.rateLimitType, info.utilization, info.resetsAt);
	return [...readings.values()];
}

/** `/usage` run by the CLI itself: `usage_report.rate_limits.limits[]`, `percent` used 0..100, ISO resets. */
export function claudeUsageReadings(report: unknown): QuotaReading[] | null {
	if (!record(report) || !record(report.rate_limits) || !Array.isArray(report.rate_limits.limits))
		return null;
	const readings: QuotaReading[] = [];
	for (const limit of report.rate_limits.limits) {
		if (!record(limit) || !finite(limit.percent)) continue;
		const resetsAt =
			typeof limit.resets_at === 'string' && Number.isFinite(Date.parse(limit.resets_at))
				? Math.round(Date.parse(limit.resets_at) / 1000)
				: null;
		const used = Math.max(0, Math.min(100, limit.percent)) / 100,
			base = { remaining: share(used), resetsAt, exhausted: used >= 1 };
		if (limit.kind === 'session')
			readings.push({ id: 'five_hour', kind: 'five-hour', model: null, minutes: 300, ...base });
		else if (limit.kind === 'weekly_all')
			readings.push({ id: 'seven_day', kind: 'weekly', model: null, minutes: 10080, ...base });
		else if (
			limit.kind === 'weekly_scoped' &&
			record(limit.scope) &&
			record(limit.scope.model) &&
			typeof limit.scope.model.display_name === 'string' &&
			limit.scope.model.display_name.trim()
		) {
			const model = limit.scope.model.display_name.trim().slice(0, 64);
			readings.push({ id: `model:${model}`, kind: 'weekly-model', model, minutes: 10080, ...base });
		}
	}
	return readings;
}

/** `_auth/status_update` of either adapter: only the login kind and the plan name, never the email. */
export function authAccess(status: unknown): { access: QuotaAccess; plan: string | null } {
	const value = record(status) && record(status.authStatus) ? status.authStatus : status;
	if (!record(value)) return { access: 'unknown', plan: null };
	if (value.kind === 'api_key') return { access: 'api-key', plan: null };
	if (value.kind !== 'account') return { access: 'unknown', plan: null };
	const raw =
		record(value.account) && typeof value.account.plan === 'string'
			? value.account.plan
			: typeof value.label === 'string'
				? value.label
				: null;
	return { access: 'subscription', plan: raw ? planLabel(raw) : null };
}
/** Plan names as the product shows them: `team` → Team, `self_serve_business_prolite` → Business. */
export function planLabel(raw: string) {
	const plan = raw
		.trim()
		.replace(/^claude\s+/i, '')
		.toLowerCase();
	if (/business/.test(plan)) return 'Business';
	if (/enterprise/.test(plan)) return 'Enterprise';
	if (/^edu/.test(plan)) return 'Edu';
	const words = plan.split(/[\s_-]+/).filter(Boolean);
	return (
		words
			.map((word) => word[0]!.toUpperCase() + word.slice(1))
			.join(' ')
			.slice(0, 40) || raw.slice(0, 40)
	);
}

/** Codex `RateLimitSnapshot`: windows are told apart by duration, never by `primary`/`secondary` position. */
export function codexRateLimitReadings(snapshot: unknown): QuotaReading[] {
	if (!record(snapshot)) return [];
	const readings = new Map<string, QuotaReading>();
	for (const slot of ['primary', 'secondary'] as const) {
		const window = snapshot[slot];
		if (!record(window) || !finite(window.usedPercent)) continue;
		const minutes =
				finite(window.windowDurationMins) && window.windowDurationMins > 0
					? window.windowDurationMins
					: null,
			used = Math.max(0, Math.min(100, window.usedPercent)) / 100;
		const kind = minutes === 300 ? 'five-hour' : minutes === 10080 ? 'weekly' : 'other',
			id = minutes === null ? `codex:${slot}` : `codex:${minutes}`;
		readings.set(id, {
			id,
			kind,
			model: null,
			minutes,
			remaining: share(used),
			resetsAt: unix(window.resetsAt),
			exhausted: used >= 1,
		});
	}
	return [...readings.values()];
}

/** Claude Code statusline JSON (documented): `rate_limits.{five_hour,seven_day}.{used_percentage 0–100, resets_at}`.
 *  The terminal-mode source; a window whose reset has passed is dropped by the CLI itself. */
export function statuslineReadings(input: unknown): QuotaReading[] {
	if (!record(input) || !record(input.rate_limits)) return [];
	const readings: QuotaReading[] = [];
	for (const [type, kind, minutes] of [
		['five_hour', 'five-hour', 300],
		['seven_day', 'weekly', 10080],
	] as const) {
		const window = input.rate_limits[type];
		if (!record(window) || !finite(window.used_percentage)) continue;
		const used = Math.max(0, Math.min(100, window.used_percentage)) / 100;
		readings.push({
			id: type,
			kind,
			model: null,
			minutes,
			remaining: share(used),
			resetsAt: unix(window.resets_at),
			exhausted: used >= 1,
		});
	}
	return readings;
}
