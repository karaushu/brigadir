import { createConnection } from 'node:net';
import {
	type ChangeView,
	type TerminalCommand,
	type TerminalEvent,
	isRecord,
	type SaveFileRequest,
	type SaveFileResult,
	type EventRecord,
	type SessionCommand,
	type SessionSnapshot,
	type HostStatus,
	hostStatus,
	isHostStatus,
} from '@brigadir/core';
import { Peer } from './peer';
import type { HostIdentity } from './runtime';
export async function connectHost(
	identity: HostIdentity,
	onEvent: (record: EventRecord) => void = () => {},
	onClose: () => void = () => {},
	onTerminal: (event: TerminalEvent) => void = () => {},
	onBrowser: (method: string, params: unknown) => Promise<unknown> = async () => {
		throw new Error('Browser UI is unavailable');
	}
) {
	const socket = createConnection(identity.socket);
	const peer = new Peer(socket, onBrowser);
	const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
	peer.onNotification = (method, params) => {
		if (method === 'terminal' && isRecord(params)) onTerminal(params as TerminalEvent);
		if (method === 'event' && isRecord(params) && params.schemaVersion === 1)
			onEvent(params as EventRecord);
	};
	socket.once('close', onClose);
	const timer = setTimeout(() => peer.close(), 5000);
	timer.unref();
	try {
		const reply = await peer.request('handshake', {
			protocolVersion: 1,
			key: identity.key,
			instance: identity.instance,
			role: 'ui',
			token: identity.uiToken,
		});
		if (
			!isRecord(reply) ||
			reply.protocolVersion !== 1 ||
			reply.instance !== identity.instance ||
			reply.startedAt !== identity.startedAt
		)
			throw new Error('Host identity mismatch');
	} catch (e) {
		peer.close();
		throw e;
	} finally {
		clearTimeout(timer);
	}
	return {
		instance: identity.instance,
		closed,
		revertFile: (fileId: string, range?: ChangeView) =>
			peer.request('revert_file', { fileId, ...(range ? { range } : {}) }),
		backgroundOutput: (id: string) =>
			peer.request('background_output', { id }) as Promise<{ text: string; missing: boolean }>,
		terminal: (command: TerminalCommand) => peer.request('terminal', command),
		startAgent: (allowScopeConflict = false) => peer.request('start_agent', { allowScopeConflict }),
		visible: (visible: boolean) => peer.request('visible', { visible }),
		saveFile: (request: SaveFileRequest) =>
			peer.request('save_file', request) as Promise<SaveFileResult>,
		snapshot: (afterSeq?: number) => readSnapshot(peer, afterSeq),
		status: () => readStatus(peer),
		command: (command: SessionCommand) => peer.request('command', command),
		close: () => peer.close(),
	};
}
/** Hosts started before a method existed answer 'Invalid command'; a crew peer of such a host hears that the method is not for its role. */
const olderHost = (e: unknown) =>
	e instanceof Error &&
	(e.message === 'Invalid command' || e.message === 'Method is not available to this role');
/** A host started before `status` existed: the snapshot then stands in, once per call. */
export async function readStatus(peer: Peer): Promise<HostStatus> {
	try {
		const value = await peer.request('status', {});
		if (isHostStatus(value)) return value;
	} catch (e) {
		if (!olderHost(e)) throw e;
	}
	const snapshot = (await peer.request('snapshot', {})) as SessionSnapshot;
	return hostStatus(snapshot.records, snapshot.connected);
}
/** Records after `afterSeq` only. A host started before the cursor ignores it and sends all records; the tail is cut here so callers see one shape. */
export async function readSnapshot(peer: Peer, afterSeq?: number): Promise<SessionSnapshot> {
	if (!afterSeq) return (await peer.request('snapshot', {})) as SessionSnapshot;
	const snapshot = (await peer.request('snapshot', { afterSeq })) as SessionSnapshot;
	const first = snapshot.records.findIndex((record) => record.seq > afterSeq);
	return first === 0
		? snapshot
		: { ...snapshot, records: first < 0 ? [] : snapshot.records.slice(first) };
}
export type HostClient = Awaited<ReturnType<typeof connectHost>>;
