/**
 * spec/remote-access-and-mobile#phone-app: the home header's two chips — the machine (its name and the link's dot, «slow»,
 * «connecting…», «unavailable») and the subscription quota (one window per provider, % left; < 25 % amber, 0 % red).
 * Each is a 44 target; the pill drawn inside it is 30 high.
 */
import {
	displayWindow,
	liveWindows,
	t,
	type AgentProvider,
	type Locale,
	type ProviderQuota,
	type QuotaSnapshot,
	type QuotaWindow,
} from '@brigadir/core';
import { Glyph } from '../../renderer/ui/Glyph';
import type { Link } from '../store';
import { Icon } from './Icon';
import s from './Header.module.css';

export function MachineChip({
	machine,
	link,
	locale,
	onClick,
}: {
	machine: string;
	link: Link;
	locale: Locale;
	onClick(): void;
}) {
	const note =
		link === 'slow'
			? t(locale, 'slow')
			: link === 'connecting'
				? t(locale, 'connecting…')
				: link === 'off'
					? t(locale, 'unavailable (machine)')
					: null;
	return (
		<button
			type="button"
			className={s.machine}
			data-machine-chip={link}
			aria-label={`${t(locale, 'Working machine')} ${machine}${note ? ` · ${note}` : ''}`}
			onClick={onClick}>
			<span className={s.pill} aria-hidden="true" />
			<Icon name="machine" size={16} />
			<span>{machine}</span>
			<i className={s.dot} data-link={link} />
			{note && <small>{note}</small>}
		</button>
	);
}
/** The window a provider shows in the header: this phone's choice when it is live, else the machine's (spec/agents-and-providers#usage). */
export function shownWindow(
	entry: ProviderQuota,
	chosen: string | undefined,
	now = Date.now()
): QuotaWindow | null {
	return (
		(chosen ? liveWindows(entry, now).find((window) => window.id === chosen) : undefined) ??
		displayWindow(entry, now)
	);
}
export const quotaLevel = (window: Pick<QuotaWindow, 'remaining' | 'exhausted'>) =>
	window.exhausted || window.remaining <= 0 ? 'zero' : window.remaining < 0.25 ? 'warn' : 'normal';
export const percent = (remaining: number) => Math.max(0, Math.round(remaining * 100));
export function QuotaPill({
	quota,
	shown,
	locale,
	onClick,
}: {
	quota: QuotaSnapshot | null;
	shown: Partial<Record<AgentProvider, string>>;
	locale: Locale;
	onClick(): void;
}) {
	const items = (quota?.providers ?? []).flatMap((entry) => {
		const window = entry.access === 'api-key' ? null : shownWindow(entry, shown[entry.provider]);
		return window ? [{ provider: entry.provider, window }] : [];
	});
	if (!items.length) return null;
	const label = `${t(locale, 'Subscription limits')}: ${items
		.map(
			({ provider, window }) =>
				`${provider === 'claude' ? 'Claude' : 'Codex'} ${t(locale, '{percent} left').replace(
					'{percent}',
					`${percent(window.remaining)} %`
				)}`
		)
		.join(', ')}`;
	return (
		<button type="button" className={s.quota} aria-label={label} data-quota-pill onClick={onClick}>
			{items.map(({ provider, window }) => (
				<span key={provider} className={s.quotaItem} data-level={quotaLevel(window)}>
					<Glyph name={provider === 'claude' ? 'claude' : 'openai'} size={12} />
					{percent(window.remaining)}%
				</span>
			))}
		</button>
	);
}
