import type { AgentProvider } from './agent';
import { formatTime } from './date-time';
import { t, type Locale } from './messages';

/** A subscription window of one provider account: what is left of it and when it resets (spec/agents-and-providers#usage, spec/agents-and-providers#quota-sources).
 *  Quota is global: it belongs to the account, never to a task. Readings come from the transport already
 *  normalized; vendor payloads stop there (rule 1). */
export type QuotaWindowKind = 'five-hour' | 'weekly' | 'weekly-model' | 'other';
export type QuotaReading = {
	/** Stable merge key within a provider, e.g. `five_hour`, `seven_day`, `model:Fable`, `codex:10080`. */
	id: string;
	kind: QuotaWindowKind;
	/** Model display name for a per-model weekly window. */
	model: string | null;
	/** Window length when the provider states it. */
	minutes: number | null;
	/** Share that is left, 0..1. The number the UI shows (spec/agents-and-providers#quota-sources). */
	remaining: number;
	/** Unix seconds; null when the provider does not say. */
	resetsAt: number | null;
	/** The provider refuses ordinary use in this window. */
	exhausted: boolean;
};
export type QuotaWindow = QuotaReading & { observedAt: number };
export type QuotaAccess = 'subscription' | 'api-key' | 'unknown';
/** `watch` is the window the indicator shows, chosen with the eye in the popover; null shows the tightest (spec/agents-and-providers#usage). */
export type ProviderQuota = {
	provider: AgentProvider;
	plan: string | null;
	access: QuotaAccess;
	windows: QuotaWindow[];
	watch: string | null;
};
export type QuotaSnapshot = { providers: ProviderQuota[] };
/** `complete` marks a full read (Claude `/usage`, Codex `account/rateLimits/read`): windows it lacks are gone.
 *  A turn reading is partial and keeps the windows it does not mention. */
export type QuotaObservation = {
	provider: AgentProvider;
	windows: QuotaReading[];
	complete: boolean;
	plan?: string | null;
	access?: QuotaAccess;
};
export type QuotaTone = 'normal' | 'low' | 'critical';

export const quotaProviders: readonly AgentProvider[] = ['claude', 'codex'];
const kinds: readonly QuotaWindowKind[] = ['five-hour', 'weekly', 'weekly-model', 'other'];
/** Data older than this is shown dimmed with its age; it is never presented as current. */
export const QUOTA_STALE_MS = 60 * 60 * 1000;

export function isQuotaReading(value: unknown): value is QuotaReading {
	if (!value || typeof value !== 'object') return false;
	const v = value as Record<string, unknown>;
	const finite = (x: unknown) => typeof x === 'number' && Number.isFinite(x);
	return (
		typeof v.id === 'string' &&
		v.id.length > 0 &&
		v.id.length <= 128 &&
		kinds.includes(v.kind as QuotaWindowKind) &&
		(v.model === null || (typeof v.model === 'string' && v.model.length <= 128)) &&
		(v.minutes === null || (finite(v.minutes) && Number(v.minutes) > 0)) &&
		finite(v.remaining) &&
		Number(v.remaining) >= 0 &&
		Number(v.remaining) <= 1 &&
		(v.resetsAt === null ||
			(finite(v.resetsAt) && Number(v.resetsAt) >= 0 && Number(v.resetsAt) <= 8_640_000_000_000)) &&
		typeof v.exhausted === 'boolean'
	);
}
export function emptyQuota(): QuotaSnapshot {
	return {
		providers: quotaProviders.map((provider) => ({
			provider,
			plan: null,
			access: 'unknown',
			windows: [],
			watch: null,
		})),
	};
}
export function isQuotaWatch(value: unknown): value is string | null {
	return value === null || (typeof value === 'string' && value.length > 0 && value.length <= 128);
}
/** The chosen window keeps the choice while it is absent (rolled over, not on this plan); the tightest shows meanwhile. */
export function watchQuota(
	snapshot: QuotaSnapshot,
	provider: AgentProvider,
	watch: string | null
): QuotaSnapshot {
	return {
		providers: snapshot.providers.map((entry) =>
			entry.provider === provider ? { ...entry, watch } : entry
		),
	};
}

/** Newer readings replace a window by id; a complete read also drops windows it does not list. */
export function mergeQuota(
	snapshot: QuotaSnapshot,
	observation: QuotaObservation,
	observedAt: number
): QuotaSnapshot {
	return {
		providers: snapshot.providers.map((entry) => {
			if (entry.provider !== observation.provider) return entry;
			const windows = new Map(entry.windows.map((window) => [window.id, window])),
				listed = new Set(observation.windows.map((reading) => reading.id));
			for (const reading of observation.windows) {
				const old = windows.get(reading.id);
				if (!old || old.observedAt <= observedAt)
					windows.set(reading.id, { ...reading, observedAt });
			}
			if (observation.complete)
				for (const [id, window] of windows)
					if (!listed.has(id) && window.observedAt <= observedAt) windows.delete(id);
			return {
				...entry,
				plan: observation.plan !== undefined ? observation.plan : entry.plan,
				access: observation.access ?? entry.access,
				windows: sortWindows([...windows.values()]),
			};
		}),
	};
}
function sortWindows(windows: QuotaWindow[]) {
	return [...windows].sort(
		(a, b) =>
			kinds.indexOf(a.kind) - kinds.indexOf(b.kind) ||
			(a.model ?? '').localeCompare(b.model ?? '') ||
			(a.minutes ?? 0) - (b.minutes ?? 0)
	);
}

