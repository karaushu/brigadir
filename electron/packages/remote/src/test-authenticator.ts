/**
 * Tests only (spec/remote-access-and-mobile#phone-network): a software WebAuthn authenticator — the bytes a browser and a phone's key would send, built the
 * way WebAuthn Level 3 spec/chat#row-engine lays them out, so the verifier meets real structures and every field can be bent for the
 * negative paths. Not exported from the package.
 */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { fromBase64Url, toBase64Url } from './base64';
import type { CborValue } from './cbor';

export function encodeCbor(value: CborValue): Uint8Array {
	const out: number[] = [];
	const head = (major: number, n: number) => {
		if (n < 24) out.push((major << 5) | n);
		else if (n < 256) out.push((major << 5) | 24, n);
		else if (n < 65536) out.push((major << 5) | 25, n >> 8, n & 255);
		else out.push((major << 5) | 26, (n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
	};
	const item = (value: CborValue) => {
		if (typeof value === 'number') {
			if (value >= 0) head(0, value);
			else head(1, -1 - value);
		} else if (value instanceof Uint8Array) {
			head(2, value.length);
			out.push(...value);
		} else if (typeof value === 'string') {
			const bytes = new TextEncoder().encode(value);
			head(3, bytes.length);
			out.push(...bytes);
		} else if (Array.isArray(value)) {
			head(4, value.length);
			value.forEach(item);
		} else if (value instanceof Map) {
			head(5, value.size);
			for (const [key, item2] of value) {
				item(key);
				item(item2);
			}
		} else if (value === false) out.push(0xf4);
		else if (value === true) out.push(0xf5);
		else out.push(0xf6);
	};
	item(value);
	return Uint8Array.from(out);
}
export type Bend = {
	type?: string;
	origin?: string;
	challenge?: string;
	crossOrigin?: boolean;
	rpId?: string;
	flags?: number;
	signCount?: number;
	extra?: Uint8Array;
	userHandle?: Uint8Array | null;
	signature?: (signature: Uint8Array) => Uint8Array;
	/** The credential id the response names (rawId), when it should differ from the key's. */
	id?: string;
};
const sha256 = (data: Uint8Array | string) =>
	new Uint8Array(createHash('sha256').update(data).digest());
export class SoftAuthenticator {
	readonly credentialId = new Uint8Array(randomBytes(16));
	private readonly privateKey: KeyObject;
	private readonly cose: Map<number | string, CborValue>;
	signCount = 0;
	userId: Uint8Array | null = null;
	constructor(readonly algorithm: -7 | -8 | -257 = -7) {
		const pair =
			algorithm === -7
				? generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
				: algorithm === -8
					? generateKeyPairSync('ed25519')
					: generateKeyPairSync('rsa', { modulusLength: 2048 });
		this.privateKey = pair.privateKey;
		const jwk = pair.publicKey.export({ format: 'jwk' });
		const b = (text: string | undefined) => fromBase64Url(text!);
		this.cose =
			algorithm === -7
				? new Map<number | string, CborValue>([
						[1, 2],
						[3, -7],
						[-1, 1],
						[-2, b(jwk.x)],
						[-3, b(jwk.y)],
					])
				: algorithm === -8
					? new Map<number | string, CborValue>([
							[1, 1],
							[3, -8],
							[-1, 6],
							[-2, b(jwk.x)],
						])
					: new Map<number | string, CborValue>([
							[1, 3],
							[3, -257],
							[-1, b(jwk.n)],
							[-2, b(jwk.e)],
						]);
	}
	get id(): string {
		return toBase64Url(this.credentialId);
	}
	private clientData(type: string, challenge: string, origin: string, bend: Bend) {
		const data: Record<string, unknown> = {
			type: bend.type ?? type,
			challenge: bend.challenge ?? challenge,
			origin: bend.origin ?? origin,
		};
		if (bend.crossOrigin !== undefined) data.crossOrigin = bend.crossOrigin;
		return new TextEncoder().encode(JSON.stringify(data));
	}
	private authData(rpId: string, flags: number, signCount: number, rest: Uint8Array[]) {
		const count = new Uint8Array(4);
		new DataView(count.buffer).setUint32(0, signCount);
		return Uint8Array.from([
			...sha256(rpId),
			flags,
			...count,
			...rest.flatMap((part) => [...part]),
		]);
	}
	/** `navigator.credentials.create` with `attestation: 'none'`; UP, UV and AT set. */
	create(
		options: { challenge: string; rpId: string; origin: string; userId: string },
		bend: Bend = {}
	) {
		this.userId = fromBase64Url(options.userId);
		const length = Uint8Array.of(this.credentialId.length >> 8, this.credentialId.length & 255);
		const attested = [new Uint8Array(16), length, this.credentialId, encodeCbor(this.cose)];
		const authData = this.authData(
			bend.rpId ?? options.rpId,
			bend.flags ?? 0x45,
			bend.signCount ?? this.signCount,
			[...attested, ...(bend.extra ? [bend.extra] : [])]
		);
		const attestationObject = encodeCbor(
			new Map<number | string, CborValue>([
				['fmt', 'none'],
				['attStmt', new Map()],
				['authData', authData],
			])
		);
		return {
			id: bend.id ?? this.id,
			clientDataJSON: this.clientData('webauthn.create', options.challenge, options.origin, bend),
			attestationObject,
		};
	}
	/** `navigator.credentials.get`: UP and UV set, the counter one up unless bent. */
	get(options: { challenge: string; rpId: string; origin: string }, bend: Bend = {}) {
		if (bend.signCount === undefined && this.signCount > 0) this.signCount++;
		const clientDataJSON = this.clientData('webauthn.get', options.challenge, options.origin, bend);
		const authenticatorData = this.authData(
			bend.rpId ?? options.rpId,
			bend.flags ?? 0x05,
			bend.signCount ?? this.signCount,
			bend.extra ? [bend.extra] : []
		);
		const signed = Buffer.concat([authenticatorData, sha256(clientDataJSON)]);
		let signature: Uint8Array = new Uint8Array(
			this.algorithm === -8
				? sign(null, signed, this.privateKey)
				: sign('sha256', signed, this.privateKey)
		);
		if (bend.signature) signature = bend.signature(signature);
		return {
			id: bend.id ?? this.id,
			clientDataJSON,
			authenticatorData,
			signature,
			userHandle: bend.userHandle === undefined ? this.userId : bend.userHandle,
		};
	}
}
