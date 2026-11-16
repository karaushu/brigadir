import { isId, isRecord } from './workspace';
import type { AgentProvider } from './agent';
import { t, type Locale, type MessageKey } from './messages';
/** spec/crew-templates-and-editor#model crew tree as data. Agent templates, crew templates and the immutable CrewSpec snapshot a task stores (spec/crew-templates-and-editor#resolution-contract). */
export const crewRoles = ['foreman', 'developer', 'reviewer'] as const;
export type CrewRole = (typeof crewRoles)[number];
/** Provider launch choices: option ids and values from the provider catalog (`session/new`), never our own model table (rule 7). */
export type CrewChoices = { modeId?: string; configOptions?: Record<string, string | boolean> };
export type AgentTemplate = {
	id: string;
	name: string;
	role: CrewRole;
	provider?: AgentProvider;
	choices?: CrewChoices;
	choiceNames?: Record<string, string>;
	summary?: string;
	instructions: string;
	builtin: boolean;
};
export type CrewLeafDraft = {
	template: string | null;
	provider?: AgentProvider;
	choices?: CrewChoices;
	choiceNames?: Record<string, string>;
};
export type CrewAgent = {
	id: string;
	name: string;
	template: string | null;
	provider?: AgentProvider;
	choices?: CrewChoices;
	choiceNames?: Record<string, string>;
	summary?: string;
	zone?: string[];
	extraInstructions?: string;
	agents?: CrewAgent[];
	checkedBy?: string[];
	leafDraft?: CrewLeafDraft;
};
export type CrewTemplate = {
	schemaVersion: 1;
	id: string;
	name: string;
	builtin: boolean;
	root: CrewAgent;
};
/** Resolved node: every reference expanded, nothing read from the library later (spec/crew-templates-and-editor#snapshot). */
export type CrewSpecAgent = {
	id: string;
	name: string;
	/** spec/crew#compose: the library template the node came from, so the editor can open a resolved crew again. */ template?: string;
	role: CrewRole;
	provider: AgentProvider;
	requestedChoices: CrewChoices;
	choiceNames: Record<string, string>;
	/** spec/crew-templates-and-editor#roster; older snapshots have none. */ summary?: string;
	instructions: string;
	extraInstructions: string;
	zone: string[];
	checkedBy: string[];
	agents: CrewSpecAgent[];
};
export type CrewSpec = {
	schemaVersion: 1;
	templateId: string | null;
	name: string;
	resolvedAt: string;
	root: CrewSpecAgent;
	/** spec/crew#compose: while present and the root has no agents, the foreman proposes the crew in its plan. */ compose?: CrewCompose;
};
/** spec/crew#compose palette snapshot: what the foreman composes from. Library templates resolved as nodes, and each provider's models with their effort levels (rule 7: ids and names from the catalog). */
export type CrewComposeOption = { id: string; choices: { value: string; name: string }[] };
export type CrewComposeProvider = {
	provider: AgentProvider;
	model?: CrewComposeOption;
	/** Effort levels of the provider's default model. */ effort?: CrewComposeOption;
	/** Effort option of each model value (spec/agents-and-providers#catalog). */ efforts?: Record<
		string,
		CrewComposeOption
	>;
};
export type CrewCompose = { templates: CrewSpecAgent[]; providers: CrewComposeProvider[] };
export type AgentTemplateDocument = { schemaVersion: 1; template: AgentTemplate };
export type CrewTemplateDocument = { schemaVersion: 1; template: CrewTemplate };

/** spec/crew-templates-and-editor#roster: the specialty is one line the parent reads in the crew roster. */
export const crewSummaryLimit = 240;
export const crewNameLimit = 80,
	crewInstructionsLimit = 100_000,
	crewZoneLimit = 256,
	crewZonePathLimit = 1024,
	crewAgentsPerNodeLimit = 64,
	crewNodeLimit = 256;
/** Design recommendation, not domain: the editor warns beyond two levels under the foreman (spec/crew#subordinates). */
export const crewRecommendedDepth = 2;
export const foremanTemplateId = 'foreman-default',
	developerTemplateId = 'developer',
	reviewerTemplateId = 'reviewer',
	seniorDeveloperTemplateId = 'senior-developer',
	testerTemplateId = 'tester',
	technicalWriterTemplateId = 'technical-writer',
	designerTemplateId = 'designer',
	securityReviewerTemplateId = 'security-reviewer';
/** spec/crew-templates-and-editor#unshipped-crew-ids: crew ids the app does not ship that data on disk may still name. Not reserved: a person's edit moves to an own crew under the same id. */
export const unshippedCrewTemplateIds: readonly string[] = ['default', 'tests'];
/** spec/pull-requests-and-ci#review-crew: the built-in crew of a PR review — the foreman merges what two reviewers of different providers found. */
export const reviewCrewTemplateId = 'review';
/** spec/crew#compose: the template id of a crew snapshot that carries a palette, and of a stored launch that runs as `Auto`. */
export const composeCrewId = 'compose';
/** spec/tasks#sheet-rail: the `Crew` popup's first item, `Auto` (spec/crew#auto); a launch names it like a crew id. */
export const autoCrewId = 'auto';

const developerInstructions =
	'You implement your part of the work. You own the listed files and directories: change only them, other files belong to other agents. Read anything you need across the project. Keep changes small and coherent; do not refactor outside your zone. Before touching a shared type or contract, call read_notes; after changing one, call post_note with the fact others need. When something in your task is unclear, call ask_foreman instead of guessing. Before you end your turn, run the check your task prompt names (a test, a typecheck, a build) and say what it showed. If it fails for a reason outside your files, say so instead of working around it. Do not commit; the host snapshots your tree.';
