import { inTask } from './scope-select';
import { isId, isRecord, type AgentTask } from './workspace';
import { baseTree, type SnapshotDocument } from './changes';
export type SidebarFilter = 'needs-you' | 'running' | 'unreviewed' | null;
export function sidebarMatches(task: AgentTask, filter: SidebarFilter) {
	return (
		filter === null ||
		(filter === 'needs-you' && task.status === 'needs-you') ||
		(filter === 'running' && ['working', 'preparing'].includes(task.status)) ||
		(filter === 'unreviewed' && task.hasUnreviewedChanges === true)
	);
}
/** The first appearance of each scope is its baseline; newly discovered scopes do not create a false delta. */
/** spec/crew#parts: `from` is the task's change base (a crew part's start). */
export function snapshotHasChanges(document: SnapshotDocument | null, from = 0) {
	if (!document) return false;
	const latest = document.checkpoints.at(-1);
	if (!latest) return false;
	return document.scopes
		.filter((scope) => inTask(scope) && (scope.available !== false || !!scope.source))
		.some((scope) => {
			const baseline = baseTree(document, scope.id, from),
				current = latest.trees.find((tree) => tree.scopeId === scope.id);
			return !!baseline && !!current && baseline.tree !== current.tree;
		});
}

/** Stable per-project priority; filtering does not change the underlying order. */
/**
 * The person's own tasks: crew workers live inside their foreman (spec/crew#task-type, spec/projects-and-board#project-screen, spec/projects-and-board#board);
 * a worker whose foreman is gone is an ordinary task (spec/tasks#delete-task). One predicate for the sidebar, the board and the list (spec/projects-and-board#person-tasks).
 */
