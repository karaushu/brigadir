import { test, expect } from 'vitest';
import { snapshotHasChanges, sidebarMatches } from './sidebar';
import type { AgentTask, SnapshotDocument } from './index';
test('unread is independent from unreviewed and new scopes start at their own baseline', () => {
	const task: AgentTask = {
		id: 'a',
		projectId: 'p',
		title: 'Test',
		status: 'done',
		hasUnread: true,
	};
	expect(sidebarMatches(task, 'unreviewed')).toBe(false);
	expect(
		sidebarMatches({ ...task, hasUnread: false, hasUnreviewedChanges: true }, 'unreviewed')
	).toBe(true);
	expect(sidebarMatches({ ...task, status: 'needs-you' }, 'running')).toBe(false);
	expect(sidebarMatches({ ...task, status: 'preparing' }, 'running')).toBe(true);
	const document = {
		scopes: [
			{ id: 'a', selected: true },
			{ id: 'b', selected: true },
		],
		checkpoints: [
			{ trees: [{ scopeId: 'a', tree: 'same' }] },
			{
				trees: [
					{ scopeId: 'a', tree: 'same' },
					{ scopeId: 'b', tree: 'new' },
				],
			},
		],
	} as SnapshotDocument;
	expect(snapshotHasChanges(document)).toBe(false);
	document.checkpoints[1]!.trees[0]!.tree = 'changed';
	expect(snapshotHasChanges(document)).toBe(true);
	document.scopes[0]!.selected = false;
	expect(snapshotHasChanges(document)).toBe(false);
});
test('sorts pinned first, then attention, running, unreviewed and recency without mutating the source', async () => {
	const { sidebarTasks } = await import('./sidebar');
	const task = (id: string, extra: Partial<AgentTask> = {}): AgentTask => ({
		id,
		projectId: 'p',
		title: id,
		status: 'done',
		updatedAt: '2026-09-21T00:00:00Z',
		...extra,
	});
	const tasks = [
		task('older'),
		task('fresh', { updatedAt: '2026-09-22T00:00:00Z' }),
		task('delta', { hasUnreviewedChanges: true }),
		task('running', { status: 'working' }),
		task('attention', { status: 'needs-you' }),
		task('pin', { pinned: true }),
	];
	expect(sidebarTasks(tasks).map((task) => task.id)).toEqual([
		'pin',
		'attention',
		'running',
		'delta',
		'fresh',
		'older',
	]);
	expect(tasks[0]?.id).toBe('older');
});
test('shows a worker without its foreman as an ordinary task and collects every task under a foreman (spec/tasks#delete-task)', async () => {
	const { sidebarTasks, taskDescendants } = await import('./sidebar');
	const task = (id: string, extra: Partial<AgentTask> = {}): AgentTask => ({
		id,
		projectId: 'p',
		title: id,
		status: 'done',
		updatedAt: '2026-09-21T00:00:00Z',
		...extra,
	});
	const crew = {} as NonNullable<AgentTask['crew']>;
	const tasks = [
		task('lead', { crew }),
		task('dev', { crewTaskId: 'lead', crewNodeId: 'n1', parentTaskId: 'lead' }),
		task('sub', { crewTaskId: 'lead', crewNodeId: 'n2', parentTaskId: 'dev' }),
		task('orphan', { crewTaskId: 'gone', crewNodeId: 'n1', parentTaskId: 'gone' }),
		task('other', { projectId: 'q', crewTaskId: 'lead', crewNodeId: 'n1' }),
	];
	expect(
		sidebarTasks(tasks)
			.map((item) => item.id)
			.sort()
	).toEqual(['lead', 'orphan', 'other']);
	expect(taskDescendants({ projectId: 'p', id: 'lead' }, tasks).map((item) => item.id)).toEqual([
		'dev',
		'sub',
	]);
	expect(taskDescendants({ projectId: 'p', id: 'dev' }, tasks).map((item) => item.id)).toEqual([
		'sub',
	]);
	expect(taskDescendants({ projectId: 'p', id: 'orphan' }, tasks)).toEqual([]);
});
test("the board and the list take only the person's tasks; a foreman counts its live workers (spec/projects-and-board#project-screen, spec/projects-and-board#board, spec/projects-and-board#person-tasks)", async () => {
	const { personTasks, crewWorkers, liveCrewWorkers } = await import('./sidebar');
	const { boardSections } = await import('./board');
	const task = (id: string, extra: Partial<AgentTask> = {}): AgentTask => ({
		id,
		projectId: 'p',
		title: id,
		status: 'done',
		updatedAt: '2026-09-21T00:00:00Z',
		...extra,
	});
	const crew = {} as NonNullable<AgentTask['crew']>;
	const tasks = [
		task('foreman', { crew, status: 'working' }),
		task('wave0', {
			crewTaskId: 'foreman',
			crewNodeId: 'd1',
			parentTaskId: 'foreman',
			status: 'completed',
		}),
		task('wave1', {
			crewTaskId: 'foreman',
			crewNodeId: 'd1',
			parentTaskId: 'foreman',
			status: 'working',
		}),
		task('asks', {
			crewTaskId: 'foreman',
			crewNodeId: 'd2',
			parentTaskId: 'foreman',
			status: 'needs-you',
		}),
		task('lead-worker', {
			crewTaskId: 'foreman',
			crewNodeId: 'd3',
			parentTaskId: 'wave1',
			status: 'preparing',
		}),
		task('reviewer', {
			crewTaskId: 'foreman',
			crewNodeId: 'r',
			parentTaskId: 'foreman',
			status: 'interrupted',
		}),
		task('orphan', {
			crewTaskId: 'gone',
			crewNodeId: 'd1',
			parentTaskId: 'gone',
			status: 'completed',
		}),
		task('mine', { status: 'completed' }),
		task('elsewhere', {
			projectId: 'q',
			crewTaskId: 'foreman',
			crewNodeId: 'd1',
			status: 'working',
		}),
	];
	const own = personTasks(tasks);
	expect(own.map((item) => item.id)).toEqual(['foreman', 'orphan', 'mine', 'elsewhere']);
	const sections = boardSections(own);
	expect(sections.completed.map((item) => item.id).sort()).toEqual(['mine', 'orphan']);
	expect(sections.progress.map((item) => item.id).sort()).toEqual(['elsewhere', 'foreman']);
	expect(crewWorkers(tasks[0]!, tasks).map((item) => item.id)).toEqual([
		'wave0',
		'wave1',
		'asks',
		'lead-worker',
		'reviewer',
	]);
	expect(liveCrewWorkers(tasks[0]!, tasks)).toBe(3);
	expect(crewWorkers(task('mine'), tasks)).toEqual([]);
	expect(liveCrewWorkers(task('plain'), tasks)).toBe(0);
});
test('a waiting worker lifts needs-you onto its foreman, and the board sorts that foreman with needs-you (spec/crew#attention)', async () => {
	const { crewNeedsYou } = await import('./sidebar');
	const { boardSections } = await import('./board');
	const task = (id: string, extra: Partial<AgentTask> = {}): AgentTask => ({
		id,
		projectId: 'p',
		title: id,
		status: 'done',
		updatedAt: '2026-09-21T00:00:00Z',
		...extra,
	});
	const crew = {} as NonNullable<AgentTask['crew']>;
	const foreman = task('foreman', { crew, status: 'working', updatedAt: '2026-09-20T00:00:00Z' }),
		other = task('other', { crew, status: 'working' });
	const lead = task('lead', {
			crewTaskId: 'foreman',
			crewNodeId: 'l',
			parentTaskId: 'foreman',
			status: 'working',
		}),
		deep = task('deep', {
			crewTaskId: 'foreman',
			crewNodeId: 'd',
			parentTaskId: 'lead',
			status: 'working',
		});
	const neighbour = task('neighbour', {
			crewTaskId: 'other',
			crewNodeId: 'd',
			parentTaskId: 'other',
			status: 'working',
		}),
		asks = task('asks', { status: 'needs-you', updatedAt: '2026-09-19T00:00:00Z' });
	const tasks = [foreman, other, lead, deep, neighbour, asks];
	expect(crewNeedsYou(foreman, tasks)).toBe(false);
	const waiting = tasks.map((item) =>
		item.id === 'deep' ? { ...item, status: 'needs-you' as const } : item
	);
	expect(crewNeedsYou(foreman, waiting)).toBe(true);
	expect(crewNeedsYou(other, waiting)).toBe(false);
	expect(crewNeedsYou(asks, waiting)).toBe(false);
	// The foreman keeps its own status; under attention it stands among needs-you, ordered by activity.
	const sections = boardSections([foreman, other, asks], (item) => crewNeedsYou(item, waiting));
	expect(sections.progress.map((item) => item.id)).toEqual(['foreman', 'asks', 'other']);
	expect(sections.progress[0]!.status).toBe('working');
	expect(boardSections([foreman, other, asks]).progress.map((item) => item.id)).toEqual([
		'asks',
		'other',
		'foreman',
	]);
});

