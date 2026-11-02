/**
 * spec/remote-access-and-mobile#architecture, spec/remote-access-and-mobile#transport-and-protocol: each side's identity — an ECDSA P-256 key and a self-signed X.509 certificate, built as
 * DER on `node:crypto` without an X.509 package. Trust is the SHA-256 fingerprint remembered at pairing, never a CA.
 */
import {
	X509Certificate,
	createPrivateKey,
	generateKeyPairSync,
	randomBytes,
	sign,
	type KeyObject,
} from 'node:crypto';

export type Identity = {
	/** PKCS#8 PEM. Lives in memory and, encrypted by the OS key store, in `remote/identity.json`. */
	key: string;
	cert: string;
	/** SHA-256 of the certificate's DER, lowercase hex without colons — the id of a device or a machine. */
	fingerprint: string;
};

function der(tag: number, ...parts: (Buffer | number[])[]): Buffer {
	const body = Buffer.concat(
		parts.map((part) => (Buffer.isBuffer(part) ? part : Buffer.from(part)))
	);
	const n = body.length;
	const length =
		n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : n < 0x10000 ? [0x82, n >> 8, n & 0xff] : null;
	if (!length) throw new Error('DER value too long');
	return Buffer.concat([Buffer.from([tag, ...length]), body]);
}
function oid(text: string): Buffer {
	const [a, b, ...rest] = text.split('.').map(Number) as [number, number, ...number[]];
	const bytes = [a * 40 + b];
	for (const value of rest) {
		const out = [value & 0x7f];
		for (let x = value >> 7; x; x >>= 7) out.unshift((x & 0x7f) | 0x80);
		bytes.push(...out);
	}
	return der(0x06, bytes);
}
const sequence = (...parts: Buffer[]) => der(0x30, ...parts);
/** UTCTime until 2049, GeneralizedTime after (RFC 5280 spec/diff-and-review#snapshots). */
function time(date: Date): Buffer {
	const iso = date.toISOString().replace(/[-:T]/g, '').slice(0, 14);
	return date.getUTCFullYear() < 2050
		? der(0x17, Buffer.from(`${iso.slice(2)}Z`))
		: der(0x18, Buffer.from(`${iso}Z`));
}
const name = (commonName: string) =>
	sequence(der(0x31, sequence(oid('2.5.4.3'), der(0x0c, Buffer.from(commonName, 'utf8')))));
const ecdsaWithSha256 = sequence(oid('1.2.840.10045.4.3.2'));

export function fingerprintOf(cert: string | Buffer): string {
	return new X509Certificate(cert).fingerprint256.replace(/:/g, '').toLowerCase();
}
/** The common name is not trusted for anything; it only makes the certificate readable in a debugger. */
export function createIdentity(commonName = 'Brigadir', years = 20): Identity {
	const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
	const serial = randomBytes(16);
	serial[0]! &= 0x7f;
	if (serial[0] === 0) serial[0] = 1;
	const now = Date.now();
	const tbs = sequence(
		der(0xa0, der(0x02, [2])),
		der(0x02, serial),
		ecdsaWithSha256,
		name(commonName.slice(0, 64) || 'Brigadir'),
		sequence(time(new Date(now - 60 * 60_000)), time(new Date(now + years * 365 * 86_400_000))),
		name(commonName.slice(0, 64) || 'Brigadir'),
		publicKey.export({ type: 'spki', format: 'der' })
	);
	const signature = sign('sha256', tbs, privateKey);
	const body = sequence(tbs, ecdsaWithSha256, der(0x03, [0], signature));
	const lines = body
		.toString('base64')
		.match(/.{1,64}/g)!
		.join('\n');
	const cert = `-----BEGIN CERTIFICATE-----\n${lines}\n-----END CERTIFICATE-----\n`;
	const key = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
	return { key, cert, fingerprint: fingerprintOf(cert) };
}
/** A stored identity is used only when the key is P-256, belongs to the certificate and the certificate signs itself. */
export function isIdentity(value: unknown): value is Identity {
	if (
		typeof value !== 'object' ||
		value === null ||
		typeof (value as Identity).key !== 'string' ||
		typeof (value as Identity).cert !== 'string' ||
		typeof (value as Identity).fingerprint !== 'string'
	)
		return false;
	const { key, cert, fingerprint } = value as Identity;
	try {
		const x509 = new X509Certificate(cert);
		const privateKey: KeyObject = createPrivateKey(key);
		return (
			privateKey.asymmetricKeyType === 'ec' &&
			privateKey.asymmetricKeyDetails?.namedCurve === 'prime256v1' &&
			x509.checkPrivateKey(privateKey) &&
			x509.verify(x509.publicKey) &&
			fingerprintOf(cert) === fingerprint
		);
	} catch {
		return false;
	}
}
/** A peer's certificate as it came over pairing: one PEM certificate with a P-256 key. */
export function isPeerCertificate(cert: unknown): cert is string {
	if (typeof cert !== 'string' || cert.length > 4096) return false;
	try {
		const x509 = new X509Certificate(cert);
		return (
			x509.publicKey.asymmetricKeyType === 'ec' &&
			x509.publicKey.asymmetricKeyDetails?.namedCurve === 'prime256v1' &&
			x509.verify(x509.publicKey)
		);
	} catch {
		return false;
	}
}
/** The DER of a PEM certificate, for channel binding in pairing. */
export function certificateDer(cert: string): Buffer {
	return Buffer.from(new X509Certificate(cert).raw);
}
