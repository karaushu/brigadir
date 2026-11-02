import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import {
	displayWindow,
	isQuotaStale,
	liveWindows,
	providerName,
	quotaAgeLabel,
	quotaPercent,
	quotaResetLabel,
	quotaRingDash,
	quotaRingWindows,
	quotaTone,
	quotaWindowLabel,
	t,
	type Locale,
	type ProviderQuota,
	type QuotaSnapshot,
	type QuotaWindow,
} from '@brigadir/core';
import { Glyph } from './ui/Glyph';
import { Button, IconButton } from './ui/Controls';
import { Popover, useHoverPopover } from './ui/Popover';
import s from './Quota.module.css';

/** One subscription for every button: the sidebar footer and the launch sheet show the same global limits (spec/agents-and-providers#usage). */
let snapshot: QuotaSnapshot | null = null,
	subscribed = false;
const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
	listeners.add(listener);
	if (!subscribed) {
		subscribed = true;
		const notify = () => {
			for (const item of listeners) item();
		};
		window.brigadir.onQuotaChanged((value) => {
			snapshot = value;
			notify();
		});
		void window.brigadir.readQuota().then(
			(value) => {
				snapshot ??= value;
				notify();
			},
			() => {}
		);
	}
	return () => {
		listeners.delete(listener);
	};
}
export function useQuota() {
	return useSyncExternalStore(subscribe, () => snapshot);
}
function useNow(interval: number) {
	const [now, setNow] = useState(Date.now);
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), interval);
		return () => clearInterval(timer);
	}, [interval]);
	return now;
}

/** A provider is shown once it has a live window or a known login without a subscription. */
const shown = (entry: ProviderQuota, now: number) =>
	entry.access === 'api-key' || liveWindows(entry, now).length > 0;

export function QuotaButton({
	locale,
	placement,
}: {
	locale: Locale;
	/** spec/sidebar#section-rail: `rail` — the foot of the sections rail: 30 px rings with the provider's glyph inside, the percent under. */
	placement: 'above' | 'below' | 'rail';
}) {
	const quota = useQuota(),
		now = useNow(60_000);
	const providers = (quota?.providers ?? []).filter((entry) => shown(entry, now));
	if (!providers.length) return null;
	return <QuotaIndicator locale={locale} placement={placement} providers={providers} />;
}

function QuotaIndicator({
	locale,
	placement,
	providers,
}: {
	locale: Locale;
	placement: 'above' | 'below' | 'rail';
	providers: ProviderQuota[];
}) {
	const hover = useHoverPopover(),
		button = useRef<HTMLButtonElement>(null),
		id = useId(),
		open = hover.open;
	const now = useNow(open ? 30_000 : 60_000);
	const gauges = providers
		.filter((entry) => entry.access !== 'api-key')
		.map((entry) => ({ entry, window: displayWindow(entry, now) }))
		.filter((item): item is { entry: ProviderQuota; window: QuotaWindow } => item.window !== null);
	const summary = gauges
		.map(
			({ entry, window }) =>
				`${providerName(entry.provider)} ${quotaPercent(locale, window.exhausted ? 0 : window.remaining)}`
		)
		.join(', ');
	// Opening asks main for a fresh complete read; main throttles it to once a minute per provider.
	useEffect(() => {
		if (open) void window.brigadir.refreshQuota().catch(() => {});
	}, [open]);
	return (
		<>
			<Button
				ref={button}
				variant="ghost"
				opensPopover
				className={placement === 'rail' ? s.railButton : s.button}
				data-quota-button={placement}
				aria-label={t(locale, 'Subscription limits: {summary}').replace(
					'{summary}',
					summary ? `${summary} ${t(locale, 'left')}` : t(locale, 'Subscription limits')
				)}
				title={t(locale, 'Subscription limits')}
				aria-haspopup="dialog"
				aria-expanded={open}
				aria-controls={open ? id : undefined}
				{...hover.trigger}>
				{gauges.map(({ entry, window }) => {
					const rings = quotaRingWindows(entry, now);
					return (
						<span
							key={entry.provider}
							className={s.gauge}
							data-provider={entry.provider}
							data-tone={quotaTone(window)}
							data-stale={isQuotaStale(window, now) || undefined}>
							{placement === 'rail' ? (
								// spec/sidebar#section-rail: rings 30 px, the provider's glyph in the middle.
								<span className={s.railRings}>
									<svg
										width="30"
										height="30"
										viewBox="0 0 30 30"
										aria-hidden="true"
										className={s.rings}>
										{entry.provider === 'claude' ? (
											<>
												<QuotaArc
													window={rings.outer}
													radius={13.4}
													width={2.4}
													now={now}
													center={15}
												/>
												<QuotaArc
													window={rings.inner}
													radius={9.6}
													width={2.2}
													now={now}
													center={15}
												/>
											</>
										) : (
											<QuotaArc
												window={rings.outer}
												radius={12.4}
												width={3}
												now={now}
												center={15}
											/>
										)}
									</svg>
									<Glyph name={entry.provider === 'claude' ? 'claude' : 'openai'} size={11} />
								</span>
							) : (
								<>
									{/* spec/appearance#evolution-redesign: Claude — 5 hours outside, the week inside; Codex — one thick ring. */}
									<svg
										width="20"
										height="20"
										viewBox="0 0 26 26"
										aria-hidden="true"
										className={s.rings}>
										{entry.provider === 'claude' ? (
											<>
												<QuotaArc window={rings.outer} radius={10} width={2.6} now={now} />
												<QuotaArc window={rings.inner} radius={5.6} width={2.4} now={now} />
											</>
										) : (
											<QuotaArc window={rings.outer} radius={9} width={3.4} now={now} />
										)}
									</svg>
									<Glyph name={entry.provider === 'claude' ? 'claude' : 'openai'} size={11} />
								</>
							)}
							<span className={s.percent}>
								{quotaPercent(locale, window.exhausted ? 0 : window.remaining)}
							</span>
						</span>
					);
				})}
			</Button>
			{/* In the launch sheet (a modal dialog) the popover stays a descendant of the sheet, so it is not inert. */}
			<Popover
				id={id}
				open={open}
				onClose={hover.close}
				anchor={button}
				side={placement === 'rail' ? 'right' : placement === 'above' ? 'top' : 'bottom'}
				align={placement === 'below' ? 'end' : placement === 'rail' ? 'end' : 'start'}
				width={300}
				label={t(locale, 'Subscription limits')}
				locale={locale}
				data-quota-popover
				// The hover popover's props carry the nub (`arrow`, spec/appearance#component-details).
				{...hover.popover}>
				<div className={s.content}>
					{providers.map((entry, index) => (
						<section key={entry.provider} className={s.provider} data-provider={entry.provider}>
							{index > 0 && <hr className={s.separator} />}
							<ProviderLimits entry={entry} locale={locale} now={now} />
						</section>
					))}
				</div>
			</Popover>
		</>
	);
}