test('completed tasks go after the rest: pinned first, newest completedAt on top, updatedAt as the fallback (spec/sidebar#done-rows)', async () => {
	const { sidebarTasks } = await import('./sidebar');
	const task = (id: string, extra: Partial<AgentTask> = {}): AgentTask => ({
		id,
		projectId: 'p',
		title: id,
		status: 'done',
		updatedAt: '2026-09-21T00:00:00Z',
		...extra,
	});
	const tasks = [
		task('old-done', {
			status: 'completed',
			completedAt: '2026-10-01T00:00:00Z',
			updatedAt: '2026-10-08T00:00:00Z',
		}),
		task('new-done', {
			status: 'completed',
			completedAt: '2026-10-07T00:00:00Z',
			updatedAt: '2026-10-02T00:00:00Z',
		}),
		task('no-stamp', { status: 'completed', updatedAt: '2026-10-05T00:00:00Z' }),
		task('pinned-done', { status: 'completed', pinned: true, completedAt: '2026-09-01T00:00:00Z' }),
		task('turn', { updatedAt: '2026-10-08T00:00:00Z' }),
		task('asks', { status: 'needs-you' }),
		task('pin', { pinned: true, updatedAt: '2026-08-01T00:00:00Z' }),
		task('queued', { status: 'backlog', updatedAt: '2026-09-30T00:00:00Z' }),
	];
	expect(sidebarTasks(tasks).map((item) => item.id)).toEqual([
		'pin',
		'asks',
		'turn',
		'queued',
		'pinned-done',
		'new-done',
		'no-stamp',
		'old-done',
	]);
	expect(
		sidebarTasks(tasks.filter((item) => item.status !== 'completed')).map((item) => item.id)
	).toEqual(['pin', 'asks', 'turn', 'queued']);
});
