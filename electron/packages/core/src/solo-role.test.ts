import { expect, it } from 'vitest';
import { builtinAgentTemplates, type AgentTemplate } from './crew';
import { soloInstructions, soloRole, soloRoleChecks, soloRoleTemplates } from './solo-role';
import { isAgentTask, isTaskRole } from './workspace';
// spec/tasks#sheet-role
it('offers every template that is not a foreman, and every built-in one has a solo text', () => {
	const roles = soloRoleTemplates(builtinAgentTemplates);
	expect(roles.map((item) => item.name)).toEqual([
		'Developer',
		'Senior developer',
		'Tester',
		'Technical writer',
		'Reviewer',
		'Designer',
		'Security reviewer',
	]);
	for (const role of roles) expect(soloInstructions[role.id], role.id).toBeTruthy();
	expect(roles.filter(soloRoleChecks).map((item) => item.name)).toEqual([
		'Reviewer',
		'Designer',
		'Security reviewer',
	]);
});
// spec/tasks#agent-context
it('gives a built-in role its solo text, without the crew tools', () => {
	for (const template of soloRoleTemplates(builtinAgentTemplates)) {
		const role = soloRole(template);
		expect(isTaskRole(role)).toBe(true);
		expect(role.instructions).toContain(`alone, as ${template.name}`);
		expect(role.instructions).not.toMatch(
			/ask_foreman|read_report|read_diff|submit_review|post_note|read_notes|approve\b|other agents/
		);
		expect(role.instructions.includes('change no files')).toBe(soloRoleChecks(template));
	}
});
it('keeps the instructions of an own template and sends its crew words to the person', () => {
	const own: AgentTemplate = {
		id: 'db',
		name: 'Database expert',
		role: 'developer',
		builtin: false,
		instructions: 'You write migrations. When unsure, call ask_foreman.',
	};
	const role = soloRole(own);
	expect(role).toMatchObject({ templateId: 'db', name: 'Database expert' });
	expect(role.instructions).toContain('turn to the person instead');
	expect(role.instructions.endsWith(own.instructions)).toBe(true);
	// Nothing to redirect when the template has no text.
	expect(soloRole({ ...own, instructions: '' }).instructions).not.toContain('instructions below');
});
it('accepts a task with a role and one whose role was taken away', () => {
	const task = { id: 't1', projectId: 'p1', title: 'Docs', status: 'backlog' };
	expect(isAgentTask({ ...task, agentRole: soloRole(builtinAgentTemplates[4]!) })).toBe(true);
	expect(isAgentTask({ ...task, agentRole: null })).toBe(true);
	expect(isAgentTask({ ...task, agentRole: { templateId: 'x', name: '' } })).toBe(false);
});
