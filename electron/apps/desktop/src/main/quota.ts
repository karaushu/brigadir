import { atomicJson, readDocument } from '@brigadir/persistence';
import {
	emptyQuota,
	isQuotaReading,
	isQuotaWatch,
	mergeQuota,
	quotaProviders,
	tightestWindow,
	watchQuota,
	type AgentProvider,
	type EventRecord,
	type QuotaObservation,
	type QuotaSnapshot,
	type TaskKey,
} from '@brigadir/core';
import { mkdir } from 'node:fs/promises';
import {
	CodexAccount,
	codexCommand,
	readClaudeUsage,
	type ClaudeUsage,
	type CodexLimits,
} from '@brigadir/transport';

export type QuotaReaders = {
	claude(): Promise<ClaudeUsage | null>;
	codex(): Promise<CodexLimits | null>;
	stop?(): void;
};
type Clock = {
	now(): number;
	setTimeout(run: () => void, ms: number): unknown;
	clearTimeout(timer: unknown): void;
};
const realClock: Clock = {
	now: () => Date.now(),
	setTimeout: (run, ms) => {
		const timer = setTimeout(run, ms);
		timer.unref?.();
		return timer;
	},
	clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};
/** A complete read counts as fresh for a minute: the CLI keeps a 60 s snapshot of `/usage` and the Codex TUI polls once a minute. */
const FRESH_MS = 60_000;
/** Codex counts as active this long after its last turn boundary; polling stops after that. */
const ACTIVE_MS = 10 * 60_000;
/** Silent refresh of both providers while the window is visible: usage outside Brigadir shows up. */
export const QUOTA_BACKGROUND_MS = 10 * 60_000;

/** spec/agents-and-providers#quota-sources: one global store per provider account; quota is never per task.
 *  Turn readings arrive through the journal; complete reads are made here, never per task. */
export class Quota {
	private snapshot = emptyQuota();
	private last = new Map<AgentProvider, number>();
	private work = new Map<AgentProvider, Promise<void>>();
	private providers = new Map<string, Promise<AgentProvider | null>>();
	private codexActiveUntil = 0;
	private codexTimer: unknown = null;
	private stopped = false;
	private backgroundTimer: unknown = null;
	private backgroundDue = false;
	private visible: () => boolean = () => false;
	private clock: Clock;
	private viewFile: string | null;
	private writes: Promise<void> = Promise.resolve();
	private pendingWrites = 0;
	constructor(
		private readers: QuotaReaders,
		private providerOf: (key: TaskKey) => Promise<AgentProvider | null>,
		private publish: (snapshot: QuotaSnapshot) => void,
		options: { clock?: Clock; viewFile?: string } = {}
	) {
		this.clock = options.clock ?? realClock;
		this.viewFile = options.viewFile ?? null;
	}
	get isSaving() {
		return this.pendingWrites > 0;
	}
	waitForWrites() {
		return this.writes;
	}
	/** The eye choice from `<data>/quota-view.json`; a missing or broken file means nothing is chosen. */
	async loadView() {
		if (!this.viewFile) return;
		let document: Record<string, unknown>;
		try {
			document = await readDocument(this.viewFile, 4096);
		} catch {
			return;
		}
		const watch = document.watch;
		if (!watch || typeof watch !== 'object') return;
		for (const provider of quotaProviders) {
			const value = (watch as Record<string, unknown>)[provider];
			if (isQuotaWatch(value)) this.snapshot = watchQuota(this.snapshot, provider, value);
		}
		this.publish(this.snapshot);
	}
	/** The eye in the popover. Works in pinned test mode too: it is a view choice, not a read. */
	watch(provider: AgentProvider, window: string | null): Promise<void> {
		this.snapshot = watchQuota(this.snapshot, provider, window);
		this.publish(this.snapshot);
		if (!this.viewFile) return Promise.resolve();
		const file = this.viewFile,
			value = {
				schemaVersion: 1,
				watch: Object.fromEntries(
					this.snapshot.providers.map((entry) => [entry.provider, entry.watch])
				),
			};
		this.pendingWrites++;
		const write = this.writes
			.then(() => atomicJson(file, value))
			.finally(() => {
				this.pendingWrites--;
			});
		this.writes = write.catch(() => {});
		return write;
	}
	read(): QuotaSnapshot {
		return this.snapshot;
	}
	/** Tests pin a snapshot instead of reaching the network. */
	pin(snapshot: QuotaSnapshot) {
		this.snapshot = snapshot;
		this.stopped = true;
		this.publish(snapshot);
	}
	private apply(observation: QuotaObservation, at: number) {
		this.snapshot = mergeQuota(this.snapshot, observation, at);
		this.publish(this.snapshot);
	}
	observe(key: TaskKey, record: EventRecord) {
		if (this.stopped) return;
		const event = record.event;
		if (event.kind === 'quota.observed') {
			const at = Date.parse(record.at);
			this.apply(
				{ provider: event.provider, windows: event.windows, complete: event.complete },
				Number.isFinite(at) ? at : this.clock.now()
			);
			return;
		}
		if (event.kind !== 'turn.started' && event.kind !== 'turn.completed') return;
		const id = `${key.projectId}/${key.id}`;
		let provider = this.providers.get(id);
		if (!provider) {
			provider = this.providerOf(key).catch(() => null);
			if (this.providers.size > 512) this.providers.clear();
			this.providers.set(id, provider);
		}
		void provider.then((value) => {
			if (value !== 'codex' || this.stopped) return;
			this.codexActiveUntil = this.clock.now() + ACTIVE_MS;
			if (event.kind === 'turn.completed') void this.refresh('codex', 15_000);
			this.schedule();
		});
	}
	/** Single-flight and throttled: a popover opening every second still makes at most one read a minute. */
	refresh(provider: AgentProvider, minAgeMs = FRESH_MS): Promise<void> {
		if (this.stopped) return Promise.resolve();
		const running = this.work.get(provider);
		if (running) return running;
		if (this.clock.now() - (this.last.get(provider) ?? 0) < minAgeMs) {
			if (provider === 'codex') this.schedule();
			return Promise.resolve();
		}
		const work = (async () => {
			const started = this.clock.now();
			try {
				const result =
					provider === 'claude' ? await this.readers.claude() : await this.readers.codex();
				this.last.set(provider, this.clock.now());
				if (!result || this.stopped) return;
				this.apply(
					{
						provider,
						windows: result.windows,
						complete: true,
						access: result.access,
						...(result.plan ? { plan: result.plan } : {}),
					},
					started
				);
			} catch {
				this.last.set(provider, this.clock.now()); /* keep what we had; its age is shown */
			}
		})().finally(() => {
			this.work.delete(provider);
			if (provider === 'codex') this.schedule();
		});
		this.work.set(provider, work);
		return work;
	}
	refreshAll() {
		return Promise.all([this.refresh('claude'), this.refresh('codex')]).then(() => undefined);
	}
	/** Like the Codex TUI: once a minute while Codex works, faster as the tightest window runs out. */
	private schedule() {
		if (this.codexTimer !== null || this.stopped || this.clock.now() >= this.codexActiveUntil)
			return;
		const codex = this.snapshot.providers.find((entry) => entry.provider === 'codex'),
			tight = codex ? tightestWindow(codex, this.clock.now()) : null;
		const left = tight ? (tight.exhausted ? 0 : tight.remaining) : 1,
			interval = left < 0.01 ? 5_000 : left < 0.1 ? 15_000 : left < 0.25 ? 30_000 : 60_000;
		this.codexTimer = this.clock.setTimeout(() => {
			this.codexTimer = null;
			void this.refresh('codex', interval - 1_000);
		}, interval);
	}
	/** Every ten minutes while the window is visible; a tick that finds it hidden waits for `shown()`. */
	background(visible: () => boolean, interval = QUOTA_BACKGROUND_MS) {
		this.visible = visible;
		const tick = () => {
			this.backgroundTimer = this.clock.setTimeout(tick, interval);
			if (this.stopped) return;
			if (this.visible()) {
				this.backgroundDue = false;
				void this.refreshAll();
			} else this.backgroundDue = true;
		};
		if (this.backgroundTimer === null && !this.stopped)
			this.backgroundTimer = this.clock.setTimeout(tick, interval);
	}
	/** The window became visible again: catch up a tick it missed. */
	shown() {
		if (this.backgroundDue && !this.stopped && this.visible()) {
			this.backgroundDue = false;
			void this.refreshAll();
		}
	}
	close() {
		this.stopped = true;
		for (const timer of [this.codexTimer, this.backgroundTimer])
			if (timer !== null) this.clock.clearTimeout(timer);
		this.codexTimer = null;
		this.backgroundTimer = null;
		this.readers.stop?.();
	}
}

