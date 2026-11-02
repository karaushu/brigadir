import { expect, it } from 'vitest';
import type { AgentTask, TaskLaunch } from '@brigadir/core';
import { cardTree } from './task-line';

const launch: TaskLaunch = {
	isolation: 'worktree',
	branch: 'brigadir/phone-validation',
	baseRef: 'origin/main',
	setupCommand: '',
	scopes: [],
};
const task = (patch: Partial<AgentTask>): AgentTask => ({
	id: 't',
	projectId: 'p',
	title: 'Phone validation',
	status: 'preparing',
	launch,
	...patch,
});

it('a «Preparing…» or «Queued» card shows the planned branch before the tree exists (spec/tasks#worktree-preparation)', () => {
	expect(cardTree('en', task({}))).toEqual({ branch: 'brigadir/phone-validation', worktree: true });
	expect(cardTree('en', task({ status: 'queued' }))?.branch).toBe('brigadir/phone-validation');
	expect(cardTree('en', task({ worktreeBranch: 'brigadir/phone-check' }))?.branch).toBe(
		'brigadir/phone-check'
	);
});

it('an auto name shows the `brigadir/…` placeholder until the agent names the branch (spec/git#agent-branch-names)', () => {
	expect(cardTree('en', task({ launch: { ...launch, branchAuto: true } }))?.branch).toBe(
		'brigadir/…'
	);
});

it('the tree, once there, wins; other states and no isolation show no planned row', () => {
	const taskTree = { branch: 'brigadir/x', worktree: true };
	expect(cardTree('en', task({ taskTree }))).toBe(taskTree);
	expect(cardTree('en', task({ status: 'working' }))).toBeNull();
	expect(cardTree('en', task({ status: 'backlog' }))).toBeNull();
	expect(cardTree('en', task({ launch: { ...launch, isolation: 'in-place' } }))).toBeNull();
});
