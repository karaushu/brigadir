import { expect, it } from 'vitest';
import { createServer, connect, type Socket } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Peer } from './peer';
async function pair() {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-peer-')),
		path = join(root, 'p.sock');
	let accept!: (socket: Socket) => void;
	const accepted = new Promise<Socket>((resolve) => {
		accept = resolve;
	});
	const server = createServer(accept);
	await new Promise<void>((resolve) => server.listen(path, resolve));
	const raw = connect(path);
	await new Promise((resolve) => raw.once('connect', resolve));
	const socket = await accepted;
	return {
		raw,
		socket,
		async close() {
			raw.destroy();
			socket.destroy();
			await new Promise((resolve) => server.close(resolve));
			await rm(root, { recursive: true, force: true });
		},
	};
}
it('frames split across chunks, several frames per chunk and multibyte text at chunk edges', async () => {
	const { raw, socket, close } = await pair();
	try {
		const peer = new Peer(socket),
			seen: unknown[] = [];
		peer.onNotification = (method, params) => seen.push([method, params]);
		const frame = (text: string) =>
			`${JSON.stringify({ jsonrpc: '2.0', method: 'n', params: text })}\n`;
		const big = 'ї'.repeat(200_000),
			bytes = Buffer.from(frame('a') + frame(big) + frame('b'));
		// Cut inside the two-byte letter so the decoder must carry it into the next chunk.
		for (let at = 0; at < bytes.length; at += 65_537) raw.write(bytes.subarray(at, at + 65_537));
		await expect.poll(() => seen.length).toBe(3);
		expect(seen).toEqual([
			['n', 'a'],
			['n', big],
			['n', 'b'],
		]);
	} finally {
		await close();
	}
});
it('drops a connection whose unterminated frame exceeds the limit', async () => {
	const { raw, socket, close } = await pair();
	try {
		new Peer(socket);
		const closed = new Promise((resolve) => socket.once('close', resolve));
		const chunk = Buffer.alloc(1024 * 1024, 'x');
		for (let i = 0; i < 33; i++) raw.write(chunk);
		await closed;
		expect(socket.destroyed).toBe(true);
	} finally {
		await close();
	}
});
