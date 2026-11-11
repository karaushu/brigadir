import { isRecord } from './workspace';
import { catalogOptions, selectOption } from './agent-options';
import {
	crewAgentsPerNodeLimit,
	crewName,
	foremanTemplateId,
	isCrewName,
	isCrewSpec,
	isCrewSummary,
	normalizeZonePath,
	resolveCrewAgent,
	zoneCovers,
	type AgentTemplate,
	type CrewAgent,
	type CrewCompose,
	type CrewComposeOption,
	type CrewSpec,
	type CrewSpecAgent,
	type CrewTemplate,
	type ProviderCatalog,
	type ResolveContext,
} from './crew';
import type { AgentProvider } from './agent';
/** spec/crew#compose: the foreman composes its crew and proposes it with the plan. Pure functions over the palette snapshot. */

const providerNames: Record<AgentProvider, string> = { claude: 'Claude', codex: 'Codex' };
const option = (source: {
	id: string;
	choices: readonly { value: string; name: string }[];
}): CrewComposeOption => ({
	id: source.id,
	choices: source.choices
		.slice(0, 128)
		.map((choice) => ({ value: choice.value.slice(0, 200), name: choice.name.slice(0, 200) })),
});

/** The library's non-foreman templates resolved as nodes, and each provider's models with the effort levels of each model. */
export function crewPalette(
	templates: readonly AgentTemplate[],
	context: ResolveContext,
	catalogs: readonly ProviderCatalog[]
): CrewCompose {
	// spec/crew#compose: an own template with a built-in's name stands in for it, so a name means one template.
	const own = templates.filter((template) => !template.builtin);
	const nodes = templates
		.filter(
			(template) =>
				template.role !== 'foreman' &&
				!(template.builtin && own.some((item) => same(item.name, template.name)))
		)
		.slice(0, crewAgentsPerNodeLimit)
		.map((template) =>
			resolveCrewAgent(
				{ id: template.id, name: template.name, template: template.id },
				context,
				[],
				false
			)
		);
	const providers = catalogs.slice(0, 2).map((catalog) => {
		const model = selectOption(catalog.options, 'model'),
			efforts: Record<string, CrewComposeOption> = {};
		if (model)
			for (const choice of model.choices.slice(0, 128)) {
				const effort = selectOption(catalogOptions(catalog, choice.value), 'effort');
				if (effort) efforts[choice.value] = option(effort);
			}
		const effort = selectOption(catalog.options, 'effort');
		return {
			provider: catalog.provider,
			...(model ? { model: option(model) } : {}),
			...(effort ? { effort: option(effort) } : {}),
			...(Object.keys(efforts).length ? { efforts } : {}),
		};
	});
	return { templates: nodes, providers };
}
/** The foreman proposes its crew while the palette is there and nobody is approved yet. */
export function isComposing(spec: CrewSpec | null | undefined): boolean {
	return !!spec?.compose && spec.root.agents.length === 0;
}
/** The spec with the proposed agents under the root, for plan checks and the card. */
export function composedSpec(spec: CrewSpec, agents: readonly CrewSpecAgent[]): CrewSpec {
	return { ...spec, root: { ...spec.root, agents: [...agents] } };
}
/** After approval the crew is an ordinary one; the palette goes. */
export function approvedSpec(spec: CrewSpec, agents: readonly CrewSpecAgent[]): CrewSpec {
	const { compose: _compose, ...rest } = composedSpec(spec, agents);
	return rest;
}

const same = (a: string, b: string) =>
	a.trim().toLocaleLowerCase('en') === b.trim().toLocaleLowerCase('en');
function choiceOf(source: CrewComposeOption, wanted: string) {
	return (
		source.choices.find((choice) => choice.value === wanted) ??
		source.choices.find((choice) => same(choice.name, wanted) || same(choice.value, wanted))
	);
}
const listed = (items: readonly string[]) => (items.length ? items.join(', ') : 'none');
function templateOf(palette: CrewCompose, wanted: string): CrewSpecAgent | undefined {
	const byName = palette.templates.filter((template) => same(template.name, wanted));
	return byName.length === 1
		? byName[0]
		: palette.templates.find((template) => template.id === wanted || template.template === wanted);
}
function providerOf(value: unknown): AgentProvider | null {
	if (typeof value !== 'string') return null;
	const wanted = value.trim().toLowerCase();
	return wanted === 'claude'
		? 'claude'
		: wanted === 'codex' || wanted === 'openai'
			? 'codex'
			: null;
}
/**
 * `propose_plan` `crew` arguments → resolved nodes under the root. Errors are English for the agent (rule 12) and name what is
 * available, so the model can retry; the rules are those of the editor (spec/crew-templates-and-editor#resolution-contract).
 */