/** spec/crew-templates-and-editor#builtin-templates: the check is against the design source, node by node, with evidence from the running app (spec/crew#smoke). */
const designerInstructions = [
	'You do not write code. You check that the changed screens match their design. The design source is named in the part prompt or the plan: a Figma node or frame, a mock-up file, or a reference screen. When none is named, your first step is to ask the foreman for it with ask_foreman; do not judge from neighbouring screens instead.',
	'When the report of an agent you check arrives, read it with read_report and its diff with read_diff. Open the design source with the tool it needs, then open the changed screen in the running app with the browser or simulator tools you have.',
	'For each design node of the changed screen, fill one table: node, property, expected from the design, found in the app, screenshot. The properties are size; padding and gaps; corner radius; border; colour or token; typography (font, size, weight, line height); icon and its size; states. List the icons one by one, each in its own row. The light and the dark theme, the hover, pressed, focus, disabled, loading, empty and error states, keyboard use and long text are rows of the same table wherever the design or the change has them. Every row names the screenshot you took for it in the app, cropped to the node where the tool allows it; rows of one node in one state may share a screenshot. Write the table in your message before you call submit_review or approve.',
	'Never approve from the code alone, and never without having opened the screen and the design. When you have no tool to open either of them, say so to the foreman with ask_foreman and do not approve.',
	'Use the tools economically. simulator_act and browser_act already wait for the screen and report what changed: do not sleep, take a screenshot or read the tree again to check that an action worked, and use simulator_wait for what comes later. Read sizes and positions from the boxes of browser_ui and simulator_ui; take screenshots for the rows of the table, not to find your way. Read each design node once and keep what it says.',
	'Comment only on what must change before the part is accepted, because every round runs the agent again. Each comment names the node, the property, what the design expects and what you found; send the comments with submit_review, pointing at the line that sets the property. Call approve when every row matches. Do not fix things yourself.',
].join('\n\n');
export const builtinAgentTemplates: readonly AgentTemplate[] = [
	{ id: foremanTemplateId, name: 'Foreman', role: 'foreman', instructions: '', builtin: true },
	{
		id: developerTemplateId,
		name: 'Developer',
		role: 'developer',
		builtin: true,
		instructions: developerInstructions,
	},
	/** spec/crew-templates-and-editor#builtin-templates: a Developer on a stronger model, for the parts the model ladder sends up (spec/crew#model-ladder). */
	{
		id: seniorDeveloperTemplateId,
		name: 'Senior developer',
		role: 'developer',
		builtin: true,
		provider: 'claude',
		choices: { configOptions: { model: 'opus', effort: 'high' } },
		choiceNames: { model: 'Opus', effort: 'High' },
		summary: 'Migrations, performance work, cross-module refactors and parts without a clear spec',
		instructions: `${developerInstructions} Your parts are the hard ones: read the code around the change before you write, and say in your last message what you verified and how.`,
	},
	/** spec/crew-templates-and-editor#builtin-templates: the specialists are a Developer or a Reviewer with their own instructions and specialty. */
	{
		id: testerTemplateId,
		name: 'Tester',
		role: 'developer',
		builtin: true,
		provider: 'claude',
		choices: { configOptions: { model: 'sonnet' } },
		choiceNames: { model: 'Sonnet' },
		summary:
			'Automated tests for a part: unit and integration tests, a failing test for a bug; changes no production code; not a manual check of the running app',
		instructions:
			'You write and run the automated tests of your part. You own the listed test files and directories: change only them, other files belong to other agents. Read anything you need across the project. For a bug, first write a test that fails because of it. Test what a caller or a person can observe, not private details, and cover the edge cases the task names and the ones the code suggests. Follow the tests the project already has: their layout, helpers and commands. Do not change the code under test: when a test shows a defect, keep the failing test and say what it shows and where, so the agent that owns the code can fix it. Before touching a shared type or contract, call read_notes; after changing one, call post_note with the fact others need. When something in your task is unclear, call ask_foreman instead of guessing. Before you end your turn, run the tests you wrote and say which passed and which failed. Do not commit; the host snapshots your tree. Checking the running app by hand is a different job: it is not yours unless your prompt asks for it. When it does, it is a smoke: go once through the flows the change touches, within the time your prompt states (10 minutes when it states none), with no matrix of checks or devices and no repeats to be sure; then report what you found and stop.',
	},
	{
		id: technicalWriterTemplateId,
		name: 'Technical writer',
		role: 'developer',
		builtin: true,
		provider: 'claude',
		choices: { configOptions: { model: 'sonnet' } },
		choiceNames: { model: 'Sonnet' },
		summary:
			'Documentation for a change: README, guides, the spec, API comments; changes no behaviour',
		instructions:
			'You write the documents of a change: the README, guides, the spec, comments on a public API. You own the listed files and directories: change only them, other files belong to other agents. Read the code and its diff before you write, and describe what the code does now, not what was planned. Keep the structure, terms and tone of the documents the project already has, and say a thing once, where a reader will look for it. Do not change behaviour: when the code and a document disagree and you cannot tell which is right, call ask_foreman. Run every command and example you write. Before you end your turn, run the check your task prompt names, when it names one, and say what it showed. Do not commit; the host snapshots your tree.',
	},
	{
		id: reviewerTemplateId,
		name: 'Reviewer',
		role: 'reviewer',
		builtin: true,
		instructions:
			'You do not write code. When the report of an agent you check arrives, read it with read_report and read its diff one file at a time with read_diff. Look for what a check cannot show: wrong behaviour, a contract changed under other agents, work outside the assigned files. The report ends with the last message of the agent; a report that names no check is not a defect by itself: when you doubt, check it yourself with commands that change no files (the project tests or type check, a short script that calls the changed code). Comment only on something wrong in the change, with its evidence, that must change before the part is accepted, because every round runs the agent again. Send review comments with submit_review: point at the line, say what is wrong and what you expect instead. Call approve when nothing is left. Do not fix things yourself.',
	},
	{
		id: designerTemplateId,
		name: 'Designer',
		role: 'reviewer',
		builtin: true,
		summary:
			'Checks changed screens against the design source (Figma node, mock-up, reference screen), node by node, in the running app',
		instructions: designerInstructions,
	},
	{
		id: securityReviewerTemplateId,
		name: 'Security reviewer',
		role: 'reviewer',
		builtin: true,
		provider: 'claude',
		choices: { configOptions: { model: 'opus', effort: 'high' } },
		choiceNames: { model: 'Opus', effort: 'High' },
		summary: 'Checks changes for security defects: untrusted input, access checks, secrets',
		instructions:
			'You do not write code. You check the work for security defects. When the report of an agent you check arrives, read it with read_report and read its diff one file at a time with read_diff. Follow untrusted input from where it enters to where it is used: queries, shell commands, file paths, markup, prompts to a model. Look for missing or misplaced access checks; secrets, tokens and personal data in code, logs, errors and URLs; unsafe file and network access; new dependencies and widened permissions; validation or defaults made weaker. Report a defect only when you can show its path: the input, the line where it becomes dangerous, and what an attacker gains. Leave style and ordinary bugs to other reviewers. Comment only on what must change before the part is accepted, because every round runs the agent again. Send review comments with submit_review: point at the line and say what you expect instead. Call approve when nothing is left. Do not fix things yourself.',
	},
];
/** spec/crew-templates-and-editor#builtin-templates: the starter tree of «New crew» and the intro; not a library crew. */
export const starterCrewTemplate: CrewTemplate = {
	schemaVersion: 1,
	id: 'starter',
	name: 'Crew',
	builtin: false,
	root: {
		id: 'root',
		name: 'Foreman',
		template: foremanTemplateId,
		agents: [
			{
				id: 'developer-1',
				name: 'Developer 1',
				template: developerTemplateId,
				checkedBy: ['reviewer'],
			},
			{
				id: 'developer-2',
				name: 'Developer 2',
				template: developerTemplateId,
				checkedBy: ['reviewer'],
			},
			{ id: 'reviewer', name: 'Reviewer', template: reviewerTemplateId },
		],
	},
};
/** spec/crew-templates-and-editor#builtin-templates: the only built-in crew is the PR review crew; a crew of developers is composed by the foreman after it read the task (spec/crew#compose). */
export const builtinCrewTemplates: readonly CrewTemplate[] = [
	{
		schemaVersion: 1,
		id: reviewCrewTemplateId,
		name: 'Review crew',
		builtin: true,
		root: {
			id: 'root',
			name: 'Foreman',
			template: foremanTemplateId,
			agents: [
				{
					id: 'astra',
					name: 'Astra',
					template: reviewerTemplateId,
					provider: 'codex',
					choices: { configOptions: { model: 'gpt-6-astra', reasoning_effort: 'high' } },
					choiceNames: { model: '6 Astra', reasoning_effort: 'High' },
				},
				{
					id: 'opus',
					name: 'Opus',
					template: reviewerTemplateId,
					provider: 'claude',
					choices: { configOptions: { model: 'opus', effort: 'high' } },
					choiceNames: { model: 'Opus', effort: 'High' },
				},
			],
		},
	},
];
/**
 * spec/crew-templates-and-editor#unshipped-crew-ids: what a stored launch runs as. A crew id the app no longer ships, that no own crew took
 * over, and a launch that asked the foreman to compose its crew both run as `Auto`.
 */
