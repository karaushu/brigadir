import type { AgentTask, TaskStatus } from './workspace';
/** spec/projects-and-board#board revision: three columns in work order; the same grouping serves the list. */
export const boardColumns = ['backlog', 'progress', 'completed'] as const;
export type BoardColumn = (typeof boardColumns)[number];
export type ProjectView = 'board' | 'list';
export const isProjectView = (value: unknown): value is ProjectView =>
	value === 'board' || value === 'list';
export function boardColumn(status: TaskStatus): BoardColumn {
	return status === 'backlog' ? 'backlog' : status === 'completed' ? 'completed' : 'progress';
}
/** Attention inside In progress: needs-you first, then the freshest activity (spec/projects-and-board#board). */
const attention: Record<TaskStatus, number> = {
	'needs-you': 0,
	working: 1,
	preparing: 1,
	queued: 2,
	'rate-limited': 3,
	failed: 3,
	interrupted: 4,
	done: 5,
	backlog: 6,
	completed: 7,
};
function byActivity(a: AgentTask, b: AgentTask) {
	return (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || a.title.localeCompare(b.title);
}
/** `waiting`: a task that carries needs-you it does not hold itself, a foreman whose worker waits (spec/crew#attention); it sorts with needs-you. */
export function boardSections(
	tasks: readonly AgentTask[],
	waiting: (task: AgentTask) => boolean = () => false
): Record<BoardColumn, AgentTask[]> {
	const sections: Record<BoardColumn, AgentTask[]> = { backlog: [], progress: [], completed: [] };
	for (const task of tasks) sections[boardColumn(task.status)].push(task);
	sections.backlog.sort(byActivity);
	sections.completed.sort(byActivity);
	const rank = (task: AgentTask) =>
		waiting(task) ? attention['needs-you'] : attention[task.status];
	sections.progress.sort((a, b) => rank(a) - rank(b) || byActivity(a, b));
	return sections;
}
/** Every allowed drop is an existing action (spec/projects-and-board#board); everything else is refused visibly. */
export type BoardMove = 'start' | 'await-input' | 'stop-complete' | 'stop-backlog';
export function boardMove(from: BoardColumn, to: BoardColumn): BoardMove | null {
	if (from === to) return null;
	if (from === 'backlog' && to === 'progress') return 'start';
	if (from === 'completed' && to === 'progress') return 'await-input';
	if (from === 'progress' && to === 'completed') return 'stop-complete';
	if (from === 'progress' && to === 'backlog') return 'stop-backlog';
	return null;
}
export const isBoardColumn = (value: unknown): value is BoardColumn =>
	boardColumns.includes(value as BoardColumn);
/** FNV-1a over the id gives a wanted slot; the layout over all open projects resolves collisions by probing (spec/projects-and-board#board). */
export const projectColorCount = 9;
function fnv1a(text: string) {
	let hash = 0x811c9dc5;
	for (let index = 0; index < text.length; index++) {
		hash ^= text.charCodeAt(index) & 0xff;
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash;
}
export function projectColors(ids: readonly string[]): Map<string, number> {
	const taken = new Set<number>(),
		colors = new Map<string, number>();
	for (const id of [...ids].sort()) {
		let slot = fnv1a(id) % projectColorCount;
		if (taken.size < projectColorCount) {
			while (taken.has(slot)) slot = (slot + 1) % projectColorCount;
		}
		taken.add(slot);
		colors.set(id, slot);
	}
	return colors;
}
/** Description is the start of the prompt; the title is already derived from the same text (spec/projects-and-board#board). */
export function taskDescription(task: AgentTask): string {
	const prompt = (task.prompt ?? '').trim();
	return prompt && prompt !== task.title ? prompt : '';
}
