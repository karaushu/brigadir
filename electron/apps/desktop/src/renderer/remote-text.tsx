import { Fragment, type ReactNode } from 'react';
import {
	relativeAge,
	remoteClock,
	remoteMoment,
	remoteNetworkName,
	t,
	type Locale,
	type MessageKey,
	type RemoteAddress,
	type RemoteAuditKind,
	type RemoteDevice,
	type RemoteNetwork,
	type FoundMachine,
	type PairedMachine,
	type RemoteReach,
	type RemoteSession,
} from '@brigadir/core';

/** A catalog text with `{name}` filled in. */
export function fill(locale: Locale, key: MessageKey, values: Record<string, string | number>) {
	return t(locale, key).replace(/\{(\w+)\}/g, (all, name: string) =>
		name in values ? String(values[name]) : all
	);
}
/** `**bold**` parts of a catalog text as <b>; the rest stays text (docs/ui-copy.md: one sentence, one key). */
export function rich(
	text: string,
	className?: string,
	/** A bold part set in mono (a machine's name). */ mono?: {
		text: string;
		className: string;
	}
): ReactNode {
	return text.split('**').map((part, index) =>
		index % 2 ? (
			<b key={index} className={mono && part === mono.text ? mono.className : className}>
				{part}
			</b>
		) : (
			<Fragment key={index}>{part}</Fragment>
		)
	);
}
/** `LAN 192.168.1.24 · Tailscale 100.88.14.2`: the first address of each network, addresses in mono. */
export function listeningParts(addresses: readonly RemoteAddress[], mono: string): ReactNode {
	const first = new Map<string, RemoteAddress>();
	for (const item of addresses) if (!first.has(item.network)) first.set(item.network, item);
	return [...first.values()].map((item, index) => (
		<Fragment key={item.network}>
			{index > 0 && ' · '}
			{remoteNetworkName(item.network)} <span className={mono}>{item.address}</span>
		</Fragment>
	));
}
/** `LAN · Tailscale`: the networks the gateway listens on. */
export function networkNames(addresses: readonly RemoteAddress[]): string {
	return [...new Set(addresses.map((item) => remoteNetworkName(item.network)))].join(' · ');
}
/** The second line of a device row (spec/remote-access-and-mobile#module-and-settings). */
export function deviceLine(locale: Locale, device: RemoteDevice, now = Date.now()): string {
	if (device.blocked)
		return device.lastFailureAt
			? fill(locale, 'Blocked: 10 wrong passwords · {age} ago', {
					age: relativeAge(locale, device.lastFailureAt, now),
				})
			: t(locale, 'Blocked: 10 wrong passwords');
	if (device.lastLoginAt && device.lastAddress)
		return fill(locale, 'Signed in {when} · {address} · {network}', {
			when: remoteMoment(locale, device.lastLoginAt, now),
			address: device.lastAddress.address,
			network: remoteNetworkName(device.lastAddress.network),
		});
	return fill(locale, 'Paired {when}', { when: remoteMoment(locale, device.pairedAt, now) });
}
/** A line of the log (spec/remote-access-and-mobile#module-and-settings): what happened, and how loud. */
export const auditEvents: Record<RemoteAuditKind, { key: MessageKey; tone?: 'warn' | 'err' }> = {
	'access-enabled': { key: 'Access turned on' },
	'access-disabled': { key: 'Access turned off' },
	'password-set': { key: 'Password set' },
	'password-changed': { key: 'Password changed' },
	renamed: { key: 'Machine renamed' },
	'pairing-opened': { key: 'Pairing opened' },
	'pairing-closed': { key: 'Pairing closed' },
	'pairing-failed': { key: 'Wrong pairing code', tone: 'warn' },
	'pairing-exhausted': { key: 'Pairing stopped: 5 wrong codes', tone: 'err' },
	'pairing-expired': { key: 'Pairing code expired' },
	'pairing-declined': { key: 'Pairing declined' },
	paired: { key: 'Paired' },
	login: { key: 'Signed in' },
	'login-failed': { key: 'Wrong password', tone: 'warn' },
	'login-refused': { key: 'Refused', tone: 'warn' },
	'tls-rejected': { key: 'Refused: device not paired', tone: 'warn' },
	blocked: { key: 'Blocked after 10 passwords', tone: 'err' },
	unblocked: { key: 'Unblocked' },
	revoked: { key: 'Revoked' },
	'revoked-all': { key: 'All devices revoked' },
	expired: { key: 'Revoked: 30 days without sign-in' },
	disconnected: { key: 'Disconnected' },
	'took-back': { key: 'Control taken back' },
	'took-over': { key: 'Took control' },
	'version-mismatch': { key: 'Another version', tone: 'warn' },
	'call-refused': { key: 'Call refused', tone: 'warn' },
	'settings-changed': { key: 'Changed settings' },
	dropped: { key: 'Disconnected from this machine' },
	'module-enabled': { key: 'Module turned on' },
	'module-disabled': { key: 'Module turned off' },
	'phone-enabled': { key: 'Phone access turned on' },
	'phone-disabled': { key: 'Phone access turned off' },
	'push-subscribed': { key: 'Phone notifications on' },
	'push-removed': { key: 'Phone notifications off' },
};
/** `4F9A 21C7 · E0B3 5D18`: the start of a certificate's fingerprint, as the pairing dialog shows it. */
export function shortKey(fingerprint: string): string {
	const hex = fingerprint.slice(0, 16).toUpperCase();
	return `${hex.slice(0, 4)} ${hex.slice(4, 8)} · ${hex.slice(8, 12)} ${hex.slice(12, 16)}`;
}
/**
 * The network of an address in the log, a toast or the pairing dialog: the one the gateway decided for the listener the
 * connection reached (`network`, spec/remote-access-and-mobile#pairing). Only lines written before it was stored are read by the address, as
 * that gateway did: 100.64.0.0/10 was Tailscale then.
 */