export function unshippedCrewLaunch(
	launch: CrewLaunch,
	crews: readonly { id: string }[]
): CrewLaunch {
	if ('compose' in launch) return { auto: true };
	return 'templateId' in launch &&
		(launch.templateId === composeCrewId ||
			launch.templateId === autoCrewId ||
			(unshippedCrewTemplateIds.includes(launch.templateId) &&
				!crews.some((item) => item.id === launch.templateId)))
		? { auto: true }
		: launch;
}
/** spec/tasks#sheet-rail, spec/pull-requests-and-ci#review-crew: the sheet's crew for a task's own crew id (an edit or a duplicate); a crew that left the
 *  library (deleted, hidden, or one the app no longer ships) gives way to `Auto`. */
export function rememberedCrewId(id: string | undefined, crews: readonly { id: string }[]): string {
	return id && id !== composeCrewId && crews.some((item) => item.id === id) ? id : autoCrewId;
}
export function isBuiltinTemplateId(id: string) {
	return (
		id === composeCrewId ||
		id === autoCrewId ||
		builtinAgentTemplates.some((item) => item.id === id) ||
		builtinCrewTemplates.some((item) => item.id === id)
	);
}

const text = (value: unknown, limit: number): value is string =>
	typeof value === 'string' && value.length <= limit && !value.includes('\0');
/** One line without control characters: it goes into the roster inline. */
export function isCrewSummary(value: unknown): value is string {
	return typeof value === 'string' && value.length <= crewSummaryLimit && !/[\r\n\0]/.test(value);
}
const names = (value: unknown): value is Record<string, string> =>
	isRecord(value) &&
	Object.keys(value).length <= 64 &&
	Object.entries(value).every(
		([key, name]) =>
			key.length > 0 && key.length <= 200 && typeof name === 'string' && name.length <= 200
	);
