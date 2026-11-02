/**
 * Security review: what a device does with a machine that lies.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { createIdentity } from './cert';
import { CPaceParty } from './cpace';
import { decodeFrame, encodeFrame } from './codec';
import { pairWithMachine } from './connection';
import { protocolVersion } from './protocol';

const servers: Server[] = [];
afterEach(async () => {
	for (const server of servers.splice(0)) {
		server.closeAllConnections?.();
		await new Promise((resolve) => server.close(resolve));
	}
});
/** A pairing listener that does not know the code: it answers `pair-a` with whatever `next` says. */
async function fakeMachine(
	next: (message: Record<string, unknown>) => Record<string, unknown>[]
): Promise<number> {
	const identity = createIdentity('impostor');
	const server = createServer({
		key: identity.key,
		cert: identity.cert,
		requestCert: true,
		rejectUnauthorized: false,
		minVersion: 'TLSv1.3',
	});
	servers.push(server);
	const wss = new WebSocketServer({ server, path: '/pair' });
	wss.on('connection', (ws) => {
		ws.send(
			encodeFrame({
				t: 'pair-hello',
				v: protocolVersion,
				sid: Buffer.alloc(16, 7).toString('base64'),
				machine: 'studio',
				table: 'table',
			})
		);
		ws.on('message', (data) => {
			const message = decodeFrame(data.toString()) as Record<string, unknown>;
			for (const reply of next(message)) ws.send(encodeFrame(reply));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	return (server.address() as AddressInfo).port;
}
const paired = {
	t: 'paired',
	machine: { name: 'studio', addresses: [], port: 7420, pairingPort: 7421 },
};

describe('security review R2–R4: pairing on the device', () => {
	it('V1: a machine that skips CPace and says `paired` right after `pair-a` is not paired', async () => {
		const port = await fakeMachine((message) => (message.t === 'pair-a' ? [paired] : []));
		const { result, record } = await pairWithMachine({
			identity: createIdentity('device'),
			host: '127.0.0.1',
			port,
			code: 'ABCD2345',
			deviceName: 'laptop',
			tableHash: 'table',
		});
		expect(result.ok).toBe(false);
		expect(record).toBeNull();
	});
	it('V1: `pair-wait` and `paired` after a tag the device refused do not pair either', async () => {
		// A real CPace share of a guessed code: the device's finish works, its check of the machine's tag fails.
		const guess = new CPaceParty(
			'responder',
			{
				prs: new TextEncoder().encode('ZZZZ9999'),
				ci: new Uint8Array(32),
				sid: Buffer.alloc(16, 7),
			},
			new TextEncoder().encode('studio')
		);
		const port = await fakeMachine((message) =>
			message.t === 'pair-a'
				? [
						{
							t: 'pair-b',
							share: Buffer.from(guess.share).toString('base64'),
							tag: Buffer.alloc(64, 2).toString('base64'),
						},
					]
				: message.t === 'pair-confirm'
					? [{ t: 'pair-wait' }, paired]
					: []
		);
		const { result, record } = await pairWithMachine({
			identity: createIdentity('device'),
			host: '127.0.0.1',
			port,
			code: 'ABCD2345',
			deviceName: 'laptop',
			tableHash: 'table',
		});
		expect(result.ok).toBe(false);
		expect(record).toBeNull();
	});
});
