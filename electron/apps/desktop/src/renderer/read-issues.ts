import type { AgentTask, MessageKey, Project, ReadIssue, ReadIssueCode } from '@brigadir/core';

/** spec/architecture-and-platform#read-issues: what a person reads for an issue — the project and task by name and what could not be read. */
export type ReadIssueLine = {
	project: string | null;
	task: string | null;
	what: MessageKey;
	reason: MessageKey;
	/** The path in the data folder, for a bug report. */
	path: string;
};
const reasons: Record<ReadIssueCode, MessageKey> = {
	invalid_document: 'The file is invalid.',
	unsupported_schema: 'The file uses a newer schema.',
	unreadable: 'The file could not be read.',
	unsafe_path: 'The data location is not allowed.',
	git_failed: 'Git could not read the repository.',
};
const taskFiles: Record<string, MessageKey> = {
	'task.json': 'Task',
	'events.jsonl': 'Chat',
	'snapshots.json': 'Changes',
	'host.json': 'Agent',
	// spec/architecture-and-platform#read-issues: the repository state of the task (branch, base, remote), read with git.
	git: 'Git',
};
const rootFiles: Record<string, MessageKey> = {
	projects: 'Projects',
	'task-reads.json': 'Unread',
	'task-labels.json': 'Task names',
	templates: 'Templates',
};
export function readIssueLine(
	issue: ReadIssue,
	projects: readonly Pick<Project, 'id' | 'name'>[],
	tasks: readonly Pick<AgentTask, 'id' | 'projectId' | 'title'>[]
): ReadIssueLine {
	// readWorkspace's paths come from `path.relative`: backslashes on Windows.
	const parts = issue.path.split(/[\\/]/),
		line = (what: MessageKey, project: string | null = null, task: string | null = null) => ({
			project,
			task,
			what,
			reason: reasons[issue.code],
			path: issue.path,
		});
	if (parts[0] === 'projects' && parts[1]) {
		const project = projects.find((item) => item.id === parts[1])?.name ?? null;
		if (parts.length === 3) return line(parts[2] === 'tasks' ? 'Tasks' : 'Project', project);
		if (parts.length === 2) return line('Project', project);
		if (parts[2] === 'tasks' && parts[3]) {
			const task =
				tasks.find((item) => item.projectId === parts[1] && item.id === parts[3])?.title ?? null;
			return line(parts.length === 4 ? 'Task' : (taskFiles[parts[4]!] ?? 'Task'), project, task);
		}
		return line('Project', project);
	}
	return line(rootFiles[parts[0]!] ?? 'App data');
}
/** The issues as plain text for a bug report: one line per issue with its code and path. */
export const readIssuesReport = (issues: readonly ReadIssue[]) =>
	issues.map((issue) => `${issue.code} ${issue.path}`).join('\n');
