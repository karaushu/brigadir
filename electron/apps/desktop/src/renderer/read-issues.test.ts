import { expect, it } from 'vitest';
import { readIssueLine, readIssuesReport } from './read-issues';

const projects = [{ id: 'p1', name: 'business' }],
	tasks = [{ id: 't1', projectId: 'p1', title: 'Client details' }];
it('names the project, the task and what could not be read; the path stays for a bug report (spec/architecture-and-platform#read-issues)', () => {
	const line = (path: string, code = 'unreadable' as const) =>
		readIssueLine({ path, code }, projects, tasks);
	expect(line('projects/p1/tasks/t1/events.jsonl')).toEqual({
		project: 'business',
		task: 'Client details',
		what: 'Chat',
		reason: 'The file could not be read.',
		path: 'projects/p1/tasks/t1/events.jsonl',
	});
	expect(line('projects/p1/tasks/t1/snapshots.json')).toMatchObject({ what: 'Changes' });
	expect(line('projects/p1/tasks/t1/host.json')).toMatchObject({ what: 'Agent' });
	// A task.json that does not read has no title: the project names it.
	expect(line('projects/p1/tasks/t9/task.json')).toMatchObject({
		project: 'business',
		task: null,
		what: 'Task',
	});
	expect(line('projects/p9/project.json')).toMatchObject({ project: null, what: 'Project' });
	expect(line('projects/p1/tasks')).toMatchObject({ project: 'business', what: 'Tasks' });
	expect(line('projects')).toMatchObject({ project: null, what: 'Projects' });
	expect(line('task-reads.json')).toMatchObject({ what: 'Unread' });
	expect(line('task-labels.json')).toMatchObject({ what: 'Task names' });
	expect(line('templates/builtin/reviewer.json')).toMatchObject({ what: 'Templates' });
	expect(line('surface-layout.json')).toMatchObject({ what: 'App data' });
	expect(
		readIssuesReport([
			{ path: 'projects/p1/project.json', code: 'invalid_document' },
			{ path: 'task-reads.json', code: 'unreadable' },
		])
	).toBe('invalid_document projects/p1/project.json\nunreadable task-reads.json');
});
