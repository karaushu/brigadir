import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultDataDir } from '@brigadir/persistence';
import {
	ghostHeadlessPolicy,
	ghostQuotaBlocked,
	ghostSuggestion,
	ghostTail,
	ghostTurn,
	ghostPrompt,
	ghostLine,
	ghostDefaultModel,
	ghostDefaultProvider,
	type TaskKey,
	type EventRecord,
	type SessionSnapshot,
	type AgentEvent,
	type AgentProviderId,
	type GhostTarget,
} from '@brigadir/core';
import { oneShotText } from '@brigadir/transport';
type Context = {
	enabled: boolean;
	visible: boolean;
	composerEmpty: boolean;
	reviewPending: number;
};
type Limit = Extract<AgentEvent, { kind: 'rate-limit.changed' }>;
type Dependencies = {
	read(key: TaskKey): Promise<SessionSnapshot>;
	context(key: TaskKey): Promise<Context>;
	/** spec/composer-steering-queue-and-ghost#ghost-headless: the provider and model of the hint, resolved from Settings and the catalogs; null — no hint at all. */
	target?(signal: AbortSignal): Promise<GhostTarget | null>;
	/** spec/composer-steering-queue-and-ghost#ghost-headless: whether the provider's account quota is exhausted now (Codex: the app-server reading, spec/agents-and-providers#quota-sources). */
	exhausted?(provider: AgentProviderId): boolean;
	write?(
		prompt: string,
		signal: AbortSignal,
		onLimit: (event: Limit) => void,
		target: GhostTarget
	): Promise<string>;
};
const name = (key: TaskKey) => `${key.projectId}/${key.id}`;
const defaultTarget: GhostTarget = {
	provider: ghostDefaultProvider,
	model: null,
	preferredModel: ghostDefaultModel,
	name: null,
	effort: null,
};
/** At most one paid attempt per displayed completed turn, including failures/cancellation. */
export class Ghosts {
	/** Claude's `rate-limit.changed` from tasks and hint calls; only Claude's adapter sends them (spec/composer-steering-queue-and-ghost#ghost-headless). */
	private limits = new Map<string, Limit>();
	private requests = new Map<
		string,
		{ key: TaskKey; controller: AbortController; provider: AgentProviderId | null }
	>();
	private results = new Map<string, string | null>();
	constructor(private dependencies: Dependencies) {}
	cancel(key: TaskKey, id: string) {
		const entry = this.requests.get(id);
		if (entry && name(entry.key) === name(key)) entry.controller.abort();
	}
	cancelAll() {
		for (const entry of this.requests.values()) entry.controller.abort();
	}
	private onLimit = (event: Limit) => {
		this.limits.set(event.window ?? 'unknown', event);
		if (this.claudeBlocked())
			for (const entry of this.requests.values())
				if (entry.provider !== 'codex') entry.controller.abort();
	};
	private claudeBlocked() {
		return ghostQuotaBlocked(
			[...this.limits.values()].map((event, index) => ({
				schemaVersion: 1 as const,
				seq: index,
				at: '',
				event,
			}))
		);
	}
	/** A warning of one provider never stops a hint the other one writes. */
	private quotaBlocked(provider: AgentProviderId, records: readonly EventRecord[]) {
		return provider === 'claude'
			? this.claudeBlocked() || ghostQuotaBlocked(records)
			: (this.dependencies.exhausted?.(provider) ?? false);
	}
	observe(key: TaskKey, record: EventRecord) {
		if (record.event.kind === 'rate-limit.changed') this.onLimit(record.event);
		if (
			[
				'turn.started',
				'host.stopped',
				'session.failed',
				'permission.requested',
				'question.requested',
				'task.proposal.requested',
				'crew.plan.requested',
				'prompt.queued',
			].includes(record.event.kind)
		)
			for (const entry of this.requests.values())
				if (name(entry.key) === name(key)) entry.controller.abort();
	}
	private async state(key: TaskKey, turn: number, provider: AgentProviderId) {
		const [snapshot, context] = await Promise.all([
			this.dependencies.read(key),
			this.dependencies.context(key),
		]);
		return {
			snapshot,
			reason:
				!snapshot.connected || ghostTurn(snapshot.records) !== turn
					? 'not-complete'
					: ghostHeadlessPolicy({
							...context,
							dismissed: false,
							heuristicFound: Boolean(
								ghostSuggestion(snapshot.records, context.reviewPending, 'en')
							),
							records: snapshot.records,
							quotaBlocked: this.quotaBlocked(provider, snapshot.records),
						}),
		};
	}
	async request(key: TaskKey, turn: number, id: string): Promise<string | null> {
		if (this.requests.has(id)) return null;
		const controller = new AbortController(),
			entry = { key, controller, provider: null as AgentProviderId | null };
		this.requests.set(id, entry);
		try {
			const target = this.dependencies.target
				? await this.dependencies.target(controller.signal)
				: defaultTarget;
			if (!target || controller.signal.aborted) return null;
			entry.provider = target.provider;
			const state = await this.state(key, turn, target.provider);
			if (controller.signal.aborted || state.reason !== 'allowed') return null;
			const cache = `${name(key)}/${turn}`;
			if (this.results.has(cache)) return this.results.get(cache) ?? null;
			this.results.set(cache, null);
			while (this.results.size > 128) this.results.delete(this.results.keys().next().value!);
			const prompt = ghostPrompt(ghostTail(state.snapshot.records)),
				text = ghostLine(
					await (this.dependencies.write ?? writeGhost)(
						prompt,
						controller.signal,
						this.onLimit,
						target
					)
				);
			if (
				controller.signal.aborted ||
				(await this.state(key, turn, target.provider)).reason !== 'allowed'
			)
				return null;
			this.results.set(cache, text || null);
			return text || null;
		} catch {
			return null;
		} finally {
			this.requests.delete(id);
		}
	}
}
/** spec/composer-steering-queue-and-ghost#ghost-headless: one stable folder for every hint call, so the provider's transcripts of these calls land in one place
 *  (`~/.claude/projects`, `~/.codex/sessions`), as `/usage` does (spec/agents-and-providers#quota-sources). Nothing is ever written into it by us. */