/** One ring of the indicator: the track and the arc of what is left, in the window's tone (spec/appearance#evolution-redesign). */
function QuotaArc({
	window,
	radius,
	width,
	now,
	center = 13,
}: {
	window: QuotaWindow | null;
	radius: number;
	width: number;
	now: number;
	/** The rings' centre: 13 in the 26 box, 15 in the rail's 30 box. */ center?: number;
}) {
	const left = !window || window.exhausted ? 0 : window.remaining;
	return (
		<g
			className={s.ring}
			data-ring-tone={window ? quotaTone(window) : undefined}
			data-ring-stale={(window && isQuotaStale(window, now)) || undefined}
			data-exhausted={window?.exhausted || undefined}
			data-remaining={window ? Math.round(left * 100) : undefined}>
			<circle
				cx={center}
				cy={center}
				r={radius}
				fill="none"
				strokeWidth={width}
				className={s.track}
			/>
			{left > 0 && (
				<circle
					cx={center}
					cy={center}
					r={radius}
					fill="none"
					strokeWidth={width}
					strokeLinecap="round"
					strokeDasharray={quotaRingDash(left, radius)}
					transform={`rotate(-90 ${center} ${center})`}
					className={s.arc}
				/>
			)}
		</g>
	);
}
function ProviderLimits({
	entry,
	locale,
	now,
}: {
	entry: ProviderQuota;
	locale: Locale;
	now: number;
}) {
	const windows = liveWindows(entry, now),
		observed = windows.length ? Math.max(...windows.map((window) => window.observedAt)) : null;
	const stale = observed !== null && isQuotaStale({ observedAt: observed }, now);
	return (
		<>
			<div className={s.head}>
				<Glyph name={entry.provider === 'claude' ? 'claude' : 'openai'} size={12} />
				<strong>{providerName(entry.provider)}</strong>
				{entry.plan && <span className={s.caption}>{entry.plan}</span>}
				<span className={s.space} />
				{observed !== null && (
					<span className={s.caption} data-stale={stale || undefined}>
						{quotaAgeLabel(locale, observed, now)}
					</span>
				)}
			</div>
			{entry.access === 'api-key' ? (
				<p className={s.note}>
					{t(locale, 'Signed in with an API key. There is no subscription limit here.')}
				</p>
			) : (
				windows.map((window) => {
					const tone = quotaTone(window),
						left = window.exhausted ? 0 : window.remaining,
						label = quotaWindowLabel(locale, entry.provider, window);
					// spec/appearance#evolution-redesign: each row starts with its own ring; the window the eye chose is the selected row.
					return (
						<div
							key={window.id}
							className={s.row}
							data-tone={tone}
							data-watched={entry.watch === window.id || undefined}
							data-stale={isQuotaStale(window, now) || undefined}>
							<svg
								width="18"
								height="18"
								viewBox="0 0 26 26"
								aria-hidden="true"
								className={s.rings}>
								<QuotaArc window={window} radius={9} width={3.4} now={now} />
							</svg>
							<span className={s.label}>{label}</span>
							<span className={s.value}>
								{window.exhausted ? (
									t(locale, 'Limit reached')
								) : (
									<>
										<span>{quotaPercent(locale, left)}</span>
										<small className={s.unit}>{t(locale, 'left')}</small>
									</>
								)}
							</span>
							<div className={s.sub}>
								<div
									className={s.track}
									role="progressbar"
									aria-label={label}
									aria-valuemin={0}
									aria-valuemax={100}
									aria-valuenow={Math.round(left * 100)}
									aria-valuetext={`${quotaPercent(locale, left)} ${t(locale, 'left')}`}>
									<span style={{ width: `${Math.round(left * 100)}%` }} />
								</div>
								<span className={s.caption}>{quotaResetLabel(locale, window, now)}</span>
								{/* spec/agents-and-providers#usage: the eye picks the window the indicator shows; pressing the chosen one returns to the tightest. */}
								<IconButton
									size="s"
									className={s.eye}
									aria-pressed={entry.watch === window.id}
									label={t(locale, 'Show «{window}» in the indicator').replace('{window}', label)}
									hint={t(locale, 'Show in the indicator')}
									onClick={() => {
										void globalThis.window.brigadir
											.watchQuota(entry.provider, entry.watch === window.id ? null : window.id)
											.catch(() => {});
									}}>
									<Glyph name="sidebar-eye" size={13} />
								</IconButton>
							</div>
						</div>
					);
				})
			)}
		</>
	);
}
