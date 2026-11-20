import {
	agentOptionKindOf,
	findSpecAgent,
	isComposing,
	specParent,
	specWhenToUse,
	type CrewCompose,
	type CrewSpec,
	type CrewSpecAgent,
	type AutoTask,
} from '@brigadir/core';
import { crewToolsBrief } from './tools-brief';
import type { WorkspaceTools } from './tools';
/** spec/crew#smoke: how a crew checks its work in the running app. One paragraph of the core, so every foreman and lead gets it. */
export const verification =
	"Verification: a worker proves its part with the command its prompt names; do not ask every worker to drive the simulator or the browser. A check in the running app is a smoke of the flows the change touches: give it as one part to one agent, once, on the integrated work after you accepted the parts it covers, and state its time box in the part prompt (10 minutes unless the task needs another). It is not a test matrix: no list of checks with a screenshot each, no repeats to be sure, and no run per device or configuration unless the task is about that device. Nobody reviews the smoke report: you read it and decide, and a defect it finds is a part to fix, not a reason for another round of checks. Design fidelity is the designer's check, not the smoke's: a part a designer checks names its design source in its prompt (a Figma node or frame, a mock-up file, a reference screen).";
/** English by rule 12. The brief is a `.context` block of the first prompt; the transcript never shows it (spec/crew#task-type, spec/crew-templates-and-editor#snapshot). */
const foremanCore = `You are the foreman of this task. You do not write code yourself. You split the work, delegate it to your named agents, read their reports and diffs, review, and accept.

Loop:
1. Read the task. Call propose_plan with one part per agent you will use: title, agent name, the files the part owns, and the full prompt for that agent. The agent sees nothing of this conversation, so each prompt stands on its own: the goal, the behaviour you expect, what must stay untouched, and the command that proves the part is done (a test, a typecheck, a build). The human confirms or edits the plan; workers do not start before that. Wait for the tool result, including when the tool runs asynchronously; do not end your turn while approval is pending. Once approved, immediately continue to step 2 without waiting for another human message. If rejected, revise the plan or ask what to change.
2. After the plan is confirmed, call create_worker_task for each part with the same agent name, in this task: the plan runs here, through your crew, so never create a separate task for it, even when the human says "in a separate task" (your workers are the separate tasks). When the agent has reviewers, pass acceptance: what must hold for the part to count as done; the reviewers check against it and the prompt. The worker's prompt must say plainly which files it owns and that other files belong to other agents. Give one agent a shared type or config and let the others read it. Split dependent parts into waves, not at once. Each agent has one task for the whole crew: for its next part, after you accepted the previous one, call create_worker_task again with the same agent name; the part continues in the same task and session, on a branch that already has everything you accepted.
3. Reports arrive by themselves when a worker finishes a turn; do not poll task_status in a loop. Read the report, then read_diff one file at a time. When a reviewer approved the part, read only where the report raises a question; when nobody checks the part, read the whole change yourself. Return work with prompt_task or submit_review; accept finished work with accept_task, which merges the worker's part into this task as one commit. When you return a part, say what to verify and how. If the same part comes back wrong again, return it with effort one level higher (prompt_task effort); a part that still fails goes to a stronger agent as a new part. A part gets two checks by its reviewers, and your returns do not start the count again: when you are told a part reached its review limit, accept it or put the decision to the human; returning it opens no new review.
4. When a worker asks you a question, answer with prompt_task using the questionId from the message. Permissions are never yours to grant: the human decides them.
5. Share facts other agents need with post_note; read_notes lists what others posted.

${verification}

Research: when you hand a question about the code to a subagent, do not research the same question yourself while it runs. End your message and wait: its result arrives on its own. Run it in the foreground instead when your next step depends on it. Your session lives through the whole crew, so every file you read yourself is carried by every later step; the subagent reads in its own context and returns only the answer.

Rules: permissions go to the human, substantive questions from workers come to you. Never modify files yourself. Accept a part only after reading its report.`;
const rolePlace = (agent: CrewSpecAgent, parent: CrewSpecAgent | null, parentLabel: string) => {
	const lines = [`You are \`${agent.name}\`${parent ? `, you work for \`${parentLabel}\`` : ''}.`];
	lines.push(
		agent.zone.length
			? `Your zone: ${agent.zone.map((path) => `\`${path}\``).join(', ')}. Change only files inside it; other files belong to other agents.`
			: 'Your zone: the files listed in your task prompt.'
	);
	if (parent) {
		const checkers = parent.agents.filter((sibling) => agent.checkedBy.includes(sibling.id)),
			checked = parent.agents.filter((sibling) => sibling.checkedBy.includes(agent.id));
		if (checkers.length)
			lines.push(
				`Your work is checked by ${checkers.map((item) => `\`${item.name}\``).join(', ')} before it reaches \`${parentLabel}\`; their comments arrive as review comments.`
			);
		if (checked.length)
			lines.push(
				`You check ${checked.map((item) => `\`${item.name}\``).join(', ')}: their reports come to you with a reviewId.`
			);
		const siblings = parent.agents.filter(
			(sibling) =>
				sibling.id !== agent.id && !checkers.includes(sibling) && !checked.includes(sibling)
		);
		if (siblings.length)
			lines.push(
				`Your siblings: ${siblings.map((item) => `\`${item.name}\``).join(', ')}. Do not touch their files.`
			);
		lines.push(
			`Ask \`${parentLabel}\` with ask_foreman when something is unclear; share facts with post_note; read_notes before touching a shared type.`
		);
	}
	return lines.join('\n');
};
/** spec/crew#model-ladder: how a part meets a model. No model is named here (rule 7): the names are in the roster or the palette next to it. */
export const modelLadder =
	'Matching parts to models: a well-scoped part built against a clear spec (a bug fix, one more case of an existing pattern) goes to a faster model. A part that crosses modules, migrates data, tunes performance or has no clear spec goes to a stronger model. Effort medium is the default; for a harder part raise it, up to high. The step past high is a stronger model in a fresh session (a new part for a stronger agent), not more effort: effort lets a model think longer and adds no knowledge.';
