import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJson } from '@brigadir/persistence';
import {
	ciLive,
	isCIWatch,
	isRecord,
	t,
	type CIRunDetail,
	type CIWatch,
	type CIFinished,
	type Locale,
} from '@brigadir/core';
import type { NoticeGateway } from './notifications';
export { isCIWatch };

/**
 * spec/pull-requests-and-ci#ci-bell: the bell on a run. Watches live in main and on disk: a closed panel, another task or a
 * restart does not lose them. While any exist, every run is re-read each 15 s; a finished one gives an OS notification and
 * a toast event, and its watch is dropped. One older than a day, or a run GitHub no longer returns, is dropped silently.
 */
export const ciWatchPollMs = 15_000;
const maxWatches = 20,
	maxAgeMs = 24 * 3_600_000;
const watchKey = (watch: Pick<CIWatch, 'projectId' | 'scopeId' | 'runId'>) =>
	`${watch.projectId}\0${watch.scopeId}\0${watch.runId}`;
export type CIWatchDeps = {
	dataDir: string | undefined;
	read(watch: CIWatch): Promise<CIRunDetail>;
	gateway: NoticeGateway;
	allowed(): Promise<boolean>;
	locale(): Locale;
	/** The watches changed: the renderer redraws its bells. */
	changed(watches: CIWatch[]): void;
	/** A run ended: the renderer shows its toast. */
	/** `detail` — the run as it ended, for Slack's environment and error line (spec/notifications-slack-notes-and-schedules#slack). */
	finished(event: CIFinished, detail: CIRunDetail): void;
	/** A click on the OS notification: the task and the run page. */
	open(event: CIFinished): void;
	now?(): number;
	/** Test builds poll faster than every 15 s. */
	pollMs?: number | undefined;
};
/** «Staging Pipeline #1068 passed»; the second line is the deploy or the commit/PR title. */
export function finishedText(locale: Locale, detail: CIRunDetail) {
	const run = detail.run,
		state =
			run.state === 'pass'
				? 'pass'
				: run.state === 'cancelled' || run.state === 'skipped'
					? 'cancelled'
					: 'fail';
	const title = t(
		locale,
		state === 'pass' ? '{run} passed' : state === 'cancelled' ? '{run} cancelled' : '{run} failed'
	).replace('{run}', `${run.workflow} #${run.number}`);
	const deploy = detail.deploy,
		body = deploy
			? t(
					locale,
					deploy.state === 'pass'
						? 'Deployed to {env}'
						: deploy.state === 'fail'
							? 'Deploy to {env} failed'
							: 'Deploying to {env}'
				).replace('{env}', deploy.environment)
			: run.title;
	return { state, title, body } as const;
}
export class CIWatches {
	private watches = new Map<string, CIWatch>();
	private timer: ReturnType<typeof setInterval> | null = null;
	private loaded: Promise<void>;
	private polling = false;
	constructor(private deps: CIWatchDeps) {
		this.loaded = this.load();
	}
	private get file() {
		return this.deps.dataDir ? join(this.deps.dataDir, 'ci-watch.json') : null;
	}
	private now() {
		return this.deps.now?.() ?? Date.now();
	}
	private async load() {
		const file = this.file;
		if (!file) return;
		try {
			const value: unknown = JSON.parse(await readFile(file, 'utf8'));
			const list =
				isRecord(value) && Array.isArray(value.watches) ? value.watches.filter(isCIWatch) : [];
			for (const watch of list.slice(0, maxWatches)) this.watches.set(watchKey(watch), watch);
		} catch {
			/* no file yet */
		}
		this.schedule();
	}
	private async save() {
		const file = this.file;
		if (file)
			await atomicJson(file, { schemaVersion: 1, watches: [...this.watches.values()] }).catch(
				() => {}
			);
	}
	async list(): Promise<CIWatch[]> {
		await this.loaded;
		return [...this.watches.values()];
	}
	/** The bell: `on` watches the run, otherwise stops watching. */
	async toggle(watch: CIWatch, on: boolean): Promise<CIWatch[]> {
		await this.loaded;
		const key = watchKey(watch);
		if (on) {
			if (!this.watches.has(key) && this.watches.size >= maxWatches) {
				const oldest = [...this.watches.entries()].sort(
					(a, b) => (a[1].since ?? 0) - (b[1].since ?? 0)
				)[0];
				if (oldest) this.watches.delete(oldest[0]);
			}
			this.watches.set(key, { ...watch, since: this.now() });
		} else this.watches.delete(key);
		await this.changed();
		return this.list();
	}
	private async changed() {
		await this.save();
		this.deps.changed([...this.watches.values()]);
		this.schedule();
	}
	private schedule() {
		if (this.watches.size && !this.timer) {
			this.timer = setInterval(() => void this.poll(), this.deps.pollMs ?? ciWatchPollMs);
			this.timer.unref?.();
		} else if (!this.watches.size && this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}
	/** One pass over all watches; tests call it without the timer. */
	async poll(): Promise<void> {
		await this.loaded;
		if (this.polling) return;
		this.polling = true;
		let dirty = false;
		try {
			for (const [key, watch] of [...this.watches]) {
				if (this.now() - (watch.since ?? this.now()) > maxAgeMs) {
					this.watches.delete(key);
					dirty = true;
					continue;
				}
				let detail: CIRunDetail;
				try {
					detail = await this.deps.read(watch);
				} catch (error) {
					// GitHub no longer returns the run (deleted, repo without access): drop it silently; a network error retries next time.
					if (error instanceof Error && /\b(404|Not Found|unavailable)\b/i.test(error.message)) {
						this.watches.delete(key);
						dirty = true;
					}
					continue;
				}
				if (ciLive(detail.run.state) || detail.deploy?.state === 'running') continue;
				this.watches.delete(key);
				dirty = true;
				await this.notify(watch, detail);
			}
		} finally {
			this.polling = false;
			if (dirty) await this.changed();
		}
	}
	private async notify(watch: CIWatch, detail: CIRunDetail) {
		const locale = this.deps.locale(),
			text = finishedText(locale, detail);
		const event: CIFinished = {
			watch,
			run: detail.run,
			state: text.state,
			title: text.title,
			body: text.body,
		};
		this.deps.finished(event, detail);
		if (!this.deps.gateway.supported() || !(await this.deps.allowed().catch(() => false))) return;
		const groupId = `ci:${watch.projectId}:${watch.scopeId}`;
		this.deps.gateway.show(
			{
				id: `ci:${watch.projectId}:${watch.scopeId}:${watch.runId}`,
				groupId,
				kind: text.state === 'pass' ? 'turn-ended' : 'failed',
				key: { projectId: watch.projectId, id: watch.taskId ?? '' },
				title: text.title,
				body: text.body,
				actions: { allow: null, deny: null },
			},
			{ open: () => this.deps.open(event), allow: () => {}, deny: () => {} }
		);
	}
	dispose() {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}
}
