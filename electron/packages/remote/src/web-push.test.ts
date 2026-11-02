import { describe, expect, it } from 'vitest';
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, verify } from 'node:crypto';
import { fromBase64Url, toBase64Url } from './base64';
import {
	createVapidKeys,
	encryptPush,
	isPushEndpoint,
	isPushSubscription,
	isVapidKeys,
	sendPush,
	vapidAuthorization,
	type PushFetch,
} from './web-push';

const b64 = (text: string) => fromBase64Url(text.replace(/\s+/g, ''));
// RFC 8291, appendix A.
const rfc = {
	plaintext: b64('V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24'),
	asPrivate: b64('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'),
	uaPublic:
		'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
	uaPrivate: b64('q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94'),
	salt: b64('DGv6ra1nlYgDCS1FRnbzlw'),
	auth: 'BTBZMqHH6r4Tts7J_aSIgg',
	result: `DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml
		mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT
		pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN`,
};
/** The browser's side of RFC 8291 spec/projects-and-board#projects and RFC 8188: what a phone does with the body. */
function decrypt(body: Uint8Array, uaPrivate: Uint8Array, uaPublic: Uint8Array, auth: Uint8Array) {
	const salt = body.subarray(0, 16),
		idlen = body[20]!,
		asPublic = body.subarray(21, 21 + idlen),
		ciphertext = body.subarray(21 + idlen);
	const ecdh = createECDH('prime256v1');
	ecdh.setPrivateKey(uaPrivate);
	const secret = ecdh.computeSecret(asPublic);
	const info = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
	const ikm = Buffer.from(hkdfSync('sha256', secret, auth, info, 32));
	const cek = Buffer.from(
		hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16)
	);
	const nonce = Buffer.from(
		hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12)
	);
	const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
	decipher.setAuthTag(ciphertext.subarray(-16));
	const plain = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
	expect(plain.at(-1)).toBe(2);
	return plain.subarray(0, -1);
}
function phone() {
	const ecdh = createECDH('prime256v1');
	ecdh.generateKeys();
	const auth = new Uint8Array(16).fill(7);
	return {
		subscription: {
			endpoint: 'https://web.push.apple.com/QGuQyavXutnMPQ',
			p256dh: toBase64Url(ecdh.getPublicKey()),
			auth: toBase64Url(auth),
		},
		open: (body: Uint8Array) =>
			JSON.parse(decrypt(body, ecdh.getPrivateKey(), ecdh.getPublicKey(), auth).toString()),
	};
}

describe('Web Push encryption (RFC 8291, spec/remote-access-and-mobile#phone-network)', () => {
	it('matches the RFC’s example byte for byte', () => {
		const body = encryptPush(
			rfc.plaintext,
			{ p256dh: rfc.uaPublic, auth: rfc.auth },
			{ asPrivate: rfc.asPrivate, salt: rfc.salt }
		);
		expect(toBase64Url(body)).toBe(rfc.result.replace(/\s+/g, ''));
		expect(
			decrypt(body, rfc.uaPrivate, fromBase64Url(rfc.uaPublic), fromBase64Url(rfc.auth)).toString()
		).toBe('When I grow up, I want to be a watermelon');
	});
	it('uses a fresh key and salt for each message', () => {
		const { subscription, open } = phone();
		const payload = new TextEncoder().encode('{"task":"Fix login","type":"question"}');
		const one = encryptPush(payload, subscription),
			two = encryptPush(payload, subscription);
		expect(toBase64Url(one)).not.toBe(toBase64Url(two));
		expect(open(one)).toEqual({ task: 'Fix login', type: 'question' });
	});
});

describe('VAPID (RFC 8292)', () => {
	it('signs a JWT the push service can check with the public key', () => {
		const keys = createVapidKeys();
		expect(isVapidKeys(keys)).toBe(true);
		const header = vapidAuthorization(
			'https://web.push.apple.com/abc',
			keys,
			'https://studio.tail1234.ts.net',
			1_800_000_000_000
		);
		const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header)!;
		expect(match[4]).toBe(keys.publicKey);
		const claims = JSON.parse(Buffer.from(fromBase64Url(match[2]!)).toString());
		expect(claims).toEqual({
			aud: 'https://web.push.apple.com',
			exp: 1_800_000_000 + 12 * 3600,
			sub: 'https://studio.tail1234.ts.net',
		});
		const point = fromBase64Url(keys.publicKey);
		const key = createPublicKey({
			key: {
				kty: 'EC',
				crv: 'P-256',
				x: toBase64Url(point.subarray(1, 33)),
				y: toBase64Url(point.subarray(33)),
			},
			format: 'jwk',
		});
		expect(
			verify(
				'sha256',
				Buffer.from(`${match[1]}.${match[2]}`),
				{ key, dsaEncoding: 'ieee-p1363' },
				fromBase64Url(match[3]!)
			)
		).toBe(true);
	});
});