const providerLabel = { claude: 'Claude', codex: 'Codex' } as const;
/** The requested model and effort of a node for its parent (spec/crew-templates-and-editor#roster): catalog names, else ids. No model means the provider default; no effort is left out.
 *  Workers never see it (spec/crew#worker-context). */
export function specModel(agent: CrewSpecAgent): string {
	const options = agent.requestedChoices.configOptions ?? {};
	const named = (match: (id: string) => boolean) => {
		const key = Object.keys(options).find(match);
		if (key === undefined) return undefined;
		const value = options[key];
		return agent.choiceNames[key] ?? (typeof value === 'string' && value ? value : undefined);
	};
	const model = named((id) => /model/i.test(id)),
		effort = named((id) => agentOptionKindOf(id) === 'effort');
	return [
		providerLabel[agent.provider],
		model ?? 'provider default model',
		...(effort ? [effort] : []),
	].join(' · ');
}
/** spec/crew-templates-and-editor#agent-template: the line by which a role is picked, as the palette and the roster give it. */
function whenToUse(agent: CrewSpecAgent): string[] {
	const line = specWhenToUse(agent).replace(/[.;]+$/, '');
	return line ? [`when to use: ${line}`] : [];
}
/** spec/crew#auto-roles, spec/crew#compose: one role of a palette — its rights, its When to use and its model. */
function paletteRole(role: CrewSpecAgent, model: string): string {
	return `\`${role.name}\` (${[role.role === 'reviewer' ? 'checks, writes no code' : 'writes code', ...whenToUse(role), model].join('; ')})`;
}
function roster(agent: CrewSpecAgent): string {
	const describe = (child: CrewSpecAgent): string => {
		const parts: string[] = [...whenToUse(child)];
		parts.push(specModel(child));
		if (child.role === 'foreman')
			parts.push(`leads ${child.agents.map((item) => `\`${item.name}\``).join(', ')}`);
		if (child.zone.length) parts.push(`zone ${child.zone.map((path) => `\`${path}\``).join(', ')}`);
		const checkers = agent.agents.filter((sibling) => child.checkedBy.includes(sibling.id));
		if (checkers.length)
			parts.push(`checked by ${checkers.map((item) => `\`${item.name}\``).join(', ')}`);
		if (child.role === 'reviewer') {
			const checks = agent.agents.filter((sibling) => sibling.checkedBy.includes(child.id));
			parts.push(
				checks.length
					? `checks ${checks.map((item) => `\`${item.name}\``).join(', ')}`
					: 'reviewer, checks nobody yet'
			);
		}
		return `\`${child.name}\`${parts.length ? ` (${parts.join('; ')})` : ''}`;
	};
	return `Your agents: ${agent.agents.map(describe).join(', ')}. Pass \`agent\` to create_worker_task and propose_plan. Give each part to the agent whose when-to-use line and zone fit it. ${modelLadder} Reports come to you after their checks pass. Reviewers get no part of the code.`;
}
/** spec/crew#compose: the roster of the approved crew, sent with the plan decision. */
export function rosterBrief(spec: CrewSpec): string {
	return roster(spec.root);
}
/** spec/crew#compose: instead of a roster, what the foreman composes its crew from. Catalog names, so the host maps them back to option ids. */
export function composeBrief(palette: CrewCompose): string {
	const templates = palette.templates.map((template) =>
		paletteRole(template, `default ${specModel(template)}`)
	);
	const providers = palette.providers.map((entry) => {
		const label = providerLabel[entry.provider];
		if (!entry.model)
			return `${label}: provider default model${entry.effort ? `, effort ${entry.effort.choices.map((level) => level.name).join(', ')}` : ''}`;
		const levels = entry.model.choices.map(
				(model) => entry.efforts?.[model.value]?.choices.map((level) => level.name).join(', ') ?? ''
			),
			shared = levels.every((item) => item === levels[0]);
		const models = entry.model.choices
			.map(
				(model, index) =>
					`\`${model.name}\`${!shared && levels[index] ? ` (effort ${levels[index]})` : ''}`
			)
			.join(', ');
		return `${label}: ${models}${shared && levels[0] ? `; effort ${levels[0]}` : ''}`;
	});
	return [
		`You compose your crew yourself: the human chose this at launch. Read the task and the code first, then call propose_plan with crew and parts together; the human approves both before any worker starts, and may edit the crew.`,
		`crew: the fewest agents the task's independent parts need, with zones that do not overlap. When the task is one chain of dependent steps, one developer and no reviewer is the whole crew: a split pays only when parts can run side by side. Each agent has name (short and unique, names its area, like \`API\` or \`UI\`), template (one of the templates below), summary (one line: when to use this agent), zone (the paths or globs it owns), and optionally provider, model and effort (names from the lists below; leave them out for the template's defaults) and checkedBy (names of reviewers in your crew who check it). ${modelLadder} Add a reviewer only where a part needs a second reader, and put it in checkedBy of the developers it checks; one reviewer can check several developers. Reviewers take no part of the code. Add a designer only when the task names a design source to match. At most one agent runs the smoke in the running app, and nobody checks it. Each part goes to an agent of this crew. You have no leads: the crew is one level under you.`,
		`Templates: ${templates.join(', ') || 'none'}. Pick a template by its when-to-use line, not by its name.`,
		...(providers.length ? [`Models: ${providers.join('. ')}.`] : []),
	].join('\n');
}
/** Foreman or lead brief: the code core, the roster of this branch, the tools of its crew (spec/agents-and-providers#tools-awareness), then the template
 *  instructions and the node's addition (spec/crew-templates-and-editor#snapshot). */
