import { useEffect, useState } from 'react';
import { useWorkspace } from './store';
import { useSurfaceLayout } from './surface-layout';
import { preloadSurface } from './task-surface';

/**
 * spec/sidebar#open-last: the app opens on the project and task that were open when it last ran. Restored once, on the first workspace,
 * and only if nothing was chosen meanwhile; a task that is gone or archived falls back to its project, a project that is
 * gone to the default. From then on every choice is written to `sidebar.json`.
 *
 * spec/task-window-workspace#restore-window: the last task's `surface.json` and the shared widths are read together with the
 * workspace, and the task is selected only once they are in (1.5 s at most), so its first frame is the restored layout,
 * not the default one a few ms before it. Until then the content area stays empty, as while the workspace loads.
 * Returns `true` while that restore is pending.
 */
export function useRestoreSelection() {
	const [pending, setPending] = useState(true);
	useEffect(() => {
		let restored = false,
			cancelled = false;
		// Read at once, alongside the workspace snapshot, not after it.
		const last = window.brigadir.readSelection().catch(() => null);
		const ahead = last.then((value) =>
			Promise.all([
				value?.task ? preloadSurface({ projectId: value.project, id: value.task }) : null,
				useSurfaceLayout.getState().load(),
			])
		);
		const save = () => {
			const { selectedProject, selectedTask } = useWorkspace.getState();
			const project = selectedTask?.projectId ?? selectedProject;
			if (project)
				void window.brigadir
					.saveSelection(selectedTask ? { project, task: selectedTask.id } : { project })
					.catch(() => {});
		};
		const restore = async () => {
			if (restored) return;
			restored = true;
			const selection = await last;
			await ahead.catch(() => {});
			const state = useWorkspace.getState(),
				workspace = state.workspace;
			if (cancelled || !workspace) return;
			setPending(false);
			if (!selection || state.selectedProject !== null || state.selectedTask !== null) return;
			const task = selection.task
				? workspace.tasks.find(
						(item) =>
							item.projectId === selection.project && item.id === selection.task && !item.archived
					)
				: undefined;
			if (task) state.selectTask(task.projectId, task.id);
			else if (
				selection.project === '*' ||
				workspace.projects.some((project) => project.id === selection.project)
			)
				state.selectProject(selection.project);
		};
		const unsubscribe = useWorkspace.subscribe((state, previous) => {
			if (!restored) {
				if (state.workspace && !previous.workspace) void restore();
				return;
			}
			if (
				state.selectedProject !== previous.selectedProject ||
				state.selectedTask !== previous.selectedTask
			)
				save();
		});
		if (useWorkspace.getState().workspace) void restore();
		return () => {
			cancelled = true;
			unsubscribe();
		};
	}, []);
	return pending;
}
