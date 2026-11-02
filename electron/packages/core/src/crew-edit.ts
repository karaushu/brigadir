import {
	crewAgents,
	crewName,
	crewParent,
	findCrewAgent,
	foremanTemplateId,
	isCrewName,
	type CrewAgent,
	type CrewLeafDraft,
	type CrewTemplate,
} from './crew';
/** Pure editor operations on a crew template (spec/crew-templates-and-editor#crew-editor). Each returns a new template; ids never change on rename. */
function mapAgents(
	root: CrewAgent,
	map: (agent: CrewAgent, parent: CrewAgent | null) => CrewAgent,
	parent: CrewAgent | null = null
): CrewAgent {
	const mapped = map(root, parent);
	return {
		...mapped,
		...(mapped.agents
			? { agents: mapped.agents.map((child) => mapAgents(child, map, mapped)) }
			: {}),
	};
}
function replaceAgent(
	template: CrewTemplate,
	id: string,
	update: (agent: CrewAgent, parent: CrewAgent | null) => CrewAgent
): CrewTemplate {
	if (!findCrewAgent(template.root, id)) throw new Error('Unknown agent');
	return {
		...template,
		root: mapAgents(template.root, (agent, parent) =>
			agent.id === id ? update(agent, parent) : agent
		),
	};
}
function clean<T>(value: object): T {
	return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}
