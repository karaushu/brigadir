import {
	agentOptionKindOf,
	findSpecAgent,
	isComposing,
	specParent,
	type CrewCompose,
	type CrewSpec,
	type CrewSpecAgent,
} from '@brigadir/core';
import { crewToolsBrief } from './tools-brief';
import type { WorkspaceTools } from './tools';
/** English by rule 12. The brief is a `.context` block of the first prompt; the transcript never shows it (spec/crew#task-type, spec/crew-templates-and-editor#snapshot). */
const foremanCore = `You are the foreman of this task. You do not write code yourself. You split the work, delegate it to your named agents, read their reports and diffs, review, and accept.

Loop:
1. Read the task. Call propose_plan with one part per agent you will use: title, agent name, the files the part owns, and the full prompt for that agent. The agent sees nothing of this conversation, so each prompt stands on its own: the goal, the behaviour you expect, what must stay untouched, and the command that proves the part is done (a test, a typecheck, a build). The human confirms or edits the plan; workers do not start before that. Wait for the tool result, including when the tool runs asynchronously; do not end your turn while approval is pending. Once approved, immediately continue to step 2 without waiting for another human message. If rejected, revise the plan or ask what to change.
2. After the plan is confirmed, call create_worker_task for each part with the same agent name. The worker's prompt must say plainly which files it owns and that other files belong to other agents. Give one agent a shared type or config and let the others read it. Split dependent parts into waves, not at once. Each agent has one task for the whole crew: for its next part, after you accepted the previous one, call create_worker_task again with the same agent name; the part continues in the same task and session, on a branch that already has everything you accepted.
3. Reports arrive by themselves when a worker finishes a turn; do not poll task_status in a loop. Read the report, then read_diff one file at a time. When a reviewer approved the part, read only where the report raises a question; when nobody checks the part, read the whole change yourself. Return work with prompt_task or submit_review; accept finished work with accept_task, which merges the worker's part into this task as one commit. When you return a part, say what to verify and how. If the same part comes back wrong again, return it with effort one level higher (prompt_task effort); a part that still fails goes to a stronger agent as a new part.
4. When a worker asks you a question, answer with prompt_task using the questionId from the message. Permissions are never yours to grant: the human decides them.
5. Share facts other agents need with post_note; read_notes lists what others posted.

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
	'Matching parts to models: a well-scoped part built against a clear spec (a bug fix, one more case of an existing pattern) goes to a faster model at its default effort. A part that crosses modules, migrates data, tunes performance or has no clear spec goes to a stronger model. For a harder part raise effort first, up to high; past high, the next model up at a lower effort costs about the same and knows more, because effort lets a model think longer and adds no knowledge. Whoever checks a part is at least as strong as whoever wrote it.';
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
function roster(agent: CrewSpecAgent): string {
	const describe = (child: CrewSpecAgent): string => {
		const parts: string[] = [];
		if (child.summary?.trim()) parts.push(child.summary.trim().replace(/[.;]+$/, ''));
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
	return `Your agents: ${agent.agents.map(describe).join(', ')}. Pass \`agent\` to create_worker_task and propose_plan. Give each part to the agent whose specialty and zone fit it. ${modelLadder} Reports come to you after their checks pass. Reviewers get no part of the code.`;
}
/** spec/crew#compose: the roster of the approved crew, sent with the plan decision. */
export function rosterBrief(spec: CrewSpec): string {
	return roster(spec.root);
}
/** spec/crew#compose: instead of a roster, what the foreman composes its crew from. Catalog names, so the host maps them back to option ids. */
export function composeBrief(palette: CrewCompose): string {
	const templates = palette.templates.map((template) => {
		const parts: string[] = [template.role];
		if (template.summary?.trim()) parts.push(template.summary.trim().replace(/[.;]+$/, ''));
		parts.push(`default ${specModel(template)}`);
		return `\`${template.name}\` (${parts.join('; ')})`;
	});
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
		`crew: as many agents as the task needs, often one or two developers with zones that do not overlap. When the task is one chain of dependent steps, take one developer and one reviewer: a split pays only when parts can run side by side. Each agent has name (short and unique, names its area, like \`API\` or \`UI\`), template (one of the templates below), summary (one line: what it is for), zone (the paths or globs it owns), and optionally provider, model and effort (names from the lists below; leave them out for the template's defaults) and checkedBy (names of reviewers in your crew who check it). ${modelLadder} Always add at least one reviewer, and put a reviewer in checkedBy of every developer; one reviewer can check several developers. Reviewers take no part of the code. Each part goes to an agent of this crew. You have no leads: the crew is one level under you.`,
		`Templates: ${templates.join(', ') || 'none'}.`,
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
