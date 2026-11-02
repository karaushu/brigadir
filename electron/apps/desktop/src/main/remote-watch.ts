import { readWorkspace } from '@brigadir/persistence';
import { discoverScopes, fetchRemotes, gitText } from '@brigadir/git';

/**
 * spec/git#pull: the main tree learns what origin has without touching the tree — a quiet `fetch` of every git repo of every
 * project at start, on window focus and every 5 minutes, never more often than once in 5 minutes per repo. A repo whose
 * remote refs moved makes its project's Repo section read again (↓N, ↑N).
 */
export const FETCH_INTERVAL = 5 * 60_000;
export class RemoteWatch {
	private last = new Map<string, number>();
	private running: Promise<void> | null = null;
	private timer: ReturnType<typeof setInterval> | null = null;
	constructor(
		private dataDir: string | undefined,
		private changed: (projectId: string) => void,
		private now: () => number = Date.now,
		private fetch: (path: string) => Promise<void> = fetchRemotes,
		private refs: (path: string) => Promise<string> = (path) =>
			gitText(path, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/remotes']).catch(
				() => ''
			)
	) {}
	/** One pass over the projects; a pass already running is joined, not doubled. */
	check(): Promise<void> {
		return (this.running ??= this.pass().finally(() => {
			this.running = null;
		}));
	}
	start() {
		this.stop();
		void this.check();
		this.timer = setInterval(() => {
			void this.check();
		}, FETCH_INTERVAL);
		this.timer.unref?.();
	}
	stop() {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}
	/** The picker and the sheet fetched it themselves: the throttle counts that too. */
	fetched(path: string) {
		this.last.set(path, this.now());
	}
	private async pass() {
		for (const project of (await readWorkspace(this.dataDir ? { dataDir: this.dataDir } : {}))
			.projects) {
			const scopes = await discoverScopes(project.path).catch(() => []);
			let moved = false;
			for (const scope of scopes) {
				if (scope.kind === 'folder' || scope.kind === 'worktree' || scope.available === false)
					continue;
				if (this.now() - (this.last.get(scope.path) ?? -Infinity) < FETCH_INTERVAL) continue;
				this.last.set(scope.path, this.now());
				const before = await this.refs(scope.path);
				try {
					await this.fetch(scope.path);
				} catch {
					continue;
				}
				if ((await this.refs(scope.path)) !== before) moved = true;
			}
			if (moved) this.changed(project.id);
		}
	}
}
