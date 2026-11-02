/**
 * spec/remote-access-and-mobile#pairing: the messages of the two listeners. Every frame is one object with `t`; a frame that fails its check
 * closes the connection. Pairing (port 7421) knows only `pair-*`; the gateway (port 7420) starts with `login`.
 */
import {
	isMachineName,
	isRecord,
	isRemoteAddress,
	isRemotePort,
	type RemoteAddress,
	type RemoteControl,
} from '@brigadir/core';

export const protocolVersion = 1;
export const defaultPort = 7420;
export const defaultPairingPort = 7421;
/** Before login and during pairing a frame is small; after login it carries IPC values (spec/remote-access-and-mobile#pairing). */
export const pairingFrameLimit = 16 * 1024;
export const gatewayFrameLimit = 16 * 1024 * 1024;
/** A WebSocket without a session closes this long after it opened, whatever happens on it (security review R1, S10). */
export const loginTimeoutMs = 20_000;
/** Each pairing step before the person's confirmation: `pair-a` after `pair-hello`, `pair-confirm` after `pair-b` (S5). */
export const pairingStepTimeoutMs = 5_000;
/** The TLS handshake, and a connection's wait for its upgrade request (security review R1, S6). */
export const handshakeTimeoutMs = 10_000;
/** Open connections on all listeners together and from one address (S6). */
export const connectionLimit = 64;
export const connectionsPerAddress = 8;

export type MachineInfo = {
	name: string;
	addresses: RemoteAddress[];
	port: number;
	pairingPort: number;
};
export type PairRefusal = 'code' | 'closed' | 'exhausted' | 'declined' | 'busy' | 'version';
export type PairMessage =
	| { t: 'pair-hello'; v: number; sid: string; machine: string; table: string }
	| { t: 'pair-a'; share: string; device: string }
	| { t: 'pair-b'; share: string; tag: string }
	| { t: 'pair-confirm'; tag: string }
	| { t: 'pair-wait' }
	| { t: 'paired'; machine: MachineInfo }
	| { t: 'pair-refused'; reason: PairRefusal; attemptsLeft: number | null };
export type LoginRefusal =
	'password' | 'wait' | 'blocked' | 'version' | 'unknown' | 'off' | 'expired' | 'local';
export type ByeReason =
	| 'revoked'
	| 'off'
	| 'password-changed'
	| 'replaced'
	| 'slow'
	| 'shutdown'
	| 'protocol'
	| 'dropped';
export type GatewayMessage =
	| {
			t: 'login';
			v: number;
			table: string;
			password: string | null;
			resume: string | null;
			takeOver: boolean;
	  }
	| { t: 'welcome'; machine: MachineInfo; resume: string; control: RemoteControl }
	| {
			t: 'refused';
			reason: LoginRefusal;
			retryAfterMs: number | null;
			attemptsLeft: number | null;
			machine: string | null;
	  }
	| { t: 'invoke'; id: number; channel: string; args: unknown[] }
	| { t: 'result'; id: number; ok: true; value: unknown }
	| { t: 'result'; id: number; ok: false; error: string }
	| { t: 'event'; channel: string; value: unknown }
	| { t: 'subscribe'; channels: string[] }
	| { t: 'take-control' }
	| { t: 'ping'; at: number }
	| { t: 'pong'; at: number }
	| { t: 'bye'; reason: ByeReason };

const text = (value: unknown, max: number): value is string =>
	typeof value === 'string' && value.length <= max;
const base64 = (value: unknown, max: number): value is string =>
	text(value, max) && /^[A-Za-z0-9+/]*={0,2}$/.test(value);
const count = (value: unknown) =>
	value === null || (Number.isSafeInteger(value) && Number(value) >= 0);
const keys = (value: Record<string, unknown>, n: number) => Object.keys(value).length === n;

/** What the working machine accepts on the pairing listener. */
export function isPairClientMessage(value: unknown): value is PairMessage {
	if (!isRecord(value)) return false;
	if (value.t === 'pair-a')
		return keys(value, 3) && base64(value.share, 64) && text(value.device, 64);
	if (value.t === 'pair-confirm') return keys(value, 2) && base64(value.tag, 128);
	return false;
}
/** The machine's name and addresses as the device stores them: what `machines.json` would refuse is refused here. */
function isMachineInfo(value: unknown): value is MachineInfo {
	return (
		isRecord(value) &&
		keys(value, 4) &&
		isMachineName(value.name) &&
		Array.isArray(value.addresses) &&
		value.addresses.length <= 32 &&
		value.addresses.every(isRemoteAddress) &&
		isRemotePort(value.port) &&
		isRemotePort(value.pairingPort)
	);
}
/** What the device accepts from the pairing listener. */
export function isPairServerMessage(value: unknown): value is PairMessage {
	if (!isRecord(value)) return false;
	switch (value.t) {
		case 'pair-hello':
			return (
				keys(value, 5) &&
				Number.isSafeInteger(value.v) &&
				base64(value.sid, 64) &&
				isMachineName(value.machine) &&
				text(value.table, 64)
			);
		case 'pair-b':
			return keys(value, 3) && base64(value.share, 64) && base64(value.tag, 128);
		case 'pair-wait':
			return keys(value, 1);
		case 'paired':
			return keys(value, 2) && isMachineInfo(value.machine);
		case 'pair-refused':
			return (
				keys(value, 3) &&
				['code', 'closed', 'exhausted', 'declined', 'busy', 'version'].includes(
					value.reason as string
				) &&
				count(value.attemptsLeft)
			);
	}
	return false;
}
/** What the working machine accepts on the gateway. */
export function isGatewayClientMessage(value: unknown): value is GatewayMessage {
	if (!isRecord(value)) return false;
	switch (value.t) {
		case 'login':
			return (
				keys(value, 6) &&
				Number.isSafeInteger(value.v) &&
				text(value.table, 64) &&
				(value.password === null || text(value.password, 1024)) &&
				(value.resume === null || base64(value.resume, 128)) &&
				typeof value.takeOver === 'boolean'
			);
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
		case 'take-control':
			return keys(value, 1);
		case 'ping':
			return keys(value, 2) && typeof value.at === 'number';
	}
	return false;
}
/** What the device accepts from the gateway. */
export function isGatewayServerMessage(value: unknown): value is GatewayMessage {
	if (!isRecord(value)) return false;
	switch (value.t) {
		case 'welcome':
			return (
				keys(value, 4) &&
				isMachineInfo(value.machine) &&
				base64(value.resume, 128) &&
				isRecord(value.control)
			);
		case 'refused':
			return (
				keys(value, 5) &&
				['password', 'wait', 'blocked', 'version', 'unknown', 'off', 'expired', 'local'].includes(
					value.reason as string
				) &&
				count(value.retryAfterMs) &&
				count(value.attemptsLeft) &&
				(value.machine === null || text(value.machine, 64))
			);
		case 'result':
			return (
				Number.isSafeInteger(value.id) &&
				(value.ok === true ? keys(value, 4) : value.ok === false && text(value.error, 4096))
			);
		case 'event':
			return keys(value, 3) && text(value.channel, 128);
		case 'pong':
			return keys(value, 2) && typeof value.at === 'number';
		case 'bye':
			return keys(value, 2) && text(value.reason, 32);
	}
	return false;
}