export function addressNetwork(address: string, network?: RemoteNetwork | null): string {
	if (network) return remoteNetworkName(network);
	if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address) || /^fd7a:115c:a1e0:/i.test(address))
		return 'Tailscale';
	if (/^127\./.test(address) || address === '::1') return 'loopback';
	return 'LAN';
}

/**
 * spec/remote-access-and-mobile#networking, spec/remote-access-and-mobile#remote-button: what this computer knows of a paired machine right now — its open window (`live`), an answer to
 * the TLS touch or an mDNS record (`on`, with the network that answered), no answer (`off`) or not yet (`check`).
 */
export type MachineReach =
	| { state: 'live'; session: RemoteSession }
	| { state: 'on'; address: RemoteAddress | null }
	| { state: 'off'; tailscale: boolean }
	| { state: 'check' };
export function machineReach(
	machine: PairedMachine,
	reach: readonly RemoteReach[],
	found: readonly FoundMachine[],
	sessions: readonly RemoteSession[] = []
): MachineReach {
	const session = sessions.find((item) => item.machineId === machine.id && item.state !== 'closed');
	if (session) return { state: 'live', session };
	const touch = reach.find((item) => item.machineId === machine.id);
	if (touch?.state === 'answered')
		return {
			state: 'on',
			address:
				touch.network && touch.address
					? { network: touch.network, address: touch.address }
					: (machine.addresses[0] ?? null),
		};
	if (touch?.state === 'silent') return { state: 'off', tailscale: touch.tailscale };
	if (found.some((item) => item.id === machine.id))
		return { state: 'on', address: machine.addresses[0] ?? null };
	return { state: 'check' };
}
/** The dot on a machine's glyph: green answers or has its window open, grey does not answer, none while checking. */
export function reachDot(reach: MachineReach): 'on' | 'off' | undefined {
	return reach.state === 'live' || reach.state === 'on'
		? 'on'
		: reach.state === 'off'
			? 'off'
			: undefined;
}
/** `LAN · 4 ms`: where an open window of a machine is connected. */
function liveLink(locale: Locale, session: RemoteSession): string {
	const network = session.address ? remoteNetworkName(session.address.network) : '';
	return session.latencyMs !== null && network
		? fill(locale, '{network} · {latency} ms', { network, latency: session.latencyMs })
		: network;
}
/** The second line of a machine in the chip's popover: «LAN · reachable», «Unavailable», «Checking…», «Window open · LAN · 4 ms». */
export function reachShort(locale: Locale, reach: MachineReach): string {
	if (reach.state === 'live')
		return [t(locale, 'Window open (machine)'), liveLink(locale, reach.session)]
			.filter(Boolean)
			.join(' · ');
	if (reach.state === 'on')
		return reach.address
			? fill(locale, '{network} · reachable', { network: remoteNetworkName(reach.address.network) })
			: t(locale, 'Available (machine)');
	if (reach.state === 'off') return t(locale, 'Unavailable (machine)');
	return t(locale, 'Checking… (machine)');
}
/** The second line of a machine in Settings ▸ Remote: «LAN · 192.168.1.31 · last today at 18:05» and its other states. */
export function reachLine(
	locale: Locale,
	machine: PairedMachine,
	reach: MachineReach,
	now = Date.now()
): string {
	const when = machine.lastConnectedAt
		? fill(locale, 'last {when}', { when: remoteMoment(locale, machine.lastConnectedAt, now) })
		: fill(locale, 'paired {when}', { when: remoteMoment(locale, machine.pairedAt, now) });
	if (reach.state === 'live') {
		const { address, latencyMs, since } = reach.session;
		if (!address) return '';
		return `${remoteNetworkName(address.network)} · ${fill(
			locale,
			latencyMs !== null ? '{address} · {latency} ms · since {time}' : '{address} · since {time}',
			{ address: address.address, latency: latencyMs ?? 0, time: remoteClock(locale, since) }
		)}`;
	}
	if (reach.state === 'check') return t(locale, 'Checking LAN and Tailscale…');
	if (reach.state === 'off')
		return [
			t(
				locale,
				reach.tailscale
					? 'No answer on the LAN or through Tailscale'
					: 'Unavailable outside the LAN without Tailscale'
			),
			when,
		].join(' · ');
	const address = reach.address ?? machine.addresses[0] ?? null;
	return [address ? remoteNetworkName(address.network) : null, address?.address, when]
		.filter(Boolean)
		.join(' · ');
}
