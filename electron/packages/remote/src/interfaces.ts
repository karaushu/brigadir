/**
 * spec/remote-access-and-mobile#architecture, research spec/chat#row-engine: the gateway listens only on named interfaces — private LAN addresses and Tailscale's —
 * never on 0.0.0.0 or a public address, and never through UPnP or a router.
 */
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import type { RemoteAddress, RemoteNetwork } from '@brigadir/core';

export function ipv4(address: string): number[] | null {
	const parts = address.split('.').map(Number);
	return parts.length === 4 &&
		parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
		? parts
		: null;
}
/** The first 16-bit groups of an IPv6 address, enough for prefix checks. */
export function ipv6Head(address: string): number[] | null {
	const plain = address.split('%')[0]!.toLowerCase();
	if (!/^[0-9a-f:.]+$/.test(plain)) return null;
	const [head, tail] = plain.split('::') as [string, string | undefined];
	const left = head ? head.split(':') : [];
	const right = tail ? tail.split(':') : [];
	const missing = 8 - left.length - right.length;
	if (tail === undefined && left.length !== 8) return null;
	const groups = [...left, ...Array(Math.max(0, missing)).fill('0'), ...right];
	return groups.slice(0, 4).map((group) => parseInt(group || '0', 16));
}
/** 100.64.0.0/10: Tailscale's IPv4 range, but also carrier-grade NAT (a phone's hotspot, a provider). */
export function isCgnat(address: string): boolean {
	const v4 = ipv4(address);
	return Boolean(v4 && v4[0] === 100 && v4[1]! >= 64 && v4[1]! <= 127);
}
function isTailscaleV6(address: string): boolean {
	const v6 = ipv6Head(address);
	return Boolean(v6 && v6[0] === 0xfd7a && v6[1] === 0x115c && v6[2] === 0xa1e0);
}
/**
 * Which network an address belongs to; null for anything we never listen on (public, link-local, multicast).
 * 100.64.0.0/10 is Tailscale only on Tailscale's interface (`onTailscale`, see `isTailscaleInterface`); anywhere else it
 * is carrier-grade NAT and counts as LAN (security review R1, S7).
 */
export function classifyAddress(address: string, onTailscale = false): RemoteNetwork | null {
	const v4 = ipv4(address);
	if (v4) {
		const [a, b] = v4 as [number, number];
		if (a === 127) return 'loopback';
		if (isCgnat(address)) return onTailscale ? 'tailscale' : 'lan';
		if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'lan';
		return null;
	}
	const v6 = ipv6Head(address);
	if (!v6) return null;
	if (address === '::1') return 'loopback';
	// Tailscale's ULA prefix fd7a:115c:a1e0::/48 comes before the general ULA range fc00::/7.
	if (isTailscaleV6(address)) return 'tailscale';
	if ((v6[0]! & 0xfe00) === 0xfc00) return 'lan';
	return null;
}
/**
 * Tailscale's own interface: `tailscale0` on Linux, `Tailscale` on Windows, and on macOS a `utunN` that also carries an
 * address of Tailscale's IPv6 prefix. Another VPN's utun or a hotspot's interface with a 100.64/10 address is not it.
 */
export function isTailscaleInterface(name: string, list: readonly NetworkInterfaceInfo[]): boolean {
	return /^tailscale/i.test(name) || list.some((item) => isTailscaleV6(item.address));
}
/** The addresses to listen on now, LAN first. */
export function listenAddresses(
	want: { lan: boolean; tailscale: boolean },
	interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()
): RemoteAddress[] {
	const found: RemoteAddress[] = [];
	for (const [name, list] of Object.entries(interfaces)) {
		const tailscale = isTailscaleInterface(name, list ?? []);
		for (const item of list ?? []) {
			if (item.internal) continue;
			const network = classifyAddress(item.address, tailscale);
			if ((network === 'lan' && want.lan) || (network === 'tailscale' && want.tailscale))
				if (!found.some((known) => known.address === item.address))
					found.push({ network, address: item.address });
		}
	}
	return found.sort((a, b) => (a.network === b.network ? 0 : a.network === 'lan' ? -1 : 1));
}
/** `host:port` for a URL: IPv6 literals in brackets. */
export function hostPort(address: string, port: number): string {
	return address.includes(':') && !address.startsWith('[')
		? `[${address}]:${port}`
		: `${address}:${port}`;
}
/** spec/remote-access-and-mobile#networking: this computer has Tailscale up — an interface of Tailscale with an address on it. */
export function hasTailscaleInterface(
	interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()
): boolean {
	return Object.entries(interfaces).some(
		([name, list]) =>
			isTailscaleInterface(name, list ?? []) && (list ?? []).some((item) => !item.internal)
	);
}
const v4Number = (parts: number[]) =>
	((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
/**
 * spec/remote-access-and-mobile#networking: `address` is on the same subnet as one of this computer's interfaces — IPv4 by the interface's
 * netmask, IPv6 by its /64 — so it is reachable without a router: home, the office, the same hotspot.
 */
export function onSameSubnet(
	address: string,
	interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()
): boolean {
	const v4 = ipv4(address);
	const v6 = v4 ? null : ipv6Head(address);
	if (!v4 && !v6) return false;
	for (const list of Object.values(interfaces))
		for (const item of list ?? []) {
			if (item.internal) continue;
			if (v4) {
				const own = ipv4(item.address),
					mask = ipv4(item.netmask);
				if (!own || !mask) continue;
				const m = v4Number(mask);
				if (m === 0) continue;
				if ((v4Number(own) & m) >>> 0 === (v4Number(v4) & m) >>> 0) return true;
			} else {
				const own = ipv6Head(item.address);
				// Link-local fe80::/64 is on every interface: it says nothing about a subnet.
				if (!own || (own[0]! & 0xffc0) === 0xfe80) continue;
				if (own.every((group, index) => group === v6![index])) return true;
			}
		}
	return false;
}
