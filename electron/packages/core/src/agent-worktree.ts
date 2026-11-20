import type { EventRecord } from './session';
/**
 * spec/tasks#agent-worktrees: the turns of a task as time windows, for telling the agent's own worktree from one made by someone else. An
 * open turn runs until now.
 */
export type TurnWindow = { start: number; end: number | null; tools: string[] };
export function turnWindows(records: readonly EventRecord[]): TurnWindow[] {
	const windows: TurnWindow[] = [];
	let open: TurnWindow | null = null,
		last = 0;
	for (const { at, event } of records) {
		const time = Date.parse(at);
		if (!Number.isFinite(time)) continue;
		if (event.kind === 'turn.started') {
			if (open) open.end = last;
			open = { start: time, end: null, tools: [] };
			windows.push(open);
		} else if (open && (event.kind === 'turn.completed' || event.kind === 'session.failed')) {
			open.end = time;
			open = null;
		} else if (open && event.kind === 'host.stopped') {
			// A host that went down mid-turn journals its stop when it starts again: the turn ended with its last record, not with the
			// downtime (a worktree made while Brigadir was down is nobody's turn).
			open.end = last;
			open = null;
		} else if (open && event.kind === 'tool.changed') {
			const { title, input } = event.patch;
			for (const text of [title, input]) if (typeof text === 'string') open.tools.push(text);
		}
		last = time;
	}
	return windows;
}
export type WorktreeVerdict = 'join' | 'ask' | 'ignore';
/**
 * spec/tasks#agent-worktrees: what the host does with a worktree it sees for the first time. Brigadir's own (a task's, a worker's, a
 * reviewer's), one inside the project folder (discovery owns those), one another task holds, and one made outside this task's turns are left
 * alone. One made inside a turn joins when that turn ran a tool naming `worktree`, its path or its branch; otherwise the host cannot tell and asks.
 */
export function worktreeVerdict(input: {
	path: string;
	branch: string | null;
	createdAt: number | null;
	/** How exact `createdAt` is (ms): it lies in `[createdAt, createdAt + precision)`. */
	precision?: number;
	turns: readonly TurnWindow[];
	brigadir: boolean;
	insideProject: boolean;
	otherTask: boolean;
	now?: number;
}): WorktreeVerdict {
	if (input.brigadir || input.insideProject || input.otherTask) return 'ignore';
	if (input.createdAt === null) return 'ask';
	const now = input.now ?? Date.now(),
		from = input.createdAt,
		to = from + Math.max(1, input.precision ?? 1);
	// Surely inside a turn, or only maybe (the clock's rounding reaches past its edge): a maybe is asked.
	const inside = input.turns.find(
		(window) => from >= window.start && to <= (window.end ?? now) + 1
	);
	if (!inside)
		return input.turns.some((window) => to > window.start && from <= (window.end ?? now))
			? 'ask'
			: 'ignore';
	const turn = inside;
	const folder = input.path.split('/').filter(Boolean).at(-1) ?? '';
	const named = turn.tools.some(
		(text) =>
			/worktree/i.test(text) ||
			text.includes(input.path) ||
			(folder.length > 2 && text.includes(folder)) ||
			(!!input.branch && text.includes(input.branch))
	);
	return named ? 'join' : 'ask';
}
/** spec/tasks#agent-worktrees: the host's own card for a worktree it cannot place; its title reads in the person's language. */
export const worktreeCard = {
	tool: 'worktree_join',
	title: 'Add worktree {name} to the task',
} as const;
/** The card's English title (journal) for `name · branch`. */
export function worktreeCardTitle(name: string, branch: string | null) {
	return worktreeCard.title.replace('{name}', branch ? `${name} · ${branch}` : name);
}
/** What `{name}` held in a card's English title, so the window can say it in the person's language; null — not this card. */
export function worktreeCardName(tool: { name?: string | undefined; title?: string | undefined }) {
	if (tool.name !== worktreeCard.tool || !tool.title) return null;
	return /^Add worktree (.+) to the task$/.exec(tool.title)?.[1] ?? null;
}
