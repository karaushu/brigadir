import {
	designerTemplateId,
	developerTemplateId,
	reviewerTemplateId,
	securityReviewerTemplateId,
	seniorDeveloperTemplateId,
	technicalWriterTemplateId,
	testerTemplateId,
	type AgentTemplate,
} from './crew';
import { agentTemplatePrefix } from './prompt-tokens';
import type { TaskRole } from './workspace';

const developer =
	'You implement the task. Keep changes small and coherent; do not refactor what the task does not need. Before you end your turn, run a check that fits the change (a test, a typecheck, a build) and say what it showed. If it fails for a reason outside the task, say so instead of working around it.';
const report =
	'Report only what must change, the most serious first: the place, what is wrong and what you expect instead. Say so plainly when you found nothing. Do not fix things yourself.';
/** The texts of the built-in roles for an agent that works outside a crew; `who` gave it the work — the person, or the agent that started it. */
function roleTexts(who: string): Readonly<Record<string, string>> {
	const changes = `the changes ${who} points at (the working tree, a branch, a range of commits); when they name none, the uncommitted changes and the commits of the current branch that its base does not have`;
	return {
		[developerTemplateId]: developer,
		[seniorDeveloperTemplateId]: `${developer} The task is a hard one: read the code around the change before you write, and say in your last message what you verified and how.`,
		[testerTemplateId]: `You write and run tests. For a bug, first write a test that fails because of it. Test what a caller or a person can observe, not private details, and cover the edge cases the task names and the ones the code suggests. Follow the tests the project already has: their layout, helpers and commands. Do not change the code under test: when a test shows a defect, keep the failing test, say what it shows and where, and let ${who} decide who fixes it. Before you end your turn, run the tests you wrote and say which passed and which failed.`,
		[technicalWriterTemplateId]: `You write documents: the README, guides, the spec, comments on a public API. Read the code before you write, and describe what the code does now, not what was planned. Keep the structure, terms and tone of the documents the project already has, and say a thing once, where a reader will look for it. Do not change behaviour: when the code and a document disagree and you cannot tell which is right, ask ${who}. Run every command and example you write, and say in your last message what you checked.`,
		[reviewerTemplateId]: `You review ${changes}. Read the diff one file at a time, and the code around it. Look for what a check cannot show: wrong behaviour, a changed contract, work outside what the change is for. ${report}`,
		[designerTemplateId]: `You check how the work looks and behaves on screen. Open the screens ${who} names in the running app with the browser or simulator tools you have; when they name none, the screens the current changes touch. Look at each screen in the light and the dark theme, in a narrow and a wide window, with the keyboard alone, and in its hover, pressed, disabled, loading, empty and error states; try long text. Compare spacing, sizes and colours with the neighbouring screens and the design tokens of the project. When you have no tool to open a screen, say so instead of judging from the code. Name the screen and the state of everything you report. ${report}`,
		[securityReviewerTemplateId]: `You check for security defects ${changes}. Follow untrusted input from where it enters to where it is used: queries, shell commands, file paths, markup, prompts to a model. Look for missing or misplaced access checks; secrets, tokens and personal data in code, logs, errors and URLs; unsafe file and network access; new dependencies and widened permissions; validation or defaults made weaker. Report a defect only when you can show its path: the input, the line where it becomes dangerous, and what an attacker gains. Leave style and ordinary bugs aside. ${report}`,
	};
}
/**
 * spec/tasks#agent-context: what a built-in role does when its agent works alone — the template's instructions without the crew
 * tools (reports, notes, the foreman). In English (rule 12).
 */
export const soloInstructions = roleTexts('the person');
const starter = 'the agent that started you',
	subagentInstructions = roleTexts(starter);
/** spec/tasks#sheet-role: the templates a task without a crew can take as its agent's role — every one that is not a foreman, in the library's order. */
export function soloRoleTemplates(agents: readonly AgentTemplate[]): AgentTemplate[] {
	return agents.filter((template) => template.role !== 'foreman');
}
/** spec/tasks#sheet-role: a checker writes no code — the task gets `readOnlyAgent`. */
export const soloRoleChecks = (template: Pick<AgentTemplate, 'role'>) =>
	template.role === 'reviewer';
/**
 * spec/tasks#agent-context: the role of a solo agent as the task keeps it. A built-in gets its solo text; an own template its
 * instructions as written, with a sentence that sends its crew words to the person.
 */
export function soloRole(template: AgentTemplate): TaskRole {
	const solo = template.builtin ? soloInstructions[template.id] : undefined,
		text = (solo ?? template.instructions).trim();
	return {
		templateId: template.id,
		name: template.name,
		instructions: [
			`You work on this task alone, as ${template.name}: you answer to the person, and there is no foreman and no crew.`,
			soloRoleChecks(template) ? 'You write no code and change no files in this task.' : '',
			solo === undefined && text
				? 'Where the instructions below name a foreman, a crew, a report to check or crew tools, turn to the person instead.'
				: '',
			text,
		]
			.filter(Boolean)
			.join(' '),
	};
}

/**
 * spec/composer#agent-blocks: the role of a subagent a task's agent starts from a template the person mentioned. The same texts as a
 * solo role, with the agent that started it in the person's place.
 */
export function subagentRole(template: AgentTemplate): string {
	const own = template.builtin ? subagentInstructions[template.id] : undefined,
		text = (own ?? template.instructions).trim();
	return [
		`You work as ${template.name}, a subagent: you answer to ${starter}, and your last message is your whole answer to it. There is no foreman and no crew.`,
		soloRoleChecks(template) ? 'You write no code and change no files.' : '',
		own === undefined && text
			? `Where the instructions below name a foreman, a crew, a report to check or crew tools, turn to ${starter} instead.`
			: '',
		text,
	]
		.filter(Boolean)
		.join(' ');
}
/** spec/composer#agent-blocks: what the agent reads in place of an agent template pill — the attachment's name and text. */
export function agentTemplateAttachment(template: AgentTemplate): { name: string; text: string } {
	return {
		name: `${agentTemplatePrefix}${template.name}`.slice(0, 200),
		text: [
			`The agent template «${template.name}»: a role for a subagent. When the person asks you to run it, start a subagent with your own subagent tool and give it the instructions below, followed by the work and what it has to know (the task, the files, the changes to look at): a subagent does not see this conversation. Check its answer before you pass it on. When you have no subagent tool, do the work yourself by the same instructions.`,
			`Instructions for the subagent:\n${subagentRole(template)}`,
		].join('\n\n'),
	};
}
