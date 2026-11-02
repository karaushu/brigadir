import { create } from 'zustand';
/**
 * spec/agents-and-providers#tools-awareness: the crew workers waiting for the project's one simulator device, by project, as main's queue reports them.
 * Nothing is stored: a wait lasts at most a minute, and a reload only misses a line that is about to go.
 */
type SimulatorWaiting = { waiting: Readonly<Record<string, readonly string[]>> };
export const useSimulatorWaiting = create<SimulatorWaiting>(() => ({ waiting: {} }));
export function setSimulatorWaiting(projectId: string, ids: readonly string[]) {
	useSimulatorWaiting.setState((state) => ({ waiting: { ...state.waiting, [projectId]: ids } }));
}
export function useWaitsForSimulator(projectId: string, id: string): boolean {
	return useSimulatorWaiting((state) => state.waiting[projectId]?.includes(id) ?? false);
}