export function composeCrew(spec: CrewSpec, input: unknown, newId: () => string): CrewSpecAgent[] {
	const palette = spec.compose;
	if (!palette || spec.root.agents.length)
		throw new Error('Your crew is already set; call propose_plan without crew.');
	if (!Array.isArray(input) || !input.length)
		throw new Error('You compose your crew: pass crew with at least one agent.');
	if (input.length > crewAgentsPerNodeLimit)
		throw new Error(`A crew has at most ${crewAgentsPerNodeLimit} agents.`);
	const taken = new Set([spec.root.name]),
		checks = new Map<CrewSpecAgent, unknown>(),
		agents: CrewSpecAgent[] = [];
	for (const [index, item] of input.entries()) {
		if (!isRecord(item)) throw new Error(`Crew agent ${index + 1} must be an object.`);
		const name = typeof item.name === 'string' ? crewName(item.name) : '';
		if (!isCrewName(name)) throw new Error(`Crew agent ${index + 1} needs a name.`);
		if (taken.has(name)) throw new Error(`Two agents are named ${name}.`);
		taken.add(name);
		const template =
			typeof item.template === 'string' ? templateOf(palette, item.template) : undefined;
		if (!template)
			throw new Error(
				`Unknown template ${String(item.template)} for ${name}. Templates: ${listed(palette.templates.map((entry) => entry.name))}.`
			);
		const provider = item.provider === undefined ? template.provider : providerOf(item.provider);
		const entry = palette.providers.find((candidate) => candidate.provider === provider);
		if (!provider || (provider !== template.provider && !entry))
			throw new Error(
				`Unknown provider ${String(item.provider)} for ${name}. Providers: ${listed(palette.providers.map((candidate) => providerNames[candidate.provider]))}.`
			);
		// spec/crew-templates-and-editor#resolution-contract: a node that changes the template's provider drops the template's choices.
		const keep = provider === template.provider,
			configOptions: Record<string, string | boolean> = {
				...(keep ? template.requestedChoices.configOptions : {}),
			},
			choiceNames: Record<string, string> = { ...(keep ? template.choiceNames : {}) };
		if (item.model !== undefined) {
			const choice =
				typeof item.model === 'string' && entry?.model
					? choiceOf(entry.model, item.model)
					: undefined;
			if (!entry?.model || !choice)
				throw new Error(
					`Unknown ${providerNames[provider]} model ${String(item.model)} for ${name}. Models: ${listed(entry?.model?.choices.map((model) => model.name) ?? [])}.`
				);
			configOptions[entry.model.id] = choice.value;
			choiceNames[entry.model.id] = choice.name;
		}
		const model = entry?.model ? configOptions[entry.model.id] : undefined,
			efforts = typeof model === 'string' ? entry?.efforts?.[model] : entry?.effort;
		// spec/agents-and-providers#catalog: a new model keeps the template's effort only when it has that level.
		if (item.model !== undefined)
			for (const levels of Object.values(entry?.efforts ?? {}))
				if (
					levels.id in configOptions &&
					(!efforts ||
						efforts.id !== levels.id ||
						!efforts.choices.some((choice) => choice.value === configOptions[levels.id]))
				) {
					delete configOptions[levels.id];
					delete choiceNames[levels.id];
				}
		if (item.effort !== undefined) {
			const choice =
				typeof item.effort === 'string' && efforts ? choiceOf(efforts, item.effort) : undefined;
			if (!efforts || !choice)
				throw new Error(
					efforts
						? `Unknown effort ${String(item.effort)} for ${name}. Levels: ${listed(efforts.choices.map((level) => level.name))}.`
						: `${name} has no effort levels: pass model first, or no effort.`
				);
			configOptions[efforts.id] = choice.value;
			choiceNames[efforts.id] = choice.name;
		}
		if (item.summary !== undefined && !isCrewSummary(item.summary))
			throw new Error(`The specialty of ${name} must be one line of at most 240 characters.`);
		const summary =
			typeof item.summary === 'string' && item.summary.trim()
				? item.summary.trim()
				: template.summary;
		const zoneInput = item.zone ?? [];
		if (!Array.isArray(zoneInput) || zoneInput.length > 256)
			throw new Error(`The zone of ${name} must be a list of paths.`);
		const zone = zoneInput.map((path) =>
			typeof path === 'string' ? normalizeZonePath(path) : null
		);
		if (zone.some((path) => path === null))
			throw new Error(`The zone of ${name} has an invalid path.`);
		if (!zone.every((path) => zoneCovers(spec.root.zone, path!)))
			throw new Error(`The zone of ${name} is outside yours: ${spec.root.zone.join(', ')}.`);
		const modeId = keep ? template.requestedChoices.modeId : undefined;
		const agent: CrewSpecAgent = {
			id: newId(),
			name,
			template: template.template ?? template.id,
			role: template.role,
			provider,
			requestedChoices: {
				...(modeId ? { modeId } : {}),
				...(Object.keys(configOptions).length ? { configOptions } : {}),
			},
			choiceNames,
			summary: summary ?? '',
			instructions: template.instructions,
			extraInstructions: '',
			zone: [...new Set(zone as string[])],
			checkedBy: [],
			agents: [],
		};
		agents.push(agent);
		checks.set(agent, item.checkedBy);
	}
	for (const [agent, checkers] of checks) {
		if (checkers === undefined) continue;
		if (!Array.isArray(checkers))
			throw new Error(`checkedBy of ${agent.name} must be a list of reviewer names.`);
		for (const wanted of checkers) {
			const checker =
				typeof wanted === 'string'
					? agents.find((item) => item.name === crewName(wanted))
					: undefined;
			if (!checker)
				throw new Error(`checkedBy of ${agent.name}: no agent named ${String(wanted)}.`);
			if (checker.role !== 'reviewer')
				throw new Error(`${checker.name} is not a reviewer and cannot check ${agent.name}.`);
			if (agent.role !== 'developer')
				throw new Error(`Only a developer can be checked: ${agent.name}.`);
			if (!agent.checkedBy.includes(checker.id)) agent.checkedBy.push(checker.id);
		}
	}
	if (!agents.some((agent) => agent.role === 'developer'))
		throw new Error('The crew needs at least one developer: reviewers take no part of the code.');
	// spec/crew#compose: every developer of a composed crew has a reviewer, while the palette has one to take.
	const reviewers = palette.templates.filter((template) => template.role === 'reviewer');
	if (reviewers.length) {
		const templates = listed(reviewers.map((template) => template.name));
		if (!agents.some((agent) => agent.role === 'reviewer'))
			throw new Error(
				`The crew needs at least one reviewer to check the developers. Reviewer templates: ${templates}.`
			);
		const unchecked = agents.filter(
			(agent) => agent.role === 'developer' && !agent.checkedBy.length
		);
		if (unchecked.length)
			throw new Error(
				`Every developer needs a reviewer in checkedBy: ${listed(unchecked.map((agent) => agent.name))}.`
			);
	}
	if (!isCrewSpec(composedSpec(spec, agents))) throw new Error('The crew is invalid.');
	return agents;
}
/**
 * A resolved crew opened in the editor again. Every node keeps its provider and choices as its own; a node whose template is
 * gone from the library keeps its instructions as the addition, so nothing the agent was told is lost.
 */
