/**
 * spec/remote-access-and-mobile#architecture, spec/remote-access-and-mobile#module-and-settings: the working machine's pairing window — a fresh 8-character code for 5 minutes, five
 * tries, one device. The window owns the timer and the tries; the listener (`gateway.ts`) runs the protocol.
 */
import { randomBytes } from 'node:crypto';
import {
	pairingAlphabet,
	pairingCodeLength,
	type RemoteNetwork,
	type RemotePairing,
} from '@brigadir/core';

export const pairingWindowMs = 5 * 60_000;
export const pairingAttempts = 5;
/** 8 characters of Crockford base32: one random byte's low 5 bits per character, uniform since 256 = 8 · 32. */
export function newPairingCode(): string {
	return Array.from(randomBytes(pairingCodeLength), (byte) => pairingAlphabet[byte & 31]).join('');
}
type Pending = {
	device: string;
	cert: string;
	fingerprint: string;
	settle(accept: boolean, name: string | null): void;
};
export class PairingWindow {
	private state: RemotePairing = { state: 'idle' };
	private timer: ReturnType<typeof setTimeout> | null = null;
	private pending: Pending | null = null;
	/** A run that sent `pair-a` (its try is spent) holds the window: one device at a time (spec/remote-access-and-mobile#pairing). */
	busy = false;
	constructor(
		private readonly changed: (
			state: RemotePairing,
			reason: 'expired' | 'exhausted' | null
		) => void,
		private readonly now: () => number = Date.now,
		private readonly windowMs = pairingWindowMs
	) {}
	get current(): RemotePairing {
		return this.state;
	}
	get isOpen(): boolean {
		return this.state.state === 'open' || this.state.state === 'confirm';
	}
	/** Tries left in an open window; 0 otherwise. */
	get attemptsLeft(): number {
		return this.state.state === 'open' ? this.state.attemptsLeft : 0;
	}
	/** The code of an open window, or null. */
	get code(): string | null {
		return this.state.state === 'open' ? this.state.code : null;
	}
	open(code = newPairingCode()): RemotePairing {
		this.clear();
		const expiresAt = new Date(this.now() + this.windowMs).toISOString();
		this.state = { state: 'open', code, expiresAt, attemptsLeft: pairingAttempts };
		this.timer = setTimeout(() => this.finish({ state: 'expired' }, 'expired'), this.windowMs);
		this.timer.unref?.();
		this.changed(this.state, null);
		return this.state;
	}
	/** A try begins: it counts now, so a peer that learns the answer and hangs up has still spent it. */
	spend(): boolean {
		if (this.state.state !== 'open' || this.state.attemptsLeft <= 0) return false;
		this.state = { ...this.state, attemptsLeft: this.state.attemptsLeft - 1 };
		this.changed(this.state, null);
		return true;
	}
	/** A wrong code: the try stays spent; the last one closes the window. */
	failed(): number {
		if (this.state.state !== 'open') return 0;
		const left = this.state.attemptsLeft;
		if (left <= 0) this.finish({ state: 'exhausted' }, 'exhausted');
		return left;
	}
	/** The code matched: the person confirms the device's name on the working machine before it is trusted. */
	matched(
		device: string,
		cert: string,
		fingerprint: string,
		address: string | null = null,
		network: RemoteNetwork | null = null
	): Promise<{ accept: boolean; name: string | null }> {
		if (this.state.state !== 'open') return Promise.resolve({ accept: false, name: null });
		const { expiresAt } = this.state;
		this.state = { state: 'confirm', device, fingerprint, expiresAt, address, network };
		this.changed(this.state, null);
		return new Promise((resolve) => {
			this.pending = {
				device,
				cert,
				fingerprint,
				settle: (accept, name) => resolve({ accept, name }),
			};
		});
	}
	/** The person's answer. */
	confirm(accept: boolean, name: string | null): boolean {
		const pending = this.pending;
		if (!pending || this.state.state !== 'confirm') return false;
		this.pending = null;
		pending.settle(accept, name);
		return true;
	}
	paired(device: string) {
		this.finish({ state: 'paired', device }, null);
	}
	declined() {
		this.finish({ state: 'declined' }, null);
	}
	close() {
		this.finish({ state: 'idle' }, null);
	}
	private finish(state: RemotePairing, reason: 'expired' | 'exhausted' | null) {
		this.clear();
		this.state = state;
		this.changed(state, reason);
	}
	private clear() {
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		const pending = this.pending;
		this.pending = null;
		pending?.settle(false, null);
	}
}
