/**
 * spec/remote-access-and-mobile#phone-network: WebAuthn on the working machine — the registration of a phone's passkey and each sign-in with it
 * (W3C WebAuthn Level 3 spec/editor#editor-principles, spec/editor#editor-principles), on `node:crypto` and the strict CBOR decoder.
 *
 * Attestation is not verified: the page asks for `none`, and the trust in the new key comes from the pairing code that
 * CPace checked on the same WebSocket. The authenticator's AAGUID is kept to name the key in the device list, nothing
 * more. User presence and user verification are required both times.
 */
import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { fromBase64Url, toBase64Url } from './base64';
import { CborError, decodeCbor, decodeCborItem, type CborValue } from './cbor';

/** COSE algorithms a passkey may use here, in the order the page offers them. */
export const passkeyAlgorithms = [-7, -8, -257] as const;
export type PasskeyAlgorithm = (typeof passkeyAlgorithms)[number];
/** A phone's passkey as `devices.json` keeps it. */
export type PasskeyRecord = {
	/** The credential id, base64url. */
	credentialId: string;
	/** The public key, SPKI DER in base64. */
	publicKey: string;
	algorithm: PasskeyAlgorithm;
	signCount: number;
	/** The authenticator model's id (36-character UUID), all zeros when the browser hides it. */
	aaguid: string;
	/** The domain the key belongs to: the machine's name in the tailnet when it was registered. */
	rpId: string;
	/** The `user.id` given at registration, base64url: a sign-in's `userHandle` must be it. */
	userId: string;
	/** The flags of the registration: whether the key may be synced (backup eligible), for the device list. */
	backupEligible: boolean;
};
export type WebAuthnFailure =
	| 'client-data'
	| 'type'
	| 'challenge'
	| 'origin'
	| 'rp'
	| 'presence'
	| 'verification'
	| 'authenticator-data'
	| 'credential'
	| 'algorithm'
	| 'key'
	| 'signature'
	| 'counter'
	| 'user';
export class WebAuthnError extends Error {
	constructor(readonly reason: WebAuthnFailure) {
		super(`WebAuthn: ${reason}`);
	}
}
export type WebAuthnExpectation = {
	/** The challenge this connection gave, raw bytes. */
	challenge: Uint8Array;
	/** `https://<machine>.<tailnet>.ts.net` (in an e2e run `http://localhost:<port>`). */
	origin: string;
	rpId: string;
};
const flag = { up: 0x01, uv: 0x04, be: 0x08, bs: 0x10, at: 0x40, ed: 0x80 } as const;
const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest();
const sameBytes = (a: Uint8Array, b: Uint8Array) =>
	a.length === b.length && a.every((byte, index) => byte === b[index]);

