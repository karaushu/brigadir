/**
 * spec/remote-access-and-mobile#module-and-settings, spec/remote-access-and-mobile#transport-and-protocol, spec/remote-access-and-mobile#networking: the working machine says `_brigadir._tcp` in the LAN while access is
 * on; a device looks for it while the Connect list is open. mDNS is a hint only — trust comes from pairing, not from a
 * name — so the record carries a short id derived from the certificate, never the fingerprint itself.
 */
import { createHash } from 'node:crypto';
import { Bonjour, type Browser, type Service } from 'bonjour-service';
import { bidiControls, type FoundMachine } from '@brigadir/core';
import { classifyAddress } from './interfaces';

export const serviceType = 'brigadir';
/** spec/remote-access-and-mobile#networking: a machine's id in mDNS — 16 hex of SHA-256 over a label and its certificate's fingerprint. */
export function mdnsId(fingerprint: string): string {
	return createHash('sha256').update(`brigadir-mdns-1\0${fingerprint}`).digest('hex').slice(0, 16);
}
/**
 * The instance name on the network: the machine's name and the start of its id, so two machines that share a system
 * name do not knock each other's record out (bonjour-service's probe silently drops the second).
 */
export function mdnsInstance(name: string, id: string): string {
	return `${name.slice(0, 48)} (${id.slice(0, 6)})`;
}
export type Advert = {
	name: string;
	port: number;
	pairingPort: number;
	/** The certificate's fingerprint; the record carries `mdnsId` of it. */
	fingerprint: string;
	/** The addresses the gateway listens on now: a change says the machine again (its A/AAAA records changed). */
	addresses: string[];
};
/** A found machine as mDNS says it: `id` is the short mDNS id (`mdnsId`), not a fingerprint. */
export type HeardMachine = FoundMachine & { id: string | null };
/** How long a goodbye may take on quit or when access turns off. */
const goodbyeMs = 1000;
/** A device asks the LAN again this often while its list is open (a machine that came up, a network change). */
const queryMs = 10_000;

export class Mdns {
	private bonjour: Bonjour | null = null;
	private advertised: Service | null = null;
	private advert: string | null = null;
	private browser: Browser | null = null;
	private query: ReturnType<typeof setInterval> | null = null;
	/** The goodbye of the record being taken down; a new record and the release wait for it. */
	private leaving: Promise<void> = Promise.resolve();
	constructor(private readonly log: (line: string) => void = () => {}) {}
	private get instance() {
		this.bonjour ??= new Bonjour(undefined, (error: unknown) =>
			this.log(`remote: mdns: ${error instanceof Error ? error.message : String(error)}`)
		);
		return this.bonjour;
	}
	/**
	 * Says the machine (or stops with null); the same advert twice does nothing. Stopping sends the goodbye (TTL 0) and
	 * resolves once it went (at most a second), so a device drops the machine at once.
	 */
	advertise(advert: Advert | null): Promise<void> {
		const key = advert
			? JSON.stringify({ ...advert, addresses: [...advert.addresses].sort() })
			: null;
		if (key === this.advert) return this.leaving;
		this.advert = key;
		if (this.advertised) {
			const old = this.advertised;
			this.advertised = null;
			const previous = this.leaving;
			this.leaving = previous.then(
				() =>
					new Promise<void>((resolve) => {
						const timer = setTimeout(resolve, goodbyeMs);
						timer.unref?.();
						try {
							old.stop?.(() => {
								clearTimeout(timer);
								resolve();
							});
						} catch {
							clearTimeout(timer);
							resolve();
						}
					})
			);
		}
		if (!advert) {
			const leaving = this.leaving.then(() => this.release());
			this.leaving = leaving;
			return leaving;
		}
		const id = mdnsId(advert.fingerprint);
		this.leaving = this.leaving.then(() => {
			// A newer advert replaced this one while the goodbye went out.
			if (this.advert !== key) return;
			try {
				this.advertised = this.instance.publish({
					name: mdnsInstance(advert.name, id),
					type: serviceType,
					port: advert.port,
					txt: { id, n: advert.name, pp: String(advert.pairingPort), v: '2' },
				});
				this.advertised.on('error', (error: Error) => this.log(`remote: mdns: ${error.message}`));
			} catch (error) {
				this.log(`remote: mdns: ${error instanceof Error ? error.message : String(error)}`);
			}
		});
		return this.leaving;
	}
	/** Looks for machines; `found` gets the whole list on every change. */
	browse(found: ((machines: HeardMachine[]) => void) | null) {
		if (this.query) clearInterval(this.query);
		this.query = null;
		if (this.browser) {
			this.browser.stop();
			this.browser.removeAllListeners();
			this.browser = null;
		}
		if (!found) {
			void this.leaving.then(() => this.release());
			return;
		}
		const browser = this.instance.find({ type: serviceType });
		const publish = () =>
			found(browser.services.map(toFound).filter((item) => item.addresses.length));
		browser.on('up', publish);
		browser.on('down', publish);
		browser.on('txt-update', publish);
		browser.on('srv-update', publish);
		this.browser = browser;
		this.query = setInterval(() => browser.update(), queryMs);
		this.query.unref?.();
		publish();
	}
	/** Asks the LAN again now (the network changed). */
	refresh() {
		this.browser?.update();
	}
	private release() {
		if (this.advertised || this.browser || !this.bonjour) return;
		const bonjour = this.bonjour;
		this.bonjour = null;
		bonjour.destroy();
	}
	/** Quit: the goodbye goes out before the socket closes. */
	close(): Promise<void> {
		this.browse(null);
		return this.advertise(null);
	}
}
/** A record as the device takes it; whatever is off is dropped or defaulted, never trusted. */
export function toFound(
	service: Pick<Service, 'name' | 'port' | 'addresses' | 'txt'>
): HeardMachine {
	const txt = (service.txt ?? {}) as Record<string, unknown>;
	const id = typeof txt.id === 'string' && /^[0-9a-f]{16}$/.test(txt.id) ? txt.id : null;
	const pairingPort = Number(txt.pp);
	const name =
		typeof txt.n === 'string' && txt.n.trim()
			? txt.n
			: String(service.name).replace(/ \([0-9a-f]{6}\)$/, '');
	return {
		name: name
			.replace(/[\u0000-\u001f\u007f]/g, '')
			.replace(new RegExp(bidiControls.source, 'g'), '')
			.slice(0, 64),
		id,
		addresses: [
			...new Set(
				(service.addresses ?? [])
					.map((address) => address.replace(/%.*$/, ''))
					.filter((address) => classifyAddress(address) !== null)
			),
		].slice(0, 16),
		port: service.port,
		pairingPort:
			Number.isSafeInteger(pairingPort) && pairingPort > 0 && pairingPort < 65536
				? pairingPort
				: 7421,
	};
}