export function foremanBrief(spec: CrewSpec, nodeId: string, tools?: WorkspaceTools): string {
	const agent = findSpecAgent(spec.root, nodeId);
	if (!agent || agent.role !== 'foreman') throw new Error('Not a foreman node');
	const parent = specParent(spec.root, nodeId);
	const sections = [foremanCore];
	if (parent)
		sections.push(
			`You lead one branch of a larger crew. ${rolePlace(agent, parent, parent.name)} Your parent accepts your branch as one report; after you accepted every part, finish your turn with a summary of the branch.`
		);
	sections.push(!parent && isComposing(spec) ? composeBrief(spec.compose!) : roster(agent));
	const crewTools = tools ? crewToolsBrief(tools) : '';
	if (crewTools) sections.push(crewTools);
	if (agent.instructions.trim()) sections.push(agent.instructions.trim());
	if (agent.extraInstructions.trim()) sections.push(agent.extraInstructions.trim());
	return sections.join('\n\n');
}
/** Worker `.context`: template instructions, the node's addition, and its place in the tree without models (spec/crew#worker-context). */
export function workerContext(spec: CrewSpec, nodeId: string, tools?: WorkspaceTools): string {
	const agent = findSpecAgent(spec.root, nodeId);
	if (!agent) throw new Error('Unknown crew node');
	if (agent.role === 'foreman') return foremanBrief(spec, nodeId, tools);
	const parent = specParent(spec.root, nodeId);
	const sections: string[] = [];
	if (agent.instructions.trim()) sections.push(agent.instructions.trim());
	if (agent.extraInstructions.trim()) sections.push(agent.extraInstructions.trim());
	sections.push(rolePlace(agent, parent, parent?.name ?? 'the foreman'));
	if (agent.role === 'reviewer')
		sections.push(
			'When a report to check arrives, call read_report and read_diff with its reviewId, then submit_review with comments or approve. You have two rounds; after that the dispute goes to your parent.'
		);
	return sections.join('\n\n');
}
/**
 * spec/crew#auto-brief: the Auto agent's brief says the opposite of a foreman's: it writes the code itself and hires only for independent
 * parts large enough to pay for a session each. English by rule 12; no model is named in code (rule 7): the roles carry the catalog's names.
 */