export function isCrewChoices(value: unknown): value is CrewChoices {
	return (
		isRecord(value) &&
		Object.keys(value).every((key) => key === 'modeId' || key === 'configOptions') &&
		(value.modeId === undefined ||
			(typeof value.modeId === 'string' &&
				value.modeId.length > 0 &&
				value.modeId.length <= 200)) &&
		(value.configOptions === undefined ||
			(isRecord(value.configOptions) &&
				Object.keys(value.configOptions).length <= 64 &&
				Object.entries(value.configOptions).every(
					([key, option]) =>
						key.length > 0 &&
						key.length <= 200 &&
						(typeof option === 'boolean' || (typeof option === 'string' && option.length <= 1000))
				)))
	);
}
/** Names compare after trim and Unicode NFC (spec/crew-templates-and-editor#resolution-contract). */
export function crewName(value: string) {
	return value.trim().normalize('NFC');
}
export function isCrewName(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		crewName(value).length > 0 &&
		value.length <= crewNameLimit &&
		!/[\r\n\0]/.test(value)
	);
}
export function isAgentTemplate(value: unknown): value is AgentTemplate {
	return (
		isRecord(value) &&
		isId(value.id) &&
		isCrewName(value.name) &&
		crewRoles.includes(value.role as CrewRole) &&
		(value.provider === undefined || value.provider === 'claude' || value.provider === 'codex') &&
		(value.choices === undefined || isCrewChoices(value.choices)) &&
		(value.choiceNames === undefined || names(value.choiceNames)) &&
		(value.summary === undefined || isCrewSummary(value.summary)) &&
		text(value.instructions, crewInstructionsLimit) &&
		typeof value.builtin === 'boolean' &&
		Object.keys(value).every((key) =>
			[
				'id',
				'name',
				'role',
				'provider',
				'choices',
				'choiceNames',
				'summary',
				'instructions',
				'builtin',
			].includes(key)
		)
	);
}
/** Zone paths are project-relative POSIX paths, optionally ending in a glob (`**`, `*`). */
export function normalizeZonePath(value: string): string | null {
	if (typeof value !== 'string' || value.includes('\0') || value.length > crewZonePathLimit)
		return null;
	let path = value.trim().replace(/\\/g, '/').replace(/\/+/g, '/');
	while (path.startsWith('./')) path = path.slice(2);
	path = path.replace(/^\/+/, '').replace(/\/+$/, '');
	if (!path || path === '.') return null;
	const segments = path.split('/');
	if (segments.some((segment) => segment === '' || segment === '.' || segment === '..'))
		return null;
	return path;
}
/** Directory prefix a zone entry owns: globs strip to their static prefix. */
export function zonePrefix(path: string): string {
	const index = path.search(/[*?[{]/);
	if (index < 0) return path;
	const prefix = path.slice(0, index).replace(/\/+$/, '');
	return prefix;
}
/** `parent` covers `child` when the child's static prefix lies inside one of the parent's entries. An empty parent zone is the whole project. */
export function zoneCovers(parent: readonly string[], child: string): boolean {
	if (!parent.length) return true;
	const target = zonePrefix(child);
	return parent.some((entry) => {
		const prefix = zonePrefix(entry);
		return prefix === '' || target === prefix || target.startsWith(`${prefix}/`);
	});
}
/** A file path (no globs) is inside the zone. */
export function zoneOwns(zone: readonly string[], path: string): boolean {
	const normalized = normalizeZonePath(path);
	if (!normalized) return false;
	return zoneCovers(zone, normalized);
}
function isZone(value: unknown): value is string[] {
	return (
		Array.isArray(value) &&
		value.length <= crewZoneLimit &&
		value.every((entry) => typeof entry === 'string' && normalizeZonePath(entry) !== null)
	);
}
function isLeafDraft(value: unknown): value is CrewLeafDraft {
	return (
		isRecord(value) &&
		(value.template === null || isId(value.template)) &&
		(value.provider === undefined || value.provider === 'claude' || value.provider === 'codex') &&
		(value.choices === undefined || isCrewChoices(value.choices)) &&
		(value.choiceNames === undefined || names(value.choiceNames)) &&
		Object.keys(value).every((key) =>
			['template', 'provider', 'choices', 'choiceNames'].includes(key)
		)
	);
}
function isCrewAgentShape(
	value: unknown,
	depth: number,
	count: { nodes: number }
): value is CrewAgent {
	if (depth > 32 || !isRecord(value) || ++count.nodes > crewNodeLimit) return false;
	return (
		isId(value.id) &&
		isCrewName(value.name) &&
		(value.template === null || isId(value.template)) &&
		(value.provider === undefined || value.provider === 'claude' || value.provider === 'codex') &&
		(value.choices === undefined || isCrewChoices(value.choices)) &&
		(value.choiceNames === undefined || names(value.choiceNames)) &&
		(value.summary === undefined || isCrewSummary(value.summary)) &&
		(value.zone === undefined || isZone(value.zone)) &&
		(value.extraInstructions === undefined ||
			text(value.extraInstructions, crewInstructionsLimit)) &&
		(value.checkedBy === undefined ||
			(Array.isArray(value.checkedBy) &&
				value.checkedBy.length <= crewAgentsPerNodeLimit &&
				value.checkedBy.every(isId))) &&
		(value.leafDraft === undefined || isLeafDraft(value.leafDraft)) &&
		(value.agents === undefined ||
			(Array.isArray(value.agents) &&
				value.agents.length <= crewAgentsPerNodeLimit &&
				value.agents.every((agent) => isCrewAgentShape(agent, depth + 1, count)))) &&
		Object.keys(value).every((key) =>
			[
				'id',
				'name',
				'template',
				'provider',
				'choices',
				'choiceNames',
				'summary',
				'zone',
				'extraInstructions',
				'agents',
				'checkedBy',
				'leafDraft',
			].includes(key)
		)
	);
}
export function isCrewAgent(value: unknown): value is CrewAgent {
	return isCrewAgentShape(value, 0, { nodes: 0 });
}
/** Structural check of a template document. Semantic rules (roles, edges, zones) are `crewIssues`. */
export function isCrewTemplate(value: unknown): value is CrewTemplate {
	return (
		isRecord(value) &&
		value.schemaVersion === 1 &&
		isId(value.id) &&
		isCrewName(value.name) &&
		typeof value.builtin === 'boolean' &&
		isCrewAgent(value.root) &&
		Object.keys(value).every((key) =>
			['schemaVersion', 'id', 'name', 'builtin', 'root'].includes(key)
		)
	);
}
export function crewAgents(root: CrewAgent): CrewAgent[] {
	return [root, ...(root.agents ?? []).flatMap(crewAgents)];
}
export function findCrewAgent(root: CrewAgent, id: string): CrewAgent | null {
	return crewAgents(root).find((agent) => agent.id === id) ?? null;
}
export function crewParent(root: CrewAgent, id: string): CrewAgent | null {
	for (const agent of crewAgents(root))
		if (agent.agents?.some((child) => child.id === id)) return agent;
	return null;
}
/** Agents below the foreman, excluding the root. */
export function crewAgentCount(root: CrewAgent) {
	return crewAgents(root).length - 1;
}
export function crewDepth(root: CrewAgent): number {
	return root.agents?.length ? 1 + Math.max(...root.agents.map(crewDepth)) : 0;
}
export type CrewTemplateLookup = (id: string) => AgentTemplate | undefined;
export function templateLookup(templates: readonly AgentTemplate[]): CrewTemplateLookup {
	const map = new Map(
		[...builtinAgentTemplates, ...templates].map((item) => [item.id, item] as const)
	);
	return (id) => map.get(id);
}
/** The role a node takes: any children make it a foreman of its branch (spec/crew#subordinates); a missing template means a developer. */
export function crewAgentRole(
	agent: CrewAgent,
	lookup: CrewTemplateLookup,
	isRoot = false
): CrewRole {
	if (isRoot || agent.agents?.length) return 'foreman';
	return agent.template === null ? 'developer' : (lookup(agent.template)?.role ?? 'developer');
}
export type CrewIssue = {
	agentId: string | null;
	code:
		| 'duplicate_id'
		| 'duplicate_name'
		| 'unknown_template'
		| 'unknown_checker'
		| 'self_check'
		| 'duplicate_check'
		| 'checker_not_reviewer'
		| 'checked_not_developer'
		| 'reviewer_with_agents'
		| 'zone_outside_parent'
		| 'root_checked';
	/** The agent name (or id for `duplicate_id`) the issue is about, for the localized text (spec/notifications-slack-notes-and-schedules#message-classes). */
	subject: string;
	/** English, for logs and main's errors; the UI words it by `code` and `subject`. */
	message: string;
};
// spec/notifications-slack-notes-and-schedules#message-classes: the crew editor names the rule and the agent, never the English `message` of crewIssues.
const crewIssueKeys: Record<CrewIssue['code'], MessageKey> = {
	root_checked: 'The foreman cannot be checked.',
	duplicate_id: 'Two agents have the same id: {name}.',
	duplicate_name: 'Two agents have the same name: {name}.',
	unknown_template: 'The agent template is not found: {name}.',
	zone_outside_parent: 'The zone goes beyond the zone of the agent above: {name}.',
	reviewer_with_agents: 'A reviewer cannot have subordinates: {name}.',
	self_check: 'An agent cannot check itself: {name}.',
	duplicate_check: 'The same checker is added twice: {name}.',
	unknown_checker: 'The checker is not under the same lead: {name}.',
	checker_not_reviewer: 'Only a reviewer can check: {name}.',
	checked_not_developer: 'Only a developer can be checked: {name}.',
};
export function crewIssueText(locale: Locale, issue: CrewIssue): string {
	return t(locale, crewIssueKeys[issue.code]).replace('{name}', issue.subject);
}
/** Semantic rules of spec/crew-templates-and-editor#resolution-contract. Empty means the template can be resolved. */
export function crewIssues(template: CrewTemplate, lookup: CrewTemplateLookup): CrewIssue[] {
	const issues: CrewIssue[] = [],
		ids = new Set<string>(),
		seenNames = new Set<string>();
	if (template.root.checkedBy?.length)
		issues.push({
			agentId: template.root.id,
			code: 'root_checked',
			subject: crewName(template.root.name),
			message: 'The foreman cannot be checked.',
		});
	for (const agent of crewAgents(template.root)) {
		if (ids.has(agent.id))
			issues.push({
				agentId: agent.id,
				code: 'duplicate_id',
				subject: agent.id,
				message: `Duplicate agent id ${agent.id}.`,
			});
		ids.add(agent.id);
		const name = crewName(agent.name);
		if (seenNames.has(name))
			issues.push({
				agentId: agent.id,
				code: 'duplicate_name',
				subject: name,
				message: `Duplicate agent name ${name}.`,
			});
		seenNames.add(name);
		if (agent.template !== null && !lookup(agent.template))
			issues.push({
				agentId: agent.id,
				code: 'unknown_template',
				subject: name,
				message: `Unknown agent template ${agent.template}.`,
			});
	}
	const visit = (agent: CrewAgent, parentZone: string[], isRoot: boolean) => {
		const zone = agent.zone?.length
			? agent.zone.map((entry) => normalizeZonePath(entry)!)
			: parentZone;
		if (
			agent.zone?.length &&
			!agent.zone.every((entry) => zoneCovers(parentZone, normalizeZonePath(entry)!))
		)
			issues.push({
				agentId: agent.id,
				code: 'zone_outside_parent',
				subject: crewName(agent.name),
				message: `The zone of ${crewName(agent.name)} is outside its parent's zone.`,
			});
		if (
			!isRoot &&
			agent.agents?.length &&
			agent.template !== null &&
			lookup(agent.template)?.role === 'reviewer'
		)
			issues.push({
				agentId: agent.id,
				code: 'reviewer_with_agents',
				subject: crewName(agent.name),
				message: `A reviewer cannot have agents: ${crewName(agent.name)}.`,
			});
		const children = agent.agents ?? [];
		for (const child of children) {
			const seen = new Set<string>();
			for (const checker of child.checkedBy ?? []) {
				if (checker === child.id) {
					issues.push({
						agentId: child.id,
						code: 'self_check',
						subject: crewName(child.name),
						message: `${crewName(child.name)} cannot check itself.`,
					});
					continue;
				}
				if (seen.has(checker)) {
					issues.push({
						agentId: child.id,
						code: 'duplicate_check',
						subject: crewName(child.name),
						message: `Duplicate checker on ${crewName(child.name)}.`,
					});
					continue;
				}
				seen.add(checker);
				const sibling = children.find((item) => item.id === checker);
				if (!sibling) {
					issues.push({
						agentId: child.id,
						code: 'unknown_checker',
						subject: crewName(child.name),
						message: `${crewName(child.name)} is checked by an unknown agent.`,
					});
					continue;
				}
				if (crewAgentRole(sibling, lookup) !== 'reviewer')
					issues.push({
						agentId: child.id,
						code: 'checker_not_reviewer',
						subject: crewName(sibling.name),
						message: `${crewName(sibling.name)} is not a reviewer.`,
					});
				if (crewAgentRole(child, lookup) !== 'developer')
					issues.push({
						agentId: child.id,
						code: 'checked_not_developer',
						subject: crewName(child.name),
						message: `Only a developer can be checked: ${crewName(child.name)}.`,
					});
			}
			visit(child, zone, false);
		}
	};
	visit(template.root, [], true);
	return issues;
}
export type CrewDefaults = (
	provider: AgentProvider
) => { choices?: CrewChoices; choiceNames?: Record<string, string> } | null;
export type ResolveContext = {
	lookup: CrewTemplateLookup;
	defaultProvider: AgentProvider;
	defaults?: CrewDefaults;
	now?: string;
};
function mergeChoices(...layers: (CrewChoices | undefined)[]): CrewChoices {
	const result: CrewChoices = {};
	for (const layer of layers) {
		if (!layer) continue;
		if (layer.modeId !== undefined) result.modeId = layer.modeId;
		if (layer.configOptions)
			result.configOptions = { ...result.configOptions, ...layer.configOptions };
	}
	return result;
}
/** Resolve order: project defaults for the chosen provider, template, node overrides (spec/crew-templates-and-editor#resolution-contract). A node that changes the template's provider drops the template's choices. */
export function resolveCrewAgent(
	agent: CrewAgent,
	context: ResolveContext,
	parentZone: string[] = [],
	isRoot = true
): CrewSpecAgent {
	const template = agent.template === null ? undefined : context.lookup(agent.template);
	const templateProvider = template?.provider ?? context.defaultProvider;
	const provider = agent.provider ?? templateProvider;
	const keepTemplateChoices = provider === templateProvider;
	const defaults = context.defaults?.(provider) ?? null;
	const requestedChoices = mergeChoices(
		defaults?.choices,
		keepTemplateChoices ? template?.choices : undefined,
		agent.choices
	);
	const choiceNames = {
		...defaults?.choiceNames,
		...(keepTemplateChoices ? template?.choiceNames : {}),
		...agent.choiceNames,
	};
	const zone = agent.zone?.length
		? agent.zone.map((entry) => normalizeZonePath(entry)!)
		: parentZone;
	return {
		id: agent.id,
		name: crewName(agent.name),
		...(agent.template !== null ? { template: agent.template } : {}),
		role: crewAgentRole(agent, context.lookup, isRoot),
		provider,
		requestedChoices,
		choiceNames,
		summary: crewSummary(agent, context.lookup),
		instructions: template?.instructions ?? '',
		extraInstructions: agent.extraInstructions ?? '',
		zone,
		checkedBy: [...(agent.checkedBy ?? [])],
		agents: (agent.agents ?? []).map((child) => resolveCrewAgent(child, context, zone, false)),
	};
}
/** Node specialty, else the template's (spec/crew-templates-and-editor#roster). Trimmed: an empty field inherits. */
export function crewSummary(agent: CrewAgent, lookup: CrewTemplateLookup): string {
	return (
		agent.summary?.trim() ||
		(agent.template === null ? '' : lookup(agent.template)?.summary?.trim()) ||
		''
	);
}
export function resolveCrew(template: CrewTemplate, context: ResolveContext): CrewSpec {
	if (!isCrewTemplate(template)) throw new Error('Invalid crew template');
	const issues = crewIssues(template, context.lookup);
	if (issues.length) throw new Error(issues[0]!.message);
	return {
		schemaVersion: 1,
		templateId: template.id,
		name: crewName(template.name),
		resolvedAt: context.now ?? new Date().toISOString(),
		root: resolveCrewAgent(template.root, context),
	};
}
function isSpecAgentShape(
	value: unknown,
	depth: number,
	count: { nodes: number }
): value is CrewSpecAgent {
	if (depth > 32 || !isRecord(value) || ++count.nodes > crewNodeLimit) return false;
	return (
		isId(value.id) &&
		isCrewName(value.name) &&
		(value.template === undefined || isId(value.template)) &&
		crewRoles.includes(value.role as CrewRole) &&
		(value.provider === 'claude' || value.provider === 'codex') &&
		isCrewChoices(value.requestedChoices) &&
		names(value.choiceNames) &&
		(value.summary === undefined || isCrewSummary(value.summary)) &&
		text(value.instructions, crewInstructionsLimit) &&
		text(value.extraInstructions, crewInstructionsLimit) &&
		isZone(value.zone) &&
		Array.isArray(value.checkedBy) &&
		value.checkedBy.every(isId) &&
		Array.isArray(value.agents) &&
		value.agents.length <= crewAgentsPerNodeLimit &&
		value.agents.every((agent) => isSpecAgentShape(agent, depth + 1, count)) &&
		Object.keys(value).every((key) =>
			[
				'id',
				'name',
				'template',
				'role',
				'provider',
				'requestedChoices',
				'choiceNames',
				'summary',
				'instructions',
				'extraInstructions',
				'zone',
				'checkedBy',
				'agents',
			].includes(key)
		)
	);
}
const isComposeOption = (value: unknown): value is CrewComposeOption =>
	isRecord(value) &&
	typeof value.id === 'string' &&
	value.id.length > 0 &&
	value.id.length <= 200 &&
	Array.isArray(value.choices) &&
	value.choices.length <= 128 &&
	value.choices.every(
		(choice) =>
			isRecord(choice) &&
			typeof choice.value === 'string' &&
			choice.value.length <= 200 &&
			typeof choice.name === 'string' &&
			choice.name.length <= 200 &&
			Object.keys(choice).length === 2
	) &&
	Object.keys(value).length === 2;
export function isCrewCompose(value: unknown): value is CrewCompose {
	return (
		isRecord(value) &&
		Object.keys(value).length === 2 &&
		Array.isArray(value.templates) &&
		value.templates.length <= crewAgentsPerNodeLimit &&
		value.templates.every(
			(item) =>
				isSpecAgentShape(item, 1, { nodes: 0 }) &&
				(item as CrewSpecAgent).agents.length === 0 &&
				(item as CrewSpecAgent).role !== 'foreman'
		) &&
		Array.isArray(value.providers) &&
		value.providers.length <= 2 &&
		value.providers.every(
			(item) =>
				isRecord(item) &&
				(item.provider === 'claude' || item.provider === 'codex') &&
				(item.model === undefined || isComposeOption(item.model)) &&
				(item.effort === undefined || isComposeOption(item.effort)) &&
				(item.efforts === undefined ||
					(isRecord(item.efforts) &&
						Object.keys(item.efforts).length <= 128 &&
						Object.values(item.efforts).every(isComposeOption))) &&
				Object.keys(item).every((key) => ['provider', 'model', 'effort', 'efforts'].includes(key))
		)
	);
}
/** One resolved node with its branch (spec/crew#compose plan crew). */
export function isCrewSpecAgent(value: unknown): value is CrewSpecAgent {
	return isSpecAgentShape(value, 1, { nodes: 0 });
}
export function isCrewSpec(value: unknown): value is CrewSpec {
	if (
		!isRecord(value) ||
		value.schemaVersion !== 1 ||
		(value.compose !== undefined && !isCrewCompose(value.compose)) ||
		!(value.templateId === null || isId(value.templateId)) ||
		!isCrewName(value.name) ||
		typeof value.resolvedAt !== 'string' ||
		!Number.isFinite(Date.parse(value.resolvedAt)) ||
		!isSpecAgentShape(value.root, 0, { nodes: 0 })
	)
		return false;
	const root = value.root as CrewSpecAgent;
	if (root.role !== 'foreman') return false;
	const ids = new Set<string>(),
		labels = new Set<string>();
	for (const agent of specAgents(root)) {
		if (ids.has(agent.id) || labels.has(agent.name)) return false;
		ids.add(agent.id);
		labels.add(agent.name);
		if (agent.agents.length && agent.role !== 'foreman') return false;
		if (!agent.agents.length && agent.role === 'foreman' && agent !== root) return false;
	}
	const edges = (agent: CrewSpecAgent): boolean =>
		agent.agents.every(
			(child) =>
				child.checkedBy.every(
					(checker) =>
						checker !== child.id &&
						agent.agents.some((item) => item.id === checker && item.role === 'reviewer')
				) &&
				(child.checkedBy.length === 0 || child.role === 'developer') &&
				edges(child)
		);
	// spec/reviews#reviewer-sessions: the root may be checked too — by reviewers among its own agents (a task's review before the PR).
	return (
		root.checkedBy.every((checker) =>
			root.agents.some((item) => item.id === checker && item.role === 'reviewer')
		) && edges(root)
	);
}
export function specAgents(root: CrewSpecAgent): CrewSpecAgent[] {
	return [root, ...root.agents.flatMap(specAgents)];
}
export function findSpecAgent(root: CrewSpecAgent, id: string): CrewSpecAgent | null {
	return specAgents(root).find((agent) => agent.id === id) ?? null;
}
export function specParent(root: CrewSpecAgent, id: string): CrewSpecAgent | null {
	for (const agent of specAgents(root))
		if (agent.agents.some((child) => child.id === id)) return agent;
	return null;
}
/** Name → node among a parent's children (spec/crew#workers): the foreman addresses agents by name, the host resolves ids. */
export function specChildByName(parent: CrewSpecAgent, name: string): CrewSpecAgent | null {
	const wanted = crewName(name);
	return parent.agents.find((agent) => agent.name === wanted) ?? null;
}
/** Providers used anywhere in the crew, in tree order without repeats (spec/crew-templates-and-editor#after-launch sidebar glyphs). */
export function specProviders(root: CrewSpecAgent): AgentProvider[] {
	return [...new Set(specAgents(root).map((agent) => agent.provider))];
}
/** spec/agents-and-providers#catalog: what a person changes on a built-in role — provider and launch choices; name, rights and instructions stay the app's. */
export type BuiltinAgentChoices = {
	id: string;
	provider?: AgentProvider;
	choices?: CrewChoices;
	choiceNames?: Record<string, string>;
};
export type BuiltinAgentChoicesDocument = { schemaVersion: 1; template: BuiltinAgentChoices };
export function isBuiltinAgentChoicesDocument(
	value: unknown
): value is BuiltinAgentChoicesDocument {
	if (
		!isRecord(value) ||
		value.schemaVersion !== 1 ||
		Object.keys(value).length !== 2 ||
		!isRecord(value.template)
	)
		return false;
	const item = value.template;
	return (
		builtinAgentTemplates.some((template) => template.id === item.id) &&
		(item.provider === undefined || item.provider === 'claude' || item.provider === 'codex') &&
		(item.choices === undefined || isCrewChoices(item.choices)) &&
		(item.choiceNames === undefined || names(item.choiceNames)) &&
		Object.keys(item).every((key) => ['id', 'provider', 'choices', 'choiceNames'].includes(key))
	);
}
/** The launch part of a built-in template a person may change; empty means the provider's defaults (spec/crew-templates-and-editor#builtin-templates). */
export function builtinAgentChoices(template: AgentTemplate): BuiltinAgentChoices {
	const configOptions = template.choices?.configOptions;
	return {
		id: template.id,
		...(template.provider ? { provider: template.provider } : {}),
		...(configOptions && Object.keys(configOptions).length ? { choices: { configOptions } } : {}),
		...(template.choiceNames && Object.keys(template.choiceNames).length
			? { choiceNames: template.choiceNames }
			: {}),
	};
}
/** A built-in template with the person's choices laid over it. Everything else comes from the app. */
export function withBuiltinChoices(
	template: AgentTemplate,
	choices: BuiltinAgentChoices | undefined
): AgentTemplate {
	if (!choices) return template;
	const { provider, choices: launch, choiceNames } = choices;
	// The overlay replaces the app's provider and choices whole: a model never carries over to another provider.
	const { provider: _provider, choices: _choices, choiceNames: _names, ...rest } = template;
	return {
		...rest,
		...(provider ? { provider } : {}),
		...(launch ? { choices: launch } : {}),
		...(choiceNames ? { choiceNames } : {}),
	};
}
const sorted = (value: Record<string, unknown> | undefined) =>
	JSON.stringify(Object.entries(value ?? {}).sort(([a], [b]) => a.localeCompare(b)));
/** Whether two launch parts are the same choice, whatever the key order. */
export function sameBuiltinChoices(a: BuiltinAgentChoices, b: BuiltinAgentChoices): boolean {
	return (
		a.id === b.id &&
		a.provider === b.provider &&
		sorted(a.choices?.configOptions) === sorted(b.choices?.configOptions)
	);
}
/** spec/crew-templates-and-editor#builtin-templates: a built-in role whose provider, model or effort differs from the app's; `Reset` is offered for it. */
export function builtinAgentCustomized(template: AgentTemplate): boolean {
	const base = builtinAgentTemplates.find((item) => item.id === template.id);
	return (
		template.builtin &&
		!!base &&
		!sameBuiltinChoices(builtinAgentChoices(template), builtinAgentChoices(base))
	);
}
const stable = (value: unknown): unknown =>
	Array.isArray(value)
		? value.map(stable)
		: isRecord(value)
			? Object.fromEntries(
					Object.entries(value)
						.filter(([, item]) => item !== undefined)
						.sort(([a], [b]) => a.localeCompare(b))
						.map(([key, item]) => [key, stable(item)])
				)
			: value;
/** Whether two crews have the same tree, whatever the key order. */
export function sameCrewTree(a: CrewTemplate, b: CrewTemplate): boolean {
	return JSON.stringify(stable(a.root)) === JSON.stringify(stable(b.root));
}
/** spec/crew-templates-and-editor#builtin-templates: a person's edit of a built-in crew keeps the app's id and name. */
export function withBuiltinCrew(
	base: CrewTemplate,
	edited: CrewTemplate | undefined
): CrewTemplate {
	return edited ? { ...edited, id: base.id, name: base.name, builtin: true } : base;
}
/** spec/crew-templates-and-editor#builtin-templates: a built-in crew whose tree differs from the app's; `Reset` is offered for it. */
export function builtinCrewCustomized(template: CrewTemplate): boolean {
	const base = builtinCrewTemplates.find((item) => item.id === template.id);
	return template.builtin && !!base && !sameCrewTree(template, base);
}
export function isAgentTemplateDocument(value: unknown): value is AgentTemplateDocument {
	return (
		isRecord(value) &&
		value.schemaVersion === 1 &&
		isAgentTemplate(value.template) &&
		Object.keys(value).length === 2
	);
}
export function isCrewTemplateDocument(value: unknown): value is CrewTemplateDocument {
	return (
		isRecord(value) &&
		value.schemaVersion === 1 &&
		isCrewTemplate(value.template) &&
		Object.keys(value).length === 2
	);
}

/** spec/crew-templates-and-editor#template-library library as the renderer sees it: builtins first, then own templates, plus files that could not be read. */
export type CrewLibrary = {
	agents: AgentTemplate[];
	crews: CrewTemplate[];
	issues: import('./workspace').ReadIssue[];
	/** spec/pull-requests-and-ci#review-crew: built-in crews hidden from the library; non-empty offers `Restore default crews`. */
	hiddenCrews: string[];
};
/**
 * What the launch sheet sends for a task (spec/tasks#sheet-rail): `Auto` (spec/crew#auto), a library crew by id, or a one-off crew edited in
 * place. `compose` is what schedules saved before `Auto` hold; it runs as `Auto` (`unshippedCrewLaunch`).
 */
export type CrewLaunch =
	| { auto: true }
	| { templateId: string }
	| { template: CrewTemplate }
	| {
			compose: true;
			template?: CrewTemplate;
	  };
export function isCrewLaunch(value: unknown): value is CrewLaunch {
	if (!isRecord(value)) return false;
	if (value.auto === true) return Object.keys(value).length === 1;
	if (value.compose === true)
		return (
			Object.keys(value).every((key) => key === 'compose' || key === 'template') &&
			(value.template === undefined ||
				(isCrewTemplate(value.template) && !value.template.root.agents?.length))
		);
	return (
		Object.keys(value).length === 1 && (isId(value.templateId) || isCrewTemplate(value.template))
	);
}
/** Localizable names of built-in templates and their nodes: the stored name is English, the UI translates it (spec/crew-templates-and-editor#builtin-templates). */
export const builtinCrewNames = [
	'Foreman',
	'Developer',
	'Developer 1',
	'Developer 2',
	'Senior developer',
	'Tester',
	'Technical writer',
	'Reviewer',
	'Designer',
	'Security reviewer',
	'Crew',
	'Crew with tests',
	'Review crew',
] as const;
/** Built-in names are stored in English and shown in the interface language (spec/crew-templates-and-editor#builtin-templates): the computer's crew and the phone's worker rows. */
export function crewLabel(locale: Locale, name: string): string {
	return isBuiltinCrewName(name) ? t(locale, name) : name;
}
export function isBuiltinCrewName(value: string): value is (typeof builtinCrewNames)[number] {
	return (builtinCrewNames as readonly string[]).includes(value);
}
/** Provider catalog as the renderer needs it for the inspector: the last advertised options and modes of a provider in this workspace (rule 7).
 *  `byModel` holds what the provider answered after each model was set (spec/agents-and-providers#catalog): effort levels differ per model. */
export type ProviderCatalog = {
	provider: AgentProvider;
	options: import('./agent').AgentOption[];
	modes: import('./agent').AgentMode[];
	byModel?: Record<string, import('./agent').AgentOption[]>;
};
