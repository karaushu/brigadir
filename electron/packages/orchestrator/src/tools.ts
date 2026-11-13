import type { CrewRole } from '@brigadir/core';
/** spec/crew#task-type, spec/crew#communication: one tool set per role. The MCP server lists only these; the host refuses the rest (two guards). */
export type CrewToolName =
	| 'propose_plan'
	| 'create_worker_task'
	| 'prompt_task'
	| 'task_status'
	| 'read_report'
	| 'read_transcript'
	| 'read_diff'
	| 'submit_review'
	| 'approve'
	| 'accept_task'
	| 'ask_foreman'
	| 'post_note'
	| 'read_notes'
	| 'hire_workers'
	| 'dismiss_worker'
	| 'request_model';
export const foremanTools: readonly CrewToolName[] = [
	'propose_plan',
	'create_worker_task',
	'prompt_task',
	'task_status',
	'read_report',
	'read_transcript',
	'read_diff',
	'submit_review',
	'accept_task',
	'post_note',
	'read_notes',
];
/**
 * spec/crew#auto-tools: the Auto agent has its whole tool set from its first session, so the list never changes mid-session (Codex does not read
 * it again). Hiring replaces the plan: `hire_workers` is the card and starts the workers; `create_worker_task` and `propose_plan` are a named crew's.
 */
export const autoTools: readonly CrewToolName[] = [
	'hire_workers',
	'dismiss_worker',
	'request_model',
	'prompt_task',
	'task_status',
	'read_report',
	'read_transcript',
	'read_diff',
	'submit_review',
	'accept_task',
	'post_note',
	'read_notes',
];
export const developerTools: readonly CrewToolName[] = ['ask_foreman', 'post_note', 'read_notes'];
export const reviewerTools: readonly CrewToolName[] = [
	'read_report',
	'read_diff',
	'submit_review',
	'approve',
	'ask_foreman',
	'post_note',
	'read_notes',
];
/** `BRIGADIR_ROLE` values: the root foreman talks to the human (`ask_user`); a lead asks its parent instead (spec/crew#subordinates); `auto` is the
 *  agent of an Auto task, which writes code and may hire (spec/crew#auto). */
export type CrewProcessRole = 'foreman' | 'lead' | 'developer' | 'reviewer' | 'auto';
export function crewTools(role: CrewProcessRole): readonly CrewToolName[] {
	switch (role) {
		case 'foreman':
			return foremanTools;
		case 'lead':
			return [...foremanTools, 'ask_foreman'];
		case 'developer':
			return developerTools;
		case 'reviewer':
			return reviewerTools;
		case 'auto':
			return autoTools;
	}
}
export function crewProcessRole(role: CrewRole, isRoot: boolean): CrewProcessRole {
	return role === 'foreman' ? (isRoot ? 'foreman' : 'lead') : role;
}
export function isCrewProcessRole(value: unknown): value is CrewProcessRole {
	return (
		value === 'foreman' ||
		value === 'lead' ||
		value === 'developer' ||
		value === 'reviewer' ||
		value === 'auto'
	);
}
export function toolAllowed(role: CrewProcessRole, tool: string): tool is CrewToolName {
	return (crewTools(role) as readonly string[]).includes(tool);
}
/** The human keeps `ask_user`, `create_task` and the editor context only in the root foreman's session; workers ask up the tree (spec/crew#task-type, spec/crew#ask-foreman). */
export function humanToolsAllowed(role: CrewProcessRole | null): boolean {
	return role === null || role === 'foreman' || role === 'auto';
}
/** spec/crew#auto: the agent at the root of its own task, foreman or Auto — the person's agent, not a worker. */
export function rootRole(role: CrewProcessRole | null | undefined): boolean {
	return role === 'foreman' || role === 'auto';
}
/** spec/agents-and-providers#tools-awareness: the browser, the simulator and the project commands belong to whoever changed the code, so every crew
 *  role has them too. Their MCP names start with the module (`browser_`, `simulator_`, `commands_`, spec/settings-modules-and-onboarding#modules). */
export const workspaceModules = ['browser', 'simulator', 'commands'] as const;
export type WorkspaceModule = (typeof workspaceModules)[number];
export type WorkspaceTools = Record<WorkspaceModule, boolean>;
/** spec/terminal-and-cli-agents#agent-console-tools: the console of the task is no module, and every role reads its own (`console_*`). */
export function isWorkspaceTool(name: string): boolean {
	return (
		name.startsWith('console_') || workspaceModules.some((module) => name.startsWith(`${module}_`))
	);
}
/** spec/agents-and-providers#tools-awareness: one simulator device per project; workers take it in turns, the foreman and a solo agent go first. */
export function simulatorQueued(role: CrewProcessRole | null): boolean {
	return !humanToolsAllowed(role);
}