/** spec/editor#editor-principles steps 5–12, spec/editor#editor-principles steps 10–15: the client data, exactly as the page's browser wrote it. */
function checkClientData(
	clientDataJSON: Uint8Array,
	type: 'webauthn.create' | 'webauthn.get',
	expected: WebAuthnExpectation
) {
	let data: unknown;
	try {
		data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(clientDataJSON));
	} catch {
		throw new WebAuthnError('client-data');
	}
	if (typeof data !== 'object' || data === null || Array.isArray(data))
		throw new WebAuthnError('client-data');
	const record = data as Record<string, unknown>;
	if (record.type !== type) throw new WebAuthnError('type');
	if (record.challenge !== toBase64Url(expected.challenge)) throw new WebAuthnError('challenge');
	if (record.origin !== expected.origin) throw new WebAuthnError('origin');
	// A frame of another site may not sign in here (spec/diff-and-review#review-comments `crossOrigin`, `topOrigin`).
	if (record.crossOrigin === true || record.topOrigin !== undefined)
		throw new WebAuthnError('origin');
}
type AuthenticatorData = {
	rpIdHash: Uint8Array;
	flags: number;
	signCount: number;
	credential: { aaguid: Uint8Array; id: Uint8Array; key: Map<number | string, CborValue> } | null;
};
/** spec/chat#row-engine: rpIdHash ‖ flags ‖ signCount ‖ [attested credential data] ‖ [extensions]; nothing may follow. */
export function parseAuthenticatorData(data: Uint8Array): AuthenticatorData {
	if (data.length < 37) throw new WebAuthnError('authenticator-data');
	const flags = data[32]!;
	const signCount = new DataView(data.buffer, data.byteOffset + 33, 4).getUint32(0);
	let at = 37;
	let credential: AuthenticatorData['credential'] = null;
	try {
		if (flags & flag.at) {
			if (data.length < at + 18) throw new WebAuthnError('authenticator-data');
			const aaguid = data.slice(at, at + 16);
			const length = (data[at + 16]! << 8) | data[at + 17]!;
			at += 18;
			if (length < 16 || length > 1023 || data.length < at + length)
				throw new WebAuthnError('credential');
			const id = data.slice(at, at + length);
			at += length;
			const { value, end } = decodeCborItem(data, at);
			if (!(value instanceof Map)) throw new WebAuthnError('key');
			at = end;
			credential = { aaguid, id, key: value };
		}
		if (flags & flag.ed) {
			const { value, end } = decodeCborItem(data, at);
			if (!(value instanceof Map)) throw new WebAuthnError('authenticator-data');
			at = end;
		}
	} catch (error) {
		if (error instanceof CborError) throw new WebAuthnError('authenticator-data');
		throw error;
	}
	if (at !== data.length) throw new WebAuthnError('authenticator-data');
	return { rpIdHash: data.slice(0, 32), flags, signCount, credential };
}
function checkFlags(auth: AuthenticatorData, rpId: string) {
	if (!sameBytes(auth.rpIdHash, sha256(rpId))) throw new WebAuthnError('rp');
	if (!(auth.flags & flag.up)) throw new WebAuthnError('presence');
	if (!(auth.flags & flag.uv)) throw new WebAuthnError('verification');
	// Backup state without backup eligibility is invalid (spec/chat#row-engine).
	if (auth.flags & flag.bs && !(auth.flags & flag.be))
		throw new WebAuthnError('authenticator-data');
}
const bytesOf = (value: CborValue | undefined, length?: number) => {
	if (!(value instanceof Uint8Array) || (length !== undefined && value.length !== length))
		throw new WebAuthnError('key');
	return value;
};
/** A COSE key (RFC 9053) of ES256, EdDSA (Ed25519) or RS256 as a Node key; anything else is refused. */
export function coseKey(
	cose: Map<number | string, CborValue>,
	allowed: readonly number[] = passkeyAlgorithms
): { key: KeyObject; algorithm: PasskeyAlgorithm } {
	const kty = cose.get(1),
		alg = cose.get(3);
	if (typeof alg !== 'number' || !allowed.includes(alg)) throw new WebAuthnError('algorithm');
	let jwk: Record<string, string>;
	if (alg === -7) {
		if (kty !== 2 || cose.get(-1) !== 1) throw new WebAuthnError('key');
		jwk = {
			kty: 'EC',
			crv: 'P-256',
			x: toBase64Url(bytesOf(cose.get(-2), 32)),
			y: toBase64Url(bytesOf(cose.get(-3), 32)),
		};
	} else if (alg === -8) {
		if (kty !== 1 || cose.get(-1) !== 6) throw new WebAuthnError('key');
		const x = bytesOf(cose.get(-2), 32);
		// A small-order point (the identity among them) verifies signatures nobody made (security review W0, W6).
		let small: boolean;
		try {
			small = ed25519.Point.fromBytes(x).isSmallOrder();
		} catch {
			throw new WebAuthnError('key');
		}
		if (small) throw new WebAuthnError('key');
		jwk = { kty: 'OKP', crv: 'Ed25519', x: toBase64Url(x) };
	} else if (alg === -257) {
		if (kty !== 3) throw new WebAuthnError('key');
		const n = bytesOf(cose.get(-1)),
			e = bytesOf(cose.get(-2));
		if (n.length < 256 || n.length > 1024 || e.length > 8) throw new WebAuthnError('key');
		// W6: a modulus of fewer bits than its length says, an even one, or an exponent below 3 or even — with e = 1 the
		// padded message itself is a valid signature (OpenSSL accepts it; Electron's BoringSSL refuses it at verify).
		const odd = (bytes: Uint8Array) => bytes.length > 0 && (bytes[bytes.length - 1]! & 1) === 1;
		const belowThree = e.every((byte, index) => (index === e.length - 1 ? byte < 3 : byte === 0));
		if (n[0] === 0 || !odd(n) || !odd(e) || belowThree) throw new WebAuthnError('key');
		jwk = { kty: 'RSA', n: toBase64Url(n), e: toBase64Url(e) };
	} else throw new WebAuthnError('algorithm');
	try {
		// Importing checks that an EC point is on the curve.
		return { key: createPublicKey({ key: jwk, format: 'jwk' }), algorithm: alg };
	} catch {
		throw new WebAuthnError('key');
	}
}
function verifySignature(
	key: KeyObject,
	algorithm: PasskeyAlgorithm,
	data: Uint8Array,
	signature: Uint8Array
): boolean {
	try {
		if (algorithm === -8) return verify(null, data, key, signature);
		// ES256 signatures are ASN.1 DER (spec/chat#row-engine); RS256 is PKCS #1 v1.5 over SHA-256.
		return verify('sha256', data, algorithm === -7 ? { key, dsaEncoding: 'der' } : key, signature);
	} catch {
		return false;
	}
}
const uuid = (bytes: Uint8Array) => {
	const hex = Buffer.from(bytes).toString('hex');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export type RegistrationResponse = {
	/** The credential's `rawId`, base64url. */
	id: string;
	clientDataJSON: Uint8Array;
	attestationObject: Uint8Array;
};
/** spec/editor#editor-principles: a new passkey for `userId`; returns what `devices.json` keeps. Throws `WebAuthnError` with the reason. */
export function verifyRegistration(
	response: RegistrationResponse,
	expected: WebAuthnExpectation & { userId: string; algorithms?: readonly number[] }
): PasskeyRecord {
	checkClientData(response.clientDataJSON, 'webauthn.create', expected);
	let attestation: CborValue;
	try {
		attestation = decodeCbor(response.attestationObject);
	} catch {
		throw new WebAuthnError('authenticator-data');
	}
	if (!(attestation instanceof Map) || typeof attestation.get('fmt') !== 'string')
		throw new WebAuthnError('authenticator-data');
	const authData = attestation.get('authData');
	if (!(authData instanceof Uint8Array) || !(attestation.get('attStmt') instanceof Map))
		throw new WebAuthnError('authenticator-data');
	const auth = parseAuthenticatorData(authData);
	checkFlags(auth, expected.rpId);
	if (!auth.credential) throw new WebAuthnError('credential');
	let rawId: Uint8Array;
	try {
		rawId = fromBase64Url(response.id);
	} catch {
		throw new WebAuthnError('credential');
	}
	if (!sameBytes(rawId, auth.credential.id)) throw new WebAuthnError('credential');
	const { key, algorithm } = coseKey(auth.credential.key, expected.algorithms);
	return {
		credentialId: toBase64Url(auth.credential.id),
		publicKey: key.export({ type: 'spki', format: 'der' }).toString('base64'),
		algorithm,
		signCount: auth.signCount,
		aaguid: uuid(auth.credential.aaguid),
		rpId: expected.rpId,
		userId: expected.userId,
		backupEligible: Boolean(auth.flags & flag.be),
	};
}

export type AssertionResponse = {
	id: string;
	clientDataJSON: Uint8Array;
	authenticatorData: Uint8Array;
	signature: Uint8Array;
	userHandle: Uint8Array | null;
};
/**
 * spec/editor#editor-principles: a sign-in with a known passkey; returns the new signature counter. The key belongs to the domain it was made for:
 * a renamed machine or tailnet gives `rp`, and the phone pairs again (spec/remote-access-and-mobile#phone).
 */
export function verifyAssertion(
	response: AssertionResponse,
	passkey: PasskeyRecord,
	expected: WebAuthnExpectation
): { signCount: number } {
	if (response.id !== passkey.credentialId) throw new WebAuthnError('credential');
	if (passkey.rpId !== expected.rpId) throw new WebAuthnError('rp');
	if (response.userHandle && toBase64Url(response.userHandle) !== passkey.userId)
		throw new WebAuthnError('user');
	checkClientData(response.clientDataJSON, 'webauthn.get', expected);
	const auth = parseAuthenticatorData(response.authenticatorData);
	if (auth.credential) throw new WebAuthnError('authenticator-data');
	checkFlags(auth, expected.rpId);
	const key = createPublicKey({
		key: Buffer.from(passkey.publicKey, 'base64'),
		format: 'der',
		type: 'spki',
	});
	const signed = Buffer.concat([response.authenticatorData, sha256(response.clientDataJSON)]);
	if (!verifySignature(key, passkey.algorithm, signed, response.signature))
		throw new WebAuthnError('signature');
	// spec/chat#row-engine: a counter that does not grow means a cloned key — unless both are zero (synced passkeys never count).
	if ((auth.signCount > 0 || passkey.signCount > 0) && auth.signCount <= passkey.signCount)
		throw new WebAuthnError('counter');
	return { signCount: auth.signCount };
}
export function isPasskeyRecord(value: unknown): value is PasskeyRecord {
	if (typeof value !== 'object' || value === null) return false;
	const item = value as Record<string, unknown>;
	return (
		Object.keys(item).length === 8 &&
		typeof item.credentialId === 'string' &&
		/^[A-Za-z0-9_-]{22,1400}$/.test(item.credentialId) &&
		typeof item.publicKey === 'string' &&
		item.publicKey.length <= 2048 &&
		/^[A-Za-z0-9+/]+={0,2}$/.test(item.publicKey) &&
		(passkeyAlgorithms as readonly unknown[]).includes(item.algorithm) &&
		Number.isSafeInteger(item.signCount) &&
		Number(item.signCount) >= 0 &&
		typeof item.aaguid === 'string' &&
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(item.aaguid) &&
		typeof item.rpId === 'string' &&
		item.rpId.length > 0 &&
		item.rpId.length <= 253 &&
		typeof item.userId === 'string' &&
		/^[A-Za-z0-9_-]{1,64}$/.test(item.userId) &&
		typeof item.backupEligible === 'boolean'
	);
}
/** A phone's device id: SHA-256 of its passkey's raw id, the way a computer's is of its certificate. */
export function passkeyDeviceId(credentialId: string): string {
	return createHash('sha256').update(fromBase64Url(credentialId)).digest('hex');
}
