import { create } from 'zustand';
import {
	defaultChatFont,
	defaultInterfaceFont,
	defaultModules,
	defaultTypography,
	selectLocale,
	type AgentTask,
	type Appearance,
	type WorkspaceSnapshot,
} from '@brigadir/core';
type State = {
	workspace: WorkspaceSnapshot | null;
	appearance: Appearance;
	error: boolean;
	selectedProject: string | null;
	selectProject(id: string): void;
	selectedTask: { projectId: string; id: string } | null;
	load(): Promise<void>;
	setAppearance(value: Appearance): void;
	selectTask(projectId: string, id: string): void;
	/** spec/tasks#quick-tasks: a repo's main tree is a hidden task record of the project; `scopeId` is the repo row it was opened from. */
	mainTree: { task: AgentTask; scopeId: string | null } | null;
	openMainTree(projectId: string, scopeId: string | null): Promise<AgentTask>;
	/** spec/notifications-slack-notes-and-schedules#notes: the Notes screen in the main area and the note it shows; null — the screen is closed. */
	notes: { note: string | null } | null;
	openNotes(note?: string | null): void;
	closeNotes(): void;
	/** spec/notifications-slack-notes-and-schedules#schedules: the Schedules section — the schedule its screen shows, or `all` for the table; null — closed. A run's
	 *  task opened from the history shows in the main area while the section stays (`openScheduleTask`). */
	schedules: { schedule: { projectId: string; id: string } | 'all' } | null;
	openSchedules(schedule?: { projectId: string; id: string } | 'all'): void;
	openScheduleTask(projectId: string, id: string): void;
	closeSchedules(): void;
};
let loadGeneration = 0;
const texts = new WeakMap<object, string>();
const serialized = (task: object) => {
	let text = texts.get(task);
	if (text === undefined) {
		text = JSON.stringify(task);
		texts.set(task, text);
	}
	return text;
};
/** Unchanged tasks keep their previous objects, so memoized sidebar rows skip a reload that did not touch them. */
function shareTasks(
	previous: WorkspaceSnapshot | null,
	next: WorkspaceSnapshot
): WorkspaceSnapshot {
	if (!previous) return next;
	const known = new Map(previous.tasks.map((task) => [`${task.projectId}/${task.id}`, task]));
	return {
		...next,
		tasks: next.tasks.map((task) => {
			const old = known.get(`${task.projectId}/${task.id}`);
			return old && serialized(old) === serialized(task) ? old : task;
		}),
	};
}
export const useWorkspace = create<State>((set, get) => ({
	workspace: null,
	appearance: {
		suggestNextPrompt: false,
		modules: { ...defaultModules },
		dark: false,
		accent: '',
		accentColor: 'system',
		locale: selectLocale(navigator.language),
		toolbarLabels: 'icons',
		interfaceFont: defaultInterfaceFont,
		chatFont: defaultChatFont,
		typography: defaultTypography,
		fonts: null,
		missingFonts: [],
		diffBase: 'task',
		notificationMode: 'needs-you',
		editing: { languageServers: true, closeBrackets: true, closeTags: true, callParens: true },
	},
	error: false,
	selectedTask: null,
	selectedProject: null,
	mainTree: null,
	notes: null,
	schedules: null,
	selectProject: (id) =>
		set({ selectedProject: id, selectedTask: null, mainTree: null, notes: null, schedules: null }),
	openNotes: (note) =>
		set((state) => ({
			notes: { note: note === undefined ? (state.notes?.note ?? null) : note },
			selectedTask: null,
			mainTree: null,
			schedules: null,
		})),
	closeNotes: () => set({ notes: null }),
	openSchedules: (schedule) =>
		set((state) => ({
			schedules: { schedule: schedule ?? state.schedules?.schedule ?? 'all' },
			selectedTask: null,
			mainTree: null,
			notes: null,
		})),
	openScheduleTask: (projectId, id) =>
		set((state) => ({
			schedules: state.schedules ?? { schedule: 'all' },
			selectedProject: projectId,
			selectedTask: { projectId, id },
			mainTree: null,
			notes: null,
		})),
	closeSchedules: () => set({ schedules: null }),
	async openMainTree(projectId, scopeId) {
		const task = await window.brigadir.openMainTree(projectId);
		set({
			selectedProject: projectId,
			selectedTask: null,
			mainTree: { task, scopeId },
			notes: null,
			schedules: null,
		});
		return task;
	},
	async load() {
		const generation = ++loadGeneration;
		set((state) => (state.error ? { error: false } : state));
		try {
			const [workspace, appearance] = await Promise.all([
				window.brigadir.readWorkspace(),
				window.brigadir.readAppearance(),
			]);
			if (generation !== loadGeneration) return;
			// An unchanged appearance keeps its identity so fonts and editors do not remeasure.
			set((state) => ({
				workspace: shareTasks(state.workspace, workspace),
				appearance:
					JSON.stringify(appearance) === JSON.stringify(state.appearance)
						? state.appearance
						: appearance,
				selectedTask: workspace.tasks.some(
					(task) =>
						task.id === state.selectedTask?.id && task.projectId === state.selectedTask.projectId
				)
					? state.selectedTask
					: null,
			}));
		} catch {
			if (generation === loadGeneration) set({ error: true });
		}
	},
	setAppearance: (appearance) => {
		const before = get().appearance.diffBase;
		set((state) =>
			JSON.stringify(appearance) === JSON.stringify(state.appearance) ? state : { appearance }
		);
		// spec/diff-and-review#diff-base: the sidebar totals and Unreviewed follow the base, so a switch re-reads the workspace.
		if (appearance.diffBase !== before) void get().load();
	},
	selectTask: (projectId, id) =>
		set({
			selectedProject: projectId,
			selectedTask: { projectId, id },
			mainTree: null,
			notes: null,
			schedules: null,
		}),
}));
