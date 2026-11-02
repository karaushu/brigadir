import { useEffect, useState } from 'react';
import { blockedRateLimit, t, type Locale, type RateLimitWindow } from '@brigadir/core';
import { Glyph } from './ui/Glyph';
import s from './RateLimit.module.css';
export function useRateLimit(windows: readonly RateLimitWindow[]) {
	const [now, setNow] = useState(Date.now),
		deadline = windows
			.filter((item) => item.resetsAt !== null)
			.map((item) => item.resetsAt!)
			.sort((a, b) => a - b)
			.join('/');
	useEffect(() => {
		const current = Date.now();
		setNow(current);
		const last = Math.max(...deadline.split('/').map(Number)) * 1000;
		if (!deadline || last <= current) return;
		const timer = setInterval(() => {
			const now = Date.now();
			setNow(now);
			if (now >= last) clearInterval(timer);
		}, 1000);
		return () => clearInterval(timer);
	}, [deadline]);
	return blockedRateLimit(windows, now);
}
export function rateResetLabel(resetsAt: number | null, locale: Locale) {
	return resetsAt === null
		? t(locale, 'Reset time is unavailable. Waiting for the provider.')
		: t(locale, 'Resets in {minutes} min').replace(
				'{minutes}',
				new Intl.NumberFormat(locale).format(
					Math.max(0, Math.ceil((resetsAt * 1000 - Date.now()) / 60000))
				)
			);
}
/** The minutes until a limit resets, «48 min»; «—» when the provider did not say. */
export function limitMinutes(locale: Locale, resetsAt: number | null) {
	return resetsAt === null
		? '—'
		: new Intl.NumberFormat(locale, { style: 'unit', unit: 'minute', unitDisplay: 'short' }).format(
				Math.max(0, Math.ceil((resetsAt * 1000 - Date.now()) / 60000))
			);
}
export function RateLimitTime({ resetsAt, locale }: { resetsAt: number | null; locale: Locale }) {
	const limit = useRateLimit([{ window: null, resetsAt }]);
	return limit ? (
		<span className={s.time} title={rateResetLabel(resetsAt, locale)}>
			{limitMinutes(locale, resetsAt)}
		</span>
	) : null;
}