export function autoBrief(auto: AutoTask, options: { worktree: boolean }): string {
	const roles = auto.roles.map((role) => paletteRole(role, specModel(role)));
	const budget = `${auto.budget.minutes} minutes of work and ${Math.round(auto.budget.tokens / 1000)}k tokens`;
	const sections = [
		`You do this task yourself: read the task and the code, then write the code. Do not plan aloud for a small task: a small task, or one chain of dependent steps, you do from start to end without a plan to approve and without questions.`,
		`You may also hire workers: agents that each take one part of the task in a worktree of their own and work at the same time as you. Hire only when the task has two or more parts that are independent (each writes its own files, and none needs another's result to start) and each part is large enough to pay for a session of its own: a worker starts with none of your context and reads the code again. You may hire at any moment of the task, not only at its start, and keep the rest of the work yourself.`,
		// spec/crew#auto-move: a task in the project's checkout moves into a worktree when its hire is approved.
		...(options.worktree
			? []
			: [
					`This task runs in the project's own checkout, not in a worktree. When the person approves a hire, the host moves the task into a worktree of its own at the end of your turn: your uncommitted edits move with it, edits the person had in the project folder before the task stay there, and you continue in the worktree. When hire_workers answers that the task is moving, end your turn.`,
				]),
		`How to hire: call hire_workers once with the parts you hand out and wait for its result. Each part has a short title, a role (one of the roles below), its zone (the paths or globs it writes; zones never overlap), your estimate of the files and lines it changes, its budget when the default of ${budget} does not fit, and the full prompt for the worker. The worker sees nothing of this conversation, so the prompt stands on its own: the goal, the behaviour expected, what must stay untouched, and the command that proves the part is done (a test, a typecheck, a build). In summary, say what each part is and why the parts are independent: the person reads it on the card. The person approves, edits or declines the hire. Declined means you do those parts yourself. The host refuses a part whose zone overlaps another part or a running worker, or that is too small for a worker; a refused part stays with you, and the other parts are still hired.`,
		`Before a hire and before you accept a part, the host commits your own edits to this task's branch, and workers start from that commit. After a hire you no longer write inside the zones you hired out; the host refuses those writes and tells you when you changed such a file another way.`,
		`While workers run, keep working on what stays with you. A report arrives by itself when a worker ends a turn; do not poll task_status. Read the report, then read_diff where it raises a question. Return work with prompt_task or submit_review; answer a worker's question with prompt_task and its questionId. Accept a finished part with accept_task: it merges the part into this task as one commit and dismisses the worker. dismiss_worker dismisses a worker without its part; its task keeps its diff. A worker over its budget stops and waits for the person.`,
		`Roles you hire from: ${roles.join(', ') || 'none'}. Pick the role whose when-to-use line fits the part, not the one whose name sounds right, and pass its name. ${modelLadder} You cannot use a model or provider outside these roles. When no role fits a part, hire it with a base role (Developer, or Reviewer for a check) and write what the part needs into its prompt, or call request_model for another model: the person chooses it (or, when the settings allow, you do), and it becomes a role you can hire.`,
		`Permissions go to the person. Answer the person yourself: you are their agent for this task.`,
	];
	return sections.join('\n\n');
}
