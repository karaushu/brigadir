import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, lstat, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createServer, type Server, type Socket } from 'node:net';
import { isRecord } from '@brigadir/core';
import { serveBrigadirChat, type McpCall } from '@brigadir/host/brigadir-tools';
import { Peer } from '@brigadir/host/peer';
import type { McpCommand } from '@brigadir/transport';

/**
 * spec/settings-modules-and-onboarding#brigadir-chat-tools: main serves the Brigadir chat's tools the way a task's host serves its own — the
 * agent spawns `mcp-relay`, which authenticates on this socket with the chat's token and then carries MCP both ways.
 */
export class BrigadirChatMcp {
	private server: Server | null = null;
	private ready: Promise<void> | null = null;
	private readonly instance = randomBytes(12).toString('hex');
	private readonly chats = new Map<string, { token: string; call: McpCall }>();
	constructor(
		private socketPath: string,
		private readonly relay: string
	) {}
	private start() {
		return (this.ready ??= (async () => {
			// spec/architecture-and-platform#socket-protocol: a Unix socket path stays under 104 bytes; a long data folder moves it to /tmp, as a host's does.
			if (Buffer.byteLength(this.socketPath) >= 104) {
				const dir = join('/tmp', `brigadir.${process.getuid?.() ?? 'user'}`);
				await mkdir(dir, { recursive: true, mode: 0o700 });
				const info = await lstat(dir);
				if (
					info.isSymbolicLink() ||
					!info.isDirectory() ||
					(process.getuid && info.uid !== process.getuid())
				)
					throw new Error('Unsafe socket directory');
				await chmod(dir, 0o700);
				this.socketPath = join(
					dir,
					`chat-${createHash('sha256').update(this.socketPath).digest('hex').slice(0, 16)}.sock`
				);
			} else await mkdir(dirname(this.socketPath), { recursive: true, mode: 0o700 });
			await rm(this.socketPath, { force: true });
			this.server = createServer((socket) => this.accept(socket));
			await new Promise<void>((resolve, reject) => {
				this.server!.once('error', reject);
				this.server!.listen(this.socketPath, () => resolve());
			});
		})());
	}
	private accept(socket: Socket) {
		let authed = false;
		const timer = setTimeout(() => socket.destroy(), 5000);
		timer.unref();
		const peer = new Peer(socket, async (method, params) => {
			if (authed || method !== 'handshake' || !isRecord(params))
				throw new Error('Invalid handshake');
			const key = isRecord(params.key) ? params.key : {},
				chat = typeof key.id === 'string' ? this.chats.get(key.id) : undefined;
			if (
				params.protocolVersion !== 1 ||
				params.instance !== this.instance ||
				key.projectId !== 'brigadir' ||
				params.role !== 'mcp' ||
				params.stdio !== true ||
				!chat ||
				typeof params.token !== 'string' ||
				!same(params.token, chat.token)
			)
				throw new Error('Invalid handshake');
			authed = true;
			clearTimeout(timer);
			peer.handOff(serveBrigadirChat(socket, chat.call));
			return { protocolVersion: 1 };
		});
	}
	/** The MCP server entry of one chat's agent session; `call` answers its tools. */
	async register(chat: string, call: McpCall): Promise<McpCommand> {
		await this.start();
		const token = randomBytes(24).toString('hex');
		this.chats.set(chat, { token, call });
		return {
			name: 'brigadir',
			command: this.relay,
			args: [],
			env: [
				{ name: 'BRIGADIR_HOST_SOCKET', value: this.socketPath },
				{ name: 'BRIGADIR_HOST_INSTANCE', value: this.instance },
				{ name: 'BRIGADIR_MCP_TOKEN', value: token },
				{ name: 'BRIGADIR_PROJECT_ID', value: 'brigadir' },
				{ name: 'BRIGADIR_TASK_ID', value: chat },
			],
		};
	}
	unregister(chat: string) {
		this.chats.delete(chat);
	}
	async close() {
		this.chats.clear();
		const server = this.server;
		this.server = null;
		this.ready = null;
		if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(this.socketPath, { force: true }).catch(() => {});
	}
}
function same(a: string, b: string) {
	const left = Buffer.from(a),
		right = Buffer.from(b);
	return left.length === right.length && timingSafeEqual(left, right);
}