export function ghostDirectory() {
	return join(process.env.BRIGADIR_DATA_DIR ?? defaultDataDir(), 'ghost');
}
/** spec/git#agent-branch-names: the branch name is a one-shot of the hint model too, in the same folder; tests answer with the agent fixture. */
export function writeBranchWords(prompt: string, signal: AbortSignal, target: GhostTarget) {
	return writeHintOneShot(prompt, signal, target, 120);
}
/** spec/git#agent-branch-names, spec/appearance#evolution-redesign, spec/git#commit-dialog: a one-shot of the hint model (branch name, project icon, commit split) in the hint folder. */
export async function writeHintOneShot(
	prompt: string,
	signal: AbortSignal,
	target: GhostTarget,
	characterLimit: number,
	/** spec/git#commit-dialog: the commit split reads a whole diff, so it waits longer than a name. */ timeoutMs = 15000,
	/** spec/composer-steering-queue-and-ghost#ghost-headless: background conveniences stop at the quota warning; a text the person asked for runs until the window is spent (spec/appearance#evolution-redesign). */ stopAtRateWarning = true,
	/** Tests: an adapter fixture of this caller; the agent fixture by default. */ options: {
		fixture?: string | undefined;
	} = {}
) {
	const cwd = ghostDirectory();
	await mkdir(cwd, { recursive: true, mode: 0o700 });
	const fixture = options.fixture ?? process.env.BRIGADIR_TEST_AGENT;
	return oneShotText({
		cwd,
		prompt,
		signal,
		provider: target.provider,
		timeoutMs,
		characterLimit,
		...(target.model
			? { model: target.model }
			: target.preferredModel
				? { preferredModel: target.preferredModel }
				: {}),
		lowestEffort: true,
		...(target.effort ? { effort: target.effort } : {}),
		stopAtRateWarning,
		...(fixture
			? {
					adapter: {
						command: '/usr/bin/env',
						args: ['ELECTRON_RUN_AS_NODE=1', process.execPath, fixture],
					},
				}
			: {}),
	});
}
async function writeGhost(
	prompt: string,
	signal: AbortSignal,
	onLimit: (event: Limit) => void,
	target: GhostTarget
) {
	const cwd = ghostDirectory();
	await mkdir(cwd, { recursive: true, mode: 0o700 });
	return oneShotText({
		cwd,
		prompt,
		signal,
		provider: target.provider,
		timeoutMs: 15000,
		characterLimit: 400,
		...(target.model
			? { model: target.model }
			: target.preferredModel
				? { preferredModel: target.preferredModel }
				: {}),
		lowestEffort: true,
		...(target.effort ? { effort: target.effort } : {}),
		stopAtRateWarning: true,
		onRateLimit: onLimit,
		...(process.env.BRIGADIR_TEST_GHOST
			? {
					adapter: {
						command: '/usr/bin/env',
						args: ['ELECTRON_RUN_AS_NODE=1', process.execPath, process.env.BRIGADIR_TEST_GHOST],
					},
				}
			: {}),
	});
}
