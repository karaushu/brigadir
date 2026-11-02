import { describe, expect, it } from 'vitest';
import {
	type TaskArchive,
	archiveAge,
	archiveDeleteTitle,
	archiveGroupKey,
	archiveGroups,
	archiveMonthLabel,
	archiveSearch,
	archiveSoon,
	archiveWhen,
	archivedTasks,
	autoArchiveDue,
	canArchive,
	isTaskArchive,
	keptWorktreeLabel,
	swipeAction,
	taskBranch,
	unstampedCompleted,
} from './archive';
import { personTasks, sidebarTasks } from './sidebar';
import { isAgentTask, type AgentTask } from './workspace';
import { defaultAppSettings, isAppSettings } from './settings';
const day = 86_400_000,
	now = Date.parse('2026-10-06T12:00:00');
const task = (id: string, patch: Partial<AgentTask> = {}): AgentTask => ({
	id,
	projectId: 'p',
	title: id,
	status: 'done',
	...patch,
});
const archive = (at: number, by: 'manual' | 'auto' = 'manual'): TaskArchive => ({
	at: new Date(at).toISOString(),
	by,
	status: 'completed',
	worktree: 'none',
});
describe('task archive (spec/tasks#archive)', () => {
	it('archives only where no agent works, the task, its workers and the launch queue', () => {
		for (const status of ['done', 'completed', 'interrupted', 'failed', 'backlog'] as const)
			expect(canArchive(task('a', { status }), [])).toBe(true);
		for (const status of ['working', 'needs-you', 'preparing', 'queued', 'rate-limited'] as const)
			expect(canArchive(task('a', { status }), [])).toBe(false);
		const foreman = task('f', { crew: {} as never }),
			worker = task('w', {
				crewTaskId: 'f',
				crewNodeId: 'n',
				parentTaskId: 'f',
				status: 'working',
			});
		expect(canArchive(foreman, [foreman, worker])).toBe(false);
		expect(canArchive(foreman, [foreman, { ...worker, status: 'done' }])).toBe(true);
		expect(canArchive(task('a'), [], (key) => key.id === 'a')).toBe(false);
		expect(canArchive(task('main-tree'), [])).toBe(false);
		expect(canArchive(task('a', { archived: archive(now) }), [])).toBe(false);
	});
	it('swipes by the board column: archive a completed or backlog task, complete one in progress with no agent at work (spec/tasks#archive-actions)', () => {
		for (const status of ['completed', 'backlog'] as const)
			expect(swipeAction(task('a', { status }), [])).toBe('archive');
		for (const status of ['done', 'interrupted', 'failed'] as const)
			expect(swipeAction(task('a', { status }), [])).toBe('complete');
		for (const status of ['working', 'needs-you', 'preparing', 'queued', 'rate-limited'] as const)
			expect(swipeAction(task('a', { status }), [])).toBeNull();
		const foreman = task('f', { crew: {} as never }),
			worker = task('w', {
				crewTaskId: 'f',
				crewNodeId: 'n',
				parentTaskId: 'f',
				status: 'working',
			});
		expect(swipeAction(foreman, [foreman, worker])).toBeNull();
		expect(swipeAction(foreman, [foreman, { ...worker, status: 'done' }])).toBe('complete');
		expect(swipeAction(task('a'), [], (key) => key.id === 'a')).toBeNull();
		expect(swipeAction(task('a', { status: 'completed' }), [], (key) => key.id === 'a')).toBeNull();
		expect(swipeAction(task('main-tree'), [])).toBeNull();
		expect(swipeAction(task('a', { archived: archive(now) }), [])).toBeNull();
	});
	it('keeps archived tasks out of the sidebar, the board and the list', () => {
		const tasks = [task('live'), task('old', { archived: archive(now) })];
		expect(personTasks(tasks).map((item) => item.id)).toEqual(['live']);
		expect(sidebarTasks(tasks).map((item) => item.id)).toEqual(['live']);
		const foreman = task('f', { crew: {} as never, archived: archive(now) }),
			worker = task('w', {
				crewTaskId: 'f',
				crewNodeId: 'n',
				parentTaskId: 'f',
				archived: archive(now),
			});
		expect(
			archivedTasks([foreman, worker, task('x', { archived: archive(now - day) })]).map(
				(item) => item.id
			)
		).toEqual(['f', 'x']);
	});
	it('validates the archive mark and completedAt on a task', () => {
		expect(isTaskArchive(archive(now))).toBe(true);
		expect(isTaskArchive({ ...archive(now), by: 'robot' })).toBe(false);
		expect(isTaskArchive({ ...archive(now), worktree: 'kept', uncommitted: 3 })).toBe(true);
		expect(isTaskArchive({ ...archive(now), uncommitted: -1 })).toBe(false);
		expect(
			isAgentTask(task('a', { archived: archive(now), completedAt: new Date(now).toISOString() }))
		).toBe(true);
		expect(isAgentTask({ ...task('a'), completedAt: 'soon' })).toBe(false);
	});
	it('picks completed, unpinned tasks of the person after N days; Never picks none', () => {
		const old = new Date(now - 8 * day).toISOString(),
			fresh = new Date(now - 2 * day).toISOString();
		const tasks = [
			task('old', { status: 'completed', completedAt: old }),
			task('fresh', { status: 'completed', completedAt: fresh }),
			task('pinned', { status: 'completed', completedAt: old, pinned: true }),
			task('stopped', { status: 'interrupted', completedAt: old }),
			task('worker', { status: 'completed', completedAt: old, crewTaskId: 'f', crewNodeId: 'n' }),
			task('unstamped', { status: 'completed' }),
		];
		expect(autoArchiveDue(tasks, 7, now).map((item) => item.id)).toEqual(['old']);
		expect(autoArchiveDue(tasks, 1, now).map((item) => item.id)).toEqual(['old', 'fresh']);
		expect(autoArchiveDue(tasks, null, now)).toEqual([]);
		expect(unstampedCompleted(tasks).map((item) => item.id)).toEqual(['unstamped']);
		expect(
			archiveSoon(
				task('a', { status: 'completed', completedAt: new Date(now - 6.5 * day).toISOString() }),
				7,
				now
			)
		).toBe('tomorrow');
		expect(
			archiveSoon(
				task('a', { status: 'completed', completedAt: new Date(now - 6.9 * day).toISOString() }),
				7,
				now
			)
		).toBe('today');
		expect(archiveSoon(task('a', { status: 'completed', completedAt: fresh }), 7, now)).toBeNull();
	});
	it('reads auto-archive from settings, 3 days by default', () => {
		expect(defaultAppSettings.agents.archiveAfterDays).toBe(3);
		expect(
			isAppSettings({
				...defaultAppSettings,
				agents: { ...defaultAppSettings.agents, archiveAfterDays: null },
			})
		).toBe(true);
		expect(
			isAppSettings({
				...defaultAppSettings,
				agents: { ...defaultAppSettings.agents, archiveAfterDays: 5 },
			})
		).toBe(false);
	});
	it('groups by the archive time: today, this week, then months', () => {
		expect(archiveGroupKey(new Date(now - 3600_000).toISOString(), now)).toBe('today');
		expect(archiveGroupKey(new Date(now - 3 * day).toISOString(), now)).toBe('week');
		expect(archiveGroupKey('2026-09-12T10:00:00', now)).toBe('month:2026-8');
		const tasks = archivedTasks([
			task('a', { archived: archive(now - 3600_000) }),
			task('b', { archived: archive(now - 2 * day) }),
			task('c', { archived: archive(Date.parse('2026-09-09T10:00:00')) }),
			task('d', { archived: archive(Date.parse('2026-09-06T10:00:00')) }),
		]);
		expect(
			archiveGroups(tasks, now).map((group) => [group.key, group.tasks.map((item) => item.id)])
		).toEqual([
			['today', ['a']],
			['week', ['b']],
			['month:2026-8', ['c', 'd']],
		]);
		expect(archiveMonthLabel('month:2026-8', 'uk', now)).toBe('Вересень');
		expect(archiveMonthLabel('month:2025-8', 'en', now)).toBe('September 2025');
	});
	it('searches title, prompt, branch and project and filters by project and way', () => {
		const tasks = [
			task('a', { title: 'Fix menu import', archived: archive(now) }),
			task('b', {
				title: 'Drop toast',
				prompt: 'Remove the legacy toast',
				archived: archive(now - day, 'auto'),
			}),
			task('c', {
				title: 'Trap focus',
				projectId: 'q',
				launch: { branch: 'fix/drawer-focus' } as never,
				archived: archive(now - 2 * day, 'auto'),
			}),
			task('live', { title: 'Fix live' }),
		];
		const projects = [
			{ id: 'p', name: 'choice', path: '/p' },
			{ id: 'q', name: 'web-admin', path: '/q' },
		];
		expect(
			archiveSearch(tasks, projects, { query: '', projectId: null, by: null }).map(
				(item) => item.id
			)
		).toEqual(['a', 'b', 'c']);
		expect(
			archiveSearch(tasks, projects, { query: 'fix', projectId: null, by: null }).map(
				(item) => item.id
			)
		).toEqual(['a', 'c']);
		expect(
			archiveSearch(tasks, projects, { query: 'legacy', projectId: null, by: null }).map(
				(item) => item.id
			)
		).toEqual(['b']);
		expect(
			archiveSearch(tasks, projects, { query: 'web-admin', projectId: null, by: null }).map(
				(item) => item.id
			)
		).toEqual(['c']);
		expect(
			archiveSearch(tasks, projects, { query: '', projectId: 'p', by: 'auto' }).map(
				(item) => item.id
			)
		).toEqual(['b']);
		expect(taskBranch(tasks[2]!)).toBe('fix/drawer-focus');
	});
	it('says ages, dates and counts with four uk forms', () => {
		expect(archiveAge('uk', new Date(now - 2 * day).toISOString(), now)).toBe('2 дні');
		expect(archiveAge('uk', new Date(now - 9 * day).toISOString(), now)).toBe('9 днів');
		expect(archiveAge('uk', new Date(now - 21 * day).toISOString(), now)).toBe('21 день');
		expect(archiveAge('uk', new Date(now).toISOString(), now)).toBe('сьогодні');
		expect(archiveWhen('uk', new Date(now - day).toISOString(), now)).toBe('вчора');
		expect(archiveWhen('uk', new Date(now - 3 * day).toISOString(), now)).toBe('3 дні тому');
		expect(archiveWhen('uk', '2026-09-09T10:00:00', now)).toBe('9 вересня');
		expect(archiveDeleteTitle('uk', 3)).toBe('Видалити 3 задачі з архіву?');
		expect(archiveDeleteTitle('uk', 5)).toBe('Видалити 5 задач з архіву?');
		expect(archiveDeleteTitle('uk', 1)).toBe('Видалити 1 задачу з архіву?');
		expect(keptWorktreeLabel('uk', 3)).toBe('Worktree лишився: 3 незакомічені файли.');
		expect(keptWorktreeLabel('en', 1)).toBe('The worktree stays: 1 uncommitted file.');
	});
});
