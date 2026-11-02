import { describe, expect, it } from 'vitest';
import {
	displayWindow,
	watchQuota,
	emptyQuota,
	isQuotaReading,
	liveWindows,
	mergeQuota,
	quotaAgeLabel,
	quotaPercent,
	quotaResetLabel,
	quotaTone,
	quotaWindowLabel,
	tightestWindow,
	isQuotaStale,
	quotaRingDash,
	quotaRingWindows,
	type QuotaReading,
} from './quota';
import { isSessionEvent } from './event-validation';

const reading = (
	id: string,
	remaining: number,
	extra: Partial<QuotaReading> = {}
): QuotaReading => ({
	id,
	kind: id === 'five_hour' ? 'five-hour' : id.startsWith('model:') ? 'weekly-model' : 'weekly',
	model: id.startsWith('model:') ? id.slice(6) : null,
	minutes: null,
	remaining,
	resetsAt: 2_000_000_000,
	exhausted: false,
	...extra,
});
const claude = (snapshot: ReturnType<typeof emptyQuota>) =>
	snapshot.providers.find((entry) => entry.provider === 'claude')!;

describe('quota', () => {
	it('keeps windows a partial turn reading does not mention and drops them on a complete read', () => {
		let snapshot = mergeQuota(
			emptyQuota(),
			{
				provider: 'claude',
				complete: true,
				windows: [
					reading('five_hour', 0.4),
					reading('seven_day', 0.7),
					reading('model:Fable', 0.9),
				],
				plan: 'Team',
				access: 'subscription',
			},
			1000
		);
		snapshot = mergeQuota(
			snapshot,
			{
				provider: 'claude',
				complete: false,
				windows: [reading('five_hour', 0.3), reading('seven_day', 0.69)],
			},
			2000
		);
		expect(
			claude(snapshot).windows.map((window) => [window.id, window.remaining, window.observedAt])
		).toEqual([
			['five_hour', 0.3, 2000],
			['seven_day', 0.69, 2000],
			['model:Fable', 0.9, 1000],
		]);
		expect(claude(snapshot).plan).toBe('Team');
		snapshot = mergeQuota(
			snapshot,
			{ provider: 'claude', complete: true, windows: [reading('five_hour', 0.2)] },
			3000
		);
		expect(claude(snapshot).windows.map((window) => window.id)).toEqual(['five_hour']);
		expect(snapshot.providers.find((entry) => entry.provider === 'codex')!.windows).toEqual([]);
	});
	it('never lets an older reading overwrite a newer one', () => {
		let snapshot = mergeQuota(
			emptyQuota(),
			{ provider: 'claude', complete: false, windows: [reading('five_hour', 0.2)] },
			5000
		);
		snapshot = mergeQuota(
			snapshot,
			{ provider: 'claude', complete: true, windows: [reading('five_hour', 0.9)] },
			4000
		);
		expect(claude(snapshot).windows[0]).toMatchObject({ remaining: 0.2, observedAt: 5000 });
	});
	it('colours by what is left: under 25% low, under 10% or exhausted critical', () => {
		expect(quotaTone({ remaining: 0.25, exhausted: false })).toBe('normal');
		expect(quotaTone({ remaining: 0.24, exhausted: false })).toBe('low');
		expect(quotaTone({ remaining: 0.1, exhausted: false })).toBe('low');
		expect(quotaTone({ remaining: 0.09, exhausted: false })).toBe('critical');
		expect(quotaTone({ remaining: 0.8, exhausted: true })).toBe('critical');
	});
	it('hides rolled-over windows and picks the tightest live one', () => {
		const snapshot = mergeQuota(
			emptyQuota(),
			{
				provider: 'claude',
				complete: true,
				windows: [
					reading('five_hour', 0.05, { resetsAt: 100 }),
					reading('seven_day', 0.6),
					reading('model:Fable', 0.4),
				],
			},
			1
		);
		expect(liveWindows(claude(snapshot), 200_000).map((window) => window.id)).toEqual([
			'seven_day',
			'model:Fable',
		]);
		expect(tightestWindow(claude(snapshot), 200_000)?.id).toBe('model:Fable');
		expect(isQuotaStale({ observedAt: 0 }, 60 * 60 * 1000 + 1)).toBe(true);
	});
	it('labels windows with the product vocabulary and resets by window kind', () => {
		expect(quotaWindowLabel('uk', 'claude', { kind: 'weekly', model: null, minutes: null })).toBe(
			'Тижневий · усі моделі'
		);
		expect(quotaWindowLabel('uk', 'codex', { kind: 'weekly', model: null, minutes: 10080 })).toBe(
			'Тижневий ліміт'
		);
		expect(
			quotaWindowLabel('uk', 'claude', { kind: 'weekly-model', model: 'Fable', minutes: null })
		).toBe('Тижневий · Fable');
		const now = Date.UTC(2026, 8, 24, 10, 0);
		expect(
			quotaResetLabel(
				'uk',
				{ kind: 'five-hour', minutes: 300, resetsAt: (now + (2 * 60 + 21) * 60_000) / 1000 },
				now
			)
		).toBe('скидання через 2 год 21 хв');
		expect(
			quotaResetLabel(
				'uk',
				{ kind: 'weekly', minutes: null, resetsAt: Date.UTC(2026, 8, 29, 14, 0) / 1000 },
				now,
				'Europe/Kyiv'
			)
		).toBe('скидання вт, 17:00');
		expect(quotaResetLabel('en', { kind: 'five-hour', minutes: null, resetsAt: null }, now)).toBe(
			'reset time unknown'
		);
		expect(quotaAgeLabel('uk', now - 30_000, now)).toBe('оновлено щойно');
		expect(quotaAgeLabel('uk', now - 120_000, now)).toBe('оновлено 2 хв тому');
		expect(quotaPercent('uk', 0.38)).toBe('38%');
	});
	it('shows the chosen window, falls back to the tightest while it is absent and keeps the choice through reads', () => {
		let snapshot = mergeQuota(
			emptyQuota(),
			{
				provider: 'claude',
				complete: true,
				windows: [reading('five_hour', 0.3), reading('seven_day', 0.7)],
			},
			1
		);
		expect(displayWindow(claude(snapshot), 0)?.id).toBe('five_hour');
		snapshot = watchQuota(snapshot, 'claude', 'seven_day');
		expect(displayWindow(claude(snapshot), 0)?.id).toBe('seven_day');
		snapshot = mergeQuota(
			snapshot,
			{ provider: 'claude', complete: true, windows: [reading('five_hour', 0.2)] },
			2
		);
		expect(claude(snapshot).watch).toBe('seven_day');
		expect(displayWindow(claude(snapshot), 0)?.id).toBe('five_hour');
		snapshot = mergeQuota(
			snapshot,
			{ provider: 'claude', complete: false, windows: [reading('seven_day', 0.6)] },
			3
		);
		expect(displayWindow(claude(snapshot), 0)?.id).toBe('seven_day');
		expect(watchQuota(snapshot, 'claude', null).providers[0]!.watch).toBeNull();
		expect(snapshot.providers[1]!.watch).toBeNull();
	});
	it('journals only well-formed readings', () => {
		expect(isQuotaReading(reading('five_hour', 0.5))).toBe(true);
		expect(isQuotaReading({ ...reading('five_hour', 0.5), remaining: 1.5 })).toBe(false);
		expect(
			isSessionEvent({
				kind: 'quota.observed',
				provider: 'claude',
				complete: false,
				windows: [reading('five_hour', 0.5)],
			})
		).toBe(true);
		expect(
			isSessionEvent({ kind: 'quota.observed', provider: 'gemini', complete: false, windows: [] })
		).toBe(false);
	});
});
describe('quota rings (spec/appearance#evolution-redesign)', () => {
	const at = (window: QuotaReading) => ({ ...window, observedAt: 1 });
	const entry = (provider: 'claude' | 'codex', windows: QuotaReading[]) => ({
		provider,
		plan: null,
		access: 'subscription' as const,
		windows: windows.map(at),
		watch: null,
	});
	it('gives Claude the 5-hour window outside and the weekly one inside', () => {
		const rings = quotaRingWindows(
			entry('claude', [
				reading('seven_day', 0.18),
				reading('five_hour', 0.76),
				reading('model:Opus', 0.41),
			]),
			0
		);
		expect(rings.outer?.id).toBe('five_hour');
		expect(rings.inner?.id).toBe('seven_day');
		// No 5-hour window: the outer ring stays an empty track.
		expect(quotaRingWindows(entry('claude', [reading('seven_day', 0.5)]), 0).outer).toBeNull();
	});
	it('gives Codex one ring: the weekly window, else the shown one', () => {
		const both = entry('codex', [reading('five_hour', 0.64), reading('codex:10080', 0.59)]);
		expect(quotaRingWindows(both, 0)).toMatchObject({ outer: { id: 'codex:10080' }, inner: null });
		const hourly = entry('codex', [
			reading('codex:60', 0.88, { kind: 'other', minutes: 60 }),
			reading('codex:43200', 0.92, { kind: 'other', minutes: 43200 }),
		]);
		expect(quotaRingWindows(hourly, 0).outer?.id).toBe('codex:60');
	});
	it('draws the remaining share of the circle', () => {
		expect(quotaRingDash(0.76, 10)).toBe('47.75 62.83');
		expect(quotaRingDash(0.18, 5.6)).toBe('6.33 35.19');
		expect(quotaRingDash(1.4, 9)).toBe('56.55 56.55');
		expect(quotaRingDash(-1, 9)).toBe('0.00 56.55');
	});
});