export function specAsTemplate(spec: CrewSpec, known: (id: string) => boolean): CrewTemplate {
	const node = (agent: CrewSpecAgent, isRoot: boolean): CrewAgent => {
		const template = isRoot
			? foremanTemplateId
			: agent.template && known(agent.template)
				? agent.template
				: null;
		const extra =
			template === null && agent.instructions.trim()
				? [agent.instructions.trim(), agent.extraInstructions.trim()].filter(Boolean).join('\n\n')
				: agent.extraInstructions;
		const choices = agent.requestedChoices,
			names = agent.choiceNames;
		return {
			id: agent.id,
			name: agent.name,
			template,
			provider: agent.provider,
			...(choices.modeId || Object.keys(choices.configOptions ?? {}).length ? { choices } : {}),
			...(Object.keys(names).length ? { choiceNames: names } : {}),
			...(agent.summary ? { summary: agent.summary } : {}),
			...(agent.zone.length && !isRoot ? { zone: agent.zone } : {}),
			...(extra ? { extraInstructions: extra } : {}),
			...(agent.checkedBy.length ? { checkedBy: agent.checkedBy } : {}),
			...(agent.agents.length ? { agents: agent.agents.map((child) => node(child, false)) } : {}),
		};
	};
	return {
		schemaVersion: 1,
		id: spec.templateId ?? 'crew',
		name: spec.name,
		builtin: false,
		root: node(spec.root, true),
	};
}
