import { t, type Locale } from '@brigadir/core';
import { Glyph } from './ui/Glyph';
import { WebLink } from './ui/WebLink';
import s from './RemoteOverview.module.css';
/**
 * spec/settings-modules-and-onboarding#intro-remote (rule 17): what remote access is, the same in the intro's Remote access step and Settings ▸ Modules ▸ Remote
 * access — this machine by its name, the other computer, a lock on the dashed line that turns green and two dots that run
 * along it while access is on.
 */
export function RemoteScheme({
	locale,
	machine,
	on,
}: {
	locale: Locale;
	machine: string;
	on: boolean;
}) {
	return (
		<div className={s.pair} data-remote-scheme>
			<div className={s.node} data-here>
				<span>
					<Glyph name="machine" size={22} />
				</span>
				<strong title={machine}>{machine}</strong>
				<small>{t(locale, 'This machine')}</small>
			</div>
			<div className={s.link} data-on={on || undefined} aria-hidden="true">
				{/* The dots run only while access is on — nothing travels to a closed lock. */}
				{on && (
					<>
						<i className={s.run} />
						<i className={s.run} />
					</>
				)}
				<span className={s.lock}>
					<Glyph name="scope-lock" size={12} />
				</span>
			</div>
			<div className={s.node}>
				<span>
					<Glyph name="laptop" size={22} />
				</span>
				<strong>{t(locale, 'Another computer')}</strong>
				<small>macOS, Linux</small>
			</div>
		</div>
	);
}
/** spec/remote-access-and-mobile#tailscale-guidance: where Tailscale is downloaded — the facts, the phone's steps and the client's list of machines. */
export const tailscaleDownload = 'https://tailscale.com/download';
export function TailscaleLink({ locale }: { locale: Locale }) {
	return (
		<WebLink href={tailscaleDownload} data-tailscale-link>
			{t(locale, 'Download Tailscale')}
		</WebLink>
	);
}
/**
 * spec/settings-modules-and-onboarding#intro-remote: the network and sleep — two facts under the scheme. spec/remote-access-and-mobile#tailscale-guidance: the network fact
 * says Tailscale is installed on both devices away from home and links its download; `network` keeps only that fact
 * (the intro's step while access is on).
 */
export function RemoteFacts({ locale, network = false }: { locale: Locale; network?: boolean }) {
	return (
		<ul className={s.facts} data-remote-facts>
			<li data-remote-fact="network">
				<Glyph name="network" size={14} />
				<span>
					{t(
						locale,
						'On the same home network nothing else is needed. Away from home and from a phone, Tailscale on both devices.'
					)}{' '}
					<TailscaleLink locale={locale} />
				</span>
			</li>
			{!network && (
				<>
					<li>
						<Glyph name="clock" size={14} />
						<span>
							{t(
								locale,
								'While remote access is on, the machine stays awake. A closed laptop lid still puts it to sleep.'
							)}
						</span>
					</li>
				</>
			)}
		</ul>
	);
}