/** spec/tasks#archive: archived tasks are not the person's live tasks; the archive section and window list them (`archivedTasks`). */
/** spec/notifications-slack-notes-and-schedules#schedules: a quiet scheduled run is not listed unless `quietRuns` — the filter's «Quiet scheduled runs». */
export function personTasks<T extends AgentTask>(tasks: readonly T[], quietRuns = false): T[] {
	const foremen = new Set(
		tasks.filter((task) => task.crew).map((task) => `${task.projectId}/${task.id}`)
	);
	return tasks.filter(
		(task) =>
			!task.archived &&
			(quietRuns || !task.scheduleRun?.quiet) &&
			(!task.crewTaskId || !foremen.has(`${task.projectId}/${task.crewTaskId}`))
	);
}
/** Every worker of a foreman's crew, leads and their workers included (they all carry the root's `crewTaskId`, spec/crew#subordinates). */
export function crewWorkers(foreman: AgentTask, tasks: readonly AgentTask[]): AgentTask[] {
	return foreman.crew
		? tasks.filter((task) => task.projectId === foreman.projectId && task.crewTaskId === foreman.id)
		: [];
}
/** spec/crew#attention: a worker of this crew waits for the person (permission, or a question after escalation); the foreman carries the attention. */
export function crewNeedsYou(foreman: AgentTask, tasks: readonly AgentTask[]): boolean {
	return crewWorkers(foreman, tasks).some((task) => task.status === 'needs-you');
}
/** Workers that hold an agent right now: the number beside the helmet on a board card (spec/projects-and-board#board). */
export function liveCrewWorkers(foreman: AgentTask, tasks: readonly AgentTask[]): number {
	return crewWorkers(foreman, tasks).filter((task) =>
		['working', 'needs-you', 'preparing'].includes(task.status)
	).length;
}
/** Workers live inside their foreman's card (spec/crew#task-type); a worker whose foreman is gone is an ordinary task (spec/tasks#delete-task). */
/** spec/sidebar#done-rows: tasks not completed first (pinned, needs you, working, unreviewed, recency), then the completed: pinned first, newest `completedAt` on top. */
export function sidebarTasks(tasks: readonly AgentTask[], quietRuns = false) {
	const priority = (task: AgentTask) =>
			task.status === 'needs-you'
				? 0
				: ['working', 'preparing'].includes(task.status)
					? 1
					: task.hasUnreviewedChanges
						? 2
						: 3,
		finished = (task: AgentTask) => task.status === 'completed',
		closed = (task: AgentTask) => task.completedAt ?? task.updatedAt ?? '';
	return personTasks(tasks, quietRuns).sort(
		(a, b) =>
			Number(finished(a)) - Number(finished(b)) ||
			Number(!!b.pinned) - Number(!!a.pinned) ||
			(finished(a)
				? closed(b).localeCompare(closed(a))
				: priority(a) - priority(b) || (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')) ||
			a.id.localeCompare(b.id)
	);
}

/** spec/tasks#delete-task: the tasks deleting `root` deletes with it — its crew workers and every task under it by `parentTaskId`. */
export function taskDescendants(
	root: { projectId: string; id: string },
	tasks: readonly AgentTask[]
): AgentTask[] {
	const own = tasks.filter((task) => task.projectId === root.projectId),
		found: AgentTask[] = [],
		seen = new Set([root.id]);
	for (let parents = [root.id]; parents.length;) {
		const next = own.filter(
			(task) =>
				!seen.has(task.id) &&
				(parents.includes(task.parentTaskId ?? '') || parents.includes(task.crewTaskId ?? ''))
		);
		for (const task of next) {
			seen.add(task.id);
			found.push(task);
		}
		parents = next.map((task) => task.id);
	}
	return found;
}

export type CrewWorkerRow = {
	task: AgentTask;
	name: string;
	depth: number;
	provider: AgentTask['provider'];
	role: CrewSpecAgent['role'];
};
/** Worker rows of a foreman card in tree order with the agent name as prefix and lead depth (spec/crew-templates-and-editor#after-launch, spec/crew#subordinates). */
export function crewWorkerRows(foreman: AgentTask, tasks: readonly AgentTask[]): CrewWorkerRow[] {
	const spec = foreman.crew;
	if (!spec) return [];
	const workers = tasks.filter((task) => task.crewTaskId === foreman.id);
	const rows: CrewWorkerRow[] = [];
	const visit = (agent: CrewSpecAgent, depth: number) => {
		for (const child of agent.agents) {
			for (const task of workers
				.filter((task) => task.crewNodeId === child.id)
				.sort((a, b) => (a.updatedAt ?? '').localeCompare(b.updatedAt ?? '')))
				rows.push({
					task,
					name: child.name,
					depth,
					provider: task.provider ?? child.provider,
					role: child.role,
				});
			visit(child, depth + 1);
		}
	};
	visit(spec.root, 0);
	for (const task of workers.filter((task) => !rows.some((row) => row.task.id === task.id)))
		rows.push({
			task,
			name: findSpecAgent(spec.root, task.crewNodeId ?? '')?.name ?? task.title,
			depth: 0,
			provider: task.provider,
			role: findSpecAgent(spec.root, task.crewNodeId ?? '')?.role ?? 'developer',
		});
	return rows;
}
/** Sidebar label of a worker anywhere else: `<agent> · <part>` (spec/crew-templates-and-editor#after-launch). */
export function crewTaskLabel(task: AgentTask, tasks: readonly AgentTask[]): string {
	if (!task.crewTaskId || !task.crewNodeId) return task.title;
	const foreman = tasks.find(
		(item) => item.id === task.crewTaskId && item.projectId === task.projectId
	);
	const name = foreman?.crew ? findSpecAgent(foreman.crew.root, task.crewNodeId)?.name : undefined;
	return name ? `${name} · ${task.title}` : task.title;
}
import { findSpecAgent, type CrewSpecAgent } from './crew';
/** spec/sidebar#open-last: what was open when the app last ran — a project (or `*`, All projects) and, inside it, a task. */
export type SidebarSelection = { project: string; task?: string };
export const isSidebarSelection = (value: unknown): value is SidebarSelection =>
	isRecord(value) &&
	(value.project === '*' || isId(value.project)) &&
	(value.task === undefined || (isId(value.task) && value.project !== '*')) &&
	Object.keys(value).every((key) => key === 'project' || key === 'task');
