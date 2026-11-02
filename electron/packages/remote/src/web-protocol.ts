/**
 * spec/remote-access-and-mobile#phone-network: the messages between a phone's page and the web listener. The same JSON frames as the gateway
 * (`codec.ts`), checked on both sides; a frame that fails its check closes the connection. Browser-safe: the page imports
 * it through `@brigadir/remote/web`.
 *
 * - `/ws/pair` (only while the pairing window is open): `pair-hello` → `pair-a` → `pair-b` → `pair-confirm` →
 *   `pair-register` → `pair-credential` → `pair-wait` → `paired` | `pair-refused`.
 * - `/ws`: `challenge` → `assert` (or `resume`) → `welcome` | `refused`; then `invoke`/`result`, `subscribe`/`event`,
 *   `push`/`push-saved`, `ping`/`pong`, `bye`.
 */
import { isMachineName, isRecord } from '@brigadir/core';
import { lvCat } from './cpace';

export const webProtocolVersion = 1;
export const defaultWebPort = 7422;
/** What a page answers within: a registration or a sign-in waits for a person and Face ID. */
export const webCeremonyMs = 120_000;
/** A credential id the page sends; WebAuthn allows up to 1023 bytes. */
const credentialIdMax = 1400;

export type WebPairRefusal =
	'code' | 'closed' | 'exhausted' | 'declined' | 'busy' | 'passkey' | 'off';
export type WebLoginRefusal = 'unknown' | 'passkey' | 'wait' | 'blocked' | 'off' | 'expired';
export type WebByeReason =
	'revoked' | 'off' | 'replaced' | 'slow' | 'shutdown' | 'protocol' | 'dropped' | 'expired';
/** What `navigator.credentials.create` needs; byte values are base64url. */
export type WebRegisterOptions = {
	challenge: string;
	rpId: string;
	rpName: string;
	userId: string;
	userName: string;
	/** COSE algorithms in order of preference: ES256, EdDSA, RS256. */
	algorithms: number[];
	timeoutMs: number;
};
/** The page's push subscription (`PushSubscription.toJSON()`), keys in base64url. */
export type WebPushSubscription = { endpoint: string; p256dh: string; auth: string };
export type WebMessage =
	| { t: 'pair-hello'; v: number; sid: string; machine: string }
	| { t: 'pair-a'; share: string; device: string }
	| { t: 'pair-b'; share: string; tag: string }
	| { t: 'pair-confirm'; tag: string }
	| { t: 'pair-register'; options: WebRegisterOptions }
	| {
			t: 'pair-credential';
			id: string;
			clientDataJSON: string;
			attestationObject: string;
			/** spec/remote-access-and-mobile#phone-app: the phone's name as the person set it after the code matched; absent — the name of `pair-a`. */
			device?: string;
	  }
	| { t: 'pair-wait' }
	| { t: 'paired'; machine: string }
	| { t: 'pair-refused'; reason: WebPairRefusal; attemptsLeft: number | null }
	| { t: 'challenge'; v: number; challenge: string; rpId: string; timeoutMs: number }
	| {
			t: 'assert';
			id: string;
			clientDataJSON: string;
			authenticatorData: string;
			signature: string;
			userHandle: string | null;
	  }
	| { t: 'resume'; token: string }
	| {
			t: 'welcome';
			machine: string;
			device: string;
			resume: string;
			/** One-time ticket for `POST /session`: the cookie that lets the page load the app's files. */
			ticket: string;
			app: { script: string; styles: string[] };
			/** The VAPID public key (base64url), null when the machine cannot send pushes. */
			push: string | null;
			/** spec/remote-access-and-mobile#phone-task-tools: Brigadir's version on the machine; empty when unknown. */
			version: string;
	  }
	| { t: 'refused'; reason: WebLoginRefusal; retryAfterMs: number | null }
	| { t: 'invoke'; id: number; channel: string; args: unknown[] }
	| { t: 'result'; id: number; ok: true; value: unknown }
	| { t: 'result'; id: number; ok: false; error: string }
	| { t: 'event'; channel: string; value: unknown }
	| { t: 'subscribe'; channels: string[] }
	| { t: 'push'; subscription: WebPushSubscription | null }
	| { t: 'push-saved'; ok: boolean; error: string | null }
	| { t: 'ping'; at: number }
	| { t: 'pong'; at: number }
	| { t: 'bye'; reason: WebByeReason };

const text = (value: unknown, max: number): value is string =>
	typeof value === 'string' && value.length <= max;
const base64 = (value: unknown, max: number): value is string =>
	text(value, max) && /^[A-Za-z0-9+/]*={0,2}$/.test(value);
export const isBase64Url = (value: unknown, max: number): value is string =>
	text(value, max) && value.length > 0 && /^[A-Za-z0-9_-]+$/.test(value);
const keys = (value: Record<string, unknown>, n: number) => Object.keys(value).length === n;
const count = (value: unknown) =>
	value === null || (Number.isSafeInteger(value) && Number(value) >= 0);

