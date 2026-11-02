import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AgentLoginState } from '@brigadir/core';
type Provider = 'claude' | 'codex';
/** The sign-in command; a test passes a script through `BRIGADIR_TEST_LOGIN`. */
export type LoginCommand = { command: string; args: string[]; env: NodeJS.ProcessEnv };
export type AgentLoginDeps = {
	/** `quiet` (spec/remote-access-and-mobile#browser-from-device): the CLI opens no browser on this machine — a device opens the page. */
	command(provider: Provider, quiet: boolean): Promise<LoginCommand>;
	/** The CLI's own status after the command exits; null — it cannot tell. */
	signedIn(provider: Provider): Promise<boolean | null>;
	openUrl(url: string): Promise<void>;
	publish(state: AgentLoginState): void;
	/** Every live host of this agent starts its failed turn again (spec/agents-and-providers#sign-in-recovery). */
	retry(provider: Provider): Promise<void>;
	timeoutMs?: number;
};
const urlPattern = /https:\/\/[^\s"'<>]+/;
/**
 * spec/agents-and-providers#sign-in-recovery: the agent's own sign-in, run by the app as a child process — no Terminal. Claude opens the browser itself
 * and reads a pasted code from stdin when the browser cannot come back; Codex opens the browser and takes no code.
 * One process per agent; the state is the same for every task of that agent.
 */
export class AgentLogin {
	private states = new Map<Provider, AgentLoginState>();
	private runs = new Map<Provider, { child: ChildProcessWithoutNullStreams; cancelled: boolean }>();
	constructor(private deps: AgentLoginDeps) {}
	state(provider: Provider): AgentLoginState {
		return this.states.get(provider) ?? { provider, phase: 'idle', url: null, at: 0 };
	}
	private set(provider: Provider, patch: Partial<AgentLoginState>) {
		const next = { ...this.state(provider), ...patch, provider, at: Date.now() };
		this.states.set(provider, next);
		this.deps.publish(next);
		return next;
	}
	async start(provider: Provider, options: { quiet?: boolean } = {}): Promise<AgentLoginState> {
		if (this.runs.has(provider)) return this.state(provider);
		const { command, args, env } = await this.deps.command(provider, options.quiet === true);
		if (this.runs.has(provider)) return this.state(provider);
		const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] }),
			run = { child, cancelled: false };
		this.runs.set(provider, run);
		this.set(provider, { phase: 'waiting', url: null });
		let output = '';
		const read = (chunk: Buffer) => {
			output = (output + chunk.toString('utf8')).slice(-16384);
			const url = output.match(urlPattern)?.[0];
			if (url && !this.state(provider).url) this.set(provider, { url });
		};
		child.stdout.on('data', read);
		child.stderr.on('data', read);
		child.stdin.on('error', () => {});
		const timer = setTimeout(
			() => {
				child.kill();
			},
			this.deps.timeoutMs ?? 10 * 60_000
		);
		timer.unref?.();
		child.on('error', () => {});
		child.on('close', (code) => {
			void (async () => {
				clearTimeout(timer);
				this.runs.delete(provider);
				if (run.cancelled) {
					this.set(provider, { phase: 'idle', url: null });
					return;
				}
				const signedIn = code === 0 ? await this.deps.signedIn(provider).catch(() => null) : false;
				if (signedIn === false) {
					this.set(provider, { phase: 'failed' });
					return;
				}
				this.set(provider, { phase: 'done', url: null });
				await this.deps.retry(provider).catch(() => {});
			})();
		});
		return this.state(provider);
	}
	submitCode(provider: Provider, code: string) {
		const run = this.runs.get(provider);
		if (!run || provider !== 'claude') throw new Error('Sign-in is not waiting for a code');
		const value = code.trim();
		if (!value || value.length > 4096 || /[\r\n\0]/.test(value))
			throw new Error('The code is invalid');
		run.child.stdin.write(`${value}\n`);
	}
	cancel(provider: Provider) {
		const run = this.runs.get(provider);
		if (!run) return;
		run.cancelled = true;
		run.child.kill();
	}
	async reopen(provider: Provider) {
		const url = this.state(provider).url;
		if (!url) throw new Error('The sign-in page is unknown');
		await this.deps.openUrl(url);
	}
	stopAll() {
		for (const provider of [...this.runs.keys()]) this.cancel(provider);
	}
}