/** A window whose reset time has passed describes a window that no longer exists. */
export function liveWindows(entry: ProviderQuota, now = Date.now()): QuotaWindow[] {
	return entry.windows.filter((window) => window.resetsAt === null || window.resetsAt * 1000 > now);
}
export function quotaTone(window: Pick<QuotaWindow, 'remaining' | 'exhausted'>): QuotaTone {
	return window.exhausted || window.remaining < 0.1
		? 'critical'
		: window.remaining < 0.25
			? 'low'
			: 'normal';
}
/** The window closest to running out; exhausted beats everything. */
export function tightestWindow(entry: ProviderQuota, now = Date.now()): QuotaWindow | null {
	return liveWindows(entry, now).reduce<QuotaWindow | null>(
		(best, window) =>
			!best || (window.exhausted ? 0 : window.remaining) < (best.exhausted ? 0 : best.remaining)
				? window
				: best,
		null
	);
}
/** What the indicator shows for a provider: the chosen window when it is live, else the tightest. */
export function displayWindow(entry: ProviderQuota, now = Date.now()): QuotaWindow | null {
	const chosen = entry.watch
		? liveWindows(entry, now).find((window) => window.id === entry.watch)
		: undefined;
	return chosen ?? tightestWindow(entry, now);
}
/**
 * spec/appearance#evolution-redesign: the rings of the indicator. Claude — two: the outer is the 5-hour window, the inner the weekly one; Codex — one
 * thick ring, its weekly window (the shown one when there is no weekly). A ring without its window stays an empty track.
 */
export function quotaRingWindows(
	entry: ProviderQuota,
	now = Date.now()
): { outer: QuotaWindow | null; inner: QuotaWindow | null } {
	const live = liveWindows(entry, now),
		weekly = live.find((window) => window.kind === 'weekly') ?? null;
	if (entry.provider === 'claude')
		return { outer: live.find((window) => window.kind === 'five-hour') ?? null, inner: weekly };
	return { outer: weekly ?? displayWindow(entry, now), inner: null };
}
/** The visible arc of a ring: `remaining` of its circumference, as an SVG dash array (`arc circumference`). */
export function quotaRingDash(remaining: number, radius: number): string {
	const circumference = 2 * Math.PI * radius,
		arc = Math.max(0, Math.min(1, remaining)) * circumference;
	return `${arc.toFixed(2)} ${circumference.toFixed(2)}`;
}
export function isQuotaStale(window: Pick<QuotaWindow, 'observedAt'>, now = Date.now()) {
	return now - window.observedAt > QUOTA_STALE_MS;
}
export function quotaObservedAt(entry: ProviderQuota): number | null {
	return entry.windows.length
		? Math.max(...entry.windows.map((window) => window.observedAt))
		: null;
}

export function quotaPercent(locale: Locale, remaining: number) {
	return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(
		Math.max(0, Math.min(1, remaining))
	);
}
export function quotaWindowLabel(
	locale: Locale,
	provider: AgentProvider,
	window: Pick<QuotaWindow, 'kind' | 'model' | 'minutes'>
) {
	if (window.kind === 'five-hour') return t(locale, '5-hour limit');
	if (window.kind === 'weekly')
		return provider === 'claude' ? t(locale, 'Weekly · all models') : t(locale, 'Weekly limit');
	if (window.kind === 'weekly-model')
		return t(locale, 'Weekly · {model}').replace('{model}', window.model ?? '');
	return t(locale, 'Limit · {window}').replace(
		'{window}',
		span(locale, (window.minutes ?? 0) * 60_000)
	);
}
/** Hours and minutes, never seconds: a quota reset is not a stopwatch. Resets round up, ages round down. */
function span(locale: Locale, milliseconds: number, round: (value: number) => number = Math.ceil) {
	const minutes = Math.max(1, round(milliseconds / 60_000)),
		hours = Math.floor(minutes / 60),
		rest = minutes % 60,
		gap = locale === 'uk' ? ' ' : ' ';
	const [h, m] = locale === 'uk' ? ['год', 'хв'] : ['h', 'min'];
	const number = (n: number) => new Intl.NumberFormat(locale).format(n);
	if (hours >= 48 && rest === 0 && hours % 24 === 0)
		return `${number(hours / 24)}${gap}${locale === 'uk' ? 'дн' : 'd'}`;
	return [
		hours ? `${number(hours)}${gap}${h}` : '',
		rest || !hours ? `${number(rest)}${gap}${m}` : '',
	]
		.filter(Boolean)
		.join(' ');
}
/** Short windows reset in a relative phrase; weekly ones name the day. */
export function quotaResetLabel(
	locale: Locale,
	window: Pick<QuotaWindow, 'kind' | 'minutes' | 'resetsAt'>,
	now = Date.now(),
	timeZone?: string
) {
	if (window.resetsAt === null) return t(locale, 'reset time unknown');
	const at = window.resetsAt * 1000,
		short =
			window.kind === 'five-hour' || (window.kind === 'other' && (window.minutes ?? 0) <= 1440);
	if (short) return t(locale, 'resets in {time}').replace('{time}', span(locale, at - now));
	const day = new Intl.DateTimeFormat(locale === 'uk' ? 'uk' : 'en-GB', {
		weekday: 'short',
		...(timeZone ? { timeZone } : {}),
	}).format(new Date(at));
	return t(locale, 'resets {day}, {time}')
		.replace('{day}', day)
		.replace('{time}', formatTime(at, timeZone ? { timeZone } : {}));
}
export function quotaAgeLabel(locale: Locale, observedAt: number, now = Date.now()) {
	return now - observedAt < 60_000
		? t(locale, 'updated just now')
		: t(locale, 'updated {time} ago').replace('{time}', span(locale, now - observedAt, Math.floor));
}
export function providerName(provider: AgentProvider) {
	return provider === 'claude' ? 'Claude' : 'Codex';
}
