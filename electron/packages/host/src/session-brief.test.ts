import { it, expect } from 'vitest';
import { resolveCrew, templateLookup, findSpecAgent, type CrewTemplate } from '@brigadir/core';
import {
	checklistBrief,
	commandsBrief,
	contextBrief,
	crewBrief,
	planApprovalBrief,
	sessionBrief,
	worktreeBrief,
	type CrewContext,
} from './crew';
import { toolsBrief } from '@brigadir/orchestrator';

const crew: CrewTemplate = {
	schemaVersion: 1,
	id: 'c',
	name: 'C',
	builtin: false,
	root: {
		id: 'root',
		name: 'Бригадир',
		template: 'foreman-default',
		agents: [{ id: 'dev', name: 'Розробник', template: 'developer' }],
	},
};
const spec = resolveCrew(crew, {
	lookup: templateLookup([]),
	defaultProvider: 'claude',
	defaults: () => null,
	now: '2026-10-01T10:00:00.000Z',
});
const key = { projectId: 'p', id: 't' };
const foreman: CrewContext = {
	role: 'foreman',
	crewKey: key,
	spec,
	node: spec.root,
	parent: null,
	parentKey: null,
	isRoot: true,
};
const worker: CrewContext = {
	role: 'developer',
	crewKey: key,
	spec,
	node: findSpecAgent(spec.root, 'dev')!,
	parent: spec.root,
	parentKey: key,
	isRoot: false,
};

it('gives a session without a crew the checklist sentence, Claude the plan sentence, and both the context sentence (spec/chat-turns-plans-and-questions#checklist-tools, spec/chat-turns-plans-and-questions#plan-approval, spec/agents-and-providers#context-tools)', () => {
	expect(sessionBrief(null, 'codex')).toBe(
		`${checklistBrief}\n\n${worktreeBrief}\n\n${contextBrief}`
	);
	expect(sessionBrief(null, 'claude')).toBe(
		`${checklistBrief}\n\n${worktreeBrief}\n\n${planApprovalBrief}\n\n${contextBrief}`
	);
});

it('puts the checklist, plan and context sentences after the role brief of the foreman (spec/chat-turns-plans-and-questions#checklist-tools, spec/chat-turns-plans-and-questions#plan-approval, spec/agents-and-providers#context-tools)', () => {
	const brief = sessionBrief(foreman, 'claude');
	expect(brief.startsWith(crewBrief(foreman))).toBe(true);
	expect(
		brief.endsWith(
			`\n\n${checklistBrief}\n\n${worktreeBrief}\n\n${planApprovalBrief}\n\n${contextBrief}`
		)
	).toBe(true);
	expect(
		sessionBrief(foreman, 'codex').endsWith(
			`\n\n${checklistBrief}\n\n${worktreeBrief}\n\n${contextBrief}`
		)
	).toBe(true);
});

it('gives a crew worker neither the plan nor the context sentence (spec/chat-turns-plans-and-questions#plan-approval, spec/agents-and-providers#context-tools)', () => {
	const brief = sessionBrief(worker, 'claude');
	expect(brief.startsWith(crewBrief(worker))).toBe(true);
	expect(brief.endsWith(`\n\n${checklistBrief}\n\n${worktreeBrief}`)).toBe(true);
	expect(brief).not.toContain('EnterPlanMode');
	expect(brief).not.toContain('editor_state');
});

it('points every session at the saved project commands, a crew worker too (spec/search-menus-and-commands#agent-command-tools, spec/agents-and-providers#tools-awareness)', () => {
	expect(sessionBrief(null, 'claude', { commands: true })).toBe(
		`${checklistBrief}\n\n${worktreeBrief}\n\n${planApprovalBrief}\n\n${contextBrief}\n\n${commandsBrief}`
	);
	expect(
		sessionBrief(foreman, 'claude', { commands: true }).endsWith(
			`\n\n${contextBrief}\n\n${commandsBrief}`
		)
	).toBe(true);
	expect(sessionBrief(worker, 'claude', { commands: true })).toBe(
		`${crewBrief(worker)}\n\n${checklistBrief}\n\n${worktreeBrief}\n\n${commandsBrief}`
	);
	expect(commandsBrief).toContain('Start a dev server as a project command');
});

it('tells every session, a crew worker too, not to create worktrees of its own (spec/tasks#agent-worktrees)', () => {
	for (const context of [null, foreman, worker])
		for (const provider of ['claude', 'codex'] as const)
			expect(sessionBrief(context, provider)).toContain(worktreeBrief);
	expect(worktreeBrief).toContain('git worktree add');
});

const allOn = { browser: true, simulator: true, commands: true };
it('names the tools in the brief of Codex and the CLI only, built from the modules that are on (spec/agents-and-providers#tools-awareness)', () => {
	expect(sessionBrief(null, 'claude', { tools: allOn })).not.toContain('browser_open');
	expect(sessionBrief(null, 'codex', { tools: allOn })).toBe(
		`${checklistBrief}\n\n${worktreeBrief}\n\n${contextBrief}\n\n${toolsBrief(null, allOn)}`
	);
	expect(sessionBrief(null, 'claude', { tools: allOn, cli: true })).toContain(
		toolsBrief(null, allOn)
	);
	const browserOnly = sessionBrief(null, 'codex', {
		tools: { browser: true, simulator: false, commands: false },
	});
	expect(browserOnly).toContain('browser_open');
	expect(browserOnly).not.toMatch(/simulator|commands_/);
	// spec/terminal-and-cli-agents#agent-console-tools: with every module off the brief still names the console.
	const none = { browser: false, simulator: false, commands: false };
	expect(sessionBrief(null, 'codex', { tools: none })).toBe(
		`${checklistBrief}\n\n${worktreeBrief}\n\n${contextBrief}\n\n${toolsBrief(null, none)}`
	);
	expect(toolsBrief(null, none)).toBe(
		'This app gives you the console of this task (console_list, console_read).'
	);
	expect(toolsBrief('developer', allOn)).toContain('shared with your crew');
	expect(toolsBrief(null, allOn)).not.toContain('shared with your crew');
});

// spec/agents-and-providers#tools-awareness: the whole first-prompt brief of a solo agent, a foreman and a worker, with every module on, as goldens.
it('keeps the briefs of a solo agent, a foreman and a worker as goldens (spec/agents-and-providers#tools-awareness)', async () => {
	const options = { commands: true, tools: allOn };
	await expect(sessionBrief(null, 'codex', options)).toMatchFileSnapshot(
		'../fixtures/briefs/solo-codex.txt'
	);
	await expect(sessionBrief(foreman, 'codex', options)).toMatchFileSnapshot(
		'../fixtures/briefs/foreman-codex.txt'
	);
	await expect(sessionBrief(worker, 'codex', options)).toMatchFileSnapshot(
		'../fixtures/briefs/worker-codex.txt'
	);
	await expect(sessionBrief(worker, 'claude', options)).toMatchFileSnapshot(
		'../fixtures/briefs/worker-claude.txt'
	);
});