/** Real readers. `claude -p /usage` runs in its own folder and writes no transcript (spec/agents-and-providers#quota-sources);
 *  the Codex process lives while it is read and stops after five idle minutes. */
export function providerReaders(usageDir: string): QuotaReaders {
	let account: CodexAccount | null = null,
		idle: ReturnType<typeof setTimeout> | null = null;
	const stop = () => {
		if (idle) clearTimeout(idle);
		idle = null;
		account?.close();
		account = null;
	};
	return {
		claude: async () => {
			await mkdir(usageDir, { recursive: true, mode: 0o700 });
			return readClaudeUsage({ cwd: usageDir, timeoutMs: 30_000 });
		},
		codex: async () => {
			const command = codexCommand();
			if (!command) return null;
			if (idle) clearTimeout(idle);
			idle = null;
			try {
				if (!account || account.closed) account = await CodexAccount.start({ command });
				return await account.readLimits();
			} catch (error) {
				stop();
				throw error;
			} finally {
				if (account) {
					idle = setTimeout(stop, 5 * 60_000);
					idle.unref?.();
				}
			}
		},
		stop,
	};
}

/** `BRIGADIR_TEST_QUOTA`: a fixed snapshot for UI tests. Anything malformed is dropped, never half-applied. */
export function testQuota(text: string): QuotaSnapshot {
	const snapshot = emptyQuota();
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return snapshot;
	}
	const providers =
		value &&
		typeof value === 'object' &&
		Array.isArray((value as { providers?: unknown }).providers)
			? (value as { providers: unknown[] }).providers
			: [];
	for (const item of providers) {
		if (!item || typeof item !== 'object') continue;
		const entry = item as Record<string, unknown>;
		if (!quotaProviders.includes(entry.provider as AgentProvider) || !Array.isArray(entry.windows))
			continue;
		const windows = entry.windows.filter(
			(window) =>
				isQuotaReading(window) &&
				typeof (window as { observedAt?: unknown }).observedAt === 'number'
		) as QuotaSnapshot['providers'][number]['windows'];
		const target = snapshot.providers.find((provider) => provider.provider === entry.provider)!;
		target.windows = windows;
		target.watch = isQuotaWatch(entry.watch) ? entry.watch : null;
		target.plan = typeof entry.plan === 'string' ? entry.plan.slice(0, 40) : null;
		target.access =
			entry.access === 'api-key' || entry.access === 'subscription' ? entry.access : 'unknown';
	}
	return snapshot;
}
