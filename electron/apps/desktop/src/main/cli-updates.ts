import { mkdir } from 'node:fs/promises';
import {
	cliUpdateEvery,
	isCliUpdateStatus,
	versionOf,
	type CliUpdateResult,
	type CliUpdateStatus,
} from '@brigadir/core';
import { SessionStore, atomicJson, readDocument, safePath } from '@brigadir/persistence';
type Provider = 'claude' | 'codex';
export type CliRun = (
	provider: Provider,
	args: string[],
	timeout: number
) => Promise<{ code: number; stdout: string; stderr: string } | null>;
export type CliUpdateDeps = {
	/** The CLI's own command; null when this provider has no CLI on the login shell's PATH. */
	run: CliRun;
	/** Providers switched on in Settings ▸ Agents, and whether the background run is on (spec/agents-and-providers#cli-updates). */
	settings(): { providers: Provider[]; background: boolean };
	/** «Check now» also refreshes the GUI adapters. */
	refreshAdapters(): Promise<void>;
	/** After every run: the window re-reads the status, main forgets the model catalogs. */
	changed(status: CliUpdateStatus): void;
	log(line: string): void;
};
const updateTimeout = 5 * 60_000,
	versionTimeout = 10_000;
/** spec/agents-and-providers#cli-updates: `claude update` / `codex update` once a day in the background and on «Check now». One run at a time. */
export class CliUpdates {
	private current: CliUpdateStatus = { checkedAt: null, running: false, results: [] };
	private loaded: Promise<void> | null = null;
	private running: Promise<CliUpdateStatus> | null = null;
	private timer: ReturnType<typeof setInterval> | null = null;
	constructor(
		private dataDir: string | undefined,
		private deps: CliUpdateDeps,
		private now = () => Date.now()
	) {}
	private file() {
		return SessionStore.at(this.dataDir).then((store) => safePath(store.root, 'cli-updates.json'));
	}
	private load() {
		return (this.loaded ??= (async () => {
			try {
				const doc = await readDocument(await this.file());
				const value = doc.status;
				if (isCliUpdateStatus(value)) this.current = { ...value, running: false };
			} catch {
				/* never checked, or an unreadable file: the next run writes it again */
			}
		})());
	}
	async status(): Promise<CliUpdateStatus> {
		await this.load();
		return structuredClone(this.current);
	}
	/** Background start: the first check a minute after launch, then the 24-hour gate every hour. */
	start(first = 60_000, every = 60 * 60_000) {
		setTimeout(() => {
			void this.maybeRun();
		}, first).unref?.();
		this.timer = setInterval(() => {
			void this.maybeRun();
		}, every);
		this.timer.unref?.();
	}
	stop() {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}
	/** The background run: only with the switch on and once a day. */
	async maybeRun() {
		await this.load();
		if (!this.deps.settings().background || this.running) return this.running;
		if (this.current.checkedAt && this.now() - Date.parse(this.current.checkedAt) < cliUpdateEvery)
			return null;
		return this.run(false);
	}
	/** «Check now»: any time, switch on or off; a run already going is joined. */
	checkNow() {
		return this.running ?? this.run(true);
	}
	private run(manual: boolean) {
		const run = (async () => {
			await this.load();
			this.current = { ...this.current, running: true };
			this.deps.changed(structuredClone(this.current));
			const results: CliUpdateResult[] = [];
			try {
				const adapters = manual ? this.deps.refreshAdapters().catch(() => {}) : Promise.resolve();
				for (const provider of this.deps.settings().providers) {
					const result = await this.update(provider);
					if (result) results.push(result);
				}
				await adapters;
			} finally {
				this.current = { checkedAt: new Date(this.now()).toISOString(), running: false, results };
				await this.save().catch((error) => {
					this.deps.log(
						`cli-updates: the status could not be saved: ${error instanceof Error ? error.message : String(error)}`
					);
				});
				this.deps.changed(structuredClone(this.current));
			}
			return structuredClone(this.current);
		})().finally(() => {
			this.running = null;
		});
		this.running = run;
		return run;
	}
	/** One CLI: version, the CLI's own update, version again. A missing CLI is skipped; a failure stays with its CLI. */
	private async update(provider: Provider): Promise<CliUpdateResult | null> {
		const before = await this.version(provider);
		if (before === undefined) return null;
		const result = await this.deps.run(provider, ['update'], updateTimeout).catch(() => null);
		if (!result || result.code !== 0) {
			this.deps.log(
				`cli-updates: ${provider} update exited with ${result?.code ?? 'no result'}: ${(result?.stderr || result?.stdout || '').trim().slice(-2000)}`
			);
			return { provider, before, after: before, outcome: 'failed' };
		}
		const after = (await this.version(provider)) ?? before;
		return { provider, before, after, outcome: after !== before ? 'updated' : 'current' };
	}
	/** undefined: no CLI at all; null: a CLI whose version could not be read. */
	private async version(provider: Provider): Promise<string | null | undefined> {
		const result = await this.deps.run(provider, ['--version'], versionTimeout).catch(() => null);
		if (result === null) return undefined;
		return result.code === 0 ? versionOf(result.stdout) : null;
	}
	private async save() {
		const store = await SessionStore.at(this.dataDir);
		await mkdir(store.root, { recursive: true, mode: 0o700 });
		await atomicJson(await this.file(), {
			schemaVersion: 1,
			status: { ...this.current, running: false },
		});
	}
}
