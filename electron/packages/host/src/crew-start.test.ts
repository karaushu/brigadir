import { expect, it } from 'vitest';
import { createServer, connect, type Socket } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostStatus, type EventRecord, type SessionEvent } from '@brigadir/core';
import { Peer } from './peer';
import { awaitSessionStarted } from './crew';
const record = (seq: number, event: SessionEvent): EventRecord => ({
	schemaVersion: 1,
	seq,
	at: '2026-09-23T00:00:00.000Z',
	event,
});
const started = (seq: number, sessionId: string) =>
	record(seq, { kind: 'session.started', sessionId, modes: [], modeId: null, options: [] });
/** A worker host stand-in: counts what the foreman asks and pushes records like server.ts does. */
async function worker(
	records: EventRecord[],
	options: { status?: boolean; ready?: () => boolean } = {}
) {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-crew-start-')),
		path = join(root, 'w.sock'),
		calls: string[] = [];
	let accept!: (socket: Socket) => void;
	const accepted = new Promise<Socket>((resolve) => {
		accept = resolve;
	});
	const server = createServer(accept);
	await new Promise<void>((resolve) => server.listen(path, resolve));
	const raw = connect(path);
	await new Promise((resolve) => raw.once('connect', resolve));
	const host = new Peer(await accepted, async (method) => {
		calls.push(method);
		if (method === 'status') {
			if (options.status === false) throw new Error('Method is not available to this role');
			return hostStatus(records, options.ready?.() ?? true);
		}
		if (method === 'snapshot')
			return {
				key: { projectId: 'p', id: 't' },
				records,
				connected: options.ready?.() ?? true,
				issue: null,
			};
		throw new Error('Invalid command');
	});
	const peer = new Peer(raw),
		closed = new Promise<void>((resolve) => raw.once('close', () => resolve())),
		link = { peer, closed, events: new Set<(record: EventRecord) => void>() };
	peer.onNotification = (method, params) => {
		if (method === 'event') for (const listener of link.events) listener(params as EventRecord);
	};
	const push = (value: EventRecord) => {
		records.push(value);
		host.notify('event', value);
	};
	return {
		link,
		calls,
		push,
		async close() {
			raw.destroy();
			host.close();
			await new Promise((resolve) => server.close(resolve));
			await rm(root, { recursive: true, force: true });
		},
	};
}
it('waits for a worker start on pushed events after one status read, without polling snapshots', async () => {
	const fresh = await worker([]);
	try {
		const waiting = awaitSessionStarted(fresh.link, 5000);
		// Before BG-04 the foreman pulled a full snapshot every 100 ms for the whole startup (~10 per second).
		await new Promise((resolve) => setTimeout(resolve, 500));
		fresh.push(started(1, 'a'));
		expect((await waiting).seq).toBe(1);
		expect(fresh.calls).toEqual(['status', 'status']);
		expect(fresh.link.events.size).toBe(0);
	} finally {
		await fresh.close();
	}
	// A resumed worker keeps returning the first start in its journal, as before.
	const resumed = await worker([
		started(1, 'old'),
		record(2, { kind: 'host.stopped', reason: 'x' }),
		started(3, 'new'),
	]);
	try {
		const found = await awaitSessionStarted(resumed.link, 5000);
		expect(found.event.kind === 'session.started' && found.event.sessionId).toBe('old');
		expect(resumed.calls).toEqual(['status', 'snapshot', 'status']);
	} finally {
		await resumed.close();
	}
	const failed = await worker([]);
	try {
		const waiting = awaitSessionStarted(failed.link, 5000);
		await new Promise((resolve) => setTimeout(resolve, 50));
		failed.push(record(1, { kind: 'session.failed', message: 'x' }));
		await expect(waiting).rejects.toThrow('Worker agent startup failed');
	} finally {
		await failed.close();
	}
	// A worker host started before crew peers could ask `status` answers with the snapshot once.
	const older = await worker([], { status: false });
	try {
		const waiting = awaitSessionStarted(older.link, 5000);
		await new Promise((resolve) => setTimeout(resolve, 50));
		older.push(started(1, 'a'));
		expect((await waiting).seq).toBe(1);
		expect(older.calls).toEqual(['status', 'snapshot', 'status', 'snapshot']);
	} finally {
		await older.close();
	}
	// The start record arrives before the worker host accepts commands: the wait ends only when it is connected.
	let ready = false;
	const starting = await worker([], { ready: () => ready });
	try {
		const waiting = awaitSessionStarted(starting.link, 5000);
		let settled = false;
		void waiting.then(() => {
			settled = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 50));
		starting.push(started(1, 'a'));
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(settled).toBe(false);
		ready = true;
		expect((await waiting).seq).toBe(1);
		expect(starting.calls.filter((call) => call === 'snapshot')).toEqual([]);
	} finally {
		await starting.close();
	}
	const silent = await worker([]);
	try {
		await expect(awaitSessionStarted(silent.link, 200)).rejects.toThrow('Worker startup timed out');
		expect(silent.calls).toEqual(['status']);
	} finally {
		await silent.close();
	}
	const dropped = await worker([]);
	try {
		const waiting = awaitSessionStarted(dropped.link, 5000);
		await new Promise((resolve) => setTimeout(resolve, 50));
		dropped.link.peer.close();
		await expect(waiting).rejects.toThrow('Host disconnected');
	} finally {
		await dropped.close();
	}
});
