import { expect, it } from 'vitest';
import { turnWindows, worktreeVerdict, type TurnWindow } from './agent-worktree';
import {
	moveRefusal,
	moveRefusals,
	isWorkspaceMoveFields,
	isWorktreeJoinedFields,
} from './workspace-move';
import type { EventRecord } from './session';
const at = (seconds: number) => new Date(Date.UTC(2026, 10, 20, 10, 0, seconds)).toISOString();
const record = (seq: number, seconds: number, event: EventRecord['event']): EventRecord =>
	({ seq, at: at(seconds), event }) as EventRecord;
it('reads the task’s turns as time windows with the tools they ran (spec/tasks#agent-worktrees)', () => {
	const windows = turnWindows([
		record(1, 0, { kind: 'turn.started', text: 'go' }),
		record(2, 5, {
			kind: 'tool.changed',
			patch: { id: 't', title: 'Bash', input: 'git worktree add ../b -b feature' },
		}),
		record(3, 10, { kind: 'turn.completed', reason: 'end_turn' }),
		record(4, 20, { kind: 'turn.started', text: 'more' }),
	]);
	expect(windows).toHaveLength(2);
	expect(windows[0]).toMatchObject({ end: Date.parse(at(10)) });
	expect(windows[0]!.tools).toContain('git worktree add ../b -b feature');
	expect(windows[1]!.end).toBeNull();
});
it('joins the agent’s worktree, asks when it cannot tell, and leaves others alone (spec/tasks#agent-worktrees)', () => {
	const turns: TurnWindow[] = [
		{ start: 1000, end: 10_000, tools: ['git worktree add ../b -b feature'] },
		{ start: 20_000, end: 30_000, tools: ['npm test'] },
	];
	const base = {
		path: '/work/b',
		branch: 'feature',
		turns,
		brigadir: false,
		insideProject: false,
		otherTask: false,
		now: 40_000,
	};
	expect(worktreeVerdict({ ...base, createdAt: 5000 })).toBe('join');
	// Made in a turn that named nothing of it: someone else may have made it meanwhile.
	expect(worktreeVerdict({ ...base, createdAt: 25_000 })).toBe('ask');
	expect(worktreeVerdict({ ...base, createdAt: null })).toBe('ask');
	// Outside the task's turns: not the agent's.
	expect(worktreeVerdict({ ...base, createdAt: 15_000 })).toBe('ignore');
	// A reflog counts whole seconds: one that may lie on either side of a turn's edge is asked.
	expect(worktreeVerdict({ ...base, createdAt: 9_500, precision: 1000 })).toBe('ask');
	expect(worktreeVerdict({ ...base, createdAt: 10_500, precision: 1000 })).toBe('ignore');
	expect(worktreeVerdict({ ...base, createdAt: 5_000, precision: 1000 })).toBe('join');
	for (const flag of ['brigadir', 'insideProject', 'otherTask'] as const)
		expect(worktreeVerdict({ ...base, createdAt: 5000, [flag]: true })).toBe('ignore');
	// The branch or the folder named by a tool counts as well.
	expect(
		worktreeVerdict({
			...base,
			createdAt: 25_000,
			turns: [{ start: 20_000, end: null, tools: ['cd /work/b && git switch -c feature'] }],
		})
	).toBe('join');
});
it('refuses the person’s move by one rule (spec/tasks#move-to-worktree)', () => {
	const task = {
		id: 'a1',
		provider: 'claude' as const,
		status: 'done' as const,
		transport: 'gui' as const,
		launch: {
			isolation: 'in-place' as const,
			branch: '',
			baseRef: '',
			setupCommand: '',
			scopes: [],
		},
	};
	const ok = { moving: false, git: true };
	expect(moveRefusal(task, ok)).toBeNull();
	expect(moveRefusal({ ...task, launch: { ...task.launch, isolation: 'worktree' } }, ok)).toBe(
		'worktree'
	);
	expect(moveRefusal({ ...task, crewTaskId: 'f1' }, ok)).toBe(moveRefusals.role);
	expect(moveRefusal({ ...task, readOnlyAgent: true }, ok)).toBe(moveRefusals.role);
	expect(moveRefusal({ ...task, transport: 'terminal' }, ok)).toBe(moveRefusals.terminal);
	expect(moveRefusal(task, { ...ok, moving: true })).toBe(moveRefusals.busy);
	expect(moveRefusal({ ...task, status: 'backlog' }, ok)).toBe(moveRefusals.busy);
	expect(moveRefusal(task, { ...ok, git: false })).toBe(moveRefusals.git);
});
it('validates the person’s move and the joined worktree (rule 2)', () => {
	expect(isWorkspaceMoveFields({ id: 'm1', by: 'person', state: 'waiting', repos: [] })).toBe(true);
	expect(isWorkspaceMoveFields({ id: 'm1', state: 'waiting', repos: [] })).toBe(false);
	expect(
		isWorkspaceMoveFields({ id: 'm1', hireId: 'h1', by: 'person', state: 'moving', repos: [] })
	).toBe(false);
	expect(isWorkspaceMoveFields({ id: 'm1', hireId: 'h1', state: 'moved', repos: ['x'] })).toBe(
		true
	);
	expect(
		isWorktreeJoinedFields({
			scopeId: '1f2e3d4c5b6a7980',
			name: 'b',
			path: '/work/b',
			repo: 'business',
			branch: 'feature',
			standsForRoot: true,
			by: 'agent',
		})
	).toBe(true);
});