export function uniqueCrewName(template: CrewTemplate, base: string): string {
	const taken = new Set(crewAgents(template.root).map((agent) => crewName(agent.name)));
	const wanted = crewName(base) || 'Agent';
	if (!taken.has(wanted)) return wanted;
	let index = 2;
	while (taken.has(`${wanted} ${index}`)) index++;
	return `${wanted} ${index}`;
}
/** Adds an agent under `parentId`. A leaf that gains its first child keeps its launch configuration in `leafDraft`, takes the Foreman template and loses its check edges (spec/crew-templates-and-editor#resolution-contract, spec/crew#subordinates). */
export function addCrewAgent(
	template: CrewTemplate,
	parentId: string,
	agent: Omit<CrewAgent, 'name'> & { name?: string }
): CrewTemplate {
	const name = uniqueCrewName(template, agent.name ?? 'Agent');
	if (findCrewAgent(template.root, agent.id)) throw new Error('Duplicate agent id');
	const next = replaceAgent(template, parentId, (parent, grand) => {
		const child = clean<CrewAgent>({
			...agent,
			name,
			agents: agent.agents ?? [],
			checkedBy: agent.checkedBy ?? [],
		});
		if (parent.agents?.length || grand === null)
			return { ...parent, agents: [...(parent.agents ?? []), child] };
		const leafDraft = clean<CrewLeafDraft>({
			template: parent.template,
			provider: parent.provider,
			choices: parent.choices,
			choiceNames: parent.choiceNames,
		});
		const { provider: _p, choices: _c, choiceNames: _n, ...rest } = parent;
		return { ...rest, template: foremanTemplateId, leafDraft, checkedBy: [], agents: [child] };
	});
	// A node with children can no longer check siblings (reviewers have no agents, spec/crew-templates-and-editor#resolution-contract).
	return {
		...next,
		root: mapAgents(next.root, (node) =>
			node.id === parentId
				? node
				: node.checkedBy?.includes(parentId) && findCrewAgent(next.root, parentId)?.agents?.length
					? { ...node, checkedBy: node.checkedBy.filter((id) => id !== parentId) }
					: node
		),
	};
}
/** Removes a node with its branch and every edge that points at it. The last child removed restores the parent's `leafDraft`. */
export function removeCrewAgent(template: CrewTemplate, id: string): CrewTemplate {
	if (id === template.root.id) throw new Error('The foreman cannot be removed');
	const parent = crewParent(template.root, id);
	if (!parent) throw new Error('Unknown agent');
	return replaceAgent(template, parent.id, (node) => {
		const agents = (node.agents ?? [])
			.filter((child) => child.id !== id)
			.map((child) =>
				child.checkedBy?.includes(id)
					? { ...child, checkedBy: child.checkedBy.filter((item) => item !== id) }
					: child
			);
		if (agents.length || !node.leafDraft || node.id === template.root.id)
			return { ...node, agents };
		const { leafDraft, agents: _a, ...rest } = node;
		return clean<CrewAgent>({
			...rest,
			template: leafDraft.template,
			provider: leafDraft.provider,
			choices: leafDraft.choices,
			choiceNames: leafDraft.choiceNames,
			agents: [],
		});
	});
}
export function renameCrewAgent(template: CrewTemplate, id: string, name: string): CrewTemplate {
	if (!isCrewName(name)) throw new Error('Invalid agent name');
	const wanted = crewName(name);
	if (crewAgents(template.root).some((agent) => agent.id !== id && crewName(agent.name) === wanted))
		throw new Error('An agent with this name already exists');
	return replaceAgent(template, id, (agent) => ({ ...agent, name: wanted }));
}
/** `undefined` in the patch removes the field (an override goes back to the template). */
export function updateCrewAgent(
	template: CrewTemplate,
	id: string,
	patch: {
		[
			K in
				| 'template'
				| 'provider'
				| 'choices'
				| 'choiceNames'
				| 'summary'
				| 'zone'
				| 'extraInstructions'
		]?: CrewAgent[K] | undefined;
	}
): CrewTemplate {
	return replaceAgent(template, id, (agent) => {
		if (
			agent.agents?.length &&
			patch.template !== undefined &&
			patch.template !== foremanTemplateId
		)
			throw new Error('An agent with agents keeps the Foreman template');
		const next = { ...agent };
		for (const [key, value] of Object.entries(patch) as [keyof typeof patch, unknown][]) {
			if (value === undefined) delete next[key];
			else (next as Record<string, unknown>)[key] = value;
		}
		return next;
	});
}
/** Check edges live between children of one parent: `checkerId` reviews `id` (spec/crew#reviewer). */
export function addCrewCheck(template: CrewTemplate, id: string, checkerId: string): CrewTemplate {
	const parent = crewParent(template.root, id);
	if (!parent || !parent.agents?.some((agent) => agent.id === checkerId))
		throw new Error('Checks are allowed only between agents of one parent');
	if (id === checkerId) throw new Error('An agent cannot check itself');
	return replaceAgent(template, id, (agent) =>
		agent.checkedBy?.includes(checkerId)
			? agent
			: { ...agent, checkedBy: [...(agent.checkedBy ?? []), checkerId] }
	);
}
export function removeCrewCheck(
	template: CrewTemplate,
	id: string,
	checkerId: string
): CrewTemplate {
	return replaceAgent(template, id, (agent) => ({
		...agent,
		checkedBy: (agent.checkedBy ?? []).filter((item) => item !== checkerId),
	}));
}
/** Copies a branch next to its source with fresh ids; edges inside the branch follow the copy, edges to outside siblings are kept. */
export function cloneCrewBranch(
	template: CrewTemplate,
	id: string,
	newId: () => string
): CrewTemplate {
	const source = findCrewAgent(template.root, id),
		parent = crewParent(template.root, id);
	if (!source || !parent) throw new Error('Unknown agent');
	const ids = new Map<string, string>();
	for (const agent of crewAgents(source)) ids.set(agent.id, newId());
	let result = template;
	const copy = (agent: CrewAgent): CrewAgent => ({
		...agent,
		id: ids.get(agent.id)!,
		name: agent.id === source.id ? uniqueCrewName(result, agent.name) : agent.name,
		...(agent.checkedBy ? { checkedBy: agent.checkedBy.map((item) => ids.get(item) ?? item) } : {}),
		...(agent.agents ? { agents: agent.agents.map(copy) } : {}),
	});
	const cloned = copy(source);
	// Nested names must stay unique too: suffix collisions inside the copy.
	const taken = new Set(crewAgents(template.root).map((agent) => crewName(agent.name)));
	taken.add(crewName(cloned.name));
	const fix = (agent: CrewAgent): CrewAgent => {
		let name = crewName(agent.name);
		if (agent.id !== cloned.id) {
			let index = 2;
			const base = name;
			while (taken.has(name)) name = `${base} ${index++}`;
			taken.add(name);
		}
		return { ...agent, name, ...(agent.agents ? { agents: agent.agents.map(fix) } : {}) };
	};
	const fixed = fix(cloned);
	result = replaceAgent(template, parent.id, (node) => {
		const agents = [...(node.agents ?? [])];
		agents.splice(agents.findIndex((child) => child.id === id) + 1, 0, fixed);
		return { ...node, agents };
	});
	return result;
}
/** A duplicated crew template gets a new template id; node ids stay because their scope is one crew (spec/crew-templates-and-editor#resolution-contract). */
export function duplicateCrewTemplate(
	template: CrewTemplate,
	id: string,
	name: string
): CrewTemplate {
	if (!isCrewName(name)) throw new Error('Invalid crew name');
	return {
		...(JSON.parse(JSON.stringify(template)) as CrewTemplate),
		id,
		name: crewName(name),
		builtin: false,
	};
}
/** A branch becomes a crew template of its own: the node is the new foreman (spec/crew-templates-and-editor#crew-editor «Save branch as template»). */
export function branchAsCrewTemplate(
	template: CrewTemplate,
	id: string,
	templateId: string,
	name: string
): CrewTemplate {
	const source = findCrewAgent(template.root, id);
	if (!source || !source.agents?.length)
		throw new Error('Only an agent with agents can become a crew');
	const {
		leafDraft: _d,
		checkedBy: _c,
		zone: _z,
		...root
	} = JSON.parse(JSON.stringify(source)) as CrewAgent;
	return {
		schemaVersion: 1,
		id: templateId,
		name: crewName(name),
		builtin: false,
		root: { ...root, template: foremanTemplateId },
	};
}