describe('push endpoints and sending', () => {
	it('sends only to the push services browsers use, over https', () => {
		for (const ok of [
			'https://web.push.apple.com/QGuQ',
			'https://fcm.googleapis.com/fcm/send/abc',
			'https://updates.push.services.mozilla.com/wpush/v2/abc',
			'https://wns2-db5p.notify.windows.com/w/?token=abc',
		])
			expect(isPushEndpoint(ok)).toBe(true);
		for (const bad of [
			'http://web.push.apple.com/x',
			'https://web.push.apple.com:8443/x',
			'https://user:pw@fcm.googleapis.com/x',
			'https://evilpush.apple.com.example/x',
			'https://fcm.googleapis.com.evil.com/x',
			'https://192.168.1.10/x',
			'https://localhost/x',
			'not a url',
		])
			expect(isPushEndpoint(bad)).toBe(false);
	});
	it('refuses keys that are not a P-256 point and a 16-byte secret', () => {
		const { subscription } = phone();
		expect(isPushSubscription(subscription)).toBe(true);
		expect(isPushSubscription({ ...subscription, auth: toBase64Url(new Uint8Array(8)) })).toBe(
			false
		);
		const point = fromBase64Url(subscription.p256dh);
		point[64] = point[64]! ^ 1;
		expect(isPushSubscription({ ...subscription, p256dh: toBase64Url(point) })).toBe(false);
	});
	it('posts the encrypted task name and kind; a gone subscription says so', async () => {
		const { subscription, open } = phone();
		const sent: {
			url: string;
			headers: Record<string, string>;
			body: Uint8Array;
			redirect: string;
		}[] = [];
		let status = 201;
		const fetch: PushFetch = async (url, init) => {
			sent.push({ url, headers: init.headers, body: init.body, redirect: init.redirect });
			return { status };
		};
		const keys = createVapidKeys();
		const options = { subject: 'https://studio.tail1234.ts.net', fetch };
		expect(
			await sendPush(
				subscription,
				{ task: 'Fix login', type: 'permission', key: 'project/task' },
				keys,
				options
			)
		).toBe('sent');
		expect(sent[0]!.url).toBe(subscription.endpoint);
		// Security review W0, W7: the POST goes to the allowed host only — a redirect elsewhere is not followed.
		expect(sent[0]!.redirect).toBe('error');
		expect(sent[0]!.headers).toMatchObject({
			'content-encoding': 'aes128gcm',
			ttl: '3600',
			urgency: 'high',
		});
		expect(sent[0]!.headers.topic).toMatch(/^[A-Za-z0-9_-]{32}$/);
		expect(sent[0]!.headers.authorization).toMatch(/^vapid t=.+, k=/);
		expect(open(sent[0]!.body)).toEqual({
			task: 'Fix login',
			type: 'permission',
			key: 'project/task',
		});
		// spec/remote-access-and-mobile#phone-task-tools: the topic follows the task's key, so two tasks with one title do not replace each other.
		const other = sent.length;
		await sendPush(
			subscription,
			{ task: 'Fix login', type: 'permission', key: 'project/other' },
			keys,
			options
		);
		expect(sent[other]!.headers.topic).not.toBe(sent[0]!.headers.topic);
		status = 410;
		expect(
			await sendPush(subscription, { task: 'x', type: 'done', key: 'p/t' }, keys, options)
		).toBe('gone');
		status = 500;
		expect(
			await sendPush(subscription, { task: 'x', type: 'done', key: 'p/t' }, keys, options)
		).toBe('failed');
		// An endpoint that is not a push service is never posted to.
		const before = sent.length;
		expect(
			await sendPush(
				{ ...subscription, endpoint: 'https://10.0.0.1/x' },
				{ task: 'x', type: 'done', key: 'p/t' },
				keys,
				options
			)
		).toBe('gone');
		expect(sent.length).toBe(before);
	});
});
