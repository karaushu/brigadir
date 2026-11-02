import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { toBase64Url } from './base64';
import { CborError, decodeCbor, decodeCborItem } from './cbor';
import { encodeCbor, SoftAuthenticator } from './test-authenticator';
import {
	coseKey,
	isPasskeyRecord,
	passkeyDeviceId,
	verifyAssertion,
	verifyRegistration,
	WebAuthnError,
	type PasskeyRecord,
} from './webauthn';

const rpId = 'studio.tail1234.ts.net',
	origin = `https://${rpId}`;
const fresh = () => {
	const challenge = new Uint8Array(randomBytes(32));
	return { challenge, text: toBase64Url(challenge) };
};
function register(authenticator = new SoftAuthenticator(), bend = {}) {
	const { challenge, text } = fresh();
	const userId = toBase64Url(randomBytes(16));
	const response = authenticator.create({ challenge: text, rpId, origin, userId }, bend);
	return { authenticator, challenge, userId, response };
}
function registered(algorithm: -7 | -8 | -257 = -7) {
	const { authenticator, challenge, userId, response } = register(new SoftAuthenticator(algorithm));
	return {
		authenticator,
		passkey: verifyRegistration(response, { challenge, origin, rpId, userId }),
	};
}
function signIn(
	authenticator: SoftAuthenticator,
	passkey: PasskeyRecord,
	bend = {},
	expected = {}
) {
	const { challenge, text } = fresh();
	return verifyAssertion(authenticator.get({ challenge: text, rpId, origin }, bend), passkey, {
		challenge,
		origin,
		rpId,
		...expected,
	});
}
const reason = (run: () => unknown) => {
	try {
		run();
	} catch (error) {
		if (error instanceof WebAuthnError) return error.reason;
		throw error;
	}
	return null;
};

describe('CBOR (spec/remote-access-and-mobile#phone-network)', () => {
	it('round-trips what WebAuthn uses', () => {
		const value = new Map<number | string, unknown>([
			['fmt', 'none'],
			[1, 2],
			[-1, Uint8Array.of(1, 2, 3)],
			[3, [true, false, null, 70000]],
		]);
		expect(decodeCbor(encodeCbor(value as never))).toEqual(value);
		expect(decodeCborItem(Uint8Array.of(0x01, 0xff)).end).toBe(1);
	});
	it('refuses what it does not need, and lies about lengths', () => {
		const cases = [
			Uint8Array.of(0x5f), // indefinite byte string
			Uint8Array.of(0xc0, 0x01), // a tag
			Uint8Array.of(0xfb, 0, 0, 0, 0, 0, 0, 0, 0), // a float
			Uint8Array.of(0x5a, 0xff, 0xff, 0xff, 0xff), // 4 GB of bytes in five
			Uint8Array.of(0x9a, 0xff, 0xff, 0xff, 0xff), // an array of 4 billion
			Uint8Array.of(0xa2, 0x01, 0x01, 0x01, 0x02), // a duplicate key
			Uint8Array.of(0xa1, 0x41, 0x00, 0x01), // a byte-string key
			Uint8Array.of(0x62, 0xc3, 0x28), // invalid UTF-8
			Uint8Array.of(0x01, 0x02), // trailing bytes
			Uint8Array.of(...Array(40).fill(0x81), 0x01), // nested 40 deep
		];
		for (const data of cases) expect(() => decodeCbor(data)).toThrow(CborError);
	});
});

describe('WebAuthn registration (spec/remote-access-and-mobile#phone-network)', () => {
	it.each([-7, -8, -257] as const)(
		'keeps a passkey of algorithm %i and signs in with it',
		(algorithm) => {
			const { authenticator, passkey } = registered(algorithm);
			expect(isPasskeyRecord(passkey)).toBe(true);
			expect(passkey).toMatchObject({
				algorithm,
				rpId,
				signCount: 0,
				credentialId: authenticator.id,
			});
			expect(passkey.aaguid).toBe('00000000-0000-0000-0000-000000000000');
			expect(passkeyDeviceId(passkey.credentialId)).toMatch(/^[0-9a-f]{64}$/);
			expect(signIn(authenticator, passkey)).toEqual({ signCount: 0 });
		}
	);
	it('refuses a wrong type, challenge, origin, RP, flags, credential id and a cross-origin frame', () => {
		const expect2 = (bend: object, want: string, patch: object = {}) => {
			const { challenge, userId, response } = register(new SoftAuthenticator(), bend);
			expect(
				reason(() => verifyRegistration(response, { challenge, origin, rpId, userId, ...patch }))
			).toBe(want);
		};
		expect2({ type: 'webauthn.get' }, 'type');
		expect2({ challenge: toBase64Url(randomBytes(32)) }, 'challenge');
		expect2({ origin: 'https://evil.example' }, 'origin');
		expect2({ origin: 'http://studio.tail1234.ts.net' }, 'origin');
		expect2({ crossOrigin: true }, 'origin');
		expect2({ rpId: 'evil.ts.net' }, 'rp');
		expect2({ flags: 0x44 }, 'presence');
		expect2({ flags: 0x41 }, 'verification');
		expect2({ flags: 0x05 }, 'authenticator-data'); // no attested credential: the key would be read from nothing
		expect2({ flags: 0x45 | 0x10 }, 'authenticator-data'); // backed up but not eligible
		expect2({ extra: Uint8Array.of(0) }, 'authenticator-data'); // a byte after the key
		expect2({ id: toBase64Url(randomBytes(16)) }, 'credential');
		expect2({}, 'algorithm', { algorithms: [-8] });
	});
	it('refuses an attestation object that is not one', () => {
		const { challenge, userId, response } = register();
		const broken = { ...response, attestationObject: response.attestationObject.slice(0, -3) };
		expect(reason(() => verifyRegistration(broken, { challenge, origin, rpId, userId }))).toBe(
			'authenticator-data'
		);
		const notJson = { ...response, clientDataJSON: new TextEncoder().encode('{') };
		expect(reason(() => verifyRegistration(notJson, { challenge, origin, rpId, userId }))).toBe(
			'client-data'
		);
	});
});