export function isWebPushSubscription(value: unknown): value is WebPushSubscription {
	return (
		isRecord(value) &&
		keys(value, 3) &&
		text(value.endpoint, 2048) &&
		isBase64Url(value.p256dh, 100) &&
		isBase64Url(value.auth, 40)
	);
}
/** What the web listener accepts from a page on `/ws/pair`. */
export function isWebPairClientMessage(value: unknown): value is WebMessage {
	if (!isRecord(value)) return false;
	switch (value.t) {
		case 'pair-a':
			return keys(value, 3) && base64(value.share, 64) && text(value.device, 64);
		case 'pair-confirm':
			return keys(value, 2) && base64(value.tag, 128);
		case 'pair-credential':
			return (
				(keys(value, 4) || (keys(value, 5) && isMachineName(value.device))) &&
				isBase64Url(value.id, credentialIdMax) &&
				isBase64Url(value.clientDataJSON, 8192) &&
				isBase64Url(value.attestationObject, 16_384)
			);
	}
	return false;
}
/** What the web listener accepts from a page on `/ws`, before and after the sign-in. */
export function isWebClientMessage(value: unknown): value is WebMessage {
	if (!isRecord(value)) return false;
	switch (value.t) {
		case 'assert':
			return (
				keys(value, 6) &&
				isBase64Url(value.id, credentialIdMax) &&
				isBase64Url(value.clientDataJSON, 8192) &&
				isBase64Url(value.authenticatorData, 8192) &&
				isBase64Url(value.signature, 1024) &&
				(value.userHandle === null || isBase64Url(value.userHandle, 100))
			);
		case 'resume':
			return keys(value, 2) && isBase64Url(value.token, 64);
		case 'invoke':
			return (
				keys(value, 4) &&
				Number.isSafeInteger(value.id) &&
				text(value.channel, 128) &&
				Array.isArray(value.args) &&
				value.args.length <= 16
			);
		case 'subscribe':
			return (
				keys(value, 2) &&
				Array.isArray(value.channels) &&
				value.channels.length <= 512 &&
				value.channels.every((channel) => text(channel, 128))
			);
		case 'push':
			return (
				keys(value, 2) && (value.subscription === null || isWebPushSubscription(value.subscription))
			);
		case 'ping':
			return keys(value, 2) && typeof value.at === 'number';
	}
	return false;
}
const assetPath = (value: unknown) =>
	text(value, 256) && /^\/assets\/[A-Za-z0-9._-]+\.(?:js|css)$/.test(value);
/** What a page accepts from the web listener. */
export function isWebServerMessage(value: unknown): value is WebMessage {
	if (!isRecord(value)) return false;
	switch (value.t) {
		case 'pair-hello':
			return (
				keys(value, 4) &&
				Number.isSafeInteger(value.v) &&
				base64(value.sid, 64) &&
				isMachineName(value.machine)
			);
		case 'pair-b':
			return keys(value, 3) && base64(value.share, 64) && base64(value.tag, 128);
		case 'pair-register': {
			const options = value.options;
			return (
				keys(value, 2) &&
				isRecord(options) &&
				keys(options, 7) &&
				isBase64Url(options.challenge, 64) &&
				text(options.rpId, 253) &&
				isMachineName(options.rpName) &&
				isBase64Url(options.userId, 64) &&
				text(options.userName, 64) &&
				Array.isArray(options.algorithms) &&
				options.algorithms.length <= 8 &&
				options.algorithms.every((item) => Number.isSafeInteger(item)) &&
				Number.isSafeInteger(options.timeoutMs)
			);
		}
		case 'pair-wait':
			return keys(value, 1);
		case 'paired':
			return keys(value, 2) && isMachineName(value.machine);
		case 'pair-refused':
			return (
				keys(value, 3) &&
				['code', 'closed', 'exhausted', 'declined', 'busy', 'passkey', 'off'].includes(
					value.reason as string
				) &&
				count(value.attemptsLeft)
			);
		case 'challenge':
			return (
				keys(value, 5) &&
				Number.isSafeInteger(value.v) &&
				isBase64Url(value.challenge, 64) &&
				text(value.rpId, 253) &&
				Number.isSafeInteger(value.timeoutMs)
			);
		case 'welcome':
			return (
				keys(value, 8) &&
				typeof value.version === 'string' &&
				/^[\w.+-]{0,64}$/.test(value.version) &&
				isMachineName(value.machine) &&
				isMachineName(value.device) &&
				isBase64Url(value.resume, 64) &&
				isBase64Url(value.ticket, 64) &&
				isRecord(value.app) &&
				keys(value.app, 2) &&
				assetPath(value.app.script) &&
				Array.isArray(value.app.styles) &&
				value.app.styles.length <= 16 &&
				value.app.styles.every(assetPath) &&
				(value.push === null || isBase64Url(value.push, 100))
			);
		case 'refused':
			return (
				keys(value, 3) &&
				['unknown', 'passkey', 'wait', 'blocked', 'off', 'expired'].includes(
					value.reason as string
				) &&
				count(value.retryAfterMs)
			);
		case 'result':
			return (
				Number.isSafeInteger(value.id) &&
				(value.ok === true ? keys(value, 4) : value.ok === false && text(value.error, 4096))
			);
		case 'event':
			return keys(value, 3) && text(value.channel, 128);
		case 'push-saved':
			return (
				keys(value, 3) &&
				typeof value.ok === 'boolean' &&
				(value.error === null || text(value.error, 512))
			);
		case 'pong':
			return keys(value, 2) && typeof value.at === 'number';
		case 'bye':
			return keys(value, 2) && text(value.reason, 32);
	}
	return false;
}
/**
 * spec/remote-access-and-mobile#phone-network: CPace's channel identifier for a phone — lv_cat("brigadir-web-pair-1", origin). There is no client
 * certificate to bind; the origin is what the browser and the listener both know, and the passkey that follows is
 * registered on the same WebSocket.
 */
export function webChannelIdentifier(origin: string): Uint8Array {
	const utf8 = (value: string) => new TextEncoder().encode(value);
	return lvCat(utf8('brigadir-web-pair-1'), utf8(origin));
}
