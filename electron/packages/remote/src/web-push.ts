/**
 * spec/remote-access-and-mobile#phone, spec/remote-access-and-mobile#phone-network: Web Push from the working machine to a phone, without a server of ours — the message
 * encrypted for the phone's browser (RFC 8291, `aes128gcm` of RFC 8188) and signed for the push service with the machine's
 * VAPID key (RFC 8292). The payload is the task's name and the kind of the event, nothing more.
 */
import {
	createECDH,
	createHash,
	createCipheriv,
	createPrivateKey,
	generateKeyPairSync,
	hkdfSync,
	randomBytes,
	sign,
} from 'node:crypto';
import { fromBase64Url, toBase64Url } from './base64';

/** What a push says (spec/remote-access-and-mobile#phone): a question, a permission, a plan, done, or that the agent waits otherwise. */
export type PushKind = 'needs-you' | 'question' | 'permission' | 'plan' | 'done';
export const pushKinds: readonly PushKind[] = [
	'needs-you',
	'question',
	'permission',
	'plan',
	'done',
];
/**
 * `key` (spec/remote-access-and-mobile#phone-task-tools): `<project>/<task>`, the ids the phone opens on a tap. The OS shows only the title and the kind; the
 * key is opaque and, like the rest, encrypted for the phone.
 */
export type PushPayload = { task: string; type: PushKind; key: string };
/** A phone's subscription as the device record keeps it; keys in base64url. */
export type PushSubscriptionRecord = { endpoint: string; p256dh: string; auth: string };
/** The machine's VAPID key pair: the public point (base64url, 65 bytes) and the private scalar (base64url, 32 bytes). */
export type VapidKeys = { publicKey: string; privateKey: string };

/**
 * The push services browsers use: Apple (Safari, iOS), Google (Chrome, Android), Mozilla and Microsoft. Anything else
 * would make the machine send a POST wherever a phone says — to a service in its LAN, for example.
 */
const pushHosts = [
	/^(?:[a-z0-9-]+\.)*push\.apple\.com$/,
	/^fcm\.googleapis\.com$/,
	/^(?:[a-z0-9-]+\.)*push\.services\.mozilla\.com$/,
	/^(?:[a-z0-9-]+\.)*notify\.windows\.com$/,
];
export function isPushEndpoint(endpoint: string, hosts: readonly RegExp[] = pushHosts): boolean {
	if (endpoint.length > 2048) return false;
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		return false;
	}
	return (
		url.protocol === 'https:' &&
		!url.username &&
		!url.password &&
		url.port === '' &&
		hosts.some((host) => host.test(url.hostname))
	);
}
/** The subscription's keys are a P-256 point and a 16-byte secret; anything else is refused before it is stored. */
export function isPushSubscription(
	value: PushSubscriptionRecord,
	hosts: readonly RegExp[] = pushHosts
): boolean {
	try {
		const key = fromBase64Url(value.p256dh),
			auth = fromBase64Url(value.auth);
		if (key.length !== 65 || key[0] !== 4 || auth.length !== 16) return false;
		// The point must be on the curve: an ECDH with it would throw later otherwise.
		const probe = createECDH('prime256v1');
		probe.generateKeys();
		probe.computeSecret(key);
	} catch {
		return false;
	}
	return isPushEndpoint(value.endpoint, hosts);
}

export function createVapidKeys(): VapidKeys {
	const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
	const jwk = privateKey.export({ format: 'jwk' });
	const x = fromBase64Url(jwk.x!),
		y = fromBase64Url(jwk.y!);
	return {
		publicKey: toBase64Url(Uint8Array.from([4, ...x, ...y])),
		privateKey: jwk.d!,
	};
}
export function isVapidKeys(value: unknown): value is VapidKeys {
	if (typeof value !== 'object' || value === null) return false;
	const item = value as Record<string, unknown>;
	try {
		return (
			Object.keys(item).length === 2 &&
			typeof item.publicKey === 'string' &&
			typeof item.privateKey === 'string' &&
			fromBase64Url(item.publicKey).length === 65 &&
			fromBase64Url(item.privateKey).length === 32
		);
	} catch {
		return false;
	}
}
function vapidPrivateKey(keys: VapidKeys) {
	const point = fromBase64Url(keys.publicKey);
	return createPrivateKey({
		key: {
			kty: 'EC',
			crv: 'P-256',
			d: keys.privateKey,
			x: toBase64Url(point.subarray(1, 33)),
			y: toBase64Url(point.subarray(33, 65)),
		},
		format: 'jwk',
	});
}
/**
 * RFC 8292 spec/terminal-and-cli-agents#roles, spec/projects-and-board#projects: `Authorization: vapid t=<JWT>, k=<public key>`. The JWT's audience is the push service's origin, it
 * lives 12 hours (the services refuse more than 24), and its subject is the machine's own address — Apple refuses a
 * `mailto:` it cannot parse.
 */