describe('WebAuthn sign-in (spec/remote-access-and-mobile#phone-network)', () => {
	it('counts a growing counter and refuses one that went back (a cloned key)', () => {
		const { authenticator, passkey } = registered();
		authenticator.signCount = 5;
		const first = signIn(authenticator, passkey, { signCount: 5 });
		expect(first.signCount).toBe(5);
		const next = { ...passkey, signCount: 5 };
		expect(reason(() => signIn(authenticator, next, { signCount: 5 }))).toBe('counter');
		expect(reason(() => signIn(authenticator, next, { signCount: 3 }))).toBe('counter');
		expect(signIn(authenticator, next, { signCount: 6 }).signCount).toBe(6);
		// A synced passkey never counts: zero after zero is fine.
		expect(signIn(authenticator, { ...passkey, signCount: 0 }, { signCount: 0 }).signCount).toBe(0);
	});
	it('refuses a bad signature, another key, another origin or RP, no UV, a wrong user and stray data', () => {
		const { authenticator, passkey } = registered();
		const other = registered().passkey;
		expect(
			reason(() =>
				signIn(authenticator, passkey, {
					signature: (s: Uint8Array) => s.map((b, i) => (i === 10 ? b ^ 1 : b)),
				})
			)
		).toBe('signature');
		// Another key under this id (and this user): the signature does not verify.
		expect(
			reason(() =>
				signIn(authenticator, {
					...other,
					credentialId: passkey.credentialId,
					userId: passkey.userId,
				})
			)
		).toBe('signature');
		expect(reason(() => signIn(authenticator, passkey, { id: other.credentialId }))).toBe(
			'credential'
		);
		expect(reason(() => signIn(authenticator, passkey, { origin: 'https://evil.example' }))).toBe(
			'origin'
		);
		expect(reason(() => signIn(authenticator, passkey, { type: 'webauthn.create' }))).toBe('type');
		expect(reason(() => signIn(authenticator, passkey, { rpId: 'other.ts.net' }))).toBe('rp');
		expect(reason(() => signIn(authenticator, passkey, { flags: 0x01 }))).toBe('verification');
		expect(reason(() => signIn(authenticator, passkey, { flags: 0x04 }))).toBe('presence');
		expect(reason(() => signIn(authenticator, passkey, { flags: 0x45 }))).toBe(
			'authenticator-data'
		);
		expect(reason(() => signIn(authenticator, passkey, { extra: Uint8Array.of(1) }))).toBe(
			'authenticator-data'
		);
		expect(reason(() => signIn(authenticator, passkey, { userHandle: new Uint8Array(16) }))).toBe(
			'user'
		);
		// No user handle is fine (a non-discoverable answer); the key decides.
		expect(signIn(authenticator, passkey, { userHandle: null }).signCount).toBe(0);
	});
	it('refuses a passkey of a machine name that changed since (the phone pairs again)', () => {
		const { authenticator, passkey } = registered();
		const moved = { ...passkey, rpId: 'studio.newnet.ts.net' };
		expect(reason(() => signIn(authenticator, moved))).toBe('rp');
	});
	it('refuses a challenge it did not give', () => {
		const { authenticator, passkey } = registered();
		const { text } = fresh();
		const response = authenticator.get({ challenge: text, rpId, origin });
		expect(
			reason(() =>
				verifyAssertion(response, passkey, { challenge: fresh().challenge, origin, rpId })
			)
		).toBe('challenge');
	});
});

describe('security review W0: keys no one may sign for (spec/remote-access-and-mobile#phone-network)', () => {
	it('W6: refuses an RSA key with a public exponent of 1, an even one or an even modulus, and a small-order Ed25519 point', () => {
		const jwk = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({
			format: 'jwk',
		});
		const n = new Uint8Array(Buffer.from(jwk.n!, 'base64url'));
		const rsa = (modulus: Uint8Array, exponent: Uint8Array) =>
			reason(() =>
				coseKey(
					new Map<number | string, Uint8Array | number>([
						[1, 3],
						[3, -257],
						[-1, modulus],
						[-2, exponent],
					])
				)
			);
		expect(rsa(n, Uint8Array.of(1, 0, 1))).toBeNull();
		// e = 1: s = EM verifies under OpenSSL — anyone signs for the phone.
		expect(rsa(n, Uint8Array.of(1))).toBe('key');
		expect(rsa(n, new Uint8Array(0))).toBe('key');
		expect(rsa(n, Uint8Array.of(1, 0, 0))).toBe('key');
		const even = n.slice();
		even[even.length - 1]! &= 0xfe;
		expect(rsa(even, Uint8Array.of(1, 0, 1))).toBe('key');
		const short = Uint8Array.from([0, ...n.subarray(1)]);
		expect(rsa(short, Uint8Array.of(1, 0, 1))).toBe('key');
		const identity = new Uint8Array(32);
		identity[0] = 1;
		expect(
			reason(() =>
				coseKey(
					new Map<number | string, Uint8Array | number>([
						[1, 1],
						[3, -8],
						[-1, 6],
						[-2, identity],
					])
				)
			)
		).toBe('key');
	});
});
