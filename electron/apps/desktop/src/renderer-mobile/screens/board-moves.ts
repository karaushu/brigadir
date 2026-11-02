/**
 * spec/remote-access-and-mobile#phone-pr-list: the phone's board without a window — the columns (`boardSections`, the computer's order), what a card held
 * over a column would do (`boardMove`, the computer's rules) in words, and which drops ask first because they stop an agent.
 */
import {
	boardColumn,
	boardMove,
	type AgentTask,
	type BoardColumn,
	type BoardMove,
	type MessageKey,
	type ProjectView,
} from '@brigadir/core';

export const columnLabels: Record<BoardColumn, MessageKey> = {
	backlog: 'Backlog',
	progress: 'In progress',
	completed: 'Completed',
};
const moveHints: Record<BoardMove, MessageKey> = {
	start: 'Release — the agent starts',
	'await-input': 'Release — back to work',
	'stop-complete': 'Release to complete the task',
	'stop-backlog': 'Release — back to the backlog',
};
/** The agent has a turn to stop: working, or waiting for the person inside its turn. */
export const agentBusy = (task: Pick<AgentTask, 'status'>) =>
	task.status === 'working' || task.status === 'needs-you';
export type MoveVerdict =
	| { move: null; column: BoardColumn; hint: MessageKey | null }
	| { move: BoardMove; column: BoardColumn; hint: MessageKey; confirm: boolean };
/**
 * A card over `to`: its own column says nothing; an allowed move says what a release does and whether it asks first (the agent
 * stops, spec/remote-access-and-mobile#phone-pr-list); a refused one says where the card may go instead.
 */
export function moveVerdict(task: Pick<AgentTask, 'status'>, to: BoardColumn): MoveVerdict {
	const from = boardColumn(task.status),
		move = boardMove(from, to);
	if (from === to) return { move: null, column: to, hint: null };
	if (!move)
		return {
			move: null,
			column: to,
			hint:
				from === 'backlog'
					? 'From the backlog only to “In progress”'
					: 'From completed only to “In progress”',
		};
	return {
		move,
		column: to,
		hint: moveHints[move],
		confirm: (move === 'stop-complete' || move === 'stop-backlog') && agentBusy(task),
	};
}
/** This phone's list or board for each project (spec/remote-access-and-mobile#phone-pr-list): its own choice, never the machine's settings. */
const viewsKey = 'brigadir.project-views';
export function readProjectView(projectId: string): ProjectView {
	try {
		const views = JSON.parse(localStorage.getItem(viewsKey) ?? '{}') as Record<string, unknown>;
		return views[projectId] === 'board' ? 'board' : 'list';
	} catch {
		return 'list';
	}
}
export function saveProjectView(projectId: string, view: ProjectView) {
	try {
		const views = JSON.parse(localStorage.getItem(viewsKey) ?? '{}') as Record<string, unknown>;
		if (view === 'list') delete views[projectId];
		else views[projectId] = view;
		localStorage.setItem(viewsKey, JSON.stringify(views));
	} catch {
		// Storage blocked (a private window): the choice lasts until the page closes.
	}
}