export function vapidAuthorization(
	endpoint: string,
	keys: VapidKeys,
	subject: string,
	now = Date.now()
): string {
	const encode = (value: object) => toBase64Url(new TextEncoder().encode(JSON.stringify(value)));
	const unsigned = `${encode({ typ: 'JWT', alg: 'ES256' })}.${encode({
		aud: new URL(endpoint).origin,
		exp: Math.floor(now / 1000) + 12 * 3600,
		sub: subject,
	})}`;
	const signature = sign('sha256', Buffer.from(unsigned), {
		key: vapidPrivateKey(keys),
		dsaEncoding: 'ieee-p1363',
	});
	return `vapid t=${unsigned}.${toBase64Url(signature)}, k=${keys.publicKey}`;
}

/** RFC 8291 spec/projects-and-board#projects, spec/diff-and-review#snapshots with one record of RFC 8188: `salt ‖ rs ‖ idlen ‖ as_public ‖ AES-128-GCM(plaintext ‖ 0x02)`. */
export function encryptPush(
	plaintext: Uint8Array,
	subscription: Pick<PushSubscriptionRecord, 'p256dh' | 'auth'>,
	/** Tests pass the RFC's values; otherwise both are fresh for each message. */
	fixed: { asPrivate?: Uint8Array; salt?: Uint8Array } = {}
): Uint8Array {
	const uaPublic = fromBase64Url(subscription.p256dh),
		authSecret = fromBase64Url(subscription.auth);
	const ecdh = createECDH('prime256v1');
	if (fixed.asPrivate) ecdh.setPrivateKey(fixed.asPrivate);
	else ecdh.generateKeys();
	const asPublic = ecdh.getPublicKey();
	const secret = ecdh.computeSecret(uaPublic);
	const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
	const ikm = Buffer.from(hkdfSync('sha256', secret, authSecret, keyInfo, 32));
	const salt = fixed.salt ?? randomBytes(16);
	const cek = Buffer.from(
		hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16)
	);
	const nonce = Buffer.from(
		hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12)
	);
	const recordSize = 4096;
	// One record: the payload, the last record's delimiter, the tag — well within 4096.
	if (plaintext.length + 1 + 16 > recordSize - 86) throw new Error('The push payload is too long.');
	const cipher = createCipheriv('aes-128-gcm', cek, nonce);
	const body = Buffer.concat([
		cipher.update(plaintext),
		cipher.update(Uint8Array.of(2)),
		cipher.final(),
		cipher.getAuthTag(),
	]);
	const header = Buffer.alloc(21);
	Buffer.from(salt).copy(header, 0);
	header.writeUInt32BE(recordSize, 16);
	header[20] = asPublic.length;
	return new Uint8Array(Buffer.concat([header, asPublic, body]));
}

export type PushFetch = (
	url: string,
	init: {
		method: 'POST';
		headers: Record<string, string>;
		body: Uint8Array;
		/** A push service that redirects does not take the POST elsewhere. */
		redirect: 'error';
		signal: AbortSignal;
	}
) => Promise<{ status: number }>;
/** `sent`; `gone` — the service forgot the subscription (404, 410): the record drops it; `failed` — try next time. */
export type PushResult = 'sent' | 'gone' | 'failed';
export async function sendPush(
	subscription: PushSubscriptionRecord,
	payload: PushPayload,
	keys: VapidKeys,
	options: {
		subject: string;
		fetch?: PushFetch;
		hosts?: readonly RegExp[];
		now?: number;
		timeoutMs?: number;
	}
): Promise<PushResult> {
	if (!isPushEndpoint(subscription.endpoint, options.hosts)) return 'gone';
	const body = encryptPush(new TextEncoder().encode(JSON.stringify(payload)), subscription);
	const send = options.fetch ?? (fetch as unknown as PushFetch);
	try {
		const response = await send(subscription.endpoint, {
			method: 'POST',
			headers: {
				authorization: vapidAuthorization(
					subscription.endpoint,
					keys,
					options.subject,
					options.now
				),
				'content-encoding': 'aes128gcm',
				'content-type': 'application/octet-stream',
				ttl: '3600',
				urgency: 'high',
				// A newer push for the same task replaces an undelivered older one (RFC 8030 spec/diff-and-review#review-comments: ≤ 32 base64url characters).
				// By the key, not the title: two tasks with one title do not replace each other (spec/remote-access-and-mobile#phone-task-tools).
				topic: toBase64Url(createHash('sha256').update(payload.key).digest()).slice(0, 32),
			},
			body,
			redirect: 'error',
			signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
		});
		if (response.status === 404 || response.status === 410) return 'gone';
		return response.status >= 200 && response.status < 300 ? 'sent' : 'failed';
	} catch {
		return 'failed';
	}
}
