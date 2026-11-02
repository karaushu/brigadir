import { isTaskKey, type TaskKey } from './session';
import { isRecord, type AgentTask } from './workspace';
export type LiveAgentRef = { key: TaskKey; instance: string };
export type LiveAgent = LiveAgentRef & {
	projectName: string;
	title: string;
	provider: AgentTask['provider'];
	status: AgentTask['status'];
	startedAt: string;
	activity: string | null;
	attention: 'permission' | 'question' | null;
};
export type LiveAgentsSnapshot = { agents: LiveAgent[]; issues: number };
export function isLiveAgentRef(value: unknown): value is LiveAgentRef {
	return (
		isRecord(value) &&
		isTaskKey(value.key) &&
		typeof value.instance === 'string' &&
		/^[a-f0-9-]{36}$/.test(value.instance)
	);
}
