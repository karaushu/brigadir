import {
	crewPalette,
	resolveTaskAgent,
	selectOption,
	catalogOptions,
	templateLookup,
	type AgentTemplate,
	type AutoBudget,
	type AutoModelAnswer,
	type AutoModelRequest,
	type AutoTask,
	type ProviderCatalog,
} from '@brigadir/core';
/**
 * spec/crew#auto-roles: what an Auto task stores at its start — the library's non-foreman templates as roles (an own template with a built-in's
 * name stands in for it), only those whose provider is on, and the part budget of Settings ▸ Auto. No catalog is read: the roles carry the
 * choices their templates name.
 */
export function autoTaskSnapshot(
	agents: readonly AgentTemplate[],
	defaultProvider: 'claude' | 'codex',
	enabled: Record<'claude' | 'codex', boolean>,
	budget: AutoBudget
): AutoTask {
	const palette = crewPalette(agents, { lookup: templateLookup(agents), defaultProvider }, []);
	return {
		roles: palette.templates.filter((role) => enabled[role.provider]),
		budget: { ...budget },
	};
}
/**
 * spec/crew#auto-model: the app's answer to the host's `auto_model`. Without `Any catalog model`, or when the agent named no model, the person is
 * asked (`{ask: true}`); otherwise the names are checked against the provider's catalog, and an unknown one is the resolver's English error.
 */
export function autoModelAnswer(
	request: AutoModelRequest,
	anyModel: boolean,
	catalog: Pick<ProviderCatalog, 'options' | 'byModel'> | null | undefined
): AutoModelAnswer | { ask: true } {
	if (!anyModel || !request.model || !request.provider) return { ask: true };
	const resolved = resolveTaskAgent(
		{
			provider: request.provider,
			model: request.model,
			...(request.effort ? { effort: request.effort } : {}),
		},
		catalog
	);
	const modelOption = catalog ? selectOption(catalogOptions(catalog), 'model') : undefined,
		model = resolved.options.find((option) => option.id === modelOption?.id),
		effortOption = catalog
			? selectOption(catalogOptions(catalog, model?.value), 'effort')
			: undefined,
		effort = resolved.options.find((option) => option.id === effortOption?.id);
	return {
		provider: request.provider,
		model: model && resolved.modelName ? { ...model, name: resolved.modelName } : null,
		effort: effort && resolved.effortName ? { ...effort, name: resolved.effortName } : null,
	};
}
