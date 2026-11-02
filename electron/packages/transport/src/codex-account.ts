import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { QuotaAccess, QuotaReading } from '@brigadir/core';
import type { AdapterCommand } from './adapter';
import { codexRateLimitReadings, planLabel } from './quota';
export type CodexLimits = { windows: QuotaReading[]; plan: string | null; access: QuotaAccess };
type Pending = {
	resolve(value: unknown): void;
	reject(error: Error): void;
	timer: ReturnType<typeof setTimeout>;
};
/** spec/agents-and-providers#quota-sources: one `codex app-server` per app, used only to read account limits. The documented integration
 *  surface (learn.chatgpt.com/docs/app-server): newline-delimited JSON-RPC without the `jsonrpc` field.
 *  A read is one backend GET and never spends model tokens; turns never run in this process. */
export class CodexAccount {
	private child: ChildProcessWithoutNullStreams;
	private pending = new Map<number, Pending>();
	private next = 0;
	private buffer = '';
	private ended: Error | null = null;
	private constructor(command: AdapterCommand, env: NodeJS.ProcessEnv) {
		this.child = spawn(command.command, [...command.args, 'app-server'], {
			stdio: ['pipe', 'pipe', 'pipe'],
			env,
			shell: false,
		});
		this.child.stdout.setEncoding('utf8');
		this.child.stdout.on('data', (chunk: string) => this.read(chunk));
		this.child.stderr.resume();
		const end = (error: Error) => {
			this.ended ??= error;
			for (const [, request] of this.pending) {
				clearTimeout(request.timer);
				request.reject(this.ended);
			}
			this.pending.clear();
		};
		this.child.once('error', end);
		this.child.once('exit', (code, signal) =>
			end(new Error(`codex app-server exited (${signal ?? code})`))
		);
		this.child.stdin.on('error', end);
	}
	static async start(input: {
		command: AdapterCommand;
		env?: NodeJS.ProcessEnv;
		timeoutMs?: number;
	}): Promise<CodexAccount> {
		const account = new CodexAccount(input.command, input.env ?? process.env);
		try {
			await account.request(
				'initialize',
				{
					clientInfo: { name: 'brigadir', title: 'Brigadir', version: '0.0.0' },
					capabilities: null,
				},
				input.timeoutMs ?? 15_000
			);
			return account;
		} catch (error) {
			account.close();
			throw error;
		}
	}
	get closed() {
		return this.ended !== null;
	}
	private read(chunk: string) {
		this.buffer += chunk;
		if (this.buffer.length > 4_000_000) {
			this.close();
			return;
		}
		for (let index = this.buffer.indexOf('\n'); index >= 0; index = this.buffer.indexOf('\n')) {
			const line = this.buffer.slice(0, index).trim();
			this.buffer = this.buffer.slice(index + 1);
			if (!line) continue;
			let message: unknown;
			try {
				message = JSON.parse(line);
			} catch {
				continue;
			}
			if (!message || typeof message !== 'object') continue;
			const value = message as {
				id?: unknown;
				method?: unknown;
				result?: unknown;
				error?: { message?: unknown };
			};
			if (typeof value.id === 'number' && value.method === undefined) {
				const request = this.pending.get(value.id);
				if (!request) continue;
				this.pending.delete(value.id);
				clearTimeout(request.timer);
				if (value.error)
					request.reject(
						new Error(
							typeof value.error.message === 'string'
								? value.error.message
								: 'codex app-server request failed'
						)
					);
				else request.resolve(value.result);
			} else if (value.id !== undefined && typeof value.method === 'string')
				this.write({
					id: value.id,
					error: { code: -32601, message: 'Brigadir reads limits only' },
				});
		}
	}
	private write(message: unknown) {
		this.child.stdin.write(JSON.stringify(message) + '\n');
	}
	private request(method: string, params: unknown, timeoutMs = 15_000): Promise<unknown> {
		if (this.ended) return Promise.reject(this.ended);
		const id = ++this.next;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`${method} timed out`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			this.write({ id, method, params });
		});
	}
	/** Background reads skip reset-credit details; `supportsLunaReserve` stays off (TUI: not for passive readers). */
	async readLimits(): Promise<CodexLimits> {
		const account = (await this.request('account/read', { refreshToken: false })) as {
			account?: { type?: unknown; planType?: unknown } | null;
		} | null;
		const type = account?.account?.type,
			plan =
				typeof account?.account?.planType === 'string' ? planLabel(account.account.planType) : null;
		if (type === 'apiKey') return { windows: [], plan: null, access: 'api-key' };
		const result = (await this.request('account/rateLimits/read', {
			excludeResetCreditDetails: true,
		})) as { rateLimits?: { planType?: unknown } } | null;
		const planType =
			typeof result?.rateLimits?.planType === 'string'
				? planLabel(result.rateLimits.planType)
				: plan;
		return {
			windows: codexRateLimitReadings(result?.rateLimits),
			plan: planType,
			access: type === 'chatgpt' ? 'subscription' : 'unknown',
		};
	}
	close() {
		if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGTERM');
		this.ended ??= new Error('codex app-server closed');
	}
}
